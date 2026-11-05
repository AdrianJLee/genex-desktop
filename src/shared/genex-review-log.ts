/**
 * A game chat's review records read back from its log: the newest Fix with agent press
 * (`genex_review_fix`) and what became of it (`genex_review` with `sent` after a fix, `not_built`,
 * `fix_stopped` or `fixed_web`), and whether the agent's work on it has ended. Main reads it once a
 * run ends to publish by itself; the chat's review card reads it for "Fixing", "Your agent stopped"
 * and the rest. Typed fields only: never the words of a message.
 */
import { CustomEvent, customPayload } from "./custom-events.ts";
import { type EventEnvelope, EventKind } from "./event-log.ts";
import {
  GenexFixKind,
  GenexReviewChange,
  type GenexReviewFixPayload,
  type GenexReviewPayload,
} from "./genex-review.ts";
import { ExecutionStatus } from "./run-state.ts";

/** The changes that end a fix press: Studio sent the app again, or said why it did not. */
const FIX_OUTCOMES: ReadonlySet<string> = new Set([
  GenexReviewChange.Sent,
  GenexReviewChange.NotBuilt,
  GenexReviewChange.FixStopped,
  GenexReviewChange.FixedWeb,
]);

const FIX_KINDS: ReadonlySet<unknown> = new Set(Object.values(GenexFixKind));

/** The newest fix press of a game and what became of it. */
export interface GenexFixState {
  fixId: string;
  kind: GenexFixKind;
  count: number;
  /** Studio publishes (or asks a person) by itself once the agent is done; false once the person said not to. */
  autoPublish: boolean;
  at: string;
  /** Where the press's record sits in the log. */
  index: number;
  /** What ended it, once something did. */
  outcome?: GenexReviewChange;
}

/** A fix record as read: every field it must have, or null. */
function fixOf(payload: Partial<GenexReviewFixPayload> | null): Omit<GenexFixState, "index"> | null {
  if (!payload || typeof payload.fixId !== "string" || !FIX_KINDS.has(payload.kind)) return null;
  return {
    fixId: payload.fixId,
    kind: payload.kind as GenexFixKind,
    count: typeof payload.count === "number" ? payload.count : 0,
    autoPublish: payload.autoPublish === true,
    at: typeof payload.at === "string" ? payload.at : "",
  };
}

/** Whether a review record is about `project` (a record with none is the chat's own game). */
const about = (payload: { project?: unknown } | null, project: string | undefined): boolean =>
  project === undefined || payload?.project === undefined || payload.project === project;

/**
 * The newest fix press in `events` for `project`, with its auto step as the person last left it and
 * its outcome; null before any press.
 */
export function newestFix(events: readonly EventEnvelope[], project?: string): GenexFixState | null {
  const found: { fix: GenexFixState | null } = { fix: null };
  for (const [index, event] of events.entries()) {
    const pressed = customPayload(event.data, CustomEvent.GenexReviewFix);
    if (pressed && about(pressed, project)) {
      const read = fixOf(pressed);
      if (read) found.fix = pressedAgain(found.fix, read, index);
      continue;
    }
    const review = customPayload(event.data, CustomEvent.GenexReview);
    const fix = found.fix;
    if (fix && !fix.outcome && review && about(review, project) && isOutcome(review)) fix.outcome = review.change;
  }
  return found.fix;
}

/** A press read after `fix`: the same press again is "Don't publish it automatically", any other a new press. */
function pressedAgain(fix: GenexFixState | null, read: Omit<GenexFixState, "index">, index: number): GenexFixState {
  return fix && read.fixId === fix.fixId ? { ...fix, autoPublish: read.autoPublish } : { ...read, index };
}

/** Whether a review record ends a fix press. */
const isOutcome = (
  review: Partial<GenexReviewPayload>,
): review is Partial<GenexReviewPayload> & {
  change: GenexReviewChange;
} =>
  typeof review.change === "string" &&
  FIX_OUTCOMES.has(review.change) &&
  (review.change !== GenexReviewChange.Sent || review.recheck === true);

/** How the agent's work on a fix ended: done, or stopped before it finished. */
export const FixEnd = { Done: "done", Stopped: "stopped" } as const;
export type FixEnd = (typeof FixEnd)[keyof typeof FixEnd];

const STOPPED_RUN: ReadonlySet<unknown> = new Set([ExecutionStatus.Cancelled, ExecutionStatus.Failed]);

/**
 * How the agent's work on `fix` ended, once it has: every build it started after the press closed
 * (not paused), else, with no build, the first chat turn that started after the press ended. Null
 * while it still works.
 */
export function fixWorkEnded(events: readonly EventEnvelope[], fix: GenexFixState): FixEnd | null {
  const after = events.slice(fix.index + 1);
  const started = new Set<string>();
  let lastRun: string | undefined;
  const closed = new Set<string>();
  for (const event of after) {
    const start = customPayload(event.data, CustomEvent.RunStarted);
    if (typeof start?.runId === "string") started.add(start.runId);
    const close = customPayload(event.data, CustomEvent.RunFinished);
    const paused = close?.paused === true || close?.executionStatus === ExecutionStatus.Paused;
    if (typeof close?.runId === "string" && !paused) {
      closed.add(close.runId);
      lastRun = close.executionStatus;
    }
  }
  if (started.size > 0) {
    if (![...started].every((runId) => closed.has(runId))) return null;
    return STOPPED_RUN.has(lastRun) ? FixEnd.Stopped : FixEnd.Done;
  }
  return turnEnded(after);
}

/** How the first turn that started in `events` ended, or null while it runs. */
function turnEnded(events: readonly EventEnvelope[]): FixEnd | null {
  const turn = events.find((event) => event.data.type === EventKind.TurnStarted)?.turn_id;
  if (!turn) return null;
  const end = events.find((event) => event.data.type === EventKind.TurnEnded && event.turn_id === turn);
  if (!end || end.data.type !== EventKind.TurnEnded) return null;
  return end.data.status === undefined || end.data.status === "ok" ? FixEnd.Done : FixEnd.Stopped;
}
