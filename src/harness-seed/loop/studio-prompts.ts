/** The words the loop's dispatch hands a model: the note a restarted harness finds in its own log. */

/** The first-person trace a restarted harness leaves itself, so the next prompt says what happened. */
export function restartNote(reason: string, detail: string | undefined): string {
  return (
    `You were restarted (${reason}${detail ? `: ${detail}` : ""}). ` +
    `Your workspace may have been rewound to the last healthy snapshot. ` +
    `Check what you were doing in the log before continuing, and do not repeat the change that broke you.`
  );
}
