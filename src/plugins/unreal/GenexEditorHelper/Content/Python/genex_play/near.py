"""What is near the player, for player_state: the nearest of the game's own actors that have
something to see or touch, each with its distance and its bearing from where the view faces.

An agent playing finds a stone, a door or a turret by name here and walks to it, instead of
searching the level or the project's files first. The engine's own actors (level geometry, lights,
the sky) and actors with no body (a game's rules, its controllers) are left out.
"""

import math

import unreal

from genex_play import play, walk_math

NEAR_COUNT = 6
NEAR_M = 60.0
CM_PER_M = 100.0
# A bearing within this many degrees of the view is ahead.
AHEAD_DEG = 10.0
ENGINE_CLASSES = '/Script/Engine.'


def _label(actor) -> str:
    try:
        return str(actor.get_actor_label())
    except Exception:  # noqa: BLE001 - a cooked or runtime actor has no editor label
        return str(actor.get_name())


def _game_body(actor) -> bool:
    """Whether an actor is the game's own (not the engine's) and has a body to see or touch."""
    if actor.get_class().get_path_name().startswith(ENGINE_CLASSES):
        return False
    return bool(actor.get_components_by_class(unreal.PrimitiveComponent))


def _where(metres: float, bearing: float) -> str:
    """ "3.8 m ahead" or "5.0 m, 90° left": how far, and which way from where the view faces."""
    if abs(bearing) <= AHEAD_DEG:
        return f'{metres:.1f} m ahead'
    return f'{metres:.1f} m, {abs(bearing):.0f}° {"right" if bearing > 0 else "left"}'


def nearby(pawn) -> list[str]:
    """The nearest of the game's own actors with a body, within NEAR_M metres, nearest first, as
    "label: 3.8 m, 20° right" (degrees from where the view faces; "ahead" within AHEAD_DEG)."""
    at = pawn.get_actor_location()
    origin = (float(at.x), float(at.y))
    view = float(play.control_rotation().yaw)
    rows = []
    for actor in unreal.GameplayStatics.get_all_actors_of_class(play.game_world(), unreal.Actor):
        if actor == pawn or not _game_body(actor):
            continue
        where = actor.get_actor_location()
        goal = (float(where.x), float(where.y))
        metres = math.dist(origin, goal) / CM_PER_M
        if metres > NEAR_M:
            continue
        bearing = walk_math.wrap(walk_math.heading(origin, goal) - view)
        rows.append((metres, f'{_label(actor)}: {_where(metres, bearing)}'))
    rows.sort(key=lambda row: row[0])
    return [text for _metres, text in rows[:NEAR_COUNT]]
