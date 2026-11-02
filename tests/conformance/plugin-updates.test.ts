/**
 * Plugin updates as the renderer holds them (src/renderer/state/plugins.ts): which installed
 * plugins have a newer version waiting, the call that installs each, Update plugins (which installs
 * them all, one after another) and how the studio keeps the plugin index current. Driven through a
 * fake `StudioApi` in Node, no window.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  PluginHealth,
  type PluginIndexView,
  type PluginInfo,
  type PluginManifest,
  PluginSourceKind,
} from "../../src/shared/plugins.ts";
import {
  chosenUpdates,
  createPluginsStore,
  installPluginUpdate,
  PLUGIN_INDEX_POLL_MS,
  pluginUpdates,
  updateKey,
} from "../../src/renderer/state/plugins.ts";
import { createStudio, type StudioTimers } from "../../src/renderer/state/studio.ts";
import type { VisibilitySource } from "../../src/renderer/state/visibility.ts";
import { fakeStudioApi } from "../helpers/fake-studio-api.ts";

const tick = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

const plugin = (id: string, over: Partial<PluginInfo> = {}): PluginInfo => ({
  manifest: { id, name: id, version: "1.0.0" } as PluginManifest,
  source: PluginSourceKind.Bundled,
  enabled: true,
  removed: false,
  health: PluginHealth.Idle,
  state: "enabled",
  ...over,
});

/** The index as main answers it, offering these newer releases. */
const index = (...releases: Array<[id: string, version: string]>): PluginIndexView => ({
  url: "https://plugins.example.invalid/index.json",
  studioVersion: "0.1.0",
  fetchedAt: 1,
  stale: false,
  entries: [],
  updates: releases.map(([id, version]) => ({ id, installedVersion: "1.0.0", version, sha: "a".repeat(40) })),
});

/** What a list of updates offers, as `id version` lines. */
const offered = (list: PluginInfo[], view: PluginIndexView | null): string[] =>
  pluginUpdates(list, view).map((update) => `${update.plugin.manifest.id} ${update.version}`);

/** Intervals a test fires by hand. */
function manualIntervals(): StudioTimers & { fire(ms: number): void } {
  const intervals = new Map<number, { run: () => void; ms: number }>();
  let next = 0;
  return {
    setInterval: (run, ms) => {
      intervals.set(++next, { run, ms });
      return next;
    },
    clearInterval: (handle) => void intervals.delete(handle as number),
    setTimeout: () => 0,
    fire(ms) {
      for (const timer of [...intervals.values()]) if (timer.ms === ms) timer.run();
    },
  };
}

describe("which installed plugins have an update waiting", () => {
  it("offers the index's newer releases, in the installed order", () => {
    const list = [plugin("genex"), plugin("blender", { source: PluginSourceKind.Index }), plugin("current")];
    assert.deepEqual(offered(list, index(["blender", "2.0.0"], ["genex", "1.5.0"])), ["genex 1.5.0", "blender 2.0.0"]);
    assert.deepEqual(offered(list, null), [], "nothing is offered before the index answers");
    assert.deepEqual(offered([plugin("current")], index()), []);
  });

  it("offers nothing a person cannot take: one already waiting for sessions, a removed plugin, code not allowed", () => {
    const view = index(["waiting", "2.0.0"], ["gone", "2.0.0"], ["found", "2.0.0"], ["absent", "2.0.0"]);
    const list = [
      plugin("waiting", { pendingVersion: "2.0.0" }),
      plugin("gone", { removed: true }),
      plugin("found", { unlisted: true }),
    ];
    assert.deepEqual(offered(list, view), [], "and a release for a plugin that is not installed is no update");
  });
});

describe("choosing which updates to take", () => {
  it("keeps every update but the unticked ones, and offers a newer release of an unticked plugin again", () => {
    const list = [plugin("blender"), plugin("genex")];
    const [blender, genex] = pluginUpdates(list, index(["blender", "2.0.0"], ["genex", "1.5.0"]));
    assert.ok(blender && genex);
    const skipped = new Set([updateKey(blender)]);
    assert.deepEqual(
      chosenUpdates([blender, genex], skipped).map((update) => update.plugin.manifest.id),
      ["genex"],
    );
    const [newer] = pluginUpdates(list, index(["blender", "2.1.0"]));
    assert.ok(newer);
    assert.deepEqual(chosenUpdates([newer], skipped), [newer], "2.1.0 was never unticked");
  });
});

describe("installing a plugin's update", () => {
  it("installs an index release through update", async () => {
    const fake = fakeStudioApi();
    const [release] = pluginUpdates([plugin("genex"), plugin("blender")], index(["blender", "2.0.0"]));
    assert.ok(release);
    await installPluginUpdate(fake.api, release);
    assert.deepEqual(
      fake.calls.map((call) => [call.method, ...call.args]),
      [["pluginUpdate", "blender"]],
    );
  });
});

describe("Update plugins: every waiting update, one after another", () => {
  /** A store that has read two plugins with an update each. */
  async function withUpdates(overrides: Parameters<typeof fakeStudioApi>[0] = {}) {
    const fake = fakeStudioApi({
      pluginsList: async () => [plugin("genex"), plugin("blender")],
      pluginsIndex: async () => index(["genex", "1.5.0"], ["blender", "2.0.0"]),
      ...overrides,
    });
    const store = createPluginsStore(fake.api);
    await Promise.all([store.refresh(), store.refreshIndex()]);
    fake.calls.length = 0;
    return { fake, store };
  }

  it("installs each in turn, busy until the last, then reads the plugins and the index again", async () => {
    let finishFirst!: () => void;
    const first = new Promise<void>((resolve) => {
      finishFirst = resolve;
    });
    const { fake, store } = await withUpdates({
      pluginUpdate: (id: string) => (id === "genex" ? first : Promise.resolve()),
    });
    assert.equal(store.getState().updating, false);
    const done = store.updateAll();
    assert.equal(store.getState().updating, true);
    await tick();
    assert.deepEqual(fake.callsOf("pluginUpdate"), [["genex"]], "the second waits for the first's answer");
    finishFirst();
    assert.deepEqual(await done, [], "nothing failed");
    assert.deepEqual(
      fake.calls.map((call) => call.method),
      ["pluginUpdate", "pluginUpdate", "pluginsList", "pluginsIndex"],
    );
    assert.equal(store.getState().updating, false);
  });

  it("keeps going past an update that fails, and answers with the failure", async () => {
    const refused = new Error("No compatible newer release is available for this installed plugin");
    const { fake, store } = await withUpdates({
      pluginUpdate: (id: string) => (id === "genex" ? Promise.reject(refused) : Promise.resolve()),
    });
    assert.deepEqual(await store.updateAll(), [refused]);
    assert.deepEqual(fake.callsOf("pluginUpdate"), [["genex"], ["blender"]], "the next plugin is still updated");
    assert.equal(store.getState().updating, false);
  });

  it("leaves out the updates the person unticked", async () => {
    const { fake, store } = await withUpdates();
    const [genex] = pluginUpdates(store.getState().list, store.getState().index);
    assert.ok(genex);
    assert.deepEqual(await store.updateAll(new Set([updateKey(genex)])), []);
    assert.deepEqual(fake.callsOf("pluginUpdate"), [["blender"]], "genex was unticked");
  });

  it("is one run at a time", async () => {
    const { fake, store } = await withUpdates();
    const running = store.updateAll();
    assert.deepEqual(await store.updateAll(), [], "a second press while it runs starts nothing");
    await running;
    assert.equal(fake.callsOf("pluginUpdate").length, 2);
  });
});

describe("the studio keeps the plugin index current", () => {
  function started(overrides: Parameters<typeof fakeStudioApi>[0] = {}, visibility?: VisibilitySource) {
    const timers = manualIntervals();
    const fake = fakeStudioApi({ pluginsIndex: async () => index(["blender", "2.0.0"]), ...overrides });
    const app = createStudio(fake.api, { storage: null, timers, ...(visibility ? { visibility } : {}) });
    app.start();
    return { fake, app, timers };
  }

  it("reads it once the bootstrap is ready, and again whenever the plugins change", async () => {
    const { fake, app } = started();
    assert.equal(app.plugins.getState().index, null, "nothing is offered before the first answer");
    await tick();
    assert.equal(fake.callsOf("pluginsIndex").length, 1);
    assert.deepEqual(app.plugins.getState().index?.updates[0]?.id, "blender");
    fake.stub("pluginsIndex", async () => index());
    fake.emit({ type: "plugins.changed", payload: {} } as never);
    await tick();
    assert.deepEqual(app.plugins.getState().index?.updates, [], "an installed update is no longer offered");
  });

  it("asks again every hour while the window shows, and keeps the last answer when a read fails", async () => {
    let hidden = false;
    const visibility: VisibilitySource = { hidden: () => hidden, subscribe: () => () => {} };
    const { fake, app, timers } = started({}, visibility);
    await tick();
    timers.fire(PLUGIN_INDEX_POLL_MS);
    await tick();
    assert.equal(fake.callsOf("pluginsIndex").length, 2);
    hidden = true;
    timers.fire(PLUGIN_INDEX_POLL_MS);
    await tick();
    assert.equal(fake.callsOf("pluginsIndex").length, 2, "a hidden window asks nothing");
    hidden = false;
    fake.stub("pluginsIndex", () => Promise.reject(new Error("Studio is still starting")));
    timers.fire(PLUGIN_INDEX_POLL_MS);
    await tick();
    assert.equal(fake.callsOf("pluginsIndex").length, 3);
    assert.equal(app.plugins.getState().index?.updates.length, 1, "the last index read stays");
  });
});
