/**
 * What `wrap_up` answers the lead (wrap-up.ts): the user's ask to finish is on record, and what comes
 * next. Model-facing text: plain, and never a reason to start something.
 */
export const WRAP_UP_WORDS = {
  notQuoted:
    "wrap_up needs the user's own words asking to finish, quoted exactly from their message to this run. Nothing was recorded.",
  closing: "the run is already closing; nothing more to wrap up",
  already: "The user's ask to finish is already on record.",
  recorded:
    "Recorded: the user asked to finish. No worker starts from now; when this turn ends the wrap-up starts. Tell the user this in a sentence.",
  /** The new Loop the user asked for is on record with the ask (next-loop.ts). */
  nextLoop: "Their new Loop starts by itself once this run has closed: tell them so, in the same sentence.",
  /** Why `worker_start` refuses once the user asked to finish. */
  noWorkers: "the user asked to finish: no new workers. The wrap-up starts when this turn ends.",
} as const;
