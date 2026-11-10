/**
 * The Publish card of a game made in an engine: one row per platform the person can act on, each
 * saying only what is true now, a switch for whether players get it, and one button whose words say
 * what it does (canvas "Publish to every platform", round 4). Build makes every switched-on app at
 * once and gives players nothing; Publish gives them every switched-on app, one that Genex Cloud
 * still builds as soon as it is built (canvas "Publish: Mac and Windows together", flow A).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HOUR_MS, MINUTE_MS } from "../../src/shared/duration.ts";
import {
  CloudBuildFailure,
  CloudBuildState,
  CloudSendState,
  GenexBuildReview,
  type GenexCloudBuild,
  GenexSendStage,
  type GenexNativeRecord,
} from "../../src/shared/genex.ts";
import { NativeArch } from "../../src/shared/play-native.ts";
import { type PublishPlatform, PublishPlatformState, PublishTarget } from "../../src/shared/publish-platforms.ts";
import {
  busyPress,
  cardErrors,
  CardErrorKind,
  type CardInput,
  type CardRow,
  CardTone,
  CardWork,
  cardRows,
  keptSwitches,
  pressNote,
  pressPlan,
} from "../../src/renderer/panels/plugins/genex/publish-card-view.ts";
import { leftOutAfter, readLeftOut, writeLeftOut } from "../../src/renderer/panels/plugins/genex/publish-left-out.ts";
import { WebOffer } from "../../src/renderer/panels/plugins/genex/publish-platforms-view.ts";
import { type KeyValueStorage, storageKeyFor } from "../../src/renderer/storage.ts";

const NOW = Date.parse("2026-11-06T20:00:00Z");
const at = (agoMs: number): string => new Date(NOW - agoMs).toISOString();
const GAME_CHANGED = at(HOUR_MS);

/** A folder row: the web, or an app ready, older than the game, or missing. */
function platform(target: PublishTarget, state: PublishPlatformState, builtAgo?: number): PublishPlatform {
  const built = state !== PublishPlatformState.Missing && target !== PublishTarget.Web;
  return {
    target,
    state,
    arch: built ? NativeArch.Universal : null,
    bytes: built ? Math.round(3.2 * 1024 ** 3) : 0,
    builtAt: built && builtAgo !== undefined ? at(builtAgo) : null,
    uploads: state === PublishPlatformState.Ready,
    changedAt: GAME_CHANGED,
  };
}

const MISSING = PublishPlatformState.Missing;
const READY = PublishPlatformState.Ready;
const STALE = PublishPlatformState.Stale;

/** An Unreal game's folder on a Mac: a Mac app, nothing for Windows or Linux, no web build. */
const unrealFolder = (mac: PublishPlatformState, builtAgo = 2 * 24 * HOUR_MS): PublishPlatform[] => [
  platform(PublishTarget.Web, MISSING),
  platform(PublishTarget.Mac, mac, builtAgo),
  platform(PublishTarget.Windows, MISSING),
  platform(PublishTarget.Linux, MISSING),
];

/** The states of a build that made its app. */
const ENDED: ReadonlySet<CloudBuildState> = new Set([CloudBuildState.Done, CloudBuildState.Built]);

const cloudBuild = (
  state: CloudBuildState,
  startedAgo: number,
  extra: Partial<GenexCloudBuild> = {},
): GenexCloudBuild => ({
  platform: PublishTarget.Windows,
  jobId: `job-${startedAgo}`,
  state,
  startedAt: at(startedAgo),
  ...(ENDED.has(state) ? { finishedAt: at(startedAgo - 20 * MINUTE_MS) } : {}),
  ...extra,
});

/** A Windows app Genex Cloud built and keeps until a publish asks for it. */
const keptBuild = (startedAgo: number): GenexCloudBuild =>
  cloudBuild(CloudBuildState.Built, startedAgo, { held: true, installedBytes: Math.round(2.9 * 1024 ** 3) });

/** The record of a Mac app sent `sentAgo` ago and Genex Cloud's Windows builds. */
function record(
  sentAgo: number | null,
  builds: GenexCloudBuild[] = [],
  extra: Partial<GenexNativeRecord> = {},
): GenexNativeRecord {
  return {
    supported: true,
    sending: false,
    sent:
      sentAgo === null
        ? []
        : [
            {
              platform: PublishTarget.Mac,
              arch: NativeArch.Universal,
              version: "1",
              sizeBytes: 1,
              publishedAt: at(sentAgo),
            },
          ],
    failed: [],
    cloud: { supported: true, builds },
    ...extra,
  };
}

/** An Unreal game on a Mac: the Mac app is made here, the Windows app on Genex Cloud. */
const unreal = (platforms: PublishPlatform[], native: GenexNativeRecord, more: Partial<CardInput> = {}): CardRow[] =>
  cardRows({
    platforms,
    native,
    now: NOW,
    webOffer: WebOffer.Unavailable,
    madeHere: new Set([PublishTarget.Mac]),
    mac: true,
    ...more,
  });

const said = (rows: readonly CardRow[]) => rows.map((row) => [row.name, row.tone, row.status, row.side, row.work]);
const NO_SWITCHES = new Map<PublishTarget, boolean>();
const MAC_OFF = new Map([[PublishTarget.Mac, false]]);
const WINDOWS_OFF = new Map([[PublishTarget.Windows, false]]);
const targets = (plan: ReturnType<typeof pressPlan>) => plan?.steps.map((step) => step.target) ?? [];

describe("the Publish card's rows", () => {
  it("says both apps are older than the game, and how each gets built", () => {
    const rows = unreal(
      unrealFolder(STALE),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS)]),
    );
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Old, "Live · older than your game", "builds on this Mac", CardWork.Build],
      ["Windows", CardTone.Old, "Live · older than your game", "builds on Genex Cloud", CardWork.Cloud],
    ]);
    const build = pressPlan(rows, NO_SWITCHES);
    assert.deepEqual(
      [build?.label, build?.steps],
      [
        "Build Mac and Windows",
        [
          { target: PublishTarget.Mac, work: CardWork.Build },
          { target: PublishTarget.Windows, work: CardWork.Cloud },
        ],
      ],
      "one Build makes both at once: nothing goes to players before a second press",
    );
    const built = unreal(
      unrealFolder(READY, 2 * MINUTE_MS),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS), keptBuild(HOUR_MS)]),
    );
    assert.deepEqual(said(built), [
      ["Mac", CardTone.Old, "Live · update ready", "3.2 GB", CardWork.Publish],
      ["Windows", CardTone.Old, "Live · update ready", "2.9 GB", CardWork.Release],
    ]);
    const update = pressPlan(built, NO_SWITCHES);
    assert.equal(update?.label, "Update Mac and Windows");
    assert.deepEqual(update?.steps, [
      { target: PublishTarget.Mac, work: CardWork.Publish },
      { target: PublishTarget.Windows, work: CardWork.Release },
    ]);
  });

  it("counts a Windows app Genex Cloud built as live: never 'only Mac players'", () => {
    const folder = unrealFolder(READY, 30 * MINUTE_MS);
    const rows = unreal(folder, record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 40 * MINUTE_MS)]));
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Live, "Live · up to date", "20 min ago", null],
      ["Windows", CardTone.Live, "Live · up to date", "20 min ago", null],
    ]);
    assert.equal(pressPlan(rows, NO_SWITCHES), null, "nothing to press once both are up to date");
  });

  it("shows no row for a platform this computer can't publish", () => {
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(null, [], { cloud: { supported: false, builds: [] } }),
    );
    assert.deepEqual(
      rows.map((row) => row.target),
      [PublishTarget.Mac],
      "no Windows row without Genex Cloud, no Linux row on a Mac, no web row for Unreal",
    );
  });

  it("builds on Genex Cloud with a clock, and the busy button says the wait can be long", () => {
    const building = cloudBuild(CloudBuildState.Building, 8 * MINUTE_MS);
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 2 * 24 * HOUR_MS), building]),
    );
    const windows = rows.find((row) => row.target === PublishTarget.Windows);
    assert.deepEqual(
      [windows?.tone, windows?.status, windows?.since, windows?.cloud],
      [CardTone.Working, "Building on Genex Cloud", building.startedAt, true],
    );
    assert.deepEqual(busyPress(rows), {
      label: "Updating Windows",
      since: building.startedAt,
      note: "It can take up to an hour.",
    });
  });

  it("says a project on its way to Genex Cloud is sending, with its clock", () => {
    const send = { platform: PublishTarget.Windows, startedAt: at(MINUTE_MS), state: CloudSendState.Sending };
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [], { cloud: { supported: true, builds: [], send } }),
    );
    const windows = rows.find((row) => row.target === PublishTarget.Windows);
    assert.deepEqual(
      [windows?.status, windows?.since, windows?.cloud],
      ["Sending to Genex Cloud", send.startedAt, true],
    );
  });

  it("carries how far a project on its way to Genex Cloud is, on its own row only", () => {
    const progress = { stage: GenexSendStage.Upload, doneBytes: 4, totalBytes: 10, at: NOW, target: "windows" };
    const send = { platform: PublishTarget.Windows, startedAt: at(MINUTE_MS), state: CloudSendState.Sending, progress };
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [], { cloud: { supported: true, builds: [], send } }),
    );
    assert.deepEqual(
      rows.map((row) => [row.target, row.progress?.doneBytes]),
      [
        [PublishTarget.Mac, undefined],
        [PublishTarget.Windows, 4],
      ],
    );
  });

  it("carries how far an app being sent is, on the row of the app the CLI names", () => {
    const folder = [platform(PublishTarget.Mac, READY, MINUTE_MS), platform(PublishTarget.Windows, READY, MINUTE_MS)];
    const sending = (target: string | undefined) =>
      unreal(
        folder,
        record(null, [], {
          sending: true,
          progress: {
            stage: GenexSendStage.Upload,
            doneBytes: 7,
            totalBytes: 10,
            at: NOW,
            ...(target ? { target } : {}),
          },
        }),
      ).map((row) => [row.target, row.tone, row.progress?.doneBytes]);
    assert.deepEqual(sending("windows-x64"), [
      [PublishTarget.Mac, CardTone.Working, undefined],
      [PublishTarget.Windows, CardTone.Working, 7],
    ]);
    assert.deepEqual(sending("mac-universal"), [
      [PublishTarget.Mac, CardTone.Working, 7],
      [PublishTarget.Windows, CardTone.Working, undefined],
    ]);
    // An app the CLI did not name is on no row: better no bar than one on the wrong app.
    assert.deepEqual(sending(undefined), [
      [PublishTarget.Mac, CardTone.Working, undefined],
      [PublishTarget.Windows, CardTone.Working, undefined],
    ]);
  });

  it("keeps the older app live when a cloud build fails, and builds again only once the game changed", () => {
    const failedAt = (startedAgo: number, failure: CloudBuildFailure) =>
      cloudBuild(CloudBuildState.Failed, startedAgo, { failure, finishedAt: at(startedAgo - 5 * MINUTE_MS) });
    const windowsOf = (failed: GenexCloudBuild) =>
      unreal(
        unrealFolder(READY, 30 * MINUTE_MS),
        record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 2 * 24 * HOUR_MS), failed]),
      ).find((row) => row.target === PublishTarget.Windows);
    const same = windowsOf(failedAt(20 * MINUTE_MS, CloudBuildFailure.Compile));
    assert.deepEqual(
      [same?.tone, same?.status, same?.work],
      [CardTone.Bad, "Couldn’t build · the older one is still live", null],
      "the same project fails the same way: the agent fixes it first",
    );
    const changed = windowsOf(failedAt(3 * HOUR_MS, CloudBuildFailure.Compile));
    assert.equal(changed?.work, CardWork.Cloud, "the game changed since: building again can help");
    const spent = windowsOf(failedAt(3 * HOUR_MS, CloudBuildFailure.Quota));
    assert.equal(spent?.work, null, "no builds left: trying again can't help");
  });

  it("says an app Genex reviews is in review, and one it turned down is not approved", () => {
    const pending = record(20 * MINUTE_MS);
    const [sent] = pending.sent;
    if (sent) sent.review = GenexBuildReview.Pending;
    const mac = unreal(unrealFolder(READY, 30 * MINUTE_MS), pending)[0];
    assert.deepEqual([mac?.tone, mac?.status, mac?.work, mac?.live], [CardTone.Review, "In review", null, true]);
    if (sent) sent.review = GenexBuildReview.Rejected;
    const turned = unreal(unrealFolder(READY, 30 * MINUTE_MS), pending)[0];
    assert.deepEqual([turned?.tone, turned?.status, turned?.work], [CardTone.Bad, "Not approved", null]);
    const newer = unreal(unrealFolder(READY, 5 * MINUTE_MS), pending)[0];
    assert.equal(newer?.work, CardWork.Publish, "a newer build of a turned-down app can go");
  });

  it("says the agent is building an app it was asked for until the new build lands", () => {
    const asked = new Map([[PublishTarget.Mac, at(5 * MINUTE_MS)]]);
    const stale = unreal(unrealFolder(STALE), record(2 * 24 * HOUR_MS), { asked })[0];
    assert.deepEqual(
      [stale?.tone, stale?.status, stale?.since],
      [CardTone.Working, "Building on this Mac", at(5 * MINUTE_MS)],
    );
    const landed = unreal(unrealFolder(READY, 2 * MINUTE_MS), record(2 * 24 * HOUR_MS), { asked })[0];
    assert.deepEqual(
      [landed?.tone, landed?.status, landed?.work],
      [CardTone.Old, "Live · update ready", CardWork.Publish],
      "the new build waits for the press",
    );
  });

  it("says an app is not built, built before the game's last change, or ready to publish", () => {
    const windowsKept = record(null, [keptBuild(HOUR_MS)]);
    assert.deepEqual(said(unreal(unrealFolder(MISSING), record(null))), [
      ["Mac", CardTone.None, "Not built", "builds on this Mac", CardWork.Build],
      ["Windows", CardTone.None, "Not built", "builds on Genex Cloud", CardWork.Cloud],
    ]);
    assert.deepEqual(said(unreal(unrealFolder(STALE), windowsKept)), [
      ["Mac", CardTone.None, "Built · older than your game", "builds on this Mac", CardWork.Build],
      ["Windows", CardTone.Ready, "Ready to publish", "2.9 GB", CardWork.Release],
    ]);
    assert.deepEqual(said(unreal(unrealFolder(READY, 10 * MINUTE_MS), windowsKept)), [
      ["Mac", CardTone.Ready, "Ready to publish", "3.2 GB", CardWork.Publish],
      ["Windows", CardTone.Ready, "Ready to publish", "2.9 GB", CardWork.Release],
    ]);
  });

  it("leaves a build Genex no longer keeps out: the app is not built", () => {
    const gone = cloudBuild(CloudBuildState.Failed, 20 * 24 * HOUR_MS, { failure: CloudBuildFailure.Expired });
    const windows = unreal(unrealFolder(MISSING), record(null, [gone])).find(
      (row) => row.target === PublishTarget.Windows,
    );
    assert.deepEqual([windows?.status, windows?.work], ["Not built", CardWork.Cloud]);
  });

  it("says nothing of an older failed build once a newer one was built and then dropped", () => {
    const failed = cloudBuild(CloudBuildState.Failed, 30 * 24 * HOUR_MS, {
      failure: CloudBuildFailure.Compile,
      errors: ["error C2065: 'Health': undeclared identifier"],
    });
    const gone = cloudBuild(CloudBuildState.Failed, 20 * 24 * HOUR_MS, { failure: CloudBuildFailure.Expired });
    const native = record(null, [failed, gone]);
    const windows = unreal(unrealFolder(MISSING), native).find((row) => row.target === PublishTarget.Windows);
    assert.deepEqual([windows?.tone, windows?.status, windows?.work], [CardTone.None, "Not built", CardWork.Cloud]);
    assert.deepEqual(cardErrors(unrealFolder(MISSING), native), [], "the game has built since: its old error is gone");
  });

  it("says a Windows app Genex Cloud built before the game's last change is older than the game, and builds it again", () => {
    // The game changed an hour ago; Genex Cloud built its Windows app three hours ago and keeps it.
    const older = keptBuild(3 * HOUR_MS);
    assert.deepEqual(said(unreal(unrealFolder(READY, 10 * MINUTE_MS), record(null, [older]))), [
      ["Mac", CardTone.Ready, "Ready to publish", "3.2 GB", CardWork.Publish],
      ["Windows", CardTone.None, "Built · older than your game", "builds on Genex Cloud", CardWork.Cloud],
    ]);
    const live = record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 13 * HOUR_MS), older]);
    const windows = unreal(unrealFolder(READY, 3 * 24 * HOUR_MS), live).find(
      (row) => row.target === PublishTarget.Windows,
    );
    assert.deepEqual(
      [windows?.tone, windows?.status, windows?.work],
      [CardTone.Old, "Live · older than your game", CardWork.Cloud],
      "players keep the app they have until the new one is built",
    );
  });
});

describe("the Publish card's button", () => {
  /** A Unity game on a Mac with a web build and a Mac app, published nowhere yet. */
  const unityRows = (): CardRow[] =>
    cardRows({
      platforms: [
        platform(PublishTarget.Web, READY),
        platform(PublishTarget.Mac, READY, 10 * MINUTE_MS),
        platform(PublishTarget.Windows, MISSING),
        platform(PublishTarget.Linux, MISSING),
      ],
      native: record(null, [], { cloud: { supported: true, builds: [] } }),
      now: NOW,
      webOffer: WebOffer.Make,
      madeHere: null,
      hostedWeb: false,
      mac: true,
    });

  it("starts with what is ready switched on and names it", () => {
    const rows = unityRows();
    assert.deepEqual(
      rows.map((row) => [row.name, row.status, row.on, row.work]),
      [
        ["Web", "Ready to publish", true, CardWork.Publish],
        ["Mac", "Ready to publish", true, CardWork.Publish],
        ["Windows", "Not built", false, CardWork.Build],
        ["Linux", "Not built", false, CardWork.Build],
      ],
    );
    assert.equal(pressPlan(rows, NO_SWITCHES)?.label, "Publish to web and Mac");
  });

  it("builds the apps the agent makes first, alone, and counts from three platforms", () => {
    const both = new Map([
      [PublishTarget.Windows, true],
      [PublishTarget.Linux, true],
    ]);
    const build = pressPlan(unityRows(), both);
    assert.deepEqual(
      [build?.label, build?.steps.map((step) => step.work)],
      ["Build Windows and Linux", [CardWork.Build, CardWork.Build]],
    );
    const windowsBuilt = cardRows({
      platforms: [
        platform(PublishTarget.Web, READY),
        platform(PublishTarget.Mac, READY, 10 * MINUTE_MS),
        platform(PublishTarget.Windows, READY, 5 * MINUTE_MS),
        platform(PublishTarget.Linux, MISSING),
      ],
      native: record(null),
      now: NOW,
      webOffer: WebOffer.Make,
      madeHere: null,
      hostedWeb: false,
      mac: true,
    });
    assert.equal(pressPlan(windowsBuilt, NO_SWITCHES)?.label, "Publish to 3 platforms");
  });

  it("opens an Unreal game on a Mac with both apps switched on and one Build for both", () => {
    const rows = unreal(unrealFolder(MISSING), record(null));
    assert.deepEqual(
      rows.map((row) => [row.target, row.on]),
      [
        [PublishTarget.Mac, true],
        [PublishTarget.Windows, true],
      ],
    );
    const plan = pressPlan(rows, NO_SWITCHES);
    assert.deepEqual(plan, {
      label: "Build Mac and Windows",
      steps: [
        { target: PublishTarget.Mac, work: CardWork.Build },
        { target: PublishTarget.Windows, work: CardWork.Cloud },
      ],
      warn: false,
    });
    assert.equal(pressPlan(rows, MAC_OFF)?.label, "Build Windows");
    assert.equal(pressPlan(rows, WINDOWS_OFF)?.label, "Build Mac");
    const neither = new Map([...MAC_OFF, ...WINDOWS_OFF]);
    assert.equal(pressPlan(rows, neither), null, "no button only when nothing is switched on");
  });

  it("switches on the app this PC builds, and leaves the other off", () => {
    const rows = cardRows({
      platforms: unrealFolder(MISSING),
      native: record(null),
      now: NOW,
      webOffer: WebOffer.Unavailable,
      madeHere: new Set([PublishTarget.Windows, PublishTarget.Linux]),
      mac: false,
    });
    assert.deepEqual(
      rows.map((row) => [row.name, row.status, row.side, row.on]),
      [
        ["Windows", "Not built", "builds on this PC", true],
        ["Linux", "Not built", "builds on this PC", false],
      ],
    );
    assert.equal(pressPlan(rows, NO_SWITCHES)?.label, "Build Windows");
  });

  it("builds a Windows app that isn't made before it publishes the Mac app that is", () => {
    const rows = unreal(unrealFolder(READY, 10 * MINUTE_MS), record(null));
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Ready, "Ready to publish", "3.2 GB", CardWork.Publish],
      ["Windows", CardTone.None, "Not built", "builds on Genex Cloud", CardWork.Cloud],
    ]);
    const plan = pressPlan(rows, NO_SWITCHES);
    assert.deepEqual(
      [plan?.label, plan?.steps],
      ["Build Windows", [{ target: PublishTarget.Windows, work: CardWork.Cloud }]],
    );
    assert.equal(pressPlan(rows, WINDOWS_OFF)?.label, "Publish to Mac", "Mac never waits for Windows");
  });

  it("says both are building while they build, and which one is slow", () => {
    const asked = new Map([[PublishTarget.Mac, at(6 * MINUTE_MS)]]);
    const send = {
      platform: PublishTarget.Windows,
      startedAt: at(5 * MINUTE_MS),
      state: CloudSendState.Sending,
      held: true,
    };
    const sending = unreal(unrealFolder(MISSING), record(null, [], { cloud: { supported: true, builds: [], send } }), {
      asked,
    });
    assert.equal(pressPlan(sending, NO_SWITCHES), null, "while the agent builds here, the Windows app waits with it");
    assert.deepEqual(busyPress(sending), {
      label: "Building Mac and Windows",
      since: at(6 * MINUTE_MS),
      note: "Windows can take up to an hour.",
    });
    const held = cloudBuild(CloudBuildState.Building, 5 * MINUTE_MS, { held: true });
    const building = unreal(unrealFolder(MISSING), record(null, [held]), { asked });
    assert.equal(busyPress(building)?.label, "Building Mac and Windows");
  });

  it("publishes the Mac app that is built together with the Windows app Genex Cloud still builds", () => {
    const held = cloudBuild(CloudBuildState.Building, 20 * MINUTE_MS, { held: true });
    const rows = unreal(unrealFolder(READY, 2 * MINUTE_MS), record(null, [held]));
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Ready, "Ready to publish", "3.2 GB", CardWork.Publish],
      ["Windows", CardTone.Working, "Building on Genex Cloud", null, CardWork.Release],
    ]);
    const plan = pressPlan(rows, NO_SWITCHES);
    assert.deepEqual(plan, {
      label: "Publish to Mac and Windows",
      steps: [
        { target: PublishTarget.Mac, work: CardWork.Publish },
        { target: PublishTarget.Windows, work: CardWork.Release },
      ],
      warn: false,
    });
    assert.equal(pressNote(rows, targets(plan)), "Windows can take up to an hour.");
  });

  it("publishes a game's only app once it is built: a game with nothing to play is never published", () => {
    const send = {
      platform: PublishTarget.Windows,
      startedAt: at(MINUTE_MS),
      state: CloudSendState.Sending,
      held: true,
    };
    const rows = unreal(unrealFolder(MISSING), record(null, [], { cloud: { supported: true, builds: [], send } }));
    assert.equal(pressPlan(rows, NO_SWITCHES)?.label, "Build Mac", "an app switched on and not built is built first");
    assert.equal(pressPlan(rows, MAC_OFF), null, "nothing to publish yet");
    assert.deepEqual(busyPress(rows), {
      label: "Building Windows",
      since: send.startedAt,
      note: "It can take up to an hour.",
    });
    const built = unreal(unrealFolder(MISSING), record(null, [keptBuild(HOUR_MS)]));
    const plan = pressPlan(built, MAC_OFF);
    assert.deepEqual(
      [plan?.label, plan?.steps],
      ["Publish to Windows", [{ target: PublishTarget.Windows, work: CardWork.Release }]],
    );
  });

  it("updates a live game's Windows app while Genex Cloud still builds it, and never beside a take-down alone", () => {
    const held = cloudBuild(CloudBuildState.Building, 5 * MINUTE_MS, { held: true });
    const rows = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(MINUTE_MS, [held]));
    const plan = pressPlan(rows, NO_SWITCHES);
    assert.deepEqual(
      [plan?.label, plan?.steps],
      ["Publish to Windows", [{ target: PublishTarget.Windows, work: CardWork.Release }]],
      "Mac players have the game: Windows follows when built",
    );
    assert.equal(pressNote(rows, targets(plan)), "It can take up to an hour.");
    const down = pressPlan(rows, MAC_OFF);
    assert.deepEqual(
      [down?.label, down?.steps],
      ["Take Mac down", [{ target: PublishTarget.Mac, work: CardWork.TakeDown }]],
      "with Mac taken down nothing is left to play until Windows is built",
    );
  });

  it("says a Windows app that was published is on its way to players while Genex Cloud builds it", () => {
    const released = cloudBuild(CloudBuildState.Building, 26 * MINUTE_MS);
    const rows = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(MINUTE_MS, [released]));
    assert.deepEqual(said(rows), [
      ["Mac", CardTone.Live, "Live · up to date", "1 min ago", null],
      ["Windows", CardTone.Working, "Building on Genex Cloud", null, null],
    ]);
    assert.equal(pressPlan(rows, NO_SWITCHES), null, "nothing left to press: Windows goes live by itself");
    assert.deepEqual(busyPress(rows), {
      label: "Publishing to Windows",
      since: released.startedAt,
      note: "It can take up to an hour.",
    });
    const send = {
      platform: PublishTarget.Windows,
      startedAt: at(MINUTE_MS),
      state: CloudSendState.Sending,
      released: true,
    };
    const going = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(MINUTE_MS, [], { cloud: { supported: true, builds: [], send } }),
    );
    assert.equal(busyPress(going)?.label, "Publishing to Windows");
    assert.equal(pressPlan(going, NO_SWITCHES), null);
  });

  it("never offers to publish a project on its way up that Genex won't keep: its app goes to players by itself", () => {
    // A build asked for without keeping (a game with a page, from the platforms list) is no kept app.
    const send = { platform: PublishTarget.Windows, startedAt: at(MINUTE_MS), state: CloudSendState.Sending };
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [], { cloud: { supported: true, builds: [], send } }),
    );
    const windows = rows.find((row) => row.target === PublishTarget.Windows);
    assert.deepEqual([windows?.making, windows?.work], [false, null]);
    assert.equal(pressPlan(rows, NO_SWITCHES), null, "nothing to press: it is on its way to players already");
    assert.equal(busyPress(rows)?.label, "Publishing to Windows");
  });

  it("publishes both once both are built, or only the one switched on", () => {
    const rows = unreal(unrealFolder(READY, 40 * MINUTE_MS), record(null, [keptBuild(HOUR_MS)]));
    assert.equal(pressPlan(rows, NO_SWITCHES)?.label, "Publish to Mac and Windows");
    const macOnly = pressPlan(rows, WINDOWS_OFF);
    assert.deepEqual(
      [macOnly?.label, macOnly?.steps],
      ["Publish to Mac", [{ target: PublishTarget.Mac, work: CardWork.Publish }]],
      "the Windows app stays built",
    );
  });

  it("takes a live platform down when its switch goes off, and warns", () => {
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 40 * MINUTE_MS)]),
    );
    const plan = pressPlan(rows, new Map([[PublishTarget.Windows, false]]));
    assert.deepEqual(plan, {
      label: "Take Windows down",
      steps: [{ target: PublishTarget.Windows, work: CardWork.TakeDown }],
      warn: true,
    });
  });

  it("says both when it updates one platform and takes another down", () => {
    const rows = unreal(
      unrealFolder(READY, 2 * MINUTE_MS),
      record(2 * 24 * HOUR_MS, [cloudBuild(CloudBuildState.Done, 40 * MINUTE_MS)]),
    );
    const plan = pressPlan(rows, new Map([[PublishTarget.Windows, false]]));
    assert.equal(plan?.label, "Update Mac and take Windows down");
    assert.equal(plan?.warn, false);
  });

  it("says the agent is building while it builds", () => {
    const asked = new Map([[PublishTarget.Mac, at(3 * MINUTE_MS)]]);
    const rows = unreal(unrealFolder(STALE), record(2 * 24 * HOUR_MS), { asked });
    assert.deepEqual(busyPress(rows), { label: "Building Mac", since: at(3 * MINUTE_MS), note: null });
  });

  it("says whether the live web version is the game as it is now", () => {
    const web = (publishedAgo: number) =>
      cardRows({
        platforms: [platform(PublishTarget.Web, READY)],
        native: record(null),
        now: NOW,
        webOffer: WebOffer.Make,
        madeHere: null,
        hostedWeb: true,
        webPublishedAt: at(publishedAgo),
        mac: true,
      })[0];
    const current = web(10 * MINUTE_MS);
    assert.deepEqual([current?.status, current?.side, current?.work], ["Live · up to date", "10 min ago", null]);
    const older = web(2 * HOUR_MS);
    assert.deepEqual([older?.status, older?.work], ["Live · older than your game", CardWork.Publish]);
    assert.equal(pressPlan(older ? [older] : [], NO_SWITCHES)?.label, "Update web");
  });

  it("leaves a platform off when its switch is off and it isn't live", () => {
    const rows = unityRows();
    const plan = pressPlan(rows, new Map([[PublishTarget.Web, false]]));
    assert.equal(plan?.label, "Publish to Mac");
  });
});

describe("the Publish card's switches", () => {
  /** An Unreal game on a PC before its first publish: its web build is ready, its Windows app is not built. */
  const pcRows = (): CardRow[] =>
    cardRows({
      platforms: [
        platform(PublishTarget.Web, READY),
        platform(PublishTarget.Mac, MISSING),
        platform(PublishTarget.Windows, MISSING),
        platform(PublishTarget.Linux, MISSING),
      ],
      native: record(null),
      now: NOW,
      webOffer: WebOffer.Make,
      madeHere: new Set([PublishTarget.Windows, PublishTarget.Linux]),
      hostedWeb: false,
      mac: false,
    });
  /** Nothing switched in this dialog: the card was opened again, or a press just ended. */
  const NOTHING_CHOSEN = new Map<PublishTarget, boolean>();
  const WINDOWS_LEFT_OUT = new Set([PublishTarget.Windows]);

  it("keeps a platform the person left out switched off, after the press and when the card opens again", () => {
    const rows = pcRows();
    assert.equal(pressPlan(rows, NO_SWITCHES)?.label, "Build Windows", "the Windows app starts switched on");
    const switches = keptSwitches(rows, WINDOWS_LEFT_OUT, NOTHING_CHOSEN);
    assert.equal(switches.get(PublishTarget.Windows), false);
    assert.equal(pressPlan(rows, switches)?.label, "Publish to web", "the web build never waits for it again");
  });

  it("lets a switch turned in this dialog win over what was kept", () => {
    const rows = pcRows();
    const on = keptSwitches(rows, WINDOWS_LEFT_OUT, new Map([[PublishTarget.Windows, true]]));
    assert.equal(pressPlan(rows, on)?.label, "Build Windows");
    const webOff = keptSwitches(rows, WINDOWS_LEFT_OUT, new Map([[PublishTarget.Web, false]]));
    assert.equal(pressPlan(rows, webOff), null, "both are off: nothing to press");
  });

  it("opens a platform players have switched on whatever was kept: an old choice never offers to take it down", () => {
    const rows = unreal(
      unrealFolder(READY, 30 * MINUTE_MS),
      record(20 * MINUTE_MS, [cloudBuild(CloudBuildState.Done, 40 * MINUTE_MS)]),
    );
    assert.equal(pressPlan(rows, keptSwitches(rows, WINDOWS_LEFT_OUT, NOTHING_CHOSEN)), null);
    const off = keptSwitches(rows, WINDOWS_LEFT_OUT, new Map([[PublishTarget.Windows, false]]));
    assert.equal(pressPlan(rows, off)?.label, "Take Windows down", "switched off in this dialog, it is taken down");
  });

  it("keeps a platform that was taken down switched off: its app, still built, is not offered again", () => {
    // The Mac app is live; the Windows one was taken down, and Genex Cloud still keeps its build.
    const rows = unreal(unrealFolder(READY, 30 * MINUTE_MS), record(20 * MINUTE_MS, [keptBuild(40 * MINUTE_MS)]));
    assert.equal(pressPlan(rows, NO_SWITCHES)?.label, "Publish to Windows", "a built app starts switched on");
    assert.equal(pressPlan(rows, keptSwitches(rows, WINDOWS_LEFT_OUT, NOTHING_CHOSEN)), null);
  });

  /** A storage of one game's page: what was written, by key. */
  function memory(start: Record<string, string> = {}): KeyValueStorage & { kept: Map<string, string> } {
    const kept = new Map(Object.entries(start));
    return {
      kept,
      getItem: (key) => kept.get(key) ?? null,
      setItem: (key, value) => void kept.set(key, value),
      removeItem: (key) => void kept.delete(key),
    };
  }
  const KEY = storageKeyFor.publishLeftOut("genex-strike");

  it("remembers per game which platforms were switched off, and forgets one switched on again", () => {
    const storage = memory();
    const off = leftOutAfter(readLeftOut("genex-strike", storage), PublishTarget.Windows, false);
    writeLeftOut("genex-strike", off, storage);
    assert.deepEqual([...readLeftOut("genex-strike", storage)], [PublishTarget.Windows]);
    assert.deepEqual([...readLeftOut("another-game", storage)], [], "another game has its own switches");
    writeLeftOut("genex-strike", leftOutAfter(off, PublishTarget.Windows, true), storage);
    assert.equal(storage.kept.has(KEY), false, "nothing left out: nothing kept");
  });

  it("reads anything else that was kept as nothing left out", () => {
    const hostile = ["", "{", "null", '"windows"', '{"windows":false}', "[1,null,{}]", '["steam","Windows"]'];
    for (const kept of hostile)
      assert.deepEqual([...readLeftOut("genex-strike", memory({ [KEY]: kept }))], [], JSON.stringify(kept));
    const mixed = memory({ [KEY]: '["linux","steam","web"]' });
    assert.deepEqual([...readLeftOut("genex-strike", mixed)], [PublishTarget.Linux, PublishTarget.Web]);
    assert.deepEqual([...readLeftOut("genex-strike", null)], [], "no storage: nothing is remembered");
    assert.doesNotThrow(() => writeLeftOut("genex-strike", new Set([PublishTarget.Mac]), null));
  });
});

describe("the Publish card's error blocks", () => {
  it("names a failed Genex Cloud build and hands over its whole log, never showing it", () => {
    const failed = cloudBuild(CloudBuildState.Failed, 10 * MINUTE_MS, {
      failure: CloudBuildFailure.Compile,
      errors: ["Weapon.cpp(88): 'FVector' undeclared", "Weapon.cpp(90): ';' expected"],
    });
    const errors = cardErrors(unrealFolder(READY, 30 * MINUTE_MS), record(20 * MINUTE_MS, [failed]));
    assert.deepEqual(errors, [
      {
        target: PublishTarget.Windows,
        kind: CardErrorKind.Build,
        title: "Windows build error",
        text: "Weapon.cpp(88): 'FVector' undeclared\nWeapon.cpp(90): ';' expected",
      },
    ]);
  });

  it("names an app that didn't reach Genex, and its row leaves the retry to the block", () => {
    const native = record(null, [], {
      failed: [{ platform: PublishTarget.Mac, arch: "universal", error: "HTTP 413" }],
    });
    const folder = unrealFolder(READY, 10 * MINUTE_MS);
    assert.deepEqual(cardErrors(folder, native), [
      { target: PublishTarget.Mac, kind: CardErrorKind.Send, title: "Mac app didn’t send", text: "HTTP 413" },
    ]);
    const mac = unreal(folder, native)[0];
    assert.deepEqual(
      [mac?.status, mac?.work],
      ["Couldn’t send", null],
      "Try again is the block's, not the main button's",
    );
  });

  it("names a Windows build that didn't start, and its row leaves the retry to the block", () => {
    const send = {
      platform: PublishTarget.Windows,
      startedAt: at(2 * MINUTE_MS),
      state: CloudSendState.Failed,
      error: "This account has used its builds for this month.",
    };
    const native = record(null, [], { cloud: { supported: true, builds: [], send } });
    const folder = unrealFolder(MISSING);
    assert.deepEqual(cardErrors(folder, native), [
      {
        target: PublishTarget.Windows,
        kind: CardErrorKind.Start,
        title: "Windows build didn’t start",
        text: "This account has used its builds for this month.",
      },
    ]);
    const asked = new Map([[PublishTarget.Mac, at(2 * MINUTE_MS)]]);
    const rows = unreal(folder, native, { asked });
    const windows = rows.find((row) => row.target === PublishTarget.Windows);
    assert.deepEqual(
      [windows?.tone, windows?.status, windows?.work, windows?.on],
      [CardTone.Bad, "Couldn’t send", null, true],
    );
    assert.equal(busyPress(rows)?.label, "Building Mac", "the Mac app builds on");
    const closed = { platform: PublishTarget.Windows, startedAt: at(2 * MINUTE_MS), state: CloudSendState.Failed };
    const stopped = record(null, [], { cloud: { supported: true, builds: [], send: closed } });
    assert.deepEqual(
      cardErrors(folder, stopped).map((error) => [error.kind, error.text]),
      [[CardErrorKind.Start, ""]],
      "stopped with Studio: no words to copy, the same Try again",
    );
  });

  it("has no block once the app went after all", () => {
    const native = record(5 * MINUTE_MS, [], {
      failed: [{ platform: PublishTarget.Mac, arch: "universal", error: "HTTP 413" }],
    });
    assert.deepEqual(cardErrors(unrealFolder(READY, 10 * MINUTE_MS), native), []);
  });
});
