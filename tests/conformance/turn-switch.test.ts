/**
 * A chat turn that goes on with the settings of a message sent while it worked (turn-switch.ts):
 * the settings it ends up on are those a turn started with that message would have, and the lines
 * that tell the session what changed say only what did.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  endsTurnFor,
  switchedSettings,
  switchNotes,
  type TurnSettings,
} from "../../src/harness-seed/loop/turn-switch.ts";
import { SWITCH_NOTES } from "../../src/harness-seed/loop/steer-switch-prompts.ts";
import { runDelegatedTurn } from "../../src/harness-seed/loop/delegated-turn.ts";
import { MessageQueue } from "../../src/harness-seed/loop/message-queue.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";

const described = [
  { id: "claude-code", label: "Claude Code", kind: "delegated" },
  { id: "codex", label: "Codex", kind: "delegated" },
  { id: "bonsai", label: "Bonsai", supportsSessions: true },
  { id: "ollama", label: "Ollama", kind: "local" },
];
const loopOff: TurnSettings = { engine: "claude-code", engineLabel: "Claude Code", model: "opus", effort: "xhigh" };
const finishedInPlace = {
  runId: "run_1",
  state: "finished",
  goal: "a boss",
  landed: true,
  stoppedBecause: null,
  engine: "claude-code",
  model: "opus",
  inPlace: true,
};

describe("the settings a switch goes on with", () => {
  it("a message's engine, model, effort and roles; a Loop commission one still carries from before the upgrade is no setting", () => {
    const older = { autopilot: { hours: 2, keepBuilding: true, roles: { planner: "sonnet" } } };
    const roles = { builder: "sonnet" };
    const item = { text: "make it brighter", engine: "claude-code", model: "haiku", effort: "low", roles, ...older };
    const next = switchedSettings(loopOff, item, described);
    assert.deepEqual(
      { engine: next.engine, model: next.model, effort: next.effort, roles: next.roles },
      { engine: "claude-code", model: "haiku", effort: "low", roles },
    );
    assert.equal("autopilot" in next, false);
    assert.equal("loop" in next, false);
    assert.deepEqual(switchNotes(loopOff, next), [SWITCH_NOTES.model("Claude Code (haiku) · low effort")]);
  });

  it("after a lead's run the session stays the after-run one, on the lead's engine", () => {
    const paused = { ...finishedInPlace, state: "paused", inPlace: false };
    const after: TurnSettings = { ...loopOff, afterLoopRun: paused as never };
    const next = switchedSettings(after, { text: "go on", engine: "codex" }, described);
    assert.equal(next.engine, "claude-code");
    assert.equal(next.afterLoopRun, paused);
  });

  it("a turn ends for an engine it cannot go on with: one without sessions, or another engine after a lead's run", () => {
    assert.equal(endsTurnFor(loopOff, { engine: "ollama" }, described), true);
    assert.equal(endsTurnFor(loopOff, { engine: "codex" }, described), false);
    assert.equal(endsTurnFor(loopOff, { engine: "bonsai" }, described), false);
    assert.equal(endsTurnFor(loopOff, {}, described), false, "naming no engine keeps the turn's");
    const after: TurnSettings = { ...loopOff, afterLoopRun: finishedInPlace as never };
    assert.equal(endsTurnFor(after, { engine: "codex" }, described), true);
    assert.equal(endsTurnFor(after, { engine: "claude-code" }, described), false);
  });
});

describe("what a switch tells the session", () => {
  it("only what changed: the engine, or the model and effort", () => {
    assert.deepEqual(switchNotes(loopOff, { ...loopOff, effort: "low" }), [
      SWITCH_NOTES.model("Claude Code (opus) · low effort"),
    ]);
    assert.deepEqual(switchNotes(loopOff, { ...loopOff, engine: "codex", engineLabel: "Codex", model: undefined }), [
      SWITCH_NOTES.engine("Codex · xhigh effort"),
    ]);
    assert.deepEqual(switchNotes(loopOff, { ...loopOff, roles: { builder: "sonnet" } }), []);
  });
});

/** A Claude Code turn in a game chat, run through the real queue and turn; each leg answers as `leg` says. */
function switchTurn(
  leg: (n: number, request: Record<string, unknown>, cutNow: () => Promise<void>) => Promise<unknown>,
  facts: { after?: unknown[]; stopAtOpen?: number } = {},
) {
  const CLAUDE = "claude-code";
  const log: Array<{ id: string; data: Record<string, unknown> }> = [];
  const web = [{ id: "web-game", path: ".", source: "core" }];
  let legs = 0;
  let cut = () => {};
  const game = () => ({
    name: "pond",
    title: "pond",
    dir: "/games/pond",
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: false,
    facts: legs > 0 && facts.after ? facts.after : web,
  });
  const recorder = ctxRecorder({
    unknown: { value: null },
    handlers: {
      "events.append": (p) => {
        for (const data of p.batch as Array<Record<string, unknown>>)
          log.push({ id: String(log.length + 1).padStart(6, "0"), data });
        return null;
      },
      "events.list": () => log,
      "events.messages": () => [{ role: "user", content: "build the boss" }],
      "game.contentStamp": () => ({ all: "a", source: "a" }),
      "game.list": () => [game()],
      "plugins.tools": () => ({ tools: [], guidance: "", revision: 1 }),
      "engine.describe": () => [
        { id: CLAUDE, label: "Claude Code", kind: "delegated" },
        { id: "codex", label: "Codex", kind: "delegated" },
      ],
      "preview.ready": () => ({ ready: false }),
      "engine.steer": (p) => {
        cut();
        return { how: "interrupt", accepted: (p.messages as Array<{ id: string }>).map((m) => m.id) };
      },
      "engine.delegate": (p) => {
        legs += 1;
        const cutNow = () =>
          new Promise<void>((resolve) => {
            cut = resolve;
          });
        return leg(legs, p, cutNow);
      },
    },
  });
  const host = { call: (method: string, p: Record<string, unknown>) => recorder.ctx.call(method, p), notify() {} };
  let ended = () => {};
  const turnEnded = new Promise<void>((resolve) => {
    ended = resolve;
  });
  let opens = 0;
  // A Stop that lands as the session opens for the `stopAtOpen`th time: before its leg runs.
  const stopping = (steer: any) =>
    new Proxy(steer, {
      get(target, key) {
        if (key === "open")
          return async (options: unknown) => {
            const taken = await target.open(options);
            opens += 1;
            if (opens === facts.stopAtOpen) recorder.ctx.cancelled = true;
            return taken;
          };
        const value = Reflect.get(target, key);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });
  const queue = new MessageQueue(host as never, async (action, steer) => {
    const turn = {
      threadId: "thread-1",
      turnId: "turn-1",
      text: action.text,
      engine: CLAUDE,
      engineLabel: "Claude Code",
    };
    try {
      await runDelegatedTurn(
        recorder.ctx as never,
        {
          ...turn,
          project: "pond",
          autopilot: action.autopilot,
          asked: action,
          steer: stopping(steer),
        } as never,
      );
    } finally {
      ended();
    }
  });
  const send = (text: string, extra: Record<string, unknown>) =>
    queue.enqueue({ type: "user_message", threadId: "thread-1", text, ...extra });
  const saved = () =>
    recorder
      .paramsOf("turn.append")
      .flatMap((p) => p.batch as Array<Record<string, any>>)
      .filter((row) => row.event_type === "contractor_session")
      .map((row) => [row.payload.engine, row.payload.sessionId]);
  return { recorder, queue, send, saved, turnEnded, cut: () => cut() };
}

describe("a switch the turn follows as it ends", () => {
  const CLAUDE = "claude-code";
  const game = {
    name: "pond",
    title: "pond",
    dir: "/games/pond",
    shape: { entry: "index.html", main: "src/main.js", build: null, own: false, kind: "studio-template" },
    built: false,
    facts: [{ id: "web-game", path: ".", source: "core" }],
  };

  it("another engine with a launch kept: the session is saved under the engine that made it", async () => {
    const log: Array<{ id: string; data: Record<string, unknown> }> = [];
    let cut = () => {};
    let working = () => {};
    const started = new Promise<void>((resolve) => {
      working = resolve;
    });
    const recorder = ctxRecorder({
      unknown: { value: null },
      handlers: {
        "events.append": (p) => {
          for (const data of p.batch as Array<Record<string, unknown>>)
            log.push({ id: String(log.length + 1).padStart(6, "0"), data });
          return null;
        },
        "events.list": () => log,
        "events.messages": () => [{ role: "user", content: "build the boss" }],
        "game.contentStamp": () => ({ all: "a", source: "a" }),
        "game.list": () => [game],
        "plugins.tools": () => ({ tools: [], guidance: "", revision: 1 }),
        "engine.describe": () => [
          { id: CLAUDE, label: "Claude Code", kind: "delegated" },
          { id: "codex", label: "Codex", kind: "delegated" },
        ],
        "preview.ready": () => ({ ready: false }),
        "engine.steer": (p) => {
          cut();
          return { how: "interrupt", accepted: (p.messages as Array<{ id: string }>).map((m) => m.id) };
        },
        "engine.delegate": async () => {
          const cutNow = new Promise<void>((resolve) => {
            cut = resolve;
          });
          working();
          await cutNow;
          // Cut after it recorded the launch: the turn ends on it, on the message's engine.
          return {
            ok: false,
            stopReason: "stopped",
            engine: CLAUDE,
            turns: 2,
            usage: {},
            sessionId: "claude-session",
            summary: "",
            studioToolCalls: [{ name: "start_autopilot", args: { goal: "a boss fight" } }],
          };
        },
      },
    });
    const host = { call: (method: string, p: Record<string, unknown>) => recorder.ctx.call(method, p), notify() {} };
    let ended = () => {};
    const turnEnded = new Promise<void>((resolve) => {
      ended = resolve;
    });
    const queue = new MessageQueue(host as never, async (action, steer) => {
      const turn = {
        threadId: "thread-1",
        turnId: "turn-1",
        text: action.text,
        engine: CLAUDE,
        engineLabel: "Claude Code",
      };
      try {
        await runDelegatedTurn(
          recorder.ctx as never,
          {
            ...turn,
            project: "pond",
            autopilot: action.autopilot,
            asked: action,
            steer,
          } as never,
        );
      } finally {
        ended();
      }
    });
    const send = (text: string, extra: Record<string, unknown>) =>
      queue.enqueue({ type: "user_message", threadId: "thread-1", text, ...extra });
    try {
      await send("build the boss", { engine: CLAUDE, autopilot: { hours: 2 } });
      await started;
      await send("let codex take it", { engine: "codex", autopilot: { hours: 2 } });
      await turnEnded;
      const saved = recorder
        .paramsOf("turn.append")
        .flatMap((p) => p.batch as Array<Record<string, any>>)
        .filter((row) => row.event_type === "contractor_session")
        .map((row) => [row.payload.engine, row.payload.sessionId]);
      assert.deepEqual(saved, [[CLAUDE, "claude-session"]]);
    } finally {
      cut();
      queue.stop();
    }
  });
});

describe("the engine a switched turn's session is on", () => {
  const stopped = (sessionId: string, extra: Record<string, unknown> = {}) => ({
    ok: false,
    stopReason: "stopped",
    engine: "claude-code",
    turns: 2,
    usage: {},
    sessionId,
    summary: "",
    ...extra,
  });

  it("a leg on another engine cut off before it started made no session: a Stop then saves the last one's", async () => {
    const started: Array<() => void> = [];
    const leg = (n: number) =>
      new Promise<void>((resolve) => {
        started[n] = resolve;
      });
    const first = leg(1),
      second = leg(2);
    const turn = switchTurn(
      async (n, _request, cutNow) => {
        const cut = cutNow();
        started[n]?.();
        await cut;
        if (n === 1) return stopped("claude-session");
        // Cut before it did anything: the engine answers that it was aborted.
        throw Object.assign(new Error("aborted"), { kind: "aborted" });
      },
      { stopAtOpen: 3 },
    );
    try {
      await turn.send("build the boss", { engine: "claude-code" });
      await first;
      await turn.send("let codex take it", { engine: "codex" });
      await second;
      await turn.send("and add fog", { engine: "codex" });
      await turn.turnEnded;
      assert.deepEqual(turn.saved(), [["claude-code", "claude-session"]]);
    } finally {
      turn.cut();
      turn.queue.stop();
    }
  });

  it("a new kind's turn after a switch to another engine starts that engine's session afresh", async () => {
    const requests: Array<Record<string, unknown>> = [];
    let first = () => {};
    const working = new Promise<void>((resolve) => {
      first = resolve;
    });
    const turn = switchTurn(
      async (n, request, cutNow) => {
        requests.push(request);
        if (n > 1)
          return { ok: true, engine: "codex", turns: 1, usage: {}, sessionId: "codex-session", summary: "Done." };
        const cut = cutNow();
        first();
        await cut;
        // Cut once it asked its question: the turn ends on it, on the message's engine.
        return stopped("claude-session", {
          studioToolCalls: [{ name: "ask_user", args: { question: "Which boss?", options: ["A", "B"] } }],
        });
      },
      { after: [{ id: "godot-project", path: ".", source: "core" }] },
    );
    try {
      await turn.send("build the boss", { engine: "claude-code", autopilot: { hours: 2 } });
      await working;
      await turn.send("let codex take it", { engine: "codex", autopilot: { hours: 2 } });
      await turn.turnEnded;
      const goesOn = requests.slice(1);
      assert.ok(goesOn.length > 0, "the turn went on with the new kind");
      for (const request of goesOn) {
        assert.equal(request.engine, "codex");
        assert.equal(request.resume ?? null, null, "never Claude Code's session on Codex");
      }
    } finally {
      turn.cut();
      turn.queue.stop();
    }
  });
});
