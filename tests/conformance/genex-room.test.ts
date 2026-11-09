/**
 * A server-authoritative game made in Studio could not be checked or played before it was
 * published: a game's commands cannot download `@genex-ai/authority-dev`, and Studio ran none.
 *
 * Now `genex__room` runs the toolchain Studio ships, in ProcessSandbox: `validate` gives the
 * publish gate's verdict, `start` serves the room on 127.0.0.1 with bots and tells the preview its
 * address, `stop` ends it with its process tree. The real sandbox and the real toolchain run here.
 */
import assert from "node:assert/strict";
import { mkdir, readdir, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { after, before, describe, it } from "node:test";
import { setTimeout as sleep } from "node:timers/promises";
import { GenexRoomService, ROOM_MAX_BOTS, roomCall, type RoomStatus } from "../../src/main/core/genex-room.ts";
import { authorityDevDir } from "../../src/plugins/genex/cli.ts";
import { ProcessSandbox } from "../../src/substrate/spawn.ts";
import { running } from "../helpers/processes.ts";
import { tmpDir } from "../helpers/tmp.ts";

const ROOM_JS = [
  'import { SPEED } from "../src/world.js";',
  "export default {",
  "  contract: 1,",
  '  config: { tickHz: 30, maxPlayers: 8, preset: { name: "topdown" } },',
  "  init: () => ({ joins: 0 }),",
  '  onJoin(ctx, player) { ctx.state.joins += SPEED > 0 ? 1 : 0; ctx.entities.spawn({ kind: "player", owner: player.id, hp: 3 }); },',
  "  onLeave(ctx, player) { const me = ctx.entities.ownedBy(player.id); if (me) ctx.entities.remove(me.id); },",
  "  onInput() {},",
  "  step() {},",
  "};",
].join("\n");
/** A module whose every tick throws: a fault the gate names. */
const FAULTY_JS = ROOM_JS.replace("step() {},", 'step() { throw new Error("boom"); },');
/** How often a test looks at a running room, and how long it looks before it gives up. */
const LOOK_EVERY_MS = 100;
const LOOK_FOR_MS = 20_000;

let sandbox: ProcessSandbox;
let root: string;
before(async () => {
  root = await tmpDir("studio-genex-room-");
  sandbox = await ProcessSandbox.create({ writableRoots: [], scratchDir: path.join(root, "sandbox"), secretPaths: [] });
});
after(async () => {
  await sandbox.dispose();
});

/** A game folder declaring a room, with `files` (relative path → text). */
async function game(name: string, files: Record<string, string>, authority: unknown = { module: "server/room.js" }) {
  const dir = path.join(root, name);
  const page = { "index.html": "<!doctype html>", "src/world.js": "export const SPEED = 4;" };
  for (const [rel, text] of Object.entries({ ...page, ...files })) {
    await mkdir(path.dirname(path.join(dir, rel)), { recursive: true });
    await writeFile(path.join(dir, rel), text);
  }
  await writeFile(path.join(dir, "genex.json"), JSON.stringify({ authority }));
  return dir;
}

/** The service on the real sandbox and toolchain, recording what it told the preview. */
function service(dir: string) {
  const told: Array<string | null> = [];
  const runs: string[] = [];
  const pids: number[] = [];
  const toolDir = authorityDevDir();
  assert.ok(toolDir, "the repository carries the toolchain");
  const rooms = new GenexRoomService({
    run: (request) => {
      runs.push(request.command);
      return sandbox.run(request);
    },
    spawn: async (request) => {
      runs.push(request.command);
      const { child, input } = await sandbox.spawnLongLived(request);
      if (child.pid) pids.push(child.pid);
      return { child, input };
    },
    toolDir,
    scratch: path.join(root, "runs"),
    boundGame: async () => dir,
    onRoom: async (_project, url) => {
      told.push(url);
      return url !== null;
    },
  });
  return { rooms, told, runs, pids, binding: { project: path.basename(dir), directory: dir } };
}

/** The room's status once `ready` holds, looked at every {@link LOOK_EVERY_MS}. */
async function until(rooms: GenexRoomService, project: string, ready: (status: RoomStatus) => boolean) {
  for (let waited = 0; waited < LOOK_FOR_MS; waited += LOOK_EVERY_MS) {
    const status = rooms.status(project);
    if (ready(status)) return status;
    await sleep(LOOK_EVERY_MS);
  }
  throw new Error(`the room never got there: ${JSON.stringify(rooms.status(project))}`);
}

describe("genex__room checks its call before anything runs", () => {
  it("refuses an unknown action, key, bot count or delay", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["no action", {}],
      ["an unknown action", { action: "deploy" }],
      ["an unknown key", { action: "start", module: "../../etc/passwd" }],
      ["too many bots", { action: "start", bots: ROOM_MAX_BOTS + 1 }],
      ["negative bots", { action: "start", bots: -1 }],
      ["fractional bots", { action: "start", bots: 1.5 }],
      ["bots as text", { action: "start", bots: "3" }],
      ["too much delay", { action: "start", latencyMs: 301 }],
    ];
    for (const [name, args] of cases) assert.throws(() => roomCall(args), Error, name);
    assert.deepEqual(roomCall({ action: "start" }), { action: "start", bots: 3, latencyMs: 0 });
  });

  it("refuses a game with no room, or a module that leads out of it, and runs nothing", async () => {
    const none = path.join(root, "no-room");
    await mkdir(none, { recursive: true });
    await writeFile(path.join(none, "index.html"), "<!doctype html>");
    await writeFile(path.join(none, "genex.json"), "{}");
    const a = service(none);
    await assert.rejects(a.rooms.call({ action: "validate" }, a.binding), /declares no room module/);
    const outside = await game("outside", { "elsewhere/room.js": ROOM_JS });
    const linked = await game("linked", {});
    await mkdir(path.join(linked, "server"), { recursive: true });
    await symlink(path.join(outside, "elsewhere", "room.js"), path.join(linked, "server", "room.js"));
    const b = service(linked);
    await assert.rejects(b.rooms.call({ action: "start" }, b.binding), /not a file in this game|escapes/i);
    const traversal = await game("traversal", {}, { module: "server/../../outside/elsewhere/room.js" });
    const c = service(traversal);
    await assert.rejects(c.rooms.call({ action: "validate" }, c.binding), /declares no room module/);
    assert.deepEqual([...a.runs, ...b.runs, ...c.runs], [], "nothing ran");
  });
});

describe("genex__room runs the toolchain Studio ships, in the sandbox", () => {
  it("validates a module as the publish gate does, and names a faulty one's failures", async () => {
    const dir = await game("validate", { "server/room.js": ROOM_JS });
    const before = await readdir(dir, { recursive: true });
    const { rooms, binding } = service(dir);
    const verdict = await rooms.call({ action: "validate" }, binding);
    assert.equal((verdict as { passed: boolean }).passed, true, JSON.stringify(verdict));
    assert.deepEqual(await readdir(dir, { recursive: true }), before, "validation writes nothing in the game");
    await writeFile(path.join(dir, "server", "room.js"), FAULTY_JS);
    const failed = (await rooms.call({ action: "validate" }, binding)) as { passed: boolean; failures: unknown[] };
    assert.equal(failed.passed, false);
    assert.ok(failed.failures.length > 0, "each failure is named");
  });

  it("serves the room with bots on 127.0.0.1, puts the preview in it, and stops it with its process tree", async () => {
    const dir = await game("start", { "server/room.js": ROOM_JS });
    const { rooms, told, pids, binding } = service(dir);
    const started = (await rooms.call({ action: "start", bots: 2 }, binding)) as RoomStatus;
    assert.match(started.url ?? "", /^ws:\/\/127\.0\.0\.1:\d+$/);
    assert.equal(started.previewJoined, true);
    assert.deepEqual(told, [started.url], "the preview was told the room's address");
    const playing = await until(rooms, binding.project, (status) => {
      const report = status.report as { players?: number } | null;
      return (report?.players ?? 0) >= 2;
    });
    assert.equal(playing.running, true);
    const stopped = await rooms.call({ action: "stop" }, binding);
    assert.equal((stopped as RoomStatus).running, false);
    assert.deepEqual(told, [started.url, null], "the preview left the room");
    assert.equal(rooms.status(binding.project).running, false);
    assert.equal(pids.length, 1, "one room process");
    for (const pid of pids) assert.equal(running(pid), false, `the room process ${pid} ended`);
  });

  it("ends a game's last room when it starts another", async () => {
    const dir = await game("restart", { "server/room.js": ROOM_JS });
    const { rooms, told, binding } = service(dir);
    const first = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
    const second = (await rooms.call({ action: "start", bots: 0 }, binding)) as RoomStatus;
    assert.notEqual(first.url, second.url);
    assert.deepEqual(told, [first.url, null, second.url]);
    await rooms.stopAll();
    assert.equal(rooms.status(binding.project).running, false);
  });

  it("fails a start whose module does not load, leaving nothing running and the preview alone", async () => {
    const dir = await game("broken", { "server/room.js": "export default {" });
    const { rooms, told, binding } = service(dir);
    await assert.rejects(rooms.call({ action: "start" }, binding), /did not start/);
    assert.deepEqual(told, []);
    await until(rooms, binding.project, (status) => !status.running);
  });
});
