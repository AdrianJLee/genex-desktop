"""The game's own on-screen interface (UMG) as a tester reads and uses it: every visible widget with its
text, kind and box on screen (in the play shot's pixels), and pressing a button by its text or name.

A press broadcasts the button's own click event, as a click on it does: it skips hit-testing, so a button
hidden under another widget still presses. It refuses a button that is not visible or not enabled, as a
player could not press it either.
"""

import unreal

from genex_play import play

VIEW_W, VIEW_H = 1280, 720
MAX_WIDGETS = 200
TEXT_CHARS = 120


def _visible(widget) -> bool:
    try:
        return bool(widget.is_visible())
    except Exception:  # noqa: BLE001
        return False


def _text(widget) -> str | None:
    try:
        return str(widget.get_text())[:TEXT_CHARS]
    except Exception:  # noqa: BLE001 - shows no text of its own
        return None


def _box(world, widget, scale: tuple) -> list | None:
    """[x, y, w, h] of a widget on screen, in the play shot's pixels; None before it was laid out."""
    try:
        geometry = widget.get_cached_geometry()
        size = unreal.SlateLibrary.get_local_size(geometry)
        pixel, _viewport = unreal.SlateLibrary.local_to_viewport(world, geometry, unreal.Vector2D(0.0, 0.0))
    except Exception:  # noqa: BLE001
        return None
    if not (size.x and size.y):
        return None
    return [round(pixel.x * scale[0]), round(pixel.y * scale[1]), round(size.x * scale[0]), round(size.y * scale[1])]


def _shown(widget) -> bool:
    """Whether a widget and every panel it sits in are visible."""
    while widget is not None:
        if not _visible(widget):
            return False
        widget = widget.get_parent()
    return True


def _rows() -> list:
    """The visible widgets that show text or are buttons, inside the user widgets on screen (Python can't walk a
    widget tree, so every widget object is checked for the on-screen user widget it belongs to)."""
    world = play.game_world()
    viewport = unreal.WidgetLayoutLibrary.get_viewport_size(world)
    scale = (VIEW_W / max(1.0, viewport.x), VIEW_H / max(1.0, viewport.y))
    tops = [top for top in unreal.WidgetLibrary.get_all_widgets_of_class(world, unreal.UserWidget, True)
            if top.is_in_viewport() and _visible(top)]
    rows: list = []
    for widget in unreal.ObjectIterator(unreal.Widget):
        if len(rows) >= MAX_WIDGETS:
            break
        if isinstance(widget, unreal.UserWidget) or widget.get_typed_outer(unreal.UserWidget) not in tops:
            continue
        text = _text(widget)
        button = isinstance(widget, unreal.Button)
        if (text or button) and _shown(widget):
            rows.append({'name': widget.get_name(), 'kind': widget.get_class().get_name(), 'text': text,
                         'button': button, 'box': _box(world, widget, scale), '_widget': widget})
    rows.sort(key=lambda row: (row['box'] or [0, 0])[1::-1])
    return rows


def widgets() -> dict:
    """The visible widgets on screen that show text or are buttons: name, kind, text, button, box."""
    return {'view': [VIEW_W, VIEW_H],
            'widgets': [{k: v for k, v in row.items() if not k.startswith('_')} for row in _rows()]}


def _button_of(rows: list, wanted: str):
    """The button whose text or name is `wanted`, else one holding it, else the button around a text that is."""
    low = wanted.strip().lower()
    buttons = [r for r in rows if r['button']]
    for test in (lambda r: (r['text'] or '').lower() == low or r['name'].lower() == low,
                 lambda r: low in (r['text'] or '').lower() or low in r['name'].lower()):
        found = [r for r in buttons if test(r)]
        if found:
            return found[0]
    labels = [r for r in rows if low in (r['text'] or '').lower()]
    for label in labels:
        parent = label['_widget'].get_parent()
        while parent is not None:
            if isinstance(parent, unreal.Button):
                return {'name': parent.get_name(), 'text': label['text'], 'button': True, '_widget': parent}
            parent = parent.get_parent()
    return None


def press(wanted: str) -> dict:
    """Presses the visible button whose text or name is `wanted` (or holds it); what it pressed."""
    rows = _rows()
    found = _button_of(rows, wanted)
    if found is None:
        names = [r['text'] or r['name'] for r in rows if r['button']]
        raise RuntimeError(f'No visible button is called {wanted}. Buttons on screen: {", ".join(names) or "none"}.')
    button = found['_widget']
    if not button.get_is_enabled():
        raise RuntimeError(f'{found["text"] or found["name"]} is on screen but not enabled.')
    button.on_clicked.broadcast()
    return {'pressed': found['text'] or found['name'], 'name': found['name']}
