/**
 * What the chat is told after a run its own session led (after-loop-run.ts). The session itself is
 * told nothing in words: it led the run, and the run's controls it keeps are its tools.
 */

/** What the chat is told when the studio did not resume the run the session asked for. */
export const MESSAGE = {
  notResumed: (why: string) => `The build was not resumed: ${why}`,
  /** Why, when Stop came after the reply and before the run was under way again. */
  stoppedFirst: "Stop came before it started again. It stays paused.",
} as const;
