/**
 * The record a ranged download keeps beside its partial file (`<partial>.ranges.json`): which
 * archive it is downloading (its size and the host's ETag), the range size, and the ranges whose
 * bytes are all in the file. It is written before the first range and after each finished one, so
 * a stopped download asks again only for what it lacks. A record is believed only when every field
 * is exactly what this download would write; anything else reads as no record.
 */
import { lstat, readFile, rm } from "node:fs/promises";
import { atomicWriteText } from "../../substrate/fsx.ts";

/** The record's format: another version is not read. */
const RECORD_VERSION = 1;
/** The longest record read: a 32 GiB archive's is a few kilobytes. */
const RECORD_MAX_BYTES = 256 * 1024;

/** What a ranged download has saved of one archive. */
export interface RangeRecord {
  version: number;
  sizeBytes: number;
  rangeBytes: number;
  /** The host's ETag for the archive every range was asked of. */
  etag: string;
  /** The ranges saved whole, by index. */
  done: number[];
}

/** The archive a record must be about: its size and the range size in use. */
export interface RangeShape {
  sizeBytes: number;
  rangeBytes: number;
}

/** Where the record of the download into `partial` is kept. */
export const rangeRecordOf = (partial: string): string => `${partial}.ranges.json`;

/** How many ranges an archive is downloaded in. */
export const rangeCount = ({ sizeBytes, rangeBytes }: RangeShape): number => Math.ceil(sizeBytes / rangeBytes);

/** The first and last byte of range `index`. */
export function rangeSpan(index: number, { sizeBytes, rangeBytes }: RangeShape): { first: number; last: number } {
  const first = index * rangeBytes;
  return { first, last: Math.min(first + rangeBytes, sizeBytes) - 1 };
}

/** A new record for `shape` under `etag`, with `done` saved. */
export const newRangeRecord = (shape: RangeShape, etag: string, done: readonly number[]): RangeRecord => ({
  version: RECORD_VERSION,
  sizeBytes: shape.sizeBytes,
  rangeBytes: shape.rangeBytes,
  etag,
  done: [...done],
});

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** The ranges a record names, or null unless each is a range of the archive named once. */
function doneRanges(value: unknown, count: number): number[] | null {
  if (!Array.isArray(value) || value.length > count) return null;
  const seen = new Set<number>();
  for (const index of value) {
    const inside = Number.isSafeInteger(index) && index >= 0 && index < count;
    if (!inside || seen.has(index)) return null;
    seen.add(index);
  }
  return [...seen];
}

/** A record's text as the record for `shape`, or null when anything in it is off. */
export function parseRangeRecord(text: string, shape: RangeShape): RangeRecord | null {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return null;
  }
  if (!isRecord(value) || value.version !== RECORD_VERSION) return null;
  if (value.sizeBytes !== shape.sizeBytes || value.rangeBytes !== shape.rangeBytes) return null;
  if (typeof value.etag !== "string" || value.etag === "") return null;
  const done = doneRanges(value.done, rangeCount(shape));
  return done ? newRangeRecord(shape, value.etag, done) : null;
}

/** Whether a record, believable or not, lies beside `partial`. */
export const hasRangeRecord = async (partial: string): Promise<boolean> =>
  (await lstat(rangeRecordOf(partial)).catch(() => null)) !== null;

/** The record beside `partial` for `shape`, or null: missing, not a plain file, too long, or off. */
export async function readRangeRecord(partial: string, shape: RangeShape): Promise<RangeRecord | null> {
  const file = rangeRecordOf(partial);
  const found = await lstat(file).catch(() => null);
  if (!found?.isFile() || found.size > RECORD_MAX_BYTES) return null;
  const text = await readFile(file, "utf8").catch(() => null);
  return text === null ? null : parseRangeRecord(text, shape);
}

/**
 * The ranges of `record` to believe for the archive the host names `etag`, with `savedBytes` in
 * the partial file: none unless it is the same archive and the file holds every one of them.
 */
export function believedRanges(record: RangeRecord | null, etag: string, savedBytes: number): number[] | null {
  if (!record || record.etag !== etag || savedBytes > record.sizeBytes) return null;
  const held = record.done.every((index) => rangeSpan(index, record).last < savedBytes);
  return held ? record.done : null;
}

/** Write `record` beside `partial`, whole or not at all. */
export const writeRangeRecord = (partial: string, record: RangeRecord): Promise<void> =>
  atomicWriteText(rangeRecordOf(partial), `${JSON.stringify(record)}\n`);

/** Remove the record beside `partial`. */
export const removeRangeRecord = (partial: string): Promise<void> => rm(rangeRecordOf(partial), { force: true });
