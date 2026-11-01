"""The arithmetic of the looks checks (genex_play.looks), free of the engine: whether a character's
feet keep still while it moves (it slides), whether its arms stand straight out (a T-pose), and
how far its feet are from the ground under it.
"""

import math

# Moving at least this fast (cm/s) along the ground counts as moving.
MOVING_CM_S = 120.0
# Feet that moved less than this (cm, in the body's own frame) while the body went SLIDE_MIN_CM did not step.
STILL_FEET_CM = 6.0
SLIDE_MIN_CM = 150.0
# An arm reaches out sideways when it is at least this long (cm), this level (its rise over its length)
# and this far across the body's facing (the cosine between the arm and the facing, at most).
ARM_MIN_CM = 35.0
ARM_LEVEL = 0.25
ARM_ACROSS = 0.35
# Feet this far above (or below) the ground under a character that stands on it float (or sink).
GROUND_GAP_CM = 25.0


def local(point: tuple, origin: tuple, yaw_deg: float) -> tuple:
    """A world point in a body's own frame: x along its facing, y to its right, z up."""
    dx, dy, dz = point[0] - origin[0], point[1] - origin[1], point[2] - origin[2]
    c, s = math.cos(math.radians(yaw_deg)), math.sin(math.radians(yaw_deg))
    return (dx * c + dy * s, -dx * s + dy * c, dz)


def spread(points: list) -> float:
    """The largest distance between any two of a foot's positions (cm)."""
    return max((math.dist(a, b) for i, a in enumerate(points) for b in points[i + 1:]), default=0.0)


def slides(feet: dict, travelled_cm: float) -> bool:
    """Whether a body slid: it went at least SLIDE_MIN_CM while every foot (its positions in the
    body's frame over that stretch) moved less than STILL_FEET_CM."""
    if travelled_cm < SLIDE_MIN_CM or not feet:
        return False
    return all(spread(points) < STILL_FEET_CM for points in feet.values())


def arm_out(shoulder: tuple, hand: tuple, facing_yaw_deg: float) -> bool:
    """Whether an arm (shoulder to hand, world cm) stands straight out to the side, level."""
    arm = (hand[0] - shoulder[0], hand[1] - shoulder[1], hand[2] - shoulder[2])
    length = math.sqrt(sum(v * v for v in arm))
    if length < ARM_MIN_CM:
        return False
    facing = (math.cos(math.radians(facing_yaw_deg)), math.sin(math.radians(facing_yaw_deg)))
    across = abs(arm[0] * facing[0] + arm[1] * facing[1]) / length
    return abs(arm[2]) / length <= ARM_LEVEL and across <= ARM_ACROSS


def ground_gap(feet_z: list, ground_z: float) -> float | None:
    """The lowest foot's height over the ground (cm, negative below it); None without feet."""
    return min(feet_z) - ground_z if feet_z else None
