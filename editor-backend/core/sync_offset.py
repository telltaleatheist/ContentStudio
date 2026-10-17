"""
The sync offset as it is applied to a source's audio (LEDGER #315).

One decision, two readers: MediaSyncProcessor.apply_sync_to_audio builds its ffmpeg filter from
`offset_filter`, and cli/transcript_keep.py reads `applied_offset_seconds` to know how far a
moment of the raw recording moved in the `_processed` file. Both come from `_offset_plan`, so the
filter that trims a file and the number that says how much it was trimmed cannot disagree.

The offset is the LAST filter in the chain (after any drift resample or atempo), so whatever
those do to the file's clock, the offset adds the same constant to every moment of the result:

    processed_time = f(raw_time) + applied_offset_seconds(offset)

A positive offset pads the start with silence (adelay, in whole milliseconds, truncated toward
zero as int() does); a negative one trims |offset| from the start (atrim, unrounded); within a
millisecond of zero nothing is applied at all.
"""

OFFSET_DEADBAND_SECONDS = 0.001


def _offset_plan(offset_seconds):
    """('adelay', whole ms) | ('atrim', seconds trimmed) | None (nothing applied)."""
    if abs(offset_seconds) > OFFSET_DEADBAND_SECONDS:
        delay_ms = int(offset_seconds * 1000)
        if delay_ms > 0:
            return ('adelay', delay_ms)
        return ('atrim', abs(offset_seconds))
    return None


def offset_filter(offset_seconds):
    """The ffmpeg audio filter that applies `offset_seconds`, or None when nothing is applied."""
    plan = _offset_plan(offset_seconds)
    if plan is None:
        return None
    kind, value = plan
    if kind == 'adelay':
        return f'adelay={value}|{value}'
    return f'atrim=start={value}'


def applied_offset_seconds(offset_seconds):
    """Seconds added to every moment of the file by applying `offset_seconds` (negative = trimmed)."""
    plan = _offset_plan(offset_seconds)
    if plan is None:
        return 0.0
    kind, value = plan
    if kind == 'adelay':
        return value / 1000.0
    return -value
