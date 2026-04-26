import fs from "fs-extra";
import rimraf from "rimraf";
import { promisify } from "util";
import { buildToolsRoot } from "consts";
import copy from "lib/helpers/fsCopy";

const rmdir = promisify(rimraf);

const ensureBuildTools = async (tmpPath: string) => {
  const buildToolsPath = `${buildToolsRoot}/${process.platform}-${process.arch}`;
  const expectedBuildToolsVersionPath = `${buildToolsPath}/tools_version`;
  const expectedToolsVersion = await fs.readFile(
    expectedBuildToolsVersionPath,
    "utf8",
  );

  const tmpBuildToolsPath = `${tmpPath}/_gbstools`;
  const tmpBuildToolsVersionPath = `${tmpPath}/_gbstools/tools_version`;

  try {
    const toolsVersion = await fs.readFile(tmpBuildToolsVersionPath, "utf8");
    if (toolsVersion === expectedToolsVersion) {
      return tmpBuildToolsPath;
    }
  } catch (e) {
    // Build tools not initialized in tmp path yet
  }

  await rmdir(tmpBuildToolsPath);
  await copy(buildToolsPath, tmpBuildToolsPath, {
    overwrite: true,
    mode: 0o755,
  });

  return tmpBuildToolsPath;
};

export default ensureBuildTools;
