/**
 * The result of a command the user ran from a reply goes to the agent as a message the chat wrote
 * itself: the send carries its origin to the harness, the queue keeps it, and the transcript never
 * draws it as the user's bubble.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { isChatReport, MessageOrigin } from "../../src/shared/protocol.ts";
import { CustomEvent } from "../../src/shared/custom-events.ts";
import { EventKind, type EventEnvelope } from "../../src/shared/event-log.ts";
import { messageQueueState } from "../../src/shared/message-queue.ts";
import { chatReportEntryIds } from "../../src/renderer/chat/transcript.ts";
// `useReport` calls no React hook: it builds the chat's sender for a command's result.
import { useReport as reporter } from "../../src/renderer/chat/use-submit.ts";
import { coreLite } from "../helpers/core-lite.ts";

const envelope = (id: string, data: EventEnvelope["data"]): EventEnvelope => ({
  id,
  thread_id: "t",
  session_id: null,
  turn_id: null,
  created_at: "2026-09-27T09:00:00.000Z",
  data,
});
const queued = (eventId: string, messageId: string, action: Record<string, unknown>) => [
  envelope(eventId, { type: EventKind.Messages, messages: [{ role: "user", content: String(action.text) }] }),
  envelope(`${eventId}-q`, {
    type: EventKind.Custom,
    event_type: CustomEvent.CoordinatorMessageQueued,
    payload: { messageId, action },
  }),
];

test("a command's result is sent to the harness with its origin", async (t) => {
  const { core } = await coreLite();
  const thread = await core.createGameThread();
  const dispatched: Record<string, unknown>[] = [];
  t.mock.method(core.host, "dispatch", async (action: Record<string, unknown>) => {
    dispatched.push(action);
  });
  await core.sendUserMessage("I ran this in the terminal", { thread, origin: MessageOrigin.CommandResult });
  await core.sendUserMessage("Make it rain", { thread });
  assert.equal(dispatched[0]?.origin, MessageOrigin.CommandResult);
  assert.equal("origin" in (dispatched[1] ?? {}), false, "the user's own words carry no origin");
});

test("the transcript leaves out the messages the chat wrote itself, and only those", () => {
  const events = [
    ...queued("e1", "m1", { text: "Convert the recordings" }),
    ...queued("e2", "m2", { text: "I ran this in the terminal", origin: MessageOrigin.CommandResult }),
    ...queued("e3", "m3", { text: "A stranger origin", origin: "something-else" }),
  ];
  const { messages } = messageQueueState(events);
  assert.deepEqual([...chatReportEntryIds(messages.values())], ["e2-0:user"]);
  assert.equal(isChatReport(undefined), false);
  assert.equal(isChatReport({ origin: MessageOrigin.CommandResult }), true);
});

test("a command's result is sent with its origin, on the chat's model, with no Loop commission whatever its build", async () => {
  const model = {
    selected: "claude-code::opus",
    choices: [{ key: "claude-code::opus", engine: "claude-code", model: "opus", label: "Opus", disabled: false }],
    studio: false,
    selectedEngine: { id: "claude-code" },
    plannerEffort: "low",
    roles: null,
    preferences: {},
  };
  const words = "I ran this in the terminal:\nnpm test\n\nIt failed (exit code 1). It printed nothing.";
  /** What the chat sends for a command's result while its build is in `state` (null: none yet). */
  const sendFor = async (state: string | null): Promise<Record<string, unknown>> => {
    const sent: Array<Record<string, unknown>> = [];
    const run = state ? { runId: "run-1", state } : null;
    const build = run ? { state } : null;
    const props = { onSend: async (_text: string, options: Record<string, unknown>) => void sent.push(options) };
    await reporter(
      props as never,
      { threadId: "derby-chat", run, isStudioThread: false } as never,
      { model, build } as never,
    )(words, MessageOrigin.CommandResult);
    assert.equal(sent.length, 1);
    return sent[0] ?? {};
  };
  // Flipped: before the chat's first build a result carried the chat's Loop; no send carries one now.
  for (const state of [null, "running", "paused", "finished"]) {
    const sent = await sendFor(state);
    assert.equal("autopilot" in sent, false, `${state}: no commission`);
    assert.equal(sent.origin, MessageOrigin.CommandResult);
    assert.equal(sent.engine, "claude-code");
  }
});
