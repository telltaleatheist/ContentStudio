"""The Python half of check:asr's editor-protocol checks (tools/asr-checks.js drives it).

It imports editor-backend/cli/transcribe.py as the editor runs it and exercises the two things
P5 changed there, against the REAL main-side responder on the other end of its stdin/stdout:

  loop     _retry_loop_regions on a synthetic compact WAV whose words hold a repetition run:
           one asr_request per region goes out with `region` set, the answer's words come back
           in the slice's seconds, and the splice shifts them by the region start.
  reader   parse_whisper_json on Crucible's words shape: probability null is read as no
           'prob', a number is kept, a word with no start is refused by name.

Every result is ONE JSON line on stdout of type "result" (stdout is also the protocol channel,
exactly as in the app). Diagnostics go to stderr.
"""
import json
import os
import sys
import tempfile
import wave

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'editor-backend'))
from cli import transcribe as T  # noqa: E402


def result(obj):
    sys.stdout.write(json.dumps(dict(obj, type='result')) + '\n')
    sys.stdout.flush()


def loop_case():
    tmp = tempfile.mkdtemp(prefix='asr_loop_')
    wav = os.path.join(tmp, 'compact.wav')
    with wave.open(wav, 'wb') as w:
        w.setnchannels(1)
        w.setsampwidth(2)
        w.setframerate(16000)
        w.writeframes(b'\x00\x00' * 16000 * 60)          # 60 s of silence is enough to slice
    raw = [{'text': 'hello', 'file_start': 1.0, 'file_end': 1.4}]
    t = 10.0
    for _ in range(12):                                   # "we go" x12: a loop run (min_reps 10)
        raw.append({'text': 'we', 'file_start': t, 'file_end': t + 0.2})
        raw.append({'text': 'go', 'file_start': t + 0.25, 'file_end': t + 0.45})
        t += 0.5
    raw.append({'text': 'bye', 'file_start': 50.0, 'file_end': 50.3})
    channel = T.AsrChannel()
    out = T._retry_loop_regions(raw, wav, channel.request, tmp, 't0', 'mic')
    result({'case': 'loop', 'words': out, 'model': channel.model})


def reader_case():
    tmp = tempfile.mkdtemp(prefix='asr_reader_')
    good = os.path.join(tmp, 'good.json')
    with open(good, 'w') as fh:
        json.dump({'words': [
            {'word': 'Hello,', 'start': 0.5, 'end': 0.9, 'probability': None},
            {'word': 'um', 'start': 1.0, 'end': 1.2, 'probability': 0.5},
            {'word': '...', 'start': 1.2, 'end': 1.3, 'probability': None},
            {'word': '[MUSIC]', 'start': 2.0, 'end': 3.0, 'probability': None},
        ]}, fh)
    words = T.parse_whisper_json(good)
    bad = os.path.join(tmp, 'bad.json')
    with open(bad, 'w') as fh:
        json.dump({'words': [{'word': 'x', 'end': 1.0, 'probability': None}]}, fh)
    try:
        T.parse_whisper_json(bad)
        refused = None
    except T.TranscribeError as e:
        refused = str(e)
    neither = os.path.join(tmp, 'neither.json')
    with open(neither, 'w') as fh:
        json.dump({'segments': []}, fh)
    try:
        T.parse_whisper_json(neither)
        refused_shape = None
    except T.TranscribeError as e:
        refused_shape = str(e)
    result({'case': 'reader', 'words': words, 'refused': refused, 'refusedShape': refused_shape})


if __name__ == '__main__':
    try:
        {'loop': loop_case, 'reader': reader_case}[sys.argv[1]]()
    except T.TranscribeError as e:
        result({'case': sys.argv[1], 'error': str(e)})
