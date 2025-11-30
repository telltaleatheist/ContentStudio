#!/usr/bin/env python3
"""
Output Handler for LaunchPad
Saves metadata to files in user-friendly formats
"""

import json
import sys
from pathlib import Path
from typing import Dict, Optional
from datetime import datetime

from .config_manager import ConfigManager


class OutputHandler:
    """Handles output formatting and file generation"""

    def __init__(self, config: ConfigManager):
        self.config = config
        # User-facing directory for txt files (the configured output directory)
        self.user_output_dir = config.output_dir
        self.user_output_dir.mkdir(parents=True, exist_ok=True)

        # Hidden directory for JSON metadata files
        self.metadata_dir = config.output_dir / '.contentstudio' / 'metadata'
        self.metadata_dir.mkdir(parents=True, exist_ok=True)

    def save_job_metadata(
        self,
        job_name: str,
        metadata_items: list[Dict],
        prompt_set: str,
        job_id: Optional[str] = None,
        source_items: Optional[list] = None
    ) -> Dict:
        """
        Save metadata for a batch job with new structure:
        - JSON files in .contentstudio/metadata/
        - TXT files in user output directory, grouped by job

        Args:
            job_name: Name of the job (e.g., "My Video + 5 more")
            metadata_items: List of metadata dictionaries
            prompt_set: Prompt set ID used for generation
            job_id: Optional job ID for linking
            source_items: Optional list of source content items for re-adding to queue

        Returns:
            Dict with paths to json_file, txt_folder, and txt_files list

        Raises:
            IOError: If file writing fails
            ValueError: If metadata is empty or invalid
        """
        if not metadata_items:
            raise ValueError("Metadata items cannot be empty")

        # Generate job ID if not provided
        if not job_id:
            timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")
            job_id = f"job-{timestamp}"

        # Clean job name for folder
        clean_folder_name = self._clean_name_with_spaces(job_name)

        # Create TXT output folder in user directory
        txt_folder = self.user_output_dir / clean_folder_name
        txt_folder.mkdir(parents=True, exist_ok=True)

        # Save JSON metadata file
        json_path = self.metadata_dir / f"{job_id}.json"
        job_metadata = {
            'job_id': job_id,
            'job_name': job_name,
            'prompt_set': prompt_set,
            'created_at': datetime.now().isoformat(),
            'txt_folder': str(txt_folder),
            'items': metadata_items,
            'status': 'completed'
        }

        # Add source items if provided (for re-adding to queue later)
        if source_items:
            serializable_sources = []
            for item in source_items:
                # Convert ContentItem to serializable dict
                source_dict = {
                    'source': str(item.source) if hasattr(item, 'source') else str(item),
                    'type': item.type if hasattr(item, 'type') else 'unknown',
                    'path': item.path if hasattr(item, 'path') else None
                }
                serializable_sources.append(source_dict)
            job_metadata['source_items'] = serializable_sources

        try:
            self._save_json(job_metadata, json_path)
            print(f"Job metadata saved to: {json_path}", file=sys.stderr)

            # Save TXT files
            txt_files = []
            for item in metadata_items:
                # Get clean name for this item
                clean_name = item.get('_title', 'metadata')
                txt_path = txt_folder / f"{clean_name}.txt"

                self._save_readable(item, txt_path, prompt_set)
                txt_files.append(str(txt_path))

            print(f"TXT files saved to: {txt_folder}", file=sys.stderr)

            return {
                'json_file': str(json_path),
                'txt_folder': str(txt_folder),
                'txt_files': txt_files,
                'job_id': job_id
            }

        except Exception as e:
            print(f"Error saving job metadata: {e}", file=sys.stderr)
            raise IOError(f"Failed to save job metadata: {e}")

    def save_metadata(
        self,
        metadata: Dict,
        prompt_set: str,
        source_name: Optional[str] = None
    ) -> str:
        """
        Save metadata to files (legacy method for backward compatibility)
        Now uses the new structure with separated JSON and TXT files

        Args:
            metadata: Dictionary containing metadata (titles, description, tags, etc.)
            prompt_set: Prompt set ID used for generation (e.g., 'youtube-telltale', 'podcast-telltale')
            source_name: Optional source name for better file naming

        Returns:
            str: Path to the TXT output folder

        Raises:
            IOError: If file writing fails
            ValueError: If metadata is empty or invalid
        """
        if not metadata:
            raise ValueError("Metadata cannot be empty")

        # Get clean name for files (use actual subject/filename with spaces)
        if source_name:
            # Extract filename if it's a path
            if '/' in source_name or '\\' in source_name:
                from pathlib import Path
                source_name = Path(source_name).stem  # Get filename without extension

            # Clean source name for file system (keep spaces, remove invalid chars)
            clean_name = self._clean_name_with_spaces(source_name)
        else:
            clean_name = "metadata"

        # Add title and prompt set to metadata for display purposes
        metadata['_title'] = clean_name
        metadata['_prompt_set'] = prompt_set

        # Use job metadata method with single item
        result = self.save_job_metadata(
            job_name=clean_name,
            metadata_items=[metadata],
            prompt_set=prompt_set
        )

        return result['txt_folder']

    def _save_json(self, metadata: Dict, output_path: Path) -> None:
        """Save metadata as JSON file"""
        try:
            with open(output_path, 'w', encoding='utf-8') as f:
                json.dump(metadata, f, indent=2, ensure_ascii=False)
            print(f"JSON saved: {output_path}", file=sys.stderr)
        except Exception as e:
            raise IOError(f"Failed to save JSON: {e}")

    def _save_readable(self, metadata: Dict, output_path: Path, prompt_set: str) -> None:
        """Save metadata as human-readable text file"""
        try:
            lines = []

            # Add header
            lines.append("=" * 80)
            lines.append(f"METADATA - {prompt_set}")
            lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            lines.append("=" * 80)
            lines.append("")

            # Add titles section
            if 'titles' in metadata:
                lines.append("TITLES")
                lines.append("-" * 80)
                titles = metadata['titles']
                if isinstance(titles, list):
                    for i, title in enumerate(titles, 1):
                        lines.append(f"{i}. {title}")
                else:
                    lines.append(titles)
                lines.append("")

            # Add thumbnail text section
            if 'thumbnail_text' in metadata:
                lines.append("THUMBNAIL TEXT")
                lines.append("-" * 80)
                thumbnail_texts = metadata['thumbnail_text']
                if isinstance(thumbnail_texts, list):
                    for i, text in enumerate(thumbnail_texts, 1):
                        lines.append(f"{i}. {text}")
                else:
                    lines.append(thumbnail_texts)
                lines.append("")

            # Add chapters section (if present)
            if 'chapters' in metadata and metadata['chapters']:
                lines.append("CHAPTERS")
                lines.append("-" * 80)
                chapters = metadata['chapters']
                if isinstance(chapters, list):
                    for chapter in chapters:
                        if isinstance(chapter, dict):
                            timestamp = chapter.get('timestamp', '')
                            title = chapter.get('title', '')
                            lines.append(f"{timestamp} - {title}")
                        else:
                            lines.append(str(chapter))
                else:
                    lines.append(str(chapters))
                lines.append("")

            # Add description section
            if 'description' in metadata:
                lines.append("DESCRIPTION")
                lines.append("-" * 80)
                lines.append(metadata['description'])
                lines.append("")

            # Add hashtags section
            if 'hashtags' in metadata:
                lines.append("HASHTAGS")
                lines.append("-" * 80)
                lines.append(metadata['hashtags'])
                lines.append("")

            # Add tags section
            if 'tags' in metadata:
                lines.append("TAGS")
                lines.append("-" * 80)
                tags = metadata['tags']
                if isinstance(tags, list):
                    lines.append(", ".join(tags))
                else:
                    lines.append(tags)
                lines.append("")

            # Add hooks section if available
            if 'hooks' in metadata:
                lines.append("HOOKS")
                lines.append("-" * 80)
                hooks = metadata['hooks']
                if isinstance(hooks, list):
                    for i, hook in enumerate(hooks, 1):
                        lines.append(f"{i}. {hook}")
                else:
                    lines.append(hooks)
                lines.append("")

            # Add any other metadata fields
            excluded_fields = {
                'titles', 'thumbnail_text', 'description',
                'hashtags', 'tags', 'hooks'
            }
            other_fields = {k: v for k, v in metadata.items() if k not in excluded_fields}

            if other_fields:
                lines.append("ADDITIONAL METADATA")
                lines.append("-" * 80)
                for key, value in other_fields.items():
                    lines.append(f"{key.upper()}:")
                    if isinstance(value, (list, dict)):
                        lines.append(json.dumps(value, indent=2, ensure_ascii=False))
                    else:
                        lines.append(str(value))
                    lines.append("")

            # Add footer
            lines.append("=" * 80)
            lines.append("End of metadata")
            lines.append("=" * 80)

            # Write to file
            with open(output_path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(lines))

            print(f"Readable file saved: {output_path}", file=sys.stderr)

        except Exception as e:
            raise IOError(f"Failed to save readable file: {e}")

    def _clean_name_with_spaces(self, name: str, max_length: int = 100) -> str:
        """
        Clean name for file system while preserving spaces

        Args:
            name: Original name
            max_length: Maximum length

        Returns:
            str: Cleaned name with spaces
        """
        # Remove only truly invalid filesystem characters
        invalid_chars = '<>:"/\\|?*\x00'
        for char in invalid_chars:
            name = name.replace(char, '')

        # Clean up multiple spaces
        name = ' '.join(name.split())

        # Truncate if too long
        if len(name) > max_length:
            name = name[:max_length].rstrip()

        # Remove trailing dots and spaces
        name = name.rstrip('. ')

        return name or "metadata"

    def _sanitize_filename(self, filename: str, max_length: int = 50) -> str:
        """
        Sanitize filename by removing invalid characters

        Args:
            filename: Original filename
            max_length: Maximum length for filename

        Returns:
            str: Sanitized filename
        """
        # Remove or replace invalid characters
        invalid_chars = '<>:"/\\|?*'
        for char in invalid_chars:
            filename = filename.replace(char, '_')

        # Replace multiple spaces/underscores with single underscore
        filename = '_'.join(filename.split())

        # Truncate if too long
        if len(filename) > max_length:
            filename = filename[:max_length]

        # Remove trailing dots and spaces
        filename = filename.rstrip('. ')

        return filename or "metadata"

    def create_batch_summary(
        self,
        batch_results: list,
        output_name: Optional[str] = None
    ) -> str:
        """
        Create a summary file for batch processing results

        Args:
            batch_results: List of dictionaries containing metadata and source info
            output_name: Optional name for the batch summary

        Returns:
            str: Path to the summary file
        """
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        if output_name:
            safe_name = self._sanitize_filename(output_name)
            summary_name = f"{timestamp}_batch_{safe_name}"
        else:
            summary_name = f"{timestamp}_batch_summary"

        summary_folder = self.output_dir / summary_name
        summary_folder.mkdir(parents=True, exist_ok=True)

        try:
            # Create summary text file
            summary_path = summary_folder / "batch_summary.txt"
            lines = []

            lines.append("=" * 80)
            lines.append("BATCH PROCESSING SUMMARY")
            lines.append(f"Generated: {datetime.now().strftime('%Y-%m-%d %H:%M:%S')}")
            lines.append(f"Total Items: {len(batch_results)}")
            lines.append("=" * 80)
            lines.append("")

            for i, result in enumerate(batch_results, 1):
                source = result.get('source', 'Unknown')
                metadata = result.get('metadata', {})
                success = result.get('success', False)

                lines.append(f"ITEM {i}: {source}")
                lines.append("-" * 80)

                if success:
                    lines.append("Status: SUCCESS")
                    if 'titles' in metadata and metadata['titles']:
                        title = metadata['titles'][0] if isinstance(metadata['titles'], list) else metadata['titles']
                        lines.append(f"Title: {title}")
                else:
                    error = result.get('error', 'Unknown error')
                    lines.append(f"Status: FAILED - {error}")

                lines.append("")

            lines.append("=" * 80)

            with open(summary_path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(lines))

            # Also save JSON version
            json_path = summary_folder / "batch_summary.json"
            with open(json_path, 'w', encoding='utf-8') as f:
                json.dump(batch_results, f, indent=2, ensure_ascii=False)

            print(f"Batch summary saved to: {summary_folder}", file=sys.stderr)
            return str(summary_folder)

        except Exception as e:
            print(f"Error creating batch summary: {e}", file=sys.stderr)
            raise IOError(f"Failed to create batch summary: {e}")

    def save_processing_log(self, log_entries: list, log_name: Optional[str] = None) -> str:
        """
        Save processing log to a file

        Args:
            log_entries: List of log entry strings
            log_name: Optional name for the log file

        Returns:
            str: Path to the log file
        """
        timestamp = datetime.now().strftime("%Y%m%d_%H%M%S")

        if log_name:
            safe_name = self._sanitize_filename(log_name)
            log_filename = f"{timestamp}_{safe_name}.log"
        else:
            log_filename = f"{timestamp}_processing.log"

        log_path = self.output_dir / log_filename

        try:
            with open(log_path, 'w', encoding='utf-8') as f:
                f.write('\n'.join(log_entries))

            print(f"Processing log saved to: {log_path}", file=sys.stderr)
            return str(log_path)

        except Exception as e:
            print(f"Error saving processing log: {e}", file=sys.stderr)
            raise IOError(f"Failed to save processing log: {e}")
