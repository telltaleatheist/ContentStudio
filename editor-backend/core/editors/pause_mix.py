# core/editors/pause_mix.py
"""Pauses found without the game audio (Owen, 2026-10-14).

The master recording carries every source merged, game audio included, and a game is
almost never silent: auto-editor on the master found next to no pauses on a set with a
game capture. Whenever the set has its own audio sources, the pauses are found on a mix of
every source but the game instead, and the master's cut list is rewritten from it. That holds
when Game Audio is set to None too (Owen, 2026-10-17: the 10-14 re-run without it kept the
game in through the master, and 5:44-7:01 lost no pauses).

The soundboard track (soundEffects) is left out of that mix too. It plays only when Owen
presses a button, so it has no pauses of its own to give. On the 2026-10-15 OBS set it also
carried the game: program track 6 correlated 0.75 with track 5, at the same level.
"""

import math
import subprocess
import sys
import xml.etree.ElementTree as ET
from fractions import Fraction
from pathlib import Path
from typing import Dict, List, Tuple

from core.editors.smart_cut_filter import SmartCutFilter


def is_game_audio(audio_type: str) -> bool:
    return audio_type.replace('Sb', '') == 'game'


def finds_pauses(audio_type: str) -> bool:
    """Whether a source goes into the pause mix: everything but the game and the soundboard."""
    return audio_type.replace('Sb', '') not in ('game', 'soundEffects')


def _frame_duration(master_xml: str) -> Fraction:
    """The master timeline's frame duration, from its <format frameDuration>."""
    root = ET.parse(master_xml).getroot()
    durations = {f.get('frameDuration') for f in root.iter('format') if f.get('frameDuration')}
    if len(durations) != 1:
        raise ValueError(f"{master_xml}: expected one frameDuration among its formats, found {sorted(durations)}")
    text = durations.pop()
    if not text.endswith('s'):
        raise ValueError(f"{master_xml}: frameDuration {text!r} is not a time in seconds")
    return Fraction(text[:-1])


def _offset_on_master(source: str, master_video: str) -> float:
    """Where `source` sits on the master's timeline (master time = source time + tau), measured
    by GCC-PHAT exactly as the sync step measures it (core/audio_sync.py): a low-confidence
    measurement is used and said, as that step places it."""
    from core.gcc_phat_align import measure_offset, CONFIDENCE_THRESHOLD, FRAME_SECONDS
    align = measure_offset(source, master_video)
    tau = align['tau_seconds']
    windows_ok = [w for w in align['per_window'] if w['confidence'] >= CONFIDENCE_THRESHOLD]
    trusted = (align['confidence'] >= CONFIDENCE_THRESHOLD
               or (len(windows_ok) >= 2 and align['spread_seconds'] <= FRAME_SECONDS))
    print(f"Pauses: {Path(source).name} sits at {tau:+.3f}s on the master "
          f"(conf {align['confidence']:.2f}{'' if trusted else ', LOW: placed as the sync step places it'})",
          file=sys.stderr)
    return tau


def _mix(sources: List[Tuple[str, float]], out_path: Path) -> None:
    """The sources, each moved onto the master's timeline by its offset, summed (no level
    normalising, as a mixer would) into one mono 16 kHz WAV whose time is master time."""
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
    for s, _ in sources:
        cmd += ['-i', s]
    chains = []
    for i, (_, tau) in enumerate(sources):
        if tau >= 0:
            chains.append(f'[{i}:a:0]adelay=delays={tau * 1000:.3f}:all=1[s{i}]')
        else:
            chains.append(f'[{i}:a:0]atrim=start={-tau:.6f},asetpts=PTS-STARTPTS[s{i}]')
    inputs = ''.join(f'[s{i}]' for i in range(len(sources)))
    graph = ';'.join(chains) + f';{inputs}amix=inputs={len(sources)}:duration=longest:normalize=0[m]'
    cmd += ['-filter_complex', graph, '-map', '[m]', '-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(out_path)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Mixing the audio for pause detection failed: {result.stderr.strip()[-800:]}")


def recut_without_game(editor, master_xml: str, master_video: str, audio_sources: Dict[str, str], threshold: str) -> str:
    """Rewrite `master_xml`'s kept segments from the pauses in every audio source that
    `finds_pauses` (not the game, not the soundboard).

    Each source is first moved onto the master's timeline by its measured offset (an OBS
    set's WAVs come out of program.mkv, which starts about a second before master.mp4), so
    the pauses are in master time. Segment edges are snapped outward to the master's frames, and clipped to the master's
    own extent. Returns `master_xml` (rewritten in place).
    """
    others = sorted((t, p) for t, p in audio_sources.items() if p and finds_pauses(t))
    if not others:
        raise ValueError("The set has no audio source but the game and the soundboard, so there is "
                         "nothing to find pauses in without the game.")
    for t, p in others:
        if not Path(p).exists():
            raise FileNotFoundError(f"{t} audio not found for pause detection: {p}")

    master_path = Path(master_xml)
    mix_path = master_path.with_name(f"{master_path.stem}_PAUSE_MIX.wav")
    mix_xml = master_path.with_name(f"{master_path.stem}_PAUSE_MIX.fcpxml")
    print(f"Pauses: finding them without the game audio, on {', '.join(t for t, _ in others)}", file=sys.stderr)
    try:
        _mix([(p, _offset_on_master(p, master_video)) for _, p in others], mix_path)
        editor.cut_silence(str(mix_path), threshold, output_file=str(mix_xml))
        scf = SmartCutFilter()
        master_segments = scf.parse_kept_segments(master_xml)
        if not master_segments:
            raise ValueError(f"{master_xml} has no kept segments to take the master's extent from")
        # auto-editor's master list starts at 0; its last kept end is at most the master's length.
        # The game-free list is clipped to the master's span as auto-editor saw it.
        master_end = max(e for _, e in master_segments)
        frame = _frame_duration(master_xml)
        snapped: List[Tuple[float, float]] = []
        for s, e in scf.parse_kept_segments(str(mix_xml)):
            s_f = math.floor(Fraction(s) / frame) * frame
            e_f = math.ceil(Fraction(e) / frame) * frame
            e_f = min(e_f, Fraction(master_end))
            if e_f <= s_f:
                continue
            if snapped and float(s_f) <= snapped[-1][1]:
                snapped[-1] = (snapped[-1][0], max(snapped[-1][1], float(e_f)))
            else:
                snapped.append((float(s_f), float(e_f)))
        if not snapped:
            raise ValueError("No speech or screen sound was found outside the game audio; refusing an empty edit.")
        print(f"Pauses: {len(master_segments)} kept segments on the master (game included) -> "
              f"{len(snapped)} without the game", file=sys.stderr)
        return scf._rewrite_xml(master_xml, snapped)
    finally:
        for p in (mix_path, mix_xml):
            if p.exists():
                p.unlink()
