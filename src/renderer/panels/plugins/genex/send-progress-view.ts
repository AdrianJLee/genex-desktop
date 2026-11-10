/**
 * How a send on its way reads on the publish card: how much went, how fast, how long is left
 * (`GenexSendProgress`, from the Genex CLI's progress lines). Pure: the card calls it on each tick.
 */
import { sizeWords } from "../../../../shared/byte-size.ts";
import { HOUR_MS, MINUTE_MS, SECOND_MS } from "../../../../shared/duration.ts";
import { GenexSendStage, type GenexSendProgress } from "../../../../shared/genex.ts";
import { t } from "../../../../shared/i18n.ts";

/** A speed read longer ago than this says nothing of now: the send may have stopped moving. */
const SPEED_FRESH_MS = 15 * SECOND_MS;
/** Time left is said to the quarter hour past an hour: nobody plans by the minute that far out. */
const QUARTER_MINUTES = 15;

const WORDS = {
  stage: {
    [GenexSendStage.Zip]: t("Packing"),
    [GenexSendStage.Hash]: t("Checking the archive"),
    [GenexSendStage.Upload]: null,
    [GenexSendStage.SourceLfs]: t("Sending the project for Remix"),
    [GenexSendStage.SourceGit]: t("Sending the project for Remix"),
  } satisfies Record<GenexSendStage, string | null>,
  sent: (done: string, total: string) => t("{done} of {total}", { done, total }),
  atSpeed: (done: string, total: string, speed: string) => t("{done} of {total} · {speed}/s", { done, total, speed }),
  underAMinute: (done: string, total: string, speed: string) =>
    t("{done} of {total} · {speed}/s · under a minute left", { done, total, speed }),
  minutesLeft: (done: string, total: string, speed: string, minutes: number) =>
    t("{done} of {total} · {speed}/s · about {minutes} min left", { done, total, speed, minutes }),
  hoursLeft: (done: string, total: string, speed: string, hours: number) =>
    t("{done} of {total} · {speed}/s · about {hours} h left", { done, total, speed, hours }),
  hoursMinutesLeft: (done: string, total: string, speed: string, hours: number, minutes: number) =>
    t("{done} of {total} · {speed}/s · about {hours} h {minutes} min left", { done, total, speed, hours, minutes }),
} as const;

/** What a working row shows of its send. */
export interface SendProgressView {
  /** What is going on when it is not the upload itself; null for the upload. */
  label: string | null;
  /** How much went, and how fast and how long is left when that is known; null when there is nothing to count. */
  amounts: string | null;
  /** How full the bar is, 0 to 1; null when the size is not known. */
  fraction: number | null;
}

/** The amounts line with the time left, by how far out the end is. */
function withTimeLeft(done: string, total: string, speed: string, leftMs: number): string {
  if (leftMs < MINUTE_MS) return WORDS.underAMinute(done, total, speed);
  if (leftMs < HOUR_MS) return WORDS.minutesLeft(done, total, speed, Math.round(leftMs / MINUTE_MS));
  const quarters = Math.round(leftMs / (QUARTER_MINUTES * MINUTE_MS));
  const hours = Math.floor(quarters / 4);
  const minutes = (quarters % 4) * QUARTER_MINUTES;
  return minutes === 0
    ? WORDS.hoursLeft(done, total, speed, hours)
    : WORDS.hoursMinutesLeft(done, total, speed, hours, minutes);
}

/** How much went of a send whose size is known. */
function amountsOf(progress: GenexSendProgress, now: number): string {
  const done = sizeWords(Math.min(progress.doneBytes, progress.totalBytes));
  const total = sizeWords(progress.totalBytes);
  const speed = progress.bytesPerSecond ?? 0;
  const fresh = now - progress.at <= SPEED_FRESH_MS;
  if (speed <= 0 || !fresh) return WORDS.sent(done, total);
  const left = Math.max(0, progress.totalBytes - progress.doneBytes);
  if (left === 0) return WORDS.atSpeed(done, total, sizeWords(speed));
  return withTimeLeft(done, total, sizeWords(speed), (left / speed) * SECOND_MS);
}

/** What a row shows of the send `progress` describes, as of `now`; null without one. */
export function sendProgressView(progress: GenexSendProgress | undefined, now: number): SendProgressView | null {
  if (!progress) return null;
  const label = WORDS.stage[progress.stage];
  if (progress.totalBytes <= 0) {
    return { label, amounts: progress.doneBytes > 0 ? sizeWords(progress.doneBytes) : null, fraction: null };
  }
  const fraction = Math.min(1, progress.doneBytes / progress.totalBytes);
  return { label, amounts: amountsOf(progress, now), fraction };
}
