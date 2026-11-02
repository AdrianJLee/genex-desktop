/**
 * A game linked to an engine project outside its folder, in any engine: Rewind's checkpoints hold
 * only the game folder, so Rewind says what it can't undo, in the engine's own name; a project inside
 * the folder is the game's like any other file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { GameEngine, linkedEngineOf } from "../../src/shared/game-engine.ts";
import { engineProjectInFolder, engineRewindNote } from "../../src/renderer/engine-game.ts";
import { unrealRewindNote } from "../../src/renderer/unreal-game.ts";
import { GODOT_ENGINE, UNREAL_ENGINE } from "../helpers/engines.ts";

const LINKED_AT = "2026-10-15T00:00:00.000Z";
const godot = (project: string) => ({
  dir: "/Users/me/AI Games/moon",
  engine: { kind: GameEngine.Godot, project, linkedAt: LINKED_AT },
  linkedEngine: linkedEngineOf(GODOT_ENGINE),
});
const unreal = (project: string) => ({
  dir: "/Users/me/AI Games/moon",
  engine: { kind: GameEngine.Unreal, project, linkedAt: LINKED_AT },
  linkedEngine: linkedEngineOf(UNREAL_ENGINE),
});

test("a Godot project outside the game: Rewind says so in Godot's name", () => {
  const outside = godot("/Users/me/Documents/Godot Projects/Void/project.godot");
  assert.equal(engineProjectInFolder(outside), false);
  assert.equal(
    engineRewindNote(outside),
    "Rewind doesn’t undo changes made in Godot: Void is outside the game folder.",
  );
});

test("a Godot project inside the game is the game's: nothing for Rewind to add", () => {
  const inside = godot("/Users/me/AI Games/moon/godot/project.godot");
  assert.equal(engineRewindNote(inside), null);
  const lookalike = godot("/Users/me/AI Games/moon-copy/godot/project.godot");
  assert.equal(engineProjectInFolder(lookalike), false, "a folder that only starts the same is outside");
});

test("Unreal's sentence stays as it was, word for word", () => {
  const outside = unreal("/Users/me/Documents/Unreal Projects/Tower/Tower.uproject");
  assert.equal(engineRewindNote(outside), unrealRewindNote(outside));
});
