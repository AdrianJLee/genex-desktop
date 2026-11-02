/**
 * The top of a native game's page (canvas "Bodycam game page", round 2, A): the game's clip or
 * pictures run under the window's top edge, darkened toward its foot and start, with the title,
 * maker, counts, the primary block and Like · Comments · Share over them (`children`); once it has
 * two pictures or more, their thumbnails sit at its foot with the slideshow's progress along the
 * one showing. With nothing to show, or once every picture failed, it draws the no-cover plate on
 * the page's own colour. The clip plays by the window's clip rules (`clip-playback.ts`: Reduce
 * Motion, the one pause, a viewer over the page, out of view); the slideshow stops for the same
 * pause and for Reduce Motion, and a still that shows alone settles in once instead of moving.
 */
import type { JSX, ReactNode, RefObject } from "react";
import { useEffect, useId, useRef, useState, useSyncExternalStore } from "react";
import { t } from "../../shared/i18n.ts";
import { Icon } from "../ui/icons.tsx";
import { REDUCED_MOTION_QUERY } from "../ui/media-queries.ts";
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip.tsx";
import { PLAY_WORDS } from "../words.ts";
import { toggleClipsPaused, useClipControl, useClipsPaused } from "./clip-playback.ts";
import { CoverClip } from "./CoverClip.tsx";
import { HERO_FRAME_MS, HeroArt, type HeroFrame, heroArt, nextFrame, runsSlideshow } from "./game-hero.ts";
import { NoCover } from "./NoCover.tsx";

const CLIP_WORDS = PLAY_WORDS.clips;

const subscribeMotion = (change: () => void): (() => void) => {
  const query = window.matchMedia(REDUCED_MOTION_QUERY);
  query.addEventListener("change", change);
  return () => query.removeEventListener("change", change);
};

/** Reduce Motion, as the computer says now. */
export const useReducedMotion = (): boolean =>
  useSyncExternalStore(subscribeMotion, () => window.matchMedia(REDUCED_MOTION_QUERY).matches);

/**
 * The slideshow's picture: the first until there are two, then the next HERO_FRAME_MS after each
 * change while `running`; a pick shows that picture and gives it its whole time.
 */
export function useSlideshow(count: number, running: boolean): { at: number; pick: (at: number) => void } {
  const [chosen, setChosen] = useState(0);
  const at = chosen < count ? chosen : 0;
  const ticking = running && count > 1;
  useEffect(() => {
    if (!ticking) return;
    const timer = window.setTimeout(() => setChosen(nextFrame(at, count)), HERO_FRAME_MS);
    return () => window.clearTimeout(timer);
  }, [ticking, at, count]);
  return { at, pick: setChosen };
}

/**
 * Whether the top moves now and so carries its pause: its clip can play (the window's clip rules), or
 * its slideshow runs with motion allowed.
 */
export function useHeroMoves(frames: readonly HeroFrame[]): boolean {
  const clip = useClipControl();
  const reduced = useReducedMotion();
  return (heroArt(frames) === HeroArt.Clip && clip) || (runsSlideshow(frames) && !reduced);
}

/** The top's one pause, at the page bar's end: every clip and the slideshow, remembered on this computer. */
export function HeroPause(): JSX.Element {
  const paused = useClipsPaused();
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          className="game-hero-pause no-drag"
          data-game-action="pause"
          data-play-clips={paused ? "paused" : "playing"}
          aria-label={CLIP_WORDS.pause}
          aria-pressed={paused}
          onClick={toggleClipsPaused}
        >
          <Icon name={paused ? "play" : "pause"} size={16} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{paused ? CLIP_WORDS.play : CLIP_WORDS.pause}</TooltipContent>
    </Tooltip>
  );
}

/** One picture of the run: its still, and over the first its clip once the still has drawn. */
function Frame({
  frame,
  current,
  alone,
  clipKey,
  anchor,
  onFailed,
}: {
  frame: HeroFrame;
  current: boolean;
  /** The only picture: it settles in once rather than drifting. */
  alone: boolean;
  clipKey: string;
  anchor: RefObject<HTMLElement | null>;
  onFailed: (src: string) => void;
}): JSX.Element {
  const [drawn, setDrawn] = useState(false);
  return (
    <div className="game-hero-frame" data-current={current || undefined} data-alone={alone || undefined}>
      <img
        src={frame.src}
        alt=""
        draggable={false}
        decoding="async"
        data-shown={drawn || undefined}
        onLoad={() => setDrawn(true)}
        onError={() => onFailed(frame.src)}
      />
      {frame.clip && <CoverClip clipKey={clipKey} url={frame.clip} ready={drawn} autoplay index={0} anchor={anchor} />}
    </div>
  );
}

/** The thumbnails at the top's foot: one per picture, the clip's marked, the one showing ringed. */
function Thumbs({
  frames,
  at,
  moving,
  title,
  onPick,
}: {
  frames: readonly HeroFrame[];
  at: number;
  /** The slideshow runs: the one showing fills its line over its time. */
  moving: boolean;
  title: string;
  onPick: (at: number) => void;
}): JSX.Element {
  return (
    <div className="game-hero-thumbs">
      {frames.map((frame, index) => (
        <button
          key={frame.src}
          type="button"
          className="game-hero-thumb"
          data-game-action="pick-shot"
          aria-pressed={index === at}
          aria-label={t("{game} {number}", { game: title, number: index + 1 })}
          onClick={() => onPick(index)}
        >
          <img src={frame.src} alt="" draggable={false} decoding="async" />
          {frame.clip && (
            <span className="game-hero-thumb-clip" aria-hidden="true">
              <Icon name="play" size={10} />
            </span>
          )}
          {/* Keyed by the pick, so the line starts again from nothing whenever this one is shown. */}
          {index === at && moving && <span key={at} className="game-hero-thumb-line" aria-hidden="true" />}
        </button>
      ))}
    </div>
  );
}

/** The top of the page: its art, the shade that keeps the words readable, the words and the thumbnails. */
export function GameHero({
  title,
  frames,
  at,
  onPick,
  onFailed,
  children,
}: {
  title: string;
  frames: readonly HeroFrame[];
  /** The picture showing. */
  at: number;
  onPick: (at: number) => void;
  /** A picture failed to load: it leaves the run. */
  onFailed: (src: string) => void;
  /** The title, maker, counts and actions over the art. */
  children: ReactNode;
}): JSX.Element {
  const anchor = useRef<HTMLElement>(null);
  const clipKey = useId();
  const art = heroArt(frames);
  const slideshow = runsSlideshow(frames);
  const paused = useClipsPaused();
  const reduced = useReducedMotion();
  return (
    <section
      ref={anchor}
      className="game-hero"
      data-game-hero={art}
      data-still={paused || reduced || undefined}
      aria-label={title}
    >
      <div className="game-hero-art">
        {art === HeroArt.None ? (
          <NoCover fill />
        ) : (
          frames.map((frame, index) => (
            <Frame
              key={frame.src}
              frame={frame}
              current={index === at}
              alone={!slideshow}
              clipKey={clipKey}
              anchor={anchor}
              onFailed={onFailed}
            />
          ))
        )}
      </div>
      <div className="game-hero-shade" aria-hidden="true" />
      <div className="game-hero-foot">
        <div className="game-hero-head">{children}</div>
        {slideshow && <Thumbs frames={frames} at={at} moving={!paused && !reduced} title={title} onPick={onPick} />}
      </div>
    </section>
  );
}
