/**
 * Seed upgrades — the fix for the trap that bit twice on day one: the harness workspace was
 * seeded only when missing, so app-shipped fixes never reached an existing install.
 *
 * The invariant under test: **the agent owns its edits, the app owns everything the agent
 * never touched.** Upgrades flow through untouched files; edited files are never overwritten.
 */
import assert from "node:assert/strict";
import { appendFile, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  applySeed,
  reconcileManifestWithSeedVintages,
  RETIRED_SEED_PATHS,
  SEED_CALL_CHANGES,
  SEED_MOVES,
  type SeedUpgradeReport,
} from "../../src/substrate/seed-upgrade.ts";
import { SEED_CALL_MEMORY_PREFIX, seedCallMemory, seedUpgradedPayload } from "../../src/main/seed-upgrade-notice.ts";
import { pathExists } from "../../src/substrate/fsx.ts";
import { StudioCore } from "../../src/main/studio-core.ts";
import { makeResources } from "../helpers/resources.ts";
import { coreLite } from "../helpers/core-lite.ts";
import { git, STUDIO_COMMITTER } from "../../src/substrate/snapshots.ts";
import { cloneSeededWorkspace } from "../helpers/seed-upgrade-fixture.ts";
import { closeBeforeCleanup, removeTree, tmpDir } from "../helpers/tmp.ts";
import { readdirSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { studioActivity } from "../../src/shared/studio-activity.ts";
import { toEntries } from "../../src/renderer/chat-entries.ts";
import type { EventEnvelope } from "../../src/substrate/types.ts";
import { SEED_GENERATED } from "../../scripts/gen-harness-types.ts";
import { linkIsolated } from "../helpers/isolated-import.ts";

async function rig(): Promise<{ seed: string; ws: string; manifest: string; backup: string }> {
  const root = await tmpDir("seed-upgrade-");
  const seed = path.join(root, "seed");
  await mkdir(path.join(seed, "loop"), { recursive: true });
  await writeFile(path.join(seed, "loop", "main.mjs"), "// v1 main\n");
  await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v1 turn loop\n");
  await writeFile(path.join(seed, "package.json"), '{"name":"harness"}\n');
  return {
    seed,
    ws: path.join(root, "workspace"),
    manifest: path.join(root, "manifest.json"),
    backup: path.join(root, "backup"),
  };
}

/**
 * Why a case waits for the integration of phase 5: it pins seed parts this phase removed or changed
 * (moves out of deleted files, step markers in rewritten parts, kept old parts that load the harness).
 * Decision 7 archives a kept part the seed removed or changed incompatibly and lays the seed's copy
 * down (WS2's `substrate/seed-archive.ts`); each case is rewritten against that archive there.
 */
describe("seed upgrade", () => {
  it("first launch seeds the workspace and records what was laid down", async () => {
    const { seed, ws, manifest } = await rig();
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.equal(report.mode, "seeded");
    assert.deepEqual(report.added, ["loop/main.mjs", "loop/turn-loop.mjs", "package.json"]);
    assert.equal(await readFile(path.join(ws, "loop", "main.mjs"), "utf8"), "// v1 main\n");
    assert.ok(await pathExists(manifest));
  });

  it("a shipped fix reaches an existing install when the agent never touched the file", async () => {
    const { seed, ws, manifest, backup } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    // The app ships a fix (this exact scenario was the day-one trap: a guard fix in
    // turn-loop.mjs that never reached the live install).
    await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v2 turn loop with the guard fix\n");
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });

    assert.equal(report.mode, "upgraded");
    assert.deepEqual(report.updated, ["loop/turn-loop.mjs"]);
    assert.deepEqual(report.kept, []);
    assert.equal(
      await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"),
      "// v2 turn loop with the guard fix\n",
    );
    // The replaced version is recoverable without git archaeology.
    assert.equal(await readFile(path.join(backup, "loop", "turn-loop.mjs"), "utf8"), "// v1 turn loop\n");
  });

  it("never overwrites a file the agent edited — full recursion means its edits win", async () => {
    const { seed, ws, manifest } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), "// the agent rewrote its own turn loop\n");
    await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v2 from the app\n");
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    assert.deepEqual(report.kept, ["loop/turn-loop.mjs"]);
    assert.equal(
      await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"),
      "// the agent rewrote its own turn loop\n",
    );

    // ...and the manifest still remembers the divergence on the NEXT upgrade too.
    await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v3 from the app\n");
    const again = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(again.kept, ["loop/turn-loop.mjs"]);
    assert.match(await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"), /agent rewrote/);
  });

  it("respects an agent deletion and keeps agent-created files out of the books", async () => {
    const { seed, ws, manifest } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    await rm(path.join(ws, "package.json"));
    await mkdir(path.join(ws, "memory"), { recursive: true });
    await writeFile(path.join(ws, "memory", "notes.md"), "the agent's own memory\n");
    await writeFile(path.join(seed, "package.json"), '{"name":"harness","version":"2"}\n');

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.kept, ["package.json"], "deleting is an edit too");
    assert.equal(await pathExists(path.join(ws, "package.json")), false);
    assert.equal(await readFile(path.join(ws, "memory", "notes.md"), "utf8"), "the agent's own memory\n");
  });

  it("adds a brand-new seed file, unless the agent already grew one at that path", async () => {
    const { seed, ws, manifest } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });

    await writeFile(path.join(seed, "loop", "judge.mjs"), "// new in this app version\n");
    await writeFile(path.join(ws, "loop", "homegrown.mjs"), "// the agent wrote this itself\n");
    await writeFile(path.join(seed, "loop", "homegrown.mjs"), "// the app ships one under the same name\n");

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.added, ["loop/judge.mjs"]);
    assert.deepEqual(report.kept, ["loop/homegrown.mjs"]);
    assert.equal(await readFile(path.join(ws, "loop", "homegrown.mjs"), "utf8"), "// the agent wrote this itself\n");
  });

  it("migrates a pre-manifest install by treating the whole workspace as untouched", async () => {
    const { seed, ws, manifest } = await rig();
    // An install from before manifests existed: seeded by plain copy, no bookkeeping —
    // exactly the live install that had to be deleted by hand twice.
    await mkdir(path.join(ws, "loop"), { recursive: true });
    await writeFile(path.join(ws, "loop", "main.mjs"), "// v1 main\n");
    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), "// OLD turn loop without the guard fix\n");
    await writeFile(path.join(ws, "package.json"), '{"name":"harness"}\n');

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.equal(report.mode, "upgraded");
    assert.deepEqual(report.updated, ["loop/turn-loop.mjs"]);
    assert.equal(await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"), "// v1 turn loop\n");
    // From now on this install has a manifest like any other.
    assert.ok(await pathExists(manifest));
  });

  it("does nothing (and says so) when everything is already current", async () => {
    const { seed, ws, manifest } = await rig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.equal(report.mode, "unchanged");
    assert.deepEqual([report.added, report.updated, report.kept], [[], [], []]);
  });
});

describe("manifest reconcile after a harness restore", () => {
  /** A rig that has lived: seeded on v1, upgraded to v2 (backing v1 up under updates/). */
  async function livedRig() {
    const { seed, ws, manifest } = await rig();
    const updates = path.join(path.dirname(ws), "updates");
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    await writeFile(path.join(seed, "loop", "turn-loop.mjs"), "// v2 turn loop\n");
    await applySeed({
      seedDir: seed,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(updates, "seed-backup-1"),
    });
    return { seed, ws, manifest, updates };
  }

  it("re-owns a restored seed-vintage file so the next boot's upgrade lands again", async () => {
    const { seed, ws, manifest, updates } = await livedRig();
    // The watchdog rewinds the harness to a snapshot from before the upgrade: the workspace
    // holds v1 again while the manifest still records v2 — the exact shape seed-upgrade
    // misreads as an agent edit.
    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), "// v1 turn loop\n");

    const { reconciled } = await reconcileManifestWithSeedVintages({
      workspaceDir: ws,
      manifestFile: manifest,
      seedDir: seed,
      updatesDir: updates,
    });
    assert.deepEqual(reconciled, ["loop/turn-loop.mjs"]);

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.updated, ["loop/turn-loop.mjs"], "the shipped fix reaches the restored install");
    assert.deepEqual(report.kept, []);
    assert.equal(await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"), "// v2 turn loop\n");
  });

  it("leaves genuine agent content owned even when it diverges from the manifest", async () => {
    const { seed, ws, manifest, updates } = await livedRig();
    // Content that matches no seed vintage is the agent's, whatever brought it here.
    await writeFile(path.join(ws, "loop", "turn-loop.mjs"), "// the agent's own rewrite\n");

    const { reconciled } = await reconcileManifestWithSeedVintages({
      workspaceDir: ws,
      manifestFile: manifest,
      seedDir: seed,
      updatesDir: updates,
    });
    assert.deepEqual(reconciled, []);

    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.kept, ["loop/turn-loop.mjs"], "hard constraint #1: the agent's copy wins");
    assert.equal(await readFile(path.join(ws, "loop", "turn-loop.mjs"), "utf8"), "// the agent's own rewrite\n");
  });

  it("is a no-op without backups, without a manifest, and for files that went missing", async () => {
    const { seed, ws, manifest } = await rig();
    // No manifest yet: nothing to reconcile, nothing to throw.
    assert.deepEqual(
      await reconcileManifestWithSeedVintages({
        workspaceDir: ws,
        manifestFile: manifest,
        seedDir: seed,
        updatesDir: path.join(path.dirname(ws), "no-such-updates"),
      }),
      { reconciled: [] },
    );

    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    // A rewind can also drop a file entirely; a deletion carries no bytes to match a vintage,
    // so its entry stays exactly as it is.
    await rm(path.join(ws, "loop", "turn-loop.mjs"));
    const { reconciled } = await reconcileManifestWithSeedVintages({
      workspaceDir: ws,
      manifestFile: manifest,
      seedDir: seed,
      updatesDir: path.join(path.dirname(ws), "still-no-updates"),
    });
    assert.deepEqual(reconciled, []);
  });
});

describe("the first launch's harness repository", () => {
  it("is written by git from the shipped seed, so no file the launch just wrote is read back", async () => {
    // Windows scans a file the first time it is read after being written: committing the copied
    // seed made git read back all of it, and a first start on Windows 11 waited minutes on that.
    const { core, resources } = await coreLite();
    const ws = core.layout.harnessWs;
    const shipped = (
      await readdir(path.join(resources, "harness-seed"), { recursive: true, withFileTypes: true })
    ).filter((entry) => entry.isFile()).length;
    const counts = Object.fromEntries(
      (await git(ws, ["count-objects", "-v"]))
        .trim()
        .split("\n")
        .map((line) => line.split(": ") as [string, string]),
    );
    assert.equal(Number(counts.count), 0, "no loose object: the commit went into one pack");
    assert.ok(Number(counts["in-pack"]) > shipped, "every file, tree and the commit are packed");
    assert.equal((await git(ws, ["ls-files"])).trim().split("\n").length, shipped);
    assert.equal((await git(ws, ["status", "--porcelain"])).trim(), "");
    assert.equal(
      (await git(ws, ["log", "--format=%an <%ae>|%s"])).trim(),
      `${STUDIO_COMMITTER.name} <${STUDIO_COMMITTER.email}>|substrate: initial`,
    );
    for (const rel of ["loop/main.ts", "package.json"])
      assert.equal(
        await readFile(path.join(ws, rel), "utf8"),
        await readFile(path.join(resources, "harness-seed", rel), "utf8"),
      );
  });
});

describe("seed upgrade baseline at boot", () => {
  it("a boot that applies seed files snapshots the fresh harness, healthy once it has booted", async () => {
    // Unattended, the watchdog rewound four times to the only healthy harness snapshot there
    // was — an Aug 20 promotion — undoing the newer seed each time. The rewind target must
    // follow the newest applied seed — once it has run: the baseline also pins whatever code
    // the last session left, which may never have booted (MIG-3).
    const resources = await makeResources();
    const userData = path.join(await tmpDir("seed-baseline-"), "userData");
    const boot = async () => {
      const core = new StudioCore({
        paths: { userData, resources },
        engines: [],
        sandbox: false,
        execPath: process.execPath,
      });
      await core.init();
      return core;
    };

    const first = await boot();
    assert.equal(
      first.snapshotIndex.newestHealthy("harness"),
      undefined,
      "a first launch seeds; nothing has run yet, so nothing is claimed healthy",
    );

    // The app ships a fix in the seed, then the studio boots again over the same install.
    const shipped = path.join(resources, "harness-seed", "prompts", "operating-rules.md");
    await writeFile(shipped, `${await readFile(shipped, "utf8")}\n<!-- shipped fix -->\n`);
    const second = await boot();
    const baseline = second.snapshotIndex.all().find((record) => /seed upgrade baseline/.test(record.reason));
    assert.ok(baseline?.git.harness, "an applied upgrade pins the fresh harness commit for the watchdog");
    assert.notEqual(baseline.healthy, true, "nothing has run it yet, and there is no healthy self it matches");
    try {
      await second.start();
      assert.equal(
        second.snapshotIndex.newestHealthy("harness")?.snapshot_id,
        baseline.snapshot_id,
        "booted, it is the rewind target",
      );
    } finally {
      await second.stop();
    }
  });
});

it("the files the build generates into the seed ship like any other: added, replaced while untouched, kept once edited", async () => {
  const { seed, ws, manifest } = await rig();
  await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
  const generated = SEED_GENERATED.map(({ seedFile }) => seedFile);
  const ship = async (suffix: string) => {
    for (const { seedFile, generate } of SEED_GENERATED) {
      await mkdir(path.dirname(path.join(seed, seedFile)), { recursive: true });
      await writeFile(path.join(seed, seedFile), generate(process.cwd()) + suffix);
    }
    return applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
  };
  const readWs = (rel: string) => readFile(path.join(ws, rel), "utf8");

  const first = await ship("");
  assert.deepEqual(first.added.filter((rel) => generated.includes(rel)).sort(), [...generated].sort());

  const second = await ship("// next contract\n");
  assert.deepEqual(second.updated.filter((rel) => generated.includes(rel)).sort(), [...generated].sort());
  for (const rel of generated) assert.match(await readWs(rel), /\/\/ next contract\n$/);

  const edited = generated.at(0) ?? assert.fail("the build generates at least one seed file");
  await appendFile(path.join(ws, edited), "// the agent's line\n");
  const third = await ship("// a later contract\n");
  assert.ok(third.kept.includes(edited), "an edited generated file is the agent's");
  assert.match(await readWs(edited), /the agent's line/);
});

describe("seed upgrade: a manifest that forgot a file", () => {
  it("keeps entries for paths the current seed does not ship, so an older build's boot cannot orphan a newer file", async () => {
    const r = await rig();
    await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    // A newer seed adds a file …
    await writeFile(path.join(r.seed, "loop", "run-inbox.mjs"), "// inbox v1\n");
    await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    // … then an older build (whose seed lacks it) boots against the same install …
    await rm(path.join(r.seed, "loop", "run-inbox.mjs"));
    await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    const manifest = JSON.parse(await readFile(r.manifest, "utf8")) as { files: Record<string, string> };
    assert.ok(manifest.files["loop/run-inbox.mjs"], "the entry survives a seed that does not ship the file");
    // … and the newer build's next fix still lands.
    await writeFile(path.join(r.seed, "loop", "run-inbox.mjs"), "// inbox v2\n");
    const report = await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    assert.deepEqual(report.updated, ["loop/run-inbox.mjs"]);
    assert.equal(await readFile(path.join(r.ws, "loop", "run-inbox.mjs"), "utf8"), "// inbox v2\n");
  });

  it("re-owns an unknown workspace file whose bytes are a backed-up seed vintage, and keeps one that matches no vintage", async () => {
    const r = await rig();
    await applySeed({ seedDir: r.seed, workspaceDir: r.ws, manifestFile: r.manifest });
    const updates = path.join(path.dirname(r.ws), "updates");
    // An earlier upgrade backed up the v1 inbox before replacing it; the manifest later lost the entry.
    await mkdir(path.join(updates, "seed-backup-old", "loop"), { recursive: true });
    await writeFile(path.join(updates, "seed-backup-old", "loop", "run-inbox.mjs"), "// inbox v1\n");
    await writeFile(path.join(r.ws, "loop", "run-inbox.mjs"), "// inbox v1\n");
    await writeFile(path.join(r.ws, "loop", "mine.mjs"), "// the agent's own\n");
    await writeFile(path.join(r.seed, "loop", "run-inbox.mjs"), "// inbox v3\n");
    await writeFile(path.join(r.seed, "loop", "mine.mjs"), "// the seed's idea of mine\n");
    const report = await applySeed({
      seedDir: r.seed,
      workspaceDir: r.ws,
      manifestFile: r.manifest,
      backupDir: r.backup,
      updatesDir: updates,
    });
    assert.deepEqual(report.updated, ["loop/run-inbox.mjs"], JSON.stringify(report));
    assert.deepEqual(report.kept, ["loop/mine.mjs"]);
    assert.equal(await readFile(path.join(r.ws, "loop", "run-inbox.mjs"), "utf8"), "// inbox v3\n");
    assert.equal(await readFile(path.join(r.ws, "loop", "mine.mjs"), "utf8"), "// the agent's own\n");
    assert.ok(await pathExists(path.join(r.backup, "loop", "run-inbox.mjs")), "the replaced vintage is backed up");
  });
});

describe("retiring a seed file the app no longer ships", () => {
  /** The rig, plus one of the retired paths in the older seed the install was created from. */
  async function retiredRig(): Promise<{ seed: string; ws: string; manifest: string; backup: string; rel: string }> {
    const base = await rig();
    const rel = RETIRED_SEED_PATHS[0]!;
    await mkdir(path.join(base.seed, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(base.seed, rel), "# an older build shipped this\n");
    await applySeed({ seedDir: base.seed, workspaceDir: base.ws, manifestFile: base.manifest });
    // The new build's seed no longer carries it: that is what retirement is for.
    await rm(path.join(base.seed, rel));
    return { ...base, rel };
  }

  it("removes an untouched copy, backs it up, and reports it", async () => {
    const { seed, ws, manifest, backup, rel } = await retiredRig();
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.deepEqual(report.retired, [rel]);
    assert.equal(report.mode, "upgraded", "a retirement is a change");
    assert.equal(await pathExists(path.join(ws, rel)), false, "the workspace no longer carries it");
    assert.equal(await readFile(path.join(backup, rel), "utf8"), "# an older build shipped this\n");
  });

  it("keeps the manifest entry, so an older build cannot resurrect the file", async () => {
    const { seed, ws, manifest, backup, rel } = await retiredRig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    const written = JSON.parse(await readFile(manifest, "utf8")) as {
      files: Record<string, string>;
      retired?: Record<string, string>;
    };
    assert.ok(written.files[rel], "the entry survives the removal");
    assert.ok(written.retired?.[rel], "and is marked retired");

    // An older build, whose seed still ships the file, boots against the same install: with the
    // entry present it reads a deliberate deletion and leaves it deleted.
    await mkdir(path.join(seed, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(seed, rel), "# an older build shipped this\n");
    const older = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.ok(older.kept.includes(rel), "the older build keeps it deleted");
    assert.equal(await pathExists(path.join(ws, rel)), false);
  });

  it("retires on the one-time migration too, where the manifest that would remember it does not exist yet", async () => {
    // An install created before the manifest: the workspace is a plain copy of the older seed.
    // Nothing else could ever remove these four — the seed no longer ships them, so they never
    // acquire a manifest entry, and every later boot would read "never the app's file here".
    const base = await rig();
    const rel = RETIRED_SEED_PATHS[0]!;
    await mkdir(path.join(base.ws, path.dirname(rel)), { recursive: true });
    await mkdir(path.join(base.ws, "loop"), { recursive: true });
    await writeFile(path.join(base.ws, rel), "# an older build shipped this\n");
    await writeFile(path.join(base.ws, "loop", "main.mjs"), "// v0 main\n");
    assert.equal(await pathExists(base.manifest), false, "the install predates the manifest");

    const report = await applySeed({
      seedDir: base.seed,
      workspaceDir: base.ws,
      manifestFile: base.manifest,
      backupDir: base.backup,
    });
    assert.deepEqual(report.retired, [rel], JSON.stringify(report));
    assert.equal(await pathExists(path.join(base.ws, rel)), false, "the dead skill is gone from the workspace");
    assert.equal(
      await readFile(path.join(base.backup, rel), "utf8"),
      "# an older build shipped this\n",
      "and is recoverable",
    );

    // The manifest the migration writes remembers the removal both ways: the entry keeps an
    // older build from copying the file straight back in, the mark keeps this one from
    // removing a copy somebody restores later.
    const written = JSON.parse(await readFile(base.manifest, "utf8")) as {
      files: Record<string, string>;
      retired?: Record<string, string>;
    };
    assert.ok(written.files[rel], "the entry the ordinary path carries over is written here");
    assert.ok(written.retired?.[rel]);
    await mkdir(path.join(base.seed, path.dirname(rel)), { recursive: true });
    await writeFile(path.join(base.seed, rel), "# an older build shipped this\n");
    const older = await applySeed({
      seedDir: base.seed,
      workspaceDir: base.ws,
      manifestFile: base.manifest,
      backupDir: base.backup,
    });
    assert.ok(older.kept.includes(rel), JSON.stringify(older));
    assert.equal(await pathExists(path.join(base.ws, rel)), false, "an older build cannot resurrect it");
  });

  it("keeps a copy the agent edited, for ever", async () => {
    const { seed, ws, manifest, backup, rel } = await retiredRig();
    await writeFile(path.join(ws, rel), "# the agent rewrote this one\n");
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.deepEqual(report.retired, []);
    assert.equal(await readFile(path.join(ws, rel), "utf8"), "# the agent rewrote this one\n");
  });

  it("is idempotent: a second pass finds nothing left to do", async () => {
    const { seed, ws, manifest, backup } = await retiredRig();
    await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    const again = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.deepEqual(again.retired, []);
    assert.equal(again.mode, "unchanged");
  });

  it("deletes nothing when no backupDir was passed — the crash-recovery reseed", async () => {
    const { seed, ws, manifest, rel } = await retiredRig();
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest });
    assert.deepEqual(report.retired, []);
    assert.equal(await pathExists(path.join(ws, rel)), true, "nothing is removed without somewhere to put it");
  });

  it("never creates the retired paths on a fresh workspace", async () => {
    const { seed, ws, manifest, backup } = await rig();
    const report = await applySeed({ seedDir: seed, workspaceDir: ws, manifestFile: manifest, backupDir: backup });
    assert.equal(report.mode, "seeded");
    assert.deepEqual(report.retired, []);
    for (const rel of RETIRED_SEED_PATHS) assert.equal(await pathExists(path.join(ws, rel)), false, rel);
  });

  it("names only paths the shipped seed really has stopped shipping", async () => {
    const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
    for (const rel of RETIRED_SEED_PATHS) {
      assert.equal(
        await pathExists(path.join(shipped, rel)),
        false,
        `${rel} is still shipped — retiring it would delete a live file`,
      );
    }
  });

  it("carries all four outcomes to both surfaces the user reads", () => {
    // A retirement takes a page out of the user's own workspace. `retired` alone marks the
    // report `upgraded`, so a pass that only retires reaches these two renderers with `added`
    // and `updated` empty — and both used to render a sentence counting zero files and a
    // detail list with nothing in it.
    // The payload StudioCore appends at boot, built from the report `applySeed` returns.
    const upgrade = (outcomes: Omit<SeedUpgradeReport, "mode">): EventEnvelope => {
      const payload = seedUpgradedPayload({ mode: "upgraded", ...outcomes });
      assert.ok(payload, "an upgraded seed is always reported");
      return {
        id: "upgrade",
        thread_id: "studio",
        turn_id: null,
        session_id: null,
        created_at: "2026-09-22T00:00:00Z",
        data: { type: "custom", event_type: "seed_upgraded", payload },
      };
    };
    for (const mode of ["seeded", "unchanged"] as const)
      assert.equal(
        seedUpgradedPayload({ mode, added: ["a"], updated: [], kept: [], retired: [], moved: [] }),
        null,
        `${mode} is not news`,
      );
    assert.equal(seedUpgradedPayload(null), null);
    const report = upgrade({
      added: ["loop/new.mjs"],
      updated: ["loop/main.mjs"],
      kept: ["skills/own.md"],
      retired: ["docs/old.md"],
      moved: [],
    });
    assert.deepEqual(
      report.data.type === "custom" && report.data.payload,
      { added: ["loop/new.mjs"], updated: ["loop/main.mjs"], kept: ["skills/own.md"], retired: ["docs/old.md"] },
      "all four outcomes, and nothing else",
    );
    const activity = studioActivity([report])[0]!;
    assert.match(activity.title, /refreshed 2/);
    assert.match(activity.title, /archived 1/);
    for (const file of ["loop/new.mjs", "loop/main.mjs", "skills/own.md", "docs/old.md"])
      assert.ok(activity.detail.includes(file), file);
    assert.match(activity.detail, /Preserved your edits/);
    const chatText = (event: EventEnvelope) =>
      toEntries([event])
        .flatMap((entry) =>
          entry.kind === "activity" ? entry.rows.map((row) => row.text) : "text" in entry ? [entry.text] : [],
        )
        .join("\n");
    assert.match(chatText(report), /refreshed 2.*took away 1.*1 self-edited file kept/);
    const retirement = upgrade({ added: [], updated: [], kept: [], retired: ["docs/old.md"], moved: [] });
    assert.match(studioActivity([retirement])[0]!.title, /archived 1/);
    assert.doesNotMatch(studioActivity([retirement])[0]!.title, /refreshed 0/);
    assert.match(chatText(retirement), /took away 1/);
    assert.doesNotMatch(chatText(retirement), /refreshed 0/);
  });
});

/**
 * An install from before the archive epoch whose agent edited every part of an older seed, kept
 * across upgrades until now. Upgrading into the epoch (seed-archive.ts) archives every such kept
 * part, of a file this seed changes or no longer ships, and lays the shipped copy down, so the
 * harness that boots is the shipped one: no older copy is left beside it to fail at link time.
 */
describe("seed upgrade into the archive epoch, over an older install", () => {
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
  /** A hash no seed file has: the copy an older seed laid down, which the agent then edited. */
  const OLDER_SEED_HASH = "0".repeat(64);
  /** What the agent's edit of an older part holds. */
  const OLDER_EDIT = "export const OLDER_EDIT = true;\n// the agent's own change\n";

  /** Every `.ts` part the shipped seed has under `loop/` and `tools/`, workspace-relative. */
  function olderParts(): string[] {
    const parts: string[] = [];
    for (const top of ["loop", "tools"])
      for (const entry of readdirSync(path.join(shipped, top), { recursive: true, withFileTypes: true }))
        if (entry.isFile() && entry.name.endsWith(".ts"))
          parts.push(path.relative(shipped, path.join(entry.parentPath, entry.name)).split(path.sep).join("/"));
    return parts.sort();
  }

  it("archives each kept older part with the agent's edit, lays the shipped copy down, and the harness loads", async () => {
    const parts = olderParts();
    assert.ok(parts.length > 100, `the seed has its parts (${parts.length})`);
    const root = await tmpDir("seed-epoch-");
    const { ws, manifest } = await cloneSeededWorkspace(shipped, root);
    const body = JSON.parse(await readFile(manifest, "utf8")) as {
      files: Record<string, string>;
      archiveEpoch?: number;
    };
    delete body.archiveEpoch;
    // The copy the shipped seed laid down in that workspace, or null where it ships none.
    const laid = new Map<string, string | null>();
    for (const rel of parts) {
      body.files[rel] = OLDER_SEED_HASH;
      laid.set(rel, await readFile(path.join(ws, rel), "utf8").catch(() => null));
      await mkdir(path.dirname(path.join(ws, rel)), { recursive: true });
      await writeFile(path.join(ws, rel), OLDER_EDIT);
    }
    await writeFile(manifest, JSON.stringify(body));

    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
      now: () => new Date("2026-10-30T09:00:00Z"),
    });

    assert.equal(report.archive?.dir, "archive/2026-10-30");
    assert.deepEqual([...(report.archive?.edits ?? [])].sort(), parts, "every kept part is archived");
    for (const rel of parts) {
      const archived = await readFile(path.join(ws, "archive", "2026-10-30", rel), "utf8");
      assert.equal(archived, OLDER_EDIT, `${rel}: the agent's copy`);
      const shippedCopy = laid.get(rel) ?? null;
      if (shippedCopy !== null)
        assert.equal(await readFile(path.join(ws, rel), "utf8"), shippedCopy, `${rel}: shipped`);
      else assert.equal(await pathExists(path.join(ws, rel)), false, `${rel}: the seed no longer ships it`);
    }
    assert.deepEqual(report.kept, [], "nothing older is kept beside the shipped harness");
    // What the bootstrap does: import the workspace's own main.ts.
    const main = await linkIsolated(path.join(ws, "loop", "main.ts"));
    assert.equal(main.createStudio, "function");
  });

  it("SEED_MOVES says where each moved name lives now, and the old file passes on that very binding", async () => {
    const load = async (rel: string) =>
      (await import(new URL(`../../src/harness-seed/${rel}`, import.meta.url).href)) as Record<string, unknown>;
    for (const move of SEED_MOVES) {
      const [from, to] = [await load(move.from), await load(move.to)];
      for (const name of move.names) {
        assert.ok(name in to, `${move.to} exports ${name}`);
        assert.equal(from[name], to[name], `${move.from} re-exports ${name} from ${move.to}`);
      }
    }
  });

  it("a kept copy of every file a call change names, edited without touching its calls, is never reported", async () => {
    const root = await tmpDir("seed-call-changes-");
    const { ws, manifest } = await cloneSeededWorkspace(shipped, root);
    const files = [...new Set(SEED_CALL_CHANGES.map((change) => change.file))];
    for (const file of files) await appendFile(path.join(ws, file), "\n// the agent's own change\n");
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual([...report.kept].sort(), [...files].sort(), "every one is the agent's");
    assert.deepEqual(report.outdatedCalls ?? [], [], "a call change names only a file and a call the seed ships");
  });
});

describe("seed upgrade across the harness step flag", () => {
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));
  const TURN = "loop/delegated-turn.ts";

  /** A workspace whose chat turn the agent edited: `older` still saves its game's editor itself, without Genex's checkpoint. */
  async function keptTurn(older: boolean) {
    const root = await tmpDir("seed-step-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const copy = await readFile(path.join(ws, TURN), "utf8");
    // The older shape: the turn's end save is its own, not Genex's checkpoint.
    const kept = older ? copy.replaceAll("endOfTurnCheckpoint(", "saveUnrealTurn(") : copy;
    await writeFile(path.join(ws, TURN), `${kept}\n// the agent's own change\n`);
    const backupDir = path.join(root, "backup");
    return applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest, backupDir });
  }

  it("a kept chat turn that ends without Genex's checkpoint is reported and noted for the agent; one that takes it is not", async () => {
    const outdated = await keptTurn(true);
    assert.ok(outdated.kept.includes(TURN), "the chat turn is the agent's");
    assert.deepEqual(outdated.outdatedCalls, [TURN]);
    const current = await keptTurn(false);
    assert.ok(current.kept.includes(TURN));
    assert.deepEqual(current.outdatedCalls ?? [], []);

    const memory = seedCallMemory({ "user taste": "warm palettes" }, outdated.outdatedCalls ?? []);
    assert.equal(memory["user taste"], "warm palettes", "the agent's own memory is left alone");
    const note = memory[`${SEED_CALL_MEMORY_PREFIX}${TURN}`];
    assert.equal(typeof note, "string");
    assert.match(note as string, /calls the host the older way/);
    assert.match(note as string, /calls the host the older way/);
    assert.ok((note as string).length <= 300, "one memory value stays within the memory policy's limit");
    assert.deepEqual(
      seedCallMemory(memory, []),
      { "user taste": "warm palettes" },
      "a note that no longer holds is taken back",
    );
  });

  it("a kept tool registry or chat turn whose plugins.tools call names no game is reported once, and noted for the agent", async () => {
    const REGISTRY = "tools/index.ts";
    const root = await tmpDir("seed-step-plugins-tools-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shape: the plugin tools asked for with no game, whatever the game holds.
    for (const [file, from] of [
      [REGISTRY, "HostMethod.PluginsTools, { project: options.project ?? null }"],
      [TURN, "HostMethod.PluginsTools, { project }"],
    ] as const) {
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(from), `${file} sends the game`);
      // The chat turn is older still: its harness steps go out like an agent's call too.
      const older = copy.replace(from, "HostMethod.PluginsTools, {}").replaceAll("step: true", "harness: true");
      await writeFile(path.join(ws, file), `${older}\n// the agent's own change\n`);
    }
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual([...(report.outdatedCalls ?? [])].sort(), [TURN, REGISTRY].sort(), "each file once");
    const memory = seedCallMemory({}, report.outdatedCalls ?? []);
    for (const file of [REGISTRY, TURN]) {
      const note = String(memory[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept local prompt that reads no web rules file is reported once and noted for the agent", async () => {
    const root = await tmpDir("seed-step-web-rules-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    const file = "loop/prompt.ts";
    const copy = await readFile(path.join(ws, file), "utf8");
    // The older shape: one rules file for every turn, its web rules included.
    const webRules = '"prompts/operating-rules-web.md"';
    assert.ok(copy.includes(webRules), "the shipped copy reads the web rules for a web game");
    await writeFile(path.join(ws, file), `${copy.replaceAll(webRules, '""')}\n// the agent's own change\n`);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual(report.outdatedCalls ?? [], [file], "reported once");
    const note = String(seedCallMemory({}, report.outdatedCalls ?? [])[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
    assert.match(note, /calls the host the older way/);
    assert.ok(note.length <= 300, "one memory value stays within the memory policy's limit");
  });

  // Flipped (chat brief): a kept chat brief that named no first step for a game with no kind, and one
  // with no workers line, were reported. The chat's context names neither: the tools do.
  it("a kept loop entry or chat turn from before chat workers is reported once and noted for the agent", async () => {
    const root = await tmpDir("seed-step-chat-workers-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shapes: no "workers" claim, no worker pool around a chat turn.
    const older: ReadonlyArray<readonly [string, readonly string[]]> = [
      ["loop/main.ts", ['"workers"']],
      [TURN, ["withChatWorkers(", "chatWorkersGrant("]],
    ];
    for (const [file, markers] of older) {
      let copy = await readFile(path.join(ws, file), "utf8");
      for (const marker of markers) {
        assert.ok(copy.includes(marker), `${file} has ${marker}`);
        copy = copy.replaceAll(marker, "olderShape");
      }
      await writeFile(path.join(ws, file), `${copy}\n// the agent's own change\n`);
    }
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    const files = older.map(([file]) => file);
    assert.deepEqual([...(report.outdatedCalls ?? [])].sort(), [...files].sort(), "each file once");
    const memory = seedCallMemory({}, report.outdatedCalls ?? []);
    for (const file of files) {
      const note = String(memory[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept wake loop, wake rules, loop run or journal from before a job's end woke the lead is reported once and noted", async () => {
    const root = await tmpDir("seed-step-job-wake-");
    const ws = path.join(root, "workspace");
    const manifest = path.join(root, "manifest.json");
    await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
    // The older shapes: no job watch, no job kind, and no cursor kept on the journal.
    const older: ReadonlyArray<readonly [string, string]> = [
      ["loop/director/wake.ts", "watchJobs("],
      ["loop/director/wake-schedule.ts", "JobEnded"],
      ["loop/director/loop-run.ts", "jobsCursor"],
      ["loop/director/journal.ts", "jobsCursor"],
    ];
    for (const [file, marker] of older) {
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(marker), `${file} has ${marker}`);
      await writeFile(path.join(ws, file), `${copy.replaceAll(marker, "olderShape")}\n// the agent's own change\n`);
    }
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    const files = older.map(([file]) => file);
    assert.deepEqual([...(report.outdatedCalls ?? [])].sort(), [...files].sort(), "each file once");
    const memory = seedCallMemory({}, report.outdatedCalls ?? []);
    for (const file of files) {
      const note = String(memory[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept director part from before a Loop led in place is reported once and noted", async () => {
    const older: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["loop/director/setup.ts", "prepareOpenLoopRun(", /prepareOpenLoopRun/],
      ["loop/director.ts", "LoopProfile.Open", /LoopProfile\.Open/],
      ["loop/director/wake.ts", "activeWork(", /activeWork/],
      ["loop/director/loop-run.ts", "open?: OpenLoop", /OpenLoop/],
      // After a Loop in place: a resume in its journal's kind, and the chat's status alone.
      ["loop/run-dispatch.ts", "resumedProfile(", /resumedProfile/],
      ["loop/after-loop-run.ts", "inPlace", /inPlace/],
    ];
    for (const [file, marker] of older) {
      const root = await tmpDir("seed-step-open-loop-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(marker), `${file} has ${marker}`);
      await writeFile(path.join(ws, file), `${copy.replaceAll(marker, "olderShape")}\n// the agent's own change\n`);
      const report = await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      assert.deepEqual(report.outdatedCalls, [file], `${file} without ${marker}`);
      const note = String(seedCallMemory({}, report.outdatedCalls ?? [])[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("a kept part from before one Loop led every project is reported once and noted", async () => {
    const older: ReadonlyArray<readonly [string, string, RegExp]> = [
      ["loop/run-dispatch.ts", "loopProfileOf(", /loopProfileOf/],
      ["loop/studio-state.ts", "NeedsSession", /NeedsSession/],
    ];
    for (const [file, marker] of older) {
      const root = await tmpDir("seed-step-one-loop-");
      const ws = path.join(root, "workspace");
      const manifest = path.join(root, "manifest.json");
      await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      const copy = await readFile(path.join(ws, file), "utf8");
      assert.ok(copy.includes(marker), `${file} has ${marker}`);
      await writeFile(path.join(ws, file), `${copy.replaceAll(marker, "olderShape")}\n// the agent's own change\n`);
      const report = await applySeed({ seedDir: shipped, workspaceDir: ws, manifestFile: manifest });
      assert.deepEqual(report.outdatedCalls, [file], `${file} without ${marker}`);
      const note = String(seedCallMemory({}, report.outdatedCalls ?? [])[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
      assert.match(note, /calls the host the older way/, file);
      assert.ok(note.length <= 300, `${file}: one memory value stays within the memory policy's limit`);
    }
  });

  it("the boot writes an outdated call into the agent's memory, and takes it back once the copy takes Genex's checkpoint", async () => {
    const resources = await makeResources();
    const userData = path.join(await tmpDir("seed-call-boot-"), "userData");
    const boot = async () => {
      // This characterizes seed memory, without agents or a process-wide network bridge.
      const core = new StudioCore({
        paths: { userData, resources },
        engines: [],
        sandbox: false,
        execPath: process.execPath,
      });
      closeBeforeCleanup(() => core.stop());
      await core.init();
      return core;
    };
    const memoryOf = async (core: StudioCore) =>
      ((await core.store.readArtifact(core.mainThread, "memory")) ?? {}) as Record<string, unknown>;
    const first = await boot();
    const turn = path.join(first.layout.harnessWs, TURN);
    const shippedTurn = await readFile(turn, "utf8");
    await writeFile(
      turn,
      `${shippedTurn.replaceAll("endOfTurnCheckpoint(", "saveUnrealTurn(")}\n// the agent's own change\n`,
    );

    const second = await boot();
    assert.match(String((await memoryOf(second))[`${SEED_CALL_MEMORY_PREFIX}${TURN}`]), /calls the host the older way/);

    // The agent carries the new call into its copy.
    await writeFile(turn, `${shippedTurn}\n// the agent's own change, on the new shape\n`);
    const third = await boot();
    assert.ok(!(`${SEED_CALL_MEMORY_PREFIX}${TURN}` in (await memoryOf(third))), "the note is gone");
  });
});

/**
 * Genex's moments changed parts of the harness (the chat turn, its brief and offer, the director's
 * start, wake, tools and builders, the worker pool, the Unreal lead's modules) and gave them a module
 * to import (`loop/hooks.ts`). Any of those parts may be one the agent edited and a seed upgrade keeps
 * at the older vintage: each new name comes from a module of its own, so a current part beside one
 * older copy still links, through the loop, every local turn's prompt and the Unreal lead.
 */
describe("seed upgrade across Genex's moments", () => {
  const shipped = path.resolve(fileURLToPath(new URL("../../src/harness-seed", import.meta.url)));

  it("a kept host-method table without the moments', locks' and finish check's methods is reported once and noted for the agent", async () => {
    const root = await tmpDir("seed-moments-methods-");
    const { ws, manifest } = await cloneSeededWorkspace(shipped, root);
    const file = "loop/host-methods.ts";
    const copy = await readFile(path.join(ws, file), "utf8");
    const newer = [
      "LocksHold",
      "LocksRelease",
      "CheckpointTake",
      "HooksFire",
      "ObserversCapture",
      "FinishReview",
      "FinishSettle",
    ];
    const older = copy
      .split("\n")
      .filter((line) => !newer.some((name) => line.trim().startsWith(`${name}:`)))
      .join("\n");
    assert.notEqual(older, copy, "the shipped table has the newer methods");
    await writeFile(path.join(ws, file), `${older}\n// the agent's own change\n`);
    const report = await applySeed({
      seedDir: shipped,
      workspaceDir: ws,
      manifestFile: manifest,
      backupDir: path.join(root, "backup"),
    });
    assert.deepEqual(report.outdatedCalls ?? [], [file], "reported once");
    const note = String(seedCallMemory({}, report.outdatedCalls ?? [])[`${SEED_CALL_MEMORY_PREFIX}${file}`]);
    assert.match(note, /calls the host the older way/);
    assert.match(note, /calls the host the older way/);
    assert.match(note, /calls the host the older way/);
    assert.match(note, /calls the host the older way/);
    assert.ok(note.length <= 300, "one memory value stays within the memory policy's limit");
    await removeTree(root);
  });
});
