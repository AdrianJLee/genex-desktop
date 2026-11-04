/**
 * Chat = one folder + one contractor session. These helpers are the load-bearing shape: a follow-up
 * never guesses a sibling game, the person's words reach the session as they wrote them, and what
 * the session knows of Genex is its system text (`chatContext`), the same on every turn.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { chatContext, lastContractorSession, resolveChatProject } from "../../src/harness-seed/loop/chat-session.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { fencedCommand } from "../../src/shared/terminal.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

type ChatMessage = { role: string; content: string };

/** The chat's context in the folder the chats name. */
const contextOf = (appLanguage: { tag: string; name: string } | null = null) =>
  chatContext({ folderLabel: "AI Games/blame", appLanguage });

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
    const context = contextOf();
    const fence = /A one-line ```(\w+) block in your reply shows the person a Run button/.exec(context)?.[1];
    assert.ok(fence, "the context names the fence a command for the person goes in");
    assert.equal(fencedCommand("brew install ffmpeg", fence), "brew install ffmpeg");
  });

  it("opens with who runs the session and the folder, then who the person is", () => {
    const context = contextOf();
    const identity = context.indexOf("You are working inside Genex");
    const person = context.search(/may not be a programmer/);
    assert.equal(identity, 0);
    assert.ok(identity < person, context);
    assert.match(context, /`AI Games\/blame`/);
  });

  // Flipped: an Unreal game's context said where its work lands, a game in its own shape the build
  // Genex runs, a linked Godot project its folder. A resumed session keeps the system text it started
  // with, so the context never says what the folder holds: the plugins' guidance and the game's own
  // CLAUDE.md say those, and Genex's line says a new kind.
  it("never says what the folder holds, nor when to start a Loop, use workers or checkpoint: those are tools", () => {
    assert.doesNotMatch(
      contextOf(),
      /it holds|lands in|before every preview|not linked|start_autopilot|Loop|worker|checkpoint|window\.__studio/,
    );
  });

  it("a Russian app language is the context's, never the words'", async () => {
    const russian = { tag: "ru", name: "Русский" };
    assert.match(contextOf(russian), /Русский \(ru\)/);
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
