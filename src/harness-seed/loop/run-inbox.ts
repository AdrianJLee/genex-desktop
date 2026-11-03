import { messageQueueState, type QueueAction } from "./message-queue.ts";
import type { AnyRecord, HarnessCtx, HarnessEvent } from "../types/harness.d.ts";
import { HostMethod } from "./host-methods.ts";
import { EventKind, RunEvent, RunState, SteeringSource } from "./run-events.ts";
import { fromThePerson, MessageFrom, SteerDelivery } from "./steer-delivery.ts";

/** What a `run_control` record asks of a run. Persisted: never rename a value. */
export const RunControlAction = {
  /** Wrap up: let the current attempts finish, then integrate and show what is ready. */
  Finish: "finish",
} as const;
export type RunControlAction = (typeof RunControlAction)[keyof typeof RunControlAction];

/** The events that say a run exists on a thread: registered from chat, or started. */
const RUN_OPENED: readonly string[] = [RunEvent.RunRegistered, RunEvent.RunStarted];

/** The run the log describes: the newest one, or `targetRunId`, folded from its own events. */
export function latestRun(events: readonly HarnessEvent[], targetRunId: string | null = null): AnyRecord | null {
  let run = null as AnyRecord | null;
  for (const event of events) {
    const d = event?.data;
    if (d?.type !== EventKind.Custom) continue;
    const p = d.payload ?? {};
    if (targetRunId && p.runId !== targetRunId) continue;
    run = foldRunEvent(run, d.event_type, p);
  }
  return run;
}

/** The run after one of its custom events: opened, finished, paused or resumed. */
function foldRunEvent(run: AnyRecord | null, type: string, p: AnyRecord): AnyRecord | null {
  const opened = RUN_OPENED.includes(type)
    ? { ...(run?.runId === p.runId ? run : {}), ...p, state: RunState.Running }
    : run;
  if (p.runId !== opened?.runId) return opened;
  if (type === RunEvent.RunFinished) return { ...opened, ...p, state: RunState.Finished };
  if (type === RunEvent.AutopilotPaused) return { ...opened, state: RunState.Paused };
  if (type === RunEvent.AutopilotResumed) return { ...opened, state: RunState.Running };
  return opened;
}

/** Future queued user input must not leak into an earlier turn's prompt. */
export function conversationThrough(events: readonly HarnessEvent[], messageId?: string | null): HarnessEvent[] {
  const { messages } = messageQueueState(events);
  const byEvent = new Map([...messages.values()].filter((m) => m.eventId).map((m) => [m.eventId, m]));
  let reached = false;
  const omit = new Set<string | null>();
  for (const message of messages.values()) {
    if (message.state === "removed" || reached) omit.add(message.eventId);
    if (messageId && message.messageId === messageId) reached = true;
  }
  return events
    .filter((e) => !omit.has(e.id))
    .map((e) => {
      const message = byEvent.get(e.id);
      if (!message?.action?.text || e.data?.type !== EventKind.Messages) return e;
      return {
        ...e,
        data: {
          ...e.data,
          messages: e.data.messages.map((m) => (m.role === "user" ? { ...m, content: message.action!.text } : m)),
        },
      };
    });
}

/** One steer the user sent a run: the event it came in, and its payload. */
type Steer = AnyRecord & { id: string };

/** What a run's log says so far: whether this session was asked to wrap up, and the steers. */
interface InboxFold {
  finishing: boolean;
  instructions: Steer[];
  /**
   * The chat's messages a run's lead took (live chat) that are settled for the run: the lead heard
   * them, or they went back to the chat, which answered them. A later run never tells them again.
   */
  settledByLead: Set<string>;
}

function emptyInboxFold(): InboxFold {
  return { finishing: false, instructions: [], settledByLead: new Set() };
}

/**
 * Take in one event of the run's thread, in log order. A registration opens a session of the run
 * (a resume registers again), and a wrap-up asked of an earlier session is not this one's: a
 * resumed run that inherited it would wrap up at once.
 */
function absorbInboxEvent(fold: InboxFold, event: HarnessEvent, runId: string): void {
  const d = event?.data;
  if (d?.type !== EventKind.Custom) return;
  const p = d.payload ?? {};
  // A message a run's lead never heard went back to the chat, which answers it (live chat).
  const chatAnswers =
    d.event_type === RunEvent.CoordinatorMessageRequeued || d.event_type === RunEvent.CoordinatorMessageProcessing;
  if (chatAnswers) settleLeadSteers(fold, p.messageId);
  if (p.runId !== runId) return;
  if (d.event_type === RunEvent.RunRegistered) fold.finishing = false;
  if (d.event_type === RunEvent.RunControl && p.action === RunControlAction.Finish) fold.finishing = true;
  // The director's own worker_steer events are steering too — but its own, not the user's.
  const said = Boolean(p.text?.trim() || p.attachmentsArtifact);
  const userSteer = d.event_type === RunEvent.RunSteering && said && p.source !== SteeringSource.Director;
  if (userSteer) fold.instructions.push({ id: event.id, ...p });
  if (d.event_type === RunEvent.RunSteeringDelivered && p.how === SteerDelivery.Lead)
    settleLeadSteers(fold, p.sourceMessageId);
}

/** A chat message the run's lead took (live chat): the queue recorded it for the lead, by the message it came from. */
const tookFromChat = (steer: Steer): boolean => steer.how === SteerDelivery.Lead && Boolean(steer.sourceMessageId);

/**
 * A note the person left about one of the run's builds (main's `runFeedback`): theirs, though no
 * chat message carried it — the chat's own `resume_run`, which names its message, is its session's.
 */
const isNote = (steer: Steer): boolean => !steer.how && !steer.sourceMessageId;

/**
 * The steers a run's lead took from this chat message so far are settled for the run (live
 * chat): heard, or back with the chat — and a note, by its own id, once the lead heard it. One
 * recorded later from the same message — the chat's own `resume_run` — is new.
 */
function settleLeadSteers(fold: InboxFold, messageId: unknown): void {
  if (!messageId) return;
  for (const steer of fold.instructions) {
    const heardNote = isNote(steer) && steer.id === messageId;
    if (heardNote || (tookFromChat(steer) && steer.sourceMessageId === messageId)) fold.settledByLead.add(steer.id);
  }
}

/** Has the run's current session (since its latest registration) been asked to wrap up? */
export function finishRequested(events: readonly HarnessEvent[], runId: string): boolean {
  const fold = emptyInboxFold();
  for (const event of events) absorbInboxEvent(fold, event, runId);
  return fold.finishing;
}

/**
 * A steer as the run's lead's line is handed it: its words, sender and kept pictures (live-chat.ts),
 * under the message it came from — or a note's own id, which the lead's hearing of it records.
 */
function leadItemOf(threadId: string, steer: Steer): QueueAction {
  return {
    threadId,
    messageId: String(steer.sourceMessageId ?? steer.id),
    text: String(steer.text ?? ""),
    ...(fromThePerson(steer) ? {} : { from: MessageFrom.Genex }),
    ...(typeof steer.attachmentsArtifact === "string" ? { attachmentsArtifact: steer.attachmentsArtifact } : {}),
  };
}

/** The steers of one kind the run's lead has not heard (nor the chat answered), oldest first. */
const unsettled = (fold: InboxFold, kind: (steer: Steer) => boolean): Steer[] =>
  fold.instructions.filter((steer) => kind(steer) && !fold.settledByLead.has(steer.id));

/** Reads the run's thread from `after` (the whole log by default): its steers and its finish request. */
export function createRunInbox(
  ctx: HarnessCtx,
  { threadId, runId, after = null }: { threadId: string; runId: string; after?: string | null },
) {
  let cursor = after;
  let draining: Promise<void> | null = null;
  const fold = emptyInboxFold();
  async function drain() {
    if (draining) return draining;
    draining = (async () => {
      const events = await ctx.call(HostMethod.EventsList, { threadId, ...(cursor ? { after: cursor } : {}) });
      for (const event of events) absorbInboxEvent(fold, event, runId);
      const last = events.at(-1);
      if (last) cursor = last.id;
    })().finally(() => {
      draining = null;
    });
    return draining;
  }
  return {
    async finishing() {
      await drain();
      return fold.finishing;
    },
    /** Every steer's words, oldest first (the finish log, `wrap_up`'s quote): a picture sent without words has none. */
    async steering(): Promise<string[]> {
      await drain();
      return fold.instructions.map((steer) => String(steer.text ?? "")).filter(Boolean);
    },
    /** The chat's messages the run's lead took and never heard, and that never went back to the chat, oldest first. */
    async unheard(): Promise<QueueAction[]> {
      await drain();
      return unsettled(fold, tookFromChat).map((steer) => leadItemOf(threadId, steer));
    },
    /** The person's notes about the run's builds its lead has not heard, oldest first. */
    async notes(): Promise<QueueAction[]> {
      await drain();
      return unsettled(fold, isNote).map((steer) => leadItemOf(threadId, steer));
    },
  };
}

/** A run's inbox: the user's steers and finish request, read from the run's cursor on. */
export type RunInbox = ReturnType<typeof createRunInbox>;
