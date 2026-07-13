#!/usr/bin/env python3
"""
Migrate prompt YAML files to new structure:
- editorial_guidelines → editorial_prompt
- generation_instructions → instructions_prompt
- Remove platform field
- Add {subject} placeholder if missing
"""

import os
import sys
import shutil
import tempfile
import yaml
from pathlib import Path

def migrate_prompt_file(file_path):
    """Migrate a single prompt YAML file"""
    print(f"Migrating {file_path}...")

    # Read the file
    with open(file_path, 'r', encoding='utf-8') as f:
        data = yaml.safe_load(f)

    if not data:
        print(f"  Skipping empty file")
        return

    modified = False

    # Rename editorial_guidelines → editorial_prompt
    if 'editorial_guidelines' in data:
        editorial = data['editorial_guidelines']
        # Add {subject} placeholder if not present
        if '{subject}' not in editorial:
            editorial = editorial + '\n\n{subject}'
        data['editorial_prompt'] = editorial
        del data['editorial_guidelines']
        modified = True
        print(f"  ✓ Renamed editorial_guidelines → editorial_prompt")

    # Rename generation_instructions → instructions_prompt
    if 'generation_instructions' in data:
        data['instructions_prompt'] = data['generation_instructions']
        del data['generation_instructions']
        modified = True
        print(f"  ✓ Renamed generation_instructions → instructions_prompt")

    # Remove platform field
    if 'platform' in data:
        del data['platform']
        modified = True
        print(f"  ✓ Removed platform field")

    if modified:
        file_path = Path(file_path)

        # Serialize to a string FIRST. If yaml.dump raises, the original file
        # is still fully intact (never truncated).
        new_content = yaml.dump(
            data, allow_unicode=True, default_flow_style=False, sort_keys=False
        )

        # Keep a backup of the original before replacing it.
        backup_path = file_path.with_suffix(file_path.suffix + '.bak')
        shutil.copy2(file_path, backup_path)

        # Write atomically: temp file in the same directory + os.replace, so the
        # target is either the old file or the fully-written new one — never a
        # half-written file if the process dies mid-write.
        fd, tmp_path = tempfile.mkstemp(dir=str(file_path.parent), suffix='.tmp')
        try:
            with os.fdopen(fd, 'w', encoding='utf-8') as f:
                f.write(new_content)
            try:
                shutil.copymode(file_path, tmp_path)
            except OSError:
                pass
            os.replace(tmp_path, file_path)
        except BaseException:
            if os.path.exists(tmp_path):
                os.unlink(tmp_path)
            raise
        print(f"  ✅ Migration complete (backup: {backup_path.name})")
    else:
        print(f"  Already migrated")

def main():
    # Get prompt sets directory
    prompt_sets_dir = Path.home() / 'Library' / 'Application Support' / 'ContentStudio' / 'prompt_sets'

    if not prompt_sets_dir.exists():
        print(f"Prompt sets directory not found: {prompt_sets_dir}")
        sys.exit(1)

    print(f"Scanning {prompt_sets_dir}...")

    # Find all YAML files
    yaml_files = list(prompt_sets_dir.glob('*.yml')) + list(prompt_sets_dir.glob('*.yaml'))

    if not yaml_files:
        print("No YAML files found")
        sys.exit(0)

    print(f"Found {len(yaml_files)} files to migrate\n")

    failures = []
    for file_path in yaml_files:
        # Isolate each file so one bad file cannot abort the whole run.
        try:
            migrate_prompt_file(file_path)
        except Exception as e:
            print(f"  ❌ Failed to migrate {file_path}: {e}")
            failures.append((file_path, str(e)))
        print()

    if failures:
        print("⚠️  Some files failed to migrate:")
        for fp, err in failures:
            print(f"   - {fp}: {err}")
        print(f"\n{len(failures)} of {len(yaml_files)} file(s) failed.")
        sys.exit(1)

    print("✅ All migrations complete!")

if __name__ == '__main__':
    main()
