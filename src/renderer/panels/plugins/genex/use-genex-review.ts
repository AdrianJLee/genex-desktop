/**
 * A game's review as the Publish dialog and the chat's review card read it: Genex's word from the
 * Genex plugin (`studio:plugins.genex-review-status`), read again whenever main's review watch says it
 * changed; the dialog also asks main to read Genex again while something is open (main reads at most
 * once a 30 s). And the game's newest Fix with agent press, read from its chat's log.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { SECOND_MS } from "../../../../shared/duration.ts";
import { CustomEvent, customPayload } from "../../../../shared/custom-events.ts";
import type { EventEnvelope } from "../../../../shared/event-log.ts";
import type { GenexReviewPayload, GenexReviewStatus } from "../../../../shared/genex-review.ts";
import { type GenexFixState, newestFix } from "../../../../shared/genex-review-log.ts";
import { UiEvent } from "../../../../shared/ui-events.ts";
import { useEventLog } from "../../../state/hooks.ts";

/** How often the open dialog reads the review again while something is open. */
const REVIEW_POLL_MS = 10 * SECOND_MS;

/** The game's review, or null before it is read (or for a game Genex does not know). */
export function useGenexReview(project: string | null, options: { poll?: boolean } = {}): GenexReviewStatus | null {
  const [status, setStatus] = useState<GenexReviewStatus | null>(null);
  const open = useRef(false);
  useEffect(() => {
    if (!project) return undefined;
    let alive = true;
    const read = (refresh: boolean) =>
      void window.studio
        .genexReviewStatus(project, refresh)
        .then((next) => {
          if (!alive) return;
          open.current = next.open;
          setStatus(next);
        })
        .catch(() => {});
    read(options.poll === true);
    const off = window.studio.onEvent((event) => {
      if (event.type === UiEvent.GenexReviewChanged && event.payload.project === project) read(false);
    });
    const timer = options.poll ? window.setInterval(() => read(open.current), REVIEW_POLL_MS) : undefined;
    return () => {
      alive = false;
      off();
      if (timer !== undefined) window.clearInterval(timer);
    };
  }, [project, options.poll]);
  return status;
}

/** The game's review records in the order they were written, across its chats. */
function reviewEvents(byThread: Readonly<Record<string, EventEnvelope[]>>, project: string): EventEnvelope[] {
  const about = (event: EventEnvelope) => {
    const payload =
      customPayload(event.data, CustomEvent.GenexReview) ?? customPayload(event.data, CustomEvent.GenexReviewFix);
    return payload !== null && payload.project === project;
  };
  return Object.values(byThread)
    .flatMap((events) => events.filter(about))
    .sort((a, b) => a.created_at.localeCompare(b.created_at));
}

/** The game's newest fix press and its newest review record, from its chats' logs. */
export function useGenexFix(project: string | null): {
  fix: GenexFixState | null;
  latest: Partial<GenexReviewPayload> | null;
} {
  const byThread = useEventLog((s) => s.byThread);
  return useMemo(() => {
    if (!project) return { fix: null, latest: null };
    const events = reviewEvents(byThread, project);
    const latest = events.map((event) => customPayload(event.data, CustomEvent.GenexReview)).findLast(Boolean) ?? null;
    return { fix: newestFix(events, project), latest };
  }, [byThread, project]);
}
