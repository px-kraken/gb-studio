import glob from "glob";
import Path from "path";
import { promisify } from "util";
import os from "os";
import { ensureDir, copyFile, readFile, pathExists } from "fs-extra";
import { checksumString } from "lib/helpers/checksum";

const globAsync = promisify(glob);
const ioConcurrency = Math.max(2, Math.min(os.cpus().length, 16));

const toObjFilePath = (buildRoot: string, srcFilePath: string) => {
  const relativeSourcePath = Path.relative(
    Path.join(buildRoot, "src"),
    srcFilePath,
  )
    .split(Path.sep)
    .join("/");
  return `${buildRoot}/obj/${relativeSourcePath}`.replace(
    /\.[cs]$/,
    ".o",
  );
};

interface ParsedInclude {
  contents: string;
  referencedFiles: string[];
  checksum: string;
}

type IncludesLookup = Record<string, ParsedInclude>;
type GameGlobalsLookup = Record<string, string>;

const GAME_GLOBALS_FILE = "data/game_globals.i";

const referencedFiles = (string: string): string[] => {
  return [...string.matchAll(/include "([^"]+)"/g)].map((m) => m[1]);
};

const fileChecksum = async (
  filename: string,
  includesLookup: IncludesLookup,
  gameGlobalsLookup: GameGlobalsLookup,
  envChecksum: string,
) => {
  const fileContents = await readFile(filename, "utf8");
  const fileChecksum = checksumString(fileContents);
  const headerFiles = referencedFiles(fileContents);
  let headerChecksums = "";
  // Add includes from headers
  for (const headerFilePath of headerFiles) {
    const header = includesLookup[headerFilePath];
    if (header) {
      for (const nestedHeader of header.referencedFiles) {
        if (!headerFiles.includes(nestedHeader)) {
          headerFiles.push(nestedHeader);
        }
      }
      if (headerFilePath === GAME_GLOBALS_FILE) {
        continue;
      }
      headerChecksums += header.checksum;
    }
  }
  // Only use addresses of globals that are used in file when generating checksum
  const usedGlobals = headerFiles.includes(GAME_GLOBALS_FILE)
    ? Object.keys(gameGlobalsLookup).filter((g) => {
        return fileContents.includes(g);
      })
    : [];
  const usedGlobalAddresses = usedGlobals.reduce(
    (memo, g) => (memo += `${gameGlobalsLookup[g]}_`),
    "",
  );
  return checksumString(
    `${fileChecksum}_${headerChecksums}_${usedGlobalAddresses}_${envChecksum}`,
  );
};

const generateIncludesLookup = async (buildIncludeRoot: string) => {
  const allIncludeFiles = await globAsync(`${buildIncludeRoot}/**/*.{h,i}`);
  const includesLookup: IncludesLookup = {};
  await Promise.all(
    allIncludeFiles.map(async (filePath) => {
      const fileContents = await readFile(filePath, "utf8");
      const key = Path.relative(buildIncludeRoot, filePath)
        .split(Path.sep)
        .join(Path.posix.sep);
      includesLookup[key] = {
        contents: fileContents,
        referencedFiles: referencedFiles(fileContents),
        checksum: checksumString(fileContents),
      };
    }),
  );
  return includesLookup;
};

const generateGameGlobalsLookup = (gameGlobalsContents: string) => {
  const lookup: GameGlobalsLookup = {};
  const globalMatches = [
    ...gameGlobalsContents.matchAll(/([A-Za-z_0-9]+)[\s]*=[\s]*(-?[0-9]+)/g),
  ];
  for (const globalMatch of globalMatches) {
    lookup[globalMatch[1]] = globalMatch[2];
  }
  return lookup;
};

const processInConcurrency = async <T>(
  values: T[],
  worker: (value: T) => Promise<void>,
  concurrency = ioConcurrency,
) => {
  await Promise.all(
    Array(concurrency)
      .fill(values.entries())
      .map(async (cursor) => {
        for (const [, value] of cursor) {
          await worker(value);
        }
      }),
  );
};

export type ObjCacheStoreStats = {
  sourceFiles: number;
  cachedObjects: number;
};

export const cacheObjData = async (
  buildRoot: string,
  tmpPath: string,
  env: NodeJS.ProcessEnv,
  srcFilesOverride?: string[],
): Promise<ObjCacheStoreStats> => {
  const cacheRoot = Path.normalize(`${tmpPath}/_gbscache/obj`);
  const buildSrcRoot = Path.normalize(`${buildRoot}/src`);
  const buildIncludeRoot = Path.normalize(`${buildRoot}/include`);

  await ensureDir(cacheRoot);
  const includesLookup = await generateIncludesLookup(buildIncludeRoot);
  const gameGlobalsLookup = generateGameGlobalsLookup(
    includesLookup[GAME_GLOBALS_FILE]?.contents,
  );

  const srcFiles = srcFilesOverride
    ? srcFilesOverride.map((filePath) => Path.normalize(filePath))
    : await globAsync(`${buildSrcRoot}/**/*.{c,s}`);

  const envChecksum = checksumString(JSON.stringify(env));
  let cachedObjects = 0;

  await processInConcurrency(srcFiles, async (srcFilePath) => {
    const objFilePath = toObjFilePath(buildRoot, srcFilePath);
    if (!(await pathExists(objFilePath))) {
      return;
    }
    const fileName = Path.basename(objFilePath, ".o");
    if (
      fileName.indexOf("bank_") !== 0 &&
      fileName.indexOf("music_bank_") !== 0
    ) {
      const cacheFilename = await fileChecksum(
        srcFilePath,
        includesLookup,
        gameGlobalsLookup,
        envChecksum,
      );

      const outFile = `${cacheRoot}/${cacheFilename}`;
      await copyFile(objFilePath, outFile);
      cachedObjects += 1;
    }
  });

  return {
    sourceFiles: srcFiles.length,
    cachedObjects,
  };
};

export type ObjCacheFetchStats = {
  sourceFiles: number;
  cacheHits: number;
  cacheMisses: number;
};

export const fetchCachedObjData = async (
  buildRoot: string,
  tmpPath: string,
  env: NodeJS.ProcessEnv,
): Promise<ObjCacheFetchStats> => {
  const cacheRoot = Path.normalize(`${tmpPath}/_gbscache/obj`);
  const buildSrcRoot = Path.normalize(`${buildRoot}/src`);
  const buildIncludeRoot = Path.normalize(`${buildRoot}/include`);

  const envChecksum = checksumString(JSON.stringify(env));
  const includesLookup = await generateIncludesLookup(buildIncludeRoot);
  const gameGlobalsLookup = generateGameGlobalsLookup(
    includesLookup[GAME_GLOBALS_FILE]?.contents,
  );

  const srcFiles = await globAsync(`${buildSrcRoot}/**/*.{c,s}`);
  let cacheHits = 0;

  await processInConcurrency(srcFiles, async (srcFilePath) => {
    const cacheFilename = await fileChecksum(
      srcFilePath,
      includesLookup,
      gameGlobalsLookup,
      envChecksum,
    );

    const cacheFile = `${cacheRoot}/${cacheFilename}`;

    if (await pathExists(cacheFile)) {
      const outFile = toObjFilePath(buildRoot, srcFilePath);
      await ensureDir(Path.dirname(outFile));
      await copyFile(cacheFile, outFile);
      cacheHits += 1;
    }
  });

  return {
    sourceFiles: srcFiles.length,
    cacheHits,
    cacheMisses: srcFiles.length - cacheHits,
  };
};
