#!/usr/bin/env python3
"""
Example: Basic usage of InputHandler and OutputHandler

This script demonstrates how to:
1. Process various input types (text subjects, videos, transcripts)
2. Prepare content for AI processing
3. Save metadata to output files

Requirements:
- openai-whisper (for video transcription): pip install openai-whisper
- torch (for Whisper): pip install torch
- ffmpeg (for audio extraction): brew install ffmpeg (macOS) or apt-get install ffmpeg (Linux)
"""

import sys
from pathlib import Path

# Add parent directory to path to import modules
sys.path.insert(0, str(Path(__file__).parent.parent))

from core.config_manager import ConfigManager
from core.input_handler import InputHandler, ContentItem
from core.output_handler import OutputHandler
from core.ai_manager import AIManager


def example_text_input():
    """Example: Process a text subject"""
    print("\n" + "=" * 80)
    print("EXAMPLE 1: Processing Text Subject")
    print("=" * 80)

    # Initialize configuration
    config = ConfigManager(
        ai_provider='ollama',
        ai_model='cogito:70b',
        platform='youtube'
    )

    # Initialize handlers
    input_handler = InputHandler(config)

    # Process text input
    inputs = ["How to build a REST API with Python and FastAPI"]
    content_items = input_handler.process_inputs(inputs)

    print(f"\nProcessed {len(content_items)} content items")
    for item in content_items:
        print(f"  Type: {item.content_type}")
        print(f"  Preview: {item.get_preview()}")


def example_video_input():
    """Example: Process a video file (requires Whisper)"""
    print("\n" + "=" * 80)
    print("EXAMPLE 2: Processing Video File")
    print("=" * 80)

    # Initialize configuration
    config = ConfigManager(
        ai_provider='ollama',
        ai_model='cogito:70b',
        platform='youtube'
    )

    # Add Whisper configuration
    config.whisper_model = 'base'  # Options: tiny, base, small, medium, large

    # Initialize handlers
    input_handler = InputHandler(config)

    # Process video (replace with actual video path)
    video_path = "/path/to/your/video.mp4"

    if Path(video_path).exists():
        content_items = input_handler.process_inputs([video_path])

        print(f"\nProcessed {len(content_items)} content items")
        for item in content_items:
            print(f"  Type: {item.content_type}")
            print(f"  Source: {item.source}")
            print(f"  Content length: {len(item.content)} characters")
            print(f"  Preview: {item.get_preview()}")
    else:
        print(f"Video file not found: {video_path}")
        print("Skipping video processing example")


def example_transcript_file():
    """Example: Process a transcript text file"""
    print("\n" + "=" * 80)
    print("EXAMPLE 3: Processing Transcript File")
    print("=" * 80)

    # Initialize configuration
    config = ConfigManager(
        ai_provider='ollama',
        ai_model='cogito:70b',
        platform='youtube'
    )

    # Initialize handlers
    input_handler = InputHandler(config)

    # Create a sample transcript file
    transcript_path = "/tmp/sample_transcript.txt"
    with open(transcript_path, 'w') as f:
        f.write("""
        Welcome to this tutorial on building REST APIs with Python.
        Today we'll cover the basics of FastAPI, a modern web framework
        for building APIs with Python 3.7+ based on standard Python type hints.
        We'll create a simple API, add validation, and learn about
        automatic documentation generation.
        """)

    # Process transcript
    content_items = input_handler.process_inputs([transcript_path])

    print(f"\nProcessed {len(content_items)} content items")
    for item in content_items:
        print(f"  Type: {item.content_type}")
        print(f"  Source: {item.source}")
        print(f"  Content length: {len(item.content)} characters")


def example_content_preparation():
    """Example: Prepare content with summarization"""
    print("\n" + "=" * 80)
    print("EXAMPLE 4: Content Preparation with Summarization")
    print("=" * 80)

    # Initialize configuration
    config = ConfigManager(
        ai_provider='ollama',
        ai_model='cogito:70b',
        platform='youtube'
    )

    # Initialize handlers
    input_handler = InputHandler(config)
    ai_manager = AIManager(config)

    # Create a long transcript
    long_content = " ".join([
        "This is a very long transcript that would benefit from summarization."
    ] * 100)  # Repeat to make it long enough

    # Create content item
    items = [ContentItem(
        content=long_content,
        content_type="video",
        source="/path/to/video.mp4",
        processing_notes="Sample long transcript"
    )]

    print(f"Original content length: {len(items[0].content)} characters")

    # Initialize AI manager (skip if not available)
    if ai_manager.initialize():
        # Prepare content (will summarize if too long)
        prepared_items = input_handler.prepare_content(items, ai_manager)

        print(f"Prepared content length: {len(prepared_items[0].content)} characters")
        print(f"Processing notes: {prepared_items[0].processing_notes}")
    else:
        print("AI manager not available, skipping summarization")


def example_save_metadata():
    """Example: Save metadata to files"""
    print("\n" + "=" * 80)
    print("EXAMPLE 5: Saving Metadata to Files")
    print("=" * 80)

    # Initialize configuration
    config = ConfigManager(
        ai_provider='ollama',
        platform='youtube'
    )

    # Initialize output handler
    output_handler = OutputHandler(config)

    # Sample metadata (as would be generated by AI)
    metadata = {
        'titles': [
            'Building REST APIs with Python and FastAPI - Complete Tutorial',
            'FastAPI Tutorial: Build Modern REST APIs in Python',
            'Python REST API Development with FastAPI Framework'
        ],
        'thumbnail_text': [
            'FastAPI Tutorial',
            'Build REST APIs',
            'Python Web Dev'
        ],
        'description': """
Learn how to build modern REST APIs with Python and FastAPI in this comprehensive tutorial.

In this video, we'll cover:
- Setting up FastAPI
- Creating endpoints
- Adding validation
- Automatic documentation
- Best practices

Perfect for beginners and intermediate Python developers!
        """.strip(),
        'hashtags': '#Python #FastAPI #WebDevelopment #RestAPI #Programming #Tutorial',
        'tags': ['python', 'fastapi', 'rest api', 'web development', 'tutorial', 'programming']
    }

    # Save metadata
    output_path = output_handler.save_metadata(
        metadata=metadata,
        platform='youtube',
        source_name='fastapi_tutorial'
    )

    print(f"\nMetadata saved to: {output_path}")
    print(f"Files created:")
    print(f"  - metadata.json (structured data)")
    print(f"  - metadata.txt (human-readable)")


def example_batch_summary():
    """Example: Create batch processing summary"""
    print("\n" + "=" * 80)
    print("EXAMPLE 6: Batch Processing Summary")
    print("=" * 80)

    # Initialize configuration
    config = ConfigManager(platform='youtube')

    # Initialize output handler
    output_handler = OutputHandler(config)

    # Sample batch results
    batch_results = [
        {
            'source': 'video1.mp4',
            'success': True,
            'metadata': {
                'titles': ['Video 1 Title'],
                'description': 'Video 1 description'
            }
        },
        {
            'source': 'video2.mp4',
            'success': True,
            'metadata': {
                'titles': ['Video 2 Title'],
                'description': 'Video 2 description'
            }
        },
        {
            'source': 'video3.mp4',
            'success': False,
            'error': 'Transcription failed'
        }
    ]

    # Create batch summary
    summary_path = output_handler.create_batch_summary(
        batch_results=batch_results,
        output_name='tutorial_series'
    )

    print(f"\nBatch summary saved to: {summary_path}")


def main():
    """Run all examples"""
    print("\n" + "=" * 80)
    print("LaunchPad InputHandler and OutputHandler Examples")
    print("=" * 80)

    # Run examples that don't require external dependencies
    try:
        example_text_input()
    except Exception as e:
        print(f"Error in example 1: {e}")

    try:
        example_transcript_file()
    except Exception as e:
        print(f"Error in example 3: {e}")

    try:
        example_save_metadata()
    except Exception as e:
        print(f"Error in example 5: {e}")

    try:
        example_batch_summary()
    except Exception as e:
        print(f"Error in example 6: {e}")

    # Examples that require additional setup
    print("\n" + "=" * 80)
    print("Additional Examples (require setup)")
    print("=" * 80)
    print("To run video processing examples:")
    print("  1. Install whisper: pip install openai-whisper")
    print("  2. Install torch: pip install torch")
    print("  3. Install ffmpeg: brew install ffmpeg (macOS)")
    print("  4. Uncomment example_video_input() in main()")

    print("\n" + "=" * 80)
    print("Examples completed!")
    print("=" * 80)


if __name__ == '__main__':
    main()
