/**
 * What the loop's dispatch keeps between actions (main.ts `createStudio`), shared with the modules
 * that do the work: the chat turn (chat-dispatch.ts), the run (run-dispatch.ts) and the boot
 * notice (boot-notice.ts).
 */
import type { HarnessCtx, Host, Run } from "../types/harness.d.ts";
import type { RunSpec } from "../types/host-api.d.ts";

/** Which status line a unit of work paints: the chat's own reply, or the run under way on it. */
export const StatusLane = {
  Chat: "chat",
  Run: "run",
} as const;
export type StatusLane = (typeof StatusLane)[keyof typeof StatusLane];

/**
 * Which loop conducts a run. Never persisted: `chooseRunner` decides whether the lead's session (on
 * a project of any kind) conducts it, or which words refuse it.
 */
export const RunnerKind = {
  Director: "director",
  /** A Loop on an engine that keeps no session: refused with a typed reason. */
  NeedsSession: "needs_session",
} as const;
export type RunnerKind = (typeof RunnerKind)[keyof typeof RunnerKind];

/**
 * A run this loop is conducting (or reserving), and the promise that settles when it is over.
 * `closed` settles, and `done` is set, as soon as the run itself is over: the chat is free from
 * then on (live-chat.ts). `stopped` is the run's own Stop (live-chat.ts `stopRun`), which it keeps
 * whatever the chat does next.
 * `closing` is set just before the run appends its own end (`run_finished`, `autopilot_paused`): a
 * new start here (a Resume of that pause) waits for the close as for a done run, never refused by it.
 * `stops` counts the Stops that reached the run (`stopRun`), so a start waiting for its close sees a
 * Stop pressed again on a run that was already stopped.
 */
export interface ActiveRun {
  run: Run;
  threadId: string;
  settled: Promise<unknown>;
  closed: Promise<unknown>;
  done?: boolean;
  closing?: boolean;
  stopped?: boolean;
  stops?: number;
}

/** A run to start: from the chat's launch, the run IPC, or a resumed journal. */
export type RunStart = {
  type: "run_start";
  threadId: string;
  run: RunSpec | Run;
  resume?: boolean;
};

/** The loop's own state, and the scoped ctx every unit of work runs with. */
export interface Studio {
  host: Host;
  /** Threads whose current work the user stopped. A fresh message in a thread clears its flag. */
  cancels: Set<string>;
  /**
   * Messages a Stop was pressed for before their turn began (still sending, or waiting at the
   * front): their turn keeps the Stop instead of clearing it. Absent from an older main.ts.
   */
  stoppedMessages?: Set<string>;
  /** runId → { run, threadId }, kept through the post-run self-improvement so Stop still lands. */
  activeRuns: Map<string, ActiveRun>;
  startingRuns: Map<string, ActiveRun>;
  /**
   * runId → project for the runs the *previous* incarnation of this loop was running when it
   * died (the host names them in the boot notice). Their builders may still be alive in the
   * host — a contractor does not always die on the first signal — and the project they were
   * hired for is the only address a Stop pressed afterwards can still reach them at.
   */
  orphanRuns: Map<string, string>;
  /** Each unit of work gets a ctx scoped to its thread: its own status line, its own stop flag. */
  scoped(threadId: string, lane?: StatusLane): HarnessCtx;
}

/** Every run this loop holds: the ones under way, then the ones still being reserved. */
export function heldRuns(studio: Studio): ActiveRun[] {
  return [...studio.activeRuns.values(), ...studio.startingRuns.values()];
}
