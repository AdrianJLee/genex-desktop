/**
 * `loop/git.ts`: the one place the harness builds and runs git command lines. Driven through a
 * real `sh -c` (Git Bash on Windows) in real repositories (what `run.exec` does), so quoting, the merge abort and
 * the hash and ref checks are proved on git itself rather than on a spelling of the command.
 */
import assert from "node:assert/strict";
import { readdir, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { describe, it } from "node:test";
import {
  GIT,
  gitAt,
  headOf,
  isAncestor,
  mergeNoFf,
  refArg,
  resetClean,
  updateRef,
} from "../../src/harness-seed/loop/git.ts";
import { runRef } from "../../src/harness-seed/loop/repo.ts";
import { ctxRecorder } from "../helpers/ctx-recorder.ts";
import { fixtureGit } from "../helpers/snapshot-fixtures.ts";
import { shellExec as sh } from "../helpers/posix-shell.ts";
import { tmpDir } from "../helpers/tmp.ts";

async function repo(files: Record<string, string> = { "index.html": "<canvas></canvas>\n" }): Promise<string> {
  const dir = await tmpDir("studio-git-");
  await fixtureGit(dir, ["init", "-q", "-b", "main"]);
  for (const [name, text] of Object.entries(files)) await writeFile(path.join(dir, name), text);
  await fixtureGit(dir, ["add", "-A"]);
  await fixtureGit(dir, ["commit", "-q", "-m", "start"]);
  return dir;
}

/** A recorder whose `run.exec` is a real shell: a worktree path runs there, `{ project }` runs in `projects[project]`. */
function shellCtx(projects: Record<string, string> = {}) {
  return ctxRecorder({
    handlers: { "run.exec": (p) => sh(String(p.command), p.cwd ? String(p.cwd) : projects[String(p.project)]!) },
  });
}

const commands = (recorder: ReturnType<typeof shellCtx>) => recorder.paramsOf("run.exec").map((p) => String(p.command));
const HOSTILE = 'a judge\'s `touch backtick` reason, $(touch dollar), "quoted"; touch semi';

describe("the command lines", () => {
  it("refuse a revision that is not a hash or HEAD, before any shell sees it", () => {
    for (const bad of ["HEAD; touch PWNED", "$(touch PWNED)", "--output=/tmp/x", "main", "", "0123ABZ"]) {
      assert.throws(() => GIT.merge(bad, { message: "m" }), /not a commit hash/, bad);
      assert.throws(() => GIT.reset(bad), /not a commit hash/, bad);
      assert.throws(() => GIT.isAncestor(bad), /not a commit hash/, bad);
      assert.throws(() => GIT.updateRef(runRef("run_a", "integration"), bad), /not a commit hash/, bad);
    }
    assert.equal(GIT.reset("HEAD"), "git reset -q --hard HEAD");
  });

  it("write only the studio's own refs", () => {
    assert.equal(refArg(runRef("run_a", "workers", "plaza-lighting")), "refs/studio/runs/run_a/workers/plaza-lighting");
    for (const bad of [
      "refs/heads/main",
      "refs/studio/runs/a b",
      "refs/studio/runs/$(x)",
      "refs/studio/runs/../../heads/main",
      "HEAD",
    ]) {
      assert.throws(() => refArg(bad), /not a studio ref/, bad);
    }
  });
});

describe("running git in a worktree", () => {
  // Flipped (one Loop): it drove `commitAll`, whose only callers were the web Loop's; the command
  // lines it ran are the same two.
  it("commits a model-written message exactly, in two commands, and runs none of it", async () => {
    const dir = await repo();
    const recorder = shellCtx();
    await writeFile(path.join(dir, "new.js"), "export const x = 1;\n");
    await gitAt(recorder.ctx, dir, GIT.addAll, { label: "facet:hud:git" });
    await gitAt(recorder.ctx, dir, GIT.commit(HOSTILE, { allowEmpty: true }), { label: "facet:hud:git" });
    assert.equal(await fixtureGit(dir, ["log", "-1", "--format=%B"]), HOSTILE);
    assert.equal(await fixtureGit(dir, ["status", "--porcelain"]), "", "everything was staged and committed");
    assert.deepEqual((await readdir(dir)).sort(), [".git", "index.html", "new.js"], "nothing in the message ran");
    assert.equal(commands(recorder)[0], "git add -A");
    assert.match(commands(recorder)[1]!, /commit -q --allow-empty -m '/);
    assert.deepEqual(
      recorder.paramsOf("run.exec").map((p) => p.label),
      ["facet:hud:git", "facet:hud:git"],
    );
  });

  it("keeps the leading column of porcelain status unless asked to trim both ends", async () => {
    const dir = await repo();
    await writeFile(path.join(dir, "index.html"), "<canvas id=x></canvas>\n");
    const recorder = shellCtx();
    assert.equal(await gitAt(recorder.ctx, dir, GIT.status), " M index.html");
    assert.equal(await gitAt(recorder.ctx, dir, GIT.status, { trim: "both" }), "M index.html");
  });

  it("throws what the command said on a non-zero exit, clipped, or in the caller's own words", async () => {
    const dir = await repo();
    const recorder = shellCtx();
    await assert.rejects(
      gitAt(recorder.ctx, dir, GIT.diffStat("0".repeat(40))),
      /bad (object|revision)|unknown revision/i,
    );
    await assert.rejects(
      gitAt(recorder.ctx, dir, GIT.diffStat("0".repeat(40)), {
        failure: (exec, command) => `in facet hud: ${command} — code=${exec.code}`,
      }),
      /^Error: in facet hud: git diff --stat 0{40} HEAD .* — code=128$/,
    );
  });

  it("answers whether a commit is already on the branch, and no when the command cannot run", async () => {
    const dir = await repo();
    const recorder = shellCtx();
    const head = await headOf(recorder.ctx, dir);
    assert.equal(await isAncestor(recorder.ctx, dir, head), true);
    assert.equal(await isAncestor(recorder.ctx, dir, "0".repeat(40)), false);
    assert.equal(await isAncestor(recorder.ctx, dir, "not a hash"), false, "a refused revision is a no, not a crash");
    recorder.handle("run.exec", () => {
      throw new Error("the host is gone");
    });
    assert.equal(await isAncestor(recorder.ctx, dir, head), false);
  });

  it("points a studio ref at a commit", async () => {
    const dir = await repo();
    const recorder = shellCtx();
    const head = await headOf(recorder.ctx, dir);
    await updateRef(recorder.ctx, dir, runRef("run_a", "integration"), head);
    assert.equal(await fixtureGit(dir, ["rev-parse", runRef("run_a", "integration")]), head);
  });

  it("resets and cleans, stops at the first failure, and tries every step when best-effort", async () => {
    const dir = await repo();
    const recorder = shellCtx();
    await writeFile(path.join(dir, "index.html"), "edited\n");
    await writeFile(path.join(dir, "stray.js"), "stray\n");
    await resetClean(recorder.ctx, dir, "HEAD");
    assert.equal(await fixtureGit(dir, ["status", "--porcelain"]), "");
    await writeFile(path.join(dir, "stray.js"), "stray\n");
    const missing = "f".repeat(40);
    await assert.rejects(resetClean(recorder.ctx, dir, missing));
    assert.ok(await stat(path.join(dir, "stray.js")), "a failed reset stops before the clean");
    await resetClean(recorder.ctx, dir, missing, { bestEffort: true });
    await assert.rejects(stat(path.join(dir, "stray.js")), "best-effort still cleans after a reset that failed");
  });
});

/** main with `ours` in shared.js, a branch `theirs` that changed the same line differently. */
async function conflicting(): Promise<{ dir: string; theirs: string; before: string }> {
  const dir = await repo({ "shared.js": "export const v = 0;\n" });
  await fixtureGit(dir, ["checkout", "-q", "-b", "theirs"]);
  await writeFile(path.join(dir, "shared.js"), "export const v = 2;\n");
  await fixtureGit(dir, ["commit", "-q", "-am", "theirs"]);
  const theirs = await fixtureGit(dir, ["rev-parse", "HEAD"]);
  await fixtureGit(dir, ["checkout", "-q", "main"]);
  await writeFile(path.join(dir, "shared.js"), "export const v = 1;\n");
  await fixtureGit(dir, ["commit", "-q", "-am", "ours"]);
  return { dir, theirs, before: await fixtureGit(dir, ["rev-parse", "HEAD"]) };
}

describe("merging", () => {
  it("merges with a merge commit of its own and the message as written", async () => {
    const dir = await repo({ "a.js": "a\n" });
    await fixtureGit(dir, ["checkout", "-q", "-b", "side"]);
    await writeFile(path.join(dir, "b.js"), "b\n");
    await fixtureGit(dir, ["add", "-A"]);
    await fixtureGit(dir, ["commit", "-q", "-m", "side"]);
    const side = await fixtureGit(dir, ["rev-parse", "HEAD"]);
    await fixtureGit(dir, ["checkout", "-q", "main"]);
    const recorder = shellCtx();
    const merged = await mergeNoFf(recorder.ctx, dir, side, { message: HOSTILE, noEdit: true });
    assert.deepEqual(merged, { ok: true, union: false });
    assert.equal(
      (await fixtureGit(dir, ["rev-list", "--parents", "-n", "1", "HEAD"])).split(" ").length,
      3,
      "a merge commit, never a fast-forward",
    );
    assert.equal(await fixtureGit(dir, ["log", "-1", "--format=%s"]), HOSTILE);
  });

  it("aborts a conflict it cannot resolve: the branch is where it was and the worktree is clean", async () => {
    const { dir, theirs, before } = await conflicting();
    const recorder = shellCtx();
    let asked = 0;
    const merged = await mergeNoFf(recorder.ctx, dir, theirs, {
      message: "integrate",
      listConflicts: true,
      resolve: async () => (asked++, { ok: false, reason: "not the wiring block" }),
    });
    assert.equal(merged.ok, false);
    assert.equal(asked, 1, "the resolver gets its one try");
    assert.deepEqual(!merged.ok && merged.conflicts, ["shared.js"]);
    assert.ok(!merged.ok && merged.error.length > 0, "what git said is kept for the caller");
    assert.equal(await fixtureGit(dir, ["rev-parse", "HEAD"]), before);
    assert.equal(await fixtureGit(dir, ["status", "--porcelain"]), "", "no half-merged file is left behind");
    await assert.rejects(stat(path.join(dir, ".git", "MERGE_HEAD")), "the merge was aborted");
    assert.equal(commands(recorder).at(-1), GIT.mergeAbort);
  });

  it("keeps a conflict its resolver settled, and never aborts it", async () => {
    const { dir, theirs } = await conflicting();
    const recorder = shellCtx();
    const merged = await mergeNoFf(recorder.ctx, dir, theirs, {
      message: "integrate",
      resolve: async () => {
        await writeFile(path.join(dir, "shared.js"), "export const v = 3;\n");
        await fixtureGit(dir, ["add", "-A"]);
        await fixtureGit(dir, ["commit", "-q", "--no-edit"]);
        return { ok: true, duplicates: 0 };
      },
    });
    assert.equal(merged.ok, true);
    assert.equal(merged.ok && merged.union, true);
    assert.ok(!commands(recorder).includes(GIT.mergeAbort));
  });

  it("lets a host that throws throw, unless the caller reads that as a failed merge", async () => {
    const recorder = ctxRecorder({
      handlers: {
        "run.exec": (p) => {
          if (String(p.command).includes(" merge ")) throw new Error("the host is gone");
          return { code: 0, stdout: "", stderr: "" };
        },
      },
    });
    await assert.rejects(mergeNoFf(recorder.ctx, "/w", "a".repeat(40), { message: "m" }), /the host is gone/);
    const failed = await mergeNoFf(recorder.ctx, "/w", "a".repeat(40), { message: "m", rpcErrors: "fail" });
    assert.equal(failed.ok, false);
    assert.equal(!failed.ok && failed.error, "the host is gone");
  });
});
