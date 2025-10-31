# LaunchPad

> AI-powered metadata generation for YouTube and Spreaker

LaunchPad is an Electron-based desktop application that generates high-quality metadata (titles, descriptions, tags, hashtags, and thumbnail text) for your video and podcast content using AI.

## Features

- **🤖 Multiple AI Providers**: Support for Ollama (local), OpenAI, and Claude (Anthropic)
- **📹 Video Processing**: Automatic transcription using Whisper
- **📝 Flexible Inputs**: Text subjects, video files, transcript files, and directories
- **🎯 Multi-Platform**: Optimized for YouTube and Spreaker
- **🎨 Beautiful UI**: Clean interface with Creamsicle theme and dark mode
- **⚡ Fast & Local**: Run AI models locally with Ollama (recommended)

## Prerequisites

- **Node.js** 18+ and npm
- **Python** 3.9+
- **Ollama** (recommended) - [Download here](https://ollama.ai)
- **FFmpeg** (for video processing)

### Install FFmpeg

**macOS:**
```bash
brew install ffmpeg
```

**Linux:**
```bash
sudo apt install ffmpeg  # Ubuntu/Debian
sudo yum install ffmpeg  # CentOS/RHEL
```

**Windows:**
Download from [ffmpeg.org](https://ffmpeg.org/download.html)

## Installation

### 1. Clone and Install Dependencies

```bash
cd /Volumes/Callisto/Projects/LaunchPad

# Install Node dependencies
npm install

# Set up Python environment
npm run setup:python
```

### 2. Install Ollama (Recommended)

Download and install Ollama from [ollama.ai](https://ollama.ai)

Pull the recommended model:
```bash
ollama pull cogito:70b
```

**Alternative models:**
```bash
ollama pull llama3.1:8b   # Faster, lighter
ollama pull qwen2.5:7b     # Alternative option
```

### 3. Build and Run

```bash
# Development mode
npm run electron:dev

# Production build
npm run package:mac     # macOS
npm run package:win     # Windows
npm run package:linux   # Linux
```

## Configuration

### AI Providers

#### Ollama (Default - Recommended)
- **Model**: cogito:70b (best quality) or llama3.1:8b (faster)
- **Host**: http://localhost:11434
- **No API key required**

#### OpenAI
- **API Key**: Get from [platform.openai.com](https://platform.openai.com/api-keys)
- **Models**: GPT-4 Turbo (metadata), GPT-3.5 Turbo (summarization)

#### Claude (Anthropic)
- **API Key**: Get from [console.anthropic.com](https://console.anthropic.com)
- **Models**: Claude 3 Opus (metadata), Claude 3 Haiku (summarization)

### Settings

Click the ⚙️ settings icon to configure:
- AI provider and model
- API keys (for OpenAI/Claude)
- Output directory

## Usage

### Basic Workflow

1. **Add Inputs**
   - 📝 **Text Subject**: Enter a topic or subject
   - 📁 **Files**: Select video files or transcript files
   - 📂 **Directory**: Process all videos in a folder

2. **Configure**
   - Choose **Platform**: YouTube or Spreaker
   - Choose **Mode**:
     - Individual (separate metadata for each input)
     - Compilation (combined metadata from all inputs)

3. **Generate**
   - Click **Generate Metadata**
   - Wait for processing (video transcription + AI generation)
   - View and copy results

### Output

Metadata includes:
- **10 Titles** (optimized for click-through)
- **10 Thumbnail Text options** (3 words max, ALL CAPS)
- **Full Description** (no timestamps, engagement-focused)
- **15 Tags** (layered from specific to broad)
- **10 Hashtags** (with # symbols)

Files are saved to your output directory in both JSON and readable text formats.

## Project Structure

```
LaunchPad/
├── electron/           # Electron main process
│   ├── main.ts        # App entry point
│   ├── preload.ts     # Preload script (IPC bridge)
│   ├── services/      # Python service, etc.
│   └── ipc/           # IPC handlers
├── frontend/          # UI (HTML/CSS/JS)
│   ├── index.html
│   ├── styles.css     # Creamsicle theme
│   └── app.js         # Frontend logic
├── python/            # Python backend
│   ├── metadata_generator.py  # Main script
│   └── core/          # Core modules
│       ├── ai_manager.py      # AI provider integration
│       ├── input_handler.py   # Input processing
│       ├── output_handler.py  # Output formatting
│       └── config_manager.py  # Configuration
└── package.json
```

## Development

### Build Commands

```bash
# Build Electron code
npm run build:electron
npm run build:preload
npm run build:all

# Clean build artifacts
npm run clean
npm run clean:all

# Development mode (with hot reload)
npm run electron:dev
```

### Python Development

```bash
# Activate Python environment
cd python
source venv/bin/activate

# Install dependencies
pip install -r requirements.txt

# Test metadata generation
python metadata_generator.py \
  --inputs "elon musk twitter" \
  --platform youtube \
  --mode individual \
  --ai-provider ollama \
  --ai-model cogito:70b
```

## Troubleshooting

### Python Environment Issues

If you get import errors:
```bash
cd /Volumes/Callisto/Projects/LaunchPad
rm -rf python/venv
npm run setup:python
```

### Ollama Connection Issues

1. Make sure Ollama is running:
   ```bash
   ollama serve
   ```

2. Test the connection:
   ```bash
   curl http://localhost:11434/api/tags
   ```

3. Check if the model is installed:
   ```bash
   ollama list
   ollama pull cogito:70b
   ```

### Video Transcription Issues

Make sure FFmpeg is installed:
```bash
ffmpeg -version
```

### Electron Build Issues

Clear node modules and reinstall:
```bash
npm run clean:all
npm install
npm run build:all
```

## Credits

- **AI Models**: Powered by Ollama, OpenAI, and Anthropic
- **Transcription**: OpenAI Whisper
- **Based on**: ContentStudio metadata pipeline
- **Design**: Creamsicle theme by Owen Morgan

## License

MIT

---

**Made with ❤️ by Owen Morgan**
