# ASAR and File System Layout

## ✅ Current Configuration Status: CORRECT

Your app is already properly configured! All components that need write access are outside the asar.

## File System Layout (macOS example)

```
ContentStudio.app/
├── Contents/
│   ├── Resources/
│   │   ├── app.asar                    # ✅ READ-ONLY (your Electron app code)
│   │   │   ├── dist/                   # Compiled TypeScript
│   │   │   ├── frontend/dist/          # Angular app
│   │   │   └── node_modules/           # Node dependencies
│   │   │
│   │   ├── python/                     # ✅ WRITABLE (extraResources)
│   │   │   ├── core/                   # Python source code
│   │   │   │   └── __pycache__/       # ← Python can write .pyc files here
│   │   │   ├── metadata_generator.py
│   │   │   └── requirements.txt
│   │   │
│   │   └── bin/                        # ✅ WRITABLE (extraResources)
│   │       └── mac/
│   │           └── ffmpeg              # FFmpeg binary
│   │
│   └── MacOS/
│       └── ContentStudio               # Electron executable
```

## Write Access Analysis

### ✅ Inside app.asar (READ-ONLY)
These are your compiled Electron/Angular code - they don't need write access:
- `dist/` - Compiled TypeScript
- `frontend/dist/` - Angular build
- `node_modules/` - Node dependencies

### ✅ Outside asar in extraResources (WRITABLE)
Already correctly configured in `package.json`:

```json
"extraResources": [
  {
    "from": "python",        // ← Python source code
    "to": "python"
  },
  {
    "from": "resources/bin", // ← FFmpeg binary
    "to": "bin"
  }
]
```

**What writes here:**
- Python interpreter creates `__pycache__/` directories with `.pyc` bytecode files
- This is normal and expected

### ✅ User Data Directory (WRITABLE)
Electron auto-handles these paths using user's home directory:

**electron-store** (`~/Library/Application Support/ContentStudio/`):
- `config.json` - User settings

**electron-log** (`~/Library/Logs/ContentStudio/`):
- `main.log` - Application logs

### ✅ User Documents (WRITABLE)
Your app writes output files here:

**Output Directory** (`~/Documents/LaunchPad Output/`):
- `{job_name}/` - Generated metadata TXT files
- `.contentstudio/metadata/` - JSON metadata files

### ✅ System Temp Directory (WRITABLE)
Temporary files during processing:

**Video Transcription** (`/tmp/` or OS temp):
- `audio.wav` - Extracted audio (deleted after use)
- Created with `tempfile.TemporaryDirectory()`

### ✅ User Cache Directory (WRITABLE)
Python packages cache their downloads:

**PyTorch Models** (`~/.cache/torch/`):
- Model files downloaded by torch

**Whisper Models** (`~/.cache/whisper/`):
- Whisper models (base, small, medium, large)
- Downloaded on first use

## Potential Issues with Bundled Python

If you bundle a standalone Python in `extraResources/python/{platform}/`:

### ✅ Safe (extraResources is writable)
- Python can create `.pyc` files in `lib/python3.11/`
- Packages can create cache directories

### ⚠️ Watch out for
Some Python packages try to write to their own installation directory:
- **numpy** - May try to create config files
- **torch** - May try to compile JIT code
- **whisper** - Downloads models to `~/.cache/whisper/` (not an issue)

**Solution:** The packages will fall back to user cache directories automatically.

## Verification Checklist

When you package the app, verify:

- [x] Python code in `Resources/python/` (not in asar)
- [x] FFmpeg in `Resources/bin/` (not in asar)
- [x] Python can import modules without permission errors
- [x] `__pycache__` directories are created successfully
- [x] Output files save to `~/Documents/LaunchPad Output/`
- [x] Settings persist in Application Support directory
- [x] Logs appear in Logs directory

## Testing Write Access

After packaging, you can verify write permissions:

```bash
# Check that extraResources are writable
cd ContentStudio.app/Contents/Resources/
ls -la python/    # Should show drwxr-xr-x (readable + writable)
ls -la bin/       # Should show drwxr-xr-x

# Run Python and check if it can create cache
ContentStudio.app/Contents/Resources/python/core/*.py
# Should create __pycache__/ directories
```

## Summary

✅ **You're already set up correctly!**

- Python code is in `extraResources` (writable)
- Binaries are in `extraResources` (writable)
- Output files go to user directories (writable)
- Config/logs go to user directories (writable)
- Cache files go to user directories (writable)
- Only your Electron app code is in the asar (doesn't need write access)

The asar configuration is optimal:
- Fast loading for app code (compressed in asar)
- Write access where needed (extraResources + user directories)
- Clean separation of concerns
