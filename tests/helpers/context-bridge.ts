/**
 * Electron's context bridge as the page sees what crosses it, for tests that cannot start Electron.
 * A call is proxied; what it answers is copied: a thrown `Error` arrives as a new `Error` with its
 * words only (Electron's documented rule: "any custom properties on the Error object will be lost"),
 * and any other value as a structured clone.
 */
import { installInMainWorld } from "../../src/preload/main-world.ts";

/** A value as the other world receives it. */
function copied(value: unknown): unknown {
  if (value instanceof Error) return new Error(value.message);
  if (typeof value === "function") return value;
  return structuredClone(value);
}

// biome-ignore lint/suspicious/noExplicitAny: the bridged calls keep their own signatures
type AnyCall = (...args: any[]) => unknown;

/** One proxied call: its answer copied, and its promise's value or failure copied when it settles. */
function proxied(call: AnyCall): AnyCall {
  return (...args) => {
    const out = call(...args);
    if (!(out instanceof Promise)) return copied(out);
    return out.then(copied, (reason: unknown) => Promise.reject(copied(reason)));
  };
}

/** `api` as `contextBridge.exposeInMainWorld` puts it in the page. */
export function exposedInMainWorld<T extends object>(api: T): T {
  const entries = Object.entries(api).map(([name, value]) => [
    name,
    typeof value === "function" ? proxied(value as AnyCall) : copied(value),
  ]);
  return Object.fromEntries(entries) as T;
}

/** `api` as the preload installs it with `executeInMainWorld(installInMainWorld)`: the page's `studio`. */
export function installedInMainWorld<T extends object>(api: T): T {
  const page: { studio?: T } = {};
  installInMainWorld("studio", exposedInMainWorld(api), page);
  if (!page.studio) throw new Error("installInMainWorld defined no studio");
  return page.studio;
}
