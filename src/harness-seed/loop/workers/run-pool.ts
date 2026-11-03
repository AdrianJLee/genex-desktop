/**
 * A run's own worker pool: the generic workers a run's lead starts beside the workers of its own
 * method (the director's builders). It opens at the run's start, keeps its records in the run's own
 * artifact and its copies' work on the run's refs, and closes with the run. Its workers belong to the
 * run: their delegations carry `worker {id, title, runId}`, so the host seats them in the mode of the
 * chat the run was started in.
 */
import { adoptPool, takeCarriedPool } from "./carry.ts";
import { openPool, type WorkerPool } from "./pool.ts";
import { runWorkersArtifact, type WorkerScope } from "./records.ts";

/** Each run's open pool, by run id (a promise while it opens, so two starts at once share one). */
const pools = new Map<string, Promise<WorkerPool>>();

/** What a run's pool is opened with: everything a pool's scope holds but its artifact, which is the run's. */
export type RunPoolSeat = Omit<WorkerScope, "artifactId" | "runId" | "turn"> & { runId: string };

/**
 * The run's pool, opened on first use. A Loop launched from a chat turn whose workers were still at
 * work takes that turn's pool over when it works in the same folder (carry.ts): its workers go on as
 * the run's. Any other carried pool closes, its workers stopped.
 */
export function runPool(seat: RunPoolSeat): Promise<WorkerPool> {
  const open = pools.get(seat.runId);
  if (open) return open;
  const scope = { ...seat, artifactId: runWorkersArtifact(seat.runId) };
  const carried = takeCarriedPool(seat.threadId);
  const sameFolder = carried?.pool.state.scope.gameDir === seat.gameDir;
  if (carried && !sameFolder) void carried.pool.close().catch(() => {});
  const opening = carried && sameFolder ? adoptPool(carried, scope) : openPool(scope);
  pools.set(seat.runId, opening);
  opening.catch(() => pools.delete(seat.runId));
  return opening;
}

/** The run ended: its pool closes (running workers stop, a copy's work is kept on the run's refs). */
export async function closeRunPool(runId: string): Promise<void> {
  const open = pools.get(runId);
  if (!open) return;
  pools.delete(runId);
  const pool = await open.catch(() => null);
  await pool?.close();
}
