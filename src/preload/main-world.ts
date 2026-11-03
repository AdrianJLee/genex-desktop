/**
 * The bridge's calls as the page receives them. Electron's context bridge copies a thrown `Error`
 * with its words only: any other property is lost on the way, so a failure's typed `code` and the
 * channel it failed on never reached the renderer, and every `error_toast_shown` and
 * `message_send_failed` read no code. A call's failure therefore crosses as a plain record, which
 * the bridge copies whole ({@link crossableCalls}), and a function the preload runs in the page's
 * own world ({@link installInMainWorld}) throws it there again as an `Error` with both.
 * Type-only imports: `installInMainWorld` is serialized into the page and may use nothing from
 * outside its body.
 */
import type { StudioApi } from "../shared/studio-api.ts";

// biome-ignore lint/suspicious/noExplicitAny: the bridge's calls, each with its own signature
type AnyCall = (...args: any[]) => unknown;

/** A failed call as it crosses the context bridge: its words, and its code and channel when it had them. */
export interface CrossingFailure {
  /** Marks the record as a crossing failure, so nothing else is turned back into an error. */
  studioFailure: true;
  message: string;
  code?: string;
  channel?: string;
}

/** A thrown value's own string field, when it has one. */
function ownText(error: unknown, field: "code" | "channel"): string | undefined {
  if (error === null || typeof error !== "object") return undefined;
  const value: unknown = Reflect.get(error, field);
  return typeof value === "string" ? value : undefined;
}

/** What crosses the bridge for a call that threw `error`: a plain record the bridge copies whole. */
export function crossingFailure(error: unknown): CrossingFailure {
  const message = error instanceof Error ? error.message : String(error);
  const code = ownText(error, "code");
  const channel = ownText(error, "channel");
  return { studioFailure: true, message, ...(code ? { code } : {}), ...(channel ? { channel } : {}) };
}

/** `call`, with its promise's failure turned into a {@link CrossingFailure}; a plain value is passed on. */
function crossable(call: AnyCall): AnyCall {
  return (...args) => {
    const out = call(...args);
    if (!(out instanceof Promise)) return out;
    return out.catch((error: unknown) => {
      throw crossingFailure(error);
    });
  };
}

/** The bridge's calls, each failing with a record the context bridge carries whole. */
export function crossableCalls<T extends Partial<StudioApi>>(calls: T): T {
  const entries = Object.entries(calls).map(([name, value]) => [
    name,
    typeof value === "function" ? crossable(value as AnyCall) : value,
  ]);
  return Object.fromEntries(entries) as T;
}

/**
 * Define `scope[name]` as the bridge's calls, each throwing a crossing failure again as an `Error`
 * with its code and channel. Run in the page's own world (`contextBridge.executeInMainWorld`), so
 * the error it throws is the page's and keeps every property; `scope` is the page's global object.
 */
// biome-ignore lint/suspicious/noExplicitAny: the page's global object and the copied calls
export function installInMainWorld(name: string, calls: Record<string, any>, scope: any = globalThis): void {
  const thrown = (reason: unknown): unknown => {
    const failure = reason as { studioFailure?: unknown; message?: unknown; code?: unknown; channel?: unknown };
    if (!failure || typeof failure !== "object" || failure.studioFailure !== true) return reason;
    const error: Error & { code?: string; channel?: string } = new Error(String(failure.message ?? ""));
    if (typeof failure.code === "string") error.code = failure.code;
    if (typeof failure.channel === "string") error.channel = failure.channel;
    return error;
  };
  // biome-ignore lint/suspicious/noExplicitAny: each call keeps its own arguments
  const rethrowing =
    (call: (...args: any[]) => any) =>
    (...args: any[]) => {
      const out = call(...args);
      if (!out || typeof out.then !== "function") return out;
      return out.then(undefined, (reason: unknown) => {
        throw thrown(reason);
      });
    };
  const api: Record<string, unknown> = {};
  for (const key of Object.keys(calls)) {
    const value = calls[key];
    api[key] = typeof value === "function" ? rethrowing(value) : value;
  }
  Object.defineProperty(scope, name, { value: Object.freeze(api), enumerable: true });
}
