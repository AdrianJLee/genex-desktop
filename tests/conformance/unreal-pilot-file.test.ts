/**
 * Which pilot file the Unreal plugin hands its helper: a plain `.py` of the game folder (Genex's own
 * `pilots/`, so writing one changes nothing of the game) by its real path; anything else goes as it
 * came, for the helper to read relative to the project or refuse. Nothing outside the game folder is
 * ever turned into a path the helper runs.
 */
import assert from "node:assert/strict";
import { mkdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { pilotFileFor } from "../../src/plugins/unreal/computer-play.ts";
import { tmpDir } from "../helpers/tmp.ts";

test("a pilot in the game folder goes by its real path; anything else goes as it came", async () => {
  const root = await realpath(await tmpDir("pilot-file-"));
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(path.join(game, "pilots"), { recursive: true });
  await mkdir(outside, { recursive: true });
  await writeFile(path.join(game, "pilots", "fight.py"), "x = 1\n");
  await writeFile(path.join(game, "pilots", "notes.txt"), "x\n");
  await writeFile(path.join(outside, "evil.py"), "raise SystemExit\n");
  await symlink(path.join(outside, "evil.py"), path.join(game, "pilots", "link.py"));
  await symlink(outside, path.join(game, "linked"));
  assert.equal(await pilotFileFor("pilots/fight.py", game), path.join(game, "pilots", "fight.py"));
  const unchanged = [
    "pilots/missing.py",
    "pilots/notes.txt",
    "pilots/link.py",
    "linked/evil.py",
    "../outside/evil.py",
    "pilots/../../outside/evil.py",
    path.join(outside, "evil.py"),
    "",
  ];
  for (const file of unchanged) assert.equal(await pilotFileFor(file, game), file, file);
  assert.equal(await pilotFileFor("pilots/fight.py", undefined), "pilots/fight.py", "no game bound");
});
