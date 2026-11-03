/**
 * The loop's self-test: the pure logic of the Loop against fixed inputs — when its lead is woken,
 * what the end of a turn means, the health check's line, which runner a run goes to, the plain
 * sentence a card falls back on, what a landing claims and a reviewer's no. No engine, no preview, no
 * network: seconds, deterministic.
 */
import { afterTurn, nextWake, TurnEnd } from "./director/wake-schedule.ts";
import { landingWords, plainly } from "./director/rules.ts";
import { secondOpinionNo } from "./director/second-opinion-prompts.ts";
import { healthLine } from "./health-check.ts";
import { chooseRunner } from "./run-dispatch.ts";
import { RunnerKind } from "./studio-state.ts";
import type { Run } from "../types/harness.d.ts";

function check(name: string, condition: unknown): void {
  if (!condition) throw new Error(`selftest failed: ${name}`);
}

/** One self-test step: its name, and the checks it runs over fixed inputs (it throws on the first failure). */
type SelftestStep = readonly [name: string, run: () => void];

/** A view of a resting lead with nothing going on, at `now`. */
const quietView = (now: number) => ({ now, untold: [], asleepSince: now, personWaiting: false });

/** The self-test, step by step, in the order it runs. */
const SELFTEST_STEPS: readonly SelftestStep[] = [
  [
    "wake: the user wakes the lead at once; nothing wakes a quiet run",
    () => {
      const now = 1_000_000;
      check("user wakes now", nextWake({ ...quietView(now), personWaiting: true }) === now);
      check("a quiet run is never woken", nextWake(quietView(now)) === null);
    },
  ],
  [
    "turn end: the lead rests, never wrapped up for being quiet; the person's Finish wraps up",
    () => {
      const base = { ok: true, closed: false, finishRequested: false };
      check("a turn end rests", afterTurn(base).next === TurnEnd.Sleep);
      check("the person's Finish wraps up", afterTurn({ ...base, finishRequested: true }).next === TurnEnd.WrapUp);
    },
  ],
  [
    "health: a check's line says it passed, or what is wrong",
    () => {
      check(
        "healthy",
        healthLine({ ok: true, problems: [], picture: null, unchecked: null }).startsWith("Health check:"),
      );
      const failed = healthLine({ ok: false, problems: ["1 uncaught error: x"], picture: null, unchecked: null });
      check("failed names it", failed.includes("1 uncaught error: x"));
    },
  ],
  [
    "runner: a session engine leads; one without a session is refused",
    () => {
      const run = { runId: "r", goal: "g", project: "p", engine: "claude" } as unknown as Run;
      const seated = [{ id: "claude", kind: "delegated" }] as never[];
      const plain = [{ id: "claude", kind: "direct", supportsSessions: false }] as never[];
      check("session leads", chooseRunner(run, seated) === RunnerKind.Director);
      check("no session refused", chooseRunner(run, plain) === RunnerKind.NeedsSession);
    },
  ],
  [
    "cards: shas and paths are taken out of the plain sentence",
    () => {
      const plain = plainly("merged w1 at 0123456789abcdef into /Users/me/game");
      check("no sha or path", !plain.includes("0123456789") && !plain.includes("/Users"));
    },
  ],
  [
    "landing: a build is said to load only when it passed its health check",
    () => {
      check("passed says so", landingWords({ healthPassed: true }).line.includes("it loads"));
      check("unchecked says so", !landingWords({ healthPassed: false }).line.includes("it loads"));
      check("never a verdict", !landingWords({ healthPassed: true }).verified);
    },
  ],
  [
    "second opinion: a reviewer's no decides nothing, and the lead hears what it named",
    () => {
      const no = secondOpinionNo(["the timer never shows"], ["the third lap"]);
      check("decides nothing", no.includes("decides nothing"));
      check("names its reasons", no.includes("the timer never shows") && no.includes("the third lap"));
    },
  ],
];

export async function runSelftest() {
  const started = Date.now();
  const passed: string[] = [];
  for (const [name, run] of SELFTEST_STEPS) {
    run();
    passed.push(name);
  }
  return { ok: true, passed, durationMs: Date.now() - started };
}
