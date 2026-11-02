/**
 * A chat turn that goes on with the settings of a message the person sent while it worked
 * (steer-switch.ts): the engine, model, effort and roles it answers on, worked out as the turn would
 * have started with that message — the after-run session's engine kept — and the lines that tell
 * the session what changed (steer-switch-prompts.ts).
 */
import { supportsSessions } from "./model-roles.ts";
import { SWITCH_NOTES } from "./steer-switch-prompts.ts";
import type { AfterLoopRun } from "./after-loop-run.ts";
import type { AnyRecord } from "../types/harness.d.ts";
import type { RunRoles } from "../types/host-api.d.ts";

/** What a chat turn runs on, as far as a switch changes it. */
export interface TurnSettings {
  engine: string;
  engineLabel: string;
  model?: string;
  effort?: string;
  preferences?: unknown;
  /** The composer's roles panel: the workers' and judges' picks (model-roles.ts). */
  roles?: RunRoles;
  afterLoopRun?: AfterLoopRun;
}

/** An engine as the host describes it: whether it holds a session, and what the person reads. */
export interface DescribedEngine {
  id: string;
  label?: string;
  supportsSessions?: boolean;
  kind?: string;
}

/** The engine a message answers on in this turn: the after-run session's, else the one it names, else the turn's. */
function engineFor(current: TurnSettings, item: AnyRecord): string {
  if (current.afterLoopRun) return current.afterLoopRun.engine;
  return typeof item.engine === "string" && item.engine ? item.engine : current.engine;
}

/**
 * Whether this turn cannot go on with the message's settings, so it ends at the session's next step
 * and the message gets a turn of its own: an engine that holds no session (its turn is another
 * runner's), or — after a run its lead led — another engine than the lead's (another session answers).
 */
export function endsTurnFor(current: TurnSettings, item: AnyRecord, described: readonly DescribedEngine[]): boolean {
  const named = typeof item.engine === "string" && item.engine ? item.engine : null;
  if (!named) return false;
  if (current.afterLoopRun) return named !== current.afterLoopRun.engine;
  return !supportsSessions(described.find((engine) => engine.id === named));
}

/** The model a message answers on: the one it names; the chat's own session after its run stays on the one it answers on. */
function modelFor(current: TurnSettings, item: AnyRecord): string | undefined {
  const named = typeof item.model === "string" && item.model ? item.model : undefined;
  if (current.afterLoopRun) return named ?? current.afterLoopRun.model ?? undefined;
  return named;
}

/**
 * The settings the turn goes on with after `item`, as a turn started with it would have run: its
 * engine (the after-run session's kept), model, effort, preferences and roles.
 */
export function switchedSettings(
  current: TurnSettings,
  item: AnyRecord,
  described: readonly DescribedEngine[],
): TurnSettings {
  const engine = engineFor(current, item);
  const model = modelFor(current, item);
  const label = described.find((one) => one.id === engine)?.label ?? engine;
  return {
    ...current,
    engine,
    engineLabel: label,
    model,
    effort: typeof item.effort === "string" ? item.effort : undefined,
    preferences: item.preferences,
    roles: item.roles && typeof item.roles === "object" ? (item.roles as RunRoles) : undefined,
  };
}

/** "Claude Code (opus) · high effort": who answers, as the session is told. */
function whoAnswers(settings: TurnSettings): string {
  const model = settings.model && settings.model !== "default" ? ` (${settings.model})` : "";
  const effort = settings.effort ? ` · ${settings.effort} effort` : "";
  return `${settings.engineLabel}${model}${effort}`;
}

/** The line a switch opens the next leg with: another engine, or another model or effort; none otherwise. */
export function switchNotes(before: TurnSettings, after: TurnSettings): string[] {
  if (after.engine !== before.engine) return [SWITCH_NOTES.engine(whoAnswers(after))];
  if (after.model !== before.model || after.effort !== before.effort) return [SWITCH_NOTES.model(whoAnswers(after))];
  return [];
}
