/**
 * A bundled plugin the host runs under the hood (`PluginRegistry.underHood`) is on whenever the
 * plugin it follows is, whatever an older profile recorded: a copy installed off, turned off or
 * removed comes back on at the next start, and the person's choice for every other plugin stays.
 */
import assert from "node:assert/strict";
import { cp, mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { test } from "node:test";
import { type PluginManifest, PluginStateRefusal } from "../../src/shared/plugins.ts";
import { PluginRegistry } from "../../src/substrate/plugins/registry.ts";
import { EXAMPLE_PLUGIN, PLUGIN_SDK_BACKEND } from "../helpers/plugins.ts";
import { removeTree } from "../helpers/tmp.ts";

/** The plugin the hidden one follows, and the hidden one. */
const LEADER = "example";
const ADVICE = "advice";

interface Fixture {
  /** A registry over the fixture's folders; `underHood` hides `advice` behind `example`. */
  open(options: { underHood: boolean; seedOff?: string[] }): Promise<PluginRegistry>;
  close(): Promise<void>;
}

/** Two seeds: the example plugin, and a copy of it named `advice`. */
async function fixture(): Promise<Fixture> {
  const root = await mkdtemp(path.join(os.tmpdir(), "studio-under-hood-"));
  const seeds = path.join(root, "seeds");
  await mkdir(seeds, { recursive: true });
  await cp(EXAMPLE_PLUGIN, path.join(seeds, LEADER), { recursive: true });
  await cp(EXAMPLE_PLUGIN, path.join(seeds, ADVICE), { recursive: true });
  const manifestFile = path.join(seeds, ADVICE, "plugin.json");
  const manifest = JSON.parse(await readFile(manifestFile, "utf8")) as PluginManifest;
  await writeFile(manifestFile, JSON.stringify({ ...manifest, id: ADVICE, name: "Advice" }));
  const registries: PluginRegistry[] = [];
  return {
    async open({ underHood, seedOff = [] }) {
      const registry = new PluginRegistry(
        path.join(root, "installed"),
        seeds,
        PLUGIN_SDK_BACKEND,
        async (_id, method) => {
          if (method !== "storage.root") throw new Error(`Unexpected service ${method}`);
          return path.join(root, "data");
        },
      );
      registry.seedEnabled = Object.fromEntries(seedOff.map((id) => [id, false]));
      if (underHood) registry.underHood = new Map([[ADVICE, LEADER]]);
      registries.push(registry);
      await registry.init();
      return registry;
    },
    async close() {
      for (const registry of registries) registry.cancel();
      await removeTree(root);
    },
  };
}

test("a plugin an older profile installed off comes back on under the hood", async () => {
  const f = await fixture();
  try {
    const before = await f.open({ underHood: false, seedOff: [ADVICE] });
    assert.equal(before.enabled(ADVICE), false, "the older profile has it off");
    const after = await f.open({ underHood: true });
    assert.equal(after.enabled(ADVICE), true);
    assert.equal(after.list().find((p) => p.manifest.id === ADVICE)?.removed, false);
  } finally {
    await f.close();
  }
});

test("a plugin the person turned off or removed comes back on under the hood; the others keep their state", async () => {
  for (const undo of ["turned off", "removed"] as const) {
    const f = await fixture();
    try {
      const before = await f.open({ underHood: false });
      if (undo === "removed") await before.remove(ADVICE);
      else await before.setEnabled(ADVICE, false);
      const after = await f.open({ underHood: true });
      assert.equal(after.enabled(ADVICE), true, `${undo}, it is on again`);
      assert.equal(after.enabled(LEADER), true);
      await after.setEnabled(LEADER, false);
      const again = await f.open({ underHood: true });
      assert.equal(again.enabled(LEADER), false, "the leader keeps the person's choice");
      assert.equal(again.enabled(ADVICE), false, "and the hidden plugin follows it");
    } finally {
      await f.close();
    }
  }
});

test("a hidden plugin is never switched or removed by itself and stays out of the window's list", async () => {
  const f = await fixture();
  try {
    const registry = await f.open({ underHood: true });
    await assert.rejects(registry.setEnabled(ADVICE, false), { code: PluginStateRefusal.UnderHood });
    await assert.rejects(registry.remove(ADVICE), { code: PluginStateRefusal.UnderHood });
    assert.ok(
      registry.list().some((p) => p.manifest.id === ADVICE),
      "the host still lists it",
    );
    const shown = (await registry.displayList()).map((p) => p.manifest.id);
    assert.deepEqual(shown, [LEADER]);
    assert.ok(
      registry.tools().some((tool) => tool.name.startsWith(`${ADVICE}__`)),
      "its agent tools are offered",
    );
  } finally {
    await f.close();
  }
});
