/** Runs: stopping, wrapping up and resuming a run, and what the Builds tab reads about one. */
import { lastLoopRunForProject } from "../../shared/run-review.ts";
import { graphEventsSince } from "../../shared/run-summary-feed.ts";
import { RunSummaryCache } from "../run-summary-cache.ts";
import type { KeepAwake } from "../keep-awake.ts";
import type { RunSummaryReader } from "../run-summary-reader.ts";
import type { StudioCore } from "../studio-core.ts";
import type { IpcHandle } from "./registrar.ts";
import { EventKind } from "../../shared/event-log.ts";
import { SECOND_MS } from "../../shared/duration.ts";

/** Why a run request from the renderer is refused. */
const MESSAGE = {
  projectAndRunRequired: "Project and run are required",
} as const;

/** How long `run.stop` waits for the harness to take the request. */
const RUN_STOP_TIMEOUT_MS = 30 * SECOND_MS;

export interface RunsIpcDeps {
  core: Pick<
    StudioCore,
    | "runFeedback"
    | "mainThread"
    | "layout"
    | "runPreviewIdentity"
    | "activityItems"
    | "requestRunFinish"
    | "resumeAutopilot"
    | "stopRun"
  >;
  runSummaryReader: Pick<RunSummaryReader, "forProject">;
  keepAwake: Pick<KeepAwake, "armFallback">;
}

export function registerRunsIpc(handle: IpcHandle, { core, runSummaryReader, keepAwake }: RunsIpcDeps): void {
  const summaries = new RunSummaryCache();
  handle("studio:run.feedback", async (payload) => core.runFeedback(payload));
  handle("studio:run.summary", async (payload) => {
    const malformed = !payload || typeof payload.project !== "string" || typeof payload.runId !== "string";
    if (malformed) throw new Error(MESSAGE.projectAndRunRequired);
    const events = await runSummaryReader.forProject(payload.project, core.mainThread);
    const summary = await summaries.read(events, payload.project, payload.runId, core.layout.runs);
    // Only what follows the events the renderer already holds (shared/run-summary-feed.ts); the
    // memoized summary itself is shared, so the reply is a copy.
    const { from, events: since } = graphEventsSince(summary.graphEvents ?? [], payload.graphFrom);
    return { ...summary, graphEvents: since, graphEventsFrom: from, preview: core.runPreviewIdentity() };
  });
  handle("studio:activity", async () => core.activityItems());
  handle("studio:run.review", async (payload) => {
    const events = await runSummaryReader.forProject(payload.project, core.mainThread);
    return lastLoopRunForProject(
      payload.runId
        ? events.filter(
            (event) =>
              event.data.type === EventKind.Custom &&
              (event.data.payload as { runId?: string })?.runId === payload.runId,
          )
        : events,
      payload.project,
    );
  });
  handle("studio:run.stop", async (payload) => {
    // Asking a run to stop is not the run ending: the harness still settles its workers,
    // runs a close health pass, lands what it can and writes the report — minutes of work that
    // used to happen on a Mac already free to sleep. `run.settled` releases the blocker; this
    // timer is only for the harness child that died and will never send it — which is exactly
    // the child whose dispatch throws or never answers, so it is armed in the finally and the
    // wait is bounded. Arming is safe either way: it no-ops with no blocker held, and the next
    // run's `run.keepawake` disarms it.
    try {
      // Through the core: the user's stop also means the run never resumes on its own afterwards.
      await core.stopRun(payload.runId, RUN_STOP_TIMEOUT_MS);
    } finally {
      keepAwake.armFallback();
    }
    return true;
  });

  // Current attempts finish, then the run integrates, checks and shows — no reset, no abort.
  handle("studio:run.finish", async (payload) => {
    // A request can arrive after the run has already ended:
    // StudioCore refuses it for a build that is already over, so a later Resume cannot inherit
    // a wrap-up meant for a session that is gone.
    await core.requestRunFinish(payload.threadId, payload.runId);
    return true;
  });

  handle("studio:autopilot.resume", async (payload) => {
    // The harness re-notifies run.keepawake as the resumed run starts, so no acquire here.
    await core.resumeAutopilot(payload.runId);
    return true;
  });
}
