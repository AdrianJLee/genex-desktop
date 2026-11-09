/**
 * `genex__room` reached only web games: its declaration scoped it to the `web-game` fact, so a
 * Unity or Unreal game's session was never offered it. A Unity builder's tool search for it found
 * nothing and an Unreal builder wrote its own room script, though their engines' multiplayer skills
 * (Unity's section 5, Unreal's server rooms) send them to `genex__room` to validate the room module
 * and play it with bots, and the room service reads those games' `authority` blocks already
 * (`unreal-authority-room.test.ts`, `unity-multiplayer.test.ts`).
 *
 * Now it reaches every game whose engine carries Genex's multiplayer (web, Unity, Unreal, Godot),
 * through the same reach rule the registry's snapshot and the capability facts read. A game that
 * declares no room module still gets the service's own refusal, which names the block to write.
 * Games of no such engine (a Blender asset folder, a game of a kind Genex can't name) still get none.
 */
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { pluginReach } from "../../src/shared/plugins.ts";
import { CoreFact, FolderHolds, type GameKind } from "../../src/shared/project-facts.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";

const manifest = validateManifest(
  JSON.parse(await readFile(path.join(process.cwd(), "src/plugins/genex/plugin.json"), "utf8")),
);
const ROOM_TOOL = "room";

/** A game whose folder holds `id` at `at`. */
const holding = (id: string, at: string): GameKind => ({ facts: [{ id, path: at }] });

/** Whether a session for `game` is offered `genex__room`. */
const offersRoom = (game: GameKind): boolean =>
  pluginReach(manifest, game).tools.some((tool) => tool.name === ROOM_TOOL);

describe("genex__room reaches the games whose engine carries Genex's multiplayer", () => {
  it("is the Genex plugin's own room tool", () => {
    assert.equal(manifest.id, GENEX_PLUGIN_ID);
    assert.ok(manifest.tools.some((tool) => tool.name === ROOM_TOOL));
  });

  const reached: Array<[string, GameKind]> = [
    ["a web game", holding(CoreFact.WebGame, ".")],
    ["a game with no kind yet (served as a web game)", { facts: [] }],
    ["a Unity game, its project in unity/", holding(CoreFact.UnityProject, "unity")],
    [
      "a Unity game with its WebGL export (the export is no web game of its own)",
      { facts: [...holding(CoreFact.UnityProject, "unity").facts, { id: CoreFact.WebGame, path: "web" }] },
    ],
    ["an Unreal game, its project in unreal/", holding(CoreFact.UnrealProject, "unreal")],
    ["an Unreal game at its folder's root", holding(CoreFact.UnrealProject, ".")],
    ["a Godot game, its project in godot/", holding(CoreFact.GodotProject, "godot")],
  ];
  for (const [label, game] of reached)
    it(`is offered to ${label}`, () => {
      assert.equal(offersRoom(game), true, label);
    });

  const unreached: Array<[string, GameKind]> = [
    ["a folder of Blender assets", holding(CoreFact.BlenderAssets, ".")],
    ["a game of a kind Genex can't name", { facts: [], holds: FolderHolds.OwnFiles }],
  ];
  for (const [label, game] of unreached)
    it(`is not offered to ${label}`, () => {
      assert.equal(offersRoom(game), false, label);
    });
});
