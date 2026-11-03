/**
 * What the open lead is answered about its evidence: the picture a save point names
 * (`save_point {shows}`). A module of its own, so the shipped tools need no new name from a
 * `prompts.ts` an agent may have kept.
 */

/** A save point's `shows`, as its answer speaks of it. */
export const SHOWS_WORDS = {
  /** A file `shows` named that is no PNG or JPEG. */
  notPicture: "not a PNG or JPEG",
  /** A save point whose `shows` named no picture Genex could read. */
  refused: (rel: string, why: string) =>
    `${JSON.stringify(rel)} is not a picture in the project's folder (${why}), so the save point keeps Genex's own pictures only.`,
} as const;
