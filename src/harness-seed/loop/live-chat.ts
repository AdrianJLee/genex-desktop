/**
 * The chat while a build of it is open (live chat). A message the person sends goes to the lead of
 * the run that owns the chat, when that lead takes the chat (director/lead-line.ts): recorded
 * delivered to the run, with a `run_steering` the lead's inbox reads, and answered by the lead in
 * the chat. Anything it does not take waits for the build to close; a message sent before the lead's
 * line opens waits for the line. A run has a Stop of its own (`stopRun`): the chat's next message
 * clears the chat's, never the run's.
 */
import { leadLineOf, leadLinesChanged, type LeadLine } from "./director/lead-line.ts";
import { RunEvent } from "./run-events.ts";
import { fromThePerson, MessageFrom, SteerDelivery } from "./steer-delivery.ts";
import { type ActiveRun, type Studio, heldRuns } from "./studio-state.ts";
import { attachmentsArtifactOf, keepsPictures, type LeadDoor, type QueueAction } from "./message-queue.ts";

/** A message's words, trimmed; anything else reads as none. */
const wordsOf = (action: QueueAction): string => String(action.text ?? "").trim();

/**
 * Does the lead take this message: words or pictures for the chat — never a fresh build asked for
 * (`newRun`, a New build queued before the composer dropped it), Studio's own chat or a slash
 * command (words to the session, not to the lead).
 */
function forTheLead(action: QueueAction): boolean {
  const words = wordsOf(action);
  const ownTurn = Boolean(action.newRun || action.studioThread);
  const said = words.length > 0 || keepsPictures(action);
  return said && !words.startsWith("/") && !ownTurn;
}

/** The build this chat's messages wait for: its run that has not closed yet. */
export function openBuildOf(studio: Studio, threadId: string): ActiveRun | undefined {
  return heldRuns(studio).find((active) => active.threadId === threadId && !active.done);
}

/**
 * The records the lead reads a message from: a steer of its run, word for word, from this message,
 * marked as the lead's (`how: "lead"`), naming the artifact its pictures are kept in and Genex when
 * Genex wrote it — once heard, or back with the chat, a later run of the run never tells it again
 * (run-inbox.ts), and the chat's own `resume_run` records its words anew.
 */
function steerOf(line: LeadLine, item: QueueAction) {
  const messageId = String(item.messageId);
  return [
    {
      event_type: RunEvent.RunSteering,
      payload: {
        runId: line.runId,
        text: wordsOf(item),
        sourceMessageId: messageId,
        how: SteerDelivery.Lead,
        ...(keepsPictures(item) ? { attachmentsArtifact: attachmentsArtifactOf(messageId) } : {}),
        ...(fromThePerson(item) ? {} : { from: MessageFrom.Genex }),
        at: new Date().toISOString(),
      },
    },
  ];
}

/**
 * The door to the lead of this chat's open build, when that lead takes this message now: its
 * wrap-up too, since the lead is the chat's own session and answers what it heard there.
 */
export function leadDoor(studio: Studio, threadId: string, action: QueueAction): LeadDoor | null {
  const build = openBuildOf(studio, threadId);
  const line = build ? leadLineOf(build.run.runId) : undefined;
  const takes = line?.threadId === threadId && line.open() && forTheLead(action);
  if (!line || !takes) return null;
  return {
    into: line.runId,
    open: () => line.open(),
    records: (item) => steerOf(line, item),
    handed: (item, giveBack) => line.hear(item, giveBack),
  };
}

/** Why the wait for a build ended: it closed, or a run's line opened or shut. */
const LINES_CHANGED = Symbol("lines changed");

/**
 * What the chat's next message waits for: the build to close — or, when the run's lead takes
 * it, the lead's door, which the queue hands it through. When a line opens or shuts and the lead
 * still does not take it, null: the queue looks again, and may hand the lead what waits behind it
 * (message-queue.ts). Stop closes the build early.
 */
export async function chatWaitsFor(
  studio: Studio,
  threadId: string,
  next: QueueAction,
): Promise<LeadDoor | null | undefined> {
  for (;;) {
    const build = openBuildOf(studio, threadId);
    if (!build) return undefined;
    const door = leadDoor(studio, threadId, next);
    if (door) return door;
    const lines = leadLinesChanged().then(() => LINES_CHANGED);
    if ((await Promise.race([build.closed, lines])) === LINES_CHANGED) return null;
  }
}

/** Does an open build hold this chat or its game (a legacy second chat of a game answers for its build too)? */
export function buildHolds(studio: Studio, threadId: string, project?: string | null): boolean {
  const ofGame = (active: ActiveRun): boolean => Boolean(project) && active.run?.project === project;
  return heldRuns(studio).some((active) => !active.done && (active.threadId === threadId || ofGame(active)));
}

/**
 * The run under way on this chat or game, once any run that has closed there has settled: a new
 * build waits that out instead of being refused.
 */
export async function runUnderWay(studio: Studio, threadId: string, project: string): Promise<ActiveRun | undefined> {
  for (;;) {
    const busy = [...studio.activeRuns.values()].find((a) => a.threadId === threadId || a.run.project === project);
    if (!busy?.done) return busy;
    await busy.settled;
  }
}

/**
 * Stop reached this run: it stays stopped whatever the chat does next — a message clears the chat's
 * own Stop (`studio.cancels`), never this one — and a build that waited for it to end does not
 * start (run-dispatch.ts).
 */
export function stopRun(active: ActiveRun): void {
  active.stopped = true;
  active.stops = (active.stops ?? 0) + 1;
}

/** The composer's Stop: it reaches every run of this chat — or of every chat, when none is named. */
export function stopRunsOf(studio: Studio, threadId?: string): void {
  for (const active of heldRuns(studio)) if (!threadId || active.threadId === threadId) stopRun(active);
}
