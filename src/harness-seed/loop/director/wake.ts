/**
 * The Loop's wake loop. The lead ends its turn when it decides to; between turns nothing of it runs;
 * the studio wakes the SAME session with a message when something happens — the user speaks, a worker
 * ends or asks, a job ends, the project's app stops (wake-schedule.ts decides which). A turn that ends
 * with nothing at work and nothing to be woken for closes the Loop, as a bare agent's turn ends; no
 * clock wakes or ends it. One turn at a time: what arrives during a turn reaches it mid-turn when its
 * engine can take it, or opens the next message. The fresh-session fallback covers every turn; a lost
 * provider (a limit, a sign-in) pauses the run, and the host resumes it.
 *
 * The journal holds what the loop needs after a restart (journal.ts); a resumed run's first message
 * is read from it. The lead answers the chat while the run is going (live chat, lead-line.ts).
 * Its functions take the run explicitly; they are not bound onto it.
 */
import { isResumeFailure } from "../chat-session.ts";
import { fireHooks, HookEvent, type HookScope, runScope as runMoment } from "../hooks.ts";
import { HOOK_PROMPTS } from "../hooks-prompts.ts";
import { type HeldBack, heldTurnResult, turnsHeldWords } from "./held-words.ts";
import { whileTurnHeld } from "./turn-hold.ts";
import { HostMethod } from "../host-methods.ts";
import { jobEndLine } from "../jobs/prompts.ts";
import { JOB_POLL_MS, jobEnds } from "../jobs/watch.ts";
import {
  EngineFailure,
  engineLimitOf,
  isTransientProviderError,
  outageDelays,
  StopReason,
  withProviderPatience,
  type EngineLimit,
} from "../outage.ts";
import { isProviderLoss, lostSignIn, noteProviderLoss, pauseDecision } from "../provider-loss.ts";
import { CLIP_DETAIL } from "../text.ts";
import { RunEvent } from "../run-events.ts";
import { fromThePerson, MessageFrom, SteerDelivery } from "../steer-delivery.ts";
import { textsOf, WORDS_APART } from "../message-queue.ts";
import { SECOND_MS } from "../time.ts";
import { estimateTokens } from "../prompt.ts";
import { wrapUpPrompt } from "./briefs.ts";
import { recordLoopRun, restoredWake, resumedFromJournal, wakeRecord } from "./journal.ts";
import { folderBusy } from "./lead-session.ts";
import { noteTurnEnds, noteTurnOver } from "./turn-ends.ts";
import { closeUnderWay } from "./close-latch.ts";
import { activeWork, hasWorkAtHand, leadsOpenLoop } from "./open/active-work.ts";
import { OPEN_WALL_CLOCK } from "./open/contract.ts";
import { openClosingOf, openDigestOf } from "./open/digest.ts";
import { healthWatch } from "./open/health.ts";
import { heardMidTurn, noteWorkerQuestions, watchOpenTurn } from "./open/news.ts";
import { watchTurnNews } from "./turn-news.ts";
import { openWakeRules } from "./open/prompts.ts";
import {
  carryOn,
  FRESH_LOG_LINES,
  FRESH_NOTES,
  freshStart,
  SESSION_LOST_WHY,
  sinceThen,
  userSaysBlock,
  wakeDigest,
  wakeRules,
  wrapLead,
} from "./wake-prompts.ts";
import { afterTurn, nextWake, NoteKind, TurnEnd, WAKE_WINDOW_MS, WakeCause, WrapCause } from "./wake-schedule.ts";
import { keepRunClock } from "./loop-run.ts";
import type { AnyRecord, HarnessCtx } from "../../types/harness.d.ts";
import type { DelegateResult, SteerMessage } from "../../types/host-api.d.ts";
import type { RestoredWake } from "./journal.ts";
import type { LeadLine } from "./lead-line.ts";
import type { LoopRun } from "./loop-run.ts";
import type { SaidSteer } from "../run-inbox.ts";
import type { DigestFacts } from "./wake-prompts.ts";
import type { TurnFacts, TurnVerdict, Wake, WakeReason, WakeView } from "./wake-schedule.ts";

/** This part serves a lead that is its chat's own session (lead-session.ts `servesLead`). */
export const SERVES_LEAD = true;

/** How often a resting lead's inbox and log are read. */
export const WAKE_POLL_MS = SECOND_MS;
/** A run opens at most this many fresh sessions for a lead whose own was lost. */
export const MAX_FRESH_SESSIONS = 3;
/** A lead's turn the host refused because another session holds its lock is asked again after this wait, until the lock is free or the person stops the run. */
export const BUSY_RETRY_MS = 15 * SECOND_MS;
/** News that reaches a resting lead is saved once it has waited this long for a wake that did not come. */
const JOURNAL_NEWS_MS = 5 * SECOND_MS;
/** A wake message's news is held to about this many tokens: the oldest gives way first. */
const WAKE_TOKEN_BUDGET = 8_000;

/** The user's own reasons to wake the lead: never held back by the hourly cap, so never counted in it. */
const USER_WAKES: ReadonlySet<WakeReason> = new Set<WakeReason>([WakeCause.UserMessage, WakeCause.FinishRequested]);

/** What a message to the lead carries besides its words: the pictures said with it, and who wrote it when it is not a brief. */
export type TurnSaid = Omit<SteerMessage, "id" | "text">;

/** A chat message as the lead is told it: its words, its pictures, and Genex when Genex wrote it. */
type Said = Omit<SteerMessage, "id">;

/** The lead's session as the run talks to it: one turn at a time, and the session id it resumes. */
export interface DirectorTalk {
  session: (prompt: string, sid: string | null | undefined, said?: TurnSaid) => Promise<Partial<DelegateResult>>;
  sessionId: string | null;
  /** Keep the session a turn answered with, on the journal where a resume finds it. */
  keep: (result: Partial<DelegateResult> | null | undefined) => Promise<void>;
}

/** The loop's clock: the real one, or one a test moves. */
export interface WakeClock {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
}
/** The wall clock. */
export const SYSTEM_CLOCK: WakeClock = { now: () => Date.now(), sleep: (ms) => OPEN_WALL_CLOCK.sleep(ms) };

/** Why a run the waking lead left open ended, when the wrap-up had a cause of its own (the report's sentence). */
export const WAKE_ENDING = {
  [WrapCause.Finish]: "the user asked to finish and the lead did not call finish in its wrap-up",
} as const satisfies Partial<Record<WrapCause, string>>;

/** What the loop keeps between the lead's turns. */
export interface WakeState {
  turns: number;
  asleepFromSeq: number;
  asleepSince: number | null;
  wrapping: boolean;
  wrapCause: WrapCause | null;
  wakes: number;
  wakesAt: number[];
  lastWakeAt: number | null;
  userWaiting: boolean;
  /** The user's words the lead was told although the store refused to record their hand-over. */
  heardUnrecorded: string[];
  /** The user's words handed into a turn that ended before it read them: they open the next message. */
  owed: Said[];
  /** The line the chat reaches the lead on (lead-line.ts), when the run opened one. */
  line: LeadLine | null;
  /** How many of the chat's messages the line had been handed when the lead's latest message was told them. */
  promptThrough: number;
  /** The user's words the lead's latest message carried: said again when no turn worked on it. */
  promptWords: Said[];
  /** The turn under way was cut short to hand the lead the user's words: it is resumed at once with them. */
  cut: boolean;
  /** The session's first message, when a plugin held its turn back: it opens the next one (`heldTurn`). */
  heldFirst?: string;
  finishNew: boolean;
  finishSaid: boolean;
  /** The log's sequence number, and the time, the loop last saved the journal. */
  journaledSeq: number;
  journaledAt: number;
  freshSessions: number;
  /** The turn whose failure started the wrap-up. */
  failed: Partial<DelegateResult> | null;
  /** When the run's job ends were last asked for (null: not yet). */
  jobsPolledAt: number | null;
}

/** How the loop ended: the last turn's answer, why the wrap-up started, and the turn that failed. */
export interface WakeOutcome {
  result: Partial<DelegateResult>;
  wrapCause: WrapCause | null;
  failed: Partial<DelegateResult> | null;
}

/** What a turn needs besides the run: the brief a fresh session opens with, the clock, and the chat's line. */
interface TurnKit {
  talk: DirectorTalk;
  brief: () => string;
  clock: WakeClock;
  line: LeadLine | null;
}

/** One message to the lead's session, and what it carries besides its words. */
interface TurnAsk {
  prompt: string;
  said?: TurnSaid;
}

/** A message carrying `words` takes their pictures with it, and says who wrote it when one sender wrote it all (`from`). */
function saidWith(words: readonly Said[], from?: MessageFrom): TurnSaid {
  const images = words.flatMap((one) => one.images ?? []);
  return { ...(images.length ? { images } : {}), ...(from ? { from } : {}) };
}

/** The loop's state as a run starts: a resumed one takes back what its journal kept of it. */
function newWakeState(restored: RestoredWake = { wakesAt: [] }): WakeState {
  return {
    turns: 0,
    asleepFromSeq: 0,
    asleepSince: null,
    wrapping: false,
    wrapCause: null,
    wakes: 0,
    wakesAt: restored.wakesAt,
    lastWakeAt: null,
    userWaiting: false,
    heardUnrecorded: [],
    owed: [],
    line: null,
    promptThrough: 0,
    promptWords: [],
    cut: false,
    finishNew: false,
    finishSaid: false,
    journaledSeq: 0,
    journaledAt: 0,
    freshSessions: restored.freshSessions ?? 0,
    failed: null,
    jobsPolledAt: null,
  };
}

/**
 * The run is over for the lead: it finished, the user stopped it, or it failed on its own; or its
 * close has started; or, an open Loop, it pauses because the project's app couldn't be brought back.
 */
const loopRunOver = (loopRun: LoopRun): boolean =>
  loopRun.state.finished ||
  loopRun.ctx.cancelled === true ||
  Boolean(loopRun.report.failure) ||
  Boolean(loopRun.state.finish) ||
  closeUnderWay(loopRun.state) ||
  Boolean(loopRun.open?.halted);

/** Of the inbox's untold steers, what the lead has not heard: those it was told on a refused hand-over lead the list. */
function unheard(wake: WakeState, untold: readonly SaidSteer[]): SaidSteer[] {
  const stillLeading = wake.heardUnrecorded.every((text, i) => untold[i]?.text === text);
  if (!stillLeading) wake.heardUnrecorded = [];
  return untold.slice(wake.heardUnrecorded.length);
}

/**
 * The user's words the lead is told now — what a turn was handed and did not read first, then the
 * inbox's — and how many of the chat's messages the line had been handed by then (`through`).
 */
async function userWords(loopRun: LoopRun, wake: WakeState): Promise<{ words: Said[]; through: number }> {
  const owed = wake.owed.splice(0);
  const { line } = wake;
  let through = line?.count() ?? 0;
  const words = await takeUntold(loopRun, wake);
  while (line && line.count() !== through) {
    through = line.count();
    words.push(...(await takeUntold(loopRun, wake)));
  }
  return { words: [...owed, ...words], through };
}

/** The user's words a message to the lead carries, taken off the inbox, which records their hand-over. */
async function tellUser(loopRun: LoopRun, wake: WakeState): Promise<Said[]> {
  const { words, through } = await userWords(loopRun, wake);
  wake.promptThrough = through;
  wake.promptWords = words;
  return words;
}

/** The inbox's steers the lead has not heard, taken off it (`tellUser`), each with its pictures. */
async function takeUntold(loopRun: LoopRun, wake: WakeState): Promise<Said[]> {
  const { inbox } = loopRun;
  const taken = await inbox.steers(undefined, true, { onlyNew: true }).catch(() => null);
  if (taken) {
    const steers = unheard(wake, taken);
    wake.heardUnrecorded = [];
    return Promise.all(steers.map((steer) => withItsPictures(loopRun, steer)));
  }
  const untold = await inbox.steers(undefined, false, { onlyNew: true }).catch(() => []);
  const steers = unheard(wake, untold);
  wake.heardUnrecorded = untold.map((steer) => steer.text);
  return Promise.all(steers.map((steer) => withItsPictures(loopRun, steer)));
}

/**
 * A steer as the lead is told it: its words and sender, and every picture the chat keeps for it
 * (its stills, and a commission's frames: message-queue.ts `#durable`).
 */
async function withItsPictures(loopRun: LoopRun, steer: SaidSteer): Promise<Said> {
  const said = { text: steer.text, ...(steer.from ? { from: steer.from } : {}) };
  if (!steer.attachmentsArtifact) return said;
  const params = { threadId: loopRun.threadId, artifactId: steer.attachmentsArtifact };
  const kept = (await loopRun.ctx.call(HostMethod.ArtifactRead, params).catch(() => null)) as AnyRecord | null;
  const images = [kept?.stills, kept?.frames].flatMap((list) => (Array.isArray(list) ? list : []));
  return { ...said, ...(images.length ? { images } : {}) };
}

/** How the Loop works, as the lead's first message (and a fresh session's) says it. */
const rulesFor = (loopRun: LoopRun): string => (leadsOpenLoop(loopRun) ? openWakeRules() : wakeRules());

/**
 * The first message: the brief, how the Loop works, and whatever the user said before it began —
 * on a resumed run, inside a message read from its journal.
 */
async function firstPrompt(loopRun: LoopRun, wake: WakeState, brief: () => string, now: number): Promise<string> {
  const said = textsOf(await tellUser(loopRun, wake));
  const opening = [brief(), rulesFor(loopRun)];
  if (resumedFromJournal(loopRun)) return [...opening, resumedDigest(loopRun, wake, said, now)].join("\n\n");
  return [...opening, said.length ? userSaysBlock(said) : ""].filter(Boolean).join("\n\n");
}

/** A resumed run's first message, read from what its journal kept, under a heading of its own. */
function resumedDigest(loopRun: LoopRun, wake: WakeState, userSays: string[], now: number): string {
  const happened = readUnread(loopRun);
  const closing = closingFor(loopRun, wake);
  if (leadsOpenLoop(loopRun)) return openDigestOf(loopRun, { reasons: [], userSays, happened, closing, resumed: true });
  const heading = "THE RUN PICKS UP where it paused.";
  return wakeDigest(digestFacts(loopRun, { now, reasons: [], userSays, finishNew: false, happened, closing, heading }));
}

/** Everything `afterTurn` decides on, read from the run as the turn ends. */
async function turnFacts(
  loopRun: LoopRun,
  wake: WakeState,
  result: Partial<DelegateResult>,
  now: number,
): Promise<TurnFacts> {
  const { inbox, state } = loopRun;
  return {
    ok: result?.ok === true,
    closed: loopRunOver(loopRun) || wake.wrapping,
    providerLost: Boolean(state.limit) || (await pauseOnLostSignIn(loopRun, now)),
    finishRequested: await inbox.finishing().catch(() => false),
  };
}

/** The wrap-up starts, for `cause` unless an earlier one is kept: this wake opens the run's last turn. */
function startWrapUp(wake: WakeState, cause: WrapCause): void {
  if (!wake.wrapCause) wake.wrapCause = cause;
  wake.wrapping = true;
}

/** Act on the end of a turn: the wrap-up the verdict starts, and the turn that failed. */
function settleTurn(wake: WakeState, verdict: TurnVerdict, result: Partial<DelegateResult>) {
  if (verdict.next !== TurnEnd.WrapUp || !verdict.wrapCause) return;
  if (verdict.wrapCause === WrapCause.Failed) wake.failed = result;
  startWrapUp(wake, verdict.wrapCause);
}

/** The run's jobs that ended since the lead last heard, each a line of the run's log; asked at most every `JOB_POLL_MS`. */
async function watchJobs(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  if (wake.jobsPolledAt !== null && now - wake.jobsPolledAt < JOB_POLL_MS) return;
  wake.jobsPolledAt = now;
  const { ctx, run, state } = loopRun;
  const read = await jobEnds(ctx, { project: run.project, runId: run.runId }, state.jobsCursor ?? 0);
  state.jobsCursor = read.cursor;
  for (const end of read.ends) loopRun.note(jobEndLine(end), NoteKind.JobEnded);
}

/** Read the inbox while the lead rests: what the user said, a finish request, its workers' questions, job ends and what is at work. */
async function collect(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  const { inbox } = loopRun;
  await watchJobs(loopRun, wake, now);
  await noteWorkerQuestions(loopRun, now);
  await activeWork(loopRun, now);
  if (leadsOpenLoop(loopRun)) healthWatch(loopRun);
  const untold = await inbox.steers(undefined, false, { onlyNew: true }).catch(() => []);
  wake.userWaiting = wake.owed.length > 0 || unheard(wake, untold).length > 0;
  const finishing = await inbox.finishing().catch(() => false);
  // An ask the lead recorded itself (`wrap_up`) is said already: no news to it.
  if (finishing && Boolean(loopRun.state.finishAsk)) wake.finishSaid = true;
  wake.finishNew = !wake.finishSaid && finishing;
}

/** What `nextWake` decides on, read from the run. */
function wakeView(loopRun: LoopRun, wake: WakeState, now: number): WakeView {
  return {
    now,
    unread: loopRun.notesSince(loopRun.waitSeq).filter((entry) => !heardMidTurn(loopRun, entry.seq)),
    asleepFromSeq: wake.asleepFromSeq,
    asleepSince: wake.asleepSince ?? now,
    userWaiting: wake.userWaiting,
    finishNew: wake.finishNew,
    wakesAt: wake.wakesAt,
  };
}

/** News that has waited `JOURNAL_NEWS_MS` for a wake that did not come is saved to the journal. */
async function journalNews(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  const saved = Math.max(wake.journaledSeq, loopRun.journaledSeq ?? 0);
  const oldest = loopRun.notesSince(saved)[0];
  if (!oldest) return;
  const waited = now - oldest.at >= JOURNAL_NEWS_MS && now - wake.journaledAt >= JOURNAL_NEWS_MS;
  if (waited) await keepWake(loopRun, wake, now);
}

/**
 * Rest until something is due; null once the run ends under the lead, or once nothing is at work and
 * nothing would wake it: then the Loop is done, as a bare agent's turn ends. A message from the chat
 * cuts the rest short.
 */
async function sleepUntilDue(loopRun: LoopRun, wake: WakeState, kit: TurnKit): Promise<Wake | null> {
  const { clock, line } = kit;
  for (;;) {
    if (loopRunOver(loopRun)) return null;
    const spoke = line?.heard();
    await collect(loopRun, wake, clock.now());
    const now = clock.now();
    const due = nextWake(wakeView(loopRun, wake, now));
    if (due && due.at <= now) return due;
    if (!due && !hasWorkAtHand(loopRun) && (await nothingJustEnded(loopRun, wake, now))) return null;
    await journalNews(loopRun, wake, now);
    await (spoke ? Promise.race([clock.sleep(WAKE_POLL_MS), spoke]) : clock.sleep(WAKE_POLL_MS));
  }
}

/**
 * Whether nothing ended just now that the lead must hear before its Loop is done: the run's job ends
 * are read again at once (a job that ended since their last read is no longer at work, and its end
 * wakes the lead), and nothing is due after it.
 */
async function nothingJustEnded(loopRun: LoopRun, wake: WakeState, now: number): Promise<boolean> {
  wake.jobsPolledAt = null;
  await watchJobs(loopRun, wake, now);
  return nextWake(wakeView(loopRun, wake, now)) === null;
}

/** The log's lines the lead has not read, as text; the shared cursor moves past them. */
function readUnread(loopRun: LoopRun): string[] {
  const unread = loopRun.notesSince(loopRun.waitSeq);
  const last = unread.at(-1);
  if (last) loopRun.waitSeq = Math.max(loopRun.waitSeq, last.seq);
  return unread.filter((entry) => !heardMidTurn(loopRun, entry.seq)).map((entry) => entry.text);
}

/** Record the wake: the cap's window, and every request it says, so none is said twice. */
function markSaid(wake: WakeState, reasons: readonly WakeReason[], now: number): void {
  wake.wakes += 1;
  wake.lastWakeAt = now;
  const capped = reasons.some((reason) => !USER_WAKES.has(reason));
  wake.wakesAt = [...wake.wakesAt.filter((at) => at > now - WAKE_WINDOW_MS), ...(capped ? [now] : [])];
  wake.userWaiting = false;
  if (wake.finishNew) wake.finishSaid = true;
  wake.finishNew = false;
}

/** How this wake's message ends: the wrap-up, or the ordinary closing. */
function closingFor(loopRun: LoopRun, wake: WakeState): string {
  if (leadsOpenLoop(loopRun)) return openClosingOf({ wrapping: wake.wrapping, wrapCause: wake.wrapCause ?? null });
  const { run, state } = loopRun;
  if (!wake.wrapping || !wake.wrapCause) return carryOn();
  const wrapUp = wrapUpPrompt({
    run,
    integrationHead: state.integrationHead,
    integrationHealthy: state.integrationHealthy,
    running: loopRun.runningWorkers().map((record) => String(record.id)),
    userAsked: wake.wrapCause === WrapCause.Finish || Boolean(state.finishAsk),
  });
  return wrapLead(wake.wrapCause, wrapUp);
}

/** The web digest's facts, read from the run at the moment of the wake. */
function digestFacts(
  loopRun: LoopRun,
  said: Pick<DigestFacts, "now" | "reasons" | "userSays" | "finishNew" | "happened" | "closing" | "heading">,
): DigestFacts {
  const { pool, state } = loopRun;
  return {
    ...said,
    integrationHead: state.integrationHead,
    integrationHealthy: state.integrationHealthy,
    workers: (pool?.state.records ?? []).map((record: AnyRecord) => ({
      id: String(record.id),
      title: String(record.title),
      state: String(record.state),
      verdict: record.verdict ?? null,
    })),
  };
}

/** The message that wakes the lead: the user's words, the news, where the run stands and the closing. */
async function wakePrompt(loopRun: LoopRun, wake: WakeState, due: Wake, clock: WakeClock): Promise<string> {
  const now = clock.now();
  // The person asked to finish while the lead rested: this message opens its last turn, in their words.
  if (due.reasons.includes(WakeCause.FinishRequested)) startWrapUp(wake, WrapCause.Finish);
  const userSays = textsOf(await tellUser(loopRun, wake));
  const happened = readUnread(loopRun);
  const finishNew = wake.finishNew;
  markSaid(wake, due.reasons, now);
  await loopRun.appendRun(RunEvent.DirectorContinued, { reasons: due.reasons });
  const closing = closingFor(loopRun, wake);
  let prompt: string;
  if (leadsOpenLoop(loopRun)) prompt = openDigestOf(loopRun, { reasons: due.reasons, userSays, happened, closing });
  else {
    const told = digestFacts(loopRun, { now, reasons: due.reasons, userSays, finishNew, happened, closing });
    const render = (lines: readonly string[]) => wakeDigest({ ...told, happened: lines, userSays: [] });
    prompt = wakeDigest({ ...told, happened: fitHappened(told.happened, render, WAKE_TOKEN_BUDGET) });
  }
  // What the lead has now been told is heard: a restart during its turn does not tell it again.
  await keepWake(loopRun, wake, now);
  return prompt;
}

/**
 * The news a wake can carry within `budget` tokens of `render`'s text: all of it when it fits;
 * otherwise the newest, halved until it fits, behind one line saying how much was left out.
 */
export function fitHappened(
  happened: readonly string[],
  render: (lines: readonly string[]) => string,
  budget: number,
): string[] {
  let kept = [...happened];
  const fits = (lines: readonly string[]) => estimateTokens(render(lines)) <= budget;
  while (!fits(withLeftOut(happened, kept)) && kept.length > 1) kept = kept.slice(-Math.floor(kept.length / 2));
  return withLeftOut(happened, kept);
}

/** `kept`, behind a line naming how many of `all` it leaves out, when it leaves any out. */
function withLeftOut(all: readonly string[], kept: string[]): string[] {
  const left = all.length - kept.length;
  return left > 0 ? [`(${left} earlier events left out to keep this message short)`, ...kept] : kept;
}

/** A turn that failed outright, as the loop reads it. */
function failedTurn(err: any): Partial<DelegateResult> {
  return { ok: false, stopReason: err?.kind ?? StopReason.Error, errorText: String(err?.message ?? err) };
}

/** The run pauses on `limit` (a provider loss), and its feed says why — once, whatever else failed after it. */
async function pauseOn(loopRun: LoopRun, limit: EngineLimit): Promise<void> {
  if (loopRun.state.limit) return;
  loopRun.state.limit = limit;
  const words = pauseDecision(limit.kind, String(limit.message).slice(0, CLIP_DETAIL));
  await loopRun.decision(words.line, words.plain);
}

/**
 * A lead turn a lost provider ended pauses the run: a lost sign-in or a limit (the session's own
 * catch has kept one already, director.ts `directorTalk`), or an outage the patience ladder could not
 * outlast. A first turn pauses too: a provider gone is no crash of the run. Answers whether it did.
 */
async function pauseOnProvider(loopRun: LoopRun, err: any, now: number): Promise<boolean> {
  if (loopRun.ctx.cancelled) return false;
  if (isProviderLoss(err?.kind)) {
    // Judges on the lead's engine stop asking it too, until the run resumes or the limit resets.
    noteProviderLoss(loopRun.run.runId, loopRun.run.engine, err, now);
    await pauseOn(loopRun, engineLimitOf(err, now));
    return true;
  }
  if (!isTransientProviderError(err)) return false;
  await pauseOn(loopRun, {
    kind: EngineFailure.Unavailable,
    message: String(err?.message ?? err),
    retryAfterMs: null,
    at: now,
  });
  return true;
}

/**
 * A sign-in lost on any engine of the run — a worker's, a judge's (provider-loss.ts `lostSignIn`) — pauses
 * the run at the lead's next turn: no worker can build and no round can be judged until the user
 * fixes it. Answers whether the run is paused on one.
 */
async function pauseOnLostSignIn(loopRun: LoopRun, now: number): Promise<boolean> {
  const lost = lostSignIn(loopRun.run.runId, now);
  if (!lost || loopRun.ctx.cancelled) return false;
  await pauseOn(loopRun, {
    kind: lost.kind,
    message: `${lost.engine}: ${lost.message}`,
    retryAfterMs: null,
    at: lost.at,
  });
  return true;
}

/**
 * Did the lead's turn come back failed on the provider's outage (a 529, a dropped gateway) rather
 * than throw it? It is asked again on the outage ladder like a thrown one (`patientAsk`).
 */
function endedOnOutage(result: Partial<DelegateResult>): boolean {
  const failed = result?.ok === false && result.stopReason !== StopReason.Stopped;
  if (!failed || isProviderLoss(result.stopReason)) return false;
  return isTransientProviderError(String(result.errorText ?? ""));
}

/** Why the lead's session is gone and a fresh one must carry the run, or null when it is not. */
function lostSessionWhy(talk: DirectorTalk, err: any): string | null {
  if (talk.sessionId && isResumeFailure(err)) return SESSION_LOST_WHY.resumeFailed;
  const full = err?.kind === EngineFailure.ContextOverflow || err?.kind === EngineFailure.ContextThreshold;
  return full ? SESSION_LOST_WHY.contextFull : null;
}

/** The lead's notes and the log it has already read, for a fresh session. */
function freshContext(loopRun: LoopRun): { notes: string[]; recent: string[] } {
  const notes = (loopRun.journal.director?.notes ?? []).slice(-FRESH_NOTES).map((n: AnyRecord) => String(n.text));
  const recent = loopRun.state.log
    .filter((entry) => entry.seq <= loopRun.waitSeq)
    .slice(-FRESH_LOG_LINES)
    .map((entry) => entry.text);
  return { notes, recent };
}

/**
 * A new session for a later turn. It knows nothing of the run, so it is told the brief, the
 * rules, the lead's notes, the run so far and this turn's message — never the message alone.
 */
function openFresh(loopRun: LoopRun, kit: TurnKit, turn: TurnAsk, why: string): Promise<Partial<DelegateResult>> {
  // An open Loop Genex paused (its app couldn't be brought back), or one the person stopped, opens no new session.
  const refused = openSessionRefused(loopRun);
  if (refused) return Promise.resolve(refused);
  const text = freshStart({
    why,
    brief: kit.brief(),
    rules: rulesFor(loopRun),
    ...freshContext(loopRun),
    // The person's words alone (a cut turn's resume) are quoted as theirs inside Genex's brief.
    digest: turn.said?.from === MessageFrom.Person ? userSaysBlock([turn.prompt]) : turn.prompt,
  });
  // A fresh start is Genex's brief around the message: it keeps the pictures, never the message's sender.
  return kit.talk.session(text, null, { images: turn.said?.images ?? [] });
}

/**
 * The lead's session is lost — it cannot be resumed, or its context is full: a fresh one carries
 * the run (`openFresh`). On the first turn the message already is the brief.
 */
async function freshSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
  why: string,
): Promise<Partial<DelegateResult>> {
  const { talk } = kit;
  const refused = openSessionRefused(loopRun);
  if (refused) return refused;
  if (wake.freshSessions >= MAX_FRESH_SESSIONS)
    return { ok: false, stopReason: StopReason.Error, errorText: `the lead's session was lost too often (${why})` };
  wake.freshSessions += 1;
  talk.sessionId = null;
  // The first turn already carries the brief: a Resume whose old session is gone opens a new one silently.
  if (wake.turns === 1) return talk.session(turn.prompt, null, turn.said);
  await loopRun.decision(
    `the director's session was lost (${why}); a fresh session carries the run on`,
    "the lead's conversation was lost, so a fresh one picks the build up from its notes",
  );
  return openFresh(loopRun, kit, turn, why);
}

/**
 * Whether a lead the host refused because another session holds its lock (`folderBusy`: for an open
 * Loop's lead, another chat's turn in the game folder) waits once more: until the lock is free, never
 * under a Stop or a pause Genex made. Its turn has not begun: a claim of it speaks for the turn that
 * may begin.
 */
async function waitsForFolder(loopRun: LoopRun, kit: TurnKit): Promise<boolean> {
  const stopped = () => loopRun.ctx.cancelled === true || Boolean(loopRun.open?.halted);
  if (stopped()) return false;
  await kit.clock.sleep(BUSY_RETRY_MS);
  // A Stop or a pause during the wait: the run's Stop freed the folder, and the next ask would be seated.
  if (stopped()) return false;
  noteTurnEnds(loopRun.state);
  return true;
}

/** The lead's session asked this turn's message; a turn that came back failed on an outage is thrown as one. */
async function askSession(loopRun: LoopRun, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  const { talk } = kit;
  // An open Loop Genex paused (its app couldn't be brought back), or one the person stopped, opens no new session: a retry included.
  const refused = openSessionRefused(loopRun);
  if (refused) return refused;
  const result = await talk.session(turn.prompt, talk.sessionId, turn.said);
  if (!endedOnOutage(result)) return result;
  throw Object.assign(new Error(String(result.errorText)), { kind: EngineFailure.Unavailable });
}

/**
 * The run's ctx as the outage ladder reads it: an open Loop's wait also ends once Genex pauses the
 * Loop (`open.halted`, its app couldn't be brought back), never after the rest of that wait. A web
 * Loop's ladder reads the run's ctx as it always did.
 */
function patienceCtx(loopRun: LoopRun): HarnessCtx {
  const open = loopRun.open;
  if (!open || !leadsOpenLoop(loopRun)) return loopRun.ctx;
  const ctx = loopRun.ctx;
  return Object.create(ctx, {
    cancelled: { get: () => ctx.cancelled === true || Boolean(open.halted) },
  }) as HarnessCtx;
}

/**
 * The lead's session asked, with a provider outage waited out on the run's outage ladder, on the
 * Loop's own clock: an overloaded gateway on one wake used to end the whole run — workers stopped,
 * head landed, run reported done. What the ladder cannot outlast still fails.
 */
function patientAsk(loopRun: LoopRun, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  return withProviderPatience(patienceCtx(loopRun), () => askSession(loopRun, kit, turn), {
    clock: kit.clock,
    delays: outageDelays(loopRun.run),
    label: "the lead's provider",
    onWait: ({ wait, error }) =>
      loopRun.decision(
        `the lead's provider failed (${error}); asking it again in ${Math.ceil(wait / SECOND_MS)} s`,
        "the lead's provider is briefly down, so the studio waits and asks again; the builders keep working",
      ),
  });
}

/** `patientAsk`, and for a lead refused because another session holds its lock, asked again each time it may wait for it (`waitsForFolder`). */
async function patientSession(loopRun: LoopRun, kit: TurnKit, turn: TurnAsk): Promise<Partial<DelegateResult>> {
  for (;;) {
    try {
      return await patientAsk(loopRun, kit, turn);
    } catch (err) {
      if (!folderBusy(err) || !(await waitsForFolder(loopRun, kit))) throw err;
    }
  }
}

/**
 * One delegation of the lead's session, or a fresh session when its own is lost — or when a later
 * turn has none to resume (a fresh one that met the engine's limit before it began). A failure on
 * the first turn is the run's (the crash close); on a later one it is a failed turn — and so is a
 * first turn whose wait for its busy lock a Stop or a pause ended: the run closes on its own terms.
 * A first turn cut short for the user's words is no failure at all (`lineWatchedSession`).
 */
async function sessionOrFresh(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  const { talk } = kit;
  const failed = async (err: any): Promise<Partial<DelegateResult>> => {
    if (await pauseOnProvider(loopRun, err, kit.clock.now())) return failedTurn(err);
    if (wake.turns === 1 && !folderBusy(err)) throw err;
    return failedTurn(err);
  };
  if (!talk.sessionId && wake.turns > 1) return openFresh(loopRun, kit, turn, SESSION_LOST_WHY.noSession).catch(failed);
  let result: Partial<DelegateResult>;
  try {
    result = await patientSession(loopRun, kit, turn);
  } catch (err: any) {
    const why = lostSessionWhy(talk, err);
    if (!why) return failed(err);
    return freshSession(loopRun, wake, kit, turn, why).catch(failed);
  }
  if (result?.stopReason !== StopReason.ContextOverflow) return result;
  return freshSession(loopRun, wake, kit, turn, SESSION_LOST_WHY.contextOverflowed).catch(failed);
}

/** A turn Genex ended because the open Loop paused: it never opened a session. */
const haltedTurn = (why: string): Partial<DelegateResult> => ({
  ok: false,
  stopReason: StopReason.Stopped,
  errorText: why,
});

/** Why the person stopped a turn that never opened a session. */
const STOPPED_BY_THE_USER = "stopped by the user";

/**
 * The turn an open Loop's lead gets in place of a new session: Genex paused the Loop (its app couldn't
 * be brought back), or the person pressed Stop (a session in the folder has Edit and Bash and would work
 * on under it); null while it may open one. A web Loop's sessions are left as they always were.
 */
function openSessionRefused(loopRun: LoopRun): Partial<DelegateResult> | null {
  if (loopRun.open?.halted) return haltedTurn(loopRun.open.halted);
  if (leadsOpenLoop(loopRun) && loopRun.ctx.cancelled === true) return haltedTurn(STOPPED_BY_THE_USER);
  return null;
}

/** One turn of the lead's session. A turn that works on its message has heard what that message told it. */
async function oneTurn(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  prompt: string,
  from?: MessageFrom,
): Promise<Partial<DelegateResult>> {
  wake.turns += 1;
  // A claim made in this turn is checked within it (open/finish.ts `turnLost`).
  noteTurnEnds(loopRun.state);
  const turn: TurnAsk = { prompt, said: saidWith(wake.promptWords, from) };
  const result = await watchedSession(loopRun, wake, kit, turn);
  noteTurnOver(loopRun.state);
  await settleTold(wake, result);
  await kit.talk.keep(result);
  return result;
}

/**
 * The user's words a turn's message told: heard once the turn works on it, or answers; owed to the
 * next message when it failed first (an error, a limit) — unless it was cut before it read it, and
 * is asked that same message again (`takeTurn`). A failed turn is followed by the wrap-up or the
 * close (`afterTurn`), so owed words are said at most once more.
 */
async function settleTold(wake: WakeState, result: Partial<DelegateResult>): Promise<void> {
  const worked = result?.ok === true || startedWorking(result);
  if (!worked && wake.cut) return;
  if (worked) await wake.line?.heardThrough(wake.promptThrough);
  else wake.owed.unshift(...wake.promptWords);
  wake.promptWords = [];
}

/** Did the session read its message before it ended: it has a session and took a turn. */
const startedWorking = (result: Partial<DelegateResult>): boolean =>
  Boolean(result?.sessionId) && (result?.turns ?? 0) > 0;

/**
 * One turn of the lead's, and its resumptions. A turn cut short to hand the lead the user's words
 * is resumed at once in the same session with their words alone, as they wrote them — or, cut
 * before it read its message, asked that message again with their words after it. A cut is never
 * a failed turn.
 */
async function takeTurn(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  prompt: string,
): Promise<Partial<DelegateResult>> {
  // One turn to the game's plugins, its resumptions included: its start and its end name it alike.
  const moment = turnScope(loopRun, wake);
  const held = await heldTurn(loopRun, wake, kit, prompt, moment);
  if (held) return held;
  const first = wake.heldFirst;
  wake.heldFirst = undefined;
  let asked = first ? `${first}\n\n${prompt}` : prompt;
  let result = await oneTurn(loopRun, wake, kit, asked);
  while (wake.cut && !loopRunOver(loopRun)) {
    wake.cut = false;
    if (!startedWorking(result)) {
      asked = await askAgain(loopRun, wake, asked);
      result = await oneTurn(loopRun, wake, kit, asked);
      continue;
    }
    const resume = await resumeWords(loopRun, wake);
    asked = resume.prompt;
    result = await oneTurn(loopRun, wake, kit, asked, resume.from);
  }
  wake.cut = false;
  await fireHooks(loopRun.ctx, loopRun.game, HookEvent.TurnEnd, moment);
  return result;
}

/**
 * What a turn cut short for the chat's messages is resumed with: the leading ones of one sender, as
 * written — the person's, or Genex's own — so a prompt says who wrote all of it. The rest are owed
 * to the turn it resumes, which is handed them at once (`watchTurn`), and are not counted heard
 * until it reads them.
 */
async function resumeWords(loopRun: LoopRun, wake: WakeState): Promise<{ prompt: string; from: MessageFrom }> {
  const words = await tellUser(loopRun, wake);
  const genex = words.length > 0 && !fromThePerson(words[0] ?? {});
  const other = words.findIndex((one) => fromThePerson(one) === genex);
  const now = other < 0 ? words : words.slice(0, other);
  if (now.length < words.length) {
    wake.owed.push(...words.slice(now.length));
    wake.promptWords = now;
    wake.promptThrough = 0;
  }
  return { prompt: textsOf(now).join(WORDS_APART), from: genex ? MessageFrom.Genex : MessageFrom.Person };
}

/** A lead's turn as Genex's moments name it: the run, and the turn's number. */
function turnScope(loopRun: LoopRun, wake: WakeState): HookScope {
  return { ...runMoment(loopRun), turn: String(wake.turns + 1) };
}

/**
 * A lead's turn a plugin of the game holds back before it starts: asked again after a wait
 * (turn-hold.ts) for as long as the plugin holds it, never counted as an idle turn. Null once the
 * turn may start. A turn the run can't wait for (its wrap-up, a Stop) is a failed turn with the
 * hold's reason: the lead hears why, the user's words the message carried are said again then, and a
 * first message (the brief) opens the next one.
 */
async function heldTurn(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  prompt: string,
  moment: HookScope,
): Promise<Partial<DelegateResult> | null> {
  let held: HeldBack | null = null;
  const ask = async () => {
    const report = await fireHooks(loopRun.ctx, loopRun.game, HookEvent.TurnStart, moment);
    held = report.blocked;
    return report.blocked?.reason ?? null;
  };
  const cantWait = () => wake.wrapping || loopRunOver(loopRun);
  const reason = await whileTurnHeld(ask, kit.clock, cantWait);
  if (reason === null) return null;
  if (wake.turns === 0) wake.heldFirst ??= prompt;
  wake.owed.unshift(...wake.promptWords);
  wake.promptWords = [];
  loopRun.note(HOOK_PROMPTS.turnHeld(reason));
  // The failed turn's words reach the person: Genex's own hold in theirs, never the agents'.
  return heldTurnResult(turnsHeldWords(held ?? { reason }));
}

/** A turn cut before it read its message is asked it again — its words and all — with the user's newer words after it. */
async function askAgain(loopRun: LoopRun, wake: WakeState, asked: string): Promise<string> {
  const carried = wake.promptWords;
  const userSays = await tellUser(loopRun, wake);
  wake.promptWords = [...carried, ...userSays];
  return [asked, sinceThen({ userSays: textsOf(userSays), happened: [] })].filter(Boolean).join("\n\n");
}

/**
 * A turn with a session to resume may be cut short for the user's words — the first too, whose
 * session has read its brief or is asked it again (`askAgain`): an engine that cannot read input
 * mid-turn would otherwise hear nothing for a whole open Loop turn. Never one with no session yet
 * (a fresh lead's first: a cut would leave nothing to resume), the wrap-up, a turn whose run is
 * already over (its `finish` may be under way), or one inside a tool call — cut there, the lead
 * never gets the call's answer (tools.ts counts them).
 */
function mayCut(loopRun: LoopRun, wake: WakeState, kit: TurnKit): boolean {
  const resumable = Boolean(kit.talk.sessionId);
  const inCall = (loopRun.toolsInFlight ?? 0) > 0;
  return resumable && !inCall && !wake.wrapping && !loopRunOver(loopRun);
}

/**
 * What a turn under way was handed to read at its next step, by the id it went in under: the words,
 * and how many of the chat's messages the line had been handed then.
 */
type Handed = Map<string, { said: Said; through: number }>;

/**
 * Hand the chat's messages to the lead's turn under way (`engine.steer`, addressed by the run),
 * each as written, with its pictures and its sender: an engine that reads input mid-turn takes
 * them at its next step (`handed`, settled against what the turn says it read; only the last
 * counts them all heard, since a session reads them in order); one that cannot is cut short when
 * `mayCut`, and resumed with them (`wake.cut`) — asked with `interrupt: false` otherwise. Messages
 * neither took open the lead's next message.
 */
async function handMidTurn(loopRun: LoopRun, wake: WakeState, kit: TurnKit, handed: Handed, id: string): Promise<void> {
  // A run that is over hears nothing more: what was sent stays untold rather than said to no one.
  if (loopRunOver(loopRun)) return;
  const { words, through } = await userWords(loopRun, wake);
  if (!words.length) return;
  const messages = words.map((said, at) => ({ id: `${id}_${at + 1}`, ...said }));
  const answer = await loopRun.ctx
    .call(HostMethod.EngineSteer, {
      threadId: loopRun.threadId,
      into: loopRun.run.runId,
      messages,
      interrupt: mayCut(loopRun, wake, kit),
    })
    .catch(() => null);
  const accepted = new Set(answer?.accepted ?? []);
  for (const [at, { id: sent, ...said }] of messages.entries()) {
    if (answer?.how === SteerDelivery.Native && accepted.has(sent))
      handed.set(sent, { said, through: at === messages.length - 1 ? through : 0 });
    else wake.owed.push(said);
  }
  if (answer?.how === SteerDelivery.Interrupt && accepted.size) wake.cut = true;
}

/**
 * Watch a session call under way for the user's words (live chat): at once, then each time a
 * message is handed to the lead, until the call ends or it is cut short for them.
 */
function watchTurn(loopRun: LoopRun, wake: WakeState, kit: TurnKit, line: LeadLine) {
  const handed: Handed = new Map();
  let over = false;
  let count = 0;
  let end = () => {};
  const ended = new Promise<void>((resolve) => {
    end = resolve;
  });
  const watching = (async () => {
    while (!over && !wake.cut) {
      const next = line.heard();
      await handMidTurn(loopRun, wake, kit, handed, `lead_${wake.turns}_${++count}`);
      await Promise.race([next, ended]);
    }
  })();
  const stop = async (): Promise<void> => {
    over = true;
    end();
    await watching.catch(() => {});
  };
  return { handed, stop };
}

/**
 * A web lead's session call: the news a resting lead would be woken by — a worker's or a job's end —
 * said into its turn as it comes (turn-news.ts).
 */
async function webWatchedSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  // On the wall clock's timers, never the wake loop's (a loop clock that answers at once would spin
  // this watch without yielding to the session it watches), and never holding the process open.
  const news = watchTurnNews(loopRun, { clock: OPEN_WALL_CLOCK, turn: wake.turns });
  let result: Partial<DelegateResult> | undefined;
  try {
    result = await lineWatchedSession(loopRun, wake, kit, turn);
    return result;
  } finally {
    await news.stop();
    news.settle(result);
  }
}

/**
 * One session call, watched while it runs: for the user's words (live chat) and for the news a
 * resting lead would be woken by (open/news.ts, turn-news.ts).
 */
async function watchedSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  if (!leadsOpenLoop(loopRun)) return webWatchedSession(loopRun, wake, kit, turn);
  const pollJobs = () => watchJobs(loopRun, wake, kit.clock.now());
  const news = watchOpenTurn(loopRun, { clock: kit.clock, turn: wake.turns, pollJobs });
  let result: Partial<DelegateResult> | undefined;
  try {
    result = await lineWatchedSession(loopRun, wake, kit, turn);
    return result;
  } finally {
    await news.stop();
    news.settle(result);
  }
}

/** One session call, watched for the user's words while it runs; what it read is heard, what it did not is owed. */
async function lineWatchedSession(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  turn: TurnAsk,
): Promise<Partial<DelegateResult>> {
  if (!kit.line) return sessionOrFresh(loopRun, wake, kit, turn);
  const watch = watchTurn(loopRun, wake, kit, kit.line);
  let result: Partial<DelegateResult> | undefined;
  try {
    result = await sessionOrFresh(loopRun, wake, kit, turn);
    return result;
  } catch (err) {
    // A first turn's failure is the run's (`sessionOrFresh`) — unless it was cut short for the
    // user's words before its session began: then it is asked again (`takeTurn`). The watch settles
    // first, since the host's answer to the cut may come after the failure the cut caused.
    await watch.stop();
    if (!wake.cut) throw err;
    result = failedTurn(err);
    return result;
  } finally {
    await watch.stop();
    let read = 0;
    for (const [id, told] of watch.handed) {
      if (result?.steered?.includes(id)) read = Math.max(read, told.through);
      else wake.owed.push(told.said);
    }
    await kit.line.heardThrough(read);
  }
}

/** The journal keeps the loop's own state and the run's record (loop-run.ts `saveJournal`) as they stand now. */
async function keepWake(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  journalWake(loopRun, wake);
  wake.journaledSeq = loopRun.logSeq;
  wake.journaledAt = now;
  await loopRun.saveJournal();
}

/**
 * The lead rests: its own lines up to here are quiet, the journal holds what a restart needs, and
 * a round that lands from now on is saved with the wake it causes (`run.resting`).
 */
async function rest(loopRun: LoopRun, wake: WakeState, now: number): Promise<void> {
  wake.asleepFromSeq = loopRun.logSeq;
  wake.asleepSince = now;
  loopRun.resting = true;
  // The run's jobs are read again at once: a job the turn started is at work.
  loopRun.jobsReadAt = null;
  await keepWake(loopRun, wake, now);
}

/** One turn of the lead's, then what waits for its end before the next (an open Loop's `afterTurn`). */
async function turnThenBetween(
  loopRun: LoopRun,
  wake: WakeState,
  kit: TurnKit,
  prompt: string,
): Promise<Partial<DelegateResult>> {
  const result = await takeTurn(loopRun, wake, kit, prompt);
  if (typeof loopRun.afterTurn === "function" && !loopRunOver(loopRun)) await loopRun.afterTurn();
  return result;
}

/**
 * When the lead is woken next: at once for the wrap-up a turn's end started, else once something is
 * due while it rests (null: the run ended under it, or nothing is at work and nothing would wake it).
 */
async function dueAfter(loopRun: LoopRun, wake: WakeState, kit: TurnKit, verdict: TurnVerdict): Promise<Wake | null> {
  if (verdict.next === TurnEnd.WrapUp) return wrapUpWake(loopRun, wake, kit);
  await rest(loopRun, wake, kit.clock.now());
  const due = await sleepUntilDue(loopRun, wake, kit);
  loopRun.resting = false;
  return due;
}

/** The one wrap-up the person's Finish or a failed turn starts: at once, told whatever else is due now. */
async function wrapUpWake(loopRun: LoopRun, wake: WakeState, kit: TurnKit): Promise<Wake> {
  const now = kit.clock.now();
  await collect(loopRun, wake, now);
  const due = nextWake(wakeView(loopRun, wake, now));
  const also = due && due.at <= now ? due.reasons : [];
  return { at: now, reasons: [...new Set([...also, WakeCause.WrapUp])] };
}

/**
 * The run as a series of the lead's turns. The first opens with the brief and the rules; each
 * later one is a wake with a digest; the wrap-up, when one starts, is the last. Returns when the run
 * is over for the lead — finished, stopped, paused on a limit, wrapped up, or done with nothing at
 * work — and the caller closes what it left open.
 */
export async function runWakeLoop(
  loopRun: LoopRun,
  talk: DirectorTalk,
  brief: () => string,
  clock: WakeClock = SYSTEM_CLOCK,
  line: LeadLine | null = null,
): Promise<WakeOutcome> {
  // The run's tools read the time on this clock (`wrap_up` stamps the person's ask with it).
  keepRunClock(loopRun, () => clock.now());
  // A resumed run takes back what its journal kept of the loop: the wake cap.
  const restored = resumedFromJournal(loopRun)
    ? restoredWake(loopRun.priorJournal?.director?.wake, clock.now())
    : undefined;
  const wake = newWakeState(restored);
  const kit: TurnKit = { talk, brief, clock, line };
  // This loop answers for what its lead hears of the chat: what it never hears goes back at the end.
  wake.line = line;
  line?.attend();
  // The parts the lead calls (the plan hold, worker_start) answer a run the wake loop drives
  // with "end your turn"; a kept older director.ts runs the long turn and never marks its run.
  loopRun.waking = true;
  const first = await firstPrompt(loopRun, wake, brief, clock.now());
  let result = await turnThenBetween(loopRun, wake, kit, first);
  for (;;) {
    const verdict = afterTurn(await turnFacts(loopRun, wake, result, clock.now()));
    if (verdict.next === TurnEnd.Close) break;
    settleTurn(wake, verdict, result);
    const due = await dueAfter(loopRun, wake, kit, verdict);
    if (!due) break;
    // A sign-in a worker or a judge lost while the lead slept pauses the run before it is woken.
    if (await pauseOnLostSignIn(loopRun, clock.now())) break;
    const prompt = await wakePrompt(loopRun, wake, due, clock);
    result = await turnThenBetween(loopRun, wake, kit, prompt);
  }
  journalWake(loopRun, wake);
  return { result, wrapCause: wake.wrapCause, failed: wake.failed };
}

/**
 * Put the wake loop's own state on the journal (`journal.director.wake`, journal.ts `wakeRecord`),
 * and the run's record with it: a kept loop-run.ts from before the full journal saves without
 * writing the record (`recordLoopRun` is idempotent). The caller saves it.
 */
export function journalWake(loopRun: LoopRun, wake: WakeState): void {
  const director = loopRun.journal?.director;
  if (!director) return;
  recordLoopRun(loopRun);
  director.wake = wakeRecord(wake);
}
