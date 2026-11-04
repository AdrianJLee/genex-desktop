/**
 * The recap of a computer session: what its moves amounted to, read from the rows of its trace.
 * It counts the inputs, waits and looks; the inputs that changed nothing in the game and their
 * longest run; the moves the target refused or took only in part; the actions that failed; and
 * the console's errors since load, grouped by message. These are the facts a model reports what
 * play showed from, rather than its memory of the moves.
 *
 * Electron-free and pure.
 */
import { StillKind } from "./computer-response.ts";
import { COMPUTER_INPUT_ACTIONS, type ComputerAction, ComputerVerb } from "./computer-tool.ts";
import { COMPUTER_RECAP } from "./computer-tool-prompts.ts";
import type { TraceRow } from "./computer-trace.ts";

/** Moves one line names by number, at most. */
const LISTED_MOVES = 5;
/** Failed actions named with their reason, at most. */
const LISTED_FAILURES = 3;
/** Kinds of console error named, at most. */
const LISTED_ERRORS = 3;
/** The characters of an error's message the recap keeps. */
const ERROR_CHARS = 120;

/** What a recap is made from. */
export interface RecapInput {
  rows: readonly TraceRow[];
  /** Rows dropped before these, past the session's bound; 0 when every row is here. */
  dropped: number;
  /** The console's error messages since load; null when the target has no console. */
  consoleErrors: readonly string[] | null;
}

/** The actions that send input, besides the plain input actions. */
const INPUT_VERBS: ReadonlySet<string> = new Set<string>([ComputerVerb.Batch, ComputerVerb.Act]);

/** Whether a row sent input (or tried to, if it failed before the target answered). */
function isInputRow(row: TraceRow): boolean {
  if (row.applied) return true;
  return (
    (COMPUTER_INPUT_ACTIONS as readonly ComputerAction[]).includes(row.action as ComputerAction) ||
    INPUT_VERBS.has(row.action)
  );
}

/** Whether a row's input reached the game: taken at least in part. */
function wasTaken(row: TraceRow): boolean {
  return (row.applied?.taken ?? 0) > 0;
}

/** Move numbers as a line names them: the first few, and how many more. */
function movesText(numbers: readonly number[]): string {
  const more = numbers.length - LISTED_MOVES;
  return `${COMPUTER_RECAP.moves(numbers.slice(0, LISTED_MOVES))}${more > 0 ? ` and ${more} more` : ""}`;
}

/** The counts the recap opens with: inputs, waits, looks. */
function headLine(rows: readonly TraceRow[], dropped: number): string {
  const kept = rows.filter((row) => !row.refused);
  const waits = kept.filter((row) => row.action === ComputerVerb.Wait).length;
  const inputs = kept.filter((row) => row.action !== ComputerVerb.Wait && isInputRow(row)).length;
  const looks = kept.length - waits - inputs;
  const counts = [
    COMPUTER_RECAP.count(inputs, "input", "inputs"),
    COMPUTER_RECAP.count(waits, "wait", "waits"),
    COMPUTER_RECAP.count(looks, "look", "looks"),
  ].join(", ");
  return COMPUTER_RECAP.head(counts, dropped > 0 ? rows.length : null);
}

/**
 * The still inputs and their longest run. A run is broken only by an input the game took that
 * changed something; looks, waits, failed and refused inputs leave it as it is.
 */
function stillLine(rows: readonly TraceRow[]): string | null {
  const still = rows.filter((row) => row.still);
  if (!still.length) return null;
  let best = { length: 0, from: 0, to: 0 };
  let run = { length: 0, from: 0, to: 0 };
  for (const row of rows) {
    if (row.still) {
      run = { length: run.length + 1, from: run.length ? run.from : row.i, to: row.i };
      if (run.length > best.length) best = run;
    } else if (isInputRow(row) && wasTaken(row)) {
      run = { length: 0, from: 0, to: 0 };
    }
  }
  const frozen = still.filter((row) => row.still === StillKind.Frozen).length;
  return `${COMPUTER_RECAP.still(still.length, best.length, best.from, best.to)}${frozen ? COMPUTER_RECAP.frozen(frozen) : ""}`;
}

/** The console's errors grouped by message, the most frequent first. */
function consoleLine(errors: readonly string[] | null): string | null {
  if (!errors?.length) return null;
  const counts = new Map<string, number>();
  for (const message of errors) {
    const key = message.slice(0, ERROR_CHARS);
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const top = [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, LISTED_ERRORS)
    .map(([message, n]) => `${n}× ${message}`)
    .join("; ");
  return COMPUTER_RECAP.console(errors.length, counts.size, top);
}

/** What the game's own detectors told, by kind in the order they first showed: how often, where first, and what. */
function findingsLine(rows: readonly TraceRow[]): string | null {
  const kinds = new Map<string, { count: number; move: number; detail: string }>();
  for (const row of rows) {
    for (const finding of row.findings ?? []) {
      const known = kinds.get(finding.code);
      if (known) known.count = Math.max(known.count, finding.count);
      else kinds.set(finding.code, { count: finding.count, move: row.i, detail: finding.detail });
    }
  }
  if (!kinds.size) return null;
  const named = [...kinds.entries()].map(([code, kind]) =>
    COMPUTER_RECAP.findingKind(code, kind.count, kind.move, kind.detail),
  );
  return COMPUTER_RECAP.findings(named.join("; "));
}

/** The actions that failed, the first few with their reason. */
function failedLine(rows: readonly TraceRow[]): string | null {
  const failed = rows.filter((row) => row.failed);
  if (!failed.length) return null;
  const named = failed.slice(0, LISTED_FAILURES).map((row) => `${COMPUTER_RECAP.moves([row.i])} (${row.failed})`);
  const more = failed.length - LISTED_FAILURES;
  return COMPUTER_RECAP.failed(`${named.join("; ")}${more > 0 ? ` and ${more} more` : ""}`);
}

/** What a session's moves amounted to, as the `recap` verb answers it. */
export function sessionRecap(input: RecapInput): string {
  const { rows, dropped, consoleErrors } = input;
  if (!rows.length && !dropped) return COMPUTER_RECAP.noMoves;
  const sent = rows.filter((row) => (row.applied?.planned ?? 0) > 0);
  const refused = sent.filter((row) => row.applied?.taken === 0).map((row) => row.i);
  const partly = sent.filter((row) => wasTaken(row) && (row.applied?.taken ?? 0) < (row.applied?.planned ?? 0));
  const sessionRefused = rows.filter((row) => row.refused).length;
  const findings = [
    stillLine(rows),
    refused.length ? COMPUTER_RECAP.refused(movesText(refused)) : null,
    partly.length ? COMPUTER_RECAP.partly(movesText(partly.map((row) => row.i))) : null,
    failedLine(rows),
    sessionRefused ? COMPUTER_RECAP.sessionRefused(sessionRefused) : null,
    findingsLine(rows),
    consoleLine(consoleErrors),
  ].filter((line): line is string => line !== null);
  return [headLine(rows, dropped), ...(findings.length ? findings : [COMPUTER_RECAP.clean])].join("\n");
}
