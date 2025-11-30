# Bundling Guide for ContentStudio

This guide explains how to bundle all required binaries with your Electron app for distribution.

## Overview

ContentStudio requires the following external dependencies:
- **Python 3.10+** with AI/ML libraries (whisper, torch, etc.)
- **FFmpeg** for video audio extraction

These have been configured to bundle in `extraResources` for production builds.

## Quick Start

### 1. Prepare FFmpeg Binary

#### macOS
```bash
# Download static FFmpeg from https://evermeet.cx/ffmpeg/
# Or copy your current system FFmpeg (development only):
cp $(which ffmpeg) resources/bin/mac/
chmod +x resources/bin/mac/ffmpeg
```

#### Windows
Download from https://www.gyan.dev/ffmpeg/builds/
- Get the "essentials" build
- Extract `ffmpeg.exe` to `resources/bin/win/`

#### Linux
Download from https://johnvansickle.com/ffmpeg/
- Get static build
- Extract to `resources/bin/linux/ffmpeg`

### 2. Bundle Python (Optional - Development)

For development, the app will use your existing `python/venv`:
```bash
npm run setup:python
```

### 3. Bundle Python (Production - Recommended)

For production builds, use standalone Python:

#### Download Standalone Python

Visit: https://github.com/indygreg/python-build-standalone/releases

Download for your platform:
- **macOS (Intel)**: `cpython-3.11.*-x86_64-apple-darwin-install_only.tar.gz`
- **macOS (ARM)**: `cpython-3.11.*-aarch64-apple-darwin-install_only.tar.gz`
- **Windows**: `cpython-3.11.*-x86_64-pc-windows-msvc-shared-install_only.tar.gz`
- **Linux**: `cpython-3.11.*-x86_64-unknown-linux-gnu-install_only.tar.gz`

#### Extract and Install Dependencies

**macOS/Linux:**
```bash
# Extract to resources directory
mkdir -p resources/python/mac
tar -xzf cpython-*.tar.gz -C resources/python/mac --strip-components=1

# Install Python dependencies
resources/python/mac/bin/python3 -m pip install -r python/requirements.txt
```

**Windows:**
```powershell
# Extract to resources\python\win
# Then:
resources\python\win\python.exe -m pip install -r python\requirements.txt
```

### 4. Build and Package

```bash
# Build for current platform
npm run package

# macOS specifically
npm run package:mac
```

## How It Works

### Directory Structure After Setup

```
ContentStudio/
├── resources/
│   ├── bin/
│   │   ├── mac/
│   │   │   └── ffmpeg           # FFmpeg binary for macOS
│   │   ├── win/
│   │   │   └── ffmpeg.exe       # FFmpeg binary for Windows
│   │   └── linux/
│   │       └── ffmpeg           # FFmpeg binary for Linux
│   └── python/
│       ├── mac/
│       │   ├── bin/python3      # Standalone Python for macOS
│       │   └── lib/...          # Python libraries
│       ├── win/
│       │   └── python.exe       # Standalone Python for Windows
│       └── linux/
│           └── bin/python3      # Standalone Python for Linux
└── python/
    ├── venv/                    # Development venv (not bundled)
    ├── core/                    # Python source code (bundled)
    ├── metadata_generator.py
    └── requirements.txt
```

### Runtime Binary Detection

The app detects and uses binaries in this order:

**Python:**
1. Bundled Python (`resources/python/{platform}/bin/python3`)
2. Development venv (`python/venv/bin/python`)
3. System Python (`python3`)

**FFmpeg:**
1. Bundled FFmpeg (`resources/bin/{platform}/ffmpeg`)
2. System FFmpeg (via PATH)

This is handled automatically in `electron/services/python-service.ts`:
- `getBundledPythonPath()` - Returns bundled Python path
- `getBundledFFmpegPath()` - Returns bundled FFmpeg path and adds to PATH

### Electron Builder Configuration

The `package.json` includes:

```json
{
  "build": {
    "extraResources": [
      {
        "from": "python",
        "to": "python",
        "filter": ["**/*", "!**/__pycache__", "!**/.*"]
      },
      {
        "from": "resources/bin",
        "to": "bin",
        "filter": ["**/*"]
      }
    ]
  }
}
```

This copies:
- `python/` → `{app}/Contents/Resources/python/` (Python source code)
- `resources/bin/` → `{app}/Contents/Resources/bin/` (FFmpeg binaries)
- `resources/python/` would go to `{app}/Contents/Resources/python/` if you add it

## Build Sizes

Expected sizes:
- FFmpeg: ~60-120 MB (static build)
- Python + dependencies: ~500 MB - 1 GB
  - Base Python: ~50 MB
  - PyTorch: ~400-500 MB
  - Whisper + other deps: ~50-100 MB

Total app size: ~600 MB - 1.2 GB

## Platform-Specific Notes

### macOS
- FFmpeg from Homebrew is NOT static - use evermeet.cx for distribution
- Code signing may require notarization for FFmpeg/Python binaries
- Universal builds need both x64 and arm64 binaries

### Windows
- Ensure you get the "shared" variant of Python standalone builds
- FFmpeg from gyan.dev is statically linked and portable
- May need to add exclusions for antivirus

### Linux
- Static FFmpeg from johnvansickle.com works on most distros
- AppImage format includes everything in a single file

## Development vs Production

### Development (Current Setup)
- Uses system FFmpeg or Homebrew FFmpeg
- Uses `python/venv` with `npm run setup:python`
- Faster iteration, smaller repo size

### Production (Packaged App)
- Uses bundled FFmpeg from `resources/bin/`
- Uses bundled Python from `resources/python/` (if provided)
- Falls back to venv/system binaries if bundles not found
- Self-contained, works on systems without FFmpeg/Python

## Troubleshooting

### "FFmpeg not found"
- Ensure FFmpeg is in `resources/bin/{platform}/`
- Check it's executable: `chmod +x resources/bin/mac/ffmpeg`
- Check electron-log output for PATH being used

### "Python packages not found"
- Verify packages installed in bundled Python:
  ```bash
  resources/python/mac/bin/python3 -m pip list
  ```
- Reinstall if needed:
  ```bash
  resources/python/mac/bin/python3 -m pip install -r python/requirements.txt
  ```

### "torch/whisper import errors"
- Ensure NumPy < 2.0: `pip install "numpy<2"`
- Check Python version is 3.10+ for torch compatibility

## Testing Bundled Binaries

To test if bundled binaries will work before packaging:

```bash
# Build the app
npm run build:all

# Test manually
node -e "
const path = require('path');
const { app } = require('electron');
console.log('Resources path:', process.resourcesPath);
"
```

Or check the logs after packaging and running the .app/.exe.

## Next Steps

1. ✅ FFmpeg bundled in `resources/bin/`
2. ⚠️ Python bundling setup (optional - using venv for now)
3. 📦 Download standalone Python builds for production
4. 🧪 Test packaged app on clean system
5. 📝 Add code signing configuration
6. 🚀 Set up CI/CD for automated builds

## References

- [python-build-standalone releases](https://github.com/indygreg/python-build-standalone/releases)
- [FFmpeg static builds (macOS)](https://evermeet.cx/ffmpeg/)
- [FFmpeg static builds (Windows)](https://www.gyan.dev/ffmpeg/builds/)
- [FFmpeg static builds (Linux)](https://johnvansickle.com/ffmpeg/)
- [electron-builder extraResources](https://www.electron.build/configuration/contents#extraresources)
