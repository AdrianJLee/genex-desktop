/**
 * What a builder is handed on a project's first message, from the folder's facts; Genex never reads
 * the person's words to decide. The words go as written; Genex's context is the session's system
 * text: who runs it (Genex, the folder, what it holds and what a Genex plugin is), and only what
 * Genex alone knows of the kinds it holds. A folder with no kind yet is handed the question card
 * while a plugin on offers a kind; the kind tools, `start_web_game` and `plugins_find` are its tools,
 * never restated in words. Each kind's line is named by path when the folder holds more than one.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatContext } from "../../src/harness-seed/loop/chat-session.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { directorBrief } from "../../src/harness-seed/loop/director/briefs.ts";
import { WorkerIsolation } from "../../src/harness-seed/loop/workers/contract.ts";
import { workerBrief } from "../../src/harness-seed/loop/workers/prompts.ts";
import { CoreFact } from "../../src/harness-seed/loop/folder-facts.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

/** What every Auto chat is handed (flipped from none): the Loop's start, for a Loop asked for in words. */
const AUTO_LOOP = "start_autopilot";

const CLAUDE = "claude-code";
const ASK = "make a castle exploration game";
const NAME = "keep";
/** The words every context opens with: where it runs, and what a plugin is there. */
const IDENTITY = /inside Genex[\s\S]*a Genex plugin/;

/** A fact as `game.list` lists it. */
const fact = (id: string, where = ".", source = "core") => ({ id, path: where, source });

/** A descriptor as `game.list` answers it, with the folder's facts. */
function game(facts: unknown[], extra: Record<string, unknown> = {}) {
  return {
    name: NAME,
    title: "Keep",
    dir: `/games/${NAME}`,
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: false,
    facts,
    ...extra,
  };
}

const UNREAL_KIND = { plugin: "unreal", name: "Unreal Engine", tool: "unreal__new-game", makes: ["unreal-project"] };
const UNREAL_ON = { tools: [], kinds: [UNREAL_KIND] };
const NONE_ON = { tools: [], kinds: [] };

/** One delegated chat turn on the game: its first message, the plugin kinds the host offers. */
async function firstMessage(descriptor: unknown, plugins: { tools: unknown[]; kinds: unknown[] }) {
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => [{ role: "user", content: ASK }],
      "game.contentStamp": () => ({ all: null, source: null }),
      "game.list": () => [descriptor],
      "plugins.tools": () => ({ ...plugins, guidance: "", revision: 1 }),
      "engine.describe": () => [],
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": () => ({ ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: "ok" }),
    },
  });
  const turn = {
    threadId: "t1",
    turnId: "turn-1",
    text: ASK,
    engine: CLAUDE,
    engineLabel: "Claude Code",
    project: NAME,
  };
  await runDelegatedTurn(recorder.ctx as never, turn as never);
  const [delegated] = recorder.paramsOf("engine.delegate");
  assert.ok(delegated, "the ask reached the builder");
  const handoff = recorder
    .paramsOf("turn.append")
    .flatMap((p) => (p.batch as Array<{ event_type?: string; payload?: { text?: string } }>) ?? [])
    .find((event) => event.event_type === RunEvent.ContractorHandoff);
  return {
    prompt: String(delegated.prompt),
    system: String(delegated.system),
    bridged: (delegated.interviewTools as Array<{ name: string }> | undefined)?.map((t) => t.name) ?? [],
    capture: Boolean(delegated.selfCapture),
    validated: recorder.sequence("game.validate").length > 0,
    handoffText: String(handoff?.payload?.text ?? ""),
  };
}

/** The context of a game as `game.list` lists it. */
const contextOf = (descriptor: Record<string, unknown>) =>
  chatContext(descriptor, { folderLabel: "AI Games/keep", appLanguage: null });

describe("the first message on a project with no kind", () => {
  // Flipped: the brief told it to start web with start_web_game or find a plugin, and asked web or
  // an engine in words with the card. The words go alone; the card is bridged while kinds are on offer.
  it("reads the words alone; the card is bridged only while a plugin on offers a kind", async () => {
    const none = await firstMessage(game([]), NONE_ON);
    assert.equal(none.prompt, ASK);
    assert.deepEqual(none.bridged, [AUTO_LOOP], "no question card");
    assert.equal(none.capture, true, "served as a web game until it picks");
    const on = await firstMessage(game([]), UNREAL_ON);
    assert.equal(on.prompt, ASK);
    assert.deepEqual(on.bridged, [AUTO_LOOP, "ask_user"]);
    for (const told of [none.system, on.system]) {
      assert.match(told, /its kind is not picked yet, and the person's request picks it/);
      assert.doesNotMatch(told, /start_web_game|plugins_find|unreal__new-game|THE ENGINE/, "its tools say it");
    }
  });

  it("a folder of notes is new but not empty: it holds notes and no game yet", () => {
    const told = contextOf(game([], { holds: "notes" }));
    assert.doesNotMatch(told, /empty/, "a folder of notes is never called empty");
    assert.match(told, /holds notes but no game yet/);
  });

  it("a folder of its own files of a kind no rule knows is never told it is empty", async () => {
    for (const plugins of [NONE_ON, UNREAL_ON]) {
      const { system, bridged } = await firstMessage(game([], { holds: "own-files" }), plugins);
      assert.doesNotMatch(system, /empty|holds nothing yet|nothing to inspect/, "it holds files");
      assert.match(system, /files of its own of a kind Genex has no rules for/);
      assert.deepEqual(bridged, [AUTO_LOOP], "no question card: it has a kind, just not one Genex knows");
    }
    assert.match(contextOf(game([], { holds: "unreadable" })), /nothing Genex could read/);
  });

  it("a project that has a kind gets no card", async () => {
    const kinds: Record<string, unknown[]> = {
      web: [fact(CoreFact.WebGame)],
      unreal: [fact(CoreFact.UnrealProject, "unreal", "link")],
      godot: [fact(CoreFact.GodotProject)],
    };
    for (const [label, facts] of Object.entries(kinds)) {
      const { bridged } = await firstMessage(game(facts), UNREAL_ON);
      assert.deepEqual(bridged, [AUTO_LOOP], label);
    }
  });
});

describe("the lines each kind adds to the context", () => {
  // Flipped: a kind no plugin on covered was told to look for a Genex plugin first, and an Unreal
  // project with the plugin off that it had no Unreal tools. The tools it is handed say both.
  it("a kind Genex has no line of its own for is named by the identity alone, with no rule about plugins", () => {
    for (const descriptor of [
      game([fact(CoreFact.UnrealProject)]),
      game([fact(CoreFact.GodotProject)], { built: true, shape: { own: true } }),
      game([fact("toy-project", ".", "plugin:toy-engine")]),
    ])
      assert.doesNotMatch(contextOf(descriptor), /plugins_find|plugins_suggest|no Unreal tools|from the shell/);
    assert.match(contextOf(game([fact(CoreFact.GodotProject)])), /it holds a Godot project at its root/);
  });

  it("a game linked to a Godot project outside its folder says its work lands there", () => {
    const linked = game([fact(CoreFact.GodotProject, "/Users/me/Documents/Godot Projects/Void", "link")], {
      engine: {
        kind: GameEngine.Godot,
        project: "/Users/me/Documents/Godot Projects/Void/project.godot",
        linkedAt: "",
      },
    });
    assert.match(
      contextOf(linked),
      /Its work lands in its Godot project in `\/Users\/me\/Documents\/Godot Projects\/Void\/`/,
    );
    assert.doesNotMatch(contextOf(linked), /stays in this workspace/);
  });

  it("a plugin's web build in a folder is said once as a build", () => {
    const told = contextOf(
      game([
        fact(CoreFact.GodotProject, "godot"),
        fact(CoreFact.WebGame, "web"),
        fact("godot-web-export", "web", "plugin:godot"),
      ]),
    );
    assert.match(told, /The web page in `web\/` is a web build a plugin exports[^\n]*Never edit its files/);
    assert.ok(!told.includes("godot-web-export"), "the plugin's fact needs no line of its own");
  });

  it("each kind's line is named by path when there are two", () => {
    const told = contextOf(
      game([fact(CoreFact.UnrealProject, "unreal", "link"), fact(CoreFact.WebGame, "site")], {
        built: true,
        shape: { own: true, build: "npm run build" },
        engine: { kind: GameEngine.Unreal, project: "/games/keep/unreal/Keep.uproject", linkedAt: "" },
      }),
    );
    const lines = told.split("\n");
    assert.ok(
      lines.includes(
        "For the web game in `site/`: Genex runs `npm run build` before every preview: a build that fails is a black screen.",
      ),
    );
    assert.ok(
      lines.some((line) =>
        line.startsWith("For the Unreal Engine project in `unreal/`: Its work lands in the Unreal project"),
      ),
    );
    const single = contextOf(
      game([fact(CoreFact.WebGame)], { built: true, shape: { own: true, build: "npm run build" } }),
    );
    assert.doesNotMatch(single, /^For the /m, "one kind needs no path");
  });

  it("an Unreal project the game is not linked to is said to be not linked, and nothing about building it", () => {
    const told = contextOf(game([fact(CoreFact.UnrealProject, "unreal")]));
    assert.match(told, /The Unreal project in `unreal\/` is not linked to this game yet\./);
    assert.doesNotMatch(told, /lands in the Unreal project|use-project/, "the plugin's guidance says how it is linked");
  });

  it("a Godot folder's builder gets no web capture, no contract check and no preview words", async () => {
    const godot = game([fact(CoreFact.GodotProject)], { built: true, shape: { own: true } });
    const { system, capture, validated, handoffText } = await firstMessage(godot, NONE_ON);
    assert.equal(capture, false, "no web capture");
    assert.equal(validated, false, "no page contract check");
    assert.doesNotMatch(handoffText, /preview/);
    assert.doesNotMatch(system, /window\.__studio|checkpoint/);
  });

  it("a Godot game set up for Genex's play gets the window its computer tool drives, and no web page's checks", async () => {
    const bridge = { own: true, runtime: "bridge", play: { command: "bin/play", args: [] } };
    const godot = game([fact(CoreFact.GodotProject, "godot")], { built: true, shape: bridge });
    const { capture, validated } = await firstMessage(godot, NONE_ON);
    assert.equal(capture, true, "a window of the game, which it plays through bin/play");
    assert.equal(validated, false, "no page contract check");
    const declaredOnly = game([fact(CoreFact.GodotProject, "godot")], {
      built: true,
      shape: { own: true, runtime: "bridge" },
    });
    assert.equal((await firstMessage(declaredOnly, NONE_ON)).capture, false, "no play command, nothing to start");
  });

  it("a folder of a kind Genex doesn't know is served as no web game: no web capture or contract check", async () => {
    for (const holds of ["own-files", "unreadable"]) {
      const { capture, validated, handoffText } = await firstMessage(game([], { holds }), NONE_ON);
      assert.equal(capture, false, `${holds}: no web capture`);
      assert.equal(validated, false, `${holds}: no page contract check`);
      assert.doesNotMatch(handoffText, /preview/, holds);
    }
  });
});

describe("who runs the session", () => {
  it("every context and lead brief says it runs inside Genex, which folder, what it holds, and what a Genex plugin is", () => {
    const told = contextOf(game([fact(CoreFact.WebGame)]));
    assert.match(told, IDENTITY);
    assert.match(told, /folder `AI Games\/keep`/);
    assert.match(told, /a web game/);
    assert.match(contextOf(game([])), /holds nothing yet/);
    const director = directorBrief({
      run: { runId: "r", project: NAME, goal: "g" },
      integrationWorktree: "/w",
      baseCommit: null,
    } as never);
    assert.match(director, IDENTITY);
    assert.match(director, /a web game/);
    const placed = directorBrief({
      run: { runId: "r", project: NAME, goal: "g" },
      integrationWorktree: "/w",
      baseCommit: null,
      facts: [fact(CoreFact.WebGame, "site"), fact(CoreFact.UnrealProject)],
      gameFolder: "/Users/me/AI Games/keep-site",
    } as never);
    assert.match(
      placed,
      /folder `AI Games\/keep-site`; it holds a web game in `site\/`, an Unreal Engine project at its root/,
    );
  });
});

/** A director's run and one of its builders, as the briefs read them. */
const RUN = { runId: "run_w", project: NAME, goal: "a keep to explore", engine: CLAUDE };

describe("every worker's brief", () => {
  it("a lead's brief names the plugin search and its card; a worker's names the search only", () => {
    const director = directorBrief({
      run: RUN,
      integrationWorktree: "/w",
      baseCommit: null,
    } as never);
    assert.match(director, /plugins_find; plugins_suggest shows the person its card/);
    const worker = workerBrief({
      identity: { folderLabel: "AI Games/keep", facts: [] },
      task: "read the level",
      isolation: WorkerIsolation.Read,
      research: false,
      typeDescription: null,
      inputs: [],
    });
    assert.match(worker, /plugins_find/);
    assert.match(worker, /only the lead shows the person a plugin's card/);
    assert.doesNotMatch(worker, /plugins_suggest/);
  });
});
