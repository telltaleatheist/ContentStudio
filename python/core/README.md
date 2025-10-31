# LaunchPad Core Modules

This directory contains the core modules for LaunchPad's content processing and metadata generation system.

## Modules

### config_manager.py
Manages configuration for the LaunchPad system, including AI provider settings and output directories.

**Key Features:**
- Support for multiple AI providers (Ollama, OpenAI, Claude)
- Configurable output directories
- Fast and smart model selection

### input_handler.py
Processes various input types and normalizes them into structured content items.

**Key Features:**
- Supports multiple input types: text subjects, video files, transcript files, directories
- Video transcription using OpenAI Whisper
- Automatic input type detection and validation
- Content preparation with AI-powered summarization for long transcripts
- File filtering to skip system files and metadata files

**Supported Video Formats:**
- .mp4, .avi, .mov, .mkv, .webm, .m4v, .flv
- .wmv, .mpg, .mpeg, .3gp, .ogv

**ContentItem Dataclass:**
```python
@dataclass
class ContentItem:
    content: str              # The actual content (subject or transcript)
    content_type: str         # "subject", "video", "transcript_file"
    source: Optional[str]     # Original source path/description
    processing_notes: Optional[str]  # Processing information
```

**Main Methods:**
- `process_inputs(inputs: List[str]) -> List[ContentItem]` - Process multiple inputs
- `prepare_content(items: List[ContentItem], ai_manager) -> List[ContentItem]` - Summarize long content

**Dependencies:**
- `openai-whisper` - For video transcription
- `torch` - For Whisper model
- `ffmpeg` - For audio extraction from videos

### output_handler.py
Saves metadata to files in user-friendly formats.

**Key Features:**
- Dual-format output: JSON (structured) and TXT (human-readable)
- Automatic filename sanitization
- Batch processing summary generation
- Processing log creation
- Organized output in timestamped folders

**Main Methods:**
- `save_metadata(metadata: Dict, platform: str, source_name: str = None) -> str` - Save metadata files
- `create_batch_summary(batch_results: list, output_name: str = None) -> str` - Create batch summary
- `save_processing_log(log_entries: list, log_name: str = None) -> str` - Save processing logs

**Output Format:**
Each save operation creates a timestamped folder containing:
- `metadata.json` - Structured JSON data
- `metadata.txt` - Human-readable formatted text with sections for:
  - Titles
  - Thumbnail text
  - Description
  - Hashtags
  - Tags
  - Additional metadata

### ai_manager.py
Manages AI interactions for metadata generation (existing module).

## Installation

### Basic Installation
```bash
pip install torch openai-whisper
```

### Video Processing (macOS)
```bash
brew install ffmpeg
```

### Video Processing (Linux)
```bash
apt-get install ffmpeg
```

## Usage Examples

### Process Text Subject
```python
from core.config_manager import ConfigManager
from core.input_handler import InputHandler

config = ConfigManager(platform='youtube')
handler = InputHandler(config)

inputs = ["How to build a REST API with Python"]
content_items = handler.process_inputs(inputs)

for item in content_items:
    print(f"Type: {item.content_type}")
    print(f"Content: {item.content}")
```

### Process Video File
```python
from core.config_manager import ConfigManager
from core.input_handler import InputHandler

config = ConfigManager(platform='youtube')
config.whisper_model = 'base'  # Options: tiny, base, small, medium, large

handler = InputHandler(config)
content_items = handler.process_inputs(["/path/to/video.mp4"])

for item in content_items:
    print(f"Transcript: {item.content}")
    print(f"Length: {len(item.content)} characters")
```

### Process with Summarization
```python
from core.config_manager import ConfigManager
from core.input_handler import InputHandler
from core.ai_manager import AIManager

config = ConfigManager(ai_provider='ollama', ai_model='cogito:70b')
handler = InputHandler(config)
ai_manager = AIManager(config)

# Process inputs
content_items = handler.process_inputs(["/path/to/long_video.mp4"])

# Prepare content (summarizes if needed)
if ai_manager.initialize():
    prepared_items = handler.prepare_content(content_items, ai_manager)
```

### Save Metadata
```python
from core.config_manager import ConfigManager
from core.output_handler import OutputHandler

config = ConfigManager(platform='youtube')
output_handler = OutputHandler(config)

metadata = {
    'titles': ['My Video Title'],
    'description': 'Video description here',
    'hashtags': '#python #tutorial',
    'tags': ['python', 'tutorial']
}

output_path = output_handler.save_metadata(
    metadata=metadata,
    platform='youtube',
    source_name='my_video'
)

print(f"Saved to: {output_path}")
```

## Error Handling

All modules use stderr for logging and include comprehensive error handling:

```python
import sys

# All error messages go to stderr
print("Error message", file=sys.stderr)

# Exceptions are caught and logged
try:
    # Process content
    pass
except Exception as e:
    print(f"Failed to process: {e}", file=sys.stderr)
```

## Configuration

### Default Output Directory
- Default: `~/Documents/LaunchPad Output`
- Configurable via ConfigManager constructor

### Whisper Model Options
- `tiny` - Fastest, least accurate
- `base` - Good balance (default)
- `small` - Better accuracy
- `medium` - High accuracy
- `large` - Best accuracy, slowest

### Device Selection
The VideoTranscriber automatically detects and uses the best available device:
1. CUDA (NVIDIA GPUs)
2. MPS (Apple Silicon)
3. CPU (fallback)

## File Structure

```
LaunchPad Output/
└── 20251030_203252_youtube_video_name/
    ├── metadata.json
    └── metadata.txt
```

## See Also

- `examples/basic_usage.py` - Comprehensive usage examples
- ContentStudio's `core/input_handler.py` - Original implementation reference
- ContentStudio's `core/output_handler.py` - Original implementation reference
