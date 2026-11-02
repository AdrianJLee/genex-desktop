/**
 * The git command lines an open Loop reads its game folder with: its uncommitted changes, and the
 * removal of what an earlier seed's reads at a turn's edge left in the game's git folder. None writes
 * the folder's own index or its object store. They live in a module of
 * their own because the shipped `loop/git.ts` may gain no key another module reads: an in-app
 * agent's kept older copy would lack it.
 */
import { shellQuote } from "../../shell.ts";

/** The git commands that read an open Loop's game folder. */
export const FOLDER_GIT = {
  /**
   * The game folder's uncommitted changes as git lists them. A nested repository's own uncommitted
   * work is left out: no commit of the folder can take it, so it would read as changed after every
   * save. A look that never writes the folder's index (`--no-optional-locks`): another chat's
   * checkpoint or a worker's git in the folder never meets its lock.
   */
  status: "git --no-optional-locks status --porcelain --ignore-submodules=dirty",
  /** Removes the run's store of an earlier seed's reads (`genex-turn-<run>`) from the game's git folder: the Loop is over. */
  dropTurnStore: (runId: string): string =>
    `b="$(git rev-parse --path-format=absolute --git-path ${shellQuote(`genex-turn-${runId}`)})" && rm -rf "$b".index* "$b.objects"`,
} as const;
