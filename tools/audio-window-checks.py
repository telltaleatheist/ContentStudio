"""check:audio-windows: where GCC-PHAT analysis windows are placed (LEDGER #317).

Offline: synthetic WAVs in a temp folder, decoded by the local ffmpeg/ffprobe exactly as a real
sync run decodes them. No Crucible, no session, nothing of Owen's touched. Covers the default
window plan of measure_offset (windows go where the SOURCE has sound, one per stretch of the
file, ties to the 10/50/85 % anchors), the failure it fixes (a sparse sound-effects track whose
bursts miss all three fixed windows), a dense track keeping its anchored windows exactly, a
silent source refused as a whole file, explicit windows honoured verbatim, and locate_source
placing its probes the same way.

    python3 tools/audio-window-checks.py
"""
import os
import shutil
import sys
import tempfile
import wave

import numpy as np

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'editor-backend'))
from core import gcc_phat_align as G  # noqa: E402

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


def near(a, b, what='', tol=1e-3):
    if abs(a - b) > tol:
        raise AssertionError(f"{what} expected {b!r} (+/-{tol}), got {a!r}")


def raises(fn, exc, *needles):
    try:
        fn()
    except exc as e:
        for n in needles:
            if n not in str(e):
                raise AssertionError(f"{type(e).__name__} {str(e)!r} does not mention {n!r}")
        return
    raise AssertionError(f"expected {exc.__name__}, nothing was raised")


FS = 8000
DUR = 1200.0                      # 20 min -> default windows are 150 s long
OFFSET = 0.75                     # source content sits +0.75 s into the reference
WLEN = 150.0
ANCHORS = [0.10 * DUR, 0.50 * DUR, 0.85 * DUR]          # 120, 600, 1020
# Bursts placed so none falls inside an anchored window ([120,270], [600,750],
# [1020,1170]) -- the shape of Owen's 2026-10-18 sound-effects track.
BURSTS = [40.0, 330.0, 470.0, 800.0, 905.0, 1185.0]
rng = np.random.default_rng(317)

tmp = tempfile.mkdtemp(prefix='audio-window-checks-')


def write_wav(name, x):
    path = os.path.join(tmp, name)
    pcm = np.clip(x, -1.0, 1.0)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(FS)
        w.writeframes((pcm * 32767).astype('<i2').tobytes())
    return path


def shifted(x, seconds):
    """x delayed by ``seconds`` (content appears later), same length."""
    k = int(round(seconds * FS))
    out = np.zeros_like(x)
    out[k:] = x[:x.size - k]
    return out


n = int(DUR * FS)
sparse = np.zeros(n)
for t in BURSTS:
    i = int(t * FS)
    sparse[i:i + FS] = 0.3 * rng.standard_normal(FS)          # 1 s broadband burst
dense = 0.2 * rng.standard_normal(n)
other_mix = 0.05 * rng.standard_normal(n)                      # the master's other sources

sparse_src = write_wav('sfx.wav', sparse)
sparse_ref = write_wav('master-sparse.wav', 0.5 * shifted(sparse, OFFSET) + other_mix)
dense_src = write_wav('mic.wav', dense)
dense_ref = write_wav('master-dense.wav', 0.5 * shifted(dense, OFFSET) + other_mix)
silent_src = write_wav('dead.wav', np.zeros(n))


def holds_burst(start, wlen):
    return any(start <= t and t + 1.0 <= start + wlen for t in BURSTS)


try:
    print('measure_offset: default windows')

    def sparse_measures():
        r = G.measure_offset(sparse_src, sparse_ref)
        near(r['tau_seconds'], OFFSET, 'tau')
        if r['confidence'] < G.CONFIDENCE_THRESHOLD:
            raise AssertionError(f"confidence {r['confidence']:.3f} under the gate")
        if len(r['per_window']) != 3:
            raise AssertionError(f"expected 3 measured windows, got {len(r['per_window'])}")
        for w in r['per_window']:
            near(w['duration'], WLEN, 'window length', tol=1e-9)
            if not holds_burst(w['start'], w['duration']):
                raise AssertionError(f"window at {w['start']}s holds no burst")
            if w['start'] < 0 or w['start'] + w['duration'] > DUR:
                raise AssertionError(f"window at {w['start']}s runs past a file end")
        near(r['spread_seconds'], 0.0, 'spread')
    check('sparse track (no burst at 10/50/85 %) measures the right offset', sparse_measures)

    def sparse_spread():
        r = G.measure_offset(sparse_src, sparse_ref)
        starts = [w['start'] for w in r['per_window']]
        # One window per stretch: the stretches split at the midpoints between
        # the anchors (360 s and 810 s).
        if not (starts[0] <= 360.0 <= starts[1] <= 810.0 <= starts[2]):
            raise AssertionError(f"windows not one per stretch: {starts}")
    check('sparse track keeps one window per stretch (drift span kept)', sparse_spread)

    def fixed_windows_fail():
        raises(lambda: G.measure_offset(sparse_src, sparse_ref,
                                        windows=[(a, WLEN) for a in ANCHORS]),
               G.SilentAudioError, 'every analysis window', '3 of 3 windows')
    check('the old fixed 10/50/85 % windows still fail on it (explicit windows honoured)',
          fixed_windows_fail)

    def dense_unchanged():
        r = G.measure_offset(dense_src, dense_ref)
        near(r['tau_seconds'], OFFSET, 'tau')
        got = [w['start'] for w in r['per_window']]
        if got != ANCHORS:
            raise AssertionError(f"dense track moved its windows: {got} vs {ANCHORS}")
    check('dense track keeps exactly the anchored 10/50/85 % windows', dense_unchanged)

    def explicit_verbatim():
        r = G.measure_offset(dense_src, dense_ref, windows=[(33.0, 60.0), (500.0, 90.0)])
        got = [(w['start'], w['duration']) for w in r['per_window']]
        if got != [(33.0, 60.0), (500.0, 90.0)]:
            raise AssertionError(f"explicit windows changed: {got}")
        near(r['tau_seconds'], OFFSET, 'tau')
    check('explicit windows= are used verbatim', explicit_verbatim)

    def silent_whole_file():
        raises(lambda: G.measure_offset(silent_src, sparse_ref), G.SilentAudioError,
               'Source audio is silent', 'dead.wav', 'no signal anywhere', 'the whole file')
    check('an all-zero source fails naming the whole file', silent_whole_file)

    print('locate_source')

    # A 600 s sparse part sitting at 400.75 s on its own reference. Its probes
    # anchor at 5/35/65 % (30, 210, 390 s local) and their stretches split at
    # 120 s and 300 s; each stretch holds one burst, none inside an anchored
    # window ([30,90], [210,270], [390,450]).
    PART_BURSTS = [100.0, 280.0, 350.0]
    part = np.zeros(int(600 * FS))
    for t in PART_BURSTS:
        i = int(t * FS)
        part[i:i + FS] = 0.3 * rng.standard_normal(FS)
    part_path = write_wav('part.wav', part)
    part_ref = other_mix.copy()
    k = int(round((400.0 + OFFSET) * FS))
    part_ref[k:k + part.size] += 0.5 * part
    part_ref_path = write_wav('master-part.wav', part_ref)

    def locate_sparse():
        r = G.locate_source(part_path, part_ref_path, expected_start=400.0 + OFFSET + 2.0,
                            search_radius_seconds=20.0, window_seconds=60.0)
        near(r['start_seconds'], 400.0 + OFFSET, 'start')
        for w in r['per_window']:
            local = w['source_local']
            if not any(local <= t and t + 1.0 <= local + 60.0 for t in PART_BURSTS):
                raise AssertionError(f"probe at local {local}s holds no burst")
    check('sparse part is located with probes over its sounds', locate_sparse)

    def locate_silent():
        dead_part = write_wav('dead-part.wav', np.zeros(int(600 * FS)))
        raises(lambda: G.locate_source(dead_part, sparse_ref, expected_start=400.0,
                                       search_radius_seconds=20.0, window_seconds=60.0),
               G.SilentAudioError, 'no signal anywhere')
    check('an all-zero part is refused as silent (callers go to picture)', locate_silent)

    print('placement rule')

    def rule_ties_to_anchor():
        env = np.full(1000, 0.1)
        got = G._place_windows(env, 0.0, [100.0, 500.0, 800.0], 50.0, 0.0, 950.0)
        if got != [100.0, 500.0, 800.0]:
            raise AssertionError(f"ties did not go to the anchors: {got}")
    check('sound throughout: every window stays on its anchor', rule_ties_to_anchor)

    def rule_empty_stretch():
        env = np.zeros(1000)
        env[200:210] = 0.1
        got = G._place_windows(env, 0.0, [100.0, 500.0, 800.0], 50.0, 0.0, 950.0)
        if got[1:] != [500.0, 800.0]:
            raise AssertionError(f"empty stretches moved their windows: {got}")
        if not (160.0 <= got[0] <= 200.0):
            raise AssertionError(f"first window does not cover the sound: {got[0]}")
    check('a stretch with no sound leaves its window on the anchor', rule_empty_stretch)
finally:
    shutil.rmtree(tmp, ignore_errors=True)

print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
