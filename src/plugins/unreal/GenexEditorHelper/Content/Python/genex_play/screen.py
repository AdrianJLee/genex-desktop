"""What the player sees during play, its on-screen UI included: the HUD, a menu, an inventory.

A HighResShot renders the 3D frame alone; the UI is drawn by Slate over the play view, so it is only
in a shot of the editor's window (`Shot showui`), which holds the whole editor. The play view is
found in that shot once per play, by matching a scene shot taken at a quarter of the play view's
size and its own framing (screen_math), and kept while the window and the view keep their sizes. Each shot is then
cut there and drawn at the asked width into a render target, exported as the shot's PNG.

Unreal hands a screenshot request to whichever viewport draws first, so a window shot taken just
after a HighResShot can come back as the editor's own viewport: a window shot no bigger than the
play view is taken again, a few frames later. When no window shot comes, the 3D frame alone is
taken instead, so the shot asked for always comes.
"""

import os
import time

import unreal

from genex_play import play, screen_math

COARSE = 16
FINE = 4
# Pixels of the play view left out at each edge: the fine search lands within FINE / 2 of it.
INSET = FINE
WINDOW_TRIES = 3
# Frames between a HighResShot (or a refused window shot) and the next window shot.
GAP_FRAMES = 3
# A shot file is read once its size has held this long: Unreal writes it on a worker thread.
SETTLED_S = 0.15
# Wall seconds one stage may take before the shot falls back to the 3D frame alone.
STAGE_S = 2.5
WINDOW_FILE = 'ui-window.png'
PART_SUFFIX = '.part.png'
SCENE_FILE = 'ui-scene.png'

Stage = {
    'Scene': 'scene',
    'SceneFile': 'scene-file',
    'Gap': 'gap',
    'Window': 'window',
    'WindowFile': 'window-file',
}

# Where the play view was found: the play view's and the window's sizes, and its place in the window.
_found: dict = {}
_job: dict = {}


def _world():
    return play.game_world()


def _console(command: str) -> None:
    world = _world()
    unreal.SystemLibrary.execute_console_command(world, command, unreal.GameplayStatics.get_player_controller(world, 0))


def _view_size() -> tuple[int, int]:
    size = unreal.WidgetLayoutLibrary.get_viewport_size(_world())
    return int(size.x), int(size.y)


def take(file: str, width: int, fall_back) -> dict:
    """Starts a shot of the play view with its UI into `file` (PNG, `width` wide) and returns at
    once; fall_back(file) takes the 3D frame alone instead when no window shot comes."""
    if _job:
        _give_up('a new shot began')
    view = _view_size()
    folder = os.path.dirname(file)
    _job.update(file=file, width=max(64, int(width)), fall_back=fall_back, view=view, tries=0, frames=0,
                sizes={}, window=os.path.join(folder, WINDOW_FILE), scene=os.path.join(folder, SCENE_FILE))
    _to(Stage['Window'] if _found.get('view') == view else Stage['Scene'])
    play.watch(_step, lambda: _give_up('the play ended'))
    return {'queued': True, 'file': file, 'ui': True}


def _to(stage: str) -> None:
    _job.update(stage=stage, since=time.monotonic(), frames=0)


def _give_up(reason: str) -> bool:
    """Ends the shot with the 3D frame alone; answers False (stop watching)."""
    job = dict(_job)
    _job.clear()
    if job:
        _found['fellBack'] = reason
        try:
            job['fall_back'](job['file'])
        except Exception:  # noqa: BLE001 - the play ended: there is no frame to take
            pass
    return False


def _settled(path: str, now: float) -> bool:
    """Whether the file is there and its size has held for SETTLED_S."""
    size = os.path.getsize(path) if os.path.exists(path) else 0
    last = _job['sizes'].get(path)
    if size == 0 or last is None or last[0] != size:
        _job['sizes'][path] = (size, now)
        return False
    return now - last[1] >= SETTLED_S


def _remove(path: str) -> None:
    if os.path.lexists(path):
        os.remove(path)
    _job['sizes'].pop(path, None)


def _step(_game_now: float, _wall_now: float) -> bool:
    """One frame of the shot; answers whether to keep watching."""
    if not _job:
        return False
    now = time.monotonic()
    _job['frames'] += 1
    if now - _job['since'] > STAGE_S:
        return _give_up(f'{_job["stage"]} took too long')
    try:
        return STAGES[_job['stage']](now)
    except Exception as error:  # noqa: BLE001 - any engine refusal: the 3D frame still comes
        return _give_up(repr(error))


def _scene(_now: float) -> bool:
    vw, vh = _job['view']
    _remove(_job['scene'])
    play.note_shot()
    _console(f'HighResShot {max(8, vw // FINE)}x{max(8, vh // FINE)} filename="{_job["scene"]}"')
    _to(Stage['SceneFile'])
    return True


def _scene_file(now: float) -> bool:
    if _settled(_job['scene'], now):
        _to(Stage['Gap'])
    return True


def _gap(_now: float) -> bool:
    if _job['frames'] >= GAP_FRAMES:
        _to(Stage['Window'])
    return True


def _window(_now: float) -> bool:
    _remove(_job['window'])
    _console(f'Shot showui -nosuffix filename={_job["window"]}')
    _to(Stage['WindowFile'])
    return True


def _window_file(now: float) -> bool:
    if not _settled(_job['window'], now):
        return True
    texture = unreal.RenderingLibrary.import_file_as_texture2d(_world(), _job['window'])
    window = (texture.blueprint_get_size_x(), texture.blueprint_get_size_y())
    vw, vh = _job['view']
    if window[0] <= vw and window[1] <= vh:
        # The editor's own viewport took the request: take the window again.
        _job['tries'] += 1
        if _job['tries'] >= WINDOW_TRIES:
            return _give_up('every window shot came back as a viewport')
        _to(Stage['Gap'])
        return True
    if _found.get('view') != _job['view'] or _found.get('window') != window:
        if not os.path.exists(_job['scene']):
            _to(Stage['Scene'])
            return True
        _found.update(view=_job['view'], window=window, at=_locate(texture, window, _job['view']))
    _cut(texture, window)
    _job.clear()
    return False


def _pixels(texture, size: tuple[int, int], uv: tuple[float, float] = (0.0, 0.0),
            uv_size: tuple[float, float] = (1.0, 1.0)):
    """A render target with the texture (or its uv part) drawn into it at `size`."""
    world = _world()
    target = unreal.RenderingLibrary.create_render_target2d(world, size[0], size[1],
                                                            unreal.TextureRenderTargetFormat.RTF_RGBA8_SRGB)
    canvas, _size, context = unreal.RenderingLibrary.begin_draw_canvas_to_render_target(world, target)
    canvas.draw_texture(texture, unreal.Vector2D(0, 0), unreal.Vector2D(*size), unreal.Vector2D(*uv),
                        unreal.Vector2D(*uv_size), unreal.LinearColor(1, 1, 1, 1), unreal.BlendMode.BLEND_OPAQUE)
    unreal.RenderingLibrary.end_draw_canvas_to_render_target(world, context)
    return target


def _rows(target) -> list:
    """A render target's pixels as (r, g, b) rows."""
    return [(c.r, c.g, c.b) for c in unreal.RenderingLibrary.read_render_target(_world(), target, False)]


def _locate(window_texture, window: tuple[int, int], view: tuple[int, int]) -> tuple[int, int]:
    """The play view's top-left corner in the window shot: a coarse search over the whole window,
    then a fine one around where it landed."""
    scene_texture = unreal.RenderingLibrary.import_file_as_texture2d(_world(), _job['scene'])
    (ww, wh), (vw, vh) = window, view
    coarse_window, coarse_scene = (ww // COARSE, wh // COARSE), (vw // COARSE, vh // COARSE)
    (cx, cy), _gap = screen_math.best_place(
        _rows(_pixels(window_texture, coarse_window)), coarse_window, _rows(_pixels(scene_texture, coarse_scene)),
        coarse_scene, range(coarse_window[0] - coarse_scene[0] + 1), range(coarse_window[1] - coarse_scene[1] + 1))
    left, top = max(0, cx * COARSE - COARSE), max(0, cy * COARSE - COARSE)
    region = (min(ww - left, vw + 2 * COARSE) // FINE, min(wh - top, vh + 2 * COARSE) // FINE)
    fine_scene = (vw // FINE, vh // FINE)
    fine_window = _pixels(window_texture, region, (left / ww, top / wh),
                          (region[0] * FINE / ww, region[1] * FINE / wh))
    (fx, fy), _gap = screen_math.best_place(
        _rows(fine_window), region, _rows(_pixels(scene_texture, fine_scene)), fine_scene,
        range(region[0] - fine_scene[0] + 1), range(region[1] - fine_scene[1] + 1))
    return left + fx * FINE, top + fy * FINE


def _cut(texture, window: tuple[int, int]) -> None:
    """Draws the play view's part of the window shot at the asked width and exports it as the shot."""
    (ww, wh), (vw, vh) = window, _job['view']
    x, y = _found['at']
    width, height = vw - 2 * INSET, vh - 2 * INSET
    out_width = min(_job['width'], width)
    out_height = max(1, round(out_width * height / width))
    target = _pixels(texture, (out_width, out_height), ((x + INSET) / ww, (y + INSET) / wh), (width / ww, height / wh))
    folder, name = os.path.split(_job['file'])
    # Exported beside the shot and moved over it, so the host, which reads the file once it is
    # there, never reads it half written.
    part = f'{os.path.splitext(name)[0]}{PART_SUFFIX}'
    unreal.RenderingLibrary.export_render_target(_world(), target, folder, part)
    os.replace(os.path.join(folder, part), _job['file'])
    _found.pop('fellBack', None)


STAGES = {
    Stage['Scene']: _scene,
    Stage['SceneFile']: _scene_file,
    Stage['Gap']: _gap,
    Stage['Window']: _window,
    Stage['WindowFile']: _window_file,
}


def forget() -> None:
    """Forgets where the play view was found (a new play may lay the editor out anew)."""
    _found.clear()
