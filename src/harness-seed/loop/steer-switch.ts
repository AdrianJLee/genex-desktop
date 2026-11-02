/**
 * How a message sent while the chat's turn works joins that turn (steer). Most join as words: read
 * at the session's next step. One that changes how the turn runs — another engine, model, effort or
 * roles, or a slash command — joins as a switch: the session is cut at its next step and the turn
 * goes on with that message's settings (chat-steer.ts), which only a runner that says it can take
 * switches does. A fresh build asked for and Studio's own chat never join.
 */
import type { AnyRecord } from "../types/harness.d.ts";

/** How a message joins the running turn. */
export const JoinKind = {
  /** Its words reach the session at its next step, as it runs. */
  Words: "words",
  /** It changes how the turn runs: the session is cut at its next step and goes on with its settings. */
  Switch: "switch",
  /** It never joins: it gets a turn of its own. */
  Own: "own",
} as const;
export type JoinKind = (typeof JoinKind)[keyof typeof JoinKind];

/** Slash text is a command to the session, never words to fold into its turn. */
export const isSlashText = (text: unknown): boolean =>
  String(text ?? "")
    .trimStart()
    .startsWith("/");

/**
 * A fresh build asked for (`newRun`, a New build queued before the composer dropped it) or Studio's
 * chat: it gets a turn of its own, never one already answering something else.
 */
function ownTurn(item: AnyRecord, action: AnyRecord): boolean {
  return Boolean(item.newRun || item.studioThread || action.studioThread);
}

/** The engine, model, effort and roles a message is answered on, as one comparable string. */
const answeredOn = (message: AnyRecord): string =>
  JSON.stringify([message.engine ?? null, message.model ?? null, message.effort ?? null, message.roles ?? null]);

/** Does `item` change what a turn answering `asked` runs on: its engine, model, effort or roles? Slash text is not a setting. */
export function changesSettings(item: AnyRecord, asked: AnyRecord): boolean {
  return answeredOn(item) !== answeredOn(asked);
}

/**
 * How `item`, sent while the turn answering `action` works, joins it: as words, as a switch, or not
 * at all. A message that settles the same things the turn runs on joins as words.
 */
export function joinKindOf(item: AnyRecord, action: AnyRecord | null | undefined): JoinKind {
  if (!action || ownTurn(item, action)) return JoinKind.Own;
  const switches = isSlashText(item.text) || changesSettings(item, action);
  return switches ? JoinKind.Switch : JoinKind.Words;
}

/** What a runner that takes switches says as its session opens (`SteerHandle.open`). */
export interface OpenOptions {
  /** The runner goes on with a message's settings when one changes how the turn runs. */
  switches?: boolean;
  /** Which of those it can go on with; one it cannot (another runner's engine) gets a turn of its own. */
  takes?: (item: AnyRecord) => boolean;
}
