"""The geometry of walking and looking, with no engine in it: flat distances, the move action's two
axes in the controller's own frame, the W/A/S/D keys closest to a direction, and how far the view
is off a target. Angles are degrees, as Unreal's rotators are; yaw 0 faces +X and grows toward +Y."""

import math

# A component of a direction past this picks its key (cos 67.5°: eight directions).
KEY_SHARE = 0.38


def wrap(degrees: float) -> float:
    """An angle in (-180, 180]."""
    turned = (degrees + 180.0) % 360.0 - 180.0
    return 180.0 if turned == -180.0 else turned


def flat_distance(a: tuple, b: tuple) -> float:
    """The distance between two points seen from above (cm)."""
    return math.hypot(b[0] - a[0], b[1] - a[1])


def heading(origin: tuple, toward: tuple) -> float:
    """The yaw that faces from origin toward a point (degrees)."""
    return math.degrees(math.atan2(toward[1] - origin[1], toward[0] - origin[0]))


def move_axes(control_yaw: float, world_yaw: float) -> tuple[float, float]:
    """The move action's (right, forward) for walking along world_yaw while the controller faces control_yaw."""
    angle = math.radians(wrap(world_yaw - control_yaw))
    return round(math.sin(angle), 3), round(math.cos(angle), 3)


def keys_for(right: float, forward: float) -> list[str]:
    """The W/A/S/D keys that walk closest to (right, forward)."""
    keys = []
    if forward > KEY_SHARE:
        keys.append('W')
    if forward < -KEY_SHARE:
        keys.append('S')
    if right > KEY_SHARE:
        keys.append('D')
    if right < -KEY_SHARE:
        keys.append('A')
    return keys


def look_error(control_yaw: float, control_pitch: float, eye: tuple, target: tuple) -> tuple[float, float]:
    """How far the view must turn to face target from eye: (yaw, pitch) degrees, right and up positive."""
    flat = flat_distance(eye, target)
    pitch = math.degrees(math.atan2(target[2] - eye[2], flat)) if flat or target[2] != eye[2] else 0.0
    return wrap(heading(eye, target) - control_yaw), wrap(pitch - control_pitch)
