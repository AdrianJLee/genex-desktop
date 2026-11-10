/**
 * Epic's own Blueprint guide for builders who never open Unreal: the Blueprint basics and the
 * Blueprint text syntax that Epic's EditorToolset ships as Python strings in the user's installed
 * engine. Genex reads them from that engine at the time of the call and copies none of Epic's text.
 * The files are the engine's, read by real path, so a link out of the engine folder is refused.
 */
import { readFile, realpath, stat } from "node:fs/promises";
import path from "node:path";

/** Epic's EditorToolset Python folder inside an engine. */
const TOOLSET_PYTHON = [
  "Engine",
  "Plugins",
  "Experimental",
  "Toolsets",
  "EditorToolset",
  "Content",
  "Python",
  "editor_toolset",
];
/** The guide's parts: the file and the string it holds. */
const GUIDE_PARTS = [
  { file: ["skills", "blueprint_basics.py"], name: "_INSTRUCTIONS" },
  { file: ["toolsets", "blueprint_dsl.py"], name: "USAGE" },
] as const;
/** The largest guide file read. */
const MAX_GUIDE_BYTES = 512 * 1024;

/** The guide's part that holds for every way of writing Blueprint text: Epic's Blueprint basics. */
const BASICS_PART = GUIDE_PARTS[0];

const MESSAGE = {
  Missing: "This Unreal has no Blueprint guide from Epic's EditorToolset, so write from what check-part says.",
  Heading: (version: string) => `Epic's Blueprint guide and Blueprint text syntax, from Unreal ${version}:`,
  GraphDsl: (version: string) =>
    `On Unreal ${version}, Blueprint text is written in the open editor with Epic's BlueprintToolsets.BlueprintDslToolset (through unreal-editor__call_tool): call its Docs for the grammar before your first Write or Edit, FindNodeReferences to find a node's name by a few words, Schema for one node type's pins, and Read a graph before you change it (names are written as Read shows them). A Write or Edit that fails leaves the Blueprint as it was and names the line. Widget, Anim and level Blueprints take editor_toolset.toolsets.blueprint.BlueprintDslTools instead, whose get_graph_dsl_docs has their syntax. Single nodes, pins, variables and functions: BlueprintToolsets.BlueprintToolset.`,
  GraphDslBasics: (version: string) => `Epic's Blueprint guide, from Unreal ${version}:`,
  NoReference: (version: string) =>
    `Genex keeps a node reference only for Unreal 5.8's Blueprint text. On Unreal ${version}, look a node up in the open editor with BlueprintToolsets.BlueprintDslToolset: FindNodeReferences finds a node's name by a few words, and Schema reads one node type's pins.`,
} as const;

/** Why a tool of Unreal 5.8's node reference doesn't apply to a game on a release that writes Blueprint text in the editor. */
export const noReferenceMessage = (version: string): string => MESSAGE.NoReference(version);

/** The text of `NAME = """…"""` in a Python file, or undefined. A leading `\` line continuation is dropped. */
function pythonString(source: string, name: string): string | undefined {
  const start = source.search(new RegExp(`^${name} = """`, "m"));
  if (start < 0) return undefined;
  const open = source.indexOf('"""', start) + 3;
  const close = source.indexOf('"""', open);
  if (close < 0) return undefined;
  return source.slice(open, close).replace(/^\\\n/, "").trim();
}

/** One guide file's text, read only when it is a plain file inside the engine by real path. */
async function guidePart(engineDir: string, part: (typeof GUIDE_PARTS)[number]): Promise<string | undefined> {
  const root = await realpath(engineDir).catch(() => undefined);
  if (!root) return undefined;
  const wanted = path.join(root, ...TOOLSET_PYTHON, ...part.file);
  const real = await realpath(wanted).catch(() => undefined);
  if (real !== wanted) return undefined;
  const info = await stat(real);
  if (!info.isFile() || info.size > MAX_GUIDE_BYTES) return undefined;
  return pythonString(await readFile(real, "utf8"), part.name);
}

/**
 * The guide for an engine that writes Blueprint text with Epic's Graph DSL toolset: which of the
 * editor's toolsets to use, and Epic's Blueprint basics from that engine when it has them. The
 * engine's older text syntax is left out: there it is for Widget and Anim Blueprints only.
 */
export async function readGraphDslGuide(engineDir: string, version: string): Promise<string> {
  const basics = await guidePart(engineDir, BASICS_PART).catch(() => undefined);
  const texts = basics ? [MESSAGE.GraphDslBasics(version), basics] : [];
  return [MESSAGE.GraphDsl(version), ...texts].join("\n\n");
}

/** Epic's Blueprint guide from the engine at `engineDir`, or an error naming what's missing. */
export async function readBlueprintGuide(engineDir: string, version: string): Promise<string> {
  const parts = await Promise.all(GUIDE_PARTS.map((part) => guidePart(engineDir, part)));
  const texts = parts.filter((text): text is string => Boolean(text));
  if (texts.length !== GUIDE_PARTS.length) throw new Error(MESSAGE.Missing);
  return [MESSAGE.Heading(version), ...texts].join("\n\n");
}
