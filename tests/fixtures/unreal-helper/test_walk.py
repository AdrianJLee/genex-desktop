"""walk_to walks the player's pawn to a target in one call, every frame on the game clock: along the
level's nav mesh when it has one, else the straight line; steered by the game's move action in the
controller's own frame (W/A/S/D without one), never walking off a drop. With no progress it jumps,
side-steps left and right, plans again, and only then says it is stuck. look_at turns the view with
the mouse, measuring what each frame turned, and says at once when the view doesn't turn."""

import json
import math
import re
import unittest
from unittest import mock

import unreal
from unreal import Rotator, Vector

from genex_play import play, walk, walk_math
from genex_play.tools import GenexPlayTools

from support import HelperCase

FRAME_S = 0.05
AXIS = re.compile(r'X=(-?[\d.e+-]+) Y=(-?[\d.e+-]+)')


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now


class Wall:
    """A box seen from above (x0, y0, x1, y1) the pawn can't walk into; a low one it can jump over."""

    def __init__(self, rect: tuple, low: bool = False, label: str = 'SM_Wall') -> None:
        self.rect, self.low, self.label = rect, low, label

    def holds(self, x: float, y: float) -> bool:
        return self.rect[0] <= x <= self.rect[2] and self.rect[1] <= y <= self.rect[3]


class World:
    """The game as walking sees it: each frame the pawn moves by what is forced on the move action (or
    W/A/S/D), turned by the controller's yaw, at `speed`, unless a wall is in the way; the view turns by
    what is forced on the mouse, `yaw_per_px` and `pitch_per_px` degrees a pixel."""

    def __init__(self, pawn, speed: float = 400.0, yaw_per_px: float = 0.5, pitch_per_px: float = -0.4) -> None:
        self.pawn, self.speed = pawn, speed
        self.yaw_per_px, self.pitch_per_px = yaw_per_px, pitch_per_px
        # How much of its speed a pawn keeps each frame with no input (0: it stops at once), and
        # whether the mouse turns the view a frame late, as a game reads input the frame after.
        self.coast = 0.0
        self.late_mouse = False
        self.mouse_due: str = ''
        # Floors to step down onto: (x from which, height); the pawn's height follows the floor under it.
        self.steps: list[tuple[float, float]] = []
        self.walls: list[Wall] = []
        # Degrees a second the body turns toward where it walks (0: it never turns, as a pawn that
        # turns with its controller doesn't).
        self.turn_rate = 0.0
        # The move action's dead zone, as the templates' mapping has one: a push below it moves
        # nothing, and what is above it is scaled back to 0..1.
        self.dead_zone = 0.0
        self.actions: dict[str, str] = {}
        self.keys: dict[str, str] = {}
        self.jumps = 0
        unreal.state['on_console'] = self.console

    def console(self, command: str) -> None:
        verb, _, rest = command.partition(' ')
        label, _, value = rest.partition(' ')
        table = self.actions if verb.endswith('action') else self.keys
        if verb.startswith('Input.+'):
            if label in ('IA_Jump', 'SpaceBar') and label not in table:
                self.jumps += 1
            table[label] = value
        elif verb.startswith('Input.-'):
            table.pop(label, None)

    def axes(self) -> tuple[float, float]:
        """(right, forward) the player asks for this frame."""
        found = AXIS.match(self.actions.get('IA_Move', ''))
        if found:
            right, forward = float(found[1]), float(found[2])
            push = math.hypot(right, forward)
            if push <= self.dead_zone:
                return 0.0, 0.0
            scale = (push - self.dead_zone) / (1.0 - self.dead_zone) / push
            return right * scale, forward * scale
        right = ('D' in self.keys) - ('A' in self.keys)
        forward = ('W' in self.keys) - ('S' in self.keys)
        length = math.hypot(right, forward) or 1.0
        return right / length, forward / length

    def step(self, dt: float) -> None:
        self.turn()
        if self.pawn.props.get('use_controller_rotation_yaw'):
            self.pawn.rotation = Rotator(0.0, 0.0, unreal.state['control_rotation'].yaw)
        right, forward = self.axes()
        yaw = math.radians(unreal.state['control_rotation'].yaw)
        dx = (math.cos(yaw) * forward - math.sin(yaw) * right) * self.speed * dt
        dy = (math.sin(yaw) * forward + math.cos(yaw) * right) * self.speed * dt
        if not right and not forward:
            dx, dy = self.pawn.velocity.x * self.coast * dt, self.pawn.velocity.y * self.coast * dt
        else:
            self.face_toward(math.degrees(math.atan2(dy, dx)), dt)
        at = self.pawn.location
        to = (at.x + dx, at.y + dy)
        jumping = 'IA_Jump' in self.actions or 'SpaceBar' in self.keys
        if any(w.holds(*to) and not (w.low and jumping) for w in self.walls):
            self.pawn.velocity = Vector()
            return
        self.pawn.location = Vector(to[0], to[1], self.height_at(to[0], at.z))
        self.pawn.velocity = Vector(dx / dt, dy / dt, 0)

    def face_toward(self, yaw: float, dt: float) -> None:
        have = self.pawn.rotation.yaw
        off = (yaw - have + 180.0) % 360.0 - 180.0
        turn = max(-self.turn_rate * dt, min(self.turn_rate * dt, off))
        self.pawn.rotation = Rotator(0.0, 0.0, have + turn)

    def height_at(self, x: float, z: float) -> float:
        """The pawn's height over the floor under x: the last step down it has passed."""
        for from_x, height in sorted(self.steps, reverse=True):
            if x >= from_x:
                return height + 100
        return z

    def turn(self) -> None:
        forced = self.keys.get('Mouse2D', '')
        if self.late_mouse:
            forced, self.mouse_due = self.mouse_due, forced
        found = AXIS.match(forced)
        if not found:
            return
        view = unreal.state['control_rotation']
        signed = (view.pitch + 180.0) % 360.0 - 180.0
        pitch = max(-89.0, min(89.0, signed + float(found[2]) * self.pitch_per_px))
        # Unreal hands a pitch below the horizon back as 270-360, never negative.
        unreal.state['control_rotation'] = Rotator(0.0, pitch % 360.0, view.yaw + float(found[1]) * self.yaw_per_px)


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexPlayTools, name)(*args))


class WalkCase(HelperCase):
    """A character at the origin on open ground, its controller facing +Y, the game's move and jump actions."""

    MOVE = True

    def setUp(self) -> None:
        super().setUp()
        self.clock = Clock()
        patcher = mock.patch.object(play, 'time', self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)
        self.addCleanup(self.end_play)
        unreal.state['pie'] = True
        unreal.state['floors'] = [unreal.Floor(0.0)]
        unreal.state['control_rotation'] = Rotator(0.0, 0.0, 90.0)
        self.hero = unreal.Character('BP_Hero_0', Vector(0, 0, 100))
        unreal.state['player'] = self.hero
        unreal.state['actors'] = [self.hero]
        actions = [('IA_Jump', unreal.InputActionValueType.BOOLEAN)]
        if self.MOVE:
            actions.append(('IA_Move', unreal.InputActionValueType.AXIS2D))
        for name, kind in actions:
            unreal.state['registry'].append(unreal.AssetData(f'/Game/Input/{name}', 'InputAction',
                                                             asset=unreal.InputAction(name, kind)))
        self.world = World(self.hero)

    def end_play(self) -> None:
        play.release_all()
        unreal.state['pie'] = False
        self.frame()

    def frame(self, dt: float = FRAME_S) -> None:
        """One frame: the game moves by the input forced last frame, then every post-tick callback runs."""
        unreal.state['game_seconds'] += dt
        self.clock.now += dt
        if unreal.state['pie']:
            self.world.step(dt)
        for callback in list(unreal.state['ticks'].values()):
            callback(dt)

    def until_done(self, report: str = 'walk', most: int = 2000) -> dict:
        for _ in range(most):
            state = tool('player_state')[report]
            if state['state'] not in ('walking', 'looking'):
                return state
            self.frame()
        self.fail(f'{report} never ended')

    def frames(self, count: int) -> None:
        for _ in range(count):
            self.frame()

    def at(self) -> tuple:
        return (self.hero.location.x, self.hero.location.y)


class OpenGround(WalkCase):
    def test_walks_straight_to_a_point_steering_the_move_action_in_the_controllers_frame(self) -> None:
        started = tool('walk_to', '1000,0,100')
        self.assertEqual((started['walking'], started['way']), (True, 'direct'))
        self.frame()
        right, forward = self.world.axes()
        self.assertLess(right, -0.9, "Unreal's Y points right: facing +Y, +X is on the left")
        self.assertLess(abs(forward), 0.1)
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertLessEqual(math.dist(self.at(), (1000, 0)), 120.0)
        self.assertNotIn('IA_Move', self.world.actions, 'the move action is let go on arrival')
        rotation = unreal.state['control_rotation']
        self.assertLessEqual(abs(walk_math.wrap(rotation.yaw)), walk.AHEAD_TOLERANCE + 2.0, 'it looked where it walked (east), not where it faced')
        self.assertLessEqual(abs(walk_math.wrap(rotation.pitch)), walk.AHEAD_TOLERANCE + 2.0, 'and level, not at the floor')

    def test_a_walk_looks_ahead_level_even_from_a_view_at_the_floor(self) -> None:
        unreal.state['control_rotation'] = Rotator(0.0, -80.0, 90.0)
        tool('walk_to', '1500,0,100')
        self.frames(60)
        rotation = unreal.state['control_rotation']
        self.assertLessEqual(abs(walk_math.wrap(rotation.pitch)), walk.AHEAD_TOLERANCE + 2.0, 'the view came up off the floor')
        self.assertLessEqual(abs(walk_math.wrap(rotation.yaw)), walk.AHEAD_TOLERANCE + 2.0, 'and turned to the way')

    def test_an_aim_while_walking_keeps_the_view(self) -> None:
        enemy = unreal.Actor('Enemy_1', Vector(0, 1200, 100))
        unreal.state['actors'].append(enemy)
        tool('walk_to', '1500,0,100')
        walk.look_at(enemy, walk.LOOK_TOLERANCE, 5.0, track=True)
        self.frames(60)
        self.assertGreater(unreal.state['control_rotation'].yaw, 60.0, 'the aim (north) wins over the way ahead (east)')

    def test_an_actor_is_found_by_label_and_followed_when_it_moves(self) -> None:
        door = unreal.Actor('BP_Door_2', Vector(800, 0, 100))
        unreal.state['actors'].append(door)
        tool('walk_to', 'door', 1.0)
        self.frames(20)
        door.location = Vector(800, 600, 100)
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertLessEqual(math.dist(self.at(), (800, 600)), 100.0)
        self.assertEqual(done['target'], 'BP_Door_2')

    def test_an_actor_is_walked_to_where_its_colliding_parts_are_not_where_an_editor_arrow_shows(self) -> None:
        turret = unreal.Actor('BP_Turret_1', Vector(800, 0, 100))
        turret.components = [unreal.CapsuleComponent(location=Vector(800, 0, 100)),
                             unreal.PrimitiveComponent('Arrow', Vector(0, 300, 100), collides=False)]
        unreal.state['actors'].append(turret)
        done = (tool('walk_to', 'turret', 1.0), self.until_done())[1]
        self.assertEqual(done['state'], 'arrived')
        self.assertLessEqual(math.dist(self.at(), (800, 0)), 100.0)

    def test_an_actor_with_nothing_that_collides_is_walked_to_its_bounds(self) -> None:
        sign = unreal.Actor('BP_Sign_1', Vector(0, 0, 100))
        sign.components = [unreal.SceneComponent('Text', Vector(600, 0, 100), collides=False)]
        unreal.state['actors'].append(sign)
        tool('walk_to', 'sign', 1.0)
        self.assertEqual(self.until_done()['state'], 'arrived')
        self.assertLessEqual(math.dist(self.at(), (600, 0)), 100.0)

    def test_an_unknown_target_is_an_error_naming_the_closest_labels(self) -> None:
        unreal.state['actors'].append(unreal.Actor('BP_Door_2', Vector(800, 0, 100)))
        answer = tool('walk_to', 'BP_Gate')
        self.assertIn('error', answer)
        self.assertIn('BP_Door_2', answer['error'])
        self.assertEqual(unreal.state['ticks'], {}, 'nothing starts for a target that is not there')

    def test_never_walks_off_a_drop(self) -> None:
        unreal.state['floors'] = [unreal.Floor(0.0, rect=(-500, -500, 300, 500))]
        tool('walk_to', '1000,0,100')
        done = self.until_done()
        self.assertEqual(done['state'], 'stopped')
        self.assertIn('drop', done['reason'])
        self.assertLess(self.hero.location.x, 300.0)

    def test_a_walk_that_takes_too_long_times_out(self) -> None:
        self.world.speed = 20.0
        tool('walk_to', '1000,0,100', 1.2, 2.0)
        done = self.until_done()
        self.assertEqual(done['state'], 'timed-out')
        self.assertNotIn('IA_Move', self.world.actions)

class Arriving(WalkCase):
    def test_arrives_only_once_the_pawn_has_stopped_within_reach_and_comes_back_after_a_slide(self) -> None:
        self.world.speed, self.world.coast = 900.0, 0.92
        tool('walk_to', '1000,0,100')
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertLess(math.hypot(self.hero.velocity.x, self.hero.velocity.y), walk.COAST_MIN_CM_S)
        self.assertLessEqual(math.dist(self.at(), (1000, 0)), 120.0, 'stopped within reach, not slid past it')

    def test_steps_down_a_floor_a_player_would_drop_to_and_stops_at_a_deeper_one(self) -> None:
        unreal.state['floors'] = [unreal.Floor(0.0, rect=(-500, -500, 400, 500)),
                                  unreal.Floor(-250.0, rect=(400, -500, 3000, 500))]
        self.world.steps = [(400.0, -250.0)]
        tool('walk_to', '1000,0,-150')
        self.assertEqual(self.until_done()['state'], 'arrived', 'a 2.5 m drop is walked down')
        unreal.state['floors'] = [unreal.Floor(-250.0, rect=(-500, -500, 1400, 500)),
                                  unreal.Floor(-800.0, rect=(1400, -500, 3000, 500))]
        tool('walk_to', '2500,0,-700')
        done = self.until_done()
        self.assertEqual(done['state'], 'stopped')
        self.assertLess(self.hero.location.x, 1400.0)

    def test_an_actor_at_the_foot_of_a_ledge_is_reached_by_dropping_down_not_from_above(self) -> None:
        unreal.state['floors'] = [unreal.Floor(0.0, rect=(-500, -500, 400, 500)),
                                  unreal.Floor(-200.0, rect=(400, -500, 3000, 500))]
        self.world.steps = [(400.0, -200.0)]
        turret = unreal.Actor('BP_Turret_1', Vector(470, 0, -112))
        turret.components = [unreal.CapsuleComponent(location=Vector(470, 0, -112))]
        unreal.state['actors'].append(turret)
        tool('walk_to', 'turret')
        self.assertEqual(self.until_done()['state'], 'arrived')
        self.assertEqual(self.hero.location.z, -100.0, 'it stands beside the turret, on its floor')

    def test_a_tall_actor_rising_through_the_players_floor_is_reached_from_it(self) -> None:
        tree = unreal.Actor('BP_Tree_1', Vector(800, 0, 400))
        tree.components = [unreal.CapsuleComponent(location=Vector(800, 0, 400), half_height=450.0, radius=60.0)]
        unreal.state['actors'].append(tree)
        tool('walk_to', 'tree', 1.5)
        self.assertEqual(self.until_done()['state'], 'arrived')


class Facing(WalkCase):
    """A character that turns where it walks, its body facing +X, beside a turret on its left."""

    def setUp(self) -> None:
        super().setUp()
        self.world.turn_rate = 540.0
        self.turret = unreal.Actor('BP_Turret_1', Vector(0, 100, 100))
        unreal.state['actors'].append(self.turret)
        self.world.walls.append(Wall((-40, 60, 40, 140), label='BP_Turret_1'))

    def body_off(self, x: float, y: float) -> float:
        want = math.degrees(math.atan2(y - self.hero.location.y, x - self.hero.location.x))
        return abs((want - self.hero.rotation.yaw + 180.0) % 360.0 - 180.0)

    def test_an_actor_already_within_reach_is_faced_before_the_walk_arrives(self) -> None:
        tool('walk_to', 'turret')
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertLessEqual(done['facingDeg'], walk.FACE_DEG)
        self.assertLessEqual(self.body_off(0, 100), walk.FACE_DEG, 'its swing now reaches the turret')
        self.assertLessEqual(math.dist(self.at(), (0, 0)), 60.0, 'facing is a turn, not another walk')
        self.assertNotIn('IA_Move', self.world.actions)

    def test_faces_through_the_move_actions_dead_zone(self) -> None:
        self.world.dead_zone = 0.25
        tool('walk_to', 'turret')
        done = self.until_done()
        self.assertLessEqual(done['facingDeg'], walk.FACE_DEG)
        self.assertLessEqual(math.dist(self.at(), (0, 0)), 60.0)

    def test_a_target_it_stands_on_is_not_faced(self) -> None:
        self.world.walls = []
        self.world.turn_rate = 0.0
        self.turret.location = Vector(10, 0, 100)
        tool('walk_to', 'turret')
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertLessEqual(math.dist(self.at(), (0, 0)), 20.0, 'no push across what it stands on')

    def test_a_point_is_never_faced(self) -> None:
        tool('walk_to', '0,100,100')
        done = self.until_done()
        self.assertEqual((done['state'], done['facingDeg']), ('arrived', None))
        self.assertEqual(self.hero.rotation.yaw, 0.0)

    def test_a_pawn_turned_by_its_view_faces_by_turning_the_view_not_by_a_push(self) -> None:
        self.world.turn_rate = 0.0
        self.hero.props['use_controller_rotation_yaw'] = True
        unreal.state['control_rotation'] = Rotator(0.0, 0.0, 0.0)
        tool('walk_to', 'turret')
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertLessEqual(done['facingDeg'], walk.FACE_DEG)
        self.assertLessEqual(self.body_off(0, 100), walk.FACE_DEG)
        self.assertEqual(self.at(), (0, 0), 'no push it could never turn by')

    def test_a_body_that_never_turns_ends_the_facing_on_time(self) -> None:
        self.world.turn_rate = 0.0
        tool('walk_to', 'turret')
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertGreater(done['facingDeg'], walk.FACE_DEG)
        self.assertLessEqual(done['gameSeconds'], walk.FACE_S + 2 * FRAME_S)


class NavMesh(WalkCase):
    def test_follows_the_nav_mesh_around_a_wall_the_straight_line_would_hit(self) -> None:
        self.world.walls.append(Wall((400, -300, 500, 300)))
        unreal.state['nav_path'] = unreal.NavigationPath(
            [Vector(0, 0, 100), Vector(0, 450, 100), Vector(1000, 450, 100), Vector(1000, 0, 100)])
        started = tool('walk_to', '1000,0,100')
        self.assertEqual(started['way'], 'navmesh')
        done = self.until_done()
        self.assertEqual((done['state'], done['way']), ('arrived', 'navmesh'))
        self.assertEqual(done['tried'], [], 'no recovery needed along the nav mesh')
        self.assertTrue(unreal.state['nav_queries'])


class DeadZone(WalkCase):
    def test_arrives_through_the_move_actions_dead_zone_without_stalling_short(self) -> None:
        self.world.dead_zone = 0.25
        tool('walk_to', '1000,0,100', 0.5)
        done = self.until_done()
        self.assertEqual((done['state'], done['tried']), ('arrived', []))
        self.assertLessEqual(math.dist(self.at(), (1000, 0)), 50.0)


class Stuck(WalkCase):
    def test_jumps_over_a_low_obstacle(self) -> None:
        self.world.walls.append(Wall((400, -2000, 450, 2000), low=True))
        tool('walk_to', '1000,0,100')
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertEqual(done['tried'], ['jump'])
        self.assertGreaterEqual(self.world.jumps, 1)

    def test_tries_jump_side_steps_and_a_new_way_before_saying_it_is_stuck(self) -> None:
        self.world.walls.append(Wall((400, -5000, 450, 5000)))
        tool('walk_to', '1000,0,100')
        done = self.until_done()
        self.assertEqual(done['state'], 'stuck')
        self.assertEqual(done['tried'], ['jump', 'left', 'right', 'replan'])
        self.assertGreater(done['distanceM'], 4.0)
        self.assertNotIn('IA_Move', self.world.actions)


class Keys(WalkCase):
    MOVE = False

    def test_a_game_without_a_move_action_is_walked_with_w_a_s_d(self) -> None:
        tool('walk_to', '0,1000,100')
        self.frame()
        self.assertIn('W', self.world.keys, 'the target is straight ahead of the controller')
        done = self.until_done()
        self.assertEqual(done['state'], 'arrived')
        self.assertFalse(set(self.world.keys) & {'W', 'A', 'S', 'D'}, 'every key let go')


class LookAt(WalkCase):
    def test_turns_the_view_onto_a_target_measuring_what_each_frame_turned(self) -> None:
        unreal.state['actors'].append(unreal.Actor('BP_Enemy_1', Vector(1000, 0, 300)))
        tool('look_at', 'enemy')
        done = self.until_done('look')
        self.assertEqual(done['state'], 'looked')
        view = unreal.state['control_rotation']
        eye = (0, 0, 100 + walk.EYE_CM)
        want_pitch = math.degrees(math.atan2(300 - eye[2], 1000))
        self.assertLess(abs(view.yaw - 0.0), 2.5)
        self.assertLess(abs(view.pitch - want_pitch), 2.5)
        self.frames(3)
        self.assertNotIn('Mouse2D', self.world.keys, 'the mouse is let go once the view is on it')

    def test_converges_when_the_view_answers_a_frame_late_and_pitch_wraps_below_the_horizon(self) -> None:
        self.world.late_mouse = True
        unreal.state['actors'].append(unreal.Actor('BP_Pit_1', Vector(1000, 600, -400)))
        tool('look_at', 'pit')
        done = self.until_done('look')
        self.assertEqual(done['state'], 'looked', done)
        view = unreal.state['control_rotation']
        eye = (0, 0, 100 + walk.EYE_CM)
        want_yaw = math.degrees(math.atan2(600, 1000))
        want_pitch = math.degrees(math.atan2(-400 - eye[2], math.hypot(1000, 600)))
        self.assertLess(abs(view.yaw - want_yaw), 2.5)
        self.assertLess(abs(((view.pitch + 180) % 360 - 180) - want_pitch), 2.5)

    def test_turns_fast_with_a_mouse_that_turns_little_per_pixel(self) -> None:
        self.world.yaw_per_px, self.world.pitch_per_px = 0.03, -0.03
        tool('look_at', '0,-1000,100')
        done = self.until_done('look')
        self.assertEqual(done['state'], 'looked', done)
        self.assertLess(done['gameSeconds'], 1.5, 'a half turn takes well under its time')

    def test_says_at_once_when_the_view_does_not_turn(self) -> None:
        self.world.yaw_per_px = self.world.pitch_per_px = 0.0
        tool('look_at', '1000,0,100')
        done = self.until_done('look', most=40)
        self.assertEqual(done['state'], 'failed')
        self.assertIn("doesn't turn", done['reason'])


if __name__ == '__main__':
    unittest.main()
