/**
 * Play on a game that plays as its own app (an Unreal game), as Builds and Live press it: a started
 * or forwarded app says nothing more; no app to play yet, one that misses the last change or one
 * that didn't start asks the open chat to send "Run the game"; a package under way says so and asks
 * nothing; with no chat open to take the ask, Play says to open it.
 */
import assert from "node:assert/strict";
import { afterEach, describe, it } from "node:test";
import { playGame, RUN_THE_GAME_EVENT, type RunTheGame } from "../../src/renderer/game-play.ts";
import { GAME_PLAY_WORDS } from "../../src/renderer/words.ts";
import { LocalPlayState } from "../../src/shared/play-native.ts";

const GAME = "dust";
const scope = globalThis as unknown as { window?: unknown };

/** A window with only what Play reaches: its events and `studio.playGameBuild` answering `state`. */
function windowAnswering(state: LocalPlayState, chat: "takes" | "none" = "takes") {
  const events = new EventTarget();
  const asked: string[] = [];
  const calls: string[] = [];
  if (chat === "takes")
    events.addEventListener(RUN_THE_GAME_EVENT, (event) => {
      const detail = (event as CustomEvent<RunTheGame>).detail;
      detail.taken = true;
      asked.push(detail.project);
      detail.answer(true);
    });
  scope.window = Object.assign(events, {
    studio: {
      playGameBuild: async (project: string) => {
        calls.push(project);
        return { state };
      },
    },
  });
  return { asked, calls };
}

afterEach(() => {
  delete scope.window;
});

describe("Play on a game that plays as its own app", () => {
  it("asks the open chat to run the game when there is no app to play", async () => {
    for (const state of [LocalPlayState.NoBuild, LocalPlayState.Stale, LocalPlayState.Failed]) {
      const { asked, calls } = windowAnswering(state);
      const told: string[] = [];
      await playGame(GAME, (text) => told.push(text));
      assert.deepEqual(calls, [GAME], state);
      assert.deepEqual(asked, [GAME], `${state}: the game's open chat sends "Run the game"`);
      assert.deepEqual(told, [], state);
    }
  });

  it("says nothing more once the app started or came forward", async () => {
    for (const state of [LocalPlayState.Launched, LocalPlayState.Shown]) {
      const { asked } = windowAnswering(state);
      const told: string[] = [];
      await playGame(GAME, (text) => told.push(text));
      assert.deepEqual([asked, told], [[], []], state);
    }
  });

  it("says a package is under way, or that Genex can't play here, asking nothing", async () => {
    const rows: Array<[LocalPlayState, string]> = [
      [LocalPlayState.Packaging, GAME_PLAY_WORDS.packaging],
      [LocalPlayState.Unsupported, GAME_PLAY_WORDS.unsupported],
    ];
    for (const [state, words] of rows) {
      const { asked } = windowAnswering(state);
      const told: string[] = [];
      await playGame(GAME, (text) => told.push(text));
      assert.deepEqual([asked, told], [[], [words]], state);
    }
  });

  it("with no chat of the game open to take the ask, says to open it", async () => {
    windowAnswering(LocalPlayState.NoBuild, "none");
    const told: string[] = [];
    await playGame(GAME, (text) => told.push(text));
    assert.deepEqual(told, [GAME_PLAY_WORDS.noChat]);
  });
});
