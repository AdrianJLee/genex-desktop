/**
 * Which Loop a run gets, through the run's start as the chat and Resume reach it: a project that
 * isn't a web game runs the one Loop on an engine that keeps a session and is told, before anything
 * is promised, that it needs one otherwise; classic and the gauntlet stay a web game's; a paused
 * Loop on an Unreal game goes on in the one Loop; and the Loop's start describes the one Loop
 * truthfully.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { setImmediate } from "node:timers/promises";
import { afterLeadLoopRun, afterLoopRunGrant } from "../../src/harness-seed/loop/after-loop-run.ts";
import { afterLoopRunNote } from "../../src/harness-seed/loop/after-loop-run-prompts.ts";
import { launchFromIntake } from "../../src/harness-seed/loop/chat-dispatch.ts";
import { OPEN_LOOP_REFUSAL } from "../../src/harness-seed/loop/open-loop-prompts.ts";
import { startAutopilot } from "../../src/harness-seed/loop/start-autopilot.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { stopRunsOf } from "../../src/harness-seed/loop/live-chat.ts";
import { runControlsFor } from "../../src/shared/chat-run.ts";
import * as runDispatchParts from "../../src/harness-seed/loop/run-dispatch.ts";
import { chooseRunner, handleRunStart } from "../../src/harness-seed/loop/run-dispatch.ts";
import { RunnerKind } from "../../src/harness-seed/loop/studio-state.ts";
import { CHAT_SESSION, gameRepo, type LoopHost, type LoopTurn, loopHost } from "../helpers/loop-host.ts";
import { copyProject, Project } from "../helpers/project-fixtures.ts";
import { tmpDir } from "../helpers/tmp.ts";

/** No Loop here may hang the suite: each is over in a few seconds when it works. */
const TEST_TIMEOUT = { timeout: 60_000 };

const GODOT = [{ id: "godot-project", path: "." }];
const UNREAL = [{ id: "unreal-project", path: "." }];
const WEB = [{ id: "web-game", path: "." }];

/** An engine that keeps no session, as `engine.describe` lists it. */
const DIRECT = { id: "ollama", label: "Ollama", kind: "direct" };

/** An engine Genex drives itself that keeps sessions (Bonsai's shape), as `engine.describe` lists it. */
const DIRECT_WITH_SESSIONS = { id: "bonsai", label: "Bonsai", kind: "direct", supportsSessions: true };

/** What Genex finds in a Godot project's folder that makes its Loop work in place, as the refusals name it. */
const GODOT_FOUND = "godot-project at the folder's root";
/** The words a refused Loop on a direct engine closes with (flipped in phase 5: any Loop needs a session, and the chat goes on). */
const NEEDS_SESSION =
  "A Loop on this project (Genex finds godot-project at the folder's root) needs an engine that keeps a session of its own (Claude Code, Codex, OpenCode, Grok Build or a local model's session); Ollama doesn't, so nothing was built. The chat still answers here.";

let runs = 0;

/** A Loop's host on a copy of one project fixture made a git repository, under a run id of its own. */
async function hostOn(
  project: Project,
  options: Omit<Parameters<typeof loopHost>[0], "dir"> & { turns?: LoopTurn[] },
): Promise<LoopHost> {
  const dir = await gameRepo(await copyProject(project, await tmpDir("one-loop-dispatch-")));
  runs += 1;
  return loopHost({ ...options, dir, run: { runId: `run-dispatch-${runs}`, ...options.run } });
}

/** A turn that claims the goal is reached, naming a file of the folder as proof. */
const finishes: LoopTurn = async ({ tool }) => {
  await tool("finish", { review: "yes", summary: "The level is built and the door opens.", proof: "project.godot" });
  return undefined;
};

/** The lead delegations that worked in place, as the one Loop's do. */
const inPlaceLeads = (host: LoopHost) =>
  host.leadCalls().filter((call) => (call.director as { inPlace?: unknown } | undefined)?.inPlace === true);

describe("which Loop a run gets", () => {
  it("a Loop on a project that isn't a web game runs the one Loop", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.dispatch();
    const [first] = inPlaceLeads(host);
    assert.ok(first, "the lead worked in place");
    assert.equal(first.resume, CHAT_SESSION, "the chat's own session leads");
    for (const method of ["game.scaffold", "preview.load"]) assert.ok(!host.trail().includes(method), `no ${method}`);
    assert.equal(host.appended("run_finished").length, 1);
  });

  it("on an engine without sessions the Loop closes saying it needs one", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "ollama" } });
    host.rec.handle("engine.describe", () => [DIRECT]);
    await host.dispatch();
    const [closed] = host.appended("run_finished");
    assert.equal(closed?.stoppedBecause, NEEDS_SESSION);
    assert.equal(closed?.landed, false);
    assert.equal(host.rec.paramsOf("engine.delegate").length, 0, "no session ran");
  });

  it("a Loop on an engine without sessions closes with the typed reason, on any project", TEST_TIMEOUT, async () => {
    assert.equal(
      chooseRunner({ runId: "r", project: "p", goal: "g", engine: "ollama" } as never, [DIRECT as never]),
      RunnerKind.NeedsSession,
    );
    for (const [project, facts] of [
      [Project.GodotGame, GODOT],
      [Project.WebFolder, WEB],
    ] as const) {
      const host = await hostOn(project, { facts, run: { engine: "ollama" } });
      host.rec.handle("engine.describe", () => [DIRECT]);
      await host.dispatch();
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.refusal, runDispatchParts.LoopRefusal.NeedsSession, `${project}: the reason is typed`);
      assert.equal(closed?.landed, false);
      assert.equal(host.rec.paramsOf("engine.delegate").length, 0, `${project}: no session ran`);
    }
  });

  it(
    // Flipped (Loop phase 3): it was refused at launch and at dispatch; any model orchestrates now.
    "on an engine Genex drives itself that keeps sessions (Bonsai's) the one Loop runs too, led in place",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "bonsai" }, turns: [finishes] });
      host.rec.handle("engine.describe", () => [DIRECT_WITH_SESSIONS]);
      const words = OPEN_LOOP_REFUSAL.needsSession("Bonsai", GODOT_FOUND);
      await host.dispatch();
      const [first] = inPlaceLeads(host);
      assert.ok(first, "the lead worked in place");
      assert.notEqual(host.appended("run_finished")[0]?.stoppedBecause, words, "never refused for its engine");
    },
  );

  it("a paused Loop on an Unreal game goes on in the one Loop on Resume", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.UnrealGame, {
      facts: UNREAL,
      turns: [
        ({ host }) => {
          host.rec.cancel();
          return undefined;
        },
      ],
    });
    await host.start();
    host.turns.push(finishes);
    host.rec.ctx.cancelled = false;
    await host.dispatch({ resume: true });
    assert.equal(inPlaceLeads(host).length, 2, "both turns were the one Loop's");
  });
});

describe("kept older parts, finished Loops and the chat's words", () => {
  it("a web Loop on an engine that keeps a session runs under the director", () => {
    const described = [{ id: "claude-code", kind: "delegated", supportsSessions: true }] as never;
    assert.equal(chooseRunner({ mode: "autopilot", engine: "claude-code" } as never, described), RunnerKind.Director);
  });

  it("a finished open Loop reads as worked in place, a web Loop's not", async () => {
    const journal = { director: { lead: { chatSession: true }, open: { version: 1, savePoints: [] } } };
    const host = { call: async () => structuredClone(journal) };
    const run = { runId: "run-done", state: "finished", project: "lantern", goal: "a level", engine: "claude-code" };
    const inPlace = await afterLeadLoopRun(host as never, { threadId: "t1" }, run);
    assert.equal(inPlace?.inPlace, true, "worked in place: no build to show or land");
    const web = { call: async () => ({ director: { lead: { chatSession: true } } }) };
    const webRun = await afterLeadLoopRun(web as never, { threadId: "t1" }, run);
    assert.equal(webRun?.inPlace, undefined);
  });
});

/** The studio a dispatch reaches, over a host's recorder, as main.ts makes it. */
function studioOf(host: LoopHost) {
  const ctx = host.rec.ctx;
  return {
    host: ctx,
    cancels: new Set<string>(),
    stoppedMessages: new Set<string>(),
    activeRuns: new Map(),
    startingRuns: new Map(),
    orphanRuns: new Map(),
    scoped: () => ctx,
  };
}

describe("the chat's launch tool", () => {
  it("names no method and no rule about when in its description, and answers every Loop as ending on the lead's finish", async () => {
    assert.doesNotMatch(String(startAutopilot.description), /critic|facet|when Loop|in words|hours/i);
    const host = ctxRecorder({ threadId: "chat-1", extra: { project: "lantern" } });
    const answer = await startAutopilot.execute(
      { goal: "A level.", direction: "a lantern-lit cave" },
      host.ctx as never,
    );
    assert.equal((answer as { content?: unknown }).content, "Building until its lead calls finish.");
    assert.deepEqual(host.calls, [], "it asks the host nothing");
  });
});

describe("a paused Loop's journal, read at its start", () => {
  it(
    "a paused web Loop resumed while its folder reads otherwise stays paused, its journal and report untouched",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      const journal = {
        runId: host.run.runId,
        run: host.run,
        director: { baseCommit: "abc", integrationHead: "def", workers: {}, notes: [] },
      };
      host.artifacts.set(`autopilot_${host.run.runId}`, structuredClone(journal));
      await host.dispatch({ resume: true });
      const [closed] = host.appended("run_finished");
      // A refusal keeps the run's record as it came: no credit cap of a Loop it never ran.
      assert.deepEqual(
        {
          words: closed?.stoppedBecause,
          status: closed?.executionStatus,
          paused: host.appended("autopilot_paused").length,
          journalKept: JSON.stringify(host.artifacts.get(`autopilot_${host.run.runId}`)) === JSON.stringify(journal),
          report: host.rec.paramsOf("run.artifact").some((params) => params.name === "report.json"),
          leads: host.leadCalls().length,
          cap: (host.appended("run_started")[0]?.budgets as Record<string, unknown> | undefined)?.creditCap,
        },
        {
          words: OPEN_LOOP_REFUSAL.webElsewhere(GODOT_FOUND),
          status: "paused",
          paused: 1,
          journalKept: true,
          report: false,
          leads: 0,
          cap: undefined,
        },
      );
    },
  );

  it(
    "a paused Loop that worked in place goes on in place, whatever its folder reads as now",
    TEST_TIMEOUT,
    async () => {
      const web = await hostOn(Project.GodotGame, { facts: [{ id: "web-game", path: "." }], turns: [finishes] });
      web.artifacts.set(`autopilot_${web.run.runId}`, {
        runId: web.run.runId,
        run: web.run,
        phase: "paused",
        director: { baseCommit: "abc", integrationHead: null, open: { version: 1, savePoints: [] } },
      });
      await web.dispatch({ resume: true });
      const [lead] = web.leadCalls();
      assert.equal((lead?.director as { inPlace?: boolean } | undefined)?.inPlace, true, "led in place");
      assert.equal(web.appended("run_finished").at(-1)?.victory, true);
    },
  );

  it("a resumed run refused at its start stays paused and keeps its earlier report", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "ollama" } });
    host.rec.handle("engine.describe", () => [DIRECT]);
    // The paused session's close: a build on its integration branch, its workers and notes.
    const earlier = {
      runId: host.run.runId,
      project: host.run.project,
      executionStatus: "paused",
      paused: true,
      landed: false,
      integrationHead: "head-1",
      baseCommit: "base-1",
      workers: [{ id: "w1", title: "Hall" }],
      notes: ["the hall is half done"],
      // How that session stopped: the provider stopped taking the account.
      limit: { kind: "auth", at: new Date(0).toISOString() },
      stopCode: "provider",
      failure: null,
      workedUntil: new Date(0).toISOString(),
      stoppedBecause: "The model provider stopped accepting this account.",
    };
    await host.rec.ctx.call("events.append", {
      threadId: host.threadId,
      batch: [{ type: "custom", event_type: "run_finished", payload: earlier }],
    });
    await host.dispatch({ resume: true });
    const closed = host.appended("run_finished").at(-1);
    assert.equal(closed?.stoppedBecause, NEEDS_SESSION);
    assert.equal(closed?.executionStatus, "paused");
    assert.equal(closed?.integrationHead, "head-1", "the paused build is still offered");
    assert.equal(closed?.baseCommit, "base-1");
    assert.deepEqual(closed?.workers, earlier.workers);
    assert.deepEqual(closed?.notes, earlier.notes);
    for (const how of ["limit", "stopCode", "failure", "workedUntil"])
      assert.ok(!(how in (closed ?? {})), `the refusal reads as its own stop, not the earlier session's ${how}`);
    assert.equal(host.appended("autopilot_paused").length, 1);
    assert.ok(
      !host.rec.paramsOf("run.artifact").some((params) => params.name === "report.json"),
      "no report rewritten",
    );
  });
});

describe("the credit cap a Loop in place keeps", () => {
  it(
    "a run's own cap is kept and carried to its workers; one Genex can't read becomes the default",
    TEST_TIMEOUT,
    async () => {
      const caps: Array<[unknown, number]> = [
        [200, 200],
        [-1, 600],
        [1.5, 600],
        ["600", 600],
      ];
      for (const [asked, kept] of caps) {
        const host = await hostOn(Project.GodotGame, {
          facts: GODOT,
          run: { budgets: { creditCap: asked } },
          turns: [
            async ({ tool, host }) => {
              await tool("worker_start", { title: "Survey", task: "Read the scenes", isolation: "read" });
              await host.workers[0]?.end({ summary: "three scenes" });
              return undefined;
            },
            finishes,
          ],
        });
        await host.start();
        const [started] = host.appended("run_started");
        assert.equal((started?.budgets as Record<string, unknown> | undefined)?.creditCap, kept, String(asked));
        assert.equal(host.workers[0]?.params.creditCap, kept, `its worker carries it (${String(asked)})`);
      }
    },
  );
});

describe("after a Loop in place", () => {
  it("the chat keeps its status alone, and is told nothing of a build to show or land", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    await host.start();
    const run = {
      runId: host.run.runId,
      state: "finished",
      project: host.game.name,
      goal: "a level",
      engine: "claude-code",
    };
    const after = await afterLeadLoopRun(host.rec.ctx as never, { threadId: host.threadId }, run);
    assert.equal(after?.inPlace, true);
    const grant = afterLoopRunGrant(after as never);
    assert.equal(grant.runControls.inPlace, true);
    assert.deepEqual(
      runControlsFor(grant.runControls).map((tool) => tool.name),
      ["run_status"],
    );
    const note = afterLoopRunNote(after as never, "claude-code");
    assert.doesNotMatch(note, /show_build|land_build/);
  });

  it(
    "a Loop in place launches with no promise of when it ends and no time limit, whatever hours its start named",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT });
      const studio = studioOf(host);
      // The launched Loop claims its goal at once and closes before anything is asserted.
      host.turns.push(finishes);
      await launchFromIntake(
        studio as never,
        host.rec.ctx as never,
        { threadId: host.threadId, project: host.game.name } as never,
        { goal: "A level the player walks through.", engine: "claude-code", mode: "autopilot", hours: 3 },
      );
      assert.ok(await host.until(() => host.appended("run_finished").length > 0), "the launched Loop closed");
      assert.ok(await host.until(() => studio.activeRuns.size === 0), "the launched Loop settled");
      const said = host.rec
        .paramsOf("events.append")
        .flatMap((params) => (params.batch ?? []) as Array<{ type?: string }>)
        .filter((data) => data.type === "messages");
      // Flipped: the chat promised "Building until about …, keep the app open"; it promises nothing now.
      assert.deepEqual(said, [], "no promise in the chat");
      const budgets = host.appended("run_registered")[0]?.budgets as Record<string, unknown> | undefined;
      // Flipped (no clock): the launch registered `untilSatisfied: true` under a 24-hour `wallClockMs`.
      assert.equal(budgets?.untilSatisfied, undefined);
      assert.equal(budgets?.wallClockMs, undefined);
    },
  );
});

describe("a web Loop on a folder that reads otherwise now", () => {
  it(
    "a paused classic Autopilot run is a web Loop's: on a folder that reads otherwise it stays paused, its cap unrecorded",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, run: { engine: "ollama" } });
      host.rec.handle("engine.describe", () => [DIRECT]);
      const journal = { runId: host.run.runId, run: host.run, plan: { facets: [] }, phase: "facets", facets: {} };
      host.artifacts.set(`autopilot_${host.run.runId}`, structuredClone(journal));
      await host.dispatch({ resume: true });
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.stoppedBecause, OPEN_LOOP_REFUSAL.webElsewhere(GODOT_FOUND));
      assert.equal(closed?.executionStatus, "paused");

      const classic = await hostOn(Project.GodotGame, { facts: GODOT, run: { classic: true } });
      classic.artifacts.set(`autopilot_${classic.run.runId}`, {
        ...journal,
        runId: classic.run.runId,
        run: classic.run,
      });
      await classic.dispatch({ resume: true });
      assert.equal(classic.appended("run_finished")[0]?.stoppedBecause, OPEN_LOOP_REFUSAL.webElsewhere(GODOT_FOUND));
      const budgets = classic.appended("run_started")[0]?.budgets as Record<string, unknown> | undefined;
      assert.equal(budgets?.creditCap, undefined, "no credit cap of the open Loop's on a web run's refusal");
    },
  );
});

describe("what a Loop in place teaches", () => {
  it(
    "a fresh Loop in place runs no self-improvement pass: it is no evidence for the web method",
    TEST_TIMEOUT,
    async () => {
      const notes: LoopTurn = async ({ tool }) => {
        await tool("note", { text: "Rooms first, then the door." });
        await tool("finish", {
          review: "yes",
          summary: "The level is built and the door opens.",
          proof: "project.godot",
        });
        return undefined;
      };
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [notes] });
      await host.dispatch();
      assert.equal(host.appended("run_finished").at(-1)?.victory, true);
      assert.deepEqual(host.appended("run_learning"), [], "no learning pass");
    },
  );
});

describe("a web page missing its files, at the run's start", () => {
  it(
    "a launch kept from before that made a game with no kind is not refused for the web page it is about to get",
    TEST_TIMEOUT,
    async () => {
      const fresh = await hostOn(Project.GodotGame, { facts: [] });
      fresh.rec.handle("game.validate", () => ({
        problems: ["index.html is missing", "src/main.js is missing"],
        missing: ["index.html", "src/main.js"],
      }));
      fresh.rec.handle("game.start", () => {
        throw new Error("the web starter ran");
      });
      const action = { type: "run_start", threadId: fresh.threadId, run: structuredClone(fresh.run) };
      await handleRunStart(studioOf(fresh) as never, action as never, { keepStop: true });
      assert.deepEqual(fresh.appended("run_start_blocked"), [], "no refusal before the web starter");
      assert.equal(fresh.appended("run_registered").length, 1, "the run started");
      assert.equal(fresh.rec.paramsOf("game.start").length, 1, "and asked for the web starter");
    },
  );

  it(
    "a chat-launched web Loop is refused by Genex's own gate whichever launch asked, and a Loop in place is never validated",
    TEST_TIMEOUT,
    async () => {
      const web = await hostOn(Project.GodotGame, { facts: [{ id: "web-game", path: "." }] });
      web.rec.handle("game.validate", () => ({ problems: ["index.html is missing"], missing: ["index.html"] }));
      // An older launch hands the start no typed list: the start asks for it itself.
      const action = { type: "run_start", threadId: web.threadId, run: structuredClone(web.run) };
      await handleRunStart(studioOf(web) as never, action as never, { keepStop: true });
      const [blocked] = web.appended("run_start_blocked");
      assert.match(String(blocked?.reason), /is not ready for a run: index\.html is missing/);
      assert.equal(web.appended("run_registered").length, 0, "no run was registered");

      const godot = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      const start = { type: "run_start", threadId: godot.threadId, run: structuredClone(godot.run) };
      await handleRunStart(studioOf(godot) as never, start as never, { keepStop: true });
      assert.deepEqual(godot.rec.paramsOf("game.validate"), []);
      assert.equal(godot.appended("run_finished").length, 1);
    },
  );
});

describe("a Resume while the paused run is still closing", () => {
  it("waits for that run's close and starts: it is never refused as a second run", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        ({ host }) => {
          host.rec.cancel();
          return undefined;
        },
      ],
    });
    // Once the pause is recorded, the run's close is held: its report is still being written.
    let release = () => {};
    const held = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pauseRecorded = () => {};
    const recorded = new Promise<void>((resolve) => {
      pauseRecorded = resolve;
    });
    // What the Resume had done when the held close was let go: it waits, so nothing yet.
    let atClose: { lists: number; registered: number } | undefined;
    host.rec.handle("run.artifact", async (params) => {
      if (host.appended("autopilot_paused").length > 0 && !atClose) {
        pauseRecorded();
        await held;
        atClose = { lists: host.rec.paramsOf("game.list").length, registered: host.appended("run_registered").length };
      }
      return `/runs/${String(params.runId)}/${String(params.name)}`;
    });
    const studio = studioOf(host);
    const start = (resume: boolean) =>
      ({ type: "run_start", threadId: host.threadId, run: structuredClone(host.run), resume }) as never;
    const paused = handleRunStart(studio as never, start(false));
    // A first run that ends before its pause fails here, never waits forever.
    await Promise.race([recorded, paused]);
    assert.equal(host.appended("autopilot_paused").length, 1, "the pause is recorded");

    host.turns.push(finishes);
    host.rec.ctx.cancelled = false;
    const listsBefore = host.rec.paramsOf("game.list").length;
    const resumed = handleRunStart(studio as never, start(true));
    // Every step the Resume can take before the paused run's close is let go: a start that did not
    // wait would read the game list (its first host call) within them.
    await setImmediate();
    release();
    await Promise.all([paused, resumed]);
    assert.deepEqual(
      atClose,
      { lists: listsBefore, registered: 1 },
      "while the paused run closed, the Resume only waited: no game list read, no run registered",
    );
    assert.deepEqual(host.appended("run_start_blocked"), [], "the Resume is not refused");
    const registered = host.appended("run_registered");
    assert.equal(registered.length, 2, "the Resume started once the paused run had closed");
    assert.equal(registered[1]?.resumed, true);
    assert.equal(host.appended("run_finished").length, 2);
  });
});

/** A run's report write (`run.artifact`) held once `event` is appended for it: the run is writing its close. */
function holdCloseAfter(host: LoopHost, event: string) {
  let release = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached = () => {};
  const closing = new Promise<void>((resolve) => {
    reached = resolve;
  });
  // What the second start had done when the held close was let go.
  const state: { atClose?: { lists: number; registered: number } } = {};
  host.rec.handle("run.artifact", async (params) => {
    if (host.appended(event).length > 0 && !state.atClose) {
      reached();
      await held;
      state.atClose = {
        lists: host.rec.paramsOf("game.list").length,
        registered: host.appended("run_registered").length,
      };
    }
    return `/runs/${String(params.runId)}/${String(params.name)}`;
  });
  return { release, closing, state };
}

describe("a start while the finished run is still closing", () => {
  it("waits for that run's close and starts: it is never refused as a second run", TEST_TIMEOUT, async () => {
    const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
    const { release, closing, state } = holdCloseAfter(host, "run_finished");
    const studio = studioOf(host);
    const first = handleRunStart(
      studio as never,
      {
        type: "run_start",
        threadId: host.threadId,
        run: structuredClone(host.run),
      } as never,
    );
    // A first run that ends before its close fails here, never waits forever.
    await Promise.race([closing, first]);
    assert.equal(host.appended("run_finished").length, 1, "the finish is recorded");

    host.turns.push(finishes);
    const listsBefore = host.rec.paramsOf("game.list").length;
    const next = handleRunStart(
      studio as never,
      {
        type: "run_start",
        threadId: host.threadId,
        run: structuredClone(host.run),
        resume: true,
      } as never,
    );
    // Every step the start can take before the finished run's close is let go.
    await setImmediate();
    release();
    await Promise.all([first, next]);
    assert.deepEqual(
      state.atClose,
      { lists: listsBefore, registered: 1 },
      "while the finished run closed, the start only waited: no game list read, no run registered",
    );
    assert.deepEqual(host.appended("run_start_blocked"), [], "the start is not refused");
    assert.equal(host.appended("run_registered").length, 2, "it started once the finished run had closed");
  });
});

describe("Stop pressed again while a Resume waits for the Stop-paused run's close", () => {
  it("the Resume does not start", TEST_TIMEOUT, async () => {
    let studio: ReturnType<typeof studioOf> | undefined;
    const host = await hostOn(Project.GodotGame, {
      facts: GODOT,
      turns: [
        ({ host }) => {
          // The person's Stop: the thread's flag, and every run of the chat stopped.
          host.rec.cancel();
          if (studio) stopRunsOf(studio as never, host.threadId);
          return undefined;
        },
      ],
    });
    const { release, closing } = holdCloseAfter(host, "autopilot_paused");
    studio = studioOf(host);
    const start = (resume: boolean) =>
      ({ type: "run_start", threadId: host.threadId, run: structuredClone(host.run), resume }) as never;
    const paused = handleRunStart(studio as never, start(false));
    await Promise.race([closing, paused]);
    assert.equal(host.appended("autopilot_paused").length, 1, "the pause is recorded");

    host.turns.push(finishes);
    host.rec.ctx.cancelled = false;
    const resumed = handleRunStart(studio as never, start(true));
    await setImmediate();
    // Stop again, as the composer's Stop does it.
    studio.cancels.add(host.threadId);
    stopRunsOf(studio as never, host.threadId);
    release();
    await Promise.all([paused, resumed]);
    assert.equal(host.appended("run_registered").length, 1, "only the paused run was ever registered");
  });
});

describe("a run's route when its journal, its folder or the game list can't be read", () => {
  it(
    "a paused Loop that worked in place goes on in place on a folder of no kind Genex names, and nothing is written into it",
    TEST_TIMEOUT,
    async () => {
      const outcomes: Array<Record<string, unknown>> = [];
      for (const holds of ["own-files", "notes"]) {
        const host = await hostOn(Project.GodotGame, { facts: [], holds, turns: [finishes] });
        host.artifacts.set(`autopilot_${host.run.runId}`, {
          runId: host.run.runId,
          run: host.run,
          phase: "paused",
          director: { baseCommit: "abc", integrationHead: null, open: { version: 1, savePoints: [] } },
        });
        await host.dispatch({ resume: true });
        outcomes.push({
          holds,
          started: host.rec.paramsOf("game.start").length,
          inPlace: inPlaceLeads(host).length > 0,
          status: host.appended("run_finished").at(-1)?.executionStatus,
        });
      }
      assert.deepEqual(outcomes, [
        { holds: "own-files", started: 0, inPlace: true, status: "completed" },
        { holds: "notes", started: 0, inPlace: true, status: "completed" },
      ]);
    },
  );

  it(
    "a paused Loop whose journal can't be read stays paused, and no Loop of either kind runs",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      const id = `autopilot_${host.run.runId}`;
      host.artifacts.set(id, {
        runId: host.run.runId,
        run: host.run,
        director: { baseCommit: "abc", open: { version: 1 } },
      });
      host.rec.handle("artifact.read", (params) => {
        if (params.artifactId === id) throw new Error("the disk is busy");
        return structuredClone(host.artifacts.get(String(params.artifactId)) ?? null);
      });
      await host.dispatch({ resume: true });
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.stoppedBecause, OPEN_LOOP_REFUSAL.journalUnreadable);
      assert.equal(closed?.executionStatus, "paused");
      assert.equal(host.leadCalls().length, 0);
    },
  );

  it(
    "a fresh run whose game list can't be read is refused with words, and nothing web is written",
    TEST_TIMEOUT,
    async () => {
      const host = await hostOn(Project.GodotGame, { facts: GODOT, turns: [finishes] });
      host.rec.handle("game.list", () => {
        throw new Error("a studio.json can't be read");
      });
      await host.dispatch();
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.stoppedBecause, OPEN_LOOP_REFUSAL.gamesUnreadable);
      for (const method of ["game.scaffold", "game.start", "preview.load", "engine.delegate"])
        assert.equal(host.rec.paramsOf(method).length, 0, `no ${method}`);
    },
  );

  it(
    "a web game holding an engine's sample project is told which files make its Loop work in place",
    TEST_TIMEOUT,
    async () => {
      const facts = [
        { id: "web-game", path: "." },
        { id: "godot-project", path: "assets/pack" },
      ];
      const host = await hostOn(Project.GodotGame, { facts, run: { engine: "ollama" } });
      host.rec.handle("engine.describe", () => [DIRECT]);
      await host.dispatch();
      const [closed] = host.appended("run_finished");
      assert.equal(closed?.stoppedBecause, OPEN_LOOP_REFUSAL.needsSession("Ollama", "godot-project in assets/pack"));
    },
  );
});
