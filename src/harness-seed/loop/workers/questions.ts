/**
 * The questions workers wait on the person with, read from the chat's log: each one's
 * `tool_permission` row names the worker (`worker.id`), and a pending row stays pending until the
 * person answers or the card's own wait ends (then its call hears that nobody answered, which is not
 * a no). The person answers the card itself; the shared pool reads its own workers' rows.
 */
import type { AnyRecord } from "../../types/harness.d.ts";
import type { EventEnvelope } from "../../types/host-api.d.ts";
import { EventKind } from "../run-events.ts";
import { WORKER_QUESTION_EVENT, type WorkerQuestion } from "./contract.ts";

/** A worker's question in the chat's log, or null for any other row. */
export function questionOf(event: EventEnvelope): WorkerQuestion | null {
  const data = event.data as AnyRecord;
  if (data?.type !== EventKind.Custom || data.event_type !== WORKER_QUESTION_EVENT) return null;
  const payload = data.payload as WorkerQuestion | null;
  return typeof payload?.requestId === "string" && typeof payload.worker?.id === "string" ? payload : null;
}

/** What a question asks, in a few words: the engine's sentence, the thing to decide on, or its id. */
export function questionText(question: WorkerQuestion): string {
  return question.title || question.subject || question.requestId;
}
