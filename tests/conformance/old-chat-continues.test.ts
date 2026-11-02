/**
 * The owner's check of the chat brief: a chat from before, whose Claude Code session holds its turns
 * in the old wrapped form (the person's words with Genex's rules glued after them, and no Genex
 * system text), goes on after the update. Its session is resumed with Genex's context as the system
 * text and the person's next message alone, as they wrote it, and the reply comes. The scripted case
 * proves what the engine hands Claude Code; opt-in (`STUDIO_CLAUDE_CLI_TESTS=1`), the real CLI against
 * `fake-anthropic.ts` resumes such a session and sends the model the old turns and the words, then
 * answers. Claude Code 2.1.314 keeps the system prompt a session started with on every resume (until
 * a compaction), so such a chat reads its old system text until then; the test reports which it sent.
 */
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { MessageFrom } from "../../src/shared/engine-requests.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { fixtureCodingCli } from "../helpers/external-cli.ts";
import { type FakeAnthropicRequest, startFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { scriptedClaude } from "../helpers/scripted-claude.ts";
import { tmpDir } from "../helpers/tmp.ts";

delete process.env.CLAUDE_CONFIG_DIR;

const LIVE = process.env.STUDIO_CLAUDE_CLI_TESTS === "1";
const CLI_DEADLINE_MS = 120_000;
/** A turn as the chat sent it before the update: the words, then Genex's rules glued after them. */
const OLD_WRAPPED = [
  "Make a castle game",
  "Continue from the existing code in this workspace.",
  "You are working inside Genex, the desktop app this chat runs in. OLD-RULES-MARK",
  "The game's work stays in this workspace (folder `games/keep`).",
].join("\n");
/** Genex's context as the chat sends it now: its system text. */
const NEW_CONTEXT = "You are working inside Genex, the desktop app this chat runs in. NEW-CONTEXT-MARK";
const WORDS = "add a moat";

/** A game folder and the engine's homes in a fresh temporary folder. */
async function place(prefix: string) {
  const root = await realpath(await tmpDir(prefix));
  const cwd = path.join(root, "game");
  await mkdir(cwd, { recursive: true });
  return { cwd, engineHome: path.join(root, "engine-home"), systemHome: path.join(root, "no-system-login") };
}

/** The text blocks of a Messages request's message, whatever shape its content has. */
function texts(message: { content?: unknown } | undefined): string[] {
  const content = message?.content;
  if (typeof content === "string") return [content];
  if (!Array.isArray(content)) return [];
  return content.flatMap((block: { type?: string; text?: unknown }) =>
    block?.type === "text" && typeof block.text === "string" ? [block.text] : [],
  );
}

/** A Messages request's system text, joined. */
function systemOf(request: FakeAnthropicRequest): string {
  const system = (request.body as { system?: unknown } | null)?.system;
  if (typeof system === "string") return system;
  return Array.isArray(system) ? system.map((block: { text?: unknown }) => String(block?.text ?? "")).join("\n") : "";
}

/** The conversation's own Messages requests (those that offer the session's tools), in order. */
function conversation(requests: readonly FakeAnthropicRequest[]): FakeAnthropicRequest[] {
  return requests.filter((request) => {
    const body = request.body as { tools?: unknown[] } | null;
    return request.path.endsWith("/v1/messages") && Array.isArray(body?.tools) && body.tools.length > 0;
  });
}

describe("a chat whose session holds its turns in the old wrapped form", () => {
  it("is resumed with Genex's context as the system text and the person's words alone", async () => {
    const { cwd, engineHome, systemHome } = await place("studio-old-chat-");
    const scripted = scriptedClaude([]);
    const engine = new ClaudeCodeEngine({
      resolveCli: fixtureCodingCli,
      engineHome,
      systemHome,
      queryFn: scripted.queryFn,
    });
    const result = await engine.delegate({
      prompt: WORDS,
      from: MessageFrom.Person,
      resume: "session-from-before",
      system: NEW_CONTEXT,
      cwd,
    } as never);
    assert.equal(result.ok, true, "the reply comes");
    assert.equal(scripted.options?.resume, "session-from-before", "its own session goes on");
    assert.deepEqual(scripted.options?.systemPrompt, { type: "preset", preset: "claude_code", append: NEW_CONTEXT });
    assert.equal(scripted.prompt, WORDS, "the words alone, as written");
  });

  it("the real CLI resumes a session started with an old wrapped brief: the model reads the old turns, then the words alone, and answers", {
    skip: !LIVE && "set STUDIO_CLAUDE_CLI_TESTS=1 to run the real Claude Code CLI",
  }, async (t) => {
    const { cwd, engineHome, systemHome } = await place("studio-old-chat-cli-");
    const saved = { ...process.env };
    const fake = await startFakeAnthropic({ command: "true" });
    process.env.ANTHROPIC_BASE_URL = fake.baseUrl;
    process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token";
    process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
    try {
      const engine = new ClaudeCodeEngine({ engineHome, systemHome });
      const before = await engine.delegate({ prompt: OLD_WRAPPED, cwd, timeoutMs: CLI_DEADLINE_MS } as never);
      assert.equal(before.ok, true, `${before.stopReason}: ${before.errorText ?? before.summary}`);
      assert.ok(before.sessionId, "the chat from before kept a session");
      const told = conversation(fake.requests).length;
      const after = await engine.delegate({
        prompt: WORDS,
        from: MessageFrom.Person,
        resume: before.sessionId,
        system: NEW_CONTEXT,
        cwd,
        timeoutMs: CLI_DEADLINE_MS,
      } as never);
      assert.equal(after.ok, true, `${after.stopReason}: ${after.errorText ?? after.summary}`);
      assert.equal(after.sessionId, before.sessionId, "the same session went on");
      assert.ok(after.summary.trim(), "the reply came");
      const resumed = conversation(fake.requests).slice(told);
      assert.ok(resumed.length > 0, "the resumed turn asked the model");
      const [first] = resumed;
      assert.ok(first, "the resumed turn's first request");
      assert.ok(!systemOf(first).includes("OLD-RULES-MARK"), "the old rules are no system text");
      // Claude Code 2.1.314 records a session's system prompt as it starts and sends that record on
      // every resume (until a compaction): the new text reaches a new session, not this one. An
      // older CLI renders it fresh on each launch. Either way the chat goes on.
      t.diagnostic(`the resumed request's system holds the new text: ${systemOf(first).includes(NEW_CONTEXT)}`);
      const messages = (first.body as { messages?: Array<{ role?: string; content?: unknown }> }).messages ?? [];
      assert.ok(
        messages.some((m) => m.role === "user" && texts(m).some((text) => text.includes("OLD-RULES-MARK"))),
        "the old wrapped turn is still the session's history",
      );
      const last = messages.filter((m) => m.role === "user").at(-1);
      assert.ok(texts(last).includes(WORDS), `the newest user message holds the words alone: ${JSON.stringify(last)}`);
      assert.ok(!texts(last).some((text) => text.includes("inside Genex")), "nothing of Genex's glued to them");
    } finally {
      process.env = saved;
      await fake.close();
    }
  });
});
