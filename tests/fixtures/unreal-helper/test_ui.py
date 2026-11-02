"""A tester reads the game's own on-screen interface (UMG) as text, exactly, and presses its buttons by their
text: what is on screen in the user widgets shown, never a hidden panel or a widget off screen."""

import json
import unittest

import unreal

from genex_play.tools import GenexPlayTools

from support import HelperCase


def tool(name: str, *args) -> dict:
    return json.loads(getattr(GenexPlayTools, name)(*args))


class GameUi(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        unreal.state['pie'] = True
        unreal.state['widgets'] = []
        hud = unreal.UserWidget('WBP_Hud')
        unreal.TextBlock('Status', 'Hunger: 99', owner=hud)
        menu = unreal.UserWidget('WBP_Menu')
        panel = unreal.Widget('Panel', owner=menu)
        self.start = unreal.Button('StartButton', owner=menu, parent=panel)
        unreal.TextBlock('StartLabel', 'Start game', owner=menu, parent=self.start)
        self.locked = unreal.Button('LockedButton', owner=menu, parent=panel, enabled=False)
        unreal.TextBlock('LockedLabel', 'Continue', owner=menu, parent=self.locked)
        hidden = unreal.Widget('HiddenPanel', owner=menu, visible=False)
        unreal.TextBlock('Secret', 'Debug menu', owner=menu, parent=hidden)
        closed = unreal.UserWidget('WBP_Shop', in_viewport=False)
        unreal.TextBlock('Price', 'Price 10', owner=closed)

    def test_lists_the_visible_text_and_buttons_of_the_widgets_on_screen(self) -> None:
        listed = tool('ui_widgets')['widgets']
        texts = {w['text'] for w in listed if w['text']}
        self.assertEqual(texts, {'Hunger: 99', 'Start game', 'Continue'})
        self.assertEqual(sorted(w['name'] for w in listed if w['button']), ['LockedButton', 'StartButton'])

    def test_presses_a_button_by_its_label_and_refuses_a_disabled_or_missing_one(self) -> None:
        self.assertEqual(tool('ui_press', 'start game'), {'pressed': 'Start game', 'name': 'StartButton'})
        self.assertEqual(self.start.on_clicked.count, 1)
        self.assertIn('not enabled', tool('ui_press', 'Continue')['error'])
        self.assertEqual(self.locked.on_clicked.count, 0)
        missing = tool('ui_press', 'Debug menu')['error']
        self.assertIn('No visible button', missing)


if __name__ == '__main__':
    unittest.main()
