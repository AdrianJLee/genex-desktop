/**
 * Plan mode on an engine that shows its plan by ending its turn (Codex, Bonsai): the host asks for
 * approval with the plan card once the turn ends, and the same session goes on in the mode chosen,
 * plans again with the person's words, or ends as it is. On every engine that plans, a build the
 * session recorded to start while the chat is still in Plan waits behind that card
 * (main/core/plan-approval.ts).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { planApprovedNote, planRevisionNote } from "../../src/main/core/delegation-prompts.ts";
import { joinedResult, withPlanApproval } from "../../src/main/core/plan-approval.ts";
import type { PermissionMode } from "../../src/shared/permissions.ts";
import type {
  DelegateRequest,
  DelegateResult,
  PermissionAsk,
  PermissionReply,
} from "../../src/substrate/engines/types.ts";

const planned = (summary: string, extra: Partial<DelegateResult> = {}): DelegateResult => ({
  ok: true,
  engine: "codex",
  summary,
  turns: 1,
  usage: { input_tokens: 10, output_tokens: 5 },
  durationMs: 100,
  sessionId: "s1",
  ...extra,
});

/**
 * A chat session in `mode` whose questions get `replies` in turn; every pass and question is kept.
 * The host's word on whether the chat is in Plan starts as `planning` and ends with an approval.
 */
function chat(
  mode: PermissionMode,
  replies: PermissionReply[],
  results: DelegateResult[],
  planningAtFirst = mode === "plan",
) {
  let inPlan = planningAtFirst;
  const asked: PermissionAsk[] = [];
  const passes: DelegateRequest[] = [];
  const request: DelegateRequest = {
    prompt: "Make it jump",
    cwd: "/game",
    images: [{ label: "ref", mimeType: "image/png", data: "AA==" }],
    permissions: {
      mode,
      allow: [],
      directories: [],
      protectWrites: [],
      ask: async (ask) => {
        asked.push(ask);
        const reply = replies.shift();
        assert.ok(reply, "no more answers were expected");
        if (reply.decision === "approve_plan") inPlan = false;
        return reply;
      },
    },
  };
  const run = async (pass: DelegateRequest): Promise<DelegateResult> => {
    passes.push(pass);
    const result = results.shift();
    assert.ok(result, "no more passes were expected");
    return result;
  };
  return { request, run, asked, passes, planning: async () => inPlan };
}

describe("a plan shown by ending a turn", () => {
  it("asks with the plan card, then goes on in the same session in the mode the person chose", async () => {
    const session = chat(
      "plan",
      [{ decision: "approve_plan", mode: "auto" }],
      [planned("1. Add a jump key"), planned("Added the jump key", { sessionId: "s1" })],
    );
    const result = await withPlanApproval({ engine: "codex", ...session, signal: new AbortController().signal });
    assert.equal(session.asked.length, 1);
    assert.equal(session.asked[0]!.tool, "ExitPlanMode");
    assert.deepEqual(session.asked[0]!.input, { plan: "1. Add a jump key" });
    assert.deepEqual(session.asked[0]!.always, []);
    const [, next] = session.passes;
    assert.equal(next!.resume, "s1", "the same session goes on");
    assert.equal(next!.prompt, planApprovedNote());
    assert.equal(next!.permissions!.mode, "auto");
    assert.equal(next!.images, undefined, "the stills were shown already");
    assert.equal(result.summary, "Added the jump key");
    assert.equal(result.turns, 2);
    assert.deepEqual(result.usage, { input_tokens: 20, output_tokens: 10 });
    assert.equal(result.durationMs, 200);
  });

  it("goes on in Auto where the engine does not honour the mode the plan was approved into", async () => {
    const session = chat(
      "plan",
      [{ decision: "approve_plan", mode: "default" }],
      [planned("1. Jump"), planned("Done")],
    );
    await withPlanApproval({ engine: "codex", ...session, signal: new AbortController().signal });
    assert.equal(session.passes[1]!.permissions!.mode, "auto");
  });

  it("plans again with the person's words, still in Plan, and asks again", async () => {
    const session = chat(
      "plan",
      [
        { decision: "deny", message: "Use space, not W" },
        { decision: "approve_plan", mode: "acceptEdits" },
      ],
      [planned("1. Jump on W"), planned("1. Jump on space"), planned("Done")],
    );
    await withPlanApproval({ engine: "bonsai", ...session, signal: new AbortController().signal });
    assert.equal(session.asked.length, 2);
    assert.equal(session.passes[1]!.prompt, planRevisionNote("Use space, not W"));
    assert.equal(session.passes[1]!.permissions!.mode, "plan");
    assert.deepEqual(session.asked[1]!.input, { plan: "1. Jump on space" });
    assert.equal(session.passes[2]!.permissions!.mode, "acceptEdits");
  });

  it("ends the turn with its plan on a bare deny, a withdrawn card, or a Stop", async () => {
    const endings: PermissionReply[] = [
      { decision: "deny" },
      { decision: "deny", message: "   " },
      { decision: "deny", withdrawn: true, message: "The user stopped this work before answering." },
    ];
    for (const ending of endings) {
      const session = chat("plan", [ending], [planned("1. Jump")]);
      const result = await withPlanApproval({ engine: "codex", ...session, signal: new AbortController().signal });
      assert.equal(session.passes.length, 1, JSON.stringify(ending));
      assert.equal(result.summary, "1. Jump");
    }
    const stopped = new AbortController();
    stopped.abort();
    const session = chat("plan", [], [planned("1. Jump")]);
    await withPlanApproval({ engine: "codex", ...session, signal: stopped.signal });
    assert.equal(session.asked.length, 0, "a stopped turn asks nothing");
  });

  it("asks nothing for a reply that is no plan to approve", async () => {
    const replies: Array<[string, DelegateResult]> = [
      ["a failed turn", planned("half a plan", { ok: false })],
      ["an empty reply", planned("  ")],
      ["no session to continue", planned("1. Jump", { sessionId: undefined })],
      ["a question or a launch", planned("Which key?", { studioToolCalls: [{ name: "ask_user", args: {} }] })],
    ];
    for (const [label, reply] of replies) {
      const session = chat("plan", [], [reply]);
      await withPlanApproval({ engine: "codex", ...session, signal: new AbortController().signal });
      assert.equal(session.asked.length, 0, label);
    }
  });

  it("runs once outside Plan, on Claude Code (which asks mid-turn), and for unattended work", async () => {
    const cases: Array<[string, string, PermissionMode | null]> = [
      ["Auto on Codex", "codex", "auto"],
      ["Plan on Claude Code", "claude-code", "plan"],
      ["Plan on an engine without it", "ollama", "plan"],
      ["unattended work", "codex", null],
    ];
    for (const [label, engine, mode] of cases) {
      const session = chat(mode ?? "plan", [], [planned("1. Jump")]);
      if (mode === null) delete session.request.permissions;
      await withPlanApproval({ engine, ...session, signal: new AbortController().signal });
      assert.equal(session.passes.length, 1, label);
      assert.equal(session.asked.length, 0, label);
    }
  });
});

describe("a build recorded to start while the chat is in Plan", () => {
  const launch = { name: "start_autopilot", args: { goal: "A neon platformer", direction: "Celeste" } };
  const signal = new AbortController().signal;
  const launches = (result: DelegateResult) =>
    (result.studioToolCalls ?? []).filter((call) => call.name !== "ask_user").map((call) => call.name);

  it("waits behind the plan card and starts as recorded once approved, on every engine that plans", async () => {
    for (const engine of ["claude-code", "codex", "bonsai"]) {
      const session = chat(
        "plan",
        [{ decision: "approve_plan", mode: "acceptEdits" }],
        [planned("1. Three levels\n2. Wall jump", { studioToolCalls: [launch] })],
      );
      const result = await withPlanApproval({ engine, ...session, signal });
      assert.equal(session.asked.length, 1, engine);
      assert.equal(session.asked[0]?.tool, "ExitPlanMode");
      const plan = String(session.asked[0]?.input.plan);
      assert.match(plan, /1\. Three levels/, engine);
      assert.match(plan, /A neon platformer/, `${engine}: the card says what it would build`);
      assert.equal(session.passes.length, 1, `${engine}: the approved build is the plan carried out`);
      assert.deepEqual(result.studioToolCalls, [launch], engine);
    }
  });

  it("is dropped when the plan is sent back, and the session plans again with the person's words", async () => {
    const session = chat(
      "plan",
      [{ decision: "deny", message: "Fewer levels" }],
      [planned("1. Ten levels", { studioToolCalls: [launch] }), planned("1. Three levels")],
    );
    const result = await withPlanApproval({ engine: "claude-code", ...session, signal });
    const [, again] = session.passes;
    assert.equal(again?.prompt, planRevisionNote("Fewer levels"));
    assert.equal(again?.permissions?.mode, "plan");
    assert.equal(again?.resume, "s1");
    assert.deepEqual(launches(result), [], "nothing starts");
    assert.equal(result.summary, "1. Three levels");
  });

  it("is dropped on a bare deny, a withdrawn card or a Stop", async () => {
    const endings: PermissionReply[] = [
      { decision: "deny" },
      { decision: "deny", withdrawn: true, message: "The user stopped this work before answering." },
    ];
    for (const ending of endings) {
      const session = chat("plan", [ending], [planned("1. Levels", { studioToolCalls: [launch] })]);
      const result = await withPlanApproval({ engine: "codex", ...session, signal });
      assert.deepEqual(launches(result), [], JSON.stringify(ending));
      assert.equal(session.passes.length, 1, JSON.stringify(ending));
    }
    const stopped = new AbortController();
    stopped.abort();
    const session = chat("plan", [], [planned("1. Levels", { studioToolCalls: [launch] })]);
    const result = await withPlanApproval({ engine: "claude-code", ...session, signal: stopped.signal });
    assert.equal(session.asked.length, 0, "a stopped turn asks nothing");
    assert.deepEqual(launches(result), []);
  });

  it("is dropped without asking beside a question, or from a failed turn", async () => {
    const question = { name: "ask_user", args: { question: "Which look?" } };
    const beside = chat("plan", [], [planned("Which look?", { studioToolCalls: [question, launch] })]);
    const asked = await withPlanApproval({ engine: "bonsai", ...beside, signal });
    assert.equal(beside.asked.length, 0);
    assert.deepEqual(asked.studioToolCalls, [question], "the question is still asked");
    const failed = chat("plan", [], [planned("half a plan", { ok: false, studioToolCalls: [launch] })]);
    assert.deepEqual(launches(await withPlanApproval({ engine: "claude-code", ...failed, signal })), []);
    assert.equal(failed.asked.length, 0);
  });

  it("holds a resumed build too, saying what it would do", async () => {
    for (const name of ["resume_run"]) {
      const session = chat(
        "plan",
        [{ decision: "deny" }],
        [planned("", { studioToolCalls: [{ name, args: { text: "Add a boss" } }] })],
      );
      const result = await withPlanApproval({ engine: "claude-code", ...session, signal });
      assert.match(String(session.asked[0]?.input.plan), /Add a boss/, name);
      assert.deepEqual(launches(result), [], name);
    }
  });

  it("goes through once the chat has left Plan, outside it, and on an engine without Plan", async () => {
    const cases: Array<[string, string, PermissionMode, boolean]> = [
      ["approved mid-turn on Claude Code", "claude-code", "plan", false],
      ["Auto", "codex", "auto", false],
      ["Plan recorded on an engine without it", "ollama", "auto", true],
    ];
    for (const [label, engine, mode, planning] of cases) {
      const session = chat(mode, [], [planned("Starting the build", { studioToolCalls: [launch] })], planning);
      const result = await withPlanApproval({ engine, ...session, signal });
      assert.equal(session.asked.length, 0, label);
      assert.deepEqual(result.studioToolCalls, [launch], label);
    }
  });
});

describe("joinedResult", () => {
  it("keeps the last pass's ending and counts everything both passes did", () => {
    const joined = joinedResult(
      planned("plan", { studioToolCalls: [{ name: "a", args: {} }], steered: ["m1"], usage: { cost_usd: 0.5 } }),
      planned("done", { ok: false, stopReason: "stopped", sessionId: "s2", steered: ["m2"], usage: { cost_usd: 1 } }),
    );
    assert.equal(joined.ok, false);
    assert.equal(joined.stopReason, "stopped");
    assert.equal(joined.sessionId, "s2");
    assert.deepEqual(joined.usage, { cost_usd: 1.5 });
    assert.deepEqual(joined.studioToolCalls, [{ name: "a", args: {} }]);
    assert.deepEqual(joined.steered, ["m1", "m2"]);
  });
});
