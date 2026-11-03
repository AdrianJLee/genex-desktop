/**
 * The seed's small shared helpers and name tables: time units and waits (`loop/time.ts`), text
 * cut to fit (`loop/text.ts`), a commit as a line quotes it (`loop/git.ts`), and the verdict's
 * rules and reasons (`loop/verdict.ts`).
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { CLIP_QUOTE, clip, clipMarked } from "../../src/harness-seed/loop/text.ts";
import {
  CANCEL_POLL_MS,
  HOUR_MS,
  MINUTE_MS,
  SECOND_MS,
  minutes,
  sleep,
  sleepUnlessCancelled,
} from "../../src/harness-seed/loop/time.ts";
import { NotLandedReason, VerdictRule, verdictRecord } from "../../src/harness-seed/loop/verdict.ts";

describe("time", () => {
  it("counts in milliseconds", () => {
    assert.equal(SECOND_MS, 1000);
    assert.equal(MINUTE_MS, 60_000);
    assert.equal(HOUR_MS, 3_600_000);
  });

  it("says a span in whole minutes, never below zero", () => {
    assert.equal(minutes(0), 0);
    assert.equal(minutes(89 * SECOND_MS), 1);
    assert.equal(minutes(91 * SECOND_MS), 2);
    assert.equal(minutes(-5 * MINUTE_MS), 0);
  });

  it("waits, and a cancelled run stops waiting at the next look", async () => {
    const started = Date.now();
    await sleep(5);
    assert.ok(Date.now() - started >= 4);

    const ctx = { cancelled: false };
    const waiting = sleepUnlessCancelled(ctx, HOUR_MS);
    ctx.cancelled = true;
    const cancelledAt = Date.now();
    await waiting;
    assert.ok(Date.now() - cancelledAt <= CANCEL_POLL_MS * 4, "an hour's wait ends within a few looks");
    await sleepUnlessCancelled(null, 1);
  });
});

describe("text cut to fit", () => {
  it("keeps the first characters, and nothing for no value", () => {
    assert.equal(clip("abcdef", 3), "abc");
    assert.equal(clip("ab", 3), "ab");
    assert.equal(clip(42, 1), "4");
    assert.equal(clip(null, 3), "");
    assert.equal(clip(undefined, 3), "");
    assert.equal(clip("x".repeat(500), CLIP_QUOTE).length, CLIP_QUOTE);
  });

  it("marks a cut", () => {
    assert.equal(clipMarked("abcdef", 3), "abc…");
    assert.equal(clipMarked("abc", 3), "abc");
    assert.equal(clipMarked(undefined, 3), "");
  });
});

describe("the verdict's rules and reasons", () => {
  it("give every rule its own sentence", () => {
    const unseen = verdictRecord({ rule: VerdictRule.Unseen }).because;
    for (const rule of Object.values(VerdictRule)) {
      const { because, decision } = verdictRecord({ rule });
      assert.equal(decision.rule, rule);
      if (rule !== VerdictRule.Unseen) assert.notEqual(because, unseen, rule);
    }
  });

  it("say why a close landed nothing, reason by reason", () => {
    const generic = verdictRecord({ rule: VerdictRule.NotLanded }).because;
    const sentences = Object.values(NotLandedReason).map(
      (notLanded) => verdictRecord({ rule: VerdictRule.NotLanded, notLanded }).because,
    );
    for (const sentence of sentences) assert.notEqual(sentence, generic);
    assert.equal(new Set(sentences).size, sentences.length, "each reason says something of its own");
  });
});
