/**
 * What the app does differently for a game linked to an Unreal project (`shared/game-engine.ts`):
 * Rewind says when Unreal's changes stay, and the Live tab's Unreal card opens the editor through
 * the Unreal plugin. Tested through the pure rules the Rewind dialog and the stage apply.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  UNREAL_PLUGIN_ID,
  UnrealPluginAction,
  unrealOpener,
  unrealProjectOf,
  unrealRewindNote,
} from "../../src/renderer/unreal-game.ts";
import { UNREAL_WORDS } from "../../src/renderer/words.ts";
import type { EngineBinding } from "../../src/shared/game-engine.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";

const linked = (project: string): EngineBinding => ({ kind: "unreal", project, linkedAt: "2026-10-04T10:00:00.000Z" });
const GAME_DIR = "/Users/me/AI Games/fog-valley";
const outsideGame = { dir: GAME_DIR, engine: linked("/Users/me/Documents/Unreal Projects/Valley/Valley.uproject") };
const insideGame = { dir: GAME_DIR, engine: linked(`${GAME_DIR}/unreal/Valley.uproject`) };
const webGame: { dir: string; engine?: EngineBinding } = { dir: GAME_DIR };

describe("Rewind in an Unreal game", () => {
  it("says Unreal's changes stay when the project is outside the game folder", () => {
    assert.equal(unrealRewindNote(outsideGame), UNREAL_WORDS.rewindNote("Valley"));
    assert.match(UNREAL_WORDS.rewindNote("Valley"), /Valley/);
  });

  it("says nothing for a web game, no game, or a project inside the game folder", () => {
    assert.equal(unrealRewindNote(webGame), null);
    assert.equal(unrealRewindNote(null), null);
    assert.equal(unrealRewindNote(insideGame), null);
    assert.equal(unrealRewindNote({ dir: `${GAME_DIR}/`, engine: insideGame.engine }), null, "a trailing slash");
  });

  it("reads a project beside the game folder, or the folder's own name, as outside", () => {
    const hostile = [
      `${GAME_DIR}-copy/unreal/Valley.uproject`,
      `${GAME_DIR}.uproject`,
      "/Users/me/AI Games/Valley.uproject",
      "/Valley.uproject",
    ];
    for (const project of hostile)
      assert.equal(
        unrealRewindNote({ dir: GAME_DIR, engine: linked(project) }),
        UNREAL_WORDS.rewindNote(project.split("/").pop()?.replace(".uproject", "") ?? ""),
        project,
      );
  });
});

describe("the Live tab's Unreal card", () => {
  it("names an Unreal game's project and none for a web game", () => {
    assert.equal(unrealProjectOf(outsideGame), outsideGame.engine.project);
    assert.equal(unrealProjectOf(webGame), null);
    assert.equal(unrealProjectOf(null), null);
  });

  const plugin = (patch: Partial<PluginInfo> = {}, actions = [UnrealPluginAction.OpenEditor]): PluginInfo =>
    ({
      manifest: { id: UNREAL_PLUGIN_ID, actions: actions.map((name) => ({ name, label: name })) },
      enabled: true,
      removed: false,
      ...patch,
    }) as PluginInfo;

  it("opens the editor through the Unreal plugin only while it is on and declares Open in Unreal", () => {
    const on = plugin();
    assert.equal(unrealOpener([on]), on);
    assert.equal(unrealOpener([plugin({ enabled: false })]), null, "turned off");
    assert.equal(unrealOpener([plugin({ removed: true })]), null, "removed");
    assert.equal(unrealOpener([plugin({ unlisted: true })]), null, "found on disk, never allowed");
    assert.equal(unrealOpener([plugin({}, [])]), null, "an Unreal plugin without the action");
    assert.equal(unrealOpener([]), null, "not installed");
    const other = { ...plugin(), manifest: { ...plugin().manifest, id: "blender" } } as PluginInfo;
    assert.equal(unrealOpener([other]), null, "another plugin with the same action");
  });
});
