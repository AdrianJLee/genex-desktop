/**
 * A pilot's run on an engine's editor play (`shared/engine-play.ts`): the studio starts the pilot
 * (`play-pilot`), then steps it (`play-pilot-step`) until it is over. The pilot plays in the engine
 * every frame by itself; the studio only carries its decisions. With a fast decision model set up
 * (Settings → Model Providers → TypeSafe), each ask the pilot puts out goes to it and its answer back
 * on the next step; without one the pilot is started to choose by its own order and nobody is asked.
 *
 * Between steps the studio waits STEP_POLL_MS, and not at all after an answer, so a decision reaches
 * the play about as soon as the model gives it. A run that outlives its wall-clock cap (4x its game
 * seconds plus WALL_GRACE_MS, for an editor whose clock stalls) or whose session is cancelled is
 * stopped, and its report is what it did until then.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import {
  decisionsByOrder,
  type EnginePlayPiloted,
  EnginePlayOptionalTool,
  isEnginePlayRefused,
  type PilotDecisions,
  PilotOutcome,
  PilotPhase,
  pilotedOf,
  pilotStepOf,
} from "../../shared/engine-play.ts";
import type { FastDecider } from "../../shared/fast-decisions.ts";
import type { EnginePlayCall } from "./editor-play-target.ts";

/** How long the studio waits between two steps of a pilot with no answer to hand it. */
const STEP_POLL_MS = 60;
/** A pilot's wall clock: its game seconds this many times over, plus the grace. */
const WALL_FACTOR = 4;
const WALL_GRACE_MS = 30 * SECOND_MS;

/** What a pilot's run needs: the play's tools, the decider if one is set up, a clock and a sleep. */
export interface PilotRunDeps {
  call: EnginePlayCall;
  decider: FastDecider | null;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  signal?: AbortSignal;
}

/** A count field of a report, else zero. */
function count(report: unknown, name: string): number {
  if (typeof report !== "object" || report === null) return 0;
  const value: unknown = Reflect.get(report, name);
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
}

function median(values: readonly number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2
    ? (sorted[middle] ?? null)
    : Math.round(((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2);
}

/** Who decided the run: the pilot's counts beside what the decider measured. */
function decisionsOf(report: unknown, decider: FastDecider | null, latencies: readonly number[]): PilotDecisions {
  if (!decider) return decisionsByOrder(count(report, "byOrder"));
  const tally = decider.tally();
  return {
    asked: count(report, "asked"),
    answered: count(report, "answered"),
    byOrder: count(report, "byOrder"),
    model: decider.model,
    medianMs: median(latencies),
    inputTokens: tally.inputTokens,
    failures: tally.failures,
  };
}

/** The error a play tool answered with, or its refusal's words, when it answered either. */
function errorOf(answer: unknown): string | null {
  if (isEnginePlayRefused(answer)) return answer.message;
  if (typeof answer !== "object" || answer === null) return null;
  const error: unknown = Reflect.get(answer, "error");
  return typeof error === "string" ? error : null;
}

/** A run that never played: broken, with why. */
function brokenRun(note: string, decider: FastDecider | null): EnginePlayPiloted {
  return pilotedOf({ outcome: PilotOutcome.Broken, note }, decisionsOf(null, decider, []));
}

/** Runs the pilot in `file` (relative to the engine's project) for `seconds` of game time; how it ended. */
export async function runPilot(
  deps: PilotRunDeps,
  spec: { file: string; seconds: number },
): Promise<EnginePlayPiloted> {
  const { call, decider } = deps;
  const started = await call(EnginePlayOptionalTool.Pilot, {
    file: spec.file,
    seconds: spec.seconds,
    decide: decider !== null,
  });
  const failed = errorOf(started);
  if (failed !== null) return brokenRun(failed, decider);
  const run: RunState = {
    deadline: deps.now() + spec.seconds * WALL_FACTOR * SECOND_MS + WALL_GRACE_MS,
    latencies: [],
    answer: "",
    handed: -1,
  };
  for (;;) {
    const ended = await stepOnce(deps, run);
    if (ended) return ended;
  }
}

/** Where a run's loop stands: its wall deadline, the answer times, the answer to hand on, the last ask handed out. */
interface RunState {
  deadline: number;
  latencies: number[];
  answer: string;
  handed: number;
}

/** One step: hand the pilot its answer and read how it stands; its report once it is over, else null. */
async function stepOnce(deps: PilotRunDeps, run: RunState): Promise<EnginePlayPiloted | null> {
  const { call, decider } = deps;
  const raw = await call(EnginePlayOptionalTool.PilotStep, run.answer ? { answer: run.answer } : {});
  run.answer = "";
  const stepError = errorOf(raw);
  if (stepError !== null) return brokenRun(stepError, decider);
  const step = pilotStepOf(raw);
  if (step.phase === PilotPhase.Over) return pilotedOf(step.report, decisionsOf(step.report, decider, run.latencies));
  if (deps.now() >= run.deadline || deps.signal?.aborted) {
    const last = pilotStepOf(await call(EnginePlayOptionalTool.PilotStep, { stop: true }));
    return pilotedOf(last.report, decisionsOf(last.report, decider, run.latencies));
  }
  if (decider && step.ask && step.ask.id !== run.handed) {
    run.handed = step.ask.id;
    const given = await decider.choose(step.ask, deps.signal);
    if (given) {
      run.latencies.push(given.ms);
      run.answer = JSON.stringify(given);
      return null;
    }
  }
  await deps.sleep(STEP_POLL_MS);
  return null;
}
