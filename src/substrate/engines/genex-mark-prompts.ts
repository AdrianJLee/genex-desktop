/**
 * The one mark Genex's own lines carry wherever they cannot say who wrote them by a field: a notice
 * beside the person's words on every engine, and a whole message Genex wrote on an engine with no
 * field saying who wrote it (Codex, Cursor, Grok Build, OpenCode, the local sessions). It is the
 * header Claude Code 2.1.257 itself puts on a message pushed with `isSynthetic` (claude-steer.ts),
 * so every engine reads Genex's lines the same way: never as the person's words.
 */
import { MessageFrom } from "../../shared/engine-requests.ts";

/** The header over a line Genex wrote. */
export const GENEX_MARK = "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]";

/** A line Genex wrote, under the mark. */
export const genexMarked = (text: string): string => `${GENEX_MARK}\n${text}`;

/** Genex's notices as every engine sends them: each under the mark, the blank ones left out. */
export const markedNotices = (notices: readonly string[] = []): string[] =>
  notices.filter((notice) => notice.trim()).map(genexMarked);

/** A message's text as an engine with no sender field sends it: Genex's under the mark, anyone else's as written. */
export function textAsSent(message: { text: string; from?: MessageFrom | undefined }): string {
  return message.from === MessageFrom.Genex ? genexMarked(message.text) : message.text;
}

/**
 * A first message's parts as an engine with no sender field sends them, in order: each of Genex's
 * notices under the mark, then the prompt as its sender wrote it. Empty parts are left out.
 */
export function textsAsSent(request: {
  prompt: string;
  from?: MessageFrom | undefined;
  notices?: readonly string[] | undefined;
}): string[] {
  const notices = markedNotices(request.notices);
  const prompt = textAsSent({ text: request.prompt, from: request.from });
  return [...notices, ...(prompt.trim() ? [prompt] : [])];
}
