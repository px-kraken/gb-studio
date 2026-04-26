import fs from "fs-extra";
import os from "os";
import Path from "path";
import {
  buildLinkFile,
  buildLinkFlags,
  getBuildCommands,
} from "./buildMakeScript";
import { cacheObjData, fetchCachedObjData } from "./objCache";
import ensureBuildTools from "./ensureBuildTools";
import spawn, { ChildProcess } from "lib/helpers/cli/spawn";
import l10n from "shared/lib/lang/l10n";
import { ProjectResources } from "shared/lib/resources/types";
import psTree from "ps-tree";
import { promisify } from "util";
import { envWith } from "lib/helpers/cli/env";
import { checksumString } from "lib/helpers/checksum";

const psTreeAsync = promisify(psTree);

type MakeOptions = {
  buildRoot: string;
  romFilename: string;
  tmpPath: string;
  data: ProjectResources;
  buildType: "rom" | "web" | "pocket";
  debug: boolean;
  progress: (msg: string) => void;
  warnings: (msg: string) => void;
};

const cpuCount = os.cpus().length;
const childSet = new Set<ChildProcess>();
let cancelling = false;

const logTiming = (
  progress: (msg: string) => void,
  label: string,
  startedAt: number,
) => {
  progress(`[timing] ${label}: ${Date.now() - startedAt}ms`);
};

const makeBuild = async ({
  buildRoot = "/tmp",
  tmpPath = "/tmp",
  romFilename,
  data,
  debug = false,
  buildType = "rom",
  progress = (_msg) => {},
  warnings = (_msg) => {},
}: MakeOptions) => {
  cancelling = false;
  const env = { ...process.env };
  const { settings } = data;
  const colorEnabled = settings.colorMode !== "mono";
  const sgbEnabled = settings.sgbEnabled && settings.colorMode !== "color";
  const colorOnly = settings.colorMode === "color";
  const targetPlatform = buildType === "pocket" ? "pocket" : "gb";
  const batterylessEnabled = settings.batterylessEnabled && buildType !== "web";

  const ensureBuildToolsStartedAt = Date.now();
  const buildToolsPath = await ensureBuildTools(tmpPath);
  logTiming(progress, "makeBuild.ensureBuildTools", ensureBuildToolsStartedAt);
  const buildToolsVersion = await fs.readFile(
    `${buildToolsPath}/tools_version`,
    "utf8",
  );

  env.PATH = envWith([Path.join(buildToolsPath, "gbdk", "bin")]);

  env.GBDKDIR = `${buildToolsPath}/gbdk/`;
  env.GBS_TOOLS_VERSION = buildToolsVersion;
  env.TARGET_PLATFORM = targetPlatform;

  env.CART_TYPE = settings.cartType || "mbc5";
  env.TMP = tmpPath;
  env.TEMP = tmpPath;
  if (colorEnabled) {
    env.COLOR = "true";
  }
  if (sgbEnabled) {
    env.SGB = "true";
  }
  if (batterylessEnabled) {
    env.BATTERYLESS = "true";
  }
  env.COLOR_MODE = settings.colorMode;
  env.MUSIC_DRIVER = settings.musicDriver;
  if (debug) {
    env.DEBUG = "true";
  }
  if (settings.musicDriver === "huge") {
    env.MUSIC_DRIVER = "HUGE_TRACKER";
  } else {
    env.MUSIC_DRIVER = "GBT_PLAYER";
  }
  if (settings.cartType === "mbc3") {
    env.RUMBLE_ENABLE = "0x20";
  } else {
    env.RUMBLE_ENABLE = "0x08";
  }

  env.GBDK_COMPILER_PRESET = String(settings.compilerPreset);

  // Clear per-source object files before restoring cache so changed sources
  // can't accidentally reuse stale .o outputs from previous runs.
  const resetObjFilesStartedAt = Date.now();
  const objFiles = (await buildLinkFile(buildRoot))
    .split("\n")
    .filter((filename) => filename.length > 0);
  await Promise.all(objFiles.map((objFile) => fs.remove(objFile)));
  logTiming(progress, "makeBuild.resetObjFiles", resetObjFilesStartedAt);
  progress(`[stats] makeBuild resetObjFiles removed=${objFiles.length}`);

  // Populate /obj with cached data
  const fetchObjCacheStartedAt = Date.now();
  const cacheFetchStats = await fetchCachedObjData(buildRoot, tmpPath, env);
  logTiming(progress, "makeBuild.fetchCachedObjData", fetchObjCacheStartedAt);
  progress(
    `[stats] objCache fetch sourceFiles=${cacheFetchStats.sourceFiles} hits=${cacheFetchStats.cacheHits} misses=${cacheFetchStats.cacheMisses} staleRemoved=${cacheFetchStats.staleObjectsRemoved}`,
  );

  // Compile Source Files
  const getBuildCommandsStartedAt = Date.now();
  const makeCommands = await getBuildCommands(buildRoot, {
    colorEnabled,
    sgb: sgbEnabled,
    musicDriver: settings.musicDriver,
    batteryless: batterylessEnabled,
    debug,
    platform: process.platform,
    targetPlatform,
    cartType: settings.cartType,
    compilerPreset: settings.compilerPreset,
  });
  logTiming(progress, "makeBuild.getBuildCommands", getBuildCommandsStartedAt);
  progress(`[stats] makeBuild compileUnits=${makeCommands.length}`);

  if (cacheFetchStats.cacheHits === 0 && makeCommands.length === 0) {
    const repairObjCacheStartedAt = Date.now();
    const repairedCacheStats = await cacheObjData(buildRoot, tmpPath, env);
    logTiming(progress, "makeBuild.repairObjCache", repairObjCacheStartedAt);
    progress(
      `[stats] objCache repair sourceFiles=${repairedCacheStats.sourceFiles} stored=${repairedCacheStats.cachedObjects}`,
    );
  }

  const options = {
    cwd: buildRoot,
    env,
    shell: true,
  };

  // Build source files in parallel
  const compileSourcesStartedAt = Date.now();
  const concurrency = cpuCount;
  await Promise.all(
    Array(concurrency)
      .fill(makeCommands.entries())
      .map(async (cursor) => {
        for (const [_, makeCommand] of cursor) {
          if (cancelling) {
            throw new Error("BUILD_CANCELLED");
          }
          try {
            progress(makeCommand.label);
          } catch (e) {
            throw e;
          }
          const { child, completed } = spawn(
            makeCommand.command,
            makeCommand.args,
            options,
            {
              onLog: (msg) => warnings(msg), // LCC writes errors to stdout
              onError: (msg) => warnings(msg),
            },
          );
          childSet.add(child);
          await completed;
          childSet.delete(child);
        }
      }),
  );
  logTiming(progress, "makeBuild.compileSources", compileSourcesStartedAt);

  const compiledSrcFiles = makeCommands.map((makeCommand) =>
    Path.join(buildRoot, makeCommand.srcFile),
  );

  // GBSPack ---

  if (cancelling) {
    throw new Error("BUILD_CANCELLED");
  }

  // Link ROM ---

  if (cancelling) {
    throw new Error("BUILD_CANCELLED");
  }

  progress(`${l10n("COMPILER_LINKING")}...`);
  const prepareLinkStartedAt = Date.now();
  const linkFile = await buildLinkFile(buildRoot);
  const linkFilePath = `${buildRoot}/obj/linkfile.lk`;
  await fs.writeFile(linkFilePath, linkFile);

  const linkCommand =
    process.platform === "win32"
      ? `..\\_gbstools\\gbdk\\bin\\lcc.exe`
      : `../_gbstools/gbdk/bin/lcc`;
  const linkArgs = buildLinkFlags(
    linkFilePath,
    romFilename,
    data.metadata.name || "GBStudio",
    settings.cartType,
    colorEnabled,
    sgbEnabled,
    colorOnly,
    settings.musicDriver,
    batterylessEnabled,
    debug,
    targetPlatform,
  );
  logTiming(progress, "makeBuild.prepareLinkInputs", prepareLinkStartedAt);

  const linkCacheStartedAt = Date.now();
  const linkCacheRoot = `${tmpPath}/_gbscache/link`;
  const linkFingerprint = checksumString(
    [buildToolsVersion, linkFile, linkArgs.join("\n")].join("\n---\n"),
  );
  const linkCacheDir = `${linkCacheRoot}/${linkFingerprint}`;
  const linkCacheRomDir = `${linkCacheDir}/rom`;
  await fs.ensureDir(linkCacheRoot);

  const canReuseLinkedOutput = makeCommands.length === 0;
  let linkCacheHit = false;

  if (canReuseLinkedOutput && (await fs.pathExists(linkCacheRomDir))) {
    await fs.remove(`${buildRoot}/build/rom`);
    await fs.copy(linkCacheRomDir, `${buildRoot}/build/rom`);
    linkCacheHit = true;
    progress(`[stats] makeBuild linkCache=hit`);
  } else {
    progress(
      `[stats] makeBuild linkCache=miss reason=${canReuseLinkedOutput ? "cache-not-found" : "objects-recompiled"}`,
    );
  }
  logTiming(progress, "makeBuild.linkCacheLookup", linkCacheStartedAt);

  if (!linkCacheHit) {
    const { completed: linkCompleted, child } = spawn(
      linkCommand,
      linkArgs,
      options,
      {
        onLog: (msg) => progress(msg),
        onError: (msg) => {
          if (msg.indexOf("Converted build") > -1) {
            return;
          }
          warnings(msg);
        },
      },
    );

    childSet.add(child);
    const linkStartedAt = Date.now();
    await linkCompleted;
    childSet.delete(child);
    logTiming(progress, "makeBuild.link", linkStartedAt);

    const storeLinkCacheStartedAt = Date.now();
    await fs.remove(linkCacheRomDir);
    await fs.copy(`${buildRoot}/build/rom`, linkCacheRomDir);
    logTiming(progress, "makeBuild.storeLinkCache", storeLinkCacheStartedAt);
  } else {
    progress(`[timing] makeBuild.link: 0ms`);
  }

  // Export game globals to ROM directory
  const exportGlobalsStartedAt = Date.now();
  const gameGlobalsPath = `${buildRoot}/include/data/game_globals.i`;
  const gameGlobalsExportPath = `${buildRoot}/build/rom/globals.i`;
  await fs.copyFile(gameGlobalsPath, gameGlobalsExportPath);
  logTiming(progress, "makeBuild.exportGlobals", exportGlobalsStartedAt);

  // Store /obj in cache
  const cacheObjDataStartedAt = Date.now();
  const cacheStoreStats = await cacheObjData(
    buildRoot,
    tmpPath,
    env,
    compiledSrcFiles,
  );
  logTiming(progress, "makeBuild.cacheObjData", cacheObjDataStartedAt);
  progress(
    `[stats] objCache store sourceFiles=${cacheStoreStats.sourceFiles} stored=${cacheStoreStats.cachedObjects}`,
  );
};

export const cancelBuildCommandsInProgress = async () => {
  cancelling = true;
  // Kill all spawned commands and any commands that were spawned by those
  // e.g lcc spawns sdcc, etc.
  for (const child of childSet) {
    if (child.pid === undefined) {
      continue;
    }
    const spawnedChildren = await psTreeAsync(child.pid);
    for (const childChild of spawnedChildren) {
      try {
        process.kill(Number(childChild.PID));
      } catch (e) {}
    }
    try {
      child.kill();
    } catch (e) {}
  }
};

export default makeBuild;
