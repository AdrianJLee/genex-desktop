/** What the chat's agent is told when a background job it started ended (`job-wake.ts`). Model-facing text. */
import { JobTool } from "../../shared/jobs.ts";

/** What the agent does once it knows how the job went. */
const CARRY_ON =
  "Tell the person in one short line how it went (the build is ready, or what failed), then go on with what you told them you would do once it finished.";

/** The words that wake the chat when its jobs ended: a plugin tool's, or its own `job_start` commands. */
export const JOB_WAKE_PROMPT = {
  /** A plugin tool's background job ended: its status tool says how. */
  plugin: (start: string, status: string) =>
    `The job ${start} started in the background has ended: read ${status} for how it went. ${CARRY_ON}`,
  /** The chat's own jobs ended: Genex's line naming each (`jobNotice`), the output in `job_tail`. */
  jobs: (notice: string) => `${notice} Its output is in ${JobTool.Tail}. ${CARRY_ON}`,
} as const;
