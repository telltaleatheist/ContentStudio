# Build Scripts Directory

Helper scripts for downloading and bundling binaries.

## Scripts

### `download-ffmpeg.sh`
Downloads FFmpeg static binary for a platform.

```bash
bash scripts/download-ffmpeg.sh [mac|win|linux]
```

**What it does:**
- macOS: Copies from system FFmpeg or prompts for manual download
- Windows: Prompts for manual download from gyan.dev
- Linux: Auto-downloads static build from johnvansickle.com

**Output:** `resources/bin/{platform}/ffmpeg`

### `download-python.sh`
Downloads Python standalone build for a platform and architecture.

```bash
bash scripts/download-python.sh [mac|win|linux] [arm64|x64]
```

**What it does:**
- Downloads from python-build-standalone GitHub releases
- Extracts to `resources/python/{platform}-{arch}/`
- Calls `install-python-deps.sh` to install requirements

**Output:** `resources/python/{platform}-{arch}/`

### `install-python-deps.sh`
Installs Python requirements into a bundled Python.

```bash
bash scripts/install-python-deps.sh [platform-arch]
```

**Example:** `bash scripts/install-python-deps.sh mac-arm64`

**What it does:**
- Locates Python executable in `resources/python/{platform-arch}/`
- Upgrades pip
- Installs `numpy<2` (for torch compatibility)
- Installs all packages from `python/requirements.txt`
- Verifies key packages (whisper, torch, openai, anthropic)

### `download-all.sh`
Downloads all binaries for a platform in one command.

```bash
bash scripts/download-all.sh [mac|mac-arm64|mac-x64|win|linux]
```

**What it does:**
- Calls `download-ffmpeg.sh` for the platform
- Calls `download-python.sh` for each required architecture
- Shows summary of what was downloaded

**Examples:**
```bash
# Universal macOS (both architectures)
bash scripts/download-all.sh mac

# Apple Silicon only
bash scripts/download-all.sh mac-arm64

# Windows
bash scripts/download-all.sh win
```

### `bundle-python.sh` (Legacy)
Old script for setting up development Python venv. Still works but not used for production builds.

---

## Usage via NPM

Instead of calling scripts directly, use the npm commands:

```bash
# Download FFmpeg
npm run download:ffmpeg:mac

# Download Python
npm run download:python:mac-arm64

# Download everything
npm run download:all:mac-arm64

# Download and package
npm run clean:package:mac-arm64
```

See `BUILD-SCRIPTS.md` for complete reference.

---

## Troubleshooting

### Permission denied
Make scripts executable:
```bash
chmod +x scripts/*.sh
```

### Download fails
Check internet connection and retry. For manual downloads:
- FFmpeg macOS: https://evermeet.cx/ffmpeg/
- FFmpeg Windows: https://www.gyan.dev/ffmpeg/builds/
- FFmpeg Linux: https://johnvansickle.com/ffmpeg/
- Python: https://github.com/indygreg/python-build-standalone/releases

### Python deps install fails
Verify Python was downloaded correctly:
```bash
ls resources/python/mac-arm64/bin/python3
resources/python/mac-arm64/bin/python3 --version
```

Then retry:
```bash
bash scripts/install-python-deps.sh mac-arm64
```

---

## Technical Details

### Python Version
Scripts download Python 3.11.9 by default. Update `PYTHON_VERSION` in `download-python.sh` to change.

### Python Source
Downloads from https://github.com/indygreg/python-build-standalone/releases/download/20240726/

### FFmpeg Sources
- macOS: https://evermeet.cx/ffmpeg/ (manual) or system copy
- Windows: https://www.gyan.dev/ffmpeg/builds/ (manual)
- Linux: https://johnvansickle.com/ffmpeg/releases/ (auto-download)

### Requirements
- `curl` or `wget` (for downloads)
- `tar` (for extraction)
- Bash 4.0+ (for array support)
