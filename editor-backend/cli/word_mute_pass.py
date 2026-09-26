#!/usr/bin/env python3
# cli/word_mute_pass.py
#
# "Mute words" on the MASTER timeline (LEDGER #226). Every transcript word in the project's
# chosen groups becomes a <mute> on the master timeline's OWN audio clips — never inside a
# compound clip — exactly as Final Cut writes one when you select a range with the Range tool
# (R) and press V:
#
#     <clip lane="-1" ...>                          (a clip: the sample Owen made)
#         <gap ...><audio ... srcCh="1, 2" role="dialogue.dialogue-1"/></gap>
#         <audio-channel-source srcCh="1, 2" role="dialogue.dialogue-1">
#             <mute start="15918331/720000s" duration="436401/720000s"/>
#         </audio-channel-source>
#     </clip>
#
# The master timeline this pipeline builds (master_project_generator.py:792-853) carries its
# audio in <ref-clip>s — the lane -1 CAM-compound audio clip (every mic) and the lane -2 SSB
# audio clip (screen / game). A ref-clip's per-role audio component is <audio-role-source>
# (FCPXML 1.14 DTD: `ref-clip (... anchor items, markers, audio-role-source*, video filters,
# filter-audio*, metadata?)` and `audio-role-source (... filter-audio*, mute*)`), so there the
# same mute is written as
#
#     <ref-clip ref="r2" lane="-1" srcEnable="audio" ...>
#         <audio-role-source role="dialogue.dialogue-1">
#             <mute start="N/720000s" duration="M/720000s"/>
#         </audio-role-source>
#     </ref-clip>
#
# with start/duration in the ref-clip's SOURCE time (the compound's own timeline — the domain of
# the ref-clip's `start` attribute), the same way the sample's mute is in its clip's source time.
#
# HOW A WORD GETS THERE — through the timeline's own tables, never a linear offset:
#   1. The word's aligned span in its SOURCE FILE (sidecar fileStart/fileEnd, Qwen3 forced
#      aligner via Crucible) grows by MUTE_PAD_SECONDS each side.
#   2. File time -> master timeline, through the file's flattened segment table
#      (ManifestBuilder.leaves: every kept auto-editor segment's timeline start and source
#      in-point). A word that spans a cut lands on BOTH sides; a stretch auto-editor removed maps
#      to nothing.
#   3. Timeline -> each audio clip's source time, through the PRISTINE master spine: every clip
#      whose audible content plays that file at that moment (resolved by media file, like
#      editor_export's mic mute) gives a (clip identity, source span) target.
#   4. The EXPORTED timeline (after cuts, stories, reorder and the mic-mute split) is walked
#      and every clip with a target identity gets the part of each target inside its own source
#      range. A word in a section that was cut lands nowhere and is reported as cut. Reorder
#      and story splits need nothing special: a clip's source range says what it plays.
#   5. The rule (core/word_mutes.muted_at) is judged at the piece's MASTER-timeline time — what
#      the viewer hears from 0:00 — so the opening window follows the edit, not the recording.
#
# Nothing is dropped silently: every matched word ends up in the report as muted, left by the
# project's choice (outside the opening window), switched off already (mic mute), cut, or NOT
# MUTED with the reason. The report is logged and returned for the screen.

import sys
from fractions import Fraction
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

import xml.etree.ElementTree as ET  # noqa: E402

from cli.editor_manifest import (  # noqa: E402
    ManifestBuilder,
    ManifestError,
    TIMELINE_TAGS,
    parse_rational,
)
from core.word_mutes import (  # noqa: E402
    CUSTOM_GROUP_ID,
    MUTE_PAD_SECONDS,
    WordMuteError,
    clock,
    format_ticks,
    match_groups,
    merge_spans,
    muted_at,
    pad_span,
    quantize_clamp,
    settings_active,
)

AUDIBLE = (None, 'all', 'audio')
# Children a mute container must come BEFORE (FCPXML 1.14 DTD, clip / asset-clip / ref-clip).
_AFTER_CONTAINER = frozenset({'filter-video', 'filter-video-mask', 'filter-audio', 'metadata'})


# ---------------------------------------------------------------------------
# What a clip can be heard playing
# ---------------------------------------------------------------------------
class _Sources:
    """Resolves which media files (with which audio roles and channels) an element's OWN
    content makes audible. Memoised per compound. File paths resolve exactly as
    editor_manifest does (media-rep file:// URL, unquoted once) — the same key the transcript
    sidecar's tracks[].file carries."""

    def __init__(self, root, context):
        resources = root.find('resources')
        if resources is None:
            raise ManifestError(f"{context}: no <resources> element")
        self.media = {el.get('id'): el for el in resources if el.tag == 'media' and el.get('id')}
        self.assets = {el.get('id'): el for el in resources if el.tag == 'asset' and el.get('id')}
        self.context = context
        self.cache = {}

    def asset_path(self, asset_id):
        from cli.editor_export import _asset_path
        return _asset_path(self.assets, asset_id, self.context)

    def media_sources(self, media_id, stack=()):
        if media_id in self.cache:
            return self.cache[media_id]
        if media_id not in self.media:
            raise ManifestError(f"{self.context}: <ref-clip> references {media_id!r}, which is not a compound <media>")
        if media_id in stack:
            raise ManifestError(f"{self.context}: compound {media_id!r} contains itself")
        spine = self.media[media_id].find('sequence/spine')
        if spine is None:
            raise ManifestError(f"{self.context}: compound {media_id!r} has no sequence spine")
        out = self.content(list(spine), None, stack + (media_id,))
        self.cache[media_id] = out
        return out

    def content(self, elements, role, stack=()):
        """file -> {'roles': set, 'srcCh': set, 'noRole': bool} audible in `elements` and
        everything under them. A disabled element takes its subtree with it."""
        out = {}
        for el in elements:
            if el.tag not in TIMELINE_TAGS or el.get('enabled') == '0':
                continue
            tag = el.tag
            if tag == 'ref-clip':
                if el.get('srcEnable') in AUDIBLE:
                    _merge(out, self.media_sources(el.get('ref'), stack))
                _merge(out, self.content(list(el), role, stack))
            elif tag == 'audio':
                _add(out, self.asset_path(el.get('ref')), role or el.get('role'), el.get('srcCh'))
                _merge(out, self.content(list(el), role, stack))
            elif tag == 'asset-clip':
                if el.get('srcEnable') in AUDIBLE and el.get('ref') in self.assets:
                    acs = el.find('audio-channel-source')
                    r = (acs.get('role') if acs is not None else None) or el.get('audioRole') or role
                    _add(out, self.asset_path(el.get('ref')), r,
                         acs.get('srcCh') if acs is not None else None)
                _merge(out, self.content(list(el), role, stack))
            elif tag == 'clip':
                acs = el.find('audio-channel-source')
                r = acs.get('role') if acs is not None and acs.get('role') else role
                _merge(out, self.content(list(el), r, stack))
            else:  # gap, video: containers for whatever is anchored to them
                _merge(out, self.content(list(el), role, stack))
        return out


def _add(out, f, role, src_ch):
    d = out.setdefault(f, {'roles': set(), 'srcCh': set(), 'noRole': False})
    if role:
        d['roles'].add(role)
    else:
        d['noRole'] = True
    if src_ch:
        d['srcCh'].add(src_ch)


def _merge(out, other):
    for f, d in other.items():
        t = out.setdefault(f, {'roles': set(), 'srcCh': set(), 'noRole': False})
        t['roles'] |= d['roles']
        t['srcCh'] |= d['srcCh']
        t['noRole'] = t['noRole'] or d['noRole']


def _zero(el, attr):
    v = el.get(attr)
    return v is None or parse_rational(v, attr) == 0


def _clip_identity_file(clip, sources):
    """A <clip> (no media ref) whose source time IS its one file's time — the sample's shape:
    an unshifted gap holding an unshifted <audio>. Returns (file, srcCh) or None. Any other
    <clip> is a container, not a carrier: its inner timing is not something a mute on the clip
    could be expressed in without guessing."""
    own = [c for c in clip if c.tag in TIMELINE_TAGS and c.get('lane') is None]
    files = []

    def walk(els):
        for el in els:
            if el.tag not in TIMELINE_TAGS or el.get('enabled') == '0':
                continue
            if not (_zero(el, 'offset') and _zero(el, 'start')):
                if el.tag in ('audio', 'gap', 'clip', 'ref-clip', 'asset-clip'):
                    return False
                continue
            if el.tag == 'audio':
                files.append((sources.asset_path(el.get('ref')), el.get('srcCh')))
            elif el.tag in ('ref-clip', 'asset-clip'):
                return False
            if walk(list(el)) is False:
                return False
        return True

    if walk(own) is False or len({f for f, _ in files}) != 1:
        return None
    acs = clip.find('audio-channel-source')
    src_ch = (acs.get('srcCh') if acs is not None else None) or files[0][1]
    if not src_ch:
        return None
    return files[0][0], src_ch


def _carrier(el, sources):
    """(identity, {file: info}, tag) when `el` is a timeline clip whose OWN audio can carry a
    mute, else None. The identity names the clip's source-time domain: two clips with the same
    identity play the same source at the same source time, which is what lets a target found
    on the pristine master be found again on the exported one."""
    tag = el.tag
    if tag == 'ref-clip' and el.get('srcEnable') in AUDIBLE:
        s = sources.media_sources(el.get('ref'))
        return (('media', el.get('ref')), s, tag) if s else None
    if tag == 'asset-clip' and el.get('srcEnable') in AUDIBLE and el.get('ref') in sources.assets:
        s = sources.content([_asset_only(el)], None)
        return (('asset', el.get('ref')), s, tag) if s else None
    if tag == 'clip' and (el.get('ref') is None or el.get('ref') not in sources.assets):
        ident = _clip_identity_file(el, sources)
        if ident is None:
            return None
        f, src_ch = ident
        acs = el.find('audio-channel-source')
        # The clip's own audio-channel-source names the output role for everything it plays,
        # exactly as Sources.content applies it to a <clip> met inside a compound.
        role = acs.get('role') if acs is not None and acs.get('role') else None
        s = sources.content([c for c in el if c.get('lane') is None], role)
        if f not in s:
            return None
        info = dict(s[f], srcCh={src_ch})
        return (('file', f), {f: info}, tag)
    return None


def _asset_only(asset_clip):
    """A childless copy of an asset-clip, so its OWN audio is resolved without its anchored clips."""
    return ET.Element('asset-clip', dict(asset_clip.attrib))


def _walk(elements, frame_a, window, disabled, out, sources, context):
    """Every carrier clip under `elements`, with its VISIBLE span on this project's timeline
    (abs0, abs1) and its source time at abs0 (src0). frame_a is the timeline time of local 0
    of the enclosing frame — the same arithmetic editor_manifest.flatten and editor_export's
    surgery use, so all three agree on where a clip is."""
    from cli.editor_export import _read_span
    for el in elements:
        if el.tag not in TIMELINE_TAGS:
            continue
        ctx = f"{context} > {el.tag}"
        offset, start, duration, _had = _read_span(el, ctx)
        a0 = frame_a + offset
        a1 = a0 + duration
        v0 = max(a0, window[0])
        v1 = min(a1, window[1])
        if v0 >= v1:
            continue
        dis = disabled or el.get('enabled') == '0'
        found = _carrier(el, sources)
        if found is not None:
            key, srcs, tag = found
            out.append({'el': el, 'key': key, 'sources': srcs, 'tag': tag, 'disabled': dis,
                        'abs0': v0, 'abs1': v1, 'src0': start + (v0 - a0)})
        if el.tag == 'clip' and found is None:
            children = list(el)                               # a container clip: look inside
        elif el.tag == 'clip':
            children = [c for c in el if c.get('lane') is not None]   # its connected clips only
        else:
            children = list(el)                               # anchored (connected) clips
        _walk(children, a0 - start, (v0, v1), dis, out, sources, ctx)


def _projects(root, context):
    out = []
    for p in root.findall('.//project'):
        seq = p.find('sequence')
        spine = seq.find('spine') if seq is not None else None
        if spine is None or not seq.get('duration'):
            raise ManifestError(f"{context}: project {p.get('name')!r} has no sequence spine or duration")
        out.append((p, seq, spine, parse_rational(seq.get('duration'), 'sequence duration')))
    if not out:
        raise ManifestError(f"{context}: no <project> in the timeline")
    return out


# ---------------------------------------------------------------------------
# 1-3: the plan, on the PRISTINE master
# ---------------------------------------------------------------------------
def plan_word_mutes(pristine_tree, entry_name, sidecar, settings, catalog, pad=MUTE_PAD_SECONDS):
    """Every matched word with its targets: [(identity, roles, srcCh, u0, u1)] in each carrier
    clip's source time. A word with no target carries `problem` (code, plain reason)."""
    tracks = {t.get('id'): t for t in sidecar.get('tracks', [])}
    matches = []
    for w in sidecar['words']:
        groups = match_groups(w.get('text'), catalog, settings)
        if not groups:
            continue
        tid = w.get('track')
        if tid not in tracks or not tracks[tid].get('file'):
            raise WordMuteError(f"transcript word {w.get('text')!r} names track {tid!r}, which the transcript does not list with a file")
        fs, fe = w.get('fileStart'), w.get('fileEnd')
        if not isinstance(fs, (int, float)) or not isinstance(fe, (int, float)) or fe < fs:
            raise WordMuteError(f"transcript word {w.get('text')!r} has no usable fileStart/fileEnd ({fs!r}, {fe!r})")
        matches.append({'text': w.get('text'), 'groups': groups, 'track': tid,
                        'trackLabel': tracks[tid].get('label') or tid, 'file': tracks[tid]['file'],
                        'fileStart': Fraction(fs), 'fileEnd': Fraction(fe),
                        'recordingTime': w.get('timelineStart'), 'targets': [], 'problem': None})
    labels = dict({g['id']: g['label'] for g in catalog}, **{CUSTOM_GROUP_ID: 'Your words'})
    if not matches:
        return {'matches': matches, 'labels': labels}

    builder = ManifestBuilder(pristine_tree, entry_name)
    builder.flatten()
    table = {}
    seen = set()
    for leaf in builder.leaves:
        if leaf['kind'] != 'audio':
            continue
        k = (leaf['file'], leaf['timeline_start'], leaf['timeline_end'], leaf['source_start'])
        if k in seen:
            continue
        seen.add(k)
        table.setdefault(leaf['file'], []).append((leaf['timeline_start'], leaf['timeline_end'], leaf['source_start']))

    root = pristine_tree.getroot()
    sources = _Sources(root, entry_name)
    carriers = []
    base = Fraction(0)
    for (p, _seq, spine, declared) in _projects(root, entry_name):
        part = []
        _walk(list(spine), Fraction(0), (Fraction(0), declared), False, part, sources,
              f"{entry_name}: project {p.get('name')!r}")
        for c in part:
            c['abs0'] += base
            c['abs1'] += base
        carriers.extend(c for c in part if not c['disabled'])
        base += declared

    for m in matches:
        a, b = pad_span(m['fileStart'], m['fileEnd'], pad)
        spans = []
        for (ts, te, ss) in table.get(m['file'], []):
            s = max(a, ss)
            e = min(b, ss + (te - ts))
            if s < e:
                spans.append((ts + (s - ss), ts + (e - ss)))
        spans = merge_spans(spans)
        if not spans:
            m['problem'] = ('not-on-timeline',
                            f"its moment in {Path(m['file']).name} is not on the master timeline "
                            "(auto-editor removed that stretch)")
            continue
        roleless = False
        targets = set()
        for (t0, t1) in spans:
            for c in carriers:
                info = c['sources'].get(m['file'])
                if info is None:
                    continue
                s = max(t0, c['abs0'])
                e = min(t1, c['abs1'])
                if s >= e:
                    continue
                if info['noRole'] or not info['roles']:
                    roleless = True
                    continue
                u0 = c['src0'] + (s - c['abs0'])
                targets.add((c['key'], tuple(sorted(info['roles'])),
                             ', '.join(sorted(info['srcCh'])) or None, u0, u0 + (e - s)))
        m['targets'] = sorted(targets, key=lambda t: (t[0], t[3]))
        if not m['targets']:
            m['problem'] = (('no-role', "the clip that plays it has no audio role for a mute to name")
                            if roleless else
                            ('no-carrier', f"no clip on the master timeline that can carry a mute plays "
                                           f"{Path(m['file']).name} at that moment"))
    return {'matches': matches, 'labels': labels}


# ---------------------------------------------------------------------------
# 4: the exported timeline
# ---------------------------------------------------------------------------
def strip_mutes(root):
    """Remove every <mute> on the timeline's own clips (never inside a compound's <media>) and
    any mute container left empty. The pipeline writes no other mute, so everything removed
    here was written by an earlier run of this pass — that is what makes Apply repeatable."""
    removed = 0
    for p in root.findall('.//project'):
        for parent in list(p.iter()):
            for cont in [c for c in parent if c.tag in ('audio-role-source', 'audio-channel-source')]:
                mutes = [m for m in cont if m.tag == 'mute']
                for m in mutes:
                    cont.remove(m)
                removed += len(mutes)
                if mutes and len(cont) == 0 and set(cont.attrib) <= {'role', 'srcCh'}:
                    parent.remove(cont)
    return removed


def _container(el, tag, role, src_ch):
    """The clip's mute container for this role, created in its DTD place if absent: after the
    media children, anchored clips and markers; before filter-video*, filter-audio*, metadata."""
    for c in el:
        if c.tag == tag and c.get('role') == role and (tag == 'audio-role-source' or c.get('srcCh') == src_ch):
            return c
    attrs = {'role': role} if tag == 'audio-role-source' else {'srcCh': src_ch, 'role': role}
    cont = ET.Element(tag, attrs)
    kids = list(el)
    idx = next((i for i, c in enumerate(kids) if c.tag in _AFTER_CONTAINER), len(kids))
    el.insert(idx, cont)
    return cont


def write_mutes(el, role, src_ch, tick_spans):
    """Append <mute start duration> elements (ticks on the 720000 grid) to `el`'s container."""
    tag = 'audio-role-source' if el.tag == 'ref-clip' else 'audio-channel-source'
    cont = _container(el, tag, role, src_ch)
    for (a, b) in tick_spans:
        ET.SubElement(cont, 'mute', {'start': format_ticks(a), 'duration': format_ticks(b - a)})
    return len(tick_spans)


def apply_word_mutes(final_tree, plan, settings, window_mode, context='timeline'):
    """Place the plan on the exported timeline. window_mode 'plain' measures master time across
    the projects laid end to end (the parts of one timeline); 'stories' measures each project
    from its own 0:00 (each story is its own video). Returns the report."""
    if window_mode not in ('plain', 'stories'):
        raise ManifestError(f"internal error: window mode {window_mode!r}")
    root = final_tree.getroot()
    removed = strip_mutes(root)
    matches = plan['matches']
    by_key = {}
    for mi, m in enumerate(matches):
        m['status'] = set()
        for t in m['targets']:
            by_key.setdefault(t[0], []).append((mi, t))

    buckets = {}
    sources = _Sources(root, context)
    base = Fraction(0)
    for (p, _seq, spine, declared) in _projects(root, context):
        carriers = []
        _walk(list(spine), Fraction(0), (Fraction(0), declared), False, carriers, sources,
              f"{context}: project {p.get('name')!r}")
        master_base = base if window_mode == 'plain' else Fraction(0)
        for c in carriers:
            lo = c['src0']
            hi = lo + (c['abs1'] - c['abs0'])
            for (mi, (key, roles, src_ch, u0, u1)) in by_key.get(c['key'], ()):
                s = max(u0, lo)
                e = min(u1, hi)
                if s >= e:
                    continue
                m = matches[mi]
                if c['disabled']:
                    m['status'].add('off')
                    continue
                if not muted_at(m['groups'], master_base + c['abs0'] + (s - lo), settings):
                    m['status'].add('choice')
                    continue
                if c['tag'] != 'ref-clip' and not src_ch:
                    m['status'].add('no-channels')
                    continue
                b = buckets.setdefault(id(c['el']), {'el': c['el'], 'lo': lo, 'hi': hi, 'spans': {}})
                for role in roles:
                    b['spans'].setdefault((role, src_ch), []).append((s, e))
                m['status'].add('muted')
        base += declared

    written = 0
    clips = 0
    for b in buckets.values():
        n_clip = 0
        for (role, src_ch) in sorted(b['spans']):
            ticks = [quantize_clamp(s, e, b['lo'], b['hi']) for (s, e) in b['spans'][(role, src_ch)]]
            ticks = merge_spans([t for t in ticks if t is not None])
            n_clip += write_mutes(b['el'], role, src_ch, ticks)
        written += n_clip
        clips += 1 if n_clip else 0
    return _report(matches, written, clips, removed, plan['labels'])


def _report(matches, written, clips, removed, labels):
    not_muted = []
    muted = 0
    by_choice = 0
    groups = {}
    for m in matches:
        st = m.get('status', set())
        for g in m['groups']:
            groups.setdefault(g, {'label': labels[g], 'found': 0, 'muted': 0})['found'] += 1
        if 'muted' in st:
            muted += 1
            for g in m['groups']:
                groups[g]['muted'] += 1
            continue
        if 'choice' in st:
            by_choice += 1
            continue
        if m['problem']:
            kind, why = 'failed', m['problem'][1]
        elif 'no-channels' in st:
            kind, why = 'failed', "the clip that plays it names no audio channels for a mute"
        elif 'off' in st:
            kind, why = 'switched-off', "that stretch of audio is already switched off on the timeline (mic mute)"
        else:
            kind, why = 'cut', "it is in a part of the recording that is not on the exported timeline (cut)"
        at = m['recordingTime']
        not_muted.append({'word': m['text'], 'at': clock(at) if isinstance(at, (int, float)) else None,
                          'seconds': at if isinstance(at, (int, float)) else None,
                          'track': m['trackLabel'], 'kind': kind, 'why': why})
    return {'active': True, 'matches': len(matches), 'muted': muted, 'leftByChoice': by_choice,
            'mutesWritten': written, 'clips': clips, 'removedOld': removed,
            'groups': groups, 'notMuted': not_muted}


def log_report(report, prefix='[word mutes]'):
    """One summary line and one line per word not muted, on stderr (the app's log)."""
    if not report.get('active'):
        print(f"{prefix} off for this project ({report.get('reason')})", file=sys.stderr)
        return
    print(f"{prefix} {report['matches']} matching word(s) in the transcript: {report['muted']} muted "
          f"with {report['mutesWritten']} mute(s) on {report['clips']} clip(s); "
          f"{report['leftByChoice']} left by the project's choice; {len(report['notMuted'])} not muted"
          + (f"; {report['removedOld']} earlier mute(s) replaced" if report['removedOld'] else ''),
          file=sys.stderr)
    for n in report['notMuted']:
        print(f"{prefix} NOT MUTED ({n['kind']}): {n['word']!r} at {n['at']} on {n['track']} — {n['why']}",
              file=sys.stderr)


def run_on_tree(zip_path, final_tree, window_mode, entry_hint='master'):
    """The whole pass for one exported tree: the project's saved choice, the transcript, the
    pristine master from the zip, the plan, the placement. Returns the report — {'active':
    False, 'reason'} when the project mutes nothing. Raises (loudly) when the project asks for
    mutes the session cannot supply."""
    from cli.editor_export import _load_transcript_sidecar, _parse_master_tree, _collect_parts
    from cli.editor_manifest import _session_name
    from core.word_mutes import load_catalog, load_settings, settings_path_for_zip
    session = _session_name(zip_path)
    try:
        catalog = load_catalog()
        settings = load_settings(settings_path_for_zip(zip_path, session), catalog)
    except WordMuteError as e:
        raise ManifestError(f"Mute words: {e}")
    if settings is None:
        report = {'active': False, 'reason': 'no Mute words choice saved for this project'}
        strip_mutes(final_tree.getroot())
        log_report(report)
        return report
    if not settings_active(settings):
        report = {'active': False, 'reason': 'nothing is selected in Mute words for this project'}
        report['removedOld'] = strip_mutes(final_tree.getroot())
        log_report(report)
        return report
    _zp, entry, pristine = _parse_master_tree(zip_path)
    _parts, frame_seconds, _total = _collect_parts(pristine.getroot(), entry)
    sidecar = _load_transcript_sidecar(zip_path, frame_seconds)
    if sidecar is None:
        raise ManifestError(
            "Mute words is on for this project, but the session has not been transcribed yet — "
            "the mutes are placed from the transcript's word times. Transcribe it first, or turn "
            "Mute words off for this project.")
    try:
        plan = plan_word_mutes(pristine, entry, sidecar, settings, catalog)
        report = apply_word_mutes(final_tree, plan, settings, window_mode,
                                  context=f"{session} {entry_hint}")
    except WordMuteError as e:
        raise ManifestError(f"Mute words: {e}")
    log_report(report)
    return report
