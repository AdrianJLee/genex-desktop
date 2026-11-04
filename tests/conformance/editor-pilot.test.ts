/**
 * A pilot's run on an editor play, the studio's side: it starts the pilot, steps it until it is over,
 * and hands each of its asks to the fast decision model when one is set up, the answer going back on
 * the very next step. Without a model the pilot is told to choose by its own order and nobody is asked.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { runPilot } from "../../src/main/core/editor-pilot.ts";
import {
  EnginePlayOptionalTool,
  EnginePlayRefusal,
  type PilotAnswer,
  type PilotAsk,
  PilotOutcome,
  PilotPhase,
} from "../../src/shared/engine-play.ts";
import type { FastDecider } from "../../src/shared/fast-decisions.ts";

type Call = { tool: string; args: Record<string, unknown> };

const REPORT = {
  outcome: PilotOutcome.Done,
  note: "the turret is off",
  evidence: { turretHealth: 0 },
  gameSeconds: 14.2,
  stages: [{ name: "wrench", done: true, atSeconds: 6.1 }],
  moves: [{ name: "attack", started: 3, worked: 3, failed: 0, medianSeconds: 1.1 }],
  asked: 2,
  answered: 2,
  byOrder: 1,
  facts: { turret_m: 1.2 },
  timeline: ["0.0 s start attack: picked (p 0.81)"],
  errors: [],
};

function ask(id: number): PilotAsk {
  return {
    id,
    state: { goal: "Disable the turret" },
    moves: { attack: "hit", back_off: "step away" },
    instructions: "",
    questions: {},
  };
}

/** A play whose pilot steps through `steps` (one answer per step, the last repeated), every call recorded. */
function play(steps: unknown[], started: unknown = { piloting: true, pilot: "Turret", seconds: 30 }) {
  const calls: Call[] = [];
  let at = 0;
  const call = async (tool: string, args: Record<string, unknown>) => {
    calls.push({ tool, args });
    if (tool === EnginePlayOptionalTool.Pilot) return started;
    if (args.stop === true) return { phase: PilotPhase.Over, report: { ...REPORT, outcome: PilotOutcome.Stopped } };
    const step = steps[Math.min(at, steps.length - 1)];
    at += 1;
    return step;
  };
  return { call, calls };
}

/** A decider that answers every ask for `move`, counting its asks. */
function decider(move: string): FastDecider & { asked: number[] } {
  const asked: number[] = [];
  return {
    model: "jev-1.14.0",
    asked,
    async choose(given): Promise<PilotAnswer> {
      asked.push(given.id);
      return { id: given.id, probabilities: { [move]: 0.8 }, answers: {}, ms: 140 + given.id };
    },
    tally: () => ({ inputTokens: 900, failures: [] }),
  };
}

const deps = (call: ReturnType<typeof play>["call"], chosen: FastDecider | null, now = () => 0) => ({
  call,
  decider: chosen,
  now,
  sleep: async () => {},
});

test("without a fast decision model the pilot chooses by its own order and nothing is asked", async () => {
  const { call, calls } = play([
    { phase: PilotPhase.Piloting, ask: null, byOrder: 1 },
    { phase: PilotPhase.Over, report: { ...REPORT, asked: 0, answered: 0 } },
  ]);
  const piloted = await runPilot(deps(call, null), { file: "Pilots/turret.py", seconds: 30 });
  assert.deepEqual(calls[0], {
    tool: EnginePlayOptionalTool.Pilot,
    args: { file: "Pilots/turret.py", seconds: 30, decide: false },
  });
  assert.equal(piloted.outcome, PilotOutcome.Done);
  assert.deepEqual(piloted.evidence, { turretHealth: 0 });
  assert.deepEqual(piloted.decisions, {
    asked: 0,
    answered: 0,
    byOrder: 1,
    model: null,
    medianMs: null,
    inputTokens: 0,
    failures: [],
  });
  assert.ok(calls.slice(1).every((c) => c.args.answer === undefined));
});

test("each ask goes to the model once and its answer rides on the very next step", async () => {
  const { call, calls } = play([
    { phase: PilotPhase.Piloting, ask: ask(1) },
    { phase: PilotPhase.Piloting, ask: null },
    { phase: PilotPhase.Piloting, ask: ask(2) },
    { phase: PilotPhase.Piloting, ask: ask(2) },
    { phase: PilotPhase.Over, report: REPORT },
  ]);
  const jev = decider("back_off");
  const piloted = await runPilot(deps(call, jev), { file: "Pilots/turret.py", seconds: 30 });
  assert.equal(calls[0]?.args.decide, true);
  assert.deepEqual(jev.asked, [1, 2], "an ask still out on the next step is not asked again");
  const handed = calls.filter((c) => typeof c.args.answer === "string").map((c) => JSON.parse(String(c.args.answer)));
  assert.deepEqual(handed, [
    { id: 1, probabilities: { back_off: 0.8 }, answers: {}, ms: 141 },
    { id: 2, probabilities: { back_off: 0.8 }, answers: {}, ms: 142 },
  ]);
  const second = calls.findIndex((c) => typeof c.args.answer === "string");
  assert.equal(calls[second - 1]?.args.answer, undefined, "the step before carried the ask");
  assert.deepEqual(piloted.decisions, {
    asked: 2,
    answered: 2,
    byOrder: 1,
    model: "jev-1.14.0",
    medianMs: 142,
    inputTokens: 900,
    failures: [],
  });
});

test("a pilot that cannot start or step is a broken run in the engine's words", async () => {
  const cases = [
    { started: { error: "Pilots/turret.py (line 3): SyntaxError: invalid syntax" }, steps: [], note: /line 3/ },
    { started: { refused: EnginePlayRefusal.NotPlaying, message: "No play is running." }, steps: [], note: /No play/ },
    { started: undefined, steps: [{ error: "no pawn" }], note: /no pawn/ },
  ];
  for (const { started, steps, note } of cases) {
    const { call } = play(steps, started ?? { piloting: true });
    const piloted = await runPilot(deps(call, null), { file: "Pilots/turret.py", seconds: 30 });
    assert.equal(piloted.outcome, PilotOutcome.Broken);
    assert.match(piloted.note, note);
  }
});

test("a run past its wall-clock cap is stopped, and its report is what it did until then", async () => {
  const { call, calls } = play([{ phase: PilotPhase.Piloting, ask: null }]);
  let clock = 0;
  const now = () => {
    clock += 10_000;
    return clock;
  };
  const piloted = await runPilot(deps(call, null, now), { file: "Pilots/turret.py", seconds: 5 });
  assert.equal(piloted.outcome, PilotOutcome.Stopped);
  assert.deepEqual(calls.at(-1)?.args, { stop: true });
});

test("a run's findings and its record in the game folder reach the agent with its report", async () => {
  const findings = [
    { code: "sliding", detail: "BP_Bot_3 slides", gameSeconds: 12, count: 1, frame: "finding-sliding-1" },
    { detail: "no kind" },
  ];
  const record = "playtests/runs/2026-11-01-180000-1793554918-Plant/record.md";
  const { call } = play([{ phase: PilotPhase.Over, report: { ...REPORT, findings, record } }]);
  const piloted = await runPilot(deps(call, null), { file: "pilots/plant.py", seconds: 30 });
  assert.deepEqual(piloted.findings, [{ code: "sliding", detail: "BP_Bot_3 slides", gameSeconds: 12 }]);
  assert.equal(piloted.record, record);
  const bare = await runPilot(deps(play([{ phase: PilotPhase.Over, report: REPORT }]).call, null), {
    file: "pilots/plant.py",
    seconds: 30,
  });
  assert.deepEqual([bare.findings, bare.record], [[], null], "an older helper's report has neither");
});
