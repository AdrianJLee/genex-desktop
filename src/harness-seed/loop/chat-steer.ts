/**
 * The chat's current turn as one engine session the person's messages reach while it works
 * (steer). The queue decides what joins the turn (message-queue.ts `SteerHandle`), the host how
 * the running session takes it (`engine.steer`), and this runner the legs: a session that cannot
 * read a message mid-turn is interrupted and resumed with it in front.
 *
 * Generic on purpose: whichever session is the chat's current turn — the contractor (a Loop
 * chat's too, and the chat's own session after a run) — runs through here unchanged. A runner that can go on with another message's settings hands its
 * `switches` (steer-switch.ts): a message that changes how the turn runs then joins it too, and the
 * next leg runs on its settings; a slash command runs as a leg of its own, then the turn carries on.
 */
import { isResumeFailure } from "./chat-session.ts";
import { type QueueAction, type SteerHandle, textsOf, WORDS_APART, withWords } from "./message-queue.ts";
import { fromThePerson, MessageFrom, SteerDelivery } from "./steer-delivery.ts";
import { isSlashText, type OpenOptions } from "./steer-switch.ts";
import { afterCommandPrompt, SWITCH_NOTES, switchedTurnPrompt } from "./steer-switch-prompts.ts";
import { EngineFailure, StopReason } from "./outage.ts";
import type { DelegateImage, DelegateResult } from "../types/host-api.d.ts";

/**
 * Whether an engine's answer says the session it was asked to resume does not exist: a session
 * another account made, or one the engine never saved. Here, not in chat-session.ts: an agent's kept
 * copy of that module would lack it. Narrower than `isResumeFailure` (chat-session.ts), since an
 * answer's words (a cap's "press Resume") are not an error's.
 */
function isLostSession(text: unknown): boolean {
  return /no conversation found|conversation not found|session (id )?not found/i.test(String(text ?? ""));
}

/** One engine call of the turn: the prompt it sends, the session it resumes, and its pictures. */
interface Leg {
  prompt: string;
  resume: string | null;
  images: DelegateImage[];
  /** A slash command run as a leg of its own: its prompt is the command alone. */
  command?: boolean;
  /**
   * Who wrote all of the prompt: Genex (its message, or the turn's: `SteeredCallOptions.from`), or
   * the person (their words alone). Absent: a brief, the person's words joined to it as written.
   */
  from?: MessageFrom;
}

/**
 * Runs the session once — an `engine.delegate` carrying `chatTurn`, so the host knows which session
 * answers the chat — saying who wrote the prompt when it was not a brief.
 */
export type SessionCall = (
  prompt: string,
  resume: string | null,
  images: DelegateImage[],
  from?: MessageFrom,
) => Promise<DelegateResult>;

/** How the turn's legs run once a message changed it (`TurnSwitches.apply`). */
export interface LegSwitch {
  /** The call every leg makes from now on: its engine, model, effort and tools. */
  call: SessionCall;
  /** The first prompt for a new session from now on. */
  fresh?: () => string;
  /** The session is another engine's: the next leg starts a new one, told everything the turn was. */
  newSession: boolean;
  /** What changed, in the words the next leg opens with: one line each. */
  notes: string[];
}

/** A runner that goes on with a message's settings when one changes how the turn runs (steer-switch.ts). */
export interface TurnSwitches {
  /** Does this message change how the turn runs now? */
  changes(item: QueueAction): boolean;
  /** Can this turn go on with it at all? One it cannot (another runner's engine) gets a turn of its own. */
  takes(item: QueueAction): boolean;
  /**
   * Does it change the Loop itself (on or off, hours, roles, attached pictures)? Only that
   * outranks a launch or a question the session already recorded; without it, every change does.
   */
  changesLoop?(item: QueueAction): boolean;
  /** Go on with this message's settings: how the legs run from now on. */
  apply(item: QueueAction): Promise<LegSwitch>;
}

/** What the turn's session is started with. */
export interface SteeredCallOptions {
  prompt: string;
  resume?: string | null;
  images?: DelegateImage[];
  call: SessionCall;
  /** The first prompt for a new session when the saved one cannot be resumed. */
  fresh?: () => string;
  /** The runner takes switches: a message that changes how the turn runs joins it too. */
  switches?: TurnSwitches;
  /** Who wrote the message the turn answers, when Genex did: its first leg says so. */
  from?: MessageFrom;
}

/** Everything the turn has been told so far, and how to run one leg of it. */
interface TurnLegs {
  ctx: { readonly cancelled: boolean };
  steer: SteerHandle;
  /** How the legs run: the caller's options, with what a switch changed since. */
  options: SteeredCallOptions;
  run: (leg: Leg) => Promise<DelegateResult>;
  /** Every message put in front of a session this turn, in the order it was told. */
  told: QueueAction[];
  /** Each leg's result, in order. */
  legs: DelegateResult[];
  /**
   * Handed in a prompt no session has read yet: this leg's, and an earlier leg's cut off before
   * it read its own (its prompt is sent again). A Stop or a failure before they are read puts
   * them back in the queue rather than leaving them recorded as read.
   */
  unread: QueueAction[];
  /** The leg last run, and what it returned. */
  leg: Leg | null;
  last: DelegateResult | undefined;
  /** What the last leg took by being interrupted: the next leg's to deliver. */
  interrupted: QueueAction[];
  /** Slash commands taken and not run yet: each runs as a leg of its own, in the order sent. */
  commands: QueueAction[];
  /**
   * Words owed a leg after this one: those that came with commands, and another sender's than the
   * leg's (`oneSender`: a prompt says who wrote all of it).
   */
  owed: QueueAction[];
  /** The work was cut for a command: once the commands have run, a leg carries it on. */
  carryOn: boolean;
  /** What changed since the last leg (a switch), said as the next leg opens. */
  notes: string[];
  /** The next leg starts a new session: the turn moved to another engine. */
  newSession: boolean;
}

/** The words among what the turn was told: a slash command is run, never quoted to a new session. */
const wordsOf = (items: readonly QueueAction[]): QueueAction[] => items.filter((item) => !isSlashText(item.text));
const stillsOf = (items: readonly QueueAction[]): DelegateImage[] => items.flatMap((item) => item.stills ?? []);

/** Who wrote the turn's message, as a leg carries it: nothing for the person's own. */
const fromOf = (options: SteeredCallOptions): Pick<Leg, "from"> => (options.from ? { from: options.from } : {});

/**
 * The leading messages a leg says as one sender's — Genex's (`genex`), or the person's — with the
 * rest owed to the legs after it, in the order sent: none joins while older words are owed.
 */
function oneSender(owed: QueueAction[], items: readonly QueueAction[], genex: boolean): QueueAction[] {
  const other = owed.length ? 0 : items.findIndex((item) => fromThePerson(item) === genex);
  if (other < 0) return [...items];
  owed.push(...items.slice(other));
  return items.slice(0, other);
}

/** The session was cut off before or as it started (the host's interrupt). */
const isAborted = (err: unknown): boolean => (err as { kind?: unknown } | null)?.kind === EngineFailure.Aborted;

/**
 * Run the chat's current turn. While it runs, the queue hands this turn what is sent
 * (`steer.open`) and the host puts it in: read mid-turn by an engine that can (recorded where it
 * was read), or by cutting the session at its next step, which this resumes with those messages in
 * front — on the settings of a message that changed how the turn runs, when the runner takes
 * switches. Messages sent before the session starts join its first prompt. Without a steer handle
 * the session runs once, as it always did.
 */
export async function steeredCall(
  ctx: { readonly cancelled: boolean },
  steer: SteerHandle | null | undefined,
  options: SteeredCallOptions,
): Promise<DelegateResult> {
  const told: QueueAction[] = [];
  const owed: QueueAction[] = [];
  // A copy: a switch changes how the legs run from then on, never the caller's options.
  const seat: SteeredCallOptions = { ...options };
  const run = (leg: Leg) => callOrStartFresh(seat, told, owed, leg);
  if (!steer)
    return run({
      prompt: options.prompt,
      resume: options.resume ?? null,
      images: options.images ?? [],
      ...fromOf(options),
    });
  const turn: TurnLegs = {
    ctx,
    steer,
    options: seat,
    run,
    told,
    legs: [],
    unread: [],
    leg: null,
    last: undefined,
    interrupted: [],
    commands: [],
    owed,
    carryOn: false,
    notes: [],
    newSession: false,
  };
  try {
    return await steered(turn);
  } finally {
    await steer.done();
  }
}

/**
 * One leg; a saved session that cannot be resumed — the engine threw, or answered that it has no
 * such session (another account's, one never saved) — is started afresh with everything the turn
 * was told (`freshLeg`), so the chat never stays stuck on a session that is gone.
 */
async function callOrStartFresh(
  options: SteeredCallOptions,
  told: readonly QueueAction[],
  owed: QueueAction[],
  leg: Leg,
): Promise<DelegateResult> {
  const startFresh = () => {
    const fresh = freshLeg(options, told, owed);
    return options.call(fresh.prompt, null, fresh.images, fresh.from);
  };
  let result: DelegateResult;
  try {
    result = await options.call(leg.prompt, leg.resume, leg.images, leg.from);
  } catch (err) {
    if (!leg.resume || !isResumeFailure(err)) throw err;
    return startFresh();
  }
  const lost = Boolean(leg.resume) && !result.ok && isLostSession(result.errorText);
  return lost ? startFresh() : result;
}

/** The turn's legs, until one ends it: its own ending, a Stop, a failure, or a question already asked. */
async function steered(turn: TurnLegs): Promise<DelegateResult> {
  for (;;) {
    const leg = await nextLeg(turn);
    if (!leg) return stopped(turn);
    const outcome: LegOutcome = await turn.run(leg).then(
      (result) => ({ result }),
      (failure: unknown) => ({ failure }),
    );
    const ending = await afterLeg(turn, outcome);
    if (ending) return ending;
  }
}

/** How a leg ended: with the session's result, or with what its call threw. */
type LegOutcome = { result: DelegateResult; failure?: undefined } | { result?: undefined; failure: unknown };

/**
 * The next leg, as its session starts: what joined while it was set up, and what the last leg
 * was cut for, delivered into its prompt — on the settings of a message that changed how the turn
 * runs, and a slash command as a leg of its own. Null after a Stop: nothing runs after it.
 */
async function nextLeg(turn: TurnLegs): Promise<Leg | null> {
  const { steer, told, options } = turn;
  // The last leg was cut to hand the session what came: a command among it cuts the work short.
  const cut = turn.interrupted.length > 0;
  const arrived = steer.inOrder([...turn.interrupted, ...(await steer.open(openOptions(options.switches)))]);
  // A leg cut off before its session read anything: its prompt is sent again, with these after it.
  const forwarded = cutBeforeRead(turn);
  turn.unread = forwarded ? [...turn.unread, ...arrived] : arrived;
  // A Stop between legs: nothing runs after it, and what no session read waits for its own turn.
  if (turn.ctx.cancelled) return null;
  await steer.deliver(arrived, turn.leg ? SteerDelivery.Interrupt : SteerDelivery.Prompt);
  told.push(...arrived);
  const words = await takeSwitches(turn, arrived);
  // A command cut the work short: once the commands have run, the turn carries it on.
  if (cut && turn.commands.length && !turn.leg?.command) turn.carryOn = true;
  // Another engine's new session starts first; the commands run in it after.
  const command = turn.newSession ? null : commandLeg(turn, words, forwarded);
  turn.leg = command ?? legAfter(turn, words, forwarded);
  return turn.leg;
}

/** What the runner says as each session opens: whether it takes switches, and which. */
function openOptions(switches: TurnSwitches | undefined): OpenOptions {
  if (!switches) return {};
  return { switches: true, takes: (item) => switches.takes(item as QueueAction) };
}

/**
 * Go on with the settings of each message that changes how the turn runs, in the order sent (the
 * newest wins), and set its slash commands aside for legs of their own. Returns the words the
 * next leg carries.
 */
async function takeSwitches(turn: TurnLegs, arrived: QueueAction[]): Promise<QueueAction[]> {
  const { switches } = turn.options;
  if (!switches) return arrived;
  const words: QueueAction[] = [];
  for (const item of arrived) {
    if (isSlashText(item.text)) {
      turn.commands.push(item);
      continue;
    }
    if (switches.changes(item)) {
      switchTo(turn, await switches.apply(item));
      // What is sent after it is weighed against its settings.
      turn.steer.follows(item);
    }
    words.push(item);
  }
  return words;
}

/** The legs run on a message's settings from now on: its call, its fresh brief, and what changed. */
function switchTo(turn: TurnLegs, change: LegSwitch): void {
  turn.options.call = change.call;
  if (change.fresh) turn.options.fresh = change.fresh;
  if (change.newSession) turn.newSession = true;
  turn.notes.push(...change.notes);
}

/**
 * The slash command due next, as a leg of its own in the turn's session: its words alone. The turn's
 * own first prompt goes first, and a command waits while work it cut short is owed. The words that
 * came with it wait for the leg that carries on after it. Null when no command is due.
 */
function commandLeg(turn: TurnLegs, words: QueueAction[], forwarded: boolean): Leg | null {
  const { leg } = turn;
  if (!leg) return null;
  // A command cut off before its session read it runs again, unchanged.
  if (forwarded && leg.command) {
    turn.owed.push(...words);
    return leg;
  }
  const command = turn.commands.shift();
  if (!command) return null;
  turn.owed.push(...words);
  return { prompt: String(command.text ?? "").trim(), resume: turn.last?.sessionId ?? null, images: [], command: true };
}

/**
 * Was the last leg cut off before its session read its prompt, so it is sent again? A command may
 * run no model turn of its own (`/compact`): one whose call ended well has run, and only one cut
 * off (or answered nothing) before it worked is sent again.
 */
function cutBeforeRead(turn: TurnLegs): boolean {
  const { leg, last } = turn;
  if (!leg) return false;
  if (!leg.command) return !startedWorking(last);
  return !last?.ok && !startedWorking(last);
}

/** Did this leg's session start working (it read its prompt): it keeps it and reads the messages next. */
function startedWorking(result: DelegateResult | undefined): boolean {
  return Boolean(result?.sessionId && result.turns > 0);
}

/**
 * The prompt, session and pictures of the leg after `turn.leg`, carrying the messages that arrived
 * — those of the leg's own sender; another's go in a leg after it (`oneSender`).
 */
function legAfter(turn: TurnLegs, arrived: QueueAction[], forwarded: boolean): Leg {
  const { steer, options, told, leg, last } = turn;
  const notes = turn.notes.splice(0);
  // Another engine answers now: a new session, told everything the turn was, and what changed.
  if (turn.newSession) return newSessionLeg(turn, notes);
  if (!leg) {
    // Delivered before a restart cut this turn short: its answer starts with them too.
    const lead = [...steer.carried, ...arrived];
    told.unshift(...steer.carried);
    const joined = oneSender(turn.owed, lead, options.from === MessageFrom.Genex);
    return {
      ...withChanges(notes, withWords(options.prompt, joined), options.from),
      resume: options.resume ?? null,
      images: [...(options.images ?? []), ...stillsOf(joined)],
    };
  }
  // A session that had started working keeps it and reads the messages next; one cut off before
  // it read its prompt gets that prompt again, with the messages after it.
  if (forwarded) {
    const joined = oneSender(turn.owed, arrived, leg.from === MessageFrom.Genex);
    return {
      ...withChanges(notes, withWords(leg.prompt, joined), leg.from),
      resume: leg.resume,
      images: [...leg.images, ...stillsOf(joined)],
    };
  }
  return { ...goOnLeg(turn, arrived, notes), resume: last?.sessionId ?? null };
}

/**
 * What the session is resumed with: the words it was cut for, or owed, as written — one sender's,
 * the rest after — or, once commands have run and nothing more was said, Genex's line that they did.
 */
function goOnLeg(
  turn: TurnLegs,
  arrived: QueueAction[],
  notes: readonly string[],
): Pick<Leg, "prompt" | "from" | "images"> {
  const pending = [...turn.owed.splice(0), ...arrived];
  const first = pending[0];
  if (first) {
    const genex = !fromThePerson(first);
    const words = oneSender(turn.owed, pending, genex);
    const from = genex ? MessageFrom.Genex : MessageFrom.Person;
    return { ...withChanges(notes, textsOf(words).join(WORDS_APART), from), images: stillsOf(words) };
  }
  const carryOn = turn.carryOn;
  turn.carryOn = false;
  return { ...withChanges(notes, afterCommandPrompt(carryOn), MessageFrom.Genex), images: [] };
}

/**
 * What changed, in front of a leg's prompt, and who wrote it all: a note is Genex's, so the person's
 * words behind one make a brief. The prompt alone, as `from` wrote it, when nothing changed.
 */
function withChanges(notes: readonly string[], prompt: string, from?: MessageFrom): Pick<Leg, "prompt" | "from"> {
  if (!notes.length) return { prompt, ...(from ? { from } : {}) };
  const keeps = from && from !== MessageFrom.Person;
  return { prompt: switchedTurnPrompt(notes, prompt), ...(keeps ? { from } : {}) };
}

/**
 * A new session's first leg: the fresh brief, and what the turn was told that the brief's sender
 * wrote (on Genex's turn, nothing of the person's); the rest goes in the legs after it.
 */
function freshLeg(options: SteeredCallOptions, told: readonly QueueAction[], owed: QueueAction[]): Leg {
  // Everything owed is in `told` already: the new session hears it from here.
  owed.length = 0;
  const joined = oneSender(owed, wordsOf(told), options.from === MessageFrom.Genex);
  return {
    prompt: withWords(options.fresh?.() ?? options.prompt, joined),
    resume: null,
    images: [...(options.images ?? []), ...stillsOf(joined)],
    ...fromOf(options),
  };
}

/** A leg in a new session: the fresh brief, everything the turn was told, and what changed (`notes`). */
function newSessionLeg(turn: TurnLegs, notes: string[]): Leg {
  const { options, told, steer } = turn;
  turn.newSession = false;
  // The first leg: what a restart carried into this turn is told too.
  if (!turn.leg) told.unshift(...steer.carried);
  turn.carryOn = false;
  const { prompt, from, ...fresh } = freshLeg(options, told, turn.owed);
  return { ...fresh, ...withChanges(notes, prompt, from) };
}

/**
 * Settle a leg that ended: what it read natively is recorded (the queue knows), what it took by
 * being interrupted goes to the next leg. Returns the turn's result when this leg ends the turn,
 * null when the turn goes on.
 */
async function afterLeg(turn: TurnLegs, outcome: LegOutcome): Promise<DelegateResult | null> {
  const { steer, ctx } = turn;
  const { result } = outcome;
  // Read natively → recorded where; taken by interrupting this leg → ours to deliver next.
  turn.interrupted = await steer.close(result);
  turn.last = result;
  const ours = turn.interrupted.length > 0 && !ctx.cancelled && cutForSteer(outcome);
  const recorded = keptCalls(turn, ours, result);
  if (result) turn.legs.push({ ...result, studioToolCalls: recorded ?? [] });
  if (ours && !recorded?.length) return null;
  // The turn ends on a launch or a question it keeps: the change of engine, model or effort it was cut for goes with it.
  if (ours) await followKeptSwitches(turn);
  // Commands are still owed, or what they leave to do: the turn goes on after a leg that ended well.
  if (result?.ok && !ours && !ctx.cancelled && owesLegs(turn)) return null;
  const neverRead = !result || (ctx.cancelled && !(result.turns > 0));
  // A Stop, a leg that ended on its own before the interrupt landed, or a failure: these wait.
  const back = [...(neverRead ? turn.unread : []), ...turn.interrupted, ...owedBack(turn)];
  await steer.requeue(steer.inOrder(once(back)));
  if (!result) throw outcome.failure;
  const ended = merged(turn, result);
  // A Loop chat that had already asked its question or launched has ended its turn: the
  // message waits for the next one (the answer, or the build it launched) instead.
  if (ours) return { ...ended, ok: true, stopReason: StopReason.Completed };
  return ended;
}

/**
 * The launch or question calls a leg recorded that still go out. The Loop changed (the leg was cut
 * for it): they were made on the old Loop, so they are dropped and the session is told so. Any other
 * change keeps them, and the turn goes out on its settings (`followKeptSwitches`).
 */
function keptCalls(turn: TurnLegs, cutForTurn: boolean, result: DelegateResult | undefined) {
  const dropped = cutForTurn && loopSwitched(turn) ? (result?.studioToolCalls ?? []) : [];
  if (!dropped.length) return result?.studioToolCalls;
  turn.notes.push(SWITCH_NOTES.dropped(dropped.map((call) => call.name)));
  return [];
}

/**
 * The turn ends on what its leg recorded (a launch, a question): go on with the settings of each
 * message it was cut for that changes them, in the order sent, so what it recorded goes out on the
 * newest. Their words still wait for whoever answers next (the build's lead, or a turn of their own).
 */
async function followKeptSwitches(turn: TurnLegs): Promise<void> {
  const { switches } = turn.options;
  if (!switches) return;
  for (const item of turn.interrupted) {
    if (isSlashText(item.text) || !switches.changes(item)) continue;
    switchTo(turn, await switches.apply(item));
    turn.steer.follows(item);
  }
}

/** Each message once, in the order first met: a command is both taken and unread. */
function once(items: readonly QueueAction[]): QueueAction[] {
  return items.filter((item, at) => items.indexOf(item) === at);
}

/** Commands taken and not run, words owed a leg, or work commands cut short: a leg is owed. */
function owesLegs(turn: TurnLegs): boolean {
  return turn.commands.length > 0 || turn.owed.length > 0 || turn.carryOn;
}

/**
 * What the turn took and never ran, once it ends: its commands and the words owed a leg. Each
 * waits for a turn of its own.
 */
function owedBack(turn: TurnLegs): QueueAction[] {
  turn.carryOn = false;
  return [...turn.commands.splice(0), ...turn.owed.splice(0)];
}

/** Does a message the last leg was cut for change the Loop the turn runs on (any setting, for a runner that cannot say)? */
function loopSwitched(turn: TurnLegs): boolean {
  const { switches } = turn.options;
  if (!switches) return false;
  const changesLoop = (item: QueueAction) => switches.changesLoop?.(item) ?? true;
  return turn.interrupted.some((item) => !isSlashText(item.text) && switches.changes(item) && changesLoop(item));
}

/** The leg ended because the host interrupted it to hand it messages, not on its own. */
function cutForSteer(outcome: LegOutcome): boolean {
  if (!outcome.result) return isAborted(outcome.failure);
  return !outcome.result.ok && outcome.result.stopReason === StopReason.Stopped;
}

/** The turn's answer: the last leg's, with every leg's turns, recorded launch and question calls and reads. */
function merged(turn: TurnLegs, result: DelegateResult): DelegateResult {
  return {
    ...result,
    turns: turn.legs.reduce((n, leg) => n + (leg.turns ?? 0), 0),
    studioToolCalls: turn.legs.flatMap((leg) => leg.studioToolCalls ?? []),
    steered: turn.legs.flatMap((leg) => leg.steered ?? []),
  };
}

/** Stopped between legs: what no session read goes back to the queue, and the turn reads as a Stop. */
async function stopped(turn: TurnLegs): Promise<DelegateResult> {
  const { steer, options } = turn;
  await steer.requeue(steer.inOrder(once([...turn.unread, ...owedBack(turn)])));
  await steer.close();
  const resume = options.resume ?? null;
  const last: DelegateResult = turn.legs.at(-1) ?? {
    ok: false,
    summary: "",
    usage: {},
    turns: 0,
    engine: "",
    ...(resume ? { sessionId: resume } : {}),
  };
  return { ...merged(turn, last), ok: false, stopReason: StopReason.Stopped };
}
