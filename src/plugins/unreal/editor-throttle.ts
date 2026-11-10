/**
 * Unreal's "Use Less CPU when in Background" (`bThrottleCPUWhenNotForeground`): while it is on, an
 * editor behind Genex plays at a few frames per second, so a play test measures a slow game. The
 * bridge and the Unreal Loop's editor queue read and write it on the settings' class default
 * object, which changes the running editor and never its saved config: through the Genex editor
 * helper's own tools ({@link ThrottleTool}), and for an editor whose helper is older than those,
 * through Epic's ObjectTools, which Unreal 5.8 has (5.9's refuse to write an editor setting).
 *
 * On a Mac, Genex lifts it only for an editor whose hardware ray tracing is off: UE 5.8 rendering
 * a ray-traced level at full speed behind another app hangs the GPU (an M4 Max crashed within a few
 * plays every time), while the same level throttled, or without ray tracing, played on.
 */

/** Epic's toolset that reads and writes an object's properties. */
export const OBJECT_TOOLSET = "editor_toolset.toolsets.object.ObjectTools";

/** Epic's ObjectTools tools that read and write the throttle, by their wire names. */
export const ObjectTool = { GetProperties: "get_properties", SetProperties: "set_properties" } as const;
export type ObjectTool = (typeof ObjectTool)[keyof typeof ObjectTool];

/** Epic's toolset with the editor's console variables, and its tool that lists them by name, by its wire name. */
export const EDITOR_APP_TOOLSET = "EditorToolset.EditorAppToolset";
export const CVarTool = { Search: "SearchCVars" } as const;
export type CVarTool = (typeof CVarTool)[keyof typeof CVarTool];

/** The console variable that says whether the editor runs hardware ray tracing. */
const RAY_TRACING = "r.RayTracing";
const MAC: NodeJS.Platform = "darwin";

/** The editor's performance settings, as their class default object, and the throttle's property. */
const SETTINGS = "/Script/UnrealEd.Default__EditorPerformanceSettings";
const PROPERTY = "bThrottleCPUWhenNotForeground";

/** The arguments of a `get_properties` call that reads the throttle. */
export const readThrottleArgs = (): Record<string, unknown> => ({ instance: SETTINGS, properties: [PROPERTY] });

/** The arguments of a `set_properties` call that turns the throttle on or off (Epic takes the values as JSON text). */
export const writeThrottleArgs = (on: boolean): Record<string, unknown> => ({
  instance: SETTINGS,
  values: JSON.stringify({ [PROPERTY]: on }),
});

/** The values a `get_properties` answer holds: Epic answers JSON text, which a caller may have parsed already. */
function answerValues(answer: unknown): unknown {
  if (typeof answer !== "string") return answer;
  try {
    return JSON.parse(answer);
  } catch {
    return undefined;
  }
}

/** The throttle's value in a `get_properties` answer; undefined when the answer holds none. */
export function throttleIn(answer: unknown): boolean | undefined {
  const values = answerValues(answer);
  if (!values || typeof values !== "object") return undefined;
  const value = (values as Record<string, unknown>)[PROPERTY];
  return typeof value === "boolean" ? value : undefined;
}

/** The arguments of a `SearchCVars` call that finds the ray tracing switch. */
export const rayTracingArgs = (): Record<string, unknown> => ({ name: RAY_TRACING });

/** Whether a `SearchCVars` answer says ray tracing is on; undefined when the answer holds no value for it. */
export function rayTracingIn(answer: unknown): boolean | undefined {
  const values = answerValues(answer);
  if (!values || typeof values !== "object") return undefined;
  const entry: unknown = Reflect.get(values, RAY_TRACING);
  const value: unknown = entry && typeof entry === "object" ? Reflect.get(entry, "value") : undefined;
  return typeof value === "number" ? value !== 0 : undefined;
}

/** Whether Genex may lift the throttle of an editor on `platform`: on a Mac only when it is known to run without ray tracing. */
export function mayLiftThrottle(platform: NodeJS.Platform, rayTracing: boolean | undefined): boolean {
  return platform !== MAC || rayTracing === false;
}

/** Whether a `set_properties` answer says the editor took the values. */
export const tookValues = (answer: unknown): boolean => answer === true;

/** The Genex editor helper's own tools for the throttle, in its Loop toolset, by their wire names. */
export const ThrottleTool = { RunSettings: "run_settings", SetThrottle: "set_background_throttle" } as const;
export type ThrottleTool = (typeof ThrottleTool)[keyof typeof ThrottleTool];

/**
 * One call of a tool that reads or writes the throttle, answering its return value (parsed, or as
 * the JSON text Epic hands over); it may throw, or answer anything else, when the editor refuses.
 */
export type ThrottleAsk = (
  tool: ThrottleTool | ObjectTool | CVarTool,
  args: Record<string, unknown>,
) => Promise<unknown>;

/** An editor's throttle and ray tracing as read, each undefined when it couldn't be; `helper` when the helper's own tools answered. */
export type RunSettings = { throttle: boolean | undefined; rayTracing: boolean | undefined; helper: boolean };

/** The throttle and ray tracing in the helper's `run_settings` answer; undefined when the answer isn't one. */
function helperSettings(answer: unknown): Omit<RunSettings, "helper"> | undefined {
  const values = answerValues(answer);
  if (!values || typeof values !== "object" || !("throttle" in values)) return undefined;
  const [throttle, rayTracing]: unknown[] = [Reflect.get(values, "throttle"), Reflect.get(values, "rayTracing")];
  return {
    throttle: typeof throttle === "boolean" ? throttle : undefined,
    rayTracing: typeof rayTracing === "boolean" ? rayTracing : undefined,
  };
}

/**
 * Reads an editor's throttle and whether it ray-traces: from the helper's own tool, else from Epic's
 * (ray tracing only when the throttle is on, since nothing else asks). Never throws.
 */
export async function readRunSettings(ask: ThrottleAsk): Promise<RunSettings> {
  const own = helperSettings(await ask(ThrottleTool.RunSettings, {}).catch(() => undefined));
  if (own) return { ...own, helper: true };
  const throttle = throttleIn(await ask(ObjectTool.GetProperties, readThrottleArgs()).catch(() => undefined));
  if (throttle !== true) return { throttle, rayTracing: undefined, helper: false };
  const rayTracing = rayTracingIn(await ask(CVarTool.Search, rayTracingArgs()).catch(() => undefined));
  return { throttle, rayTracing, helper: false };
}

/** Sets the throttle for the editor's current run, the way it was read (`helper`); true when the editor took it. */
export async function writeThrottle(ask: ThrottleAsk, helper: boolean, on: boolean): Promise<boolean> {
  if (!helper) return tookValues(await ask(ObjectTool.SetProperties, writeThrottleArgs(on)));
  return helperSettings(await ask(ThrottleTool.SetThrottle, { on }))?.throttle === on;
}
