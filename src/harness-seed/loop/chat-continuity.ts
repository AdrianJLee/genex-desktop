/**
 * One conversation, whichever model answers it: the person may switch the chat's model at any
 * message. A session goes on only while it is the chat's latest (`goesOn`): one that another model
 * answered after has missed those turns. A session that starts in a chat that began before it is
 * told the chat so far as one Genex notice (`historyNotice`): the handover the chat's last compaction
 * wrote, and the newest messages that fit.
 */
import { TRANSCRIPT_CHARS, TRANSCRIPT_MESSAGES } from "./brief-window.ts";
import { handoverSection } from "./session-compact-prompts.ts";
import type { Message } from "../types/host-api.d.ts";

/** The chat's latest session, when it is this engine's: only that one goes on. */
export function goesOn<T extends { engine?: string }>(latest: T | null, engine: string): T | null {
  return latest?.engine === engine ? latest : null;
}

/**
 * The chat so far, for a session that starts in a chat that began before it: the handover the last
 * compaction wrote (`handover`), and the newest messages that fit, the one this turn answers (`ask`,
 * its prompt) left out (null keeps it, for a prompt that is not the ask). Empty when nothing came
 * before.
 */
export function historyNotice(
  messages: readonly Partial<Pick<Message, "role" | "content">>[],
  ask: string | null,
  handover: string | null,
): string {
  const said = messages.filter((m) => m.role === "user" || m.role === "assistant");
  const last = said.at(-1);
  const answered = ask !== null && last?.role === "user" && last.content?.trim() === ask.trim();
  const earlier = answered ? said.slice(0, -1) : said;
  const latest = earlier
    .slice(-TRANSCRIPT_MESSAGES)
    .map((m) => `${m.role}: ${m.content ?? ""}`)
    .join("\n")
    .slice(-TRANSCRIPT_CHARS);
  if (!latest && !handover) return "";
  return [
    "This chat began before this session, which goes on from here.",
    ...(handover ? [handoverSection(handover)] : []),
    ...(latest ? [`The latest of it:\n${latest}`] : []),
  ].join("\n\n");
}
