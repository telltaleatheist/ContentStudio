# Build Scripts Reference

Complete guide to building and packaging ContentStudio with all required binaries.

## Quick Reference

### Clean Build (Downloads Everything + Packages)

```bash
# macOS Universal (Intel + Apple Silicon)
npm run clean:package:mac

# macOS Apple Silicon only
npm run clean:package:mac-arm64

# macOS Intel only
npm run clean:package:mac-x64

# Windows x64
npm run clean:package:win

# Linux x64
npm run clean:package:linux
```

### Quick Package (Assumes Binaries Already Downloaded)

```bash
# macOS Universal
npm run package:mac

# macOS Apple Silicon only
npm run package:mac-arm64

# macOS Intel only
npm run package:mac-x64

# Windows x64
npm run package:win

# Linux x64
npm run package:linux
```

---

## Available Scripts

### Development Scripts

#### `npm run electron:dev`
Start the app in development mode:
- Starts Angular dev server on port 4200
- Builds Electron + Preload TypeScript
- Launches Electron in dev mode
- Uses system Python venv or system binaries

#### `npm run setup:python`
Set up Python virtual environment for development:
```bash
cd python && python3 -m venv venv && pip install -r requirements.txt
```

---

## Build Scripts

### Code Building

#### `npm run build:electron`
Compile Electron main process TypeScript → `dist/main/`

#### `npm run build:preload`
Compile Electron preload script TypeScript → `dist/preload/`

#### `npm run build:frontend`
Build Angular frontend → `frontend/dist/`

#### `npm run build:all`
Build everything: Electron + Preload + Frontend

---

## Download Scripts

### Download FFmpeg

#### `npm run download:ffmpeg:mac`
Downloads/copies FFmpeg for macOS to `resources/bin/mac/ffmpeg`
- Tries to copy from system FFmpeg first (development)
- Prompts for manual download for production

#### `npm run download:ffmpeg:win`
Sets up FFmpeg for Windows to `resources/bin/win/ffmpeg.exe`
- Prompts for manual download from gyan.dev

#### `npm run download:ffmpeg:linux`
Downloads FFmpeg for Linux to `resources/bin/linux/ffmpeg`
- Auto-downloads static build from johnvansickle.com

### Download Python

#### `npm run download:python:mac-arm64`
Downloads Python 3.11 standalone for macOS Apple Silicon
- Downloads from python-build-standalone
- Extracts to `resources/python/mac-arm64/`
- Installs all requirements automatically

#### `npm run download:python:mac-x64`
Downloads Python 3.11 standalone for macOS Intel
- Extracts to `resources/python/mac-x64/`

#### `npm run download:python:win-x64`
Downloads Python 3.11 standalone for Windows x64
- Extracts to `resources/python/win-x64/`

#### `npm run download:python:linux-x64`
Downloads Python 3.11 standalone for Linux x64
- Extracts to `resources/python/linux-x64/`

### Download Everything

#### `npm run download:all:mac`
Downloads all binaries for macOS Universal build:
- FFmpeg for macOS
- Python for mac-arm64
- Python for mac-x64

#### `npm run download:all:mac-arm64`
Downloads binaries for Apple Silicon only:
- FFmpeg for macOS
- Python for mac-arm64

#### `npm run download:all:mac-x64`
Downloads binaries for Intel only:
- FFmpeg for macOS
- Python for mac-x64

#### `npm run download:all:win`
Downloads binaries for Windows:
- FFmpeg for Windows
- Python for win-x64

#### `npm run download:all:linux`
Downloads binaries for Linux:
- FFmpeg for Linux
- Python for linux-x64

---

## Package Scripts

### Quick Package (No Download)

These scripts assume binaries are already in `resources/` directories.

#### `npm run package:mac`
Package universal macOS app (Intel + Apple Silicon):
- Builds code
- Creates `.dmg` installer
- Output: `dist-build/ContentStudio-*.dmg`
- Requires:
  - `resources/bin/mac/ffmpeg`
  - `resources/python/mac-arm64/` (optional)
  - `resources/python/mac-x64/` (optional)

#### `npm run package:mac-arm64`
Package macOS app for Apple Silicon only:
- Creates arm64-only build
- Smaller file size
- Requires:
  - `resources/bin/mac/ffmpeg`
  - `resources/python/mac-arm64/` (optional)

#### `npm run package:mac-x64`
Package macOS app for Intel only:
- Creates x64-only build
- Requires:
  - `resources/bin/mac/ffmpeg`
  - `resources/python/mac-x64/` (optional)

#### `npm run package:win`
Package Windows app:
- Creates `.exe` installer
- Output: `dist-build/ContentStudio Setup *.exe`
- Requires:
  - `resources/bin/win/ffmpeg.exe`
  - `resources/python/win-x64/` (optional)

#### `npm run package:linux`
Package Linux app:
- Creates AppImage and .deb
- Output: `dist-build/ContentStudio-*.AppImage`
- Requires:
  - `resources/bin/linux/ffmpeg`
  - `resources/python/linux-x64/` (optional)

### Clean Package (Download + Package)

These scripts download all binaries and then package.

#### `npm run clean:package:mac`
1. Cleans previous build
2. Downloads FFmpeg for macOS
3. Downloads Python for mac-arm64 and mac-x64
4. Builds all code
5. Packages universal macOS app

**Duration:** ~10-15 minutes (downloads ~800MB)

#### `npm run clean:package:mac-arm64`
Same as above but only for Apple Silicon.
**Duration:** ~5-10 minutes (downloads ~500MB)

#### `npm run clean:package:mac-x64`
Same as above but only for Intel.
**Duration:** ~5-10 minutes (downloads ~500MB)

#### `npm run clean:package:win`
1. Cleans previous build
2. Downloads FFmpeg for Windows
3. Downloads Python for win-x64
4. Builds all code
5. Packages Windows app

**Duration:** ~5-10 minutes

#### `npm run clean:package:linux`
1. Cleans previous build
2. Downloads FFmpeg for Linux
3. Downloads Python for linux-x64
4. Builds all code
5. Packages Linux app

**Duration:** ~5-10 minutes

---

## Cleanup Scripts

#### `npm run clean`
Remove build artifacts:
- `dist/` (compiled TypeScript)
- `*.dmg` (macOS installers)
- `*.dmg.blockmap`

#### `npm run clean:binaries`
Remove downloaded binaries:
- `resources/bin/`
- `resources/python/`

#### `npm run clean:all`
Nuclear clean:
- All build artifacts
- `node_modules/`
- `python/venv/`

---

## Directory Structure After Download

```
ContentStudio/
├── resources/
│   ├── bin/
│   │   ├── mac/
│   │   │   └── ffmpeg                    # ~60-120 MB
│   │   ├── win/
│   │   │   └── ffmpeg.exe                # ~60-120 MB
│   │   └── linux/
│   │       └── ffmpeg                    # ~60-120 MB
│   └── python/
│       ├── mac-arm64/                    # ~500-800 MB
│       │   ├── bin/python3
│       │   └── lib/python3.11/
│       ├── mac-x64/                      # ~500-800 MB
│       │   ├── bin/python3
│       │   └── lib/python3.11/
│       ├── win-x64/                      # ~500-800 MB
│       │   ├── python.exe
│       │   └── Lib/
│       └── linux-x64/                    # ~500-800 MB
│           ├── bin/python3
│           └── lib/python3.11/
└── python/
    ├── venv/                             # Development only (not bundled)
    ├── core/                             # Python source (bundled)
    └── metadata_generator.py            # Python source (bundled)
```

---

## Binary Detection at Runtime

The app detects binaries in this priority order:

### Python
1. **Bundled Python** (production): `Resources/python/{platform}-{arch}/bin/python3`
   - Example: `Resources/python/mac-arm64/bin/python3`
2. **Development venv**: `python/venv/bin/python`
3. **System Python**: `python3`

### FFmpeg
1. **Bundled FFmpeg** (production): `Resources/bin/{platform}/ffmpeg`
   - Example: `Resources/bin/mac/ffmpeg`
2. **System FFmpeg**: Via PATH (`/usr/local/bin`, `/opt/homebrew/bin`, etc.)

This happens automatically in `electron/services/python-service.ts`.

---

## Expected Build Sizes

| Platform | Component | Size |
|----------|-----------|------|
| macOS (Universal) | Base App | ~200 MB |
| | + FFmpeg | ~60 MB |
| | + Python (arm64) | ~600 MB |
| | + Python (x64) | ~600 MB |
| | **Total DMG** | **~1.5 GB** |
| macOS (Single Arch) | Base App + FFmpeg + Python | **~900 MB** |
| Windows | Base App + FFmpeg + Python | **~800 MB** |
| Linux | Base App + FFmpeg + Python | **~800 MB** |

Most of the size comes from PyTorch (~400 MB) and Whisper models.

---

## Example Workflows

### Development Workflow

```bash
# One-time setup
npm install
npm run setup:python

# Daily development
npm run electron:dev
```

### Build for Current Platform (macOS)

```bash
# Download binaries once
npm run download:all:mac-arm64

# Then package anytime
npm run package:mac-arm64
```

### Build for All Platforms (CI/CD)

```bash
# macOS
npm run clean:package:mac

# Windows (on Windows machine or via CI)
npm run clean:package:win

# Linux (on Linux machine or via CI)
npm run clean:package:linux
```

### Quick Rebuild (Binaries Already Downloaded)

```bash
# Make code changes...

npm run package:mac-arm64
# Takes ~2-3 minutes vs 10+ for clean build
```

---

## Troubleshooting

### "FFmpeg not found" during download
- macOS: Install FFmpeg via Homebrew for development: `brew install ffmpeg`
- For production: Download static build manually and place in `resources/bin/`

### "Python download failed"
- Check internet connection
- Try manual download from: https://github.com/indygreg/python-build-standalone/releases
- Extract to appropriate `resources/python/` directory

### "Requirements installation failed"
- Ensure Python downloaded correctly
- Check `resources/python/{platform}-{arch}/bin/python3 --version`
- Try manual install: `resources/python/mac-arm64/bin/python3 -m pip install -r python/requirements.txt`

### Package includes wrong architecture
- Check `resources/python/` has correct architecture folder
- For mac-arm64, should have `mac-arm64/`, not `mac-x64/`
- Clean and re-download: `npm run clean:binaries && npm run download:all:mac-arm64`

### Build size too large
- This is expected with PyTorch (~1.5 GB universal, ~900 MB single arch)
- Consider not bundling Python (app will use system Python)
- Remove torch/whisper if transcription not needed

---

## CI/CD Integration

### GitHub Actions Example

```yaml
name: Build macOS

on: [push]

jobs:
  build-mac:
    runs-on: macos-latest
    steps:
      - uses: actions/checkout@v3
      - uses: actions/setup-node@v3
        with:
          node-version: '18'

      - name: Install dependencies
        run: npm install

      - name: Download binaries and build
        run: npm run clean:package:mac-arm64

      - name: Upload artifact
        uses: actions/upload-artifact@v3
        with:
          name: ContentStudio-macOS
          path: dist-build/*.dmg
```

---

## Notes

- **Development**: Uses system binaries (faster iteration)
- **Production**: Uses bundled binaries (self-contained)
- **Fallback**: If bundled binaries missing, falls back to system
- **Platform-specific**: Each platform needs its own binaries
- **Universal builds**: macOS can bundle both architectures
