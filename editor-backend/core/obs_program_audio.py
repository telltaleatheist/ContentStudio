"""The WAVs an OBS set's program recording carries, pulled out at the start of a run.

An OBS-set manifest of version 2 (`<set> sync.json`, written by Utility Suite) no longer comes
with WAVs. It lists `<set> program.mkv`, the main OBS recording, whose audio tracks are lossless
PCM and which the manifest describes by OBS's 1-based track number and what each holds. The
version-1 WAVs (`mic audio`, `screen audio`, `master audio`) were Utility Suite's copies of
those same tracks; this does that step here.

The setup modal's detection (`obsSetProgramAudio` in electron/services/editor/session-sources.ts)
fills the audio slots with the WAV paths below before they exist; the run extracts whichever of
them it was given and finds missing. The two tables must agree: a renamed WAV here is a slot
that is never filled.
"""
import json
import os
import subprocess
import sys
from pathlib import Path

# What a program track holds (the manifest's "audio" label) -> the WAV it becomes, named as the
# vMix-era files were so the existing detection reads it. "on-air mix" and "everything merged"
# are not extracted: no part of the pipeline takes a master mix as a source.
PROGRAM_TRACK_WAVS = {
    'Mic 1': 'mic audio',
    'Mic 2': 'mic 2 audio',
    'Mac': 'screen audio',
    'game': 'game audio',
}
NOT_EXTRACTED = {'on-air mix', 'everything merged'}


def program_audio_plan(master_video):
    """{wav path: (program path, OBS track number)} for an OBS set of manifest version 2, and {}
    for any other set (no manifest, or version 1, whose WAVs arrive already made).

    A version-2 manifest without a program entry, or with a track label this table does not
    know, is an error: either would silently drop a mic.
    """
    master_video = Path(master_video)
    session = master_video.stem
    if session.lower().endswith(' master'):
        session = session[:-len(' master')]
    manifest_path = master_video.parent / f"{session} sync.json"
    if not manifest_path.exists():
        return {}
    with open(manifest_path, 'r', encoding='utf-8') as f:
        manifest = json.load(f)
    if not isinstance(manifest, dict) or manifest.get('format') != 'obs-set':
        raise ValueError(f"{manifest_path.name} is not an OBS-set manifest (its format is not \"obs-set\")")
    if manifest.get('version') == 1:
        return {}
    if manifest.get('version') != 2:
        raise ValueError(f"{manifest_path.name} is OBS-set manifest version {manifest.get('version')!r}; "
                         f"this build reads versions 1 and 2")

    programs = [e for e in manifest.get('files') or [] if isinstance(e, dict) and e.get('role') == 'program']
    if len(programs) != 1:
        raise ValueError(f"{manifest_path.name} is version 2 but lists {len(programs)} program recordings, "
                         f"not one; the set's WAVs come from it")
    program = programs[0]
    program_path = master_video.parent / str(program['file'])
    tracks = program.get('tracks')
    if not isinstance(tracks, list) or not tracks:
        raise ValueError(f"{manifest_path.name} lists {program['file']} without its \"tracks\"")

    plan = {}
    for entry in tracks:
        label = entry.get('audio')
        if label in NOT_EXTRACTED:
            continue
        if label not in PROGRAM_TRACK_WAVS:
            raise ValueError(f"{manifest_path.name}: program track {entry.get('track')} holds "
                             f"\"{label}\", which this build does not know how to name")
        wav = master_video.parent / f"{session} {PROGRAM_TRACK_WAVS[label]}.wav"
        plan[str(wav)] = (program_path, int(entry['track']))
    return plan


def extract_program_audio(master_video, wanted_paths, ffmpeg, ffprobe, on_progress):
    """Write each of `wanted_paths` that the plan names and that is not on disk, in ONE read of
    the program recording, copying the PCM untouched. Returns the paths written.

    Each WAV is written under a temporary name and renamed when ffmpeg has finished, so a run
    killed halfway leaves no WAV that looks complete. RF64 is allowed because a long stream's
    PCM passes the 4 GB a plain WAV can hold.

    `on_progress(fraction)` gets 0..1 as the program recording is read.
    """
    plan = program_audio_plan(master_video)
    todo = [(p, plan[p]) for p in wanted_paths if p in plan and not Path(p).exists()]
    if not todo:
        return []

    program_path = todo[0][1][0]
    if not program_path.exists():
        raise FileNotFoundError(f"{program_path.name} is not in {program_path.parent}. An OBS set's "
                                f"WAVs are taken from it, and {len(todo)} of them are not made yet.")

    probe = subprocess.run(
        [ffprobe, '-v', 'error', '-select_streams', 'a',
         '-show_entries', 'stream=codec_name:format=duration', '-of', 'json', str(program_path)],
        capture_output=True, text=True, check=True)
    info = json.loads(probe.stdout)
    codecs = [s['codec_name'] for s in info.get('streams', [])]
    duration = float(info['format']['duration'])
    for wav, (_, track) in todo:
        if track > len(codecs):
            raise ValueError(f"{program_path.name} has {len(codecs)} audio tracks; the manifest "
                             f"puts {Path(wav).name}'s audio on track {track}")
        if not codecs[track - 1].startswith('pcm_'):
            raise ValueError(f"{program_path.name} track {track} is {codecs[track - 1]}, not PCM; "
                             f"the manifest says its tracks are lossless")

    cmd = [ffmpeg, '-hide_banner', '-nostats', '-y', '-progress', 'pipe:1', '-i', str(program_path)]
    partials = []
    for wav, (_, track) in todo:
        partial = str(Path(wav).with_name(Path(wav).stem + '.partial.wav'))
        partials.append((partial, wav))
        cmd += ['-map', f'0:a:{track - 1}', '-c:a', 'copy', '-rf64', 'auto', partial]
        print(f"Extracting {Path(wav).name} from {program_path.name} track {track} ({codecs[track - 1]})",
              file=sys.stderr)

    proc = subprocess.Popen(cmd, stdout=subprocess.PIPE, stderr=subprocess.PIPE, text=True)
    stderr_tail = []

    import threading
    def _drain():
        for line in proc.stderr:
            stderr_tail.append(line)
            del stderr_tail[:-40]
    drainer = threading.Thread(target=_drain, daemon=True)
    drainer.start()

    for line in proc.stdout:
        if line.startswith('out_time_us=') and duration > 0:
            try:
                on_progress(min(1.0, int(line.split('=', 1)[1]) / 1e6 / duration))
            except ValueError:
                pass  # "N/A" before the first packet
    code = proc.wait()
    drainer.join()
    if code != 0:
        for partial, _ in partials:
            if os.path.exists(partial):
                os.unlink(partial)
        raise RuntimeError(f"ffmpeg could not extract the WAVs from {program_path.name} "
                           f"(exit {code}):\n{''.join(stderr_tail)}")
    for partial, wav in partials:
        os.replace(partial, wav)
    return [wav for _, wav in partials]
