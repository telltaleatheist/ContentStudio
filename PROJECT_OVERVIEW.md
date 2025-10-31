# LaunchPad - Project Overview

## What is LaunchPad?

LaunchPad is an Electron-based desktop application that generates AI-powered metadata for YouTube and Spreaker content. It takes your content (text subjects, video files, or transcripts) and produces optimized titles, descriptions, tags, hashtags, and thumbnail text.

---

## 📋 Project Requirements (For AI Assistant Reference)

Use this section when asking an AI assistant to build similar projects or make modifications to LaunchPad.

### Core Purpose
Build an Electron desktop application for AI-powered metadata generation (titles, descriptions, tags, hashtags, thumbnail text) for YouTube and Spreaker content.

### Technology Stack Requirements

**Frontend:**
- **Framework**: Electron (desktop app)
- **UI**: Vanilla HTML/CSS/JavaScript (NO frameworks like React/Angular/Vue)
- **Design Theme**: Creamsicle theme
  - Primary orange: `#ff6b35`
  - Reference: `/Volumes/Callisto/Projects/standalone creamsicle template.html`
  - Must include dark mode support
  - Clean, modern, minimal design
- **Example Reference**: `/Volumes/Callisto/Projects/clippy` for Electron architecture

**Backend/Logic:**
- **Language**: Python 3.9+
- **Execution**: Subprocess (spawn) from Electron - **NO web server** (no Flask, no Uvicorn, no FastAPI)
- **Communication**: IPC via JSON stdout/stderr
- **Base Logic**: Adapt from `/Volumes/Callisto/Projects/ContentStudio` (metadata pipeline only, remove video analysis pipeline)

**AI Integration:**
- **Primary Provider**: Ollama (local, default)
  - Default model: `cogito:70b`
  - Fast model for summarization: `llama3.1:8b`
- **Secondary Providers**: OpenAI, Claude (Anthropic) - configurable
- **Transcription**: OpenAI Whisper for video-to-text
- **Provider Selection**: User-configurable in settings UI

### Architecture Constraints

**DO NOT Include:**
- ❌ Web server (Flask, Uvicorn, NestJS backend)
- ❌ Frontend frameworks (React, Angular, Vue)
- ❌ Video analysis pipeline (exists in separate app)
- ❌ Database (use electron-store for settings)
- ❌ REST API endpoints
- ❌ WebSockets for Python communication

**DO Include:**
- ✅ Python as child process (spawn/exec)
- ✅ Electron IPC for frontend ↔ main process
- ✅ JSON for Python ↔ Electron communication
- ✅ electron-store for persistent settings
- ✅ Creamsicle design system throughout
- ✅ Dark mode toggle
- ✅ TypeScript for Electron code
- ✅ Proper error handling and logging

### UI/UX Requirements

**Layout:**
- **Left Panel**: Input management
  - Add text subjects, files, directories
  - List of added inputs (removable)
  - Platform selector (YouTube/Spreaker)
  - Mode selector (Individual/Compilation)
  - Generate button

- **Right Panel**: Output display
  - Progress indicator during generation
  - Organized sections for each metadata type
  - Click to copy to clipboard
  - Save location indicator

**Settings Modal:**
- AI provider selection (Ollama/OpenAI/Claude)
- Model configuration
- API keys (for cloud providers)
- Output directory selection
- Theme toggle (light/dark)

**User Flow:**
1. Add inputs → 2. Select platform/mode → 3. Click generate → 4. View/copy results

### Default Configuration

```javascript
{
  aiProvider: 'ollama',
  ollamaModel: 'cogito:70b',
  ollamaHost: 'http://localhost:11434',
  openaiApiKey: 'sk-dummy-key-replace-me',
  claudeApiKey: 'sk-ant-dummy-key-replace-me',
  defaultPlatform: 'youtube',
  defaultMode: 'individual',
  outputDirectory: '~/Documents/LaunchPad Output'
}
```

### Reference Applications

- **UI Theme**: `/Volumes/Callisto/Projects/standalone creamsicle template.html`
- **Electron Architecture**: `/Volumes/Callisto/Projects/clippy`
- **Python Logic**: `/Volumes/Callisto/Projects/ContentStudio/pipelines/metadata/`
- **AI Integration**: `/Volumes/Callisto/Projects/ContentStudio/core/ai_manager.py`

### Key Design Principles

1. **Local-First**: Prioritize Ollama for privacy and speed
2. **No Web Server**: Python subprocess only, not HTTP server
3. **Creamsicle Everywhere**: Consistent theme across all UI
4. **Simple & Fast**: Minimal dependencies, quick startup
5. **User-Friendly**: Clear error messages, helpful defaults
6. **Based on Proven Code**: Adapt ContentStudio's metadata pipeline

**Bottom Line**: Build a desktop app (not web app) that generates metadata using AI. Python runs as subprocess (not server). Use Creamsicle theme. Make it simple, fast, and local-first.

---

## Architecture

### Technology Stack

**Frontend:**
- Electron (desktop app framework)
- HTML/CSS/JavaScript (vanilla, no frameworks)
- Creamsicle design theme (signature orange #ff6b35)
- Dark mode support

**Backend:**
- Python 3.9+ (subprocess, not web server)
- TypeScript for Electron main process
- IPC (Inter-Process Communication) for Electron ↔ Python

**AI/ML:**
- Ollama (local AI, recommended)
- OpenAI API (cloud option)
- Claude/Anthropic API (cloud option)
- Whisper (speech-to-text for videos)

### Key Components

#### 1. Electron Main Process (`electron/`)
- **main.ts**: Application entry point, window management
- **preload.ts**: IPC bridge (secure communication)
- **services/python-service.ts**: Manages Python subprocess
- **ipc/ipc-handlers.ts**: IPC request handlers

#### 2. Frontend (`frontend/`)
- **index.html**: Single-page UI
- **styles.css**: Creamsicle theme with dark mode
- **app.js**: UI logic, state management, IPC calls

#### 3. Python Backend (`python/`)
- **metadata_generator.py**: CLI entry point
- **core/ai_manager.py**: Multi-provider AI integration (974 lines)
- **core/input_handler.py**: Process videos, transcripts, text
- **core/output_handler.py**: Save metadata in JSON + readable formats
- **core/config_manager.py**: Configuration management

## Data Flow

```
User Input (UI)
    ↓
Frontend (app.js)
    ↓ IPC
Electron Main (ipc-handlers.ts)
    ↓
Python Service (python-service.ts)
    ↓ spawn subprocess
Python Script (metadata_generator.py)
    ↓
AI Manager → AI Provider (Ollama/OpenAI/Claude)
    ↓
Output Handler → Save to disk
    ↓
Return JSON to Electron
    ↓ IPC
Frontend displays results
```

## Features

### Input Types
1. **Text Subject**: Direct topic/subject entry
2. **Video Files**: MP4, MOV, AVI, MKV, etc.
3. **Transcript Files**: .txt files
4. **Directories**: Batch process folders

### Processing Modes
1. **Individual**: Separate metadata for each input
2. **Compilation**: Combined metadata from multiple inputs

### Platforms
1. **YouTube**: Optimized for YouTube algorithm
2. **Spreaker**: Podcast-specific optimization

### Output
- **10 Titles**: 45-70 characters, optimized for CTR
- **10 Thumbnail Text**: 3 words max, ALL CAPS
- **Description**: Complete, no timestamps, engagement-focused
- **15 Tags**: Layered pyramid (specific → broad)
- **10 Hashtags**: With # symbols

### AI Providers

**Ollama (Default - Recommended):**
- Runs locally on your machine
- No API costs
- Full privacy
- Model: cogito:70b (or llama3.1:8b for speed)
- Fast model for summarization: llama3.1:8b

**OpenAI:**
- Cloud-based
- Requires API key
- GPT-4 Turbo for metadata
- GPT-3.5 Turbo for summarization

**Claude (Anthropic):**
- Cloud-based
- Requires API key
- Claude 3 Opus for metadata
- Claude 3 Haiku for summarization

## File Structure

```
LaunchPad/
├── electron/                      # Electron main process
│   ├── main.ts                   # App entry, window management
│   ├── preload.ts                # IPC bridge
│   ├── services/
│   │   └── python-service.ts     # Python subprocess manager
│   └── ipc/
│       └── ipc-handlers.ts       # IPC handlers
│
├── frontend/                      # UI Layer
│   ├── index.html                # Main UI
│   ├── styles.css                # Creamsicle theme
│   └── app.js                    # Frontend logic
│
├── python/                        # Python backend
│   ├── metadata_generator.py     # CLI entry point
│   ├── requirements.txt          # Python dependencies
│   ├── core/
│   │   ├── ai_manager.py        # AI provider integration
│   │   ├── input_handler.py     # Input processing
│   │   ├── output_handler.py    # Output formatting
│   │   └── config_manager.py    # Configuration
│   └── examples/
│       └── basic_usage.py       # Usage examples
│
├── package.json                   # Node dependencies & scripts
├── tsconfig.electron.json        # TypeScript config
├── tsconfig.preload.json         # Preload TypeScript config
├── setup.sh                      # Automated setup script
├── README.md                     # Full documentation
├── QUICKSTART.md                 # 5-minute quick start
└── PROJECT_OVERVIEW.md           # This file
```

## Development Workflow

### Setup (One-time)
```bash
./setup.sh
```

### Daily Development
```bash
npm run electron:dev    # Run in development mode
```

### Building for Distribution
```bash
npm run package:mac     # macOS .dmg
npm run package:win     # Windows installer
npm run package:linux   # Linux AppImage
```

## Configuration

Settings are stored using `electron-store` with these defaults:

```javascript
{
  aiProvider: 'ollama',
  ollamaModel: 'cogito:70b',
  ollamaHost: 'http://localhost:11434',
  openaiApiKey: 'sk-dummy-key-replace-me',
  claudeApiKey: 'sk-ant-dummy-key-replace-me',
  defaultPlatform: 'youtube',
  defaultMode: 'individual',
  outputDirectory: '~/Documents/LaunchPad Output'
}
```

## Dependencies

**Node.js:**
- electron: ^36.0.1
- electron-log: ^5.3.3
- electron-store: ^10.0.0
- typescript: ^5.8.3

**Python:**
- requests (Ollama HTTP API)
- openai (OpenAI API)
- anthropic (Claude API)
- openai-whisper (transcription)
- torch (Whisper dependency)
- PyYAML (config files)

## Design Principles

1. **Local-First**: Prioritize local AI (Ollama) for privacy and speed
2. **No Web Server**: Python runs as subprocess, not HTTP server
3. **Simple UI**: Clean, focused interface with Creamsicle theme
4. **Flexible**: Support multiple AI providers and platforms
5. **Fast**: Efficient processing with async operations
6. **Quality**: Based on proven ContentStudio pipeline

## Comparison with ContentStudio

**LaunchPad:**
- Desktop app (Electron)
- Simplified, focused on metadata only
- Multiple AI providers (Ollama/OpenAI/Claude)
- Beautiful GUI with Creamsicle theme
- No video analysis pipeline

**ContentStudio:**
- CLI application
- Web UI (Flask)
- Ollama only
- Video analysis + metadata
- More complex feature set

LaunchPad takes the best parts of ContentStudio's metadata pipeline and wraps them in a polished desktop app.

## Future Enhancements (Potential)

- [ ] Batch processing queue with progress tracking
- [ ] Metadata templates and presets
- [ ] History and favorites
- [ ] Export to various formats (CSV, Excel)
- [ ] A/B testing different titles/descriptions
- [ ] Integration with YouTube API for direct upload
- [ ] Analytics on metadata performance
- [ ] Multi-language support
- [ ] Cloud sync for settings

## License

MIT

---

**Built with Python, TypeScript, and the Creamsicle theme.**
