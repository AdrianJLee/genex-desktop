"""While an agent plays, the rendering is lighter (half resolution, lower shadows, lighting and effects)
so a heavy game plays at a usable frame rate; every value is put back exactly when the play ends."""

import json
import unittest

import unreal

from genex_play import light
from genex_play.tools import GenexPlayTools

from support import HelperCase


def tool(*args) -> dict:
    return json.loads(GenexPlayTools.light_play(*args))


class LightPlay(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        light._kept.clear()
        unreal.state['cvars'].update({'r.ScreenPercentage': 100, 'sg.ShadowQuality': 3, 'sg.EffectsQuality': 0})
        self.addCleanup(light._kept.clear)

    def commands(self) -> list:
        return [call[1][1] if len(call[1]) > 1 else call[1][0] for call in unreal.calls if call[0] == 'console']

    def test_lowers_what_is_higher_and_puts_back_exactly_what_it_was(self) -> None:
        tool(True)
        self.assertIn('r.ScreenPercentage 50', self.commands())
        self.assertIn('sg.ShadowQuality 1', self.commands())
        self.assertNotIn('sg.EffectsQuality 1', self.commands(), 'a setting already lower is left alone')
        unreal.calls.clear()
        self.assertEqual(tool(False)['restored']['sg.ShadowQuality'], 3)
        self.assertIn('r.ScreenPercentage 100', self.commands())
        self.assertIn('sg.ShadowQuality 3', self.commands())

    def test_turning_it_on_twice_keeps_the_first_values(self) -> None:
        tool(True)
        unreal.state['cvars']['r.ScreenPercentage'] = 50  # what the first call set
        tool(True)
        self.assertEqual(tool(False)['restored']['r.ScreenPercentage'], 100)


if __name__ == '__main__':
    unittest.main()
