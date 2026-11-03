/**
 * Live never keeps a game hidden behind its loader longer than 45 s, whatever the page does. A load
 * the stage started itself is `pending` until main answers it, and main's answer never came for a
 * page whose start-up never ended: the 45 s were only counted once it had, so "Loading game" stayed
 * on the stage for good. A pending load gives up on the same clock, and says it timed out.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { freshSettle, type LiveLoad, settledLoad } from "../../src/renderer/panels/stage/live-load.ts";
import { LiveOutcome, LiveTrigger, LiveWaitSaw } from "../../src/renderer/analytics/events/builds.ts";

const T0 = Date.parse("2026-10-30T14:30:00.000Z");
const SECOND = 1000;

/** What the stage's probe hears while main is still loading the page: nothing of it yet. */
const probeAt = (now: number) => ({ live: null, current: false, broken: false, now });

describe("a load the stage is still waiting for main to answer", () => {
  const pending: LiveLoad = { project: "drifting-rocks", pending: true, since: T0, trigger: LiveTrigger.GameStarted };

  it("keeps the loader while there is time left", () => {
    assert.equal(settledLoad(pending, "drifting-rocks", freshSettle(), probeAt(T0 + 10 * SECOND)), null);
    assert.equal(settledLoad(pending, "drifting-rocks", freshSettle(), probeAt(T0 + 45 * SECOND)), null);
  });

  it("gives up as timed out once Live has kept the game hidden 45 s, though main never answered", () => {
    assert.deepEqual(settledLoad(pending, "drifting-rocks", freshSettle(), probeAt(T0 + 46 * SECOND)), {
      load: pending,
      outcome: LiveOutcome.TimedOut,
    });
  });

  it("is not this game's to end when it loads another one", () => {
    assert.equal(settledLoad(pending, "orchard", freshSettle(), probeAt(T0 + 46 * SECOND)), null);
  });
});

/**
 * Every new game's first wait ended "timed out": its first build had no page yet, so the probe never
 * saw one, and the event could not tell that from a page that came and never settled. A wait that
 * runs out without ever seeing this game's page says so, and the settle keeps when it first saw it.
 */
describe("a load main answered whose page never came", () => {
  const answered: LiveLoad = {
    project: "drifting-rocks",
    pending: false,
    since: T0,
    trigger: LiveTrigger.FirstBuildAuto,
  };
  /** A probe of this game's page, still loading. */
  const thisGameAt = (now: number) => ({
    live: { project: "drifting-rocks", navigating: false, page: { complete: false, resources: 3 } },
    current: true,
    broken: false,
    now,
  });
  /** A probe while Live still holds another game's page. */
  const otherGameAt = (now: number) => ({
    live: { project: "orchard", navigating: false },
    current: false,
    broken: false,
    now,
  });
  const probe = (p: { live: unknown; current: boolean; broken: boolean; now: number }) =>
    p as Parameters<typeof settledLoad>[3];

  it("ends with no page, not a timeout, when no probe saw this game's page", () => {
    const settle = freshSettle();
    assert.equal(settledLoad(answered, "drifting-rocks", settle, probe(otherGameAt(T0 + 10 * SECOND))), null);
    assert.deepEqual(settledLoad(answered, "drifting-rocks", settle, probe(otherGameAt(T0 + 46 * SECOND))), {
      load: answered,
      outcome: LiveOutcome.NoPage,
    });
    assert.equal(settle.currentAt, 0);
    assert.equal(settle.saw, LiveWaitSaw.OtherGame);
  });

  it("times out, and keeps when it first saw the page, when the page came but never settled", () => {
    const settle = freshSettle();
    assert.equal(settledLoad(answered, "drifting-rocks", settle, probe(thisGameAt(T0 + 5 * SECOND))), null);
    assert.equal(settledLoad(answered, "drifting-rocks", settle, probe(otherGameAt(T0 + 20 * SECOND))), null);
    assert.deepEqual(settledLoad(answered, "drifting-rocks", settle, probe(otherGameAt(T0 + 46 * SECOND))), {
      load: answered,
      outcome: LiveOutcome.TimedOut,
    });
    assert.equal(settle.currentAt, T0 + 5 * SECOND);
  });

  it("starts a pending load's settle afresh, so an earlier load's page is not counted as seen", () => {
    const settle = freshSettle();
    settledLoad(answered, "drifting-rocks", settle, probe(thisGameAt(T0 + 5 * SECOND)));
    const pending: LiveLoad = { ...answered, since: T0 + 60 * SECOND, pending: true };
    settledLoad(pending, "drifting-rocks", settle, probeAt(T0 + 61 * SECOND));
    assert.deepEqual([settle.since, settle.currentAt, settle.saw], [pending.since, 0, LiveWaitSaw.Nothing]);
  });
});
