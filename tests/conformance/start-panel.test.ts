/**
 * The card "You asked" opens on Builds: the words the build was asked with and the pictures sent
 * with that message — never pictures the game was given for an earlier build.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { buildRunGraph, type RunNode } from "../../src/renderer/run-graph.ts";
import type { EventEnvelope } from "../../src/shared/event-log.ts";

/** The card as the plain renderer build compiles it, the chat's picture cache, and React's server renderer. */
async function startPanel() {
  const result = await build({
    stdin: {
      contents: [
        'export { StartPanel } from "./src/renderer/panels/inspector/StartPanel.tsx";',
        'export { rememberMessageImages } from "./src/renderer/chat/MessageImages.tsx";',
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

let sequence = 0;
/** One custom record of the chat's thread. */
function record(eventType: string, payload: Record<string, unknown>): EventEnvelope {
  sequence += 1;
  return {
    id: `e${sequence}`,
    thread_id: "chat",
    session_id: null,
    turn_id: null,
    created_at: `2026-11-04T12:${String(sequence).padStart(2, "0")}:00.000Z`,
    data: { type: "custom", event_type: eventType, payload },
  };
}

/** The message's picture, as the chat keeps a sent one. */
const RAIN = { label: "Rain at night", mimeType: "image/png", data: "UkFJTi1QSUNUVVJF" };
/** A picture the game was given for an earlier build, still in its `references/` folder. */
const EARLIER = { label: "castle-from-last-week", src: "data:image/png;base64,Q0FTVExFLVBJQ1RVUkU=" };

test("the card shows the pictures sent with the message the build answers, and no other picture of the game's", async () => {
  const { StartPanel, rememberMessageImages, createElement, renderToStaticMarkup } = await startPanel();
  const graph = buildRunGraph([
    record("coordinator_message_queued", {
      messageId: "m2",
      action: { text: "Make it rain like this", attachmentsArtifact: "message_attachments_m2", imageCount: 1 },
    }),
    record("coordinator_message_processing", { messageId: "m2" }),
    record("run_started", { runId: "run_rain", goal: "Make it rain like this" }),
  ]);
  assert.ok(graph);
  const run = graph.nodes.find((node): node is RunNode => node.kind === "run");
  assert.ok(run?.asked, "the build answers a message that carried a picture");
  rememberMessageImages("chat", "m2", [RAIN]);
  const noop = () => {};
  const markup: string = renderToStaticMarkup(
    createElement(StartPanel, {
      selection: "start",
      graph,
      outcome: null,
      rows: [],
      run,
      base: null,
      blender: null,
      assets: null,
      project: "rainy-game",
      // What the game's `references/` folder answered before: every picture it was ever sent.
      references: [EARLIER],
      baseSrc: null,
      resultSrc: null,
      resultPath: null,
      resultBorrowed: false,
      resultPairsWithBase: false,
      timeline: null,
      onClose: noop,
      onSelect: noop,
      onPrev: noop,
      onNext: noop,
      notesFor: null,
      onLight: noop,
      onOpenJob: noop,
      onReply: null,
      onKeepBuilding: null,
      onNotice: noop,
      onPlay: null,
    }),
  );
  const pictures = [...markup.matchAll(/<img [^>]*src="([^"]*)"/g)].map((match) => match[1]);
  assert.deepEqual(pictures, [`data:${RAIN.mimeType};base64,${RAIN.data}`]);
  assert.match(markup, /Make it rain like this/);
});
