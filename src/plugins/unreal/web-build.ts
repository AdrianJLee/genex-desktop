/**
 * What an Unreal game's web build needs of this computer, read from the engine's own files. Unreal
 * builds for the web (its Wasm platform, from 5.9) only from an engine that has the web libraries:
 * an installed (launcher) engine says which platforms it builds in `BaseEngine.ini`'s
 * `[InstalledPlatforms]`, and an engine with no such list builds what its `Engine/Platforms` holds.
 * The build compiles with emscripten, in exactly the version the engine's `Wasm_SDK.json` names,
 * from an emsdk folder the person installs and names in `WASM_EMSDK_ROOT` (else `EMSDK`), the two
 * variables Unreal's build tool reads first.
 *
 * The finished site is the game's web version in `web/` at the game's root, where Publish and Live
 * find an engine's web build; a `web/` that holds anything but an earlier Unreal web build is never
 * replaced. A web build runs only on a cross-origin isolated page, and Genex's hosts are plain ones,
 * so the project gets Epic's setting that has the page's own service worker add the headers.
 */
import { lstat, mkdir, readFile, rename, rm } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText, readRegularFile } from "../../substrate/fsx.ts";
import { UNREAL_WEB_BUILD_MARKER } from "../../shared/project-facts.ts";
import { isInside } from "../../substrate/paths.ts";
import { loadEpicText } from "./epic-files.ts";

/** Unreal's name for the web platform, in `-platform=` and in its installed-platform list. */
export const WEB_PLATFORM = "Wasm";
/** The variables that name an emsdk folder, in the order Unreal's build tool reads them. */
export const EMSDK_VARIABLES = ["WASM_EMSDK_ROOT", "EMSDK"] as const;
/** The variable Genex hands the build: the first Unreal reads, so the emsdk Genex checked is the one used. */
export const EMSDK_VARIABLE = EMSDK_VARIABLES[0];

const BASE_ENGINE_INI = ["Engine", "Config", "BaseEngine.ini"];
const WEB_SDK_FILE = ["Engine", "Platforms", WEB_PLATFORM, "Config", "Wasm_SDK.json"];
const EMSCRIPTEN_VERSION_FILE = ["upstream", "emscripten", "emscripten-version.txt"];
const HAS_PLATFORM_LIST = /^\s*HasInstalledPlatformInfo\s*=\s*true\s*$/im;
const PLATFORM_LINE = /^\s*\+InstalledPlatformConfigurations\s*=\s*\((.*)\)\s*$/;
const FIELD = /(\w+)\s*=\s*"?([^",)]*)"?/g;
/** The configuration Genex packages, and the kind of target a game is. */
const PACKAGED = { Configuration: "Shipping", PlatformType: "Game" } as const;
const VERSION = /^\d+(\.\d+){1,3}$/;

/** One line of the installed-platform list as its fields, or undefined for any other line. */
function platformEntry(line: string): Record<string, string> | undefined {
  const listed = PLATFORM_LINE.exec(line);
  if (!listed) return undefined;
  return Object.fromEntries([...(listed[1] ?? "").matchAll(FIELD)].map((field) => [field[1], field[2]]));
}

/** Whether a plain file (never a link) is at `file`. */
const isPlainFile = async (file: string) => (await lstat(file).catch(() => null))?.isFile() === true;

/** Whether an entry's required file is there, inside the engine; an entry that requires none passes. */
async function hasRequired(engineDir: string, entry: Record<string, string>): Promise<boolean> {
  const required = entry.RequiredFile;
  if (!required) return true;
  const file = path.resolve(engineDir, required);
  return isInside(engineDir, file) && isPlainFile(file);
}

/**
 * Whether the engine in `engineDir` builds a Shipping game for the web: its installed-platform list
 * has such an entry whose required file is there; an engine with no list (not an installed build)
 * does when it holds the web platform.
 */
export async function engineBuildsWeb(engineDir: string): Promise<boolean> {
  const ini = await readFile(path.join(engineDir, ...BASE_ENGINE_INI), "utf8").catch(() => undefined);
  if (ini === undefined) return false;
  if (!HAS_PLATFORM_LIST.test(ini)) return isPlainFile(path.join(engineDir, ...WEB_SDK_FILE));
  for (const line of ini.split(/\r?\n/)) {
    const entry = platformEntry(line);
    const web =
      entry?.PlatformName === WEB_PLATFORM &&
      entry.Configuration === PACKAGED.Configuration &&
      entry.PlatformType === PACKAGED.PlatformType;
    if (entry && web && (await hasRequired(engineDir, entry))) return true;
  }
  return false;
}

/** The emscripten version the engine in `engineDir` builds web games with; undefined when it names none. */
export async function emscriptenFor(engineDir: string): Promise<string | undefined> {
  const text = await readFile(path.join(engineDir, ...WEB_SDK_FILE), "utf8").catch(() => "");
  try {
    const main: unknown = (JSON.parse(text) as { MainVersion?: unknown } | null)?.MainVersion;
    return typeof main === "string" && VERSION.test(main) ? main : undefined;
  } catch {
    return undefined;
  }
}

/**
 * Whether `root` is an emsdk folder whose emscripten is exactly `version`: an absolute plain folder
 * (never a link) whose `upstream/emscripten/emscripten-version.txt` reads it, quoted or not.
 */
export async function emsdkHolds(root: string, version: string): Promise<boolean> {
  if (!path.isAbsolute(root)) return false;
  const folder = await lstat(root).catch(() => null);
  if (!folder?.isDirectory()) return false;
  const text = await readFile(path.join(root, ...EMSCRIPTEN_VERSION_FILE), "utf8").catch(() => "");
  return text.trim().replace(/^"|"$/g, "") === version;
}

/** The folder at a game's root that holds its web version. */
export const GAME_WEB_FOLDER = "web";
/** The page a web build starts from, at its site's root. */
export const WEB_PAGE = "index.html";

/** Whose a game's `web/` is: nobody's yet, an Unreal web build's, or something else's that stays. */
export const WebFolder = { Free: "free", Ours: "ours", Taken: "taken" } as const;
export type WebFolder = (typeof WebFolder)[keyof typeof WebFolder];

/** Whose the game's `web/` is ({@link WebFolder}); a link or a file of that name is taken. */
export async function webFolderOf(gameDir: string): Promise<WebFolder> {
  const folder = path.join(gameDir, GAME_WEB_FOLDER);
  const info = await lstat(folder).catch(() => null);
  if (!info) return WebFolder.Free;
  if (!info.isDirectory()) return WebFolder.Taken;
  return (await isPlainFile(path.join(folder, UNREAL_WEB_BUILD_MARKER))) ? WebFolder.Ours : WebFolder.Taken;
}

/**
 * Makes the site Unreal staged in `staged` the game's web version: `web/` at the game's root, an
 * earlier Unreal web build there replaced whole. Answers its page, or undefined when `web/` holds
 * anything else, which stays as it is with the site left where Unreal staged it.
 */
export async function placeWebBuild(gameDir: string, staged: string): Promise<string | undefined> {
  if ((await webFolderOf(gameDir)) === WebFolder.Taken) return undefined;
  const folder = path.join(gameDir, GAME_WEB_FOLDER);
  await rm(folder, { recursive: true, force: true });
  await rename(staged, folder);
  return path.join(folder, WEB_PAGE);
}

const PROJECT_CONFIG = ["Config", "DefaultEngine.ini"];
const WEB_SETTINGS = "[/Script/WasmTargetPlatform.WasmTargetSettings]";
/** Epic's setting for a host that can't send the isolation headers: the page's service worker adds them. */
const ISOLATION_KEY = "bInjectIsolationHeaders";
const MAX_CONFIG_BYTES = 1024 * 1024;
const LINE_BREAK = /\r\n|\r|\n/;
const CRLF = "\r\n";
const sameText = (a: string, b: string) => a.trim().toLowerCase() === b.toLowerCase();

/** The project's config as text; "" when it has none. Never read through a link. */
async function projectConfig(file: string): Promise<string> {
  try {
    return loadEpicText(await readRegularFile(file, MAX_CONFIG_BYTES));
  } catch (error) {
    if (error instanceof Error && Reflect.get(error, "code") === "ENOENT") return "";
    throw error;
  }
}

/** Where the web settings stand in the config's lines: the section's last line, and whether it sets the key. */
function webSettingsIn(lines: readonly string[]): { end: number | null; set: boolean } {
  let inside = false;
  let end: number | null = null;
  let set = false;
  lines.forEach((line, index) => {
    const trimmed = line.trim();
    if (trimmed.startsWith("[")) inside = sameText(trimmed, WEB_SETTINGS);
    if (!inside || trimmed === "") return;
    end = index;
    if (sameText(trimmed.split("=")[0] ?? "", ISOLATION_KEY)) set = true;
  });
  return { end, set };
}

/**
 * Turns on, in the project's own config, the setting that lets its web build run on a host that
 * sends no isolation headers. A project that already sets it, either way, is left as it is. Every
 * other line stays. Answers whether it wrote.
 */
export async function ensureWebIsolation(projectDir: string): Promise<boolean> {
  const file = path.join(projectDir, ...PROJECT_CONFIG);
  const text = await projectConfig(file);
  const eol = text.includes(CRLF) ? CRLF : "\n";
  const lines = text === "" ? [] : text.split(LINE_BREAK);
  const { end, set } = webSettingsIn(lines);
  if (set) return false;
  const setting = `${ISOLATION_KEY}=True`;
  if (end !== null) lines.splice(end + 1, 0, setting);
  else {
    // A config that ends with its final line break keeps one blank line before the new section.
    if (lines.at(-1) === "") lines.pop();
    lines.push(...(lines.length ? [""] : []), WEB_SETTINGS, setting, "");
  }
  await mkdir(path.dirname(file), { recursive: true });
  await atomicWriteText(file, lines.join(eol));
  return true;
}
