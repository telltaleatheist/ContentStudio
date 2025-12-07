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
        # Write back
        with open(file_path, 'w', encoding='utf-8') as f:
            yaml.dump(data, f, allow_unicode=True, default_flow_style=False, sort_keys=False)
        print(f"  ✅ Migration complete")
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

    for file_path in yaml_files:
        migrate_prompt_file(file_path)
        print()

    print("✅ All migrations complete!")

if __name__ == '__main__':
    main()
