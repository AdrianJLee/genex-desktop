/**
 * The room-module toolchain in Studio's publish copy. The CLI bundles and validates a
 * server-authoritative game's room module with the `@genex-ai/authority-dev` it resolves from the
 * folder it runs in, as Node resolves a dependency of the game. Studio's copy of a game has no
 * dependencies of its own, so it gets a link to the pinned copy in this plugin's payload: nothing
 * is downloaded, and a game whose maker installed nothing still has its room checked and shipped.
 */
import { mkdir, rm, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { AUTHORITY_DEV_PACKAGE, type GenexGameManifest } from "../../shared/genex.ts";

/** The publish copy's dependency folder, which holds nothing but the link. */
const MODULES_DIR = "node_modules";
/** Its ignore file: git keeps none of it, so a source push never carries the link. */
const MODULES_IGNORE = "# Studio's link to its room-module toolchain, never pushed\n*\n";

/** Whether the game declares a room block at all (a malformed one too: the CLI names what is wrong). */
export function declaresRoom(manifest: GenexGameManifest | undefined): boolean {
  return manifest?.genex !== undefined && Object.hasOwn(manifest.genex, "authority");
}

/**
 * Give the publish copy `workspace` the toolchain when the game declares a room and `toolDir` (the
 * pinned package's folder) is there; otherwise leave it no dependency folder at all, so a game
 * with no room publishes from exactly the copy it always did. The folder is Studio's alone: what
 * was in it, a link included, is removed and never followed.
 */
export async function linkAuthorityToolchain(
  workspace: string,
  toolDir: string | null,
  manifest: GenexGameManifest | undefined,
): Promise<void> {
  const modules = path.join(workspace, MODULES_DIR);
  await rm(modules, { recursive: true, force: true });
  if (!toolDir || !declaresRoom(manifest)) return;
  const link = path.join(modules, ...AUTHORITY_DEV_PACKAGE.split("/"));
  await mkdir(path.dirname(link), { recursive: true });
  await writeFile(path.join(modules, ".gitignore"), MODULES_IGNORE);
  // A junction on Windows: it needs no symlink privilege (ignored elsewhere).
  await symlink(toolDir, link, "junction");
}
