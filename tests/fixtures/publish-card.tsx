/**
 * Test-owned production Publish dialog over a fake `window.studio`, for the Publish card of a game
 * made in an engine (canvas "Publish to every platform", round 4): an Unreal game on a Mac whose Mac
 * app is made here and whose Windows app Genex Cloud builds, the same game on a PC, and a Unity game
 * with all four platforms. Each scene is a moment of the card (canvas "Publish: Mac and Windows
 * together", flow A): nothing built, both building, the Mac app built while Windows builds, Windows
 * following by itself, both built, done, apps older than the game, a newer one ready, a failed build,
 * a build that didn't start, a send that failed, a switch turned off, a PC whose web build is ready
 * while its Windows app is not built, and the rows while the folder is still read.
 */
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";
import manifest from "../../src/plugins/genex/plugin.json" with { type: "json" };
import { initializeAppearance, updateAppearance } from "../../src/renderer/appearance/store.ts";
import { AppearanceMode } from "../../src/renderer/appearance/themes.ts";
import { COMPOSE_IN_CHAT_EVENT, type ComposeInChat } from "../../src/renderer/compose-in-chat.ts";
import { GenexPublishDialog } from "../../src/renderer/panels/plugins/genex/GenexPublish.tsx";
import { studio } from "../../src/renderer/state/studio.ts";
import { removeKey, storageKeyFor } from "../../src/renderer/storage.ts";
import type { GameProject } from "../../src/shared/game-project.ts";
import { GenexAccountStatus } from "../../src/shared/genex-account.ts";
import {
  CloudBuildFailure,
  CloudBuildState,
  CloudSendState,
  GenexAction,
  type GenexCloudBuild,
  type GenexNativeRecord,
  type GenexPublishState,
} from "../../src/shared/genex.ts";
import { GenexGameReview, type GenexReviewStatus } from "../../src/shared/genex-review.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import type { PluginInfo } from "../../src/shared/plugins.ts";
import { CoreFact } from "../../src/shared/project-facts.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../src/shared/publish-platforms.ts";
import { UiEvent } from "../../src/shared/ui-events.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const GAME = "genex-strike";
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const rootElement = document.getElementById("root");
if (!rootElement) throw new Error("Missing fixture root");
const root = createRoot(rootElement);
const frame = () => new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
async function settle(frames = 10) {
  for (let i = 0; i < frames; i++) await frame();
}

/** The moments of the card. */
type Scene =
  | "first"
  | "startFails"
  | "macBuilt"
  | "following"
  | "bothBuilt"
  | "windowsBuilt"
  | "old"
  | "built"
  | "updateReady"
  | "building"
  | "done"
  | "failed"
  | "failedFirst"
  | "sendFailed"
  | "pc"
  | "pcWeb"
  | "unity"
  | "loading";

const ago = (ms: number): string => new Date(Date.now() - ms).toISOString();
const CHANGED = (): string => ago(HOUR);

/** A folder row. */
function row(target: PublishTarget, state: PublishPlatformState, builtAgo: number | null = null): PublishPlatform {
  const built = state !== PublishPlatformState.Missing && target !== PublishTarget.Web;
  return {
    target,
    state,
    arch: built ? (target === PublishTarget.Mac ? NativeArch.Universal : NativeArch.X64) : null,
    bytes: built ? 3.2 * 1024 ** 3 : 0,
    builtAt: built && builtAgo !== null ? ago(builtAgo) : null,
    uploads: state === PublishPlatformState.Ready,
    changedAt: CHANGED(),
  };
}
const { Ready, Stale, Missing } = PublishPlatformState;
const unreal = (mac: PublishPlatformState, builtAgo: number): PublishPlatform[] => [
  row(PublishTarget.Web, Missing),
  row(PublishTarget.Mac, mac, builtAgo),
  row(PublishTarget.Windows, Missing),
  row(PublishTarget.Linux, Missing),
];

const PLATFORMS: Record<Scene, () => PublishPlatform[]> = {
  first: () => unreal(Missing, 0),
  startFails: () => unreal(Missing, 0),
  macBuilt: () => unreal(Ready, 2 * MINUTE),
  following: () => unreal(Ready, 30 * MINUTE),
  bothBuilt: () => unreal(Ready, 40 * MINUTE),
  windowsBuilt: () => unreal(Missing, 0),
  old: () => unreal(Stale, 2 * DAY),
  // Built after the agent was asked in `old`: the new Mac app has landed.
  built: () => unreal(Ready, 0),
  updateReady: () => unreal(Ready, 2 * MINUTE),
  building: () => unreal(Ready, 30 * MINUTE),
  done: () => unreal(Ready, 30 * MINUTE),
  failed: () => unreal(Ready, 30 * MINUTE),
  failedFirst: () => unreal(Ready, 10 * MINUTE),
  sendFailed: () => unreal(Ready, 10 * MINUTE),
  pc: () => unreal(Missing, 0),
  pcWeb: () => [
    row(PublishTarget.Web, Ready),
    row(PublishTarget.Mac, Missing),
    row(PublishTarget.Windows, Missing),
    row(PublishTarget.Linux, Missing),
  ],
  loading: () => unreal(Ready, 30 * MINUTE),
  unity: () => [
    row(PublishTarget.Web, Ready),
    row(PublishTarget.Mac, Ready, 50 * MINUTE),
    row(PublishTarget.Windows, Ready, 5 * MINUTE),
    row(PublishTarget.Linux, Missing),
  ],
};

const cloud = (state: CloudBuildState, startedAgo: number, extra: Partial<GenexCloudBuild> = {}): GenexCloudBuild => ({
  platform: "windows",
  jobId: `job-${startedAgo}`,
  state,
  startedAt: ago(startedAgo),
  ...(state === CloudBuildState.Done || state === CloudBuildState.Built
    ? { finishedAt: ago(startedAgo - 20 * MINUTE) }
    : {}),
  ...extra,
});
/** A Windows app Genex Cloud built and keeps for the publish. */
const kept = (startedAgo: number): GenexCloudBuild =>
  cloud(CloudBuildState.Built, startedAgo, { held: true, installedBytes: Math.round(2.9 * 1024 ** 3) });
/** A Windows app Genex Cloud still builds and keeps. */
const keeping = (startedAgo: number): GenexCloudBuild => cloud(CloudBuildState.Building, startedAgo, { held: true });
const sent = (platform: string, sentAgo: number) => ({
  platform,
  arch: platform === "mac" ? "universal" : "x64",
  version: "1.4",
  sizeBytes: 1,
  publishedAt: ago(sentAgo),
});

/** The publish record's apps and Genex Cloud's Windows builds in each scene. */
function appsOf(of: Scene): GenexNativeRecord {
  const record = (sentList: ReturnType<typeof sent>[], builds: GenexCloudBuild[]): GenexNativeRecord => ({
    supported: true,
    sending: false,
    sent: sentList,
    failed: [],
    cloud: { supported: true, builds },
  });
  const COMPILE = ["Source/Strike/Weapon.cpp(88): error C2065: 'FVector': undeclared identifier", "and 3 more"];
  const records: Record<Scene, () => GenexNativeRecord> = {
    first: () => record([], []),
    startFails: () => record([], []),
    macBuilt: () => record([], [keeping(20 * MINUTE)]),
    // Published while Genex Cloud still built it: it goes to players as soon as it is built.
    following: () => record([sent("mac", 5 * MINUTE)], [cloud(CloudBuildState.Building, 26 * MINUTE)]),
    bothBuilt: () => record([], [kept(HOUR)]),
    windowsBuilt: () => record([], [kept(HOUR)]),
    old: () => record([sent("mac", 2 * DAY)], [cloud(CloudBuildState.Done, 13 * HOUR)]),
    built: () => record([sent("mac", 2 * DAY)], [cloud(CloudBuildState.Done, 13 * HOUR)]),
    updateReady: () => record([sent("mac", 2 * DAY)], [cloud(CloudBuildState.Done, 13 * HOUR), kept(50 * MINUTE)]),
    building: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, DAY), cloud(CloudBuildState.Building, 8 * MINUTE)]),
    done: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
    failed: () =>
      record(
        [sent("mac", 20 * MINUTE)],
        [cloud(CloudBuildState.Done, DAY), cloud(CloudBuildState.Failed, 10 * MINUTE, { failure: CloudBuildFailure.Compile, errors: COMPILE })],
      ),
    failedFirst: () =>
      record([], [cloud(CloudBuildState.Failed, 10 * MINUTE, { failure: CloudBuildFailure.Compile, errors: COMPILE })]),
    sendFailed: () => ({
      ...record([], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
      failed: [{ platform: "mac", arch: "universal", error: "Couldn't get an upload token (HTTP 413)." }],
    }),
    pc: () => ({ ...record([], []), cloud: { supported: true, builds: [] } }),
    pcWeb: () => record([], []),
    loading: () => record([sent("mac", 20 * MINUTE)], [cloud(CloudBuildState.Done, 40 * MINUTE)]),
    unity: () => record([sent("mac", 40 * MINUTE)], []),
  };
  const made = records[of]();
  if (!cloudSend || !made.cloud) return made;
  return { ...made, cloud: { ...made.cloud, send: cloudSend } };
}

/** The scenes of a game that has no page on Genex yet. */
const NOT_ON_GENEX: ReadonlySet<Scene> = new Set([
  "first",
  "startFails",
  "macBuilt",
  "bothBuilt",
  "windowsBuilt",
  "failedFirst",
  "pc",
  "pcWeb",
]);
/** The scenes on a PC; every other is on a Mac. */
const ON_A_PC: ReadonlySet<Scene> = new Set(["pc", "pcWeb"]);
/** What Genex Cloud refuses a build with in `startFails`: never shown, only copied. */
const REFUSED = "This account has used its Genex Cloud builds for this month.";

let scene: Scene = "old";
/** The agent's Mac build has landed in the folder while the card stays open (`land`). */
let landed = false;
/** The game's project on its way to Genex Cloud since the card's Build, or the one that didn't arrive. */
let cloudSend: NonNullable<GenexNativeRecord["cloud"]>["send"];
/**
 * The game each scene opens: the Mac app the agent builds in `old` lands in `built`, so those two share
 * one game (the card remembers its ask per game); every other scene is a game of its own.
 */
let game = GAME;
const composed: ComposeInChat[] = [];
window.addEventListener(COMPOSE_IN_CHAT_EVENT, (event) => composed.push((event as CustomEvent<ComposeInChat>).detail));
const onGenex = (): boolean => !NOT_ON_GENEX.has(scene);
const state = (): GenexPublishState => ({
  version: 1,
  project: game,
  connected: true,
  ...(onGenex()
    ? { slug: game, status: "published", galleryUrl: `https://genex.games/${GAME}`, lastPublishAt: ago(40 * MINUTE) }
    : {}),
  native: appsOf(scene),
  ...(scene === "unity" ? { hostedWeb: true } : {}),
});
/** What the card asked of Genex and main: the actions, publishes and Genex Cloud builds. */
const asked: string[] = [];
const fake = fakeStudioApi();
fake.stub("pluginReview", async (_id, name) => {
  asked.push(`review:${name}`);
  return { ticket: "fixture-ticket" };
});
fake.stub("pluginAction", async (_id, name, args) => {
  if (name === GenexAction.PublishStatus) return state();
  asked.push(`${name}${args && typeof args === "object" && "platform" in args ? `:${String(args.platform)}` : ""}`);
  return {};
});
/** While the scene is `loading`, the folder's read waits until `release`. */
let release: () => void = () => {};
fake.stub("genexPublishPlatforms", async () => {
  if (scene === "loading") await new Promise<void>((resolve) => (release = resolve));
  return landed ? PLATFORMS.built() : PLATFORMS[scene]();
});
fake.stub("genexPublishApps", async (_project, _title, _remix, platforms, release) => {
  asked.push(`apps:${(platforms ?? []).join("+")}`);
  if (release?.length) asked.push(`release:${release.join("+")}`);
});
fake.stub("genexPublish", async (_project, _review, _title, _remix, _replace, platforms) => {
  asked.push(`web:${(platforms ?? []).join("+")}`);
});
/** A held press: the ask it sends to Genex Cloud waits until `letThrough`. */
let held = false;
let letThrough: () => void = () => {};
fake.stub("genexCloudBuild", async (_project, platform, keep) => {
  asked.push(`cloud:${platform}${keep ? ":keep" : ""}`);
  if (held) await new Promise<void>((resolve) => (letThrough = resolve));
  const startedAt = new Date().toISOString();
  // The record says at once how the project's way up goes: on its way, or refused.
  cloudSend =
    scene === "startFails"
      ? { platform, startedAt, state: CloudSendState.Failed, error: REFUSED }
      : { platform, startedAt, state: CloudSendState.Sending, ...(keep ? { held: true } : {}) };
});
fake.stub("genexPublishReview", async () => ({ included: ["index.html"], excluded: [] }));
const NOTHING: GenexReviewStatus = {
  record: { state: GenexGameReview.NotPublished, apps: [], takedown: null },
  checkedAt: null,
  connected: true,
  open: false,
  fingerprint: "",
  told: null,
  publishing: false,
};
fake.stub("genexReviewStatus", async () => NOTHING);
fake.stub("assetLibraryStates", async () => ({ project: game, states: [], unread: false }));
fake.stub("projectAssets", async () => ({ project: game, assets: [], truncated: false, skipped: [] }));
fake.stub("assetLibrary", async () => ({ assets: [], nextCursor: null }));
window.studio = fake.api;
initializeAppearance();
const genex = { manifest, source: "bundled", enabled: true, removed: false, state: "enabled" } as unknown as PluginInfo;

/** What a person sees on the card: each row, the button, the line under it, and what was asked. */
function sample() {
  const content = document.querySelector<HTMLElement>('[data-testid="genex-publish"] .genex-publish-content');
  const rows = [...(content?.querySelectorAll<HTMLElement>("[data-genex-publish-platforms] [data-publish-platform]") ?? [])].map(
    (one) => ({
      target: one.dataset.publishPlatform,
      tone: one.dataset.tone,
      on: one.dataset.on === "true",
      name: one.querySelector(".genex-publish-card-text > span:first-child")?.textContent ?? "",
      status: one.querySelector("[data-publish-platform-status]")?.textContent ?? "",
      side: one.querySelector(".genex-publish-card-side")?.textContent ?? null,
      clock: one.querySelector("[data-publish-platform-clock]")?.textContent ?? null,
      switch: Boolean(one.querySelector('[role="switch"]')),
    }),
  );
  const primary = document.querySelector<HTMLButtonElement>(".genex-publish-primary");
  const column = content?.getBoundingClientRect();
  const overflow = [...(content?.querySelectorAll<HTMLElement>("*") ?? [])].some(
    (el) => column !== undefined && el.getBoundingClientRect().right > column.right + 0.5,
  );
  return {
    loading: Boolean(content?.querySelector("[data-publish-card-loading]")),
    rows,
    primary: primary?.textContent ?? null,
    primaryDisabled: primary?.disabled ?? null,
    // The button's label colour and fill as drawn.
    primaryInk: primary ? getComputedStyle(primary).color : null,
    primaryFill: primary ? getComputedStyle(primary).backgroundColor : null,
    warn: primary?.dataset.warn === "true",
    note: content?.querySelector(".genex-publish-card-note")?.textContent ?? null,
    blocks: [...(content?.querySelectorAll<HTMLElement>("[data-publish-error]") ?? [])].map((block) => ({
      target: block.dataset.publishError,
      text: block.textContent ?? "",
      sent: block.hasAttribute("data-sent"),
      send: Boolean(block.querySelector("[data-publish-error-send]")),
      retry: Boolean(block.querySelector("[data-publish-error-retry]")),
      copy: Boolean(block.querySelector("[data-publish-error-copy]")),
    })),
    link: content?.querySelector("[data-public]")?.textContent ?? null,
    share: Boolean(content?.querySelector(".genex-publish-share, [data-publish-share]")),
    text: content?.textContent ?? "",
    asked: [...asked],
    composed: [...composed],
    overflow,
  };
}

/**
 * Open the dialog in `theme` on the scene's game. A game opens with no switch remembered, unless it is
 * opened `again`: then the card has what the person left switched off the time before.
 */
async function open(options: { theme?: "dark" | "light"; scene?: Scene; again?: boolean } = {}) {
  updateAppearance((appearance) => ({
    ...appearance,
    mode: options.theme === "light" ? AppearanceMode.Light : AppearanceMode.Dark,
  }));
  scene = options.scene ?? "old";
  landed = false;
  cloudSend = undefined;
  // The computer the game is made on: a Mac, or the PC of the `pc` scenes.
  document.documentElement.dataset.platform = ON_A_PC.has(scene) ? "win32" : "darwin";
  game = scene === "old" || scene === "built" ? GAME : `${GAME}-${scene}`;
  if (!options.again) removeKey(storageKeyFor.publishLeftOut(game));
  asked.length = 0;
  composed.length = 0;
  studio().people.setState((people) => ({ ...people, account: GenexAccountStatus.SignedIn }), true);
  const fact = scene === "unity" ? CoreFact.UnityProject : CoreFact.UnrealProject;
  const listed = {
    name: game,
    title: scene === "unity" ? "Moon Garden" : "genex-strike",
    createdAt: ago(10 * DAY),
    engine: { id: scene === "unity" ? "unity" : "unreal", project: "." },
    facts: [{ id: fact, path: "." }],
  } as unknown as GameProject;
  studio().library.setState((library) => ({ ...library, games: [listed] }), true);
  flushSync(() => root.render(null));
  await settle(2);
  flushSync(() => root.render(<GenexPublishDialog plugin={genex} project={game} onClose={() => {}} />));
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-status]"); i++) await frame();
  const ready = () => document.querySelector("[data-genex-publish-platforms], [data-publish-card-loading]");
  for (let i = 0; i < 100 && !ready(); i++) await frame();
  await settle();
  return sample();
}

/** The folder's read answers (the `loading` scene). */
async function answer() {
  release();
  for (let i = 0; i < 100 && !document.querySelector("[data-genex-publish-platforms]"); i++) await frame();
  await settle();
  return sample();
}

/** Turn a row's switch. */
async function toggle(target: PublishTarget) {
  document.querySelector<HTMLButtonElement>(`[data-publish-platform="${target}"] [role="switch"]`)?.click();
  await settle();
  return sample();
}

/** Press the card's button. */
async function press() {
  document.querySelector<HTMLButtonElement>(".genex-publish-primary")?.click();
  for (let i = 0; i < 60 && asked.length === 0 && composed.length === 0; i++) await frame();
  await settle();
  return sample();
}

/** Press the card's button and stop while its ask to Genex Cloud is being sent; `goThrough` lets it on. */
async function hold() {
  held = true;
  document.querySelector<HTMLButtonElement>(".genex-publish-primary")?.click();
  for (let i = 0; i < 60 && asked.length === 0; i++) await frame();
  await settle();
  return sample();
}

/** The held press goes through. */
async function goThrough() {
  held = false;
  letThrough();
  await settle();
  return sample();
}

/**
 * The agent's Mac build lands in the folder while the card stays open, and the agent's turn ends: the
 * card is never reopened, and waits at most `wait` frames for the row to change.
 */
async function land(wait = 120) {
  landed = true;
  fake.emit({ type: UiEvent.ChatStreamEnded, payload: { threadId: "t1", streamId: "s1" } });
  const status = () =>
    document.querySelector(`[data-publish-platform="mac"] [data-publish-platform-status]`)?.textContent ?? "";
  for (let i = 0; i < wait && status().startsWith("Building"); i++) await frame();
  await settle();
  return sample();
}

/** Press an error block's Send to agent, Try again or Copy (`send`, `retry`, `copy`). */
async function block(which: "send" | "retry" | "copy") {
  document.querySelector<HTMLButtonElement>(`[data-publish-error-${which}]`)?.click();
  for (let i = 0; i < 30 && asked.length === 0 && composed.length === 0; i++) await frame();
  await settle();
  return sample();
}

Object.assign(window, { cardRig: { open, answer, toggle, press, hold, goThrough, sample, land, block } });
