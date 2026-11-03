/**
 * What `wrap_up` answers the lead (wrap-up.ts): the user's ask to finish is on record. The rule it
 * follows is stated once, in `WRAP_UP_SPEC` (tool-specs.ts). Model-facing text: plain facts.
 */
export const WRAP_UP_WORDS = {
  notQuoted:
    "wrap_up needs the user's own words asking to finish, quoted exactly from their message to this run. Nothing was recorded.",
  closing: "the run is already closing; nothing more to wrap up",
  already: "The user's ask to finish is already on record.",
  recorded: "Recorded: the user asked to finish.",
  /** The new Loop the user asked for is on record with the ask (next-loop.ts). */
  nextLoop: "Their new Loop starts by itself once this run has closed.",
  /** Why `worker_start` refuses once the user asked to finish. */
  noWorkers: "No worker started: the user asked to finish.",
} as const;
