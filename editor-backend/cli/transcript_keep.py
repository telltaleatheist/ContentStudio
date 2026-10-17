#!/usr/bin/env python3
# cli/transcript_keep.py
#
# "Use existing transcript" for a re-process (LEDGER #315, Owen 2026-10-17: "if it says use
# existing transcript, it doesnt delete it. it just puts it back exactly where it was when its
# done processing"). No decoding happens here at all: the SAME words are re-placed onto the
# rebuilt timeline from their FILE times, through the new compound's segments, by the very
# function transcribe.py places freshly decoded words with (map_file_words).
#
# Three steps, each its own invocation, run by Electron main (editor-ipc.ts execute-workflow):
#
#   keep     BEFORE the workflow is spawned. `<session>_transcript.json` is moved into
#            `<session>_kept_transcript/transcript.json`, beside a copy of the alignment it was
#            made against (`<session>_alignment.json`, which the run overwrites) and of the
#            compounds zip (its cut list), and keep.json (the zip's SHA-256). The folder's name
#            cannot be read as a current transcript by anything that looks for one.
#            A folder left by an earlier run that never finished (the app quit mid-run) is
#            adopted as it is: its snapshot is still the one its transcript was made against.
#   replace  AFTER a successful run. Re-places the kept words onto the rebuilt session and
#            writes `<session>_transcript.json` atomically; when nothing about the placement
#            changed, the kept file itself goes back (byte-identical). Then the folder goes.
#   restore  AFTER a failed or cancelled run. If the zip is the one the transcript was kept
#            with, the kept file goes back untouched. If the run got as far as writing a new
#            zip, the words are re-placed onto it as `replace` does (an untouched file would
#            sit on cut boundaries that no longer exist).
#
# A refusal leaves the folder exactly as it is, so nothing is lost, and its message says which
# track and that Re-transcribe is needed. Refused (never guessed, never re-decoded):
#   - a kept track whose file is not in the rebuilt session, or a rebuilt track the kept
#     transcript never transcribed;
#   - a track whose clock-drift factor or speed factor changed (that stretches the file, it
#     does not shift it), or whose sync method is not one whose trim is known;
#   - a track aligned in one run and not the other.
# A track whose sync OFFSET changed is re-placed through it: the processed WAV is the raw
# recording plus a constant (core/sync_offset.applied_offset_seconds, the same decision that
# builds the trim filter), so a moment's new file time is its old one plus
#     applied(new offset) - applied(old offset).
#
# Words whose file time now falls in a cut are not on the timeline: counted and logged per
# track. Kept file time the OLD cut list had removed has no words in the kept transcript (they
# were never in it); that is counted and said per track too, since only Re-transcribe fills it.
#
# Invocation:  python cli/transcript_keep.py {keep|replace|restore} --zip /abs/<name>_compounds.zip
# Output (stdout, one line):
#     {"type":"keep_result","result":{...}}
#     {"type":"error","message":"..."}  (+ exit code 1)
# Diagnostics on stderr.

import argparse
import hashlib
import json
import os
import shutil
import sys
import time
from pathlib import Path

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))
from cli import transcribe as _t  # noqa: E402
from cli.editor_manifest import ManifestError, _session_name  # noqa: E402
from core.sync_offset import applied_offset_seconds  # noqa: E402

KEEP_SCHEMA = 1
RETRANSCRIBE = 'Choose Re-transcribe to build a new transcript.'
# Sync methods whose processed file is the raw recording (after any recorded drift/speed
# retime) plus a constant offset (core/audio_sync.apply_sync_to_audio; electron_workflow.py
# _write_alignment_sidecar names them).
TRIM_METHODS = {'gcc-phat', 'manual-override', 'unified-soundboard', 'reused-from-previous-run'}
# The keys a sidecar word may carry (transcribe.map_file_words). Anything else would be
# silently dropped by a re-place, so it is refused instead.
WORD_KEYS = {'track', 'text', 'timelineStart', 'timelineEnd', 'fileStart', 'fileEnd', 'group', 'prob'}


class KeepError(Exception):
    """A loud, user-facing refusal; its message is emitted verbatim."""


def _log(msg):
    print(f"[transcript-keep] {msg}", file=sys.stderr)


# ---------------------------------------------------------------------------
# Paths.
# ---------------------------------------------------------------------------
def paths_for(zip_path):
    d = Path(zip_path).parent
    session = _session_name(zip_path)
    keep = d / f"{session}_kept_transcript"
    return {
        'session': session,
        'transcript': d / f"{session}_transcript.json",
        'alignment': d / f"{session}_alignment.json",
        'keep': keep,
        'kept_transcript': keep / 'transcript.json',
        'kept_alignment': keep / 'alignment.json',
        'kept_zip': keep / Path(zip_path).name,
        'kept_meta': keep / 'keep.json',
    }


def _sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as fh:
        for block in iter(lambda: fh.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def _read_json(path, what):
    try:
        with open(path, 'r') as fh:
            return json.load(fh)
    except (OSError, json.JSONDecodeError) as e:
        raise KeepError(f"{what} {path} could not be read: {e}")


def _write_json_atomic(path, obj):
    tmp = Path(str(path) + '.tmp')
    with open(tmp, 'w') as fh:
        json.dump(obj, fh)
    os.replace(tmp, path)


# ---------------------------------------------------------------------------
# keep
# ---------------------------------------------------------------------------
def keep(zip_path):
    p = paths_for(zip_path)
    if p['keep'].exists():
        meta = _read_kept(p)
        if p['transcript'].exists():
            raise KeepError(
                f"{p['transcript'].name} and {p['keep'].name}/ both exist: the folder holds a "
                f"transcript set aside by an earlier run (kept {meta['keptAt']}), and there is a "
                f"current one as well, so which to keep cannot be told. Delete the one you do "
                f"not want, or {RETRANSCRIBE}")
        _log(f"adopting {p['keep']} (kept {meta['keptAt']} by a run that did not finish)")
        return {'kept': str(p['keep']), 'adopted': True}

    if not p['transcript'].is_file():
        raise KeepError(f"there is no {p['transcript'].name} beside {Path(zip_path).name} to keep")
    if not Path(zip_path).is_file():
        raise KeepError(f"the session zip {zip_path} is not on disk, so the transcript's cut "
                        f"list cannot be kept with it")
    # Read before anything moves: an unreadable transcript is refused while it is still in place.
    old = _read_json(p['transcript'], 'the transcript')
    _validate_sidecar(old, p['transcript'])

    # The folder is filled first and the transcript moved into it LAST, so a crash at any point
    # leaves either the transcript where it was or the whole snapshot in the folder.
    p['keep'].mkdir()
    has_alignment = p['alignment'].is_file()
    try:
        shutil.copy2(zip_path, p['kept_zip'])
        if has_alignment:
            shutil.copy2(p['alignment'], p['kept_alignment'])
        meta = {
            'schemaVersion': KEEP_SCHEMA,
            'session': p['session'],
            'keptAt': time.strftime('%Y-%m-%dT%H:%M:%S%z'),
            'zipName': Path(zip_path).name,
            'zipSha256': _sha256(zip_path),
            'alignment': has_alignment,
        }
        _write_json_atomic(p['kept_meta'], meta)
    except Exception:
        # Only copies are in it yet and the transcript has not moved: the folder goes, and the
        # failure is raised as it was.
        shutil.rmtree(p['keep'])
        raise
    os.rename(p['transcript'], p['kept_transcript'])
    _log(f"moved {p['transcript']} to {p['kept_transcript']} "
         f"({len(old['words'])} words; alignment {'copied' if has_alignment else 'absent'})")
    return {'kept': str(p['keep']), 'adopted': False, 'words': len(old['words'])}


def _read_kept(p):
    for key in ('kept_meta', 'kept_transcript', 'kept_zip'):
        if not p[key].is_file():
            raise KeepError(f"{p['keep']} is incomplete: {p[key].name} is missing. Nothing in it "
                            f"was changed; look inside before deleting it, or {RETRANSCRIBE}")
    meta = _read_json(p['kept_meta'], 'the keep record')
    if not isinstance(meta, dict) or meta.get('schemaVersion') != KEEP_SCHEMA:
        raise KeepError(f"{p['kept_meta']} is not a schema-{KEEP_SCHEMA} keep record")
    if meta.get('alignment') and not p['kept_alignment'].is_file():
        raise KeepError(f"{p['keep']} says it kept the alignment, but {p['kept_alignment'].name} "
                        f"is not in it")
    return meta


def _remove_keep(p):
    """Only the files this script put there; anything else stops rmdir, loudly."""
    for key in ('kept_transcript', 'kept_alignment', 'kept_zip', 'kept_meta'):
        if p[key].exists():
            os.remove(p[key])
    os.rmdir(p['keep'])
    _log(f"removed {p['keep']}")


# ---------------------------------------------------------------------------
# The re-place (pure: no files, so the checks can drive it directly).
# ---------------------------------------------------------------------------
def _validate_sidecar(sc, where):
    if not isinstance(sc, dict) or sc.get('schemaVersion') != 1:
        raise KeepError(f"{where} is not a schema-1 transcript")
    if not isinstance(sc.get('tracks'), list) or not isinstance(sc.get('words'), list):
        raise KeepError(f"{where} has no tracks/words lists")


def _by_name(tracks, what):
    out = {}
    for t in tracks:
        name = Path(t['file']).name
        if name in out:
            raise KeepError(f"{what} lists {name} twice ({out[name]['id']} and {t['id']})")
        out[name] = t
    return out


def _audio_entries(alignment):
    if alignment is None:
        return []
    if not isinstance(alignment, dict) or not isinstance(alignment.get('sources'), list):
        raise KeepError("an alignment record has no sources list")
    return [s for s in alignment['sources'] if isinstance(s, dict) and s.get('kind') == 'audio']


def _alignment_by_file(old_alignment, new_alignment):
    """({file name: new entry}, {file name: old entry}, old types no file could be given).

    New records name each source's file (processedFile). An OLD record from before LEDGER #315
    names none: its entries are paired by source type with the new record's (the type is what
    the setup modal assigned the file to); a type the new run did not align is left unpaired,
    and a track that would need it is refused below."""
    new_entries = _audio_entries(new_alignment)
    if any('processedFile' not in e for e in new_entries):
        raise KeepError("the rebuilt session's alignment record does not name its files "
                        "(processedFile), so its tracks cannot be paired with the transcript's")
    new_by_file, new_type_file = {}, {}
    for e in new_entries:
        name = Path(e['processedFile']).name
        if name in new_by_file:
            raise KeepError(f"the rebuilt session's alignment names {name} for two sources")
        new_by_file[name] = e
        new_type_file[e['type']] = name

    old_entries = _audio_entries(old_alignment)
    named = [e for e in old_entries if 'processedFile' in e]
    if named and len(named) != len(old_entries):
        raise KeepError("the kept alignment record names files for some sources and not others")
    old_by_file, unpaired = {}, []
    if named or not old_entries:
        for e in old_entries:
            name = Path(e['processedFile']).name
            if name in old_by_file:
                raise KeepError(f"the kept alignment names {name} for two sources")
            old_by_file[name] = e
    else:
        _log("the kept alignment predates file names; pairing its sources by type")
        for e in old_entries:
            name = new_type_file.get(e['type'])
            if name is None:
                unpaired.append(e['type'])
            else:
                old_by_file[name] = e
    return new_by_file, old_by_file, unpaired


def track_shift(track, old_e, new_e, unpaired):
    """Seconds to add to this track's kept file times, or a KeepError saying why there is none."""
    who = f"track {track['id']} ({track['label']})"
    if old_e is None and new_e is None:
        if unpaired:
            raise KeepError(
                f"{who}: the kept alignment record names no files and lists sources this run "
                f"did not align ({', '.join(sorted(unpaired))}), so whether this file was "
                f"trimmed when the transcript was made cannot be told. {RETRANSCRIBE}")
        return 0.0              # used verbatim both times (the master of a master-only set)
    if old_e is None or new_e is None:
        when = 'this run' if old_e is None else 'the run the transcript was made from'
        raise KeepError(f"{who}: it was aligned by only one of the two runs (not by {when}), "
                        f"so its file times do not mean the same moment. {RETRANSCRIBE}")
    for e in (old_e, new_e):
        if e.get('method') not in TRIM_METHODS:
            raise KeepError(f"{who}: its sync method {e.get('method')!r} is not one whose trim is "
                            f"known, so its words cannot be moved with it. {RETRANSCRIBE}")
    old_off, new_off = float(old_e['offsetSeconds']), float(new_e['offsetSeconds'])
    if new_e['method'] == 'reused-from-previous-run':
        # The file was adopted as it was on disk: not re-derived, so not moved.
        if new_off != old_off:
            raise KeepError(f"{who}: this run reused the processed file but records offset "
                            f"{new_off:.6f}s against {old_off:.6f}s when the transcript was made")
        return 0.0
    if old_e.get('driftFactor') != new_e.get('driftFactor'):
        raise KeepError(f"{who}: its clock-drift factor changed ({old_e.get('driftFactor')} -> "
                        f"{new_e.get('driftFactor')}), which stretches the file rather than "
                        f"shifting it. {RETRANSCRIBE}")
    if 'speedFactor' in old_e:
        if old_e['speedFactor'] != new_e.get('speedFactor'):
            raise KeepError(f"{who}: its speed factor changed ({old_e['speedFactor']} -> "
                            f"{new_e.get('speedFactor')}), which stretches the file rather than "
                            f"shifting it. {RETRANSCRIBE}")
    elif new_e.get('speedFactor', 1.0) != 1.0:
        # Only a soundboard file is retimed (by the drift config); the kept record predates the
        # field, so whether its speed was the same cannot be told.
        raise KeepError(f"{who}: this run retimed it by speed factor {new_e['speedFactor']} and "
                        f"the kept alignment does not record the speed it was made with. "
                        f"{RETRANSCRIBE}")
    return applied_offset_seconds(new_off) - applied_offset_seconds(old_off)


def _union_length(ranges):
    total, end = 0.0, None
    for s, e in sorted(ranges):
        if end is None or s > end:
            total += e - s
            end = e
        elif e > end:
            total += e - end
            end = e
    return total


def _uncovered_seconds(new_segments, old_segments, shift):
    """Kept file time in the new cut list that the old one had cut (so no word can be there)."""
    old = sorted((s['source_start'] + shift, s['source_end'] + shift) for s in old_segments)
    total = 0.0
    for seg in new_segments:
        a, b = seg['source_start'], seg['source_end']
        covered = [(max(a, s), min(b, e)) for s, e in old if s < b and e > a]
        total += (b - a) - _union_length(covered)
    return total


def replace_words(old, session, frame_seconds, new_tracks, old_segments_for,
                  old_alignment, new_alignment):
    """The re-placed sidecar and a per-track report. `old_segments_for()` returns {file name:
    that file's segments} in the zip the transcript was kept with (the old cut list); it is
    called only once every track has been matched, so a missing track is refused by name."""
    _validate_sidecar(old, 'the kept transcript')
    if old.get('session') != session:
        raise KeepError(f"the kept transcript is for session {old.get('session')!r}, "
                        f"not {session!r}")
    old_by_name = _by_name(old['tracks'], 'the kept transcript')
    new_by_name = _by_name(new_tracks, 'the rebuilt session')
    problems = []
    for name, t in old_by_name.items():
        if name not in new_by_name:
            problems.append(f"track {t['id']} ({t['label']}): its file {name} is not in the "
                            f"rebuilt session, so its words have nowhere to go")
    for name, t in new_by_name.items():
        if name not in old_by_name:
            problems.append(f"track {t['label']} ({name}) is new in the rebuilt session and the "
                            f"kept transcript has no words for it")
    if problems:
        raise KeepError('; '.join(problems) + f". {RETRANSCRIBE}")

    new_by_file, old_by_file, unpaired = _alignment_by_file(old_alignment, new_alignment)
    old_tracks_segments = old_segments_for()

    words_by_old_id = {t['id']: [] for t in old['tracks']}
    for i, w in enumerate(old['words']):
        extra = set(w) - WORD_KEYS
        if extra:
            raise KeepError(f"kept word {i} carries {sorted(extra)}, which a re-place would lose")
        if w.get('track') not in words_by_old_id:
            raise KeepError(f"kept word {i} names track {w.get('track')!r}, which the kept "
                            f"transcript does not list")
        words_by_old_id[w['track']].append(w)

    all_words, report = [], []
    for track in new_tracks:
        name = Path(track['file']).name
        old_track = old_by_name[name]
        shift = track_shift(track, old_by_file.get(name), new_by_file.get(name), unpaired)
        kept = words_by_old_id[old_track['id']]
        file_words = []
        for w in kept:
            fw = {'text': w['text'],
                  'fileStart': w['fileStart'] + shift if shift else w['fileStart'],
                  'fileEnd': w['fileEnd'] + shift if shift else w['fileEnd']}
            if 'prob' in w:
                fw['prob'] = w['prob']
            file_words.append(fw)
        mapped = _t.map_file_words(track, file_words)
        dropped = len(file_words) - len(mapped)
        if name not in old_tracks_segments:
            raise KeepError(f"track {track['id']} ({track['label']}): {name} is not in the zip "
                            f"the transcript was kept with")
        uncovered = _uncovered_seconds(track['segments'], old_tracks_segments[name], shift)
        if shift:
            _log(f"{track['id']} {track['label']}: offset moved {shift:.3f}s, words shifted")
        _log(f"{track['id']} {track['label']}: {len(mapped)} words placed, {dropped} now in a cut"
             + (f", {uncovered:.1f}s kept that was cut when it was transcribed (no words there)"
                if uncovered > frame_seconds else ''))
        report.append({'id': track['id'], 'label': track['label'], 'shiftSeconds': shift,
                       'placed': len(mapped), 'droppedInCuts': dropped,
                       'uncoveredSeconds': uncovered if uncovered > frame_seconds else 0.0})
        all_words.extend(mapped)

    # The order transcribe.py writes: (track, fileStart), track in discovery order.
    track_order = {t['id']: i for i, t in enumerate(new_tracks)}
    all_words.sort(key=lambda w: (track_order[w['track']], w['fileStart']))
    sidecar = {
        'schemaVersion': 1,
        'session': session,
        'model': old.get('model'),
        'calibration': old.get('calibration'),
        'frameSeconds': frame_seconds,
        'tracks': [{'id': t['id'], 'label': t['label'], 'file': t['file']} for t in new_tracks],
        'words': all_words,
    }
    return sidecar, report


# ---------------------------------------------------------------------------
# replace / restore
# ---------------------------------------------------------------------------
def replace(zip_path):
    p = paths_for(zip_path)
    if not p['keep'].is_dir():
        raise KeepError(f"there is no {p['keep'].name}/ beside {Path(zip_path).name}: nothing "
                        f"was kept to put back")
    meta = _read_kept(p)
    if p['transcript'].exists():
        raise KeepError(f"{p['transcript'].name} already exists beside the rebuilt session, and "
                        f"the kept one is in {p['keep'].name}/; neither was touched")
    if not p['alignment'].is_file():
        raise KeepError(f"the rebuilt session has no {p['alignment'].name}, so its tracks' "
                        f"offsets cannot be compared with the kept transcript's")
    old = _read_json(p['kept_transcript'], 'the kept transcript')
    old_alignment = _read_json(p['kept_alignment'], 'the kept alignment') if meta['alignment'] else None
    new_alignment = _read_json(p['alignment'], 'the alignment record')
    session, frame_seconds, new_tracks = _t.discover_tracks(zip_path)

    def old_segments():
        _s, _f, kept_tracks = _t.discover_tracks(str(p['kept_zip']))
        return {Path(t['file']).name: t['segments'] for t in kept_tracks}

    sidecar, report = replace_words(old, session, frame_seconds, new_tracks, old_segments,
                                    old_alignment, new_alignment)
    identical = sidecar == old
    if identical:
        os.replace(p['kept_transcript'], p['transcript'])
        _log(f"nothing about the placement changed: {p['kept_transcript']} put back as it was")
    else:
        _t._atomic_write_json(str(p['transcript']), sidecar)
        _log(f"wrote {p['transcript']} ({len(sidecar['words'])} of {len(old['words'])} words)")
    _remove_keep(p)
    return {'outcome': 'replaced', 'identical': identical, 'transcriptPath': str(p['transcript']),
            'wordCount': len(sidecar['words']), 'keptWordCount': len(old['words']),
            'tracks': report}


def restore(zip_path):
    p = paths_for(zip_path)
    meta = _read_kept(p) if p['keep'].is_dir() else None
    if meta is None:
        raise KeepError(f"there is no {p['keep'].name}/ beside {Path(zip_path).name}: nothing "
                        f"was kept to put back")
    if Path(zip_path).is_file() and _sha256(zip_path) == meta['zipSha256']:
        if p['transcript'].exists():
            raise KeepError(f"{p['transcript'].name} already exists, and the kept one is in "
                            f"{p['keep'].name}/; neither was touched")
        os.replace(p['kept_transcript'], p['transcript'])
        _log(f"the session zip is unchanged: {p['transcript']} put back untouched")
        _remove_keep(p)
        return {'outcome': 'restored', 'transcriptPath': str(p['transcript'])}
    if not Path(zip_path).is_file():
        raise KeepError(f"the session zip {zip_path} is gone, so the kept transcript has no "
                        f"session to go back to; it is preserved in {p['keep']}")
    _log("the run wrote a new session zip before it ended: re-placing the kept words onto it")
    return replace(zip_path)


def main(argv=None):
    parser = argparse.ArgumentParser(description="Keep a transcript across a re-process.")
    parser.add_argument('action', choices=['keep', 'replace', 'restore'])
    parser.add_argument('--zip', dest='zip_path', required=True)
    args = parser.parse_args(argv)
    action = {'keep': keep, 'replace': replace, 'restore': restore}[args.action]
    try:
        result = action(args.zip_path)
    except (KeepError, _t.TranscribeError, ManifestError) as e:
        message = str(e)
        if args.action != 'keep' and paths_for(args.zip_path)['keep'].is_dir():
            message += f" The kept transcript is preserved in {paths_for(args.zip_path)['keep']}."
        print(json.dumps({'type': 'error', 'message': message}), flush=True)
        return 1
    except Exception as e:  # unexpected — still loud
        message = f"{type(e).__name__}: {e}"
        if args.action != 'keep' and paths_for(args.zip_path)['keep'].is_dir():
            message += f" The kept transcript is preserved in {paths_for(args.zip_path)['keep']}."
        print(json.dumps({'type': 'error', 'message': message}), flush=True)
        return 1
    print(json.dumps({'type': 'keep_result', 'result': result}), flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
