/**
 * Genex's starter pilot (`GenexEditorHelper/Templates/pilots/explore.py`): put in a game folder's
 * `pilots/` when it has no pilot yet, so a playtest can start playing at once and the agent adapts a
 * working pilot instead of pressing keys one call at a time. Written only into the game folder's own
 * `pilots/` (a link out of it is refused), never over a file, never while any pilot is there, and only
 * once: `pilots/.genex-starter` marks it given, so a starter the person deletes stays deleted.
 */
import { constants } from "node:fs";
import { copyFile, mkdir, readdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { isInside } from "../../substrate/paths.ts";

/** The starter's name in the game folder's `pilots/`. */
export const STARTER_PILOT = "explore.py";
/** The mark that the starter was given once. */
export const STARTER_GIVEN = ".genex-starter";
const TEMPLATE = fileURLToPath(new URL("./GenexEditorHelper/Templates/pilots/explore.py", import.meta.url));

/** Puts the starter pilot in `gameFolder`'s `pilots/` when it holds no `.py`; its path in the game folder, else null. */
export async function ensureStarterPilot(gameFolder: string | undefined, template = TEMPLATE): Promise<string | null> {
  if (!gameFolder) return null;
  try {
    const root = await realpath(gameFolder);
    const pilots = path.join(root, "pilots");
    const names = await readdir(pilots).catch(() => [] as string[]);
    if (names.includes(STARTER_GIVEN) || names.some((name) => name.endsWith(".py"))) return null;
    await mkdir(pilots, { recursive: true });
    if (!isInside(root, await realpath(pilots))) return null;
    await copyFile(template, path.join(pilots, STARTER_PILOT), constants.COPYFILE_EXCL);
    await writeFile(path.join(pilots, STARTER_GIVEN), "Genex gave this game its starter pilot once.\n");
    return path.join("pilots", STARTER_PILOT);
  } catch {
    return null;
  }
}
