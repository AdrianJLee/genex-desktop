/**
 * The Genex CLI's progress lines. Asked for with `GENEX_PROGRESS=json`, the CLI writes one line
 * per update to its error output: the prefix below, then a JSON object. Studio takes those lines
 * out of the output (the rest stays the CLI's own words for a failure) and meters them into bytes
 * sent and a speed. A CLI that knows nothing of the variable writes none, and nothing changes.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import { GenexSendStage, type GenexSendProgress } from "../../shared/genex.ts";

/** The variable that asks the CLI for progress lines, and its one value. */
export const PROGRESS_ENV = { GENEX_PROGRESS: "json" } as const;
/** What every progress line starts with: the CLI's contract (its `lib/progress.ts`). */
const PROGRESS_PREFIX = "@genex-progress ";
/** The speed is the bytes moved over this long, so one slow or fast part does not swing it. */
const SPEED_WINDOW_MS = 10 * SECOND_MS;
/** An app's name in a progress line: `mac-arm64`, `windows`. */
const TARGET = /^[a-z0-9-]{1,32}$/;

const STAGES: ReadonlySet<string> = new Set(Object.values(GenexSendStage));

/** One update as the CLI wrote it. */
export type SendProgressEvent = Omit<GenexSendProgress, "at" | "bytesPerSecond">;

const isCount = (value: unknown): value is number =>
  typeof value === "number" && Number.isSafeInteger(value) && value >= 0;

/** The update a line of the CLI's output carries, or null for any other line. */
export function parseProgressLine(line: string): SendProgressEvent | null {
  if (!line.startsWith(PROGRESS_PREFIX)) return null;
  let read: unknown;
  try {
    read = JSON.parse(line.slice(PROGRESS_PREFIX.length));
  } catch {
    return null;
  }
  if (typeof read !== "object" || read === null) return null;
  const { stage, doneBytes, totalBytes, target } = read as Record<string, unknown>;
  if (typeof stage !== "string" || !STAGES.has(stage)) return null;
  if (!isCount(doneBytes) || !isCount(totalBytes)) return null;
  const named = typeof target === "string" && TARGET.test(target) ? { target } : {};
  return { stage: stage as GenexSendStage, doneBytes, totalBytes, ...named };
}

/** What one chunk of output came to: the updates in it, and the text that is not progress. */
export interface SplitOutput {
  text: string;
  events: SendProgressEvent[];
}

/**
 * Takes the CLI's error output as it arrives, in chunks cut anywhere. `push` gives back the
 * whole lines seen so far, progress lines read and removed; `end` gives back what was left
 * with no newline after it.
 */
export function progressSplitter(): { push(chunk: string): SplitOutput; end(): string } {
  let pending = "";
  return {
    push(chunk) {
      const lines = (pending + chunk).split("\n");
      pending = lines.pop() ?? "";
      const out: SplitOutput = { text: "", events: [] };
      for (const line of lines) {
        const event = parseProgressLine(line.replace(/\r$/, ""));
        if (event) out.events.push(event);
        else out.text += `${line}\n`;
      }
      return out;
    },
    end() {
      const rest = pending;
      pending = "";
      return rest;
    },
  };
}

interface Sample {
  at: number;
  doneBytes: number;
}

/** Turns the CLI's updates into progress with a speed, starting over at each new stage or app. */
export function createSendMeter(now: () => number = Date.now): (event: SendProgressEvent) => GenexSendProgress {
  let key = "";
  let samples: Sample[] = [];
  return (event) => {
    const at = now();
    const eventKey = `${event.stage}\n${event.target ?? ""}`;
    if (eventKey !== key) {
      key = eventKey;
      samples = [];
    }
    // The oldest sample inside the window anchors the speed; with none, the newest before it.
    while (samples.length > 1 && (samples[0]?.at ?? at) < at - SPEED_WINDOW_MS) samples.shift();
    const anchor = samples[0];
    samples.push({ at, doneBytes: event.doneBytes });
    const moved = anchor ? event.doneBytes - anchor.doneBytes : 0;
    const elapsedMs = anchor ? at - anchor.at : 0;
    const speed = moved > 0 && elapsedMs > 0 ? { bytesPerSecond: Math.round((moved * SECOND_MS) / elapsedMs) } : {};
    return { ...event, at, ...speed };
  };
}
