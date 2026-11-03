/**
 * The chat is woken when a background job its agent started ends: a plugin tool's job (an Unreal
 * package) through the status tool its manifest names (`jobStatus`), and the chat's own `job_start`
 * commands. One hidden message per end, never for a job the agent already read as ended, one
 * someone stopped, or one a Loop's lead or worker started.
 */
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import {
  JOB_WATCH_MAX_MS,
  JOB_WATCH_MISSES_MAX,
  JOB_WATCH_POLL_MS,
  type JobWakeDeps,
  PluginJobWatches,
  coreJobWake,
  wakeForJob,
  wakesChat,
} from "../../src/main/core/job-wake.ts";
import { PluginToolService } from "../../src/main/core/plugin-tools.ts";
import { type JobRecord, JobRole, JobScopeKind, JobState, JobStopper } from "../../src/shared/jobs.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { type PluginManifest, PluginToolAudience } from "../../src/shared/plugins.ts";
import { isChatReport, MessageOrigin } from "../../src/shared/protocol.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { coreLite } from "../helpers/core-lite.ts";

const THREAD = "t-wake";
const BINDING = { project: "racer", directory: "/games/racer", threadId: THREAD };
const PACKAGE = "unreal__package-game";
const STATUS = "unreal__package-status";
const NO_PARAMETERS = { type: "object", properties: {} };

/** A clock and timers the test moves by hand, and every read, wake and log line the watches made. */
function fakeHost(answers: unknown[] = []) {
  let now = 0;
  const timers: Array<{ at: number; fire: () => void; live: boolean }> = [];
  const reads: Array<{ status: string; args: Record<string, unknown> }> = [];
  const wakes: Array<{ threadId: string; project: string; text: string }> = [];
  const logs: string[] = [];
  const deps: JobWakeDeps = {
    jobStatusOf: (name) =>
      name === PACKAGE || name === "unreal__plugin-test" ? { status: STATUS, parameters: ["plugin"] } : null,
    readStatus: async (status, args) => {
      reads.push({ status, args });
      const next = answers.shift();
      if (next instanceof Error) throw next;
      return next;
    },
    wake: async (threadId, project, text) => {
      wakes.push({ threadId, project, text });
    },
    schedule: (fire, ms) => {
      const timer = { at: now + ms, fire, live: true };
      timers.push(timer);
      return () => {
        timer.live = false;
      };
    },
    now: () => now,
    log: (line) => logs.push(line),
  };
  /** Move the clock by one poll and let what fell due run to its end. */
  const tick = async (ms = JOB_WATCH_POLL_MS) => {
    now += ms;
    for (const timer of timers.splice(0).filter((t) => t.live && t.at <= now)) timer.fire();
    for (let turn = 0; turn < 5; turn++) await Promise.resolve();
  };
  return { deps, reads, wakes, logs, tick, pending: () => timers.filter((t) => t.live).length };
}

const running = { state: "running", jobRunning: true };
const done = { state: "done", app: "unreal/Builds/Mac/Racer.app", jobRunning: false };

describe("a plugin job the chat's agent started", () => {
  it("is read every poll while it runs, and its end starts the chat's next turn once", async () => {
    const host = fakeHost([running, running, done]);
    const watches = new PluginJobWatches(host.deps);
    watches.called(PACKAGE, { stop: false }, BINDING, { started: true, system: "Mac" });
    assert.equal(watches.size, 1);
    await host.tick();
    await host.tick();
    assert.equal(host.wakes.length, 0, "nothing while it runs");
    await host.tick();
    assert.equal(host.wakes.length, 1);
    const [wake] = host.wakes;
    assert.equal(wake?.threadId, THREAD);
    assert.equal(wake?.project, "racer");
    assert.match(wake?.text ?? "", new RegExp(`${PACKAGE}.*has ended: read ${STATUS}`));
    assert.match(wake?.text ?? "", /Tell the person in one short line/);
    assert.deepEqual(
      host.reads.map((read) => read.args),
      [{}, {}, {}],
      "only the arguments the status tool declares are passed",
    );
    assert.equal(watches.size, 0);
    await host.tick();
    assert.equal(host.wakes.length, 1, "woken once");
    assert.equal(host.pending(), 0, "no timer left");
  });

  it("passes the starting call's arguments the status tool declares", async () => {
    const host = fakeHost([done]);
    const watches = new PluginJobWatches(host.deps);
    watches.called("unreal__plugin-test", { plugin: "Tools", filter: "Tools.Window" }, BINDING, { started: true });
    await host.tick();
    assert.deepEqual(host.reads, [{ status: STATUS, args: { plugin: "Tools" } }]);
  });

  it("wakes nothing once the agent itself read that the job ended", async () => {
    const host = fakeHost([running]);
    const watches = new PluginJobWatches(host.deps);
    watches.called(PACKAGE, {}, BINDING, { started: true });
    await host.tick();
    watches.called(STATUS, {}, BINDING, running);
    assert.equal(watches.size, 1, "a read that says it still runs changes nothing");
    watches.called(STATUS, {}, BINDING, done);
    assert.equal(watches.size, 0);
    await host.tick();
    await host.tick();
    assert.deepEqual(host.wakes, []);
    assert.equal(host.reads.length, 1, "no read after the agent's");
  });

  it("a stop, or a start that started nothing, ends the watch; a new start replaces it", async () => {
    const host = fakeHost([running, done]);
    const watches = new PluginJobWatches(host.deps);
    watches.called(PACKAGE, {}, BINDING, { started: true });
    watches.called(PACKAGE, { stop: true }, BINDING, { stopped: true });
    assert.equal(watches.size, 0, "a stop ends it");
    watches.called(PACKAGE, {}, BINDING, { started: true });
    watches.called(PACKAGE, {}, BINDING, { started: true });
    assert.equal(watches.size, 1, "one watch per chat and status tool");
    await host.tick();
    await host.tick();
    assert.equal(host.wakes.length, 1, "the replaced watch wakes nothing of its own");
    for (const answer of [{ already: true }, null, "started", { started: "true" }]) {
      watches.called(PACKAGE, {}, BINDING, answer);
      assert.equal(watches.size, 0, JSON.stringify(answer));
    }
  });

  it("watches nothing for a call with no chat, or a tool that names no status", async () => {
    const host = fakeHost();
    const watches = new PluginJobWatches(host.deps);
    watches.called(PACKAGE, {}, { project: "racer", directory: "/games/racer" }, { started: true });
    watches.called("unreal__open-editor", {}, BINDING, { started: true });
    assert.equal(watches.size, 0);
    assert.equal(host.pending(), 0);
  });

  it("a status that keeps saying neither, or fails, ends the watch with no message", async () => {
    const unread = [{ state: "running" }, new Error("backend ended"), "text"];
    const host = fakeHost(unread.slice(0, JOB_WATCH_MISSES_MAX));
    const watches = new PluginJobWatches(host.deps);
    watches.called(PACKAGE, {}, BINDING, { started: true });
    for (let n = 0; n < JOB_WATCH_MISSES_MAX; n++) await host.tick();
    assert.equal(watches.size, 0);
    assert.deepEqual(host.wakes, []);
    assert.equal(host.logs.length, 1);
  });

  it("a miss between reads that say it runs is forgiven", async () => {
    const answers = [...Array.from({ length: JOB_WATCH_MISSES_MAX - 1 }, () => null), running];
    const host = fakeHost([...answers, ...answers, done]);
    const watches = new PluginJobWatches(host.deps);
    watches.called(PACKAGE, {}, BINDING, { started: true });
    for (let n = 0; n < answers.length * 2 + 1; n++) await host.tick();
    assert.equal(host.wakes.length, 1);
  });

  it("a job past the longest watch ends it with no message", async () => {
    const host = fakeHost([running, done]);
    const watches = new PluginJobWatches(host.deps);
    watches.called(PACKAGE, {}, BINDING, { started: true });
    await host.tick();
    await host.tick(JOB_WATCH_MAX_MS);
    assert.equal(watches.size, 0);
    assert.deepEqual(host.wakes, []);
    assert.equal(host.reads.length, 1, "no read past the longest watch");
  });

  it("dispose ends every watch, a read under way included, with no message", async () => {
    let release: (answer: unknown) => void = () => {};
    const host = fakeHost();
    const deps: JobWakeDeps = { ...host.deps, readStatus: () => new Promise((resolve) => (release = resolve)) };
    const watches = new PluginJobWatches(deps);
    watches.called(PACKAGE, {}, BINDING, { started: true });
    await host.tick();
    watches.dispose();
    release(done);
    await host.tick();
    assert.equal(watches.size, 0);
    assert.deepEqual(host.wakes, []);
  });
});

/** A `job_start` job's record as its registry keeps it. */
const job = (fields: Partial<JobRecord> = {}, owner: Partial<JobRecord["owner"]> = {}): JobRecord => ({
  id: "4f9c3a1e-0000-4000-8000-000000000001",
  title: "Unreal build",
  owner: { project: "racer", chatThreadId: THREAD, role: JobRole.Chat, scope: { kind: JobScopeKind.Chat }, ...owner },
  command: "make build",
  cwd: "/games/racer",
  startedAt: "2026-11-03T10:00:00.000Z",
  endedAt: "2026-11-03T10:12:00.000Z",
  state: JobState.Succeeded,
  exitCode: 0,
  logFile: "/jobs/racer/job.log",
  logBytes: 0,
  mode: PermissionMode.Auto,
  ...fields,
});

describe("a job_start job of the chat's own agent", () => {
  it("wakes its chat only when it ended by itself and the agent was not told yet", () => {
    const rows: Array<[string, JobRecord, boolean]> = [
      ["finished", job(), true],
      ["failed", job({ state: JobState.Failed, exitCode: 2 }), true],
      ["ran out of time", job({ state: JobState.TimedOut }), true],
      ["stopped by the agent", job({ state: JobState.Stopped, stoppedBy: JobStopper.Agent }), false],
      ["stopped by the person", job({ state: JobState.Stopped, stoppedBy: JobStopper.Person }), false],
      ["stopped by quitting Genex", job({ state: JobState.Stopped, stoppedBy: JobStopper.Quit }), false],
      ["left by an earlier Genex", job({ state: JobState.Interrupted }), false],
      ["still running", job({ state: JobState.Running }), false],
      ["already told", job({ toldChat: true }), false],
      ["a lead's", job({}, { role: JobRole.Lead, scope: { kind: JobScopeKind.Run, runId: "r1" } }), false],
      ["a worker's", job({}, { role: JobRole.Worker, scope: { kind: JobScopeKind.Turn, turn: "m1" } }), false],
    ];
    for (const [label, record, wakes] of rows) assert.equal(wakesChat(record), wakes, label);
  });

  it("marks it told before the wake, and takes the mark back when the wake never reached the chat", async () => {
    const calls: string[] = [];
    const jobs = {
      markTold: async () => void calls.push("told"),
      markUntold: async () => void calls.push("untold"),
    };
    const texts: string[] = [];
    const wake = async (_thread: string, _project: string, text: string) => {
      calls.push("wake");
      texts.push(text);
    };
    await wakeForJob(job(), { jobs, wake, log: () => {} });
    assert.deepEqual(calls, ["told", "wake"]);
    assert.match(texts[0] ?? "", /Your jobs that ended: Unreal build \([^)]+\) finished \(exit 0\) after 12 min\./);
    calls.length = 0;
    const logs: string[] = [];
    const failing = async () => {
      calls.push("wake");
      throw new Error("harness not running");
    };
    await wakeForJob(job(), { jobs, wake: failing, log: (line) => logs.push(line) });
    assert.deepEqual(calls, ["told", "wake", "untold"]);
    assert.equal(logs.length, 1);
    calls.length = 0;
    await wakeForJob(job({ state: JobState.Stopped, stoppedBy: JobStopper.Person }), { jobs, wake, log: () => {} });
    assert.deepEqual(calls, [], "a stopped job touches nothing");
  });
});

/** The smallest API 3 manifest with a starting tool, its status tool and the given fields on each. */
const jobManifest = (start: Record<string, unknown>, status: Record<string, unknown> = {}, apiVersion = 3) => ({
  apiVersion,
  id: "job-test",
  version: "1.0.0",
  name: "Job test",
  publisher: "Genex tests",
  description: "A manifest whose job status is under test.",
  backend: "backend.mjs",
  capabilities: [],
  tools: [
    { name: "bake", description: "Bake.", parameters: NO_PARAMETERS, ...start },
    { name: "bake-status", description: "How the bake stands.", parameters: NO_PARAMETERS, ...status },
    ...(apiVersion === 3
      ? [{ name: "probe", audience: "harness", description: "Probe.", parameters: NO_PARAMETERS }]
      : []),
  ],
  locks: apiVersion === 3 ? [{ id: "oven", label: "Oven", per: "project" }] : undefined,
  skills: [],
  panels: [],
  settings: [],
  actions: [],
});

describe("a manifest's jobStatus", () => {
  it("keeps a starting tool's status tool", () => {
    const kept = validateManifest(jobManifest({ jobStatus: "bake-status" }));
    assert.equal(kept.tools.find((tool) => tool.name === "bake")?.jobStatus, "bake-status");
    assert.equal(kept.tools.find((tool) => tool.name === "bake-status")?.jobStatus, undefined);
  });

  it("refuses a status Genex could not read on its own", () => {
    const hostile: Array<[string, ReturnType<typeof jobManifest>, RegExp]> = [
      ["naming itself", jobManifest({ jobStatus: "bake" }), /jobStatus/],
      ["naming an undeclared tool", jobManifest({ jobStatus: "bake-state" }), /jobStatus/],
      ["naming a harness tool", jobManifest({ jobStatus: "probe" }), /jobStatus/],
      ["naming a tool that asks", jobManifest({ jobStatus: "bake-status" }, { confirmation: "Read it?" }), /jobStatus/],
      ["naming a tool that needs a lock", jobManifest({ jobStatus: "bake-status" }, { needs: ["oven"] }), /jobStatus/],
      ["on a harness tool", jobManifest({ jobStatus: "bake-status", audience: "harness" }), /jobStatus/],
      ["on API 2", jobManifest({ jobStatus: "bake-status" }, {}, 2), /jobStatus requires apiVersion 3/],
    ];
    for (const [label, manifest, refusal] of hostile) assert.throws(() => validateManifest(manifest), refusal, label);
  });

  it("the Unreal plugin's background tools each name the status tool that says when they end", () => {
    const raw = JSON.parse(readFileSync("src/plugins/unreal/plugin.json", "utf8")) as PluginManifest;
    const unreal = validateManifest(raw);
    const named = Object.fromEntries(
      unreal.tools.flatMap((tool) => (tool.jobStatus ? [[tool.name, tool.jobStatus]] : [])),
    );
    assert.deepEqual(named, {
      "add-cpp-module": "cpp-status",
      "add-motion-matching": "motion-status",
      "package-game": "package-status",
      "plugin-build": "plugin-status",
      "plugin-test": "plugin-status",
      "plugin-package": "plugin-status",
    });
  });
});

describe("the core's side of a job's wake", () => {
  it("the registry names an enabled plugin's status tool, with its parameters, by agent names", async () => {
    const { core, close } = await coreLite();
    try {
      await core.plugins.setEnabled("unreal", true);
      assert.deepEqual(core.plugins.jobStatusOf(PACKAGE), { status: STATUS, parameters: [] });
      assert.deepEqual(core.plugins.jobStatusOf("unreal__plugin-build"), {
        status: "unreal__plugin-status",
        parameters: ["plugin"],
      });
      for (const name of [STATUS, "unreal__open-editor", "unreal__package-game__x", "nobody__package-game", "unreal"])
        assert.equal(core.plugins.jobStatusOf(name), null, name);
      await core.plugins.setEnabled("unreal", false);
      assert.equal(core.plugins.jobStatusOf(PACKAGE), null, "a plugin that is off names none");
    } finally {
      core.plugins.cancel();
      await close();
    }
  });

  it("reads a status as Genex's own step, and wakes the chat with one hidden message on its last model", async () => {
    const { core, close } = await coreLite();
    try {
      await core.games.scaffold("racer", { title: "Racer" });
      const threadId = await core.threadForGame("racer");
      await core.store.updateThread(threadId, { metadata: { lastEngine: "codex", lastModel: "gpt-5.5" } });
      const callers: unknown[] = [];
      core.plugins.tool = (async (...call: unknown[]) => {
        callers.push(call[4]);
        return done;
      }) as never;
      const sent: Array<{ text: string; options: Record<string, unknown> }> = [];
      core.sendUserMessage = (async (text: string, options: Record<string, unknown>) => {
        sent.push({ text, options });
      }) as never;
      const deps = coreJobWake(core);
      assert.deepEqual(await deps.readStatus(STATUS, {}, BINDING, new AbortController().signal), done);
      assert.deepEqual(callers, [PluginToolAudience.Harness]);
      await deps.wake(threadId, "racer", "The job ended.");
      assert.deepEqual(sent, [
        {
          text: "The job ended.",
          options: {
            thread: threadId,
            project: "racer",
            origin: MessageOrigin.JobEnded,
            engine: "codex",
            model: "gpt-5.5",
          },
        },
      ]);
      assert.ok(isChatReport(sent[0]?.options), "the transcript leaves it out");
    } finally {
      core.plugins.cancel();
      await close();
    }
  });

  it("watches the chat's own session's calls only: never a run's, a lead's, a worker's or Genex's own", async () => {
    const { core, close } = await coreLite();
    try {
      await core.plugins.setEnabled("unreal", true);
      await core.games.scaffold("racer", { title: "Racer" });
      const threadId = await core.threadForGame("racer");
      core.plugins.tool = (async () => ({ started: true, system: "Mac" })) as never;
      const service = new PluginToolService(core, {
        consent: null as never,
        pluginCallAttribution: new WeakMap(),
        mcpSecrets: null,
        activeConnectorCalls: new Map(),
        assetCalls: new Map(),
        cutOffCalls: new Map(),
        planning: async () => false,
        chatMode: async () => PermissionMode.Auto,
        locks: core.locks,
        hooks: core.hooks,
      });
      const binding = { ...BINDING, threadId };
      const others: Array<[string, Record<string, unknown>]> = [
        ["a run worker", { attribution: { runId: "r1", agentId: "w1" } }],
        ["a director", { director: { runId: "r1" } }],
        ["a self-capture", { selfCapture: { runId: "r1" } }],
        ["a lead", { lead: true }],
        ["a run's own call", { outlivesTurn: true }],
        ["a worker holding its locks", { holder: "w2" }],
        ["Genex's own step", { caller: PluginToolAudience.Harness }],
      ];
      try {
        for (const [label, ctx] of others) {
          await service.invokePluginTool(PACKAGE, {}, binding, undefined, { engine: "claude-code", ...ctx });
          assert.equal(service.jobWatches.size, 0, label);
        }
        await service.invokePluginTool(PACKAGE, {}, binding, undefined, { engine: "claude-code" });
        assert.equal(service.jobWatches.size, 1, "the chat's own agent's package is watched");
      } finally {
        service.jobWatches.dispose();
      }
    } finally {
      core.plugins.cancel();
      await close();
    }
  });
});
