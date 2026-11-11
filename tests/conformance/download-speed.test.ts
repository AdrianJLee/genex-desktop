/**
 * A download's speed as its install line says it: measured from how far the download has come at
 * each moment, smoothed so one fast or slow second does not swing it, with the time left worked
 * out from it. Time is what the caller says it is.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { speedWords } from "../../src/shared/byte-size.ts";
import { etaMsAt, SPEED_SAMPLE_MS, speedAfter, speedMeter } from "../../src/shared/download-speed.ts";

const MB = 1024 ** 2;

describe("a download's speed", () => {
  it("is not known until a sample's time has passed", () => {
    const start = speedMeter(0, 10_000);
    assert.equal(start.bytesPerSecond, null);
    const early = speedAfter(start, 5 * MB, 10_000 + SPEED_SAMPLE_MS - 1);
    assert.equal(early, start, "too soon to measure: nothing changes");
    assert.equal(etaMsAt(early, 100 * MB), null);
  });

  it("is the bytes saved over the time they took", () => {
    const first = speedAfter(speedMeter(0, 0), 20 * MB, SPEED_SAMPLE_MS);
    assert.equal(first.bytesPerSecond, 20 * MB);
    const late = speedAfter(speedMeter(0, 0), 20 * MB, 2 * SPEED_SAMPLE_MS);
    assert.equal(late.bytesPerSecond, 10 * MB, "a late sample counts its whole time");
  });

  it("starts from the bytes a resumed download already had", () => {
    const resumed = speedAfter(speedMeter(500 * MB, 0), 510 * MB, SPEED_SAMPLE_MS);
    assert.equal(resumed.bytesPerSecond, 10 * MB);
  });

  it("moves toward each new second without jumping to it", () => {
    let meter = speedAfter(speedMeter(0, 0), 10 * MB, SPEED_SAMPLE_MS);
    meter = speedAfter(meter, 60 * MB, 2 * SPEED_SAMPLE_MS);
    const after = meter.bytesPerSecond ?? 0;
    assert.ok(after > 10 * MB && after < 50 * MB, `between the old speed and the new second: ${after}`);
    let at = 60 * MB;
    for (let second = 3; second < 40; second++) {
      at += 50 * MB;
      meter = speedAfter(meter, at, second * SPEED_SAMPLE_MS);
    }
    assert.ok(Math.abs((meter.bytesPerSecond ?? 0) - 50 * MB) < MB / 10, "and settles on a steady speed");
  });

  it("falls to nothing when the download stops moving, and never below", () => {
    let meter = speedAfter(speedMeter(0, 0), 10 * MB, SPEED_SAMPLE_MS);
    for (let second = 2; second < 60; second++) meter = speedAfter(meter, 10 * MB, second * SPEED_SAMPLE_MS);
    assert.ok((meter.bytesPerSecond ?? -1) >= 0 && (meter.bytesPerSecond ?? 0) < 1024);
    assert.equal(etaMsAt(meter, 100 * MB), null, "no time left is said for a download that stands still");
    const back = speedAfter(meter, 5 * MB, 61 * SPEED_SAMPLE_MS);
    assert.equal(back.bytesPerSecond, null, "progress that went back starts the measure again");
  });

  it("says the time left at the speed it has", () => {
    const meter = speedAfter(speedMeter(0, 0), 10 * MB, SPEED_SAMPLE_MS);
    assert.equal(etaMsAt(meter, 600 * MB), 60_000);
    assert.equal(etaMsAt(meter, 0), 0);
  });

  it("is said in the unit it reaches", () => {
    assert.equal(speedWords(38 * MB), "38 MB/s");
    assert.equal(speedWords(1.26 * MB), "1.3 MB/s");
    assert.equal(speedWords(900 * 1024), "900 KB/s");
    assert.equal(speedWords(300), "0 KB/s");
  });
});
