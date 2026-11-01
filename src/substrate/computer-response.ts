/**
 * Whether a game answered the player. The computer session compares a game's state before and after
 * each move that pressed something, with what moves on its own set aside (the clock, the frame count
 * and rate, the input echo, what the game marks volatile), or goes by the game's own checksum when it
 * keeps one. Inputs in a row that changed nothing usually mean something holds the controls: a menu
 * or dialog, a cutscene, a player who is dead or not spawned, a window without focus. A clock that
 * did not move either means the game is paused or stopped. The session only says so; it decides
 * nothing.
 *
 * Electron-free and pure but for the watch's own count: the session reads the states and keeps one
 * watch per session.
 */
import { EnginePlayStateField } from "../shared/engine-play.ts";
import { PlayStateField } from "../shared/play-protocol.ts";

/** Inputs in a row that changed nothing before the session says so. */
export const STILL_INPUTS_NOTED = 3;

/** How a move that pressed something left the game. */
export const StillKind = {
  /** Its state was as before. */
  Unchanged: "unchanged",
  /** Its state was as before and its clock did not move: paused or stopped. */
  Frozen: "frozen",
} as const;
export type StillKind = (typeof StillKind)[keyof typeof StillKind];

/** Top-level fields that change with time alone or echo the input, never with what the player did. */
const SET_ASIDE: ReadonlySet<string> = new Set<string>([
  PlayStateField.Volatile,
  PlayStateField.Input,
  ...Object.values(EnginePlayStateField),
]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** What the game's state says about the game itself, as one string; null when there is no state. */
export function stateFingerprint(state: unknown): string | null {
  if (state === null || state === undefined) return null;
  if (!isRecord(state)) return JSON.stringify(state);
  const checksum = state[PlayStateField.Checksum];
  if (typeof checksum === "string") return checksum;
  return JSON.stringify(Object.fromEntries(Object.entries(state).filter(([key]) => !SET_ASIDE.has(key))));
}

/** The game's clock in a state, when the state carries one. */
function gameSecondsOf(state: unknown): number | null {
  const seconds = isRecord(state) ? state[EnginePlayStateField.GameSeconds] : undefined;
  return typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null;
}

/** How a move left the game: still (and whether its clock stood too), or null when it changed it or there is nothing to compare. */
export function stillAfter(before: unknown, after: unknown): StillKind | null {
  const was = stateFingerprint(before);
  if (was === null || was !== stateFingerprint(after)) return null;
  const from = gameSecondsOf(before);
  const to = gameSecondsOf(after);
  return from !== null && to !== null && to <= from ? StillKind.Frozen : StillKind.Unchanged;
}

/** The note a move earns: how many inputs in a row changed nothing, and whether the clock stood through all of them. */
export interface StillNote {
  inputs: number;
  kind: StillKind;
}

/** One session's watch: the last state seen, the still inputs in a row, and all of them. */
export interface StillWatch {
  /** A state read outside a judged move (after a wait, a look at the state, a move that only pointed). */
  seen(state: unknown): void;
  /**
   * A move that pressed something and was taken: how it left the game against the last state seen,
   * and the note once enough in a row changed nothing. With no state seen before it, it is not judged.
   */
  judge(after: unknown): { kind: StillKind | null; note: StillNote | null };
  /** Every judged move that changed nothing. */
  readonly total: () => number;
}

/** A watch with nothing seen yet. */
export function stillWatch(): StillWatch {
  let last: unknown = null;
  let run = 0;
  let frozen = 0;
  let total = 0;
  return {
    seen: (state) => {
      last = state;
    },
    judge: (after) => {
      const kind = stillAfter(last, after);
      last = after;
      if (kind === null) {
        run = 0;
        frozen = 0;
        return { kind, note: null };
      }
      run += 1;
      total += 1;
      if (kind === StillKind.Frozen) frozen += 1;
      if (run < STILL_INPUTS_NOTED) return { kind, note: null };
      return { kind, note: { inputs: run, kind: frozen === run ? StillKind.Frozen : StillKind.Unchanged } };
    },
    total: () => total,
  };
}
