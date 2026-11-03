/**
 * Who wrote a message pushed into a running Claude Code turn, as the real CLI shows it to the model.
 *
 * The CLI talks to `fake-anthropic.ts` (a dummy OAuth token, no account, nothing billed), whose
 * scripted turn runs one command; while it runs, the engine pushes a line of Genex's
 * (`isSynthetic`, no origin) and the person's words (origin human) into the turn. Opt-in, like every
 * test that needs this machine's own programs: `STUDIO_CLAUDE_CLI_TESTS=1` with a `claude` the
 * engine can find.
 */
import assert from "node:assert/strict";
import { mkdir, realpath } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import { MessageFrom } from "../../src/shared/engine-requests.ts";
import { ClaudeCodeEngine } from "../../src/substrate/engines/claude-code.ts";
import { GENEX_MARK } from "../../src/substrate/engines/genex-mark-prompts.ts";
import type { DelegateEvent, SteerSend } from "../../src/substrate/engines/types.ts";
import { type FakeAnthropic, startFakeAnthropic } from "../helpers/fake-anthropic.ts";
import { tmpDir } from "../helpers/tmp.ts";

const LIVE = process.env.STUDIO_CLAUDE_CLI_TESTS === "1";

/** One scripted turn against the fake, its command the one given. */
async function withFake<T>(command: string, body: (fake: FakeAnthropic) => Promise<T>): Promise<T> {
  const saved = { ...process.env };
  const fake = await startFakeAnthropic({ command });
  delete process.env.CLAUDE_CONFIG_DIR;
  process.env.ANTHROPIC_BASE_URL = fake.baseUrl;
  process.env.CLAUDE_CODE_OAUTH_TOKEN = "fake-token";
  process.env.CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC = "1";
  try {
    return await body(fake);
  } finally {
    process.env = saved;
    await fake.close();
  }
}

/** Every text the CLI sent the model in its last request, by the role that carried it. */
function lastTexts(fake: FakeAnthropic): Array<{ role: string; text: string }> {
  type Asked = { messages?: Array<{ role: string; content: unknown }> };
  const asked = fake.requests.filter((request) => Array.isArray((request.body as Asked | null)?.messages));
  const messages = (asked.at(-1)?.body as Asked | undefined)?.messages ?? [];
  return messages.flatMap((message) => {
    const blocks = Array.isArray(message.content) ? message.content : [{ type: "text", text: message.content }];
    return (blocks as Array<{ type?: string; text?: string }>)
      .filter((block) => block.type === "text")
      .map((block) => ({ role: message.role, text: String(block.text) }));
  });
}

describe("who wrote a message pushed into a Claude Code turn (real CLI)", {
  skip: !LIVE && "STUDIO_CLAUDE_CLI_TESTS=1",
}, () => {
  it("Genex's line reads as not the user's, the person's as the user's, and the session reads both", async () => {
    const root = await realpath(await tmpDir("studio-claude-steer-cli-"));
    const cwd = path.join(root, "game");
    await mkdir(cwd, { recursive: true });
    const engine = new ClaudeCodeEngine({
      engineHome: path.join(root, "engine-home"),
      systemHome: path.join(root, "no-system-login"),
      scratchRoot: path.join(root, "scratch"),
    });
    await withFake("sleep 4", async (fake) => {
      let send: SteerSend | null = null;
      let pushed = false;
      const result = await engine.delegate({
        prompt: "Run the command.",
        cwd,
        timeoutMs: 120_000,
        steer: { ready: (ready) => (send = ready) },
        onEvent: (event: DelegateEvent) => {
          const toolUse = event.type === "assistant" && JSON.stringify(event.payload).includes("tool_use");
          if (!toolUse || !send || pushed) return;
          pushed = true;
          send({ id: "news", text: 'worker sky "Sky": done.', from: MessageFrom.Genex });
          send({ id: "said", text: "and make it red" });
        },
      });
      assert.equal(result.ok, true, `${result.stopReason}: ${result.errorText ?? result.summary}`);
      assert.deepEqual(result.steered, ["news", "said"], "the session read both");
      const texts = lastTexts(fake);
      const genex = texts.find((said) => said.text.includes("Sky"));
      assert.equal(genex?.text, `${GENEX_MARK}\nworker sky "Sky": done.`);
      assert.notEqual(genex?.role, "user", "never the user's turn");
      const person = texts.find((said) => said.text.includes("and make it red"));
      assert.match(String(person?.text), /^The user sent a new message while you were working:\nand make it red\n/);
      assert.equal(person?.role, "user");
    });
  });
});
