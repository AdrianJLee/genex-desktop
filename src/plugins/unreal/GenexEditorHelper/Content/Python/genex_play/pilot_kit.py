"""The pilot kit: what an agent writes to play a game toward one goal by itself, every frame, and
genex_play.pilot runs in the play session.

A pilot turns a game into a few moves to choose between. Every frame of the play:
  - the running move's run() steps once: the fast part (walk, aim, time a press) is code;
  - every 1/look_hz game seconds the pilot looks (look reads the game into a dict, the view),
    says how the goal stands (outcome) and lists the moves that make sense now (moves);
  - at a decision point it picks a move: when nothing runs, when a move ended, when the moves on
    offer changed, and every 1/decide_hz seconds while one runs.
Who picks: with a TypeSafe key in Genex's Settings, Jev (a fast decision model) picks by the facts,
answering in a fraction of a second; without one, or while its answer is late, the first move the
pilot lists wins. So list moves in the order you would choose them: a pilot plays well by its order
alone, and Jev makes it play better where the facts weigh against each other. A different pick stops
a running move only when that move can_stop and the pick leads it by stop_lead (or the pick is
urgent), so play doesn't dither.

Write one file in the game folder's pilots/ (Genex's own, so it changes nothing of the game), such as
pilots/gate.py, with one Pilot subclass (a file in the Unreal project, Pilots/<goal>.py, runs too):

    from genex_play.pilot_kit import Move, Outcome, Pilot, Stage

    class Gate(Pilot):
        goal = 'Pick up 2 keys, then stand at the gate'
        stages = [Stage('keys', 'Hold 2 keys', lambda view: view['keys'] >= 2, ['pick_key']),
                  Stage('gate', 'Stand at the gate', lambda view: view['gate_m'] < 2, ['go_gate'])]

        def look(self, game):
            key, key_m = game.nearest('Key')
            return {'keys': game.read('BP_Hero', 'keys') or 0, 'nearest_key_m': key_m,
                    'gate_m': game.distance('Gate'), '_key': key}

        def moves(self, view):
            moves = [Move('go_gate', 'walk to the gate', lambda game, view: game.walk_to('Gate'))]
            if view['_key'] is not None:
                moves.insert(0, Move('pick_key', 'walk to the nearest key and pick it up', self.pick,
                                     facts={'distance_m': view['nearest_key_m']}))
            return moves

        def pick(self, game, view):
            walked = yield from game.walk_to(view['_key'])
            if walked['state'] != 'arrived':
                return False, walked['reason']
            yield from game.tap('E')
            return True

        def outcome(self, view):
            if view['keys'] >= 2 and view['gate_m'] < 2:
                return Outcome.done('2 keys at the gate', keys=view['keys'])
            return Outcome.playing()

A move's run(game, view) is a generator: each `yield` is one frame. `yield from` the game's
controllers (walk_to, look_at, aim at a moving actor, shoot it, strafe, hold, tap, wait, mouse; together
runs several in the same frames) and return True when it worked, False when it
failed, None when it can't tell, or (that, 'why'). game.visible(actor) says whether the player sees it;
game.read(actor, 'Health') reads its properties (C++ spellings such as Health or bDead are found too).
Aim and fire with game.shoot(enemy): it aims down sights and fires in bursts only while on target, which
lands far more hits than holding fire while turning. Defending against a swing (a melee strike, a heavy slam)
has to happen on the frame it is due, sooner than any pick arrives: def reflex(self, game) is called on
every frame beside the running move, and game.dodge('Brute', action='Dodge') there presses the dodge
once per swing, just ahead of its damage (game.threat('Brute') gives the swing and its countdown).
A view's keys that start with "_" (actors, raw
vectors) are kept from the decider. Read the game's own state for facts and stages (an inventory
count, a door's state), never what moves ran.
"""

from dataclasses import dataclass, field
from typing import Any, Callable, Optional


@dataclass
class Move:
    """One thing the player can do now.

    name:     letters, digits and _, stable across looks: how picks and the running move are matched.
              Name it by its role (attack_nearest_turret), not an instance (attack_turret_7).
    does:     what it does, in the words the facts use; the decider reads it. Keep it the same each look.
    run:      run(game, view) -> generator, one step a frame; returns True, False, None or (that, 'why').
    facts:    facts about this move now (distance to its target, what it gets, how often it worked).
    can_stop: whether a better pick may stop it midway (False for what must finish, a jump, a swing).
    urgent:   taken at once when picked, without the margin (defend when hit).
    worked:   worked(before_view, after_view) -> True, False or None: whether it worked, by the game's state.
    seconds:  the most game seconds it may run; then it is stopped as failed.
    """

    name: str
    does: str
    run: Callable[..., Any]
    facts: dict = field(default_factory=dict)
    can_stop: bool = True
    urgent: bool = False
    worked: Optional[Callable[[dict, dict], Optional[bool]]] = None
    seconds: float = 20.0


@dataclass
class Stage:
    """One stage of the plan: a thing the goal needs before the next.

    name:  letters, digits and _: how the plan's progress is kept and reported.
    what:  what the stage achieves, in the game's own words; the decider reads it.
    done:  done(view) -> True once achieved, read from the game's state. A stage found done stays done.
    moves: the names of the moves this stage offers (plus urgent ones); None offers every move. When none
           of them is on offer, every move is, and the report says so.
    """

    name: str
    what: str
    done: Callable[[dict], bool]
    moves: Optional[list] = None


class Outcome:
    """How the goal stands: playing, done (reached, or the question is settled) or failed (it can't be
    reached any more). note says why in words; evidence holds the values that show it."""

    PLAYING, DONE, FAILED = 'playing', 'done', 'failed'

    def __init__(self, state: str = PLAYING, note: str = '', evidence: Optional[dict] = None) -> None:
        self.state, self.note, self.evidence = state, note, dict(evidence or {})

    @classmethod
    def playing(cls) -> 'Outcome':
        return cls(cls.PLAYING)

    @classmethod
    def done(cls, note: str = '', **evidence) -> 'Outcome':
        return cls(cls.DONE, note, evidence)

    @classmethod
    def failed(cls, note: str = '', **evidence) -> 'Outcome':
        return cls(cls.FAILED, note, evidence)

    @property
    def over(self) -> bool:
        return self.state != self.PLAYING


class Pilot:
    """Subclass this in a file of the project's Pilots/ folder; the runtime plays the last subclass the file defines."""

    goal: str = ''  # the goal in the game's own words, as the decider reads it
    stages: list = []  # the plan: Stages in order (or set in setup); empty is every move all the time
    decide_hz: float = 3.0  # decisions a second while a move runs (0: only when it ends or the moves change)
    look_hz: float = 10.0  # looks a second, in game time
    stop_lead: float = 0.2  # how much more the decider must prefer another move to stop a running one
    instructions: Optional[str] = None  # the pick's instructions for the decider (None: the runtime's)
    recent_kept: int = 6  # how many of the last moves' results the decider reads
    stall_seconds: float = 30.0  # game seconds with no stage done and no move that worked before it stalls (0: never)
    stage_seconds: float = 120.0  # game seconds one stage may take, moves working or not (0: no limit)

    def setup(self, game) -> None:
        """Once, before the first look: find what the pilot works with."""

    def reflex(self, game) -> None:
        """Every frame, whatever move runs: reactions too quick for a decision, such as
        game.dodge('Brute') just before each of its hits lands. Keep it to a read or two."""

    def look(self, game) -> dict:
        """Read the game: the view, a dict. Called look_hz times a second: keep it to a few reads."""
        return {}

    def facts(self, view: dict) -> dict:
        """What the decider is told of the situation (default: the view without "_" keys)."""
        return {key: value for key, value in view.items() if not key.startswith('_')}

    def moves(self, view: dict) -> list:
        """The moves that make sense now, in the order you would choose them."""
        return []

    def outcome(self, view: dict) -> Outcome:
        return Outcome.playing()

    def questions(self, view: dict) -> dict:
        """Extra questions for the decider, asked with each pick: {name: {"type": "noul", "instructions":
        "Is the player in danger?"}} (also "choice" with criteria {option: words}, or "score" with
        criteria [levels]); their answers come to heard()."""
        return {}

    def heard(self, answers: dict, view: dict) -> None:
        """The answers to questions(): a noul's probability, a score, or a choice's {option: probability}."""

    def teardown(self, game) -> None:
        """After the run, however it ended."""
