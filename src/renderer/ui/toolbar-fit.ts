/**
 * The composer toolbar keeps the model's name whole. When the name would be cut short, the
 * permissions pill's label gives way first, then the context ring, and in the narrowest chat the
 * permissions pill itself (never Bypass's warning); only then does the name truncate. Measured, not a width threshold: names and labels differ in
 * length.
 */
import { type RefObject, useLayoutEffect, useRef } from "react";

/** What the toolbar has given up for the model's name (`data-squeeze`, theme.css). */
const ToolbarSqueeze = {
  PermissionLabel: "permission-label",
  Ring: "ring",
  Permission: "permission",
} as const;
type ToolbarSqueeze = (typeof ToolbarSqueeze)[keyof typeof ToolbarSqueeze];

/** Everything shown, then each step in the order the toolbar gives it up; each keeps the ones before. */
const STEPS: readonly (ToolbarSqueeze | null)[] = [
  null,
  ToolbarSqueeze.PermissionLabel,
  ToolbarSqueeze.Ring,
  ToolbarSqueeze.Permission,
];

/** Is any text that should read whole (`data-fit`) cut short? A hidden one is not. */
function cutShort(toolbar: HTMLElement): boolean {
  return [...toolbar.querySelectorAll<HTMLElement>("[data-fit]")].some((text) => text.scrollWidth > text.clientWidth);
}

/** The first step at which nothing is cut short (the last one when that never happens). */
function fit(toolbar: HTMLElement): void {
  for (const step of STEPS) {
    if (step) toolbar.dataset.squeeze = step;
    else delete toolbar.dataset.squeeze;
    if (!cutShort(toolbar)) return;
  }
}

/** What the toolbar says and which modes it shows: a render that leaves this alone needs no fitting. */
function contentOf(toolbar: HTMLElement): string {
  const modes = [...toolbar.querySelectorAll<HTMLElement>("[data-mode]")].map((element) => element.dataset.mode ?? "");
  return `${toolbar.textContent ?? ""}\u0000${modes.join(" ")}`;
}

/**
 * Fits the toolbar before it paints: after a render that changed what it says (a name, a mode or a
 * limit — not every keystroke in the draft beside it) and whenever its width changes. The
 * attribute is set on the element directly, so a resize never shows a frame with the name cut short.
 */
export function useToolbarFit(toolbar: RefObject<HTMLElement | null>): void {
  const fitted = useRef<string | null>(null);
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const content = contentOf(element);
    if (content === fitted.current) return;
    fitted.current = content;
    fit(element);
  });
  useLayoutEffect(() => {
    const element = toolbar.current;
    if (!element) return;
    const observer = new ResizeObserver(() => fit(element));
    observer.observe(element);
    return () => observer.disconnect();
  }, [toolbar]);
}
