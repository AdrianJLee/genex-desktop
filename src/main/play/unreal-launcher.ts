/**
 * Unreal's Windows launcher (BootstrapPackagedGame): the small `<Game>.exe` at a packaged game's
 * root. It reads Microsoft's Visual C++ runtime from the registry, offers its installer when the
 * registry has none (an admin prompt), then starts the game binary its resources name, with the
 * arguments they name before its own. A game binary that carries the runtime's DLLs beside it
 * (Build on Genex ships them there) starts on any Windows without that runtime, so Play starts the
 * binary itself; without them the launcher starts as before and offers its installer.
 *
 * The launcher is read as data: its two `RT_RCDATA` strings, bounded reads, and a target that must
 * stay inside the app (`containedReal`) as a `.exe`. Anything else answers null.
 */
import { lstat, open, readdir } from "node:fs/promises";
import path from "node:path";
import { containedReal } from "../../substrate/paths.ts";

/** The `RT_RCDATA` ids Unreal's launcher keeps its game binary and its arguments under. */
export const UnrealLauncherResource = { Target: 201, Args: 202 } as const;
export type UnrealLauncherResource = (typeof UnrealLauncherResource)[keyof typeof UnrealLauncherResource];

/** Unreal's launcher is a few hundred kilobytes; a larger program is not one. */
const LAUNCHER_MAX_BYTES = 8 * 1024 * 1024;
/** A resource string longer than this is no path or argument line. */
const RESOURCE_MAX_BYTES = 4096;
/** How deep a resource directory may go: type, id, language. */
const RESOURCE_DEPTH = 3;
/** Entries one resource directory may list before it is taken as damaged. */
const RESOURCE_MAX_ENTRIES = 1024;
const RT_RCDATA = 10;
const RESOURCE_DIRECTORY = 2;
const SUBDIRECTORY = 0x80000000;
/** The runtime DLLs an Unreal game binary loads at start (msvcp140 for its C++ library). */
const RUNTIME_DLLS = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"] as const;

/** Where a game starts instead of its launcher. */
export interface UnrealGameProgram {
  binary: string;
  args: string[];
}

/** A PE image's sections, to turn a relative virtual address into a file offset. */
interface PeSection {
  rva: number;
  size: number;
  file: number;
}

function sections(image: Buffer): { sections: PeSection[]; resources: number } | null {
  if (image.length < 0x40 || image.readUInt16LE(0) !== 0x5a4d) return null;
  const pe = image.readUInt32LE(0x3c);
  if (pe + 24 > image.length || image.readUInt32LE(pe) !== 0x00004550) return null;
  const count = image.readUInt16LE(pe + 6);
  const optional = pe + 24;
  const optionalSize = image.readUInt16LE(pe + 20);
  const magic = image.readUInt16LE(optional);
  const directories = optional + (magic === 0x20b ? 112 : 96);
  const table = optional + optionalSize;
  if (directories + (RESOURCE_DIRECTORY + 1) * 8 > image.length || table + count * 40 > image.length) return null;
  const found: PeSection[] = [];
  for (let i = 0; i < count; i++) {
    const at = table + i * 40;
    const virtualSize = image.readUInt32LE(at + 8);
    const rawSize = image.readUInt32LE(at + 16);
    found.push({
      rva: image.readUInt32LE(at + 12),
      size: Math.max(virtualSize, rawSize),
      file: image.readUInt32LE(at + 20),
    });
  }
  return { sections: found, resources: image.readUInt32LE(directories + RESOURCE_DIRECTORY * 8) };
}

function fileOffset(list: PeSection[], rva: number): number | null {
  const section = list.find((s) => rva >= s.rva && rva < s.rva + s.size);
  return section ? section.file + (rva - section.rva) : null;
}

/** The first entry of the resource directory at `table` whose id is `id` (any id for null). */
function entry(image: Buffer, base: number, table: number, id: number | null): number | null {
  if (base + table + 16 > image.length) return null;
  const named = image.readUInt16LE(base + table + 12);
  const ids = image.readUInt16LE(base + table + 14);
  const total = named + ids;
  if (total > RESOURCE_MAX_ENTRIES || base + table + 16 + total * 8 > image.length) return null;
  for (let i = named; i < total; i++) {
    const at = base + table + 16 + i * 8;
    if (id === null || image.readUInt32LE(at) === id) return image.readUInt32LE(at + 4);
  }
  return null;
}

/** The `RT_RCDATA` resource `id` of a PE image as a string (UTF-16, up to its first NUL), or null. */
export function rcDataString(image: Buffer, id: number): string | null {
  const pe = sections(image);
  if (!pe?.resources) return null;
  const base = fileOffset(pe.sections, pe.resources);
  if (base === null) return null;
  let table = 0;
  let next: number | null = null;
  for (const [depth, want] of [RT_RCDATA, id, null].entries()) {
    next = entry(image, base, table, want);
    const isTable = next !== null && (next & SUBDIRECTORY) !== 0;
    if (next === null || isTable !== depth < RESOURCE_DEPTH - 1) return null;
    table = next & ~SUBDIRECTORY;
  }
  if (base + table + 16 > image.length) return null;
  const dataRva = image.readUInt32LE(base + table);
  const size = image.readUInt32LE(base + table + 4);
  const data = fileOffset(pe.sections, dataRva);
  if (data === null || size > RESOURCE_MAX_BYTES || data + size > image.length) return null;
  const text = image.subarray(data, data + size - (size % 2)).toString("utf16le");
  const end = text.indexOf("\u0000");
  return end < 0 ? text : text.slice(0, end);
}

/** A command line split as Windows programs split theirs: spaces between words, quotes around spaces. */
export function splitArguments(line: string): string[] {
  const words: string[] = [];
  for (const match of line.matchAll(/"([^"]*)"|(\S+)/g)) words.push(match[1] ?? match[2] ?? "");
  return words;
}

/** A launcher's target as path segments inside the app, or null for one that could leave it. */
function targetSegments(target: string): string[] | null {
  const rooted = /^[a-z]:/i.test(target) || /^[\\/]/.test(target);
  const segments = target.split(/[\\/]/);
  const climbs = segments.some((segment) => segment === "" || segment === "." || segment === "..");
  if (!target || rooted || climbs || target.includes(":") || !/\.exe$/i.test(target)) return null;
  return segments;
}

async function readLauncher(file: string): Promise<Buffer | null> {
  const handle = await open(file, "r").catch(() => null);
  if (!handle) return null;
  try {
    const { size } = await handle.stat();
    if (size > LAUNCHER_MAX_BYTES) return null;
    const bytes = Buffer.alloc(size);
    await handle.read(bytes, 0, size, 0);
    return bytes;
  } finally {
    await handle.close();
  }
}

/** Whether `folder` holds every runtime DLL the game binary loads, named in any case. */
async function carriesRuntime(folder: string): Promise<boolean> {
  const names = new Set((await readdir(folder).catch(() => [])).map((name) => name.toLowerCase()));
  return RUNTIME_DLLS.every((dll) => names.has(dll));
}

/**
 * Where Play starts the game installed at `app` (its program `executable`): the game binary Unreal's
 * launcher names, with the launcher's arguments, when that binary sits inside the app with the
 * runtime beside it; null for anything else, which then starts as installed.
 */
export async function unrealGameProgram(app: string, executable: string): Promise<UnrealGameProgram | null> {
  const image = await readLauncher(path.join(app, executable));
  const target = image ? rcDataString(image, UnrealLauncherResource.Target) : null;
  const segments = target === null ? null : targetSegments(target);
  if (!image || !segments) return null;
  const real = await containedReal(app, segments.join("/")).catch(() => null);
  if (!real || !(await lstat(real)).isFile() || !(await carriesRuntime(path.dirname(real)))) return null;
  return {
    binary: path.join(app, ...segments),
    args: splitArguments(rcDataString(image, UnrealLauncherResource.Args) ?? ""),
  };
}
