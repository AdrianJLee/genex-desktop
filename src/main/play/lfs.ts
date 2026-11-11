/**
 * A remix's Git LFS files over https, without git-lfs. The clone keeps each model as a pointer (its
 * SHA-256 and size); the game's own repository on Genex's git says where each object is (the Git
 * LFS batch API), each is downloaded once, and it takes its pointers' places only once its bytes
 * match. No git-lfs has to be installed, or found: an app opened from the Dock or the Start menu
 * never looks where Homebrew puts one. Only files the clone's attributes route through Git LFS
 * count, as git-lfs counts them, and every request is https, redirects included.
 *
 * A big game's files take hours, and a download link lives minutes: links are asked for a batch at
 * a time, right before its objects download, and again once when one has run out. The disk is
 * asked for room before the first byte. Given a folder to keep them in (`kept`), files that came
 * whole stay there by their SHA-256 when another fails, and the next attempt checks each again and
 * downloads only the rest.
 */
import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { copyFile, lstat, mkdir, open, readdir, readFile, rename, rm, rmdir } from "node:fs/promises";
import path from "node:path";
import { SECOND_MS } from "../../shared/duration.ts";
import { isBelow } from "../../substrate/paths.ts";
import { isRecord } from "./gallery.ts";

/** The most objects one batch request asks for, as git-lfs asks. */
const BATCH_MAX_OBJECTS = 100;
/** How many objects download at once. */
const PARALLEL_DOWNLOADS = 4;
/** A pointer is smaller than this (the Git LFS spec): a bigger file is the file itself. */
const POINTER_MAX_BYTES = 1024;
/** How many bytes come between two reports of the models' download. */
const PROGRESS_STEP_BYTES = 1024 * 1024;
/** The Git LFS API's media type. */
const LFS_MEDIA_TYPE = "application/vnd.git-lfs+json";
/** The HTTP statuses that redirect. */
const REDIRECT_STATUSES: ReadonlySet<number> = new Set([301, 302, 303, 307, 308]);
/** The most redirects one download follows. */
const MAX_REDIRECTS = 5;
/** Where downloads go when nothing is kept between attempts: inside the clone's `.git`, which the copy drops. */
const PARTS_DIR = "genex-lfs";
/** What a download is called until its bytes match: never a name a whole object has. */
const PART_SUFFIX = ".part";
/** A whole object's name where it is kept: its SHA-256, lowercase hex, and nothing else. */
const OBJECT_ID = /^[0-9a-f]{64}$/;
/** The statuses storage answers for a link that has run out. */
const LINK_REFUSED_STATUSES: ReadonlySet<number> = new Set([401, 403]);
/** A link this close to its end is asked for again before it is used. */
const LINK_EXPIRY_MARGIN_MS = 10 * SECOND_MS;
/** Free space kept beyond the files themselves, as a native install keeps (`INSTALL_RESERVE_BYTES`). */
export const LFS_RESERVE_BYTES = 1024 ** 3;
/** How much of a kept file is read at a time while its SHA-256 is checked. */
const HASH_CHUNK_BYTES = 1024 * 1024;
/** A pointer as Git LFS writes it: the spec's version, a SHA-256 and a size, one per line. */
const POINTER =
  /^version https:\/\/git-lfs\.github\.com\/spec\/v1\r?\noid sha256:([0-9a-f]{64})\r?\nsize (\d{1,15})\r?\n?$/;

const MESSAGE = {
  BatchFailed: (status: number) => `Genex’s git answered ${status} when asked for this game’s files`,
  BatchUnreadable: "Genex’s git’s answer about this game’s files couldn’t be read",
  BatchStalled: "Genex’s git stopped answering about this game’s files",
  ModelsMissing: (files: number) => `${files} of this game’s files didn’t download from Git LFS`,
  DownloadRefused: "A download address for this game’s files was refused",
  DownloadFailed: (status: number) => `A file of this game didn’t download (${status})`,
  Mismatch: "A file of this game didn’t match what its repository says it is",
  Stalled: "A file of this game stopped moving while it downloaded",
  NoSpace: (needed: number, free: number) =>
    `This game’s files need ${needed} bytes of free space, and the disk has ${free}`,
  KeptRefused: "A kept file’s name was refused",
} as const;

/** The disk can't hold the clone's Git LFS files and the reserve: nothing was downloaded. */
export class LfsNoSpaceError extends Error {
  /** The bytes the files still to come and the reserve take. */
  readonly needed: number;
  /** The bytes the disk has free. */
  readonly free: number;
  constructor(needed: number, free: number) {
    super(MESSAGE.NoSpace(needed, free));
    this.name = "LfsNoSpaceError";
    this.needed = needed;
    this.free = free;
  }
}

/** Storage refused a link as run out (401, 403): asked for again once, then the download's failure. */
class LinkRefusedError extends Error {
  constructor(status: number) {
    super(MESSAGE.DownloadFailed(status));
    this.name = "LinkRefusedError";
  }
}

/** The object a pointer stands for: its SHA-256 (lowercase hex) and its size in bytes. */
export interface LfsObject {
  oid: string;
  size: number;
}

/** A file of the clone that is a pointer, by its path in the clone. */
export interface LfsPointer extends LfsObject {
  file: string;
}

/** How the files are fetched: the network, who hears the bytes, and a guard against a stalled download. */
export interface LfsDownloadDeps {
  fetch(input: string, init?: RequestInit): Promise<Response>;
  /** Which of these files (paths in the clone) its attributes route through Git LFS (`filter=lfs`). */
  routed(files: string[]): Promise<Set<string>>;
  /** Hears the bytes downloaded so far, of the total. */
  models(done: number, total: number): void;
  /** A guard whose signal aborts once its download has not `moved` for a while. */
  guard(): { signal: AbortSignal; moved: () => void; stop: () => void };
  /** The time now, in milliseconds: what a link's end is measured against. */
  now(): number;
  /** The free bytes on the disk holding `dir`. */
  freeBytes(dir: string): Promise<number>;
  /**
   * A folder, on the clone's disk, where files that came whole stay when another fails, each by
   * its SHA-256. Without one nothing outlives the call.
   */
  kept?: string;
}

/** Where an object downloads from, as the batch API answered, and when that stops being so. */
interface LfsAction {
  href: string;
  header: Record<string, string>;
  /** When the link runs out, on the `now` clock; null when the answer did not say. */
  expiresAt: number | null;
}

/** One batch's links, asked for again as they run out. */
interface BatchLinks {
  /** The object's link, asked for again first when its time has passed. */
  current(object: LfsObject): LfsAction | Promise<LfsAction>;
  /** A new link for the object: the batch API is asked again for every object still to come. */
  renewed(object: LfsObject): Promise<LfsAction>;
  /** The object is whole: later asks leave it out. */
  finished(object: LfsObject): void;
}

/** Counts the bytes that have come and tells them, a step at a time. */
interface Tally {
  add(bytes: number): void;
  /** Tell the bytes so far now, whatever the step. */
  tell(): void;
}

/** The object a pointer's text stands for, or null when the text is not exactly a pointer. */
export function parseLfsPointer(text: string): LfsObject | null {
  const match = POINTER.exec(text);
  if (!match?.[1] || !match[2]) return null;
  const size = Number(match[2]);
  return Number.isSafeInteger(size) ? { oid: match[1], size } : null;
}

/**
 * Every file of the clone in `dir` that is a pointer and that its attributes route through Git LFS
 * (`routed`), as git-lfs finds them. Its `.git` and its links are never read.
 */
export async function findLfsPointers(dir: string, routed: LfsDownloadDeps["routed"]): Promise<LfsPointer[]> {
  const pointers: LfsPointer[] = [];
  for (const file of await filesOf(dir)) {
    const full = path.join(dir, file);
    if ((await lstat(full)).size >= POINTER_MAX_BYTES) continue;
    const object = parseLfsPointer(await readFile(full, "utf8"));
    if (object) pointers.push({ file, ...object });
  }
  if (pointers.length === 0) return pointers;
  const inLfs = await routed(pointers.map((pointer) => pointer.file));
  return pointers.filter((pointer) => inLfs.has(pointer.file));
}

/** The plain files under `dir`, by their paths in it: no `.git`, and no link is followed. */
async function filesOf(dir: string, under = ""): Promise<string[]> {
  const files: string[] = [];
  for (const entry of await readdir(path.join(dir, under), { withFileTypes: true })) {
    const file = path.join(under, entry.name);
    if (!under && entry.name === ".git") continue;
    if (entry.isDirectory()) files.push(...(await filesOf(dir, file)));
    else if (entry.isFile()) files.push(file);
  }
  return files;
}

/**
 * Where the object `oid` is kept in `kept`. Only a SHA-256 in lowercase hex names one: anything
 * else (a path, a name that leads out of the folder) throws before a file is touched.
 */
export function keptObjectPath(kept: string, oid: string): string {
  if (!OBJECT_ID.test(oid)) throw new Error(MESSAGE.KeptRefused);
  const file = path.join(kept, oid);
  if (!isBelow(kept, file)) throw new Error(MESSAGE.KeptRefused);
  return file;
}

/**
 * Put the Git LFS files of the clone in `dir`, cloned from `repository`, in their pointers' places.
 * A download that fails leaves every pointer as it was; downloads under way stop before it is told.
 */
export async function downloadLfsFiles(dir: string, repository: string, deps: LfsDownloadDeps): Promise<void> {
  const pointers = await findLfsPointers(dir, deps.routed);
  if (pointers.length === 0) return;
  const objects = [...new Map(pointers.map(({ oid, size }) => [oid, { oid, size }])).values()];
  const store = deps.kept ?? path.join(dir, ".git", PARTS_DIR);
  const tally = tallyOf(bytesOf(objects), deps.models);
  try {
    await openStore(store);
    const have = await keptObjects(store, objects, tally);
    const wanted = objects.filter((object) => !have.has(object.oid));
    // What is still to come, and the files' whole size once more: the remixed game's first save
    // copies every one of them into its history, since Studio's git runs no LFS filter. Without
    // it a disk passes the check and fills while the game is being adopted.
    const toCome = bytesOf(pointers) - bytesOf(objects) + bytesOf(wanted);
    await assertSpace(dir, toCome + bytesOf(pointers), deps);
    await downloadAll(repository, wanted, pointers, store, { ...deps, progress: tally.add });
    for (const object of objects) await placeObject(dir, store, object, pointers);
  } finally {
    await closeStore(store, deps.kept === undefined);
  }
}

const bytesOf = (objects: readonly LfsObject[]): number => objects.reduce((sum, object) => sum + object.size, 0);

/** A tally of `total` bytes that tells `models` at the start, then every step and at the end. */
function tallyOf(total: number, models: LfsDownloadDeps["models"]): Tally {
  let done = 0;
  let told = 0;
  const tell = () => {
    told = done;
    models(done, total);
  };
  tell();
  return {
    tell,
    add: (bytes) => {
      done += bytes;
      if (done - told >= PROGRESS_STEP_BYTES || done === total) tell();
    },
  };
}

/** Make `store` a plain folder: a link or a file standing there goes first, never followed. */
async function openStore(store: string): Promise<void> {
  const found = await lstat(store).catch(() => null);
  if (found && !found.isDirectory()) await rm(store, { force: true });
  await mkdir(store, { recursive: true });
}

/** Leave `store` behind: gone when nothing is kept between attempts, or when it holds nothing. */
async function closeStore(store: string, ephemeral: boolean): Promise<void> {
  if (ephemeral) await rm(store, { recursive: true, force: true });
  else await rmdir(store).catch(() => {});
}

/**
 * The objects already whole in `store`, from an attempt before: each a plain file named by a
 * wanted object's SHA-256 whose size and bytes still match. Everything else there goes (a half
 * download, another version's object, a link), so what is kept never outgrows the game.
 */
async function keptObjects(store: string, objects: LfsObject[], tally: Tally): Promise<Set<string>> {
  const wanted = new Map(objects.map((object) => [object.oid, object]));
  const have = new Set<string>();
  for (const name of await readdir(store)) {
    const object = wanted.get(name);
    if (object && (await isWhole(keptObjectPath(store, name), object))) {
      have.add(name);
      tally.add(object.size);
    } else await rm(path.join(store, name), { recursive: true, force: true });
  }
  if (have.size > 0) tally.tell();
  return have;
}

/** Whether `file` is a plain file (never a link) with the object's size and SHA-256, read a piece at a time. */
async function isWhole(file: string, object: LfsObject): Promise<boolean> {
  // `O_NOFOLLOW` is not on Windows, where the `lstat` alone tells a link.
  const noFollow = constants.O_NOFOLLOW ?? 0;
  const plain = await lstat(file).then(
    (found) => found.isFile() && found.size === object.size,
    () => false,
  );
  if (!plain) return false;
  const handle = await open(file, constants.O_RDONLY | noFollow).catch(() => null);
  if (!handle) return false;
  try {
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of handle.createReadStream({ highWaterMark: HASH_CHUNK_BYTES, autoClose: false })) {
      size += chunk.byteLength;
      if (size > object.size) return false;
      hash.update(chunk);
    }
    return size === object.size && hash.digest("hex") === object.oid;
  } catch {
    return false;
  } finally {
    await handle.close();
  }
}

/** Throw {@link LfsNoSpaceError} unless the disk holding `dir` has room for `bytes` more and the reserve. */
async function assertSpace(dir: string, bytes: number, deps: LfsDownloadDeps): Promise<void> {
  const needed = bytes + LFS_RESERVE_BYTES;
  const free = await deps.freeBytes(dir);
  if (free < needed) throw new LfsNoSpaceError(needed, free);
}

/**
 * Where each object downloads from, asked of the repository's batch API. Only the objects asked
 * for are kept, by the ids the pointers gave, never one the answer made up. A link's life is
 * counted from before the ask, so it is never thought younger than it is.
 */
async function locate(repository: string, asked: LfsObject[], deps: LfsDownloadDeps): Promise<Map<string, LfsAction>> {
  const actions = new Map<string, LfsAction>();
  const askedAt = deps.now();
  const answered = await askBatch(repository, asked, deps);
  const wanted = new Set(asked.map((object) => object.oid));
  for (const item of answered) {
    const found = answerOf(item, askedAt);
    if (found && wanted.has(found.oid)) actions.set(found.oid, found.action);
  }
  return actions;
}

/**
 * The links of one batch of objects, asked for now. An object the server has no download for is
 * the batch's failure, before any of it downloads.
 */
async function batchLinks(
  repository: string,
  batch: LfsObject[],
  pointers: LfsPointer[],
  deps: LfsDownloadDeps,
): Promise<BatchLinks> {
  const pending = new Map(batch.map((object) => [object.oid, object]));
  const actions = new Map<string, LfsAction>();
  let asking: Promise<void> | null = null;
  // One ask at a time: downloads that find their links run out together share its answer.
  const ask = (): Promise<void> => {
    asking ??= locate(repository, [...pending.values()], deps)
      .then((found) => {
        for (const [oid, action] of found) actions.set(oid, action);
      })
      .finally(() => {
        asking = null;
      });
    return asking;
  };
  const linkOf = (object: LfsObject): LfsAction => {
    const action = actions.get(object.oid);
    if (!action) throw new Error(MESSAGE.ModelsMissing(1));
    return action;
  };
  await ask();
  const missing = pointers.filter((pointer) => pending.has(pointer.oid) && !actions.has(pointer.oid)).length;
  if (missing) throw new Error(MESSAGE.ModelsMissing(missing));
  const renewed = async (object: LfsObject): Promise<LfsAction> => {
    await ask();
    return linkOf(object);
  };
  return {
    renewed,
    current: (object) => (hasRunOut(linkOf(object), deps.now()) ? renewed(object) : linkOf(object)),
    finished: (object) => {
      pending.delete(object.oid);
    },
  };
}

/** Whether a link's time has passed, or is about to. */
const hasRunOut = (action: LfsAction, now: number): boolean =>
  action.expiresAt !== null && now >= action.expiresAt - LINK_EXPIRY_MARGIN_MS;

/** One batch request's answered objects. A server that stops answering is given up, as a stalled download is. */
async function askBatch(repository: string, asked: LfsObject[], deps: LfsDownloadDeps): Promise<unknown[]> {
  const guard = deps.guard();
  try {
    const response = await fetchHttps(deps.fetch, `${repository}/info/lfs/objects/batch`, {
      method: "POST",
      headers: { Accept: LFS_MEDIA_TYPE, "Content-Type": LFS_MEDIA_TYPE },
      body: JSON.stringify({ operation: "download", transfers: ["basic"], objects: asked, hash_algo: "sha256" }),
      signal: guard.signal,
    });
    if (!response.ok) throw new Error(MESSAGE.BatchFailed(response.status));
    const answered = await response.json().catch((error: unknown) => {
      if (guard.signal.aborted) throw error;
      return null;
    });
    if (!isRecord(answered) || !Array.isArray(answered.objects)) throw new Error(MESSAGE.BatchUnreadable);
    return answered.objects;
  } catch (error) {
    throw guard.signal.aborted ? new Error(MESSAGE.BatchStalled) : error;
  } finally {
    guard.stop();
  }
}

/**
 * Fetch `href`, following a redirect only to another https address with no user or password in
 * it: each hop is checked before it is requested, so a downgrade to plain http never is, and the
 * request's headers go no further than its own origin. A request with a body (the batch) follows
 * none.
 */
async function fetchHttps(fetch: LfsDownloadDeps["fetch"], href: string, init: RequestInit): Promise<Response> {
  let at = href;
  let request = init;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop += 1) {
    const response = await fetch(at, { ...request, redirect: "manual" });
    if (!REDIRECT_STATUSES.has(response.status)) return response;
    await response.body?.cancel();
    const location = response.headers.get("location");
    const followable = init.body === undefined && location !== null && URL.canParse(location, at);
    if (!followable) throw new Error(MESSAGE.DownloadRefused);
    const next = safeHref(new URL(location, at).href);
    // The answer's headers (an Authorization) are for the host it named, never sent on to another.
    if (new URL(next).origin !== new URL(at).origin) request = { ...request, headers: undefined };
    at = next;
  }
  throw new Error(MESSAGE.DownloadRefused);
}

/** One answered object's download, or null when the server has none for it. A hostile address throws. */
function answerOf(item: unknown, askedAt: number): { oid: string; action: LfsAction } | null {
  if (!isRecord(item) || typeof item.oid !== "string" || item.error !== undefined) return null;
  const download = isRecord(item.actions) ? item.actions.download : null;
  if (!isRecord(download)) return null;
  const action = {
    href: safeHref(download.href),
    header: safeHeader(download.header),
    expiresAt: expiryOf(download, askedAt),
  };
  return { oid: item.oid, action };
}

/**
 * When an answered link runs out: `expires_in` seconds after it was asked for, or at `expires_at`
 * (the first wins, as the Git LFS API says); null when the answer gives neither.
 */
function expiryOf(download: Record<string, unknown>, askedAt: number): number | null {
  const { expires_in: seconds, expires_at: date } = download;
  if (typeof seconds === "number" && Number.isFinite(seconds)) return askedAt + seconds * SECOND_MS;
  const at = typeof date === "string" ? Date.parse(date) : Number.NaN;
  return Number.isNaN(at) ? null : at;
}

/** A download address: https, with no user or password in it. */
function safeHref(href: unknown): string {
  const url = typeof href === "string" && URL.canParse(href) ? new URL(href) : null;
  const plain = url?.protocol === "https:" && !url.username && !url.password;
  if (!url || !plain) throw new Error(MESSAGE.DownloadRefused);
  return url.href;
}

/** A download's headers: text names to text values, or none. */
function safeHeader(header: unknown): Record<string, string> {
  if (header === undefined) return {};
  if (!isRecord(header)) throw new Error(MESSAGE.DownloadRefused);
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(header)) {
    if (typeof value !== "string") throw new Error(MESSAGE.DownloadRefused);
    headers[name] = value;
  }
  return headers;
}

/** What a download hears beyond the network: when to stop, and the bytes as they come. */
type DownloadDeps = LfsDownloadDeps & { stop: AbortSignal; progress: (bytes: number) => void };

/**
 * Download every object into `store`, a batch at a time: a batch's links are asked for only when
 * its objects are next, so none is hours old by its turn. The first failure stops the rest.
 */
async function downloadAll(
  repository: string,
  objects: LfsObject[],
  pointers: LfsPointer[],
  store: string,
  deps: LfsDownloadDeps & { progress: (bytes: number) => void },
): Promise<void> {
  for (let start = 0; start < objects.length; start += BATCH_MAX_OBJECTS) {
    const batch = objects.slice(start, start + BATCH_MAX_OBJECTS);
    const links = await batchLinks(repository, batch, pointers, deps);
    await downloadBatch(batch, links, store, deps);
  }
}

/**
 * Download one batch's objects, a few at a time. The first failure stops the rest: the ones under
 * way are aborted and waited for, then the failure is told.
 */
async function downloadBatch(
  batch: LfsObject[],
  links: BatchLinks,
  store: string,
  deps: LfsDownloadDeps & { progress: (bytes: number) => void },
): Promise<void> {
  const stop = new AbortController();
  const queue = [...batch];
  const failures: unknown[] = [];
  const worker = async () => {
    for (let object = queue.shift(); object && !stop.signal.aborted; object = queue.shift()) {
      await fetchObject(object, links, store, { ...deps, stop: stop.signal }).catch((error: unknown) => {
        if (!stop.signal.aborted) failures.push(error);
        stop.abort();
      });
    }
  };
  await Promise.all(Array.from({ length: PARALLEL_DOWNLOADS }, worker));
  if (failures.length) throw failures[0];
}

/**
 * One object, by its link; a link storage refuses as run out is asked for again once, and the
 * download made again with the new one. A second refusal is the download's failure.
 */
async function fetchObject(object: LfsObject, links: BatchLinks, store: string, deps: DownloadDeps): Promise<void> {
  const refused = await downloadObject(object, await links.current(object), store, deps).then(
    () => false,
    (error: unknown) => {
      if (error instanceof LinkRefusedError) return true;
      throw error;
    },
  );
  if (refused) await downloadObject(object, await links.renewed(object), store, deps);
  links.finished(object);
}

/**
 * One object's download into `store`, hashed and counted as it comes. It is written beside its
 * place and takes its name (its SHA-256) only when its bytes match; otherwise nothing of it stays.
 */
async function downloadObject(object: LfsObject, action: LfsAction, store: string, deps: DownloadDeps): Promise<void> {
  const guard = deps.guard();
  const whole = keptObjectPath(store, object.oid);
  const part = `${whole}${PART_SUFFIX}`;
  const file = await open(part, "w");
  let matched = false;
  try {
    const signal = AbortSignal.any([guard.signal, deps.stop]);
    const response = await fetchHttps(deps.fetch, action.href, { headers: action.header, signal });
    if (LINK_REFUSED_STATUSES.has(response.status)) {
      await response.body?.cancel();
      throw new LinkRefusedError(response.status);
    }
    if (!response.ok || !response.body) throw new Error(MESSAGE.DownloadFailed(response.status));
    const hash = createHash("sha256");
    let size = 0;
    for await (const chunk of response.body) {
      size += chunk.byteLength;
      if (size > object.size) throw new Error(MESSAGE.Mismatch);
      hash.update(chunk);
      await file.write(chunk);
      guard.moved();
      deps.progress(chunk.byteLength);
    }
    if (size !== object.size || hash.digest("hex") !== object.oid) throw new Error(MESSAGE.Mismatch);
    matched = true;
  } catch (error) {
    throw guard.signal.aborted ? new Error(MESSAGE.Stalled) : error;
  } finally {
    guard.stop();
    await file.close();
    if (matched) await rename(part, whole);
    else await rm(part, { force: true });
  }
}

/** Put a downloaded object in the place of each pointer that stands for it. */
async function placeObject(dir: string, store: string, object: LfsObject, pointers: LfsPointer[]): Promise<void> {
  const part = keptObjectPath(store, object.oid);
  const [first, ...others] = pointers.filter((pointer) => pointer.oid === object.oid);
  for (const pointer of others) await copyFile(part, path.join(dir, pointer.file));
  if (first) await rename(part, path.join(dir, first.file));
}
