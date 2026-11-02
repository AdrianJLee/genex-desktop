/**
 * The chat's context for a game linked to an engine project (`studio.json` `engine`): where its work
 * lands, an Unreal project in the person's open editor or a Godot project whose folder may lie
 * outside the game's, while the game's folder keeps its notes (chat-session.ts `chatContext`).
 */

/** The folder of a linked project file (its `project.godot`). */
export function projectFolderOf(projectFile: string): string {
  const cut = Math.max(projectFile.lastIndexOf("/"), projectFile.lastIndexOf("\\"));
  return cut > 0 ? projectFile.slice(0, cut) : projectFile;
}

/** Where a linked Godot game's work lands. */
export function godotLinkLine(projectFile: string): string {
  return `Its work lands in its Godot project in \`${projectFolderOf(projectFile)}/\` (res:// is that folder); this folder holds the game's notes.`;
}

/**
 * Where an Unreal game's work lands: the project it is linked to (`project`), in the person's open
 * Unreal Editor; or, for a project found in the folder at `found` and not linked yet, that it is not.
 * How it is linked and built is the Unreal plugin's guidance.
 */
export function unrealLinkLine(project: string | null, found: string): string {
  if (project)
    return `Its work lands in the Unreal project \`${project}\`, in the person's open Unreal Editor; this folder holds the game's notes.`;
  const where = found === "." ? "this folder" : `\`${found}/\``;
  return `The Unreal project in ${where} is not linked to this game yet.`;
}
