/**
 * A plugin's web build in a folder of the game: a folder holding a web game that a plugin's `detect`
 * also claims (Godot's web export in `web/`, known by its `index.pck`). It is a build the plugin
 * exports from the game's own project, played in Live and published as it is, never a web game of
 * its own to edit: briefs name it once, as a build (the plugin's own guidance says how it is made).
 */
import { CoreFact, type FactRef, PLUGIN_FACT_SOURCE_PREFIX } from "./folder-facts.ts";

/** A plugin's web build, as the folder's contents name it. */
export const WEB_BUILD_WORDS = "a web build exported from the game's own project";

/** Whether a fact is one of Genex's own kinds (the core table). */
const isCoreFact = (id: string) => (Object.values(CoreFact) as string[]).includes(id);

/** Whether a plugin's `detect` found the fact (a fact without a source is read as one). */
const detectedByPlugin = (fact: FactRef & { source?: string }) =>
  fact.source === undefined || fact.source.startsWith(PLUGIN_FACT_SOURCE_PREFIX);

/** The folders holding a web game that a plugin's `detect` also claims. */
export function pluginWebBuilds(facts: readonly (FactRef & { source?: string })[]): Set<string> {
  const webAt = new Set(facts.filter((fact) => fact.id === CoreFact.WebGame).map((fact) => fact.path));
  const claimed = facts.filter((fact) => !isCoreFact(fact.id) && detectedByPlugin(fact) && webAt.has(fact.path));
  return new Set(claimed.map((fact) => fact.path));
}

/**
 * What a game is, as a key that a plugin's web build doesn't change: its facts as `id@path`, sorted,
 * the facts at a folder a plugin's web build fills left out. A plugin exporting its game for the web
 * leaves the game the kind it was.
 */
export function kindKey(facts: readonly (FactRef & { source?: string })[]): string {
  const builds = pluginWebBuilds(facts);
  return facts
    .filter((fact) => !builds.has(fact.path))
    .map((fact) => `${fact.id}@${fact.path}`)
    .sort()
    .join("\n");
}
