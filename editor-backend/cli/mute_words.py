#!/usr/bin/env python3
# cli/mute_words.py
#
# Apply (or re-apply) a project's Mute words choice to the master timeline it has ALREADY
# exported — "<session> master edited.fcpxml" next to the zip — without exporting again. The
# right-click "Mute words…" modal runs this after a save; every export also runs the same pass
# itself (cli/editor_export.py), so this is only for a timeline that is already on disk.
#
# The earlier run's mutes are removed and the current choice is placed fresh (the pipeline
# writes no other <mute>, see word_mute_pass.strip_mutes), so pressing Apply twice is the same
# as pressing it once. The file is replaced atomically.
#
# Refuses, by name, rather than guessing:
#   - no exported master timeline yet  -> export it (the mutes go in with the export);
#   - the export is older than the zip -> it was made from an earlier processing run;
#   - no saved choice, or a choice that needs a transcript the session does not have.
#
# Invocation:  python cli/mute_words.py --zip /abs/<name>_compounds.zip
# Output (stdout, one line):
#     {"type":"mute_result","path":"/abs/<session> master edited.fcpxml","wordMutes":{...}}
#     {"type":"error","message":"..."}  (+ exit code 1)

import argparse
import json
import os
import sys
from pathlib import Path
import xml.etree.ElementTree as ET

_REPO_ROOT = Path(__file__).resolve().parent.parent
if str(_REPO_ROOT) not in sys.path:
    sys.path.insert(0, str(_REPO_ROOT))

from cli.editor_manifest import ManifestError, _session_name  # noqa: E402
from cli.editor_export import STORIES_EVENT_SUFFIX  # noqa: E402
from cli import word_mute_pass  # noqa: E402
from core.word_mutes import settings_path_for_zip  # noqa: E402
from core.xml_utils import FCPXMLUtils  # noqa: E402


def exported_master_path(zip_path):
    """The one file every FCPXML export writes (editor_export.export / export_stories)."""
    return Path(zip_path).parent / f"{_session_name(zip_path)} master edited.fcpxml"


def apply_to_export(zip_path):
    zp = Path(zip_path)
    if not zp.is_file():
        raise ManifestError(f"zip not found: {zip_path}")
    session = _session_name(zip_path)
    if not settings_path_for_zip(zip_path, session).is_file():
        raise ManifestError("No Mute words choice is saved for this project yet — save one first.")
    target = exported_master_path(zip_path)
    if not target.is_file():
        raise ManifestError(
            "This project's master timeline has not been exported yet, so there is nothing to put "
            "the mutes on. Export it from the editor (File ▸ Export…) — the mutes are written into "
            "it as part of every export.")
    if target.stat().st_mtime < zp.stat().st_mtime:
        raise ManifestError(
            f"{target.name} was exported before this session was last processed, so its clips may "
            "not match the transcript. Export it again from the editor — the mutes go in with it.")
    try:
        tree = ET.parse(str(target))
    except ET.ParseError as e:
        raise ManifestError(f"{target.name}: XML parse error: {e}")
    event = tree.getroot().find('.//event')
    stories = event is not None and (event.get('name') or '').endswith(STORIES_EVENT_SUFFIX)
    report = word_mute_pass.run_on_tree(zip_path, tree, 'stories' if stories else 'plain',
                                        entry_hint=target.name)
    tmp = target.with_name(target.name + '.writing')
    FCPXMLUtils.save_fcpxml(tree, str(tmp))
    os.replace(tmp, target)
    print(f"[mute_words] wrote {target}", file=sys.stderr)
    return {'type': 'mute_result', 'path': str(target), 'wordMutes': report}


def main(argv=None):
    parser = argparse.ArgumentParser(description="Re-apply a project's Mute words choice to its exported master timeline.")
    parser.add_argument('--zip', dest='zip_path', required=True)
    args = parser.parse_args(argv)
    try:
        result = apply_to_export(args.zip_path)
    except ManifestError as e:
        sys.stdout.write(json.dumps({'type': 'error', 'message': str(e)}) + '\n')
        return 1
    except Exception as e:  # unexpected — still loud, never a partial success
        sys.stdout.write(json.dumps({'type': 'error', 'message': f"{type(e).__name__}: {e}"}) + '\n')
        return 1
    sys.stdout.write(json.dumps(result) + '\n')
    return 0


if __name__ == '__main__':
    sys.exit(main())
