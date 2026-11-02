"""player_state names what is near the player: the nearest of the game's own actors that have
something to see or touch, each with its distance and its bearing from where the view faces, so an
agent can walk to a stone or a turret by name without searching the level for it first."""

import json
import unittest

import unreal
from unreal import Rotator, Vector

from genex_play import near
from genex_play.tools import GenexPlayTools

from support import HelperCase


class GameActor(unreal.Actor):
    """An actor of the game's own class, with a body."""

    def __init__(self, label: str, location: Vector, path: str = '/Script/TP_ThirdPerson.GamePickup') -> None:
        super().__init__(label, location)
        self.path = path
        self.components = [unreal.CapsuleComponent(location=location)]

    def get_class(self):
        return unreal.Class(type(self), path=self.path)


def state() -> dict:
    return json.loads(GenexPlayTools.player_state())


class Near(HelperCase):
    def setUp(self) -> None:
        super().setUp()
        unreal.state['pie'] = True
        unreal.state['control_rotation'] = Rotator(0.0, 0.0, 90.0)
        self.hero = unreal.Character('BP_Hero_0', Vector(0, 0, 100))
        unreal.state['player'] = self.hero
        unreal.state['actors'] = [self.hero]

    def add(self, *actors) -> None:
        unreal.state['actors'].extend(actors)

    def test_names_the_nearest_game_actors_with_distance_and_bearing_from_the_view(self) -> None:
        self.add(GameActor('Coin_1', Vector(0, 380, 100)), GameActor('Crate_1', Vector(500, 0, 100)),
                 GameActor('Turret_1', Vector(-1500, 600, 100), path='/Script/TP_ThirdPerson.SentryTurret'))
        self.assertEqual(state()['near'], ['Coin_1: 3.8 m ahead', 'Crate_1: 5.0 m, 90° left', 'Turret_1: 16.2 m, 68° right'])

    def test_leaves_out_level_geometry_bodiless_actors_and_far_ones_and_keeps_the_nearest_few(self) -> None:
        wall = unreal.Actor('SM_Wall', Vector(100, 0, 100))
        wall.components = [unreal.StaticMeshComponent(location=Vector(100, 0, 100))]
        director = GameActor('GameDirector', Vector(0, 50, 100), path='/Script/TP_ThirdPerson.GameDirector')
        director.components = []
        far = GameActor('Coin_9', Vector(0, near.NEAR_M * 100 + 100, 100))
        crowd = [GameActor(f'Coin_{n}', Vector(0, 200 + n * 10, 100)) for n in range(near.NEAR_COUNT + 2)]
        self.add(wall, director, far, *crowd)
        names = [line.split(':')[0] for line in state()['near']]
        self.assertEqual(names, [f'Coin_{n}' for n in range(near.NEAR_COUNT)])

    def test_nothing_near_is_an_empty_list(self) -> None:
        self.assertEqual(state()['near'], [])


if __name__ == '__main__':
    unittest.main()
