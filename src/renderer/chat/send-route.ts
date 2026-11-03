/**
 * Where a message from the composer goes: a note to the build the chat replies about, the held
 * plan's inbox, plan review, or the chat's queue with a bubble that shows at once.
 */
import { PlanReviewState } from "../../shared/composer.ts";
import { keepsOwnPlan } from "../../shared/run-state.ts";
import { EntryAction, EntryKind } from "../chat-entries.ts";
import { noteSentWords, type ReplyAbout } from "../reply-about.ts";
import { type Notify, ToastTone } from "../state/toasts.ts";
import type { ComposerExtras } from "../ui/PromptBar.tsx";
import { problemWords } from "../words.ts";
import type { ConversationEntry } from "./conversation-entries.ts";
import { SendRoute } from "../analytics/chat-vocabulary.ts";
import {
  leadTakesSend,
  newClientId,
  type PendingSend,
  type SendPlacement,
  sendPlacement,
  waitsBehindWork,
} from "./pending-sends.ts";
import { finishingRun } from "./transcript.ts";
import type { ChatThread } from "./use-chat-thread.ts";
import type { ChatWorkView } from "./use-chat-work.ts";
import type { FollowScroll } from "./use-follow-scroll.ts";
import type { ReplyingAbout } from "./use-reply-about.ts";
import { errorCode } from "../../shared/errors.ts";

/** A legacy in-run plan that holds the worker until it is answered. */
export const isHeldPlan = (entry: ConversationEntry, runId: string | null, now: number): boolean =>
  entry.kind === EntryKind.Action &&
  entry.action === EntryAction.Steer &&
  Boolean(entry.pending) &&
  entry.runId === runId &&
  (entry.expiresAt ?? 0) > now;

/** Plan states that take the next message as the plan's request (main routes it alike). */
const REVIEW_TAKES_MESSAGE: ReadonlySet<string> = new Set([
  PlanReviewState.Waiting,
  PlanReviewState.Generating,
  PlanReviewState.Failed,
]);

/**
 * A reply about the build is a note to it (the steering inbox), not a chat turn: it needs no
 * model and never waits behind the build. A failure keeps the words in the composer.
 */
async function sendNote(about: ReplyAbout, text: string, onNotice: Notify): Promise<void> {
  await window.studio
    .runFeedback({ threadId: about.threadId, runId: about.runId, ...about.target, text, label: about.label })
    .catch((err: unknown) => {
      onNotice(problemWords(err), ToastTone.Error, errorCode(err));
      throw err;
    });
  onNotice(noteSentWords(about), ToastTone.Ok);
}

/**
 * Whether plan review takes a send as the plan's request: one that asks for it, or the next message
 * after a plan, while no build of the chat is running or paused (that build keeps its own plan).
 */
function toPlanReview(chat: ChatThread, work: ChatWorkView, extras?: ComposerExtras): boolean {
  const review = work.plan.review;
  const reviewTakes = Boolean(review && REVIEW_TAKES_MESSAGE.has(review.state));
  return !chat.isStudioThread && !keepsOwnPlan(chat.run) && Boolean(extras?.reviewPlan || reviewTakes);
}

/** What a send waits behind: the chat's own work, or its running build unless that build's lead takes it now. */
function sendWork(text: string, chat: ChatThread, work: ChatWorkView): Parameters<typeof waitsBehindWork>[0] {
  return {
    chatWorking: work.line.chatWorking,
    runId: chat.activeRunId,
    leadTakes: leadTakesSend(text, {
      listens: chat.leadListens,
      finishing: finishingRun(chat.threadEvents, chat.activeRunId),
    }),
  };
}

/** The bubble a send shows at once, until its durable row arrives (`chat/pending-sends.ts`). */
function pendingSend(
  send: { clientId: string; threadId: string; text: string },
  chat: ChatThread,
  work: ChatWorkView,
  extras: ComposerExtras | undefined,
): PendingSend {
  const attached = extras?.frames;
  return {
    ...send,
    after: chat.rawStateEvents.at(-1)?.id ?? null,
    placement: sendPlacement(waitsBehindWork(sendWork(send.text, chat, work)), chat.queue),
    ...(attached?.length ? { frames: attached } : {}),
  };
}

/**
 * Send as a note to the build the chat replies about, when it does; true when it went. A note
 * carries words only, so pictures sent with none go to the chat instead.
 */
export async function sentAsNote(
  reply: ReplyingAbout,
  threadId: string | undefined,
  text: string,
  onNotice: Notify,
  follow: FollowScroll,
): Promise<boolean> {
  const { about } = reply;
  if (!about || about.threadId !== threadId) return false;
  if (!text.trim()) return false;
  await sendNote(about, text, onNotice);
  reply.drop(about.threadId);
  follow.jumpToLatest();
  return true;
}

/**
 * Where a message that is not a note goes, for the send's analytics: the held plan's inbox, plan
 * review, or the chat, with where its bubble waits. Read before `showSend` adds the bubble.
 */
export function sendDestination(
  parts: { chat: ChatThread; work: ChatWorkView },
  text: string,
  extras: ComposerExtras | undefined,
  heldRun: string | null,
): { route: SendRoute; placement?: SendPlacement } {
  const { chat, work } = parts;
  if (heldRun) return { route: SendRoute.HeldPlan };
  if (toPlanReview(chat, work, extras)) return { route: SendRoute.PlanReview };
  return { route: SendRoute.Chat, placement: sendPlacement(waitsBehindWork(sendWork(text, chat, work)), chat.queue) };
}

/**
 * The bubble a message to the chat shows at once, and its id; none for the held plan's inbox or
 * for plan review, whose request shows in the plan.
 */
export function showSend(
  parts: { chat: ChatThread; work: ChatWorkView },
  text: string,
  extras: ComposerExtras | undefined,
  heldRun: string | null,
): string | undefined {
  const { chat, work } = parts;
  const { threadId } = chat;
  if (!threadId || heldRun || toPlanReview(chat, work, extras)) return undefined;
  const clientId = newClientId();
  chat.sends.add(pendingSend({ clientId, threadId, text }, chat, work, extras));
  return clientId;
}
