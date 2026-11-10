/**
 * The platforms a person switched off on a game's Publish card, kept on this computer so a switch
 * stays where they left it: after the press that left the platform out, and when the card opens
 * again. Pure, but for the storage reads and writes, which never throw.
 */
import { PUBLISH_TARGETS, type PublishTarget } from "../../../../shared/publish-platforms.ts";
import {
  browserStorage,
  type KeyValueStorage,
  readJson,
  removeKey,
  storageKeyFor,
  writeJson,
} from "../../../storage.ts";

const isTarget = (value: unknown): value is PublishTarget => PUBLISH_TARGETS.some((target) => target === value);

/** The platforms left out of `project`'s publishes; none when nothing is kept or what is kept is not a list of them. */
export function readLeftOut(
  project: string,
  storage: KeyValueStorage | null = browserStorage(),
): ReadonlySet<PublishTarget> {
  const kept = readJson<unknown>(storageKeyFor.publishLeftOut(project), [], storage);
  return new Set(Array.isArray(kept) ? kept.filter(isTarget) : []);
}

/** `leftOut` once `target`'s switch is turned: off adds the platform, on forgets it. */
export function leftOutAfter(
  leftOut: ReadonlySet<PublishTarget>,
  target: PublishTarget,
  on: boolean,
): ReadonlySet<PublishTarget> {
  const next = new Set(leftOut);
  if (on) next.delete(target);
  else next.add(target);
  return next;
}

/** Keep `leftOut` for `project`; nothing left out keeps nothing. */
export function writeLeftOut(
  project: string,
  leftOut: ReadonlySet<PublishTarget>,
  storage: KeyValueStorage | null = browserStorage(),
): void {
  const key = storageKeyFor.publishLeftOut(project);
  if (leftOut.size === 0) removeKey(key, storage);
  else writeJson(key, [...leftOut].sort(), storage);
}
