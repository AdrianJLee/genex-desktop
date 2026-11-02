"""The play's bug detectors look at the player's pawn and the frame time every editor frame, from
the first player_state read until the play ends. Each kind of finding is told on its 1st, 10th, 100th
and 1000th time, so a fault that repeats every frame is told without flooding, and player_state
hands over what was told since the computer last took them, even when the pawn it describes is gone:
a plain read only peeks, so the plugin's own polling during a walk loses nothing."""

import json
import math
import unittest
from unittest import mock

import unreal
from unreal import Vector

from genex_play import detect, play
from genex_play.tools import GenexPlayTools

from support import HelperCase

FRAME_S = 0.016


class Clock:
    """The wall clock the play tools read (time.monotonic), moved by the test."""

    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now


def player_state(take: bool = True) -> dict:
    """The state as the computer reads it (taking the findings), or as any other caller does (peeking)."""
    return json.loads(GenexPlayTools.player_state(take))


class DetectCase(HelperCase):
    """A play session whose player is a character standing at the origin."""

    def setUp(self) -> None:
        super().setUp()
        self.clock = Clock()
        patcher = mock.patch.object(play, 'time', self.clock)
        patcher.start()
        self.addCleanup(patcher.stop)
        unreal.state['pie'] = True
        self.hero = self.spawn()
        self.addCleanup(self.end_play)
        self.assertEqual(player_state()['findings'], [], 'reading the state starts the detectors, with nothing told')

    def spawn(self, at: Vector | None = None) -> unreal.Character:
        hero = unreal.Character('BP_Hero_0', at or Vector(0, 0, 100))
        unreal.state['player'] = hero
        unreal.state['actors'] = [hero]
        return hero

    def end_play(self) -> None:
        """The play ends: the next frame finds no game world, and every tick stops."""
        unreal.state['pie'] = False
        self.frame(0.0, 0.0)

    def frame(self, game: float = FRAME_S, wall: float = FRAME_S) -> None:
        unreal.state['game_seconds'] += game
        unreal.state['world_delta'] = game
        self.clock.now += wall
        for callback in list(unreal.state['ticks'].values()):
            callback(wall)

    def frames(self, count: int, game: float = FRAME_S, wall: float = FRAME_S) -> None:
        for _ in range(count):
            self.frame(game, wall)

    def codes(self) -> list[str]:
        return [finding['code'] for finding in player_state()['findings']]


class NotANumber(DetectCase):
    def test_a_position_that_is_not_a_number_is_told_on_its_first_and_tenth_frame(self) -> None:
        self.hero.location = Vector(math.nan, 0, 100)
        self.frames(9)
        state = player_state()
        self.assertIn('error', state, 'a position that is not a number has no state to round')
        self.assertEqual([(f['code'], f['count']) for f in state['findings']], [('nan', 1)])
        self.frame()
        self.assertEqual([(f['code'], f['count']) for f in player_state()['findings']], [('nan', 10)])
        self.frame()
        self.assertEqual(player_state()['findings'], [], 'told once, handed over once')


class Peeking(DetectCase):
    def test_a_plain_read_peeks_and_only_the_computers_read_takes(self) -> None:
        self.frame()
        unreal.state['player'] = None
        self.frame()
        self.assertEqual([f['code'] for f in player_state(take=False)['findings']], ['player-gone'])
        self.assertEqual([f['code'] for f in player_state(take=False)['findings']], ['player-gone'],
                         "the plugin's own polls leave it for the computer")
        self.assertEqual([f['code'] for f in player_state()['findings']], ['player-gone'])
        self.assertEqual(player_state(take=False)['findings'], [], 'taken once')


class PlayerGone(DetectCase):
    def test_a_pawn_that_vanishes_is_told_and_the_state_still_hands_it_over(self) -> None:
        self.frame()
        unreal.state['player'] = None
        self.frames(3)
        state = player_state()
        self.assertIn('error', state)
        self.assertEqual([f['code'] for f in state['findings']], ['player-gone'])

    def test_a_new_pawn_far_away_is_a_respawn_not_a_teleport(self) -> None:
        self.frame()
        self.spawn(Vector(90_000, 0, 100))
        self.frame()
        self.assertEqual(self.codes(), [])


class LongFall(DetectCase):
    def test_a_fall_that_never_lands_is_told_once_after_eight_game_seconds(self) -> None:
        self.hero.velocity = Vector(0, 0, -1200)
        self.frames(79, game=0.1, wall=0.1)
        self.assertEqual(self.codes(), [], 'falling for 7.9 game seconds')
        self.frames(3, game=0.1, wall=0.1)
        self.assertEqual(self.codes(), ['long-fall'])
        self.frames(50, game=0.1, wall=0.1)
        self.assertEqual(self.codes(), [], 'one fall, told once')

    def test_a_fall_that_lands_is_not_a_finding(self) -> None:
        self.hero.velocity = Vector(0, 0, -1200)
        self.frames(50, game=0.1, wall=0.1)
        self.hero.velocity = Vector()
        self.frame()
        self.hero.velocity = Vector(0, 0, -1200)
        self.frames(50, game=0.1, wall=0.1)
        self.assertEqual(self.codes(), [])


class Hitch(DetectCase):
    def test_a_frame_that_freezes_is_told_after_the_first_seconds_unless_a_shot_froze_it(self) -> None:
        self.frame(wall=1.2)
        self.assertEqual(self.codes(), [], 'the first game seconds load the level')
        self.frames(200)
        play.note_shot()
        self.frame(wall=1.2)
        self.assertEqual(self.codes(), [], 'a shot freezes the frame that renders it')
        self.frame(wall=1.2)
        findings = player_state()['findings']
        self.assertEqual([f['code'] for f in findings], ['hitch'])
        self.assertIn('1.2 s', findings[0]['detail'])


class Teleport(DetectCase):
    def test_a_jump_across_the_level_in_one_frame_is_told_and_a_step_is_not(self) -> None:
        self.frame()
        self.hero.location = Vector(100, 0, 100)
        self.frame()
        self.assertEqual(self.codes(), [])
        self.hero.location = Vector(3100, 0, 100)
        self.frame()
        findings = player_state()['findings']
        self.assertEqual([f['code'] for f in findings], ['teleport'])
        self.assertIn('30 m', findings[0]['detail'])


class Lifetime(DetectCase):
    def test_detection_ends_with_the_play_and_starts_only_while_one_runs(self) -> None:
        self.assertTrue(unreal.state['ticks'], 'watching while the play runs')
        self.end_play()
        self.assertEqual(unreal.state['ticks'], {}, 'no tick outlives the play')
        self.assertEqual(player_state()['findings'], [], 'no play: nothing to detect, nothing started')
        self.assertEqual(unreal.state['ticks'], {})

    def test_every_finding_carries_its_code_detail_game_time_and_count(self) -> None:
        unreal.state['game_seconds'] = 41.0
        self.frame()
        unreal.state['player'] = None
        self.frame()
        (finding,) = player_state()['findings']
        self.assertEqual(sorted(finding), ['code', 'count', 'detail', 'gameSeconds'])
        self.assertIn(finding['code'], detect.CODES)
        self.assertAlmostEqual(finding['gameSeconds'], 41.0, places=1)


if __name__ == '__main__':
    unittest.main()


class Frames(DetectCase):
    """A stretch (a pilot's run) keeps its findings, and the first of each kind in it comes with a frame of the play view."""

    def jump(self, x: float) -> None:
        self.hero.location = Vector(x, 0, 100)
        self.frame()

    def test_the_first_finding_of_a_kind_in_a_stretch_has_a_frame_and_its_repeats_do_not(self) -> None:
        self.frame()
        mark = detect.mark()
        for i in range(10):
            self.jump(3000.0 * (i + 1))
        found = detect.since(mark)
        self.assertEqual([(f['code'], f['count']) for f in found], [('teleport', 1), ('teleport', 10)])
        self.assertTrue(found[0]['frame'].startswith('finding-teleport-'))
        self.assertNotIn('frame', found[1], 'one frame per kind in a stretch')
        self.assertTrue(any(c[0] == 'console' and 'HighResShot' in str(c[1][1]) for c in unreal.calls), 'the frame was asked of the play view')
        again = detect.mark()
        self.assertEqual(detect.since(again), [], 'a new stretch starts empty')

    def test_frames_stop_at_the_cap(self) -> None:
        self.frame()
        detect.mark()
        for n in range(detect.MAX_FRAMES + 3):
            detect._note(f'kind-{n}', 'made up', 1.0)
        framed = [f for f in detect.since(0) if 'frame' in f]
        self.assertEqual(len(framed), detect.MAX_FRAMES)


class Stretches(DetectCase):
    def test_a_kind_the_play_told_already_is_still_in_the_next_stretch_with_its_frame(self) -> None:
        self.frame()
        detect.mark()
        detect._note('hitch', 'a frame took 0.9 s', 1.0)
        later = detect.mark()
        detect._note('hitch', 'a frame took 0.8 s', 2.0)
        detect._note('hitch', 'a frame took 0.8 s', 3.0)
        found = detect.since(later)
        self.assertEqual([(f['code'], f['count']) for f in found], [('hitch', 2)], 'the first of its kind in this stretch, once')
        self.assertIn('frame', found[0])
        self.assertEqual([f['count'] for f in player_state()['findings']], [1], 'the computer is told on the 1st, 10th... as before')
