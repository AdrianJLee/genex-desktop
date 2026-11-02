/**
 * The loop's shared numbers: how long a command may take, how long a delegated turn is given, how
 * often a window is asked for again. One place, so two parts that mean the same wait cannot drift
 * apart.
 *
 * What is NOT here on purpose: a part's own policy (the lead's window and worker limits in
 * director.ts). Those are the shape of one part's work and live beside the code that reads them.
 */
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "./time.ts";

/** How long a git command may take: `ref` for a ref write, `quick` for a read, `slow` for a merge or a commit. */
export const GIT_TIMEOUT_MS = Object.freeze({ ref: 30 * SECOND_MS, quick: MINUTE_MS, slow: 2 * MINUTE_MS });

/** A delegated turn is never given less than this: one asked to finish in seconds fails for the clock, not its work. */
export const MIN_DELEGATE_TIMEOUT_MS = MINUTE_MS;

/**
 * The effort a small, bounded ask runs at, whatever effort the user set for a role or the run: a
 * run at high effort must not pay high effort for each of them.
 */
export const LIGHT_EFFORT = "low";

/** A run's wall clock when its spec names none: a day. */
export const DEFAULT_WALL_CLOCK_MS = 24 * HOUR_MS;

/** The ceiling of a Loop's run, in hours: it goes until its lead finishes it, within this. */
export const MAX_RUN_HOURS = 24;

/** The rounds a direct engine's build turn may take in the harness's own tool loop. */
export const BUILD_TURN_MAX_ROUNDS = 30;

/**
 * How long a pass waits for a window before it decides there is none. The pool has no queue —
 * `preview.acquire` throws the instant every window is leased — and a worker holds one only
 * while it looks at its own build, so asking again a few seconds later usually finds one. Three
 * asks, seven seconds in all: long enough to outlast one look, short enough that a lead is never
 * quietly blocked.
 */
export const WINDOW_RETRIES_MS = Object.freeze([SECOND_MS, 2 * SECOND_MS, 4 * SECOND_MS]);
