"""A play shot with the game's on-screen UI is cut from a shot of the editor's window: the play view
is found there once by matching a small scene shot taken at its own framing, then every shot is cut
there and drawn at the asked width. A window shot the editor's own viewport took instead is taken
again; when no window shot comes, the 3D frame alone is taken, so the shot asked for always comes."""

import os
import re
from unittest import mock

import unreal

from genex_loop import capture
from genex_play import play, screen, screen_math

from support import HelperCase

WINDOW = (1728, 1084)
VIEW = (1372, 909)
# The play view's place in the window: off the search's grid, as an editor's panels put it.
AT = (6, 141)
CHROME = (30, 30, 34)
FILENAME = re.compile(r'filename="?([^"\s]+)"?')
FRAME_S = 0.05


def scene_pixel(x: int, y: int) -> tuple:
    """The 3D frame: blocks of shade, so no two places look alike."""
    bx, by = x // 23, y // 19
    return (bx * 53 % 256, by * 97 % 256, (bx * 7 + by * 13) * 31 % 256)


def window_pixel(x: int, y: int) -> tuple:
    """The editor: dark panels round the play view, and a white HUD panel over part of the view."""
    vx, vy = x - AT[0], y - AT[1]
    if not (0 <= vx < VIEW[0] and 0 <= vy < VIEW[1]):
        return CHROME
    if 300 <= vx < 1000 and 200 <= vy < 600:
        return (250, 250, 250)
    return scene_pixel(vx, vy)


class Clock:
    def __init__(self) -> None:
        self.now = 1000.0

    def monotonic(self) -> float:
        return self.now


class ScreenCase(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        self.clock = Clock()
        for module in (play, screen):
            patcher = mock.patch.object(module, 'time', self.clock)
            patcher.start()
            self.addCleanup(patcher.stop)
        hero = unreal.Character('BP_Hero_0', unreal.Vector(0, 0, 90))
        unreal.state.update(pie=True, viewport_size=VIEW, on_console=self.console, player=hero, actors=[hero])
        screen.forget()
        self.addCleanup(screen.forget)
        self.addCleanup(play.release_all)
        # How many window shots the editor's own viewport takes before the play view's window does,
        # and whether a window shot comes at all.
        self.viewport_first = 0
        self.windows_come = True
        self.fell_back: list[str] = []
        self.file = os.path.join(self.path('game', 'unreal', 'Saved', 'Genex', 'captures'), 'look.png')

    def console(self, command: str) -> None:
        found = FILENAME.search(command)
        file = found[1] if found else ''
        if command.startswith('HighResShot'):
            width, height = (int(n) for n in command.split()[1].split('x'))
            self.picture(file, unreal.Picture(width, height, lambda x, y: scene_pixel(
                x * VIEW[0] // width, y * VIEW[1] // height)))
        elif command.startswith('Shot showui') and self.windows_come:
            if self.viewport_first:
                self.viewport_first -= 1
                self.picture(file, unreal.Picture(*VIEW, lambda x, y: CHROME))
            else:
                self.picture(file, unreal.Picture(*WINDOW, window_pixel))

    def picture(self, file: str, picture) -> None:
        unreal.state['pictures'][file] = picture
        with open(file, 'wb') as out:
            out.write(b'picture')

    def take(self) -> dict:
        return screen.take(self.file, 1280, self.fell_back.append)

    def frames(self, count: int = 200) -> None:
        for _ in range(count):
            self.clock.now += FRAME_S
            for callback in list(unreal.state['ticks'].values()):
                callback(FRAME_S)
            if not screen._job:
                return

    def exports(self) -> list:
        return [call for call in unreal.calls if call[0] == 'export_render_target']

    def commands(self, start: str) -> list[str]:
        return [call[1][1] for call in unreal.calls if call[0] == 'console' and call[1][1].startswith(start)]


class Finding(ScreenCase):
    def test_the_shot_is_the_play_view_cut_from_the_window_with_its_ui_at_the_asked_width(self) -> None:
        self.assertEqual(self.take(), {'queued': True, 'file': self.file, 'ui': True})
        self.frames()
        x, y = screen._found['at']
        self.assertLessEqual(abs(x - AT[0]) + abs(y - AT[1]), screen.FINE, 'found where the play view is')
        [(_call, name, uv, uv_size, width, height)] = self.exports()
        self.assertNotEqual(name, 'look.png', 'exported beside the shot, then moved over it whole')
        self.assertFalse(os.path.exists(os.path.join(os.path.dirname(self.file), name)))
        self.assertEqual(width, 1280)
        self.assertAlmostEqual(height, 1280 * (VIEW[1] - 2 * screen.INSET) / (VIEW[0] - 2 * screen.INSET), delta=1)
        left, top = uv[0] * WINDOW[0], uv[1] * WINDOW[1]
        right, bottom = left + uv_size[0] * WINDOW[0], top + uv_size[1] * WINDOW[1]
        self.assertGreaterEqual(left, AT[0], 'no editor panel in the cut')
        self.assertGreaterEqual(top, AT[1])
        self.assertLessEqual(right, AT[0] + VIEW[0])
        self.assertLessEqual(bottom, AT[1] + VIEW[1])
        self.assertTrue(os.path.exists(self.file))
        self.assertEqual(self.fell_back, [])

    def test_a_second_shot_is_cut_where_the_first_found_the_view_without_another_scene_shot(self) -> None:
        self.take()
        self.frames()
        self.take()
        self.frames()
        self.assertEqual(len(self.commands('HighResShot')), 1)
        self.assertEqual(len(self.exports()), 2)

    def test_a_view_of_another_size_is_found_again(self) -> None:
        self.take()
        self.frames()
        unreal.state['viewport_size'] = (VIEW[0] - 40, VIEW[1] - 30)
        self.take()
        self.frames()
        self.assertEqual(len(self.commands('HighResShot')), 2)


class Retaking(ScreenCase):
    def test_a_window_shot_the_editors_viewport_took_is_taken_again(self) -> None:
        self.viewport_first = 1
        self.take()
        self.frames()
        self.assertEqual(len(self.commands('Shot showui')), 2)
        self.assertEqual((len(self.exports()), self.fell_back), (1, []))

    def test_the_3d_frame_alone_comes_when_every_window_shot_is_a_viewport(self) -> None:
        self.viewport_first = 99
        self.take()
        self.frames()
        self.assertEqual(len(self.commands('Shot showui')), screen.WINDOW_TRIES)
        self.assertEqual((self.exports(), self.fell_back), ([], [self.file]))

    def test_the_3d_frame_alone_comes_when_no_window_shot_comes(self) -> None:
        self.windows_come = False
        self.take()
        self.frames()
        self.assertEqual((self.exports(), self.fell_back), ([], [self.file]))
        self.assertIn('took too long', screen._found['fellBack'])


class CapturePlay(ScreenCase):
    def test_capture_play_with_ui_takes_the_ui_shot_and_without_it_the_3d_frame(self) -> None:
        self.assertEqual(self.call('capture_play', 'look', 1280, 720, True)['ui'], True)
        self.frames()
        self.assertEqual(len(self.exports()), 1)
        unreal.calls.clear()
        self.assertEqual(self.call('capture_play', 'look', 1280, 720, False)['ui'], False)
        self.assertEqual(self.commands('Shot showui'), [])
        self.assertEqual(len(self.commands('HighResShot')), 1)


class Search(ScreenCase):
    def test_the_search_finds_a_scene_under_a_ui_panel_and_skips_places_off_the_window(self) -> None:
        window = [window_pixel(x * 4, y * 4) for y in range(WINDOW[1] // 4) for x in range(WINDOW[0] // 4)]
        scene = [scene_pixel(x * 4, y * 4) for y in range(VIEW[1] // 4) for x in range(VIEW[0] // 4)]
        place, gap = screen_math.best_place(window, (WINDOW[0] // 4, WINDOW[1] // 4), scene,
                                            (VIEW[0] // 4, VIEW[1] // 4), range(-5, 200), range(-5, 200))
        self.assertLessEqual(abs(place[0] * 4 - AT[0]) + abs(place[1] * 4 - AT[1]), 8)
        self.assertLess(gap, 60.0)
        self.assertEqual(list(screen_math.around(10, 2)), [8, 9, 10, 11, 12])
        self.assertEqual(screen_math.sample_points(50, 40), screen_math.sample_points(50, 40), 'the same points every try')
