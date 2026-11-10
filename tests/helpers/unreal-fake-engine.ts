/**
 * A small fake Unreal, the release Genex makes new games with (and, when asked, the oldest one a
 * game may stay on beside it), for the Unreal plugin's project-making tools: its Blank Blueprint
 * template as Epic's TemplateDefs.ini describes it, the three C++ plugin templates the New Plugin
 * wizard copies (`Engine/Plugins/Editor/PluginBrowser/Templates/{Advanced,Basic,Blank}`), one engine
 * plugin and one engine module by name, the launcher's install list and the editor app; and the
 * plugin's backend on it, in a Genex game open in the chat, with every launch and host call recorded
 * instead of run, its tools called as an agent calls them or as Genex does at its moments; and a
 * tool's `engine` dep on a computer with two engines ({@link engineByGame}). Nothing here reads the
 * real engine.
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { createUnrealBackend, type UnrealBackendDeps } from "../../src/plugins/unreal/backend.ts";
import { GameEngine } from "../../src/shared/game-engine.ts";
import { ENGINE_LINKS_FOLDER } from "../../src/shared/plugins.ts";
import type { LaunchEnv } from "../../src/plugins/unreal/editor-launch.ts";
import { EngineLine, NEW_GAMES_ENGINE, OLDEST_ENGINE } from "../../src/plugins/unreal/engine-line.ts";
import type { PluginHookContext } from "../../src/plugin-sdk/index.d.ts";
import type { Engine, SetupEnv } from "../../src/plugins/unreal/setup.ts";
import { type XcodeStatus, XcodeState } from "../../src/plugins/unreal/xcode.ts";
import { tmpDir } from "./tmp.ts";

const GIB = 1024 ** 3;
const BOM = "﻿";
/** The Genex editor helper the plugin ships. */
export const UNREAL_HELPER = path.resolve("src/plugins/unreal/GenexEditorHelper");
/** A PNG's first bytes: the plugin templates' icon, copied as bytes. */
export const ICON_PNG = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 7, 7, 7]);
/** An engine plugin's name: a project plugin can't take it. */
export const ENGINE_PLUGIN_NAME = "ModelingToolsEditorMode";
/** An engine module's name by its folder in the engine's source: a project plugin can't take it. */
export const ENGINE_MODULE_NAME = "Gauntlet";

const READY_XCODE: XcodeStatus = {
  state: XcodeState.Ready,
  app: "/Applications/Xcode.app",
  version: "26.2",
  commandLineTools: true,
  supported: null,
  command: null,
};

const tab = (value: unknown) => JSON.stringify(value, null, "\t");

/** The fake releases: each one's build and the version Epic's launcher lists it by. */
const RELEASES = {
  [EngineLine.Unreal58]: { build: "5.8.3", listed: "5.8.3-58210709+++UE5+Release-5.8-Mac" },
  [EngineLine.Unreal59]: { build: "5.9.0", listed: "5.9.0-60000001+++UE5+Release-5.9-Mac" },
} as const satisfies Record<EngineLine, { build: string; listed: string }>;

/** An engine as a tool's `engine` dep answers it. */
type ToolEngine = Pick<Engine, "version" | "directory">;

/**
 * A tool's `engine` dep on a computer with two Unreals, a game's own and another: `own` when asked
 * for `game`, `other` for any other ask, as the backend answers a game whose project names the
 * Unreal it was made with.
 */
export const engineByGame =
  (game: string, own: ToolEngine, other: ToolEngine) =>
  async (_storage?: string, asked?: string): Promise<ToolEngine> =>
    asked === game ? own : other;

/** Writes a file, making its folder. */
export async function put(file: string, data: string | Buffer): Promise<void> {
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, data);
}

/** Every file under `dir` with a hash of its bytes (links named, not followed): a no-side-effect witness. */
export async function tree(dir: string): Promise<Record<string, string>> {
  const out: Record<string, string> = {};
  for (const entry of await readdir(dir, { recursive: true, withFileTypes: true }).catch(() => [])) {
    const full = path.join(entry.parentPath, entry.name);
    const key = path.relative(dir, full).split(path.sep).join("/");
    if (entry.isSymbolicLink()) out[key] = "link";
    else if (entry.isFile())
      out[key] = createHash("sha256")
        .update(await readFile(full))
        .digest("hex");
    else if (entry.isDirectory()) out[`${key}/`] = "dir";
  }
  return out;
}

const BLANK_DEFS = [
  `${BOM}[/Script/GameProjectGeneration.TemplateProjectDefs]`,
  "bIsBlank=True",
  'LocalizedDisplayNames=(Language="en", Text="Blank")',
  "FoldersToIgnore=Media",
  'FilesToIgnore="%TEMPLATENAME%.uproject"',
  'FilesToIgnore="Config/TemplateDefs.ini"',
  'ReplacementsInFiles=(Extensions=("cpp","h","ini","cs"), From="%TEMPLATENAME%", To="%PROJECTNAME%", bCaseSensitive=false)',
  "",
].join("\n");

/** A plugin template's module: its rules naming the editor modules an editor plugin uses, a header and a source. */
function pluginTemplateFiles(editor: boolean): Record<string, string | Buffer> {
  const deps = editor ? '"UnrealEd", "ToolMenus", "Slate"' : '"CoreUObject", "Engine"';
  const files: Record<string, string | Buffer> = {
    "Resources/Icon128.png": ICON_PNG,
    "Source/PLUGIN_NAME/PLUGIN_NAME.Build.cs": `using UnrealBuildTool;\n\npublic class PLUGIN_NAME : ModuleRules\n{\n\tpublic PLUGIN_NAME(ReadOnlyTargetRules Target) : base(Target)\n\t{\n\t\tPrivateDependencyModuleNames.AddRange(new string[] { ${deps} });\n\t}\n}\n`,
    "Source/PLUGIN_NAME/Public/PLUGIN_NAME.h":
      '#pragma once\n\n#include "Modules/ModuleManager.h"\n\nclass FPLUGIN_NAMEModule : public IModuleInterface\n{\n};\n',
    "Source/PLUGIN_NAME/Private/PLUGIN_NAME.cpp":
      '#include "PLUGIN_NAME.h"\n\n#define LOCTEXT_NAMESPACE "FPLUGIN_NAMEModule"\n\nIMPLEMENT_MODULE(FPLUGIN_NAMEModule, PLUGIN_NAME)\n',
  };
  if (editor) {
    files["Resources/PlaceholderButtonIcon.svg"] = "<svg/>";
    files["Source/PLUGIN_NAME/Public/PLUGIN_NAMECommands.h"] = 'TEXT("PLUGIN_NAME")\n';
  }
  return files;
}

/**
 * A fake UE at `root/UE_<version>` (the release new games are made with, unless named) with the
 * Blank template and the three plugin templates.
 */
export async function fakeUnrealEngine(root: string, version: EngineLine = NEW_GAMES_ENGINE): Promise<Engine> {
  const directory = path.join(root, `UE_${version}`);
  const blank = path.join(directory, "Templates", "TP_BlankBP");
  await put(
    path.join(blank, "TP_BlankBP.uproject"),
    tab({
      FileVersion: 3,
      EngineAssociation: "",
      Category: "",
      Description: "",
      Modules: [],
      Plugins: [{ Name: ENGINE_PLUGIN_NAME, Enabled: true, TargetAllowList: ["Editor"] }],
    }),
  );
  await put(path.join(blank, "Config", "TemplateDefs.ini"), BLANK_DEFS);
  await put(path.join(blank, "Config", "DefaultEngine.ini"), "[/Script/EngineSettings.GameMapsSettings]\n");
  await put(path.join(blank, "Config", "DefaultGame.ini"), "[/Script/EngineSettings.GeneralProjectSettings]\n");
  await put(path.join(blank, "Media", "TP_BlankBP.png"), ICON_PNG);
  const templates = path.join(directory, "Engine", "Plugins", "Editor", "PluginBrowser", "Templates");
  for (const [folder, editor] of [
    ["Advanced", true],
    ["Basic", true],
    ["Blank", false],
  ] as const)
    for (const [file, data] of Object.entries(pluginTemplateFiles(editor)))
      await put(path.join(templates, folder, ...file.split("/")), data);
  await put(
    path.join(directory, "Engine", "Plugins", "Editor", ENGINE_PLUGIN_NAME, `${ENGINE_PLUGIN_NAME}.uplugin`),
    tab({ FileVersion: 3 }),
  );
  await mkdir(path.join(directory, "Engine", "Source", "Developer", ENGINE_MODULE_NAME), { recursive: true });
  await put(
    path.join(directory, "Engine", "Config", "Mac", "DataDrivenPlatformInfo.ini"),
    "[DataDrivenPlatformInfo]\n",
  );
  return { version, build: RELEASES[version].build, directory, supported: true };
}

/** An engine as Epic's launcher lists it. */
const listedAs = (version: EngineLine, engine: Engine) => ({
  InstallLocation: engine.directory,
  AppVersion: RELEASES[version].listed,
  AppName: `UE_${version}`,
});

type Launched = { command: string; args: readonly string[] };

/** What a fixture's backend is built with besides the fake engine: the programs it runs instead of UBT, the headless editor and UAT. */
/**
 * `game: false` opens no game; `older` installs the oldest Unreal a game may stay on beside the one
 * new games are made with; `refuseLink` is the error the host's game link answers with; `signal` is
 * the turn's (a stopped turn's is aborted).
 */
export type UnrealFixtureOptions = {
  game?: boolean;
  older?: boolean;
  programs?: UnrealBackendDeps["programs"];
  refuseLink?: Error;
  signal?: AbortSignal;
};

/**
 * The Unreal plugin's backend on a fake engine (`engine`, the Unreal new games are made with; with
 * `older`, the oldest one a game may stay on is installed beside it), in a Genex game `valley` open
 * in the chat (with its own ignore file, unless `game` is false), with the launches and host calls
 * it asks for recorded. A game link the host is asked for is kept as the real host keeps it, and
 * Unreal, once launched, runs and answers. `linkProject` gives the game a project of its own naming
 * an engine, linked the same way; `xcodeAsked` is the engine folder each Xcode check was judged
 * against.
 */
export async function unrealBackendFixture(options: UnrealFixtureOptions = {}) {
  const root = await tmpDir("studio-unreal-fake-");
  const engine = await fakeUnrealEngine(path.join(root, "Engines"));
  const older = options.older ? await fakeUnrealEngine(path.join(root, "Engines"), OLDEST_ENGINE) : undefined;
  const parent = path.join(root, "Unreal Projects");
  const outside = path.join(root, "outside");
  const home = path.join(root, "home");
  const storage = path.join(root, "storage");
  for (const dir of [parent, outside, storage]) await mkdir(dir, { recursive: true });
  await put(
    path.join(home, "Library/Application Support/Epic/UnrealEngineLauncher/LauncherInstalled.dat"),
    JSON.stringify({
      InstallationList: [listedAs(NEW_GAMES_ENGINE, engine), ...(older ? [listedAs(OLDEST_ENGINE, older)] : [])],
    }),
  );
  for (const installed of older ? [engine, older] : [engine])
    await mkdir(path.join(installed.directory, "Engine", "Binaries", "Mac", "UnrealEditor.app"), { recursive: true });
  const launches: Launched[] = [];
  const xcodeAsked: Array<string | undefined> = [];
  const env: SetupEnv = {
    home,
    platform: "darwin",
    programData: path.join(home, "ProgramData"),
    editorRunning: async () => launches.length > 0,
    portListening: async () => false,
    editorAnswers: async () => launches.length > 0,
    xcode: async (engineDir) => {
      xcodeAsked.push(engineDir);
      return READY_XCODE;
    },
    freeBytes: async () => 200 * GIB,
    totalMemory: () => 32 * GIB,
  };
  const launch: LaunchEnv = {
    open: async (l) => void launches.push({ command: l.command, args: l.args }),
    applications: path.join(root, "Applications"),
    now: () => 1_000,
  };
  const backend = createUnrealBackend({
    env,
    helper: UNREAL_HELPER,
    projects: async () => parent,
    launch,
    ...(options.programs ? { programs: options.programs } : {}),
  });
  const dir = path.join(root, "games", "valley");
  await mkdir(dir, { recursive: true });
  await writeFile(path.join(dir, ".gitignore"), ".studio/\nnode_modules\n");
  const linked: unknown[] = [];
  /** As the host keeps it: the game's link record in the plugin's storage. */
  const keepLink = (project: string) =>
    put(path.join(storage, ENGINE_LINKS_FOLDER, "valley.json"), JSON.stringify({ kind: GameEngine.Unreal, project }));
  /** Gives the game a project in its `unreal/` folder whose `.uproject` names `association`, linked; answers the file. */
  const linkProject = async (association: string) => {
    const file = path.join(dir, "unreal", "Valley.uproject");
    await put(file, tab({ FileVersion: 3, EngineAssociation: association }));
    await keepLink(file);
    return file;
  };
  const context = {
    signal: options.signal ?? new AbortController().signal,
    callId: 1,
    ...(options.game === false ? {} : { project: "valley", directory: dir }),
    host: (async (method: string, args?: unknown) => {
      if (method === "storage.root") return storage;
      if (method === "game.engine.link" && options.refuseLink) throw options.refuseLink;
      if (method === "game.engine.link") {
        await keepLink((args as { project: string }).project);
        return linked.push(args);
      }
      if (method === "game.engine.steps") return true;
      throw new Error(`unexpected host call ${method}`);
    }) as never,
  };
  /** Calls one of the backend's tools; a hostile call sends any JSON, whatever the SDK's scalar type says. */
  const call = (name: string, args: Record<string, unknown>) =>
    backend.tool?.(name, args as never, context) ?? Promise.reject(new Error("no tools"));
  /** Calls one of the backend's harness tools as Genex does at one of its moments (`hook`). */
  const atMoment = (name: string, hook: PluginHookContext) =>
    backend.tool?.(name, {}, { ...context, hook }) ?? Promise.reject(new Error("no tools"));
  return {
    root,
    engine,
    older,
    parent,
    outside,
    storage,
    dir,
    linked,
    launches,
    xcodeAsked,
    linkProject,
    call,
    atMoment,
  };
}
