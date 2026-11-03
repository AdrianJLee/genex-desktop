/**
 * The one mark Genex's own messages carry on an engine with no field saying who wrote a message
 * (Codex, Cursor, Grok Build, OpenCode, the local sessions). It is the header Claude Code 2.1.257
 * itself puts on a message pushed with `isSynthetic` (claude-steer.ts), so every engine reads
 * Genex's lines the same way: never as the person's words.
 */
import { MessageFrom } from "../../shared/engine-requests.ts";

/** The header over a message Genex wrote. */
export const GENEX_MARK = "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]";

/** A message's text as an engine with no sender field sends it: Genex's under the mark, anyone else's as written. */
export function textAsSent(message: { text: string; from?: MessageFrom | undefined }): string {
  return message.from === MessageFrom.Genex ? `${GENEX_MARK}\n${message.text}` : message.text;
}
