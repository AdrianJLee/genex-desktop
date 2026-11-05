/**
 * Genex's own craft advice (multiplayer patterns, cover craft, where assets come from) is a plugin of
 * its own, `genex-recommendations`, that works under the hood of Genex: it is on exactly while Genex
 * is, each of its skills is one line in the brief and is read on demand through its own skill tool,
 * and no person sees it: the window's lists leave it out, an agent neither finds nor suggests it, and
 * nobody switches or removes it by itself. The `genex` plugin keeps only Genex's product
 * requirements and API facts.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { ConnectionService } from "../../src/main/core/connections.ts";
import { pluginsFind, pluginsSuggest } from "../../src/main/core/project-tools.ts";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { GENEX_RECOMMENDATIONS_PLUGIN_ID } from "../../src/shared/plugin-id.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

const ID = GENEX_RECOMMENDATIONS_PLUGIN_ID;
/** The advice the plugin holds, by skill name. */
const SKILLS = [
  "multiplayer-patterns",
  "cover-craft",
  "asset-sources",
  "shop-design",
  "player-experience",
  "play-time-models",
];

/**
 * The text a chat's session in a new game `project` is handed as its turn starts: its system text,
 * or, for an engine with no system channel like this fixture's, the notices of a new session.
 */
async function sessionText(lite: CoreLite, project: string): Promise<{ text: string; threadId: string }> {
  await lite.core.games.scaffold(project);
  const threadId = await lite.core.createGameThread(project);
  const seen: DelegateRequest[] = [];
  lite.core.engines.register({
    id: "fixture",
    label: "fixture",
    kind: "delegated",
    supportsSessions: true,
    status: async () => ({ code: "ready", detail: "fixture" }),
    models: async () => [],
    delegate: async (request: DelegateRequest) => {
      seen.push(request);
      return { ok: true, engine: "fixture", summary: "fixture", turns: 1, usage: {}, sessionId: "s1" };
    },
  } as never);
  await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
  const api = lite.api() as unknown as Record<string, (input: unknown) => Promise<unknown>>;
  const turn = {
    engine: "fixture",
    project,
    threadId,
    prompt: "add a moat",
    from: "person",
    chatTurn: { messageId: "m1" },
  };
  await api["engine.delegate"]?.(turn);
  const request = seen.at(-1);
  return { text: [request?.system ?? "", ...(request?.notices ?? [])].join("\n\n"), threadId };
}

describe("genex-recommendations", () => {
  let lite: CoreLite;
  before(async () => {
    lite = await coreLite();
  });
  after(() => lite.close());

  const briefLines = () =>
    lite.core.plugins
      .guidance()
      .split("\n")
      .filter((line) => line.startsWith(`[${ID}/`));
  const skillTool = () => lite.core.plugins.tools().find((tool) => tool.name === `${ID}__skill`);

  it("ships with Studio and is on in a new profile: one brief line per skill, each read on demand", async () => {
    assert.ok(
      lite.core.plugins.list().some((plugin) => plugin.manifest.id === ID),
      "a bundled plugin",
    );
    assert.equal(lite.core.plugins.enabled(ID), true);
    assert.deepEqual(
      briefLines().map((line) => line.slice(ID.length + 2, line.indexOf("]"))),
      SKILLS,
    );
    assert.ok(skillTool(), "its skill tool is offered");
    const binding = { project: "harbour-run", directory: lite.gamesRoot };
    for (const name of SKILLS) {
      const page = (await lite.core.plugins.tool(`${ID}__skill`, { name }, binding)) as { text: string };
      assert.ok(page.text.length > 200, `${name} reads`);
    }
  });

  it("is shown nowhere: not in the window's list, not found or suggested by an agent", async () => {
    const shown = await lite.core.plugins.displayList();
    assert.ok(
      shown.some((plugin) => plugin.manifest.id === GENEX_PLUGIN_ID),
      "the window lists Genex",
    );
    assert.ok(!shown.some((plugin) => plugin.manifest.id === ID), "but not its advice");
    const found = await pluginsFind(lite.core, {});
    assert.ok(found.plugins.length > 0, "an agent finds the other plugins");
    assert.ok(!found.plugins.some((plugin) => plugin.id === ID));
    const suggested = await pluginsSuggest(lite.core, { plugin: ID, project: "harbour-run", threadId: "chat" });
    assert.equal(suggested.shown, false);
  });

  it("a session's system text carries its advice, never its name among the plugins turned on", async () => {
    const project = "advice";
    const { text: system, threadId } = await sessionText(lite, project);
    for (const name of SKILLS) assert.ok(system.includes(`[${ID}/${name}]`), `${name} is in the brief`);
    const handed = system.split("\n\n").find((part) => part.startsWith("Plugins turned on for this session"));
    assert.ok(handed?.includes(`(${GENEX_PLUGIN_ID}__ tools)`), handed);
    assert.ok(!handed?.includes(ID), handed);
    const planning = await new ConnectionService(lite.core, () => false).capabilityFacts(threadId, project);
    assert.ok(planning.text.includes(`"${GENEX_PLUGIN_ID}"`), "the planning step hears of Genex");
    assert.ok(!planning.text.includes(ID), "but not of its advice");
  });

  it("is never switched or removed by itself", async () => {
    await assert.rejects(lite.core.plugins.setEnabled(ID, false));
    await assert.rejects(lite.core.plugins.remove(ID));
    assert.equal(lite.core.plugins.enabled(ID), true, "still on");
    assert.equal(briefLines().length, SKILLS.length);
  });

  it("follows Genex's switch: Genex off takes its advice from the brief, on again brings it back", async () => {
    await lite.core.plugins.setEnabled(GENEX_PLUGIN_ID, false);
    try {
      assert.equal(lite.core.plugins.enabled(ID), false);
      assert.deepEqual(briefLines(), []);
      assert.equal(skillTool(), undefined);
      const suggested = await pluginsSuggest(lite.core, { plugin: ID, project: "harbour-run", threadId: "chat" });
      assert.equal(suggested.shown, false, "off with Genex, it is still never suggested");
    } finally {
      await lite.core.plugins.setEnabled(GENEX_PLUGIN_ID, true);
    }
    assert.equal(lite.core.plugins.enabled(ID), true);
    assert.equal(briefLines().length, SKILLS.length);
  });

  it("holds the advice the genex plugin no longer carries", () => {
    const genex = lite.core.plugins.list().find((plugin) => plugin.manifest.id === GENEX_PLUGIN_ID);
    const genexSkills = new Set(genex?.manifest.skills.map((skill) => skill.name));
    for (const moved of ["asset-preference", "genex-cover"])
      assert.ok(!genexSkills.has(moved), `${moved} is no longer a genex skill`);
  });
});
