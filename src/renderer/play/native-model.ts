/**
 * What Play draws for a native game, worked out from the catalog, this computer's installs and the
 * games being played: the game page's one primary block (install, installing, play, playing,
 * update, elsewhere, failed) and the badge on its card. Pure, so it is tested without a window.
 */
import { MINUTE_MS } from "../../shared/duration.ts";
import type { PlayGame } from "../../shared/play.ts";
import {
  buildFor,
  hasWebBuild,
  type InstalledGame,
  type InstallFailure,
  InstallPhase,
  type InstallProgress,
  installUnderWay,
  type LaunchFailure,
  type NativeBuild,
  type NativeInstalls,
  NativePlatform,
  type NativeSession,
  NativeSessionPhase,
  type NotHere,
  platformsOf,
  whyNotHere,
} from "../../shared/play-native.ts";

/** Where a native game stands on this computer, as its page's primary block says. */
export const GamePhase = {
  Install: "install",
  Installing: "installing",
  Ready: "ready",
  Playing: "playing",
  Update: "update",
  /** No build for this computer: the page says where it plays instead. */
  Elsewhere: "elsewhere",
  Failed: "failed",
} as const;
export type GamePhase = (typeof GamePhase)[keyof typeof GamePhase];

/** Why the last try failed: an install's or a launch's reason. */
export type GameFailure = { install: InstallFailure } | { launch: LaunchFailure };

/** A native game on this computer, for its page. */
export interface GameStanding {
  phase: GamePhase;
  /** The build this computer installs, or null. */
  build: NativeBuild | null;
  installed: InstalledGame | null;
  /** The install under way (or failed), or null. */
  progress: InstallProgress | null;
  /** Its session being played (or failed to start), or null. */
  session: NativeSession | null;
  failure: GameFailure | null;
  /** The kind of computer this is, as the builds name it: what its words call it. */
  here: NativePlatform;
  /** Why no build installs here, once main has said what this computer is; null when one does. */
  notHere: NotHere | null;
}

/** Whether an install is still going. */
export const installing = (progress: InstallProgress | null | undefined): progress is InstallProgress =>
  installUnderWay(progress ?? undefined);

/** Whether a session is starting or being played. */
const live = (session: NativeSession | null): boolean =>
  session !== null && session.phase !== NativeSessionPhase.Failed;

/** The failure to show, if the last install or launch failed: the newer one when both did. */
function failureOf(progress: InstallProgress | null, session: NativeSession | null): GameFailure | null {
  if (session?.phase === NativeSessionPhase.Failed && session.failure) return { launch: session.failure };
  if (progress?.phase === InstallPhase.Failed && progress.failure) return { install: progress.failure };
  return null;
}

/** The phase that follows from what is installed and what this computer is offered. */
function restingPhase(build: NativeBuild | null, installed: InstalledGame | null): GamePhase {
  if (!installed) return build ? GamePhase.Install : GamePhase.Elsewhere;
  return build && build.version !== installed.version ? GamePhase.Update : GamePhase.Ready;
}

/** Where `game` stands on this computer: what its page's primary block shows. */
export function gameStanding(
  game: Pick<PlayGame, "slug" | "native">,
  installs: NativeInstalls,
  sessions: readonly NativeSession[],
): GameStanding {
  const build = installs.host ? buildFor(game.native?.builds ?? [], installs.host) : null;
  const installed = installs.installed.find((one) => one.slug === game.slug) ?? null;
  const progress = installs.progress.find((one) => one.slug === game.slug) ?? null;
  const session = sessions.find((one) => one.slug === game.slug) ?? null;
  const failure = failureOf(progress, session);
  const here = installs.host?.platform ?? NativePlatform.Mac;
  const notHere = installs.host ? whyNotHere(game.native?.builds ?? [], installs.host) : null;
  const standing = { build, installed, progress, session, failure, here, notHere };
  if (live(session)) return { ...standing, phase: GamePhase.Playing };
  if (installing(progress)) return { ...standing, phase: GamePhase.Installing };
  if (failure) return { ...standing, phase: GamePhase.Failed };
  return { ...standing, phase: restingPhase(build, installed) };
}

/** How far an install has come, in whole percent. */
export const installPercent = (progress: InstallProgress): number =>
  progress.totalBytes > 0 ? Math.min(100, Math.floor((progress.receivedBytes / progress.totalBytes) * 100)) : 0;

/** What the game page's install line says. */
export const InstallLine = {
  Waiting: "waiting",
  Downloading: "downloading",
  Verifying: "verifying",
  Unpacking: "unpacking",
} as const;
export type InstallLine = (typeof InstallLine)[keyof typeof InstallLine];

/** The install line and what it tells: a download's percent, with its speed and minutes left once both are known. */
export type InstallLineView =
  | { line: typeof InstallLine.Waiting }
  | { line: typeof InstallLine.Verifying }
  | { line: typeof InstallLine.Unpacking }
  | {
      line: typeof InstallLine.Downloading;
      percent: number;
      bytesPerSecond: number | null;
      minutesLeft: number | null;
    };

/** The steps after the download, each its own line. */
const STEP_LINE: Partial<Record<InstallPhase, InstallLineView>> = {
  [InstallPhase.Queued]: { line: InstallLine.Waiting },
  [InstallPhase.Verifying]: { line: InstallLine.Verifying },
  [InstallPhase.Unpacking]: { line: InstallLine.Unpacking },
};

/** What the install line says for `progress`: waiting, the download with its speed and time left, verifying or unpacking. */
export function installLine(progress: InstallProgress | null | undefined): InstallLineView {
  const step = progress && STEP_LINE[progress.phase];
  if (step) return step;
  const speed = progress?.bytesPerSecond ?? null;
  const etaMs = progress?.etaMs ?? null;
  const known = speed !== null && speed > 0 && etaMs !== null;
  return {
    line: InstallLine.Downloading,
    percent: progress ? installPercent(progress) : 0,
    bytesPerSecond: known ? speed : null,
    minutesLeft: known ? Math.ceil(etaMs / MINUTE_MS) : null,
  };
}

/** What a card shows over its cover's corner for a native game. */
export const CardBadge = {
  /** Not installed: which systems it was built for. */
  Platforms: "platforms",
  Downloading: "downloading",
  Installed: "installed",
  Update: "update",
} as const;
export type CardBadge = (typeof CardBadge)[keyof typeof CardBadge];

/** A card's badge and what it says. */
export type CardBadgeState =
  | { kind: typeof CardBadge.Platforms; platforms: NativePlatform[] }
  | { kind: typeof CardBadge.Downloading; percent: number; etaMs: number | null }
  | { kind: typeof CardBadge.Installed; platform: NativePlatform }
  | { kind: typeof CardBadge.Update; bytes: number };

/**
 * The badge a card shows, or null: a game with a web build shows nothing new (its card plays the web
 * build), unless it is installed or installing here.
 */
export function cardBadge(game: Pick<PlayGame, "slug" | "native">, installs: NativeInstalls): CardBadgeState | null {
  if (!game.native) return null;
  const progress = installs.progress.find((one) => one.slug === game.slug);
  if (installing(progress))
    return { kind: CardBadge.Downloading, percent: installPercent(progress), etaMs: progress.etaMs };
  const installed = installs.installed.find((one) => one.slug === game.slug);
  const build = installs.host ? buildFor(game.native.builds, installs.host) : null;
  if (installed && build && build.version !== installed.version)
    return { kind: CardBadge.Update, bytes: build.sizeBytes };
  if (installed) return { kind: CardBadge.Installed, platform: installed.platform };
  if (hasWebBuild(game)) return null;
  return { kind: CardBadge.Platforms, platforms: platformsOf(game) };
}

/**
 * Whether pressing `game`'s card opens its page rather than the viewer: it has an app to install
 * (its page offers the app, and the browser too when it has a web build), or no web build at all.
 */
export const opensPage = (game: Pick<PlayGame, "native">): boolean =>
  !hasWebBuild(game) || (game.native?.builds.length ?? 0) > 0;

/**
 * How a game's page offers its web build: not at all; as the one way to play here; first, with the
 * app to install beside it; or second, beside the installed app's Play.
 */
export const WebPlay = { None: "none", Only: "only", First: "first", Second: "second" } as const;
export type WebPlay = (typeof WebPlay)[keyof typeof WebPlay];

/** Where each resting phase puts the web build; in every other phase the block is the app's alone. */
const WEB_PLAY_IN: Partial<Record<GamePhase, WebPlay>> = {
  [GamePhase.Elsewhere]: WebPlay.Only,
  [GamePhase.Install]: WebPlay.First,
  [GamePhase.Ready]: WebPlay.Second,
};

/** How the page offers `game`'s web build while it stands as `standing` on this computer ({@link WebPlay}). */
export const webPlayOn = (game: Pick<PlayGame, "native">, standing: GameStanding): WebPlay =>
  hasWebBuild(game) ? (WEB_PLAY_IN[standing.phase] ?? WebPlay.None) : WebPlay.None;

/** Whole minutes since `startedAt` at `now`. */
export const minutesSince = (startedAt: string, now: number): number =>
  Math.max(0, Math.floor((now - Date.parse(startedAt)) / MINUTE_MS));
