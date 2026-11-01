/**
 * The fast decision model a play's pilot may ask (TypeSafe's Jev): its key's state in Settings, and
 * the decider a play hands each of the pilot's asks to. It is optional everywhere: without a key a
 * pilot chooses its moves by its own order, and nothing else in a play changes.
 */
import type { PilotAnswer, PilotAsk } from "./engine-play.ts";

/** Where the key stands, as Settings shows it. Wire values: never rename. */
export const FastDecisionKeyState = {
  /** A key TypeSafe took is saved. */
  Ready: "ready",
  /** No key is saved: pilots choose by their own order. */
  Missing: "missing",
  /** TypeSafe refused the key just pasted; nothing was saved. */
  Refused: "refused",
  /** TypeSafe could not be reached to check the key; nothing was saved. */
  Unreachable: "unreachable",
  /** The OS secret store is locked: no key can be read or saved. */
  Locked: "locked",
} as const;
export type FastDecisionKeyState = (typeof FastDecisionKeyState)[keyof typeof FastDecisionKeyState];

/** The key's state, with the words of what went wrong when something did. */
export interface FastDecisionKeyStatus {
  state: FastDecisionKeyState;
  detail?: string;
}

/** The model the decider asks, by its exact id: answers change only when this does. */
export const FAST_DECISION_MODEL = "jev-1.14.0";

/**
 * Answers a pilot's asks. `choose` never throws: an answer that does not come in time, or comes
 * malformed, is null, and the pilot then chooses by its own order.
 */
export interface FastDecider {
  /** The model that answers. */
  readonly model: string;
  choose(ask: PilotAsk, signal?: AbortSignal): Promise<PilotAnswer | null>;
  /** What the decider has spent and seen so far: input tokens, and why answers did not come. */
  tally(): { inputTokens: number; failures: string[] };
}
