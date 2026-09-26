# core/word_mutes.py
#
# The pure half of "Mute words" (LEDGER #226): which transcript words are muted, and where in
# time. Nothing here reads FCPXML — cli/word_mute_pass.py places the mutes on the master
# timeline's own clips. Everything here is plain data in, plain data out, so the offline checks
# (tools/word-mute-checks.js -> tools/word-mute-driver.py) drive exactly this code.
#
# THE WORD LISTS live in ONE data file, core/mute_words.json ("muteGroups"). The app's modal
# reads the same file through the main process (electron/services/editor/mute-words.ts), so
# what the modal shows a group covering is, byte for byte, what this module matches.
#
# THE SEAM FOR "um"/"uh" (not built): removing filler words is a different ACTION (a cut, not a
# mute) over the same kind of word set. It gets its own key in mute_words.json next to
# "muteGroups" (e.g. "fillerWords") and is matched by the same `word_matches` rule below; the
# mute pass never reads that key.
#
# DOCTRINE: numbers are sacred (exact Fractions until the XML string), and nothing is skipped
# silently — a settings file that cannot be read, or names a group the catalog does not have,
# raises with the reason.

import json
import math
from fractions import Fraction
from pathlib import Path

CATALOG_PATH = Path(__file__).with_name('mute_words.json')

MUTE_PAD_SECONDS = Fraction(50, 1000)
"""Added to EACH side of the aligned word span before it is muted. Owen's number to tune.
Protects the word's attack and tail: the forced aligner places a word's edges to within a few
tens of milliseconds, and a mute that starts on the aligner's exact edge lets the hard "f"
through. 50 ms is short enough that the neighbouring words survive at normal speaking pace."""

MUTE_TIMEBASE = 720000
"""The denominator FCP itself writes mute times in (the sample: start="15918331/720000s").
Every frame rate this pipeline produces (24, 25, 29.97, 30, 59.94, 60) lands exactly on it."""

DEFAULT_WINDOW_MINUTES = 3
"""The opening window's length when a project has never set one (Owen: "the first 3 minutes")."""

SETTINGS_SCHEMA_VERSION = 1
MODES = ('off', 'everywhere', 'opening')
CUSTOM_GROUP_ID = 'custom'
MAX_WINDOW_MINUTES = 600


class WordMuteError(Exception):
    """A loud, user-facing failure. Its message is shown verbatim."""


# ---------------------------------------------------------------------------
# The catalog (the word groups)
# ---------------------------------------------------------------------------
def _norm(text):
    """One word as the matcher sees it: lowercase, curly apostrophes straightened, and the
    punctuation the transcript glues on (commas, quotes, a trailing apostrophe) stripped."""
    t = (text or '').lower().replace('’', "'").replace('‘', "'")
    return t.strip(" \t\r\n.,!?;:\"'()[]{}<>*_~`\u201c\u201d\u2026")


def load_catalog(path=None):
    """The word groups, validated. A catalog the app cannot trust raises — it is shipped data,
    so a broken one is a build defect, never something to half-use."""
    p = Path(path) if path else CATALOG_PATH
    try:
        with open(p, encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        raise WordMuteError(f"the word list {p} cannot be read: {e}")
    groups = data.get('muteGroups') if isinstance(data, dict) else None
    if not isinstance(groups, list) or not groups:
        raise WordMuteError(f"the word list {p} has no 'muteGroups'")
    seen = set()
    out = []
    for g in groups:
        gid = g.get('id') if isinstance(g, dict) else None
        if not isinstance(gid, str) or not gid or gid == CUSTOM_GROUP_ID or gid in seen:
            raise WordMuteError(f"the word list {p} has a group with a missing, reserved or repeated id: {gid!r}")
        seen.add(gid)
        label = g.get('label')
        contains = g.get('contains', [])
        exact = g.get('exact', [])
        if not isinstance(label, str) or not label:
            raise WordMuteError(f"the word list {p}: group {gid!r} has no label")
        for name, lst in (('contains', contains), ('exact', exact)):
            if not isinstance(lst, list) or not all(isinstance(w, str) and _norm(w) == w and w for w in lst):
                raise WordMuteError(
                    f"the word list {p}: group {gid!r} '{name}' must be a list of lowercase words "
                    "with no surrounding punctuation")
        if not contains and not exact:
            raise WordMuteError(f"the word list {p}: group {gid!r} lists no words")
        out.append({'id': gid, 'label': label, 'contains': tuple(contains), 'exact': tuple(exact)})
    return out


def parse_custom_word(entry):
    """One of Owen's own words -> ('exact' | 'prefix' | 'suffix' | 'contains', stem).
    A '*' at the start or end is a wildcard: 'bs*' = anything starting with bs."""
    raw = (entry or '').strip().lower().replace('’', "'")
    lead = raw.startswith('*')
    trail = raw.endswith('*')
    stem = _norm(raw.strip('*'))
    if not stem:
        raise WordMuteError(f"custom word {entry!r} has no letters in it")
    if lead and trail:
        return ('contains', stem)
    if lead:
        return ('suffix', stem)
    if trail:
        return ('prefix', stem)
    return ('exact', stem)


def _pieces(norm):
    """The whole word plus its hyphen-separated parts, so 'dumb-ass' is checked as 'ass' too."""
    parts = [p for p in norm.replace('—', '-').split('-') if p]
    return [norm] + (parts if len(parts) > 1 else [])


def word_matches(text, contains=(), exact=(), custom=()):
    """True when this transcript word is in the set: any `contains` stem inside it, any
    `exact` word equal to it (or to one of its hyphen parts), or any custom rule. The one
    matching rule for every word set, the um/uh seam included."""
    n = _norm(text)
    if not n:
        return False
    if any(c in n for c in contains):
        return True
    pieces = _pieces(n)
    if any(p in exact for p in pieces):
        return True
    for kind, stem in custom:
        for p in pieces:
            if ((kind == 'exact' and p == stem) or (kind == 'prefix' and p.startswith(stem))
                    or (kind == 'suffix' and p.endswith(stem)) or (kind == 'contains' and stem in p)):
                return True
    return False


# ---------------------------------------------------------------------------
# Per-project settings (<cleanName>_mute-words.json beside the project's zip)
# ---------------------------------------------------------------------------
def settings_path_for_zip(zip_path, session_name):
    return Path(zip_path).parent / f"{session_name}_mute-words.json"


def validate_settings(data, catalog, label='mute settings'):
    """The saved choice, checked field by field. The same rules as the main process's
    validator (electron/services/editor/mute-words.ts validateMuteSettings); the offline check
    runs both over the same inputs so they cannot drift (Law 10)."""
    if not isinstance(data, dict):
        raise WordMuteError(f"{label}: not an object")
    if data.get('schemaVersion') != SETTINGS_SCHEMA_VERSION:
        raise WordMuteError(f"{label}: schemaVersion {data.get('schemaVersion')!r} is not {SETTINGS_SCHEMA_VERSION}")
    groups = data.get('groups')
    if not isinstance(groups, dict):
        raise WordMuteError(f"{label}: 'groups' is not an object")
    ids = [g['id'] for g in catalog]
    for gid in groups:
        if gid not in ids:
            raise WordMuteError(f"{label}: group {gid!r} is not in the word list (known: {ids})")
    for gid in ids:
        if gid not in groups:
            raise WordMuteError(
                f"{label}: no choice saved for the {gid!r} group — open Mute words and save again")
        if groups[gid] not in MODES:
            raise WordMuteError(f"{label}: group {gid!r} is {groups[gid]!r}, expected one of {list(MODES)}")
    custom = data.get('customWords')
    if not isinstance(custom, list) or not all(isinstance(w, str) for w in custom):
        raise WordMuteError(f"{label}: 'customWords' is not a list of words")
    for w in custom:
        parse_custom_word(w)
    if data.get('customMode') not in MODES:
        raise WordMuteError(f"{label}: 'customMode' is {data.get('customMode')!r}, expected one of {list(MODES)}")
    win = data.get('openingWindow')
    if not isinstance(win, dict) or not isinstance(win.get('allSwearing'), bool):
        raise WordMuteError(f"{label}: 'openingWindow.allSwearing' is not true/false")
    minutes = win.get('minutes')
    if (isinstance(minutes, bool) or not isinstance(minutes, (int, float))
            or not math.isfinite(minutes) or minutes <= 0 or minutes > MAX_WINDOW_MINUTES):
        raise WordMuteError(f"{label}: 'openingWindow.minutes' must be a number above 0 and at most {MAX_WINDOW_MINUTES}")
    return data


def load_settings(path, catalog):
    """The project's saved choice, or None when the project has never saved one (no mutes)."""
    p = Path(path)
    if not p.is_file():
        return None
    try:
        with open(p, encoding='utf-8') as fh:
            data = json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        raise WordMuteError(f"{p.name} cannot be read: {e} — open Mute words and save again")
    return validate_settings(data, catalog, p.name)


def settings_active(settings):
    """Would these settings mute anything at all?"""
    if settings is None:
        return False
    if settings['openingWindow']['allSwearing']:
        return True
    if any(m != 'off' for m in settings['groups'].values()):
        return True
    return settings['customMode'] != 'off' and bool(settings['customWords'])


def window_seconds(settings):
    return Fraction(settings['openingWindow']['minutes']).limit_denominator(1000) * 60


def match_groups(text, catalog, settings):
    """The group ids this word belongs to ('custom' for Owen's own words). Empty = not a match."""
    out = []
    for g in catalog:
        if word_matches(text, g['contains'], g['exact']):
            out.append(g['id'])
    custom = [parse_custom_word(w) for w in settings['customWords']]
    if custom and word_matches(text, custom=custom):
        out.append(CUSTOM_GROUP_ID)
    return out


def muted_at(group_ids, master_seconds, settings):
    """THE RULE. A word is muted at this point of the MASTER timeline (what the viewer hears
    from 0:00) when any group it belongs to is set to 'everywhere', or when the point is inside
    the opening window and the group is set to 'opening' or the window mutes all swearing."""
    in_window = master_seconds < window_seconds(settings)
    all_in_window = settings['openingWindow']['allSwearing']
    for gid in group_ids:
        mode = settings['customMode'] if gid == CUSTOM_GROUP_ID else settings['groups'][gid]
        if mode == 'everywhere':
            return True
        if in_window and (mode == 'opening' or all_in_window):
            return True
    return False


# ---------------------------------------------------------------------------
# Interval arithmetic and the <mute> number format
# ---------------------------------------------------------------------------
def pad_span(start, end, pad=MUTE_PAD_SECONDS):
    """The word span grown by `pad` on each side, never before 0."""
    return (max(Fraction(0), start - pad), end + pad)


def merge_spans(spans):
    """Sort and merge spans that overlap OR touch. [(a, b)] -> sorted, disjoint, non-touching."""
    out = []
    for (s, e) in sorted(spans):
        if out and s <= out[-1][1]:
            if e > out[-1][1]:
                out[-1] = (out[-1][0], e)
        else:
            out.append((s, e))
    return out


def quantize_clamp(s, e, lo, hi, timebase=MUTE_TIMEBASE):
    """(start_ticks, end_ticks) on the FCP mute grid, rounded OUTWARD (a mute exists to cover
    the word, so rounding may only ever cover more of it) and then clamped INSIDE the clip's
    source range [lo, hi). None when nothing is left."""
    a = max(math.floor(s * timebase), math.ceil(lo * timebase))
    b = min(math.ceil(e * timebase), math.floor(hi * timebase))
    if b <= a:
        return None
    return (a, b)


def format_ticks(ticks, timebase=MUTE_TIMEBASE):
    """FCP's own spelling: unreduced N/720000s, and plain 0s for zero."""
    return '0s' if ticks == 0 else f"{ticks}/{timebase}s"


def clock(seconds):
    """H:MM:SS (or M:SS) for a report line."""
    s = int(math.floor(float(seconds)))
    h, rem = divmod(s, 3600)
    m, sec = divmod(rem, 60)
    return f"{h}:{m:02d}:{sec:02d}" if h else f"{m}:{sec:02d}"
