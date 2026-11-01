"""Walks the player's pawn to a target, and turns its view onto one, every frame on the game clock.

walk_to's way is the level's nav mesh path when it has one, else the straight line. The pawn is
steered by forcing the game's move action (IA_Move, a 2D axis the templates read in the
controller's own frame: X right, Y forward) toward the next waypoint each frame, so no view is
turned; a game without one is steered with W/A/S/D. Each frame's input lasts only LEASE_S of game
time unless pressed again, so a walk that stops lets go by itself. It lets go early by the distance
the pawn slides and never walks off a drop. When it makes no progress it jumps, side-steps left
and right, plans the way again, and only then says it is stuck. Arrived at an actor, it ends facing
it, so the swing or interact that follows reaches it: a body that turns where it walks (a
third-person character) by a light push toward it, a body that turns with its view by turning the
view onto it as look_at does.

look_at turns the view with the mouse (Mouse2D). It first moves the mouse a little for one frame
and waits a few frames for the view to answer, which measures how far a pixel turns it (and any
frame of lag) with no sensitivity set up front, and says at once when the view doesn't turn (a
menu or the game holding the mouse). Then it closes the gap a damped share each frame, which stays
steady when the game answers a frame late. player_state reports both.
"""

import difflib
import math

import unreal

from genex_play import play, walk_math

WITHIN_M = 1.2
WALK_SECONDS = 20.0
CM_PER_M = 100.0
# Each frame's move input lasts this much game time unless pressed again.
LEASE_S = 0.25
# A waypoint this close is passed; a moving target this far from the planned goal plans the way again.
WAYPOINT_CM = 80.0
REPLAN_CM = 200.0
# Progress is getting PROGRESS_CM closer to the next waypoint within PROGRESS_S game seconds.
PROGRESS_CM = 30.0
PROGRESS_S = 1.5
# What a walk tries, in order, when it makes no progress; each once, until it gets RECOVERED_CM closer.
JUMP, LEFT, RIGHT, REPLAN = 'jump', 'left', 'right', 'replan'
RECOVERY = (JUMP, LEFT, RIGHT, REPLAN)
RECOVERY_S = 0.6
RECOVERED_CM = 300.0
JUMP_PRESS_S = 0.2
# Below this flat speed (cm/s) the pawn has stopped coasting: a walk arrives only below it.
COAST_MIN_CM_S = 100.0
# The pawn coasts about its speed times this once the input is let go.
SLIDE_S = 0.12
# Over the last APPROACH_CM before reach the move action eases off, as a player lets go of the stick,
# down to MIN_PUSH of a full push: a fast pawn then arrives slowly instead of sliding past. A move
# action has a dead zone (the templates' is 0.2) that a smaller push never gets past.
APPROACH_CM = 300.0
MIN_PUSH = 0.4
# Arrived at an actor, the body is pushed lightly toward it (FACE_PUSH of a full push; W/A/S/D for
# FACE_LEASE_S at a time) for at most FACE_S game seconds, or its view is turned onto it for at most
# FACE_VIEW_S, until it faces it within FACE_DEG.
FACE_DEG = 15.0
FACE_S = 0.8
FACE_VIEW_S = 2.0
FACE_PUSH = 0.5
FACE_LEASE_S = 0.05
# Standing this near (flat) an actor's middle, it is underfoot: there is nothing to face.
UNDERFOOT_CM = 30.0
# A point more than this above or below the pawn is on another floor; an actor whose bottom is more
# than LEVEL_CM above or below the pawn's feet stands on another level (unless it rises through them).
STOREY_CM = 250.0
LEVEL_CM = 100.0
# The floor is felt this far ahead; a floor more than STEP_DOWN_CM below the pawn's feet is a drop
# (a player drops 3 m without a second thought).
LOOKAHEAD_CM = 60.0
STEP_DOWN_CM = 300.0
# A pawn without a capsule is taken for a standing character.
HALF_HEIGHT_CM = 88.0
HIT_BLOCKING = 0  # BreakHitResult's first output
KEYS = ('W', 'A', 'S', 'D')
JUMP_KEY = 'SpaceBar'

EYE_CM = 64.0
LOOK_TOLERANCE = 2.5
LOOK_SECONDS = 6.0
# While walking with nothing else turning the view, it looks where the walk goes, as a player does: at a
# point this far ahead along the way at eye height (level), turning again once off by more than this.
AHEAD = '(the way ahead)'
AHEAD_CM = 500.0
AHEAD_TOLERANCE = 12.0
# The probe: pixels the mouse moves for one frame, and the frames the view has to answer it.
PROBE_PX = 10.0
PROBE_FRAMES = 4
# Degrees a pixel turns an axis the probe couldn't measure (at its limit); the most degrees one
# frame turns (in degrees, not pixels: a game whose pixel turns a twentieth of a degree still turns
# fast); the share of the gap closed each frame (under 0.5 stays steady with a frame of lag).
LOOK_GAIN = 0.5
LOOK_MAX_TURN = 20.0
LOOK_DAMPING = 0.4
# A turn smaller than this (degrees) is no turn; a measured gain stays within these bounds.
MIN_TURN = 0.05
GAIN_RANGE = (0.01, 10.0)
# A tracking look keeps measuring what its pushes turn (aiming down sights or a game's own smoothing change it
# mid-look): each frame after a push of ADAPT_PX or more, the yaw gain moves ADAPT_SHARE toward what turned.
# Pitch follows the same factor (recoil kicks pitch on its own, so pitch is never measured).
ADAPT_PX = 3.0
ADAPT_SHARE = 0.3
# Frames of pushing in which the gap never got smaller before the view is taken for stuck.
NO_TURN_FRAMES = 12
STILL_MOUSE = 'X=0 Y=0'

CLOSEST_NAMES = 5

_walk: dict = {}
_look: dict = {}


def _xyz(vector) -> tuple:
    return (float(vector.x), float(vector.y), float(vector.z))


def _pawn():
    try:
        return play.player_pawn()
    except RuntimeError:  # the player controls no pawn right now
        return None


def _label(actor) -> str:
    try:
        return str(actor.get_actor_label())
    except Exception:  # noqa: BLE001 - a cooked or runtime actor has no editor label
        return str(actor.get_name())


def _actor_target(world, pawn, text: str):
    """(label, goal getter, span getter) of the actor whose label or name is text or holds it, the closest to the pawn."""
    wanted = text.strip().lower()
    actors = [a for a in unreal.GameplayStatics.get_all_actors_of_class(world, unreal.Actor) if a != pawn]
    named = [(a, _label(a), str(a.get_name())) for a in actors]
    exact = [a for a, label, name in named if wanted in (label.lower(), name.lower())]
    loose = exact or [a for a, label, name in named if wanted in label.lower() or wanted in name.lower()]
    if not loose:
        labels = sorted({label for _a, label, _n in named})
        closest = difflib.get_close_matches(text, labels, n=CLOSEST_NAMES, cutoff=0.0)
        raise RuntimeError(f'No actor is called {text}. Closest names: {", ".join(closest) or "none"}.')
    at = _xyz(pawn.get_actor_location())
    return _actor_goals(min(loose, key=lambda a: math.dist(_xyz(a.get_actor_location()), at)))


def _actor_goals(actor):
    """(label, goal getter, span getter) of an actor itself, followed while it moves."""

    def goal():
        try:
            return _middle(actor)
        except Exception:  # noqa: BLE001 - the actor was destroyed while the walk went on
            return None

    def span():
        try:
            return _span(actor)
        except Exception:  # noqa: BLE001 - the actor was destroyed while the walk went on
            return None

    return _label(actor), goal, span


def _bounds(actor) -> tuple:
    """(low, high) corners of an actor's parts that collide (an editor-only arrow doesn't, and its
    bounds in play lie elsewhere), else of all its parts."""
    origin, extent = actor.get_actor_bounds(True)
    if not (extent.x or extent.y or extent.z):
        origin, extent = actor.get_actor_bounds(False)
    o, e = _xyz(origin), _xyz(extent)
    return tuple(o[i] - e[i] for i in range(3)), tuple(o[i] + e[i] for i in range(3))


def _middle(actor) -> tuple:
    """Where an actor is: the middle of its bounds."""
    low, high = _bounds(actor)
    return tuple((low[i] + high[i]) / 2 for i in range(3))


def _span(actor) -> tuple:
    """(bottom, top) of an actor's bounds."""
    low, high = _bounds(actor)
    return (low[2], high[2])


def _at_height(goal_of, span_of, height: float):
    """A goal getter for the point `height` of the way up an actor's span, above its middle."""

    def goal():
        middle, span = goal_of(), span_of()
        if middle is None or span is None:
            return middle
        return (middle[0], middle[1], span[0] + (span[1] - span[0]) * height)

    return goal


def _point(text: str) -> tuple | None:
    """The point "x,y,z" (cm) names, or None when text is not three numbers."""
    parts = text.split(',')
    if len(parts) != 3:
        return None
    try:
        return tuple(float(part) for part in parts)
    except ValueError:
        return None


def _target(world, pawn, text):
    """(label, goal getter, span getter) for a target: a point "x,y,z" (cm), which has no span, an
    actor by label or name, or an actor itself (a pilot's), whose span is its (bottom, top)."""
    if not isinstance(text, str):
        return _actor_goals(text)
    point = _point(text)
    if point is not None:
        return text.strip(), lambda: point, None
    return _actor_target(world, pawn, text)


def _half_height(pawn) -> float:
    capsule = pawn.get_component_by_class(unreal.CapsuleComponent)
    return float(capsule.get_scaled_capsule_half_height()) if capsule is not None else HALF_HEIGHT_CM


def _plan(walk: dict, at: tuple, goal: tuple) -> None:
    """The way to goal: the nav mesh's path when the level has one, else the straight line."""
    path = unreal.NavigationSystemV1.find_path_to_location_synchronously(
        play.game_world(), unreal.Vector(*at), unreal.Vector(*goal))
    points = [_xyz(p) for p in path.path_points] if path is not None and path.is_valid() else []
    if len(points) >= 2:
        walk.update(way='navmesh', waypoints=points[1:], partial=bool(path.is_partial()))
    else:
        walk.update(way='direct', waypoints=[goal], partial=False)
    walk['planned'] = goal


def walk_to(target, within_m: float = WITHIN_M, seconds: float = WALK_SECONDS) -> dict:
    """Starts walking the player's pawn to target (an actor's label or name, "x,y,z" cm, or an actor); returns at once."""
    world = play.game_world()
    pawn = play.player_pawn()
    label, goal_of, span_of = _target(world, pawn, target)
    goal = goal_of()
    if goal is None:
        raise RuntimeError(f'{label} has no place in the level.')
    _end_walk('stopped', 'a new walk began')
    now = play.game_seconds()
    seconds = max(float(seconds), LEASE_S)
    walk = {'state': 'walking', 'target': label, 'goal_of': goal_of, 'within': max(float(within_m), 0.1) * CM_PER_M,
            'started': now, 'until_game': now + seconds, 'until_wall': play.wall_clock() + play.wall_cap(seconds),
            'move': play.optional_action('Move'), 'jump': play.optional_action('Jump'), 'tried': [], 'reason': '',
            'next': 0, 'best': math.inf, 'since': now, 'recovering': None, 'recovery_until': now,
            'recovery_from': math.inf, 'distance': math.dist(_xyz(pawn.get_actor_location())[:2], goal[:2]),
            'ended': None, 'pressed': set(), 'span_of': span_of, 'facing': None, 'facing_until': None, 'facing_view': False}
    _plan(walk, _xyz(pawn.get_actor_location()), goal)
    _walk.clear()
    _walk.update(walk)
    play.watch(_walk_step, lambda: _end_walk('stopped', 'stopped by release_all or the end of play'))
    return {'walking': True, 'target': label, 'way': walk['way'], 'waypoints': len(walk['waypoints']),
            'distanceM': round(walk['distance'] / CM_PER_M, 1)}


def stop_walk(reason: str) -> None:
    """Stops the walk going on, if one is, letting go of what it pressed."""
    _end_walk('stopped', reason)


def stop_look(reason: str) -> None:
    """Stops the look going on, if one is, stilling the mouse."""
    _end_look('stopped', reason)


def _let_go_walk() -> None:
    for label in list(_walk.get('pressed', ())):
        play.release(label)
    _walk['pressed'] = set()


def _end_walk(state: str, reason: str) -> bool:
    """Ends the walk going on, if one is: how it ended and why; answers False (stop watching)."""
    if _walk.get('state') != 'walking':
        return False
    _walk.update(state=state, reason=reason)
    try:
        _walk['ended'] = play.game_seconds()
    except RuntimeError:  # the play session ended
        _walk['ended'] = None
    _let_go_walk()
    if _look.get('target') == AHEAD:
        _end_look('stopped', 'the walk ended')
    return False


def _eyes(pawn) -> tuple:
    """Where the view is seen from: the player's camera, else EYE_CM above the pawn."""
    camera = play.eyes()
    if camera is not None:
        return camera
    at = _xyz(pawn.get_actor_location())
    return (at[0], at[1], at[2] + EYE_CM)


def _look_ahead() -> None:
    """Turns the view to where the walk goes, unless another look (an aim, a look_at) is turning it."""
    if _look.get('state') == 'looking':
        return

    def goal():
        pawn = _pawn()
        if pawn is None or not _walk.get('waypoints'):
            return None
        at = _xyz(pawn.get_actor_location())
        yaw = math.radians(walk_math.heading(at, _walk['waypoints'][0]))
        return (at[0] + math.cos(yaw) * AHEAD_CM, at[1] + math.sin(yaw) * AHEAD_CM, at[2] + EYE_CM)

    _start_look(AHEAD, goal, AHEAD_TOLERANCE, max(_walk['until_game'] - play.game_seconds(), LEASE_S), track=True)


def _press(held, x: float, y: float, seconds: float) -> None:
    play.press(held, x, y, seconds)
    _walk['pressed'].add(held.label)


def _recover(at: tuple, game_now: float) -> bool:
    """The next thing to try when no progress was made; False once everything was tried (stuck)."""
    if _walk['next'] >= len(RECOVERY):
        x, y, z = (round(v) for v in at)
        _end_walk('stuck', f'no way past at {x},{y},{z}')
        return False
    step = RECOVERY[_walk['next']]
    _walk['next'] += 1
    _walk['tried'].append(step)
    _walk.update(recovering=step, recovery_until=game_now + RECOVERY_S, since=game_now, best=math.inf,
                 recovery_from=_walk['distance'])
    if step == JUMP:
        _press(_walk['jump'] or play.Input(JUMP_KEY, None), 1.0, 0.0, JUMP_PRESS_S)
    elif step == REPLAN:
        _plan(_walk, at, _walk['goal_of']() or _walk['planned'])
    return True


def _progress(at: tuple, game_now: float) -> bool:
    """Whether the walk goes on: closer to the next waypoint lately, or trying something; False once stuck."""
    near = walk_math.flat_distance(at, _walk['waypoints'][0])
    if _walk['distance'] <= _walk['recovery_from'] - RECOVERED_CM:
        _walk.update(next=0, recovery_from=math.inf)
    if near < _walk['best'] - PROGRESS_CM:
        _walk.update(best=near, since=game_now)
        return True
    waiting = game_now < _walk['recovery_until'] or game_now - _walk['since'] < PROGRESS_S
    return True if waiting else _recover(at, game_now)


def _heading(at: tuple, game_now: float) -> float:
    """The yaw to walk along this frame: toward the next waypoint, or across it while side-stepping."""
    toward = walk_math.heading(at, _walk['waypoints'][0])
    if game_now < _walk['recovery_until'] and _walk['recovering'] in (LEFT, RIGHT):
        return toward + (90.0 if _walk['recovering'] == LEFT else -90.0)
    return toward


def _drop_ahead(pawn, at: tuple, yaw: float) -> bool:
    """Whether the floor LOOKAHEAD_CM along yaw lies more than STEP_DOWN_CM below the pawn's feet, or is not there."""
    half = _half_height(pawn)
    x = at[0] + math.cos(math.radians(yaw)) * LOOKAHEAD_CM
    y = at[1] + math.sin(math.radians(yaw)) * LOOKAHEAD_CM
    hit = unreal.SystemLibrary.line_trace_single(
        pawn, unreal.Vector(x, y, at[2] + half), unreal.Vector(x, y, at[2] - half - STEP_DOWN_CM),
        unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, True, [pawn], unreal.DrawDebugTrace.NONE, True)
    return hit is None or not hit.to_tuple()[HIT_BLOCKING]


def _steer(yaw: float, push: float | None = None, lease: float = LEASE_S) -> None:
    """Forces the move action (or W/A/S/D) to walk along yaw in the controller's frame, for lease;
    the move action pushes `push` of a full push, or eases off near the goal."""
    right, forward = walk_math.move_axes(float(play.control_rotation().yaw), yaw)
    if _walk['move'] is not None:
        if push is None:
            push = min(1.0, max(MIN_PUSH, (_walk['distance'] - _walk['within']) / APPROACH_CM))
        _press(_walk['move'], round(right * push, 3), round(forward * push, 3), LEASE_S)
        return
    keys = walk_math.keys_for(right, forward)
    for key in KEYS:
        if key in keys:
            _press(play.Input(key, None), 1.0, 0.0, lease)
        elif key in _walk['pressed']:
            play.release(key)
            _walk['pressed'].discard(key)


def _body_off(pawn, at: tuple, goal: tuple) -> float:
    """Degrees between where the pawn's body faces and the goal."""
    return abs(walk_math.wrap(walk_math.heading(at, goal) - float(pawn.get_actor_rotation().yaw)))


def _arrive(pawn, at: tuple, goal: tuple, game_now: float, wall_now: float) -> bool:
    """Ends the walk arrived, first turning a body that turns where it walks to face an actor."""
    if _walk['span_of'] is None:
        return _end_walk('arrived', '')
    _walk['facing'] = _body_off(pawn, at, goal)
    if _walk['facing'] <= FACE_DEG or _walk['distance'] < UNDERFOOT_CM:
        return _end_walk('arrived', '')
    _walk['facing_until'] = game_now + FACE_S
    if pawn.get_editor_property('use_controller_rotation_yaw'):
        _walk['facing_view'] = True
        _start_look(_walk['target'], _walk['goal_of'], FACE_DEG, FACE_VIEW_S)
        return True
    return _face(pawn, at, goal, game_now, wall_now)


def _face(pawn, at: tuple, goal: tuple, game_now: float, wall_now: float) -> bool:
    """One frame of facing: a light push toward the goal until the body faces it or FACE_S is up, or
    the view turning onto it until that turn ends."""
    _walk['facing'] = _body_off(pawn, at, goal)
    if _walk['facing_view']:
        turning = _look.get('state') == 'looking' and wall_now < _walk['until_wall']
        return True if turning else _end_walk('arrived', '')
    done = _walk['facing'] <= FACE_DEG or walk_math.flat_distance(at, goal) < UNDERFOOT_CM
    if done or game_now >= _walk['facing_until'] or wall_now >= _walk['until_wall']:
        return _end_walk('arrived', '')
    _steer(walk_math.heading(at, goal), FACE_PUSH, FACE_LEASE_S)
    return True


def _same_level(pawn, at: tuple, goal: tuple) -> bool:
    """Whether the goal stands on the pawn's level: for an actor, its bottom near the pawn's feet or
    the actor rising through them (a tree, a wall); for a point, within a storey of the pawn."""
    span = _walk['span_of']() if _walk['span_of'] is not None else None
    if span is None:
        return abs(at[2] - goal[2]) <= STOREY_CM
    feet = at[2] - _half_height(pawn)
    bottom, top = span
    return abs(feet - bottom) <= LEVEL_CM or bottom <= feet <= top


def _within(pawn, at: tuple, goal: tuple) -> bool:
    return _walk['distance'] <= _walk['within'] and _same_level(pawn, at, goal)


def _walk_step(game_now: float, wall_now: float) -> bool:
    """One frame of the walk; answers whether to keep watching."""
    if _walk.get('state') != 'walking':
        return False
    pawn = _pawn()
    goal = _walk['goal_of']() if pawn is not None else None
    if pawn is None or goal is None:
        return _end_walk('failed', "the player's pawn is gone" if pawn is None else 'the target is gone')
    at = _xyz(pawn.get_actor_location())
    _walk['distance'] = walk_math.flat_distance(at, goal)
    speed = math.hypot(float(pawn.get_velocity().x), float(pawn.get_velocity().y))
    if _walk['facing_until'] is not None:
        return _face(pawn, at, goal, game_now, wall_now)
    if _within(pawn, at, goal):
        # Arrived once it has stopped there; until then it coasts, and a slide out of reach steers back.
        if speed < COAST_MIN_CM_S:
            return _arrive(pawn, at, goal, game_now, wall_now)
        _let_go_walk()
        return True
    if game_now >= _walk['until_game'] or wall_now >= _walk['until_wall']:
        return _end_walk('timed-out', f'{_walk["distance"] / CM_PER_M:.1f} m short when its time was up')
    if walk_math.flat_distance(goal, _walk['planned']) > REPLAN_CM:
        _plan(_walk, at, goal)
    if _walk['way'] == 'direct':
        _walk['waypoints'] = [goal]
    while len(_walk['waypoints']) > 1 and walk_math.flat_distance(at, _walk['waypoints'][0]) <= WAYPOINT_CM:
        _walk.update(waypoints=_walk['waypoints'][1:], best=math.inf, since=game_now)
    if not _progress(at, game_now):
        return False
    yaw = _heading(at, game_now)
    if _walk['way'] == 'direct' and _drop_ahead(pawn, at, yaw):
        return _end_walk('stopped', f'a drop ahead, {_walk["distance"] / CM_PER_M:.1f} m short: it never walks off one')
    if speed >= COAST_MIN_CM_S and _walk['distance'] <= _walk['within'] + speed * SLIDE_S:
        _let_go_walk()
        return True
    _look_ahead()
    _steer(yaw)
    return True


def walk_report(now: float) -> dict | None:
    """The latest walk: how it stands, the way it took, what it tried; None before any."""
    if not _walk:
        return None
    end = _walk['ended'] if _walk['ended'] is not None else now
    return {'state': _walk['state'], 'target': _walk['target'], 'way': _walk['way'], 'partial': _walk['partial'],
            'distanceM': round(_walk['distance'] / CM_PER_M, 1), 'tried': list(_walk['tried']),
            'reason': _walk['reason'], 'gameSeconds': round(end - _walk['started'], 1),
            'facingDeg': round(_walk['facing'], 1) if _walk['facing'] is not None else None}


def look_at(target, tolerance: float = LOOK_TOLERANCE, seconds: float = LOOK_SECONDS, track: bool = False,
            height: float | None = None) -> dict:
    """Starts turning the player's view onto target (an actor's label or name, "x,y,z" cm, or an actor); returns at
    once. A tracking look stays on a moving target for its seconds instead of ending once on it. height (0 its
    bottom, 1 its top) looks at that height of an actor instead of its middle: 0.9 is a standing body's head."""
    world = play.game_world()
    pawn = play.player_pawn()
    label, goal_of, span_of = _target(world, pawn, target)
    if height is not None:
        goal_of = _at_height(goal_of, span_of, float(height))
    _start_look(label, goal_of, tolerance, seconds, track)
    return {'looking': True, 'target': label}


def _start_look(label: str, goal_of, tolerance: float, seconds: float, track: bool = False) -> None:
    """Starts turning the view onto what goal_of answers, watched every frame."""
    _end_look('stopped', 'a new look began')
    now = play.game_seconds()
    seconds = max(float(seconds), LEASE_S)
    _look.clear()
    _look.update({'state': 'looking', 'target': label, 'goal_of': goal_of, 'tolerance': max(float(tolerance), 0.5),
                  'started': now, 'until_game': now + seconds, 'until_wall': play.wall_clock() + play.wall_cap(seconds),
                  'gain': [LOOK_GAIN, LOOK_GAIN], 'probe': None, 'best': math.inf, 'still': 0, 'reason': '',
                  'error': None, 'ended': None, 'track': bool(track), 'view': None, 'pushed': None, 'pushed_from': None})
    play.watch(_look_step, lambda: _end_look('stopped', 'stopped by release_all or the end of play'))


def _end_look(state: str, reason: str) -> bool:
    if _look.get('state') != 'looking':
        return False
    _look.update(state=state, reason=reason)
    try:
        _look['ended'] = play.game_seconds()
        # A forced analog key let go injects its opposite: still the mouse for a frame first.
        play.settle_key(play.MOUSE_MOVE, STILL_MOUSE)
    except RuntimeError:  # the play session ended and took its input with it
        _look['ended'] = None
    return False


def _probe(view: tuple) -> bool:
    """The first frames of a look: a one-frame push, then frames for the view to answer it. True
    while probing; the gains are measured from what turned once it is done."""
    probe = _look['probe']
    if probe is not None and probe.get('done'):
        return False
    if probe is None:
        _look['probe'] = {'from': view, 'frames': 0}
        play.force_key(play.MOUSE_MOVE, f'X={PROBE_PX:g} Y={PROBE_PX:g}')
        return True
    if probe['frames'] == 0:
        play.force_key(play.MOUSE_MOVE, STILL_MOUSE)
    probe['frames'] += 1
    if probe['frames'] < PROBE_FRAMES:
        return True
    turned = (walk_math.wrap(view[0] - probe['from'][0]), walk_math.wrap(view[1] - probe['from'][1]))
    for axis in (0, 1):
        if abs(turned[axis]) >= MIN_TURN:
            gain = turned[axis] / PROBE_PX
            _look['gain'][axis] = math.copysign(min(max(abs(gain), GAIN_RANGE[0]), GAIN_RANGE[1]), gain)
    probe.update(done=True, moved=max(abs(turned[0]), abs(turned[1])) >= MIN_TURN)
    return False


def _look_step(game_now: float, wall_now: float) -> bool:
    """One frame of the look; answers whether to keep watching."""
    if _look.get('state') != 'looking':
        return False
    pawn = _pawn()
    goal = _look['goal_of']() if pawn is not None else None
    if pawn is None or goal is None:
        return _end_look('failed', "the player's pawn is gone" if pawn is None else 'the target is gone')
    rotation = play.control_rotation()
    view = (float(rotation.yaw), float(rotation.pitch))
    yaw_off, pitch_off = walk_math.look_error(view[0], view[1], _eyes(pawn), goal)
    _look['error'] = (yaw_off, pitch_off)
    if _probe(view):
        return True
    if not _look['probe']['moved']:
        return _end_look('failed', "the view doesn't turn: a menu or the game holds the mouse")
    return _turn(yaw_off, pitch_off, game_now, wall_now, view)


def _not_turning(gap: float, view: tuple) -> bool:
    """Whether the view has stopped answering the mouse: a plain look that gets no closer, or a tracking
    look whose view stands still (its target may move away faster than it closes) for NO_TURN_FRAMES."""
    if _look['track']:
        moved = _look['view'] is None or view != _look['view']
        _look.update(view=view, still=0 if moved else _look['still'] + 1)
    elif gap < _look['best'] - MIN_TURN:
        _look.update(best=gap, still=0)
    else:
        _look['still'] += 1
    return _look['still'] >= NO_TURN_FRAMES


def _turn(yaw_off: float, pitch_off: float, game_now: float, wall_now: float, view: tuple) -> bool:
    """Closes a damped share of the gap this frame; ends the look once on target (a tracking look holds
    it until its time is up), stuck or out of time."""
    gap = max(abs(yaw_off), abs(pitch_off))
    on_target = abs(yaw_off) <= _look['tolerance'] and abs(pitch_off) <= _look['tolerance']
    if on_target and not _look['track']:
        return _end_look('looked', '')
    if game_now >= _look['until_game'] or wall_now >= _look['until_wall']:
        return _end_look('looked', '') if on_target else _end_look('timed-out', f'{gap:.1f} degrees off when its time was up')
    if on_target:
        _look.update(view=view, still=0, pushed=None, pushed_from=None)
        play.force_key(play.MOUSE_MOVE, STILL_MOUSE)
        return True
    if _not_turning(gap, view):
        return _end_look('failed', "the view doesn't turn: a menu or the game holds the mouse")
    if _look['track']:
        _adapt(view)
    px = _pixels(yaw_off, _look['gain'][0])
    py = _pixels(pitch_off, _look['gain'][1])
    _look.update(pushed=(px, py), pushed_from=view)
    play.force_key(play.MOUSE_MOVE, f'X={px:.2f} Y={py:.2f}')
    return True


def _adapt(view: tuple) -> None:
    """Moves the gains toward what the last frame's push turned the yaw (a tracking look's own measure)."""
    pushed, before = _look.get('pushed'), _look.get('pushed_from')
    _look.update(pushed=None, pushed_from=None)
    if pushed is None or before is None or abs(pushed[0]) < ADAPT_PX:
        return
    turned = walk_math.wrap(view[0] - before[0])
    measured = turned / pushed[0]
    if measured <= 0:
        return  # turned the other way, or not at all: a frame of lag, not the gain
    old = _look['gain'][0]
    new = old + (min(max(measured, GAIN_RANGE[0]), GAIN_RANGE[1]) - old) * ADAPT_SHARE
    _look['gain'] = [new, _look['gain'][1] * new / old]


def _pixels(off: float, gain: float) -> float:
    """The mouse pixels that turn a damped share of off this frame, at most LOOK_MAX_TURN degrees."""
    turn = max(-LOOK_MAX_TURN, min(LOOK_MAX_TURN, off * LOOK_DAMPING))
    return turn / gain


def look_report(now: float) -> dict | None:
    """The latest look: how it stands and how far off the view still is; None before any."""
    if not _look:
        return None
    end = _look['ended'] if _look['ended'] is not None else now
    error = _look['error']
    return {'state': _look['state'], 'target': _look['target'], 'reason': _look['reason'],
            'offDegrees': round(max(abs(error[0]), abs(error[1])), 1) if error else None,
            'gameSeconds': round(end - _look['started'], 1)}
