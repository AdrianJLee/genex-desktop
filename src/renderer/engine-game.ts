/**
 * What the app reads of a game linked to any engine (`shared/game-engine.ts`): the engine as its
 * plugin declares it (`GameProject.linkedEngine`), whether its project lies in the game folder, and
 * Rewind's note when an engine whose save points need it there finds it elsewhere. Unreal's own card,
 * editor and words stay in `unreal-game.ts`. Pure, so each rule is tested without a DOM.
 */
import {
  engineOf,
  GameEngine,
  isEngineGame,
  type LinkedEngine,
  projectName,
  UPROJECT_EXTENSION,
} from "../shared/game-engine.ts";
import type { GameProject } from "../shared/game-project.ts";
import { ENGINE_GAME_WORDS, GAME_ENGINE_WORDS } from "./words.ts";

/** The part of a game these rules read: its folder, its engine link and its engine as declared. */
export type EngineGame = Pick<GameProject, "engine"> & Partial<Pick<GameProject, "dir" | "linkedEngine">>;

/** Unreal as its plugin declares it, for a descriptor from before descriptors carried the declaration. */
const UNREAL_AS_DECLARED: LinkedEngine = {
  label: GAME_ENGINE_WORDS.unreal,
  projectFiles: [UPROJECT_EXTENSION],
  projectInFolder: true,
};

/**
 * The engine a game is linked to, as its plugin declares it; null for a web game (or no game). A
 * descriptor that carries no declaration reads Unreal as Unreal declares itself, and any other
 * engine by its id, needing its project in the folder: Rewind's note errs toward saying what Rewind
 * can't undo.
 */
export function linkedEngineOf(game: EngineGame | null | undefined): LinkedEngine | null {
  const kind = engineOf(game?.engine);
  if (!isEngineGame(kind)) return null;
  if (game?.linkedEngine) return game.linkedEngine;
  if (kind === GameEngine.Unreal) return UNREAL_AS_DECLARED;
  return { label: kind, projectFiles: [], projectInFolder: true };
}

const SEPARATOR = /[\\/]/;
const TRAILING_SEPARATORS = /[\\/]+$/;

/** Whether `file` lies under `folder`, by spelling: `/a/game-copy` is not under `/a/game`. */
export function under(file: string, folder: string): boolean {
  const base = folder.replace(TRAILING_SEPARATORS, "");
  if (!base || !file.startsWith(base)) return false;
  return SEPARATOR.test(file.charAt(base.length));
}

/** The engine a game is linked to, when its save points need its project inside the game folder. */
function folderBound(game: EngineGame | null | undefined): { engine: LinkedEngine; project: string } | null {
  const engine = linkedEngineOf(game);
  const project = game?.engine?.project;
  return engine?.projectInFolder && project ? { engine, project } : null;
}

/** Whether a linked game's project lies inside its own folder (New game puts it there). */
export function engineProjectInFolder(game: EngineGame | null | undefined): boolean {
  const project = game?.engine?.project;
  return Boolean(project && game?.dir && under(project, game.dir));
}

/**
 * What Rewind adds for a game whose engine needs its project in the game folder and finds it
 * elsewhere: its checkpoints hold only that folder, so what was changed in the engine stays. Null
 * for a web game, an engine whose save points hold its project wherever it is, and a project inside
 * the game folder. The record holds the project's real path while the game's folder may be spelled
 * through a link; a mismatch reads as outside, so the note errs toward saying what Rewind can't undo.
 */
export function engineRewindNote(game: EngineGame | null | undefined): string | null {
  const bound = folderBound(game);
  if (!bound || engineProjectInFolder(game)) return null;
  return ENGINE_GAME_WORDS.rewindNote(bound.engine.label, nameOf(bound.project, bound.engine));
}

/** A project's name as its engine shows it, by the engine's own project files (Unreal's when none are said). */
const nameOf = (project: string, engine: LinkedEngine): string =>
  projectName(project, engine.projectFiles.length > 0 ? engine.projectFiles : undefined);
