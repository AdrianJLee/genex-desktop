/**
 * An update of the app itself, as main tells the window about it. On macOS and Windows it is
 * downloaded in the background (`main/auto-update.ts`) and installed by a restart the person
 * chooses, or at the next quit; on Linux, where nothing installs it in place, it is a newer
 * release the person downloads (`main/release-check.ts`).
 */

/** What the person does with a waiting update. */
export const UpdateAction = {
  /** Downloaded: relaunch to install it. */
  Restart: "restart",
  /** Published but not installable in place: open its release page to download it. */
  Download: "download",
} as const;
export type UpdateAction = (typeof UpdateAction)[keyof typeof UpdateAction];

/** What Relaunch to update came to (`StudioApi.restartToUpdate`). */
export const RestartAnswer = {
  /** Genex quits and relaunches into the downloaded version. */
  Relaunching: "relaunching",
  /** Nothing downloaded waits to be installed. */
  NoUpdate: "no_update",
  /** An earlier Relaunch still asks the person; this one asks nothing. */
  AlreadyAsking: "already_asking",
  /** The person kept the running build (or the paused one's resume) going. */
  Declined: "declined",
} as const;
export type RestartAnswer = (typeof RestartAnswer)[keyof typeof RestartAnswer];

/** Where an update the app looks for on its own failed (`UiEvent.UpdateFailed`). */
export const UpdateFailure = {
  /** Asking the feed for a newer version. */
  Check: "check",
  /** Downloading the newer version it found. */
  Download: "download",
  /** Installing a downloaded version. */
  Install: "install",
} as const;
export type UpdateFailure = (typeof UpdateFailure)[keyof typeof UpdateFailure];

/** What Genex's own request to the update feed found after the installer failed (`UpdateFailedNote`). */
export const UpdateFeedState = {
  /** The feed answered, so the failure is the installer's own (Squirrel, the install folder, the download). */
  Reachable: "reachable",
  /** The feed answered with an error status (`httpStatus`). */
  Refused: "refused",
  /** No answer: the name did not resolve, the connection or TLS failed, or it timed out (`netError`). */
  Unreachable: "unreachable",
} as const;
export type UpdateFeedState = (typeof UpdateFeedState)[keyof typeof UpdateFeedState];

/** An update the app looked for on its own failed (`UiEvent.UpdateFailed`), with what Genex found out. */
export interface UpdateFailedNote {
  stage: UpdateFailure;
  /** What the update feed answered Genex's own request, or null when none was made. */
  feed: UpdateFeedState | null;
  /** Chromium's network error for an unreachable feed ("ERR_NAME_NOT_RESOLVED"), else null. */
  netError: string | null;
  /** The feed's status when it refused, else null. */
  httpStatus: number | null;
  /** Windows: Squirrel's Update.exe is beside the install; false means nothing can install in place. */
  installer: boolean | null;
  /** A newer release was found on GitHub and offered as a download instead (`UpdateAction.Download`). */
  offeredDownload: boolean;
}

/** What is running, for Settings → About: the version (null in an unpackaged build), platform and architecture. */
export interface AppAbout {
  version: string | null;
  platform: string;
  arch: string;
}

/** A new version waiting for the person: downloaded for a restart, or published for a download. */
export interface ReadyUpdate {
  /** The release's version ("0.2.0"), or null when the release named none. */
  version: string | null;
  action: UpdateAction;
}

/** What a Check for Updates found. */
export const UpdateCheckStatus = {
  /** This is the newest published version. */
  Current: "current",
  /** A newer version was found and is downloading; it announces itself when ready. */
  Downloading: "downloading",
  /** A newer version waits (`ReadyUpdate`): relaunch or download. */
  Waiting: "waiting",
  /** Linux from the Genex package repository: the system's own updates bring new versions. */
  System: "system",
  /** This build never checks: a development, test or self-packaged launch. */
  Off: "off",
  /** The check did not finish: offline, the service failed, or it took too long. */
  Failed: "failed",
} as const;
export type UpdateCheckStatus = (typeof UpdateCheckStatus)[keyof typeof UpdateCheckStatus];

/** The answer to a Check for Updates. */
export interface UpdateCheckResult {
  status: UpdateCheckStatus;
  /** The running version ("0.1.0"). */
  current: string;
  /** The waiting update, when `status` is waiting. */
  update: ReadyUpdate | null;
}
