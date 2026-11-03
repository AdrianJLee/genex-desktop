/**
 * Tool permission ledger — every way a request can be settled, that each settles it once, and
 * that nothing settles it on a clock: Claude Code waits for the person, and so do the chat and a
 * build's lead.
 */
import assert from "node:assert/strict";
import { mock, test } from "node:test";
import { ToolPermissions } from "../../src/main/tool-permissions.ts";

const ask = (
  ledger: ToolPermissions,
  requestId: string,
  extra: {
    project?: string;
    threadId?: string;
    signal?: AbortSignal;
    plan?: boolean;
    outlivesTurn?: boolean;
  } = {},
) =>
  ledger.request({
    requestId,
    project: extra.project ?? "game",
    threadId: extra.threadId ?? "t1",
    ...(extra.plan ? { plan: true } : {}),
    ...(extra.signal ? { signal: extra.signal } : {}),
    ...(extra.outlivesTurn ? { outlivesTurn: true } : {}),
  });

test("the person's answer settles the request, whatever it was", async () => {
  const ledger = new ToolPermissions();
  const allowed = ask(ledger, "p1");
  const always = ask(ledger, "p2");
  const plan = ask(ledger, "p3", { plan: true });
  const denied = ask(ledger, "p4");
  assert.deepEqual(
    ledger.pending().map((p) => p.requestId),
    ["p1", "p2", "p3", "p4"],
  );
  assert.equal(ledger.resolve("p1", { decision: "allow" }), true);
  assert.equal(ledger.resolve("p2", { decision: "always" }), true);
  assert.equal(ledger.resolve("p3", { decision: "approve_plan", mode: "acceptEdits" }), true);
  assert.equal(ledger.resolve("p4", { decision: "deny", message: "Use yarn" }), true);
  assert.deepEqual(await allowed, { answer: { decision: "allow" }, by: "user" });
  assert.deepEqual(await always, { answer: { decision: "always" }, by: "user" });
  assert.deepEqual(await plan, { answer: { decision: "approve_plan", mode: "acceptEdits" }, by: "user" });
  assert.deepEqual(await denied, { answer: { decision: "deny", message: "Use yarn" }, by: "user" });
  assert.deepEqual(ledger.pending(), []);
});

test("a request waits with no timeout of its own", async () => {
  const ledger = new ToolPermissions();
  let settled = false;
  const answer = ask(ledger, "p1").then((result) => {
    settled = true;
    return result;
  });
  await new Promise((resolve) => setTimeout(resolve, 50));
  assert.equal(settled, false);
  assert.equal(ledger.pending().length, 1);
  ledger.resolve("p1", { decision: "allow" });
  assert.equal((await answer).by, "user");
});

// Flipped (no clock): a lead's card nobody answered was withdrawn after its `timeoutMs`
// (`by: "timeout"`, LEAD_ASK_TIMEOUT_MS five minutes); no card has a clock now.
test("a lead's card waits a day unanswered: only an answer or a Stop settles it", async (t) => {
  mock.timers.enable({ apis: ["setTimeout"] });
  t.after(() => mock.timers.reset());
  const ledger = new ToolPermissions();
  const answered = ask(ledger, "p1", { outlivesTurn: true });
  mock.timers.tick(24 * 60 * 60_000);
  assert.equal(ledger.pending().length, 1, "still waiting a day later");
  assert.equal(ledger.resolve("p1", { decision: "allow" }), true);
  assert.deepEqual(await answered, { answer: { decision: "allow" }, by: "user" });
  const stopped = ask(ledger, "p2", { outlivesTurn: true });
  mock.timers.tick(24 * 60 * 60_000);
  ledger.cancel({}, "stop");
  assert.deepEqual(await stopped, { answer: null, by: "stop" });
  assert.deepEqual(ledger.pending(), []);
});

test("an unknown or settled id resolves to false; a second click changes nothing", async () => {
  const ledger = new ToolPermissions();
  assert.equal(ledger.resolve("nope", { decision: "allow" }), false);
  const answer = ask(ledger, "p1");
  assert.equal(ledger.resolve("p1", { decision: "deny" }), true);
  assert.equal(ledger.resolve("p1", { decision: "allow" }), false);
  assert.deepEqual(await answer, { answer: { decision: "deny" }, by: "user" });
  await assert.rejects(Promise.all([ask(ledger, "dup"), ask(ledger, "dup")]), /already pending/);
  ledger.cancel({}, "stop");
});

test("the session's abort withdraws its request as a stop", async () => {
  const ledger = new ToolPermissions();
  const controller = new AbortController();
  const answer = ask(ledger, "p1", { signal: controller.signal });
  controller.abort();
  assert.deepEqual(await answer, { answer: null, by: "stop" });
  assert.equal(ledger.resolve("p1", { decision: "allow" }), false);
  const already = new AbortController();
  already.abort();
  assert.deepEqual(await ask(ledger, "p2", { signal: already.signal }), { answer: null, by: "stop" });
  assert.deepEqual(ledger.pending(), []);
});

test("a turn's end and a game's Stop withdraw only the requests in their scope", async () => {
  const ledger = new ToolPermissions();
  const inTurn = ask(ledger, "p1", { project: "game", threadId: "t1" });
  const otherChat = ask(ledger, "p2", { project: "game", threadId: "t2" });
  const otherGame = ask(ledger, "p3", { project: "other", threadId: "t3" });
  assert.equal(ledger.cancel({ threadId: "t1" }, "turn"), 1);
  assert.deepEqual(await inTurn, { answer: null, by: "turn" });
  assert.equal(ledger.cancel({ project: "game" }, "stop"), 1);
  assert.deepEqual(await otherChat, { answer: null, by: "stop" });
  assert.deepEqual(
    ledger.pending().map((p) => p.requestId),
    ["p3"],
  );
  assert.equal(ledger.cancel({}, "stop"), 1, "an empty scope is the shutdown path: everything goes");
  assert.deepEqual(await otherGame, { answer: null, by: "stop" });
  assert.equal(ledger.cancel({}, "stop"), 0);
  assert.equal(ledger.resolve("p3", { decision: "allow" }), false);
});

test("a lead's card outlives the chat's turns: only a Stop, its session or an answer end it", async () => {
  const ledger = new ToolPermissions();
  const chats = ask(ledger, "p1");
  const leads = ask(ledger, "p2", { outlivesTurn: true });
  assert.equal(ledger.cancel({ threadId: "t1" }, "turn"), 1, "another turn ended: the chat's own card goes");
  assert.deepEqual(await chats, { answer: null, by: "turn" });
  assert.deepEqual(
    ledger.pending().map((p) => p.requestId),
    ["p2"],
  );
  assert.equal(ledger.cancel({ threadId: "t1" }, "stop"), 1, "a Stop still ends it");
  assert.deepEqual(await leads, { answer: null, by: "stop" });
});

test("an answer that does not fit the question is refused, not read as another", async () => {
  const ledger = new ToolPermissions();
  const command = ask(ledger, "cmd");
  const plan = ask(ledger, "plan", { plan: true });
  assert.throws(() => ledger.resolve("cmd", { decision: "approve_plan", mode: "acceptEdits" }), /does not fit/);
  assert.throws(() => ledger.resolve("plan", { decision: "allow" }), /does not fit/);
  assert.throws(() => ledger.resolve("plan", { decision: "always" }), /does not fit/);
  assert.equal(ledger.pending().length, 2, "a refused answer settles nothing");
  assert.equal(ledger.resolve("plan", { decision: "deny", message: "Smaller bridge" }), true);
  assert.equal(ledger.resolve("cmd", { decision: "deny" }), true);
  assert.deepEqual((await plan).answer, { decision: "deny", message: "Smaller bridge" });
  assert.deepEqual((await command).answer, { decision: "deny" });
});
