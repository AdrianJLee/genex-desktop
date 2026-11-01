"""Where the play view sits inside a shot of the editor's window, found without Unreal.

The window shot (Unreal's `Shot showui`) holds the play view with its on-screen UI, somewhere among
the editor's panels. A small scene shot taken at the play view's own framing holds the same 3D
picture without the UI. Sliding the scene over the window and keeping the place where the pixels
differ least finds the play view: the UI covers only part of it, so the scene still matches best
where it belongs. Pixels are (r, g, b) tuples in rows; a fixed set of sample points keeps each try
cheap enough for Python.
"""

import random

SAMPLES = 400
SEED = 7


def sample_points(width: int, height: int, count: int = SAMPLES, seed: int = SEED) -> list[tuple[int, int]]:
    """`count` fixed points spread over a width x height picture, the same for every try."""
    rng = random.Random(seed)
    return [(rng.randrange(width), rng.randrange(height)) for _ in range(count)]


def mismatch(window: list, window_width: int, scene: list, scene_width: int, at: tuple[int, int],
             points: list[tuple[int, int]]) -> float:
    """How far apart the scene placed at `at` in the window is, as the mean channel difference."""
    ox, oy = at
    total = 0
    for x, y in points:
        a = window[(oy + y) * window_width + ox + x]
        b = scene[y * scene_width + x]
        total += abs(a[0] - b[0]) + abs(a[1] - b[1]) + abs(a[2] - b[2])
    return total / (3 * max(1, len(points)))


def best_place(window: list, window_size: tuple[int, int], scene: list, scene_size: tuple[int, int],
               xs: range, ys: range) -> tuple[tuple[int, int], float]:
    """The place among xs x ys where the scene matches the window best, and how far apart it is
    there. Places where the scene would leave the window are skipped."""
    (ww, wh), (sw, sh) = window_size, scene_size
    points = sample_points(sw, sh)
    best, place = float('inf'), (0, 0)
    for oy in ys:
        for ox in xs:
            if ox < 0 or oy < 0 or ox + sw > ww or oy + sh > wh:
                continue
            gap = mismatch(window, ww, scene, sw, (ox, oy), points)
            if gap < best:
                best, place = gap, (ox, oy)
    return place, best


def around(center: int, span: int) -> range:
    """The places within span of center, both ways."""
    return range(center - span, center + span + 1)
