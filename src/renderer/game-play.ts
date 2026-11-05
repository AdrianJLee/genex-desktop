/**
 * Play for a game that plays as its own app (an Unreal game), from Builds and from Live: Genex
 * starts the newest app the game's folder holds for this computer (`studio:game.play-build`), or
 * brings its window forward. With no app to play yet, or one older than the game's last change, the
 * open chat sends "Run the game" as the person's message, and its agent packages the game and starts
 * it once Genex wakes it at the package's end. While that package runs, Play says so and sends
 * nothing more.
 */
import { LocalPlayState } from "../shared/play-native.ts";
import { type Notify, notifyProblem, ToastTone } from "./state/toasts.ts";
import { GAME_PLAY_WORDS } from "./words.ts";

export const RUN_THE_GAME_EVENT = "studio:run-the-game";

/** A Play that needs the agent: the game whose open chat asks, marked `taken` by it, answered once it sent. */
export interface RunTheGame {
  project: string;
  taken?: boolean;
  answer: (sent: boolean) => void;
}

/** What Play hands the chat's agent: no app here yet, one that misses the last change, or one that didn't start. */
const ASKS_AGENT: ReadonlySet<LocalPlayState> = new Set([
  LocalPlayState.NoBuild,
  LocalPlayState.Stale,
  LocalPlayState.Failed,
]);

/**
 * Ask `project`'s open chat to send "Run the game": whether it sent it, or null when no open chat of
 * the game took the ask (a chat that took it and sent nothing, a sign-in first, says why itself).
 */
export function runTheGame(project: string): Promise<boolean | null> {
  return new Promise<boolean | null>((resolve) => {
    const detail: RunTheGame = { project, answer: resolve };
    window.dispatchEvent(new CustomEvent<RunTheGame>(RUN_THE_GAME_EVENT, { detail }));
    if (!detail.taken) resolve(null);
  });
}

/** Play `project`: its app, or its chat's agent asked to run the game (module comment). */
export async function playGame(project: string, notify: Notify): Promise<void> {
  try {
    const { state } = await window.studio.playGameBuild(project);
    if (state === LocalPlayState.Packaging) return notify(GAME_PLAY_WORDS.packaging, ToastTone.Info);
    if (state === LocalPlayState.Unsupported) return notify(GAME_PLAY_WORDS.unsupported, ToastTone.Info);
    if (!ASKS_AGENT.has(state)) return;
    if ((await runTheGame(project)) === null) notify(GAME_PLAY_WORDS.noChat, ToastTone.Info);
  } catch (error) {
    notifyProblem(notify)(error);
  }
}
