/**
 * Genex's review in the game's chat: each `genex_review` record and Fix with agent press is a card at
 * its own time, never held for the turn it came in; the game's newest is its live card and every older
 * one settles into one line; the same press read again ("Don't publish it automatically") adds no card.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { EntryKind, type GenexReviewEntry, toEntries } from "../../src/renderer/chat-entries.ts";
import { CustomEvent, customEventData } from "../../src/shared/custom-events.ts";
import { type EventData, type EventEnvelope, EventKind } from "../../src/shared/event-log.ts";
import { GenexFixKind, GenexReviewChange } from "../../src/shared/genex-review.ts";

let seq = 0;
const at = (minute: number) => new Date(Date.parse("2026-10-27T14:00:00Z") + minute * 60_000).toISOString();
const event = (data: EventData, minute: number, turn: string | null = null): EventEnvelope => {
  seq += 1;
  return { id: `e${seq}`, thread_id: "t1", session_id: null, turn_id: turn, created_at: at(minute), data };
};
const review = (change: string, minute: number, project = "dust") =>
  event(
    customEventData(CustomEvent.GenexReview, { project, change: change as GenexReviewChange, at: at(minute) }),
    minute,
  );
const fix = (minute: number, autoPublish = true) =>
  event(
    customEventData(CustomEvent.GenexReviewFix, {
      project: "dust",
      fixId: "fix-1",
      kind: GenexFixKind.App,
      count: 3,
      autoPublish,
      at: at(minute),
    }),
    minute,
  );
const reviews = (events: EventEnvelope[]) =>
  toEntries(events).filter((entry): entry is GenexReviewEntry => entry.kind === EntryKind.GenexReview);

describe("Genex's review in the chat", () => {
  it("draws each record at its time, the newest live and the rest as lines", () => {
    const cards = reviews([
      review(GenexReviewChange.Live, 0),
      review(GenexReviewChange.TakenDown, 4),
      fix(20),
      review(GenexReviewChange.Sent, 30),
      review(GenexReviewChange.Restored, 33),
    ]);
    assert.deepEqual(
      cards.map((card) => [card.review?.change ?? "fix", card.latest]),
      [
        [GenexReviewChange.Live, false],
        [GenexReviewChange.TakenDown, false],
        ["fix", false],
        [GenexReviewChange.Sent, false],
        [GenexReviewChange.Restored, true],
      ],
    );
    assert.equal(cards[2]?.fix?.count, 3);
  });

  it("places a card in the middle of a turn, never after it", () => {
    const entries = toEntries([
      event({ type: EventKind.TurnStarted } as EventData, 1, "turn-1"),
      review(GenexReviewChange.NotApproved, 2),
      event(
        { type: EventKind.Messages, messages: [{ role: "assistant", content: "Working on it." }] } as EventData,
        3,
        "turn-1",
      ),
    ]);
    const kinds = entries.map((entry) => entry.kind);
    assert.ok(kinds.indexOf(EntryKind.GenexReview) < kinds.lastIndexOf(EntryKind.Assistant));
  });

  it("adds no card when the same press is read again, and keeps each game's live card its own", () => {
    const cards = reviews([fix(1), fix(2, false), review(GenexReviewChange.NotApproved, 3, "other")]);
    assert.equal(cards.length, 2);
    assert.deepEqual(
      cards.map((card) => [card.project, card.latest]),
      [
        ["dust", true],
        ["other", true],
      ],
    );
  });

  it("reads a record with no payload as a card with nothing in it, never a crash", () => {
    const cards = reviews([event({ type: "custom", event_type: CustomEvent.GenexReview } as EventData, 0)]);
    assert.equal(cards.length, 1);
    assert.equal(cards[0]?.project, undefined);
  });
});
