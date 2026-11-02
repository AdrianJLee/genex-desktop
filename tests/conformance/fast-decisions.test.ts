/**
 * The fast decision model a pilot may ask (TypeSafe's Jev): its key, checked with TypeSafe before it
 * is kept and never handed back, and the decider that turns one of a pilot's asks into one System One
 * request. Optional: with no key there is no decider, and nothing reaches TypeSafe.
 */
import assert from "node:assert/strict";
import test from "node:test";
import { FastDecisions } from "../../src/main/core/fast-decisions.ts";
import type { PilotAsk } from "../../src/shared/engine-play.ts";
import { FAST_DECISION_MODEL, FastDecisionKeyState } from "../../src/shared/fast-decisions.ts";
import { memoryKeyStore } from "../../src/substrate/provider-keys.ts";
import { checkTypeSafeKey, TYPESAFE_BASE_URL, typeSafeDecider } from "../../src/substrate/typesafe.ts";

const GOOD_KEY = "ts-live-0123456789abcdef";

/** A request TypeSafe was sent: where, how, and its body as JSON. */
type Sent = { url: string; method: string; auth: string | null; body: unknown };

/** A stand-in for TypeSafe: each request recorded, answered by `answer` (a Response, or a thrown error). */
function fakeTypeSafe(answer: (sent: Sent) => Response | Promise<Response>) {
  const sent: Sent[] = [];
  const fetch: typeof globalThis.fetch = async (input, init) => {
    const headers = new Headers(init?.headers);
    const body = typeof init?.body === "string" ? (JSON.parse(init.body) as unknown) : null;
    const request = { url: String(input), method: init?.method ?? "GET", auth: headers.get("Authorization"), body };
    sent.push(request);
    return answer(request);
  };
  return { fetch, sent };
}

const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), { status, headers: { "Content-Type": "application/json" } });

/** TypeSafe as it answers a good key and a decision. */
function typeSafe(decision: unknown = {}) {
  return fakeTypeSafe((sent) => {
    if (sent.auth !== `Bearer ${GOOD_KEY}`) return json({ detail: "bad key" }, 401);
    if (sent.url.endsWith("/models")) return json({ models: [{ name: "jev-latest" }] });
    return json(decision);
  });
}

const ASK: PilotAsk = {
  id: 7,
  state: { goal: "Disable the turret", situation: { health: 40 }, moves: {} },
  moves: { attack: "hit the turret", back_off: "step out of its line of fire" },
  instructions: "Pick the move that serves the goal.",
  questions: {
    danger: { type: "noul", instructions: "Is the player about to be hit?" },
    pick: { type: "noul", instructions: "Is there a pickup in reach?" },
  },
};

test("a pasted key is kept only once TypeSafe takes it, and no status ever carries it back", async () => {
  const server = typeSafe();
  const keys = memoryKeyStore();
  const decisions = new FastDecisions(keys, { fetch: server.fetch });
  assert.deepEqual(await decisions.status(), { state: FastDecisionKeyState.Missing });
  const cases = [
    { pasted: "ts-not-the-right-key-000", state: FastDecisionKeyState.Refused },
    { pasted: "two words", state: FastDecisionKeyState.Refused },
    { pasted: 42, state: FastDecisionKeyState.Refused },
  ];
  for (const { pasted, state } of cases) {
    const status = await decisions.save(pasted);
    assert.equal(status.state, state, String(pasted));
    assert.equal(await keys.read(), null, `nothing kept for ${String(pasted)}`);
  }
  const saved = await decisions.save(`  ${GOOD_KEY}\n`);
  assert.deepEqual(saved, { state: FastDecisionKeyState.Ready });
  assert.equal(await keys.read(), GOOD_KEY);
  assert.ok(!JSON.stringify(saved).includes(GOOD_KEY));
  assert.ok(
    server.sent.every((sent) => sent.url === `${TYPESAFE_BASE_URL}/models`),
    "a check only lists models",
  );
  assert.deepEqual(await decisions.clear(), { state: FastDecisionKeyState.Missing });
  assert.equal(await decisions.decider(), null, "no key, no decider: pilots choose by their own order");
});

test("a key TypeSafe cannot be reached to check is not kept, and says why", async () => {
  const down = fakeTypeSafe(() => {
    throw new Error("getaddrinfo ENOTFOUND api.typesafe.ai");
  });
  const keys = memoryKeyStore();
  const status = await new FastDecisions(keys, { fetch: down.fetch }).save(GOOD_KEY);
  assert.equal(status.state, FastDecisionKeyState.Unreachable);
  assert.match(status.detail ?? "", /ENOTFOUND/);
  assert.equal(await keys.read(), null);
  const busy = fakeTypeSafe(() => json({}, 529));
  assert.deepEqual(await checkTypeSafeKey(GOOD_KEY, { fetch: busy.fetch }), {
    ok: false,
    refused: false,
    detail: "HTTP 529",
  });
});

test("a decision is one pick over the moves beside the pilot's questions (one named pick included), on the pinned model", async () => {
  const server = typeSafe({
    model: FAST_DECISION_MODEL,
    answers: {
      genex_move: {
        type: "choice",
        choice: "back_off",
        confidence: 0.8,
        probabilities: { attack: 0.25, back_off: 0.75 },
      },
      pick: { type: "noul", noul: 0.4 },
      danger: { type: "noul", noul: 0.91 },
    },
    usage: { input_tokens: 312, output_tokens: 4 },
  });
  let clock = 1000;
  const decider = typeSafeDecider(GOOD_KEY, { fetch: server.fetch, now: () => (clock += 90) });
  const answer = await decider.choose(ASK);
  assert.deepEqual(answer, {
    id: 7,
    probabilities: { attack: 0.25, back_off: 0.75 },
    answers: { danger: 0.91, pick: 0.4 },
    ms: 90,
  });
  const [sent] = server.sent;
  assert.equal(sent?.url, `${TYPESAFE_BASE_URL}/systemone`);
  assert.equal(sent?.method, "POST");
  assert.deepEqual(sent?.body, {
    model: FAST_DECISION_MODEL,
    state: ASK.state,
    questions: {
      danger: ASK.questions.danger,
      pick: ASK.questions.pick,
      genex_move: { type: "choice", instructions: ASK.instructions, criteria: ASK.moves },
    },
  });
  assert.deepEqual(decider.tally(), { inputTokens: 312, failures: [] });
});

test("a decision that does not come, comes refused or comes malformed is null and said once, never thrown", async () => {
  const cases: Array<{ answer: () => Response | Promise<Response>; failure: RegExp }> = [
    { answer: () => json({ detail: "slow down" }, 429), failure: /HTTP 429/ },
    { answer: () => json({ answers: {} }), failure: /without its pick/ },
    { answer: () => new Response("not json", { status: 200 }), failure: /JSON|Unexpected/ },
    {
      answer: () => {
        throw new TypeError("fetch failed");
      },
      failure: /fetch failed/,
    },
  ];
  for (const { answer, failure } of cases) {
    const server = fakeTypeSafe(answer);
    const decider = typeSafeDecider(GOOD_KEY, { fetch: server.fetch });
    assert.equal(await decider.choose(ASK), null);
    assert.equal(await decider.choose(ASK), null);
    const { failures } = decider.tally();
    assert.equal(failures.length, 1, failures.join("; "));
    assert.match(failures[0] ?? "", failure);
  }
});

test("a choice that names one option with no probabilities is that option, certain", async () => {
  const server = typeSafe({ answers: { genex_move: { type: "choice", choice: "attack" } } });
  const answer = await typeSafeDecider(GOOD_KEY, { fetch: server.fetch }).choose({ ...ASK, questions: {} });
  assert.deepEqual(answer?.probabilities, { attack: 1 });
});

test("a decision the caller abandons is null at once", async () => {
  const hung = fakeTypeSafe(
    (_sent) =>
      new Promise<Response>(() => {
        // never answers
      }),
  );
  const leaving = new AbortController();
  const decider = typeSafeDecider(GOOD_KEY, {
    fetch: async (input, init) => {
      const pending = hung.fetch(input, init);
      return Promise.race([
        pending,
        new Promise<Response>((_resolve, reject) =>
          init?.signal?.addEventListener("abort", () => reject(init.signal?.reason)),
        ),
      ]);
    },
  });
  const choosing = decider.choose(ASK, leaving.signal);
  leaving.abort(new Error("the session ended"));
  assert.equal(await choosing, null);
});
