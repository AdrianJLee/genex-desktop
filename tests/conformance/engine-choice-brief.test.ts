/**
 * Which engine a new game builds in is the chat's own session's to ask or choose, with the question
 * card bridged in while the folder has no kind yet and a plugin on offers one; the person's words
 * reach it as they wrote them, and no words restate the kinds (the kind tools are its tools). A game
 * that has a kind is never handed the card. The end of a turn that linked the game to Unreal reads
 * the game again: no web preview pass for a folder that now holds an Unreal project.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { RunEvent } from "../../src/harness-seed/loop/run-events.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const CLAUDE = "claude-code";
const ASK = "make a rally racing game";
const PROJECT = "/Users/me/AI Games/rally/unreal/Rally.uproject";
const SHAPE = { entry: "index.html", main: "src/main.js", build: null };
/** What every chat's own session is handed: the Loop's start. */
const AUTO_LOOP = "start_autopilot";
/** The Unreal plugin's tool that makes a game's Unreal project, as the host serves it. */
const UNREAL_NEW_GAME_TOOL = "unreal__new-game";
/** The Unreal plugin's kind, as the host lists it while the plugin is on. */
const UNREAL_KIND = { plugin: "unreal", name: "Unreal Editor", tool: UNREAL_NEW_GAME_TOOL, makes: ["unreal-project"] };

/** A descriptor as `game.list` answers it. */
function game(name: string, extra: Record<string, unknown> = {}) {
  return {
    name,
    title: name,
    dir: `/games/${name}`,
    shape: { ...SHAPE, own: false, kind: "studio-template" },
    built: false,
    ...extra,
  };
}
const NEW_GAME_TOOL = { name: UNREAL_NEW_GAME_TOOL, description: "Make the game's Unreal project.", parameters: {} };
const OTHER_TOOL = { name: "blender__model", description: "Model with Blender.", parameters: {} };

/**
 * A delegated chat turn: the games the host lists, the plugin tools it serves, the builder's answer,
 * the chat's messages so far, and the content stamp the game's folder has now.
 */
function chatTurn(options: {
  games?: unknown[];
  tools?: unknown[];
  answer?: Record<string, unknown>;
  messages?: unknown[];
  stamp?: string;
}) {
  return ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.messages": () => options.messages ?? [{ role: "user", content: ASK }],
      "game.contentStamp": () => ({ all: options.stamp ?? null, source: options.stamp ?? null }),
      "game.list": () => options.games ?? [],
      "game.scaffold": (p) => game(String(p.name)),
      // While the Unreal plugin is on (its new-game tool served), the host lists its kind.
      "plugins.tools": () => ({
        tools: options.tools ?? [],
        guidance: "",
        revision: 1,
        kinds: (options.tools as Array<{ name?: string }> | undefined)?.some(
          (tool) => tool.name === UNREAL_NEW_GAME_TOOL,
        )
          ? [UNREAL_KIND]
          : [],
      }),
      "engine.describe": () => [],
      // The preview answers at once, so no turn waits out the settle of a studio that cannot.
      "preview.ready": () => ({ ready: false }),
      "engine.delegate": () => ({
        ok: true,
        engine: CLAUDE,
        turns: 1,
        usage: {},
        sessionId: "s",
        summary: "done",
        ...options.answer,
      }),
    },
  });
}
const TURN = { threadId: "thread-1", turnId: "turn-1", text: ASK, engine: CLAUDE, engineLabel: "Claude Code" };
const NEW_CHAT = { ...TURN, newProject: true };

/** What the builder was handed: its prompt, the bridged tools by name, and whether it got the capture tool. */
function handed(recorder: ReturnType<typeof chatTurn>) {
  const [delegated] = recorder.paramsOf("engine.delegate");
  assert.ok(delegated, "the ask reached the builder");
  const bridged = (delegated.interviewTools as Array<{ name: string }> | undefined)?.map((t) => t.name) ?? [];
  return { prompt: String(delegated.prompt), bridged, capture: Boolean(delegated.selfCapture) };
}

describe("a chat turn and the question card", () => {
  // Flipped: the brief asked web or Unreal first in words; the session reads the person's words alone.
  it("with the Unreal plugin off, a new game's builder gets the words alone and no question card", async () => {
    const recorder = chatTurn({ tools: [OTHER_TOOL] });
    await runDelegatedTurn(recorder.ctx as never, NEW_CHAT);
    const { prompt, bridged } = handed(recorder);
    assert.equal(prompt, ASK);
    assert.deepEqual(bridged, [AUTO_LOOP]);
  });

  it("with it on, a new game's builder gets the words alone, with the question card bridged in", async () => {
    const recorder = chatTurn({ tools: [OTHER_TOOL, NEW_GAME_TOOL] });
    await runDelegatedTurn(recorder.ctx as never, NEW_CHAT);
    const { prompt, bridged, capture } = handed(recorder);
    assert.equal(prompt, ASK);
    assert.deepEqual(bridged, [AUTO_LOOP, "ask_user"]);
    assert.equal(capture, true, "it is still a web game until the user chooses");
  });

  it("a game linked to Unreal gets no card, and its builder gets no web capture", async () => {
    const linked = game("rally", { engine: { kind: GameEngine.Unreal, project: PROJECT, linkedAt: "" } });
    const recorder = chatTurn({ games: [linked], tools: [NEW_GAME_TOOL] });
    await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: "rally" });
    const { bridged, capture } = handed(recorder);
    assert.deepEqual(bridged, [AUTO_LOOP]);
    assert.equal(capture, false, "its folder holds notes, not a page to capture");
  });

  it("a web game gets no card, even with the plugin on", async () => {
    const web = { facts: [{ id: "web-game", path: ".", source: "core" }] };
    for (const existing of [
      game("rally", web),
      game("rally", { ...web, built: true, shape: { ...SHAPE, own: true } }),
    ]) {
      const recorder = chatTurn({ games: [existing], tools: [NEW_GAME_TOOL] });
      await runDelegatedTurn(recorder.ctx as never, { ...TURN, project: "rally" });
      const { bridged, capture } = handed(recorder);
      assert.deepEqual(bridged, [AUTO_LOOP]);
      assert.equal(capture, true);
    }
  });

  it("the question the builder records in Auto is shown as the question card, not reported as a build", async () => {
    const question = {
      question: "Build it for the web or in Unreal Engine?",
      options: "Web (Three.js)\nUnreal Engine",
    };
    const recorder = chatTurn({
      tools: [NEW_GAME_TOOL],
      answer: { studioToolCalls: [{ name: "ask_user", args: question }] },
    });
    await runDelegatedTurn(recorder.ctx as never, NEW_CHAT);
    const recorded = recorder
      .paramsOf("turn.append")
      .flatMap((p) => (p.batch as Array<{ event_type?: string; payload?: { question?: string } }>) ?? [])
      .filter((event) => event.event_type === RunEvent.InterviewQuestion);
    assert.deepEqual(
      recorded.map((event) => event.payload?.question),
      [question.question],
    );
  });
});

/**
 * New game makes the game before the chat's first ask, as an empty folder with no kind: the turn
 * finds a project that already exists. The host's facts say it has no kind yet (`facts: []`), and
 * the chat's first ask is a chat with no reply, no session and no run; both together ask.
 */
describe("a game the app made before the chat's first ask", () => {
  const PENDING = { facts: [] };
  const madeGame = (extra: Record<string, unknown> = {}) => game("made-game", { ...PENDING, ...extra });
  const ON_ITS_GAME = { ...TURN, project: "made-game" };

  /** The builder's brief and bridged tools for one turn on the app-made game. */
  async function turnOn(options: Parameters<typeof chatTurn>[0], turn: Record<string, unknown> = ON_ITS_GAME) {
    const recorder = chatTurn({ games: [madeGame()], tools: [NEW_GAME_TOOL], ...options });
    await runDelegatedTurn(recorder.ctx as never, turn as never);
    return handed(recorder);
  }

  it("with nothing built in it and the plugin on, the chat's first build is handed the card", async () => {
    const { bridged, capture } = await turnOn({});
    assert.deepEqual(bridged, [AUTO_LOOP, "ask_user"]);
    assert.equal(capture, true, "it is still a web game until the user chooses");
  });

  it("gets no card once it has a kind, the game is linked to Unreal, or the plugin is off", async () => {
    const linked = madeGame({
      engine: { kind: GameEngine.Unreal, project: PROJECT, linkedAt: "" },
      facts: [{ id: "unreal-project", path: ".", source: "link" }],
    });
    const cases: Record<string, Parameters<typeof chatTurn>[0]> = {
      "a web game since it was made": { games: [madeGame({ facts: [{ id: "web-game", path: ".", source: "core" }] })] },
      "a descriptor from a host that lists no facts": { games: [game("made-game")] },
      "linked to Unreal": { games: [linked] },
      "the plugin off": { tools: [OTHER_TOOL] },
    };
    for (const [label, options] of Object.entries(cases)) {
      const { bridged } = await turnOn(options);
      assert.deepEqual(bridged, [AUTO_LOOP], label);
    }
  });

  it("keeps the card on a resumed session and a later message while the folder has no kind, never on a run's own turn", async () => {
    const turns: Record<string, [Parameters<typeof chatTurn>[0], Record<string, unknown>, string[]]> = {
      // Flipped: a resumed session that still has no kind keeps the card its first brief named.
      "a resumed session": [{}, { ...ON_ITS_GAME, resume: "session-1" }, [AUTO_LOOP, "ask_user"]],
      "a run's own turn": [{}, { ...ON_ITS_GAME, runId: "run-1" }, []],
    };
    for (const [label, [options, turn, expected]] of Object.entries(turns)) {
      const { bridged } = await turnOn(options, turn);
      assert.deepEqual(bridged, expected, label);
    }
    // A greeting first never loses the card: the folder still has no kind.
    const replied = [
      { role: "user", content: "hi" },
      { role: "assistant", content: "Hello! What shall we make?" },
      { role: "user", content: ASK },
    ];
    const later = await turnOn({ messages: replied }, ON_ITS_GAME);
    assert.equal(later.prompt, ASK, "the words alone");
    assert.deepEqual(later.bridged, [AUTO_LOOP, "ask_user"], "a later message");
  });
});

/**
 * The turn that answers the engine question may link the game to Unreal: its end looks at the game
 * as the host lists it then, read again, so a folder that now holds an Unreal project gets no web
 * preview load, no "fix the black screen" and no failed `build_observation`. A host that cannot
 * answer leaves the game the turn started with.
 */
describe("the end of a turn whose game was linked to Unreal during it", () => {
  const NAME = "rally-circuit";
  const BLACK = "black canvas: 0.00% of pixels above luma 8 (mean 0.0)";
  const REPORT = "Made the Unreal project.";
  const WEB = game(NAME, { facts: [{ id: "web-game", path: ".", source: "core" }] });
  const UNREAL = game(NAME, {
    engine: { kind: GameEngine.Unreal, project: PROJECT, linkedAt: "" },
    facts: [{ id: "unreal-project", path: "unreal", source: "link" }],
  });
  const QUESTION = { studioToolCalls: [{ name: "ask_user", args: { question: "A night track too?" } }] };

  /**
   * One turn on the game: its engine read answers `before` until the builder has run and `after`
   * once it has (a throwing `after` is a host that cannot answer); the preview shows a black canvas.
   */
  async function turnOn(before: unknown, after: unknown, turn: Record<string, unknown> = {}, answer = {}) {
    let built = false;
    const recorder = chatTurn({});
    recorder.handle("game.list", () => {
      if (!built) return [before];
      if (after instanceof Error) throw after;
      return [after];
    });
    recorder.handle("engine.delegate", () => {
      built = true;
      return { ok: true, engine: CLAUDE, turns: 1, usage: {}, sessionId: "s", summary: REPORT, ...answer };
    });
    recorder.handle("preview.load", () => true);
    recorder.handle("preview.ready", () => ({ ready: true, ms: 5 }));
    recorder.handle("preview.status", () => ({ loadError: null }));
    recorder.handle("preview.console", () => []);
    recorder.handle("preview.observe", () => ({ ok: false, reasons: [BLACK] }));
    await runDelegatedTurn(recorder.ctx as never, { ...TURN, text: "Unreal Engine", project: NAME, ...turn } as never);
    const observations = recorder
      .paramsOf("turn.append")
      .flatMap((p) => (p.batch as Array<{ event_type?: string }>) ?? [])
      .filter((event) => event.event_type === RunEvent.BuildObservation);
    const said = recorder.notifications
      .filter((n) => n.type === "chat.message")
      .map((n) => String((n.payload as { content?: unknown }).content))
      .join("\n");
    return { previewCalls: recorder.sequence("preview."), observations: observations.length, said };
  }

  it("a game linked to Unreal by the turn gets no preview load, no build_observation and no black-screen line", async () => {
    const cases: Record<string, [Record<string, unknown>, Record<string, unknown>]> = {
      "its report": [{}, {}],
      "a question beside it": [{}, QUESTION],
    };
    for (const [label, [turn, answer]] of Object.entries(cases)) {
      const { previewCalls, observations, said } = await turnOn(WEB, UNREAL, turn, answer);
      assert.deepEqual(previewCalls, [], label);
      assert.equal(observations, 0, label);
      assert.doesNotMatch(said, /black screen|loads clean|console error/, label);
      assert.ok(said.includes(REPORT), `${label}: the builder's report still reaches the chat`);
    }
  });

  it("a web game is still checked, and a game linked before the turn still is not", async () => {
    const web = await turnOn(WEB, WEB);
    assert.equal(web.previewCalls[0], "preview.load");
    assert.equal(web.observations, 1);
    assert.match(web.said, /fix the black screen/);
    const unreal = await turnOn(UNREAL, UNREAL);
    assert.deepEqual(unreal.previewCalls, []);
    assert.equal(unreal.observations, 0);
  });

  it("a host that cannot read the game again leaves the engine the turn started with", async () => {
    const web = await turnOn(WEB, new Error("game.list failed"));
    assert.equal(web.previewCalls[0], "preview.load");
    assert.equal(web.observations, 1);
    const unreal = await turnOn(UNREAL, new Error("game.list failed"));
    assert.deepEqual(unreal.previewCalls, []);
    assert.equal(unreal.observations, 0);
  });
});
