/**
 * What the top of a native game's page shows from what genex.games sends: the clip over the cover,
 * the cover alone, or the no-cover drawing; and a slideshow once there are two pictures or more. A
 * picture that failed to load leaves the run, so a broken cover falls back to the drawing.
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { HeroArt, heroArt, heroFrames, nextFrame, runsSlideshow } from "../../src/renderer/play/game-hero.ts";

const COVER = "https://cdn.genex.technology/covers/p1/cover.webp";
const CLIP = "https://cdn.genex.technology/covers/p1/clip.mp4";
const SHOT_A = "https://cdn.genex.technology/shots/a.webp";
const SHOT_B = "https://cdn.genex.technology/shots/b.webp";
const NONE: ReadonlySet<string> = new Set();

describe("a game page's top", () => {
  it("plays the clip over the cover, with no slideshow while the cover is its one picture", () => {
    const frames = heroFrames({ coverUrl: COVER, clipUrl: CLIP, shots: [] }, NONE);
    assert.deepEqual(frames, [{ src: COVER, clip: CLIP }]);
    assert.equal(heroArt(frames), HeroArt.Clip);
    assert.equal(runsSlideshow(frames), false);
  });

  it("shows the cover still when there is no clip", () => {
    const frames = heroFrames({ coverUrl: COVER, clipUrl: null, shots: [] }, NONE);
    assert.equal(heroArt(frames), HeroArt.Still);
    assert.equal(runsSlideshow(frames), false);
  });

  it("draws the no-cover plate for a game with nothing at all", () => {
    const frames = heroFrames({ coverUrl: null, clipUrl: null, shots: [] }, NONE);
    assert.deepEqual(frames, []);
    assert.equal(heroArt(frames), HeroArt.None);
  });

  it("runs the cover and its clip first, then each shot once, the cover not repeated", () => {
    const frames = heroFrames({ coverUrl: COVER, clipUrl: CLIP, shots: [SHOT_A, COVER, SHOT_B, SHOT_A] }, NONE);
    assert.deepEqual(frames, [
      { src: COVER, clip: CLIP },
      { src: SHOT_A, clip: null },
      { src: SHOT_B, clip: null },
    ]);
    assert.equal(runsSlideshow(frames), true);
  });

  it("starts with the shots of a game that has shots and no cover", () => {
    const frames = heroFrames({ coverUrl: null, clipUrl: null, shots: [SHOT_A, SHOT_B] }, NONE);
    assert.deepEqual(frames, [
      { src: SHOT_A, clip: null },
      { src: SHOT_B, clip: null },
    ]);
    assert.equal(heroArt(frames), HeroArt.Still);
  });

  it("leaves out a picture that failed: a broken cover takes its clip with it", () => {
    const failed = new Set([COVER]);
    assert.equal(heroArt(heroFrames({ coverUrl: COVER, clipUrl: CLIP, shots: [] }, failed)), HeroArt.None);
    const frames = heroFrames({ coverUrl: COVER, clipUrl: CLIP, shots: [SHOT_A, SHOT_B] }, new Set([SHOT_A]));
    assert.deepEqual(
      frames.map((frame) => frame.src),
      [COVER, SHOT_B],
    );
  });

  it("goes round the pictures in order, back to the first after the last", () => {
    assert.equal(nextFrame(0, 3), 1);
    assert.equal(nextFrame(2, 3), 0);
    assert.equal(nextFrame(0, 1), 0);
    assert.equal(nextFrame(4, 0), 0);
  });
});
