/**
 * The lines Genex itself writes to a Loop's lead (wake.ts): that its Loop started or resumed, and
 * why the turn under way is its last. Each is one fact, marked as Genex's: what the lead can do is
 * in its tools' descriptions, and where the run stands is `run_status`'s answer. Model-facing: the
 * lead reads them as written.
 */

/** What Genex tells a Loop's lead. */
export const LOOP_WORDS = {
  /** The Loop's first line: its goal, as the chat's session wrote it when it started the Loop. */
  started: (goal: string) => `The Loop started. Its goal: ${goal}`,
  /** A resumed Loop's first line. */
  resumed: (goal: string) => `The Loop resumed after a pause; workers from before it no longer run. Its goal: ${goal}`,
  /** The wrap-up turn the person's Finish starts. */
  finishAsked: "The person asked the Loop to finish: it closes when this turn ends.",
  /** The wrap-up turn a failed turn starts. */
  turnFailed: (why: string) => `Your last turn failed${why ? ` (${why})` : ""}: the Loop closes when this turn ends.`,
} as const;
