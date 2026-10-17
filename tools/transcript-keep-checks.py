"""check:transcript-keep: "Use existing transcript" across a re-process (LEDGER #315).

Offline and pure: synthetic sidecars, alignments and stand-in zips in a temp folder, with
transcribe.discover_tracks stubbed to hand back the cut list each zip stands for. No ffmpeg, no
Crucible, no session. Covers the re-place (unchanged cuts give the identical file, changed cuts
move words and drop the ones now in a cut, a moved sync offset shifts words by exactly the trim
difference), every refusal (missing or new track, drift or speed change, one-sided alignment),
and the keep/replace/restore steps on disk (a failed or cancelled run puts the original back
byte-for-byte; a refusal leaves the kept folder whole).

    python3 tools/transcript-keep-checks.py
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'editor-backend'))
from cli import transcribe as T  # noqa: E402
from cli import transcript_keep as K  # noqa: E402
from core import sync_offset as S  # noqa: E402

passed = 0
failed = 0


def check(name, fn):
    global passed, failed
    try:
        fn()
        passed += 1
        print(f"  ok   {name}")
    except Exception as e:  # report every failure, then exit non-zero
        failed += 1
        print(f"  FAIL {name}: {type(e).__name__}: {e}")


def eq(a, b, what=''):
    if a != b:
        raise AssertionError(f"{what} expected {b!r}, got {a!r}")


def near(a, b, what='', tol=1e-9):
    if abs(a - b) > tol:
        raise AssertionError(f"{what} expected {b!r}, got {a!r}")


def refuses(fn, *needles):
    try:
        fn()
    except K.KeepError as e:
        for n in needles:
            if n not in str(e):
                raise AssertionError(f"refusal {str(e)!r} does not mention {n!r}")
        return
    raise AssertionError('expected a KeepError, nothing was raised')


FRAME = 1001 / 30000
MIC = '/w/s mic audio_processed.wav'
SCREEN = '/w/s screen audio_processed.wav'


def seg(group, src, dur, tl):
    return {'group': group, 'source_start': src, 'source_end': src + dur, 'timeline_start': tl}


def tracks(cuts):
    """cuts: {file: [(src, dur), ...]} laid end to end on the timeline, in that order."""
    out = []
    for i, (f, spans) in enumerate(cuts.items()):
        tl, segs = 0.0, []
        for g, (src, dur) in enumerate(spans):
            segs.append(seg(g, src, dur, tl))
            tl += dur
        label = os.path.basename(f)[2:-4]
        out.append({'id': f"t{i}", 'label': label, 'file': f, 'segments': segs})
    return out


OLD_CUTS = {MIC: [(0.0, 10.0), (20.0, 10.0)], SCREEN: [(0.0, 10.0), (20.0, 10.0)]}
FILE_WORDS = {
    MIC: [('hello', 1.0, 1.4), ('there', 5.0, 5.3), ('again', 22.0, 22.5), ('late', 28.0, 28.4)],
    SCREEN: [('game', 2.0, 2.2), ('over', 25.0, 25.6)],
}


def made_transcript(cuts, model='crucible:mac:qwen3-asr-1.7b'):
    """What transcribe.py writes for these words over these cuts (its own map + sort)."""
    ts = tracks(cuts)
    words = []
    for t in ts:
        fw = [{'text': x, 'fileStart': s, 'fileEnd': e} for x, s, e in FILE_WORDS[t['file']]]
        words.extend(T.map_file_words(t, fw))
    order = {t['id']: i for i, t in enumerate(ts)}
    words.sort(key=lambda w: (order[w['track']], w['fileStart']))
    return {'schemaVersion': 1, 'session': 's', 'model': model, 'calibration': 'none',
            'frameSeconds': FRAME,
            'tracks': [{'id': t['id'], 'label': t['label'], 'file': t['file']} for t in ts],
            'words': words}


def alignment(mic_off=0.25, screen_off=-0.1, named=True, **extra):
    srcs = []
    for typ, f, off in (('mic1', MIC, mic_off), ('screen', SCREEN, screen_off)):
        e = {'kind': 'audio', 'type': typ, 'offsetSeconds': off, 'driftFactor': None,
             'method': 'gcc-phat', 'speedFactor': 1.0}
        if named:
            e['processedFile'] = f
        e.update(extra.get(typ, {}))
        srcs.append(e)
    srcs.append({'kind': 'video', 'type': 'cam1', 'offsetSeconds': 3.0, 'driftFactor': None,
                 'method': 'gcc-phat'})
    return {'schemaVersion': 1, 'masterVideo': '/w/s master.mp4', 'sources': srcs}


def segments_of(cuts):
    return lambda: {os.path.basename(t['file']): t['segments'] for t in tracks(cuts)}


def run(old_cuts, new_cuts, old_al=None, new_al=None, old=None):
    old = old if old is not None else made_transcript(old_cuts)
    return K.replace_words(old, 's', FRAME, tracks(new_cuts), segments_of(old_cuts),
                           old_al if old_al is not None else alignment(),
                           new_al if new_al is not None else alignment())


# ── the re-place ────────────────────────────────────────────────────────────

def unchanged_identical():
    old = made_transcript(OLD_CUTS)
    sidecar, report = run(OLD_CUTS, OLD_CUTS, old=json.loads(json.dumps(old)))
    eq(sidecar, old, 'sidecar')
    eq(json.dumps(sidecar), json.dumps(old), 'serialised bytes')
    eq([r['droppedInCuts'] for r in report], [0, 0], 'drops')


def changed_cuts_replace():
    # The mic's second span now starts later (a pause at 20-23 was cut) and the timeline closes
    # up: "again" (22.0) is now in a cut; "late" moves from 18.0 to 10 + (28 - 23) = 15.0.
    new_cuts = {MIC: [(0.0, 10.0), (23.0, 7.0)], SCREEN: [(0.0, 10.0), (20.0, 10.0)]}
    sidecar, report = run(OLD_CUTS, new_cuts)
    mic = [w for w in sidecar['words'] if w['track'] == 't0']
    eq([w['text'] for w in mic], ['hello', 'there', 'late'], 'mic words')
    late = mic[2]
    near(late['timelineStart'], 15.0, 'late timelineStart')
    near(late['fileStart'], 28.0, 'late fileStart (file time unchanged)')
    eq(late['group'], 1, 'late group')
    eq(report[0]['droppedInCuts'], 1, 'mic drops')
    eq(report[1]['droppedInCuts'], 0, 'screen drops')
    # Every word lands exactly where a fresh transcription over the new cuts would put it.
    fresh = made_transcript(new_cuts)
    eq(sidecar['words'], fresh['words'], 'same as a fresh map over the new cuts')


def newly_kept_reported():
    # The new cut list keeps 10-20 on the mic, which the transcript's cut list had removed.
    new_cuts = {MIC: [(0.0, 30.0)], SCREEN: [(0.0, 10.0), (20.0, 10.0)]}
    _sc, report = run(OLD_CUTS, new_cuts)
    near(report[0]['uncoveredSeconds'], 10.0, 'mic newly kept seconds')
    eq(report[1]['uncoveredSeconds'], 0.0, 'screen newly kept seconds')


def trim_model(offset, raw_t, rate=1000):
    """Where a moment of the raw file lands once offset_filter's filter is applied, worked out
    from the filter text the way ffmpeg applies it (adelay pads, atrim drops from the start)."""
    af = S.offset_filter(offset)
    n = round(raw_t * rate)
    if af is None:
        return n / rate
    if af.startswith('adelay='):
        ms = int(af.split('=')[1].split('|')[0])
        return (n + ms * rate // 1000) / rate
    start = float(af.split('=')[-1])
    return (n - round(start * rate)) / rate


def shift_sign_proven():
    for old_off, new_off in ((0.25, 0.55), (0.55, 0.25), (-0.1, 0.3), (0.3, -0.4), (0.0005, 0.2),
                             (0.2377, 0.2371)):
        for raw in (3.0, 12.345):
            old_file = trim_model(old_off, raw)
            new_file = trim_model(new_off, raw)
            shift = S.applied_offset_seconds(new_off) - S.applied_offset_seconds(old_off)
            near(old_file + shift, new_file, f"offset {old_off}->{new_off} raw {raw}", tol=1e-6)


def offset_shift_replaces():
    # Mic re-aligned from +0.25 s to +0.55 s: every mic moment is 0.3 s later in the new file.
    _sc, base = run(OLD_CUTS, OLD_CUTS)
    sidecar, report = run(OLD_CUTS, OLD_CUTS, new_al=alignment(mic_off=0.55))
    near(report[0]['shiftSeconds'], 0.3, 'mic shift', tol=1e-9)
    eq(report[1]['shiftSeconds'], 0.0, 'screen shift')
    old = made_transcript(OLD_CUTS)
    old_mic = [w for w in old['words'] if w['track'] == 't0']
    new_mic = [w for w in sidecar['words'] if w['track'] == 't0']
    eq(len(new_mic), len(old_mic), 'mic word count')
    for o, n in zip(old_mic, new_mic):
        near(n['fileStart'], o['fileStart'] + 0.3, f"{o['text']} fileStart", tol=1e-9)
        near(n['timelineStart'], o['timelineStart'] + 0.3, f"{o['text']} timelineStart", tol=1e-9)
    old_screen = [w for w in old['words'] if w['track'] == 't1']
    eq([w for w in sidecar['words'] if w['track'] == 't1'], old_screen, 'screen untouched')


def offset_shift_into_cut():
    # Shift -6: "hello" (1.0) and "there" (5.0) land before the file starts, "again" (22.0)
    # lands at 16.0 in the 10-20 cut; only "late" (28.0 -> 22.0) is still kept.
    _sc, report = run(OLD_CUTS, OLD_CUTS, old_al=alignment(mic_off=6.0),
                      new_al=alignment(mic_off=0.0))
    near(report[0]['shiftSeconds'], -6.0, 'shift')
    eq(report[0]['droppedInCuts'], 3, 'mic drops')
    eq(report[0]['placed'], 1, 'mic placed')


def legacy_alignment_by_type():
    _sc, report = run(OLD_CUTS, OLD_CUTS, old_al=alignment(mic_off=0.1, named=False),
                      new_al=alignment(mic_off=0.4))
    near(report[0]['shiftSeconds'], 0.3, 'legacy pairing shift', tol=1e-9)


def reused_not_moved():
    new_al = alignment(mic1={'method': 'reused-from-previous-run', 'driftFactor': None})
    old_al = alignment(mic1={'method': 'manual-override', 'driftFactor': 1.0002})
    _sc, report = run(OLD_CUTS, OLD_CUTS, old_al=old_al, new_al=new_al)
    eq(report[0]['shiftSeconds'], 0.0, 'reused shift')


def refusals():
    refuses(lambda: run(OLD_CUTS, {MIC: OLD_CUTS[MIC]}), 'track t1', 'screen audio_processed',
            'not in the rebuilt session', 'Re-transcribe')
    refuses(lambda: run({MIC: OLD_CUTS[MIC]}, OLD_CUTS, old=made_transcript({MIC: OLD_CUTS[MIC]})),
            'screen audio_processed', 'is new in the rebuilt session', 'Re-transcribe')
    refuses(lambda: run(OLD_CUTS, OLD_CUTS, new_al=alignment(mic1={'driftFactor': 1.0001})),
            'track t0', 'clock-drift factor changed', 'Re-transcribe')
    refuses(lambda: run(OLD_CUTS, OLD_CUTS, new_al=alignment(mic1={'speedFactor': 1.00001})),
            'speed factor changed', 'Re-transcribe')
    legacy_old = alignment(named=False)
    for e in legacy_old['sources']:
        e.pop('speedFactor', None)
    refuses(lambda: run(OLD_CUTS, OLD_CUTS, old_al=legacy_old,
                        new_al=alignment(mic_off=0.3, mic1={'speedFactor': 1.00001,
                                                            'method': 'unified-soundboard'})),
            'does not record the speed', 'Re-transcribe')
    one_sided = alignment()
    one_sided['sources'] = [s for s in one_sided['sources'] if s.get('type') != 'screen']
    refuses(lambda: run(OLD_CUTS, OLD_CUTS, new_al=one_sided), 'track t1',
            'aligned by only one of the two runs', 'Re-transcribe')
    refuses(lambda: run(OLD_CUTS, OLD_CUTS, new_al=alignment(mic1={'method': 'mystery'})),
            "'mystery'", 'Re-transcribe')
    odd = made_transcript(OLD_CUTS)
    odd['words'][0]['speaker'] = 'HOST'
    refuses(lambda: run(OLD_CUTS, OLD_CUTS, old=odd), "['speaker']")


# ── keep / replace / restore on disk ────────────────────────────────────────

class Project:
    """A folder with a stand-in zip, a transcript and an alignment; discover_tracks is stubbed
    to give the cut list registered for each zip's CONTENT (so the kept copy keeps its own)."""

    def __init__(self, cuts=OLD_CUTS):
        self.dir = tempfile.mkdtemp(prefix='transcript_keep_checks_')
        self.zip = os.path.join(self.dir, 's_compounds.zip')
        self.transcript = os.path.join(self.dir, 's_transcript.json')
        self.alignment = os.path.join(self.dir, 's_alignment.json')
        self.keep = os.path.join(self.dir, 's_kept_transcript')
        self.cut_lists = {}
        self.write_zip(b'zip-v1', cuts)
        with open(self.transcript, 'w') as fh:
            json.dump(made_transcript(cuts), fh)
        with open(self.transcript, 'rb') as fh:
            self.original = fh.read()
        self.write_alignment(alignment())
        T.discover_tracks = self.discover

    def write_zip(self, content, cuts):
        self.cut_lists[content] = cuts
        with open(self.zip, 'wb') as fh:
            fh.write(content)

    def write_alignment(self, al):
        with open(self.alignment, 'w') as fh:
            json.dump(al, fh, indent=2)

    def discover(self, zip_path):
        with open(zip_path, 'rb') as fh:
            content = fh.read()
        return 's', FRAME, tracks(self.cut_lists[content])

    def read_transcript(self):
        with open(self.transcript, 'rb') as fh:
            return fh.read()

    def done(self):
        shutil.rmtree(self.dir)


def failed_run_restores_original():
    p = Project()
    try:
        K.keep(p.zip)
        eq(os.path.exists(p.transcript), False, 'transcript moved aside')
        eq(sorted(os.listdir(p.keep)), ['alignment.json', 'keep.json', 's_compounds.zip',
                                        'transcript.json'], 'kept folder')
        # The run re-aligned and died before zipping (or was cancelled): zip unchanged.
        p.write_alignment(alignment(mic_off=0.9))
        r = K.restore(p.zip)
        eq(r['outcome'], 'restored', 'outcome')
        eq(p.read_transcript(), p.original, 'original bytes')
        eq(os.path.exists(p.keep), False, 'kept folder removed')
    finally:
        p.done()


def failed_after_new_zip_replaces():
    p = Project()
    try:
        K.keep(p.zip)
        new_cuts = {MIC: [(0.0, 10.0), (23.0, 7.0)], SCREEN: OLD_CUTS[SCREEN]}
        p.write_zip(b'zip-v2', new_cuts)
        r = K.restore(p.zip)
        eq(r['outcome'], 'replaced', 'outcome')
        with open(p.transcript) as fh:
            eq(json.load(fh)['words'], made_transcript(new_cuts)['words'], 're-placed words')
    finally:
        p.done()


def success_unchanged_byte_identical():
    p = Project()
    try:
        K.keep(p.zip)
        p.write_zip(b'zip-v2', OLD_CUTS)          # rebuilt, same cuts
        p.write_alignment(alignment())
        r = K.replace(p.zip)
        eq(r['identical'], True, 'identical')
        eq(p.read_transcript(), p.original, 'original bytes')
        eq(os.path.exists(p.keep), False, 'kept folder removed')
    finally:
        p.done()


def success_changed_writes():
    p = Project()
    try:
        K.keep(p.zip)
        new_cuts = {MIC: [(0.0, 10.0), (23.0, 7.0)], SCREEN: OLD_CUTS[SCREEN]}
        p.write_zip(b'zip-v2', new_cuts)
        p.write_alignment(alignment(mic_off=0.55))
        r = K.replace(p.zip)
        eq(r['identical'], False, 'identical')
        eq([t['droppedInCuts'] for t in r['tracks']], [1, 0], 'drops')
        near(r['tracks'][0]['shiftSeconds'], 0.3, 'shift')
        eq(os.path.exists(p.keep), False, 'kept folder removed')
    finally:
        p.done()


def refusal_keeps_folder():
    p = Project()
    try:
        K.keep(p.zip)
        with open(os.path.join(p.keep, 'transcript.json'), 'rb') as fh:
            kept = fh.read()
        p.write_zip(b'zip-v2', {MIC: OLD_CUTS[MIC]})       # the screen track is gone
        refuses(lambda: K.replace(p.zip), 'track t1', 'Re-transcribe')
        eq(os.path.exists(p.transcript), False, 'no transcript written')
        with open(os.path.join(p.keep, 'transcript.json'), 'rb') as fh:
            eq(fh.read(), kept, 'kept transcript untouched')
        eq(kept, p.original, 'kept transcript is the original')
        # The next run adopts the folder; with the screen back, it goes back where it was.
        eq(K.keep(p.zip)['adopted'], True, 'adopted')
        p.write_zip(b'zip-v3', OLD_CUTS)
        K.replace(p.zip)
        eq(p.read_transcript(), p.original, 'original bytes after adoption')
    finally:
        p.done()


def keep_refuses_ambiguity():
    p = Project()
    try:
        K.keep(p.zip)
        with open(p.transcript, 'wb') as fh:
            fh.write(p.original)                          # a new one appeared meanwhile
        refuses(lambda: K.keep(p.zip), 'both exist')
        refuses(lambda: K.restore(p.zip), 'already exists')
        eq(os.path.isdir(p.keep), True, 'folder kept')
    finally:
        p.done()


def keep_without_transcript_refuses():
    p = Project()
    try:
        os.remove(p.transcript)
        refuses(lambda: K.keep(p.zip), 'there is no s_transcript.json')
        eq(os.path.exists(p.keep), False, 'no folder made')
    finally:
        p.done()


print('transcript keep checks (LEDGER #315)')
_real_discover = T.discover_tracks
for name, fn in [
    ('unchanged cuts give the identical transcript', unchanged_identical),
    ('changed cuts re-place words and drop the ones now in a cut', changed_cuts_replace),
    ('file time the old cuts removed is counted as having no words', newly_kept_reported),
    ('the trim shift has the sign the filter gives it', shift_sign_proven),
    ('a moved offset shifts that track\'s words by the trim difference', offset_shift_replaces),
    ('a shift that leaves a word before the file drops it', offset_shift_into_cut),
    ('an alignment from before processedFile pairs by type', legacy_alignment_by_type),
    ('a reused processed file is not moved', reused_not_moved),
    ('missing/new track, drift, speed, one-sided, unknown method, unknown word key refuse', refusals),
    ('a failed or cancelled run puts the original back byte-for-byte', failed_run_restores_original),
    ('a failed run that wrote a new zip re-places onto it', failed_after_new_zip_replaces),
    ('success with unchanged cuts puts the kept file back byte-for-byte', success_unchanged_byte_identical),
    ('success with changed cuts and offset writes the re-placed file', success_changed_writes),
    ('a refusal leaves the kept folder whole; the next run adopts it', refusal_keeps_folder),
    ('a kept folder and a current transcript together refuse', keep_refuses_ambiguity),
    ('keep with no transcript refuses and makes nothing', keep_without_transcript_refuses),
]:
    check(name, fn)
    T.discover_tracks = _real_discover

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
