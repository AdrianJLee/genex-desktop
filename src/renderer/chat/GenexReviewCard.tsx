/**
 * Genex's review in the game's chat (mockups A2, C2, C3, C4, D2). The game's newest review record or
 * fix press is its live card, drawn from Genex's word now (so "Checking your fixes" turns into "is
 * public again" in place); a live game's card shows its cover, "is live!", its link with Copy link and
 * Open on Genex, and that a takedown would be heard of here. Every older one settles into one line,
 * "{label} · {when} ›", which opens to what it said then, read only.
 */
import type { JSX } from "react";
import { useState } from "react";
import { GENEX_PLUGIN_ID, GenexAction } from "../../shared/genex.ts";
import { intlLocale } from "../../shared/i18n.ts";
import type { GenexReviewEntry } from "../chat-entries.ts";
import { readGenexShot } from "../panels/plugins/genex/genex-cover-shot.ts";
import { ReviewCard } from "../panels/plugins/genex/ReviewCard.tsx";
import {
  fixHistoryLabel,
  historyLabel,
  ReviewPlace,
  type ReviewCardView,
  reviewCardView,
} from "../panels/plugins/genex/review-card-view.ts";
import { useGenexPublishState } from "../panels/plugins/genex/use-genex-publishing.ts";
import { useGenexFix, useGenexReview } from "../panels/plugins/genex/use-genex-review.ts";
import { runPluginAction } from "../plugin-actions.ts";
import { useLibrary, usePlugins } from "../state/hooks.ts";
import { Button } from "../ui/Button.tsx";
import { Icon } from "../ui/icons.tsx";
import { useAsyncEffect } from "../use-async-effect.ts";
import { useCopy } from "../use-copy.ts";
import { GENEX_WORDS, REVIEW_WORDS } from "../words.ts";

/** The longest edge the live card's picture is read at. */
const CARD_PICTURE_PX = 960;

/** A record's time as a history line says it: "Oct 27, 14:06". */
const when = (iso: string): string =>
  Number.isFinite(Date.parse(iso))
    ? new Date(iso).toLocaleString(intlLocale(), { month: "short", day: "numeric", hour: "2-digit", minute: "2-digit" })
    : "";

/** An older record, settled into one line that opens to what it said then. */
function HistoryLine({ entry }: { entry: GenexReviewEntry }): JSX.Element | null {
  const [open, setOpen] = useState(false);
  const label = entry.fix ? fixHistoryLabel(entry.fix.count ?? 0) : historyLabel(entry.review ?? {});
  if (!label) return null;
  const things = entry.review?.things ?? [];
  return (
    <div className="genex-review-history" data-genex-review-history={entry.review?.change ?? "fix"}>
      <button type="button" aria-expanded={open} onClick={() => setOpen(!open)} className="genex-review-history-line">
        <span className="genex-review-history-ring" aria-hidden />
        <span>{label}</span>
        <span className="genex-review-history-when">· {when(entry.review?.at ?? entry.fix?.at ?? entry.at)}</span>
        <Icon name={open ? "chevron-down" : "chevron-right"} size={12} />
      </button>
      {open && things.length > 0 && (
        <ul className="genex-review-things" data-analytics-mask>
          {things.map((thing) => (
            <li key={thing.text}>{thing.text}</li>
          ))}
        </ul>
      )}
    </div>
  );
}

/** The live game's card: its cover, that it is live, its link with Copy link and Open on Genex. */
function LiveCard({ project, view }: { project: string; view: ReviewCardView }): JSX.Element {
  const [src, setSrc] = useState<string | null>(null);
  const [copied, copy] = useCopy();
  const plugin = usePlugins((s) => s.list.find((one) => one.manifest.id === GENEX_PLUGIN_ID));
  const reading = useGenexPublishState(project, true);
  const link = reading.state?.galleryUrl ?? null;
  useAsyncEffect(
    (alive) => {
      void readGenexShot(project, CARD_PICTURE_PX).then((shot) => {
        if (alive()) setSrc(shot);
      });
      return undefined;
    },
    [project],
  );
  const open = () => {
    if (plugin)
      void runPluginAction({
        plugin,
        name: GenexAction.PublishOpen,
        args: { target: "gallery" },
        project,
        review: () => {},
      });
  };
  return (
    <section
      className="genex-review-card genex-review-live"
      data-genex-review={view.kind}
      data-tone="done"
      aria-label={REVIEW_WORDS.label}
    >
      {src && (
        <img src={src} alt={GENEX_WORDS.publish.coverCardAlt} className="genex-review-live-cover" draggable={false} />
      )}
      <p className="genex-review-title">
        <Icon name="check" size={14} />
        <span>{view.title}</span>
      </p>
      {view.lines.map((line) => (
        <p key={line} className="genex-review-line">
          {line}
        </p>
      ))}
      {link && (
        <div className="genex-review-presses">
          <span className="genex-review-link-text" data-analytics-mask>
            {link.replace(/^https:\/\//, "")}
          </span>
          <Button variant="secondary" size="sm" data-genex-review-copy onClick={() => copy(link)}>
            <Icon name={copied ? "check" : "copy"} size={12} />
            {copied ? GENEX_WORDS.publish.copied : REVIEW_WORDS.press.copyLink}
          </Button>
          <Button variant="default" size="sm" data-genex-review-open onClick={open}>
            <Icon name="arrow-up-right" size={12} />
            {REVIEW_WORDS.press.openOnGenex}
          </Button>
        </div>
      )}
      <p className="genex-review-footer">{REVIEW_WORDS.dialog.liveFooter}</p>
    </section>
  );
}

/** The game's live card: Genex's word now and the newest fix press, as the dialog's card draws them. */
function LiveReview({ project }: { project: string }): JSX.Element | null {
  const status = useGenexReview(project);
  const { fix, latest } = useGenexFix(project);
  const title = useLibrary((s) => s.games.find((game) => game.name === project)?.title) || project;
  const view = reviewCardView({ status, fix, latest, title, place: ReviewPlace.Chat });
  if (!view) return null;
  if (view.live) return <LiveCard project={project} view={view} />;
  return (
    <ReviewCard
      project={project}
      title={title}
      view={view}
      record={status?.record ?? null}
      place={ReviewPlace.Chat}
      fixId={fix?.fixId}
    />
  );
}

export function GenexReviewCard({ entry, project }: { entry: GenexReviewEntry; project: string | null }) {
  const game = entry.project ?? project;
  if (!game) return null;
  return entry.latest ? <LiveReview project={game} /> : <HistoryLine entry={entry} />;
}
