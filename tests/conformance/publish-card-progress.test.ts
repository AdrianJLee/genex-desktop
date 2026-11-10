/**
 * A working row of the Publish card while its send says how far it is: a bar a screen reader can
 * read and one line of numbers under the row's status. A row whose send says nothing shows the
 * status and its clock alone, as before. Rendered from the plain renderer build with React's
 * server renderer.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { GenexSendStage } from "../../src/shared/genex.ts";
import { PublishTarget } from "../../src/shared/publish-platforms.ts";
import { type CardRow, CardTone } from "../../src/renderer/panels/plugins/genex/publish-card-view.ts";

async function views() {
  const result = await build({
    stdin: {
      contents: [
        'export { PublishCardRows } from "./src/renderer/panels/plugins/genex/PublishCard.tsx";',
        'export { createElement } from "react";',
        'export { renderToStaticMarkup } from "react-dom/server.edge";',
      ].join("\n"),
      resolveDir: process.cwd(),
      loader: "tsx",
    },
    bundle: true,
    write: false,
    format: "esm",
    jsx: "automatic",
    logLevel: "silent",
    platform: "browser",
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

const GB = 1024 ** 3;
const sending = (target: PublishTarget, name: string, more: Partial<CardRow> = {}): CardRow => ({
  target,
  name,
  tone: CardTone.Working,
  status: "Sending",
  side: null,
  since: new Date(Date.now() - 134_000).toISOString(),
  cloud: false,
  here: false,
  making: false,
  live: false,
  on: true,
  work: null,
  ...more,
});

describe("a working row of the Publish card", () => {
  it("shows a bar and how much went, how fast and how long is left", async () => {
    const { PublishCardRows, createElement, renderToStaticMarkup } = await views();
    const progress = {
      stage: GenexSendStage.Upload,
      doneBytes: Math.round(1.2 * GB),
      totalBytes: Math.round(4.6 * GB),
      at: Date.now(),
      bytesPerSecond: 38 * 1024 ** 2,
      target: "mac-arm64",
    };
    const html: string = renderToStaticMarkup(
      createElement(PublishCardRows, {
        rows: [sending(PublishTarget.Mac, "Mac", { progress }), sending(PublishTarget.Windows, "Windows")],
        switches: new Map(),
        onSwitch: () => {},
      }),
    );
    const [mac = "", windows = ""] = html.split("<li ").slice(1);
    assert.match(mac, /data-send-progress/);
    assert.match(mac, /role="progressbar"[^>]*aria-valuenow="26"/);
    assert.match(mac, /1\.2 GB of 4\.6 GB · 38 MB\/s · about 2 min left/);
    assert.match(mac, /data-publish-platform-clock="mac"/, "the row keeps its clock");
    assert.doesNotMatch(windows, /data-send-progress/, "a row whose send says nothing shows no bar");
  });

  it("names what is going on before the upload, with no bar for a size it does not know", async () => {
    const { PublishCardRows, createElement, renderToStaticMarkup } = await views();
    const progress = { stage: GenexSendStage.Zip, doneBytes: 0, totalBytes: 0, at: Date.now(), target: "mac-arm64" };
    const html: string = renderToStaticMarkup(
      createElement(PublishCardRows, {
        rows: [sending(PublishTarget.Mac, "Mac", { progress })],
        switches: new Map(),
        onSwitch: () => {},
      }),
    );
    assert.match(html, /data-send-progress/);
    assert.match(html, /Packing/);
    assert.doesNotMatch(html, /role="progressbar"/);
  });
});
