/**
 * Steer on Claude Code (`DelegateRequest.steer`): the person's messages, and Genex's own lines,
 * pushed into the running session through the SDK's streaming input. The CLI folds a message pushed
 * with priority `next` in at its next tool result, or runs it as a follow-up turn of the same
 * session when it arrives during the final answer. Its `command_lifecycle` `started` frame is the
 * moment the session read it: reported at once (`steer_delivered`), so the host records it in
 * stream order. Each frame is its sender's (`saidFrame`): the person's words as they sent them,
 * which CLI 2.1.257 shows as "The user sent a new message while you were working", and Genex's as
 * `isSynthetic`, shown under "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]".
 *
 * Only a CLI that advertises message lifecycles says whether it read a message; an older one, and
 * an interview (a message folded in at its question's or launch's tool result would be answered
 * by a turn that had already decided), take nothing mid-turn and are interrupted instead.
 */
import { randomUUID } from "node:crypto";
import { MINUTE_MS, SECOND_MS } from "../../shared/duration.ts";
import { MessageFrom } from "../../shared/engine-requests.ts";
import { markedNotices } from "./genex-mark-prompts.ts";
import {
  DelegateEventType,
  type DelegateImage,
  type DelegateRequest,
  type SteerMessage,
  type SteerSend,
} from "./types.ts";

/**
 * How long a steered message the CLI took may sit unread after a result before the input is
 * closed anyway. A late message normally starts its own turn within a second of the result;
 * one that never does must not hold a finished session open (it reports as not delivered).
 * Exported for the test that runs the stall on its own clock.
 */
export const STEER_STALL_MS = 30 * SECOND_MS;

/**
 * How long a session that answered while a task of its own still runs in the background keeps its
 * input open for it: the CLI's own wait on such a shell once its input has ended
 * (`CLAUDE_CODE_PRINT_BG_WAIT_CEILING_MS`). The CLI's wait starts only then, so a shell that outruns
 * this hold may still wake the session, its Genex calls cut (`claude-code.ts` `wokeAfterEnd`); a
 * server the CLI would not wait on (a dev server left running) holds it this long too.
 */
export const BACKGROUND_HOLD_MS = MINUTE_MS;

/** The init capability of a CLI that reports each pushed message's lifecycle (2.1.281 does). */
const MESSAGE_LIFECYCLES = "msg_lifecycle_v1";

/** Where a pushed message stands, as its `command_lifecycle` frame says. Wire values: never rename one. */
const LifecycleState = {
  Queued: "queued",
  /** The session read it: in stream order, after the tool result it was folded into. */
  Started: "started",
  Completed: "completed",
  Discarded: "discarded",
  Refused: "refused",
  Cancelled: "cancelled",
} as const;
type LifecycleState = (typeof LifecycleState)[keyof typeof LifecycleState];
/** The session will never read it: it reports as not delivered. */
const DROPPED: ReadonlySet<string> = new Set<LifecycleState>([
  LifecycleState.Discarded,
  LifecycleState.Refused,
  LifecycleState.Cancelled,
]);

/** A pushed message folds in at the next tool-result boundary instead of waiting for the turn. */
const NEXT_PRIORITY = "next";
/** The person sent it: the CLI keeps only this origin from local stdin. */
const HUMAN_ORIGIN = { kind: "human" } as const;

/** Stills as the SDK's image blocks. */
function imageBlocks(images: readonly DelegateImage[]) {
  return images.map((image) => ({
    type: "image" as const,
    source: { type: "base64" as const, media_type: image.mimeType || "image/jpeg", data: image.data },
  }));
}

/** Genex's notices as text blocks of their own, each under the mark, ahead of a message's words. */
function noticeBlocks(notices: readonly string[]) {
  return markedNotices(notices).map((text) => ({ type: "text" as const, text }));
}

/** Notices, words and stills as one message's content blocks: the words only when there are any. */
function blocks(text: string, images: readonly DelegateImage[], notices: readonly string[] = []) {
  return [...noticeBlocks(notices), ...(text ? [{ type: "text" as const, text }] : []), ...imageBlocks(images)];
}

/**
 * A brief's content: Genex's notices, the text, and any stills as image blocks the text names by
 * label (WP3d) — a builder that never saw the reference read it nine times in 2,245 turns.
 */
export function userContent(text: string, images: readonly DelegateImage[], notices: readonly string[] = []) {
  if (!images.length) return [...noticeBlocks(notices), { type: "text" as const, text }];
  const labels = images.map((image) => image.label).join("; ");
  return blocks(`${text}\n\nIMAGES ATTACHED (${images.length}): ${labels}.`, images, notices);
}

/** A brief as a user message frame of the SDK's streaming input, Genex's notices ahead of it. */
export function userFrame(text: string, images: readonly DelegateImage[], notices: readonly string[] = []) {
  return {
    type: "user" as const,
    message: { role: "user" as const, content: userContent(text, images, notices) },
    parent_tool_use_id: null,
  };
}

/**
 * A message as its sender's frame, its stills those with pixels (the host's steer and `briefFrame`
 * keep only those). The person's: their words and pictures exactly as sent, from `HUMAN_ORIGIN`
 * (absent `from` is the person). Genex's: `isSynthetic` and no origin, which CLI 2.1.257 stamps
 * `unclassified` and shows the model under "[MESSAGE FROM NON-USER SOURCE - NOT USER INPUT]"
 * (mid-turn as a system message), never as the user's; it reports it `started` like any other
 * (`claude-steer-cli.test.ts`). A channel origin cannot say it: from local stdin the CLI drops
 * every origin but `human`.
 */
export function saidFrame(said: Omit<SteerMessage, "id">, notices: readonly string[] = []) {
  const message = { role: "user" as const, content: blocks(said.text, said.images ?? [], notices) };
  const sender = said.from === MessageFrom.Genex ? { isSynthetic: true as const } : { origin: HUMAN_ORIGIN };
  return { type: "user" as const, message, parent_tool_use_id: null, ...sender };
}

/** The stills of a session's first message that have pixels. */
export const briefImages = (request: Pick<DelegateRequest, "images">): DelegateImage[] =>
  (request.images ?? []).filter((image) => image?.data);

/**
 * A session's first message: a brief (no `from`) as it always was, or a message by its sender; either
 * way Genex's notices ride it as marked text blocks before the words, never as a frame of their own
 * (a second frame at the turn's start would reach the session as a message sent while it worked).
 */
export function briefFrame(request: Pick<DelegateRequest, "prompt" | "images" | "from" | "notices">) {
  const images = briefImages(request);
  const notices = request.notices ?? [];
  if (!request.from) return userFrame(request.prompt, images, notices);
  return saidFrame({ text: request.prompt, images, from: request.from }, notices);
}

/** What a steerable delegation reports back through `delegate`: the host's `ready`, and what was read. */
export interface SteerSession {
  /** Says once whether this session takes messages mid-turn; later calls are ignored. */
  tell(send: SteerSend | null): void;
  /** Ids of the steered messages the session read, in the order it read them. */
  steered: string[];
}

/** The steer half of a delegation: `ready` said exactly once, whatever ends it. */
export function steerSession(ready: (send: SteerSend | null) => void): SteerSession {
  let told = false;
  return {
    tell: (send) => {
      if (told) return;
      told = true;
      ready(send);
    },
    steered: [],
  };
}

/**
 * A steerable session's input: the brief, then each message pushed, until it is ended. The SDK
 * keeps the CLI's stdin open for exactly as long as this iterable runs, so it must end on every
 * path — an abort included, or a stopped session's `for await` would wait on it forever. What an
 * abort leaves unwritten is dropped: it was never read, so it reports as not delivered.
 */
function steerInput(first: object, signal: AbortSignal) {
  const queue: object[] = [first];
  let ended = false;
  let wake: (() => void) | null = null;
  const end = (): void => {
    ended = true;
    wake?.();
  };
  const abort = (): void => {
    queue.length = 0;
    end();
  };
  if (signal.aborted) abort();
  else signal.addEventListener("abort", abort, { once: true });
  return {
    get ended(): boolean {
      return ended;
    },
    end,
    push(message: object): void {
      queue.push(message);
      wake?.();
    },
    messages: (async function* () {
      for (;;) {
        const next = queue.shift();
        if (next) {
          yield next;
          continue;
        }
        if (ended) return;
        await new Promise<void>((resolve) => {
          wake = resolve;
        });
        wake = null;
      }
    })(),
  };
}

/** Runs `fire` after `ms` and returns what calls it off: real timers, or a test's own clock. */
export type StallSchedule = (fire: () => void, ms: number) => () => void;

/** The real clock's schedule. */
const realSchedule: StallSchedule = (fire, ms) => {
  const timer = setTimeout(fire, ms);
  return () => clearTimeout(timer);
};

/** A steerable session's input and the messages it took, as the delegation's stream reads them. */
export interface SteerFeed {
  /** The session's input, for the SDK's `prompt`. */
  prompt: AsyncIterable<object>;
  /** The session's init: tells the host once whether it takes messages mid-turn. */
  initialized(message: Record<string, unknown>, interview: boolean): void;
  /** A `command_lifecycle` frame: a pushed message read, or dropped. */
  lifecycle(message: Record<string, unknown>, onEvent: DelegateRequest["onEvent"]): void;
  /** A result: the input ends once the session has answered everything it read. */
  answered(): void;
  /** A `background_tasks_changed` frame: what the session still runs in the background. */
  background(message: Record<string, unknown>): void;
  /** A tool's result went back on the session's own thread: a task's notice owed now joins its next request. */
  toolAnswered(): void;
  /** The session is at work on its own thread again (a turn's init, a reply of its own): it took what woke it. */
  working(): void;
  /** The delegation ended: the input ends with it. */
  dispose(): void;
  /** The input has ended: the session takes nothing more over stdin, a control request included. */
  readonly ended: boolean;
}

/** The tasks a `background_tasks_changed` frame lists as the session's work: not the CLI's housekeeping (`ambient`). */
function userTasks(message: Record<string, unknown>): unknown[] {
  const tasks: unknown[] = Array.isArray(message.tasks) ? message.tasks : [];
  return tasks.filter((task) => (task as { ambient?: unknown } | null)?.ambient !== true);
}

/**
 * The session's background tasks, as its `background_tasks_changed` frames list them, and the
 * notice a task that ended owes it: the CLI puts the notice in at its next tool-result boundary
 * (priority `next`), or, when the turn has none left, runs it as a turn of its own after the result.
 */
function backgroundWork() {
  let running = 0;
  let wakeOwed = false;
  let wakeJoins = false;
  return {
    changed(message: Record<string, unknown>): void {
      const now = userTasks(message).length;
      if (now < running) {
        wakeOwed = true;
        wakeJoins = false;
      }
      running = now;
    },
    toolAnswered(): void {
      if (wakeOwed) wakeJoins = true;
    },
    /** At work again past a result, or past the tool answer the notice joined: the notice is taken. */
    working(afterResult: boolean): void {
      if (!afterResult && !wakeJoins) return;
      wakeOwed = false;
      wakeJoins = false;
    },
    /**
     * How long the input waits past a result: for a message the CLI took (`unread`) or a task's
     * notice to start a turn, and for a task still running. Zero when nothing is owed.
     */
    holdMs(unread: boolean): number {
      const startOwed = unread || wakeOwed ? STEER_STALL_MS : 0;
      return Math.max(startOwed, running > 0 ? BACKGROUND_HOLD_MS : 0);
    },
  };
}

/**
 * The input a session is fed through, held open by the delegation: a string prompt has the SDK
 * close stdin at the first result, which would cut off a message taken during the final answer
 * before the CLI started it, a resumed session's brief behind a queued notice, and every Genex
 * tool call after that result. Genex's tools answer over this input, so it stays open while the
 * session still works in the background: the turn a finished task's notice wakes reaches Genex as
 * the turn's own do (CLI 2.1.318 answers a call made past the input's end "interrupted before a
 * result was received").
 * `sessionId` names the session each message goes to;
 * `schedule` is the clock the stall runs on; `ended` hears once that the input has ended.
 */
export function steerFeed(
  steer: SteerSession,
  brief: object,
  signal: AbortSignal,
  sessionId: () => string | undefined,
  schedule: StallSchedule = realSchedule,
  ended: () => void = () => {},
): SteerFeed {
  // The brief carries a uuid so the session says when it reads it: a resumed session first
  // answers what it had queued (a background task's notice), and that result is not the brief's.
  const briefUuid = randomUUID();
  const input = steerInput({ ...brief, uuid: briefUuid }, signal);
  let briefUnread = false;
  let briefTaken = false;
  // Steers the CLI took and has not yet read, by frame uuid → the queue's message id. Read is
  // `started`, never `completed`: an abort after `queued` means the session never saw it.
  const pending = new Map<string, string>();
  let resultSinceSteer = false;
  let cancelStall: (() => void) | null = null;
  const work = backgroundWork();
  const close = (): void => {
    if (input.ended) return;
    input.end();
    ended();
  };
  const holdOff = (): void => {
    cancelStall?.();
    cancelStall = null;
  };
  // The input ends once the session has answered everything it read (a result since the last
  // steer started) and owes nothing: no message unread, no task running or notice to start — or,
  // with no progress, once its hold passes (`backgroundWork().holdMs`). Whatever never started by
  // then is reported as not delivered. Before a result there is nothing to settle, and a stall set
  // for an unread brief stands.
  const settleInput = (): void => {
    if (input.ended || !resultSinceSteer) return;
    holdOff();
    const holdMs = work.holdMs(pending.size > 0);
    if (holdMs === 0) close();
    else cancelStall = schedule(close, holdMs);
  };
  // The brief read (or dropped): only a result after it answers it.
  const briefTook = (state: string): void => {
    if (state !== LifecycleState.Started && !DROPPED.has(state)) return;
    briefTaken = true;
    briefUnread = false;
    resultSinceSteer = false;
    holdOff();
    if (DROPPED.has(state)) close();
  };
  const send: SteerSend = (message) => {
    if (input.ended || signal.aborted) return false;
    const uuid = randomUUID();
    input.push({ ...saidFrame(message), priority: NEXT_PRIORITY, uuid, session_id: sessionId() ?? "" });
    pending.set(uuid, message.id);
    return true;
  };
  return {
    prompt: input.messages,
    initialized(message, interview) {
      const capabilities = Array.isArray(message.capabilities) ? message.capabilities : [];
      const lifecycles = capabilities.includes(MESSAGE_LIFECYCLES);
      // Only a CLI that reports lifecycles says when it read the brief; an older one answers it first.
      briefUnread = lifecycles && !briefTaken;
      steer.tell(lifecycles && !interview ? send : null);
    },
    lifecycle(message, onEvent) {
      const uuid = String(message.command_uuid ?? "");
      if (uuid === briefUuid) {
        briefTook(String(message.state ?? ""));
        return;
      }
      const id = pending.get(uuid);
      if (id === undefined) return;
      const state = String(message.state ?? "");
      if (state === LifecycleState.Started) {
        pending.delete(uuid);
        resultSinceSteer = false;
        holdOff();
        steer.steered.push(id);
        onEvent?.({ type: DelegateEventType.SteerDelivered, payload: { id } });
      } else if (DROPPED.has(state)) pending.delete(uuid);
      settleInput();
    },
    answered() {
      if (briefUnread) {
        // What it answered was queued before the brief; one that never starts must not hold it open.
        holdOff();
        cancelStall = schedule(close, STEER_STALL_MS);
        return;
      }
      resultSinceSteer = true;
      settleInput();
    },
    background(message) {
      work.changed(message);
      settleInput();
    },
    toolAnswered() {
      work.toolAnswered();
    },
    working() {
      if (input.ended) return;
      // A turn under way before the brief started (another queued notice): its own result re-arms the stall.
      if (briefUnread) holdOff();
      work.working(resultSinceSteer);
      if (!resultSinceSteer) return;
      // Past a result: the turn under way answers what woke it, and its own result settles the input.
      resultSinceSteer = false;
      holdOff();
    },
    dispose() {
      holdOff();
      close();
    },
    get ended() {
      return input.ended;
    },
  };
}
