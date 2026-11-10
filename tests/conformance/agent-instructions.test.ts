import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// Developer instruction files and the docs they route to. Their links are the only way a fresh
// agent finds the recipes, so a broken one is a broken instruction.
const root = path.resolve(import.meta.dirname, "../..");
const ROUTED = ["AGENTS.md", "src/AGENTS.md", "tests/AGENTS.md", "docs/agent/glossary.md", "docs/agent/recipes.md"];
const IMPORTS = ["CLAUDE.md", "src/CLAUDE.md", "tests/CLAUDE.md"];
// scripts/build.mjs copies these trees into every user's workspace, where in-app engines read
// any AGENTS.md/CLAUDE.md as their own instructions.
const SHIPPED = ["src/harness-seed", "src/game-template"];
const PAYLOAD = new Set(["src/game-template/CLAUDE.md"]);

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

/** Files whose backticked paths and `npm run` names are checked: the routed files and the helper catalogue. */
const NAMED = [...ROUTED, "tests/helpers/README.md"];
/** Folders the walk skips: installs, build output and local-only state, none of them repository source. */
const UNWALKED = new Set(["node_modules", ".git", "dist", "out", ".studio-dev", ".vite"]);
/** A code span that names a repository file (by extension) or folder (trailing slash): no command, glob or placeholder. */
const PATH_TOKEN = /^\.?[\w@-][\w@.-]*(?:\/[\w@.-]+)*(?:\.(?:ts|tsx|mts|mjs|cjs|js|json|md|css|yml)|\/)$/;
/** Paths a code span may name that are not in the repository: build output and ignored local state. */
const OUTSIDE = /^(?:dist|out|\.studio-dev)\//;
/** Named folders that are right to be absent here: a game's own folder, and one the eval tooling makes on its first promote. */
const ELSEWHERE = new Set([".genex/items/", "evals/baselines/"]);

/** Every file under `base` as a relative path, and every folder as one with a trailing slash. */
function repositoryPaths(base: string): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(path.join(base, dir), { withFileTypes: true })) {
      if (UNWALKED.has(entry.name)) continue;
      const rel = dir ? `${dir}/${entry.name}` : entry.name;
      if (!entry.isDirectory()) found.push(rel);
      else {
        found.push(`${rel}/`);
        walk(rel);
      }
    }
  };
  walk("");
  return found;
}

/**
 * Code spans in `file` that name a file or folder no path in the repository ends with. Instruction
 * files name paths relative to the folder they talk about (`loop/git.ts`, `words.ts`), so a name
 * passes when any repository path is it or ends with it.
 */
function missingPaths(base: string, file: string, paths = repositoryPaths(base)): string[] {
  const text = unfenced(fs.readFileSync(path.join(base, file), "utf8"));
  const named = new Set([...text.matchAll(/`([^`\n]+)`/g)].map((m) => m[1] ?? ""));
  const exists = (name: string) => paths.some((p) => p === name || p.endsWith(`/${name}`));
  const checked = (name: string) => PATH_TOKEN.test(name) && !OUTSIDE.test(name) && !ELSEWHERE.has(name);
  return [...named].filter((name) => checked(name) && !exists(name)).map((name) => `${file}: ${name}`);
}

/** `npm run <name>` commands in `file` that package.json does not define. */
function missingScripts(base: string, file: string): string[] {
  const scripts = JSON.parse(fs.readFileSync(path.join(base, "package.json"), "utf8")).scripts ?? {};
  const text = fs.readFileSync(path.join(base, file), "utf8");
  const named = new Set([...text.matchAll(/npm run ([a-z][\w:-]*)/g)].map((m) => m[1] ?? ""));
  return [...named].filter((name) => !(name in scripts)).map((name) => `${file}: npm run ${name}`);
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

function scratch(t: { after: (fn: () => void) => void }, files: Record<string, string>): string {
  const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "agent-instructions-")));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  for (const [file, text] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, file)), { recursive: true });
    fs.writeFileSync(path.join(dir, file), text);
  }
  return dir;
}

test("link check flags missing files, missing anchors and escapes, and ignores code and URLs", (t) => {
  const dir = scratch(t, {
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

test("path check flags a missing file and folder, and passes relative names, globs and build output", (t) => {
  const dir = scratch(t, {
    "src/loop/git.ts": "",
    "src/renderer/words.ts": "",
    "AGENTS.md": [
      "`src/loop/git.ts` `loop/git.ts` `words.ts` `src/loop/` `loop/`",
      "`loop/evidence.ts` `src/gone/` `gone.md`",
      "`src/**` `prompts/*.md` `<workspace>/archive/<date>/` `~/AI Games` `dist/resources/tsc.js` `.studio-dev/notes/a.md`",
      "`npm run lint` `payload as X` `data-*`",
      "```",
      "`fenced/missing.ts`",
      "```",
    ].join("\n"),
  });
  assert.deepEqual(missingPaths(dir, "AGENTS.md"), [
    "AGENTS.md: loop/evidence.ts",
    "AGENTS.md: src/gone/",
    "AGENTS.md: gone.md",
  ]);
});

test("script check flags an npm run name package.json does not define", (t) => {
  const dir = scratch(t, {
    "package.json": JSON.stringify({ scripts: { lint: "x", "verify:context": "y" } }),
    "AGENTS.md": "Run `npm run lint`, then `npm run verify:context -- --area a` and npm run gone:script.",
  });
  assert.deepEqual(missingScripts(dir, "AGENTS.md"), ["AGENTS.md: npm run gone:script"]);
});

test("every file, folder and npm script the developer instructions name exists", () => {
  const paths = repositoryPaths(root);
  assert.deepEqual(
    NAMED.flatMap((file) => [...missingPaths(root, file, paths), ...missingScripts(root, file)]),
    [],
  );
});

test("import check accepts @AGENTS.md plus one line and rejects links, extra text and orphans", (t) => {
  const dir = scratch(t, {
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

test("shipped-tree check finds nested and differently cased instruction files but allows the template payload", (t) => {
  const dir = scratch(t, {
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
