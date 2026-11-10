/**
 * The Unreal releases Genex works with, and what differs between them. A release is named the way a
 * project's `EngineAssociation` and Epic's launcher name it ("5.9"). New games are made with one
 * release ({@link NEW_GAMES_ENGINE}), which is also the one a newcomer installs; a game made with an
 * older supported release stays on it until its owner moves it. Everything Genex does differently
 * per release is in {@link LINE_TRAITS}, so a new release is one row here.
 */

/** An Unreal release Genex knows the ways of. */
export const EngineLine = { Unreal58: "5.8", Unreal59: "5.9" } as const;
export type EngineLine = (typeof EngineLine)[keyof typeof EngineLine];

/** The oldest Unreal a game may stay on: Epic's MCP server ships from it. */
export const OLDEST_ENGINE = EngineLine.Unreal58;
/** The Unreal Genex makes new games with and asks a newcomer to install. */
export const NEW_GAMES_ENGINE = EngineLine.Unreal59;
/** What Epic's launcher puts on disk for {@link NEW_GAMES_ENGINE} with its default options, in whole GB. */
export const NEW_GAMES_ENGINE_GB = 47;

/**
 * The settings section of Epic's MCP server. Its class moved from the ModelContextProtocolEngine
 * module to ModelContextProtocol in 5.9, which still reads the old section (Epic's
 * `ConfigRedirects.ini`) and saves the new one.
 */
export const McpSection = {
  EngineModule: "[/Script/ModelContextProtocolEngine.ModelContextProtocolSettings]",
  OwnModule: "[/Script/ModelContextProtocol.ModelContextProtocolSettings]",
} as const;
export type McpSection = (typeof McpSection)[keyof typeof McpSection];

/**
 * How a release writes Blueprint text: with Epic's Python BlueprintTools (the syntax a part's .dsl
 * files use, checked against a node reference Genex exports), or with Epic's Graph DSL toolset in
 * the open editor (BlueprintToolsets.BlueprintDslToolset), which has its own grammar and lookups.
 */
export const BlueprintText = { PythonTools: "python-tools", GraphDsl: "graph-dsl" } as const;
export type BlueprintText = (typeof BlueprintText)[keyof typeof BlueprintText];

/** What one release does its own way. */
export type LineTraits = {
  /** The sections this release reads Epic's MCP settings from; setup writes the first into a file with none. */
  mcpSections: readonly McpSection[];
  /**
   * Whether Epic's MCP server starts with the editor when no setting says either way. A release
   * whose own base settings turn it on saves a project's section without the setting.
   */
  autoStarts: boolean;
  /**
   * Epic's toolset plugins agents make games with on this release, beyond the two the bridge talks
   * to, in the order setup adds them. Not Epic's AllToolsets, whose other toolsets serve no game
   * Genex makes. Each is a plain reference: Unreal's launcher builds load an optional one only when
   * the editor was built with it, which none of these is.
   */
  toolsets: readonly string[];
  /**
   * The build settings this release's own C++ templates name in their targets. A launcher build
   * refuses a game target whose settings differ from the ones it was built with.
   */
  buildSettings: string;
  blueprintText: BlueprintText;
};

const LINE_TRAITS = {
  [EngineLine.Unreal58]: {
    mcpSections: [McpSection.EngineModule],
    autoStarts: false,
    // UI widgets, effects, AI (state trees, behavior trees), animation and sequences, procedural
    // content, physics assets, gameplay tags and automation tests.
    toolsets: [
      "UMGToolSet",
      "NiagaraToolsets",
      "StateTreeToolset",
      "AIModuleToolset",
      "AnimationAssistantToolset",
      "PCGToolset",
      "PhysicsToolsets",
      "GameplayTagsToolset",
      "AutomationTestToolset",
    ],
    buildSettings: "V7",
    blueprintText: BlueprintText.PythonTools,
  },
  [EngineLine.Unreal59]: {
    mcpSections: [McpSection.OwnModule, McpSection.EngineModule],
    autoStarts: true,
    // Blueprints are a plugin of their own from 5.9, and UI widgets are part of EditorToolset. New
    // with it: input sent to a running play, captures, console variables, widget animations and
    // checks, the navmesh and MetaSounds.
    toolsets: [
      "BlueprintToolsets",
      "NiagaraToolsets",
      "StateTreeToolset",
      "AIModuleToolset",
      "AnimationAssistantToolset",
      "PCGToolset",
      "PhysicsToolsets",
      "GameplayTagsToolset",
      "AutomationTestToolset",
      "InputToolset",
      "SceneCaptureToolset",
      "ConsoleToolset",
      "WidgetAnimationToolset",
      "WidgetStaticAnalysisToolset",
      "NavMeshToolset",
      "MetaSoundToolset",
    ],
    buildSettings: "V8",
    blueprintText: BlueprintText.GraphDsl,
  },
} as const satisfies Record<EngineLine, LineTraits>;

const VERSION = /^(\d+)\.(\d+)$/;

/** A version's major and minor numbers, or undefined for anything but "major.minor" (a source build's id). */
export function versionNumbers(version: string): { major: number; minor: number } | undefined {
  const named = VERSION.exec(version);
  return named ? { major: Number(named[1]), minor: Number(named[2]) } : undefined;
}

/** Whether version `a` is `b` or a later one; false when either isn't "major.minor". */
export function atLeast(a: string, b: string): boolean {
  const [left, right] = [versionNumbers(a), versionNumbers(b)];
  if (!left || !right) return false;
  return left.major > right.major || (left.major === right.major && left.minor >= right.minor);
}

/**
 * The release whose ways a version follows: its own, the newest known one's for a later Unreal, and
 * the oldest's for anything else (an older Unreal, or a source build's id, which names no version).
 */
export function lineOf(version: string): EngineLine {
  return atLeast(version, NEW_GAMES_ENGINE) ? NEW_GAMES_ENGINE : OLDEST_ENGINE;
}

/** What the release a version follows does its own way. */
export const traitsOf = (version: string): LineTraits => LINE_TRAITS[lineOf(version)];
