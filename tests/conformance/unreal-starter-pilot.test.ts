/**
 * Genex's starter pilot goes into a game folder's `pilots/` when it has no pilot, so a playtest can start
 * playing at once; never over a file, never beside a pilot already there, never through a link out.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { ensureStarterPilot, STARTER_PILOT } from "../../src/plugins/unreal/starter-pilot.ts";
import { tmpDir } from "../helpers/tmp.ts";

test("a game with no pilot gets the starter; one with a pilot, or none bound, gets nothing", async () => {
  const root = await realpath(await tmpDir("starter-pilot-"));
  const game = path.join(root, "game");
  await mkdir(game);
  assert.equal(await ensureStarterPilot(game), path.join("pilots", STARTER_PILOT));
  const text = await readFile(path.join(game, "pilots", STARTER_PILOT), "utf8");
  assert.match(text, /class Explore\(Pilot\)/);
  await writeFile(path.join(game, "pilots", STARTER_PILOT), "# the agent's own edit\n");
  assert.equal(await ensureStarterPilot(game), null, "a pilot is there");
  assert.equal(await readFile(path.join(game, "pilots", STARTER_PILOT), "utf8"), "# the agent's own edit\n");
  assert.equal(await ensureStarterPilot(undefined), null);
  await rm(path.join(game, "pilots", STARTER_PILOT));
  assert.equal(await ensureStarterPilot(game), null, "a starter the person deleted stays deleted");
  assert.deepEqual(await readdir(path.join(game, "pilots")), [".genex-starter"]);
});

test("a pilots/ that links out of the game folder gets nothing", async () => {
  const root = await realpath(await tmpDir("starter-pilot-"));
  const game = path.join(root, "game");
  const outside = path.join(root, "outside");
  await mkdir(game);
  await mkdir(outside);
  await symlink(outside, path.join(game, "pilots"));
  assert.equal(await ensureStarterPilot(game), null);
  assert.deepEqual(await readdir(outside), []);
});
