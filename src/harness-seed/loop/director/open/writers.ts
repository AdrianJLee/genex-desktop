/**
 * The run's writers in place: its pool's workers with isolation lock, which write in the game folder
 * beside the lead (a worker in a copy or a reader writes nothing there). A claim waits for one, the
 * lead's rewind or restart waits for it to end, no autosave keeps its half-done files, and a way back
 * to a save point stops it first, saying so.
 */
import { WorkerIsolation, WorkerTool } from "../../workers/contract.ts";
import { runningRecords, type WorkerRecord } from "../../workers/records.ts";
import type { OpenLoop } from "./contract.ts";

/** The run's writers in place at work now: its pool's workers that write in the game folder under its lock. */
export function writersInPlace(open: OpenLoop): WorkerRecord[] {
  if (!open.pool) return [];
  return runningRecords(open.pool.state).filter((record) => record.isolation === WorkerIsolation.Lock);
}

/**
 * Stops the run's writers in place before Genex takes the folder back (`worker_stop`, the reason on
 * each one's end record): their edits would otherwise land on files the restore replaced. Answers
 * the ids of those it stopped.
 */
export async function stopWritersInPlace(open: OpenLoop, why: string): Promise<string[]> {
  const ids = writersInPlace(open).map((record) => record.id);
  for (const id of ids) await open.pool?.call(WorkerTool.Stop, { id, why }).catch(() => "");
  return ids;
}
