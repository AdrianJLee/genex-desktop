/**
 * What an Unreal game's web build needs of this computer (`web-build.ts`): an engine whose install
 * lists the web (Wasm) platform, and the emscripten that engine names. Read from the engine's own
 * files and an emsdk folder, written here as small stand-ins.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  emscriptenFor,
  emsdkHolds,
  engineBuildsWeb,
  ensureWebIsolation,
  placeWebBuild,
  WebFolder,
  webFolderOf,
} from "../../src/plugins/unreal/web-build.ts";
import { tmpDir } from "../helpers/tmp.ts";

const platformLine = (platform: string, more = "") =>
  `+InstalledPlatformConfigurations=(PlatformName="${platform}", Configuration="Shipping", PlatformType="Game"${more}, ProjectType="Any", bCanBeDisplayed=False)`;
const INSTALLED = "[InstalledPlatforms]\nHasInstalledPlatformInfo=true\n";

/** An engine folder whose `BaseEngine.ini` is `ini`, with the web platform's SDK file when `sdk` is given. */
async function engineWith(ini: string, sdk?: string) {
  const engine = await tmpDir("unreal-web-engine-");
  await mkdir(path.join(engine, "Engine", "Config"), { recursive: true });
  await writeFile(path.join(engine, "Engine", "Config", "BaseEngine.ini"), ini);
  if (sdk !== undefined) {
    await mkdir(path.join(engine, "Engine", "Platforms", "Wasm", "Config"), { recursive: true });
    await writeFile(path.join(engine, "Engine", "Platforms", "Wasm", "Config", "Wasm_SDK.json"), sdk);
  }
  return engine;
}
const SDK = '{\n\t"MainVersion": "6.0.10",\n\t"MinVersion": "6.0.10",\n\t"MaxVersion": "6.0.10"\n}\n';

describe("an Unreal that builds for the web", () => {
  it("is an install that lists a Shipping game for the web platform", async () => {
    const lists = await engineWith(`${INSTALLED}${platformLine("Mac")}\n${platformLine("Wasm")}\n`, SDK);
    assert.equal(await engineBuildsWeb(lists), true);
  });

  it("is not an install that lists other platforms only, whatever its web folder holds", async () => {
    const mac = await engineWith(`${INSTALLED}${platformLine("Mac")}\n${platformLine("Android")}\n`, SDK);
    assert.equal(await engineBuildsWeb(mac), false);
  });

  it("needs the file its web entry requires", async () => {
    const required = ', RequiredFile="Engine/Binaries/Wasm/UnrealGame-Wasm-Shipping.target"';
    const engine = await engineWith(`${INSTALLED}${platformLine("Wasm", required)}\n`, SDK);
    assert.equal(await engineBuildsWeb(engine), false);
    await mkdir(path.join(engine, "Engine", "Binaries", "Wasm"), { recursive: true });
    await writeFile(path.join(engine, "Engine", "Binaries", "Wasm", "UnrealGame-Wasm-Shipping.target"), "{}");
    assert.equal(await engineBuildsWeb(engine), true);
  });

  const others: Array<[string, string]> = [
    ["a Development entry alone", platformLine("Wasm").replace("Shipping", "Development")],
    ["an editor entry", platformLine("Wasm").replace('"Game"', '"Editor"')],
    ["a platform whose name only starts the same", platformLine("WasmSimulator")],
    ["a line in a comment", `;${platformLine("Wasm")}`],
    ["a required file outside the engine", platformLine("Wasm", ', RequiredFile="../../../etc/hosts"')],
  ];
  for (const [name, line] of others)
    it(`is not an install with ${name}`, async () => {
      assert.equal(await engineBuildsWeb(await engineWith(`${INSTALLED}${line}\n`, SDK)), false);
    });

  it("an engine with no installed-platform list builds what its folders hold: the web platform's own", async () => {
    assert.equal(await engineBuildsWeb(await engineWith("[Core.System]\n", SDK)), true);
    assert.equal(await engineBuildsWeb(await engineWith("[Core.System]\n")), false);
    assert.equal(await engineBuildsWeb(path.join(await tmpDir("unreal-web-none-"), "missing")), false);
  });
});

describe("the emscripten an Unreal builds web games with", () => {
  it("is the main version its web platform names, and none where it names none", async () => {
    assert.equal(await emscriptenFor(await engineWith("", SDK)), "6.0.10");
    for (const sdk of ["", "{}", '{"MainVersion": 6}', '{"MainVersion": "6.0.10; rm -rf ~"}', "not json"])
      assert.equal(await emscriptenFor(await engineWith("", sdk)), undefined, sdk);
    assert.equal(await emscriptenFor(await engineWith("")), undefined);
  });

  /** An emsdk folder whose emscripten says it is `version`, as its version file is written. */
  async function emsdk(text: string) {
    const root = await tmpDir("unreal-web-emsdk-");
    await mkdir(path.join(root, "upstream", "emscripten"), { recursive: true });
    await writeFile(path.join(root, "upstream", "emscripten", "emscripten-version.txt"), text);
    return root;
  }

  it("is held by an emsdk folder whose emscripten is that version, quoted or not", async () => {
    assert.equal(await emsdkHolds(await emsdk('"6.0.10"\n'), "6.0.10"), true);
    assert.equal(await emsdkHolds(await emsdk("6.0.10"), "6.0.10"), true);
  });

  it("is not held by another version, a relative or missing folder, or a folder that is a link", async () => {
    assert.equal(await emsdkHolds(await emsdk('"6.0.11"\n'), "6.0.10"), false);
    assert.equal(await emsdkHolds(await emsdk('"16.0.10"\n'), "6.0.10"), false);
    assert.equal(await emsdkHolds("emsdk", "6.0.10"), false);
    assert.equal(await emsdkHolds("", "6.0.10"), false);
    assert.equal(await emsdkHolds(path.join(await tmpDir("unreal-web-gone-"), "emsdk"), "6.0.10"), false);
    const real = await emsdk('"6.0.10"\n');
    const link = path.join(await tmpDir("unreal-web-link-"), "emsdk");
    await symlink(real, link, "dir");
    assert.equal(await emsdkHolds(link, "6.0.10"), false);
  });
});

describe("the game's web folder for an Unreal web build", () => {
  /** A game folder, and a staged site in it as Unreal leaves one. */
  async function gameWithSite() {
    const game = await tmpDir("unreal-web-game-");
    const staged = path.join(game, "unreal", "Builds", "Wasm");
    await mkdir(path.join(staged, "Dust", "Binaries", "Wasm"), { recursive: true });
    await writeFile(path.join(staged, "index.html"), "<!doctype html>");
    await writeFile(path.join(staged, "wasm-manifest.json"), "{}");
    await writeFile(path.join(staged, "Dust", "Binaries", "Wasm", "Dust.wasm"), "\0asm");
    return { game, staged };
  }

  it("is free when missing, the game's own when it holds an Unreal web build, and taken otherwise", async () => {
    const { game } = await gameWithSite();
    assert.equal(await webFolderOf(game), WebFolder.Free);
    await mkdir(path.join(game, "web"));
    await writeFile(path.join(game, "web", "index.html"), "<p>a mockup</p>");
    assert.equal(await webFolderOf(game), WebFolder.Taken);
    await writeFile(path.join(game, "web", "wasm-manifest.json"), "{}");
    assert.equal(await webFolderOf(game), WebFolder.Ours);
  });

  it("a link named web is taken, and so is a file", async () => {
    const linked = await gameWithSite();
    await symlink(linked.staged, path.join(linked.game, "web"), "dir");
    assert.equal(await webFolderOf(linked.game), WebFolder.Taken);
    const file = await gameWithSite();
    await writeFile(path.join(file.game, "web"), "");
    assert.equal(await webFolderOf(file.game), WebFolder.Taken);
  });

  it("the staged site becomes web/, replacing an earlier Unreal web build whole", async () => {
    const { game, staged } = await gameWithSite();
    await mkdir(path.join(game, "web"));
    await writeFile(path.join(game, "web", "wasm-manifest.json"), "{}");
    await writeFile(path.join(game, "web", "old.pak"), "old");
    assert.equal(await placeWebBuild(game, staged), path.join(game, "web", "index.html"));
    assert.deepEqual((await readdir(path.join(game, "web"))).sort(), ["Dust", "index.html", "wasm-manifest.json"]);
    assert.deepEqual(await readdir(path.dirname(staged)), [], "the stage moved, it was not copied");
  });

  it("never replaces a web folder that holds anything else: the site stays where Unreal staged it", async () => {
    const { game, staged } = await gameWithSite();
    await mkdir(path.join(game, "web"));
    await writeFile(path.join(game, "web", "index.html"), "<p>a mockup</p>");
    assert.equal(await placeWebBuild(game, staged), undefined);
    assert.equal(await readFile(path.join(game, "web", "index.html"), "utf8"), "<p>a mockup</p>");
    assert.deepEqual((await readdir(staged)).sort(), ["Dust", "index.html", "wasm-manifest.json"]);
  });
});

describe("the setting that lets an Unreal web build run on a plain host", () => {
  const SECTION = "[/Script/WasmTargetPlatform.WasmTargetSettings]";
  const config = (project: string) => path.join(project, "Config", "DefaultEngine.ini");
  /** A project folder whose `Config/DefaultEngine.ini` is `text`; none when undefined. */
  async function projectWith(text?: string) {
    const project = await tmpDir("unreal-web-project-");
    if (text !== undefined) {
      await mkdir(path.join(project, "Config"));
      await writeFile(config(project), text);
    }
    return project;
  }

  it("is added to a project without it, in its own section, the rest kept byte for byte", async () => {
    const before = "[/Script/Engine.RendererSettings]\r\nr.RayTracing=False\r\n";
    const project = await projectWith(before);
    assert.equal(await ensureWebIsolation(project), true);
    assert.equal(
      await readFile(config(project), "utf8"),
      `${before}\r\n${SECTION}\r\nbInjectIsolationHeaders=True\r\n`,
    );
    const none = await projectWith();
    assert.equal(await ensureWebIsolation(none), true);
    assert.equal(await readFile(config(none), "utf8"), `${SECTION}\nbInjectIsolationHeaders=True\n`);
  });

  it("joins the section when the project has it, after its last setting", async () => {
    const project = await projectWith(`${SECTION}\nStartMode=Click\n\n[Other]\nA=1\n`);
    assert.equal(await ensureWebIsolation(project), true);
    assert.equal(
      await readFile(config(project), "utf8"),
      `${SECTION}\nStartMode=Click\nbInjectIsolationHeaders=True\n\n[Other]\nA=1\n`,
    );
  });

  it("leaves a project that already says either way as it is", async () => {
    for (const value of ["True", "False", "true"]) {
      const text = `${SECTION}\nbInjectIsolationHeaders=${value}\n`;
      const project = await projectWith(text);
      assert.equal(await ensureWebIsolation(project), false, value);
      assert.equal(await readFile(config(project), "utf8"), text);
    }
  });

  it("never writes through a link", async () => {
    const outside = path.join(await tmpDir("unreal-web-outside-"), "DefaultEngine.ini");
    await writeFile(outside, "[Other]\nA=1\n");
    const project = await projectWith();
    await mkdir(path.join(project, "Config"));
    await symlink(outside, config(project));
    await assert.rejects(ensureWebIsolation(project));
    assert.equal(await readFile(outside, "utf8"), "[Other]\nA=1\n");
  });
});
