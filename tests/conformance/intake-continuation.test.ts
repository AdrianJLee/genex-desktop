import { test } from "node:test";
import assert from "node:assert/strict";
import { startRig, waitForLog } from "../helpers/studio-rig.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";

test("a follow-up keeps the Loop's start: every turn of the chat's own session is handed it, and none is told when", async () => {
  const rig = await startRig();
  try {
    const calls: DelegateRequest[] = [];
    rig.core.engines.register({
      id: "codex",
      label: "Codex fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      complete: async () => {
        throw new Error("Unexpected completion");
      },
      delegate: async (request) => {
        calls.push(request);
        return {
          ok: true,
          summary: calls.length === 1 ? "Use a cozy lake setting?" : "Launch tool available.",
          sessionId: "intake-session",
          turns: 1,
          usage: {},
          durationMs: 1,
          engine: "codex",
        };
      },
    });
    await rig.core.games.scaffold("fishing-intake");
    const thread = await rig.core.createGameThread("fishing-intake");
    const options = { thread, engine: "codex", model: "gpt-5.6-sol" };
    await rig.core.sendUserMessage("Create a fishing game", options);
    await waitForLog(rig.core, (events) =>
      events.some((e) => e.data.type === "custom" && e.data.event_type === "contractor_session"),
    );
    await rig.core.sendUserMessage("yeah! nice recommendations! keep going", options);
    await waitForLog(
      rig.core,
      (events) =>
        events.filter((e) => e.data.type === "custom" && e.data.event_type === "contractor_session").length === 2,
    );
    assert.equal(calls.length, 2);
    for (const call of calls)
      assert.deepEqual(
        call.interviewTools?.map((t) => t.name),
        ["start_autopilot"],
        "the Loop's start survives the follow-up",
      );
    assert.equal(calls[1]!.resume, "intake-session");
    // Flipped: the resumed chat was told "Loop is on: you may start the Loop"; no brief says when now.
    assert.doesNotMatch(calls[1]!.prompt, /Loop is on|start_autopilot/);
  } finally {
    await rig.stop();
  }
});
