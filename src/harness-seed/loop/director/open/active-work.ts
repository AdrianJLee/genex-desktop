/**
 * What a Loop's lead has at work while it rests: its pool's running workers and the run's running
 * jobs, and for an open Loop a recovery of the project's app under way. A lead with nothing at work
 * and nothing to be woken for is done: its Loop closes, as a bare agent's turn ends (wake.ts). The
 * run's jobs are read from the host at most every `JOB_POLL_MS`; a read the host could not answer
 * says nothing, so only one that says no job runs lets the Loop close.
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
  return loopRun.runningWorkers().length + pooled + (loopRun.jobsRunning ?? 0) + recovering;
}

/** What the lead has at work now, the run's jobs read again when the last read is `JOB_POLL_MS` old or forgotten. */
export async function activeWork(loopRun: LoopRun, now: number): Promise<number> {
  const readAt = loopRun.jobsReadAt ?? null;
  if (readAt === null || now - readAt >= JOB_POLL_MS) {
    loopRun.jobsReadAt = now;
    const jobs = await jobsNow(loopRun.ctx, loopRun.run.project, loopRun.run.runId);
    loopRun.jobsRunning = jobs === null ? null : runningJobs(jobs);
  }
  return workAtHand(loopRun);
}

/** How many of the jobs run now. */
const runningJobs = (jobs: readonly JobView[]): number => jobs.filter((job) => job?.state === JobState.Running).length;

/**
 * Whether the lead has anything at work (the module's header): a worker until its run has settled
 * (the line of its end, which wakes the lead, is that run's last step), and the run's jobs as their
 * last read found them, a read that could not say among them.
 */
export function hasWorkAtHand(loopRun: LoopRun): boolean {
  const pool = loopRun.pool ?? loopRun.open?.pool ?? null;
  return Boolean(pool?.state.runs.size) || loopRun.jobsRunning !== 0 || workAtHand(loopRun) > 0;
}
