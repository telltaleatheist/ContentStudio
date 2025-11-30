# Resources Directory

This directory contains binaries and resources that will be bundled with the packaged application.

## Directory Structure

```
resources/
├── bin/
│   ├── mac/          # macOS binaries (x64 and arm64)
│   ├── win/          # Windows binaries
│   └── linux/        # Linux binaries
└── python/           # Standalone Python distribution (platform-specific)
```

## Required Binaries

### 1. FFmpeg

FFmpeg is required for video processing (extracting audio from video files).

#### macOS
Download static FFmpeg build from: https://evermeet.cx/ffmpeg/
- Download `ffmpeg-<version>.7z`
- Extract and place the `ffmpeg` binary in `resources/bin/mac/`
- Make it executable: `chmod +x resources/bin/mac/ffmpeg`

#### Windows
Download from: https://www.gyan.dev/ffmpeg/builds/
- Download the "essentials" build
- Extract `ffmpeg.exe` from `bin/` folder
- Place in `resources/bin/win/`

#### Linux
Download from: https://johnvansickle.com/ffmpeg/
- Download static build
- Extract `ffmpeg` binary
- Place in `resources/bin/linux/`

### 2. Python

A standalone Python distribution with all dependencies pre-installed.

#### Option 1: Python Standalone Builds
- macOS: https://github.com/indygreg/python-build-standalone/releases
- Windows: https://github.com/indygreg/python-build-standalone/releases
- Download Python 3.11+ standalone build
- Extract to `resources/python/<platform>/`

#### Option 2: Use python-build-standalone via script
Run the bundling script (to be created):
```bash
npm run bundle:python
```

## Python Dependencies

The following packages need to be installed in the bundled Python:
- openai-whisper
- torch
- torchaudio
- requests
- openai
- anthropic
- PyYAML
- pathspec
- python-dateutil

These will be installed automatically by the bundling script.

## Electron Builder Integration

The `package.json` build configuration is set up to automatically include these resources in the packaged app under `extraResources`.

## Notes

- Binaries must be platform-specific
- For universal macOS builds, you may need both x64 and arm64 versions
- Total size of bundled resources will be significant (~500MB-1GB with Python + torch)
