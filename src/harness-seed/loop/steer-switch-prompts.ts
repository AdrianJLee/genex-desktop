/**
 * The words a chat session is given when the person changed how its turn runs while it worked
 * (steer-switch.ts, chat-steer.ts): what changed, in front of the leg's own prompt; and after a
 * slash command the person sent mid-turn, what the turn goes on with.
 */

import { WorkerTool } from "./workers/contract.ts";

/** What changed while the session worked, in front of `prompt`: one line each, then the prompt. */
export function switchedTurnPrompt(notes: readonly string[], prompt: string): string {
  return [
    "While you were working, the user changed how you work. From now on:",
    ...notes.map((note) => `- ${note}`),
    "",
    prompt,
  ].join("\n");
}

/**
 * Genex's line after a slash command the person sent while the session worked, once what they wrote
 * with it has been read: the command has run, and when it cut the work short, the session carries it on.
 */
export function afterCommandPrompt(carryOn: boolean): string {
  const ran = "The command the user sent has run.";
  return carryOn ? `${ran} Carry on with what you were doing before it, unless it changed what they want.` : ran;
}

/** The note a switch opens the next leg with (delegated-turn.ts): the engine, or the model and effort, that changed. */
export const SWITCH_NOTES = {
  model: (label: string) => `You now run on ${label}.`,
  engine: (label: string) =>
    `${label} takes over this chat: you are a new session, so read the conversation below before you act.`,
} as const;

/** What a tool that only waits answers when the person's words ended its wait (person-wrote.ts). */
export const WAIT_ENDED = {
  workers: `The user just wrote in the chat, so this wait ended early: read their message and answer it, then wait again (${WorkerTool.Wait}) if you still need to.`,
} as const;
