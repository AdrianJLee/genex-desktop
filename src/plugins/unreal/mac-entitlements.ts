/**
 * A packaged Mac game's network entitlement. Unreal signs a Shipping Mac app with
 * `ShippingSpecificMacEntitlements`, which Unreal 5.8 points at `Sandbox.NoNet.entitlements`: the App
 * Sandbox with no network at all. macOS then refuses the game every DNS lookup ("Sandbox
 * restriction"), so a multiplayer game's sign-in and join never leave the computer. A package Genex
 * makes keeps the sandbox and adds `com.apple.security.network.client`, the smallest grant that lets
 * it sign in over HTTPS and join over WebSocket and UDP (the plugin's UDP socket is connected, never
 * bound or listening, so it needs no `network.server`). The app is signed again ad hoc, as Unreal
 * signed it: Genex never signs a person's game with an identity of its own.
 */
import { execFile } from "node:child_process";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { SECOND_MS } from "../../shared/duration.ts";

/** The entitlements this module reads and grants, by Apple's key. */
export const MacEntitlement = {
  AppSandbox: "com.apple.security.app-sandbox",
  NetworkClient: "com.apple.security.network.client",
  GetTaskAllow: "com.apple.security.get-task-allow",
} as const;
export type MacEntitlement = (typeof MacEntitlement)[keyof typeof MacEntitlement];

/** A signature's entitlements as plist values (true, strings, arrays). */
export type MacEntitlements = Record<string, unknown>;

/** Reads an app's signed entitlements and signs it again ad hoc with others; tests stand in. */
export type MacSigner = {
  read(app: string): Promise<MacEntitlements>;
  sign(app: string, entitlements: MacEntitlements): Promise<void>;
};

/** How long one codesign or plutil call may take: a game's program is a few hundred megabytes. */
const SIGN_TIMEOUT_MS = 120 * SECOND_MS;
/** codesign's and plutil's output: an entitlements plist is a few kilobytes. */
const MAX_OUTPUT_BYTES = 1024 * 1024;
const TEMP_PREFIX = "genex-entitlements-";

const run = promisify(execFile);
const options = { timeout: SIGN_TIMEOUT_MS, maxBuffer: MAX_OUTPUT_BYTES, encoding: "utf8" } as const;

/**
 * The entitlements `entitlements` must become for the app to reach the network, or null when it
 * already can: an app outside the App Sandbox, or a sandboxed one granted `network.client`.
 */
export function withNetwork(entitlements: MacEntitlements): MacEntitlements | null {
  const sandboxed = entitlements[MacEntitlement.AppSandbox] === true;
  if (!sandboxed || entitlements[MacEntitlement.NetworkClient] === true) return null;
  return { ...entitlements, [MacEntitlement.NetworkClient]: true };
}

/**
 * Lets the Mac app at `app` reach the network when its sandbox doesn't: signs it again with
 * `network.client` added and reads the signature back. True when it signed; throws when it couldn't.
 */
export async function letAppReachNetwork(app: string, signer: MacSigner): Promise<boolean> {
  const wanted = withNetwork(await signer.read(app));
  if (!wanted) return false;
  await signer.sign(app, wanted);
  if (withNetwork(await signer.read(app))) throw new Error("the signature still has no network.client");
  return true;
}

/** A plist's value as JSON, through plutil (which reads XML and binary plists alike). */
async function plistAsJson(file: string): Promise<MacEntitlements> {
  const { stdout } = await run("/usr/bin/plutil", ["-convert", "json", "-o", "-", file], options);
  const value: unknown = JSON.parse(stdout);
  if (typeof value !== "object" || value === null || Array.isArray(value)) throw new Error("not a plist dictionary");
  return value as MacEntitlements;
}

/** Runs `use` with a private folder of its own, removed after. */
async function inTempFolder<T>(use: (folder: string) => Promise<T>): Promise<T> {
  const folder = await mkdtemp(path.join(tmpdir(), TEMP_PREFIX));
  try {
    return await use(folder);
  } finally {
    await rm(folder, { recursive: true, force: true });
  }
}

/** The computer's own codesign: reads the app's entitlements, and signs the app ad hoc with new ones. */
export const systemMacSigner: MacSigner = {
  read: (app) =>
    inTempFolder(async (folder) => {
      const file = path.join(folder, "signed.plist");
      await run("/usr/bin/codesign", ["--display", "--entitlements", file, "--xml", app], options);
      // An app signed with no entitlements leaves the file empty or unwritten.
      const text = await readFile(file, "utf8").catch(() => "");
      return text.trim() === "" ? {} : plistAsJson(file);
    }),
  sign: (app, entitlements) =>
    inTempFolder(async (folder) => {
      const json = path.join(folder, "wanted.json");
      const plist = path.join(folder, "wanted.plist");
      await writeFile(json, JSON.stringify(entitlements));
      await run("/usr/bin/plutil", ["-convert", "xml1", "-o", plist, json], options);
      await run("/usr/bin/codesign", ["--force", "--sign", "-", "--entitlements", plist, app], options);
    }),
};
