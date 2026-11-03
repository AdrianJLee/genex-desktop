/**
 * A lead's turn a plugin of the game holds back at its start (`turn.start`): never an idle turn.
 * The wake loop asks again after a wait, and the turn runs once nothing holds it; it waits for as long
 * as the plugin holds it, and gives up with the hold's reason only when the run can't wait (its
 * wrap-up, or a run that is over: the person's Stop). A module of its own, so the shipped wake loop
 * needs no new name from a module an agent may have kept.
 */
import { MINUTE_MS } from "../time.ts";

/** How long the wake loop waits before it asks a held turn's start again. */
export const HELD_TURN_WAIT_MS = MINUTE_MS;

/** The clock the waits run on: the run's, or a test's. */
export type HoldClock = { sleep: (ms: number) => Promise<void> };

/**
 * Asks `held` (the hold's reason, or null when the turn may start) until the turn may start,
 * waiting {@link HELD_TURN_WAIT_MS} between asks. Answers null once it may, else the last reason as
 * soon as `giveUp` says the run can't wait.
 */
export async function whileTurnHeld(
  held: () => Promise<string | null>,
  clock: HoldClock,
  giveUp: () => boolean,
): Promise<string | null> {
  for (;;) {
    const reason = await held();
    if (reason === null) return null;
    if (giveUp()) return reason;
    await clock.sleep(HELD_TURN_WAIT_MS);
  }
}
