/**
 * The chat's run, as the host and the chat's own session share it: the run's controls that session
 * keeps after a closed Loop run (`RunControl`, answered by `main/core/conversation.ts` `runControl`),
 * the builds it records to start, the run a conversation is on, the state `run_status` reads back,
 * and the slice of the conversation a queued message may see.
 *
 * The harness keeps its own copy of the run readings in `src/harness-seed/loop/run-inbox.ts` — the
 * app must not load the agent's editable code — and `tests/conformance/seed-contracts.test.ts` holds
 * the two to the same readings of the same logs.
 */
import { CustomEvent, customRecord, type CustomEventData } from "./custom-events.ts";
import type { StudioToolSpec } from "./engine-requests.ts";
import { EventKind, type EventData } from "./event-log.ts";
import { messageQueueState, type QueueView } from "./message-queue.ts";
import { RUN_START_EVENTS } from "./run-state.ts";

/** What a `run_control` record asks of a run. Persisted: never rename a value (the harness's copy is in `loop/run-inbox.ts`). */
export const RunControlAction = {
  /** Wrap up: let the current attempts finish, then integrate and show what is ready. */
  Finish: "finish",
} as const;
export type RunControlAction = (typeof RunControlAction)[keyof typeof RunControlAction];

/**
 * The tool name a game chat's delegation is logged under (`tool_requested` … `tool_result`), from
 * the brief it hands a contractor to the build's result. The harness writes it (its copy is
 * `loop/delegated-turn.ts` `DELEGATE_TOOL`): never rename it.
 */
export const DELEGATE_TOOL = "delegate_to_contractor";

/**
 * The run's controls the chat's own session keeps after a closed Loop run (`runControls`), answered
 * live by the host. The model calls them by these names, and the log records them so: never rename
 * one. Its `resume_run` is not one: the harness bridges it in and does it once the reply ends, since
 * the resumed run's lead may be that same session.
 */
export const RunControl = {
  RunStatus: "run_status",
  ShowBuild: "show_build",
  LandBuild: "land_build",
} as const;
export type RunControl = (typeof RunControl)[keyof typeof RunControl];

/** The run's controls as the chat's own session is handed them, in menu order. */
export const runControlTools: readonly StudioToolSpec[] = [
  {
    name: RunControl.RunStatus,
    description: "Read the current run and its workers' progress. This does not start or stop work.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: RunControl.ShowBuild,
    description:
      "Open a build in Live, the game view on the right of this chat, without changing the game folder: integration (what the run built, landed or not), live (the game folder as it is), or a commit hash. Use only when the user asks to see, run, play or launch what a run made, including after the run has finished or paused; never to show your own edits, which the stage's Reload button offers by itself. Afterwards say what it answered: open in Live, or waiting behind Reload while the user watches Live.",
    parameters: {
      type: "object",
      properties: { build: { type: "string", description: "live, integration (default), or a commit hash." } },
    },
  },
  {
    name: RunControl.LandBuild,
    description:
      "Put a build in the game folder: merge what the run built (integration, the default) or a named commit into the folder the user plays from; Live shows it at once or through its Reload button, as the answer says. Only for a run that has finished or paused. Refuses when the game folder has uncommitted edits.",
    parameters: {
      type: "object",
      properties: { build: { type: "string", description: "integration (default) or a commit hash." } },
    },
  },
];

const RUN_CONTROLS: ReadonlySet<string> = new Set<string>(Object.values(RunControl));

/** Is this one of the run's controls the chat's own session keeps? */
export function isRunControl(name: string): name is RunControl {
  return RUN_CONTROLS.has(name);
}

/** The controls a Loop that worked in the game folder itself keeps: its status alone, no build to show or land. */
const IN_PLACE_CONTROLS: ReadonlySet<string> = new Set<string>([RunControl.RunStatus]);

/** The run's controls a grant hands the chat's own session: all of them, or the status alone after an in-place Loop. */
export function runControlsFor(grant: { inPlace?: boolean }): readonly StudioToolSpec[] {
  return grant.inPlace === true ? runControlTools.filter((tool) => IN_PLACE_CONTROLS.has(tool.name)) : runControlTools;
}

/** Is this one of the controls a grant hands (`runControlsFor`)? */
export function isGrantedRunControl(name: string, grant: { inPlace?: boolean }): name is RunControl {
  return isRunControl(name) && (grant.inPlace !== true || IN_PLACE_CONTROLS.has(name));
}

/**
 * The builds a chat's own session records to start, which the harness starts once its reply ends:
 * a Loop's launch (the seed's `tools/game-tools.ts`), a finished build reopened
 * (`loop/reopen-run-prompts.ts` `REOPEN_RUN`) and a paused one resumed (`resume_run`). While the
 * chat is in Plan the host holds them behind the plan card (`main/core/plan-approval.ts`). The model
 * calls them by these names: never rename one (`seed-contracts.test.ts` holds them to the seed's).
 */
export const BuildLaunch = {
  StartAutopilot: "start_autopilot",
  StartUnattendedRun: "start_unattended_run",
  ReopenRun: "reopen_run",
  ResumeRun: "resume_run",
} as const;
export type BuildLaunch = (typeof BuildLaunch)[keyof typeof BuildLaunch];

const BUILD_LAUNCHES: ReadonlySet<string> = new Set<string>(Object.values(BuildLaunch));

/** Is this recorded call a build the chat's session asked to start? */
export function isBuildLaunch(name: string): name is BuildLaunch {
  return BUILD_LAUNCHES.has(name);
}

/** The run tools the host itself answers and records (`conversation.ts` `runControl`): the run's controls and the resume. */
export type HostRunTool = RunControl | typeof BuildLaunch.ResumeRun;

/** Is this a run tool the host answers and records? */
export function isHostRunTool(name: string): name is HostRunTool {
  return isRunControl(name) || name === BuildLaunch.ResumeRun;
}

/** The chat's reading of a run: its start payload merged with later closes, and a state. */
export type ChatRunState = "running" | "paused" | "finished";
export type ChatRun = Record<string, unknown> & {
  runId?: string;
  project?: string;
  goal?: string;
  state: ChatRunState;
};

type LogRecord = { readonly id: string; readonly data: CustomEventData };

/**
 * The run a conversation is on — the one started last, or the named one — with the fields its
 * start and its close carried. A close is `finished` whatever it says; a pause and a resume move
 * it between `paused` and `running`. This is the chat's view, not the Builds graph's
 * (`run-state.ts` `runExecution` reads a paused close as paused); the two answer different
 * questions and are kept apart on purpose.
 */
export function latestRun(events: readonly LogRecord[], targetRunId: string | null = null): ChatRun | null {
  let run: ChatRun | null = null;
  for (const event of events) {
    const custom = customRecord(event.data);
    if (!custom) continue;
    if (targetRunId && custom.payload.runId !== targetRunId) continue;
    run = chatRunStep(run, custom.event_type, custom.payload);
  }
  return run;
}

/** One record applied to the chat's run: a start, a close, a pause or a resume. */
function chatRunStep(run: ChatRun | null, event_type: string, p: Record<string, unknown>): ChatRun | null {
  const started: ChatRun | null = RUN_START_EVENTS.has(event_type)
    ? { ...(run && run.runId === p.runId ? run : {}), ...p, state: "running" }
    : run;
  if (p.runId !== started?.runId) return started;
  // A close or a pause with no run id and no run before it still reads as a run (as it always has).
  if (event_type === CustomEvent.RunFinished) return { ...started, ...p, state: "finished" };
  if (event_type === CustomEvent.AutopilotPaused) return { ...started, state: "paused" };
  if (event_type === CustomEvent.AutopilotResumed) return { ...started, state: "running" };
  return started;
}

/**
 * Has the run's current session been asked to wrap up? Only a `finish` after the run's latest
 * `run_registered` counts: a resume registers the run again, and a resumed run that inherited
 * an earlier session's ask would skip every builder. The harness's inbox reads it the same way.
 */
export function finishRequested(events: readonly LogRecord[], runId: string): boolean {
  let finishing = false;
  for (const event of events) {
    const custom = customRecord(event.data);
    if (custom?.payload.runId !== runId) continue;
    if (custom.event_type === CustomEvent.RunRegistered) finishing = false;
    if (custom.event_type === CustomEvent.RunControl && custom.payload.action === RunControlAction.Finish)
      finishing = true;
  }
  return finishing;
}

const PROGRESS = /facet_|autopilot_|integration_|director_|optimization_updated|run_control|run_steering/;
/**
 * Events that look like progress and are not: a wake of the lead is the lead being told, not the
 * run moving, and with up to thirty an hour they pushed the workers' own events off the list; so
 * did a steer's hand-over, two for every chat message a run's lead takes (live chat).
 */
const NOT_PROGRESS: ReadonlySet<string> = new Set([CustomEvent.DirectorContinued, CustomEvent.RunSteeringDelivered]);

/** Does a snapshot show this event as the run's progress? */
const isProgress = (eventType: string): boolean => PROGRESS.test(eventType) && !NOT_PROGRESS.has(eventType);

export interface RunSnapshot {
  run: ChatRun | { runId: string | undefined; state: "superseded" } | null;
  availableRuns: Array<{ runId: unknown; project: unknown; goal: unknown; state: ChatRunState | undefined }>;
  progress: Array<Record<string, unknown> & { type: string }>;
}

/** What `run_status` answers: the run (or that it was superseded), every run here, recent progress. */
export function runSnapshot(events: readonly LogRecord[], runId: string | undefined): RunSnapshot {
  const current = latestRun(events);
  const recent = events.flatMap((event) => {
    const custom = customRecord(event.data);
    return custom && custom.payload.runId === runId ? [custom] : [];
  });
  const started = events.flatMap((event) => {
    const custom = customRecord(event.data);
    return custom && RUN_START_EVENTS.has(custom.event_type) && custom.payload.runId ? [custom.payload.runId] : [];
  });
  return {
    run: current?.runId === runId ? current : { runId, state: "superseded" },
    availableRuns: [...new Set(started)].map((id) => {
      const run = latestRun(events, id as string);
      return { runId: id, project: run?.project, goal: run?.goal, state: run?.state };
    }),
    progress: recent
      .filter((custom) => isProgress(custom.event_type))
      .slice(-24)
      .map((custom) => ({ type: custom.event_type, ...custom.payload })),
  };
}

/**
 * The conversation as a queued message may see it: messages removed from the queue are left out,
 * and so is everything queued after `messageId` (future input must not leak into an earlier
 * turn's prompt). A message edited in the queue reads with its edited text.
 */
export function conversationThrough<T extends { readonly id: string; readonly data: EventData }>(
  events: readonly T[],
  messageId?: string | null,
  queue?: QueueView,
): T[] {
  const { messages } = queue ?? messageQueueState(events);
  const byEvent = new Map([...messages.values()].filter((m) => m.eventId).map((m) => [m.eventId, m]));
  let reached = false;
  const omit = new Set<string | null>();
  for (const message of messages.values()) {
    if (message.state === "removed" || reached) omit.add(message.eventId);
    if (messageId && message.messageId === messageId) reached = true;
  }
  return events
    .filter((e) => !omit.has(e.id))
    .map((e) => {
      const message = byEvent.get(e.id);
      const text = message?.action?.text;
      if (!text || e.data.type !== EventKind.Messages) return e;
      return {
        ...e,
        data: { ...e.data, messages: e.data.messages.map((m) => (m.role === "user" ? { ...m, content: text } : m)) },
      };
    });
}
