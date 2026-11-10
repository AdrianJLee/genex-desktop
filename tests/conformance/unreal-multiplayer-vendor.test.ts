/**
 * An Unreal game made in Genex could not be made server-authoritative: the app shipped no Unreal
 * client for Genex rooms, and a sandboxed job may fetch none. Now the app ships Genex's own
 * `GenexMultiplayer` Unreal plugin, vendored from the Genex SDK (`sdks/unreal/GenexMultiplayer`)
 * at a pinned commit by `scripts/vendor-unreal-multiplayer.ts`.
 *
 * Byte identity is checked the way git itself names a folder: the vendored folder's git tree id,
 * computed here from the bytes on disk and the pin's file modes, must be the tree id the pinned
 * commit gives `sdks/unreal/GenexMultiplayer`. A changed, missing or extra byte changes the id.
 */
import assert from "node:assert/strict";
import { cp, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  readUnrealMultiplayerPin,
  UNREAL_MULTIPLAYER_DIR,
  vendoredTreeId,
} from "../../scripts/vendor-unreal-multiplayer.ts";
import {
  COLYSEUS_WIN64_DIR,
  coreFromBuild,
  readColyseusWin64Pin,
  sha256,
} from "../../scripts/vendor-unreal-colyseus-win64.ts";
import { COLYSEUS_WIN64_CORE, WIN64_CORE_FILES } from "../../src/plugins/unreal/multiplayer-tools.ts";
import { tmpDir } from "../helpers/tmp.ts";

const COMMIT = /^[0-9a-f]{40}$/;

describe("the app ships Genex's Unreal multiplayer plugin at its pin", () => {
  it("pins a Genex SDK commit and the plugin's tree there", async () => {
    const pin = await readUnrealMultiplayerPin();
    assert.equal(pin.source, "me-ai-org/genex-demo");
    assert.equal(pin.path, "sdks/unreal/GenexMultiplayer");
    assert.match(pin.commit, COMMIT);
    assert.match(pin.tree, COMMIT);
  });

  it("holds the pinned tree byte for byte", async () => {
    const pin = await readUnrealMultiplayerPin();
    assert.equal(await vendoredTreeId(UNREAL_MULTIPLAYER_DIR, pin.executables), pin.tree);
  });

  it("names any changed, extra or missing byte by a different tree", async () => {
    const pin = await readUnrealMultiplayerPin();
    const cases: Array<[string, (dir: string) => Promise<void>]> = [
      ["a changed source byte", (dir) => writeFile(path.join(dir, "GenexMultiplayer.uplugin"), "{}")],
      ["an extra file", (dir) => writeFile(path.join(dir, "Source", "Extra.h"), "#pragma once\n")],
      [
        "a CRLF checkout of a text file",
        async (dir) => {
          const file = path.join(dir, "Config", "FilterPlugin.ini");
          const { readFile } = await import("node:fs/promises");
          await writeFile(file, (await readFile(file, "utf8")).replaceAll("\n", "\r\n"));
        },
      ],
    ];
    for (const [name, change] of cases) {
      const dir = path.join(await tmpDir("studio-unreal-mp-vendor-"), "GenexMultiplayer");
      await cp(UNREAL_MULTIPLAYER_DIR, dir, { recursive: true });
      await change(dir);
      assert.notEqual(await vendoredTreeId(dir, pin.executables), pin.tree, name);
    }
  });
});

/** Every file below `dir`, `/`-separated, sorted. */
async function filesBelow(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile())
    .map((entry) => path.relative(dir, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"))
    .sort();
}

/** The vendored core laid out as genex-demo's Win64 build lays it out (`bin/`, `lib/`, `include/`). */
async function asBuild(): Promise<string> {
  const build = await tmpDir("studio-colyseus-win64-build-");
  await mkdir(path.join(build, "bin"));
  await mkdir(path.join(build, "lib"));
  await cp(path.join(COLYSEUS_WIN64_DIR, WIN64_CORE_FILES.Dll), path.join(build, "bin", "colyseus.dll"));
  await cp(path.join(COLYSEUS_WIN64_DIR, WIN64_CORE_FILES.Lib), path.join(build, "lib", "colyseus.lib"));
  await cp(path.join(COLYSEUS_WIN64_DIR, "include"), path.join(build, "include"), { recursive: true });
  return build;
}

describe("the app ships the pinned Win64 Colyseus core", () => {
  it("holds exactly the pinned files, byte for byte, and the dll and lib are Genex's pinned build", async () => {
    const pin = await readColyseusWin64Pin();
    assert.equal(pin.version, COLYSEUS_WIN64_CORE.version);
    assert.equal(pin.files[WIN64_CORE_FILES.Dll], COLYSEUS_WIN64_CORE.dll);
    assert.equal(pin.files[WIN64_CORE_FILES.Lib], COLYSEUS_WIN64_CORE.lib);
    const vendored = (await filesBelow(COLYSEUS_WIN64_DIR)).filter((rel) => rel !== "vendor.json");
    assert.deepEqual(vendored, Object.keys(pin.files).sort());
    for (const rel of vendored)
      assert.equal(sha256(await readFile(path.join(COLYSEUS_WIN64_DIR, ...rel.split("/")))), pin.files[rel], rel);
  });

  it("vendors a build only when its dll and lib are the pinned ones", async () => {
    const pin = await readColyseusWin64Pin();
    const files = await coreFromBuild(await asBuild());
    assert.deepEqual([...files.keys()].sort(), Object.keys(pin.files).sort());
    const cases: Array<[string, string]> = [
      ["another dll", "bin/colyseus.dll"],
      ["another import library", "lib/colyseus.lib"],
    ];
    for (const [name, rel] of cases) {
      const build = await asBuild();
      await writeFile(path.join(build, ...rel.split("/")), "MZ not the pinned build");
      await assert.rejects(coreFromBuild(build), /not the pinned/, name);
    }
  });
});
