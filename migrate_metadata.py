#!/usr/bin/env python3
"""
Metadata Migration Script
Migrates old metadata structure to new organized structure
"""

import os
import re
import json
import shutil
from pathlib import Path
from datetime import datetime


def sanitize_for_filesystem(name: str, fallback: str = 'Unknown') -> str:
    """
    Make a string safe to use as a single path component.

    Replaces path separators and characters that are illegal on common
    filesystems (Windows in particular) so that a '/' in a title cannot
    scatter output across nested directories.
    """
    if name is None:
        return fallback
    # Replace path separators and illegal filesystem characters with '_'
    cleaned = re.sub(r'[<>:"/\\|?*\x00-\x1f]', '_', str(name))
    # Windows does not allow trailing dots/spaces in names
    cleaned = cleaned.strip().rstrip('. ')
    if not cleaned:
        return fallback
    return cleaned


def migrate_metadata(old_metadata_dir: str, output_base_dir: str):
    """
    Migrate metadata from old structure to new structure

    Old structure:
        metadata/
        ├── 20251102_133429_youtube-telltale_the_history_of_ke/
        │   ├── metadata.json
        │   └── the history of kent hovind.txt

    New structure:
        .contentstudio/metadata/
        │   └── job-20251102_133429.json
        the history of kent hovind/
            └── the history of kent hovind.txt
    """

    old_metadata_path = Path(old_metadata_dir)
    output_base_path = Path(output_base_dir)

    if not old_metadata_path.exists():
        print(f"Error: Old metadata directory does not exist: {old_metadata_dir}")
        return

    # Create new directory structure
    json_dir = output_base_path / '.contentstudio' / 'metadata'
    json_dir.mkdir(parents=True, exist_ok=True)

    print(f"Migrating metadata from: {old_metadata_path}")
    print(f"Output base directory: {output_base_path}")
    print(f"JSON directory: {json_dir}")
    print()

    # Get all subdirectories
    old_dirs = [d for d in old_metadata_path.iterdir() if d.is_dir()]

    print(f"Found {len(old_dirs)} metadata directories to migrate\n")

    migrated_count = 0
    skipped_count = 0
    collision_count = 0
    used_job_ids = set()

    for old_dir in old_dirs:
        try:
            # Parse directory name: timestamp_promptset_filename
            dir_name = old_dir.name
            parts = dir_name.split('_', 2)

            if len(parts) < 3:
                print(f"⚠️  Skipping {dir_name} - unexpected format")
                skipped_count += 1
                continue

            timestamp = f"{parts[0]}_{parts[1]}"
            # The rest is prompt set and filename
            remaining = parts[2]

            # Find metadata.json file
            json_file = old_dir / 'metadata.json'
            if not json_file.exists():
                print(f"⚠️  Skipping {dir_name} - no metadata.json found")
                skipped_count += 1
                continue

            # Read the metadata
            with open(json_file, 'r', encoding='utf-8') as f:
                metadata = json.load(f)

            # Get the display title from metadata
            display_title = metadata.get('_title', 'Unknown')
            prompt_set = metadata.get('_prompt_set', 'youtube-telltale')

            # Sanitize the title before using it as a directory name so a '/'
            # (or other illegal char) cannot scatter output across directories.
            safe_title = sanitize_for_filesystem(display_title)
            if safe_title != display_title:
                collision_count += 1
                print(f"⚠️  Sanitized title for filesystem: {display_title!r} -> {safe_title!r}")

            # Find the txt file
            txt_files = list(old_dir.glob('*.txt'))
            if not txt_files:
                print(f"⚠️  Skipping {dir_name} - no txt file found")
                skipped_count += 1
                continue

            txt_file = txt_files[0]

            # Generate a UNIQUE job ID. The timestamp is only second-resolution,
            # so two jobs can share one; de-collide by appending a counter and
            # also guard against JSON files left by a previous run.
            base_job_id = f"job-{timestamp}"
            job_id = base_job_id
            dupe = 1
            while job_id in used_job_ids or (json_dir / f"{job_id}.json").exists():
                job_id = f"{base_job_id}-{dupe}"
                dupe += 1
            if job_id != base_job_id:
                collision_count += 1
                print(f"⚠️  Job id collision for {base_job_id}; using {job_id}")
            used_job_ids.add(job_id)

            # Create new TXT folder with sanitized name
            txt_folder = output_base_path / safe_title
            txt_folder.mkdir(parents=True, exist_ok=True)

            # Copy TXT file to new location; de-collide the filename so a same-
            # titled job does not overwrite an already-migrated TXT file.
            new_txt_path = txt_folder / txt_file.name
            if new_txt_path.exists():
                stem, suffix = new_txt_path.stem, new_txt_path.suffix
                dupe = 1
                while new_txt_path.exists():
                    new_txt_path = txt_folder / f"{stem}-{dupe}{suffix}"
                    dupe += 1
                collision_count += 1
                print(f"⚠️  TXT filename collision in {safe_title!r}; writing as {new_txt_path.name}")
            shutil.copy2(txt_file, new_txt_path)

            # Create new JSON structure
            job_metadata = {
                'job_id': job_id,
                'job_name': display_title,
                'prompt_set': prompt_set,
                'created_at': datetime.fromtimestamp(json_file.stat().st_mtime).isoformat(),
                'txt_folder': str(txt_folder),
                'items': [metadata]
            }

            # Save new JSON file
            new_json_path = json_dir / f"{job_id}.json"
            with open(new_json_path, 'w', encoding='utf-8') as f:
                json.dump(job_metadata, f, indent=2, ensure_ascii=False)

            print(f"✅ Migrated: {display_title}")
            print(f"   JSON: {new_json_path.name}")
            print(f"   TXT:  {txt_folder.name}/{new_txt_path.name}")
            print()

            migrated_count += 1

        except Exception as e:
            print(f"❌ Error migrating {old_dir.name}: {e}")
            skipped_count += 1

    print("\n" + "="*60)
    print(f"Migration complete!")
    print(f"  Migrated:   {migrated_count}")
    print(f"  Skipped:    {skipped_count}")
    print(f"  Collisions: {collision_count} (de-collided / sanitized)")
    print(f"  Total:      {len(old_dirs)}")
    print("="*60)

    if migrated_count > 0:
        print(f"\n📁 Old metadata directory: {old_metadata_path}")
        print(f"📁 New JSON directory:     {json_dir}")
        print(f"📁 New TXT directories:    {output_base_path}")
        print("\n⚠️  The old metadata directory has NOT been deleted.")
        print("   Please verify the migration and delete it manually if desired.")

if __name__ == "__main__":
    import sys

    if len(sys.argv) < 2:
        print("Usage: python3 migrate_metadata.py <old_metadata_dir> [output_base_dir]")
        print()
        print("Example:")
        print("  python3 migrate_metadata.py /Volumes/Callisto/ContentStudio/metadata /Volumes/Callisto/ContentStudio")
        sys.exit(1)

    old_dir = sys.argv[1]
    output_dir = sys.argv[2] if len(sys.argv) > 2 else str(Path(old_dir).parent)

    migrate_metadata(old_dir, output_dir)
