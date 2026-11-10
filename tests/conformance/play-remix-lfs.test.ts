/**
 * A remix's Git LFS files come over https without git-lfs: the clone's pointer files name each
 * model's SHA-256 and size, Genex's git answers where each one is (the Git LFS batch API), and a
 * model takes its pointer's place only once its bytes match. Nothing here runs git or git-lfs, so
 * a Mac where an app opened from the Dock finds no git-lfs remixes like any other.
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { lstat, mkdir, readdir, readFile, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import {
  downloadLfsFiles,
  findLfsPointers,
  keptObjectPath,
  LFS_RESERVE_BYTES,
  type LfsDownloadDeps,
  LfsNoSpaceError,
  parseLfsPointer,
} from "../../src/main/play/lfs.ts";
import { DOWNLOAD_STALL_MS, type StallClock, stallGuard } from "../../src/main/play/remix.ts";
import { tmpDir } from "../helpers/tmp.ts";

const REPO = "https://git.genex.games/u-1/lost-cathedral.git";
const BATCH = `${REPO}/info/lfs/objects/batch`;
const STORAGE = "https://storage.genex.example";

const oidOf = (bytes: Buffer): string => createHash("sha256").update(bytes).digest("hex");
const pointerOf = (bytes: Buffer): string =>
  `version https://git-lfs.github.com/spec/v1\noid sha256:${oidOf(bytes)}\nsize ${bytes.length}\n`;

/** A request the fake network saw. */
interface Seen {
  url: string;
  method: string;
  /** The Authorization header it carried, or null. */
  authorization: string | null;
  objects: Array<{ oid: string; size: number }>;
}

/** What the fake batch API answers for one asked object; `undefined` leaves it out. */
type Answer = (object: { oid: string; size: number }) => unknown;

/** Where a storage address redirects to, or undefined to serve it. */
type Redirect = (url: string) => string | undefined;

/**
 * Genex's git and its storage: the batch API answers with `answer`, storage serves `store`, and an
 * address `redirect` names answers 302 there.
 */
function fakeNetwork(store: Map<string, Buffer>, answer?: Answer, redirect?: Redirect) {
  const seen: Seen[] = [];
  const located: Answer = (object) =>
    store.has(object.oid)
      ? { ...object, actions: { download: { href: `${STORAGE}/${object.oid}?sig=abc`, expires_in: 3600 } } }
      : { ...object, error: { code: 404, message: "Object does not exist" } };
  const fetch: LfsDownloadDeps["fetch"] = async (input, init) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const objects = url === BATCH ? (JSON.parse(String(init?.body)) as { objects: Seen["objects"] }).objects : [];
    seen.push({ url, method, objects, authorization: new Headers(init?.headers).get("authorization") });
    if (url === BATCH) return Response.json({ objects: objects.map(answer ?? located).filter(Boolean) });
    const location = redirect?.(url);
    if (location) return new Response(null, { status: 302, headers: { location } });
    const bytes = store.get(new URL(url).pathname.slice(1));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("no", { status: 404 });
  };
  return { fetch, seen };
}

/** A clone in a temporary folder: `files` written as given, a `.git` folder beside them. */
async function cloneWith(files: Record<string, string | Buffer>): Promise<string> {
  const dir = await tmpDir("studio-remix-lfs-");
  await mkdir(path.join(dir, ".git"), { recursive: true });
  for (const [file, body] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(dir, file)), { recursive: true });
    await writeFile(path.join(dir, file), body);
  }
  return dir;
}

/** The network, no stall clock that ever fires, and every progress report kept. */
function depsOn(fetch: LfsDownloadDeps["fetch"]) {
  const heard: Array<[number, number]> = [];
  const deps: LfsDownloadDeps = {
    fetch,
    models: (done, total) => {
      heard.push([done, total]);
    },
    guard: () => stallGuard({ setTimeout: () => null, clearTimeout: () => {} }),
    routed: async (files) => new Set(files),
    now: () => 0,
    freeBytes: async () => Number.MAX_SAFE_INTEGER,
  };
  return { deps, heard };
}

const MODEL = Buffer.from("glTF model bytes ".repeat(500));
const SOUND = Buffer.from("a footstep sound");

describe("Remix's Git LFS files over https", () => {
  it("reads a pointer exactly as Git LFS writes it, and nothing else", () => {
    const oid = oidOf(MODEL);
    const cases: Array<[string, { oid: string; size: number } | null]> = [
      [pointerOf(MODEL), { oid, size: MODEL.length }],
      [pointerOf(MODEL).replaceAll("\n", "\r\n"), { oid, size: MODEL.length }],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 12`, { oid, size: 12 }],
      ["", null],
      ["hello\n", null],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid.slice(1)}\nsize 12\n`, null],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid.toUpperCase()}\nsize 12\n`, null],
      [`version https://git-lfs.github.com/spec/v1\noid md5:${oid}\nsize 12\n`, null],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize -1\n`, null],
      [`version https://git-lfs.github.com/spec/v1\noid sha256:${oid}\nsize 99999999999999999999\n`, null],
      [`version https://example.com/spec\noid sha256:${oid}\nsize 12\n`, null],
      [`${pointerOf(MODEL)}trailing\n`, null],
    ];
    for (const [text, expected] of cases) assert.deepEqual(parseLfsPointer(text), expected, JSON.stringify(text));
  });

  it("finds the clone's pointers, never its .git, a big file, or what a link points at", async () => {
    const outside = await cloneWith({ "elsewhere.glb": pointerOf(MODEL) });
    const dir = await cloneWith({
      "public/models/player.glb": pointerOf(MODEL),
      "public/sounds/step 1.mp3": pointerOf(SOUND),
      "index.html": "<h1>game</h1>",
      ".git/lfs-looking": pointerOf(MODEL),
      "big.bin": `${pointerOf(MODEL)}${"x".repeat(2048)}`,
    });
    await symlink(path.join(outside, "elsewhere.glb"), path.join(dir, "linked.glb"));
    await symlink(outside, path.join(dir, "linked-folder"));
    const found = await findLfsPointers(dir, async (files) => new Set(files));
    assert.deepEqual(found.map((pointer) => pointer.file.split(path.sep).join("/")).sort(), [
      "public/models/player.glb",
      "public/sounds/step 1.mp3",
    ]);
  });

  it("puts every model in its pointer's place, downloading each object once, and tells the bytes", async () => {
    const dir = await cloneWith({
      "public/models/player.glb": pointerOf(MODEL),
      "public/models/copy-of-player.glb": pointerOf(MODEL),
      "public/sounds/step.mp3": pointerOf(SOUND),
      "index.html": "<h1>game</h1>",
    });
    const store = new Map([
      [oidOf(MODEL), MODEL],
      [oidOf(SOUND), SOUND],
    ]);
    const { fetch, seen } = fakeNetwork(store);
    const { deps, heard } = depsOn(fetch);
    await downloadLfsFiles(dir, REPO, deps);
    assert.deepEqual(await readFile(path.join(dir, "public/models/player.glb")), MODEL);
    assert.deepEqual(await readFile(path.join(dir, "public/models/copy-of-player.glb")), MODEL);
    assert.deepEqual(await readFile(path.join(dir, "public/sounds/step.mp3")), SOUND);
    assert.equal(await readFile(path.join(dir, "index.html"), "utf8"), "<h1>game</h1>");
    // One batch to the game's own repository, then one download per object: the shared model once.
    const [batch, ...downloads] = seen;
    assert.deepEqual([batch?.method, batch?.url], ["POST", BATCH]);
    assert.deepEqual(
      downloads.map(({ method, url }) => [method, url.split("?")[0]]).sort(),
      [...store.keys()].map((oid) => ["GET", `${STORAGE}/${oid}`]).sort(),
    );
    const total = MODEL.length + SOUND.length;
    assert.deepEqual(heard[0], [0, total]);
    assert.deepEqual(heard.at(-1), [total, total]);
    for (let index = 1; index < heard.length; index += 1)
      assert.ok((heard[index]?.[0] ?? 0) >= (heard[index - 1]?.[0] ?? 0), "the bytes only grow");
    assert.deepEqual(await readdir(path.join(dir, ".git")), [], "no half downloads left beside the clone");
  });

  it("asks for at most a hundred objects a batch", async () => {
    const files: Record<string, Buffer> = {};
    const store = new Map<string, Buffer>();
    for (let index = 0; index < 205; index += 1) {
      const bytes = Buffer.from(`model ${index}`);
      files[`models/${index}.glb`] = Buffer.from(pointerOf(bytes));
      store.set(oidOf(bytes), bytes);
    }
    const dir = await cloneWith(files);
    const { fetch, seen } = fakeNetwork(store);
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    const batches = seen.filter((request) => request.method === "POST");
    assert.deepEqual(
      batches.map((batch) => batch.objects.length),
      [100, 100, 5],
    );
    assert.deepEqual(await readFile(path.join(dir, "models/204.glb")), Buffer.from("model 204"));
  });

  it("does nothing for a clone with no pointers", async () => {
    const dir = await cloneWith({ "index.html": "<h1>game</h1>" });
    const { fetch, seen } = fakeNetwork(new Map());
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    assert.deepEqual(seen, []);
  });

  it("refuses what Genex's git or its storage answers wrong, and leaves every pointer as it was", async () => {
    const located =
      (href: string, header?: unknown): Answer =>
      (object) => ({
        ...object,
        actions: { download: { href, ...(header ? { header } : {}) } },
      });
    const wrongBytes = new Map([[oidOf(MODEL), Buffer.from("not the model")]]);
    const longer = new Map([[oidOf(MODEL), Buffer.concat([MODEL, Buffer.from("more")])]]);
    const cases: Array<{
      name: string;
      fetch?: LfsDownloadDeps["fetch"];
      store?: Map<string, Buffer>;
      answer?: Answer;
      redirect?: Redirect;
      refused: RegExp;
    }> = [
      { name: "bytes that are not the model", store: wrongBytes, refused: /didn’t match/ },
      { name: "more bytes than the pointer says", store: longer, refused: /didn’t match/ },
      { name: "an object the server does not have", store: new Map(), refused: /2 of this game’s files/ },
      { name: "an object left out of the answer", answer: () => undefined, refused: /2 of this game’s files/ },
      { name: "a plain http download", answer: located(`http://storage.genex.example/x`), refused: /refused/ },
      {
        name: "a download with a password",
        answer: located(`https://u:p@storage.genex.example/x`),
        refused: /refused/,
      },
      { name: "a download that is not a link", answer: located("ext::sh -c touch"), refused: /refused/ },
      { name: "a header that is not text", answer: located(`${STORAGE}/x`, { Authorization: 1 }), refused: /refused/ },
      {
        name: "a download redirected to plain http",
        redirect: (url) => (url.startsWith(STORAGE) ? "http://storage.genex.example/x" : undefined),
        refused: /refused/,
      },
      {
        name: "a download redirected to an address with a password",
        redirect: (url) => (url.startsWith(STORAGE) ? "https://u:p@storage.genex.example/x" : undefined),
        refused: /refused/,
      },
      {
        name: "a download redirected with no address",
        fetch: async (input) =>
          String(input) === BATCH
            ? fakeNetwork(new Map([[oidOf(MODEL), MODEL]])).fetch(input, { method: "POST", body: batchBody() })
            : new Response(null, { status: 302 }),
        refused: /refused/,
      },
      {
        name: "a batch redirected elsewhere",
        fetch: async () => new Response(null, { status: 307, headers: { location: `${REPO}/elsewhere` } }),
        refused: /refused/,
      },
      {
        name: "an answer naming a path for an object",
        answer: (object) => ({ ...object, oid: "../../x", actions: { download: { href: `${STORAGE}/x` } } }),
        refused: /2 of this game’s files/,
      },
      {
        name: "a batch that fails",
        fetch: async () => new Response("down", { status: 503 }),
        refused: /answered 503/,
      },
      {
        name: "a batch that is not JSON",
        fetch: async () => new Response("<html>", { status: 200 }),
        refused: /couldn’t be read/,
      },
      {
        name: "a batch of the wrong shape",
        fetch: async () => Response.json({ objects: "all of them" }),
        refused: /couldn’t be read/,
      },
    ];
    for (const { name, fetch, store, answer, redirect, refused } of cases) {
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL), "b/c.glb": pointerOf(MODEL) });
      const network = fakeNetwork(store ?? new Map([[oidOf(MODEL), MODEL]]), answer, redirect);
      await assert.rejects(downloadLfsFiles(dir, REPO, depsOn(fetch ?? network.fetch).deps), refused, name);
      assert.equal(await readFile(path.join(dir, "a.glb"), "utf8"), pointerOf(MODEL), name);
      assert.equal(await readFile(path.join(dir, "b/c.glb"), "utf8"), pointerOf(MODEL), name);
      assert.deepEqual((await readdir(dir)).sort(), [".git", "a.glb", "b"], `${name}: nothing written beside them`);
      assert.deepEqual(await readdir(path.join(dir, ".git")), [], `${name}: no half download kept`);
      const offHost = network.seen.filter(
        (request) => !request.url.startsWith(REPO) && !request.url.startsWith(STORAGE),
      );
      assert.deepEqual(offHost, [], `${name}: nothing requested off Genex's git and storage`);
    }
  });

  it("follows a storage redirect to another https address", async () => {
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const moved = (url: string) => (url.startsWith(`${STORAGE}/`) ? `${STORAGE}/moved/${oidOf(MODEL)}` : undefined);
    const store = new Map([
      [oidOf(MODEL), MODEL],
      [`moved/${oidOf(MODEL)}`, MODEL],
    ]);
    const { fetch, seen } = fakeNetwork(store, undefined, (url) => (url.includes("/moved/") ? undefined : moved(url)));
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    assert.deepEqual(await readFile(path.join(dir, "a.glb")), MODEL);
    assert.equal(seen.at(-1)?.url, `${STORAGE}/moved/${oidOf(MODEL)}`);
  });

  it("sends the answer's headers to its own storage host only, never on to another a redirect names", async () => {
    const cases: Array<{ name: string; to: string; carried: string | null }> = [
      { name: "another host", to: `https://cdn.genex.example/${oidOf(MODEL)}`, carried: null },
      { name: "the same host", to: `${STORAGE}/moved/${oidOf(MODEL)}`, carried: "Bearer token" },
    ];
    for (const { name, to, carried } of cases) {
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
      const store = new Map([
        [oidOf(MODEL), MODEL],
        [`moved/${oidOf(MODEL)}`, MODEL],
      ]);
      const signed: Answer = (object) => ({
        ...object,
        actions: { download: { href: `${STORAGE}/${object.oid}`, header: { Authorization: "Bearer token" } } },
      });
      const { fetch, seen } = fakeNetwork(store, signed, (url) =>
        url === `${STORAGE}/${oidOf(MODEL)}` ? to : undefined,
      );
      await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
      assert.deepEqual(await readFile(path.join(dir, "a.glb")), MODEL, name);
      const [, first, second] = seen;
      assert.deepEqual([first?.url, first?.authorization], [`${STORAGE}/${oidOf(MODEL)}`, "Bearer token"], name);
      assert.deepEqual([second?.url, second?.authorization], [to, carried], name);
    }
  });

  it("downloads only the pointers the clone's attributes route through Git LFS", async () => {
    const dir = await cloneWith({ "models/a.glb": pointerOf(MODEL), "docs/pointer-example.txt": pointerOf(SOUND) });
    const { fetch, seen } = fakeNetwork(
      new Map([
        [oidOf(MODEL), MODEL],
        [oidOf(SOUND), SOUND],
      ]),
    );
    const asked: string[][] = [];
    const deps: LfsDownloadDeps = {
      ...depsOn(fetch).deps,
      routed: async (files) => {
        asked.push(files.map((file) => file.split(path.sep).join("/")).sort());
        return new Set(files.filter((file) => file.endsWith(".glb")));
      },
    };
    await downloadLfsFiles(dir, REPO, deps);
    assert.deepEqual(
      asked,
      [["docs/pointer-example.txt", "models/a.glb"]],
      "only pointer-shaped files are asked about",
    );
    assert.deepEqual(await readFile(path.join(dir, "models/a.glb")), MODEL);
    assert.equal(await readFile(path.join(dir, "docs/pointer-example.txt"), "utf8"), pointerOf(SOUND));
    assert.deepEqual(
      seen.flatMap((request) => request.objects.map((object) => object.oid)),
      [oidOf(MODEL)],
    );
  });

  it("asks Genex's git only at the game's own repository", async () => {
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const { fetch, seen } = fakeNetwork(new Map([[oidOf(MODEL), MODEL]]));
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    const batch = seen.find((request) => request.method === "POST");
    assert.equal(batch?.url, BATCH);
  });

  it("gives Genex's git up once it stops answering, so a later remix is not held up", async () => {
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const timers = manualTimers();
    let asked = () => {};
    const waiting = new Promise<void>((resolve) => {
      asked = resolve;
    });
    const fetch: LfsDownloadDeps["fetch"] = (_input, init) =>
      new Promise((_resolve, reject) => {
        asked();
        init?.signal?.addEventListener("abort", () => reject(init.signal?.reason));
      });
    const deps: LfsDownloadDeps = { ...depsOn(fetch).deps, guard: () => stallGuard(timers.clock) };
    const download = downloadLfsFiles(dir, REPO, deps);
    await waiting;
    timers.advance(DOWNLOAD_STALL_MS);
    await assert.rejects(download, /stopped answering/);
    assert.equal(await readFile(path.join(dir, "a.glb"), "utf8"), pointerOf(MODEL));
  });

  it("gives a model up once its download stops moving", async () => {
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const timers = manualTimers();
    let waiting = () => {};
    const stuck = new Promise<void>((resolve) => {
      waiting = resolve;
    });
    const { fetch: answering } = fakeNetwork(new Map([[oidOf(MODEL), MODEL]]));
    const fetch: LfsDownloadDeps["fetch"] = async (input, init) => {
      if (String(input) === BATCH) return answering(input, init);
      const body = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(MODEL.subarray(0, 10));
          init?.signal?.addEventListener("abort", () => controller.error(init.signal?.reason));
        },
        pull() {
          waiting();
          return new Promise(() => {});
        },
      });
      return new Response(body);
    };
    const deps: LfsDownloadDeps = { ...depsOn(fetch).deps, guard: () => stallGuard(timers.clock) };
    const download = downloadLfsFiles(dir, REPO, deps);
    await stuck;
    timers.advance(DOWNLOAD_STALL_MS);
    await assert.rejects(download, /stopped moving/);
    assert.equal(await readFile(path.join(dir, "a.glb"), "utf8"), pointerOf(MODEL));
  });
});

/** A link the fake batch API signs: each answer's links carry the number of the batch that gave them. */
const signedHref = (oid: string, batch: number): string => `${STORAGE}/${oid}?sig=${batch}`;

/**
 * Genex's git whose links carry the number of the batch that signed them (`?sig=<n>`), with `link`
 * added to each answer's download; storage answers `refuse(url)`'s status when it names one.
 */
function signingNetwork(
  store: Map<string, Buffer>,
  options: { link?: (batch: number) => Record<string, unknown>; refuse?: (url: string) => number | undefined } = {},
) {
  const seen: Array<{ method: string; url: string; oids: string[] }> = [];
  let batches = 0;
  const fetch: LfsDownloadDeps["fetch"] = async (input, init) => {
    const url = String(input);
    if (url === BATCH) {
      batches += 1;
      const { objects } = JSON.parse(String(init?.body)) as { objects: Seen["objects"] };
      seen.push({ method: "POST", url, oids: objects.map((object) => object.oid) });
      const batch = batches;
      const answered = objects.map((object) => ({
        ...object,
        actions: { download: { href: signedHref(object.oid, batch), ...options.link?.(batch) } },
      }));
      return Response.json({ objects: answered });
    }
    seen.push({ method: "GET", url, oids: [] });
    const status = options.refuse?.(url);
    if (status) return new Response("no", { status });
    const bytes = store.get(new URL(url).pathname.slice(1));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response("no", { status: 404 });
  };
  return { fetch, seen };
}

/** How often, and how many times, a test looks for a file another download is writing. */
const KEPT_LOOK_MS = 5;
const KEPT_LOOKS = 200;

const isThere = async (target: string): Promise<boolean> =>
  lstat(target).then(
    () => true,
    () => false,
  );

describe("Remix's Git LFS files of a big game", () => {
  it("asks for a batch's links only when its objects are next, never all of them up front", async () => {
    const files: Record<string, Buffer> = {};
    const store = new Map<string, Buffer>();
    for (let index = 0; index < 205; index += 1) {
      const bytes = Buffer.from(`model ${index}`);
      files[`models/${index}.glb`] = Buffer.from(pointerOf(bytes));
      store.set(oidOf(bytes), bytes);
    }
    const dir = await cloneWith(files);
    const { fetch, seen } = signingNetwork(store);
    await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
    // Each run of downloads follows the batch that named them: links are short-lived.
    const runs: string[] = [];
    for (const { method } of seen) {
      const last = runs.at(-1);
      if (method === "POST" || !last?.startsWith("GET")) runs.push(`${method} 1`);
      else runs[runs.length - 1] = `GET ${Number(last.split(" ")[1]) + 1}`;
    }
    assert.deepEqual(runs, ["POST 1", "GET 100", "POST 1", "GET 100", "POST 1", "GET 5"]);
    const signedBy = seen
      .filter(({ method }) => method === "GET")
      .map(({ url }) => new URL(url).searchParams.get("sig"));
    assert.deepEqual([signedBy[0], signedBy[100], signedBy[200]], ["1", "2", "3"], "by its own batch's links");
  });

  it("asks again for a link storage refuses as expired, once, and downloads with the new one", async () => {
    for (const status of [401, 403]) {
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
      const oid = oidOf(MODEL);
      const { fetch, seen } = signingNetwork(new Map([[oid, MODEL]]), {
        refuse: (url) => (url === signedHref(oid, 1) ? status : undefined),
      });
      await downloadLfsFiles(dir, REPO, depsOn(fetch).deps);
      assert.deepEqual(await readFile(path.join(dir, "a.glb")), MODEL, String(status));
      assert.deepEqual(
        seen.map(({ method, url, oids }) => [method, url, oids]),
        [
          ["POST", BATCH, [oid]],
          ["GET", signedHref(oid, 1), []],
          ["POST", BATCH, [oid]],
          ["GET", signedHref(oid, 2), []],
        ],
        String(status),
      );
    }
  });

  it("takes a second refusal as the failure it is, and any other answer at once", async () => {
    const oid = oidOf(MODEL);
    const cases: Array<{ status: number; requests: string[] }> = [
      { status: 403, requests: ["POST", "GET", "POST", "GET"] },
      { status: 401, requests: ["POST", "GET", "POST", "GET"] },
      { status: 404, requests: ["POST", "GET"] },
      { status: 500, requests: ["POST", "GET"] },
    ];
    for (const { status, requests } of cases) {
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
      const { fetch, seen } = signingNetwork(new Map([[oid, MODEL]]), { refuse: () => status });
      await assert.rejects(
        downloadLfsFiles(dir, REPO, depsOn(fetch).deps),
        new RegExp(`didn’t download \\(${status}\\)`),
      );
      assert.deepEqual(
        seen.map(({ method }) => method),
        requests,
        String(status),
      );
      assert.equal(await readFile(path.join(dir, "a.glb"), "utf8"), pointerOf(MODEL), String(status));
    }
  });

  it("asks again before using a link whose time has passed, by the answer's expires_in or expires_at", async () => {
    const start = Date.UTC(2026, 0, 1);
    const cases: Array<[string, Record<string, unknown>]> = [
      ["expires_in", { expires_in: 120 }],
      ["expires_at", { expires_at: new Date(start + 120_000).toISOString() }],
    ];
    for (const [name, link] of cases) {
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
      const oid = oidOf(MODEL);
      let now = start;
      // The first answer's link is three minutes old by the time its object's turn comes.
      const { fetch, seen } = signingNetwork(new Map([[oid, MODEL]]), {
        link: (batch) => {
          if (batch === 1) now += 180_000;
          return link;
        },
      });
      await downloadLfsFiles(dir, REPO, { ...depsOn(fetch).deps, now: () => now });
      assert.deepEqual(await readFile(path.join(dir, "a.glb")), MODEL, name);
      assert.deepEqual(
        seen.map(({ method, url }) => [method, url]),
        [
          ["POST", BATCH],
          ["POST", BATCH],
          ["GET", signedHref(oid, 2)],
        ],
        `${name}: the stale link is never requested`,
      );
    }
    const fresh = await cloneWith({ "a.glb": pointerOf(MODEL) });
    const { fetch, seen } = signingNetwork(new Map([[oidOf(MODEL), MODEL]]), { link: () => ({ expires_in: 120 }) });
    await downloadLfsFiles(fresh, REPO, { ...depsOn(fetch).deps, now: () => start });
    assert.deepEqual(
      seen.map(({ method }) => method),
      ["POST", "GET"],
      "a link still in its time is used as it is",
    );
  });

  it("refuses before downloading anything when the disk can't hold the files and a reserve", async () => {
    // The files themselves, and as much again: the remixed game's first save copies every one
    // of them into its history (Studio's git runs no LFS filter).
    const files = MODEL.length * 2 + SOUND.length;
    const total = files * 2;
    const cases: Array<{ free: number; fits: boolean }> = [
      { free: 0, fits: false },
      { free: files + LFS_RESERVE_BYTES, fits: false },
      { free: total + LFS_RESERVE_BYTES - 1, fits: false },
      { free: total + LFS_RESERVE_BYTES, fits: true },
    ];
    for (const { free, fits } of cases) {
      // The model is in two places: both copies take room.
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL), "b.glb": pointerOf(MODEL), "c.mp3": pointerOf(SOUND) });
      const store = new Map([
        [oidOf(MODEL), MODEL],
        [oidOf(SOUND), SOUND],
      ]);
      const { fetch, seen } = signingNetwork(store);
      const asked: string[] = [];
      const deps: LfsDownloadDeps = {
        ...depsOn(fetch).deps,
        freeBytes: async (at) => {
          asked.push(at);
          return free;
        },
      };
      if (fits) {
        await downloadLfsFiles(dir, REPO, deps);
        assert.deepEqual(await readFile(path.join(dir, "b.glb")), MODEL);
        assert.deepEqual(asked, [dir], "the clone's own disk is the one asked about");
        continue;
      }
      await assert.rejects(
        downloadLfsFiles(dir, REPO, deps),
        (error: unknown) =>
          error instanceof LfsNoSpaceError && error.needed === total + LFS_RESERVE_BYTES && error.free === free,
        String(free),
      );
      assert.deepEqual(seen, [], `${free}: nothing is asked of the network`);
      assert.equal(await readFile(path.join(dir, "a.glb"), "utf8"), pointerOf(MODEL));
      assert.deepEqual(await readdir(path.join(dir, ".git")), [], `${free}: nothing written`);
    }
  });

  it("keeps what downloaded whole when another file fails, and the next attempt downloads only the rest", async () => {
    const kept = path.join(await tmpDir("studio-remix-kept-"), "kept");
    const pointers = { "a.glb": pointerOf(MODEL), "b/c.mp3": pointerOf(SOUND) };
    const store = new Map([
      [oidOf(MODEL), MODEL],
      [oidOf(SOUND), SOUND],
    ]);
    const first = await cloneWith(pointers);
    // The sound is refused only once the model is kept (or was given long enough), so what is kept
    // is the same every run.
    const modelKept = async () => {
      for (let look = 0; look < KEPT_LOOKS && !(await isThere(path.join(kept, oidOf(MODEL)))); look += 1)
        await sleep(KEPT_LOOK_MS);
    };
    const failing = signingNetwork(store);
    const fetch: LfsDownloadDeps["fetch"] = async (input, init) => {
      if (!String(input).startsWith(`${STORAGE}/${oidOf(SOUND)}`)) return failing.fetch(input, init);
      await modelKept();
      return new Response("gone", { status: 500 });
    };
    const deps: LfsDownloadDeps = { ...depsOn(fetch).deps, kept };
    await assert.rejects(downloadLfsFiles(first, REPO, deps), /didn’t download \(500\)/);
    assert.equal(await readFile(path.join(first, "a.glb"), "utf8"), pointerOf(MODEL), "no pointer is replaced");
    assert.deepEqual(await readdir(kept), [oidOf(MODEL)], "the whole model is kept, by its SHA-256, and no half file");
    assert.deepEqual(await readFile(path.join(kept, oidOf(MODEL))), MODEL);

    const second = await cloneWith(pointers);
    const { fetch: working, seen } = signingNetwork(store);
    const { deps: again, heard } = depsOn(working);
    const free: number[] = [];
    await downloadLfsFiles(second, REPO, {
      ...again,
      kept,
      freeBytes: async () => {
        // What is kept is not downloaded again: only the sound is still to come. The game's first
        // save copies both files once more, and the reserve stays free.
        const room = SOUND.length + MODEL.length + SOUND.length + LFS_RESERVE_BYTES;
        free.push(room);
        return room;
      },
    });
    assert.deepEqual(await readFile(path.join(second, "a.glb")), MODEL);
    assert.deepEqual(await readFile(path.join(second, "b/c.mp3")), SOUND);
    assert.deepEqual(
      seen.map(({ method, url, oids }) => [method, url, oids]),
      [
        ["POST", BATCH, [oidOf(SOUND)]],
        ["GET", signedHref(oidOf(SOUND), 1), []],
      ],
      "only the sound is asked for and downloaded",
    );
    const total = MODEL.length + SOUND.length;
    assert.deepEqual(
      [heard[0], heard.at(-1)],
      [
        [0, total],
        [total, total],
      ],
    );
    assert.ok(
      heard.some(([done]) => done === MODEL.length),
      "the kept model counts as soon as it is checked",
    );
    assert.equal(free.length, 1);
    assert.equal(await isThere(kept), false, "nothing is kept once every file is in place");
  });

  it("never trusts what is kept: only a plain file of the right name, size and SHA-256 is used", async () => {
    const oid = oidOf(MODEL);
    const wrong = Buffer.from(MODEL);
    wrong[0] = (wrong[0] ?? 0) ^ 1;
    const outsideModel = "outside.glb";
    type Plant = (kept: string, outside: string) => Promise<unknown>;
    const cases: Array<[string, Plant]> = [
      ["the right size, other bytes", (kept) => writeFile(path.join(kept, oid), wrong)],
      ["fewer bytes", (kept) => writeFile(path.join(kept, oid), MODEL.subarray(0, 10))],
      ["more bytes", (kept) => writeFile(path.join(kept, oid), Buffer.concat([MODEL, MODEL]))],
      ["a half download", (kept) => writeFile(path.join(kept, `${oid}.part`), MODEL)],
      [
        "a link to the right bytes elsewhere",
        (kept, outside) => symlink(path.join(outside, outsideModel), path.join(kept, oid)),
      ],
      ["a folder by its name", (kept) => mkdir(path.join(kept, oid, "x"), { recursive: true })],
      ["its name in capitals", (kept) => writeFile(path.join(kept, oid.toUpperCase()), MODEL)],
      ["another version's object", (kept) => writeFile(path.join(kept, oidOf(SOUND)), SOUND)],
      ["a link out of the folder", (kept, outside) => symlink(outside, path.join(kept, "elsewhere"))],
    ];
    for (const [name, plant] of cases) {
      const home = await tmpDir("studio-remix-kept-hostile-");
      const kept = path.join(home, "kept");
      const outside = path.join(home, "outside");
      await mkdir(kept);
      await mkdir(outside);
      await writeFile(path.join(outside, outsideModel), MODEL);
      await plant(kept, outside);
      const dir = await cloneWith({ "a.glb": pointerOf(MODEL) });
      const { fetch, seen } = signingNetwork(new Map([[oid, MODEL]]));
      await downloadLfsFiles(dir, REPO, { ...depsOn(fetch).deps, kept });
      assert.deepEqual(await readFile(path.join(dir, "a.glb")), MODEL, name);
      assert.deepEqual(
        seen.map(({ method }) => method),
        ["POST", "GET"],
        `${name}: the model is downloaded, not taken from there`,
      );
      assert.deepEqual(await readdir(outside), [outsideModel], `${name}: nothing outside is removed or written`);
      assert.deepEqual(await readFile(path.join(outside, outsideModel)), MODEL, name);
      assert.equal(await isThere(kept), false, `${name}: what was planted goes with the folder`);
    }
  });

  it("writes through no link standing where the kept folder goes", async () => {
    const home = await tmpDir("studio-remix-kept-link-");
    const outside = path.join(home, "outside");
    await mkdir(outside);
    await writeFile(path.join(outside, oidOf(MODEL)), MODEL);
    const kept = path.join(home, "kept");
    await symlink(outside, kept);
    const dir = await cloneWith({ "a.glb": pointerOf(MODEL), "b.mp3": pointerOf(SOUND) });
    const store = new Map([
      [oidOf(MODEL), MODEL],
      [oidOf(SOUND), SOUND],
    ]);
    const { fetch, seen } = signingNetwork(store);
    await downloadLfsFiles(dir, REPO, { ...depsOn(fetch).deps, kept });
    assert.deepEqual(await readFile(path.join(dir, "a.glb")), MODEL);
    assert.equal(seen.filter(({ method }) => method === "GET").length, 2, "nothing is taken through the link");
    assert.deepEqual(await readdir(outside), [oidOf(MODEL)], "the folder it led to is as it was");
  });

  it("names a kept object only by a SHA-256, inside its folder", async () => {
    const kept = await tmpDir("studio-remix-kept-names-");
    const oid = oidOf(MODEL);
    assert.equal(keptObjectPath(kept, oid), path.join(kept, oid));
    const hostile = [
      "",
      ".",
      "..",
      "../x",
      `../${oid}`,
      `${oid}/../../x`,
      `${oid}/x`,
      `x\\${oid}`,
      path.join(kept, "..", oid),
      `/${oid}`,
      oid.toUpperCase(),
      oid.slice(1),
      `${oid}0`,
      `${oid}.part`,
      `${oid}\0`,
      `${oid}\n`,
      ` ${oid}`,
      `${oid.slice(0, 63)}g`,
    ];
    for (const name of hostile) assert.throws(() => keptObjectPath(kept, name), /refused/, JSON.stringify(name));
    assert.deepEqual(await readdir(kept), [], "naming one makes nothing");
  });
});

/** A batch request's body asking for the model, as `downloadLfsFiles` sends it. */
const batchBody = (): string => JSON.stringify({ objects: [{ oid: oidOf(MODEL), size: MODEL.length }] });

/** Timers the test moves by hand. */
function manualTimers(): { clock: StallClock; advance: (ms: number) => void } {
  let now = 0;
  let next = 0;
  const timers = new Map<number, { at: number; run: () => void }>();
  return {
    clock: {
      setTimeout: (run, ms) => {
        next += 1;
        timers.set(next, { at: now + ms, run });
        return next;
      },
      clearTimeout: (handle) => {
        timers.delete(handle as number);
      },
    },
    advance: (ms) => {
      now += ms;
      for (const [id, timer] of [...timers]) {
        if (timer.at > now) continue;
        timers.delete(id);
        timer.run();
      }
    },
  };
}
