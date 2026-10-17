"""check:asr-cache: the editor's ASR cache in editor-backend/cli/transcribe.py (LEDGER #311).

Offline and pure: synthetic WAVs and entries in a temp folder, no ffmpeg, no Crucible, no
session. Covers the fingerprint (content, not mtime), the key and the name it files under,
the entry read/write (a miss, a hit, and every malformed entry refused by name), and the
split map path (compact -> file words, then file -> timeline) that fresh and cached words
share.

    python3 tools/asr-cache-checks.py
"""
import json
import os
import shutil
import sys
import tempfile
import time
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'editor-backend'))
from cli import transcribe as T  # noqa: E402

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


def refuses(fn, *needles):
    try:
        fn()
    except T.TranscribeError as e:
        for n in needles:
            if n not in str(e):
                raise AssertionError(f"refusal {str(e)!r} does not mention {n!r}")
        return
    raise AssertionError('expected a TranscribeError, nothing was raised')


TMP = tempfile.mkdtemp(prefix='asr_cache_checks_')


def make_wav(name, seconds, rate=16000, channels=1, seed=1):
    path = os.path.join(TMP, name)
    n = int(seconds * rate) * channels
    # Deterministic, non-repeating bytes, so every block's hash differs.
    data = bytearray()
    x = seed
    for _ in range(n):
        x = (x * 1103515245 + 12345) & 0x7FFFFFFF
        data += (x >> 8 & 0xFFFF).to_bytes(2, 'little')
    with wave.open(path, 'wb') as w:
        w.setnchannels(channels)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(data))
    return path


TIME_MAP = [
    {'concat_start': 0.0, 'concat_end': 2.0, 'file_start': 10.0},
    {'concat_start': 2.3, 'concat_end': 5.0, 'file_start': 40.0},
]
SHA = 'a' * 64


def key_for(wav, **over):
    args = dict(fingerprint=T.fingerprint_audio(wav), time_map_digest=T.time_map_sha256(TIME_MAP),
                asr_model='qwen3-asr-1.7b', asr_params_sha256=SHA, max_seconds=None)
    args.update(over)
    return T.asr_cache_key(**args)


print('fingerprint')


def offsets_small():
    eq(T._fingerprint_offsets(10), [0], 'a 10-byte file:')
    eq(T._fingerprint_offsets(3 * T.FP_BLOCK_BYTES + 5), [0, 1 << 20, 2 << 20, 3 << 20], 'a 3 MiB file, whole:')


def offsets_large():
    size = 500 * T.FP_BLOCK_BYTES + 12345
    offs = T._fingerprint_offsets(size)
    eq(len(offs), T.FP_SPREAD_BLOCKS + 2, 'blocks:')
    eq(offs[0], 0, 'first block:')
    eq(offs[-1], size - T.FP_BLOCK_BYTES, 'last block:')
    eq(offs, sorted(set(offs)), 'sorted and distinct:')
    eq(offs, T._fingerprint_offsets(size), 'deterministic:')


def same_bytes_new_mtime():
    a = make_wav('a.wav', 3)
    fa = T.fingerprint_audio(a)
    b = os.path.join(TMP, 'b.wav')
    shutil.copyfile(a, b)
    os.utime(b, (time.time() + 3600, time.time() + 3600))
    eq(T.fingerprint_audio(b), fa, 'a copy with a new mtime:')
    eq((fa['channels'], fa['sampleWidth'], fa['sampleRate'], fa['frames']), (1, 2, 16000, 48000), 'format:')


def changed_byte_misses():
    a = make_wav('c.wav', 3)
    fa = T.fingerprint_audio(a)
    with open(a, 'r+b') as fh:
        fh.seek(5000)
        b = fh.read(1)
        fh.seek(5000)
        fh.write(bytes([b[0] ^ 0xFF]))
    if T.fingerprint_audio(a)['sampledSha256'] == fa['sampledSha256']:
        raise AssertionError('one changed byte left the fingerprint unchanged')


def format_counts():
    mono = T.fingerprint_audio(make_wav('m.wav', 1, rate=16000, channels=1))
    other = T.fingerprint_audio(make_wav('r.wav', 2, rate=8000, channels=1))
    eq(mono['bytes'], other['bytes'], 'same size:')
    if mono == other:
        raise AssertionError('16 kHz and 8 kHz of the same size fingerprinted alike')


check('small files are hashed whole', offsets_small)
check('large files: first, last and 64 spread blocks, deterministic', offsets_large)
check('identical bytes with a new mtime fingerprint alike', same_bytes_new_mtime)
check('one changed byte changes the fingerprint', changed_byte_misses)
check('the format is part of the fingerprint', format_counts)

print('key')


def key_fields():
    wav = make_wav('k.wav', 2)
    base = T.asr_cache_path(TMP, key_for(wav))
    eq(T.asr_cache_path(TMP, key_for(wav)), base, 'the same inputs:')
    variants = {
        'model': key_for(wav, asr_model='qwen3-asr-0.6b'),
        'params': key_for(wav, asr_params_sha256='b' * 64),
        'max seconds': key_for(wav, max_seconds=30.0),
        'time map': key_for(wav, time_map_digest=T.time_map_sha256(TIME_MAP[:1])),
    }
    for what, k in variants.items():
        if T.asr_cache_path(TMP, k) == base:
            raise AssertionError(f"a different {what} filed under the same name")
    k = key_for(wav)
    for field in ('vad', 'loopRetry'):
        if field not in k:
            raise AssertionError(f"the key has no {field}")
    eq(k['loopRetry'], {'minReps': T.LOOP_MIN_REPS, 'padSec': T.LOOP_PAD_SEC, 'maxRegions': T.LOOP_MAX_REGIONS})
    eq(k['vad']['sepSec'], T.SEP_SEC)


def key_survives_json():
    k = key_for(make_wav('j.wav', 1), max_seconds=12.5)
    eq(json.loads(json.dumps(k)), k, 'JSON round trip:')


check('every key field changes the entry name', key_fields)
check('a key compares equal after a JSON round trip', key_survives_json)

print('entries')

WORDS = [{'text': 'Hello,', 'fileStart': 10.5, 'fileEnd': 10.9},
         {'text': 'um', 'fileStart': 11.0, 'fileEnd': 11.2, 'prob': 0.5}]
MODEL = 'crucible:mac:qwen3-asr-1.7b'


def fresh_dir():
    return tempfile.mkdtemp(prefix='cache_', dir=TMP)


def miss_then_hit():
    d = os.path.join(fresh_dir(), 's_asr_cache')    # not created yet: write makes it
    k = key_for(make_wav('h.wav', 1))
    p = T.asr_cache_path(d, k)
    eq(T.read_asr_cache(p, k), None, 'before any write:')
    T.write_asr_cache(p, k, MODEL, WORDS, 'mic audio_processed', '/x/mic audio_processed.wav')
    eq(T.read_asr_cache(p, k), (WORDS, MODEL), 'after the write:')
    eq(sorted(os.listdir(d)), [os.path.basename(p)], 'no temp file left:')


def refused_entries():
    d = fresh_dir()
    k = key_for(make_wav('e.wav', 1))
    p = T.asr_cache_path(d, k)

    def write_raw(obj):
        with open(p, 'w') as fh:
            fh.write(obj if isinstance(obj, str) else json.dumps(obj))

    good = {'schema': T.ASR_CACHE_SCHEMA, 'key': k, 'reportedModel': MODEL, 'words': WORDS}
    cases = [
        ('not JSON', '{"schema": 1, ', 'cannot be read'),
        ('not an object', [1, 2], 'not a JSON object'),
        ('another schema', dict(good, schema=99), 'schema 99'),
        ('another key', dict(good, key=dict(k, asrModel='qwen3-asr-0.6b')), 'differs from the one it is filed under'),
        ('another model', dict(good, reportedModel='crucible:mac:qwen3-asr-0.6b'), 'not qwen3-asr-1.7b'),
        ('no words', {kk: v for kk, v in good.items() if kk != 'words'}, "no 'words' list"),
        ('a word without fileEnd', dict(good, words=[{'text': 'x', 'fileStart': 1.0}]), 'words[0]'),
        ('a boolean time', dict(good, words=[{'text': 'x', 'fileStart': True, 'fileEnd': 2.0}]), 'words[0]'),
        ('an empty word', dict(good, words=[{'text': '', 'fileStart': 1.0, 'fileEnd': 2.0}]), 'words[0]'),
        ('a text prob', dict(good, words=[WORDS[0], dict(WORDS[1], prob='high')]), 'words[1]'),
    ]
    for what, body, needle in cases:
        write_raw(body)
        try:
            refuses(lambda: T.read_asr_cache(p, k), p, needle)
        except AssertionError as e:
            raise AssertionError(f"{what}: {e}")


check('a missing entry is a miss; a written one reads back whole, atomically', miss_then_hit)
check('a malformed or mis-keyed entry fails naming the file', refused_entries)

print('one map path')


def split_map():
    # Compact-time words: one in span 1, one in the separator gap, one in span 2, one in span 2
    # whose file time falls in a cut.
    raw = [
        {'text': 'one', 'file_start': 0.5, 'file_end': 0.9},
        {'text': 'gap', 'file_start': 2.05, 'file_end': 2.25},
        {'text': 'two', 'file_start': 2.5, 'file_end': 2.9, 'prob': 0.25},
        {'text': 'cut', 'file_start': 4.5, 'file_end': 4.8},
    ]
    fw = T.compact_to_file_words(raw, TIME_MAP)
    eq([w['text'] for w in fw], ['one', 'two', 'cut'], 'file words (the separator word dropped, the cut one kept):')
    eq((round(fw[0]['fileStart'], 6), round(fw[1]['fileStart'], 6)), (10.5, 40.2), 'file times:')
    eq(fw[1]['prob'], 0.25, 'prob kept:')
    track = {'id': 't0', 'segments': [
        {'group': 0, 'source_start': 10.0, 'source_end': 12.0, 'timeline_start': 100.0},
        {'group': 1, 'source_start': 40.0, 'source_end': 42.0, 'timeline_start': 200.0},
    ]}
    mapped = T.map_file_words(track, fw)
    eq([(w['text'], round(w['timelineStart'], 6), w['group']) for w in mapped],
       [('one', 100.5, 0), ('two', 200.2, 1)], 'timeline words (the cut one dropped):')
    # Cached words go down the same path: a round trip through an entry maps identically.
    d = fresh_dir()
    k = key_for(make_wav('p.wav', 1))
    p = T.asr_cache_path(d, k)
    T.write_asr_cache(p, k, MODEL, fw, 'mic', '/x/mic.wav')
    eq(T.map_file_words(track, T.read_asr_cache(p, k)[0]), mapped, 'cached words mapped:')


check('compact -> file words keep cut words; file -> timeline drops them; cached maps the same', split_map)

print('a whole run, stubbed (no ffmpeg, no Crucible)')


class FakeChannel:
    """Answers each asr_request with two words in the compact WAV's seconds, and counts them."""

    def __init__(self, model=MODEL):
        self.model = None
        self._model = model
        self.requests = 0

    def request(self, wav, track_id, region, on_progress):
        self.requests += 1
        self.model = self._model
        path = wav + '.words.json'
        with open(path, 'w') as fh:
            json.dump({'words': [{'word': 'hello', 'start': 0.4, 'end': 0.8, 'probability': None},
                                 {'word': 'there', 'start': 0.9, 'end': 1.2, 'probability': None}]}, fh)
        return path


def bursty_wav(path, seed):
    """16 kHz mono: 1 s of noise, 1 s of silence, 1 s of noise (two active spans)."""
    rate = 16000
    x = seed
    data = bytearray()
    for sec in range(3):
        for _ in range(rate):
            if sec == 1:
                data += b'\x00\x00'
            else:
                x = (x * 1103515245 + 12345) & 0x7FFFFFFF
                data += ((x >> 8 & 0x3FFF) - 0x2000).to_bytes(2, 'little', signed=True)
    with wave.open(path, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(rate)
        w.writeframes(bytes(data))


def run(zip_path, channel, seed, model='qwen3-asr-1.7b'):
    import contextlib
    import io
    track = {'id': 't0', 'label': 'mic audio_processed', 'file': '/x/s mic audio_processed.wav',
             'segments': [{'group': 0, 'source_start': 0.0, 'source_end': 3.0, 'timeline_start': 5.0}]}
    saved = (T._validate_tool, T.discover_tracks, T.extract_wav)
    T._validate_tool = lambda *a, **k: None
    T.discover_tracks = lambda _zip: ('s', 1 / 30, [track])
    T.extract_wav = lambda _ff, _src, dst, _max: bursty_wav(dst, seed)
    out = io.StringIO()
    try:
        with contextlib.redirect_stdout(out), contextlib.redirect_stderr(io.StringIO()):
            T.transcribe(zip_path, '/bin/ffmpeg', None, model, SHA, channel=channel)
    finally:
        T._validate_tool, T.discover_tracks, T.extract_wav = saved
    lines = [json.loads(l) for l in out.getvalue().splitlines() if l.strip()]
    result = [l for l in lines if l['type'] == 'success'][0]['result']
    with open(result['transcriptPath']) as fh:
        return result, json.load(fh), lines


def whole_run():
    d = fresh_dir()
    zip_path = os.path.join(d, 's_compounds.zip')
    first = FakeChannel()
    r1, side1, _ = run(zip_path, first, seed=7)
    eq((r1['tracksDecoded'], r1['tracksReused'], r1['tracksSilent'], first.requests), (1, 0, 0, 1), 'first run:')
    eq([w['text'] for w in side1['words']], ['hello', 'there'], 'first run words:')
    eq(len(os.listdir(os.path.join(d, 's_asr_cache'))), 1, 'entries after the first run:')
    os.remove(r1['transcriptPath'])                     # what clear-session-state does
    second = FakeChannel()
    r2, side2, lines = run(zip_path, second, seed=7)
    eq((r2['tracksDecoded'], r2['tracksReused'], second.requests), (0, 1, 0), 'second run, same audio:')
    eq(side2['words'], side1['words'], 'the reused transcript:')
    eq(side2['model'], MODEL, 'the sidecar names the cached model:')
    if not any(l['type'] == 'progress' and l['message'].startswith('Reused saved words') for l in lines):
        raise AssertionError('no progress line says the track was reused')
    third = FakeChannel()
    r3, _, _ = run(zip_path, third, seed=8)             # the audio changed
    eq((r3['tracksDecoded'], r3['tracksReused'], third.requests), (1, 0, 1), 'third run, new audio:')
    eq(len(os.listdir(os.path.join(d, 's_asr_cache'))), 2, 'entries after the third run:')


def model_mismatch_refused():
    d = fresh_dir()
    try:
        run(os.path.join(d, 's_compounds.zip'), FakeChannel(model='crucible:mac:qwen3-asr-0.6b'), seed=7)
    except T.TranscribeError as e:
        if 'qwen3-asr-0.6b' not in str(e):
            raise AssertionError(f"refusal does not name the model: {e}")
        if os.path.isdir(os.path.join(d, 's_asr_cache')):
            raise AssertionError('a mismatched decode was cached')
        return
    raise AssertionError('a decode on another model than the run was started for went through')


check('decode, then reuse the same audio (no request), then decode changed audio', whole_run)
check('main answering with another model than --asr-model is refused and not cached', model_mismatch_refused)

shutil.rmtree(TMP, ignore_errors=True)
print(f"\n{passed} passed, {failed} failed")
sys.exit(1 if failed else 0)
