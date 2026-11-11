/**
 * The Publish card of a game made in an engine, as words and a plan (canvas "Publish to every
 * platform", round 4): one row per platform the person can do something about, each saying only
 * what is true now (a dot and a line), with a switch for whether players get it; and the one button,
 * whose words say what pressing it does. Pure: the dialog draws it, tests read it.
 *
 * Build and Publish are two presses (canvas "Publish: Mac and Windows together", flow A). Build makes
 * every switched-on app that isn't made, here and on Genex Cloud at once, and gives players nothing:
 * Genex Cloud keeps what it builds. Publish gives players every switched-on app that is made, and
 * one Genex Cloud still builds as soon as it is built.
 */
import { sizeWords } from "../../../../shared/byte-size.ts";
import { HOUR_MS, MINUTE_MS } from "../../../../shared/duration.ts";
import {
  CloudBuildFailure,
  CloudBuildState,
  CloudSendState,
  GenexBuildReview,
  type GenexCloudBuild,
  type GenexNativeRecord,
  type GenexNativeSent,
  type GenexSendProgress,
} from "../../../../shared/genex.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { NATIVE_WORDS, PUBLISH_CARD_WORDS } from "../../../words.ts";
import {
  CLOUD_TARGETS,
  cloudErrors,
  currentSent,
  newestCloudBuild,
  RUNNING_CLOUD,
  WebOffer,
} from "./publish-platforms-view.ts";

const WORDS = PUBLISH_CARD_WORDS;

/** How close two times count as the same build: a game's files keep changing a little after a build starts. */
const SAME_BUILD_MS = MINUTE_MS;
/** How long a row says the agent builds an app it was asked for, when no new build lands: then it was not built. */
const ASK_HOLD_MS = 2 * HOUR_MS;

/** A row's dot: what is on Genex for that platform now. */
export const CardTone = {
  /** Players have it, and it is the game as it is now (or its age can't be told). */
  Live: "live",
  /** Players have it, but the game changed since. */
  Old: "old",
  /** Players don't have it, and no app of it is ready for them. */
  None: "none",
  /** Players don't have it: its app is built and waits for Publish. */
  Ready: "ready",
  /** Something is happening to it now: a clock is at its end. */
  Working: "working",
  /** On Genex, waiting for Genex's review. */
  Review: "review",
  /** Its last send or build failed, or Genex turned it down. */
  Bad: "bad",
} as const;
export type CardTone = (typeof CardTone)[keyof typeof CardTone];

/** What the button does for a row. */
export const CardWork = {
  /** Send the build the folder holds. */
  Publish: "publish",
  /** Ask the agent to make it, or make it again, on this computer. */
  Build: "build",
  /** Have Genex Cloud build it from the game's project, and keep it. */
  Cloud: "cloud",
  /** Give players the app Genex Cloud built and keeps, or the one it still builds once it is built. */
  Release: "release",
  /** Take what players have off Genex. */
  TakeDown: "take-down",
} as const;
export type CardWork = (typeof CardWork)[keyof typeof CardWork];

/** One platform's row. */
export interface CardRow {
  target: PublishTarget;
  name: string;
  tone: CardTone;
  status: string;
  /** The row's end: when it went live, how big it is, or where the button builds it. */
  side: string | null;
  /** When the work the row shows began, for its clock. */
  since?: string;
  /** How far the send the row shows is; absent when nothing is being sent or the CLI says nothing of it. */
  progress?: GenexSendProgress;
  /** Genex Cloud is working on it now: the wait can be long. */
  cloud: boolean;
  /** The agent is building it on this computer now. */
  here: boolean;
  /** The work under way only makes the app: players get nothing when it ends. */
  making: boolean;
  /** On Genex now (for players or for review): switching it off takes it down. */
  live: boolean;
  /** Where its switch starts. */
  on: boolean;
  /** What the button does for it while its switch is on; null when nothing needs doing. */
  work: CardWork | null;
}

/** What the card is read from. */
export interface CardInput {
  /** The game folder's platforms as the Genex plugin can send them (`gateByPlugin`). */
  platforms: readonly PublishPlatform[];
  /** How the last Publish's apps went, and Genex Cloud's builds. */
  native?: GenexNativeRecord | undefined;
  now: number;
  /** What a game with no web version is offered for one. */
  webOffer: WebOffer;
  /** The systems this computer makes the game's apps for (`appsMadeHere`); null: the agent makes any. */
  madeHere: ReadonlySet<PublishTarget> | null;
  /** Whether Genex's page plays a web version; absent while unknown. */
  hostedWeb?: boolean | undefined;
  /** When the web version last went out from here (`lastPublishAt`), to tell it from the game's last change. */
  webPublishedAt?: string | undefined;
  /** Apps the agent was asked to build from this card, by when it was asked. */
  asked?: ReadonlyMap<PublishTarget, string>;
  /** This computer is a Mac: the words say "this Mac", else "this PC". */
  mac: boolean;
}

/** The app players get of a platform, from the last sends and Genex Cloud's builds. */
interface Live {
  /** When it went live. */
  at: string;
  /** When it was built, as near as can be told: what "older than your game" is judged by. */
  builtAt: string;
  review?: GenexBuildReview;
}

const ms = (at: string | null | undefined): number => (at ? Date.parse(at) : Number.NaN);

/** The newest app the record says went to Genex for `row`'s platform. */
function newestSent(row: PublishPlatform, native: GenexNativeRecord | undefined): GenexNativeSent | undefined {
  const sent = (native?.sent ?? []).filter((one) => one.platform === row.target);
  return sent.reduce<GenexNativeSent | undefined>(
    (newest, one) => (!newest || ms(one.publishedAt) > ms(newest.publishedAt) ? one : newest),
    undefined,
  );
}

/** The newest build Genex Cloud finished and put on the game's page for `row`'s platform. */
function newestCloudDone(row: PublishPlatform, native: GenexNativeRecord | undefined): GenexCloudBuild | undefined {
  const done = (native?.cloud?.builds ?? []).filter(
    (build) => build.platform === row.target && build.state === CloudBuildState.Done,
  );
  return done.reduce<GenexCloudBuild | undefined>(
    (newest, build) => (!newest || ms(build.startedAt) > ms(newest.startedAt) ? build : newest),
    undefined,
  );
}

/** The app players get (or Genex reviews) of a native platform: whichever went last. */
function liveApp(row: PublishPlatform, native: GenexNativeRecord | undefined): Live | null {
  const sent = newestSent(row, native);
  const cloud = newestCloudDone(row, native);
  const cloudAt = cloud?.finishedAt ?? cloud?.startedAt;
  if (cloud && cloudAt && (!sent || ms(cloudAt) > ms(sent.publishedAt)))
    return { at: cloudAt, builtAt: cloud.startedAt };
  if (!sent) return null;
  // The build that went is this folder's when the record says it went after the folder's build was made.
  const builtAt = currentSent(row, native) && row.builtAt ? row.builtAt : sent.publishedAt;
  return { at: sent.publishedAt, builtAt, ...(sent.review ? { review: sent.review } : {}) };
}

/** Whether the app players have is older than the game: built before its last change, or a newer build waits. */
function isOlder(row: PublishPlatform, live: Live): boolean {
  const built = ms(live.builtAt);
  const changedSince = ms(row.changedAt) - built > SAME_BUILD_MS;
  const newerWaits = row.state === PublishPlatformState.Ready && ms(row.builtAt) - built > SAME_BUILD_MS;
  return changedSince || newerWaits;
}

/** Whether this computer can make `row`'s app (the agent builds it here). */
const makesHere = (row: PublishPlatform, input: CardInput): boolean =>
  input.madeHere === null || input.madeHere.has(row.target);

/** Whether Genex Cloud builds `row`'s app because this computer can't: an Unreal game's Windows app on a Mac. */
const cloudBuilds = (row: PublishPlatform, input: CardInput): boolean =>
  CLOUD_TARGETS.has(row.target) && input.native?.cloud?.supported === true && !makesHere(row, input);

/** The app Genex Cloud built and keeps of `row`'s platform, whatever its age; null when it keeps none. */
function keptApp(row: PublishPlatform, native: GenexNativeRecord | undefined): GenexCloudBuild | null {
  const build = newestCloudBuild(row, native);
  return build?.state === CloudBuildState.Built ? build : null;
}

/** Whether the game changed after Genex Cloud started `build`: what it made is not the game as it is now. */
const builtBeforeChange = (row: PublishPlatform, build: GenexCloudBuild): boolean =>
  ms(row.changedAt) - ms(build.startedAt) > SAME_BUILD_MS;

/**
 * The app Genex Cloud built and keeps for a publish, when it is the game as it is now and newer than
 * the one players have. One built before the game's last change stays with Genex, as a build in the
 * folder that is older than the game stays there: the button builds it again.
 */
function keptBuild(
  row: PublishPlatform,
  native: GenexNativeRecord | undefined,
  live: Live | null,
): GenexCloudBuild | null {
  const build = keptApp(row, native);
  if (!build || builtBeforeChange(row, build)) return null;
  return live && ms(live.builtAt) >= ms(build.startedAt) ? null : build;
}

/** The works that give players an app that is already made. */
const SENDS: ReadonlySet<CardWork | null> = new Set([CardWork.Publish, CardWork.Release]);
/** The works that make an app, and give players nothing. */
const MAKES: ReadonlySet<CardWork | null> = new Set([CardWork.Build, CardWork.Cloud]);

/**
 * What the button does to bring a platform's app up to the game: send the build the folder holds or
 * the one Genex Cloud keeps, else build it on Genex Cloud or here.
 */
function updateWork(
  row: PublishPlatform,
  input: CardInput,
  live: Live | null,
): { work: CardWork | null; side: string | null } {
  if (row.state === PublishPlatformState.Ready)
    return row.uploads ? { work: CardWork.Publish, side: sizeWords(row.bytes) } : { work: null, side: WORDS.soon };
  const kept = keptBuild(row, input.native, live);
  if (kept) return { work: CardWork.Release, side: kept.installedBytes ? sizeWords(kept.installedBytes) : null };
  if (cloudBuilds(row, input)) return { work: CardWork.Cloud, side: WORDS.buildsCloud };
  if (makesHere(row, input)) return { work: CardWork.Build, side: WORDS.buildsHere(input.mac) };
  return { work: null, side: null };
}

/** What a row says, before its switch and work. */
type RowState = Pick<CardRow, "tone" | "status" | "side" | "since" | "progress" | "cloud" | "here" | "making">;

/** The app a send's progress names (`mac-universal`, `windows-x64`) is `row`'s. */
const namesRow = (progress: GenexSendProgress | undefined, row: PublishPlatform): boolean =>
  progress?.target?.split("-")[0] === row.target;

/** A row at rest: nothing is under way for it. */
const AT_REST = { cloud: false, here: false, making: false } as const;

const progressOf = (progress: GenexSendProgress | undefined): Pick<CardRow, "progress"> =>
  progress ? { progress } : {};

/** How far the app being sent is, when it is `row`'s. */
const appProgress = (native: GenexNativeRecord, row: PublishPlatform): Pick<CardRow, "progress"> =>
  namesRow(native.progress, row) ? progressOf(native.progress) : {};

/** The work under way for a native platform now, if any: Genex Cloud's, a send, or the agent's. */
function workingNow(row: PublishPlatform, input: CardInput): RowState | null {
  const { native } = input;
  const send = native?.cloud?.send;
  if (send?.platform === row.target && send.state === CloudSendState.Sending)
    return {
      tone: CardTone.Working,
      status: WORDS.sendingCloud,
      side: null,
      since: send.startedAt,
      ...progressOf(send.progress),
      cloud: true,
      here: false,
      // Only a build Genex keeps is just being made: any other goes to players once built.
      making: send.held === true && send.released !== true,
    };
  const build = newestCloudBuild(row, native);
  if (build && RUNNING_CLOUD.has(build.state))
    return {
      tone: CardTone.Working,
      status: WORDS.buildingCloud,
      side: null,
      since: build.startedAt,
      cloud: true,
      here: false,
      making: build.held === true,
    };
  if (native?.sending && row.uploads && !currentSent(row, native))
    return { tone: CardTone.Working, status: WORDS.sending, side: null, ...appProgress(native, row), ...AT_REST };
  const asked = input.asked?.get(row.target);
  const landed = row.state === PublishPlatformState.Ready && ms(row.builtAt) > ms(asked);
  const waiting = asked !== undefined && input.now - ms(asked) < ASK_HOLD_MS;
  if (asked !== undefined && waiting && !landed)
    return {
      tone: CardTone.Working,
      status: WORDS.buildingHere(input.mac),
      side: null,
      since: asked,
      cloud: false,
      here: true,
      making: true,
    };
  return null;
}

/** Whether the project Genex Cloud builds `row`'s app from never reached it, and none has gone since. */
const cloudSendFailed = (row: PublishPlatform, native: GenexNativeRecord | undefined): boolean =>
  native?.cloud?.send?.platform === row.target && native.cloud.send.state === CloudSendState.Failed;

/**
 * Why a native platform's last try went wrong, if it did and nothing newer went: an app or a project
 * that didn't reach Genex, or a failed cloud build.
 */
function failedNow(row: PublishPlatform, input: CardInput, live: Live | null): RowState | null {
  const { native } = input;
  const appFailed = native?.failed.some((one) => one.platform === row.target) && !currentSent(row, native);
  if (appFailed || cloudSendFailed(row, native))
    return { tone: CardTone.Bad, status: WORDS.sendFailed, side: null, ...AT_REST };
  const build = newestCloudBuild(row, native);
  if (build?.state !== CloudBuildState.Failed) return null;
  if (live && ms(live.at) > ms(build.startedAt)) return null;
  return { tone: CardTone.Bad, status: live ? WORDS.buildFailedLive : WORDS.buildFailed, side: null, ...AT_REST };
}

/** What Genex's review says of the app on Genex, when it holds it back. */
function reviewNow(live: Live | null): RowState | null {
  if (live?.review === GenexBuildReview.Pending)
    return { tone: CardTone.Review, status: WORDS.inReview, side: null, ...AT_REST };
  if (live?.review === GenexBuildReview.Rejected)
    return { tone: CardTone.Bad, status: WORDS.notApproved, side: null, ...AT_REST };
  return null;
}

/**
 * Whether building `row`'s app on Genex Cloud again can't help: the account's builds are used up, or
 * the game hasn't changed since the build failed (the same project fails the same way: the agent fixes
 * it first).
 */
function retryUseless(row: PublishPlatform, native: GenexNativeRecord | undefined): boolean {
  const build = newestCloudBuild(row, native);
  if (build?.state !== CloudBuildState.Failed) return false;
  if (build.failure === CloudBuildFailure.Quota) return true;
  return !(ms(row.changedAt) - ms(build.finishedAt ?? build.startedAt) > SAME_BUILD_MS);
}

/** The system this computer runs, among the apps: what its own Build makes first. */
const ownTarget = (input: CardInput): PublishTarget => (input.mac ? PublishTarget.Mac : PublishTarget.Windows);

/**
 * Whether an app that isn't ready starts switched on. Before the first publish of a game whose apps
 * are made per computer (Unreal), the ones a first Build makes do: this computer's own and Genex
 * Cloud's. Every other app starts off, as a game whose apps the agent makes any of always did.
 */
function startsOn(row: PublishPlatform, input: CardInput, work: CardWork | null, firstPublish: boolean): boolean {
  if (!firstPublish || input.madeHere === null) return false;
  return work === CardWork.Cloud || row.target === ownTarget(input);
}

/** The row of a platform players have: up to date, or older than the game with what brings it up. */
function liveRow(row: PublishPlatform, input: CardInput, live: Live): RowState & Pick<CardRow, "on" | "work"> {
  const update = updateWork(row, input, live);
  const older = isOlder(row, live) || update.work === CardWork.Release;
  if (!older)
    return {
      tone: CardTone.Live,
      status: WORDS.liveCurrent,
      side: WORDS.ago(live.at, input.now),
      ...AT_REST,
      on: true,
      work: null,
    };
  const status = SENDS.has(update.work) ? WORDS.liveUpdateReady : WORDS.liveOlder;
  return { tone: CardTone.Old, status, side: update.side, ...AT_REST, on: true, work: update.work };
}

/** The row of a platform players don't have: its app is ready, was built before the game's last change, or isn't built. */
function unpublishedRow(
  row: PublishPlatform,
  input: CardInput,
  firstPublish: boolean,
): (RowState & Pick<CardRow, "on" | "work">) | null {
  const update = updateWork(row, input, null);
  if (!update.work) return null;
  if (SENDS.has(update.work))
    return {
      tone: CardTone.Ready,
      status: WORDS.readyToPublish,
      side: update.side,
      ...AT_REST,
      on: true,
      work: update.work,
    };
  const kept = keptApp(row, input.native);
  const older = row.state === PublishPlatformState.Stale || (kept !== null && builtBeforeChange(row, kept));
  const status = older ? WORDS.builtOlder : WORDS.notBuilt;
  const on = startsOn(row, input, update.work, firstPublish);
  return { tone: CardTone.None, status, side: update.side, ...AT_REST, on, work: update.work };
}

/** A native platform's row, or null when nothing can be done about it from here. */
function nativeRow(row: PublishPlatform, input: CardInput, firstPublish: boolean): CardRow | null {
  const live = liveApp(row, input.native);
  const base = { target: row.target, name: WORDS.name[row.target], live: live !== null };
  const update = updateWork(row, input, live);
  const working = workingNow(row, input);
  // What Genex Cloud makes and keeps can be published while it is made: it goes to players once built.
  if (working)
    return { ...base, ...working, on: true, work: working.cloud && working.making ? CardWork.Release : null };
  const held = reviewNow(live);
  // A turned-down app goes again only as a newer build: the same one would be turned down again.
  const resend = held?.tone === CardTone.Bad && live && isOlder(row, live) ? update.work : null;
  if (held) return { ...base, ...held, on: true, work: resend };
  const failed = failedNow(row, input, live);
  if (failed) {
    // What didn't reach Genex is tried again from its error block, never by the main button.
    const blockRetries = failed.status === WORDS.sendFailed;
    const work = blockRetries || retryUseless(row, input.native) ? null : update.work;
    return { ...base, ...failed, on: true, work };
  }
  if (live) return { ...base, ...liveRow(row, input, live) };
  const unpublished = unpublishedRow(row, input, firstPublish);
  return unpublished ? { ...base, ...unpublished } : null;
}

/**
 * Whether the web version that went out at `publishedAt` is older than the game: the game changed
 * after it, or the web build in the game's folder was made after it (a build put there is new by
 * itself, with no source changed).
 */
function webOlder(row: PublishPlatform, publishedAt: string): boolean {
  const published = ms(publishedAt);
  return ms(row.changedAt) - published > SAME_BUILD_MS || ms(row.builtAt) - published > SAME_BUILD_MS;
}

/** The web row: live on Genex's page, ready to send, or one the agent can make; null when the game can't have one. */
function webRow(row: PublishPlatform, input: CardInput): CardRow | null {
  const live = input.hostedWeb === true;
  const base = { target: row.target, name: WORDS.name[row.target], live, ...AT_REST };
  const ready = row.state === PublishPlatformState.Ready;
  if (live) {
    const at = input.webPublishedAt;
    const older = ready && (!at || webOlder(row, at));
    const side = at ? WORDS.ago(at, input.now) : null;
    return older
      ? { ...base, tone: CardTone.Old, status: WORDS.liveOlder, side: null, on: true, work: CardWork.Publish }
      : { ...base, tone: CardTone.Live, status: WORDS.liveCurrent, side, on: true, work: null };
  }
  if (ready)
    return {
      ...base,
      tone: CardTone.Ready,
      status: WORDS.readyToPublish,
      side: null,
      on: true,
      work: CardWork.Publish,
    };
  if (input.webOffer !== WebOffer.Make) return null;
  const side = WORDS.buildsHere(input.mac);
  return { ...base, side, tone: CardTone.None, status: WORDS.notBuilt, on: false, work: CardWork.Build };
}

/** The card's rows, in the folder's order, leaving out every platform nothing can be done about from here. */
export function cardRows(input: CardInput): CardRow[] {
  const anyLive = input.platforms.some((row) =>
    row.target === PublishTarget.Web ? input.hostedWeb === true : liveApp(row, input.native) !== null,
  );
  return input.platforms
    .map((row) => (row.target === PublishTarget.Web ? webRow(row, input) : nativeRow(row, input, !anyLive)))
    .filter((row): row is CardRow => row !== null);
}

/** One thing the button does. */
export interface PlanStep {
  target: PublishTarget;
  work: CardWork;
}

/** What the button does and says. */
export interface PressPlan {
  label: string;
  steps: PlanStep[];
  /** It only takes platforms down: the button warns. */
  warn: boolean;
}

/** Whether a row's switch is on: the person's choice, else where it starts. */
export const switchedOn = (row: CardRow, switches: ReadonlyMap<PublishTarget, boolean>): boolean =>
  switches.get(row.target) ?? row.on;

/**
 * The switches the card has: the ones turned in this dialog, over the platforms the person left out
 * before (`leftOut`, kept per game). A platform players have opens switched on whatever was kept: a
 * choice from another day never offers to take it down.
 */
export function keptSwitches(
  rows: readonly CardRow[],
  leftOut: ReadonlySet<PublishTarget>,
  chosen: ReadonlyMap<PublishTarget, boolean>,
): Map<PublishTarget, boolean> {
  const stillOut = rows.filter((row) => leftOut.has(row.target) && !row.live);
  return new Map<PublishTarget, boolean>([...stillOut.map((row) => [row.target, false] as const), ...chosen]);
}

/** "Mac", "Mac and Windows", "Mac, Windows and web". */
const listed = (rows: readonly CardRow[]): string =>
  NATIVE_WORDS.platforms(rows.map((row) => WORDS.inPress[row.target]));

/** The words for the platforms that get something: named up to two, counted from three. */
function sendWords(updates: readonly CardRow[], news: readonly CardRow[]): string | null {
  const all = [...updates, ...news];
  if (all.length === 0) return null;
  const onlyUpdates = news.length === 0;
  if (all.length >= 3) return onlyUpdates ? WORDS.updateCount(all.length) : WORDS.publishToCount(all.length);
  return onlyUpdates ? WORDS.update(listed(all)) : WORDS.publishTo(listed(all));
}

/** The words for platforms that get something, with the ones taken down after them. */
function planLabel(updates: readonly CardRow[], news: readonly CardRow[], downs: readonly CardRow[]): string {
  const send = sendWords(updates, news);
  if (downs.length === 0) return send ?? "";
  if (!send) return WORDS.takeDown(listed(downs));
  return news.length === 0
    ? WORDS.updateAndTakeDown(listed(updates), listed(downs))
    : WORDS.publishAndTakeDown(listed([...updates, ...news]), listed(downs));
}

/** The button for apps that aren't made: it makes them, here and on Genex Cloud at once, and a second press publishes them. */
function buildPlan(builds: readonly CardRow[]): PressPlan {
  const label = builds.length >= 3 ? WORDS.buildCount(builds.length) : WORDS.build(listed(builds));
  const steps = builds.map((row) => ({ target: row.target, work: row.work ?? CardWork.Build }));
  return { label, steps, warn: false };
}

/**
 * The rows a Publish gives players: each switched-on one whose app is made, and one Genex Cloud still
 * builds and keeps, which then goes to players once built. That one goes only with the game: beside
 * an app that is made, or to a game players have already, because a game with nothing to play can't
 * be published. While the agent builds an app here it waits with it: one Build asked for both, and
 * Publish comes once the first is ready.
 */
function sendingRows(rows: readonly CardRow[], switches: ReadonlyMap<PublishTarget, boolean>): CardRow[] {
  const sends = rows.filter((row) => switchedOn(row, switches) && SENDS.has(row.work));
  const made = sends.filter((row) => row.tone !== CardTone.Working);
  const playable = made.length > 0 || rows.some((row) => row.live && switchedOn(row, switches));
  const agentBuilds = rows.some((row) => row.here);
  return playable && !agentBuilds ? sends : made;
}

/**
 * What the button does for the rows as switched, or null when nothing needs doing. Apps that aren't
 * made come first and alone, the agent's and Genex Cloud's in one press: building never sends
 * anything to players, so a second press does.
 */
export function pressPlan(rows: readonly CardRow[], switches: ReadonlyMap<PublishTarget, boolean>): PressPlan | null {
  const atRest = rows.filter((row) => row.tone !== CardTone.Working);
  const builds = atRest.filter((row) => switchedOn(row, switches) && MAKES.has(row.work));
  if (builds.length > 0) return buildPlan(builds);
  const sending = sendingRows(rows, switches);
  const downs = atRest.filter((row) => !switchedOn(row, switches) && row.live);
  if (sending.length === 0 && downs.length === 0) return null;
  const steps: PlanStep[] = [
    ...sending.map((row) => ({ target: row.target, work: row.work ?? CardWork.Publish })),
    ...downs.map((row) => ({ target: row.target, work: CardWork.TakeDown })),
  ];
  const updates = sending.filter((row) => row.live);
  const news = sending.filter((row) => !row.live);
  return { label: planLabel(updates, news, downs), steps, warn: sending.length === 0 };
}

/**
 * The line under the button while Genex Cloud works, for a button that names `named`: the wait can
 * be long. It names whose wait when the button names anything else.
 */
export function pressNote(rows: readonly CardRow[], named: readonly PublishTarget[]): string | null {
  const slow = rows.filter((row) => row.tone === CardTone.Working && row.cloud);
  if (slow.length === 0) return null;
  const onlySlow = named.length === slow.length && slow.every((row) => named.includes(row.target));
  return onlySlow && slow.length === 1 ? WORDS.cloudTakesLong : WORDS.cloudTakesLongFor(listed(slow));
}

/** The button while rows work: what it says, the clock of the longest wait, and the line under it. */
export interface BusyPress {
  label: string;
  since: string | null;
  /** Under the button while Genex Cloud works (`pressNote`). */
  note: string | null;
}

/**
 * The rows the busy button names and what it says of them: building while every one is only being
 * made, else the ones on their way to players, as an update of what they have or something new.
 */
function busyWords(working: readonly CardRow[]): { named: readonly CardRow[]; label: string } {
  if (working.every((row) => row.making)) return { named: working, label: WORDS.building(listed(working)) };
  const going = working.filter((row) => !row.making);
  const words = going.every((row) => row.live) ? WORDS.updating : WORDS.publishing;
  return { named: going, label: words(listed(going)) };
}

/** The busy button for the rows at work now, or null when none is. */
export function busyPress(rows: readonly CardRow[]): BusyPress | null {
  const working = rows.filter((row) => row.tone === CardTone.Working);
  if (working.length === 0) return null;
  const { named, label } = busyWords(working);
  const starts = named.map((row) => row.since).filter((at): at is string => at !== undefined);
  const since = starts.reduce<string | null>((first, at) => (first === null || ms(at) < ms(first) ? at : first), null);
  const note = pressNote(
    rows,
    named.map((row) => row.target),
  );
  return { label, since, note };
}

/**
 * What an error block is about: a build Genex Cloud couldn't make, a build that never started (the
 * game's project didn't reach Genex Cloud, or it refused it), or an app that didn't reach Genex.
 */
export const CardErrorKind = { Build: "build", Start: "start", Send: "send" } as const;
export type CardErrorKind = (typeof CardErrorKind)[keyof typeof CardErrorKind];

/** One error block: under the rows, above the link. Its text is never shown: it goes to the agent or the clipboard. */
export interface CardError {
  target: PublishTarget;
  kind: CardErrorKind;
  title: string;
  /** The whole error, as the log or the CLI said it. */
  text: string;
}

/** The block of a Genex Cloud build that never started, in the CLI's words when it said why. */
function startError(platforms: readonly PublishPlatform[], native: GenexNativeRecord | undefined): CardError[] {
  const row = platforms.find((one) => cloudSendFailed(one, native));
  if (!row) return [];
  const title = WORDS.startError(WORDS.name[row.target]);
  return [{ target: row.target, kind: CardErrorKind.Start, title, text: native?.cloud?.send?.error ?? "" }];
}

/**
 * The card's error blocks: a failed Genex Cloud build with its log, which the agent can fix, one that
 * never started, and each app whose last send didn't reach Genex (and hasn't gone since), which a
 * press tries again.
 */
export function cardErrors(platforms: readonly PublishPlatform[], native: GenexNativeRecord | undefined): CardError[] {
  const errors: CardError[] = [];
  const build = cloudErrors(platforms, native);
  if (build)
    errors.push({
      target: build.target,
      kind: CardErrorKind.Build,
      title: WORDS.buildError(WORDS.name[build.target]),
      text: build.errors.join("\n"),
    });
  errors.push(...startError(platforms, native));
  for (const row of platforms) {
    const failed = native?.failed.find((one) => one.platform === row.target);
    if (!failed || currentSent(row, native)) continue;
    errors.push({
      target: row.target,
      kind: CardErrorKind.Send,
      title: WORDS.sendError(WORDS.name[row.target]),
      text: failed.error,
    });
  }
  return errors;
}
