"""An enemy's swing as numbers: which montage it plays, where in it the playhead is, and the game seconds
left before the montage's next damage notify (DoAttackTrace, Hit, ApplyDamage, a trace window).

The notify times come from the montage asset (read once per montage), and the playhead and play rate
from the enemy's animation instance on every read, so the countdown holds at any speed. A dodge or a
block keyed to it fires on the right frame; picking a move takes too long for that.
"""

import unreal

# A notify is a hit by its name: one of these words, and none of the bookkeeping words.
HIT_WORDS = ('hit', 'damage', 'trace', 'strike', 'swing', 'impact', 'attack')
NOT_HIT_WORDS = ('check', 'combo', 'sound', 'fx', 'footstep', 'end', 'start')
# A read this far past a hit's time still counts the hit as coming (its frame may not have run yet).
LATE_S = 0.02
# A position this far behind the last read means the attack started over.
RESTART_S = 0.05

_hit_times: dict[tuple, list] = {}


def is_hit(notify_name: str, hit: str = '') -> bool:
    """Whether a notify named `notify_name` lands a hit: it contains `hit` when given, else a hit word
    and no bookkeeping word."""
    name = notify_name.lower()
    if hit:
        return hit.lower() in name
    return any(word in name for word in HIT_WORDS) and not any(word in name for word in NOT_HIT_WORDS)


def hit_times(montage, hit: str = '') -> list:
    """The montage's hit notifies' times in montage seconds, in order (read once per montage)."""
    key = (montage.get_path_name(), hit)
    if key not in _hit_times:
        times = []
        for event in unreal.AnimationLibrary.get_animation_notify_events(montage):
            name = str(event.get_editor_property('notify_name'))
            if is_hit(name, hit):
                times.append(float(unreal.AnimationLibrary.get_anim_notify_event_trigger_time(event)))
        _hit_times[key] = sorted(times)
    return _hit_times[key]


def _anim(actor):
    mesh = actor.get_editor_property('mesh') if isinstance(actor, unreal.Character) else None
    if mesh is None:
        meshes = actor.get_components_by_class(unreal.SkeletalMeshComponent)
        mesh = meshes[0] if meshes else None
    return mesh.get_anim_instance() if mesh is not None else None


def next_hit(times: list, position: float, rate: float) -> tuple:
    """(montage time of the next hit, game seconds until it) from `position`; (None, None) when none is left."""
    for at in times:
        if at >= position - LATE_S:
            return at, max(0.0, (at - position) / max(abs(rate), 1e-3))
    return None, None


def read(actor, hit: str = '') -> dict | None:
    """The attack `actor` plays: {attack, section, position, rate, hit_at, to_hit}; None when it plays no
    montage. to_hit is the game seconds until its next hit lands, None when no hit is left in it."""
    anim = _anim(actor)
    montage = anim.get_current_active_montage() if anim is not None else None
    if montage is None:
        return None
    position = float(anim.montage_get_position(montage))
    rate = float(anim.montage_get_play_rate(montage) or 1.0)
    hit_at, to_hit = next_hit(hit_times(montage, hit), position, rate)
    return {'attack': str(montage.get_name()), 'section': str(anim.montage_get_current_section(montage)),
            'position': round(position, 3), 'rate': round(rate, 3), 'hit_at': hit_at,
            'to_hit': None if to_hit is None else round(to_hit, 3)}


class Tracker:
    """Tells one attack from the next (hit_key), so a reflex answers each hit once."""

    def __init__(self) -> None:
        self.serial, self.last = 0, None


def hit_key(tracker: Tracker, seen: dict | None) -> tuple | None:
    """The coming hit's identity (attack serial, montage time), or None when no hit is coming. An attack's
    serial grows when the montage changes, starts over, or comes back after none played."""
    last, tracker.last = tracker.last, seen
    if seen is None:
        return None
    restarted = last is None or last['attack'] != seen['attack'] or seen['position'] < last['position'] - RESTART_S
    if restarted:
        tracker.serial += 1
    if seen['hit_at'] is None:
        return None
    return (tracker.serial, seen['hit_at'])
