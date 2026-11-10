/** A file's or a folder's size as people read it, the same in the host's words and the app's. */
import { intlLocale, t } from "./i18n.ts";

/** The units a size is said in, largest first, in a person's words. */
const SIZE_UNITS = [
  { bytes: 1024 ** 3, words: (size: string) => t("{size} GB", { size }) },
  { bytes: 1024 ** 2, words: (size: string) => t("{size} MB", { size }) },
  { bytes: 1024, words: (size: string) => t("{size} KB", { size }) },
] as const;

/** A size in the largest unit it reaches, to one decimal (`6.1 GB`, `2 GB`, `80 KB`, `12 bytes`), in the app's language. */
export function sizeWords(bytes: number): string {
  const unit = SIZE_UNITS.find((each) => bytes >= each.bytes);
  if (!unit) return t("{count, plural, other {# bytes}}", { count: bytes });
  return unit.words(oneDecimal(bytes / unit.bytes));
}

/** The units a speed is said in, largest first. */
const SPEED_UNITS = [
  { bytes: 1024 ** 2, words: (size: string) => t("{size} MB/s", { size }) },
  { bytes: 1024, words: (size: string) => t("{size} KB/s", { size }) },
] as const;

/** A download's speed in the largest unit it reaches, to one decimal (`38 MB/s`, `900 KB/s`); under a kilobyte reads `0 KB/s`. */
export function speedWords(bytesPerSecond: number): string {
  const unit = SPEED_UNITS.find((each) => bytesPerSecond >= each.bytes);
  if (!unit) return t("{size} KB/s", { size: oneDecimal(0) });
  return unit.words(oneDecimal(bytesPerSecond / unit.bytes));
}

/** A number to at most one decimal, written as the app's language writes it (`6.1`, `6,1`). */
function oneDecimal(value: number): string {
  const locale = intlLocale();
  if (!locale) return String(Number(value.toFixed(1)));
  return new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(value);
}
