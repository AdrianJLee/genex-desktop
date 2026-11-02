/**
 * What waits for the end of an open Loop's turn before the next (`LoopRun.afterTurn`, which the wake
 * loop awaits): a look at the project's app the turn started settles first, then a recovery of the
 * app under way; then, when the turn kept no save point, Genex keeps what it left (always when the
 * folder changed; only what is unsaved where a plugin saves the project's app; nothing otherwise, nor
 * while a worker writes in the folder in place); then the rewind the lead asked for (Genex's restore
 * of the save point, the plugins' steps around it, then a wait until the app answers) and the restart
 * (the project's restore moments with no file changed, then the wait), both waiting while a worker
 * writes in place. No judge plays between turns: one is the lead's to ask for (`judge_play`). Each
 * outcome is one line the lead's next message carries; what came of a rewind or a restart the lead
 * asked for is a line of the run's log that wakes it (`NoteKind.AskDone`), as a worker's end does.
 * Never under a running turn, never after the Loop closed, and no recovery starts while this runs.
 */
import {
  CheckpointSkip,
  fireHooks,
  HookEvent,
  hookBlocked,
  holdOf,
  hooksOn,
  REOPEN_WAIT_MS,
  runScope,
  waitReady,
} from "../../hooks.ts";
import { HostMethod } from "../../host-methods.ts";
import type { LoopRun } from "../loop-run.ts";
import { closeUnderWay } from "../close-latch.ts";
import { NoteKind } from "../wake-schedule.ts";
import { folderChanged } from "./close.ts";
import { asksPending, type OpenLoop, type OpenRewind } from "./contract.ts";
import { heldForLead, OPEN_NEWS } from "./prompts.ts";
import { checkpointNow, queued, recordSavePoint } from "./save-point.ts";
import { writersInPlace } from "./writers.ts";

const MESSAGE = {
  autosave: "Autosave",
  autosaveSummary: "Saved by Genex: the lead's turn ended with unsaved work.",
  notRestored: (why: string) => `the restore failed (${why})`,
} as const;

/** Whether the Loop is closing or closed, stopped, or paused: nothing runs between turns then. */
const over = (loopRun: LoopRun, open: OpenLoop): boolean =>
  loopRun.state.finished ||
  Boolean(loopRun.state.finish) ||
  closeUnderWay(loopRun.state) ||
  loopRun.ctx.cancelled === true ||
  Boolean(open.halted);

/** A line the lead's next message carries. */
const carry = (open: OpenLoop, line: string): void => {
  open.journal.carried.push(line);
};

/** What came of a rewind or a restart the lead asked for: a line that wakes it. */
const tellDone = (loopRun: LoopRun, line: string): void => loopRun.note(line, NoteKind.AskDone);

/**
 * The turn's unsaved work, kept as an autosave: always when the folder changed (or git couldn't
 * say), only what is unsaved where a plugin saves the project's app, and nothing otherwise. A
 * checkpoint Genex held back or that failed is said; one that found nothing unsaved is not.
 */
async function autosave(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  const changed = await folderChanged(loopRun);
  const appSaved =
    hooksOn(loopRun.game, HookEvent.CheckpointBefore) || hooksOn(loopRun.game, HookEvent.CheckpointAfter);
  if (changed === false && !appSaved) return;
  const taken = await checkpointNow(loopRun, MESSAGE.autosave, changed === false);
  if ("snapshot" in taken) {
    const ask = { label: MESSAGE.autosave, summary: MESSAGE.autosaveSummary, auto: true };
    const point = await recordSavePoint(loopRun, ask, taken);
    carry(open, OPEN_NEWS.autosaved(point.label));
    return;
  }
  if ("skipped" in taken && taken.skipped === CheckpointSkip.NothingUnsaved) return;
  const why =
    "blocked" in taken ? heldForLead({ reason: taken.blocked, hold: taken.hold, label: taken.label }) : taken.reason;
  carry(open, OPEN_NEWS.notAutosaved(why));
}

/** The autosave, unless a worker writes in the folder in place: it would keep that worker's half-done files. */
async function autosaveUnlessWriting(loopRun: LoopRun, open: OpenLoop, writers: readonly string[]): Promise<void> {
  if (!writers.length) return autosave(loopRun, open);
  if ((await folderChanged(loopRun)) !== false) carry(open, OPEN_NEWS.notAutosavedWriter(writers));
}

/** Waits until the project's app answers again, when a plugin says whether it does; why not, or null. */
async function answered(loopRun: LoopRun, open: OpenLoop): Promise<string | null> {
  if (!hooksOn(loopRun.game, HookEvent.Health)) return null;
  const until = open.clock.now() + REOPEN_WAIT_MS;
  const stopped = () => over(loopRun, open);
  const ready = await waitReady(loopRun.ctx, loopRun.game, runScope(loopRun), open.clock, until, stopped);
  return ready.ok || loopRun.ctx.cancelled || stopped() ? null : ready.reason;
}

/** Genex's restore of a snapshot, after every git write before it; why it didn't happen, or null. */
async function restoreSnapshot(loopRun: LoopRun, snapshotId: string, reason: string): Promise<string | null> {
  const params = { ...runScope(loopRun), snapshotId, reason };
  try {
    await queued(loopRun, () => loopRun.ctx.call(HostMethod.SnapshotRestore, params));
    return null;
  } catch (err) {
    if (hookBlocked(err))
      return heldForLead({ reason: String(err.reason ?? err.message), hold: err.hold, label: err.label });
    return MESSAGE.notRestored(err instanceof Error ? err.message : String(err));
  }
}

/** The lead's rewind: back to the save point it named (the snapshot its label named when it asked), then the app waited for. */
async function rewind(loopRun: LoopRun, open: OpenLoop, { label, snapshotId }: OpenRewind): Promise<void> {
  open.journal.between.rewind = null;
  const why = await restoreSnapshot(loopRun, snapshotId, label);
  if (why) {
    tellDone(loopRun, OPEN_NEWS.noRewind(label, why));
    return;
  }
  const notBack = await answered(loopRun, open);
  tellDone(loopRun, OPEN_NEWS.rewound(label));
  if (notBack) tellDone(loopRun, OPEN_NEWS.notAnswering(notBack));
}

/**
 * The project's restore moments with no file changed, on the git-write queue; whether the app was
 * restarted. A block before leaves the app as it is; Genex holding the reopen back is the outcome,
 * never read as an app that failed to reopen.
 */
async function restartSteps(loopRun: LoopRun): Promise<boolean> {
  const scope = runScope(loopRun);
  const closing = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.RestoreBefore, scope);
  if (closing.blocked) {
    tellDone(loopRun, OPEN_NEWS.noRestart(heldForLead(closing.blocked)));
    return false;
  }
  const reopening = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.RestoreAfter, scope);
  if (reopening.blocked && holdOf(reopening.blocked)) {
    tellDone(loopRun, OPEN_NEWS.noRestart(heldForLead(reopening.blocked)));
    return false;
  }
  return true;
}

/**
 * The lead's restart: its steps (`restartSteps`), then the app waited for outside the git-write
 * queue, so a recovery's way back never waits behind that wait.
 */
async function restart(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  open.journal.between.restart = false;
  if (!(await queued(loopRun, () => restartSteps(loopRun)))) return;
  const notBack = await answered(loopRun, open);
  tellDone(loopRun, OPEN_NEWS.restarted);
  if (notBack) tellDone(loopRun, OPEN_NEWS.notAnswering(notBack));
}

/**
 * The rewind and the restart the lead asked for; both wait while a worker writes in the folder in
 * place, whose edits would land on the files the rewind put back.
 */
async function asksAtTurnEnd(loopRun: LoopRun, open: OpenLoop, writers: readonly string[]): Promise<void> {
  const { between } = open.journal;
  if (!asksPending(open.journal) || over(loopRun, open)) return;
  if (writers.length) {
    carry(open, OPEN_NEWS.askWaitsForWriter(writers));
    return;
  }
  if (between.rewind) await rewind(loopRun, open, between.rewind);
  if (between.restart && !over(loopRun, open)) await restart(loopRun, open);
}

/** A turn's end while Genex brings the project's app back: why nothing was kept or restored. */
function whileRecovering(open: OpenLoop, savedInTurn: boolean): void {
  if (!savedInTurn) carry(open, OPEN_NEWS.notAutosaved(OPEN_NEWS.bringingBack));
  if (asksPending(open.journal)) carry(open, OPEN_NEWS.askWaits);
}

/** The between-turns work itself (the module's header), once no recovery can start beside it. */
async function betweenTurns(loopRun: LoopRun, open: OpenLoop): Promise<void> {
  const savedInTurn = open.journal.savePoints.length > open.turnSavedFrom;
  if (open.recovering) whileRecovering(open, savedInTurn);
  else {
    const writers = writersInPlace(open).map((record) => record.id);
    // A turn that kept a save point left nothing for an autosave.
    if (!savedInTurn) await autosaveUnlessWriting(loopRun, open, writers);
    await asksAtTurnEnd(loopRun, open, writers);
  }
  // The next turn's save points count from here.
  open.turnSavedFrom = open.journal.savePoints.length;
  await loopRun.saveJournal().catch(() => {});
}

/** The between-turns work (the module's header), for an open Loop's run. */
export async function openBetweenTurns(loopRun: LoopRun): Promise<void> {
  const open = loopRun.open;
  if (!open || over(loopRun, open)) return;
  // A look the turn started settles first: a crash it saw starts its recovery now, never in the middle of what follows.
  if (open.healthLook) await open.healthLook;
  open.betweenTurns = true;
  try {
    await betweenTurns(loopRun, open);
  } finally {
    open.betweenTurns = false;
  }
}
