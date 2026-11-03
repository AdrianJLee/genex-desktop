import ts from "@typescript/typescript6";
import path from "node:path";
import fs from "node:fs";
import { builtinModules } from "node:module";
import { pathToFileURL } from "node:url";
import { filesBelow } from "./studio-dev/files.mjs";
/** The URL the serve layer gives the page world's own modules; see scripts/build.mjs. */
const SERVED_PAGE = /^\/vendor\/studio\/([A-Za-z0-9_.-]+\.js)$/;
/** A source file any of the checks read: JavaScript or TypeScript, plain, CommonJS or module. */
const SCRIPT = /\.[cm]?[jt]sx?$/;

function compilerOptions(root: string): ts.CompilerOptions {
  const config = ts.readConfigFile(path.join(root, "tsconfig.json"), ts.sys.readFile);
  return ts.parseJsonConfigFileContent(config.config, ts.sys, root).options;
}
const typeOnlyImport = (node: ts.ImportDeclaration) => {
  const c = node.importClause;
  return (
    !!c &&
    (c.isTypeOnly ||
      (!c.name &&
        !!c.namedBindings &&
        ts.isNamedImports(c.namedBindings) &&
        c.namedBindings.elements.length > 0 &&
        c.namedBindings.elements.every((e) => e.isTypeOnly)))
  );
};
const typeOnlyExport = (node: ts.ExportDeclaration) =>
  node.isTypeOnly ||
  (!!node.exportClause &&
    ts.isNamedExports(node.exportClause) &&
    node.exportClause.elements.length > 0 &&
    node.exportClause.elements.every((e) => e.isTypeOnly));

/** A dynamic `import(…)` or a `require(…)`, with or without its argument. */
function isRuntimeLoad(node: ts.Node): node is ts.CallExpression {
  if (!ts.isCallExpression(node)) return false;
  const callee = node.expression;
  return callee.kind === ts.SyntaxKind.ImportKeyword || (ts.isIdentifier(callee) && callee.text === "require");
}

/** An `import x = require("…")` that is not type-only: its module expression. */
function importEqualsTarget(node: ts.Node): ts.Expression | undefined {
  if (!ts.isImportEqualsDeclaration(node) || node.isTypeOnly) return undefined;
  return ts.isExternalModuleReference(node.moduleReference) ? node.moduleReference.expression : undefined;
}

/** The browser-side walk: what is forbidden, what was visited, and what it found. */
interface BrowserWalk {
  root: string;
  options: ts.CompilerOptions;
  builtin: Set<string>;
  errors: string[];
  seen: Set<string>;
}

/** One file being walked, and the chain of imports that reached it. */
interface BrowserFile {
  file: string;
  chain: string[];
  source: ts.SourceFile;
}

// The page world addresses its own siblings by the URL the studio serves them at
// (scripts/build.mjs keeps that specifier external so one page holds one hook). Resolve it
// back to the file it is built from, so the walk does not stop at the served URL.
function followServedPage(walk: BrowserWalk, from: BrowserFile, name: string, served: string, origin: string) {
  // Served as the bundle's .js name, built from the page world's .ts source.
  const rel = `src/page/${served.replace(/\.js$/, ".ts")}`;
  const target = path.join(walk.root, rel);
  if (!fs.existsSync(target)) {
    walk.errors.push(`${origin}: ${name} is served from ${rel}, which does not exist`);
    return;
  }
  visitBrowserFile(walk, target, [...from.chain, rel]);
}

/** One runtime import of a browser file: forbidden, unresolved, or followed. */
function browserEdge(walk: BrowserWalk, from: BrowserFile, spec: ts.Expression, at: ts.Node) {
  const loc = from.source.getLineAndCharacterOfPosition(at.getStart());
  const origin = `${path.relative(walk.root, from.file)}:${loc.line + 1}`;
  if (!ts.isStringLiteralLike(spec)) {
    walk.errors.push(`${origin}: nonliteral runtime import cannot be verified; use a literal browser module`);
    return;
  }
  const name = spec.text;
  if (name === "electron" || name.startsWith("node:") || walk.builtin.has(name)) {
    walk.errors.push(`${origin}: forbidden browser runtime dependency ${name} via ${from.chain.join(" → ")}`);
    return;
  }
  const served = SERVED_PAGE.exec(name);
  if (served) {
    followServedPage(walk, from, name, served[1], origin);
    return;
  }
  const resolved = ts.resolveModuleName(name, from.file, walk.options, ts.sys).resolvedModule;
  if (!resolved) {
    walk.errors.push(`${origin}: unresolved runtime import ${name}`);
    return;
  }
  const target = resolved.resolvedFileName;
  const rel = path.relative(walk.root, target).replaceAll(path.sep, "/");
  if (/^src\/(main|preload|substrate)\//.test(rel)) {
    walk.errors.push(`${origin}: forbidden runtime edge to ${rel} via ${from.chain.join(" → ")}`);
    return;
  }
  if (!resolved.isExternalLibraryImport && !target.endsWith(".d.ts"))
    visitBrowserFile(walk, target, [...from.chain, rel]);
}

function walkBrowserImports(walk: BrowserWalk, from: BrowserFile, node: ts.Node): void {
  const equalsTarget = importEqualsTarget(node);
  if (ts.isImportDeclaration(node)) {
    if (typeOnlyImport(node)) return;
    browserEdge(walk, from, node.moduleSpecifier, node);
  } else if (ts.isExportDeclaration(node) && node.moduleSpecifier) {
    if (typeOnlyExport(node)) return;
    browserEdge(walk, from, node.moduleSpecifier, node);
  } else if (equalsTarget) browserEdge(walk, from, equalsTarget, node);
  else if (isRuntimeLoad(node)) {
    if (node.arguments[0]) browserEdge(walk, from, node.arguments[0], node);
    else walk.errors.push(`${from.file}: runtime import without target`);
  }
  ts.forEachChild(node, (child) => walkBrowserImports(walk, from, child));
}

function visitBrowserFile(walk: BrowserWalk, file: string, chain: string[]): void {
  if (walk.seen.has(file)) return;
  walk.seen.add(file);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  walkBrowserImports(walk, { file, chain, source }, source);
}

export function checkBoundaries(root: string): string[] {
  const walk: BrowserWalk = {
    root,
    options: compilerOptions(root),
    builtin: new Set(builtinModules.map((x) => x.replace(/^node:/, ""))),
    errors: [],
    seen: new Set<string>(),
  };
  // src/page is the studio's own code on a game's page: it may not reach the main process, the
  // preload or the substrate any more than the renderer may. src/game-template stays out — that
  // is a game, not the app.
  for (const dir of ["src/renderer", "src/shared", "src/page"])
    for (const file of filesBelow(path.join(root, dir), dir).filter((f: string) => SCRIPT.test(f)))
      visitBrowserFile(walk, path.join(root, file), [file]);
  return walk.errors;
}
/** A runtime import between two files under the root, as root-relative paths. */
export interface ImportEdge {
  from: string;
  to: string;
  line: number;
}

/** The file a specifier names: a relative file as written, else what the resolver finds in the repo. */
function importTarget(file: string, name: string, options: ts.CompilerOptions): string | undefined {
  if (name.startsWith(".")) {
    const direct = path.resolve(path.dirname(file), name);
    if (fs.existsSync(direct) && fs.statSync(direct).isFile()) return direct;
  }
  const resolved = ts.resolveModuleName(name, file, options, ts.sys).resolvedModule;
  if (!resolved || resolved.isExternalLibraryImport || resolved.resolvedFileName.endsWith(".d.ts")) return undefined;
  return resolved.resolvedFileName;
}

/** The static (and, with `dynamic`, literal dynamic) import specifiers of a file, with their nodes. */
function importSpecifiers(node: ts.Node, dynamic: boolean, found: Array<[ts.Expression, ts.Node]>): void {
  if (ts.isImportDeclaration(node)) {
    if (!typeOnlyImport(node)) found.push([node.moduleSpecifier, node]);
    return;
  }
  if (ts.isExportDeclaration(node)) {
    if (node.moduleSpecifier && !typeOnlyExport(node)) found.push([node.moduleSpecifier, node]);
    return;
  }
  if (dynamic && isRuntimeLoad(node) && node.arguments[0]) found.push([node.arguments[0], node]);
  ts.forEachChild(node, (child) => importSpecifiers(child, dynamic, found));
}

/**
 * The runtime imports of one source file that land on another file under `src/`: import and
 * export-from declarations whose bindings are not all erased types, plus — with `dynamic` — a
 * literal `import()` or `require()`. Package imports are not edges.
 */
export function runtimeImports(root: string, rel: string, options: ts.CompilerOptions, dynamic: boolean): ImportEdge[] {
  const file = path.join(root, rel);
  const source = ts.createSourceFile(file, fs.readFileSync(file, "utf8"), ts.ScriptTarget.Latest, true);
  const found: Array<[ts.Expression, ts.Node]> = [];
  importSpecifiers(source, dynamic, found);
  const edges: ImportEdge[] = [];
  for (const [spec, at] of found) {
    if (!ts.isStringLiteralLike(spec)) continue;
    const target = importTarget(file, spec.text, options);
    const to = target ? path.relative(root, target).replaceAll(path.sep, "/") : "";
    if (to.startsWith("src/"))
      edges.push({ from: rel, to, line: source.getLineAndCharacterOfPosition(at.getStart()).line + 1 });
  }
  return edges;
}

/**
 * The harness seed is the in-app agent's own editable code, copied into its workspace and run
 * there: the app must not load it. Every runtime import from the main process, the preload, the
 * renderer or shared code into `src/harness-seed/` (static, or a literal dynamic import). The
 * contract parts the app needs live in `src/shared` instead (`chat-run.ts`, `message-queue.ts`,
 * `model-roles.ts`, `skill-edits.ts`), held to the seed's copies by
 * `tests/conformance/seed-contracts.test.ts`.
 */
export function seedEdges(root: string): ImportEdge[] {
  const options = compilerOptions(root);
  return ["src/main", "src/preload", "src/renderer", "src/shared"]
    .flatMap((dir) => filesBelow(path.join(root, dir), dir).filter((f: string) => SCRIPT.test(f)))
    .flatMap((file: string) => runtimeImports(root, file, options, true))
    .filter((edge) => edge.to.startsWith("src/harness-seed/"));
}

/** Tarjan's bookkeeping: each node's index and low-link, and the stack of the open component. */
interface Tarjan {
  graph: Map<string, string[]>;
  index: number;
  indexOf: Map<string, number>;
  low: Map<string, number>;
  stack: string[];
  onStack: Set<string>;
  out: string[][];
}
type TarjanFrame = { node: string; next: number };

function enter(t: Tarjan, node: string): void {
  t.indexOf.set(node, t.index);
  t.low.set(node, t.index);
  t.index++;
  t.stack.push(node);
  t.onStack.add(node);
}

const lower = (t: Tarjan, node: string, value: number | undefined) =>
  t.low.set(node, Math.min(t.low.get(node) ?? 0, value ?? 0));

/** Takes the frame's next edge: descends into an unvisited file, or links back to an open one. */
function advance(t: Tarjan, frame: TarjanFrame, work: TarjanFrame[]): void {
  const to = (t.graph.get(frame.node) ?? [])[frame.next++];
  if (to === undefined || !t.graph.has(to)) return;
  if (!t.indexOf.has(to)) {
    enter(t, to);
    work.push({ node: to, next: 0 });
  } else if (t.onStack.has(to)) lower(t, frame.node, t.indexOf.get(to));
}

/** A finished frame: when it roots a component, pop it off the stack (a cycle when it has one). */
function closeComponent(t: Tarjan, frame: TarjanFrame): void {
  if (t.low.get(frame.node) !== t.indexOf.get(frame.node)) return;
  const component: string[] = [];
  for (;;) {
    const member = t.stack.pop() as string;
    t.onStack.delete(member);
    component.push(member);
    if (member === frame.node) break;
  }
  const selfImport = (t.graph.get(frame.node) ?? []).includes(frame.node);
  if (component.length > 1 || selfImport) t.out.push(component.sort());
}

// Tarjan's strongly connected components, iterative so a deep import chain cannot overflow.
function stronglyConnected(graph: Map<string, string[]>): string[][] {
  const t: Tarjan = { graph, index: 0, indexOf: new Map(), low: new Map(), stack: [], onStack: new Set(), out: [] };
  for (const start of graph.keys()) {
    if (t.indexOf.has(start)) continue;
    enter(t, start);
    const work: TarjanFrame[] = [{ node: start, next: 0 }];
    while (work.length) {
      const frame = work[work.length - 1] as TarjanFrame;
      if (frame.next < (graph.get(frame.node) ?? []).length) {
        advance(t, frame, work);
        continue;
      }
      work.pop();
      const parent = work[work.length - 1];
      if (parent) lower(t, parent.node, t.low.get(frame.node));
      closeComponent(t, frame);
    }
  }
  return t.out;
}

/**
 * Import cycles among the app's own sources (`src/`, without the game template, which is a game):
 * each strongly connected component of the static runtime import graph with more than one file,
 * or a file that imports itself, as a sorted list of files. Dynamic imports are left out — they
 * run after every module has loaded, so they cannot order a load.
 */
export function importCycles(root: string): string[][] {
  const options = compilerOptions(root);
  const files = filesBelow(path.join(root, "src"), "src").filter(
    (f: string) => SCRIPT.test(f) && !f.startsWith("src/game-template/"),
  );
  const graph = new Map<string, string[]>(
    files.map((f: string) => [f, [...new Set(runtimeImports(root, f, options, false).map((e) => e.to))]]),
  );
  return stronglyConnected(graph).sort((a, b) => (a[0] ?? "").localeCompare(b[0] ?? ""));
}
/**
 * Import cycles that exist today, frozen in `scripts/boundary-allowlist.json`. The list may only
 * shrink: a cycle it does not cover fails the check, and an entry the code no longer has is
 * reported so it can be deleted. Seed imports have no allowlist: every one fails.
 */
export interface BoundaryAllowlist {
  cycles: string[][];
}
export const ALLOWLIST = "scripts/boundary-allowlist.json";
export interface CheckResult {
  errors: string[];
  warnings: string[];
}

export function checkSeedBoundary(root: string): CheckResult {
  return {
    errors: seedEdges(root).map(
      (edge) =>
        `${edge.from}:${edge.line}: runtime import of the harness seed ${edge.to} — the app must not load the agent's editable code; move what it needs to src/shared`,
    ),
    warnings: [],
  };
}

export function checkCycles(root: string, allowed: BoundaryAllowlist): CheckResult {
  const cycles = importCycles(root);
  const covered = (cycle: string[]) => allowed.cycles.some((entry) => cycle.every((file) => entry.includes(file)));
  const exact = (entry: string[]) =>
    cycles.some((cycle) => cycle.length === entry.length && cycle.every((file) => entry.includes(file)));
  return {
    errors: cycles
      .filter((cycle) => !covered(cycle))
      .map(
        (cycle) =>
          `new import cycle: ${cycle.join(", ")} — import a type with \`import type\`, or move what both sides need into a module neither imports`,
      ),
    warnings: [
      ...cycles.filter(covered).map((cycle) => `allowlisted import cycle, still to break: ${cycle.join(", ")}`),
      ...allowed.cycles
        .filter((entry) => !exact(entry))
        .map(
          (entry) =>
            `entry that no longer matches a cycle exactly, shrink or delete it in ${ALLOWLIST}: ${entry.join(", ")}`,
        ),
    ],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const root = process.cwd();
  const errors = checkBoundaries(root);
  if (errors.length) {
    console.error(errors.join("\n"));
    process.exitCode = 1;
  } else console.log("Browser runtime boundaries: pass (erased types allowed)");
  const allowed = JSON.parse(fs.readFileSync(path.join(root, ALLOWLIST), "utf8")) as BoundaryAllowlist;
  for (const [label, result] of [
    ["Harness-seed imports from the app", checkSeedBoundary(root)],
    ["Import cycles in src", checkCycles(root, allowed)],
  ] as const) {
    // Allowlisted and stale entries are notes, on stdout: the edit hook treats anything on stderr as a failure.
    for (const warning of result.warnings) console.log(`note: ${warning}`);
    if (result.errors.length) {
      console.error(result.errors.join("\n"));
      process.exitCode = 1;
    } else
      console.log(
        `${label}: pass${result.warnings.length ? ` (${result.warnings.length} allowlisted or stale, listed above)` : ""}`,
      );
  }
}
