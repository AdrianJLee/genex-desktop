"""Lighter rendering while an agent plays: half the render resolution and lower shadows, lighting,
reflections, effects, foliage and post-processing, so a heavy game plays at a usable frame rate under the
editor (the agent judges play, not looks). Each console variable's value is kept and put back exactly when
the play ends; turning it on twice keeps the first values."""

import unreal

LIGHT = {
    'r.ScreenPercentage': 50,
    'sg.ShadowQuality': 1,
    'sg.GlobalIlluminationQuality': 1,
    'sg.ReflectionQuality': 1,
    'sg.PostProcessQuality': 1,
    'sg.EffectsQuality': 1,
    'sg.FoliageQuality': 1,
}

_kept: dict[str, int] = {}


def _set(name: str, value: int) -> None:
    unreal.SystemLibrary.execute_console_command(None, f'{name} {value}')


def light_play(on: bool) -> dict:
    """Lowers the rendering for the agent's play (on), or puts back what it was (off); what it changed."""
    if not on:
        restored = dict(_kept)
        for name, value in restored.items():
            _set(name, value)
        _kept.clear()
        return {'light': False, 'restored': restored}
    for name, value in LIGHT.items():
        if name not in _kept:
            _kept[name] = int(unreal.SystemLibrary.get_console_variable_int_value(name))
        if _kept[name] > value:
            _set(name, value)
    return {'light': True, 'kept': dict(_kept)}
