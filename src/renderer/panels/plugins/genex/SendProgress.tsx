/** A send on its way: a thin bar and one line saying how much went, how fast and how long is left. */
import type { JSX } from "react";
import type { GenexSendProgress } from "../../../../shared/genex.ts";
import { t } from "../../../../shared/i18n.ts";
import { sendProgressView } from "./send-progress-view.ts";

const PERCENT = 100;

/**
 * The bar and line for `progress`, or nothing when there is nothing to say of it. Read at each
 * render: the publish record is read again every couple of seconds while a send is going.
 */
export function SendProgress({ progress }: { progress: GenexSendProgress | undefined }): JSX.Element | null {
  const view = sendProgressView(progress, Date.now());
  if (!view || (view.fraction === null && !view.amounts && !view.label)) return null;
  const percent = view.fraction === null ? null : Math.round(view.fraction * PERCENT);
  return (
    <span className="genex-send-progress" data-send-progress data-stage={progress?.stage}>
      {percent !== null && (
        <span
          className="genex-send-progress-bar"
          role="progressbar"
          aria-label={view.label ?? t("Sent")}
          aria-valuemin={0}
          aria-valuemax={PERCENT}
          aria-valuenow={percent}
          aria-valuetext={view.amounts ?? undefined}
        >
          <i style={{ width: `${percent}%` }} />
        </span>
      )}
      <span className="genex-send-progress-words">
        {view.label}
        {view.label && view.amounts ? " · " : null}
        {view.amounts}
      </span>
    </span>
  );
}
