/**
 * A CLI run that reports progress: Studio asks for the lines only when someone listens, hands
 * each update on, keeps them out of a failure's words, and counts its time limit from the last
 * byte that moved rather than from the start, so a long send that is still going is never cut.
 *
 * The "CLI" here is a small script standing in for the pinned one: only the run is under test.
 */
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { GenexCliStopped, runGenexCli, type GenexCliRun } from "../../src/plugins/genex/cli.ts";
import type { SendProgressEvent } from "../../src/plugins/genex/send-progress.ts";

/** Writes one progress line every `everyMs`, `count` times, then stays `idleMs` and exits `code`. */
const SCRIPT = `
const [everyMs, count, idleMs, code] = process.argv.slice(2, 6).map(Number);
const asked = process.env.GENEX_PROGRESS === "json";
process.stderr.write("asked=" + asked + "\\n");
let sent = 0;
const tick = () => {
  if (sent >= count) return setTimeout(() => { process.stderr.write("the end\\n"); process.exit(code); }, idleMs);
  sent++;
  process.stderr.write('@genex-progress {"stage":"upload","doneBytes":' + sent + ',"totalBytes":' + count + '}\\n');
  setTimeout(tick, everyMs);
};
tick();
`;

describe("a CLI run that reports progress", () => {
  let root = "";
  const run = (args: number[], more: Partial<GenexCliRun> = {}): Promise<unknown> =>
    runGenexCli({
      cli: path.join(root, "cli.mjs"),
      preload: path.join(root, "preload.mjs"),
      api: "http://127.0.0.1:9",
      token: "synthetic-token",
      cwd: root,
      args: args.map(String),
      signal: undefined,
      timeoutMs: 30_000,
      parse: false,
      home: root,
      ...more,
    });

  before(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), "genex-cli-progress-"));
    await writeFile(path.join(root, "cli.mjs"), SCRIPT);
    await writeFile(path.join(root, "preload.mjs"), "");
  });
  after(() => rm(root, { recursive: true, force: true }));

  it("hands each update on, and a failure's words carry none of them", async () => {
    const seen: SendProgressEvent[] = [];
    const failure = await run([1, 3, 0, 1], { onProgress: (event) => seen.push(event) }).catch((e: Error) => e);
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, "asked=true\nthe end\n");
    assert.deepEqual(
      seen.map((e) => [e.stage, e.doneBytes, e.totalBytes]),
      [
        ["upload", 1, 3],
        ["upload", 2, 3],
        ["upload", 3, 3],
      ],
    );
  });

  it("asks for no progress when nobody listens", async () => {
    const failure = await run([1, 0, 0, 1]).catch((e: Error) => e);
    assert.ok(failure instanceof Error);
    assert.equal(failure.message, "asked=false\nthe end\n");
  });

  it("outlasts its time limit while bytes keep moving", async () => {
    // 12 updates 100 ms apart: 1.2 s of work under a 600 ms limit.
    const seen: number[] = [];
    await run([100, 12, 0, 0], { timeoutMs: 600, onProgress: (event) => seen.push(event.doneBytes) });
    assert.equal(seen.length, 12);
  });

  it("is stopped once nothing has moved for the time limit", async () => {
    const stopped = await run([10, 2, 60_000, 0], { timeoutMs: 400, onProgress: () => {} }).catch((e: Error) => e);
    assert.ok(stopped instanceof GenexCliStopped);
    assert.equal(stopped.timedOut, true);
  });

  it("gets no more time from an update that moves nothing", async () => {
    const script = path.join(root, "stuck.mjs");
    await writeFile(
      script,
      `setInterval(() => process.stderr.write('@genex-progress {"stage":"upload","doneBytes":5,"totalBytes":9}\\n'), 50);`,
    );
    const stopped = await run([], { cli: script, timeoutMs: 400, onProgress: () => {} }).catch((e: Error) => e);
    assert.ok(stopped instanceof GenexCliStopped);
  });
});
