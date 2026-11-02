/**
 * Chat = one folder + one contractor session. These helpers are the load-bearing shape: a follow-up
 * never guesses a sibling game, the person's words reach the session as they wrote them, and what
 * the session knows of Genex is its system text (`chatContext`), the same on every turn while the
 * game is the same.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatContext, lastContractorSession, resolveChatProject } from "../../src/harness-seed/loop/chat-session.ts";
import { GameEngine } from "../../src/harness-seed/loop/game-engine.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { fencedCommand } from "../../src/shared/terminal.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

type ChatMessage = { role: string; content: string };

/** The context of a game as `game.list` lists it, in the folder the chats name. */
const contextOf = (game: Record<string, unknown>, appLanguage: { tag: string; name: string } | null = null) =>
  chatContext(game, { folderLabel: "AI Games/blame", appLanguage });

describe("chat session helpers", () => {
  it("never guesses a project from preview or newest-game", () => {
    const games = [
      { name: "older", dir: "/games/older" },
      { name: "newer", dir: "/games/newer" },
    ];
    assert.equal(resolveChatProject({}, games), null);
    assert.equal(resolveChatProject({ project: "missing" }, games), null);
    assert.equal(resolveChatProject({ newProject: true, project: "older" }, games), null);
    assert.equal(resolveChatProject({ project: "older" }, games), "older");
  });

  it("reads the last contractor session from the log, newest last", () => {
    const found = lastContractorSession(
      [
        {
          data: {
            type: "custom",
            event_type: "delegation_incomplete",
            payload: { sessionId: "ses_old", engine: "vendor", project: "older" },
          },
        },
        {
          data: {
            type: "custom",
            event_type: "contractor_session",
            payload: { sessionId: "ses_ok", engine: "vendor", project: "older" },
          },
        },
      ],
      "vendor",
    );
    assert.deepEqual(found, { sessionId: "ses_ok", engine: "vendor", project: "older" });
  });

  it("tells the session how the chat runs a blocked step for the person: a block the chat can run", () => {
    const context = contextOf({ facts: [{ id: "web-game", path: "." }] });
    const fence = /A one-line ```(\w+) block in your reply shows the person a Run button/.exec(context)?.[1];
    assert.ok(fence, "the context names the fence a command for the person goes in");
    assert.equal(fencedCommand("brew install ffmpeg", fence), "brew install ffmpeg");
  });

  it("opens with who runs the session and the folder, then who the person is, before any fact about the game", () => {
    const context = contextOf({
      facts: [{ id: "web-game", path: "." }],
      built: true,
      shape: { build: "npm run build" },
    });
    const identity = context.indexOf("You are working inside Genex");
    const person = context.search(/may not be a programmer/);
    const build = context.indexOf("npm run build");
    assert.equal(identity, 0);
    assert.ok(identity < person && person < build, context);
    assert.match(context, /`AI Games\/blame`/);
  });

  it("a Russian app language is the context's, never the words'", async () => {
    const russian = { tag: "ru", name: "Русский" };
    assert.match(contextOf({ facts: [] }, russian), /Русский \(ru\)/);
    const recorder = ctxRecorder({
      threadId: "t1",
      unknown: { value: null },
      handlers: {
        "events.messages": () => [{ role: "user", content: "Hello" }],
        "events.list": () => [],
        "studio.language": () => russian,
        "game.list": () => [{ name: "g", title: "G", dir: "/g/g", facts: [{ id: "web-game", path: "." }] }],
        "game.contentStamp": () => ({ all: "same", source: "same" }),
        "engine.delegate": () => ({
          ok: true,
          engine: "claude-code",
          turns: 1,
          usage: {},
          sessionId: "s1",
          summary: "Hi!",
        }),
      },
    });
    const turn = { threadId: "t1", turnId: "turn-1", text: "Hello", engine: "claude-code", engineLabel: "Claude Code" };
    await runDelegatedTurn(recorder.ctx as never, { ...turn, project: "g" });
    const [delegated] = recorder.paramsOf("engine.delegate");
    assert.equal(delegated?.prompt, "Hello");
    assert.match(String(delegated?.system), /Русский \(ru\)/);
  });
});

describe("a chat's message in a game", () => {
  /** One chat turn on a game the studio made; what the builder was handed. */
  async function handed(text: string, asked: Record<string, unknown> = {}, prior: ChatMessage[] = []) {
    const recorder = ctxRecorder({
      threadId: "t1",
      unknown: { value: null },
      handlers: {
        "events.messages": () => [...prior, { role: "user", content: text }],
        "events.list": () => [],
        "game.list": () => [{ name: "untitled-game", title: "Untitled game", dir: "/g/untitled-game", facts: [] }],
        "game.contentStamp": () => ({ all: "same", source: "same" }),
        "engine.delegate": () => ({
          ok: true,
          engine: "claude-code",
          turns: 1,
          usage: {},
          sessionId: "s1",
          summary: "Done.",
        }),
      },
    });
    await runDelegatedTurn(
      recorder.ctx as never,
      {
        threadId: "t1",
        turnId: "turn-1",
        text,
        engine: "claude-code",
        engineLabel: "Claude Code",
        project: "untitled-game",
        asked: { threadId: "t1", text, ...asked },
      } as never,
    );
    const [delegated] = recorder.paramsOf("engine.delegate");
    assert.ok(delegated, "the message reached the builder");
    return delegated;
  }

  // Flipped: a first message was briefed as a blank page ("nothing has been built", or "continue
  // from the existing code"). The session sees the folder itself, and reads the words alone.
  it("a greeting reaches the session as written, with nothing about where the game stands", async () => {
    const delegated = await handed("Hello");
    assert.equal(delegated.prompt, "Hello");
    assert.doesNotMatch(String(delegated.system), /nothing has been built|existing code|greeting/i);
  });

  it("a message the chat wrote itself goes to the session as Genex's; the person's as theirs", async () => {
    assert.equal((await handed("Make the cover", { origin: "cover-step", from: "genex" })).from, "genex");
    assert.equal((await handed("a night street race")).from, "person");
  });

  // Flipped: a keep-going brief without a session quoted the original ask and the latest instruction.
  it("a follow-up with no session to resume reads the words alone, and the chat so far as one notice", async () => {
    const delegated = await handed("Keep going", {}, [{ role: "user", content: "Make Blame!" }]);
    assert.equal(delegated.prompt, "Keep going");
    const [history] = (delegated.notices as string[] | undefined) ?? [];
    assert.match(String(history), /user: Make Blame!/);
    assert.doesNotMatch(String(history), /Keep going/, "the words it answers are its prompt");
  });
});

describe("the context of a game that builds in Unreal", () => {
  const PROJECT = "/Users/me/Unreal Projects/Valley/Valley.uproject";
  const UNREAL = {
    engine: { kind: GameEngine.Unreal, project: PROJECT, linkedAt: "" },
    facts: [{ id: "unreal-project", path: "unreal", source: "link" }],
  };
  /** The web page's contract, its engine and its randomness rule: none of it is an Unreal game's. */
  const WEB_PAGE = /window\.__studio|three\.?js|installStudio|Math\.random|deterministic|Reload/i;

  it("says where its work lands, the linked project in the person's open editor, and nothing of a web page", () => {
    const context = contextOf(UNREAL);
    assert.ok(context.includes(PROJECT), "the work lands in the linked project");
    assert.match(context, /open Unreal Editor/);
    assert.doesNotMatch(context, /unreal-editor__/, "never a connector tool's name: the plugin's guidance has them");
    assert.doesNotMatch(context, WEB_PAGE);
  });

  it("a project found in the folder and not linked yet is said to be not linked", () => {
    const found = { facts: [{ id: "unreal-project", path: "unreal", source: "core" }] };
    assert.match(contextOf(found), /The Unreal project in `unreal\/` is not linked to this game yet\./);
  });

  it("no context says when to start a Loop, use workers or checkpoint: those are tools", () => {
    for (const game of [UNREAL, { facts: [{ id: "web-game", path: "." }] }, { facts: [] }])
      assert.doesNotMatch(contextOf(game), /start_autopilot|Loop|worker|checkpoint/);
  });

  it("a game in its own shape is told the build Genex runs before every preview; the starter, nothing more", () => {
    const own = contextOf({ facts: [{ id: "web-game", path: "." }], built: true, shape: { build: "npm run build" } });
    assert.match(own, /Genex runs `npm run build` before every preview/);
    const starter = contextOf({ facts: [{ id: "web-game", path: "." }], built: false });
    assert.doesNotMatch(starter, /Genex runs `|window\.__studio|Unreal/);
  });

  it("a game linked to a Godot project says where its work lands", () => {
    const godot = {
      engine: { kind: GameEngine.Godot, project: "/Users/me/Games/Moss/project.godot", linkedAt: "" },
      facts: [],
    };
    assert.match(contextOf(godot), /Its work lands in its Godot project in `\/Users\/me\/Games\/Moss\/`/);
  });
});
