/**
 * The Publish card's state and its one press, for a game made in an engine. The rows wait for both
 * the game folder and Genex's record; a switch stays where the person left it, after a press and
 * when the card opens again (`publish-left-out.ts`); a press does what its plan says. Build: the
 * agent builds apps here and Genex Cloud builds the ones this computer can't, both at once, and
 * players get nothing (Genex Cloud keeps what it builds). Publish: the card sends what is ready,
 * gives players what Genex Cloud built (or still builds, once built), and takes switched-off
 * platforms down.
 */
import { useState } from "react";
import { GenexAction, GenexHostedStatus, type GenexNativeRecord } from "../../../../shared/genex.ts";
import type { FactRef } from "../../../../shared/project-facts.ts";
import { type PublishPlatform, PublishTarget } from "../../../../shared/publish-platforms.ts";
import { composeInChat } from "../../../compose-in-chat.ts";
import { hostPlatform } from "../../../platform.ts";
import { useLibrary } from "../../../state/hooks.ts";
import {
  type CardError,
  CardErrorKind,
  type CardRow,
  CardWork,
  cardErrors,
  cardRows,
  type PressPlan,
  busyPress,
  keptSwitches,
  pressNote,
  pressPlan,
} from "./publish-card-view.ts";
import { leftOutAfter, readLeftOut, writeLeftOut } from "./publish-left-out.ts";
import {
  appsMadeHere,
  cloudFixAsk,
  makeAppAsk,
  makeWebAsk,
  rebuildAsk,
  webOfferFor,
} from "./publish-platforms-view.ts";
import type { usePublishRecord } from "./use-publish-record.ts";

type PublishRecord = ReturnType<typeof usePublishRecord>;

/**
 * The apps the agent was asked to build from a game's card, by when, for this run of the app: the
 * card says so again when it opens while the agent still builds.
 */
const ASKED = new Map<string, ReadonlyMap<PublishTarget, string>>();

const NO_FACTS: readonly FactRef[] = [];

/** What a Build step sends the agent: make the app (or the web version), or build it again. */
function buildAsk(row: CardRow | undefined, target: PublishTarget, title: string): string {
  if (target === PublishTarget.Web) return makeWebAsk(title);
  return row?.live ? rebuildAsk(target, title) : makeAppAsk(target, title);
}

/** The targets of a plan's steps of one kind. */
const targetsOf = (plan: PressPlan, work: CardWork): PublishTarget[] =>
  plan.steps.filter((step) => step.work === work).map((step) => step.target);

/** One error block as the card draws it: what failed, when the agent was handed it, and its press. */
export interface ErrorBlock extends CardError {
  /** When the agent was handed this error from the card; null before. */
  sentAt: string | null;
  /** A failed build: hand its log to the agent. */
  onSend?: () => void;
  /** A send that didn't reach Genex, or a build that didn't start: do it again. */
  onRetry?: () => void;
}

/** What Try again does for a block: start the build again, or send the app again. */
const RETRY_WORK = { [CardErrorKind.Start]: CardWork.Cloud, [CardErrorKind.Send]: CardWork.Publish } as const;

/**
 * The card's error blocks, each with its press: Send to agent for a failed Genex Cloud build (the block
 * then says the agent is fixing it, until the error changes), Try again for a build that didn't start
 * or an app that didn't reach Genex.
 */
function useErrorBlocks(
  project: string,
  title: string,
  platforms: PublishPlatform[] | null,
  native: GenexNativeRecord | undefined,
  press: (plan: PressPlan) => Promise<void>,
): ErrorBlock[] {
  const [sent, setSent] = useState<ReadonlyMap<string, string>>(() => new Map());
  const errors = platforms ? cardErrors(platforms, native) : [];
  return errors.map((error) => {
    const key = `${error.target}\n${error.kind}\n${error.text}`;
    const block: ErrorBlock = { ...error, sentAt: sent.get(key) ?? null };
    if (error.kind !== CardErrorKind.Build) {
      const retry: PressPlan = {
        label: "",
        steps: [{ target: error.target, work: RETRY_WORK[error.kind] }],
        warn: false,
      };
      return { ...block, onRetry: () => void press(retry) };
    }
    const onSend = (): void => {
      composeInChat({
        project,
        text: cloudFixAsk({ target: error.target, errors: error.text.split("\n") }, title),
        send: true,
      });
      setSent((before) => new Map(before).set(key, new Date().toISOString()));
    };
    return { ...block, onSend };
  });
}

/**
 * The card's switches: the ones turned in this dialog, over the platforms the person left out of
 * `project`'s publishes before. Turning one is kept at once, so it is where it was left after any
 * press and when the card opens again.
 */
function useCardSwitches(project: string, rows: readonly CardRow[] | null) {
  const [chosen, setChosen] = useState<ReadonlyMap<PublishTarget, boolean>>(() => new Map());
  const [leftOut, setLeftOut] = useState(() => readLeftOut(project));
  const onSwitch = (target: PublishTarget, on: boolean): void => {
    const next = leftOutAfter(leftOut, target, on);
    setChosen((before) => new Map(before).set(target, on));
    setLeftOut(next);
    writeLeftOut(project, next);
  };
  return { switches: rows ? keptSwitches(rows, leftOut, chosen) : chosen, onSwitch };
}

/** What the card shows and does for `project`, from its record and the folder's platforms (null until read). */
export function usePublishCard({
  project,
  record,
  platforms,
  name,
  remix,
  replacesApps,
}: {
  project: string;
  record: PublishRecord;
  platforms: PublishPlatform[] | null;
  /** The game's name as the banner has it: what the publish lists it under. */
  name: string;
  /** Allow remixing: whether the publish sends the game's project. */
  remix: boolean;
  /** The card said this web build takes the place of a page that shows only the game's apps. */
  replacesApps: boolean;
}) {
  const facts = useLibrary((s) => s.games.find((g) => g.name === project)?.facts) ?? NO_FACTS;
  const title = useLibrary((s) => s.games.find((g) => g.name === project)?.title) || project;
  const [asked, setAsked] = useState<ReadonlyMap<PublishTarget, string>>(() => ASKED.get(project) ?? new Map());
  const [acting, setActing] = useState(false);
  const state = record.state;
  const rows =
    platforms && state
      ? cardRows({
          platforms,
          native: state.native,
          now: Date.now(),
          webOffer: webOfferFor(facts),
          madeHere: appsMadeHere(facts, hostPlatform()),
          hostedWeb: state.hostedWeb,
          ...(state.status ? { listed: state.status === GenexHostedStatus.Published } : {}),
          webPublishedAt: state.lastPublishAt,
          asked,
          mac: hostPlatform() === "darwin",
        })
      : null;
  const { switches, onSwitch } = useCardSwitches(project, rows);
  const remember = (targets: readonly PublishTarget[]): void => {
    const at = new Date().toISOString();
    const next = new Map(asked);
    for (const target of targets) next.set(target, at);
    ASKED.set(project, next);
    setAsked(next);
  };
  const ask = (targets: readonly PublishTarget[]): void => {
    if (targets.length === 0) return;
    const text = targets.map((target) =>
      buildAsk(
        rows?.find((row) => row.target === target),
        target,
        title,
      ),
    );
    composeInChat({ project, text: text.join("\n\n"), send: true });
    remember(targets);
  };
  const takeDown = async (targets: readonly PublishTarget[]): Promise<void> => {
    for (const target of targets)
      await (target === PublishTarget.Web
        ? record.act(GenexAction.PublishRemoveWeb)
        : record.act(GenexAction.PublishRemoveApp, { platform: target }));
  };
  /**
   * Genex Cloud builds each app and keeps it. A build Genex refuses before anything goes is the record's
   * error line; one whose project didn't arrive is the record's too, shown in its block.
   */
  const buildOnCloud = async (targets: readonly PublishTarget[]): Promise<void> => {
    for (const target of targets) await record.buildOnCloud(target);
  };
  const send = async (plan: PressPlan): Promise<void> => {
    const published = targetsOf(plan, CardWork.Publish);
    const apps = published.filter((target) => target !== PublishTarget.Web);
    const released = targetsOf(plan, CardWork.Release);
    const web = published.includes(PublishTarget.Web);
    if (web) await record.publish(name, remix, replacesApps, apps);
    // What Genex Cloud made goes with the apps; after a web publish, on its own.
    if (released.length > 0 || (!web && apps.length > 0))
      await record.publishApps(name, remix, web ? [] : apps, released);
  };
  const press = async (plan: PressPlan): Promise<void> => {
    setActing(true);
    try {
      ask(targetsOf(plan, CardWork.Build));
      await buildOnCloud(targetsOf(plan, CardWork.Cloud));
      await takeDown(targetsOf(plan, CardWork.TakeDown));
      await send(plan);
    } finally {
      setActing(false);
      await record.refresh();
    }
  };
  const errors = useErrorBlocks(project, title, platforms, state?.native, press);
  const plan = rows ? pressPlan(rows, switches) : null;
  const busy = rows ? busyPress(rows) : null;
  const named = plan?.steps.map((step) => step.target) ?? [];
  return {
    /** The error blocks under the rows, each with its press. */
    errors,
    rows,
    switches,
    onSwitch,
    plan,
    busy,
    /** The line under the button while Genex Cloud works: the active button's, else the busy one's. */
    note: rows && plan ? pressNote(rows, named) : (busy?.note ?? null),
    /** The agent is building an app here: the folder is read again until it lands. */
    building: rows?.some((row) => row.here) ?? false,
    press,
    acting,
  };
}
