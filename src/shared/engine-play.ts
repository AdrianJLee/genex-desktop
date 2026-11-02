/**
 * Playing a game inside its engine's editor (`TargetRuntime.Editor`): the harness tools an engine
 * plugin provides so the studio's `computer` tool can play its games the
 * way it plays a web game — a picture of what the player sees, keys held on the game's own clock,
 * and the game's state the studio checks goals against. The tools are the plugin's, by these names
 * after `<plugin>__`; the studio's target (`main/core/editor-play-target.ts`) stays engine-agnostic.
 * Unreal's use its engine link and editor helper; Unity's use explicit project facts and Pipeline.
 *
 * Every tool is a harness step (`audience: "harness"`) that needs the plugin's editor lock for its
 * call: the person first, any other caller in turn.
 */

import {
  ClockLevel,
  EDITOR_CAPABILITIES,
  PointerLevel,
  StateLevel,
  type TargetCapabilities,
} from "./computer-target.ts";

/** The play tools, by their names after `<plugin>__`. Wire values: never rename. */
export const EnginePlayTool = {
  /** Start play (or join the play already running; `fresh`: start it over, as a judge needs): answers the view's size. */
  Open: "play-open",
  /** Hold keys together for a time on the game's own clock, then let go: answers once that time has passed. */
  Input: "play-input",
  /** A picture of what the player sees: answers a JPEG or a PNG, as its `mime` says. */
  Shot: "play-shot",
  /** The game's state: the player and the game's own numbers, as the engine plugin reads them. */
  State: "play-state",
  /** Stand the play still (`paused: true`) or let it run: the studio holds a judge's game still between moves. */
  Pause: "play-pause",
  /** Let go of every key and end the play the session started. */
  Close: "play-close",
} as const;
export type EnginePlayTool = (typeof EnginePlayTool)[keyof typeof EnginePlayTool];

/**
 * The fields of a `play-state` answer that move with time or echo the input, never with what the
 * player did: the game's clock, its frame count and rate, and the keys held.
 */
export const EnginePlayStateField = {
  GameSeconds: "gameSeconds",
  Frame: "frame",
  Fps: "fps",
  Held: "held",
  /** What the play's bug detectors told since the last read. */
  Findings: "findings",
} as const;
export type EnginePlayStateField = (typeof EnginePlayStateField)[keyof typeof EnginePlayStateField];

/**
 * What a play's bug detectors notice, by kind. Wire values: the Unreal helper's detectors
 * (`genex_play/detect.py`) send the same spellings.
 */
export const EnginePlayFindingCode = {
  /** The player's position is not a number. */
  Nan: "nan",
  /** The player's pawn vanished: dead, destroyed or fallen out of the world. */
  PlayerGone: "player-gone",
  /** The player has been falling for seconds without landing. */
  LongFall: "long-fall",
  /** One frame froze for most of a second or more. */
  Hitch: "hitch",
  /** The player moved across the level in one frame. */
  Teleport: "teleport",
  /** A character near the player moves along without stepping: its feet keep still. */
  Sliding: "sliding",
  /** A character near the player stands with its arms straight out: no animation plays on it. */
  TPose: "t-pose",
  /** A character near the player stands well above the ground under it. */
  Floating: "floating",
  /** A character near the player has its feet well into the ground. */
  Sunk: "sunk",
} as const;
export type EnginePlayFindingCode = (typeof EnginePlayFindingCode)[keyof typeof EnginePlayFindingCode];

/** One finding a play's detectors told: its kind, what was seen, when (game seconds), and how many times so far. */
export interface EnginePlayFinding {
  code: EnginePlayFindingCode;
  detail: string;
  gameSeconds: number | null;
  count: number;
}

const FINDING_CODES: ReadonlySet<string> = new Set(Object.values(EnginePlayFindingCode));

function isFindingCode(value: unknown): value is EnginePlayFindingCode {
  return typeof value === "string" && FINDING_CODES.has(value);
}

/** One listed finding, when it is well formed and of a known kind; null otherwise. */
function findingOf(item: unknown): EnginePlayFinding | null {
  if (typeof item !== "object" || item === null) return null;
  const code: unknown = Reflect.get(item, "code");
  const detail: unknown = Reflect.get(item, "detail");
  if (!isFindingCode(code) || typeof detail !== "string") return null;
  const seconds: unknown = Reflect.get(item, "gameSeconds");
  const count: unknown = Reflect.get(item, "count");
  return {
    code,
    detail,
    gameSeconds: typeof seconds === "number" && Number.isFinite(seconds) ? seconds : null,
    count: typeof count === "number" && count > 0 ? count : 1,
  };
}

/** The findings a `play-state` answer carries, the well-formed ones of a known kind; none when it carries none. */
export function findingsOf(state: unknown): EnginePlayFinding[] {
  if (typeof state !== "object" || state === null) return [];
  const listed: unknown = Reflect.get(state, EnginePlayStateField.Findings);
  if (!Array.isArray(listed)) return [];
  return listed.map(findingOf).filter((finding): finding is EnginePlayFinding => finding !== null);
}

/**
 * The play tools an engine plugin may add: `walk` and `look` declared by its play's `walk`, the
 * pilot's two by its `pilot`. Wire values: never rename.
 */
export const EnginePlayOptionalTool = {
  /** Walk the player to a target by itself (`{target, seconds?}`): answers once the walk has ended, as {@link EnginePlayWalked}. */
  Walk: "play-walk",
  /** Turn the player's view onto a target (`{target}`): answers once the turn has ended, as {@link EnginePlayLooked}. */
  Look: "play-look",
  /**
   * Start a pilot: a file of the game's project (`{file, seconds, decide}`) that plays by itself in
   * the engine, every frame, choosing among the moves it names. Answers at once that it started.
   */
  Pilot: "play-pilot",
  /**
   * One step of a running pilot (`{answer?, stop?}`): hands it the decision it asked for (JSON of a
   * {@link PilotAnswer}) and answers how it stands, with its next ask, and its report once it is over.
   */
  PilotStep: "play-pilot-step",
} as const;
export type EnginePlayOptionalTool = (typeof EnginePlayOptionalTool)[keyof typeof EnginePlayOptionalTool];

/** How a walk ended (or stands). Wire values: the Unreal helper's `genex_play/walk.py` sends them. */
export const EnginePlayWalkState = {
  Walking: "walking",
  Arrived: "arrived",
  Stuck: "stuck",
  Stopped: "stopped",
  TimedOut: "timed-out",
  Failed: "failed",
} as const;
export type EnginePlayWalkState = (typeof EnginePlayWalkState)[keyof typeof EnginePlayWalkState];

/** The way a walk took: the level's nav mesh, or the straight line. */
export const EnginePlayWay = { NavMesh: "navmesh", Direct: "direct" } as const;
export type EnginePlayWay = (typeof EnginePlayWay)[keyof typeof EnginePlayWay];

/** How a turn of the view ended (or stands). */
export const EnginePlayLookState = {
  Looking: "looking",
  Looked: "looked",
  Stopped: "stopped",
  TimedOut: "timed-out",
  Failed: "failed",
} as const;
export type EnginePlayLookState = (typeof EnginePlayLookState)[keyof typeof EnginePlayLookState];

/** What `play-walk` answers: how the walk ended, how far from the target, the way, what it tried, and why it stopped. */
export interface EnginePlayWalked {
  state: EnginePlayWalkState;
  target: string;
  way: EnginePlayWay;
  /** The nav mesh reaches only part of the way. */
  partial: boolean;
  distanceM: number | null;
  tried: string[];
  reason: string;
  gameSeconds: number | null;
  /** Degrees the player's body faces off an actor it walked to; null for a point. */
  facingDeg: number | null;
}

/**
 * How a pilot's run ended. Wire values: the Unreal helper's `genex_play/pilot.py` sends them.
 * `broken` is a pilot that could not run (its file, its setup, every look failing).
 */
export const PilotOutcome = {
  Done: "done",
  Failed: "failed",
  Stalled: "stalled",
  TimedOut: "timed-out",
  Stopped: "stopped",
  Broken: "broken",
} as const;
export type PilotOutcome = (typeof PilotOutcome)[keyof typeof PilotOutcome];

/** How a running pilot stands, as `play-pilot-step` says it. Wire values. */
export const PilotPhase = { Piloting: "piloting", Over: "over" } as const;
export type PilotPhase = (typeof PilotPhase)[keyof typeof PilotPhase];

/**
 * One decision a pilot asks for: what the decider reads (`state`: the goal, the facts, each move's
 * facts, what is running, how recent moves went, where the plan stands), the moves to pick between
 * by name with what each does, the pick's instructions, and the pilot's own extra questions (typed
 * as a decision model's: `choice`, `score`, `noul`).
 */
export interface PilotAsk {
  id: number;
  state: Record<string, unknown>;
  moves: Record<string, string>;
  instructions: string;
  questions: Record<string, unknown>;
}

/** A decider's answer to one ask: a probability for each move, its answers to the extra questions, and how long it took. */
export interface PilotAnswer {
  id: number;
  probabilities: Record<string, number>;
  answers: Record<string, unknown>;
  ms: number;
}

/** What one move of a pilot did over a run. */
export interface PilotMoveTally {
  name: string;
  started: number;
  worked: number;
  failed: number;
  /** Median game seconds it ran; null before it ended once. */
  medianSeconds: number | null;
}

/** Who decided a pilot's moves: the fast decision model it asked, else the pilot's own order. */
export interface PilotDecisions {
  /** Decisions asked of the model. */
  asked: number;
  /** Of those, answered in time and applied. */
  answered: number;
  /** Decisions the pilot made by its own order: no model, no answer in time, or only one move. */
  byOrder: number;
  /** The model that answered (`jev-1.14.0`), or null when none was asked. */
  model: string | null;
  /** The model's median answer time in milliseconds; null before an answer. */
  medianMs: number | null;
  /** What the model was sent, in input tokens, over the run. */
  inputTokens: number;
  /** Why the model's answers did not come, when some did not (refused key, timeouts). */
  failures: string[];
}

/** What a pilot's run ended with: how, the pilot's own note and evidence, the plan, the moves, and who decided. */
export interface EnginePlayPiloted {
  outcome: PilotOutcome;
  note: string;
  evidence: Record<string, unknown>;
  gameSeconds: number | null;
  stages: Array<{ name: string; done: boolean; atSeconds: number | null }>;
  moves: PilotMoveTally[];
  decisions: PilotDecisions;
  /** The facts the pilot saw last. */
  facts: Record<string, unknown>;
  /** The run's last lines: moves started and ended, stages done, in game seconds. */
  timeline: string[];
  /** Errors the pilot's own code raised, each once, with where. */
  errors: string[];
  /** What the play's detectors found during the run: kind, words, game seconds. */
  findings: Array<{ code: string; detail: string; gameSeconds: number | null }>;
  /** The run's record in the game folder (`playtests/runs/.../record.md`), when Genex wrote one. */
  record: string | null;
}

/** What `play-look` answers: how the turn ended, how far off the view still is, and why it stopped. */
export interface EnginePlayLooked {
  state: EnginePlayLookState;
  target: string;
  offDegrees: number | null;
  reason: string;
  gameSeconds: number | null;
}

const WALK_STATES: ReadonlySet<string> = new Set(Object.values(EnginePlayWalkState));
const LOOK_STATES: ReadonlySet<string> = new Set(Object.values(EnginePlayLookState));

function isWalkState(value: unknown): value is EnginePlayWalkState {
  return typeof value === "string" && WALK_STATES.has(value);
}

function isLookState(value: unknown): value is EnginePlayLookState {
  return typeof value === "string" && LOOK_STATES.has(value);
}

/** A number field of an answer, else null. */
function numberField(answer: unknown, name: string): number | null {
  const value = ownField(answer, name);
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A text field of an answer, else the fallback. */
function textField(answer: unknown, name: string, fallback = ""): string {
  const value = ownField(answer, name);
  return typeof value === "string" ? value : fallback;
}

/** A walk's answer read defensively: a state it doesn't know is a failed walk. */
export function walkedOf(answer: unknown, target: string): EnginePlayWalked {
  const state = ownField(answer, "state");
  const tried = ownField(answer, "tried");
  return {
    state: isWalkState(state) ? state : EnginePlayWalkState.Failed,
    target: textField(answer, "target", target),
    way: ownField(answer, "way") === EnginePlayWay.NavMesh ? EnginePlayWay.NavMesh : EnginePlayWay.Direct,
    partial: ownField(answer, "partial") === true,
    distanceM: numberField(answer, "distanceM"),
    tried: Array.isArray(tried) ? tried.filter((step): step is string => typeof step === "string") : [],
    reason: textField(answer, "reason", isWalkState(state) ? "" : "the engine said nothing of the walk"),
    gameSeconds: numberField(answer, "gameSeconds"),
    facingDeg: numberField(answer, "facingDeg"),
  };
}

/** A look's answer read defensively: a state it doesn't know is a failed look. */
export function lookedOf(answer: unknown, target: string): EnginePlayLooked {
  const state = ownField(answer, "state");
  return {
    state: isLookState(state) ? state : EnginePlayLookState.Failed,
    target: textField(answer, "target", target),
    offDegrees: numberField(answer, "offDegrees"),
    reason: textField(answer, "reason", isLookState(state) ? "" : "the engine said nothing of the look"),
    gameSeconds: numberField(answer, "gameSeconds"),
  };
}

const PILOT_OUTCOMES: ReadonlySet<string> = new Set(Object.values(PilotOutcome));

function isPilotOutcome(value: unknown): value is PilotOutcome {
  return typeof value === "string" && PILOT_OUTCOMES.has(value);
}

/** A plain object's own fields, else an empty record. */
function recordField(value: unknown, name: string): Record<string, unknown> {
  const field = ownField(value, name);
  if (typeof field !== "object" || field === null || Array.isArray(field)) return {};
  return Object.fromEntries(Object.entries(field));
}

/** The text items of a list field. */
function textsField(value: unknown, name: string): string[] {
  const field = ownField(value, name);
  return Array.isArray(field) ? field.filter((item): item is string => typeof item === "string") : [];
}

/** A move's tally read defensively: missing counts are zero. */
function tallyOf(item: unknown): PilotMoveTally | null {
  const name = textField(item, "name");
  if (!name) return null;
  const count = (field: string) => Math.max(0, Math.round(numberField(item, field) ?? 0));
  return {
    name,
    started: count("started"),
    worked: count("worked"),
    failed: count("failed"),
    medianSeconds: numberField(item, "medianSeconds"),
  };
}

/** A stage of the plan read defensively. */
function stageOf(item: unknown): { name: string; done: boolean; atSeconds: number | null } | null {
  const name = textField(item, "name");
  return name ? { name, done: ownField(item, "done") === true, atSeconds: numberField(item, "atSeconds") } : null;
}

/** The decisions as nobody asked a model: every one made by the pilot's own order. */
export function decisionsByOrder(byOrder: number): PilotDecisions {
  return { asked: 0, answered: 0, byOrder, model: null, medianMs: null, inputTokens: 0, failures: [] };
}

/**
 * A pilot's report (the `report` of a `play-pilot-step` once it is over) read defensively, with who
 * decided: an outcome it does not know is a broken pilot.
 */
export function pilotedOf(report: unknown, decisions: PilotDecisions): EnginePlayPiloted {
  const outcome = ownField(report, "outcome");
  const listed = (name: string) => {
    const field = ownField(report, name);
    return Array.isArray(field) ? field : [];
  };
  return {
    outcome: isPilotOutcome(outcome) ? outcome : PilotOutcome.Broken,
    note: textField(report, "note", isPilotOutcome(outcome) ? "" : "the engine said nothing of the pilot"),
    evidence: recordField(report, "evidence"),
    gameSeconds: numberField(report, "gameSeconds"),
    stages: listed("stages")
      .map(stageOf)
      .filter((stage) => stage !== null),
    moves: listed("moves")
      .map(tallyOf)
      .filter((tally) => tally !== null),
    decisions,
    facts: recordField(report, "facts"),
    timeline: textsField(report, "timeline"),
    errors: textsField(report, "errors"),
    findings: listed("findings")
      .map(pilotFindingOf)
      .filter((finding) => finding !== null),
    record: textField(report, "record", "") || null,
  };
}

/** One of a run's findings, from the engine's raw list: a kind and its words, else null. */
function pilotFindingOf(value: unknown): EnginePlayPiloted["findings"][number] | null {
  const code = ownField(value, "code");
  if (typeof code !== "string" || !code) return null;
  return { code, detail: textField(value, "detail", ""), gameSeconds: numberField(value, "gameSeconds") };
}

/** A probability for each name, from a decider's raw answer: finite numbers from 0 to 1 only. */
function probabilitiesOf(value: unknown): Record<string, number> {
  if (typeof value !== "object" || value === null) return {};
  const kept = Object.entries(value).filter(
    (entry): entry is [string, number] =>
      typeof entry[1] === "number" && Number.isFinite(entry[1]) && entry[1] >= 0 && entry[1] <= 1,
  );
  return Object.fromEntries(kept);
}

/** One step's ask read defensively: null without an id or at least one named move. */
export function pilotAskOf(value: unknown): PilotAsk | null {
  const id = numberField(value, "id");
  const moves = Object.fromEntries(
    Object.entries(recordField(value, "moves")).filter(
      (entry): entry is [string, string] => typeof entry[1] === "string",
    ),
  );
  if (id === null || Object.keys(moves).length === 0) return null;
  return {
    id,
    state: recordField(value, "state"),
    moves,
    instructions: textField(value, "instructions"),
    questions: recordField(value, "questions"),
  };
}

/** What `play-pilot-step` answers: how the pilot stands, its ask when it has one, and its report once over. */
export interface PilotStep {
  phase: PilotPhase;
  ask: PilotAsk | null;
  report: unknown;
  /** The pilot's own count of the moves it chose by its order. */
  byOrder: number;
}

/** A step's answer read defensively: anything but a running pilot is over. */
export function pilotStepOf(answer: unknown): PilotStep {
  const phase = ownField(answer, "phase") === PilotPhase.Piloting ? PilotPhase.Piloting : PilotPhase.Over;
  return {
    phase,
    ask: phase === PilotPhase.Piloting ? pilotAskOf(ownField(answer, "ask")) : null,
    report: ownField(answer, "report") ?? answer,
    byOrder: Math.max(0, Math.round(numberField(answer, "byOrder") ?? 0)),
  };
}

/** A decider's raw answer to an ask, as the pilot takes it: the move probabilities and the extra answers. */
export function pilotAnswer(
  id: number,
  probabilities: unknown,
  answers: Record<string, unknown>,
  ms: number,
): PilotAnswer {
  return { id, probabilities: probabilitiesOf(probabilities), answers, ms: Math.max(0, Math.round(ms)) };
}

/** Every play tool an engine plugin must provide for its games to be played through `computer`. */
export const ENGINE_PLAY_TOOLS: readonly EnginePlayTool[] = Object.values(EnginePlayTool);

/** The view every play shot is taken at, unless the engine says otherwise. */
export const ENGINE_PLAY_VIEW = { width: 1280, height: 720 } as const;

/** The longest one `play-input` holds keys, in game seconds. */
export const MAX_PLAY_INPUT_SECONDS = 10;

/** The most players one play may open: each is its own window of the editor's play. */
export const MAX_PLAY_PLAYERS = 8;

/**
 * What an engine's editor can do in play, as its plugin declares it (`engine.play`): how many
 * players one play opens at most, its clock, whether the mouse aims as a player's does and whether
 * the game's state can be read. Absent fields are the editor defaults.
 */
export interface EnginePlayDeclaration {
  /** 1 to `MAX_PLAY_PLAYERS`. */
  players?: number;
  clock?: ClockLevel;
  pointer?: boolean;
  state?: boolean;
  /** Whether its play walks the player to a target and turns its view by itself (`play-walk`, `play-look`). Absent is no. */
  walk?: boolean;
  /** Whether its play runs pilots: a file of moves that plays by itself every frame (`play-pilot`, `play-pilot-step`). Absent is no. */
  pilot?: boolean;
}

/** The most bytes one play shot may hold: a bigger picture is refused, never shown to a model (its limit is 1 MB). */
export const MAX_PLAY_SHOT_BYTES = 1_000_000;

/** The clock levels, from none to the most the studio can do with a clock. */
const CLOCK_ORDER: readonly ClockLevel[] = [
  ClockLevel.None,
  ClockLevel.Freeze,
  ClockLevel.StepLocked,
  ClockLevel.Replayable,
];

/** The play tools pause a play and never step it: the most clock an editor's play can have. */
const EDITOR_CLOCK_MOST: ClockLevel = ClockLevel.Freeze;

/** The lower of two clock levels. */
function lowerClock(a: ClockLevel, b: ClockLevel): ClockLevel {
  return CLOCK_ORDER.indexOf(a) <= CLOCK_ORDER.indexOf(b) ? a : b;
}

/** Whether a value is one of the clock levels. */
function isClockLevel(value: unknown): value is ClockLevel {
  return (CLOCK_ORDER as readonly unknown[]).includes(value);
}

/** A player's number: a whole number from 1 to `MAX_PLAY_PLAYERS`, else null. */
export function playerArg(value: unknown): number | null {
  const valid = typeof value === "number" && Number.isInteger(value) && value >= 1 && value <= MAX_PLAY_PLAYERS;
  return valid ? value : null;
}

/** How many players a play is asked to open: a player's number, else 1. */
export function playersArg(value: unknown): number {
  return playerArg(value) ?? 1;
}

/** The capabilities with `players` set, or left out at one player (which is what absent means). */
function withPlayers(caps: TargetCapabilities, players: number): TargetCapabilities {
  const { players: _dropped, ...rest } = caps;
  return players > 1 ? { ...rest, players } : rest;
}

/**
 * What the computer can do in an engine's editor play, as the engine's plugin declares it
 * (`engine.play`): its players, its clock (at most the play's own pause), whether the mouse aims as
 * a player's does, and whether the game's state can be read. Nothing declared is the editor's own
 * ({@link EDITOR_CAPABILITIES}).
 */
export function editorCapabilities(play: EnginePlayDeclaration = {}): TargetCapabilities {
  const caps: TargetCapabilities = { ...EDITOR_CAPABILITIES };
  if (play.clock !== undefined) caps.clock = lowerClock(play.clock, EDITOR_CLOCK_MOST);
  if (play.pointer === false) Object.assign(caps, { pointer: PointerLevel.None, aimedClicks: false });
  if (play.state === false) caps.state = StateLevel.None;
  if (play.walk === true) caps.walk = true;
  if (play.pilot === true) caps.pilot = true;
  return withPlayers(caps, playersArg(play.players));
}

/** A field of an object, when the value is an object that has it. */
function ownField(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, name)) return undefined;
  const field: unknown = Reflect.get(value, name);
  return field;
}

/**
 * The capabilities `caps` as a play's own answer says it can do (`play-open`'s `capabilities`, in
 * the declaration's shape): each field can only lower what was declared, never raise it, and
 * anything the answer does not say stays as declared.
 */
export function narrowCapabilities(caps: TargetCapabilities, answered: unknown): TargetCapabilities {
  const narrowed: TargetCapabilities = { ...caps };
  const clock = ownField(answered, "clock");
  if (isClockLevel(clock)) narrowed.clock = lowerClock(caps.clock, clock);
  if (ownField(answered, "pointer") === false)
    Object.assign(narrowed, { pointer: PointerLevel.None, aimedClicks: false });
  if (ownField(answered, "state") === false) narrowed.state = StateLevel.None;
  if (ownField(answered, "walk") === false && narrowed.walk) narrowed.walk = false;
  if (ownField(answered, "pilot") === false && narrowed.pilot) narrowed.pilot = false;
  const players = playerArg(ownField(answered, "players"));
  return withPlayers(narrowed, Math.min(caps.players ?? 1, players ?? MAX_PLAY_PLAYERS));
}

/** What `play-open` is asked: how many players to open; absent is one. */
export interface EnginePlayOpenArgs {
  players?: number;
}

/**
 * What `play-open` answers: the view's size, whether the play was already running, and where the
 * engine can say so, how many players joined, what this play can do (in the declaration's shape, which
 * can only narrow it) and whether the game's live saved data can be reached from it.
 */
export interface EnginePlayOpened {
  width: number;
  height: number;
  joined: boolean;
  players?: number;
  capabilities?: EnginePlayDeclaration;
  liveData?: boolean;
}

/** Which player a play tool is for: absent is player 1, which is never sent. */
export interface EnginePlayerArgs {
  player?: number;
}

/** The arguments that name a player: nothing for player 1. */
export function playerArgs(player: number): EnginePlayerArgs {
  return player > 1 ? { player } : {};
}

/** The mouse buttons, as `play-input` names them among its keys (web key codes have none). Wire values: never rename. */
export const MouseButtonCode = { Left: "MouseLeft", Right: "MouseRight", Middle: "MouseMiddle" } as const;
export type MouseButtonCode = (typeof MouseButtonCode)[keyof typeof MouseButtonCode];

/** One frame of the player's mouse: motion in pixels (down the screen is +dy) and wheel notches (up is +). */
export interface EnginePlayMouse {
  dx?: number;
  dy?: number;
  wheel?: number;
}

/**
 * What `play-input` is asked: keys as web key codes (`KeyboardEvent.code`: `KeyW`, `Space`,
 * `ArrowUp`, `ShiftLeft`, `Digit1`) or mouse buttons ({@link MouseButtonCode}) joined by commas,
 * held together, after one frame of the mouse when it moves; the engine plugin names them in its
 * engine. Plugin tool parameters are scalars, so the keys are one string; none is a wait.
 */
export interface EnginePlayInputArgs extends EnginePlayMouse, EnginePlayerArgs {
  keys: string;
  seconds: number;
}

/** The keys a `play-input` names, in order: `"KeyW,ShiftLeft"` is `["KeyW", "ShiftLeft"]`. */
export function playInputKeys(keys: unknown): string[] {
  return typeof keys === "string"
    ? keys
        .split(",")
        .map((key) => key.trim())
        .filter(Boolean)
    : [];
}

/**
 * A `play-input`'s arguments for keys held together for `seconds`, after one frame of `mouse` when
 * it moves, by `player` (named only above 1).
 */
export function playInputArgs(
  keys: readonly string[],
  seconds: number,
  mouse: EnginePlayMouse = {},
  player = 1,
): EnginePlayInputArgs {
  return { keys: keys.join(","), seconds, ...mouse, ...playerArgs(player) };
}

/** What `play-input` answers: the keys the engine took, and the game seconds that passed. */
export interface EnginePlayInputAnswer {
  held: string[];
  gameSeconds: number | null;
}

/**
 * What `play-shot` answers: the picture as base64 `data` with its `mime` (`image/jpeg` or
 * `image/png`; anything else is read as PNG), at the view's size. `png` is the older name for a
 * PNG's data, read when `data` is absent.
 */
export interface EnginePlayShot {
  data?: string;
  png?: string;
  mime?: string;
  width: number;
  height: number;
}

/** Why a play tool did not do what it was asked, as a code: the words the model reads are the target's. */
export const EnginePlayRefusal = {
  /** The editor is not open or does not answer. */
  NoEditor: "no-editor",
  /** The engine's own queue is playing a build now; try again when it has finished. */
  Busy: "busy",
  /** No play is running (it ended, or the person stopped it). */
  NotPlaying: "not-playing",
  /** A key the engine has no name for. */
  UnknownKey: "unknown-key",
  /** The engine cannot do this at all (more players, a pause): the studio stops asking, never retries. */
  Unsupported: "unsupported",
  /** A fresh play was asked for while the person plays: their game is never started over. */
  PersonPlaying: "person-playing",
} as const;
export type EnginePlayRefusal = (typeof EnginePlayRefusal)[keyof typeof EnginePlayRefusal];

/** A play tool's refusal, as every play tool answers one. */
export interface EnginePlayRefused {
  refused: EnginePlayRefusal;
  message: string;
}

/** Whether a play tool's answer is a refusal. */
export function isEnginePlayRefused(answer: unknown): answer is EnginePlayRefused {
  if (typeof answer !== "object" || answer === null) return false;
  return (
    "refused" in answer &&
    typeof answer.refused === "string" &&
    "message" in answer &&
    typeof answer.message === "string"
  );
}
