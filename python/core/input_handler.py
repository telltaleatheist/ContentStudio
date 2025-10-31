#!/usr/bin/env python3
"""
Input Handler for LaunchPad
Processes all input types and normalizes them to content strings
"""

import os
import sys
import subprocess
import tempfile
from pathlib import Path
from typing import List, Optional, Dict, Any
from dataclasses import dataclass

from .config_manager import ConfigManager

# Lazy import whisper and torch only when needed for video processing
whisper = None
torch = None


@dataclass
class ContentItem:
    """Represents a normalized piece of content"""
    content: str  # The actual content (subject or transcript)
    content_type: str  # "subject", "video", "transcript_file"
    source: Optional[str] = None  # Original source path/description
    processing_notes: Optional[str] = None  # Processing information

    def get_preview(self, max_length: int = 100) -> str:
        """Get a preview of the content"""
        if len(self.content) <= max_length:
            return self.content
        return self.content[:max_length] + "..."


class InputDetector:
    """Detects and validates input types"""

    SUPPORTED_VIDEO_FORMATS = {
        '.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v', '.flv',
        '.wmv', '.mpg', '.mpeg', '.3gp', '.ogv'
    }

    @staticmethod
    def detect_input_type(input_item: str) -> str:
        """
        Detect what type of input this is

        Returns: "subject", "video", "directory", "transcript_file"
        """
        path = Path(input_item)

        # Check if it looks like a file path (has extension or path separators)
        has_extension = path.suffix != ""
        has_path_separators = "/" in input_item or "\\" in input_item

        if has_extension or has_path_separators:
            # It looks like a file path
            if path.exists():
                if path.is_file():
                    suffix = path.suffix.lower()
                    if suffix in InputDetector.SUPPORTED_VIDEO_FORMATS:
                        return "video"
                    elif suffix in ['.txt']:
                        return "transcript_file"
                    else:
                        # Assume any other file is a transcript
                        return "transcript_file"
                elif path.is_dir():
                    return "directory"
            else:
                # File doesn't exist, but determine type by extension
                suffix = path.suffix.lower()
                if suffix in InputDetector.SUPPORTED_VIDEO_FORMATS:
                    return "video"
                elif suffix in ['.txt']:
                    return "transcript_file"
                else:
                    return "transcript_file"  # Default for unknown file extensions

        # If not a file path, treat as subject
        return "subject"

    @staticmethod
    def validate_input(input_item: str, input_type: str, max_file_size_mb: int = 500) -> tuple[bool, str]:
        """
        Validate input based on its type

        Returns: (is_valid, error_message)
        """
        if input_type == "subject":
            if not input_item or len(input_item.strip()) < 3:
                return False, "Subject must be at least 3 characters"
            if len(input_item) > 1000:
                return False, "Subject too long (max 1000 characters)"
            return True, ""

        elif input_type in ["video", "transcript_file"]:
            path = Path(input_item)
            if not path.exists():
                return False, f"File not found: {input_item}"
            if not path.is_file():
                return False, f"Path is not a file: {input_item}"
            if path.stat().st_size == 0:
                return False, f"File is empty: {input_item}"

            # Check file size
            size_mb = path.stat().st_size / (1024 * 1024)
            if size_mb > max_file_size_mb:
                return False, f"File too large: {size_mb:.1f}MB (max: {max_file_size_mb}MB)"

            return True, ""

        elif input_type == "directory":
            path = Path(input_item)
            if not path.exists():
                return False, f"Directory not found: {input_item}"
            if not path.is_dir():
                return False, f"Path is not a directory: {input_item}"
            return True, ""

        return True, ""

    @staticmethod
    def should_skip_file(file_path: Path) -> bool:
        """
        Check if a file should be skipped during processing

        Args:
            file_path: Path to the file

        Returns:
            bool: True if file should be skipped
        """
        filename = file_path.name

        # Skip macOS metadata files
        if filename.startswith('._'):
            return True

        # Skip hidden files
        if filename.startswith('.'):
            return True

        # Skip common system files
        system_files = {
            'Thumbs.db',        # Windows thumbnails
            'Desktop.ini',      # Windows desktop config
            '.DS_Store',        # macOS directory metadata
            '.localized',       # macOS localization
            'Icon\r',           # macOS custom icons
        }

        if filename in system_files:
            return True

        # Skip files with no extension or unsupported extensions
        if not file_path.suffix:
            return True

        return False


class VideoTranscriber:
    """Handles video transcription using Whisper"""

    def __init__(self, config: ConfigManager):
        self.config = config
        self.model = None
        self.device = None  # Will be set when loading whisper
        self.whisper_model = getattr(config, 'whisper_model', 'base')
        self._whisper_loaded = False

    def _load_whisper_libraries(self) -> bool:
        """Lazy load whisper and torch libraries"""
        global whisper, torch

        if self._whisper_loaded:
            return True

        try:
            import whisper as _whisper
            import torch as _torch

            whisper = _whisper
            torch = _torch
            self._whisper_loaded = True

            # Now detect device
            self.device = self._detect_device()
            return True

        except ImportError as e:
            print(f"Failed to load whisper/torch: {e}", file=sys.stderr)
            print("Whisper is only needed for video transcription", file=sys.stderr)
            return False

    def _detect_device(self) -> str:
        """Detect best available device for transcription"""
        # Check for CUDA
        if torch.cuda.is_available():
            print("Using CUDA device for transcription", file=sys.stderr)
            return "cuda"

        # Check for MPS (Apple Silicon)
        if torch.backends.mps.is_available():
            try:
                # Test MPS compatibility
                test_tensor = torch.randn(10, device="mps")
                test_result = test_tensor + 1
                print("Using MPS device for transcription", file=sys.stderr)
                return "mps"
            except Exception as e:
                print(f"MPS test failed, falling back to CPU: {e}", file=sys.stderr)

        print("Using CPU device for transcription", file=sys.stderr)
        return "cpu"

    def _load_model(self) -> bool:
        """Load Whisper model"""
        if self.model is not None:
            return True

        try:
            print(f"Loading Whisper {self.whisper_model} model on {self.device}...", file=sys.stderr)
            self.model = whisper.load_model(self.whisper_model, device=self.device)
            print(f"Whisper model loaded successfully", file=sys.stderr)
            return True
        except Exception as e:
            print(f"Failed to load Whisper model: {e}", file=sys.stderr)
            # Try CPU fallback
            if self.device != "cpu":
                try:
                    print("Trying CPU fallback...", file=sys.stderr)
                    self.device = "cpu"
                    self.model = whisper.load_model(self.whisper_model, device="cpu")
                    print(f"Whisper model loaded on CPU", file=sys.stderr)
                    return True
                except Exception as e2:
                    print(f"CPU fallback failed: {e2}", file=sys.stderr)
            return False

    def _extract_audio(self, video_path: str, output_dir: str) -> Optional[str]:
        """Extract audio from video using ffmpeg"""
        audio_path = os.path.join(output_dir, "audio.wav")

        cmd = [
            'ffmpeg', '-i', video_path, '-y',
            '-vn',  # No video
            '-acodec', 'pcm_s16le',  # 16-bit PCM
            '-ar', '16000',  # 16kHz sample rate
            '-ac', '1',  # Mono
            '-loglevel', 'error',
            audio_path
        ]

        try:
            subprocess.run(cmd, check=True, capture_output=True)
            if Path(audio_path).exists() and Path(audio_path).stat().st_size > 0:
                return audio_path
            return None
        except subprocess.CalledProcessError as e:
            print(f"FFmpeg error: {e}", file=sys.stderr)
            return None
        except Exception as e:
            print(f"Audio extraction failed: {e}", file=sys.stderr)
            return None

    def transcribe_video(self, video_path: str) -> Optional[str]:
        """Transcribe video to text"""
        # Load whisper libraries first
        if not self._load_whisper_libraries():
            print("Cannot transcribe video: whisper/torch not available", file=sys.stderr)
            return None

        if not self._load_model():
            return None

        print(f"Transcribing video: {Path(video_path).name}", file=sys.stderr)

        with tempfile.TemporaryDirectory() as temp_dir:
            # Extract audio
            audio_path = self._extract_audio(video_path, temp_dir)
            if not audio_path:
                return None

            try:
                # Transcribe
                result = self.model.transcribe(
                    audio_path,
                    language=None,  # Auto-detect
                    task="transcribe",
                    fp16=self.device != "cpu",
                    verbose=False
                )

                transcript = result.get("text", "").strip()
                if transcript:
                    # Basic cleaning
                    transcript = ' '.join(transcript.split())  # Normalize whitespace
                    print(f"Transcription complete ({len(transcript)} characters)", file=sys.stderr)
                    return transcript
                else:
                    print("Empty transcript", file=sys.stderr)
                    return None

            except Exception as e:
                print(f"Transcription failed: {e}", file=sys.stderr)
                return None


class InputHandler:
    """Main input processing class"""

    def __init__(self, config: ConfigManager):
        self.config = config
        self.transcriber = VideoTranscriber(config)
        self.max_file_size_mb = getattr(config, 'max_file_size_mb', 500)

    def process_inputs(self, input_items: List[str]) -> List[ContentItem]:
        """
        Process multiple inputs and return normalized content items

        Args:
            input_items: List of input strings (subjects, file paths, etc.)

        Returns:
            List[ContentItem]: Normalized content items
        """
        content_items = []

        for input_item in input_items:
            print(f"Processing input: {input_item}", file=sys.stderr)

            # Detect input type
            input_type = InputDetector.detect_input_type(input_item)

            # Validate input
            is_valid, error = InputDetector.validate_input(
                input_item, input_type, self.max_file_size_mb
            )

            if not is_valid:
                print(f"Invalid input: {error}", file=sys.stderr)
                continue

            # Process based on type
            try:
                items = self._process_single_input(input_item, input_type)
                content_items.extend(items)
                print(f"Processed {len(items)} item(s) from {input_type}", file=sys.stderr)
            except Exception as e:
                print(f"Failed to process {input_item}: {e}", file=sys.stderr)
                continue

        return content_items

    def _process_single_input(self, input_item: str, input_type: str) -> List[ContentItem]:
        """Process a single input item"""
        if input_type == "subject":
            return [ContentItem(
                content=input_item.strip(),
                content_type="subject",
                source=input_item.strip()  # Use the subject text itself as the source
            )]

        elif input_type == "video":
            return self._process_video(input_item)

        elif input_type == "directory":
            return self._process_directory(input_item)

        elif input_type == "transcript_file":
            return self._process_transcript_file(input_item)

        return []

    def _process_video(self, video_path: str) -> List[ContentItem]:
        """Process a single video file"""
        transcript = self.transcriber.transcribe_video(video_path)
        if not transcript:
            return []

        return [ContentItem(
            content=transcript,
            content_type="video",
            source=video_path,
            processing_notes=f"Transcribed ({len(transcript)} chars)"
        )]

    def _process_directory(self, dir_path: str) -> List[ContentItem]:
        """Process all videos in a directory with improved filtering"""
        path = Path(dir_path)

        # Find all video files with filtering
        video_files = []
        for ext in InputDetector.SUPPORTED_VIDEO_FORMATS:
            # Find files with this extension
            found_files = list(path.glob(f'*{ext}')) + list(path.glob(f'*{ext.upper()}'))

            # Filter out system files
            for file_path in found_files:
                if not InputDetector.should_skip_file(file_path):
                    video_files.append(file_path)

        if not video_files:
            print(f"No valid video files found in: {dir_path}", file=sys.stderr)
            return []

        print(f"Found {len(video_files)} video files", file=sys.stderr)

        # Process each video
        content_items = []
        processed_count = 0
        failed_count = 0

        for video_file in sorted(video_files):
            print(f"Processing: {video_file.name}", file=sys.stderr)
            try:
                items = self._process_video(str(video_file))
                if items:
                    content_items.extend(items)
                    processed_count += 1
                else:
                    failed_count += 1
                    print(f"Failed to process: {video_file.name}", file=sys.stderr)
            except Exception as e:
                failed_count += 1
                print(f"Error processing {video_file.name}: {e}", file=sys.stderr)

        print(f"Directory processing complete: {processed_count} success, {failed_count} failed", file=sys.stderr)
        return content_items

    def _process_transcript_file(self, file_path: str) -> List[ContentItem]:
        """Process a transcript text file"""
        try:
            with open(file_path, 'r', encoding='utf-8') as f:
                content = f.read().strip()

            if not content:
                print(f"Empty transcript file: {file_path}", file=sys.stderr)
                return []

            return [ContentItem(
                content=content,
                content_type="transcript_file",
                source=file_path,
                processing_notes=f"Loaded ({len(content)} chars)"
            )]

        except Exception as e:
            print(f"Failed to read transcript file: {e}", file=sys.stderr)
            return []

    def prepare_content(self, items: List[ContentItem], ai_manager) -> List[ContentItem]:
        """
        Prepare content items for metadata generation by summarizing long transcripts

        Args:
            items: List of ContentItem objects
            ai_manager: AIManager instance for summarization

        Returns:
            List[ContentItem]: Processed items with summarized content if needed
        """
        processed_items = []

        for item in items:
            # Skip subjects (already concise)
            if item.content_type == "subject":
                processed_items.append(item)
                continue

            # For videos and transcript files, check if summarization is needed
            # Use a threshold of 4000 characters (roughly 1000 tokens)
            if len(item.content) > 4000:
                print(f"Summarizing long transcript ({len(item.content)} chars)...", file=sys.stderr)

                try:
                    # Get source name for better summarization
                    source_name = Path(item.source).stem if item.source else "content"

                    # Summarize using AI manager
                    summary = ai_manager.summarize_transcript(item.content, source_name)

                    if summary:
                        # Create new item with summarized content
                        summarized_item = ContentItem(
                            content=summary,
                            content_type=item.content_type,
                            source=item.source,
                            processing_notes=f"Summarized from {len(item.content)} to {len(summary)} chars"
                        )
                        processed_items.append(summarized_item)
                        print(f"Summarized to {len(summary)} characters", file=sys.stderr)
                    else:
                        # If summarization fails, use original
                        print("Summarization failed, using original content", file=sys.stderr)
                        processed_items.append(item)

                except Exception as e:
                    print(f"Error during summarization: {e}", file=sys.stderr)
                    processed_items.append(item)
            else:
                # Content is already short enough
                processed_items.append(item)

        return processed_items

    def get_processing_summary(self, content_items: List[ContentItem]) -> Dict[str, Any]:
        """Get summary of processed content"""
        by_type = {}
        sources = []

        for item in content_items:
            # Count by type
            if item.content_type not in by_type:
                by_type[item.content_type] = 0
            by_type[item.content_type] += 1

            # Collect sources
            if item.source and item.source not in sources:
                sources.append(item.source)

        return {
            "total_items": len(content_items),
            "by_type": by_type,
            "sources": sources[:10]  # Limit to first 10 sources
        }
