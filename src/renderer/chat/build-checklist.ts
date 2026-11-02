/**
 * The running build's steps as the Building card lists them (`BuildChecklist.tsx`): each save point
 * its lead made, by its label, in the order saved, then each part a worker built — a restart
 * (`replaces`) stays on its part's row, as the run's summary groups it — added, working or ended
 * without it. The lead itself is no row: what it does now is the card's line. Its counts make that
 * line once there is a step. Pure: read from the run's summary and its save points.
 */
import { CustomEvent, customPayload, type FacetIterationPayload, LEAD_PART } from "../../shared/custom-events.ts";
import { MINUTE_MS } from "../../shared/duration.ts";
import type { EventEnvelope } from "../../shared/event-log.ts";
import type { RunSummary, RunTask } from "../../shared/run-summary.ts";
import { WorkerState } from "../run-graph.ts";
import { BUILD_CHECKLIST_WORDS as WORDS } from "../words.ts";

/** A row's mark: a tick once added, a dashed ring while it works, an empty ring otherwise. */
export const PartMark = { Added: "added", Working: "working", Next: "next" } as const;
export type PartMark = (typeof PartMark)[keyof typeof PartMark];

/** One row of the checklist. */
export interface ChecklistRow {
  id: string;
  title: string;
  mark: PartMark;
  /** Where it stands, in the words on the row's right. */
  status: string;
}

/** The checklist: its rows, how many of them are done and how many work now. */
export interface BuildChecklist {
  rows: ChecklistRow[];
  done: number;
  working: number;
}

/** A save point the lead made: the record that keeps it, and its label. */
export interface SavePoint {
  id: string;
  label: string;
}

/** The label of a save point this run's lead made, or "" for any other round: an autosave Genex took is none. */
function leadSaveLabel(round: FacetIterationPayload | null, runId: string): string {
  if (round?.runId !== runId || round.facetId !== LEAD_PART) return "";
  return round.auto ? "" : (round.label ?? "");
}

/** The save points the lead of this run made, in the order it made them. */
export function runSavePoints(events: readonly EventEnvelope[], runId: string | null): SavePoint[] {
  if (!runId) return [];
  return events.flatMap((event) => {
    const label = leadSaveLabel(customPayload(event.data, CustomEvent.FacetIteration), runId);
    return label ? [{ id: `${LEAD_PART}:${event.id}`, label }] : [];
  });
}

/** Whether a part's worker is building now. */
const isWorking = (task: RunTask): boolean => task.state === WorkerState.Running;

/** What a working part says: its time left when its round named a deadline, else its round. */
function workingStatus(task: RunTask, now: number): string {
  const left = typeof task.deadlineMs === "number" ? Math.round((task.deadlineMs - now) / MINUTE_MS) : 0;
  if (left >= 1) return WORDS.workingFor(left);
  return typeof task.round === "number" ? WORDS.workingRound(task.round) : WORDS.working;
}

/** A part's row: its work in the build, under way, or ended without it. */
function partRow(task: RunTask, now: number): ChecklistRow {
  const row = { id: task.id, title: task.title };
  if (isWorking(task)) return { ...row, mark: PartMark.Working, status: workingStatus(task, now) };
  if (task.integrations > 0 || task.added === true) return { ...row, mark: PartMark.Added, status: WORDS.added };
  return { ...row, mark: PartMark.Next, status: WORDS.notAdded };
}

/** A save point's row: done, under the lead's label. */
const saveRow = (point: SavePoint): ChecklistRow => ({
  id: point.id,
  title: point.label,
  mark: PartMark.Added,
  status: WORDS.added,
});

/** What a running build's checklist is read from: its summary and its lead's save points. */
export interface BuildParts {
  summary: RunSummary | null;
  saves: readonly SavePoint[];
}

/** The checklist of a running build at `now`, or null before it has a save point or a worker. */
export function buildChecklist({ summary, saves, now }: BuildParts & { now: number }): BuildChecklist | null {
  const parts = (summary?.tasks ?? []).filter((task) => task.id !== LEAD_PART);
  const rows = [...saves.map(saveRow), ...parts.map((task) => partRow(task, now))];
  if (!rows.length) return null;
  const done = rows.filter((row) => row.mark === PartMark.Added).length;
  const working = rows.filter((row) => row.mark === PartMark.Working).length;
  return { rows, done, working };
}

/** The card's one line, counted from its checklist: how many steps are done, and how many work. */
export function checklistCaption(list: BuildChecklist, finishing: boolean): string {
  return finishing ? WORDS.finishing(list.working) : WORDS.caption(list.done, list.working);
}
