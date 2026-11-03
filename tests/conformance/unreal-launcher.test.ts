/**
 * Play on Windows starts an Unreal game's own binary instead of Unreal's launcher when the binary
 * carries Microsoft's Visual C++ runtime beside it (main/play/unreal-launcher.ts). The launcher checks
 * the runtime in the registry, not beside the game, so it would ask to install a runtime the game
 * already has. Reads synthetic PE images (helpers/pe-image.ts) in a temporary app folder.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdir, readdir, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { UnrealLauncherResource, unrealGameProgram } from "../../src/main/play/unreal-launcher.ts";
import { peImageBytes } from "../helpers/pe-image.ts";
import { tmpDir } from "../helpers/tmp.ts";

const TARGET = "Dust\\Binaries\\Win64\\Dust-Win64-Shipping.exe";
const RUNTIME = ["msvcp140.dll", "vcruntime140.dll", "vcruntime140_1.dll"];

/** Unreal's launcher naming `target` (and `args`) in its resources, as BootstrapPackagedGame does. */
function launcher(target: string, args = "Dust"): Buffer {
  return peImageBytes({
    rcdata: [
      { id: UnrealLauncherResource.Target, text: target },
      { id: UnrealLauncherResource.Args, text: args },
    ],
  });
}

async function put(root: string, file: string, bytes: Buffer | string = ""): Promise<void> {
  await mkdir(path.dirname(path.join(root, file)), { recursive: true });
  await writeFile(path.join(root, file), bytes);
}

/** An unpacked Windows Unreal app: the launcher at its root, the game binary, and `runtime` beside it. */
async function app(options: { launcherBytes?: Buffer; runtime?: readonly string[] } = {}): Promise<string> {
  const root = await realpath(await tmpDir("unreal-launcher-"));
  await put(root, "Dust.exe", options.launcherBytes ?? launcher(TARGET));
  await put(root, "Dust/Binaries/Win64/Dust-Win64-Shipping.exe", peImageBytes());
  for (const dll of options.runtime ?? RUNTIME) await put(root, `Dust/Binaries/Win64/${dll}`);
  return root;
}

async function files(root: string): Promise<string[]> {
  return (await readdir(root, { recursive: true })).map(String).sort();
}

test("a launcher whose game binary carries the runtime starts that binary, with the launcher's arguments", async () => {
  const root = await app();
  assert.deepEqual(await unrealGameProgram(root, "Dust.exe"), {
    binary: path.join(root, "Dust", "Binaries", "Win64", "Dust-Win64-Shipping.exe"),
    args: ["Dust"],
  });
  // Windows names files case-blind; an app zipped elsewhere may spell the DLLs in capitals.
  const shouting = await app({ runtime: RUNTIME.map((dll) => dll.toUpperCase()) });
  assert.ok(await unrealGameProgram(shouting, "Dust.exe"));
  const quoted = await app({ launcherBytes: launcher(TARGET, 'Dust "-log=My Game.log"  -foo') });
  assert.deepEqual((await unrealGameProgram(quoted, "Dust.exe"))?.args, ["Dust", "-log=My Game.log", "-foo"]);
});

test("without the runtime beside the game binary, the launcher starts as before and offers its installer", async () => {
  for (const runtime of [[], ["msvcp140.dll", "vcruntime140.dll"]]) {
    const root = await app({ runtime });
    assert.equal(await unrealGameProgram(root, "Dust.exe"), null, runtime.join(","));
  }
});

test("a program that is not Unreal's launcher is started as it is", async () => {
  const cases: Array<[string, Buffer]> = [
    ["no resources", peImageBytes()],
    ["only arguments", peImageBytes({ rcdata: [{ id: UnrealLauncherResource.Args, text: "Dust" }] })],
    ["not a PE image", Buffer.from("#!/bin/sh\necho hi\n")],
    ["a truncated PE image", launcher(TARGET).subarray(0, 0x150)],
    ["empty", Buffer.alloc(0)],
  ];
  for (const [name, launcherBytes] of cases) {
    const root = await app({ launcherBytes });
    assert.equal(await unrealGameProgram(root, "Dust.exe"), null, name);
  }
  const root = await app();
  assert.equal(await unrealGameProgram(root, "Missing.exe"), null, "no such program");
});

test("hostile launcher targets start nothing outside the app, and nothing is written", async () => {
  const outside = await realpath(await tmpDir("unreal-launcher-outside-"));
  await put(outside, "evil.exe", peImageBytes());
  for (const dll of RUNTIME) await put(outside, dll);
  const cases: Array<[string, string]> = [
    ["parent climb", "..\\..\\evil.exe"],
    ["climb inside a path", "Dust\\Binaries\\..\\..\\..\\evil.exe"],
    ["absolute drive path", "C:\\Windows\\System32\\cmd.exe"],
    ["drive-relative", "C:evil.exe"],
    ["UNC share", "\\\\server\\share\\evil.exe"],
    ["rooted", "\\Windows\\evil.exe"],
    ["forward-slash climb", "../../evil.exe"],
    ["absolute POSIX", path.join(outside, "evil.exe")],
    ["empty", ""],
    ["a folder, not a program", "Dust\\Binaries\\Win64"],
    ["not an .exe", "Dust\\Binaries\\Win64\\vcruntime140.dll"],
    ["missing binary", "Dust\\Binaries\\Win64\\Other-Win64-Shipping.exe"],
    // The launcher reads its target up to the first NUL, as Play does.
    ["a NUL first", "\u0000..\\..\\evil.exe"],
  ];
  for (const [name, target] of cases) {
    const root = await app({ launcherBytes: launcher(target) });
    const before = await files(root);
    assert.equal(await unrealGameProgram(root, "Dust.exe"), null, name);
    assert.deepEqual(await files(root), before, `${name}: nothing written`);
  }
  // A folder of the app that links out of it is outside the app too.
  const viaLink = await app({ launcherBytes: launcher("Linked\\evil.exe") });
  // A junction on Windows, which needs no administrator; a plain link elsewhere.
  await symlink(outside, path.join(viaLink, "Linked"), "junction");
  assert.equal(await unrealGameProgram(viaLink, "Dust.exe"), null, "a link out of the app");
  assert.deepEqual(await files(outside), ["evil.exe", ...RUNTIME].sort(), "nothing written outside");
});
