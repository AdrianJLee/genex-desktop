/**
 * The words a chat session is given when a tool that only waits ends because the person wrote in the
 * chat (person-wrote.ts). A change of how its turn runs is never said in words: its engine and model
 * are the next leg's options, and another engine's new session is told the chat so far.
 */

import { WorkerTool } from "./workers/contract.ts";

/** What a tool that only waits answers when the person's words ended its wait (person-wrote.ts). */
export const WAIT_ENDED = {
  workers: `The user just wrote in the chat, so this wait ended early: read their message and answer it, then wait again (${WorkerTool.Wait}) if you still need to.`,
} as const;
