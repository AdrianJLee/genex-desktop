/**
 * How a chat turn is recorded: why it stopped (`TurnOutcome.stopped`, or a tool's `stopTurn`),
 * the status the host keeps on `turn.end`, and the reply a turn appends for the chat.
 */
import { HostMethod } from "./host-methods.ts";
import { EventKind } from "./run-events.ts";
import type { HarnessCtx } from "../types/harness.d.ts";
import type { HarnessHostApi } from "../types/host-api.d.ts";

/** Why a turn stopped. A tool's `stopTurn` is one of these too; callers read them: never rename one. */
export const TurnStop = {
  /** The turn answered. */
  Done: "done",
  /** The user pressed Stop. */
  Cancelled: "cancelled",
  /** A contractor session the user stopped; its finished edits are kept. */
  Aborted: "aborted",
  /** The engine needs a sign-in only a person can give. */
  NeedsSignin: "needs_signin",
  /** The engine is out of usage, or throttled with nothing to fall back to. */
  EngineLimited: "engine_limited",
  /** The loop spent every tool round it was given. */
  MaxRounds: "max_rounds",
  /** The run's wall clock ran out mid-turn. */
  Deadline: "deadline",
  /** The chat's session started a Loop: the outcome's `details.run` is its spec. */
  LaunchRun: "launch_run",
  /** The harness restarts itself into an edit (`restart_studio`). */
  Restart: "restart",
} as const;
export type TurnStop = (typeof TurnStop)[keyof typeof TurnStop];

/** How the host records a finished turn (`turn.end`). Wire values: never rename one. */
export const TurnStatus = {
  Ok: "ok",
  Error: "error",
  Cancelled: "cancelled",
} as const satisfies Record<string, NonNullable<HarnessHostApi["turn.end"]["params"]["status"]>>;
export type TurnStatus = (typeof TurnStatus)[keyof typeof TurnStatus];

/** Say `content` in the chat as this turn's assistant reply: recorded on the turn, then pushed. */
export async function sayInTurn(ctx: HarnessCtx, turnId: string, content: string): Promise<void> {
  await ctx.call(HostMethod.TurnAppend, {
    turnId,
    batch: [{ type: EventKind.Messages, messages: [{ role: "assistant", content }] }],
  });
  ctx.notify("chat.message", { role: "assistant", content });
}
