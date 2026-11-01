"""Genex's starter pilot: plays any level for a first look, while the play's detectors watch for what
breaks. It walks to places around the level, goes to the characters it hasn't met, and shoots at a
character in sight (left mouse, sights on the right). Genex put it in this game's pilots/ because the
folder had none; run it first (the computer tool's pilot verb), then copy it into a pilot of this game's
own: its controls, its goal, its stages.
"""
import random

import unreal

from genex_play import play
from genex_play.pilot_kit import Move, Outcome, Pilot

# Places nearer than this are not worth a walk; a walk or a shot gives up after its seconds.
FAR_M = 8.0
SHOOT_WITHIN_M = 35.0
WALK_S = 8.0
SHOOT_S = 2.0
# How many places the pilot keeps to walk to, picked once from the level's actors that the player can walk to
# (a full path on the nav mesh, about the player's height); at most PROBED are tried.
PLACES_KEPT = 60
PROBED = 150
LEVEL_CM = 250.0


class Explore(Pilot):
    goal = 'Explore the level, meet its characters and see what breaks'
    decide_hz = 3.0
    look_hz = 6.0
    stall_seconds = 0
    stage_seconds = 0

    def setup(self, game):
        me = game.pawn()
        world, at = play.game_world(), me.get_actor_location()
        kinds = (unreal.PlayerStart, unreal.TargetPoint, unreal.StaticMeshActor)
        places = [a for kind in kinds for a in unreal.GameplayStatics.get_all_actors_of_class(world, kind)]
        random.shuffle(places)
        self.places = [p for p in places[:PROBED] if self.reachable(world, at, p)][:PLACES_KEPT]
        self.met = set()

    def reachable(self, world, at, place):
        goal = place.get_actor_location()
        if abs(float(goal.z) - float(at.z)) > LEVEL_CM:
            return False
        path = unreal.NavigationSystemV1.find_path_to_location_synchronously(world, at, goal)
        return path is not None and path.is_valid() and not path.is_partial()

    def look(self, game):
        try:
            me = game.pawn()
        except RuntimeError:
            return {'alive': False}
        others = [a for a in unreal.GameplayStatics.get_all_actors_of_class(play.game_world(), unreal.Character) if a != me]
        seen = [a for a in others if game.visible(a)]
        target = min(seen, key=game.distance) if seen else None
        unmet = [a for a in others if a.get_name() not in self.met]
        stranger = min(unmet, key=game.distance) if unmet else None
        place = next((p for p in self.places if (game.distance(p) or 0) > FAR_M), None)
        return {'alive': True, 'characters': len(others), 'in_sight': len(seen),
                'target_m': game.distance(target) if target else None,
                'stranger_m': game.distance(stranger) if stranger else None,
                'places_left': len(self.places),
                '_target': target, '_stranger': stranger, '_place': place}

    def moves(self, view):
        if not view.get('alive'):
            return [Move('wait', 'wait to respawn', lambda game, v: game.wait(1.0))]
        moves = []
        target = view['_target']
        if target is not None and (view['target_m'] or 99) < SHOOT_WITHIN_M:
            moves.append(Move('shoot', 'shoot the nearest character in sight', lambda game, v: self.shoot(game, target),
                              urgent=True, seconds=SHOOT_S + 1, facts={'distance_m': view['target_m']}))
        stranger = view['_stranger']
        if stranger is not None:
            moves.append(Move('meet', 'walk to the nearest character not met yet', lambda game, v: self.meet(game, stranger),
                              seconds=WALK_S + 1, facts={'distance_m': view['stranger_m']}))
        place = view['_place']
        if place is not None:
            moves.append(Move('explore', 'walk to another place in the level', lambda game, v: self.explore(game, place),
                              seconds=WALK_S + 1, facts={'places_left': view['places_left']}))
        return moves or [Move('wait', 'stand and watch', lambda game, v: game.wait(1.0))]

    def shoot(self, game, target):
        shot = yield from game.shoot(target, SHOOT_S, height=0.9)
        return shot['fired'] > 0

    def meet(self, game, stranger):
        self.met.add(stranger.get_name())
        walked = yield from game.walk_to(stranger, within=4.0, seconds=WALK_S)
        return walked['state'] == 'arrived'

    def explore(self, game, place):
        if place in self.places:
            self.places.remove(place)
        walked = yield from game.walk_to(place, within=3.0, seconds=WALK_S)
        return walked['state'] == 'arrived'

    def outcome(self, view):
        if view.get('alive') and view.get('places_left') == 0 and view.get('stranger_m') is None:
            return Outcome.done('every place walked and every character met')
        return Outcome.playing()
