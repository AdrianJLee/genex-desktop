/**
 * What the top of a native game's page shows (canvas "Bodycam game page", round 2, A): the game's
 * clip over its cover, the cover alone, or the no-cover drawing; and, once it has two pictures or
 * more, a slideshow through them, the cover (with its clip) first, a few seconds each. genex.games
 * sends one cover, a clip only beside a cover (`toPlayGame`), and up to four shots; a picture that
 * fails to load leaves the run, so a broken cover falls back to the drawing.
 */
import { SECOND_MS } from "../../shared/duration.ts";
import type { PlayGameDetail } from "../../shared/play.ts";

/** How long each picture of the slideshow shows: the clip's own length. */
export const HERO_FRAME_MS = 5 * SECOND_MS;

/** What the page's top shows: the clip over the cover, a still picture, or the no-cover drawing. */
export const HeroArt = { Clip: "clip", Still: "still", None: "none" } as const;
export type HeroArt = (typeof HeroArt)[keyof typeof HeroArt];

/** One picture of the run: its still, and the clip that plays over it (the cover's only). */
export interface HeroFrame {
  src: string;
  clip: string | null;
}

/** The pictures the top runs through: the cover and its clip first, then each shot once; none that failed. */
export function heroFrames(
  game: Pick<PlayGameDetail, "coverUrl" | "clipUrl" | "shots">,
  failed: ReadonlySet<string>,
): HeroFrame[] {
  const shown = (src: string | null): src is string => src !== null && !failed.has(src);
  const frames: HeroFrame[] = shown(game.coverUrl) ? [{ src: game.coverUrl, clip: game.clipUrl }] : [];
  const seen = new Set(frames.map((frame) => frame.src));
  for (const shot of game.shots) {
    if (!shown(shot) || seen.has(shot)) continue;
    seen.add(shot);
    frames.push({ src: shot, clip: null });
  }
  return frames;
}

/** What the top shows for its pictures: the first one's clip, its still, or the drawing. */
export function heroArt(frames: readonly HeroFrame[]): HeroArt {
  const first = frames[0];
  if (!first) return HeroArt.None;
  return first.clip ? HeroArt.Clip : HeroArt.Still;
}

/** Whether the top runs a slideshow and the page lists its shots: two pictures or more. */
export const runsSlideshow = (frames: readonly HeroFrame[]): boolean => frames.length > 1;

/** The picture after `at`, back to the first after the last; the first while there are none. */
export const nextFrame = (at: number, count: number): number => (count > 0 ? (at + 1) % count : 0);
