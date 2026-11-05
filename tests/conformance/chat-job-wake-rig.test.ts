/**
 * A chat woken by its job's end, through the real harness: once the chat's turn has ended, a
 * `job_start` job of its own that finishes, and a plugin job Genex watched to its end, each start
 * the chat's next turn on the engine the person last used, with Genex's words as its prompt and
 * nothing in the transcript. The watch's timing is `chat-job-wake.test.ts`'s.
 */
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { after, it } from "node:test";
import { coreJobWake, PluginJobWatches } from "../../src/main/core/job-wake.ts";
import { MessageFrom } from "../../src/shared/engine-requests.ts";
import { JobRole, JobScopeKind } from "../../src/shared/jobs.ts";
import { messageQueueState } from "../../src/shared/message-queue.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { isChatReport, MessageOrigin } from "../../src/shared/protocol.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import type { JobSpawn } from "../../src/substrate/jobs.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { type Rig, startRig, waitForLog } from "../helpers/studio-rig.ts";

const POSIX = { skip: process.platform === "win32" && "process groups and /bin/sh are POSIX" } as const;
const ENGINE = "codex";

const rigs: Rig[] = [];
after(async () => {
  for (const rig of rigs) await rig.stop().catch(() => {});
});

const handled = (thread: string, count: number) => (events: EventEnvelope[]) =>
  events.filter(
    (e) => e.thread_id === thread && e.data.type === "custom" && e.data.event_type === "coordinator_message_handled",
  ).length >= count;

/** A rig whose jobs are plain `/bin/sh -c`, a game chat, and a delegated engine recording every turn it is asked. */
async function wakeRig() {
  const jobSpawn: JobSpawn = async (request) => ({
    child: spawn("/bin/sh", ["-c", request.command], { cwd: request.cwd, detached: true, stdio: "pipe" }),
    sandboxed: false,
  });
  const rig = await startRig({}, { jobSpawn });
  rigs.push(rig);
  const project = "wake-racer";
  await rig.core.games.scaffold(project);
  const thread = await rig.core.createGameThread(project);
  const turns: DelegateRequest[] = [];
  rig.core.engines.register({
    id: ENGINE,
    label: ENGINE,
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: '{"pick":"A","reason":"fixture"}' },
      usage: {},
      model: "fixture",
      engine: ENGINE,
      stopReason: "stop",
    }),
    delegate: async (request) => {
      turns.push(request);
      return {
        ok: true,
        summary: turns.length === 1 ? "Packaging is running; I'll test it when it finishes." : "The build is ready.",
        sessionId: request.resume ?? "session",
        turns: 1,
        usage: {},
        durationMs: 1,
        engine: ENGINE,
      };
    },
  });
  await rig.core.setPermissionMode(thread, PermissionMode.Auto);
  await rig.core.sendUserMessage("Package the game and test it", { thread, engine: ENGINE });
  await waitForLog(rig.core, handled(thread, 1), 20_000, "the person's turn");
  return { rig, project, thread, turns };
}

/** The chat's queued messages Genex sent itself when a job ended. */
async function wakesIn(rig: Rig, thread: string) {
  const queued = [...messageQueueState(await rig.core.store.listEvents(thread)).messages.values()];
  return queued.filter((message) => message.action?.origin === MessageOrigin.JobEnded);
}

it(
  "a job_start job of the chat's own that finishes after its turn ended starts the chat's next turn",
  POSIX,
  async () => {
    const { rig, project, thread, turns } = await wakeRig();
    await rig.core.jobs.start({
      owner: { project, chatThreadId: thread, role: JobRole.Chat, scope: { kind: JobScopeKind.Chat } },
      title: "Unreal build",
      command: "echo built",
      cwd: rig.core.games.dirFor(project),
      policy: {},
      mode: PermissionMode.Auto,
    });
    await waitForLog(rig.core, handled(thread, 2), 20_000, "the woken turn");
    assert.equal(turns.length, 2);
    const woken = turns[1];
    assert.match(woken?.prompt ?? "", /Your jobs that ended: Unreal build \([^)]+\) finished \(exit 0\)/);
    assert.match(woken?.prompt ?? "", /Tell the person in one short line/);
    assert.equal(woken?.from, MessageFrom.Genex, "the engine reads it as Genex's, not the person's");
    assert.doesNotMatch((woken?.notices ?? []).join("\n"), /Your jobs that ended/, "told once, by the wake");
    const wakes = await wakesIn(rig, thread);
    assert.equal(wakes.length, 1);
    assert.equal(wakes[0]?.action?.engine, ENGINE, "on the engine the person last used");
    assert.ok(isChatReport(wakes[0]?.action), "the transcript leaves it out");
  },
);

it("a plugin job Genex watched to its end starts the chat's next turn naming its status tool", async () => {
  const { rig, project, thread, turns } = await wakeRig();
  const watches = new PluginJobWatches({
    ...coreJobWake(rig.core),
    jobStatusOf: () => ({ status: "unreal__package-status", parameters: [] }),
    readStatus: async () => ({ state: "done", jobRunning: false }),
    schedule: (fire) => {
      setImmediate(fire);
      return () => {};
    },
  });
  const binding = { project, directory: rig.core.games.dirFor(project), threadId: thread };
  watches.called("unreal__package-game", {}, binding, { started: true, system: "Mac" });
  await waitForLog(rig.core, handled(thread, 2), 20_000, "the woken turn");
  assert.equal(turns.length, 2);
  assert.match(
    turns[1]?.prompt ?? "",
    /The job unreal__package-game started in the background has ended: read unreal__package-status/,
  );
  assert.equal(turns[1]?.from, MessageFrom.Genex);
  assert.equal((await wakesIn(rig, thread)).length, 1);
});
