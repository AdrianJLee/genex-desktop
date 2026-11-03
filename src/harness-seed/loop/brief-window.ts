/**
 * How much of the conversation a session that starts in a chat that began before it is told
 * verbatim (chat-continuity.ts `historyNotice`).
 */

/** The latest messages the history notice quotes. */
export const TRANSCRIPT_MESSAGES = 20;
/** The most of them it quotes, in characters, counted from the end. */
export const TRANSCRIPT_CHARS = 18_000;
