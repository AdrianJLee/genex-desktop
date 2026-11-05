/**
 * The native-review fixture: the fixture game is Midnight Asphalt on Genex, its Mac app live, and a
 * moderator took the whole game down for three things to fix. Its publish record, the apps it sent
 * and Genex's review are laid down in the Genex plugin's storage as the plugin keeps them, and its
 * chat holds the review's records (published, then taken down), so the chat's live card and the
 * Publish dialog's card show it. A fixture profile asks Genex nothing (`genexReviewReads: false`).
 */
import { mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import { CustomEvent, customEventData } from "../../shared/custom-events.ts";
import { HOUR_MS } from "../../shared/duration.ts";
import { GENEX_PLUGIN_ID } from "../../shared/genex.ts";
import {
  GenexAppReview,
  GenexHumanReview,
  GenexReviewChange,
  type GenexReviewRecord,
  gameReviewOf,
  reviewFingerprint,
  reviewKeys,
} from "../../shared/genex-review.ts";
import type { StudioCore } from "../studio-core.ts";

/** The game's link on Genex in the fixture. */
const SLUG = "midnight-asphalt";
const SHA = "3f9a21c0".padEnd(64, "0");
const THINGS = [
  {
    text: "The “Get 5,000 coins” button opens an outside payment page",
    where: "Garage → Get coins",
    rule: "Off-platform payment",
  },
  { text: "Loads code from another website (unpkg.com)", where: "src/main.js:3", rule: "Unreviewable remote code" },
  { text: "Sets a cookie before the player agrees", where: "index.html · on load", rule: "Privacy" },
];

/** The fixture game's review as the Genex plugin keeps it, a takedown since `at`. */
function takenDown(published: string, at: string): GenexReviewRecord {
  const apps = [
    {
      platform: "mac",
      arch: "universal",
      state: GenexAppReview.Live,
      version: "1.2.0",
      sha256: SHA,
      sentAt: published,
      decidedAt: published,
      decidedBy: "check" as const,
      things: [],
      humanReview: { state: GenexHumanReview.None, canRequest: false },
    },
  ];
  const takedown = {
    at,
    rule: "Off-platform payment",
    things: THINGS,
    appealable: true,
    humanReview: { state: GenexHumanReview.None, canRequest: true },
  };
  return { state: gameReviewOf(apps, takedown), apps, takedown };
}

const json = (value: unknown) => `${JSON.stringify(value, null, 2)}\n`;

/** Midnight Asphalt on Genex, taken down: its records in the plugin's storage, its review in its chat. */
export async function seedNativeReview(core: StudioCore, project: string, threadId: string): Promise<void> {
  const published = new Date(Date.now() - 48 * HOUR_MS).toISOString();
  const at = new Date(Date.now() - HOUR_MS).toISOString();
  const dir = path.join(core.pluginServices.root(GENEX_PLUGIN_ID), "publish", project);
  await mkdir(path.join(dir, ".genex"), { recursive: true, mode: 0o700 });
  await writeFile(
    path.join(dir, ".genex", "project.json"),
    json({ id: "fixture-midnight", slug: SLUG, status: "published" }),
  );
  await writeFile(
    path.join(dir, "publish.json"),
    json({ version: 1, project, connected: true, slug: SLUG, title: "Midnight Asphalt" }),
  );
  const sent = {
    platform: "mac",
    arch: "universal",
    version: "1.2.0",
    sizeBytes: 1,
    sha256: SHA,
    publishedAt: published,
    review: "approved",
  };
  await writeFile(path.join(dir, "native.json"), json({ jobId: "fixture-job", sent: [sent], failed: [] }));
  const record = takenDown(published, at);
  const told = { fingerprint: reviewFingerprint(record), keys: reviewKeys(record) };
  await writeFile(
    path.join(dir, "review.json"),
    json({ checkedAt: at, source: "list", record, fingerprint: told.fingerprint, told, failures: 0, signedOut: false }),
  );
  const app = { platform: "mac", arch: "universal", version: "1.2.0" };
  await core.append(
    [
      customEventData(CustomEvent.GenexReview, {
        project,
        slug: SLUG,
        change: GenexReviewChange.Live,
        app,
        at: published,
      }),
      customEventData(CustomEvent.GenexReview, {
        project,
        slug: SLUG,
        change: GenexReviewChange.TakenDown,
        things: THINGS,
        count: THINGS.length,
        at,
      }),
    ],
    threadId,
  );
}
