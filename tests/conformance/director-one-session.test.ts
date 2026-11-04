/**
 * One session through the real core and harness (loop/director/lead-session.ts): a waking run
 * launched from a chat is led by that chat's own contractor session, resumed in the game folder, and
 * the chat goes on in the same session once the run closes, with its hands back and the run's
 * controls (loop/after-loop-run.ts); a Loop it starts after a finished build is a new run, never
 * that build reopened. A session that cannot be resumed is replaced by a fresh one told the chat so
 * far. Flipped (one Loop): the rows of a web game's Loop that led and landed an integration
 * worktree (S1, S1b, S1c, S3's landing, S5, S6) went with it; the one Loop's own suites cover a Loop
 * in its folder (one-loop.test.ts, one-loop-projects.test.ts).
 */
import assert from "node:assert/strict";
import { mkdir, realpath, writeFile } from "node:fs/promises";
import path from "node:path";
import { afterEach, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GENEX_PLUGIN_ID } from "../../src/shared/genex.ts";
import type { DelegateRequest, DelegateResult, LiveToolResult } from "../../src/substrate/engines/types.ts";
import { customEvents, makeFakePreview, startRig, waitForLog, type Rig } from "../helpers/studio-rig.ts";

/** No run here may hang the suite: each is over in well under a minute when it works. */
const RIG_TIMEOUT_MS = 240_000;
/**
 * How long the host's resume of a paused run is held back from the loop in the tests that hold
 * it: the chat's chance to take its next message, or the person's to press Stop, before the run
 * is under way again. The chat itself holds for up to after-loop-run.ts `RESUME_RESERVED_WITHIN_MS`.
 */
const RESUME_HELD_MS = 1_500;
const rigs: Rig[] = [];
afterEach(async () => {
  await Promise.all(rigs.splice(0).map((rig) => rig.stop().catch(() => {})));
});

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const json = (result: LiveToolResult): Record<string, any> => JSON.parse(text(result));

/** Reference stills guide appearance; omitting hours explicitly commissions goal completion. */
const FRAMES = [
  { data: Buffer.from("frame-one").toString("base64"), mimeType: "image/png", label: "dusk 1" },
  { data: Buffer.from("frame-two").toString("base64"), mimeType: "image/png", label: "dusk 2" },
];

/** A worker in its own copy of the integration branch, as a lead starts one: a title and its task. */
const copyWorker = (title: string) => ({ title, task: `Build the ${title}`, isolation: "copy" });

/** The id of the worker a start named (`Started w1 (copy).`). */
const startedId = (answer: string): string => /\bw\d+\b/.exec(answer)?.[0] ?? "";

/** Whether `run_status` says the worker `id` is still at work. */
const stillRunning = (status: Record<string, any>, id: string): boolean =>
  (status.workers as Array<{ id: string; state: string }>).some(
    (worker) => worker.id === id && worker.state === "running",
  );

/** What one delegation was for, read off the request the way the host hands it to an engine. */
const Kind = {
  Chat: "chat",
  Lead: "lead",
  Worker: "worker",
  FollowUp: "follow-up",
  /** The chat's own session after its run: the run's controls ride on its turn. */
  After: "after",
} as const;
type Kind = (typeof Kind)[keyof typeof Kind];
function kindOf(request: DelegateRequest): Kind {
  if (request.director) return Kind.Lead;
  if (request.worker) return Kind.Worker;
  if (request.liveTools?.some((tool) => tool.name === "run_status")) return Kind.After;
  return request.interviewTools?.length ? Kind.Chat : Kind.FollowUp;
}

/**
 * A delegated engine that keeps each session's conversation the way a real one does: a resumed
 * session answers with its own id and remembers every turn it was given. What the script returns
 * joins the result (a bridged tool the session recorded, say).
 */
function sessionEngine(
  rig: Rig,
  id: string,
  script: (request: DelegateRequest, kind: Kind) => Promise<void | Partial<DelegateResult>>,
) {
  const histories = new Map<string, Kind[]>();
  const requests: Array<{ kind: Kind; request: DelegateRequest; sessionId?: string }> = [];
  let minted = 0;
  rig.core.engines.register({
    id,
    label: id,
    kind: "delegated",
    status: async () => ({ code: "ready", detail: "" }),
    models: async () => [],
    complete: async () => ({
      message: { role: "assistant", content: "{}" },
      usage: {},
      model: "fixture",
      engine: id,
      stopReason: "stop",
    }),
    delegate: async (request: DelegateRequest): Promise<DelegateResult> => {
      const kind = kindOf(request);
      const asked: { kind: Kind; request: DelegateRequest; sessionId?: string } = { kind, request };
      requests.push(asked);
      const extra = (await script(request, kind)) ?? {};
      const sessionId = request.resume ?? `${kind}-${++minted}`;
      asked.sessionId = sessionId;
      if (kind !== Kind.Worker) histories.set(sessionId, [...(histories.get(sessionId) ?? []), kind]);
      return {
        ok: true,
        engine: id,
        turns: 1,
        usage: {},
        sessionId,
        summary: `${kind} done`,
        ...(kind === Kind.Chat
          ? { studioToolCalls: [{ name: "start_autopilot", args: { goal: "a dusk plaza", direction: "dusk" } }] }
          : {}),
        ...extra,
      };
    },
  } as never);
  return { histories, requests };
}

/**
 * A game with its chat, on a rig with windows to lend: two are the lead's, the rest its workers'.
 * The Genex plugin is off unless `cover` asks for it: with it on, every landed run is followed by
 * the cover step's turn (core/cover-step.ts), which only the cover's own row is about.
 */
async function gameChat(name: string, windows = 3, { cover = false } = {}) {
  const rig = await startRig(
    { replies: [] },
    { previewPoolMax: windows, createHeadlessPreview: async () => makeFakePreview() },
  );
  rigs.push(rig);
  await rig.core.plugins.setEnabled(GENEX_PLUGIN_ID, cover);
  const project = await rig.core.games.scaffold(name, { title: name });
  const threadId = await rig.core.threadForGame(project.name);
  return { rig, project, threadId };
}

/** The run the chat launched, once it closed. */
async function loopRunClosed(rig: Rig, label: string) {
  const events = await waitForLog(rig.core, (log) => customEvents(log, "run_finished").length >= 1, 150_000, label);
  return customEvents(events, "run_finished")[0]!;
}

/**
 * Send a message in the chat — on `engine`, or naming none — and wait until it is answered: the
 * `handled`th handled message of the thread.
 */
async function answered(
  rig: Rig,
  threadId: string,
  text: string,
  engine: string | null,
  handled: number,
  /** The composer's bubble id, which the host notes as the person's message (a rig send has none). */
  clientId?: string,
) {
  await rig.core.sendUserMessage(text, {
    thread: threadId,
    ...(engine ? { engine } : {}),
    ...(clientId ? { clientId } : {}),
  });
  return handledUpTo(rig, threadId, handled, text);
}

/** Send a message with pictures on `engine`, and wait until it is answered: the `handled`th of the thread. */
async function answeredWithPictures(rig: Rig, threadId: string, text: string, engine: string, handled: number) {
  await rig.core.sendUserMessage(text, { thread: threadId, engine, frames: FRAMES });
  return handledUpTo(rig, threadId, handled, text);
}

/** The thread's log once it has handled `handled` messages, the last the answer to `text`. */
function handledUpTo(rig: Rig, threadId: string, handled: number, text: string) {
  return waitForLog(
    rig.core,
    (log) =>
      customEvents(
        log.filter((e) => e.thread_id === threadId),
        "coordinator_message_handled",
      ).length >= handled,
    60_000,
    `the chat's answer to "${text}"`,
  );
}

/** The studio tools a request was offered to record (bridged in), by name. */
const offeredTools = (request: DelegateRequest): string[] => (request.interviewTools ?? []).map((tool) => tool.name);

/**
 * Hold the host's resume of a paused run back from the loop until `release`, as a slow journal
 * read or a learning pass still being waited out would.
 */
function holdResumes(rig: Rig): { release: () => void } {
  let release: () => void = () => {};
  const held = new Promise<void>((resolve) => {
    release = resolve;
  });
  const dispatch = rig.core.host.dispatch.bind(rig.core.host);
  rig.core.host.dispatch = (async (action, timeoutMs) => {
    if (action.type === "autopilot_resume") await held;
    return dispatch(action, timeoutMs);
  }) as typeof rig.core.host.dispatch;
  return { release };
}

/** The chat's bookmark in the thread's record: the session its next message resumes. */
async function chatBookmark(rig: Rig, threadId: string): Promise<string | undefined> {
  const record = await rig.core.store.getRecord(threadId);
  return (record.metadata as { contractor?: { sessionId?: string } } | undefined)?.contractor?.sessionId;
}

describe("a lead whose chat session cannot be resumed", () => {
  it("S2. starts fresh in the game folder with the chat so far, the brief and the digest, and becomes the chat's session", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, project, threadId } = await gameChat("one-session-lost");
    const prompts: string[] = [];
    let leadTurns = 0;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind !== Kind.Lead) return;
      prompts.push(request.prompt);
      const chatSession = requests.find((r) => r.kind === Kind.Chat)?.sessionId;
      if (request.resume && request.resume === chatSession)
        throw new Error(`No conversation found with session ID: ${chatSession}`);
      leadTurns += 1;
      if (leadTurns === 1) await call("finish", { summary: "nothing to build this run", land: "no" });
    });

    await rig.core.sendUserMessage("make a dusk plaza with a fountain", {
      thread: threadId,
      engine,
      frames: FRAMES,
    });
    await loopRunClosed(rig, "the run's close");

    const lead = requests.filter((r) => r.kind === Kind.Lead).map((r) => r.request);
    assert.equal(
      lead[0]!.resume,
      requests.find((r) => r.kind === Kind.Chat)!.sessionId,
      "the chat's session is tried first",
    );
    assert.equal(lead[1]!.resume, undefined, "then a fresh one");
    assert.equal(await realpath(lead[1]!.cwd), await realpath(project.dir), "in the game folder too");
    // Flipped: the fresh session's prompt was the chat so far glued before the brief (YOU LEAD THIS LOOP,
    // THE GOAL); its prompt is the turn's own message, the chat so far a notice of Genex's beside it.
    assert.equal(prompts[1], prompts[0], "the same message, in a fresh session");
    const told = (lead[1]!.notices ?? []).join("\n");
    const at = ["THE CHAT SO FAR", "make a dusk plaza with a fountain"].map((mark) => told.indexOf(mark));
    assert.ok(
      at.every((i, n) => i >= 0 && (n === 0 || i > at[n - 1]!)),
      `in order: ${JSON.stringify(at)}\n${told.slice(0, 2_000)}`,
    );
    // The fresh session's turn ends after the close it called: the chat's bookmark follows that
    // turn, so wait for it rather than read the bookmark the moment the run closed.
    const freshLead = () => requests.filter((r) => r.kind === Kind.Lead)[1]?.sessionId;
    await waitForLog(rig.core, () => Boolean(freshLead()), 15_000, "the fresh session's turn to end");
    const freshSession = freshLead();
    // The harness's view of the chat says the same (its bookmark follows the turn that answered).
    const events = await waitForLog(
      rig.core,
      (log) => customEvents(log, "contractor_session").some((e) => e.sessionId === freshSession),
      15_000,
      "the fresh session on the chat's bookmark",
    );
    assert.equal(await chatBookmark(rig, threadId), freshSession, "the chat goes on in the fresh session");
    const bookmarks = customEvents(events, "contractor_session").map((e) => e.sessionId);
    assert.equal(bookmarks.at(-1), freshSession, JSON.stringify(bookmarks));
  });
});

describe("the same agent after the build", () => {
  it("S7. after a paused run a question is answered in place, and 'continue with…' resumes the run with the same session as its lead", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, threadId } = await gameChat("after-run-resume");
    const results: Record<string, any> = {};
    const leadPrompts: string[] = [];
    let workerStarted = false;
    const { requests, histories } = sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadPrompts.push(request.prompt);
        if (leadPrompts.length === 1) {
          await call("worker_start", copyWorker("moon"));
          return;
        }
        results.resumedFinish = text(await call("finish", { summary: "a red moon", land: "no" }));
        return;
      }
      if (kind === Kind.Worker) {
        // Building until the user stops the run.
        workerStarted = true;
        await new Promise<void>((resolve) => {
          if (request.signal?.aborted) resolve();
          else request.signal?.addEventListener("abort", () => resolve(), { once: true });
        });
        return;
      }
      if (kind !== Kind.After) return;
      results.offered = (request.interviewTools ?? []).map((tool) => tool.name);
      if (request.prompt.includes("is the moon red yet")) {
        results.status = json(await call("run_status", {}));
        return;
      }
      if (request.prompt.includes("continue with a red moon"))
        return { studioToolCalls: [{ name: "resume_run", args: { text: "continue with a red moon" } }] };
    });

    await rig.core.sendUserMessage("make a moonlit plaza", {
      thread: threadId,
      engine,
      frames: FRAMES,
    });
    await waitForLog(rig.core, () => workerStarted, 120_000, "the run's worker to start");
    await rig.core.stopThread(threadId);
    await waitForLog(rig.core, (log) => customEvents(log, "autopilot_paused").length >= 1, 60_000, "the paused run");
    const chatSession = requests.find((r) => r.kind === Kind.Chat)!.sessionId!;

    // A question alone never restarts the build.
    await answered(rig, threadId, "is the moon red yet?", engine, 2);
    assert.equal(results.status.run.state, "paused", JSON.stringify(results.status.run));
    // Named flip: a new Loop's start, for one asked in words, sits beside the resume.
    assert.deepEqual(results.offered, ["start_autopilot", "resume_run"], "a paused run can be resumed from the chat");
    let log = await rig.core.store.listEvents(threadId);
    assert.equal(customEvents(log, "run_registered").length, 1, "the question resumed nothing");
    assert.equal(leadPrompts.length, 1);

    // An instruction to go on resumes the run; its lead is this same session again.
    await answered(rig, threadId, "continue with a red moon", engine, 3);
    log = await waitForLog(
      rig.core,
      (events) => customEvents(events, "run_finished").length >= 2,
      120_000,
      "the resumed run's close",
    );
    const leads = requests.filter((r) => r.kind === Kind.Lead);
    assert.equal(leads.length, 2, requests.map((r) => r.kind).join(", "));
    assert.equal(leads[1]!.request.resume, chatSession, "the resumed run's lead is the chat's own session");
    // Flipped: the resumed lead was told "continue with a red moon" under THE USER SAYS; the chat's own
    // session wrote it into resume_run, and that session is the lead: it opens with Genex's line.
    assert.match(leadPrompts[1]!, /^The Loop resumed after a pause/);
    assert.ok(
      customEvents(log, "run_steering").some((e) => e.text === "continue with a red moon"),
      "the instruction is saved on the run before it resumes",
    );
    assert.equal(customEvents(log, "run_registered").length, 2, "the same run, registered again by its resume");
    assert.equal(new Set(customEvents(log, "run_registered").map((e) => e.runId)).size, 1, "never a second run");
    // The run closes inside the resumed lead's `finish` call: its turn returns just after.
    const whole = [Kind.Chat, Kind.Lead, Kind.After, Kind.After, Kind.Lead];
    for (let waited = 0; (histories.get(chatSession)?.length ?? 0) < whole.length && waited < 600; waited++)
      await sleep(25);
    assert.deepEqual(histories.get(chatSession), whole);
  });
});

/** A paused run's lead and worker, as S7 scripts them: the worker builds until Stop, the resumed lead finishes. */
function pausedLoopRun(leadPrompts: string[], started: { worker: boolean }) {
  return async (request: DelegateRequest, kind: Kind) => {
    const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
    if (kind === Kind.Lead) {
      leadPrompts.push(request.prompt);
      if (leadPrompts.length === 1) {
        await call("worker_start", copyWorker("moon"));
        return;
      }
      await call("finish", { summary: "a red moon", land: "no" });
      return;
    }
    if (kind === Kind.Worker) {
      started.worker = true;
      await new Promise<void>((resolve) => {
        if (request.signal?.aborted) resolve();
        else request.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
    }
  };
}

/** Launch a run from the chat and pause it with Stop once its worker builds. */
async function launchAndPause(rig: Rig, threadId: string, engine: string, started: { worker: boolean }) {
  await rig.core.sendUserMessage("make a moonlit plaza", {
    thread: threadId,
    engine,
    frames: FRAMES,
  });
  await waitForLog(rig.core, () => started.worker, 120_000, "the run's worker to start");
  await rig.core.stopThread(threadId);
  await waitForLog(rig.core, (log) => customEvents(log, "autopilot_paused").length >= 1, 60_000, "the paused run");
}

/** The resume the chat's own session records, as the session's result carries it. */
const recordedResume = (text: string) => ({ studioToolCalls: [{ name: "resume_run", args: { text } }] });

/** The live tools a scripted turn calls, as the host handed them over. */
function liveCall(request: DelegateRequest) {
  const onLiveTool = request.onLiveTool;
  if (!onLiveTool) throw new Error(`no live tools on this ${kindOf(request)} turn`);
  return (name: string, args: Record<string, unknown>) => onLiveTool(name, args);
}

/**
 * A run that builds `part` with one worker and lands it, as S1 scripts it: its lead starts the
 * worker, then merges its copy and finishes once the worker is done.
 */
function landingLoopRun(part: string, onStatus: (status: Record<string, any>) => void = () => {}) {
  let turns = 0;
  let finished = false;
  let worker = "";
  return async (request: DelegateRequest): Promise<void> => {
    const call = liveCall(request);
    turns += 1;
    if (turns === 1) {
      worker = startedId(text(await call("worker_start", copyWorker(part))));
      return;
    }
    const status = json(await call("run_status", {}));
    if (finished || stillRunning(status, worker)) return;
    onStatus(status);
    finished = true;
    await call("worker_mark", { id: worker, verdict: "used" });
    await call("finish", { summary: `the ${part}`, land: "yes" });
  };
}

/** A worker that writes its part: `src/<id>.js`. */
async function writePart(request: DelegateRequest, id: string): Promise<void> {
  await mkdir(path.join(request.cwd, "src"), { recursive: true });
  await writeFile(path.join(request.cwd, "src", `${id}.js`), `export const ${id} = true;\n`);
}

/** The dusk plaza the chat launches on `engine`, once its run has closed. */
async function launchedAndClosed(rig: Rig, threadId: string, engine: string) {
  await rig.core.sendUserMessage("make a dusk plaza", {
    thread: threadId,
    engine,
    frames: FRAMES,
  });
  return loopRunClosed(rig, "the launched run's close");
}

/** The log once `count` runs have closed. */
function loopRunsClosed(rig: Rig, count: number, label: string) {
  return waitForLog(rig.core, (events) => customEvents(events, "run_finished").length >= count, 150_000, label);
}

/** The kinds of this chat's turns no build of its own should open: a builder follow-up. */
const strangers = (requests: ReadonlyArray<{ kind: Kind }>): Kind[] =>
  requests.filter((r) => r.kind === Kind.FollowUp).map((r) => r.kind);

describe("the same agent after the build: the resume it asks for, and the session it is", () => {
  it("S8. a message sent while the chat's own session asks to resume waits for the resumed run, never answered as after a paused run again; a reply that ended early resumes anyway, and says so", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, threadId } = await gameChat("after-run-resuming");
    const leadPrompts: string[] = [];
    const started = { worker: false };
    const loopRun = pausedLoopRun(leadPrompts, started);
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind !== Kind.After) return loopRun(request, kind);
      if (!request.prompt.includes("continue with a red moon")) return;
      // The person sends another message while this reply is still being written; it reaches the
      // reply (the host interrupts it) and waits again once the reply ends.
      await rig.core.sendUserMessage("and make the moon big", { thread: threadId, engine });
      await Promise.race([
        new Promise((resolve) => request.signal?.addEventListener("abort", resolve, { once: true })),
        waitForLog(rig.core, () => false, 5_000).catch(() => null),
      ]);
      return {
        ...recordedResume("continue with a red moon"),
        ok: false,
        stopReason: "error",
        errorText: "the session hit its deadline",
      };
    });
    await launchAndPause(rig, threadId, engine, started);
    const chatSession = requests.find((r) => r.kind === Kind.Chat)!.sessionId!;

    const { release } = holdResumes(rig);
    await rig.core.sendUserMessage("continue with a red moon", { thread: threadId, engine });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_steering").some((e) => e.text === "continue with a red moon"),
      60_000,
      "the resume the chat asked for",
    );
    const answeredWhilePaused = () =>
      requests.filter(
        (r) =>
          r.kind === Kind.After &&
          r.request.prompt.includes("make the moon big") &&
          (r.request.interviewTools ?? []).some((tool) => tool.name === "resume_run"),
      );
    // Before the resumed run is under way again, the chat has every chance to take the message.
    await waitForLog(rig.core, () => answeredWhilePaused().length > 0, RESUME_HELD_MS).catch(() => null);
    release();

    let log = await waitForLog(
      rig.core,
      (events) => customEvents(events, "run_finished").length >= 2,
      120_000,
      "the resumed run's close",
    );
    const bigId = customEvents(log, "coordinator_message_queued").find(
      (e) => (e.action as { text?: string } | undefined)?.text === "and make the moon big",
    )?.messageId;
    // It reaches the resumed run's lead, or is answered once that run has closed.
    log = await waitForLog(
      rig.core,
      (events) =>
        customEvents(events, "coordinator_message_handled").some((e) => e.messageId === bigId) ||
        customEvents(events, "coordinator_message_delivered").some((e) => e.messageId === bigId && e.how === "lead"),
      60_000,
      "the message sent during the resuming reply, settled",
    );
    const said = (await rig.core.store.listMessages(threadId)).map((m) => String(m.content ?? ""));
    assert.deepEqual(
      {
        answeredWhilePaused: answeredWhilePaused().length,
        toldItEndedEarly: said.some((m) =>
          /ended early \(error: the session hit its deadline\).*resuming it anyway/.test(m),
        ),
      },
      { answeredWhilePaused: 0, toldItEndedEarly: true },
    );
    const leads = requests.filter((r) => r.kind === Kind.Lead);
    assert.equal(leads.length, 2, requests.map((r) => r.kind).join(", "));
    assert.equal(leads[1]!.request.resume, chatSession, "the resumed run's lead is the chat's own session");
    assert.equal(customEvents(log, "run_registered").length, 2, "resumed once");
    assert.equal(new Set(customEvents(log, "run_registered").map((e) => e.runId)).size, 1, "never a second run");
  });

  it("S9. Stop after the resuming reply, before the run is under way again: it stays paused, and the chat is told", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "claude-code";
    const { rig, threadId } = await gameChat("after-run-stopped-resume");
    const leadPrompts: string[] = [];
    const started = { worker: false };
    const loopRun = pausedLoopRun(leadPrompts, started);
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind !== Kind.After) return loopRun(request, kind);
      if (request.prompt.includes("continue with a red moon")) return recordedResume("continue with a red moon");
    });
    await launchAndPause(rig, threadId, engine, started);

    const { release } = holdResumes(rig);
    await rig.core.sendUserMessage("continue with a red moon", { thread: threadId, engine });
    await waitForLog(
      rig.core,
      (log) => customEvents(log, "run_steering").some((e) => e.text === "continue with a red moon"),
      60_000,
      "the resume the chat asked for",
    );
    await rig.core.stopThread(threadId);
    release();

    const notResumed = (events: Awaited<ReturnType<typeof rig.core.listAllEvents>>) =>
      events.some(
        (e) =>
          e.thread_id === threadId &&
          e.data.type === "error" &&
          /The build was not resumed: Stop came before it started again/.test(e.data.message),
      );
    const log = await waitForLog(
      rig.core,
      (events) => customEvents(events, "run_registered").length >= 2 || notResumed(events),
      60_000,
      "the resume, started or held back",
    );
    assert.deepEqual(
      { registered: customEvents(log, "run_registered").length, told: notResumed(log) },
      { registered: 1, told: true },
      "the run did not start again after the Stop",
    );
    assert.equal(requests.filter((r) => r.kind === Kind.Lead).length, 1, "no lead turn after the Stop");
  });

  it("S10. a message that names no engine goes on on the lead's engine, in the same session; one on another engine is the chat's own session there, with the run's controls", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, threadId } = await gameChat("after-run-engines");
    let leadTurns = 0;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      const call = (name: string, args: Record<string, unknown>) => request.onLiveTool!(name, args);
      if (kind === Kind.Lead) {
        leadTurns += 1;
        if (leadTurns === 1) {
          await call("worker_start", copyWorker("sky"));
          return;
        }
        if (stillRunning(json(await call("run_status", {})), "w1")) return;
        await call("worker_mark", { id: "w1", verdict: "used" });
        await call("finish", { summary: "a dusk sky", land: "yes" });
        return;
      }
      if (kind === Kind.Worker) {
        await mkdir(path.join(request.cwd, "src"), { recursive: true });
        await writeFile(path.join(request.cwd, "src", "sky.js"), "export const sky = 'dusk';\n");
      }
    });
    const other = sessionEngine(rig, "claude-code", async () => {});
    await rig.core.sendUserMessage("make a dusk plaza", {
      thread: threadId,
      engine,
      frames: FRAMES,
    });
    await loopRunClosed(rig, "the codex run's close");
    const chatSession = requests.find((r) => r.kind === Kind.Chat)!.sessionId;

    // No engine named: the lead's engine, its own session, with the run's controls.
    await answered(rig, threadId, "why dusk?", null, 2);
    const onTheLeadsEngine = requests
      .filter((r) => r.kind === Kind.After)
      .map((r) => ({ resume: r.request.resume, asked: r.request.prompt.includes("why dusk?") }));
    const elsewhereFirst = other.requests.map((r) => r.kind);
    // Another engine is another session: the chat's own there answers with the run's controls, and the lead's is not asked.
    await answered(rig, threadId, "and why a plaza?", "claude-code", 3);
    assert.deepEqual(
      {
        onTheLeadsEngine,
        elsewhereFirst,
        onAnotherEngine: other.requests.map((r) => r.kind),
        leadsSessionAsked: requests.filter((r) => r.kind === Kind.After).length,
      },
      {
        onTheLeadsEngine: [{ resume: chatSession, asked: true }],
        elsewhereFirst: [],
        onAnotherEngine: [Kind.After],
        leadsSessionAsked: 1,
      },
    );
  });
});

/** What the chat's own session is offered after a finished build it led: the Loop's start, never a reopen. */
const AFTER_FINISHED_OFFERED = ["start_autopilot"];

describe("the same agent after the build: a new Loop or a question", () => {
  it("S12. a Loop the session starts after a finished build is a new build: another run, never the finished one reopened", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, threadId } = await gameChat("after-run-start-over");
    const first = landingLoopRun("sky");
    let offered: string[] | null = null;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind === Kind.Lead && offered) {
        await liveCall(request)("finish", { summary: "a neon city", land: "no" });
        return;
      }
      if (kind === Kind.Lead) return first(request);
      if (kind === Kind.Worker) return writePart(request, "sky");
      if (kind !== Kind.After || !request.prompt.includes("start over")) return;
      offered = offeredTools(request);
      return { studioToolCalls: [{ name: "start_autopilot", args: { goal: "a neon city", direction: "neon" } }] };
    });
    await launchedAndClosed(rig, threadId, engine);

    await answeredWithPictures(rig, threadId, "start over, a neon city", engine, 2);
    assert.deepEqual(offered, AFTER_FINISHED_OFFERED);
    const log = await loopRunsClosed(rig, 2, "the new build's close");
    const registered = customEvents(log, "run_registered");
    assert.deepEqual(
      {
        runs: new Set(registered.map((e) => e.runId)).size,
        goals: registered.map((e) => e.goal),
        resumed: registered.map((e) => e.resumed),
      },
      { runs: 2, goals: ["a dusk plaza", "a neon city"], resumed: [false, false] },
      "a new run of its own, started afresh",
    );
    assert.deepEqual(strangers(requests), []);
  });

  it("S13. a question after a finished build is answered by the chat's own session: nothing starts again", {
    timeout: RIG_TIMEOUT_MS,
  }, async () => {
    const engine = "codex";
    const { rig, threadId } = await gameChat("after-run-question-on-loop");
    const first = landingLoopRun("sky");
    let offered: string[] | null = null;
    const { requests } = sessionEngine(rig, engine, async (request, kind) => {
      if (kind === Kind.Lead) return first(request);
      if (kind === Kind.Worker) return writePart(request, "sky");
      if (kind === Kind.After) offered = offeredTools(request);
    });
    await launchedAndClosed(rig, threadId, engine);
    const chatSession = requests.find((r) => r.kind === Kind.Chat)?.sessionId;

    const log = await answeredWithPictures(rig, threadId, "why dusk?", engine, 2);
    assert.deepEqual(
      {
        offered,
        answeredBy: requests.filter((r) => r.kind === Kind.After).map((r) => r.request.resume),
        steered: customEvents(log, "run_steering").length,
        registered: customEvents(log, "run_registered").length,
        leads: requests.filter((r) => r.kind === Kind.Lead && r.request.prompt.includes("why dusk?")).length,
      },
      { offered: AFTER_FINISHED_OFFERED, answeredBy: [chatSession], steered: 0, registered: 1, leads: 0 },
      "answered by the chat's own session, and the build stays finished",
    );
  });
});
