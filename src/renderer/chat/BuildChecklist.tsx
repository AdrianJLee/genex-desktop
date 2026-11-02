/**
 * The Building card's steps, opened under it (`BuildStatus.tsx`): each step with its mark and where
 * it stands, and the way to the whole build on Builds. Its rows are `build-checklist.ts`'s; their
 * time left moves on while the list is open.
 */
import type { JSX } from "react";
import { Icon } from "../ui/icons.tsx";
import { BUILD_CHECKLIST_WORDS as WORDS } from "../words.ts";
import { type BuildChecklist as Checklist, PartMark } from "./build-checklist.ts";
import { StepMark } from "./StepMark.tsx";

/** The open list: one row a step, then Open in Builds when Builds can be opened. */
export function BuildChecklist({
  id,
  list,
  onOpenBuilds,
}: {
  id: string;
  list: Checklist;
  onOpenBuilds?: () => void;
}): JSX.Element {
  return (
    <div id={id} data-build-checklist className="relative z-[1] flex min-w-0 flex-col gap-1 px-2 pt-[3px] pb-1">
      <ul aria-label={WORDS.list} className="m-0 flex min-w-0 list-none flex-col p-0">
        {list.rows.map((row) => (
          <li key={row.id} data-part-row={row.mark} className="flex min-w-0 items-start gap-2.5 py-1 text-chat-sub">
            <StepMark done={row.mark === PartMark.Added} working={row.mark === PartMark.Working} clear />
            <span className={`line-clamp-2 min-w-0 flex-1 ${row.mark === PartMark.Next ? "text-ink-3" : "text-ink"}`}>
              {row.title}
            </span>
            <span className="shrink-0 ps-2 text-ink-3">{row.status}</span>
          </li>
        ))}
      </ul>
      {onOpenBuilds ? (
        <button type="button" data-open-build onClick={onOpenBuilds} className="build-checklist-open pill-quiet">
          {WORDS.open}
          <Icon name="chevron-right" size={12} strokeWidth={2} />
        </button>
      ) : null}
    </div>
  );
}
