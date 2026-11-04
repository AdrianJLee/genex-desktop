"""The play toolset Epic's MCP server lists as genex_play.tools.GenexPlayTools."""

import json

import unreal

import toolset_registry

from genex_loop.errors import short_message
from genex_play import detect, motion, play, route, walk
from genex_play import light, ui
from genex_play import pilot as pilot_run


def _answer(step, *args) -> str:
    """The step's answer as JSON; a failure becomes {error}, never an exception."""
    try:
        return json.dumps(step(*args))
    except Exception as error:  # noqa: BLE001 - no play session, no pawn, an engine call this version names differently
        return json.dumps({'error': short_message(error)})


def _state_and_findings(take_findings: bool = False) -> dict:
    """The player's state with what the play's detectors told since the computer last took them (taken
    when take_findings, else only peeked); the findings ride along even when the state can't be read
    (the pawn they describe may be gone)."""
    detect.ensure()
    try:
        state = motion.player_state()
    except Exception as error:  # noqa: BLE001 - no pawn, a position that is not a number, an ended play
        state = {'error': short_message(error)}
    state['findings'] = detect.take() if take_findings else detect.peek()
    return state


@unreal.uclass()
class GenexPlayTools(unreal.ToolsetDefinition):
    """Plays the game like a player during a play session (PIE): holds input actions or keys
    for a time, lets the pawn settle, drives it along the game's route, and reads where the
    player's pawn is. Every time here is the play session's game time: a slow editor plays the
    same amount of game, only more slowly (a wait still ends after 4x its seconds plus 10 s of
    wall clock when the game stalls). They suit a quick look (one key, a value); minutes of real
    play (a bug hunt, a fight, a goal) go better through a pilot with Genex's computer tool, which
    plays every frame (the game folder's pilots/explore.py is Genex's starter)."""

    @toolset_registry.tool_call
    @staticmethod
    def list_actions() -> str:
        """Lists the game's input actions with their value type and keys.

        Returns:
            JSON list of {action, valueType, keys, contexts}.
        """
        return play.list_actions()

    @toolset_registry.tool_call
    @staticmethod
    def hold(name: str, x: float = 1.0, y: float = 0.0, seconds: float = 1.0) -> str:
        """Holds an input action or a key as if the player pressed it, then lets go.

        Returns at once; the game keeps receiving the input for `seconds` of game time, so
        capture frames or read player_state meanwhile. Holding the same input again replaces
        its value and time.

        Args:
            name: Input action (IA_Throttle or Throttle) or key (W, SpaceBar, Gamepad_LeftX).
            x: Value on the first axis: 1 presses a button, -1..1 for an axis.
            y: Value on the second axis, for 2D actions only.
            seconds: How long to hold it, in game seconds; a tap is about 0.1.

        Returns:
            JSON {held, seconds}.
        """
        return play.hold(name, x, y, seconds)

    @toolset_registry.tool_call
    @staticmethod
    def mouse(dx: float = 0.0, dy: float = 0.0, wheel: float = 0.0) -> str:
        """Moves the player's mouse and turns its wheel for one frame of the game, as a mouse does:
        the game's own look mapping turns the view by what moved.

        Args:
            dx: Pixels of mouse motion to the right (negative: left).
            dy: Pixels of mouse motion down the screen (negative: up).
            wheel: Notches of the wheel, up positive.

        Returns:
            JSON {moved: [dx, dy], wheel}, or {error} without a play session.
        """
        return _answer(play.move_mouse, dx, dy, wheel)

    @toolset_registry.tool_call
    @staticmethod
    def pause(paused: bool = True) -> str:
        """Pauses or resumes the running play session's game, as its own pause does.

        Args:
            paused: True stands the game still; False lets it run.

        Returns:
            JSON {paused}, or {error} without a play session.
        """
        return _answer(play.set_paused, paused)

    @toolset_registry.tool_call
    @staticmethod
    def release_all() -> int:
        """Lets go of every held input action and key, and ends a settle or a drive.

        Returns:
            How many inputs were held.
        """
        return play.release_all()

    @toolset_registry.tool_call
    @staticmethod
    def project_file() -> str:
        """Names the project this editor has open, so Genex sends a project's calls only to its own editor.

        Returns:
            The full path of the open project's .uproject file.
        """
        return unreal.Paths.convert_relative_path_to_full(unreal.Paths.get_project_file_path())

    @toolset_registry.tool_call
    @staticmethod
    def player_state(take_findings: bool = False) -> str:
        """Reads the player's pawn in the running play session, the game clock, the latest settle and drive,
        and what the play's bug detectors noticed since Genex's computer last took them.

        Args:
            take_findings: True only for Genex's computer, which hands the findings to its agent and
                clears them; every other read sees them and leaves them.

        Returns:
            JSON {pawn, location, rotation, speedKmh, held, gameSeconds, fps, routeProgressM,
            settle: {state: watching|settled|unsettled, gameSeconds, speedCmS} or null,
            drive: {state: driving|done, gameSeconds, progressM, route} or null,
            findings: [{code: nan|player-gone|long-fall|hitch|teleport, detail, gameSeconds, count}]},
            or {error, findings}. fps is the editor's frames per second lately; routeProgressM is how
            far the latest drive got along the route (m), null without a route. A kind of finding is
            told on its 1st, 10th, 100th and 1000th time.
        """
        return _answer(_state_and_findings, take_findings)

    @toolset_registry.tool_call
    @staticmethod
    def walk_to(target: str, within: float = 1.2, seconds: float = 20.0) -> str:
        """Walks the player's pawn to a target as a player would, in game time: along the level's nav
        mesh when it has one, else straight, steered by the game's move action (W/A/S/D without one);
        it never walks off a drop, and when blocked it jumps, side-steps and plans again before saying
        it is stuck. Returns at once; read player_state's walk until it is no longer walking.

        Args:
            target: An actor's label or name (or part of it: the closest match wins), or "x,y,z" in cm.
            within: How near to stop, in meters.
            seconds: The most game seconds the walk may take.

        Returns:
            JSON {walking, target, way: navmesh|direct, waypoints, distanceM}, or {error} naming the
            closest actor labels when nothing matches.
        """
        return _answer(walk.walk_to, target, within, seconds)

    @toolset_registry.tool_call
    @staticmethod
    def look_at(target: str, tolerance: float = 2.5, seconds: float = 6.0) -> str:
        """Turns the player's view onto a target with the mouse, as a player would, measuring each frame
        how far the mouse turned it. Returns at once; read player_state's look until it is no longer looking.

        Args:
            target: An actor's label or name (or part of it), or "x,y,z" in cm.
            tolerance: How near the view must point, in degrees.
            seconds: The most game seconds the turn may take.

        Returns:
            JSON {looking, target}, or {error}.
        """
        return _answer(walk.look_at, target, tolerance, seconds)

    @toolset_registry.tool_call
    @staticmethod
    def settle(seconds: float = 8.0) -> str:
        """Watches the player's pawn come to rest: settled once it moves under 20 cm/s with its
        height steady for one game second, unsettled if it still moves after `seconds`.

        Returns at once; read player_state's settle until it is no longer watching.

        Args:
            seconds: The most game seconds to wait, up to 8.

        Returns:
            JSON {watching, seconds}, or {error} without a play session.
        """
        return _answer(motion.settle, seconds)

    @toolset_registry.tool_call
    @staticmethod
    def drive_route(seconds: float = 20.0, throttle: str = 'Throttle', steer: str = 'Steering') -> str:
        """Drives the player's pawn along the game's route (the spline tagged GenexRoute):
        holds the throttle and steers each frame toward the route 15 m ahead. Without a route
        it only holds the throttle.

        Returns at once; capture frames meanwhile, and read player_state's drive until it is done.

        Args:
            seconds: Game seconds to drive, up to 30.
            throttle: The throttle's input action (as hold names it).
            steer: The steering's input action: -1 full left to 1 full right.

        Returns:
            JSON {driving, seconds, route}, or {error} (no play session, an input the game lacks).
        """
        return _answer(motion.drive_route, seconds, throttle, steer)

    @toolset_registry.tool_call
    @staticmethod
    def probe_route() -> str:
        """Measures the player's pawn against the game's route: how far its facing is off the
        route's direction, how far it is from the route and how far along.

        Returns:
            JSON {route, facingDeg (0 to 180), offRouteCm, progressM (from the route's first
            point), lengthM}; nulls and route false when the game has no route; {error} without
            a play session.
        """
        return _answer(route.probe_route)

    @toolset_registry.tool_call
    @staticmethod
    def pilot(file: str, seconds: float = 60.0, decide: bool = False) -> str:
        """Starts a pilot: a file of the project (Pilots/<goal>.py, written against genex_play.pilot_kit)
        that plays toward one goal by itself, every frame in game time, choosing among the moves it names.
        A pilot already running stops first.

        Returns at once; call pilot_step until its phase is over.

        Args:
            file: The pilot's .py file, relative to the project folder.
            seconds: The most game seconds the pilot may play, 1 to 300.
            decide: Put each decision out as an ask for a decider (the host's fast decision model)
                to answer through pilot_step; False picks every move by the pilot's own order.

        Returns:
            JSON {piloting, pilot, seconds, decide, stages}, or {error} with the file's line.
        """
        return _answer(pilot_run.start, file, seconds, decide)

    @toolset_registry.tool_call
    @staticmethod
    def pilot_step(answer: str = '', stop: bool = False) -> str:
        """One step of the running pilot: hands it the decider's answer to its ask, or stops it, and
        says how it stands.

        Args:
            answer: JSON {id, probabilities: {move: p}, answers: {question: answer}, ms}, for the
                ask with that id; empty for none.
            stop: End the run now.

        Returns:
            JSON {phase: piloting, ask (the decision it waits on, or null), applied, running, stage,
            byOrder, gameSeconds}, or {phase: over, report: {outcome, note, evidence, gameSeconds,
            stages, moves, asked, answered, byOrder, facts, timeline, errors}}.
        """
        return _answer(pilot_run.step, answer, stop)

    @toolset_registry.tool_call
    @staticmethod
    def light_play(on: bool = True) -> str:
        """Lowers the rendering while an agent plays (half resolution, lower shadows, lighting, reflections,
        effects, foliage and post-processing), or puts back exactly what it was.

        Args:
            on: True to lower it for the play, False to put the kept values back.

        Returns:
            JSON {light, kept} or {light, restored}.
        """
        return _answer(light.light_play, on)

    @toolset_registry.tool_call
    @staticmethod
    def ui_widgets() -> str:
        """Lists the game's own on-screen interface during play: every visible widget that shows text or is
        a button, with its kind and its box on screen in the play shot's pixels (1280x720).

        Returns:
            JSON {view, widgets: [{name, kind, text, button, box: [x, y, w, h]}]}, or {error}.
        """
        return _answer(ui.widgets)

    @toolset_registry.tool_call
    @staticmethod
    def ui_press(button: str) -> str:
        """Presses a visible, enabled button of the game's interface by its text or name, as clicking it
        does (its own click event; hit-testing skipped).

        Args:
            button: The button's text or name, or part of it.

        Returns:
            JSON {pressed, name}, or {error} naming the buttons on screen.
        """
        return _answer(ui.press, button)
