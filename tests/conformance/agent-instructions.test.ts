import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { gitFile } from "../helpers/git.ts";
import { tmpDir } from "../helpers/tmp.ts";

// Developer instruction files and the docs they route to. Their links are the only way a fresh
// agent finds the recipes, so a broken one is a broken instruction.
const root = path.resolve(import.meta.dirname, "../..");
const ROUTED = ["AGENTS.md", "src/AGENTS.md", "tests/AGENTS.md", "docs/agent/glossary.md", "docs/agent/recipes.md"];
const IMPORTS = ["CLAUDE.md", "src/CLAUDE.md", "tests/CLAUDE.md"];
// scripts/build.mjs copies these trees into every user's workspace, where in-app engines read
// any AGENTS.md/CLAUDE.md as their own instructions.
const SHIPPED = ["src/harness-seed", "src/game-template"];
const PAYLOAD = new Set(["src/game-template/CLAUDE.md"]);
/** The engineering skills AGENTS.md routes to; `.claude/skills/` mirrors them byte for byte. */
const SKILLS = [
  "add-ipc-channel",
  "add-event-type",
  "add-plugin-tool",
  "run-area-tests",
  "verify-ui-via-dev-control",
  "harness-incident-fix",
].map((name) => `.agents/skills/${name}/SKILL.md`);
/**
 * Documents whose backticked paths and `npm run` names are checked, each with its home: the folder
 * a file named without one must sit under. A folder's AGENTS.md talks about that folder, and the
 * helper catalogue about its own; the root file, the docs and the skills talk about the whole tree.
 */
const NAMED: Record<string, string> = {
  "AGENTS.md": "",
  "src/AGENTS.md": "src/",
  "tests/AGENTS.md": "tests/",
  "tests/helpers/README.md": "tests/helpers/",
  "docs/agent/glossary.md": "",
  "docs/agent/recipes.md": "",
  "docs/agent/verification.md": "",
  ...Object.fromEntries(SKILLS.map((file) => [file, ""])),
};
/** A code span that names a repository file (by extension) or folder (trailing slash): no command, glob or placeholder. */
const PATH_TOKEN = /^\.?[\w@-][\w@.-]*(?:\/[\w@.-]+)*(?:\.(?:ts|tsx|mts|mjs|cjs|js|json|md|css|yml)|\/)$/;
/** Paths a code span may name that are not in the repository: build output and ignored local state. */
const OUTSIDE = /^(?:dist|out|\.studio-dev)\//;
/** Names that are right to be absent here: a game's own folder, and one the eval tooling makes on its first promote. */
const ELSEWHERE = new Set([".genex/items/", "evals/baselines/"]);
/** Room for git's listing of every file in the repository; Node's default for a child's output is 1 MB. */
const LISTING_BYTES = 64 * 1024 * 1024;

const unfenced = (text: string) => text.replace(/^\s*(```|~~~)[\s\S]*?^\s*\1.*$/gm, "");
const prose = (text: string) => unfenced(text).replace(/`[^`\n]*`/g, "");
// Same slug rule as scripts/check-agent-context.ts, so anchors that pass here pass verify:context.
const slugs = (text: string) =>
  [...unfenced(text).matchAll(/^#+\s+(.+)$/gm)].map((m) =>
    m[1]!
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s-]/gu, "")
      .replace(/\s+/g, "-"),
  );

/** Relative Markdown links in `file` whose target file or heading anchor does not exist. */
function brokenLinks(base: string, file: string): string[] {
  const text = fs.readFileSync(path.join(base, file), "utf8"),
    broken: string[] = [];
  for (const [, raw] of prose(text).matchAll(/\[[^\]]*\]\(([^)\s]+)\)/g)) {
    const link = raw!.replace(/^<|>$/g, "");
    if (/^[a-z][a-z\d+.-]*:/i.test(link)) continue;
    const [target, anchor] = link.split("#");
    const dest = target ? path.resolve(path.dirname(path.join(base, file)), target) : path.join(base, file);
    if (!dest.startsWith(base + path.sep) || !fs.existsSync(dest)) {
      broken.push(`${file}: ${link}`);
      continue;
    }
    if (anchor && dest.endsWith(".md") && !slugs(fs.readFileSync(dest, "utf8")).includes(anchor))
      broken.push(`${file}: ${link}`);
  }
  return broken;
}

/**
 * The files git tracks or would add under `base`. Asking git, not the disk, keeps ignored local
 * state out: a worktree under `.claude/worktrees/` holds a copy of every file, and a name that is
 * gone from the tree would still be found there.
 */
async function repositoryFiles(base: string): Promise<string[]> {
  const list = async (...flags: string[]) => {
    const { stdout } = await gitFile(["ls-files", "-z", ...flags], { cwd: base, maxBuffer: LISTING_BYTES });
    return String(stdout).split("\0").filter(Boolean);
  };
  const deleted = new Set(await list("--deleted"));
  return (await list("--cached", "--others", "--exclude-standard")).filter((file) => !deleted.has(file));
}

/** `files`, plus every folder that holds one, written with a trailing slash. */
function withFolders(files: string[]): string[] {
  const folders = new Set<string>();
  for (const file of files) {
    const parts = file.split("/");
    for (let depth = 1; depth < parts.length; depth += 1) folders.add(`${parts.slice(0, depth).join("/")}/`);
  }
  return [...files, ...folders];
}

/**
 * Code spans in `file` that name a file or folder `paths` does not hold. Instruction files name
 * paths relative to the folder they talk about (`loop/git.ts`, `e2e/`), so a name with a folder
 * passes when a path is it or ends with it. A file named without a folder (`words.ts`) must be a
 * root file or sit under `home`. The check reads code spans only: a path inside a command, a
 * folder written without its slash and an extension PATH_TOKEN does not list are not checked, and
 * a bare name is only as strong as it is unique under its home.
 */
function missingPaths(base: string, file: string, paths: string[], home = ""): string[] {
  const text = unfenced(fs.readFileSync(path.join(base, file), "utf8"));
  const named = new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? ""));
  const exists = (name: string) => {
    const hasFolder = name.slice(0, -1).includes("/");
    return paths.some((p) => p === name || ((hasFolder || p.startsWith(home)) && p.endsWith(`/${name}`)));
  };
  const checked = (name: string) => PATH_TOKEN.test(name) && !OUTSIDE.test(name) && !ELSEWHERE.has(name);
  return [...named].filter((name) => checked(name) && !exists(name)).map((name) => `${file}: ${name}`);
}

/** `npm run <name>` commands in `file` that package.json does not define. */
function missingScripts(base: string, file: string): string[] {
  const scripts = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).scripts ?? {};
  const text = fs.readFileSync(path.join(base, file), "utf8");
  const named = new Set([...text.matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => m[1] ?? ""));
  return [...named].filter((name) => !Object.hasOwn(scripts, name)).map((name) => `${file}: npm run ${name}`);
}

/** CLAUDE.md files that do not import their sibling AGENTS.md as the first line. */
function missingImports(base: string, files: string[]): string[] {
  return files.filter((file) => {
    const lines = fs
      .readFileSync(path.join(base, file), "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter(Boolean);
    return (
      lines[0] !== "@AGENTS.md" || lines.length > 2 || !fs.existsSync(path.join(base, path.dirname(file), "AGENTS.md"))
    );
  });
}

/** Developer instruction files inside trees that ship to user workspaces. */
function shippedInstructions(base: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(base, dir), { withFileTypes: true })) {
      const rel = `${dir}/${entry.name}`;
      if (entry.isDirectory()) walk(rel);
      else if (/^(agents|claude)\.md$/i.test(entry.name) && !PAYLOAD.has(rel)) found.push(rel);
    }
  };
  for (const dir of SHIPPED) if (fs.existsSync(path.join(base, dir))) walk(dir);
  return found;
}

/** A temp folder holding `files`, removed when this test file finishes. */
async function scratch(files: Record<string, string>): Promise<string> {
  const dir = fs.realpathSync(await tmpDir("agent-instructions-"));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

test("link check flags missing files, missing anchors and escapes, and ignores code and URLs", async () => {
  const dir = await scratch({
    "docs/a.md": "# A\n\n## Real heading\n",
    "AGENTS.md": [
      "[ok](docs/a.md) [ok anchor](docs/a.md#real-heading) [self](#top) [web](https://example.com)",
      "[gone](docs/missing.md) [bad anchor](docs/a.md#nope) [escape](../outside.md)",
      "`[code](docs/missing.md)`",
      "```",
      "[fenced](docs/missing.md)",
      "```",
      "# Top",
    ].join("\n"),
  });
  assert.deepEqual(brokenLinks(dir, "AGENTS.md"), [
    "AGENTS.md: docs/missing.md",
    "AGENTS.md: docs/a.md#nope",
    "AGENTS.md: ../outside.md",
  ]);
});

test("every relative link in the developer instructions, glossary and recipes resolves", () => {
  for (const file of ROUTED) assert.ok(fs.existsSync(path.join(root, file)), `${file} is missing`);
  assert.deepEqual(
    ROUTED.flatMap((file) => brokenLinks(root, file)),
    [],
  );
});

test("path check flags a missing file and folder, and passes relative names, globs and build output", async () => {
  const dir = await scratch({
    "AGENTS.md": [
      "`src/loop/git.ts` `loop/git.ts` `words.ts` `src/loop/` `loop/` `package.json`",
      "`loop/evidence.ts` `src/gone/` `gone.md`",
      "`src/**` `prompts/*.md` `<workspace>/archive/<date>/` `~/AI Games` `dist/resources/tsc.js` `.studio-dev/notes/a.md`",
      "`npm run lint` `payload as X` `data-*` `.genex/items/`",
      "```",
      "`fenced/missing.ts`",
      "```",
    ].join("\n"),
  });
  const paths = withFolders(["package.json", "src/loop/git.ts", "src/renderer/words.ts"]);
  assert.deepEqual(missingPaths(dir, "AGENTS.md", paths), [
    "AGENTS.md: loop/evidence.ts",
    "AGENTS.md: src/gone/",
    "AGENTS.md: gone.md",
  ]);
});

test("path check wants a file named without a folder under the document's home, or at the root", async () => {
  const dir = await scratch({ "tests/AGENTS.md": "`rig.ts` `git.ts` `loop/git.ts` `package.json` `helpers/`" });
  const paths = withFolders(["package.json", "src/loop/git.ts", "tests/helpers/rig.ts"]);
  // git.ts exists, but only under src/: a namesake elsewhere does not stand in for a helper that is gone.
  assert.deepEqual(missingPaths(dir, "tests/AGENTS.md", paths, "tests/"), ["tests/AGENTS.md: git.ts"]);
  assert.deepEqual(missingPaths(dir, "tests/AGENTS.md", paths), []);
});

test("the repository listing leaves out ignored files and files removed from the working tree", async () => {
  const dir = await scratch({
    ".gitignore": "local/\n",
    "kept.ts": "",
    "removed.ts": "",
    "local/worktree/kept.ts": "",
  });
  await gitFile(["init", "--quiet"], { cwd: dir });
  await gitFile(["add", "removed.ts"], { cwd: dir });
  fs.rmSync(path.join(dir, "removed.ts"));
  assert.deepEqual((await repositoryFiles(dir)).sort(), [".gitignore", "kept.ts"]);
});

test("script check flags an npm run name package.json does not define", async () => {
  const dir = await scratch({
    "package.json": JSON.stringify({ scripts: { lint: "x", "verify:context": "y" } }),
    "AGENTS.md": "Run `npm run lint`, then `npm run verify:context -- --area a` and npm run gone:script.",
  });
  assert.deepEqual(missingScripts(dir, "AGENTS.md"), ["AGENTS.md: npm run gone:script"]);
});

test("the paths and npm scripts the developer instructions and engineering skills name exist", async () => {
  const paths = withFolders(await repositoryFiles(root));
  assert.deepEqual(
    Object.entries(NAMED).flatMap(([file, home]) => [
      ...missingPaths(root, file, paths, home),
      ...missingScripts(root, file),
    ]),
    [],
  );
});

test("import check accepts @AGENTS.md plus one line and rejects links, extra text and orphans", async () => {
  const dir = await scratch({
    "AGENTS.md": "# Root",
    "CLAUDE.md": "@AGENTS.md\n",
    "a/AGENTS.md": "# A",
    "a/CLAUDE.md": "@AGENTS.md\nFolder notes.\n",
    "b/AGENTS.md": "# B",
    "b/CLAUDE.md": "Read [AGENTS.md](AGENTS.md).\n",
    "c/AGENTS.md": "# C",
    "c/CLAUDE.md": "@AGENTS.md\none\ntwo\n",
    "d/CLAUDE.md": "@AGENTS.md\n",
  });
  assert.deepEqual(missingImports(dir, ["CLAUDE.md", "a/CLAUDE.md", "b/CLAUDE.md", "c/CLAUDE.md", "d/CLAUDE.md"]), [
    "b/CLAUDE.md",
    "c/CLAUDE.md",
    "d/CLAUDE.md",
  ]);
});

test("each CLAUDE.md imports its folder AGENTS.md", () => {
  assert.deepEqual(missingImports(root, IMPORTS), []);
});

test("shipped-tree check finds nested and differently cased instruction files but allows the template payload", async () => {
  const dir = await scratch({
    "src/game-template/CLAUDE.md": "payload",
    "src/game-template/CLAUDE.own.md": "payload",
    "src/game-template/src/AGENTS.md": "dev",
    "src/harness-seed/loop/claude.md": "dev",
    "src/harness-seed/AGENTS.md": "dev",
    "src/main/AGENTS.md": "fine",
  });
  assert.deepEqual(shippedInstructions(dir).sort(), [
    "src/game-template/src/AGENTS.md",
    "src/harness-seed/AGENTS.md",
    "src/harness-seed/loop/claude.md",
  ]);
});

test("no developer AGENTS.md or CLAUDE.md ships inside harness-seed or game-template", () => {
  assert.ok(
    fs.existsSync(path.join(root, "src/game-template/CLAUDE.md")),
    "the template payload moved; update PAYLOAD",
  );
  assert.deepEqual(shippedInstructions(root), []);
});
