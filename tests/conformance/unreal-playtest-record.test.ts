/**
 * A finished pilot run leaves its record in the game folder (`playtests/runs/<date>-<run>/record.md`),
 * with its findings' frames and its decision log copied from the Unreal project's `Saved/Genex`, once
 * per run, keeping only the newest records. Frames and logs come only from inside `Saved/Genex`, by
 * real path: a forged name, a path elsewhere or a link out copies nothing.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, readFile, realpath, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { KEPT_RUNS, recordFolderName, writeRunRecord } from "../../src/plugins/unreal/playtest-record.ts";
import { tmpDir } from "../helpers/tmp.ts";

const RUN_ID = "1793554918-Plant";

async function world() {
  const root = await realpath(await tmpDir("playtest-record-"));
  const game = path.join(root, "game");
  const project = path.join(root, "Proj");
  const captures = path.join(project, "Saved", "Genex", "captures");
  const pilots = path.join(project, "Saved", "Genex", "pilots");
  const outside = path.join(root, "outside");
  for (const dir of [game, captures, pilots, outside]) await mkdir(dir, { recursive: true });
  await writeFile(path.join(captures, "finding-sliding-1200.png"), "png");
  await writeFile(path.join(pilots, `${RUN_ID}.json`), '{"decisions": []}');
  await writeFile(path.join(outside, "secret.png"), "secret");
  await writeFile(path.join(outside, "secret.json"), "secret");
  await symlink(path.join(outside, "secret.png"), path.join(captures, "finding-link-1.png"));
  return { root, game, project, uproject: path.join(project, "Proj.uproject"), pilots, outside };
}

function report(extra: Record<string, unknown> = {}) {
  return {
    runId: RUN_ID,
    pilot: "Plant",
    outcome: "done",
    note: "bomb planted",
    gameSeconds: 61.2,
    asked: 120,
    answered: 118,
    byOrder: 4,
    moves: [{ name: "push_site", started: 19, worked: 12, failed: 3 }],
    findings: [
      { code: "sliding", detail: "BP_Bot_3 slides", gameSeconds: 12.0, count: 1, frame: "finding-sliding-1200" },
    ],
    timeline: ["10.0 s start push_site"],
    errors: [],
    ...extra,
  };
}

test("a finished run is recorded once, with its frame and decision log beside it", async () => {
  const w = await world();
  const film = path.join(w.pilots, `${RUN_ID}.json`);
  const relative = await writeRunRecord(w.game, w.uproject, report({ film }));
  const folder = recordFolderName(RUN_ID);
  assert.equal(relative, path.join("playtests", "runs", String(folder), "record.md"));
  const dir = path.join(w.game, "playtests", "runs", String(folder));
  assert.deepEqual((await readdir(dir)).sort(), ["decisions.json", "finding-sliding-1200.png", "record.md"]);
  const text = await readFile(path.join(dir, "record.md"), "utf8");
  assert.match(text, /Outcome: \*\*done\*\* \(bomb planted\)/);
  assert.match(text, /118 of 120 asks answered/);
  assert.match(text, /sliding at 12 s: BP_Bot_3 slides !\[\]\(finding-sliding-1200\.png\)/);
  await writeFile(path.join(dir, "record.md"), "the agent read it");
  assert.equal(await writeRunRecord(w.game, w.uproject, report({ film, outcome: "failed" })), relative);
  assert.equal(
    await readFile(path.join(dir, "record.md"), "utf8"),
    "the agent read it",
    "the end read twice writes once",
  );
});

test("frames and logs come only from inside Saved/Genex: forged names, other paths and links copy nothing", async () => {
  const w = await world();
  const hostile = [
    { frame: "../../outside/secret" },
    { frame: "finding-link-1" },
    { frame: "/etc/passwd" },
    { frame: "a b" },
  ];
  const relative = await writeRunRecord(
    w.game,
    w.uproject,
    report({
      findings: hostile.map((h, i) => ({ code: `kind-${i}`, detail: "x", gameSeconds: 1, ...h })),
      film: path.join(w.outside, "secret.json"),
    }),
  );
  const dir = path.dirname(path.join(w.game, String(relative)));
  assert.deepEqual(await readdir(dir), ["record.md"], "no frame and no log was copied");
  assert.doesNotMatch(await readFile(path.join(dir, "record.md"), "utf8"), /!\[\]/);
});

test("a run without a proper id writes nothing, and only the newest records are kept", async () => {
  const w = await world();
  for (const runId of ["", "../x", "12-a/b", "abc-Plant"]) {
    assert.equal(await writeRunRecord(w.game, w.uproject, report({ runId })), null, runId);
  }
  assert.deepEqual(await readdir(w.game), [], "nothing written for a bad id");
  const runs = path.join(w.game, "playtests", "runs");
  await mkdir(path.join(runs, "keep-me"), { recursive: true });
  for (let i = 0; i < KEPT_RUNS + 3; i++) {
    await writeRunRecord(w.game, undefined, report({ runId: `${1793550000 + i * 60}-Run` }));
  }
  const left = await readdir(runs);
  assert.equal(left.filter((n) => n !== "keep-me").length, KEPT_RUNS);
  assert.ok(left.includes("keep-me"), "a folder Genex did not name is left alone");
  assert.ok(!left.includes(String(recordFolderName("1793550000-Run"))), "the oldest went first");
});
