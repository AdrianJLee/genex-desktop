/**
 * The line a run's lead takes the chat on while its build runs (live chat). The chat's queue
 * hands the lead a message the person sends (loop/live-chat.ts) instead of holding it until the
 * run is over, and the lead's own loop reads it from here (director/news.ts): at its next step in a
 * turn under way, or as the message that wakes it. What the lead heard is recorded on the run's log,
 * so a later run of the run never tells it again (run-inbox.ts). What it never heard when its run
 * ends goes back to the chat, where it waits for a turn of its own — so Stop still hands over to it.
 * A message sent before the line opens (the run still prepares its start) waits for it.
 */
import { HostMethod } from "../host-methods.ts";
import { EventKind, RunEvent } from "../run-events.ts";
import { SteerDelivery } from "../steer-delivery.ts";
import type { QueueAction } from "../message-queue.ts";
import type { HarnessCtx } from "../../types/harness.d.ts";

/** Puts messages back in the chat's queue, in the order they were sent. */
export type GiveBack = (items: QueueAction[]) => Promise<void>;

/** A settled-from-outside promise: the next word on the line. */
interface Signal {
  promise: Promise<void>;
  resolve(): void;
}

function signal(): Signal {
  let resolve = () => {};
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
}

/** A run's lead, as the chat reaches it. */
export interface LeadLine {
  readonly runId: string;
  /** The chat the run tells its story in: only its messages reach the lead. */
  readonly threadId: string;
  /** It takes the chat's messages now: its run goes on, its wrap-up included. */
  open(): boolean;
  /** No more messages: the run is over for its lead. */
  shut(): void;
  /**
   * A message was handed to it (`giveBack` returns it to the chat): a turn under way hears it at
   * once. One handed already, by its id, is handed once.
   */
  hear(item: QueueAction, giveBack: GiveBack): void;
  /** Settles when the next message is handed to it. */
  heard(): Promise<void>;
  /** The messages handed to it that the lead has not heard yet, in the order sent. */
  unheard(): readonly QueueAction[];
  /**
   * The lead heard every message handed up to `item` (in a message it took, or read mid-turn):
   * recorded on the run's log, when the line was opened with the run's ctx.
   */
  heardThrough(item: QueueAction): Promise<void>;
  /**
   * The run is over: no more messages, and those its lead never heard go back to the chat. One
   * handed after this goes back at once.
   */
  release(): Promise<void>;
}

/** The lines open now, by run. */
const lines = new Map<string, LeadLine>();
/** Settles when a line opens or shuts: what waits for a lead looks again. */
let changed = signal();

/** Tell whatever waits for a lead that the lines changed. */
function announce(): void {
  const was = changed;
  changed = signal();
  was.resolve();
}

/**
 * The record that the run's lead heard these chat messages (`run_steering_delivered`, how `lead`,
 * by the message each came from): run-inbox.ts never tells them to a later run of the run.
 */
function heardRecords(runId: string, items: readonly QueueAction[]) {
  return items.map((item) => ({
    type: EventKind.Custom,
    event_type: RunEvent.RunSteeringDelivered,
    payload: { runId, sourceMessageId: item.messageId, how: SteerDelivery.Lead },
  }));
}

/**
 * Open the line to a run's lead: it takes the chat's messages while `live` holds (its run is
 * not over) and until it is shut. What the lead hears is recorded through `ctx`, the run's own.
 */
export function openLeadLine(
  runId: string,
  threadId: string,
  live: () => boolean,
  ctx?: Pick<HarnessCtx, "call">,
): LeadLine {
  let isShut = false;
  let released = false;
  let heardCount = 0;
  let next = signal();
  const handed: Array<{ item: QueueAction; giveBack: GiveBack }> = [];
  const line: LeadLine = {
    runId,
    threadId,
    open: () => !isShut && live(),
    shut: () => {
      if (isShut) return;
      isShut = true;
      if (lines.get(runId) === line) lines.delete(runId);
      announce();
    },
    hear: (item, giveBack) => {
      // Handed as the run ended (its line was released while the receipt was written): nobody
      // is left to hear it, so it goes back to the chat at once.
      if (released) {
        void giveBack([item]).catch(() => {});
        return;
      }
      if (item.messageId && handed.some((one) => one.item.messageId === item.messageId)) return;
      handed.push({ item, giveBack });
      const was = next;
      next = signal();
      was.resolve();
    },
    heard: () => next.promise,
    unheard: () => handed.slice(heardCount).map(({ item }) => item),
    heardThrough: async (item) => {
      const through = handed.findIndex((one) => one.item === item) + 1;
      if (through <= heardCount) return;
      const now = handed.slice(heardCount, through).map((one) => one.item);
      heardCount = through;
      if (!ctx) return;
      await ctx.call(HostMethod.EventsAppend, { threadId, batch: heardRecords(runId, now) }).catch(() => {});
    },
    release: async () => {
      line.shut();
      released = true;
      const unheard = handed.splice(heardCount);
      heardCount = handed.length;
      const first = unheard[0];
      if (first) await first.giveBack(unheard.map(({ item }) => item)).catch(() => {});
    },
  };
  lines.set(runId, line);
  announce();
  return line;
}

/** The line to the lead of this run, while it is open. */
export function leadLineOf(runId: string): LeadLine | undefined {
  return lines.get(runId);
}

/** Settles the next time a line opens or shuts. */
export function leadLinesChanged(): Promise<void> {
  return changed.promise;
}
