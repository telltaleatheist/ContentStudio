#!/usr/bin/env python3
"""
Metadata Migration Script
Migrates old metadata structure to new organized structure
"""

import os
import json
import shutil
from pathlib import Path
from datetime import datetime

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

            # Find the txt file
            txt_files = list(old_dir.glob('*.txt'))
            if not txt_files:
                print(f"⚠️  Skipping {dir_name} - no txt file found")
                skipped_count += 1
                continue

            txt_file = txt_files[0]

            # Generate job ID
            job_id = f"job-{timestamp}"

            # Create new TXT folder with clean name
            txt_folder = output_base_path / display_title
            txt_folder.mkdir(parents=True, exist_ok=True)

            # Copy TXT file to new location
            new_txt_path = txt_folder / txt_file.name
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
            print(f"   TXT:  {txt_folder.name}/{txt_file.name}")
            print()

            migrated_count += 1

        except Exception as e:
            print(f"❌ Error migrating {old_dir.name}: {e}")
            skipped_count += 1

    print("\n" + "="*60)
    print(f"Migration complete!")
    print(f"  Migrated: {migrated_count}")
    print(f"  Skipped:  {skipped_count}")
    print(f"  Total:    {len(old_dirs)}")
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
