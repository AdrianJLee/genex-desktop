/**
 * Budget ledger — substrate-enforced caps at the engine seam.
 *
 * The harness is agent-editable and cannot be trusted to police its own spending, so the caps
 * live here, checked inside `engine.complete`/`engine.delegate` before anything is dispatched.
 * Two classes of work:
 *
 *  - `"user"` — everything the user asked for. Never blocked by the ledger.
 *  - `"improvement"` — SkillOpt passes, architect jobs. Refused while user work is in flight
 *    (improvement never queues ahead of a build) and capped to a share of the day's tokens.
 *
 * The class tag arrives as an RPC param defaulting to `"user"`. The harness can only lie
 * downward: mislabelling its own work "improvement" gets it *more* restrictions, never fewer,
 * and the scheduler that runs real improvement jobs lives host-side where the tag is trustworthy.
 */
import { normalizedTokens } from "../shared/eval-lane.ts";
import { WorkClass } from "../shared/harness-api.ts";
import { atomicWriteJson, readJson } from "./fsx.ts";

/** The budget class vocabulary lives in `shared/harness-api.ts`; engine code reads it from here. */
export { WorkClass };

/** The class a call asked for: only an explicit `improvement` is improvement work. */
export function workClassOf(requested: unknown): WorkClass {
  return requested === WorkClass.Improvement ? WorkClass.Improvement : WorkClass.User;
}

export type BudgetGate = { ok: true } | { ok: false; reason: string };

interface DayBucket {
  user: number;
  improvement: number;
}

interface LedgerFile {
  days: Record<string, DayBucket>;
}

export interface BudgetLedgerOptions {
  /** Persisted day-bucketed totals, e.g. `<userData>/budget-ledger.json`. */
  file: string;
  /** Improvement-class share of the day's total tokens (default 15%). */
  improvementShare?: number;
  /**
   * Tokens of improvement work always allowed per day before the share kicks in — without a
   * floor, a quiet day (total ≈ 0) would block the very first improvement call forever.
   */
  improvementFloorTokens?: number;
  now?: () => Date;
}

/** How many days of totals the ledger keeps. */
const KEEP_DAYS = 30;
/** Improvement work's default share of the day's tokens. */
const DEFAULT_IMPROVEMENT_SHARE = 0.15;
/** Improvement tokens always allowed per day before the share applies (see `improvementFloorTokens`). */
const DEFAULT_IMPROVEMENT_FLOOR_TOKENS = 200_000;

const MESSAGE = {
  UserWorkRunning: "user work is running — improvement work never queues ahead of a build",
  ShareSpent: (spent: number, allowance: number) =>
    `improvement work has spent its daily share (${Math.round(spent)} of ${Math.round(allowance)} tokens)`,
  Refused: (reason: string) => `budget: ${reason}`,
} as const;

export class BudgetLedger {
  readonly #file: string;
  readonly #share: number;
  readonly #floor: number;
  readonly #now: () => Date;
  #days: Record<string, DayBucket> = {};
  /** In-flight user-class engine calls; improvement work is refused while any are running. */
  #userInFlight = 0;
  #persisting: Promise<void> = Promise.resolve();

  constructor(options: BudgetLedgerOptions) {
    this.#file = options.file;
    this.#share = options.improvementShare ?? DEFAULT_IMPROVEMENT_SHARE;
    this.#floor = options.improvementFloorTokens ?? DEFAULT_IMPROVEMENT_FLOOR_TOKENS;
    this.#now = options.now ?? (() => new Date());
  }

  async load(): Promise<void> {
    const parsed = await readJson<LedgerFile>(this.#file).catch(() => null);
    const days = parsed?.days;
    if (typeof days !== "object" || days === null) return;
    this.#days = {};
    for (const [day, bucket] of Object.entries(days)) {
      this.#days[day] = {
        user: Number((bucket as DayBucket)?.user) || 0,
        improvement: Number((bucket as DayBucket)?.improvement) || 0,
      };
    }
  }

  #dayKey(): string {
    return this.#now().toISOString().slice(0, 10);
  }

  #bucket(): DayBucket {
    const key = this.#dayKey();
    let bucket = this.#days[key];
    if (!bucket) {
      bucket = { user: 0, improvement: 0 };
      this.#days[key] = bucket;
      const keys = Object.keys(this.#days).sort();
      for (const stale of keys.slice(0, Math.max(0, keys.length - KEEP_DAYS))) delete this.#days[stale];
    }
    return bucket;
  }

  /** Call before dispatching; pair with {@link endWork} in a finally. */
  beginWork(workClass: WorkClass): void {
    if (workClass === WorkClass.User) this.#userInFlight++;
  }

  endWork(workClass: WorkClass): void {
    if (workClass === WorkClass.User) this.#userInFlight = Math.max(0, this.#userInFlight - 1);
  }

  get userInFlight(): number {
    return this.#userInFlight;
  }

  /** Tokens spent today, by class. */
  today(): { user: number; improvement: number } {
    const bucket = this.#days[this.#dayKey()] ?? { user: 0, improvement: 0 };
    return { ...bucket };
  }

  record(entry: { tokens: number; class: WorkClass }): void {
    const tokens = Number(entry.tokens);
    if (!Number.isFinite(tokens) || tokens <= 0) return;
    const bucket = this.#bucket();
    if (entry.class === WorkClass.Improvement) bucket.improvement += tokens;
    else bucket.user += tokens;
    // Fire-and-forget, serialised: bookkeeping must never block or reorder an engine call.
    this.#persisting = this.#persisting
      .then(() => atomicWriteJson(this.#file, { days: this.#days } satisfies LedgerFile))
      .catch(() => {});
  }

  /** A usage report's tokens, recorded against this class; `engine` says what its input_tokens holds. */
  recordUsage(workClass: WorkClass, usage: unknown, engine?: string): void {
    this.record({ tokens: usageTokens(usage, engine), class: workClass });
  }

  gate(check: { class: WorkClass }): BudgetGate {
    if (check.class === WorkClass.User) return { ok: true };
    if (this.#userInFlight > 0) {
      return { ok: false, reason: MESSAGE.UserWorkRunning };
    }
    const { user, improvement } = this.today();
    const allowance = Math.max(this.#floor, this.#share * (user + improvement));
    if (improvement >= allowance) return { ok: false, reason: MESSAGE.ShareSpent(improvement, allowance) };
    return { ok: true };
  }

  /** Refuse work the ledger will not allow now, as `budget: <reason>`. */
  assertAllowed(workClass: WorkClass): void {
    const gate = this.gate({ class: workClass });
    if (!gate.ok) throw new Error(MESSAGE.Refused(gate.reason));
  }

  /** One engine call of this class: gated, counted in flight while `work` runs, its usage recorded. */
  async run<T extends { usage?: unknown }>(workClass: WorkClass, work: () => Promise<T>, engine?: string): Promise<T> {
    this.assertAllowed(workClass);
    this.beginWork(workClass);
    try {
      const result = await work();
      this.recordUsage(workClass, result.usage, engine);
      return result;
    } finally {
      this.endWork(workClass);
    }
  }

  /** Flush pending persistence — for tests and orderly shutdown. */
  async flush(): Promise<void> {
    await this.#persisting;
  }
}

/**
 * Total tokens in a usage record, tolerant of partially-filled engine reports. Codex's
 * `input_tokens` already holds its cache reads, so they count once (`normalizedTokens`).
 */
export function usageTokens(usage: unknown, engine?: string): number {
  const u = (usage ?? {}) as Record<string, unknown>;
  const n = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const tokens = normalizedTokens(
    {
      input_tokens: n(u.input_tokens),
      output_tokens: n(u.output_tokens),
      cache_read_tokens: n(u.cache_read_tokens),
      cache_write_tokens: n(u.cache_write_tokens),
    },
    engine,
  );
  return tokens.uncachedInput + tokens.cacheWrite + tokens.cacheRead + tokens.output;
}
