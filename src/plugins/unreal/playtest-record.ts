/**
 * A pilot run's record in the game folder: `playtests/runs/<date>-<run>/record.md` says what the run did
 * (its outcome, moves, who decided, what the play's detectors found), with the frames of its findings
 * and its decision log (`decisions.json`) beside it. Genex writes it when the run ends, whatever the
 * agent does, so the next playtest can start from what this one learned; the agent's own notes go to
 * `playtests/notes.md`, which Genex never writes.
 *
 * Frames and the decision log come from the Unreal project's `Saved/Genex` (the editor helper writes
 * them there); each is copied only from inside that folder, by its real path. A run already recorded
 * (the end of a run read twice) is left as it is, and only the newest KEPT_RUNS records are kept.
 */
import { copyFile, mkdir, readdir, realpath, rm, stat } from "node:fs/promises";
import path from "node:path";
import { atomicWriteText } from "../../substrate/fsx.ts";
import { isInside } from "../../substrate/paths.ts";

/** The records kept in a game folder; older ones are removed. */
export const KEPT_RUNS = 30;
/** The findings and timeline lines a record lists. */
const FINDINGS_LISTED = 40;
const TIMELINE_LISTED = 25;

/** Where records live in the game folder, and the shape of a record's folder name (date, then run id). */
export const RUNS_FOLDER = ["playtests", "runs"] as const;
const RUN_ID = /^\d{1,13}-[A-Za-z0-9_]{1,64}$/;
const RECORD_FOLDER = /^\d{4}-\d{2}-\d{2}-\d{6}-\d{1,13}-[A-Za-z0-9_]{1,64}$/;
const CAPTURE_NAME = /^[A-Za-z0-9_-]{1,64}$/;

const MESSAGE = {
  title: (pilot: string, when: string) => `# Playtest run: ${pilot} (${when})`,
  outcome: (outcome: string, note: string, seconds: string) =>
    `- Outcome: **${outcome}**${note ? ` (${note})` : ""} after ${seconds} game seconds`,
  decided: (asked: number, answered: number, byOrder: number) =>
    `- Decisions: ${answered} of ${asked} asks answered by the decision model, ${byOrder} picked by the pilot's order`,
  moves: "## Moves (started / worked / failed)",
  findings: "## What the play's detectors found",
  noFindings: "None.",
  timeline: "## Last moments",
  errors: "## Errors in the pilot",
  decisionsFile: "The run's every pick (move, odds, facts) is in decisions.json beside this file.",
} as const;

function own(value: unknown, name: string): unknown {
  return typeof value === "object" && value !== null && Object.hasOwn(value, name)
    ? Reflect.get(value, name)
    : undefined;
}

function text(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function list(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** The folder name of a run's record: its start date (UTC) then its run id. */
export function recordFolderName(runId: string): string | null {
  if (!RUN_ID.test(runId)) return null;
  const epoch = Number(runId.split("-")[0]);
  const date = new Date(epoch * 1000).toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return `${date.slice(0, 4)}-${date.slice(4, 6)}-${date.slice(6, 8)}-${date.slice(9, 15)}-${runId}`;
}

/** A run's record as Markdown, from the pilot's report and the frames copied beside it. */
export function recordText(report: unknown, frames: ReadonlyMap<string, string>, hasDecisions: boolean): string {
  const pilot = text(own(report, "pilot"), "pilot");
  const runId = text(own(report, "runId"));
  const epoch = Number(runId.split("-")[0]);
  const when = Number.isFinite(epoch) && epoch > 0 ? new Date(epoch * 1000).toISOString().slice(0, 16) : "";
  const lines = [
    MESSAGE.title(pilot, when.replace("T", " ")),
    "",
    MESSAGE.outcome(
      text(own(report, "outcome"), "?"),
      text(own(report, "note")),
      String(num(own(report, "gameSeconds"))),
    ),
    MESSAGE.decided(num(own(report, "asked")), num(own(report, "answered")), num(own(report, "byOrder"))),
    "",
    MESSAGE.moves,
    ...list(own(report, "moves")).map(
      (m) =>
        `- ${text(own(m, "name"))}: ${num(own(m, "started"))} / ${num(own(m, "worked"))} / ${num(own(m, "failed"))}`,
    ),
    "",
    MESSAGE.findings,
  ];
  const findings = list(own(report, "findings")).slice(0, FINDINGS_LISTED);
  if (findings.length === 0) lines.push(MESSAGE.noFindings);
  for (const finding of findings) {
    const frame = frames.get(text(own(finding, "frame")));
    const at = num(own(finding, "gameSeconds"));
    lines.push(
      `- ${text(own(finding, "code"))} at ${at} s: ${text(own(finding, "detail"))}${frame ? ` ![](${frame})` : ""}`,
    );
  }
  const errors = list(own(report, "errors"))
    .map((e) => text(e))
    .filter(Boolean);
  if (errors.length) lines.push("", MESSAGE.errors, ...errors.map((e) => `- ${e}`));
  const timeline = list(own(report, "timeline"))
    .map((t) => text(t))
    .filter(Boolean)
    .slice(-TIMELINE_LISTED);
  if (timeline.length) lines.push("", MESSAGE.timeline, ...timeline.map((t) => `- ${t}`));
  if (hasDecisions) lines.push("", MESSAGE.decisionsFile);
  return `${lines.join("\n")}\n`;
}

/** The real path of a file the helper wrote under `<project>/Saved/Genex/<sub>`, or null when it is elsewhere or missing. */
async function savedFile(projectDir: string, sub: string, file: string): Promise<string | null> {
  try {
    const root = await realpath(path.join(projectDir, "Saved", "Genex", sub));
    const real = await realpath(file);
    return isInside(root, real) && (await stat(real)).isFile() ? real : null;
  } catch {
    return null;
  }
}

async function copyFrames(report: unknown, projectDir: string, folder: string): Promise<Map<string, string>> {
  const copied = new Map<string, string>();
  for (const finding of list(own(report, "findings"))) {
    const name = text(own(finding, "frame"));
    if (!CAPTURE_NAME.test(name) || copied.has(name)) continue;
    const source = await savedFile(
      projectDir,
      "captures",
      path.join(projectDir, "Saved", "Genex", "captures", `${name}.png`),
    );
    if (!source) continue;
    await copyFile(source, path.join(folder, `${name}.png`));
    copied.set(name, `${name}.png`);
  }
  return copied;
}

/** Removes all but the newest KEPT_RUNS records (folders Genex named; anything else is left alone). */
async function prune(runs: string): Promise<void> {
  const names = (await readdir(runs).catch(() => [] as string[])).filter((n) => RECORD_FOLDER.test(n)).sort();
  for (const old of names.slice(0, Math.max(0, names.length - KEPT_RUNS))) {
    await rm(path.join(runs, old), { recursive: true, force: true });
  }
}

/**
 * Writes the record of a finished pilot run into `gameFolder` (once per run), copying its frames and
 * decision log out of the project's `Saved/Genex`; the record's path relative to the game folder, or
 * null when there is nothing to write (no run id, or a run already recorded).
 */
export async function writeRunRecord(
  gameFolder: string,
  projectFile: string | undefined,
  report: object,
): Promise<string | null> {
  const name = recordFolderName(text(own(report, "runId")));
  if (!name) return null;
  const runs = path.join(gameFolder, ...RUNS_FOLDER);
  const folder = path.join(runs, name);
  const relative = path.join(...RUNS_FOLDER, name, "record.md");
  if (
    await stat(folder).then(
      () => true,
      () => false,
    )
  )
    return relative;
  await mkdir(folder, { recursive: true });
  const projectDir = projectFile ? path.dirname(projectFile) : null;
  const frames = projectDir ? await copyFrames(report, projectDir, folder) : new Map<string, string>();
  const film = text(own(report, "film"));
  const decisions = projectDir && film.endsWith(".json") ? await savedFile(projectDir, "pilots", film) : null;
  if (decisions) await copyFile(decisions, path.join(folder, "decisions.json"));
  await atomicWriteText(path.join(folder, "record.md"), recordText(report, frames, decisions !== null));
  await prune(runs);
  return relative;
}
