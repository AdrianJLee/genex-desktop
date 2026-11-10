/** What an Unreal project file is and the engine it names, the rules every Unreal module shares. */
import path from "node:path";
import { isJsonObject, readRegularFile } from "../../substrate/fsx.ts";

/** An Unreal project file's extension, compared without case. */
export const UPROJECT_EXTENSION = ".uproject";
/** A `.uproject` is a few hundred bytes; a larger file is not read for its engine. */
const UPROJECT_MAX_BYTES = 1024 * 1024;

/** Whether a value is an absolute path to a `.uproject`, by the path rules of `platform` (this computer's unless named). */
export function isProjectPath(file: unknown, platform: NodeJS.Platform = process.platform): file is string {
  const paths = platform === "win32" ? path.win32 : path.posix;
  return typeof file === "string" && paths.isAbsolute(file) && paths.extname(file).toLowerCase() === UPROJECT_EXTENSION;
}

/** A project's name: its `.uproject` file's name without the extension. */
export function projectName(file: string): string {
  return path.basename(file, path.extname(file));
}

/** The engine a `.uproject` names (its `EngineAssociation`), or "" when it can't be read as a small JSON object. */
export async function engineAssociation(file: string): Promise<string> {
  try {
    const json: unknown = JSON.parse((await readRegularFile(file, UPROJECT_MAX_BYTES)).toString("utf8"));
    return isJsonObject(json) && typeof json.EngineAssociation === "string" ? json.EngineAssociation : "";
  } catch {
    return "";
  }
}
