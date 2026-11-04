import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  afterTurn,
  nextWake,
  NoteKind,
  TurnEnd,
  WAKE_DEBOUNCE_MS,
  WrapCause,
} from "../../src/harness-seed/loop/director/wake-schedule.ts";
import { wakeRecord } from "../../src/harness-seed/loop/director/journal.ts";
import { HOUR_MS, MINUTE_MS } from "../../src/harness-seed/loop/time.ts";
import {
  bookmarkLead,
  chatBookmark,
  continuesChat,
  leadSeat,
} from "../../src/harness-seed/loop/director/lead-session.ts";
import { CHAT_SO_FAR_MESSAGES, chatSoFar } from "../../src/harness-seed/loop/director/lead-session-prompts.ts";

const T0 = Date.UTC(2026, 8, 25, 14, 0, 0);

describe("when the lead is woken (wake-schedule.ts)", () => {
  // Flipped (no clock): the rows for the working time's wrap-up (`WrapCause.Deadline`), the open
  // Loop's turn cap (`TurnEnd.Continue`) and carry-on (`TurnEnd.CarryOn`) and the pass's deadline
  // (`passDeadline`) are gone with them: a Loop has no clock.
  it("W7. a turn that ends rests the lead; the person's Finish or a failed turn starts the one wrap-up", () => {
    const quiet = { ok: true, closed: false, finishRequested: false };
    assert.deepEqual(afterTurn(quiet), { next: TurnEnd.Sleep });
    assert.deepEqual(afterTurn({ ...quiet, closed: true }), { next: TurnEnd.Close });
    assert.deepEqual(afterTurn({ ...quiet, ok: false }), { next: TurnEnd.WrapUp, wrapCause: WrapCause.Failed });
    assert.deepEqual(afterTurn({ ...quiet, finishRequested: true }), {
      next: TurnEnd.WrapUp,
      wrapCause: WrapCause.Finish,
    });
    assert.deepEqual(afterTurn({ ...quiet, finishRequested: true, ok: false }), {
      next: TurnEnd.WrapUp,
      wrapCause: WrapCause.Finish,
    });
  });

  it("W7b (provider lost). a turn a lost provider failed closes the run paused — never the wrap-up that lands a build", () => {
    // A wrap-up after a lost provider would land a build nobody could check.
    const lost = { ok: false, closed: false, providerLost: true, finishRequested: false };
    assert.deepEqual(afterTurn(lost), { next: TurnEnd.Close });
    assert.deepEqual(afterTurn({ ...lost, finishRequested: true }), { next: TurnEnd.Close });
    assert.deepEqual(afterTurn({ ...lost, ok: true }), { next: TurnEnd.Close });
    assert.deepEqual(
      afterTurn({ ...lost, providerLost: false }),
      { next: TurnEnd.WrapUp, wrapCause: WrapCause.Failed },
      "any other failed turn keeps today's wrap-up",
    );
  });

  /** What the waker reads while the lead rests: nobody waiting, nothing untold, asleep since T0. */
  const quietView = { now: T0, untold: [], asleepSince: T0, personWaiting: false };
  const line = (seq: number, at: number, kind: NoteKind) => ({ seq, at, kind });

  it("W8. no clock wakes a resting lead: with nothing untold and nobody waiting, nothing is ever due", () => {
    for (const now of [T0, T0 + HOUR_MS, T0 + 48 * HOUR_MS])
      assert.equal(nextWake({ ...quietView, now }), null, `nothing due ${(now - T0) / HOUR_MS} h on`);
  });

  // Flipped: a wake answered its reasons ("user_message", "news", the line kinds) for a digest's
  // heading and the `director_continued` record; it is a time now, and what wakes the lead is what it reads.
  it("W9. the person's message wakes the lead at once; so does a line that cannot wait; the rest settle first", () => {
    const now = T0 + MINUTE_MS;
    assert.equal(nextWake({ ...quietView, now, personWaiting: true }), now);
    assert.equal(nextWake({ ...quietView, now, untold: [line(1, now, NoteKind.AppCrashed)] }), now);
    const ends = [line(1, now, NoteKind.WorkerEnded), line(2, now + 2_000, NoteKind.WorkerEnded)];
    assert.equal(
      nextWake({ ...quietView, now, untold: ends }),
      now + WAKE_DEBOUNCE_MS,
      "one wake for both, from the first",
    );
    for (const kind of [NoteKind.AppStopping, NoteKind.Folder])
      assert.equal(
        nextWake({ ...quietView, now, untold: [line(1, now, kind)] }),
        null,
        `${kind} is said, never woken for`,
      );
  });

  // Flipped: at most thirty wakes an hour (`MAX_WAKES_PER_HOUR`); the 31st waited for the hour to pass.
  it("W10. no hourly cap: the 31st worker's end in an hour wakes the lead as the first did", () => {
    const at = T0 + 31 * MINUTE_MS;
    const view = { ...quietView, now: at, asleepSince: at, untold: [line(31, at, NoteKind.WorkerEnded)] };
    assert.equal(nextWake(view), at + WAKE_DEBOUNCE_MS);
  });
});

describe("what the journal keeps of the wake loop (journal.ts wakeRecord)", () => {
  /**
   * The run's own record — its clock, its workers, the defects nobody owns, the plan window, the
   * log — is written on every save now (director-journal.test.ts K2); the wake loop's record keeps
   * only the loop's own state, and a Resume takes back the wakes (K5).
   */
  // Flipped: the record also kept the wake loop's kind (`loop: "wake"`), its wakes and when they were
  // (the hourly cap's window), when it last woke and since when it slept, and why the wrap-up started
  // (`wrapCause`); a Resume reads none of them.
  it("J1. the journal keeps the wake loop's own state: the fresh sessions it spent", () => {
    assert.deepEqual(wakeRecord({ freshSessions: 1 }), { freshSessions: 1 });
  });
});

/** A chat's bookmark as a chat turn records it (delegated-turn.ts `bookmarkSession`). */
const bookmarked = (payload: Record<string, unknown>) => ({
  data: { type: "custom", event_type: "contractor_session", payload },
});

describe("one session: whose session the lead is (lead-session.ts)", () => {
  const run = { runId: "run_s", project: "plaza", goal: "a dusk plaza", engine: "claude-code", model: "opus" };

  // Flipped (one session per chat): a lead never keeps a session of its own beside the chat's.
  it("O1. the lead is always the chat's session: it continues it on the lead's engine and game, whatever the model", () => {
    const seat = (events: unknown[]) =>
      leadSeat({ events: events as never, run: run as never, folder: "/games/plaza" });
    const chat = bookmarked({ project: "plaza", engine: "claude-code", sessionId: "chat-1", model: "opus" });
    const rows = [
      { label: "the chat's own session", events: [chat], want: { sessionId: "chat-1" } },
      {
        label: "a bookmark from before one session names no model",
        events: [bookmarked({ project: "plaza", engine: "claude-code", sessionId: "chat-0" })],
        want: { sessionId: "chat-0" },
      },
      {
        label: "no bookmark: a fresh session that becomes the chat's",
        events: [],
        want: { sessionId: null },
      },
      {
        label: "another engine's session: a fresh one on the run's engine becomes the chat's",
        events: [bookmarked({ project: "plaza", engine: "codex", sessionId: "chat-codex", model: null })],
        want: { sessionId: null },
      },
      {
        label: "another model: the same session, the lead's model its model option",
        events: [bookmarked({ project: "plaza", engine: "claude-code", sessionId: "chat-sonnet", model: "sonnet" })],
        want: { sessionId: "chat-sonnet" },
      },
      {
        label: "another game's session",
        events: [bookmarked({ project: "other", engine: "claude-code", sessionId: "chat-other", model: "opus" })],
        want: { sessionId: null },
      },
    ];
    for (const { label, events, want } of rows) {
      const got = seat(events);
      assert.deepEqual({ sessionId: got.sessionId }, want, label);
      assert.equal(got.folder, "/games/plaza", label);
      assert.equal(got.model, "opus", label);
    }
    // The chat's latest session wins, whatever engine an older one was on.
    const other = bookmarked({ project: "plaza", engine: "codex", sessionId: "chat-codex", model: null });
    const latest = chatBookmark([
      bookmarked({ engine: "claude-code", sessionId: "old", model: "opus" }),
      other,
    ] as never);
    assert.equal(latest?.sessionId, "chat-codex");
    assert.equal(continuesChat(latest!, run as never), false, "another engine's session is not continued");
  });

  it("O2. a fresh lead is told the chat's latest messages, clipped, oldest first", () => {
    const lines = Array.from({ length: CHAT_SO_FAR_MESSAGES + 5 }, (_, i) => ({
      role: i % 2 ? "assistant" : "user",
      content: `message ${i}`,
    }));
    const told = chatSoFar(lines);
    assert.match(told, /^THE CHAT SO FAR/);
    assert.ok(!told.includes("message 4\n") && told.includes("message 5"), "only the latest twenty");
    assert.ok(told.indexOf("message 5") < told.indexOf("message 24"), "oldest first");
    assert.match(chatSoFar([{ role: "user", content: "x".repeat(10_000) }]), /x…$/, "a long message is clipped");
    assert.equal(chatSoFar([]), "", "no chat, nothing said");
  });

  it("O3. the lead's session is written to the chat's bookmark only when it changed", async () => {
    const appended: unknown[] = [];
    const ctx = { call: async (_method: string, params: { batch: unknown[] }) => appended.push(...params.batch) };
    const seat = leadSeat({ events: [], run: run as never, folder: "/games/plaza" });
    await bookmarkLead(ctx as never, { threadId: "t", run: run as never, seat }, "lead-1");
    await bookmarkLead(ctx as never, { threadId: "t", run: run as never, seat }, "lead-1");
    assert.deepEqual(appended, [
      {
        type: "custom",
        event_type: "contractor_session",
        payload: { project: "plaza", engine: "claude-code", sessionId: "lead-1" },
      },
    ]);
  });
});

describe("the lost-session allowance across a Resume", () => {
  it("is kept on the journal, so a Resume does not hand a run fresh sessions it already spent", async () => {
    const { wakeRecord, restoredWake } = await import("../../src/harness-seed/loop/director/journal.ts");
    const saved = wakeRecord({ freshSessions: 2 });
    const restored = restoredWake(JSON.parse(JSON.stringify(saved)));
    assert.equal(restored.freshSessions, 2);
  });
});
