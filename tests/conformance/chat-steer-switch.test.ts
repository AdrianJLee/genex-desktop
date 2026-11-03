/**
 * Messages without a queue: a message the person sends while the chat's turn works reaches that
 * turn at the session's next step, whatever it changes. One that changes how the turn runs — another
 * model, effort, engine or roles — cuts the session there and the turn goes on with that message's
 * settings, which are the next leg's call, never words; a slash command waits for a turn of its own,
 * as one typed while Claude Code works runs once its turn ends. These drive the runner
 * (chat-steer.ts) through the real queue.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import type { DelegateResult } from "../../src/substrate/engines/types.ts";
import { MessageQueue, messageQueueState } from "../../src/harness-seed/loop/message-queue.ts";
import { type LegSwitch, steeredCall, type TurnSwitches } from "../../src/harness-seed/loop/chat-steer.ts";

const deferred = <T = void>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
const until = async (check: () => boolean) => {
  for (let n = 0; n < 2000; n++) {
    if (check()) return;
    await new Promise((r) => setImmediate(r));
  }
  assert.fail("did not settle");
};
const ok = (summary: string, sessionId: string, extra: Partial<DelegateResult> = {}): DelegateResult => ({
  ok: true,
  summary,
  sessionId,
  turns: 1,
  usage: {},
  durationMs: 1,
  engine: "fixture",
  ...extra,
});
const stopped = (sessionId: string, turns: number, extra: Partial<DelegateResult> = {}): DelegateResult => ({
  ok: false,
  summary: "",
  stopReason: "stopped",
  sessionId,
  turns,
  usage: {},
  durationMs: 1,
  engine: "fixture",
  ...extra,
});

/** The queue over a host whose sessions are cut at their next step to take a message (`engine.steer` interrupts). */
function cuttingQueue(run: (action: any, steer: any) => Promise<unknown>) {
  const events: any[] = [],
    artifacts = new Map<string, unknown>(),
    asked: any[] = [];
  let cut = () => {};
  const host = {
    call: async (method: string, p: any) => {
      if (method === "events.append")
        for (const data of p.batch)
          events.push({ id: String(events.length + 1).padStart(4, "0"), thread_id: p.threadId, data });
      if (method === "events.list") return events;
      if (method === "artifact.write") artifacts.set(p.artifactId, p.value);
      if (method === "artifact.read") return artifacts.get(p.artifactId);
      if (method === "engine.steer") {
        asked.push(p);
        cut();
        return { how: "interrupt", accepted: p.messages.map((m: any) => m.id) };
      }
    },
    notify: () => {},
  };
  const queue = new MessageQueue(host as never, run);
  const send = (text: string, extra: object = {}) =>
    queue.enqueue({ type: "user_message", threadId: "chat", text, engine: "claude-code", ...extra });
  const state = (text: string) => [...messageQueueState(events).messages.values()].find((m) => m.action?.text === text);
  return {
    queue,
    events,
    asked,
    send,
    state,
    onCut: (fn: () => void) => {
      cut = fn;
    },
  };
}

/** A leg the host cuts once a message arrives: it ends as stopped, its session kept. */
function legUntilCut(q: ReturnType<typeof cuttingQueue>, started: { resolve(): void }, result: DelegateResult) {
  const cut = deferred();
  q.onCut(() => cut.resolve());
  started.resolve();
  return cut.promise.then(() => result);
}

/** Test switches: another model or engine changes the turn; each switch leg is recorded by what it runs on. */
function switchesFor(calls: any[], applied: any[] = []): TurnSwitches {
  return {
    changes: (item) => Boolean(item.model) || item.engine === "codex",
    takes: () => true,
    apply: async (item): Promise<LegSwitch> => {
      applied.push(item.text);
      const on = item.engine === "codex" ? "codex" : "model";
      return {
        call: async (prompt, resume, images) => {
          calls.push({ prompt, resume, images, on });
          return ok("switched", on === "codex" ? "c1" : "s1");
        },
        newSession: on === "codex",
      };
    },
  };
}

describe("a message that changes how the turn runs: the turn goes on with its settings", () => {
  // Flipped: the resumed leg opened with what changed ("You now run on …"). The model is its call's.
  it("another model mid-answer: the same session goes on at its next step, on the message's settings, with its words alone", async () => {
    const calls: any[] = [],
      started = deferred(),
      results: DelegateResult[] = [];
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      results.push(
        await steeredCall({ cancelled: false }, steer, {
          prompt: "PROMPT",
          resume: "prior",
          call: async (prompt, resume) => {
            calls.push({ prompt, resume, on: "start" });
            return legUntilCut(q, started, stopped("s1", 3));
          },
          switches: switchesFor(calls),
        }),
      );
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("use sonnet for this", { model: "sonnet" });
    await until(() => q.state("build the boss")?.state === "handled");
    assert.equal(q.asked[0].native, false, "never read as words mid-turn");
    assert.equal(calls.length, 2);
    assert.deepEqual(
      calls[1],
      { prompt: "use sonnet for this", resume: "s1", images: [], on: "model" },
      "the same session, on the switched call, the words as written",
    );
    assert.equal(q.state("use sonnet for this")!.state, "delivered", "read by this turn: no turn of its own");
    assert.equal(results[0].summary, "switched");
    q.queue.stop();
  });

  // Flipped: the new session was told a fresh brief and what changed; it gets the turn's words and
  // everything the turn was told (the caller adds the chat so far as a notice).
  it("another engine: a new session starts with the turn's words and everything the turn was told", async () => {
    const calls: any[] = [],
      started = deferred();
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        resume: "prior",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume, on: "start" });
          return legUntilCut(q, started, stopped("s1", 3));
        },
        switches: switchesFor(calls),
      });
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("let codex finish it", { engine: "codex" });
    await until(() => q.state("build the boss")?.state === "handled");
    assert.deepEqual(calls[1], { prompt: "PROMPT\n\nlet codex finish it", resume: null, images: [], on: "codex" });
    q.queue.stop();
  });

  it("another engine, model or effort keeps a launch the cut leg recorded: the build starts on the message's settings", async () => {
    const calls: any[] = [],
      applied: string[] = [],
      started = deferred(),
      results: DelegateResult[] = [];
    const q = cuttingQueue(async (action, steer) => {
      if (action.text !== "build the boss") return;
      results.push(
        await steeredCall({ cancelled: false }, steer, {
          prompt: "PROMPT",
          call: async (prompt, resume) => {
            calls.push({ prompt, resume, on: "start" });
            const launched = { studioToolCalls: [{ name: "start_autopilot", args: { goal: "boss" } }] };
            return legUntilCut(q, started, stopped("s1", 2, launched));
          },
          switches: switchesFor(calls, applied),
        }),
      );
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("let codex take it", { engine: "codex" });
    await until(() => q.state("build the boss")?.state === "handled");
    assert.equal(calls.length, 1, "nothing ran after the launch");
    assert.deepEqual(
      results[0].studioToolCalls?.map((call) => call.name),
      ["start_autopilot"],
      "the launch goes out",
    );
    assert.deepEqual(applied, ["let codex take it"], "the turn goes out on the message's settings");
    assert.equal(calls.length, 1, "no leg runs on them: the turn has ended");
    assert.notEqual(q.state("let codex take it")?.state, "delivered", "its words wait for what comes next");
    q.queue.stop();
  });

  // Flipped: a command cut the work short, ran as a leg of its own, and Genex's line carried the
  // work on after it. It waits now, as in Claude Code: the work is never cut for it.
  it("a slash command sent while the turn works never cuts it: it waits for a turn of its own", async () => {
    const calls: any[] = [],
      started = deferred(),
      finish = deferred(),
      seen: string[] = [];
    const q = cuttingQueue(async (action, steer) => {
      seen.push(action.text);
      if (action.text !== "build the boss") return;
      await steeredCall({ cancelled: false }, steer, {
        prompt: "PROMPT",
        call: async (prompt, resume) => {
          calls.push({ prompt, resume });
          started.resolve();
          await finish.promise;
          return ok("built", "s1");
        },
        switches: switchesFor(calls),
      });
    });
    await q.send("build the boss");
    await started.promise;
    await q.send("/review");
    finish.resolve();
    await until(() => seen.length === 2);
    assert.deepEqual(seen, ["build the boss", "/review"], "a turn of its own, after the turn");
    assert.deepEqual(calls, [{ prompt: "PROMPT", resume: null }], "the turn ran once, never cut");
    assert.deepEqual(q.asked, [], "never handed to the session mid-turn");
    q.queue.stop();
  });
});
