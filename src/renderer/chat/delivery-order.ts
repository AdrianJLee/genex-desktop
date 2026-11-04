import type { EventEnvelope } from "../types.ts";
import { CustomEvent, customRecord } from "../../shared/custom-events.ts";
import { type QueuedMessage, QueueState, messageQueueState } from "../../shared/message-queue.ts";

/**
 * The record a message's bubble moves before, by the state it is in: it reads where the agent
 * first saw it. Waiting input (queued, or steering: handed to the running turn but not read yet)
 * has none, and moves to the end. A state not listed keeps its place.
 */
const READ_AT: Partial<Record<QueueState, CustomEvent | null>> = {
  [QueueState.Queued]: null,
  [QueueState.Steering]: null,
  [QueueState.Processing]: CustomEvent.CoordinatorMessageProcessing,
  [QueueState.Handled]: CustomEvent.CoordinatorMessageProcessing,
  [QueueState.Delivered]: CustomEvent.CoordinatorMessageDelivered,
};
/** The records a bubble can move before. */
const READ_RECORDS: ReadonlySet<string> = new Set([
  CustomEvent.CoordinatorMessageProcessing,
  CustomEvent.CoordinatorMessageDelivered,
]);

/** A record a bubble can move before, keyed `<record>:<messageId>`; null for any other record. */
function readAt(event: EventEnvelope): string | null {
  const custom = customRecord(event.data);
  if (!custom || !READ_RECORDS.has(custom.event_type)) return null;
  const id = custom.payload.messageId;
  return typeof id === "string" && id ? `${custom.event_type}:${id}` : null;
}

/**
 * The messages that move, by the id of their user row: each waiting one (to the end), and each
 * read one whose reading is recorded (to that record).
 */
function movingMessages(messages: Iterable<QueuedMessage>, recorded: ReadonlySet<string>): Map<string, string> {
  const moving = new Map<string, string>();
  for (const message of messages) {
    const type = READ_AT[message.state];
    if (!message.eventId || type === undefined) continue;
    const at = type ? `${type}:${message.messageId}` : `waiting:${message.messageId}`;
    if (!type || recorded.has(at)) moving.set(message.eventId, at);
  }
  return moving;
}

/**
 * A follow-up belongs where it was delivered, not where it was typed. A message still waiting
 * moves to the end (the panel shows it below the current work); one answered by a turn of its
 * own moves to the moment its processing began, so a message typed during a build reads after
 * that build; one steered into a running turn moves to where that turn read it, which may be in
 * the middle of its work. Messages without that recorded moment keep their place.
 */
export function deliveryOrder(events: EventEnvelope[], messages = messageQueueState(events).messages): EventEnvelope[] {
  const recorded = new Set<string>();
  for (const event of events) {
    const at = readAt(event);
    if (at) recorded.add(at);
  }
  const moving = movingMessages(messages.values(), recorded);
  if (!moving.size) return events;
  const held = new Map<string, EventEnvelope>();
  const result: EventEnvelope[] = [];
  for (const event of events) {
    const at = moving.get(event.id);
    if (at) {
      held.set(at, event);
      continue;
    }
    const key = readAt(event);
    const message = key ? held.get(key) : undefined;
    if (key && message) {
      result.push(message);
      held.delete(key);
    }
    result.push(event);
  }
  return [...result, ...held.values()];
}
