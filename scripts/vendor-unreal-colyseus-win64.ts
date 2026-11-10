/**
 * Vendor the Win64 Colyseus core Genex's Unreal plugin links (`colyseus.dll`, its import library
 * `colyseus.lib` and the C headers) into `src/plugins/unreal/multiplayer/colyseus-win64`, from which
 * `unreal__multiplayer` places it in a Windows game's `Plugins/GenexMultiplayer` (developer-run only:
 * nothing is fetched at runtime or in CI).
 *
 * Colyseus publishes no MSVC build, so the Genex SDK builds v0.18.10's source release with zig
 * (`sdks/unreal/scripts/build-colyseus-win64.sh`); the build is reproducible and its dll and lib are
 * pinned by sha256 in `sdks/unreal/scripts/fetch-colyseus.sh`. `--from` is such a build as that
 * script lays it out (`bin/colyseus.dll`, `lib/colyseus.lib`, `include/`): the `colyseus-windows-x64`
 * artifact of genex-demo's `platforms` workflow (`win64-core` job, `gh run download <run> -R
 * me-ai-org/genex-demo -n colyseus-windows-x64 -D <dir>`) or the script's own output. A build whose
 * dll or lib isn't the pinned one is refused before anything is written. `vendor.json` records the
 * provenance and every vendored file's sha256; `--check` compares the vendored folder with it.
 *
 *   node scripts/vendor-unreal-colyseus-win64.ts --from <build dir> --run <artifact's run id> [--check]
 */
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  COLYSEUS_WIN64_CORE,
  type ColyseusWin64Pin,
  WIN64_CORE_FILES,
} from "../src/plugins/unreal/multiplayer-tools.ts";

/** The vendored core, beside the plugin it is placed into. */
export const COLYSEUS_WIN64_DIR = fileURLToPath(
  new URL("../src/plugins/unreal/multiplayer/colyseus-win64/", import.meta.url),
);
const PIN_FILE = "vendor.json";
/** Where the build lays out its library and import library, and where the plugin wants them. */
const BUILD_LAYOUT = [
  ["bin/colyseus.dll", WIN64_CORE_FILES.Dll],
  ["lib/colyseus.lib", WIN64_CORE_FILES.Lib],
] as const;
const BUILD_HEADERS = "include";

/** The provenance `vendor.json` records beside the files' sha256. */
const PROVENANCE = {
  source: {
    url: "https://github.com/colyseus/native-sdk/releases/download/v0.18.10/colyseus-source-v0.18.10.tar.gz",
    sha256: "a90950b6871dcba9f32e31e71ecb3e914c851e015b62b7534fe31aac6d60a325",
  },
  build: {
    repository: "me-ai-org/genex-demo",
    script: "sdks/unreal/scripts/build-colyseus-win64.sh",
    pinnedBy: "sdks/unreal/scripts/fetch-colyseus.sh",
    workflow: "platforms",
    job: "win64-core",
    artifact: "colyseus-windows-x64",
  },
} as const;

/** A file's sha256, hex. */
export const sha256 = (bytes: Uint8Array) => createHash("sha256").update(bytes).digest("hex");

/** The vendored core's pin as committed. */
export async function readColyseusWin64Pin(dir = COLYSEUS_WIN64_DIR): Promise<ColyseusWin64Pin> {
  return JSON.parse(await readFile(path.join(dir, PIN_FILE), "utf8")) as ColyseusWin64Pin;
}

/** Every file below `dir`, `/`-separated; a link refuses. */
async function filesBelow(dir: string, rel = ""): Promise<string[]> {
  const out: string[] = [];
  for (const entry of await readdir(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isSymbolicLink()) throw new Error(`${child} is a link: a build holds none`);
    if (entry.isDirectory()) out.push(...(await filesBelow(dir, child)));
    else if (entry.isFile()) out.push(child);
  }
  return out;
}

/**
 * The core's files from a build in `from`, by their vendored path, once its dll and lib are the
 * pinned ones ({@link COLYSEUS_WIN64_CORE}); throws, having read only, otherwise.
 */
export async function coreFromBuild(from: string): Promise<Map<string, Buffer>> {
  const files = new Map<string, Buffer>();
  const pinned = { [WIN64_CORE_FILES.Dll]: COLYSEUS_WIN64_CORE.dll, [WIN64_CORE_FILES.Lib]: COLYSEUS_WIN64_CORE.lib };
  for (const [built, vendored] of BUILD_LAYOUT) {
    const bytes = await readFile(path.join(from, ...built.split("/")));
    if (sha256(bytes) !== pinned[vendored])
      throw new Error(`${built} is ${sha256(bytes)}, not the pinned ${pinned[vendored]}: refusing the build`);
    files.set(vendored, bytes);
  }
  for (const rel of await filesBelow(path.join(from, BUILD_HEADERS)))
    files.set(`${BUILD_HEADERS}/${rel}`, await readFile(path.join(from, BUILD_HEADERS, ...rel.split("/"))));
  return files;
}

/** Each vendored file's sha256 as `vendor.json` records it, sorted by path. */
function fileShas(files: ReadonlyMap<string, Buffer>): Record<string, string> {
  return Object.fromEntries(
    [...files].map(([rel, bytes]) => [rel, sha256(bytes)]).sort(([a], [b]) => (a < b ? -1 : 1)),
  );
}

/** The value after `--name`, if given. */
function flag(argv: readonly string[], name: string): string | undefined {
  const at = argv.indexOf(`--${name}`);
  return at === -1 ? undefined : argv[at + 1];
}

/** Compare the vendored folder with its pin: the same files, byte for byte. */
async function check(): Promise<void> {
  const pin = await readColyseusWin64Pin();
  const vendored = (await filesBelow(COLYSEUS_WIN64_DIR)).filter((rel) => rel !== PIN_FILE).sort();
  if (JSON.stringify(vendored) !== JSON.stringify(Object.keys(pin.files).sort()))
    throw new Error("the vendored core's files are not the pinned ones");
  for (const rel of vendored)
    if (sha256(await readFile(path.join(COLYSEUS_WIN64_DIR, ...rel.split("/")))) !== pin.files[rel])
      throw new Error(`${rel} is not the pinned file`);
  console.log(`colyseus-win64 matches its pin (${vendored.length} files)`);
}

/** Vendor (or, with `--check`, compare) the core. */
async function main(argv: readonly string[]): Promise<void> {
  if (argv.includes("--check")) return check();
  const from = flag(argv, "from");
  const run = Number(flag(argv, "run"));
  if (!from || !(await lstat(from).catch(() => null))?.isDirectory())
    throw new Error("--from <a Win64 build: bin/colyseus.dll, lib/colyseus.lib, include/> is required");
  if (!Number.isSafeInteger(run) || run <= 0) throw new Error("--run <the artifact's workflow run id> is required");
  const files = await coreFromBuild(from);
  await rm(COLYSEUS_WIN64_DIR, { recursive: true, force: true });
  for (const [rel, bytes] of files) {
    const target = path.join(COLYSEUS_WIN64_DIR, ...rel.split("/"));
    await mkdir(path.dirname(target), { recursive: true });
    await writeFile(target, bytes);
  }
  const pin: ColyseusWin64Pin = {
    version: COLYSEUS_WIN64_CORE.version,
    ...PROVENANCE,
    build: { ...PROVENANCE.build, run },
    files: fileShas(files),
  };
  await writeFile(path.join(COLYSEUS_WIN64_DIR, PIN_FILE), `${JSON.stringify(pin, null, 2)}\n`);
  const bytes = [...files.values()].reduce((sum, file) => sum + file.length, 0);
  console.log(`vendored ${files.size} files (${bytes} bytes) of the Win64 Colyseus core ${pin.version}, run ${run}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  main(process.argv.slice(2)).catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
