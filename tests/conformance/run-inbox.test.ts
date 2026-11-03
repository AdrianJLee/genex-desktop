/**
 * A run's inbox read from the log (`loop/run-inbox.ts`): whether the person asked the run to wrap up,
 * the steers on record, and the chat's messages its lead took and never heard come from the run's
 * durable events, so a resumed session neither honours a wrap-up asked of an earlier session nor
 * loses a message the app quit under. Reading writes nothing: the lead reads the person's words from
 * its line (director/lead-line.ts). Fake `ctx`, no host.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HostMethod } from "../../src/harness-seed/loop/host-methods.ts";
import { conversationThrough, createRunInbox, latestRun } from "../../src/harness-seed/loop/run-inbox.ts";
import type { AnyRecord, HarnessEvent } from "../../src/harness-seed/types/harness.d.ts";

const RUN = "r";
const THREAD = "t";

const custom = (event_type: string, payload: AnyRecord): AnyRecord => ({ type: "custom", event_type, payload });
const steer = (text: string, extra: AnyRecord = {}) => custom("run_steering", { runId: RUN, text, ...extra });
/** A chat message the run's lead took (live chat), as live-chat.ts records it. */
const leadSteer = (text: string, sourceMessageId: string, extra: AnyRecord = {}) =>
  steer(text, { sourceMessageId, how: "lead", ...extra });

/** A run's thread: `events.list` answers after the cursor it is given, `events.append` adds with new ids. */
function fakeLog(initial: AnyRecord[]) {
  const events: HarnessEvent[] = [];
  const append = (...batch: AnyRecord[]) => {
    for (const data of batch) events.push({ id: String(events.length + 1).padStart(6, "0"), data } as HarnessEvent);
  };
  append(...initial);
  const ctx = {
    cancelled: false,
    call: async (method: string, p: AnyRecord) => {
      if (method === HostMethod.EventsAppend) return append(...p.batch);
      if (method !== HostMethod.EventsList) throw new Error(`unexpected ${method}`);
      return p.after ? events.slice(events.findIndex((e) => e.id === p.after) + 1) : [...events];
    },
  };
  return { events, append, ctx };
}

// Flipped: the inbox handed steers over (`run_steering_delivered` stage "next brief"/"now"), once per
// session (`onlyNew`), to the build's brief or one worker (`addressed`, `backlog`); nothing reads them
// so now, and the rows for those hand-overs went with them.
describe("a run's inbox, read from the log", () => {
  it("a resumed session forgets an earlier wrap-up, and reading the steers writes nothing", async () => {
    const log = fakeLog([custom("run_registered", { runId: RUN }), steer("A"), steer("B", { facetId: "boss" })]);
    const first = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.deepEqual(await first.steering(), ["A", "B"]);
    log.append(
      custom("run_control", { runId: RUN, action: "finish" }),
      custom("autopilot_paused", { runId: RUN }),
      steer("C"),
      custom("run_registered", { runId: RUN, resumed: true }),
    );
    const before = log.events.length;
    const second = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.equal(await second.finishing(), false, "the wrap-up was asked of the session before the resume");
    assert.deepEqual(await second.steering(), ["A", "B", "C"]);
    assert.equal(log.events.length, before, "a read appends nothing");
    log.append(custom("run_control", { runId: RUN, action: "finish" }));
    assert.equal(await second.finishing(), true, "a wrap-up asked of this session counts");
  });

  it("the person's own words only: another run's steer and the lead's own to a worker are no instruction", async () => {
    const log = fakeLog([
      steer("Use warm light", { facetId: "light" }),
      custom("run_steering", { runId: "other", text: "Destroy it" }),
      steer("Keep walking peaceful"),
      steer("fix the floating drums", { facetId: "contact", source: "director" }),
    ]);
    const inbox = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.deepEqual(await inbox.steering(), ["Use warm light", "Keep walking peaceful"]);
  });

  it("the messages a lead took and never heard come back for a Resume — never one it heard or the chat answered", async () => {
    const log = fakeLog([
      custom("run_registered", { runId: RUN }),
      leadSteer("is the sky dusk yet?", "m1"),
      custom("run_steering_delivered", { runId: RUN, sourceMessageId: "m1", how: "lead" }),
      leadSteer("then light the lamps", "m2", { attachmentsArtifact: "message_attachments_m2" }),
      leadSteer("and add some fog", "m3"),
      leadSteer("Genex turned the Blender plugin on.", "m4", { from: "genex" }),
      // The chat answered m3 itself: it went back when the lead's line was released.
      custom("coordinator_message_requeued", { messageId: "m3" }),
      // The chat's own `resume_run` is the chat session's words, not a message the lead took.
      steer("then keep going", { sourceMessageId: "m5" }),
    ]);
    const inbox = createRunInbox(log.ctx as never, { threadId: THREAD, runId: RUN });
    assert.deepEqual(await inbox.unheard(), [
      {
        threadId: THREAD,
        messageId: "m2",
        text: "then light the lamps",
        attachmentsArtifact: "message_attachments_m2",
      },
      { threadId: THREAD, messageId: "m4", text: "Genex turned the Blender plugin on.", from: "genex" },
    ]);
  });
});

describe("a run read from the log", () => {
  it("keeps paused and finished identity after an app restart", () => {
    const es = [
      { data: { type: "custom", event_type: "run_started", payload: { runId: "r", project: "village" } } },
      { data: { type: "custom", event_type: "run_finished", payload: { runId: "r" } } },
      { data: { type: "custom", event_type: "autopilot_paused", payload: { runId: "r" } } },
    ];
    assert.equal(latestRun(es as never)?.state, "paused");
    const replaced = [
      ...es,
      { data: { type: "custom", event_type: "run_started", payload: { runId: "empty-replacement" } } },
    ];
    assert.equal(
      latestRun(replaced as never, "r")?.state,
      "paused",
      "the registrar can still address an older saved run",
    );
  });
});

it("future queued messages stay out of an earlier turn prompt", () => {
  const es = [
    { id: "1", data: { type: "messages", messages: [{ role: "user", content: "first" }] } },
    { id: "2", data: { type: "custom", event_type: "coordinator_message_queued", payload: { messageId: "a" } } },
    { id: "3", data: { type: "messages", messages: [{ role: "user", content: "second" }] } },
    { id: "4", data: { type: "custom", event_type: "coordinator_message_queued", payload: { messageId: "b" } } },
  ];
  assert.deepEqual(
    (conversationThrough(es as never, "a") as typeof es).filter((e) => e.data.type === "messages").map((e) => e.id),
    ["1"],
  );
  assert.deepEqual(
    (conversationThrough(es as never, "b") as typeof es).filter((e) => e.data.type === "messages").map((e) => e.id),
    ["1", "3"],
  );
});
