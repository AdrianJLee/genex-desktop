/** Why a Loop did not start, or a paused one did not go on, as its close and the chat say it. */
export const OPEN_LOOP_REFUSAL = {
  needsSession: (engine: string) =>
    `A Loop needs an engine that keeps a session of its own (Claude Code, Codex, OpenCode, Grok Build or a local model's session); ${engine} doesn't, so nothing was built. The chat still answers here.`,
  /** A web game's Loop an earlier Genex paused, which built in a copy of the game folder; `ref`: where git keeps its work. */
  webLoopBefore: (ref: string) =>
    `This Loop was paused by an earlier version of Genex, which built web games in a copy of the game folder, so it can't go on in this one. Its work is in git at ${ref}: ask here to bring it into the game.`,
  /** The list of projects could not be read, so nothing tells which Loop the project needs. */
  gamesUnreadable:
    "Genex couldn't read the list of projects, so it can't tell how this project's Loop goes; nothing was built or changed. Try again in a moment.",
  /** A paused Loop's journal could not be read, so nothing tells how it goes on. */
  journalUnreadable:
    "Genex couldn't read this Loop's journal, so it can't tell how the Loop goes on; nothing was built. It stays paused: Resume tries again.",
} as const;
