/**
 * A chat turn Ollama's small default context refused: under the error, one line offering
 * "Raise context to 16K", which copies the model with a larger context and switches the chat to it.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryAction, EntryKind, toEntries } from "../../src/renderer/chat-entries.ts";
import { TRANSCRIPT_WORDS } from "../../src/renderer/words.ts";
import type { EventData, EventEnvelope } from "../../src/shared/event-log.ts";
import { raisedContextName } from "../../src/shared/ollama-context.ts";

const event = (id: number, data: EventData, turn = "turn-1"): EventEnvelope => ({
  id: String(id).padStart(6, "0"),
  thread_id: "t1",
  turn_id: turn,
  session_id: null,
  created_at: new Date(id).toISOString(),
  data,
});
const started = (id: number, metadata: Record<string, unknown>, turn?: string) =>
  event(id, { type: "turn_started", metadata }, turn);
const ended = (id: number, harnessFailure: unknown, turn?: string) =>
  event(id, { type: "turn_ended", status: "error", metadata: { harnessFailure } }, turn);
const refused = (engine: string, model: string, code = "context_too_small"): EventEnvelope[] => [
  started(1, { engine, model }),
  event(2, { type: "error", message: "Ollama runs this model with a 4,096-token context" }),
  ended(3, { code }),
];

type ActionEntry = Extract<ReturnType<typeof toEntries>[number], { kind: typeof EntryKind.Action }>;
const raiseLines = (events: EventEnvelope[]): ActionEntry[] =>
  toEntries(events).flatMap((entry) =>
    entry.kind === EntryKind.Action && entry.action === EntryAction.RaiseContext ? [entry] : [],
  );

describe("raising a local model's context from the chat", () => {
  it("offers Raise context to 16K under an Ollama turn its context refused", () => {
    const entries = toEntries(refused("ollama", "qwen3:8b"));
    const [line] = raiseLines(refused("ollama", "qwen3:8b"));
    assert.equal(entries.at(-2)?.kind, EntryKind.System, "the error's own line comes first");
    assert.equal(line?.raiseContext, "qwen3:8b");
    assert.equal(
      line?.text,
      "Genex can copy qwen3:8b to run with a 16K context. The copy shares its files, so nothing is downloaded.",
    );
    assert.equal(TRANSCRIPT_WORDS.raiseContext, "Raise context to 16K");
    assert.equal(entries.at(-1)?.id, line?.id, "the offer sits under the error that explains it");
  });

  it("offers nothing for another failure, another engine, a copy already raised or a turn it did not see start", () => {
    assert.deepEqual(raiseLines(refused("ollama", "qwen3:8b", "context_full")), []);
    assert.deepEqual(raiseLines(refused("openrouter", "qwen/qwen3-8b")), []);
    assert.deepEqual(raiseLines(refused("ollama", raisedContextName("qwen3:8b"))), [], "16K did not help");
    assert.deepEqual(raiseLines(refused("ollama", "")), []);
    assert.deepEqual(raiseLines([ended(3, { code: "context_too_small" })]), [], "no model to copy");
    for (const failure of [undefined, null, "context_too_small", { code: 7 }, { code: "Context_Too_Small" }])
      assert.deepEqual(raiseLines([started(1, { engine: "ollama", model: "qwen3:8b" }), ended(2, failure)]), []);
  });

  it("names the copy after the original's tag", () => {
    assert.equal(raisedContextName("qwen3:8b"), "qwen3:8b-16k");
    assert.equal(raisedContextName("llama3"), "llama3:latest-16k");
    assert.equal(raisedContextName("hf.co/user/model:Q4_K_M"), "hf.co/user/model:Q4_K_M-16k");
    assert.equal(raisedContextName("localhost:5000/team/model"), "localhost:5000/team/model:latest-16k");
  });
});
