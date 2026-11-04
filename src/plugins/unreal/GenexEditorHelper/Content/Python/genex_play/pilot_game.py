"""The game as a pilot sees it (genex_play.pilot_kit): reads of the play session, and controllers a
move's run() takes with `yield from`, each a generator stepped once a frame on the game clock.

Reads: seconds, pawn, state, near, actor, actors, nearest, distance, bearing, visible, read, threat
(an attacker's swing and the seconds until its hit lands, genex_play.threat).
Controllers: walk_to and look_at (genex_play.walk: the nav mesh, recovery, facing on arrival), aim
(the view kept on a moving actor), strafe, hold, tap, wait and mouse; together steps several in the
same frames (aim while holding fire, strafe while aiming). A controller a move is stopped in lets go of
what it pressed: a walk or a look stops, a hold or a strafe is released.
Reflexes, for Pilot.reflex every frame whatever move runs: dodge (once per hit, just before it lands)
and press_now.
"""

import contextlib
import math
import re

import unreal

from genex_play import near, play, threat, ui, walk, walk_math

CM_PER_M = 100.0
WALKING, LOOKING = 'walking', 'looking'
# A tapped key's press reaches the game within this many frames.
TAP_FRAMES = 2
# BreakHitResult's first and tenth outputs: whether the trace hit, and the actor it hit.
HIT_BLOCKING, HIT_ACTOR = 0, 9
# The shortest aim, in game seconds.
AIM_TURN_S = 0.3
# shoot fires while the view is on the target: within ON_TARGET_DEG, or within the angle a body BODY_HALF_CM
# wide each side covers at its distance (wider up close); in bursts this long with these pauses.
ON_TARGET_DEG = 3.0
BODY_HALF_CM = 35.0
# visible() looks for a body's head at this height of it, then its middle.
SIGHT_HEAD = 0.85
# Aimed at this height of a body or above (its head), the on-target window is a head's width.
HEAD_HEIGHT = 0.8
HEAD_HALF_CM = 11.0
# A head far off still gets a window this wide (degrees): the aim settles no finer, and a near miss hits the body.
HEAD_MIN_DEG = 1.0
# shoot stops once its target has been out of sight this long (it went behind a wall or round a corner).
LOST_S = 0.5
BURST_S = 0.35
BURST_PAUSE_S = 0.2
# The keys most shooters fire and aim down sights with.
FIRE_KEY, AIM_KEY = 'LeftMouseButton', 'RightMouseButton'
# dodge presses once a hit is this many game seconds away (a frame and the dodge's start-up), and holds
# the move input sideways this long so the dodge goes across the swing.
DODGE_LEAD_S = 0.3
DODGE_MOVE_S = 0.25
REFLEXES_KEPT = 200
# The Unreal C++ spelling of a property (Health, bDead, MaxHP) becomes Python's (health, dead, max_hp).
_CAMEL = re.compile(r'(?<=[a-z0-9])(?=[A-Z])|(?<=[A-Z])(?=[A-Z][a-z])')


def python_name(name: str) -> str:
    """The Python spelling of a property's C++ name: Health is health, bDead is dead, MaxHP is max_hp."""
    plain = name[1:] if len(name) > 1 and name[0] == 'b' and name[1].isupper() else name
    return re.sub(_CAMEL, '_', plain).lower()


def _label(actor) -> str:
    try:
        return str(actor.get_actor_label())
    except Exception:  # noqa: BLE001 - a cooked or runtime actor has no editor label
        return str(actor.get_name())


def _clear(hit, actor) -> bool:
    """Whether a trace's hit leaves the way to `actor` open: no hit, no blocking hit, or a hit on it or what it holds."""
    if hit is None:
        return True
    broken = hit.to_tuple()
    struck = broken[HIT_ACTOR]
    return not broken[HIT_BLOCKING] or struck == actor or (struck is not None and struck.get_owner() == actor)


def _flat(vector) -> tuple:
    return (float(vector.x), float(vector.y))


class Game:
    """The play session's game, for a pilot's look, moves and setup."""

    def __init__(self) -> None:
        self._trackers: dict[str, threat.Tracker] = {}
        self._answered: set = set()
        self._side = 1.0
        self.reflexes: list[dict] = []  # each dodge made: game time, target, attack, seconds the hit was away

    # -- reads ---------------------------------------------------------------------------------

    def seconds(self) -> float:
        """The play session's game clock, in seconds."""
        return play.game_seconds()

    def pawn(self):
        """The player's pawn, or RuntimeError when the player controls none."""
        return play.player_pawn()

    def state(self) -> dict:
        """The player's pawn, its speed, what is held, and the play's clock and frame rate."""
        return play.pawn_state()

    def near(self) -> list:
        """The nearest of the game's own actors with a body, as "label: 3.8 m, 20° right"."""
        return near.nearby(play.player_pawn())

    def actors(self, text: str = '') -> list:
        """The level's actors whose label or name holds text (case aside), the player's pawn left out."""
        wanted = text.strip().lower()
        pawn = play.player_pawn()
        found = []
        for actor in unreal.GameplayStatics.get_all_actors_of_class(play.game_world(), unreal.Actor):
            if actor == pawn:
                continue
            if not wanted or wanted in _label(actor).lower() or wanted in str(actor.get_name()).lower():
                found.append(actor)
        return found

    def actor(self, text: str):
        """The actor whose label or name is text (the player's pawn too), else the nearest whose label or
        name holds it; None when none does."""
        wanted = text.strip().lower()
        pawn = play.player_pawn()
        if wanted in (_label(pawn).lower(), str(pawn.get_name()).lower()):
            return pawn
        matches = self.actors(text)
        exact = [a for a in matches if wanted in (_label(a).lower(), str(a.get_name()).lower())]
        return self._nearest_of(exact or matches)[0]

    def nearest(self, text: str) -> tuple:
        """(actor, metres) of the nearest actor whose label or name holds text, (None, None) when none does."""
        return self._nearest_of(self.actors(text))

    def _nearest_of(self, actors: list) -> tuple:
        if not actors:
            return None, None
        at = _flat(play.player_pawn().get_actor_location())
        distances = [(math.dist(at, _flat(a.get_actor_location())) / CM_PER_M, a) for a in actors]
        metres, actor = min(distances, key=lambda pair: pair[0])
        return actor, round(metres, 2)

    def _resolve(self, target):
        return self.actor(target) if isinstance(target, str) else target

    def distance(self, target) -> float | None:
        """Metres along the ground from the player to an actor (or its label or name); None when there is none."""
        actor = self._resolve(target)
        if actor is None:
            return None
        at = _flat(play.player_pawn().get_actor_location())
        return round(math.dist(at, _flat(actor.get_actor_location())) / CM_PER_M, 2)

    def bearing(self, target) -> float | None:
        """Degrees from where the view faces to an actor: + right, - left, 0 ahead; None when there is none."""
        actor = self._resolve(target)
        if actor is None:
            return None
        at = _flat(play.player_pawn().get_actor_location())
        heading = walk_math.heading(at, _flat(actor.get_actor_location()))
        return round(walk_math.wrap(heading - float(play.control_rotation().yaw)), 1)

    def visible(self, target) -> bool | None:
        """Whether the player's view sees an actor: a line from the camera reaches its head or its middle with
        nothing that blocks sight in between (a wall between the camera and it hides it, even when the body
        stands where a line from the pawn would slip past); None when there is none."""
        actor = self._resolve(target)
        if actor is None:
            return None
        pawn = play.player_pawn()
        # The player's own attached actors (a first-person weapon) are never what hides an enemy.
        mine = [pawn, *pawn.get_attached_actors()]
        eyes = walk._eyes(pawn)
        start = unreal.Vector(*eyes)
        middle = actor.get_actor_location()
        low, high = walk._span(actor)
        for z in (low + (high - low) * SIGHT_HEAD, float(middle.z)):
            end = unreal.Vector(float(middle.x), float(middle.y), z)
            sight = unreal.SystemLibrary.line_trace_single(
                pawn, start, end, unreal.TraceTypeQuery.TRACE_TYPE_QUERY1, True, mine, unreal.DrawDebugTrace.NONE, True)
            # A level piece that lets the sight channel through (a door set to ignore it) still stops bullets:
            # anything solid in the world on the line hides the actor too.
            solid = unreal.SystemLibrary.line_trace_single_for_objects(
                pawn, start, end, [unreal.ObjectTypeQuery.OBJECT_TYPE_QUERY1, unreal.ObjectTypeQuery.OBJECT_TYPE_QUERY2],
                True, mine, unreal.DrawDebugTrace.NONE, True)
            if _clear(sight, actor) and _clear(solid, actor):
                return True
        return False

    def threat(self, target, hit: str = '') -> dict | None:
        """The attack an actor (or its label or name) plays: {attack, section, position, rate, hit_at, to_hit};
        None when it plays none. to_hit is the game seconds until its next hit lands: a notify whose name
        holds `hit`, else one named like a hit (DoAttackTrace, Hit, Damage)."""
        actor = self._resolve(target)
        return threat.read(actor, hit) if actor is not None else None

    def widgets(self) -> list:
        """The game's own on-screen interface: visible widgets with text or buttons (name, kind, text, button, box)."""
        return ui.widgets()['widgets']

    def press_button(self, text: str) -> dict:
        """Presses a visible, enabled button of the game's interface by its text or name."""
        return ui.press(text)

    def read(self, target, name: str, default=None):
        """A property of an actor (a Blueprint's variable by its name; a C++ spelling such as Health or bDead
        is read as Python's health and dead), else default."""
        actor = self._resolve(target)
        if actor is None:
            return default
        for spelling in dict.fromkeys((name, python_name(name))):
            try:
                return actor.get_editor_property(spelling)
            except Exception:  # noqa: BLE001 - no property of this spelling on this actor
                continue
        return default

    # -- controllers -------------------------------------------------------------------------------

    def walk_to(self, target, within: float = walk.WITHIN_M, seconds: float = walk.WALK_SECONDS):
        """Walks the player to an actor (or its label or name, or "x,y,z" cm) and answers how the walk
        ended: {state: arrived|stuck|stopped|timed-out|failed, distanceM, reason, ...}."""
        try:
            walk.walk_to(target, within, seconds)
        except RuntimeError as error:
            return {'state': 'failed', 'reason': str(error), 'distanceM': None}
        try:
            while True:
                report = walk.walk_report(play.game_seconds())
                if report is None or report['state'] != WALKING:
                    return report or {'state': 'failed', 'reason': 'the walk never started', 'distanceM': None}
                yield
        finally:
            walk.stop_walk('the pilot chose another move')

    def look_at(self, target, seconds: float = walk.LOOK_SECONDS):
        """Turns the player's view onto an actor (or its label or name, or "x,y,z" cm) and answers how
        the turn ended: {state: looked|stopped|timed-out|failed, offDegrees, reason}."""
        try:
            walk.look_at(target, walk.LOOK_TOLERANCE, seconds)
        except RuntimeError as error:
            return {'state': 'failed', 'reason': str(error), 'offDegrees': None}
        try:
            while True:
                report = walk.look_report(play.game_seconds())
                if report is None or report['state'] != LOOKING:
                    return report or {'state': 'failed', 'reason': 'the look never started', 'offDegrees': None}
                yield
        finally:
            walk.stop_look('the pilot chose another move')

    def aim(self, target, seconds: float, height: float | None = None):
        """Keeps the player's view on an actor (or its label or name) for `seconds` of game time as it
        moves, turning again whenever it drifts off; answers how the last turn stood. height (0 bottom,
        1 top) aims at that height of it instead of its middle: 0.9 is a standing body's head."""
        try:
            walk.look_at(target, walk.LOOK_TOLERANCE, max(AIM_TURN_S, float(seconds)), track=True, height=height)
        except RuntimeError as error:  # no such actor
            return {'state': 'failed', 'reason': str(error), 'offDegrees': None}
        try:
            while True:
                report = walk.look_report(play.game_seconds())
                if report is None or report['state'] != LOOKING:
                    return report or {'state': 'failed', 'reason': 'the aim never started', 'offDegrees': None}
                yield
        finally:
            walk.stop_look('the aim ended')

    def shoot(self, target, seconds: float = 3.0, fire: str = FIRE_KEY, aim: str | None = AIM_KEY,
              height: float | None = None):
        """Aims at an actor and fires at it for `seconds` of game time, as a player does: aiming down sights
        (`aim`, None for no sights) the whole time, the view kept on the target, and the trigger pulled in
        short bursts only while the view is within ON_TARGET_DEG of it (so recoil and a moving target are
        corrected between bursts). height aims at that height of the body (0.9: the head, where a shot
        kills soonest in most shooters). It stops early once the target has been out of sight for LOST_S, so
        it never fires into a wall. Answers {fired, onTarget, lost}: seconds of fire, the share of frames on
        it, and whether it stopped because the target went out of sight."""
        actor = self._resolve(target)
        tracking = self.aim(target, seconds, height)
        sights = self._sights(aim)
        trigger = play.resolve(fire)
        until = play.game_seconds() + float(seconds)
        raised = False
        frames = on = 0
        fired, burst_until, rest_until = 0.0, -math.inf, -math.inf
        seen_at, lost = play.game_seconds(), False
        try:
            while True:
                try:
                    next(tracking)
                except StopIteration:
                    break
                now = play.game_seconds()
                if actor is None or self.visible(actor):
                    seen_at = now
                elif now - seen_at >= LOST_S:
                    lost = True
                    break
                report = walk.look_report(now) or {}
                off = report.get('offDegrees')
                frames += 1
                if off is not None and off <= self._on_target_deg(actor, height):
                    on += 1
                    if sights is not None and not raised:
                        # Raised only once on target: the sights change how far the mouse turns the view.
                        play.press(sights, 1.0, 0.0, max(until - now, play.MIN_HOLD_SECONDS))
                        raised = True
                    if now >= rest_until and now >= burst_until:
                        play.press(trigger, 1.0, 0.0, BURST_S)
                        burst_until, rest_until = now + BURST_S, now + BURST_S + BURST_PAUSE_S
                        fired += BURST_S
                yield
        finally:
            with contextlib.closing(tracking):
                pass
            play.release(trigger.label)
            if sights is not None:
                play.release(sights.label)
        return {'fired': round(fired, 2), 'onTarget': round(on / frames, 2) if frames else 0.0, 'lost': lost}

    def _sights(self, aim: str | None):
        """The input that raises the sights, or None: none asked, or the game has no such input (it fires from the hip)."""
        if not aim:
            return None
        try:
            return play.resolve(aim)
        except RuntimeError:
            return None

    def _on_target_deg(self, actor, height: float | None = None) -> float:
        """How near the view must point to hit `actor`: ON_TARGET_DEG, or the angle its body (its head, when
        aimed that high) covers up close."""
        head = height is not None and height >= HEAD_HEIGHT
        metres = self.distance(actor) if actor is not None else None
        if not metres:
            return ON_TARGET_DEG
        half = HEAD_HALF_CM if head else BODY_HALF_CM
        widest = math.degrees(math.atan(half / (metres * CM_PER_M)))
        return max(HEAD_MIN_DEG if head else ON_TARGET_DEG, widest)

    def strafe(self, right: float, seconds: float):
        """Steps sideways for `seconds` of game time, right for right > 0 and left for right < 0, as a
        player strafes: the game's move action, else D or A."""
        move = play.optional_action('Move')
        side = max(-1.0, min(1.0, float(right)))
        held = move if move is not None else play.Input('D' if side > 0 else 'A', None)
        play.press(held, side if move is not None else 1.0, 0.0, max(float(seconds), play.MIN_HOLD_SECONDS))
        try:
            yield from self.wait(seconds)
        finally:
            play.release(held.label)

    def together(self, *runs):
        """Steps several controllers in the same frames until every one has ended; answers their results
        in order. Stopped early, it stops each still running, which lets go of what it pressed."""
        results = [None] * len(runs)
        live = list(enumerate(runs))
        try:
            while live:
                still = []
                for index, run in live:
                    try:
                        next(run)
                        still.append((index, run))
                    except StopIteration as stop:
                        results[index] = stop.value
                live = still
                if live:
                    yield
        finally:
            for _index, run in live:
                with contextlib.closing(run):  # a closed controller lets go of what it pressed
                    pass
        return results

    def wait(self, seconds: float):
        """Waits `seconds` of game time."""
        until = play.game_seconds() + max(0.0, float(seconds))
        while play.game_seconds() < until:
            yield

    def hold(self, name: str, seconds: float, x: float = 1.0, y: float = 0.0):
        """Holds an input action (Jump, IA_Attack) or a key (W, MouseLeft) for `seconds` of game time."""
        held = play.resolve(name)
        play.press(held, x, y, max(float(seconds), play.MIN_HOLD_SECONDS))
        try:
            yield from self.wait(seconds)
        finally:
            play.release(held.label)

    def tap(self, name: str):
        """Presses a key once, as a keyboard's tap (an input action for a tap's moment), and waits the
        frames its press takes to reach the game."""
        held = play.resolve(name)
        if held.action is not None:
            yield from self.hold(name, play.TAP_SECONDS)
            return
        play.tap(held.label)
        for _ in range(TAP_FRAMES):
            yield

    def mouse(self, dx: float = 0.0, dy: float = 0.0, wheel: float = 0.0):
        """Moves the player's mouse by (dx, dy) pixels (down is +dy) and turns its wheel, for one frame."""
        play.move_mouse(dx, dy, wheel)
        yield

    # -- reflexes (Pilot.reflex, every frame) ------------------------------------------------------

    def press_now(self, name: str, seconds: float = play.TAP_SECONDS, x: float = 1.0, y: float = 0.0) -> None:
        """Presses an input action (Dodge, IA_Block) or a key at once for `seconds` of game time, beside
        whatever the running move holds."""
        play.press(play.resolve(name), x, y, max(float(seconds), play.MIN_HOLD_SECONDS))

    def dodge(self, target, action: str = 'Dodge', lead: float = DODGE_LEAD_S, hit: str = '',
              sideways: bool = True) -> bool:
        """Presses `action` once per hit of an attacker, when that hit is under `lead` game seconds away;
        with sideways, the move input is held across (alternating sides) so the dodge leaves the swing.
        Call it from Pilot.reflex every frame. True when it pressed this frame; each press goes in
        game.reflexes with how far away the hit was, to tune lead against the hits that still land."""
        actor = self._resolve(target)
        if actor is None:
            return False
        name = _label(actor)
        seen = threat.read(actor, hit)
        key = threat.hit_key(self._trackers.setdefault(name, threat.Tracker()), seen)
        if key is None or seen['to_hit'] > lead or (name, key) in self._answered:
            return False
        self._answered.add((name, key))
        move = play.optional_action('Move') if sideways else None
        if move is not None:
            self._side = -self._side
            play.press(move, self._side, 0.0, DODGE_MOVE_S)
        self.press_now(action)
        if len(self.reflexes) < REFLEXES_KEPT:
            self.reflexes.append({'t': round(self.seconds(), 2), 'target': name, 'attack': seen['attack'],
                                  'toHit': seen['to_hit']})
        return True
