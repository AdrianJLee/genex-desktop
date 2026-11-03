/**
 * The turn loop — PLAN.md §5.1, ported from Exo's `model-runtime/turn-loop.ts`.
 *
 * Two properties are load-bearing and must survive every future self-edit:
 *
 *  1. **The prompt is materialised from the event log every round.** There is no hidden
 *     in-memory conversation: the log is the state (hard constraint #2), so a crash mid-turn
 *     costs nothing and a fork of the log is a fork of the mind.
 *  2. **The tool registry is rebuilt every round.** A tool the agent writes during this turn is
 *     callable on the next round, without a restart. That is what makes tool self-installation
 *     feel immediate rather than ceremonial.
 *
 * This module picks the turn's runner: the Studio's own chat (studio-chat.ts), a delegated
 * engine's contractor (delegated-turn.ts), or the tool loop of a direct engine (tool-loop.ts).
 */
import { EngineId, supportsSessions } from "./model-roles.ts";
import { runStudioTurn } from "./studio-chat.ts";
import { HostMethod } from "./host-methods.ts";
import { runDelegatedTurn } from "./delegated-turn.ts";
import { resolveContextWindow, runToolLoop } from "./tool-loop.ts";
import {
  buildContractorBrief,
  isContinueAsk,
  lastContractorSession,
  nameFromAsk,
  resolveChatProject,
} from "./chat-session.ts";
import type { AnyRecord, HarnessCtx } from "../types/harness.d.ts";
import type { ModelPreferences, ReferenceFrame, RunRoles } from "../types/host-api.d.ts";
import type { SteerHandle } from "./message-queue.ts";
import type { AfterLoopRun } from "./after-loop-run.ts";

/** One turn's options: who is asked, where, with what, and — inside a run — under which clock. */
export interface TurnOptions {
  threadId: string;
  turnId: string;
  text?: string;
  engine?: string;
  model?: string;
  effort?: string;
  preferences?: ModelPreferences;
  project?: string | null;
  newProject?: boolean;
  studioThread?: boolean;
  resume?: string | null;
  projectDir?: string;
  extraReads?: string[];
  stills?: ReferenceFrame[];
  /** The composer's roles panel: the workers' and judges' picks the message carries (model-roles.ts). */
  roles?: RunRoles;
  runId?: string;
  iteration?: number;
  setup?: AnyRecord | null;
  deadlineMs?: number;
  maxRounds?: number;
  contextWindow?: number | null;
  extraSystem?: string;
  engineLabel?: string;
  /** The queue's door into this turn for what the person sends while it works (chat-steer.ts). */
  steer?: SteerHandle;
  /** The run this chat's own session led is over: it answers with the run's controls (after-loop-run.ts). */
  afterLoopRun?: AfterLoopRun;
  /** The message whose settings the turn follows, as it was sent (chat-dispatch.ts). */
  asked?: AnyRecord;
  [option: string]: unknown;
}

/** How a turn ended (one of `TurnStop`, turn-record.ts), and what its last tool handed on. */
export interface TurnOutcome {
  stopped: string;
  round: number;
  engine?: string;
  details?: AnyRecord;
}

export {
  isContinueAsk,
  lastContractorSession,
  resolveChatProject,
  buildContractorBrief,
  nameFromAsk,
  resolveContextWindow,
};

/** Run one chat turn on the runner its engine calls for. */
export async function runTurn(ctx: HarnessCtx, options: TurnOptions): Promise<TurnOutcome> {
  const engine = options.engine ?? EngineId.Ollama;
  const described = await ctx.call(HostMethod.EngineDescribe);
  const contextWindowOf = (model: string | undefined) => resolveContextWindow(described, engine, model);
  if (options.studioThread)
    return runStudioTurn(ctx, {
      ...options,
      engine,
      model: options.model,
      contextWindow: contextWindowOf(options.model),
    });
  const descriptor = described.find((e) => e.id === engine);
  if (supportsSessions(descriptor))
    return runDelegatedTurn(ctx, { ...options, engine, engineLabel: descriptor?.label ?? engine });
  return runToolLoop(ctx, { ...options, engine, contextWindow: contextWindowOf(options.model) });
}
