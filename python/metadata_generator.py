#!/usr/bin/env python3
"""
LaunchPad Metadata Generator
AI-powered metadata generation for YouTube and Spreaker
Adapted from ContentStudio
"""

import sys
import json
import argparse
from pathlib import Path
from typing import List, Dict, Any
import time

# Add current directory to path
sys.path.insert(0, str(Path(__file__).parent))

try:
    from core.ai_manager import AIManager
    from core.input_handler import InputHandler
    from core.output_handler import OutputHandler
    from core.config_manager import ConfigManager
except ImportError as e:
    print(json.dumps({"success": False, "error": f"Import error: {e}"}), file=sys.stderr)
    sys.exit(1)


def main():
    parser = argparse.ArgumentParser(description='LaunchPad Metadata Generator')

    # Input options
    parser.add_argument('--inputs', nargs='+', required=True,
                       help='Input items: subjects, video files, transcript files, directories')

    # Platform and mode
    parser.add_argument('--platform', choices=['youtube', 'spreaker'], default='youtube',
                       help='Target platform for metadata generation')
    parser.add_argument('--mode', choices=['individual', 'compilation'], default='individual',
                       help='Processing mode')

    # AI configuration
    parser.add_argument('--ai-provider', choices=['ollama', 'openai', 'claude'], default='ollama',
                       help='AI provider to use')
    parser.add_argument('--ai-model', help='AI model name (for Ollama)')
    parser.add_argument('--ai-api-key', help='API key (for OpenAI/Claude)')
    parser.add_argument('--ai-host', default='http://localhost:11434',
                       help='AI host URL (for Ollama)')

    # Output options
    parser.add_argument('--output', help='Output directory')

    args = parser.parse_args()

    try:
        # Initialize configuration
        config_manager = ConfigManager(
            ai_provider=args.ai_provider,
            ai_model=args.ai_model,
            ai_api_key=args.ai_api_key,
            ai_host=args.ai_host,
            platform=args.platform,
            output_dir=args.output
        )

        # Initialize components
        ai_manager = AIManager(config_manager)
        input_handler = InputHandler(config_manager)
        output_handler = OutputHandler(config_manager)

        # Initialize AI manager
        if not ai_manager.initialize():
            raise Exception("Failed to initialize AI manager")

        start_time = time.time()

        # Process inputs
        print(f"Processing {len(args.inputs)} inputs...", file=sys.stderr)
        content_items = input_handler.process_inputs(args.inputs)

        if not content_items:
            raise Exception("No valid content items could be processed")

        # Prepare content (summarize if needed)
        content_items = input_handler.prepare_content(content_items, ai_manager)

        # Generate metadata
        if args.mode == 'compilation':
            # Combine all content for single metadata output (EXACTLY like ContentStudio)
            content_sections = []
            for i, item in enumerate(content_items, 1):
                if item.content_type == "subject":
                    content_sections.append(f"TOPIC {i}: {item.content}")
                else:
                    # Include filename for file-based content
                    source_note = f" (from file: {Path(item.source).name})" if item.source else ""
                    content_sections.append(f"CONTENT {i}{source_note}:\n{item.content}")

            combined_content = "\n\n".join(content_sections)
            metadata_result = ai_manager.generate_metadata(combined_content, args.platform)

            if metadata_result.success:
                # Generate a descriptive source name for compilations
                compilation_name = f"Compilation of {len(content_items)} items"

                # Save output
                output_path = output_handler.save_metadata(
                    metadata_result.metadata,
                    args.platform,
                    source_name=compilation_name
                )
                result = {
                    "success": True,
                    "metadata": [metadata_result.metadata],
                    "output_files": [output_path],
                    "processing_time": time.time() - start_time
                }
            else:
                raise Exception(metadata_result.error)

        else:
            # Generate individual metadata for each content item
            all_metadata = []
            output_files = []

            for item in content_items:
                # Get source filename if available (EXACTLY like ContentStudio)
                source_filename = None
                if item.source and item.content_type in ["video", "transcript_file"]:
                    source_filename = Path(item.source).name

                metadata_result = ai_manager.generate_metadata(
                    item.content,
                    args.platform,
                    source_filename=source_filename
                )

                if metadata_result.success:
                    all_metadata.append(metadata_result.metadata)
                    output_path = output_handler.save_metadata(
                        metadata_result.metadata,
                        args.platform,
                        source_name=item.source
                    )
                    output_files.append(output_path)
                else:
                    print(f"Warning: Failed to generate metadata for {item.source}", file=sys.stderr)

            if not all_metadata:
                raise Exception("Failed to generate any metadata")

            result = {
                "success": True,
                "metadata": all_metadata,
                "output_files": output_files,
                "processing_time": time.time() - start_time
            }

        # Cleanup
        ai_manager.cleanup()

        # Output JSON result to stdout
        print(json.dumps(result))
        sys.exit(0)

    except Exception as e:
        error_result = {
            "success": False,
            "error": str(e)
        }
        print(json.dumps(error_result), file=sys.stderr)
        sys.exit(1)


if __name__ == "__main__":
    main()
