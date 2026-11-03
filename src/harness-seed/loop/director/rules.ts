/**
 * The Loop's plain rules, with no run of their own: the plain sentence a card falls back on. It
 * imports no part of the run, so every part can use it without an import cycle.
 */

/**
 * The fallback plain sentence, for a card whose writer gave none: everything only a developer
 * could read — shas, refs, run ids, absolute paths — is taken out and what is left is tidied.
 */
export function plainly(text: unknown): string {
  return (
    String(text ?? "")
      .replace(/\b(?:refs\/|attempt\/)[\w./-]+/g, "")
      .replace(/\/(?:Users|private|var|tmp)\/\S+/g, "")
      .replace(/\brun_[a-z0-9]{6,}\b/gi, "")
      // Eight and up: a word like "defaced" is not a sha, and every sha the cards carry is ten.
      .replace(/\b[0-9a-f]{8,40}\b/g, "")
      .replace(/\(\s*[),;:—–-]*\s*\)/g, "")
      .replace(/\s+([,.;:])/g, "$1")
      .replace(/\s{2,}/g, " ")
      .trim()
      .replace(/[\s—–:,;'"(-]+$/, "")
      // What a removed sha or ref leaves behind: "kept unlanded on", "merged shine at".
      .replace(/\s+(?:on|at|in|to|from|as|of)$/i, "")
      .replace(/[\s—–:,;'"(-]+$/, "")
      .trim()
  );
}
