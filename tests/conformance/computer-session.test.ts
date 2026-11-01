/**
 * The computer session over any target: a fake target records what reached it, so the session's
 * own rules — observing after an action, batches, the action budget, the trace and the clock's
 * pacing — are tested without a window.
 */
import assert from "node:assert/strict";
import { readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { computerSession, type TargetSource } from "../../src/main/core/computer-session.ts";
import {
  BROWSER_CAPABILITIES,
  ClockLevel,
  DESKTOP_CAPABILITIES,
  InputRoute,
  StateLevel,
  type TargetCapabilities,
} from "../../src/shared/computer-target.ts";
import type { ComputerTarget } from "../../src/substrate/computer-target.ts";
import type { LiveToolResult } from "../../src/substrate/engines/types.ts";
import { tmpDir } from "../helpers/tmp.ts";

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const images = (result: LiveToolResult): number => (typeof result === "string" ? 0 : (result.images?.length ?? 0));

/** A target that records every call in order, with a clock that can step. */
function fakeTarget(options: { stepAnswers?: number | null; failInputAt?: number } = {}) {
  const calls: string[] = [];
  let inputs = 0;
  const target: ComputerTarget = {
    caps: BROWSER_CAPABILITIES,
    viewSize: () => ({ width: 960, height: 600 }),
    pointer: () => ({ x: 1, y: 2 }),
    screenshot: async ({ surface }) => {
      calls.push(`shot:${surface}`);
      return { jpeg: Buffer.from("jpeg"), stats: null, surface: null };
    },
    input: async (actions) => {
      inputs += 1;
      if (options.failInputAt === inputs) throw new Error("the window went away");
      calls.push(`input:${actions.map((a) => a.type).join("+")}`);
      return { applied: actions.length, route: InputRoute.Browser };
    },
    state: async () => ({ hp: 3 }),
    clock: {
      pause: async () => {
        calls.push("pause");
      },
      start: async () => {
        calls.push("start");
      },
      step: async (ms) => {
        calls.push(`step:${ms}`);
        return options.stepAnswers === undefined ? ms : options.stepAnswers;
      },
    },
    seed: async (seed) => {
      calls.push(`seed:${seed}`);
    },
  };
  return { target, calls };
}

/** A source over one fake target: loads it once, frames go nowhere. */
function sourceOf(target: ComputerTarget): TargetSource {
  let loaded = false;
  return {
    caps: target.caps,
    load: async () => {
      const fresh = !loaded;
      loaded = true;
      return { target, problem: null, note: null, fresh };
    },
    frame: async () => {},
  };
}

async function session(options: Partial<Parameters<typeof computerSession>[2]> & { target?: ComputerTarget } = {}) {
  const fake = options.target ? { target: options.target, calls: [] as string[] } : fakeTarget();
  const frameDir = await tmpDir("computer-session-");
  const s = computerSession(sourceOf(fake.target), "/build", { pacing: "running", frameDir, ...options });
  return { s, calls: fake.calls, frameDir };
}

describe("computer session — observe after an action", () => {
  it("returns the picture with the answer when asked, and saves it as a frame", async () => {
    const { s, calls } = await session();
    const answer = await s.run("computer", { action: "key", text: "w", observe: "screenshot" });
    assert.equal(images(answer), 1);
    assert.match(text(answer), /s1_/);
    assert.deepEqual(calls, ["input:press", "shot:auto"]);
  });

  it("observes by default where the session says so, and never when told none", async () => {
    const { s, calls } = await session({ observeByDefault: true });
    assert.equal(images(await s.run("computer", { action: "key", text: "w" })), 1);
    assert.equal(images(await s.run("computer", { action: "key", text: "w", observe: "none" })), 0);
    assert.deepEqual(calls, ["input:press", "shot:auto", "input:press"]);
    assert.doesNotMatch(
      text(await s.run("computer", { action: "key", text: "w", observe: "none" })),
      /Screenshot to see/,
    );
  });

  it("photographs only the canvas when asked", async () => {
    const { s, calls } = await session();
    await s.run("computer", { action: "key", text: "w", observe: "canvas" });
    assert.equal(calls.at(-1), "shot:canvas");
  });
});

describe("computer session — batches and the action budget", () => {
  it("runs a batch in order with one look at the end", async () => {
    const { s, calls } = await session();
    const answer = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "left_click", coordinate: "5,5" },
      ],
      observe: "screenshot",
    });
    assert.deepEqual(calls, ["input:press", "input:click", "shot:auto"]);
    assert.equal(images(answer), 1);
    assert.match(text(answer), /2 of 2 steps/);
  });

  it("stops a batch at the first step that fails and names it", async () => {
    const { target, calls } = fakeTarget({ failInputAt: 2 });
    const { s } = await session({ target });
    const answer = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "a" },
        { action: "key", text: "d" },
      ],
    });
    assert.match(text(answer), /step 2 \(key a\) failed/);
    assert.deepEqual(calls, ["input:press"]);
  });

  it("counts every batch step against the budget, on the host", async () => {
    const { s } = await session({ maxActions: 3 });
    await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "w" },
      ],
    });
    const over = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "w" },
      ],
    });
    assert.match(text(over), /action budget/);
    const last = await s.run("computer", { action: "key", text: "w" });
    assert.doesNotMatch(text(last), /action budget/);
    assert.match(text(await s.run("computer", { action: "key", text: "w" })), /action budget/);
    assert.doesNotMatch(text(await s.run("computer", { action: "screenshot" })), /action budget/, "looking is free");
  });
});

describe("computer session — the trace", () => {
  it("writes one row per action with its route, frame and cursor", async () => {
    const { s, frameDir } = await session();
    await s.run("computer", { action: "key", text: "w", observe: "screenshot" });
    await s.run("computer", { action: "state" });
    const rows = (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    assert.equal(rows.length, 2);
    assert.equal(rows[0].action, "key");
    assert.equal(rows[0].route, InputRoute.Browser);
    assert.match(rows[0].frame, /s1_/);
    assert.deepEqual(rows[0].cursor, { x: 1, y: 2 });
    assert.equal(rows[1].action, "state");
    assert.equal(rows[1].route, null);
    assert.equal(s.trace().steps, 2);
    assert.equal(s.trace().path, path.join(frameDir, "trace.jsonl"));
  });

  it("numbers on past what an earlier process left in the folder: no trace is appended to, no frame overwritten", async () => {
    const frameDir = await tmpDir("computer-session-");
    await writeFile(path.join(frameDir, "trace.jsonl"), '{"i":1,"action":"key"}\n');
    await writeFile(path.join(frameDir, "s7_after-key.jpg"), "earlier");
    const { target } = fakeTarget();
    const s = computerSession(sourceOf(target), "/build", { pacing: "running", frameDir });
    const answer = await s.run("computer", { action: "key", text: "w", observe: "screenshot" });
    assert.match(text(answer), /s8_after-key/);
    assert.equal(s.trace().path, path.join(frameDir, "trace-2.jsonl"));
    assert.equal(await readFile(path.join(frameDir, "trace.jsonl"), "utf8"), '{"i":1,"action":"key"}\n');
    assert.equal(await readFile(path.join(frameDir, "s7_after-key.jpg"), "utf8"), "earlier");
  });
});

describe("computer session — the clock", () => {
  it("a paced session pauses after load and runs the clock only during a move", async () => {
    const { s, calls } = await session({ pacing: "paced" });
    await s.run("computer", { action: "key", text: "w" });
    assert.deepEqual(calls, ["pause", "start", "input:press", "pause"]);
  });

  it("a stepped session seeds, pauses, and steps exact time after each move and through a wait", async () => {
    const { s, calls } = await session({ pacing: "stepped", seed: 7 });
    await s.run("computer", { action: "key", text: "w" });
    await s.run("computer", { action: "wait", duration: 0.5 });
    // Flipped on purpose (review finding): a stroke on a stepped clock is its down, a few frames of
    // game time, and its up, so a game that reads keys once a frame sees it; then the settle step.
    assert.deepEqual(calls, ["seed:7", "pause", "input:down", "step:50", "input:up", "step:120", "step:500"]);
    assert.equal(s.trace().deterministic, true);
  });

  it("a stepped session whose target cannot step falls back to pacing and marks the trace", async () => {
    const { target, calls } = fakeTarget({ stepAnswers: null });
    const { s } = await session({ pacing: "stepped", target });
    await s.run("computer", { action: "key", text: "w" });
    await s.run("computer", { action: "key", text: "w" });
    assert.equal(s.trace().deterministic, false);
    assert.deepEqual(
      calls.slice(-3),
      ["start", "input:press", "pause"],
      "it paces with start/pause once stepping failed",
    );
  });

  it("a target without a holdable clock is never paused, whatever the role", async () => {
    const { target, calls } = fakeTarget();
    const { s } = await session({
      pacing: "paced",
      target: { ...target, caps: { ...BROWSER_CAPABILITIES, clock: ClockLevel.None } },
    });
    await s.run("computer", { action: "key", text: "w" });
    assert.deepEqual(calls, ["input:press"]);
  });
});

describe("computer session — review findings", () => {
  it("a held key on a stepped clock is held for that much game time, not wall time", async () => {
    const { s, calls } = await session({ pacing: "stepped", seed: 3 });
    await s.run("computer", { action: "hold_key", text: "w", duration: 2 });
    assert.deepEqual(calls, ["seed:3", "pause", "input:down", "step:2000", "input:up", "step:120"]);
  });

  it("reads what the loaded target can do: a clock it cannot step is paced, and the trace never claims a replay", async () => {
    const { target, calls } = fakeTarget();
    const unstepped: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, clock: ClockLevel.None },
      clock: { pause: target.clock!.pause, start: target.clock!.start },
    };
    // The source promises more than the game delivers, as a Play Protocol game does before `hello`.
    let loaded = false;
    const source: TargetSource = {
      caps: BROWSER_CAPABILITIES,
      load: async () => {
        const fresh = !loaded;
        loaded = true;
        return { target: unstepped, problem: null, note: null, fresh };
      },
      frame: async () => {},
    };
    const s = computerSession(source, "/build", { pacing: "stepped", frameDir: await tmpDir("cs-caps-") });
    await s.run("computer", { action: "key", text: "w" });
    assert.ok(!calls.some((call) => call.startsWith("step")), "nothing stepped");
    assert.ok(!calls.includes("pause"), "a clock that cannot be held is not paused");
    assert.equal(s.trace().deterministic, false);
  });

  it("says when the game took only part of a move, and a batch stops where the game refused everything", async () => {
    const { target } = fakeTarget();
    let taken = 0;
    const picky: ComputerTarget = {
      ...target,
      input: async (actions) => ({ applied: Math.min(taken, actions.length), route: InputRoute.Bridge }),
    };
    const { s, frameDir } = await session({ target: picky });
    assert.match(
      text(await s.run("computer", { action: "key", text: "w" })),
      /PARTLY — key w: 0 of 1 input actions were taken/,
    );
    const stopped = await s.run("computer", {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "a" },
      ],
    });
    assert.match(text(stopped), /step 1 \(key w\) failed: every input of that step was refused/);
    taken = 5;
    assert.match(text(await s.run("computer", { action: "key", text: "w" })), /^OK — key w/);
    const rows = (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.deepEqual(rows[0].applied, { taken: 0, planned: 1 });
  });

  it("an action that throws is answered as an error and still written to the trace", async () => {
    const { target } = fakeTarget({ failInputAt: 1 });
    const { s, frameDir } = await session({ target });
    const answer = await s.run("computer", { action: "key", text: "w" });
    assert.equal(typeof answer !== "string" && answer.isError, true);
    assert.match(text(answer), /key failed: the window went away/);
    const rows = (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
      .trim()
      .split("\n")
      .map((l) => JSON.parse(l));
    assert.equal(rows[0].failed, "the window went away");
  });

  it("two sessions in one folder never overwrite each other's frames or trace", async () => {
    const frameDir = await tmpDir("cs-shared-");
    const a = computerSession(sourceOf(fakeTarget().target), "/build", { pacing: "running", frameDir });
    const b = computerSession(sourceOf(fakeTarget().target), "/build", { pacing: "running", frameDir });
    await a.run("computer", { action: "screenshot" });
    await b.run("computer", { action: "screenshot" });
    assert.notEqual(a.trace().path, b.trace().path);
    const frames = (await readdir(frameDir)).filter((f) => f.endsWith(".jpg"));
    assert.equal(frames.length, 2, frames.join(","));
  });
});

/** The game's own state, as a Play Protocol game or an engine editor's play reports it. */
const GAME_CAPABILITIES: TargetCapabilities = { ...BROWSER_CAPABILITIES, state: StateLevel.Game };

/** The fake target with a state that answers each read from `states` in turn, the last one again once they run out. */
function statefulTarget(states: unknown[], caps: TargetCapabilities = GAME_CAPABILITIES): ComputerTarget {
  const { target } = fakeTarget();
  let read = 0;
  return { ...target, caps, state: async () => states[Math.min(read++, states.length - 1)] };
}

/** The rows of a session's trace file, parsed. */
async function traceRows(frameDir: string): Promise<Array<Record<string, unknown>>> {
  return (await readFile(path.join(frameDir, "trace.jsonl"), "utf8"))
    .trim()
    .split("\n")
    .map((line) => JSON.parse(line));
}

/** Presses enough for three to be judged: the first input of a session has no state before it to compare with. */
const JUDGED_THREE = 4;
const STILL_NOTE = /the last 3 inputs changed nothing in the game/;
const FROZEN_NOTE = /game time did not move during the last 3 inputs/;

describe("computer session — inputs that change nothing", () => {
  it("says so once three inputs in a row leave the game's state as it was, and marks them in the trace", async () => {
    const { s, frameDir } = await session({ target: statefulTarget([{ hp: 3, at: [0, 0] }]) });
    const answers = [];
    for (let i = 0; i < 5; i++) answers.push(text(await s.run("computer", { action: "key", text: "w" })));
    assert.ok(
      answers.slice(0, 3).every((answer) => !STILL_NOTE.test(answer)),
      "the first input is only the state to compare with; then two",
    );
    assert.match(answers[3], STILL_NOTE);
    assert.match(answers[4], /the last 4 inputs changed nothing in the game/);
    const rows = await traceRows(frameDir);
    assert.deepEqual(
      rows.map((row) => row.still ?? null),
      [null, "unchanged", "unchanged", "unchanged", "unchanged"],
    );
    assert.equal(s.trace().stillInputs, 4);
  });

  it("stays quiet while the inputs change the game, and starts counting again after a change", async () => {
    const here = { at: [0, 0] };
    const there = { at: [1, 0] };
    const { s } = await session({ target: statefulTarget([here, here, here, there, there, there]) });
    const answers = [];
    for (let i = 0; i < 6; i++) answers.push(text(await s.run("computer", { action: "key", text: "w" })));
    assert.ok(
      answers.every((answer) => !STILL_NOTE.test(answer)),
      "two unchanged, one change, two unchanged: never three in a row",
    );
    assert.equal(s.trace().stillInputs, 4);
  });

  it("sets aside what changes with time alone: the clock, frame counts, the input echo and volatile timings", async () => {
    const ticking = statefulTarget(
      [0, 1, 2, 3, 4].map((n) => ({
        gameSeconds: n * 0.5,
        frame: n * 30,
        fps: 60 - n,
        held: n % 2 ? ["KeyW"] : [],
        input: { keys: ["KeyW"], look: { dx: n, dy: 0 } },
        volatile: { tickMs: 16 + n },
        player: { location: [10, 20, 30] },
      })),
    );
    const { s } = await session({ target: ticking });
    let last = "";
    for (let i = 0; i < JUDGED_THREE; i++) last = text(await s.run("computer", { action: "key", text: "w" }));
    assert.match(last, STILL_NOTE);
  });

  it("goes by the game's own checksum when it keeps one", async () => {
    const summed = statefulTarget(["a", "b", "c", "d"].map((checksum) => ({ checksum, hp: 3 })));
    const { s } = await session({ target: summed });
    let last = "";
    for (let i = 0; i < JUDGED_THREE; i++) last = text(await s.run("computer", { action: "key", text: "w" }));
    assert.doesNotMatch(last, STILL_NOTE);
    assert.equal(s.trace().stillInputs, 0);
  });

  it("names a game whose clock stood still: paused or stopped, not merely unmoved", async () => {
    const paused = statefulTarget([{ gameSeconds: 12.5, player: { location: [0, 0, 0] } }]);
    const { s, frameDir } = await session({ target: paused });
    let last = "";
    for (let i = 0; i < JUDGED_THREE; i++) last = text(await s.run("computer", { action: "key", text: "w" }));
    assert.match(last, FROZEN_NOTE);
    assert.doesNotMatch(last, STILL_NOTE);
    assert.deepEqual(
      (await traceRows(frameDir)).map((row) => row.still ?? null),
      [null, "frozen", "frozen", "frozen"],
    );
  });

  it("never judges pointing alone, a wait, a target with no state, or an app's accessibility tree", async () => {
    const still = await session({ target: statefulTarget([{ hp: 3 }]) });
    for (let i = 0; i < 3; i++) await still.s.run("computer", { action: "mouse_move", coordinate: "5,5" });
    for (let i = 0; i < 3; i++) await still.s.run("computer", { action: "wait", duration: 0.01 });
    assert.equal(still.s.trace().stillInputs, 0, "hovering and waiting may rightly change nothing");

    const { target } = fakeTarget();
    const { state: _state, ...stateless } = target;
    const blind = await session({ target: stateless });
    let last = "";
    for (let i = 0; i < JUDGED_THREE; i++) last = text(await blind.s.run("computer", { action: "key", text: "w" }));
    assert.doesNotMatch(last, STILL_NOTE);
    assert.equal(blind.s.trace().stillInputs, 0);

    const app = await session({ target: statefulTarget([{ window: "Notes" }], DESKTOP_CAPABILITIES) });
    for (let i = 0; i < JUDGED_THREE; i++) {
      last = text(await app.s.run("computer", { action: "left_click", coordinate: "5,5" }));
    }
    assert.doesNotMatch(last, STILL_NOTE, "a click may rightly leave an app's accessibility tree as it was");
    assert.equal(app.s.trace().stillInputs, 0);
  });

  it("judges a batch as one move, by its state at the end", async () => {
    const { s } = await session({ target: statefulTarget([{ hp: 3 }]) });
    const batch = {
      action: "batch",
      actions: [
        { action: "key", text: "w" },
        { action: "key", text: "d" },
      ],
    };
    let last = "";
    for (let i = 0; i < JUDGED_THREE; i++) last = text(await s.run("computer", batch));
    assert.match(last, STILL_NOTE);
    assert.equal(s.trace().stillInputs, 3);
  });
});

describe("computer session — the recap", () => {
  it("adds up what the session's moves amounted to: inputs, waits, still inputs and their longest run", async () => {
    const { s } = await session({ target: statefulTarget([{ hp: 3 }]) });
    await s.run("computer", { action: "screenshot" });
    for (let i = 0; i < 4; i++) await s.run("computer", { action: "key", text: "w" });
    await s.run("computer", { action: "wait", duration: 0.01 });
    const recap = text(await s.run("computer", { action: "recap" }));
    assert.match(recap, /4 inputs, 1 wait, 1 look/);
    assert.match(recap, /inputs that changed nothing in the game: 3 \(longest run 3: moves 3–5\)/);
    assert.doesNotMatch(recap, /stood still/);
  });

  it("names the moves the target refused or took in part, the actions that failed, and the game's clock standing", async () => {
    const { target } = fakeTarget();
    // On a stepped clock a key press is two inputs, down then up: the game answers each in turn.
    const answers: Array<number | "throw"> = [0, 0, 1, 0, "throw"];
    const flaky: ComputerTarget = {
      ...target,
      caps: GAME_CAPABILITIES,
      state: async () => ({ gameSeconds: 4 }),
      input: async (actions) => {
        const next = answers.shift() ?? actions.length;
        if (next === "throw") throw new Error("the window went away");
        return { applied: Math.min(next, actions.length), route: InputRoute.Bridge };
      },
    };
    const { s } = await session({ target: flaky, pacing: "stepped", seed: 1 });
    for (let i = 0; i < 6; i++) await s.run("computer", { action: "key", text: "w" });
    const recap = text(await s.run("computer", { action: "recap" }));
    assert.match(recap, /input the target refused: move 1\n/);
    assert.match(recap, /taken only in part: move 2\n/);
    assert.match(recap, /actions that failed: move 3 \(the window went away\)/);
    assert.match(
      recap,
      /changed nothing in the game: 4 \(longest run 4: moves 2–6\); game time stood still in 4/,
      "moves 2, 4, 5 and 6 were judged and the clock never moved; the failed move 3 was not judged",
    );
  });

  it("groups the console's errors since load by message, most frequent first", async () => {
    const { target } = fakeTarget();
    const errors = [
      ...Array.from({ length: 5 }, () => "TypeError: enemy is undefined"),
      "Failed to load texture rock.png",
      "TypeError: enemy is undefined",
    ];
    const noisy: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, console: true },
      console: () => errors.map((message) => ({ level: "error" as const, message, at: 0 })),
    };
    const { s } = await session({ target: noisy });
    await s.run("computer", { action: "key", text: "w" });
    const recap = text(await s.run("computer", { action: "recap" }));
    assert.match(
      recap,
      /console errors since load: 7, 2 kinds — 6× TypeError: enemy is undefined; 1× Failed to load texture rock\.png/,
    );
  });

  it("says when nothing went wrong that it can see, and before any move that there is nothing yet", async () => {
    const fresh = await session();
    assert.match(text(await fresh.s.run("computer", { action: "recap" })), /no moves yet/);
    const changing = await session({ target: statefulTarget([{ at: 0 }, { at: 1 }, { at: 2 }]) });
    await changing.s.run("computer", { action: "key", text: "w" });
    await changing.s.run("computer", { action: "key", text: "w" });
    assert.match(
      text(await changing.s.run("computer", { action: "recap" })),
      /nothing went wrong that the session can see/,
    );
  });

  it("costs no move from the budget", async () => {
    const { s } = await session({ maxActions: 1 });
    await s.run("computer", { action: "key", text: "w" });
    assert.match(text(await s.run("computer", { action: "recap" })), /1 input/);
    assert.match(text(await s.run("computer", { action: "key", text: "w" })), /action budget spent/);
  });
});

describe("computer session — what the game's detectors noticed", () => {
  const gone = { code: "player-gone", detail: "the player's pawn is gone", gameSeconds: 12.5, count: 1 };
  const hitch = { code: "hitch", detail: "a frame took 1.2 s", gameSeconds: 14, count: 10 };

  it("says what the game's detectors told, once, apart from the state it came with, and keeps it in the trace", async () => {
    const target = statefulTarget([
      { at: [0, 0], findings: [] },
      { at: [1, 0], findings: [gone] },
      { at: [2, 0], findings: [] },
    ]);
    const { s, frameDir } = await session({ target });
    const answers = [];
    for (let i = 0; i < 3; i++) answers.push(text(await s.run("computer", { action: "key", text: "w" })));
    assert.doesNotMatch(answers[0], /game's detectors/);
    assert.match(answers[1], /the game's detectors noticed: the player's pawn is gone \(player-gone at 12\.5 s\)/);
    assert.doesNotMatch(answers[1], /"findings"/, "the state shows the game, the line shows the findings");
    assert.doesNotMatch(answers[2], /game's detectors/);
    const rows = await traceRows(frameDir);
    assert.deepEqual(
      rows.map((row) => (row.findings as Array<{ code: string }> | undefined)?.map((f) => f.code) ?? []),
      [[], ["player-gone"], []],
    );
  });

  it("never takes a finding for a change in the game", async () => {
    const target = statefulTarget([
      { hp: 3, findings: [] },
      { hp: 3, findings: [hitch] },
      { hp: 3, findings: [] },
      { hp: 3, findings: [gone] },
    ]);
    const { s } = await session({ target });
    let last = "";
    for (let i = 0; i < JUDGED_THREE; i++) last = text(await s.run("computer", { action: "key", text: "w" }));
    assert.match(last, STILL_NOTE);
  });

  it("adds them up in the recap by kind, with how often each was told and where it first showed", async () => {
    const target = statefulTarget([
      { at: 0, findings: [] },
      { at: 1, findings: [{ ...hitch, count: 1 }] },
      { at: 2, findings: [gone, hitch] },
      { at: 3, findings: [] },
    ]);
    const { s } = await session({ target });
    for (let i = 0; i < 4; i++) await s.run("computer", { action: "key", text: "w" });
    const recap = text(await s.run("computer", { action: "recap" }));
    assert.match(
      recap,
      /- the game's detectors noticed: hitch ×10 \(first at move 2: a frame took 1\.2 s\); player-gone ×1 \(first at move 3: the player's pawn is gone\)/,
    );
    assert.doesNotMatch(recap, /nothing went wrong/);
  });
});

describe("computer session — named game actions", () => {
  it("hands act to the target, held for its duration of game time, and refuses it where there are none", async () => {
    const { target, calls } = fakeTarget();
    const acting: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, actions: true },
      act: async (list) => {
        calls.push(`act:${list.map((a) => `${a.action}/${a.state}/${a.ticks ?? 0}`).join(",")}`);
        return { applied: list.length, route: InputRoute.Bridge };
      },
    };
    const { s } = await session({ target: acting, pacing: "stepped", seed: 1 });
    await s.run("computer", { action: "act", text: "jump" });
    await s.run("computer", { action: "act", text: "run", duration: 1 });
    assert.deepEqual(calls, ["seed:1", "pause", "act:jump/press/0", "step:120", "act:run/hold/60", "step:1000"]);
    const plain = await session();
    assert.match(text(await plain.s.run("computer", { action: "act", text: "jump" })), /not available/);
  });
});

describe("computer session — why a game refused", () => {
  it("names the game's own reason when it took only part of a move", async () => {
    const { target } = fakeTarget();
    const pending = [{ op: "key", code: "unsupported", message: "no keyboard in this build" }];
    const refusing: ComputerTarget = {
      ...target,
      input: async () => ({ applied: 0, route: InputRoute.Bridge }),
      refusals: () => pending.splice(0),
    };
    const { s } = await session({ target: refusing });
    assert.match(
      text(await s.run("computer", { action: "key", text: "w" })),
      /PARTLY .*\(key: no keyboard in this build\)/,
    );
  });
});

describe("computer session — bringing an app to the front", () => {
  it("hands bring_to_front to a target that can, says why when it could not, and refuses it elsewhere", async () => {
    const { target, calls } = fakeTarget();
    const desk: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, apps: true },
      front: async (app, window) => {
        calls.push(window ? `front:${app}:${window}` : `front:${app}`);
        return app === "chrome.exe" ? `${app} did not come to the front` : null;
      },
    };
    const { s } = await session({ target: desk });
    assert.match(
      text(await s.run("computer", { action: "bring_to_front", text: "msedge.exe" })),
      /^OK — bring msedge\.exe to the front/,
    );
    assert.match(
      text(await s.run("computer", { action: "bring_to_front", text: "chrome.exe" })),
      /bring_to_front did not happen: chrome\.exe did not come to the front/,
    );
    assert.match(text(await s.run("computer", { action: "bring_to_front" })), /bring_to_front needs text=<app>/);
    assert.match(
      text(
        await s.run("computer", {
          action: "bring_to_front",
          text: "com.Roblox.RobloxStudio",
          window: " spinning-colored-block ",
        }),
      ),
      /^OK — bring com\.Roblox\.RobloxStudio \(spinning-colored-block\) to the front/,
      "one of the app's windows, by part of its title",
    );
    assert.deepEqual(calls, [
      "front:msedge.exe",
      "front:chrome.exe",
      "front:com.Roblox.RobloxStudio:spinning-colored-block",
    ]);
    const plain = await session();
    assert.match(
      text(await plain.s.run("computer", { action: "bring_to_front", text: "msedge.exe" })),
      /not available/,
    );
  });
});

describe("computer session — opening a page in the person's browser", () => {
  it("hands open_page to a target that can, says why when it could not, and refuses it elsewhere", async () => {
    const { target, calls } = fakeTarget();
    const desk: ComputerTarget = {
      ...target,
      caps: { ...BROWSER_CAPABILITIES, apps: true },
      openPage: async (address) => {
        calls.push(`page:${address}`);
        return address.startsWith("https://create.example.com/") ? null : "that page is not this task's";
      },
    };
    const { s } = await session({ target: desk });
    assert.match(
      text(await s.run("computer", { action: "open_page", text: "https://create.example.com/icon" })),
      /^OK — open create\.example\.com in the browser/,
    );
    assert.match(
      text(await s.run("computer", { action: "open_page", text: "https://elsewhere.example/" })),
      /open_page did not happen: that page is not this task's/,
    );
    assert.match(
      text(await s.run("computer", { action: "open_page" })),
      /open_page needs text=<an https:\/\/ address>/,
    );
    assert.deepEqual(calls, ["page:https://create.example.com/icon", "page:https://elsewhere.example/"]);
    const plain = await session();
    assert.match(
      text(await plain.s.run("computer", { action: "open_page", text: "https://create.example.com/icon" })),
      /not available/,
    );
  });
});
