/**
 * Compact now on a chat with a provider session (loop/session-compact.ts): what a fresh session is
 * briefed with after it, including the chat whose session led a build that is paused, where the
 * run's controls must keep working and a Resume seats a lead that reads the handover.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { historyNotice } from "../../src/harness-seed/loop/chat-continuity.ts";
import * as delegatedTurn from "../../src/harness-seed/loop/delegated-turn.ts";
import { freshChat } from "../../src/harness-seed/loop/director/lead-session.ts";
import { compactedSummary, endedByCompaction } from "../../src/harness-seed/loop/compaction-log.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const THREAD = "thread_compact";
const RUN = "run_compact";
const HANDOVER = "The plaza's fountain works; the market stalls are next (src/market.js).";
/** A chat's `compacted` event as the log holds it. */
const compacted = (id: string, summary: string) => ({
  id,
  data: { type: "custom", event_type: "compacted", payload: { engine: "codex", summary, upTo: "0000001" } },
});

describe("what a session is briefed with after its chat was compacted", () => {
  it("reads the latest compaction's handover, and nothing when the chat never compacted", () => {
    assert.equal(compactedSummary([]), null);
    assert.equal(compactedSummary([compacted("0000002", "older"), compacted("0000005", HANDOVER)]), HANDOVER);
    assert.equal(compactedSummary([compacted("0000002", "   ")]), null, "an empty handover is none");
  });

  it("reads past a Codex compaction, which keeps its summary sealed in its session", () => {
    const sealed = {
      id: "0000007",
      data: { type: "custom", event_type: "compacted", payload: { engine: "codex", native: true, sessionId: "s" } },
    };
    assert.equal(compactedSummary([compacted("0000005", HANDOVER), sealed]), HANDOVER);
    assert.equal(compactedSummary([sealed]), null);
  });

  it("a handover ends the session it names; a provider's own compaction keeps it", () => {
    const ended = { id: "0000003", data: { type: "custom", event_type: "compacted", payload: { sessionId: "ses-1" } } };
    const native = {
      id: "0000004",
      data: { type: "custom", event_type: "compacted", payload: { sessionId: "ses-2", native: true } },
    };
    assert.equal(endedByCompaction([ended, native], "ses-1"), true);
    assert.equal(endedByCompaction([ended, native], "ses-2"), false, "the provider compacted it in place");
  });

  // Flipped: the handover and the recent conversation were glued into a fresh session's brief. They
  // are one Genex notice now (`historyNotice`), which only a leg with no session to resume is given.
  it("a fresh session's notice holds the handover, then the latest messages, never the words it answers", () => {
    const messages = [
      { role: "user", content: "Build a plaza with a fountain." },
      { role: "assistant", content: "Done." },
      { role: "user", content: "Now add the market stalls." },
    ];
    const notice = historyNotice(messages, "Now add the market stalls.", HANDOVER);
    assert.match(notice, /Where this chat stands/);
    assert.ok(notice.indexOf(HANDOVER) < notice.indexOf("user: Build a plaza with a fountain."), "the handover first");
    assert.ok(!notice.includes("user: Now add the market stalls."), "the words it answers are its prompt");
    assert.equal(historyNotice([{ role: "user", content: "hi" }], "hi", null), "", "nothing came before");
  });

  it("after a paused build's chat is compacted, its next turn is a fresh session that keeps the run's controls and reads the handover", async () => {
    const requests: Array<Record<string, unknown>> = [];
    const recorder = ctxRecorder({
      threadId: THREAD,
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "add enemies" }],
        // The host forgets the sessions before the compaction (shared/chat-rewind.ts harnessView).
        "events.list": () => [compacted("0000009", HANDOVER)],
        "game.list": () => [{ name: "plaza", title: "Plaza" }],
        "game.contentStamp": () => ({ all: "same", source: "same" }),
        "engine.delegate": (params) => {
          requests.push(params);
          return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "chat-2", summary: "On it." };
        },
      },
    });
    const loopRun = {
      runId: RUN,
      state: "paused",
      goal: "a dusk plaza",
      landed: false,
      stoppedBecause: "stopped by the user",
      model: null,
      messageId: "m1",
      reopenable: true,
      engine: "codex",
    };
    await delegatedTurn.runDelegatedTurn(recorder.ctx as never, {
      threadId: THREAD,
      turnId: "turn-1",
      text: "add enemies",
      engine: "codex",
      engineLabel: "Codex",
      project: "plaza",
      afterLoopRun: loopRun as never,
    });
    const [request] = requests;
    assert.ok(request, "the turn ran");
    assert.equal(request.resume, undefined, "a fresh session");
    assert.deepEqual(request.runControls, { runId: RUN, messageId: "m1" }, "the run's controls are granted per turn");
    assert.equal(request.prompt, "add enemies", "the words alone");
    assert.ok(
      String((request.notices as string[] | undefined)?.[0]).includes(HANDOVER),
      "told the handover as a notice",
    );
  });

  it("a lead seated fresh after the compaction is told the handover before the chat's latest messages", async () => {
    const said = (id: string, role: string, content: string) => ({
      id,
      data: { type: "messages", messages: [{ role, content }] },
    });
    const recorder = ctxRecorder({
      threadId: THREAD,
      handlers: {
        "events.list": () => [
          said("0000001", "user", "Build a plaza."),
          said("0000002", "assistant", "Building."),
          compacted("0000009", HANDOVER),
        ],
      },
    });
    const chat = await freshChat(recorder.ctx as never, THREAD);
    assert.ok(chat.includes(HANDOVER));
    assert.ok(chat.indexOf(HANDOVER) < chat.indexOf("THE CHAT SO FAR"), "the handover first");
    assert.match(chat, /user: Build a plaza\./);
    assert.deepEqual(
      recorder.calls.map((c) => c.method),
      ["events.list"],
      "one read of the log gives both",
    );
  });
});
