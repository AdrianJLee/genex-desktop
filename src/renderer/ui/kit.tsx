import { Tooltip, TooltipTrigger, TooltipContent } from "./tooltip.tsx";
/** Shared desktop icon buttons and status dots on the Genex system. */
import type { JSX, Ref } from "react";
import { Icon, type IconName } from "./icons.tsx";
import { Shortcut } from "./Shortcut.tsx";

/** "Search games · ⌘K" reads as a label with its shortcut chip. */
function TipText({ text }: { text: string }): JSX.Element {
  const [name, keys] = text.split(" · ");
  return keys && /^[⌘⌃⌥⇧]/.test(keys) ? (
    <span className="flex items-center gap-2">
      {name}
      <Shortcut>{keys}</Shortcut>
    </span>
  ) : (
    <>{text}</>
  );
}

/**
 * How far a tooltip turned to a side opens from its control: past the 8px it slides in by, less
 * the glyph's own inset, so it never passes over the glyph and takes the hover from it as it opens.
 */
export const SIDE_TOOLTIP_OFFSET = 6;

/** Where a tooltip opens beside its control when not above it. */
export type TooltipSide = "right" | "bottom" | "left";

/** A square button that is only a glyph, one control height tall, so groups stay level. */
export function IconButton({
  icon,
  label,
  onClick,
  title,
  disabled,
  active = false,
  expanded,
  size = 16,
  className = "",
  tooltipSide,
  ref,
}: {
  icon: IconName;
  /** Required: an icon with no accessible name is a mystery box. */
  label: string;
  onClick?: () => void;
  title?: string;
  disabled?: boolean;
  active?: boolean;
  /** Set only when the button opens a menu: it becomes the button's aria-expanded. */
  expanded?: boolean;
  size?: number;
  className?: string;
  /** Where its tooltip opens when not above it (where it would cover what it sits under). */
  tooltipSide?: TooltipSide;
  /** Menus anchor to their trigger, so the trigger has to be reachable. */
  ref?: Ref<HTMLButtonElement>;
}): JSX.Element {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          ref={ref}
          type="button"
          aria-label={label}
          disabled={disabled}
          onClick={onClick}
          {...(expanded === undefined ? {} : { "aria-haspopup": "menu" as const, "aria-expanded": expanded })}
          className={`hit-24 grid size-ctl shrink-0 place-items-center rounded-sm
        transition-[background-color,color] duration-[var(--dur)] ease-out disabled:cursor-default disabled:opacity-35
        ${active ? "bg-control-hover text-control-text-hover" : "text-icon enabled:hover:bg-control-hover enabled:hover:text-control-text-hover"}
        ${className}`}
        >
          <Icon name={icon} size={size} />
        </button>
      </TooltipTrigger>
      <TooltipContent {...(tooltipSide ? { side: tooltipSide, sideOffset: SIDE_TOOLTIP_OFFSET } : {})}>
        <TipText text={title ?? label} />
      </TooltipContent>
    </Tooltip>
  );
}

/* ── status ─────────────────────────────────────────────────────────────── */
/** A still dot's colour for each tone. */
const DOT_COLOUR: Record<"ok" | "warn" | "bad" | "idle", string> = {
  ok: "bg-green",
  warn: "bg-orange",
  bad: "bg-red",
  idle: "bg-fg-3",
};

export function Dot({
  tone = "idle",
  className = "",
}: {
  tone?: "ok" | "warn" | "bad" | "idle" | "busy";
  className?: string;
}): JSX.Element {
  if (tone === "busy") {
    return (
      <span className={`relative grid size-3 shrink-0 place-items-center ${className}`}>
        <span className="absolute size-2.5 animate-ping rounded-full bg-accent opacity-30" />
        <span className="size-1.5 rounded-full bg-accent" />
      </span>
    );
  }
  return <span className={`size-1.5 shrink-0 rounded-full ${DOT_COLOUR[tone]} ${className}`} />;
}
