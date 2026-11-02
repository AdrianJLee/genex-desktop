/**
 * The run's record in its run journal (`autopilot_<runId>`, the harness's own and durable): what a
 * run needs to go on after a restart, a crash or a pause — the integration's last health check, the log and how much of it the lead has heard, and the wake
 * loop's own state. Every save writes it (`recordLoopRun`, called by loop-run.ts `saveJournal`); a
 * resumed run reads it back (`restoreLoopRun`, called by setup.ts `prepareLoopRun`). Its functions
 * take the run explicitly; they are not bound onto it.
 */
import { tallyOf } from "../finish-check.ts";
import { DirectorLoop, WAKE_WINDOW_MS } from "./wake-schedule.ts";
import type { AnyRecord } from "../../types/harness.d.ts";
import type { LoopRun, LoopRunLogEntry } from "./loop-run.ts";
import type { WakeState } from "./wake.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;

/** How many of the run's log lines the journal keeps, the newest. */
export const JOURNAL_LOG_LINES = 60;

/** What the wake loop takes back from the journal on a Resume. */
export interface RestoredWake {
  wakesAt: number[];
  /** Lost sessions the run has already replaced: the allowance does not start again on a Resume. */
  freshSessions?: number;
}

/** A time for the journal: ISO, or null. */
const iso = (ms: number | null | undefined): string | null =>
  typeof ms === "number" && Number.isFinite(ms) ? new Date(ms).toISOString() : null;

/** A time from the journal — ISO or milliseconds — or null when it is not one. */
function msOf(value: unknown): number | null {
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  if (typeof value !== "string") return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** A count from the journal. */
const countOf = (value: unknown): number => (typeof value === "number" && Number.isFinite(value) ? value : 0);

/** The newest lines of the run's log, as the journal keeps them. */
function logRecord(log: readonly LoopRunLogEntry[]): LoopRunLogEntry[] {
  return log.slice(-JOURNAL_LOG_LINES).map(({ at, seq, text, kind }) => ({ at, seq, text, ...(kind ? { kind } : {}) }));
}

/**
 * Put the run's record on its journal (`journal.director`), as every save does: the integration's
 * last health check, the log and how much of it the lead has heard, and where its job ends and its
 * finish checks stand.
 */
export function recordLoopRun(loopRun: LoopRun): void {
  const director = loopRun.journal?.director;
  if (!director || !loopRun.state) return;
  const { state } = loopRun;
  Object.assign(director, {
    integrationHealthy: state.integrationHealthy,
    log: logRecord(state.log),
    logSeq: loopRun.logSeq,
    heardSeq: loopRun.waitSeq,
    judges: state.judges,
    jobsCursor: state.jobsCursor ?? 0,
    ...(state.finishTally ? { finishTally: state.finishTally } : {}),
  });
}

/** The journal as a save compares it with what the last save wrote; null when it cannot be read as JSON (it is then written). */
export function journalText(journal: AnyRecord): string | null {
  try {
    return JSON.stringify(journal);
  } catch {
    return null;
  }
}

/** The wake loop's own state, as the journal keeps it (wake.ts `journalWake` writes it). */
export function wakeRecord(
  wake: Pick<WakeState, "wrapCause" | "wakes" | "wakesAt" | "lastWakeAt" | "asleepSince"> & {
    freshSessions?: number;
  },
): AnyRecord {
  return {
    loop: DirectorLoop.Wake,
    freshSessions: wake.freshSessions ?? 0,
    wrapCause: wake.wrapCause,
    wakes: wake.wakes,
    wakesAt: wake.wakesAt.map(iso),
    lastWakeAt: iso(wake.lastWakeAt),
    asleepSince: iso(wake.asleepSince),
  };
}

/** Does this run pick up one its journal kept: a Resume of a Loop's run? */
export function resumedFromJournal(loopRun: Pick<LoopRun, "resume" | "priorJournal">): boolean {
  return loopRun.resume === true && Boolean(loopRun.priorJournal?.director);
}

/** The log's newest lines as the journal kept them, and how much of it the lead has heard. */
function restoreLog(loopRun: LoopRun, saved: AnyRecord): void {
  const log = (Array.isArray(saved.log) ? saved.log : []).filter(
    (entry: AnyRecord): entry is LoopRunLogEntry => typeof entry?.seq === "number" && typeof entry.text === "string",
  );
  loopRun.state.log = log;
  loopRun.logSeq = Math.max(countOf(saved.logSeq), log.at(-1)?.seq ?? 0);
  loopRun.waitSeq = Math.min(countOf(saved.heardSeq), loopRun.logSeq);
}

/**
 * A resumed run reads its journal back: the last health check, the log and how much of it the lead
 * had heard, its judges' count, its job cursor and its finish checks. The integration head comes back
 * through `startingCommits` (setup.ts). Called before the run writes a line of its own.
 */
export function restoreLoopRun(loopRun: LoopRun): void {
  if (!resumedFromJournal(loopRun)) return;
  const saved = loopRun.priorJournal?.director ?? {};
  const { state } = loopRun;
  if (typeof saved.integrationHealthy === "boolean") state.integrationHealthy = saved.integrationHealthy;
  restoreLog(loopRun, saved);
  state.judges = Number.isInteger(saved.judges) && saved.judges > 0 ? saved.judges : 0;
  state.jobsCursor = countOf(saved.jobsCursor);
  if (saved.finishTally !== undefined) state.finishTally = tallyOf(saved.finishTally);
}

/** The wake loop's own state as the journal kept it: the wakes still in the cap's window and the fresh sessions used. */
export function restoredWake(saved: unknown, now: number): RestoredWake {
  const record = (saved ?? {}) as AnyRecord;
  const wakesAt = (Array.isArray(record.wakesAt) ? record.wakesAt : [])
    .map(msOf)
    .filter((at: number | null): at is number => at !== null && at > now - WAKE_WINDOW_MS && at <= now);
  const freshSessions = Number.isInteger(record.freshSessions) && record.freshSessions > 0 ? record.freshSessions : 0;
  return { wakesAt, ...(freshSessions ? { freshSessions } : {}) };
}
