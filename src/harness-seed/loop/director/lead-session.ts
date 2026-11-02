/**
 * One session: a waking run's lead IS its chat's own contractor session, and there is one session
 * per chat.
 *
 * Before this, launching a build from a chat handed the run to a second mind: a director session
 * of its own, opened in the run's integration worktree beside the chat's contractor session, which
 * knew nothing of the conversation the build came from and wrote a memory file to survive its own
 * compactions. Now the chat's own session leads: the run resumes the session the chat's bookmark
 * names (`contractor_session`), in the game folder where that session lives, and it builds with its
 * own hands in the integration worktree it leads, beside its workers — never read-only, limited only
 * by the chat's permission mode. A lead model of its own on that engine is the session's model
 * option. After the close the chat goes on in the same session, before, during and after the build
 * one conversation.
 *
 * When the chat has no session this lead can continue — none yet, its bookmark names another
 * engine, or it cannot be resumed — the lead starts a fresh one in the game folder with the brief,
 * the chat's latest messages and the digest (`freshChat`), and it becomes the chat's bookmark.
 *
 * The long turn (`run.directorLoop: "turn"`), the classic pipeline and a kept older director.ts
 * keep the separate director in its integration worktree.
 */
import { lastContractorSession } from "../chat-session.ts";
import { HostMethod } from "../host-methods.ts";
import { plannerModel } from "../model-roles.ts";
import { EventKind, RunEvent } from "../run-events.ts";
import { compactedSummary } from "../compaction-log.ts";
import { handoverSection } from "../session-compact-prompts.ts";
import { chatSoFar } from "./lead-session-prompts.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent, Run } from "../../types/harness.d.ts";

/**
 * Why the host refused a delegation before any engine ran (the error's `code`). The app's copy is
 * `DelegationRefusal` in `shared/engine-requests.ts`; wire values, never renamed.
 */
export const DelegationRefusal = {
  /** Another session holds the lock this one needs: for a lead, the build it leads. */
  FolderBusy: "folder_busy",
} as const;
export type DelegationRefusal = (typeof DelegationRefusal)[keyof typeof DelegationRefusal];

/** Did the host refuse this delegation because another session holds its lock? It passes: ask again. */
export function folderBusy(err: unknown): boolean {
  return (err as AnyRecord | null)?.code === DelegationRefusal.FolderBusy;
}

/**
 * Does every part of the run a lead depends on serve one (`SERVES_LEAD`): its words and its tools for
 * a lead seated in its game folder are there? A seed upgrade keeps a part the agent edited before one
 * session, which never exported it. Such a run seats no lead: a director whose working folder is the
 * integration worktree leads, as it did before.
 */
export function servesLead(parts: readonly Readonly<Record<string, unknown>>[]): boolean {
  return parts.every((part) => part.SERVES_LEAD === true);
}

/** Where a waking run's lead sits and whose session it is (`run.lead`). */
export interface LeadSeat {
  /** The game folder its session sits in: the live folder the user sees. */
  folder: string;
  /** Its session is the chat's own: the chat's bookmark follows it (`bookmarkLead`). */
  chatSession: boolean;
  /** The session its first turn resumes: the chat's; null opens a fresh one. */
  sessionId: string | null;
  /** The session the chat's bookmark names now, so an unchanged one is not written again. */
  bookmarked: string | null;
  engine: string | undefined;
  model: string | null;
}

/** The chat's bookmark as the lead reads it: its session, engine and folder. */
export interface ChatBookmark {
  sessionId: string;
  engine: string | undefined;
  project?: string;
}

/** The chat's current session, whatever its engine: what the chat resumes next (chat-session.ts `lastContractorSession`). */
export function chatBookmark(events: readonly (HarnessEvent | AnyRecord)[] | undefined): ChatBookmark | null {
  const found = lastContractorSession(events ?? []);
  if (!found) return null;
  return { sessionId: found.sessionId, engine: found.engine, ...(found.project ? { project: found.project } : {}) };
}

/** Can this run's lead continue the chat's session: the same engine and the same game? A model of its own goes as the model option. */
export function continuesChat(bookmark: ChatBookmark, run: Run): boolean {
  if (!bookmark.engine || bookmark.engine !== run.engine) return false;
  return !bookmark.project || bookmark.project === run.project;
}

/**
 * The lead's seat for this run: always the chat's session (one session per chat). It continues the
 * chat's session when it can; otherwise — the chat has none, or it is another engine's — a fresh
 * one opens, and is the chat's from then on.
 */
export function leadSeat({
  events,
  run,
  folder,
}: {
  events: readonly (HarnessEvent | AnyRecord)[] | undefined;
  run: Run;
  folder: string;
}): LeadSeat {
  const bookmark = chatBookmark(events);
  const sessionId = bookmark && continuesChat(bookmark, run) ? bookmark.sessionId : null;
  return {
    folder,
    engine: run.engine,
    model: plannerModel(run) ?? null,
    chatSession: true,
    sessionId,
    bookmarked: sessionId,
  };
}

/**
 * The chat's latest messages, as a fresh lead session is told them (empty when the chat has none),
 * after the handover its compaction wrote when it was compacted (session-compact.ts).
 */
export async function freshChat(ctx: HarnessCtx, threadId: string): Promise<string> {
  const listed = await ctx.call(HostMethod.EventsList, { threadId }).catch(() => []);
  const events: HarnessEvent[] = Array.isArray(listed) ? listed : [];
  // The messages the host's own `events.messages` would answer: every message event's, in order.
  const lines = events
    .flatMap((event) => (event?.data?.type === EventKind.Messages ? event.data.messages : []))
    .filter((m) => m?.role === "user" || m?.role === "assistant")
    .map((m) => ({ role: String(m.role), content: String(m.content ?? "") }))
    .filter((m) => m.content.trim());
  const handover = compactedSummary(events);
  return [handover ? handoverSection(handover) : "", chatSoFar(lines)].filter(Boolean).join("\n\n");
}

/**
 * The lead's session becomes the chat's bookmark when it is the chat's own and it changed (a fresh
 * one, or an engine that answers a resume with a new id): the chat's next turn resumes it. The host
 * keeps the chat's record (`contractor`) the same way (delegation.ts `chatLead`).
 */
export async function bookmarkLead(
  ctx: HarnessCtx,
  { threadId, run, seat }: { threadId: string; run: Run; seat: LeadSeat },
  sessionId: string | null | undefined,
): Promise<void> {
  if (!seat.chatSession || !sessionId || sessionId === seat.bookmarked) return;
  seat.bookmarked = sessionId;
  const payload = { project: run.project, engine: seat.engine, sessionId, model: seat.model };
  await ctx
    .call(HostMethod.EventsAppend, {
      threadId,
      batch: [{ type: EventKind.Custom, event_type: RunEvent.ContractorSession, payload }],
    })
    .catch(() => {});
}
