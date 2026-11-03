/**
 * The chat's queue and Stop: a message left unanswered by a crash is answered once on boot, Stop
 * reaches a turn the chat's own session is answering (or a message still sending, or a plan being
 * written) and hands over to what waits behind it, and a stale Plan flag keeps a build's plan. And
 * what `run_status` shows of a run's progress (shared/chat-run.ts `runSnapshot`), beside the build
 * controls the chat's session keeps after a run (`runControlTools`).
 */
import assert from "node:assert/strict";
import { after, it } from "node:test";
import { startRig, waitForLog, customEvents, type Rig } from "../helpers/studio-rig.ts";
import { type DelegateRequest, EngineError } from "../../src/substrate/engines/types.ts";
import { RunControl, runControlTools, runSnapshot } from "../../src/shared/chat-run.ts";

const rigs: Rig[] = [];
after(async () => {
  for (const rig of rigs) await rig.stop().catch(() => {});
});
const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => (resolve = r));
  return { promise, resolve };
};
const result = (summary: string, sessionId: string) => ({
  ok: true,
  summary,
  sessionId,
  turns: 1,
  usage: {},
  durationMs: 1,
  engine: "fixture",
});

it("replays a durable unanswered message once on boot without opening intake", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("replay-world");
  const thread = await rig.core.createGameThread("replay-world");
  await rig.core.append(
    [
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId: "old", project: "replay-world", engine: "ollama" },
      },
      { type: "custom", event_type: "run_finished", payload: { runId: "old", project: "replay-world" } },
      { type: "messages", messages: [{ role: "user", content: "What passed?" }] },
      {
        type: "custom",
        event_type: "coordinator_message_queued",
        payload: {
          messageId: "recover-me",
          action: {
            messageId: "recover-me",
            type: "user_message",
            threadId: thread,
            project: "replay-world",
            text: "What passed?",
            engine: "ollama",
            autopilot: { hours: 2 },
          },
        },
      },
    ],
    thread,
  );
  await rig.core.host.dispatch({ type: "boot_notice", notice: { reason: "crash_restart" } });
  await waitForLog(
    rig.core,
    (es) => customEvents(es, "coordinator_message_handled").some((p) => p.messageId === "recover-me"),
    15000,
  );
  await rig.core.host.dispatch({ type: "boot_notice", notice: { reason: "cold_start" } });
  const es = await rig.core.store.listEvents(thread);
  assert.equal(customEvents(es, "coordinator_message_handled").length, 1);
  assert.equal(customEvents(es, "run_started").length, 1);
});

// Flipped (one Loop): the chat was also offered `show_build` and `land_build` after a run, in flat
// string tools both bridges carry; every Loop works in the game folder, so there is no build to show
// or land, and the run's status is its one control.
it("offers the chat the run's status after the run, and no build to show or land", () => {
  assert.deepEqual(
    runControlTools.map((t) => t.name),
    [RunControl.RunStatus],
  );
});

it("run_status includes the current Optimization stage without mixing runs", () => {
  const event = (event_type: string, payload: object) => ({ data: { type: "custom", event_type, payload } });
  const snapshot = runSnapshot(
    [
      event("run_started", { runId: "r", project: "village" }),
      event("optimization_updated", { runId: "r", phase: "profiling_candidate", outcome: null }),
      event("optimization_updated", { runId: "other", phase: "terminal", outcome: "improved" }),
    ] as never,
    "r",
  );
  assert.equal(snapshot.progress.length, 1);
  assert.equal(snapshot.progress[0].phase, "profiling_candidate");
});

it("the chat's words to a run's lead do not crowd the workers out of run_status's progress", () => {
  const event = (event_type: string, payload: object) => ({ data: { type: "custom", event_type, payload } });
  // Each message to the lead is a steer, taken off its inbox and heard: only the steer is progress.
  const chat = Array.from({ length: 10 }, (_, i) => [
    event("run_steering", { runId: "r", text: `question ${i}`, sourceMessageId: `m${i}`, how: "lead" }),
    event("run_steering_delivered", { runId: "r", messageId: `s${i}`, facetId: "build", stage: "next brief" }),
    event("run_steering_delivered", { runId: "r", sourceMessageId: `m${i}`, how: "lead" }),
  ]).flat();
  const snapshot = runSnapshot(
    [
      event("run_started", { runId: "r", project: "village" }),
      event("director_worker", { runId: "r", workerId: "sky", state: "running" }),
      ...chat,
      event("director_worker", { runId: "r", workerId: "sky", state: "done" }),
    ] as never,
    "r",
  );
  const types = snapshot.progress.map((p) => p.type);
  assert.equal(types.filter((type) => type === "run_steering").length, 10);
  assert.ok(!types.includes("run_steering_delivered"), types.join(", "));
  assert.equal(types[0], "director_worker", "the worker's start is still on the list");
});

for (const ending of ["returns stopped", "throws aborted"] as const)
  it(`Stop leaves the same durable trace in the chat's own turn after a run when its engine ${ending}`, async () => {
    // Real engines do both: Claude Code and Codex mostly answer a Stop with a stopped result, and
    // throw an abort when it lands before the session starts. The turn records it the same way.
    const rig = await startRig();
    rigs.push(rig);
    await rig.core.games.scaffold("stop-trace");
    const thread = await rig.core.createGameThread("stop-trace");
    await rig.core.append(
      [
        {
          type: "custom",
          event_type: "run_started",
          payload: { runId: "saved", project: "stop-trace", engine: "codex" },
        },
        { type: "custom", event_type: "run_finished", payload: { runId: "saved", project: "stop-trace" } },
      ],
      thread,
    );
    const started = deferred();
    rig.core.engines.register({
      id: "codex",
      label: "fixture",
      kind: "delegated",
      status: async () => ({ code: "ready", detail: "" }),
      models: async () => [],
      delegate: async (request) => {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        if (ending === "throws aborted") throw new EngineError("aborted", "codex", "stopped by you");
        return { ...result("", "stopped-session"), ok: false, stopReason: "stopped", errorText: "stopped by you" };
      },
    });
    try {
      await rig.core.sendUserMessage("Is the river ready?", { thread, engine: "codex" });
      await started.promise;
      await rig.core.stopThread(thread);
      const log = await waitForLog(
        rig.core,
        (es) => es.some((e) => e.data.type === "turn_ended"),
        15000,
        "the turn to end",
      );
      const turnId = log.find((e) => e.data.type === "turn_started")?.turn_id;
      assert.ok(turnId, "the message opened a turn");
      const ended = log.find((e) => e.turn_id === turnId && e.data.type === "turn_ended");
      assert.equal((ended?.data as { status?: string } | undefined)?.status, "cancelled");
      const interrupted = log.some(
        (e) =>
          e.turn_id === turnId &&
          e.data.type === "custom" &&
          e.data.event_type === "session_activity" &&
          (e.data.payload as { phase?: string } | undefined)?.phase === "interrupted",
      );
      assert.ok(interrupted, "the turn says it was interrupted");
    } finally {
      await rig.core.stopThread(thread).catch(() => {});
    }
  });

it("Stop while the plan is being written cancels it at once, without waiting for the plan", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("stop-plan");
  const thread = await rig.core.createGameThread("stop-plan");
  let writing = false;
  rig.core.engines.register({
    id: "codex",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    // The plan is written until the user stops it.
    complete: async (request: { signal?: AbortSignal }) => {
      writing = true;
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw Object.assign(new Error("stopped by you"), { name: "AbortError" });
    },
    delegate: async () => result("never", "s"),
  } as never);
  const sending = rig.core
    .sendUserMessage("Build a quiet garden", {
      thread,
      engine: "codex",
      reviewPlan: true,
    })
    .catch(() => {});
  const deadline = Date.now() + 10_000;
  while (!writing && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
  assert.ok(writing, "the plan is being written");
  const stopped = await Promise.race([
    rig.core.stopThread(thread).then(() => true),
    new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 5_000)),
  ]);
  assert.ok(stopped, "Stop answers without waiting for the plan to be written");
  await sending;
});

it("a Stop pressed while the message is still sending stops that message: no builder answers it", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("stop-while-sending");
  const thread = await rig.core.createGameThread("stop-while-sending");
  let answered = 0;
  rig.core.engines.register({
    id: "codex",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      // A builder that is stopped says so; one left alone answers after a moment.
      const stopped = await new Promise<boolean>((resolve) => {
        if (request.signal?.aborted) resolve(true);
        request.signal?.addEventListener("abort", () => resolve(true), { once: true });
        setTimeout(() => resolve(false), 2_000);
      });
      if (stopped) return { ...result("", "s"), ok: false, stopReason: "stopped", errorText: "stopped by you" };
      answered++;
      return result("Made the sky pink.", "s");
    },
  });
  try {
    // The composer's Send, and the Stop pressed before the send reached the chat's queue.
    const sending = rig.core.sendUserMessage("make the sky pink", { thread, engine: "codex" });
    await rig.core.stopThread(thread);
    await sending;
    const log = await waitForLog(
      rig.core,
      (es) => es.some((e) => e.data.type === "turn_ended"),
      15000,
      "the stopped message's turn to end",
    );
    await new Promise((resolve) => setTimeout(resolve, 2_500));
    assert.equal(answered, 0, "no builder answered the stopped message");
    const ended = log.find((e) => e.data.type === "turn_ended")?.data as { status?: string } | undefined;
    assert.equal(ended?.status, "cancelled");
  } finally {
    await rig.core.stopThread(thread).catch(() => {});
  }
});

it("Stop hands off to queued input in the same native session; an empty queue stays stopped", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("stop-queue");
  const thread = await rig.core.createGameThread("stop-queue");
  await rig.core.append(
    [
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId: "saved", project: "stop-queue", engine: "codex" },
      },
      { type: "custom", event_type: "run_finished", payload: { runId: "saved", project: "stop-queue" } },
    ],
    thread,
  );
  const started = deferred(),
    calls: DelegateRequest[] = [];
  rig.core.engines.register({
    id: "codex",
    label: "fixture",
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    delegate: async (request) => {
      calls.push(request);
      if (calls.length === 1) {
        started.resolve();
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return result("Interrupted with progress saved.", "same-session");
      }
      assert.equal(request.resume, "same-session");
      assert.ok(request.prompt.includes("Add fireflies"), request.prompt);
      assert.ok(!request.signal?.aborted, "new response is not aborted by the old Stop");
      return result("Continue the existing garden.", "same-session");
    },
  });
  try {
    await rig.core.sendUserMessage("First message", { thread, engine: "codex" });
    await started.promise;
    // Another model: it may join this turn as a switch, but Stop hands it a turn of its own.
    await rig.core.sendUserMessage("Add fireflies", { thread, engine: "codex", model: "another-model" });
    assert.equal(calls.length, 1);
    await rig.core.stopThread(thread);
    await waitForLog(rig.core, (es) => customEvents(es, "coordinator_message_handled").length === 2, 15000);
    assert.equal(calls.length, 2);
    await rig.core.stopThread(thread);
    assert.equal(calls.length, 2, "empty queue does not invent a continuation");
    assert.equal(customEvents(await rig.core.store.listEvents(thread), "run_started").length, 1);
  } finally {
    await rig.core.stopThread(thread);
  }
});

it("a stale Plan mode flag during a build preserves its plan and queues the follow-up", async () => {
  const rig = await startRig();
  rigs.push(rig);
  await rig.core.games.scaffold("existing-plan");
  const thread = await rig.core.createGameThread("existing-plan");
  await rig.core.store.updateThread(thread, {
    metadata: {
      planReview: {
        id: "approved-plan",
        state: "approved",
        text: "Build a quiet garden",
        plan: "Keep the river blue",
        options: { thread },
      },
    },
  });
  await rig.core.append(
    [
      {
        type: "custom",
        event_type: "run_started",
        payload: { runId: "current", project: "existing-plan", engine: "ollama", goal: "Build a quiet garden" },
      },
    ],
    thread,
  );
  await rig.core.sendUserMessage("Add fireflies", {
    thread,
    engine: "ollama",
    reviewPlan: true,
  });
  const saved = (await rig.core.store.getRecord(thread)).metadata?.planReview as { id: string };
  assert.equal(saved.id, "approved-plan");
  assert.equal(customEvents(await rig.core.store.listEvents(thread), "plan_review").length, 0);
  assert.equal(customEvents(await rig.core.store.listEvents(thread), "coordinator_message_queued").length, 1);
});
