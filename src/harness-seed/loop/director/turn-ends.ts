/**
 * The run's lead turn under way: wake.ts notes each one as it starts and once its session has
 * returned, and a claim made in that turn that is still under review when the turn is over loses
 * its turn (open/finish.ts `turnLost`). Kept per run state in memory, as the turn is. A module of its
 * own with no imports, so the shipped wake.ts needs no new name from a module an agent may have kept.
 */

/** The lead's turn under way, by its identity: one object per turn. */
export interface TurnEnds {
  /** Its session has returned: a claim made in it that is still checked has lost its turn. */
  over?: boolean;
}

/** The turn under way of each run, by its state. */
const TURN_ENDS = new WeakMap<object, TurnEnds>();

/** Note that the run's lead turn under way begins: a new turn, which no claim of an earlier one speaks for. */
export function noteTurnEnds(state: object): void {
  TURN_ENDS.set(state, {});
}

/** The run's lead turn under way, or undefined when no turn said. */
export function turnEndsOf(state: object): TurnEnds | undefined {
  return TURN_ENDS.get(state);
}

/** Note that the run's lead turn under way has ended (its session returned). */
export function noteTurnOver(state: object): void {
  const noted = TURN_ENDS.get(state);
  if (noted) noted.over = true;
}
