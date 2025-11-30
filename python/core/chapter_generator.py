#!/usr/bin/env python3
"""
Chapter Generator for ContentStudio
Handles chunking transcripts and generating chapter markers
"""

import re
from typing import List, Dict, Optional
from dataclasses import dataclass


@dataclass
class TranscriptChunk:
    """Represents a chunk of transcript with timestamp"""
    id: int
    time: str  # Simplified format: "0:00", "1:30", etc.
    text: str
    start_seconds: float  # Original timestamp in seconds for mapping


@dataclass
class TranscriptSegment:
    """Represents a hierarchical segment (group of chunks)"""
    id: int
    time: str  # Simplified format: "0:00", "1:30", etc.
    topic: str  # Summarized topic for this segment
    chunk_ids: List[int]  # Original chunk IDs in this segment
    start_seconds: float  # Original timestamp in seconds for mapping


class TranscriptChunker:
    """
    Chunks transcripts into ~30-second segments at sentence boundaries
    """

    def __init__(self, target_duration: int = 30):
        """
        Initialize chunker

        Args:
            target_duration: Target duration in seconds for each chunk (default: 30)
        """
        self.target_duration = target_duration

    def chunk_from_srt_segments(self, srt_segments: List) -> List[TranscriptChunk]:
        """
        Create transcript chunks from SRT segments

        Args:
            srt_segments: List of SRTSegment objects

        Returns:
            List of TranscriptChunk objects
        """
        if not srt_segments:
            return []

        chunks = []
        current_chunk_text = []
        current_chunk_start = None
        current_chunk_start_seconds = 0
        chunk_id = 1

        for segment in srt_segments:
            # Parse start time to seconds
            start_seconds = self._srt_time_to_seconds(segment.start_time)

            # Initialize first chunk
            if current_chunk_start is None:
                current_chunk_start = self._seconds_to_youtube_time(start_seconds)
                current_chunk_start_seconds = start_seconds

            # Add text to current chunk
            current_chunk_text.append(segment.text.strip())

            # Check if we should start a new chunk
            elapsed = start_seconds - current_chunk_start_seconds

            if elapsed >= self.target_duration:
                # Try to find a sentence boundary
                full_text = ' '.join(current_chunk_text)

                # Look for sentence endings
                sentences = self._split_sentences(full_text)

                if len(sentences) > 1:
                    # Keep most sentences in current chunk, carry over the last partial one
                    chunk_text = ' '.join(sentences[:-1])
                    carryover = sentences[-1]

                    # Save current chunk
                    chunks.append(TranscriptChunk(
                        id=chunk_id,
                        time=current_chunk_start,
                        text=chunk_text,
                        start_seconds=current_chunk_start_seconds
                    ))

                    # Start new chunk with carryover
                    chunk_id += 1
                    current_chunk_text = [carryover]
                    current_chunk_start = self._seconds_to_youtube_time(start_seconds)
                    current_chunk_start_seconds = start_seconds
                else:
                    # No sentence boundary found, just split here
                    chunks.append(TranscriptChunk(
                        id=chunk_id,
                        time=current_chunk_start,
                        text=full_text,
                        start_seconds=current_chunk_start_seconds
                    ))

                    chunk_id += 1
                    current_chunk_text = []
                    current_chunk_start = self._seconds_to_youtube_time(start_seconds)
                    current_chunk_start_seconds = start_seconds

        # Add final chunk if there's remaining text
        if current_chunk_text:
            chunks.append(TranscriptChunk(
                id=chunk_id,
                time=current_chunk_start,
                text=' '.join(current_chunk_text),
                start_seconds=current_chunk_start_seconds
            ))

        return chunks

    def _split_sentences(self, text: str) -> List[str]:
        """
        Split text into sentences

        Args:
            text: Text to split

        Returns:
            List of sentences
        """
        # Simple sentence splitting on common endings
        # This handles periods, exclamation marks, and question marks
        # But tries to avoid splitting on common abbreviations
        sentences = re.split(r'(?<=[.!?])\s+(?=[A-Z])', text)
        return [s.strip() for s in sentences if s.strip()]

    def _srt_time_to_seconds(self, srt_time: str) -> float:
        """
        Convert SRT time format (hh:mm:ss,ms) to seconds

        Args:
            srt_time: Time in SRT format

        Returns:
            Time in seconds
        """
        # SRT format: hh:mm:ss,ms
        time_part, ms_part = srt_time.split(',')
        hours, minutes, seconds = map(int, time_part.split(':'))
        milliseconds = int(ms_part)

        total_seconds = hours * 3600 + minutes * 60 + seconds + milliseconds / 1000.0
        return total_seconds

    def _seconds_to_youtube_time(self, seconds: float) -> str:
        """
        Convert seconds to YouTube chapter format (simplified)

        Args:
            seconds: Time in seconds

        Returns:
            Time in format "h:mm:ss" or "m:ss" or "0:ss"
        """
        hours = int(seconds // 3600)
        minutes = int((seconds % 3600) // 60)
        secs = int(seconds % 60)

        if hours > 0:
            return f"{hours}:{minutes:02d}:{secs:02d}"
        else:
            return f"{minutes}:{secs:02d}"

    def format_for_ai(self, chunks: List[TranscriptChunk]) -> str:
        """
        Format chunks for AI consumption

        Args:
            chunks: List of transcript chunks

        Returns:
            Formatted string for AI
        """
        lines = []
        for chunk in chunks:
            lines.append(f"{chunk.id}. [{chunk.time}] {chunk.text}")

        return '\n'.join(lines)

    def create_segments(self, chunks: List[TranscriptChunk], chunks_per_segment: int = 4) -> List[TranscriptSegment]:
        """
        Group chunks into hierarchical segments for better scaling

        For long videos, this groups multiple chunks together to reduce
        the amount of data sent to the AI while preserving temporal structure.

        Args:
            chunks: List of transcript chunks
            chunks_per_segment: Number of chunks to group into each segment (default: 4 = ~2 minutes)

        Returns:
            List of TranscriptSegment objects (placeholders, topics will be filled by AI)
        """
        segments = []

        for i in range(0, len(chunks), chunks_per_segment):
            segment_chunks = chunks[i:i + chunks_per_segment]

            # Combine text from all chunks in this segment
            combined_text = ' '.join([c.text for c in segment_chunks])

            # Create segment (topic will be filled in by AI summarization)
            segments.append(TranscriptSegment(
                id=len(segments) + 1,
                time=segment_chunks[0].time,
                topic="",  # Will be filled by summarize_segments()
                chunk_ids=[c.id for c in segment_chunks],
                start_seconds=segment_chunks[0].start_seconds
            ))

        return segments

    def format_segments_for_ai(self, segments: List[TranscriptSegment]) -> str:
        """
        Format segments with topics for AI chapter generation

        Args:
            segments: List of segments with topics filled in

        Returns:
            Formatted string for AI
        """
        lines = []
        for segment in segments:
            lines.append(f"{segment.id}. [{segment.time}] {segment.topic}")

        return '\n'.join(lines)


class ChapterMapper:
    """
    Maps AI-identified chapter positions back to timestamps
    Works with both chunks and segments
    """

    def __init__(self, items: List):
        """
        Initialize mapper with transcript chunks or segments

        Args:
            items: List of TranscriptChunk or TranscriptSegment objects
        """
        self.items = items
        self.item_map = {item.id: item for item in items}

    def map_chapters(self, ai_chapters: List[Dict]) -> List[Dict[str, str]]:
        """
        Map AI-identified chapters to timestamps

        Args:
            ai_chapters: List of dicts with 'chunk_id' and 'title'
                        Example: [{"chunk_id": 1, "title": "Introduction"}, ...]
                        Works with both chunk IDs and segment IDs

        Returns:
            List of dicts with 'timestamp' and 'title' in YouTube format
            Example: [{"timestamp": "0:00", "title": "Introduction"}, ...]
        """
        mapped_chapters = []

        for i, chapter in enumerate(ai_chapters):
            item_id = chapter.get('chunk_id') or chapter.get('segment_id')
            title = chapter.get('title', '').strip()

            if not item_id or not title:
                continue

            # Get the item (chunk or segment)
            item = self.item_map.get(item_id)
            if not item:
                # Invalid ID, skip
                continue

            mapped_chapters.append({
                'timestamp': item.time,
                'title': title,
                'sequence': i
            })

        # Ensure chapters are sorted by timestamp
        mapped_chapters.sort(key=lambda x: self._youtube_time_to_seconds(x['timestamp']))

        # Update sequence numbers after sorting
        for i, chapter in enumerate(mapped_chapters):
            chapter['sequence'] = i

        # Validate YouTube chapter requirements
        validated_chapters = self._validate_youtube_chapters(mapped_chapters)

        return validated_chapters

    def _validate_youtube_chapters(self, chapters: List[Dict]) -> List[Dict]:
        """
        Validate and fix YouTube chapter requirements

        YouTube requirements:
        - First chapter must start at 0:00
        - Must have at least 3 chapters
        - Each chapter must be at least 10 seconds long

        Args:
            chapters: List of chapter dicts

        Returns:
            Validated list of chapters
        """
        if not chapters:
            return []

        # Ensure first chapter starts at 0:00
        if chapters[0]['timestamp'] != '0:00':
            # Add an intro chapter at 0:00
            chapters.insert(0, {
                'timestamp': '0:00',
                'title': 'Introduction',
                'sequence': 0
            })
            # Update sequence numbers
            for i, chapter in enumerate(chapters):
                chapter['sequence'] = i

        # Check minimum length requirement (10 seconds)
        valid_chapters = []
        for i, chapter in enumerate(chapters):
            current_seconds = self._youtube_time_to_seconds(chapter['timestamp'])

            # Check next chapter to see if this one is long enough
            if i < len(chapters) - 1:
                next_seconds = self._youtube_time_to_seconds(chapters[i + 1]['timestamp'])
                duration = next_seconds - current_seconds

                if duration < 10:
                    # Chapter too short, skip it
                    continue

            valid_chapters.append(chapter)

        # Ensure we have at least 3 chapters
        # If not, return empty list (don't generate chapters)
        if len(valid_chapters) < 3:
            return []

        return valid_chapters

    def _youtube_time_to_seconds(self, time_str: str) -> float:
        """
        Convert YouTube time format to seconds

        Args:
            time_str: Time in format "h:mm:ss" or "m:ss" or "0:ss"

        Returns:
            Time in seconds
        """
        parts = time_str.split(':')

        if len(parts) == 3:
            hours, minutes, seconds = map(int, parts)
            return hours * 3600 + minutes * 60 + seconds
        elif len(parts) == 2:
            minutes, seconds = map(int, parts)
            return minutes * 60 + seconds
        else:
            return int(parts[0])
