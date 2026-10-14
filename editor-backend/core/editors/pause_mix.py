# core/editors/pause_mix.py
"""Pauses found without the game audio (Owen, 2026-10-14).

The master recording carries every source merged, game audio included, and a game is
almost never silent: auto-editor on the master found next to no pauses on a set with a
game capture. When the set has game audio, the pauses are found on a mix of every OTHER
audio source instead, and the master's cut list is rewritten from it.
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


def _mix(sources: List[str], out_path: Path) -> None:
    """The sources summed (no level normalising, as a mixer would) into one mono 16 kHz WAV."""
    cmd = ['ffmpeg', '-hide_banner', '-loglevel', 'error', '-y']
    for s in sources:
        cmd += ['-i', s]
    if len(sources) == 1:
        cmd += ['-map', '0:a:0']
    else:
        inputs = ''.join(f'[{i}:a:0]' for i in range(len(sources)))
        cmd += ['-filter_complex', f'{inputs}amix=inputs={len(sources)}:duration=longest:normalize=0[m]', '-map', '[m]']
    cmd += ['-ac', '1', '-ar', '16000', '-c:a', 'pcm_s16le', str(out_path)]
    result = subprocess.run(cmd, capture_output=True, text=True)
    if result.returncode != 0:
        raise RuntimeError(f"Mixing the audio for pause detection failed: {result.stderr.strip()[-800:]}")


def recut_without_game(editor, master_xml: str, audio_sources: Dict[str, str], threshold: str) -> str:
    """Rewrite `master_xml`'s kept segments from the pauses in every non-game audio source.

    Segment edges are snapped outward to the master's frames, and clipped to the master's
    own extent. Returns `master_xml` (rewritten in place).
    """
    others = sorted((t, p) for t, p in audio_sources.items() if p and not is_game_audio(t))
    if not others:
        raise ValueError("The set has game audio and no other audio source, so there is nothing "
                         "to find pauses in without the game.")
    for t, p in others:
        if not Path(p).exists():
            raise FileNotFoundError(f"{t} audio not found for pause detection: {p}")

    master_path = Path(master_xml)
    mix_path = master_path.with_name(f"{master_path.stem}_PAUSE_MIX.wav")
    mix_xml = master_path.with_name(f"{master_path.stem}_PAUSE_MIX.fcpxml")
    print(f"Pauses: finding them without the game audio, on {', '.join(t for t, _ in others)}", file=sys.stderr)
    try:
        _mix([p for _, p in others], mix_path)
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
