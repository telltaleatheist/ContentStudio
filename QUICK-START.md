# Quick Start Guide

## For Developers

### First Time Setup
```bash
# Install Node dependencies
npm install

# Set up Python environment
npm run setup:python

# Start development
npm run electron:dev
```

Your app will use:
- System FFmpeg (from PATH)
- Python venv at `python/venv/`

---

## For Building Releases

### Option 1: Clean Build (Recommended)

Everything in one command - downloads binaries and packages:

```bash
# macOS (your current platform)
npm run clean:package:mac-arm64

# Takes ~5-10 minutes, downloads ~500MB
# Output: dist-build/ContentStudio-*.dmg
```

### Option 2: Incremental Build

Download once, build many times:

```bash
# Download binaries (once)
npm run download:all:mac-arm64

# Package (fast, repeatable)
npm run package:mac-arm64
```

---

## All Build Commands

| Command | Platform | Type |
|---------|----------|------|
| `npm run clean:package:mac` | macOS Universal | Download + Build |
| `npm run clean:package:mac-arm64` | macOS Apple Silicon | Download + Build |
| `npm run clean:package:mac-x64` | macOS Intel | Download + Build |
| `npm run clean:package:win` | Windows x64 | Download + Build |
| `npm run clean:package:linux` | Linux x64 | Download + Build |
| `npm run package:mac-arm64` | macOS Apple Silicon | Build Only |
| `npm run package:win` | Windows x64 | Build Only |
| `npm run package:linux` | Linux x64 | Build Only |

---

## What Gets Bundled?

✅ **Always included:**
- Your Electron/Angular app code
- Python source code (`python/core/`, `metadata_generator.py`)

✅ **Included if downloaded to `resources/`:**
- FFmpeg binary (~60 MB)
- Python 3.11 standalone + packages (~600 MB)

⚠️ **Never included:**
- `python/venv/` (development only)
- `node_modules/` build dependencies

---

## File Size Expectations

- **With bundled Python + FFmpeg:** ~900 MB (single arch), ~1.5 GB (universal)
- **Without bundled Python:** ~200 MB (app will use system Python)

---

## Troubleshooting

### "Command not found: bash"
Windows users: Use Git Bash or WSL

### "FFmpeg not found"
Install FFmpeg or let the script copy from system:
```bash
# macOS
brew install ffmpeg

# Then run download
npm run download:ffmpeg:mac
```

### "Python download failed"
Check internet connection and retry:
```bash
npm run download:python:mac-arm64
```

### Build fails with "No such file"
Ensure binaries are downloaded:
```bash
ls resources/bin/mac/        # Should show ffmpeg
ls resources/python/         # Should show mac-arm64/ etc.
```

---

## More Information

- **Build Scripts Reference:** See `BUILD-SCRIPTS.md`
- **Binary Bundling Details:** See `BUNDLING.md`
- **ASAR Structure:** See `ASAR-LAYOUT.md`
