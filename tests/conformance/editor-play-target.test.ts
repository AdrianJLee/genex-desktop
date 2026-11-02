/**
 * The `computer` tool on a game played in its engine's editor (`main/core/editor-play-target.ts`),
 * driven through the real computer session against a stand-in engine plugin's play tools: the tool
 * offers keys, not a pointer; each key verb becomes holds on the game's own time; play opens once
 * for the whole session and the play it started ends with it; and a goal
 * the studio reads in the player's state is studio-verified as on any other target.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { computerSession } from "../../src/main/core/computer-session.ts";
import { editorPlaySource } from "../../src/main/core/editor-play-target.ts";
import {
  EDITOR_CAPABILITIES,
  InputRoute,
  PointerLevel,
  type TargetCapabilities,
} from "../../src/shared/computer-target.ts";
import {
  ENGINE_PLAY_VIEW,
  EnginePlayOptionalTool,
  EnginePlayRefusal,
  EnginePlayTool,
  editorCapabilities,
  MAX_PLAY_SHOT_BYTES,
  MouseButtonCode,
  narrowCapabilities,
  playInputKeys,
} from "../../src/shared/engine-play.ts";
import { StillMimeType } from "../../src/shared/preview-contract.ts";
import { computerActionsFor, computerToolDefinition } from "../../src/substrate/computer-tool.ts";
import type { LiveToolResult } from "../../src/substrate/engines/types.ts";
import { TOY_ENGINE } from "../helpers/engines.ts";
import { tmpDir } from "../helpers/tmp.ts";

const text = (result: LiveToolResult): string => (typeof result === "string" ? result : result.text);
const images = (result: LiveToolResult): number => (typeof result === "string" ? 0 : (result.images?.length ?? 0));
/** A 1×1 PNG, as an engine's play shot. */
const PIXEL = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

/** A stand-in engine plugin: its play tools, recorded, and a game whose player wins once W was held 2 s. */
function standInEngine(options: { refuseOpen?: boolean; afterOpen?: (answer: unknown) => Promise<void> } = {}) {
  const calls: Array<[EnginePlayTool | EnginePlayOptionalTool, Record<string, unknown>]> = [];
  const game = { heldW: 0, playing: false, paused: false, pausedAtInput: [] as boolean[] };
  const call = async (tool: EnginePlayTool | EnginePlayOptionalTool, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    switch (tool) {
      case EnginePlayTool.Open:
        if (options.refuseOpen)
          return { refused: EnginePlayRefusal.Busy, message: "Unreal is playing a build for the Loop right now." };
        game.playing = true;
        return { ...ENGINE_PLAY_VIEW, joined: false };
      case EnginePlayTool.Input: {
        game.pausedAtInput.push(game.paused);
        const keys = playInputKeys(args.keys);
        if (keys.includes("KeyW")) game.heldW += Number(args.seconds);
        return { held: keys, gameSeconds: 1 };
      }
      case EnginePlayTool.Shot:
        if (!game.playing) return { refused: EnginePlayRefusal.NotPlaying, message: "No play test is running." };
        return { png: PIXEL, ...ENGINE_PLAY_VIEW };
      case EnginePlayTool.State:
        return { pawn: "Hero_0", phase: game.heldW >= 2 ? "won" : "playing" };
      case EnginePlayTool.Pause:
        game.paused = Boolean(args.paused);
        return { paused: game.paused };
      case EnginePlayTool.Close:
        game.playing = false;
        game.paused = false;
        return { closed: true };
    }
  };
  const source = editorPlaySource({ call, ...(options.afterOpen ? { afterOpen: options.afterOpen } : {}) });
  const inputs = () => calls.filter(([tool]) => tool === EnginePlayTool.Input).map(([, args]) => args);
  return { source, calls, game, inputs };
}

describe("the computer on a game played in its engine's editor", () => {
  it("offers keys, the mouse as a player has it, waits, pictures and the player's state, never a point to click at", () => {
    const { source } = standInEngine();
    assert.deepEqual(computerActionsFor(source.caps), [
      "left_click",
      "right_click",
      "middle_click",
      "double_click",
      "triple_click",
      "scroll",
      "type",
      "key",
      "hold_key",
      "look",
      "screenshot",
      "wait",
      "state",
      // Flipped on purpose: every session now offers its recap.
      "recap",
      "batch",
    ]);
    const tool = computerToolDefinition({ role: "builder", capabilities: source.caps, observeByDefault: false });
    assert.match(tool.description, /engine's editor/);
  });

  it("stands the game still between a judge's moves and runs it only while a move lasts; a builder's game runs on", async () => {
    const judged = standInEngine();
    const judge = computerSession(judged.source, "/game", {
      pacing: "stepped",
      frameDir: await tmpDir("editor-play-"),
    });
    await judge.run("computer", { action: "screenshot" });
    assert.equal(judged.game.paused, true, "still while the judge looks");
    await judge.run("computer", { action: "hold_key", text: "w", duration: 1 });
    assert.deepEqual(judged.game.pausedAtInput, [false], "running while the key is held");
    assert.equal(judged.game.paused, true, "still again after the move");
    const built = standInEngine();
    const builder = computerSession(built.source, "/game", {
      pacing: "running",
      frameDir: await tmpDir("editor-play-"),
    });
    await builder.run("computer", { action: "hold_key", text: "w", duration: 1 });
    assert.equal(
      built.calls.some(([tool]) => tool === EnginePlayTool.Pause),
      false,
      "a builder's game is never paused",
    );
  });

  it("carries each key verb as holds on the game's own time", async () => {
    const { source, inputs } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "key", text: "shift+w" });
    await session.run("computer", { action: "hold_key", text: "d", duration: 25 });
    await session.run("computer", { action: "type", text: "Hi" });
    assert.deepEqual(inputs(), [
      { keys: "ShiftLeft,KeyW", seconds: 0.1 },
      { keys: "KeyD", seconds: 10 },
      { keys: "KeyD", seconds: 10 },
      { keys: "KeyD", seconds: 5 },
      { keys: "ShiftLeft,KeyH", seconds: 0.1 },
      { keys: "KeyI", seconds: 0.1 },
    ]);
    assert.equal(session.trace().routes?.includes(InputRoute.Editor), true, "recorded as the editor's own input");
  });

  it("carries mouse-look, clicks and the wheel as one frame of the player's mouse, the buttons as keys", async () => {
    const { source, inputs } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "look", dx: 40, dy: -10 });
    await session.run("computer", { action: "left_click" });
    await session.run("computer", { action: "right_click" });
    await session.run("computer", { action: "scroll", scroll_direction: "down", scroll_amount: 2 });
    assert.deepEqual(inputs(), [
      { keys: "", seconds: 0.05, dx: 40, dy: -10 },
      { keys: MouseButtonCode.Left, seconds: 0.1 },
      { keys: MouseButtonCode.Right, seconds: 0.1 },
      { keys: "", seconds: 0.05, wheel: -2 },
    ]);
  });

  it("never names a cursor the editor play has none of", async () => {
    const { source } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    const answers = [
      await session.run("computer", { action: "screenshot" }),
      await session.run("computer", { action: "hold_key", text: "w", duration: 1 }),
      await session.run("computer", { action: "batch", actions: [{ action: "key", text: "d" }] }),
    ];
    for (const answer of answers) assert.doesNotMatch(text(answer), /cursor/);
  });

  it("looks with the player's view, as a picture the model sees", async () => {
    const { source } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    const looked = await session.run("computer", { action: "screenshot" });
    assert.equal(images(looked), 1);
    assert.match(text(looked), /1280×720/);
  });

  it("opens play once for the whole session, and ends the play it started when the session is let go", async () => {
    const { source, game, calls } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "screenshot" });
    await session.run("computer", { action: "key", text: "w" });
    await session.run("computer", { action: "screenshot" });
    assert.equal(calls.filter(([tool]) => tool === EnginePlayTool.Open).length, 1, "play opened once");
    await source.release();
    assert.equal(game.playing, false, "the play it started ended");
    await source.release();
    assert.equal(calls.filter(([tool]) => tool === EnginePlayTool.Close).length, 1, "closed once");
  });

  it("opens play again once the engine says its play ended, instead of failing every call after", async () => {
    const { source, game, calls } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "screenshot" });
    game.playing = false;
    assert.match(text(await session.run("computer", { action: "screenshot" })), /No play test is running/);
    const again = await session.run("computer", { action: "screenshot" });
    assert.equal(images(again), 1, "the next look plays again");
    assert.equal(calls.filter(([tool]) => tool === EnginePlayTool.Open).length, 2, "a fresh play was opened");
    await source.release();
  });

  it("runs its after-open step once, right after the play opens and before any move, with the open's answer", async () => {
    const seen: Array<{ before: Array<EnginePlayTool | EnginePlayOptionalTool>; answer: unknown }> = [];
    const { source, calls } = standInEngine({
      afterOpen: async (answer) => {
        seen.push({ before: calls.map(([tool]) => tool), answer });
      },
    });
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "screenshot" });
    await session.run("computer", { action: "key", text: "w" });
    await session.run("computer", { action: "screenshot" });
    assert.equal(seen.length, 1, "once for the session's play");
    assert.deepEqual(seen[0]?.before, [EnginePlayTool.Open], "right after the play opened, before any move");
    assert.equal((seen[0]?.answer as { width?: number } | undefined)?.width, ENGINE_PLAY_VIEW.width);
  });

  it("says the engine's reason when play cannot open, and has nothing to close", async () => {
    const { source, calls } = standInEngine({ refuseOpen: true });
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    assert.match(text(await session.run("computer", { action: "screenshot" })), /playing a build for the Loop/);
    await source.release();
    assert.equal(calls.filter(([tool]) => tool === EnginePlayTool.Close).length, 0);
  });
});

/** A stand-in engine whose play opens several players, each with its own view and state, as the toy engine declares. */
function playersEngine(
  options: {
    players?: number;
    caps?: TargetCapabilities;
    opened?: Record<string, unknown>;
    shot?: Record<string, unknown>;
    pause?: unknown;
    shrink?: (picture: Buffer) => Promise<Buffer>;
  } = {},
) {
  const calls: Array<[EnginePlayTool | EnginePlayOptionalTool, Record<string, unknown>]> = [];
  const call = async (tool: EnginePlayTool | EnginePlayOptionalTool, args: Record<string, unknown>) => {
    calls.push([tool, args]);
    const player = typeof args.player === "number" ? args.player : 1;
    switch (tool) {
      case EnginePlayTool.Open:
        return { ...ENGINE_PLAY_VIEW, joined: false, players: args.players ?? 1, ...options.opened };
      case EnginePlayTool.Input:
        return { held: playInputKeys(args.keys), gameSeconds: 1 };
      case EnginePlayTool.Shot:
        return options.shot ?? { data: JPEG, mime: StillMimeType.Jpeg, ...ENGINE_PLAY_VIEW };
      case EnginePlayTool.State:
        return { player };
      case EnginePlayTool.Pause:
        return options.pause ?? { paused: Boolean(args.paused) };
      case EnginePlayTool.Close:
        return { closed: true };
    }
  };
  const caps = options.caps ?? editorCapabilities(TOY_ENGINE.play);
  const source = editorPlaySource({
    call,
    caps,
    players: options.players ?? 3,
    ...(options.shrink ? { shrink: options.shrink } : {}),
  });
  const sent = (tool: EnginePlayTool) => calls.filter(([t]) => t === tool).map(([, args]) => args);
  return { source, calls, sent };
}

/** A few bytes standing in for a JPEG an engine answers, base64 as on the wire. */
const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3, 0xff, 0xd9]).toString("base64");

describe("the computer on a play with several players, as its engine declares", () => {
  it("opens as many players as it was asked for, and addresses each by number, never naming player 1", async () => {
    const { source, sent } = playersEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "screenshot" });
    assert.deepEqual(sent(EnginePlayTool.Open), [{ players: 3 }]);
    await session.run("computer", { action: "key", text: "w", player: 2 });
    await session.run("computer", { action: "screenshot" });
    assert.match(text(await session.run("computer", { action: "state" })), /"player":2/, "player 2 is kept");
    await session.run("computer", { action: "key", text: "d", player: 1 });
    await session.run("computer", { action: "screenshot" });
    assert.deepEqual(
      sent(EnginePlayTool.Input).map((args) => args.player),
      [2, undefined],
      "player 2's keys name it; player 1's never do",
    );
    assert.deepEqual(sent(EnginePlayTool.Shot), [{}, { player: 2 }, {}]);
    assert.deepEqual(
      sent(EnginePlayTool.State),
      [{ player: 2 }, { player: 2 }, {}],
      "each move's state is its player's",
    );
    assert.match(
      text(await session.run("computer", { action: "screenshot", player: 4 })),
      /player 4 is not in this play: it has 3 players/,
    );
  });

  it("opens one player, sending nothing about players, when asked for one or for more than the engine has", async () => {
    for (const players of [1, 9]) {
      const { source, sent } = playersEngine({ players, caps: editorCapabilities() });
      await source.load("/game", false);
      assert.deepEqual(sent(EnginePlayTool.Open), [{}], `asked for ${players}`);
      assert.equal(source.caps.players, undefined);
    }
    const { source, sent } = playersEngine({ players: 9 });
    const { target } = await source.load("/game", false);
    assert.deepEqual(sent(EnginePlayTool.Open), [{ players: 3 }], "no more than the engine declares");
    assert.equal(target.caps.players, 3);
  });

  it("takes the engine's JPEG as a JPEG, and anything it does not name as a PNG", async () => {
    const jpeg = playersEngine();
    const shot = await (await jpeg.source.load("/game", false)).target.screenshot({ quality: 60, surface: "auto" });
    assert.equal(shot.mime, StillMimeType.Jpeg);
    assert.deepEqual(shot.jpeg, Buffer.from(JPEG, "base64"));
    for (const mime of ["image/gif", undefined, 7]) {
      const other = playersEngine({ shot: { data: JPEG, mime, ...ENGINE_PLAY_VIEW } });
      const read = await (await other.source.load("/game", false)).target.screenshot({ quality: 60, surface: "auto" });
      assert.equal(read.mime, StillMimeType.Png, String(mime));
    }
    const png = playersEngine({ shot: { png: PIXEL, ...ENGINE_PLAY_VIEW } });
    const old = await (await png.source.load("/game", false)).target.screenshot({ quality: 60, surface: "auto" });
    assert.deepEqual(
      [old.mime, old.jpeg],
      [StillMimeType.Png, Buffer.from(PIXEL, "base64")],
      "an engine's png still reads",
    );
  });

  it("refuses a picture over the size a model can be shown, in plain words", async () => {
    const big = Buffer.alloc(MAX_PLAY_SHOT_BYTES + 1, 1).toString("base64");
    const { source } = playersEngine({ shot: { data: big, mime: StillMimeType.Jpeg, ...ENGINE_PLAY_VIEW } });
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    const answer = await session.run("computer", { action: "screenshot" });
    assert.equal(images(answer), 0);
    assert.match(text(answer), /picture is too large to show \(1\.0 MB; the most is 1\.0 MB\)/);
    const fits = playersEngine({
      shot: { data: Buffer.alloc(MAX_PLAY_SHOT_BYTES, 1).toString("base64"), mime: StillMimeType.Jpeg },
    });
    const at = computerSession(fits.source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    assert.equal(images(await at.run("computer", { action: "screenshot" })), 1, "exactly the most is shown");
  });

  // Unreal's 1280×720 PNG of a lit level came to just over 1 MB, and the agent never saw its game.
  it("shrinks a picture over the size a model can be shown into a JPEG that fits, and refuses one it cannot", async () => {
    const big = Buffer.alloc(MAX_PLAY_SHOT_BYTES + 1, 1).toString("base64");
    const small = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 9, 9, 0xff, 0xd9]);
    const shrunk: number[] = [];
    const { source } = playersEngine({
      shot: { data: big, mime: StillMimeType.Png, ...ENGINE_PLAY_VIEW },
      shrink: async (picture) => {
        shrunk.push(picture.length);
        return small;
      },
    });
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-play-") });
    const answer = await session.run("computer", { action: "screenshot" });
    assert.equal(images(answer), 1);
    assert.deepEqual(shrunk, [MAX_PLAY_SHOT_BYTES + 1]);
    const shown = typeof answer === "string" ? undefined : answer.images?.[0];
    assert.equal(shown?.mimeType, StillMimeType.Jpeg);
    assert.equal(shown?.data, small.toString("base64"));
    const stubborn = playersEngine({
      shot: { data: big, mime: StillMimeType.Png, ...ENGINE_PLAY_VIEW },
      shrink: async () => Buffer.alloc(MAX_PLAY_SHOT_BYTES + 1),
    });
    const still = computerSession(stubborn.source, "/game", {
      pacing: "running",
      frameDir: await tmpDir("editor-play-"),
    });
    assert.match(
      text(await still.run("computer", { action: "screenshot" })),
      /picture is too large to show \(1\.0 MB; the most is 1\.0 MB\)/,
    );
  });

  it("stops asking to pause once the engine says it cannot, and says the clock runs on", async () => {
    const pause = { refused: EnginePlayRefusal.Unsupported, message: "This engine cannot pause its play." };
    const { source, sent } = playersEngine({
      caps: { ...editorCapabilities(TOY_ENGINE.play), clock: "freeze" },
      pause,
    });
    const session = computerSession(source, "/game", { pacing: "paced", frameDir: await tmpDir("editor-play-") });
    const looked = text(await session.run("computer", { action: "screenshot" }));
    assert.doesNotMatch(looked, /cannot pause/, "a missing pause is no failure");
    await session.run("computer", { action: "hold_key", text: "w", duration: 0.2 });
    await session.run("computer", { action: "wait", duration: 0.1 });
    assert.equal(sent(EnginePlayTool.Pause).length, 1, "asked once");
    const { target } = await source.load("/game", false);
    assert.equal(target.caps.clock, "none", "the clock is known to run on");
  });

  it("lets the play's own answer narrow what the engine declared, never widen it", async () => {
    const declared = { ...editorCapabilities(TOY_ENGINE.play), pointer: PointerLevel.None, aimedClicks: false };
    const opened = {
      players: 2,
      capabilities: { players: 8, clock: "step-locked", pointer: true, state: false },
    };
    const { source } = playersEngine({ caps: declared, opened });
    const { target } = await source.load("/game", false);
    assert.equal(target.caps.players, 2, "two of three players joined");
    assert.equal(target.caps.clock, "none", "the clock declared none stays none");
    assert.equal(target.caps.pointer, PointerLevel.None, "no pointer stays none");
    assert.equal(target.caps.state, "none", "a play that cannot read its state says so");
  });

  it("keeps Unreal's play as it was: an editor with no play declared opens one player and asks nothing more", async () => {
    assert.deepEqual(editorCapabilities(), EDITOR_CAPABILITIES);
    assert.deepEqual(narrowCapabilities(EDITOR_CAPABILITIES, undefined), EDITOR_CAPABILITIES);
    const { source, calls } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "stepped", frameDir: await tmpDir("editor-play-") });
    await session.run("computer", { action: "screenshot" });
    await session.run("computer", { action: "key", text: "w" });
    await session.run("computer", { action: "state" });
    await source.release();
    assert.deepEqual(calls, [
      [EnginePlayTool.Open, {}],
      [EnginePlayTool.Pause, { paused: true }],
      [EnginePlayTool.Shot, {}],
      [EnginePlayTool.Pause, { paused: false }],
      [EnginePlayTool.Input, { keys: "KeyW", seconds: 0.1 }],
      [EnginePlayTool.Pause, { paused: true }],
      [EnginePlayTool.State, {}],
      [EnginePlayTool.State, {}],
      [EnginePlayTool.Close, {}],
    ]);
  });
});

describe("what an engine declares its editor can do in play", () => {
  it("reads the declaration's players, clock, pointer and state as the computer's capabilities", () => {
    const toy = editorCapabilities(TOY_ENGINE.play);
    assert.deepEqual(
      [toy.players, toy.clock, toy.pointer, toy.aimedClicks, toy.state],
      [3, "none", PointerLevel.Relative, true, "game"],
    );
    const still = editorCapabilities({ pointer: false, state: false, players: 1 });
    assert.deepEqual([still.pointer, still.aimedClicks, still.state], [PointerLevel.None, false, "none"]);
    assert.equal(Object.hasOwn(still, "players"), false, "one player is no players field");
    assert.equal(editorCapabilities({ clock: "replayable" }).clock, "freeze", "the play tools pause, never step");
  });
});

describe("the computer walks and looks in a play that can", () => {
  /** A stand-in engine whose play walks the player and turns its view: every call, and the walk's answer. */
  function walkingEngine(walked: Record<string, unknown>) {
    const calls: Array<[string, Record<string, unknown>]> = [];
    const call = async (tool: EnginePlayTool | EnginePlayOptionalTool, args: Record<string, unknown>) => {
      calls.push([tool, args]);
      switch (tool) {
        case EnginePlayTool.Open:
          return { ...ENGINE_PLAY_VIEW, joined: false };
        case EnginePlayOptionalTool.Walk:
          return walked;
        case EnginePlayOptionalTool.Look:
          return { state: "looked", target: "BP_Enemy_1", reason: "", offDegrees: 1.2, gameSeconds: 0.4 };
        case EnginePlayTool.State:
          return { gameSeconds: 3, location: [1, 2, 3] };
        case EnginePlayTool.Pause:
          return { paused: Boolean(args.paused) };
        default:
          return {};
      }
    };
    const source = editorPlaySource({ call, caps: editorCapabilities({ walk: true }) });
    return { source, calls };
  }
  const arrived = {
    state: "arrived",
    target: "BP_Door_2",
    way: "navmesh",
    partial: false,
    distanceM: 0.9,
    tried: [],
    reason: "",
    gameSeconds: 6.4,
  };

  it("offers walk_to and look_at only where the engine declares its play walks, and a play's answer can take it back", () => {
    const walking = editorCapabilities({ walk: true });
    assert.ok(computerActionsFor(walking).includes("walk_to"));
    assert.ok(computerActionsFor(walking).includes("look_at"));
    assert.ok(!computerActionsFor(editorCapabilities()).includes("walk_to"));
    assert.equal(narrowCapabilities(walking, { walk: false }).walk, false);
    assert.equal(narrowCapabilities(editorCapabilities(), { walk: true }).walk, undefined, "an answer never adds");
    const tool = computerToolDefinition({ role: "builder", capabilities: walking, observeByDefault: false });
    assert.match(tool.description, /walk_to text=<an actor's name or x,y,z>/);
  });

  it("walks to a target through play-walk, the game running only while it walks, and says how it ended", async () => {
    const { source, calls } = walkingEngine(arrived);
    const session = computerSession(source, "/game", { pacing: "paced", frameDir: await tmpDir("editor-walk-") });
    const answer = text(await session.run("computer", { action: "walk_to", text: "door", duration: 12 }));
    assert.match(answer, /^OK — walk to door: arrived: 0\.9 m from BP_Door_2 after 6\.4 game s, by the nav mesh\./);
    const around = calls.filter(([tool]) => tool !== EnginePlayTool.State).slice(-3);
    assert.deepEqual(around, [
      [EnginePlayTool.Pause, { paused: false }],
      [EnginePlayOptionalTool.Walk, { target: "door", seconds: 12 }],
      [EnginePlayTool.Pause, { paused: true }],
    ]);
  });

  it("says what stopped a walk and what it tried", async () => {
    const stuck = {
      ...arrived,
      state: "stuck",
      way: "direct",
      distanceM: 7.8,
      gameSeconds: 9,
      reason: "no way past at 1210,-340,90",
      tried: ["jump", "left", "right", "replan"],
    };
    const { source } = walkingEngine(stuck);
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-walk-") });
    assert.match(
      text(await session.run("computer", { action: "walk_to", text: "BP_Door_2" })),
      /stuck: 7\.8 m from BP_Door_2 after 9 game s, straight: no way past at 1210,-340,90; tried jump, left, right, replan/,
    );
  });

  it("says how far off the player's body faces an actor it walked to, and nothing of it for a point", async () => {
    const faced = { ...arrived, facingDeg: 4.2 };
    const { source } = walkingEngine(faced);
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-walk-") });
    assert.match(
      text(await session.run("computer", { action: "walk_to", text: "door" })),
      /arrived: 0\.9 m from BP_Door_2 after 6\.4 game s, by the nav mesh, facing it 4\.2° off\./,
    );
    const pointed = walkingEngine({ ...arrived, facingDeg: null });
    const toPoint = computerSession(pointed.source, "/game", {
      pacing: "running",
      frameDir: await tmpDir("editor-walk-"),
    });
    assert.doesNotMatch(text(await toPoint.run("computer", { action: "walk_to", text: "10,0,0" })), /facing/);
  });

  it("turns the view onto a target through play-look", async () => {
    const { source, calls } = walkingEngine(arrived);
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-look-") });
    assert.match(
      text(await session.run("computer", { action: "look_at", text: "enemy" })),
      /looked: 1\.2° off BP_Enemy_1 after 0\.4 game s/,
    );
    assert.deepEqual(
      calls.filter(([tool]) => tool === EnginePlayOptionalTool.Look),
      [[EnginePlayOptionalTool.Look, { target: "enemy" }]],
    );
  });

  it("refuses walk_to where the play cannot walk, before anything reaches the engine", async () => {
    const { source, calls } = standInEngine();
    const session = computerSession(source, "/game", { pacing: "running", frameDir: await tmpDir("editor-walk-") });
    assert.match(text(await session.run("computer", { action: "walk_to", text: "door" })), /walk_to is not available/);
    assert.deepEqual(calls, []);
  });
});
