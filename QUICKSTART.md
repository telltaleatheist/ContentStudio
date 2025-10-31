# LaunchPad Quick Start Guide

Get up and running with LaunchPad in 5 minutes!

## 1. Install Prerequisites

### Install Ollama (Recommended)
```bash
# Download from https://ollama.ai or use:
brew install ollama  # macOS

# Pull the AI model
ollama pull cogito:70b
```

### Install FFmpeg
```bash
brew install ffmpeg  # macOS
```

## 2. Set Up LaunchPad

```bash
# Navigate to project
cd /Volumes/Callisto/Projects/LaunchPad

# Install dependencies
npm install

# Set up Python environment
npm run setup:python
```

## 3. Run the App

```bash
# Development mode
npm run electron:dev

# Or build and run
npm run electron
```

## 4. First Use

1. **Configure Settings** (⚙️ icon)
   - AI Provider: Ollama (default)
   - Model: cogito:70b
   - Set output directory (optional)

2. **Add Content**
   - Click "Text Subject" and enter: `elon musk twitter controversy`
   - Or add a video file from your computer

3. **Generate Metadata**
   - Select Platform: YouTube
   - Select Mode: Individual
   - Click "Generate Metadata"

4. **Use Results**
   - Click any generated item to copy to clipboard
   - Files saved to: `~/Documents/LaunchPad Output`

## Common Issues

**"Python service not initialized"**
```bash
npm run setup:python
```

**"Cannot connect to Ollama"**
```bash
ollama serve
ollama pull cogito:70b
```

**"FFmpeg not found"**
```bash
brew install ffmpeg
```

## Package for Distribution

```bash
# Build distributable app
npm run package:mac   # Creates .dmg file
```

That's it! You're ready to generate metadata! 🚀
