/**
 * The review card's view, the same in the Publish dialog and in the chat: each state of Genex's review
 * of a game's apps and of its takedown, and what the newest Fix with agent press became, as its title,
 * lines, things, presses and footer. Every word is true of what Genex does: no card says the check
 * takes seconds, that Genex checks public games again, or that a takedown comes back without a person.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  elapsedWords,
  historyLabel,
  ReviewCardKind,
  type ReviewCardView,
  ReviewLink,
  ReviewPlace,
  ReviewPress,
  reviewCardView,
} from "../../src/renderer/panels/plugins/genex/review-card-view.ts";
import {
  GenexAppReview,
  GenexFixKind,
  GenexHumanReview,
  type GenexReviewApp,
  GenexReviewChange,
  GenexReviewReadProblem,
  type GenexReviewRecord,
  type GenexReviewStatus,
  type GenexTakedown,
  gameReviewOf,
} from "../../src/shared/genex-review.ts";
import type { GenexFixState } from "../../src/shared/genex-review-log.ts";

const DECIDED = "2026-10-27T14:06:00.000Z";
const thing = (n: number) => ({ text: `Thing ${n}` });

const app = (state: GenexAppReview, extra: Partial<GenexReviewApp> = {}): GenexReviewApp => ({
  platform: "mac",
  arch: "arm64",
  state,
  version: "1.3.0",
  sentAt: "2026-10-27T14:02:00.000Z",
  decidedAt: DECIDED,
  decidedBy: "check",
  things: state === GenexAppReview.NotApproved ? [thing(1)] : [],
  humanReview: { state: GenexHumanReview.None, canRequest: state === GenexAppReview.NotApproved },
  ...extra,
});

const status = (
  apps: GenexReviewApp[],
  takedown: GenexTakedown | null = null,
  extra: Partial<GenexReviewStatus> = {},
) => {
  const record: GenexReviewRecord = { state: gameReviewOf(apps, takedown), apps, takedown };
  return {
    record,
    checkedAt: null,
    connected: true,
    open: true,
    fingerprint: "f",
    told: null,
    publishing: false,
    ...extra,
  };
};

const takedown = (extra: Partial<GenexTakedown> = {}): GenexTakedown => ({
  at: DECIDED,
  things: [thing(1), thing(2), thing(3)],
  appealable: true,
  humanReview: { state: GenexHumanReview.None, canRequest: true },
  ...extra,
});

const fix = (extra: Partial<GenexFixState> = {}): GenexFixState => ({
  fixId: "fix-1",
  kind: GenexFixKind.App,
  count: 1,
  autoPublish: true,
  at: "2026-10-27T14:20:00.000Z",
  index: 0,
  ...extra,
});

const view = (s: GenexReviewStatus | null, extra: Partial<Parameters<typeof reviewCardView>[0]> = {}) =>
  reviewCardView({ status: s, fix: null, title: "Midnight Asphalt", place: ReviewPlace.Chat, ...extra });

const presses = (card: ReviewCardView | null) => card?.presses.map((one) => one.press) ?? [];
const words = (card: ReviewCardView | null) =>
  [card?.title, ...(card?.lines ?? []), ...(card?.after ?? []), card?.footer].filter(Boolean).join(" ");

describe("an app Genex turned down", () => {
  it("can't publish yet, with Fix with agent, Request human review and the honest footer", () => {
    const card = view(status([app(GenexAppReview.NotApproved)]));
    assert.equal(card?.kind, ReviewCardKind.NotApproved);
    assert.equal(card?.title, "Can't publish yet: 1 thing to fix");
    assert.deepEqual(presses(card), [ReviewPress.Fix, ReviewPress.Request]);
    assert.equal(card?.footer, "Nothing went public. After the fix, it publishes by itself and Genex checks it again.");
  });

  it("says players keep the earlier version of an update", () => {
    const card = view(
      status([app(GenexAppReview.NotApproved, { players: { version: "1.2.0", since: "2026-10-25T10:00:00Z" } })]),
    );
    assert.equal(card?.kind, ReviewCardKind.Update);
    assert.equal(card?.title, "Update not approved: 1 thing to fix");
    assert.match(card?.lines[0] ?? "", /^Players keep the .+ version\.$/);
  });

  it("says still to fix after the re-check Studio sent by itself", () => {
    const card = view(status([app(GenexAppReview.NotApproved, { decidedAt: "2026-10-27T14:40:00Z" })]), {
      fix: fix({ outcome: GenexReviewChange.Sent }),
    });
    assert.equal(card?.kind, ReviewCardKind.Still);
    assert.equal(card?.title, "Not approved: 1 thing still to fix after the re-check");
  });

  it("names a person's decision, after a request and when the check handed it on, quoting them", () => {
    const kept = view(
      status([
        app(GenexAppReview.NotApproved, {
          decidedBy: "person",
          reply: "Sell coins through the Genex shop.",
          humanReview: { state: GenexHumanReview.Answered, canRequest: false },
        }),
      ]),
    );
    assert.equal(kept?.kind, ReviewCardKind.PersonKept);
    assert.deepEqual(kept?.lines, ["Human review agreed with the check."]);
    assert.equal(kept?.quote, "Sell coins through the Genex shop.");
    assert.deepEqual(presses(kept), [ReviewPress.Fix]);
    const handed = view(status([app(GenexAppReview.NotApproved, { decidedBy: "person" })]));
    assert.deepEqual(handed?.lines, ["A person at Genex reviewed it."]);
  });

  it("says three turn-downs this week send the next build to a person", () => {
    const card = view(status([app(GenexAppReview.NotApproved, { nextReviewBy: "person", nextReviewWhy: "repeated" })]));
    assert.equal(card?.kind, ReviewCardKind.Repeated);
    assert.deepEqual(presses(card), [ReviewPress.Fix]);
    assert.equal(card?.footer, null);
  });

  it("says a request is open, its resend going now, or still owed", () => {
    const asked = (resend: boolean) =>
      app(GenexAppReview.NotApproved, {
        humanReview: { state: GenexHumanReview.Requested, canRequest: false, ...(resend ? { resend } : {}) },
      });
    assert.equal(view(status([asked(false)]))?.kind, ReviewCardKind.Requested);
    const going = view(status([asked(true)]), { sending: true });
    assert.equal(going?.kind, ReviewCardKind.Resending);
    assert.deepEqual(going?.after, ["Sending the Mac app again so a person can read it…"]);
    const owed = view(status([asked(true)]));
    assert.equal(owed?.kind, ReviewCardKind.ResendOwed);
    assert.deepEqual(presses(owed), [ReviewPress.Publish]);
  });

  it("shows a fix on its way, with the link that takes the publish back, and once taken back, Publish", () => {
    const pending = view(status([app(GenexAppReview.NotApproved)]), { fix: fix() });
    assert.equal(pending?.kind, ReviewCardKind.FixSent);
    assert.deepEqual(pending?.after, [
      "Sent to your agent. When it's done, Studio publishes it and Genex checks it again.",
    ]);
    assert.equal(pending?.link?.link, ReviewLink.DontPublish);
    assert.deepEqual(presses(pending), []);
    const manual = view(status([app(GenexAppReview.NotApproved)]), { fix: fix({ autoPublish: false }) });
    assert.equal(manual?.kind, ReviewCardKind.AutoCancelled);
    assert.deepEqual(presses(manual), [ReviewPress.Publish]);
  });

  it("says how a fix ended short: stopped, not built", () => {
    const stopped = view(status([app(GenexAppReview.NotApproved)]), {
      fix: fix({ outcome: GenexReviewChange.FixStopped }),
    });
    assert.equal(stopped?.kind, ReviewCardKind.FixStopped);
    assert.deepEqual(presses(stopped), [ReviewPress.FixAgain]);
    const unbuilt = view(status([app(GenexAppReview.NotApproved)]), {
      fix: fix({ outcome: GenexReviewChange.NotBuilt }),
    });
    assert.equal(unbuilt?.kind, ReviewCardKind.NotBuilt);
    assert.equal(unbuilt?.platform, "mac");
    assert.deepEqual(presses(unbuilt), [ReviewPress.BuildAgain]);
  });
});

describe("an app Genex checks, a person reviews, or players get", () => {
  it("draws the check in the chat with its clock, and leaves it to the dialog's own step bar there", () => {
    const checked = status([app(GenexAppReview.Checking)]);
    const card = view(checked);
    assert.equal(card?.kind, ReviewCardKind.Checking);
    assert.equal(card?.title, "Checking your Mac app");
    assert.deepEqual(card?.lines, ["usually a few minutes"]);
    assert.equal(card?.since, "2026-10-27T14:02:00.000Z");
    assert.equal(view(checked, { place: ReviewPlace.Dialog }), null);
    assert.equal(view(checked, { fix: fix({ outcome: GenexReviewChange.Sent }) })?.title, "Checking your fixes");
  });

  it("says a person at Genex reviews it within a day", () => {
    const card = view(status([app(GenexAppReview.WithPerson)]));
    assert.equal(card?.title, "A person at Genex is reviewing it");
    assert.deepEqual(card?.lines, ["Usually within a day. You'll hear here and by email."]);
  });

  it("celebrates in the chat: first, update, public again, and approved after a request", () => {
    const liveStatus = status([app(GenexAppReview.Live)]);
    assert.equal(view(liveStatus)?.title, "Midnight Asphalt is live!");
    assert.equal(view(liveStatus, { place: ReviewPlace.Dialog }), null);
    const update = view(liveStatus, { latest: { change: GenexReviewChange.Live, update: true } });
    assert.equal(update?.title, "Version 1.3.0 is live");
    assert.deepEqual(update?.lines, ["Mac players get it now."]);
    const back = view(liveStatus, { latest: { change: GenexReviewChange.Restored, requested: true } });
    assert.equal(back?.title, "Midnight Asphalt is public again");
    assert.deepEqual(back?.lines, ["Someone from the Genex team agreed it's fine."]);
    const agreed = view(
      status([app(GenexAppReview.Live, { humanReview: { state: GenexHumanReview.Answered, canRequest: false } })]),
    );
    assert.deepEqual(agreed?.lines, ["Someone from the Genex team agreed it's fine."]);
  });
});

describe("a taken-down game", () => {
  it("is hidden until a person puts it back, with Fix with agent and Request human review", () => {
    const card = view(status([], takedown()));
    assert.equal(card?.kind, ReviewCardKind.TakenDown);
    assert.equal(card?.title, "Taken down: 3 things to fix");
    assert.deepEqual(card?.lines, ["Hidden from players until it's fixed and a person at Genex puts it back."]);
    assert.deepEqual(presses(card), [ReviewPress.Fix, ReviewPress.Request]);
    assert.equal(card?.footer, "After the fix, Studio asks a person at Genex to put it back. Usually within a day.");
  });

  it("never tells apart a takedown that can't be reviewed again", () => {
    const card = view(
      status([], takedown({ appealable: false, things: [], humanReview: { state: "none", canRequest: false } })),
    );
    assert.equal(card?.kind, ReviewCardKind.TakenDownClosed);
    assert.equal(card?.title, "Taken down");
    assert.deepEqual(card?.lines, ["The Genex team is reviewing this game."]);
    assert.deepEqual(presses(card), []);
  });

  it("says a request is open, then quotes a person who kept it down", () => {
    const asked = view(status([], takedown({ humanReview: { state: GenexHumanReview.Requested, canRequest: false } })));
    assert.equal(asked?.kind, ReviewCardKind.TakedownRequested);
    assert.deepEqual(presses(asked), [ReviewPress.Fix]);
    const kept = view(
      status(
        [],
        takedown({
          humanReview: { state: GenexHumanReview.Denied, canRequest: true, reply: "Still sells coins outside Genex." },
        }),
      ),
    );
    assert.equal(kept?.kind, ReviewCardKind.TakedownUpheld);
    assert.equal(kept?.quote, "Still sells coins outside Genex.");
    assert.equal(kept?.footer, "After the fix, Studio asks a person at Genex to look again. Usually within a day.");
    const final = view(status([], takedown({ humanReview: { state: GenexHumanReview.Denied, canRequest: false } })));
    assert.equal(final?.footer, null);
  });

  it("asks a person automatically after a fix of a game with apps, and leaves a web game's publish to the person", () => {
    const apps = view(status([], takedown()), { fix: fix({ kind: GenexFixKind.Takedown }) });
    assert.equal(apps?.link?.link, ReviewLink.DontAsk);
    assert.deepEqual(apps?.after, [
      "Sent to your agent. When it's done, Studio asks a person at Genex to put it back.",
    ]);
    const web = view(status([], takedown()), { fix: fix({ kind: GenexFixKind.Web }) });
    assert.equal(web?.link, null);
    const fixed = view(status([], takedown()), {
      fix: fix({ kind: GenexFixKind.Web, outcome: GenexReviewChange.FixedWeb }),
    });
    assert.equal(fixed?.kind, ReviewCardKind.FixedWeb);
    assert.deepEqual(presses(fixed), [ReviewPress.Publish, ReviewPress.Request]);
  });
});

describe("a review that can't be read now", () => {
  it("keeps the last state with reconnect, or asks to sign in", () => {
    const offline = view(status([], takedown(), { problem: GenexReviewReadProblem.Offline }));
    assert.equal(offline?.kind, ReviewCardKind.Offline);
    assert.deepEqual(offline?.lines, ["Taken down · reconnect to see what to fix"]);
    const signedOut = view(
      status([app(GenexAppReview.NotApproved)], null, { problem: GenexReviewReadProblem.SignedOut }),
    );
    assert.equal(signedOut?.kind, ReviewCardKind.SignedOut);
    assert.deepEqual(presses(signedOut), [ReviewPress.SignIn]);
    assert.equal(
      view(status([app(GenexAppReview.Live)], null, { problem: GenexReviewReadProblem.Offline }))?.kind,
      ReviewCardKind.Live,
    );
  });

  it("draws nothing before Genex said anything", () => {
    assert.equal(view(null), null);
  });
});

describe("the card's words", () => {
  it("never claim seconds, a re-check of public games, or a takedown back without a person", () => {
    const cards = [
      view(status([app(GenexAppReview.NotApproved)])),
      view(status([app(GenexAppReview.Checking)])),
      view(status([app(GenexAppReview.WithPerson)])),
      view(status([app(GenexAppReview.Live)])),
      view(status([], takedown())),
      view(status([], takedown()), { fix: fix({ kind: GenexFixKind.Takedown }) }),
    ];
    for (const card of cards) {
      const said = words(card);
      assert.doesNotMatch(said, /few seconds|\(2s\)|about 2 min/i);
      assert.doesNotMatch(said, /keeps checking|checks public games/i);
    }
    const down = words(view(status([], takedown())));
    assert.doesNotMatch(down, /checks it again and puts it back/i);
  });

  it("say how long a check has taken", () => {
    const at = Date.parse("2026-10-27T14:00:00Z");
    assert.equal(elapsedWords("2026-10-27T14:00:00Z", at + 6000), "6s");
    assert.equal(elapsedWords("2026-10-27T14:00:00Z", at + 65000), "1m 05s");
    assert.equal(elapsedWords("2026-10-27T14:00:00Z", at + 72 * 60000), "1h 12m");
  });

  it("settle into one history line each", () => {
    assert.equal(historyLabel({ change: GenexReviewChange.Live }), "Published");
    assert.equal(historyLabel({ change: GenexReviewChange.Live, update: true }), "Live");
    assert.equal(historyLabel({ change: GenexReviewChange.TakenDown }), "Taken down");
    assert.equal(historyLabel({ change: GenexReviewChange.Restored }), "Public again");
    assert.equal(historyLabel({ change: GenexReviewChange.Requested }), "Human review requested");
    assert.equal(historyLabel({ change: GenexReviewChange.FixStopped }), null);
  });
});
