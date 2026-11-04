/**
 * The frame of Play's people pages (Friends, a profile) and a game's own page: the dashboard's page
 * and scroller, its bar holding the sidebar's toggle while the sidebar is hidden, Back, and a page's
 * own controls at its end. A `bleed` page lays its first picture under the bar, to the window's
 * top edge (`.play-page-bleed`).
 */
import type { JSX, ReactNode } from "react";
import { SIDEBAR_TOGGLE, SidebarToggle } from "../shell/use-shell-chrome.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { PLAY_WORDS } from "../words.ts";

/** A people page: its bar, then what scrolls. */
export function PlayPageFrame({
  label,
  sidebarHidden,
  onToggleSidebar,
  onBack,
  backLabel = PLAY_WORDS.people.back,
  bleed = false,
  actions,
  children,
}: {
  label: string;
  sidebarHidden: boolean;
  onToggleSidebar: () => void;
  /** Back to the page before; none on a page the sidebar opens. */
  onBack?: () => void;
  /** What Back says: the page it returns to, when that is clearer than "Back". */
  backLabel?: string;
  /** The page's first picture runs under the bar, to the window's top edge. */
  bleed?: boolean;
  /** The page's own controls, at the bar's end. */
  actions?: ReactNode;
  children: ReactNode;
}): JSX.Element {
  return (
    <section data-play-page aria-label={label} className={`play-page ${bleed ? "play-page-bleed" : ""}`}>
      <div className="play-scroll">
        <header
          className={`play-toolbar people-toolbar titlebar-drag window-controls-end ${sidebarHidden ? "play-toolbar-inset" : ""}`}
        >
          {sidebarHidden && (
            <button
              type="button"
              className="no-drag sidebar-toggle"
              data-sidebar-toggle={SidebarToggle.Show}
              aria-label={SIDEBAR_TOGGLE.Show}
              aria-controls="studio-sidebar"
              aria-expanded="false"
              onClick={onToggleSidebar}
            >
              <Icon name="sidebar" />
            </button>
          )}
          {onBack && (
            <Button variant="ghost" className="no-drag text-ink-3" data-play-back onClick={onBack}>
              <Icon name="chevron-left" />
              {backLabel}
            </Button>
          )}
          {actions && <div className="play-toolbar-end">{actions}</div>}
        </header>
        <div className="people-content">{children}</div>
      </div>
    </section>
  );
}
