/**
 * A follow-up sent while the chat works waits below that work: one no turn has taken yet can be sent
 * now (stopping that work), taken back to the composer to edit, or removed; one handed to the
 * running turn reads Sending… and no longer can.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import { build, type Plugin } from "esbuild";
import { rendererBuildOptions } from "../../scripts/renderer-build.mjs";
import { CHAT_WORDS } from "../../src/renderer/words.ts";

/**
 * The bubble reads the chat's file store, which has no snapshot outside a window, so it renders
 * as nothing here: these tests read the line under it.
 */
const bareBubble: Plugin = {
  name: "bare-bubble",
  setup(plugin) {
    plugin.onResolve({ filter: /\/chat\/UserMessage\.tsx$/ }, () => ({ path: "UserMessage", namespace: "bare" }));
    plugin.onLoad({ filter: /.*/, namespace: "bare" }, () => ({
      contents: "export const UserMessage = () => null;",
      loader: "js",
    }));
  },
};

/** The waiting messages and taking one back, as the plain renderer build compiles them, and React's server renderer. */
async function waitingMessages() {
  const result = await build({
    stdin: {
      contents: [
        'export { QueuedMessage, SendingMessage } from "./src/renderer/panels/QueuedMessage.tsx";',
        'export { takeBack } from "./src/renderer/chat/put-back.ts";',
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
    plugins: [bareBubble],
    ...rendererBuildOptions(),
  });
  const code = result.outputFiles[0]?.text ?? "";
  return import(`data:text/javascript;base64,${Buffer.from(code).toString("base64")}`);
}

/** The line under a message: its markup inside the message's own element. */
const lineOf = (markup: string): string => markup.replace(/^<div[^>]*>/, "").replace(/<\/div>$/, "");

/** The line's status: Sending… while the message has nothing better to say. */
const SENDING = new RegExp(`<span role="status">${CHAT_WORDS.sendingMessage}</span>`);
/** Send now takes the status's place: a text button whose name says it stops the work first. */
const SEND_NOW = /<button[^>]*aria-label="Stop and send now"[^>]*>Send now<\/button>/;
const EDIT = /aria-label="Edit queued message"/;
const REMOVE = /aria-label="Remove queued message"/;

test("a waiting follow-up offers Send now in place of Sending…, with Edit and Remove, until a turn takes it, and keeps the line of a message on its way", async () => {
  const { QueuedMessage, SendingMessage, createElement, renderToStaticMarkup } = await waitingMessages();
  const props = {
    threadId: "chat-a",
    messageId: "m1",
    text: "and add rain",
    onNotice: () => {},
    onEdit: async () => {},
    onSendNow: () => {},
  };
  const waiting: string = renderToStaticMarkup(createElement(QueuedMessage, props));
  assert.match(waiting, /^<div data-queued-message="m1"/, "smoke runners still find it by its message");
  assert.doesNotMatch(waiting, /Queued/);
  assert.match(waiting, SEND_NOW, "one no turn took yet can go now, stopping the work it waits for");
  assert.doesNotMatch(waiting, SENDING, "Send now says it is on its way; a Sending… beside it would say it twice");
  assert.match(waiting, EDIT, "one no turn took yet can go back to the composer");
  assert.match(waiting, REMOVE, "one no turn took yet can be withdrawn");
  const nothingToStop: string = renderToStaticMarkup(createElement(QueuedMessage, { ...props, onSendNow: undefined }));
  assert.doesNotMatch(nothingToStop, SEND_NOW, "with no work to stop it is about to go anyway");
  assert.match(nothingToStop, SENDING);
  assert.match(nothingToStop, EDIT);
  assert.match(nothingToStop, REMOVE);
  const handed: string = renderToStaticMarkup(createElement(QueuedMessage, { ...props, sending: true }));
  assert.match(handed, SENDING);
  assert.doesNotMatch(handed, /<button/, "handed to the running turn: nothing to send, edit or withdraw");
  const onItsWay: string = renderToStaticMarkup(createElement(SendingMessage, { text: "and add rain" }));
  assert.equal(lineOf(handed), lineOf(onItsWay), "nothing moves when a message on its way starts to wait");
});

test("a waiting message taken back to edit leaves the queue before its words reach the composer; one a turn already took stays out of it", async () => {
  const { takeBack } = await waitingMessages();
  const message = { threadId: "chat-a", messageId: "m1", text: "and add rain", pickedImages: 1 };
  const calls: string[] = [];
  const api = {
    changeQueuedMessage: async (threadId: string, messageId: string, operation: string) => {
      calls.push(`${operation} ${threadId}/${messageId}`);
    },
  };
  await takeBack(api, message, (back: typeof message) => calls.push(`composer ${back.text} +${back.pickedImages}`));
  assert.deepEqual(calls, ["remove chat-a/m1", "composer and add rain +1"]);

  const started = new Error("This message has already started. Send a follow-up to change it.");
  const putBack: unknown[] = [];
  const refusing = {
    changeQueuedMessage: async () => {
      throw started;
    },
  };
  await assert.rejects(
    takeBack(refusing, message, (back: unknown) => putBack.push(back)),
    started,
  );
  assert.deepEqual(putBack, [], "answered and in the composer at once would send it twice");
});
