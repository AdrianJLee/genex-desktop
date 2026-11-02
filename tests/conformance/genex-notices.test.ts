/**
 * What the host hands a session beside the harness's prompt (`engine.delegate`): the harness's
 * `system` first in the session's system text, then its plugins, their guidance and connectors;
 * Genex's own lines for this message (`notices`) apart from the words, never glued to them. An
 * engine with no system channel reads the system text as a notice of a new session only: a resumed
 * one has it in its history.
 */
import assert from "node:assert/strict";
import { after, before, describe, it } from "node:test";
import { type HandedPlugin, handedPluginsNote } from "../../src/main/core/delegation-prompts.ts";
import { PermissionMode } from "../../src/shared/permissions.ts";
import { PluginAccountState } from "../../src/shared/plugins.ts";
import type { DelegateRequest } from "../../src/substrate/engines/types.ts";
import { type CoreLite, coreLite } from "../helpers/core-lite.ts";

type Api = Record<string, (input: unknown) => Promise<unknown>>;

/** What the harness says lasts for the session, and the person's words. */
const CONTEXT = "You are working inside Genex. CONTEXT-MARK";
const WORDS = "add a moat";

describe("Genex's context and notices beside the person's words", () => {
  let lite: CoreLite;
  let api: Api;
  let threadId: string;
  const project = "notices";
  const seen: Record<string, DelegateRequest[]> = { "claude-code": [], vendor: [] };

  before(async () => {
    lite = await coreLite();
    api = lite.api() as unknown as Api;
    await lite.core.games.scaffold(project);
    threadId = await lite.core.createGameThread(project);
    for (const id of Object.keys(seen))
      lite.core.engines.register({
        id,
        label: id,
        kind: "delegated",
        // The chat's own Claude Code session asks about every call: it once read a note that it reaches the whole Mac.
        permissionPrompts: id === "claude-code",
        supportsSessions: true,
        status: async () => ({ code: "ready", detail: "fixture" }),
        models: async () => [],
        delegate: async (request: DelegateRequest) => {
          seen[id]?.push(request);
          return { ok: true, engine: id, summary: "fixture", turns: 1, usage: {}, sessionId: "s1" };
        },
      } as never);
    await lite.core.setPermissionMode(threadId, PermissionMode.Auto);
  });

  after(async () => {
    await lite.close();
  });

  const delegate = (engine: string, extra: Record<string, unknown> = {}) =>
    api["engine.delegate"]?.({
      engine,
      project,
      threadId,
      prompt: WORDS,
      from: "person",
      system: CONTEXT,
      chatTurn: { messageId: "m1" },
      ...extra,
    });

  it("the chat's own Claude Code session reads the words alone, and Genex's context first in its system text", async () => {
    await delegate("claude-code");
    const request = seen["claude-code"]?.at(-1);
    assert.equal(request?.prompt, WORDS, "the words as written");
    assert.ok(request?.system?.startsWith(CONTEXT), String(request?.system));
    assert.doesNotMatch(String(request?.system), /main agent|not in a sandbox|may not be a programmer/);
    assert.equal(request?.notices, undefined, "nothing to tell beside the words");
  });

  it("an engine with no system channel reads the context as a notice of a new session, and nothing more once resumed", async () => {
    await delegate("vendor");
    const fresh = seen.vendor?.at(-1);
    assert.equal(fresh?.prompt, WORDS);
    assert.equal(fresh?.system, undefined, "it has no system channel");
    assert.ok(fresh?.notices?.[0]?.startsWith(CONTEXT), JSON.stringify(fresh?.notices));
    await delegate("vendor", { resume: "s1" });
    const resumed = seen.vendor?.at(-1);
    assert.equal(resumed?.prompt, WORDS);
    assert.equal(resumed?.notices, undefined, "its history holds the context already");
  });
});

/** Plugins as the system text names them: two with tools of their own, one of hooks alone. */
const BLENDER: HandedPlugin = {
  id: "blender",
  name: "Local Blender",
  description: "Model 3D assets with Blender on this Mac.",
  tools: true,
};
const GENEX: HandedPlugin = { id: "genex", name: "Genex plugin", description: "Assets made in chat.", tools: true };
const HOOKS: HandedPlugin = {
  id: "hooks",
  name: "Checkpoint hooks",
  description: "Runs at each checkpoint.",
  tools: false,
};
/** How a plugin's line ends while the person has not connected its account yet. */
const NOT_SET_UP = "Not set up yet: the person still has to connect its account on its page.";

describe("the plugins a session's system text names", () => {
  it("each plugin a session is handed is one line: its name, the prefix of its tools and what it does", () => {
    const lines = handedPluginsNote([BLENDER, HOOKS]).split("\n");
    assert.equal(lines.length, 3, "a heading and one line each");
    assert.equal(lines[1], "- Local Blender (blender__ tools): Model 3D assets with Blender on this Mac.");
    assert.equal(
      lines[2],
      "- Checkpoint hooks: Runs at each checkpoint.",
      "never the prefix of tools it does not have",
    );
    assert.equal(handedPluginsNote([]), "", "none handed, no list");
  });

  it("an author's description over several lines, or past its length, stays one short line cut at a word", () => {
    const long = { ...BLENDER, description: `Models assets.\n\nAlso ${"renders ".repeat(60)}` };
    const note = handedPluginsNote([long]);
    const [, line = ""] = note.split("\n");
    assert.equal(note.split("\n").length, 2, note);
    assert.ok(line.startsWith("- Local Blender (blender__ tools): Models assets. Also renders"), line);
    assert.ok(line.endsWith("renders…"), line);
    assert.ok(line.length < 260, `${line.length}`);
  });

  it("a plugin whose account is not connected yet says so on its line; a connected one and one with no account do not", () => {
    const notConnected = [
      PluginAccountState.Locked,
      PluginAccountState.NotConnected,
      PluginAccountState.Authorizing,
      PluginAccountState.Failed,
    ];
    for (const account of notConnected) {
      const [, line = ""] = handedPluginsNote([{ ...GENEX, account }]).split("\n");
      assert.equal(line, `- Genex plugin (genex__ tools): Assets made in chat. ${NOT_SET_UP}`, account);
    }
    const connected = handedPluginsNote([{ ...GENEX, account: PluginAccountState.Unlocked }]);
    assert.ok(!connected.includes(NOT_SET_UP), connected);
    assert.ok(!handedPluginsNote([BLENDER]).includes(NOT_SET_UP), "no account, nothing to set up");
  });
});
