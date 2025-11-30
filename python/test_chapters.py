#!/usr/bin/env python3
"""
Quick test script for chapter generation
Tests chapter generation without full metadata processing
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from core.chapter_generator import TranscriptChunker, ChapterMapper
from core.input_handler import SRTSegment
from core.ai_manager import AIManager
from core.config_manager import ConfigManager

# Create mock SRT segments (simulating ~5 minute video with 30-second segments)
def create_mock_srt_segments(duration_seconds=300, segment_duration=30):
    """Create mock SRT segments for testing"""
    segments = []
    num_segments = duration_seconds // segment_duration

    for i in range(num_segments):
        start = i * segment_duration
        end = (i + 1) * segment_duration

        # Mock transcript text
        text = f"This is segment {i+1}. We're discussing topic {i+1} here. " * 3

        segments.append(SRTSegment(
            sequence=i+1,
            start_time=_seconds_to_srt_time(start),
            end_time=_seconds_to_srt_time(end),
            text=text
        ))

    return segments

def _seconds_to_srt_time(seconds):
    """Convert seconds to SRT time format"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"

def test_chapter_generation():
    """Test chapter generation with mock data"""
    print("=" * 60)
    print("CHAPTER GENERATION TEST")
    print("=" * 60)

    # Create mock SRT segments
    print("\n1. Creating mock SRT segments...")
    srt_segments = create_mock_srt_segments(duration_seconds=300, segment_duration=30)
    print(f"   Created {len(srt_segments)} segments")

    # Create chunks
    print("\n2. Creating chunks...")
    chunker = TranscriptChunker(target_duration=30)
    chunks = chunker.chunk_from_srt_segments(srt_segments)
    print(f"   Created {len(chunks)} chunks")

    # Format for AI
    print("\n3. Formatting chunks for AI...")
    chunked_text = chunker.format_for_ai(chunks)
    print(f"   Formatted text length: {len(chunked_text)} characters")
    print(f"\n   First 500 chars:\n   {chunked_text[:500]}")

    # Initialize AI Manager
    print("\n4. Initializing AI Manager...")
    config = ConfigManager(
        ai_provider='ollama',
        ai_model='qwen2.5:14b',  # Use whatever model you have
        platform='youtube'
    )

    ai_manager = AIManager(config)
    if not ai_manager.initialize():
        print("   ERROR: Failed to initialize AI Manager")
        return False

    print(f"   Using model: {ai_manager.metadata_model}")

    # Build chapter prompt
    print("\n5. Building chapter prompt...")
    chapter_prompt = ai_manager._build_chapter_prompt(chunked_text)
    print(f"   Prompt length: {len(chapter_prompt)} characters")

    # Show the prompt
    print("\n6. Chapter prompt:")
    print("-" * 60)
    print(chapter_prompt)
    print("-" * 60)

    # Make request with shorter timeout for testing
    print("\n7. Requesting chapters from AI...")
    print("   (timeout: 120 seconds)")

    try:
        response = ai_manager._make_request(chapter_prompt, model=ai_manager.metadata_model, timeout=120)

        if response:
            print(f"\n8. AI Response ({len(response)} chars):")
            print("-" * 60)
            print(response)
            print("-" * 60)

            # Parse response
            print("\n9. Parsing chapters...")
            ai_chapters = ai_manager._parse_chapter_response(response)

            if ai_chapters:
                print(f"   Parsed {len(ai_chapters)} chapters:")
                for ch in ai_chapters:
                    print(f"   - Chunk {ch['chunk_id']}: {ch['title']}")

                # Map to timestamps
                print("\n10. Mapping to timestamps...")
                mapper = ChapterMapper(chunks)
                final_chapters = mapper.map_chapters(ai_chapters)

                if final_chapters:
                    print(f"\n✅ SUCCESS! Generated {len(final_chapters)} chapters:")
                    for ch in final_chapters:
                        print(f"   {ch['timestamp']} - {ch['title']}")
                    return True
                else:
                    print("\n❌ Chapter validation failed")
                    return False
            else:
                print("\n❌ Failed to parse AI response")
                return False
        else:
            print("\n❌ Empty response from AI")
            return False

    except Exception as e:
        print(f"\n❌ ERROR: {e}")
        import traceback
        traceback.print_exc()
        return False

if __name__ == '__main__':
    success = test_chapter_generation()
    sys.exit(0 if success else 1)
