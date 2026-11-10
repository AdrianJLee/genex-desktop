/**
 * What Studio makes of the Genex CLI's progress lines (`GENEX_PROGRESS=json`): the lines are
 * taken out of the CLI's error output, anything else stays, and a meter turns them into bytes
 * sent and a smoothed speed.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenexSendStage } from "../../src/shared/genex.ts";
import { createSendMeter, parseProgressLine, progressSplitter } from "../../src/plugins/genex/send-progress.ts";

const line = (o: unknown) => `@genex-progress ${JSON.stringify(o)}`;

describe("a progress line", () => {
  it("is read when it is whole and well formed", () => {
    assert.deepEqual(parseProgressLine(line({ stage: "upload", doneBytes: 5, totalBytes: 10, target: "mac-arm64" })), {
      stage: GenexSendStage.Upload,
      doneBytes: 5,
      totalBytes: 10,
      target: "mac-arm64",
    });
    assert.deepEqual(parseProgressLine(line({ stage: "source-lfs", doneBytes: 0, totalBytes: 0 })), {
      stage: GenexSendStage.SourceLfs,
      doneBytes: 0,
      totalBytes: 0,
    });
  });

  const refused: Array<[string, string]> = [
    ["plain output", "› Uploading 12 files…"],
    ["the prefix mid-line", `note ${line({ stage: "upload", doneBytes: 1, totalBytes: 2 })}`],
    ["broken JSON", "@genex-progress {stage:"],
    ["not an object", "@genex-progress 7"],
    ["null", "@genex-progress null"],
    ["a stage Studio does not know", line({ stage: "teleport", doneBytes: 1, totalBytes: 2 })],
    ["a negative count", line({ stage: "upload", doneBytes: -1, totalBytes: 2 })],
    ["a count that is no number", line({ stage: "upload", doneBytes: "9", totalBytes: 2 })],
    ["an endless count", '@genex-progress {"stage":"upload","doneBytes":1e400,"totalBytes":2}'],
    ["a fractional count", line({ stage: "upload", doneBytes: 1.5, totalBytes: 2 })],
    ["a missing total", line({ stage: "upload", doneBytes: 1 })],
  ];
  for (const [name, text] of refused) {
    it(`is not read from ${name}`, () => assert.equal(parseProgressLine(text), null));
  }

  it("drops a target that is not a short plain name", () => {
    const read = parseProgressLine(line({ stage: "upload", doneBytes: 1, totalBytes: 2, target: "a/../b\n" }));
    assert.deepEqual(read, { stage: GenexSendStage.Upload, doneBytes: 1, totalBytes: 2 });
  });
});

describe("the CLI's error output", () => {
  it("loses its progress lines and keeps the rest, across any chunking", () => {
    const text = `› Hashing\n${line({ stage: "hash", doneBytes: 1, totalBytes: 4 })}\n✗ failed\n${line({
      stage: "upload",
      doneBytes: 2,
      totalBytes: 4,
    })}\ntail with no newline`;
    for (const size of [1, 3, 7, 1000]) {
      const split = progressSplitter();
      let kept = "";
      const seen: number[] = [];
      for (let i = 0; i < text.length; i += size) {
        const out = split.push(text.slice(i, i + size));
        kept += out.text;
        seen.push(...out.events.map((e) => e.doneBytes));
      }
      kept += split.end();
      assert.equal(kept, "› Hashing\n✗ failed\ntail with no newline", `chunks of ${size}`);
      assert.deepEqual(seen, [1, 2], `chunks of ${size}`);
    }
  });

  it("keeps a line that only looks like progress", () => {
    const split = progressSplitter();
    const out = split.push("@genex-progress nope\n");
    assert.equal(out.text + split.end(), "@genex-progress nope\n");
    assert.deepEqual(out.events, []);
  });
});

describe("the meter", () => {
  const upload = (doneBytes: number, totalBytes = 1000) => ({ stage: GenexSendStage.Upload, doneBytes, totalBytes });

  it("has no speed until bytes have moved over time", () => {
    const clock = { at: 1000 };
    const meter = createSendMeter(() => clock.at);
    assert.deepEqual(meter(upload(0)), { stage: "upload", doneBytes: 0, totalBytes: 1000, at: 1000 });
    assert.equal(meter(upload(0)).bytesPerSecond, undefined);
  });

  it("gives the speed over the last ten seconds", () => {
    const clock = { at: 0 };
    const meter = createSendMeter(() => clock.at);
    meter(upload(0, 1_000_000));
    clock.at = 2000;
    assert.equal(meter(upload(200, 1_000_000)).bytesPerSecond, 100);
    clock.at = 20_000;
    // 20 s on: only samples from the last 10 s count, and the nearest older one anchors them.
    assert.equal(meter(upload(2000, 1_000_000)).bytesPerSecond, 100);
    clock.at = 21_000;
    assert.equal(meter(upload(12_000, 1_000_000)).bytesPerSecond, 10_000);
  });

  it("starts over at a new stage or a new app", () => {
    const clock = { at: 0 };
    const meter = createSendMeter(() => clock.at);
    meter(upload(0));
    clock.at = 1000;
    meter(upload(500));
    clock.at = 2000;
    const next = meter({ stage: GenexSendStage.SourceLfs, doneBytes: 900, totalBytes: 1000 });
    assert.equal(next.bytesPerSecond, undefined);
    clock.at = 3000;
    const app = meter({ stage: GenexSendStage.SourceLfs, doneBytes: 950, totalBytes: 1000, target: "windows-x64" });
    assert.equal(app.bytesPerSecond, undefined);
  });
});
