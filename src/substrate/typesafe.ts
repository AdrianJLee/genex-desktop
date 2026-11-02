/**
 * TypeSafe's System One API, for a pilot's fast decisions (`shared/fast-decisions.ts`): a key check,
 * a warm-up, and one POST per decision over a kept connection. The key is read in main and never
 * leaves it: the engine's editor, the pilot and the agent only ever see the answers.
 *
 * A decision is one `choice` question named `genex_move` over the pilot's moves (each move's words are
 * its criterion), beside the pilot's own extra questions (one of theirs by that name gives way to it),
 * against the ask's state. An answer that takes
 * longer than DECISION_TIMEOUT_MS is dropped: the game went on meanwhile, and the pilot chooses by
 * its own order.
 */
import { SECOND_MS } from "../shared/duration.ts";
import { type PilotAsk, pilotAnswer } from "../shared/engine-play.ts";
import { errorMessage } from "../shared/errors.ts";
import { FAST_DECISION_MODEL, type FastDecider } from "../shared/fast-decisions.ts";

/** TypeSafe's API, before `/systemone` and `/models`. */
export const TYPESAFE_BASE_URL = "https://api.typesafe.ai/v1";
const KEY_CHECK_TIMEOUT_MS = 10 * SECOND_MS;
/** A decision answered later than this is dropped. */
const DECISION_TIMEOUT_MS = 1.5 * SECOND_MS;
/** A warm-up may take longer than a decision: a server waking takes a second or more. */
const WARM_TIMEOUT_MS = 5 * SECOND_MS;
/** The most distinct reasons a decider keeps for answers that did not come. */
const MAX_FAILURES = 5;
/** The question every decision's pick is asked under: a name a pilot's own questions are unlikely to use. */
const PICK = "genex_move";
const HTTP_UNAUTHORIZED = 401;
const HTTP_FORBIDDEN = 403;

/** Where TypeSafe is and how it is reached: the real API by default, a stand-in in tests. */
export interface TypeSafeOptions {
  baseUrl?: string;
  fetch?: typeof fetch;
  now?: () => number;
}

/** Whether TypeSafe takes a key: taken, refused, or not reachable to ask. */
export type TypeSafeKeyCheck = { ok: true } | { ok: false; refused: boolean; detail: string };

function authorized(key: string, extra: Record<string, string> = {}): Record<string, string> {
  return { Authorization: `Bearer ${key}`, ...extra };
}

/** Ask TypeSafe whether a key is good, by listing the models it may use. */
export async function checkTypeSafeKey(key: string, options: TypeSafeOptions = {}): Promise<TypeSafeKeyCheck> {
  const call = options.fetch ?? fetch;
  let response: Response;
  try {
    response = await call(`${options.baseUrl ?? TYPESAFE_BASE_URL}/models`, {
      headers: authorized(key),
      signal: AbortSignal.timeout(KEY_CHECK_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, refused: false, detail: errorMessage(err) };
  }
  await response.body?.cancel().catch(() => {});
  if (response.ok) return { ok: true };
  const refused = response.status === HTTP_UNAUTHORIZED || response.status === HTTP_FORBIDDEN;
  return { ok: false, refused, detail: `HTTP ${response.status}` };
}

/** A field of an object, when the value is an object that has it. */
function field(value: unknown, name: string): unknown {
  if (typeof value !== "object" || value === null || !Object.hasOwn(value, name)) return undefined;
  const found: unknown = Reflect.get(value, name);
  return found;
}

/** A choice's probabilities, or its one choice as certain when it gave none. */
function choiceProbabilities(answer: unknown): unknown {
  const probabilities = field(answer, "probabilities");
  if (typeof probabilities === "object" && probabilities !== null) return probabilities;
  const choice = field(answer, "choice");
  return typeof choice === "string" ? { [choice]: 1 } : {};
}

/** An extra question's answer as a pilot reads it: a noul's probability, a score, or a choice's probabilities. */
function extraAnswer(answer: unknown): unknown {
  const type = field(answer, "type");
  if (type === "noul") return field(answer, "noul");
  if (type === "score") return field(answer, "score");
  return choiceProbabilities(answer);
}

/** The body of one decision: the pick over the moves beside the pilot's own questions. */
function decisionBody(ask: PilotAsk): string {
  const pick = { type: "choice", instructions: ask.instructions, criteria: ask.moves };
  return JSON.stringify({
    model: FAST_DECISION_MODEL,
    state: ask.state,
    questions: { ...ask.questions, [PICK]: pick },
  });
}

/** A decider that asks TypeSafe with `key`, plus a warm-up that opens its connection before the first decision. */
export function typeSafeDecider(key: string, options: TypeSafeOptions = {}): FastDecider & { warm(): Promise<void> } {
  const call = options.fetch ?? fetch;
  const now = options.now ?? Date.now;
  const base = options.baseUrl ?? TYPESAFE_BASE_URL;
  const failures: string[] = [];
  let inputTokens = 0;
  const failed = (why: string): null => {
    if (!failures.includes(why) && failures.length < MAX_FAILURES) failures.push(why);
    return null;
  };
  const read = async (response: Response, id: number, started: number) => {
    const body: unknown = await response.json();
    const answers = field(body, "answers");
    const tokens = field(field(body, "usage"), "input_tokens");
    if (typeof tokens === "number" && Number.isFinite(tokens)) inputTokens += tokens;
    const pick = field(answers, PICK);
    if (pick === undefined) return failed("an answer without its pick");
    const extras = Object.entries(typeof answers === "object" && answers !== null ? answers : {})
      .filter(([name]) => name !== PICK)
      .map(([name, answer]): [string, unknown] => [name, extraAnswer(answer)]);
    return pilotAnswer(id, choiceProbabilities(pick), Object.fromEntries(extras), now() - started);
  };
  return {
    model: FAST_DECISION_MODEL,
    async choose(ask, signal) {
      const started = now();
      const timeout = AbortSignal.timeout(DECISION_TIMEOUT_MS);
      try {
        const response = await call(`${base}/systemone`, {
          method: "POST",
          headers: authorized(key, { "Content-Type": "application/json" }),
          body: decisionBody(ask),
          signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
        });
        if (!response.ok) {
          await response.body?.cancel().catch(() => {});
          return failed(`HTTP ${response.status}`);
        }
        return await read(response, ask.id, started);
      } catch (err) {
        return failed(timeout.aborted ? "no answer in time" : errorMessage(err));
      }
    },
    tally: () => ({ inputTokens, failures: [...failures] }),
    async warm() {
      const response = await call(`${base}/models`, {
        headers: authorized(key),
        signal: AbortSignal.timeout(WARM_TIMEOUT_MS),
      }).catch(() => null);
      await response?.body?.cancel().catch(() => {});
    },
  };
}
