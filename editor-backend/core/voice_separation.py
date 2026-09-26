#!/usr/bin/env python
"""Chunked voice isolation: the audio logic here, the model on a Crucible.

The model call is Crucible's `denoise` job on the `vocals-roformer` manifest
(LEDGER #200, CRUCIBLE-MIGRATION-PLAN.md section 9). Everything else stays
here and is unchanged: the input is cut at SILENCES into ~6-min pieces, each
piece is extracted at 44.1 kHz stereo (the model's native rate; the server
never resamples), silent pieces are passed through as silence without asking
for a job, and the vocal stems are concatenated and resampled back to the
target rate. Seams fall in silence, so the concatenation is click-free.

Why chunk at all, now that the model's memory is the server's concern: the
silent-piece skip (a muted stretch crashes the separator and costs a job for
nothing) and one file per job on the wire (plan section 9).

THE PROTOCOL, one exchange per non-silent piece, on this process's stdio:

  stdout  {"type": "separation_request", "wav": <44.1 kHz chunk>, "out": <stem path>,
           "chunk": i, "chunks": n, "track": <label>}
  stdin   {"type": "separation_complete", "out": <stem path>}
       or {"type": "separation_complete", "error": <the server's message>}
  stdout  {"type": "separation_release"}      once, when every piece is done

Electron's main process runs the job (electron/crucible/denoise.ts) and
answers. Inside the editor's workflow this module runs IN electron_workflow.py's
process, so the requests ride its stdout like `ducking_request` does; run as a
script, the same lines are its own stdio.

Fails loud: a missing tool, a chunk not at 44.1 kHz, an error answer, a stem
that is missing or empty, or a parent that went away aborts the whole run
with a clear message (main holds each stem to the chunk's rate and length
before it answers). The noisy original never ships in the isolated track's
place.

  python voice_separation.py --input in.wav --output voice.wav \
      [--target-min 6] [--max-min 8] [--target-sr 48000] [--noise-db -40] [--keep-temp]
"""
import argparse
import json
import os
import re
import select
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

# The separator's native rate (crucible/denoise/vocals-roformer.toml). Every
# chunk is extracted at it and checked before it is offered to the server.
MODEL_SAMPLE_RATE = 44100


class VoiceIsolationError(RuntimeError):
    """Voice isolation cannot finish. The message says why, in words a log reader can act on."""


def run(cmd, **kw):
    return subprocess.run(cmd, capture_output=True, text=True, **kw)


def ffprobe_duration(ffprobe, path):
    r = run([ffprobe, "-v", "error", "-show_entries", "format=duration",
             "-of", "default=nk=1:nw=1", str(path)])
    if r.returncode != 0 or not r.stdout.strip():
        raise VoiceIsolationError(f"could not probe duration of {path}: {r.stderr.strip()}")
    return float(r.stdout.strip())


def ffprobe_sample_rate(ffprobe, path):
    r = run([ffprobe, "-v", "error", "-select_streams", "a:0", "-show_entries",
             "stream=sample_rate", "-of", "default=nk=1:nw=1", str(path)])
    if r.returncode != 0 or not r.stdout.strip():
        raise VoiceIsolationError(f"could not probe the sample rate of {path}: {r.stderr.strip()}")
    return int(r.stdout.strip())


def detect_silences(ffmpeg, path, noise_db, min_sil_s):
    """Return list of (start, end) silent intervals via ffmpeg silencedetect
    (streaming, low memory)."""
    r = run([ffmpeg, "-nostdin", "-i", str(path),
             "-af", f"silencedetect=noise={noise_db}dB:d={min_sil_s}",
             "-f", "null", "-"])
    starts = [float(m) for m in re.findall(r"silence_start:\s*([0-9.]+)", r.stderr)]
    ends = [float(m) for m in re.findall(r"silence_end:\s*([0-9.]+)", r.stderr)]
    return list(zip(starts, ends))  # ends may be one shorter if file ends in silence


def plan_cuts(duration, silences, target_s, max_s):
    """Greedy cut points at silence midpoints: aim for target_s, never exceed
    max_s. If no silence is available before max_s, force a hard cut at max_s
    (logged) rather than letting a chunk grow unbounded."""
    mids = [ (s + e) / 2.0 for s, e in silences if e > s ]
    cuts, last = [], 0.0
    i = 0
    while duration - last > max_s:
        # first silence midpoint at/after target from last
        window = [m for m in mids if last + target_s <= m <= last + max_s]
        if window:
            cut = window[0]
        else:
            cut = last + max_s
            print(f"FORCED_CUT no silence between {last:.1f}s and {last+max_s:.1f}s; "
                  f"hard cut at {cut:.1f}s", file=sys.stderr)
        cuts.append(cut)
        last = cut
    bounds = [0.0] + cuts + [duration]
    return list(zip(bounds[:-1], bounds[1:]))


def is_silent(ffmpeg, wav, thresh_db=-60.0):
    """True if the chunk has no audio above thresh_db (a muted/zero stretch).
    Such chunks crash the separator ('empty or not valid'); we pass them through
    as silence instead — silence in = silence out, and it saves GPU time."""
    r = run([ffmpeg, "-nostdin", "-i", str(wav), "-af", "volumedetect", "-f", "null", "-"])
    m = re.search(r"max_volume:\s*(-?[0-9.]+|-inf)", r.stderr)
    if not m:
        return False  # can't determine -> process it (don't silently skip real audio)
    v = m.group(1)
    return v == "-inf" or float(v) <= thresh_db


# THE STEMS ARE 16-BIT PCM WAV. Crucible's denoise returns nothing else, and
# electron/crucible/denoise.ts refuses any stem that is not (STEM_BITS_PER_SAMPLE)
# before it answers here, so this file never probes a stem's codec.
STEM_CODEC = "pcm_s16le"


def to_silence_like(ffmpeg, src, out):
    """Re-encode an (all-silent) chunk as the stems are (STEM_CODEC in a WAV), so
    it concatenates cleanly with them: the concat demuxer reads every file as
    the first one's codec, and a 24-bit file read as 16-bit comes out one and a
    half times as long. Exact same length as src."""
    r = run([ffmpeg, "-nostdin", "-v", "error", "-i", str(src),
             "-c:a", STEM_CODEC, "-y", str(out)])
    if r.returncode != 0:
        raise VoiceIsolationError(f"could not build silent passthrough stem: {r.stderr[-400:]}")


def extract_chunk(ffmpeg, path, t0, t1, out):
    r = run([ffmpeg, "-nostdin", "-v", "error", "-ss", f"{t0:.6f}", "-to", f"{t1:.6f}",
             "-i", str(path), "-ac", "2", "-ar", str(MODEL_SAMPLE_RATE), "-c:a", "pcm_s24le",
             "-y", str(out)])
    if r.returncode != 0:
        raise VoiceIsolationError(f"ffmpeg failed extracting chunk {t0:.1f}-{t1:.1f}s: {r.stderr[-500:]}")


def _read_answer(parent_pid):
    """One line from stdin, waiting as long as the job takes.

    There is deliberately NO overall timeout: a chunk that waits for a busy
    lane waits as long as the lane is held. On POSIX the wait polls with select
    so a crashed parent is noticed instead of blocking forever (the Dugan
    automixer's wait in electron_workflow.py, same reason)."""
    if sys.platform == 'win32':
        return sys.stdin.readline()
    while True:
        ready, _, _ = select.select([sys.stdin], [], [], 5.0)
        if ready:
            return sys.stdin.readline()
        current = os.getppid()
        if current == 1 or current != parent_pid:
            raise VoiceIsolationError("Electron exited while a voice-isolation chunk was on the Crucible")


def request_separation(chunk_wav, out_wav, index, count, track, parent_pid):
    """Ask Electron's main process to run the `denoise` job on ONE 44.1 kHz
    chunk. Returns the vocal stem's path. This is the only step that left this
    file: it used to spawn audio-separator from voice-separator-env."""
    print(json.dumps({
        "type": "separation_request",
        "wav": str(chunk_wav),
        "out": str(out_wav),
        "chunk": index,
        "chunks": count,
        "track": track,
    }), flush=True)
    line = _read_answer(parent_pid)
    # EOF: nobody will answer. Continuing would ship the noisy original.
    if not line:
        raise VoiceIsolationError(f"Electron closed stdin without answering the request for {Path(chunk_wav).name}")
    try:
        answer = json.loads(line.strip())
    except Exception as err:
        raise VoiceIsolationError(f"the answer for {Path(chunk_wav).name} is not JSON: {err}: {line!r}")
    if answer.get("type") != "separation_complete":
        raise VoiceIsolationError(
            f"expected separation_complete for {Path(chunk_wav).name}, got {answer.get('type')!r}")
    if answer.get("error"):
        raise VoiceIsolationError(f"voice isolation failed on {Path(chunk_wav).name}: {answer['error']}")
    stem = answer.get("out")
    if not stem or not Path(stem).is_file() or Path(stem).stat().st_size == 0:
        raise VoiceIsolationError(
            f"the stem for {Path(chunk_wav).name} is missing or empty at {stem!r} — refusing to continue")
    return Path(stem)


def concat_resample(ffmpeg, stems, output, target_sr):
    listf = Path(output).with_suffix(".concat.txt")
    # as_posix() keeps forward slashes — the ffmpeg concat demuxer chokes on
    # Windows backslash paths.
    listf.write_text("".join(f"file '{s.resolve().as_posix()}'\n" for s in stems))
    # -rf64 auto: this is the one full-length output here (the chunks are bounded
    # by --max_min), and 32-bit RIFF chunk sizes clamp past 4 GiB — see
    # audio_sync.apply_sync_to_audio for what that silently costs downstream.
    r = run([ffmpeg, "-nostdin", "-v", "error", "-f", "concat", "-safe", "0",
             "-i", str(listf), "-ar", str(target_sr), "-c:a", "pcm_s24le",
             "-rf64", "auto", "-y", str(output)])
    listf.unlink(missing_ok=True)
    if r.returncode != 0:
        raise VoiceIsolationError(f"concat/resample failed: {r.stderr[-500:]}")


def isolate_voice(input_path, output_path, *, ffmpeg="ffmpeg", ffprobe="ffprobe", track="audio",
                  target_min=6.0, max_min=8.0, target_sr=48000, noise_db=-40.0, min_sil=0.3,
                  keep_temp=False, parent_pid=None, report=None):
    """Isolate the voice in `input_path` into `output_path`, one Crucible job per
    non-silent piece. Progress is the PLAN / CHUNK / DONE lines, written to
    stderr and handed to `report` (electron_workflow.py turns them into the
    operation row); raises VoiceIsolationError on any failure."""
    parent_pid = os.getppid() if parent_pid is None else parent_pid

    def say(line):
        print(line, file=sys.stderr)
        if report is not None:
            report(line)

    dur = ffprobe_duration(ffprobe, input_path)
    sil = detect_silences(ffmpeg, input_path, noise_db, min_sil)
    chunks = plan_cuts(dur, sil, target_min * 60, max_min * 60)
    say(f"PLAN: {dur/60:.1f} min input, {len(sil)} silences -> {len(chunks)} chunks")

    tmp = Path(tempfile.mkdtemp(prefix="voicesep_"))
    stems = []
    # Silent chunks, as (index into stems, the chunk): their silence is written
    # after the loop, as a STEM_CODEC WAV like every stem.
    silent = []
    try:
        for i, (t0, t1) in enumerate(chunks):
            cw = tmp / f"chunk_{i:04d}.wav"
            extract_chunk(ffmpeg, input_path, t0, t1, cw)
            if is_silent(ffmpeg, cw):
                # Muted/zero stretch — don't feed the separator (it errors); it
                # becomes matching-length silence below.
                silent.append((len(stems), cw))
                stems.append(None)
                say(f"CHUNK {i+1}/{len(chunks)} ({t0/60:.1f}-{t1/60:.1f}min) SILENT -> passthrough")
                continue
            # The server refuses nothing about the rate before the upload; its
            # worker fails the job after it. Checked here, where it is cheap,
            # and again on the header before the upload (denoise.ts).
            rate = ffprobe_sample_rate(ffprobe, cw)
            if rate != MODEL_SAMPLE_RATE:
                raise VoiceIsolationError(
                    f"{cw.name} was extracted at {rate} Hz; the separator takes {MODEL_SAMPLE_RATE} Hz")
            stem = request_separation(cw, tmp / f"out_{i:04d}.wav", i + 1, len(chunks), track, parent_pid)
            stems.append(stem)
            cw.unlink(missing_ok=True)  # free chunk input immediately
            say(f"CHUNK {i+1}/{len(chunks)} ({t0/60:.1f}-{t1/60:.1f}min) -> {stem.name}")
        for at, cw in silent:
            stem = tmp / f"sil_{at:04d}.wav"
            to_silence_like(ffmpeg, cw, stem)
            stems[at] = stem
            cw.unlink(missing_ok=True)
        concat_resample(ffmpeg, stems, output_path, target_sr)
        say(f"DONE {output_path} ({len(chunks)} chunks, {target_sr}Hz)")
    finally:
        # The pass is over either way: main gives the separator's lease back
        # now rather than when the whole workflow ends (denoise.ts dispose()).
        print(json.dumps({"type": "separation_release"}), flush=True)
        if not keep_temp:
            shutil.rmtree(tmp, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--input", required=True)
    ap.add_argument("--output", required=True)
    ap.add_argument("--track", default="audio")
    ap.add_argument("--target-min", type=float, default=6.0)
    ap.add_argument("--max-min", type=float, default=8.0)
    ap.add_argument("--target-sr", type=int, default=48000)
    ap.add_argument("--noise-db", type=float, default=-40.0)
    ap.add_argument("--min-sil", type=float, default=0.3)
    ap.add_argument("--ffmpeg", default="ffmpeg")
    ap.add_argument("--ffprobe", default="ffprobe")
    ap.add_argument("--keep-temp", action="store_true")
    a = ap.parse_args()
    try:
        isolate_voice(a.input, a.output, ffmpeg=a.ffmpeg, ffprobe=a.ffprobe, track=a.track,
                      target_min=a.target_min, max_min=a.max_min, target_sr=a.target_sr,
                      noise_db=a.noise_db, min_sil=a.min_sil, keep_temp=a.keep_temp)
    except VoiceIsolationError as err:
        sys.exit(f"ERROR: {err}")


if __name__ == "__main__":
    main()
