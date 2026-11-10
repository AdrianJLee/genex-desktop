/** What a working row of the publish card says of a send: how much went, how fast, how long is left. */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { GenexSendStage, type GenexSendProgress } from "../../src/shared/genex.ts";
import { sendProgressView } from "../../src/renderer/panels/plugins/genex/send-progress-view.ts";

const GB = 1024 ** 3;
const MB = 1024 ** 2;
const NOW = 1_000_000;
const upload = (more: Partial<GenexSendProgress> = {}): GenexSendProgress => ({
  stage: GenexSendStage.Upload,
  doneBytes: 1.2 * GB,
  totalBytes: 4.6 * GB,
  at: NOW,
  ...more,
});

describe("a send's progress on the publish card", () => {
  it("is nothing without progress", () => {
    assert.equal(sendProgressView(undefined, NOW), null);
  });

  it("says how much went, how fast and how long is left", () => {
    const view = sendProgressView(upload({ bytesPerSecond: 38 * MB }), NOW);
    assert.equal(view?.amounts, "1.2 GB of 4.6 GB · 38 MB/s · about 2 min left");
    assert.equal(view?.label, null);
    assert.ok(view && Math.abs((view.fraction ?? 0) - 1.2 / 4.6) < 1e-9);
  });

  it("rounds the time left to what a person plans by", () => {
    const left = (bytesPerSecond: number) =>
      sendProgressView(upload({ doneBytes: 0, totalBytes: 3600 * MB, bytesPerSecond }), NOW)?.amounts;
    assert.equal(left(100 * MB), "0 bytes of 3.5 GB · 100 MB/s · under a minute left");
    assert.equal(left(MB), "0 bytes of 3.5 GB · 1 MB/s · about 1 h left");
    assert.equal(left(MB / 2), "0 bytes of 3.5 GB · 512 KB/s · about 2 h left");
    assert.equal(left(0.8 * MB), "0 bytes of 3.5 GB · 819.2 KB/s · about 1 h 15 min left");
  });

  it("says only how much went before any speed is known, and once the last reading is old", () => {
    assert.equal(sendProgressView(upload(), NOW)?.amounts, "1.2 GB of 4.6 GB");
    const stale = sendProgressView(upload({ bytesPerSecond: 38 * MB, at: NOW - 60_000 }), NOW);
    assert.equal(stale?.amounts, "1.2 GB of 4.6 GB");
  });

  it("has no bar or total for a size it does not know", () => {
    const view = sendProgressView(upload({ totalBytes: 0, doneBytes: 5 * MB }), NOW);
    assert.equal(view?.fraction, null);
    assert.equal(view?.amounts, "5 MB");
    assert.equal(sendProgressView(upload({ totalBytes: 0, doneBytes: 0 }), NOW)?.amounts, null);
  });

  it("never shows more than the whole", () => {
    assert.equal(sendProgressView(upload({ doneBytes: 9 * GB }), NOW)?.fraction, 1);
  });

  it("names what is going on when it is not the upload itself", () => {
    const stage = (s: GenexSendStage) => sendProgressView(upload({ stage: s }), NOW)?.label;
    assert.equal(stage(GenexSendStage.Zip), "Packing");
    assert.equal(stage(GenexSendStage.Hash), "Checking the archive");
    assert.equal(stage(GenexSendStage.SourceLfs), "Sending the project for Remix");
    assert.equal(stage(GenexSendStage.SourceGit), "Sending the project for Remix");
    assert.equal(stage(GenexSendStage.Upload), null);
    // Packing and the small rest of the source have no byte count worth reading.
    assert.equal(
      sendProgressView(upload({ stage: GenexSendStage.Zip, totalBytes: 0, doneBytes: 0 }), NOW)?.amounts,
      null,
    );
  });
});
