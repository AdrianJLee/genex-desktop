/**
 * A download's speed, measured from how far it has come at each moment and smoothed so one fast or
 * slow second does not swing what a person reads. Pure: the caller says what time it is.
 */
import { SECOND_MS } from "./duration.ts";

/** The least time one speed sample covers. */
export const SPEED_SAMPLE_MS = SECOND_MS;
/** How far the speed moves toward each new sample: the rest stays what it was. */
const SPEED_SMOOTHING = 0.3;
/** The slowest speed a time left is worked out from, in bytes a second. */
const MOVING_BYTES_PER_SECOND = 1;

/** A download's speed so far and the sample it was last measured at. */
export interface SpeedMeter {
  atMs: number;
  bytes: number;
  /** Null until one sample's time has passed. */
  bytesPerSecond: number | null;
}

/** A meter for a download that has `bytes` at `nowMs`: the bytes a resumed download had are not speed. */
export const speedMeter = (bytes: number, nowMs: number): SpeedMeter => ({ atMs: nowMs, bytes, bytesPerSecond: null });

/**
 * `meter` after the download reached `bytes` at `nowMs`: unchanged until a sample's time has
 * passed, then moved toward the speed since the last sample. Progress that went back starts again.
 */
export function speedAfter(meter: SpeedMeter, bytes: number, nowMs: number): SpeedMeter {
  if (bytes < meter.bytes) return speedMeter(bytes, nowMs);
  const elapsedMs = nowMs - meter.atMs;
  if (elapsedMs < SPEED_SAMPLE_MS) return meter;
  const sample = ((bytes - meter.bytes) * SECOND_MS) / elapsedMs;
  const before = meter.bytesPerSecond;
  const bytesPerSecond = before === null ? sample : before + SPEED_SMOOTHING * (sample - before);
  return { atMs: nowMs, bytes, bytesPerSecond };
}

/** About how long `remainingBytes` take at `meter`'s speed, or null while it is not known or nothing moves. */
export function etaMsAt(meter: SpeedMeter, remainingBytes: number): number | null {
  const speed = meter.bytesPerSecond;
  if (speed === null || speed < MOVING_BYTES_PER_SECOND) return null;
  return Math.round((remainingBytes * SECOND_MS) / speed);
}
