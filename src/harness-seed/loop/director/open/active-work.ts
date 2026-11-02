/**
 * What a Loop's lead has at work while it rests: its pool's running workers and the run's running
 * jobs, and for an open Loop a recovery of the project's app under way. A lead with nothing at work
 * and nothing to be woken for is done: its Loop closes, as a bare agent's turn ends (wake.ts). An
 * open Loop's jobs are read from the host at most every `JOB_POLL_MS`, or at once at a turn's edge.
 */
import type { HarnessCtx } from "../../../types/harness.d.ts";
import type { JobView } from "../../../types/host-api.d.ts";
import { HostMethod } from "../../host-methods.ts";
import { JobState } from "../../jobs/contract.ts";
import { JOB_POLL_MS } from "../../jobs/watch.ts";
import { LoopProfile } from "../../folder-facts.ts";
import { runningRecords } from "../../workers/records.ts";
import type { LoopRun } from "../loop-run.ts";

/** Whether the run leads an open Loop. */
export const leadsOpenLoop = (loopRun: Pick<LoopRun, "profile" | "open">): boolean =>
  loopRun.profile === LoopProfile.Open && Boolean(loopRun.open);

/** The run's jobs as the host lists them now; null when it could not say. */
async function jobsNow(ctx: HarnessCtx, project: string, runId: string): Promise<JobView[] | null> {
  try {
    const answer = await ctx.call(HostMethod.JobsList, { project, runId });
    return Array.isArray(answer?.jobs) ? answer.jobs : null;
  } catch {
    return null;
  }
}

/**
 * What the lead has at work now, from the last read of the run's jobs (`activeWork` refreshes it): a
 * recovery of the project's app under way counts too, so a lone lead rests while Genex brings the
 * app back, and the recovery's outcome wakes it, never the question of what next.
 */
export function workAtHand(loopRun: LoopRun): number {
  const open = loopRun.open;
  const pooled = open?.pool ? runningRecords(open.pool.state).length : 0;
  const recovering = open?.recovering ? 1 : 0;
  return loopRun.runningWorkers().length + pooled + (open?.jobsRunning ?? 0) + recovering;
}

/**
 * What the lead has at work now, the run's jobs read again when the last read is `JOB_POLL_MS` old,
 * or at once when `fresh` (a turn's edge, which must not miss a job that ran within it).
 */
export async function activeWork(loopRun: LoopRun, now: number, { fresh = false } = {}): Promise<number> {
  const open = loopRun.open;
  const stale = open && (fresh || open.jobsReadAt === null || now - open.jobsReadAt >= JOB_POLL_MS);
  if (open && stale) {
    open.jobsReadAt = now;
    const jobs = await jobsNow(loopRun.ctx, loopRun.run.project, loopRun.run.runId);
    if (jobs !== null) open.jobsRunning = runningJobs(jobs);
  }
  return workAtHand(loopRun);
}

/** How many of the jobs run now. */
const runningJobs = (jobs: readonly JobView[]): number => jobs.filter((job) => job?.state === JobState.Running).length;

/**
 * Whether the lead has anything at work (the module's header): a worker until its run has settled
 * (the line of its end, which wakes the lead, is that run's last step), and the run's jobs, an open
 * Loop's read again at once at a turn's edge (`edge`), which must not miss a job the turn just
 * started; a web Loop's every time.
 */
export async function hasWorkAtHand(loopRun: LoopRun, now: number, edge: boolean): Promise<boolean> {
  const pool = loopRun.pool ?? loopRun.open?.pool ?? null;
  if (pool?.state.runs.size || loopRun.runningWorkers().length) return true;
  if (leadsOpenLoop(loopRun)) return (await activeWork(loopRun, now, { fresh: edge })) > 0;
  const jobs = await jobsNow(loopRun.ctx, loopRun.run.project, loopRun.run.runId);
  return runningJobs(jobs ?? []) > 0;
}
