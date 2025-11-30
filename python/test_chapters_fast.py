#!/usr/bin/env python3
"""
Fast chapter generation test using existing transcript
Skips re-transcription to save time
"""

import sys
from pathlib import Path
sys.path.insert(0, str(Path(__file__).parent))

from core.chapter_generator import TranscriptChunker, ChapterMapper, TranscriptSegment
from core.input_handler import SRTSegment
from core.ai_manager import AIManager
from core.config_manager import ConfigManager

# Simulate the Trump video transcript (13344 chars, ~5 minutes)
def create_realistic_srt_segments():
    """Create SRT segments matching the Trump video structure"""
    segments = []

    # Sample text from a political analysis video
    sample_texts = [
        "Welcome to today's discussion about Trump's food stamp policy changes",
        "The SNAP program affects over 40 million Americans across the country",
        "Recent policy decisions have halted funding for this critical program",
        "Many families are struggling to afford basic groceries and necessities",
        "Conservative commentators have been dismissing these concerns entirely",
        "The data shows a clear impact on vulnerable populations including children",
        "Healthcare costs are rising as nutrition assistance becomes less available",
        "We need to examine the real world consequences of these policy choices",
        "Income inequality plays a major role in food insecurity rates",
        "Let's break down the timeline of how this policy was implemented",
        "Government assistance programs serve as an economic safety net",
        "The political motivations behind cutting food stamps deserve scrutiny",
        "Evidence-based analysis reveals significant harm to working class families",
        "Republican leadership claims these cuts promote self-sufficiency",
        "Democratic response has focused on protecting vulnerable populations",
        "Public health experts warn of long-term consequences for child development",
        "Economic impact analysis shows ripple effects across multiple sectors",
        "Fact-checking reveals misleading claims about fraud in the SNAP program",
        "Wealth distribution patterns explain why food assistance remains necessary",
        "The broader context includes attacks on other social safety net programs",
        "Voter consequences may emerge as people realize the impact of these policies",
        "Accountability measures are needed to track the human cost",
        "Join us as we continue to monitor this developing situation"
    ]

    # Create segments (~30 seconds each, total ~5 minutes)
    for i in range(len(sample_texts)):
        start = i * 13.0  # ~13 seconds per segment
        end = (i + 1) * 13.0

        segments.append(SRTSegment(
            sequence=i+1,
            start_time=_seconds_to_srt_time(start),
            end_time=_seconds_to_srt_time(end),
            text=sample_texts[i]
        ))

    return segments

def _seconds_to_srt_time(seconds):
    """Convert seconds to SRT time format"""
    hours = int(seconds // 3600)
    minutes = int((seconds % 3600) // 60)
    secs = int(seconds % 60)
    ms = int((seconds % 1) * 1000)
    return f"{hours:02d}:{minutes:02d}:{secs:02d},{ms:03d}"

def test_full_chapter_flow():
    """Test the complete chapter generation flow"""
    print("=" * 80)
    print("FAST CHAPTER GENERATION TEST")
    print("=" * 80)

    # Step 1: Create realistic SRT segments
    print("\n1. Creating realistic SRT segments...")
    srt_segments = create_realistic_srt_segments()
    print(f"   Created {len(srt_segments)} segments (~5 minute video)")

    # Step 2: Initialize AI Manager
    print("\n2. Initializing AI Manager...")
    config = ConfigManager(
        ai_provider='ollama',
        platform='youtube'
    )
    ai_manager = AIManager(config)
    if not ai_manager.initialize():
        print("   ERROR: Failed to initialize AI Manager")
        return False

    print(f"   Summary model: {ai_manager.summary_model}")
    print(f"   Metadata model: {ai_manager.metadata_model}")

    # Step 3: Create mock content item with SRT segments
    print("\n3. Creating content item...")
    from core.input_handler import ContentItem
    content_item = ContentItem(
        content="Mock content",
        content_type="video",
        source="/test/video.mp4",
        srt_segments=srt_segments
    )

    # Step 4: Use the FULL generate_chapters flow (with adaptive logic)
    print("\n4. Generating chapters (full flow with adaptive logic)...")
    final_chapters = ai_manager.generate_chapters(content_item, "Mock content")

    if not final_chapters:
        print("   ERROR: Chapter generation failed")
        return False

    print(f"\n✅ SUCCESS! Generated {len(final_chapters)} chapters:")
    print("=" * 80)
    for ch in final_chapters:
        print(f"{ch['timestamp']} {ch['title']}")
    print("=" * 80)

    return True

if __name__ == '__main__':
    success = test_full_chapter_flow()
    sys.exit(0 if success else 1)
