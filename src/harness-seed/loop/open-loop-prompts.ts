/** Why a run on a project that isn't a web game did not start, as its close and the chat say it. */
export const OPEN_LOOP_REFUSAL = {
  /** `found`: what Genex found that makes the project's Loop work in place (`openLoopBecause`). */
  needsSession: (engine: string, found?: string) =>
    `A Loop${found ? ` on this project (Genex finds ${found})` : ""} needs an engine that keeps a session of its own (Claude Code, Codex, OpenCode, Grok Build or a local model's session); ${engine} doesn't, so nothing was built. The chat still answers here.`,
  /** A paused web Loop, resumed on a folder that reads as no web game now; `found`: what Genex finds there. */
  webElsewhere: (found: string) =>
    `This Loop was paused as a web game's Loop, and the folder doesn't read as a web game now (Genex finds ${found}), so it can't go on now. It stays paused: once the folder reads as a web game again (move those files out of it, say), Resume picks it up.`,
  /** The list of projects could not be read, so nothing tells which Loop the project needs. */
  gamesUnreadable:
    "Genex couldn't read the list of projects, so it can't tell which kind of Loop this project needs; nothing was built or changed. Try again in a moment.",
  /** A paused Loop's journal could not be read, so nothing tells how it goes on. */
  journalUnreadable:
    "Genex couldn't read this Loop's journal, so it can't tell how the Loop goes on; nothing was built. It stays paused: Resume tries again.",
} as const;
