/**
 * A web version on Genex that the game folder no longer holds: an Unreal game whose Mac app was its
 * page until a page of design mockups went out as its "web build". Genex's page plays a web version
 * whenever it holds one, so publishing the apps again changes nothing players see. Publish says
 * when Genex holds one (`hostedWeb`, from the owner read of the game), and Remove takes it off
 * Genex, keeping the apps, so the page shows them again. Genex keeps a web version that is all the
 * game has. The other way round, a web build never takes a page of apps by surprise: Genex refuses
 * one unless the publish carries the person's word (`--replace-native-page`).
 *
 * GenexTools runs against the fixture Genex API on this machine.
 */
import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, describe, it } from "node:test";
import { GenexTools } from "../../src/plugins/genex/adapter.ts";
import { createGenexPlugin } from "../../src/plugins/genex/backend.ts";
import { publishArgs } from "../../src/plugins/genex/publish.ts";
import { MINUTE_MS } from "../../src/shared/duration.ts";
import { GenexAction, GenexPublishPhase, type GenexPublishState, GenexWebRefusal } from "../../src/shared/genex.ts";
import { validateManifest } from "../../src/substrate/plugins/manifest.ts";
import { type GenexFixtureApi, type GenexRequest, startGenexFixtureApi } from "../helpers/genex-fixture-api.ts";
import { tmpDir } from "../helpers/tmp.ts";

const PROJECT = "dust-two";
const SLUG = "dust-two";
const PROJECT_ID = "p-dust";
const MOCKUPS = "c0ffee";
const servers: GenexFixtureApi[] = [];
after(async () => {
  await Promise.all(servers.map((s) => s.close()));
});

/**
 * Genex holding the game with a public web build (`commitSha`) until its web version is taken off;
 * `refuse` answers that take-off with a refusal code instead, `omitCommit` an owner read that names
 * no build at all.
 */
async function genexWith(options: { refuse?: string; omitCommit?: boolean; down?: boolean } = {}) {
  const hosted = { commitSha: MOCKUPS as string | null, stagingCommitSha: MOCKUPS as string | null };
  const requests: GenexRequest[] = [];
  const server = await startGenexFixtureApi((request, reply) => {
    requests.push(request);
    if (request.url === `/api/projects/by-slug/${SLUG}`) {
      if (options.down) return reply.json({ error: "unavailable" }, 503);
      const builds = options.omitCommit ? {} : hosted;
      return reply.json({ project: { id: PROJECT_ID, slug: SLUG, status: "published", ...builds } });
    }
    if (request.url === `/api/games/${PROJECT_ID}/web` && request.method === "DELETE") {
      if (options.refuse) return reply.json({ error: options.refuse }, 409);
      hosted.commitSha = null;
      hosted.stagingCommitSha = null;
      return reply.json({ removed: true, web: false });
    }
  });
  servers.push(server);
  const removals = () => requests.filter((r) => r.method === "DELETE");
  const reads = () => requests.filter((r) => r.url.startsWith("/api/projects/by-slug/"));
  return { server, removals, reads };
}

/** Studio's publish workspace of a game on Genex whose last web publish Studio verified. */
async function tools(api: string, clock = { now: Date.parse("2026-11-03T10:00:00Z") }) {
  const root = await tmpDir("studio-genex-remove-web-");
  let token: string | null = "fixture-token";
  const genex = new GenexTools(path.join(root, "host"), api, {
    credentials: {
      get: async () => token,
      set: async (value) => {
        token = value;
      },
      clear: async () => {
        token = null;
      },
    },
    now: () => clock.now,
  });
  const dir = path.join(genex.root, "publish", PROJECT);
  await mkdir(path.join(dir, ".genex"), { recursive: true });
  await writeFile(
    path.join(dir, ".genex", "project.json"),
    JSON.stringify({ slug: SLUG, id: PROJECT_ID, status: "published" }),
  );
  const state: GenexPublishState = {
    version: 1,
    project: PROJECT,
    connected: true,
    readyDraft: { revision: MOCKUPS, url: `https://genex.games/draft/${SLUG}`, digest: "d1", verifiedAt: "x" },
  };
  await writeFile(path.join(dir, "publish.json"), JSON.stringify(state));
  const saved = async () => JSON.parse(await readFile(path.join(dir, "publish.json"), "utf8")) as GenexPublishState;
  const signOut = () => {
    token = null;
  };
  return { genex, saved, clock, signOut };
}

describe("a web version on Genex the game no longer has", () => {
  it("says Genex plays a web version on the game's page, asking at most once a minute", async () => {
    const { server, reads } = await genexWith();
    const { genex, clock } = await tools(server.url);
    assert.equal((await genex.publishView(PROJECT)).hostedWeb, true);
    assert.equal((await genex.publishView(PROJECT)).hostedWeb, true);
    assert.equal(reads().length, 1, "the dialog's polls do not ask Genex each time");
    clock.now += MINUTE_MS;
    await genex.publishView(PROJECT);
    assert.equal(reads().length, 2, "a minute later Genex is asked again");
  });

  it("knows nothing while Genex can't be asked, names no build, or the account is signed out", async () => {
    const down = await genexWith({ down: true });
    assert.equal("hostedWeb" in (await (await tools(down.server.url)).genex.publishView(PROJECT)), false);
    const silent = await genexWith({ omitCommit: true });
    assert.equal("hostedWeb" in (await (await tools(silent.server.url)).genex.publishView(PROJECT)), false);
    const signedIn = await genexWith();
    const signedOut = await tools(signedIn.server.url);
    signedOut.signOut();
    assert.equal("hostedWeb" in (await signedOut.genex.publishView(PROJECT)), false);
    assert.equal(signedIn.reads().length, 0, "a signed-out Studio asks Genex nothing");
  });

  it("Remove takes the web version off Genex and keeps the apps: the page shows them again", async () => {
    const { server, removals } = await genexWith();
    const { genex, saved } = await tools(server.url);
    assert.equal((await genex.publishView(PROJECT)).hostedWeb, true);
    const after = await genex.publishRemoveWeb(PROJECT);
    assert.deepEqual(
      removals().map((r) => [r.url, r.authorization]),
      [[`/api/games/${PROJECT_ID}/web`, "Bearer fixture-token"]],
    );
    assert.equal(after.hostedWeb, false, "Genex is asked again, not the minute-old answer kept");
    assert.equal((await saved()).readyDraft, undefined, "the draft Studio verified is gone with it");
  });

  it("Genex keeps a web version that is all the game has, and the record keeps its draft", async () => {
    const { server } = await genexWith({ refuse: GenexWebRefusal.NoNativeBuild });
    const { genex, saved } = await tools(server.url);
    await assert.rejects(genex.publishRemoveWeb(PROJECT), /no app on Genex yet/);
    assert.equal((await saved()).readyDraft?.revision, MOCKUPS);
  });

  it("says why Genex kept the web version: a taken-down game's stays, a removal cut short is pressed again", async () => {
    const said: Array<[string, RegExp]> = [
      [GenexWebRefusal.GameTakenDown, /taken down/],
      [GenexWebRefusal.RemovalIncomplete, /Press Remove again/],
    ];
    for (const [code, words] of said) {
      const { server } = await genexWith({ refuse: code });
      await assert.rejects((await tools(server.url)).genex.publishRemoveWeb(PROJECT), words, code);
    }
  });

  it("asks Genex nothing for a game that isn't on Genex or while signed out", async () => {
    const { server, removals } = await genexWith();
    const signedOut = await tools(server.url);
    signedOut.signOut();
    await assert.rejects(signedOut.genex.publishRemoveWeb(PROJECT), /Connect the Genex plugin first/);
    const fresh = await tools(server.url);
    await writeFile(
      path.join(fresh.genex.root, "publish", PROJECT, ".genex", "project.json"),
      JSON.stringify({ slug: SLUG }),
    );
    await assert.rejects(fresh.genex.publishRemoveWeb(PROJECT), /Nothing is online for this game yet/);
    assert.equal(removals().length, 0);
  });

  it("is the Publish dialog's Remove, confirmed in the native dialog before anything is sent", async () => {
    const manifest = validateManifest(
      JSON.parse(await readFile(path.join(process.cwd(), "src/plugins/genex/plugin.json"), "utf8")),
    );
    const declared = manifest.actions.find((a) => a.name === GenexAction.PublishRemoveWeb);
    assert.ok(declared?.confirmation, "taking a page's web version off asks first");
    const { server, removals } = await genexWith();
    const { genex } = await tools(server.url);
    const plugin = await createGenexPlugin(server.url);
    const services: Record<string, unknown> = {
      "storage.root": genex.root,
      "credentials.read": "fixture-token",
      // The host's lease for the call: the signed-in account's token.
      "credentials.session": "fixture-token",
    };
    const ctx = { project: PROJECT, host: async (method: string) => services[method] ?? true };
    const removed = (await plugin.action(GenexAction.PublishRemoveWeb, {}, ctx)) as GenexPublishState;
    assert.equal(removals().length, 1);
    assert.equal(removed.hostedWeb, false);
  });
});

describe("a web build taking the place of a page of apps", () => {
  it("carries the person's word on each step that can make it public, and only those", () => {
    const word = "--replace-native-page";
    const agreed = { title: "Ember Run", replaceNativePage: true };
    assert.deepEqual(publishArgs(GenexPublishPhase.Promoting, agreed), ["promote", word]);
    assert.deepEqual(publishArgs(GenexPublishPhase.Listing, agreed), [
      "publish",
      "--no-push",
      word,
      "--title",
      "Ember Run",
    ]);
    assert.deepEqual(
      publishArgs(GenexPublishPhase.Uploading, agreed),
      ["preview", "--no-build"],
      "a draft takes no page",
    );
    assert.deepEqual(publishArgs(GenexPublishPhase.Promoting, { title: "Ember Run" }), ["promote"], "never assumed");
  });
});
