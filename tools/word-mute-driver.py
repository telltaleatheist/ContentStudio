#!/usr/bin/env python3
"""Offline checks for Mute words (LEDGER #226), driven by tools/word-mute-checks.js.

Synthetic data only — no media, no model, nothing of Owen's is read. Prints one line per check
("ok   <name>" / "FAIL <name>: <detail>") and a final JSON line {"passed":N,"failed":M}.

Mode 'validate' instead reads a JSON list of settings objects on stdin and prints, per item,
null (valid) or the error message — the JS side compares that with the main process's own
validator so the two cannot drift.
"""
import copy
import json
import os
import sys
import tempfile
import time
import zipfile
from fractions import Fraction
from pathlib import Path
import xml.etree.ElementTree as ET

BACKEND = Path(__file__).resolve().parent.parent / 'editor-backend'
sys.path.insert(0, str(BACKEND))

from core import word_mutes as wm  # noqa: E402
from cli import word_mute_pass as wp  # noqa: E402
from cli import editor_export as ex  # noqa: E402

CATALOG = wm.load_catalog()
FS = Fraction(1001, 30000)          # 29.97 frame
MIC = '/tmp/wm-check/session mic1_processed.wav'
SCREEN = '/tmp/wm-check/session screen_processed.wav'

results = {'passed': 0, 'failed': 0}


def check(name, cond, detail=''):
    if cond:
        results['passed'] += 1
        print(f"ok   {name}")
    else:
        results['failed'] += 1
        print(f"FAIL {name}: {detail}")


def settings(**over):
    s = {'schemaVersion': 1, 'groups': {g['id']: 'off' for g in CATALOG}, 'customWords': [],
         'customMode': 'off', 'openingWindow': {'allSwearing': False, 'minutes': 3}}
    for k, v in over.items():
        if k == 'groups':
            s['groups'].update(v)
        else:
            s[k] = v
    return wm.validate_settings(s, CATALOG)


def t(sec):
    """Seconds -> an FCPX time string on the 29.97 grid (sec must be a whole frame count * FS)."""
    return ex.format_time(Fraction(sec))


def frames(n):
    return n * FS


# ---------------------------------------------------------------------------
# A synthetic master shaped like master_project_generator.py:792-853 builds it
# ---------------------------------------------------------------------------
def build_master(segments, with_filter=False):
    """segments: [(timeline_offset, compound_start, duration)] in frames. The CAM compound r2
    holds the mic as the generator's clip/gap/audio shape (compound time == mic file time); the
    SSB compound r6 holds the screen audio the same way."""
    root = ET.Element('fcpxml', {'version': '1.14'})
    res = ET.SubElement(root, 'resources')
    ET.SubElement(res, 'format', {'id': 'r1', 'frameDuration': '1001/30000s', 'width': '1920', 'height': '1080'})
    ET.SubElement(res, 'asset', {'id': 'a1', 'name': 'mic1', 'start': '0s', 'duration': '3600s', 'hasAudio': '1'}).append(
        ET.Element('media-rep', {'kind': 'original-media', 'src': 'file://' + MIC.replace(' ', '%20')}))
    ET.SubElement(res, 'asset', {'id': 'a2', 'name': 'screen', 'start': '0s', 'duration': '3600s', 'hasAudio': '1'}).append(
        ET.Element('media-rep', {'kind': 'original-media', 'src': 'file://' + SCREEN.replace(' ', '%20')}))
    for mid, aid in (('r2', 'a1'), ('r6', 'a2')):
        media = ET.SubElement(res, 'media', {'id': mid, 'name': mid})
        seq = ET.SubElement(media, 'sequence', {'format': 'r1', 'duration': '3600s'})
        spine = ET.SubElement(seq, 'spine')
        gap = ET.SubElement(spine, 'gap', {'name': 'Gap', 'offset': '0s', 'duration': '3600s'})
        clip = ET.SubElement(gap, 'clip', {'lane': '-2', 'offset': '0s', 'name': aid, 'duration': '3600s'})
        ET.SubElement(clip, 'adjust-volume', {'amount': '0dB'})
        g2 = ET.SubElement(clip, 'gap', {'name': 'Gap', 'offset': '0s', 'duration': '3600s'})
        ET.SubElement(g2, 'audio', {'ref': aid, 'lane': '-1', 'offset': '0s', 'duration': '3600s',
                                    'role': 'dialogue.dialogue-1', 'srcCh': '1, 2'})
        acs = ET.SubElement(clip, 'audio-channel-source', {'srcCh': '1, 2', 'role': 'dialogue.dialogue-1'})
        ET.SubElement(acs, 'adjust-voiceIsolation', {'amount': '75'})
    lib = ET.SubElement(root, 'library')
    ev = ET.SubElement(lib, 'event', {'name': 'Auto-Editor Media Group'})
    total = sum(d for (_o, _s, d) in segments)
    proj = ET.SubElement(ev, 'project', {'name': 'session hybrid part 1'})
    seq = ET.SubElement(proj, 'sequence', {'format': 'r1', 'duration': t(frames(total))})
    spine = ET.SubElement(seq, 'spine')
    for (off, st, dur) in segments:
        main = ET.SubElement(spine, 'ref-clip', {'ref': 'r2', 'offset': t(frames(off)), 'name': 'CAM',
                                                 'duration': t(frames(dur)), 'srcEnable': 'video', 'start': t(frames(st))})
        cam = ET.SubElement(main, 'ref-clip', {'ref': 'r2', 'lane': '-1', 'offset': t(frames(st)), 'name': 'CAM',
                                               'duration': t(frames(dur)), 'srcEnable': 'audio', 'start': t(frames(st))})
        if with_filter:
            ET.SubElement(cam, 'filter-audio', {'ref': 'rX', 'name': 'Compressor'})
        ET.SubElement(main, 'ref-clip', {'ref': 'r6', 'lane': '-2', 'offset': t(frames(st)), 'name': 'SSB',
                                         'duration': t(frames(dur)), 'srcEnable': 'audio', 'start': t(frames(st))})
    return ET.ElementTree(root)


def sidecar(words):
    """words: [(text, track, fileStart, fileEnd)] in seconds."""
    return {'schemaVersion': 1, 'frameSeconds': float(FS),
            'tracks': [{'id': 't0', 'label': 'mic1', 'file': MIC}, {'id': 't1', 'label': 'screen', 'file': SCREEN}],
            'words': [{'track': tr, 'text': tx, 'fileStart': a, 'fileEnd': b, 'timelineStart': a}
                      for (tx, tr, a, b) in words]}


def mutes_on(tree, lane='-1', ref='r2'):
    """[(clip start seconds, [(mute start, mute end)])] for every lane clip, in document order."""
    out = []
    for c in tree.getroot().iter('ref-clip'):
        if c.get('lane') != lane or c.get('ref') != ref:
            continue
        ms = []
        for ars in c.findall('audio-role-source'):
            for m in ars.findall('mute'):
                a = ex.parse_rational(m.get('start'), 's')
                ms.append((a, a + ex.parse_rational(m.get('duration'), 'd')))
        out.append((ex.parse_rational(c.get('start', '0s'), 's'), ms))
    return out


def near(a, b, tol=Fraction(1, 720000)):
    return abs(Fraction(a) - Fraction(b)) <= tol


PAD = wm.MUTE_PAD_SECONDS


# ---------------------------------------------------------------------------
# 1. the matcher
# ---------------------------------------------------------------------------
def check_matcher():
    s = settings(customWords=['bs*', 'frick'], customMode='everywhere')
    cases = {
        'fuck': ['f-word'], 'Fucking,': ['f-word'], 'MOTHERFUCKER!': ['f-word'], "fuckin'": ['f-word'],
        'fucked.': ['f-word'], '“fuck”': ['f-word'], 'shit': ['swearing'], 'bullshit': ['swearing'],
        'ass': ['swearing'], 'class': [], 'assess': [], 'dumb-ass': ['swearing'], 'Dickens': [],
        'raccoon': [], 'bsing': ['custom'], 'frick': ['custom'], 'fricking': [], 'um': [], 'uh': [],
        'hello': [],
    }
    bad = {w: (wm.match_groups(w, CATALOG, s), exp) for w, exp in cases.items()
           if wm.match_groups(w, CATALOG, s) != exp}
    check('matcher: F-word family, whole-word swearing, hyphen parts, custom wildcards, no false hits',
          not bad, bad)
    check('matcher: the harsh group is in the data file and matches by its own words',
          any(g['id'] == 'harsh' for g in CATALOG) and wm.match_groups(CATALOG[1]['contains'][0] + 's', CATALOG, s) == ['harsh'])
    check('seam: um/uh are in no mute group (filler removal is a later, separate word set)',
          not wm.match_groups('um', CATALOG, s) and not wm.match_groups('uh', CATALOG, s))


# ---------------------------------------------------------------------------
# 2. the rule (group modes + opening window, on master time)
# ---------------------------------------------------------------------------
def check_rule():
    s = settings(groups={'f-word': 'everywhere', 'swearing': 'opening', 'harsh': 'off'},
                 openingWindow={'allSwearing': False, 'minutes': 3})
    check('rule: everywhere mutes at any time', wm.muted_at(['f-word'], 5000, s) and wm.muted_at(['f-word'], 1, s))
    check('rule: opening-only mutes inside the window, not after',
          wm.muted_at(['swearing'], 179, s) and not wm.muted_at(['swearing'], 180, s))
    check('rule: an off group is not muted, even in the window, without "all swearing"',
          not wm.muted_at(['harsh'], 10, s))
    s2 = settings(groups={'f-word': 'everywhere'}, customWords=['heck'],
                  openingWindow={'allSwearing': True, 'minutes': 3})
    check('rule: "all swearing in the first N minutes" mutes every group and the custom words inside the window',
          wm.muted_at(['harsh'], 10, s2) and wm.muted_at(['custom'], 10, s2) and wm.muted_at(['swearing'], 179.9, s2))
    check('rule: after the window only "everywhere" groups stay muted',
          not wm.muted_at(['harsh'], 181, s2) and wm.muted_at(['f-word'], 181, s2))
    s3 = settings(openingWindow={'allSwearing': True, 'minutes': 0.5})
    check('rule: the window length is the saved minutes value', wm.muted_at(['swearing'], 29, s3) and not wm.muted_at(['swearing'], 30, s3))


# ---------------------------------------------------------------------------
# 3. padding, clamp, merge, format
# ---------------------------------------------------------------------------
def check_numbers():
    a, b = wm.pad_span(Fraction(2), Fraction(3))
    check('pad: 50 ms each side by default', a == Fraction(195, 100) and b == Fraction(305, 100), (a, b))
    check('pad: never before 0', wm.pad_span(Fraction(1, 100), Fraction(1, 10))[0] == 0)
    check('clamp: a mute is clipped to the clip\'s own source range',
          wm.quantize_clamp(Fraction(9), Fraction(11), Fraction(10), Fraction(20)) == (7200000, 7920000))
    check('clamp: nothing left outside the clip', wm.quantize_clamp(Fraction(1), Fraction(2), Fraction(10), Fraction(20)) is None)
    check('quantize: rounds outward on the 720000 grid',
          wm.quantize_clamp(Fraction(1, 3), Fraction(2, 3), 0, 10) == (240000, 480000)
          and wm.quantize_clamp(Fraction(1000001, 3000000), Fraction(1999999, 3000000), 0, 10) == (240000, 480000))
    check('merge: overlapping and touching mutes become one; apart stay apart',
          wm.merge_spans([(5, 6), (1, 2), (2, 3), (2.5, 4), (7, 8)]) == [(1, 4), (5, 6), (7, 8)])
    check('format: FCP\'s own unreduced N/720000s, 0s for zero',
          wm.format_ticks(15918331) == '15918331/720000s' and wm.format_ticks(0) == '0s' and wm.format_ticks(360000) == '360000/720000s')


# ---------------------------------------------------------------------------
# 4. time mapping through the cut table, on the master's own clips
# ---------------------------------------------------------------------------
# Two auto-editor segments: timeline [0, 600f) plays compound [300f, 900f); timeline [600f, 1500f)
# plays compound [1200f, 2100f). Compound time == mic file time. Auto-editor removed [900f, 1200f).
SEGS = [(0, 300, 600), (600, 1200, 900)]


def fsec(fr):
    return float(frames(fr))


def check_mapping():
    s = settings(groups={'f-word': 'everywhere', 'swearing': 'everywhere'})
    w_plain = ('fuck', 't0', fsec(360), fsec(372))              # compound 360f..372f -> clip 1
    w_span = ('fucking', 't0', fsec(890), fsec(1210))           # starts before the removed stretch, ends after it
    w_gone = ('motherfucker', 't0', fsec(1000), fsec(1012))     # inside what auto-editor removed
    w_screen = ('shit', 't1', fsec(1500), fsec(1512))            # screen audio -> the SSB clip
    master = build_master(SEGS)
    sc = sidecar([w_plain, w_span, w_gone, w_screen])
    plan = wp.plan_word_mutes(master, 'master', sc, s, CATALOG)
    final = copy.deepcopy(master)
    rep = wp.apply_word_mutes(final, plan, s, 'plain')
    cam = mutes_on(final)
    c1 = cam[0][1]
    c2 = cam[1][1]
    check('map: a word lands on the lane -1 mic clip in that clip\'s SOURCE time (not timeline time)',
          any(near(a, frames(360) - PAD) and near(b, frames(372) + PAD) for (a, b) in c1), c1)
    check('map: a word spanning an auto-editor cut is muted on BOTH sides (clamped at each clip edge)',
          any(near(a, frames(890) - PAD) and near(b, frames(900)) for (a, b) in c1)
          and any(near(a, frames(1200)) and near(b, frames(1210) + PAD) for (a, b) in c2), (c1, c2))
    gone = [n for n in rep['notMuted'] if n['word'] == 'motherfucker']
    check('map: a word in a stretch auto-editor removed writes no mute and is reported, with its time and why',
          gone and gone[0]['kind'] == 'failed' and 'auto-editor removed' in gone[0]['why'] and gone[0]['at'] is not None, rep['notMuted'])
    ssb = mutes_on(final, '-2', 'r6')
    check('map: a screen-audio word lands on the screen clip (lane -2), not the mic clip',
          any(ms for (_st, ms) in ssb) and not any(near(a, frames(1500) - PAD) for (a, _b) in c2), ssb)
    check('report: counts matches, muted words and mutes written',
          rep['matches'] == 4 and rep['muted'] == 3 and rep['mutesWritten'] == 4, rep)

    # An EDITOR cut through the middle of a word, and one that swallows a word whole.
    w_mid = ('fuck', 't0', fsec(390), fsec(402))                # timeline 90f..102f
    w_cut = ('fuck', 't0', fsec(500), fsec(506))                # timeline 200f..206f, cut entirely
    sc2 = sidecar([w_mid, w_cut])
    plan2 = wp.plan_word_mutes(master, 'master', sc2, s, CATALOG)
    final2 = copy.deepcopy(master)
    ex.apply_cuts(final2, 'master', [{'startFrame': 95, 'endFrame': 98}, {'startFrame': 190, 'endFrame': 220}])
    rep2 = wp.apply_word_mutes(final2, plan2, s, 'plain')
    pieces = mutes_on(final2)
    flat = [(st, m) for (st, ms) in pieces for m in ms]
    check('editor cut through a word: the parts on both sides of the cut are muted, each in its own clip piece',
          any(near(m[0], frames(390) - PAD) and near(m[1], frames(395)) for (_st, m) in flat)
          and any(near(m[0], frames(398)) and near(m[1], frames(402) + PAD) for (_st, m) in flat), flat)
    cut = [n for n in rep2['notMuted'] if n['kind'] == 'cut']
    check('editor cut over a whole word: no mute, and the word is listed as cut',
          len(cut) == 1 and rep2['muted'] == 1, rep2)
    ok_bounds = all(st <= m[0] and m[1] <= st + ex.parse_rational(c.get('duration'), 'd')
                    for c in final2.getroot().iter('ref-clip') if c.get('lane') == '-1'
                    for st in [ex.parse_rational(c.get('start', '0s'), 's')]
                    for ars in c.findall('audio-role-source') for mm in ars.findall('mute')
                    for m in [(ex.parse_rational(mm.get('start'), 's'),
                               ex.parse_rational(mm.get('start'), 's') + ex.parse_rational(mm.get('duration'), 'd'))])
    check('clamp: every mute sits inside its clip piece\'s source range', ok_bounds)

    # Two words close together merge into one mute.
    sc3 = sidecar([('fuck', 't0', fsec(360), fsec(366)), ('fucking', 't0', fsec(368), fsec(378))])
    final3 = copy.deepcopy(master)
    wp.apply_word_mutes(final3, wp.plan_word_mutes(master, 'master', sc3, s, CATALOG), s, 'plain')
    m3 = mutes_on(final3)[0][1]
    check('merge: two padded words that overlap are written as ONE mute', len(m3) == 1, m3)


# ---------------------------------------------------------------------------
# 5. the opening window follows the EXPORTED timeline, and group modes
# ---------------------------------------------------------------------------
def check_window():
    master = build_master(SEGS)
    # "damn" at compound 1510f -> original timeline 910f (30.36 s; 30.31 s with its padding).
    # Window 0.5 min = 30 s. The rule is judged where the mute would START on the master timeline.
    w = ('damn', 't0', fsec(1510), fsec(1516))
    s = settings(groups={'swearing': 'opening'}, openingWindow={'allSwearing': False, 'minutes': 0.5})
    plan = wp.plan_word_mutes(master, 'master', sidecar([w]), s, CATALOG)
    f1 = copy.deepcopy(master)
    r1 = wp.apply_word_mutes(f1, plan, s, 'plain')
    check('window: a word just after 0:30 on an uncut timeline is left (by the choice, not an error)',
          r1['muted'] == 0 and r1['leftByChoice'] == 1 and not r1['notMuted'], r1)
    f2 = copy.deepcopy(master)
    ex.apply_cuts(f2, 'master', [{'startFrame': 100, 'endFrame': 160}])   # 2 s cut before it
    plan2 = wp.plan_word_mutes(master, 'master', sidecar([w]), s, CATALOG)
    r2 = wp.apply_word_mutes(f2, plan2, s, 'plain')
    check('window: the same word after a 2 s cut earlier is at 0:28 on the MASTER timeline, so it is muted',
          r2['muted'] == 1, r2)
    s_off = settings(groups={'swearing': 'off'}, openingWindow={'allSwearing': True, 'minutes': 0.5})
    f3 = copy.deepcopy(master)
    ex.apply_cuts(f3, 'master', [{'startFrame': 100, 'endFrame': 160}])
    r3 = wp.apply_word_mutes(f3, wp.plan_word_mutes(master, 'master', sidecar([w]), s_off, CATALOG), s_off, 'plain')
    check('window: "all swearing" mutes an OFF group inside the window', r3['muted'] == 1, r3)
    s_none = settings()
    check('settings: nothing selected is inactive; any group or the window makes it active',
          not wm.settings_active(s_none) and wm.settings_active(s) and wm.settings_active(s_off))


# ---------------------------------------------------------------------------
# 6. the XML: DTD placement on a ref-clip, and the sample's exact structure on a clip
# ---------------------------------------------------------------------------
SAMPLE_PROJECT = """<project name="clips"><sequence format="r1" duration="39500/3000s" tcStart="0s" tcFormat="NDF" audioLayout="stereo" audioRate="48k"><spine>
<clip offset="0s" name="2026-09-24 master" start="571571/30000s" duration="39500/3000s" format="r2" tcFormat="NDF">
<conform-rate srcFrameRate="29.97"/>
<video ref="r3" offset="0s" duration="420431011/30000s"/>
<clip lane="-1" offset="571571/30000s" name="2026-09-24 master" start="571571/30000s" duration="39500/3000s" tcFormat="NDF">
<conform-rate srcFrameRate="29.97"/>
<gap name="Gap" offset="0s" duration="420431011/30000s">
<audio ref="r3" lane="-1" offset="0s" duration="10090368264/720000s" role="dialogue.dialogue-1" srcCh="1, 2"/>
</gap>
<audio-channel-source srcCh="1, 2" role="dialogue.dialogue-1">
<mute start="15918331/720000s" duration="436401/720000s"/>
</audio-channel-source>
</clip>
</clip>
</spine></sequence></project>"""
SAMPLE_FILE = '/tmp/wm-check/2026-09-24 master.mp4'


def sample_tree(with_mute):
    root = ET.Element('fcpxml', {'version': '1.14'})
    res = ET.SubElement(root, 'resources')
    ET.SubElement(res, 'format', {'id': 'r1', 'frameDuration': '100/3000s'})
    ET.SubElement(res, 'format', {'id': 'r2', 'frameDuration': '1001/30000s'})
    ET.SubElement(res, 'asset', {'id': 'r3', 'name': '2026-09-24 master', 'start': '0s', 'hasAudio': '1'}).append(
        ET.Element('media-rep', {'kind': 'original-media', 'src': 'file://' + SAMPLE_FILE.replace(' ', '%20')}))
    ev = ET.SubElement(ET.SubElement(root, 'library'), 'event', {'name': '1 - raw footage'})
    proj = ET.fromstring(SAMPLE_PROJECT)
    if not with_mute:
        for acs in proj.iter('audio-channel-source'):
            for m in list(acs):
                acs.remove(m)
        for parent in proj.iter():
            for acs in [c for c in parent if c.tag == 'audio-channel-source']:
                parent.remove(acs)
    ev.append(proj)
    return ET.ElementTree(root)


def shape(el):
    return (el.tag, dict(el.attrib), [shape(c) for c in el])


def check_xml():
    # A ref-clip that already has a filter: the container goes after anchored clips, before filters.
    master = build_master(SEGS, with_filter=True)
    s = settings(groups={'f-word': 'everywhere'})
    final = copy.deepcopy(master)
    wp.apply_word_mutes(final, wp.plan_word_mutes(master, 'master', sidecar([('fuck', 't0', fsec(360), fsec(372))]), s, CATALOG), s, 'plain')
    cam = [c for c in final.getroot().iter('ref-clip') if c.get('lane') == '-1'][0]
    tags = [c.tag for c in cam]
    ars = cam.find('audio-role-source')
    check('xml: on a ref-clip the mute goes in <audio-role-source role=...>, placed before filter-audio (DTD order)',
          tags == ['audio-role-source', 'filter-audio'] and ars.get('role') == 'dialogue.dialogue-1'
          and [c.tag for c in ars] == ['mute'] and set(ars[0].attrib) == {'start', 'duration'}, tags)
    check('xml: nothing is written inside a compound <media> (the mutes are on the master timeline only)',
          not any(e.tag == 'mute' for m in final.getroot().iter('media') for e in m.iter()))

    # The sample: rebuild Owen's R+V mute from a word, on a tree identical to his minus the mute.
    tb = 720000
    fs_ = (Fraction(15918331) + Fraction(4, 10)) / tb + wm.MUTE_PAD_SECONDS
    fe_ = (Fraction(15918331 + 436401) - Fraction(4, 10)) / tb - wm.MUTE_PAD_SECONDS
    sc = {'schemaVersion': 1, 'frameSeconds': 0.1, 'tracks': [{'id': 't0', 'label': 'master', 'file': SAMPLE_FILE}],
          'words': [{'track': 't0', 'text': 'fucking', 'fileStart': float(fs_), 'fileEnd': float(fe_), 'timelineStart': 3.06}]}
    bare = sample_tree(False)
    plan = wp.plan_word_mutes(bare, 'sample', sc, s, CATALOG)
    out = copy.deepcopy(bare)
    rep = wp.apply_word_mutes(out, plan, s, 'plain')
    got = out.getroot().find('.//project')
    want = sample_tree(True).getroot().find('.//project')
    check('xml: from a word, the pass rebuilds Owen\'s sample EXACTLY — <audio-channel-source srcCh="1, 2" '
          'role="dialogue.dialogue-1"><mute start="15918331/720000s" duration="436401/720000s"/> after the '
          'lane -1 clip\'s gap, in that clip\'s source time',
          shape(got) == shape(want) and rep['mutesWritten'] == 1, ET.tostring(got.find('.//clip/clip'), encoding='unicode'))
    again = copy.deepcopy(out)
    rep2 = wp.apply_word_mutes(again, wp.plan_word_mutes(bare, 'sample', sc, s, CATALOG), s, 'plain')
    check('xml: applying again replaces the earlier mute instead of adding a second one',
          shape(again.getroot()) == shape(out.getroot()) and rep2['removedOld'] == 1, rep2)


# ---------------------------------------------------------------------------
# 7. end to end through the export and the Apply command, on a synthetic zip
# ---------------------------------------------------------------------------
def check_end_to_end():
    from cli import mute_words as mw
    d = Path(tempfile.mkdtemp(prefix='wm-check-'))
    try:
        clean = 'wmcheck'
        master = build_master(SEGS)
        xml_path = d / 'm.fcpxml'
        master.write(str(xml_path), encoding='utf-8', xml_declaration=True)
        zp = d / f"{clean}_compounds.zip"
        with zipfile.ZipFile(zp, 'w') as z:
            z.write(xml_path, f"{clean}/{clean} master.fcpxml")
        s = settings(groups={'f-word': 'everywhere'})
        sc = sidecar([('fuck', 't0', fsec(360), fsec(372)), ('fucked', 't0', fsec(1300), fsec(1310))])
        (d / f"{clean}_transcript.json").write_text(json.dumps(sc))

        res0 = ex.export(str(zp), [], None, False)
        check('export: a project with no Mute words choice exports with wordMutes.active false, and says why',
              res0['wordMutes'] == {'active': False, 'reason': 'no Mute words choice saved for this project'}, res0.get('wordMutes'))

        (d / f"{clean}_mute-words.json").write_text(json.dumps(s))
        res = ex.export(str(zp), [], None, False)
        out = Path(res['path'])
        check('export: the master FCPXML export writes the mutes and reports them',
              res['wordMutes']['muted'] == 2 and res['wordMutes']['mutesWritten'] == 2
              and out.read_text().count('<mute ') == 2, res['wordMutes'])
        time.sleep(0.01)
        before = out.read_text()
        r1 = mw.apply_to_export(str(zp))
        r2 = mw.apply_to_export(str(zp))
        check('apply: re-applying to the exported timeline twice gives the same file (earlier mutes replaced)',
              out.read_text() == before and r2['wordMutes']['removedOld'] == 2 and r1['wordMutes']['mutesWritten'] == 2)
        (d / f"{clean}_mute-words.json").write_text(json.dumps(settings()))
        r3 = mw.apply_to_export(str(zp))
        check('apply: choosing nothing and applying removes the mutes and says so',
              r3['wordMutes']['active'] is False and out.read_text().count('<mute ') == 0, r3)
        (d / f"{clean}_transcript.json").unlink()
        (d / f"{clean}_mute-words.json").write_text(json.dumps(s))
        try:
            ex.export(str(zp), [], None, False)
            check('export: Mute words on but no transcript refuses loudly', False, 'no error raised')
        except ex.ManifestError as e:
            check('export: Mute words on but no transcript refuses loudly', 'not been transcribed' in str(e), str(e))
        out.unlink()
        try:
            mw.apply_to_export(str(zp))
            check('apply: no exported timeline yet refuses loudly and says to export', False, 'no error raised')
        except ex.ManifestError as e:
            check('apply: no exported timeline yet refuses loudly and says to export', 'has not been exported yet' in str(e), str(e))
    finally:
        for p in sorted(d.rglob('*'), reverse=True):
            p.unlink() if p.is_file() else p.rmdir()
        d.rmdir()


def validate_mode():
    items = json.loads(sys.stdin.read())
    out = []
    for it in items:
        try:
            wm.validate_settings(it, CATALOG)
            out.append(None)
        except wm.WordMuteError as e:
            out.append(str(e))
    print(json.dumps(out))


if __name__ == '__main__':
    if len(sys.argv) > 1 and sys.argv[1] == 'validate':
        validate_mode()
        sys.exit(0)
    for fn in (check_matcher, check_rule, check_numbers, check_mapping, check_window, check_xml, check_end_to_end):
        try:
            fn()
        except Exception as e:  # a crash is a failed check, named
            import traceback
            traceback.print_exc()
            check(fn.__name__, False, f"{type(e).__name__}: {e}")
    print(json.dumps(results))
    sys.exit(1 if results['failed'] else 0)
