/**
 * The Windows and Linux window controls (Electron's `titleBarOverlay`) follow the theme: after
 * each appearance change the renderer sends main the canvas and ink it just applied. Home says
 * while its background lies under them, and Windows then draws them with no box of their own; a
 * game page says while its picture does, which shows through them only while their ink is light
 * (a dark theme's), since a light theme's dark ink would vanish over a game's dark picture.
 * macOS draws its own traffic lights, so nothing is sent there.
 */
import { useEffect } from "react";
import { StudioPlatform } from "../shared/boot.ts";
import type { StudioApi, WindowControlColors } from "../shared/studio-api.ts";
import { subscribeAppearance } from "./appearance/store.ts";

/** Only a plain `#rrggbb` crosses to main; anything else waits for the next change. */
const HEX_COLOR = /^#[0-9a-f]{6}$/i;

type ThemeStyle = Pick<CSSStyleDeclaration, "getPropertyValue">;

/** Does Home's background lie under the controls now? */
let homeUnder = false;
/** Does a game page's picture lie under them now? */
let pictureUnder = false;
const underChanges = new Set<() => void>();
/** An ink this light or lighter (0–255, the mean of its channels) reads over a dark picture. */
const LIGHT_INK_MIN = 160;

/** Whether a `#rrggbb` ink is light: a dark theme's. */
export function isLightInk(hex: string): boolean {
  const channels = [1, 3, 5].map((at) => Number.parseInt(hex.slice(at, at + 2), 16));
  const mean = channels.reduce((sum, channel) => sum + channel, 0) / channels.length;
  return mean >= LIGHT_INK_MIN;
}

/** The overlay's colours from the root's computed theme tokens, or null while they are not plain hex. */
export function windowControlColors(style: ThemeStyle): WindowControlColors | null {
  const color = style.getPropertyValue("--background").trim();
  const symbolColor = style.getPropertyValue("--foreground").trim();
  if (!HEX_COLOR.test(color) || !HEX_COLOR.test(symbolColor)) return null;
  return { color, symbolColor };
}

/** Home and what may lie over it, as the shell sees them. */
export interface HomeCover {
  /** Home is up at rest: no game launching from it. */
  resting: boolean;
  /** The Play or Plugins room, or a remix being made, covers it. */
  covered: boolean;
  /** The game viewer's native views lie over the window (`nativeViewsUp`). */
  viewerUp: boolean;
}

/** Is Home's background what lies under the controls: Home at rest, with nothing over it? */
export const homeUnderControls = ({ resting, covered, viewerUp }: HomeCover): boolean =>
  resting && !covered && !viewerUp;

/** Home's background now lies under the controls, or no longer does. */
export function setHomeUnderControls(under: boolean): void {
  if (under === homeUnder) return;
  homeUnder = under;
  for (const change of underChanges) change();
}

/** A game page's picture now lies under the controls, or no longer does. */
export function setPictureUnderControls(under: boolean): void {
  if (under === pictureUnder) return;
  pictureUnder = under;
  for (const change of underChanges) change();
}

/** A game page's picture lies under the controls while `under`, until the caller unmounts. */
export function usePictureUnderControls(under: boolean): void {
  useEffect(() => {
    if (!under) return;
    setPictureUnderControls(true);
    return () => setPictureUnderControls(false);
  }, [under]);
}

/** Home's background lies under the controls while `under`, until the caller unmounts. */
export function useHomeUnderControls(under: boolean): void {
  useEffect(() => {
    if (!under) return;
    setHomeUnderControls(true);
    return () => setHomeUnderControls(false);
  }, [under]);
}

/**
 * Send the controls now and after every appearance change or Home coming and going, on the
 * platforms that draw an overlay; returns the unsubscribe.
 */
export function syncWindowControls(
  api: Pick<StudioApi, "setWindowControls">,
  platform: string,
  readStyle: () => ThemeStyle = () => getComputedStyle(document.documentElement),
): () => void {
  if (platform === StudioPlatform.Mac) return () => {};
  let last = "";
  const send = (): void => {
    const colors = windowControlColors(readStyle());
    if (!colors) return;
    const picture = pictureUnder && isLightInk(colors.symbolColor);
    const controls = { ...colors, seeThrough: homeUnder || picture };
    const key = JSON.stringify(controls);
    if (key === last) return;
    last = key;
    void api.setWindowControls(controls).catch(() => {});
  };
  send();
  underChanges.add(send);
  const stopAppearance = subscribeAppearance(send);
  return () => {
    underChanges.delete(send);
    stopAppearance();
  };
}
