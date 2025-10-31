#!/bin/bash

# LaunchPad Setup Script
# Automates initial setup for the LaunchPad application

set -e

echo "🚀 LaunchPad Setup"
echo "=================="
echo ""

# Color codes
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
RED='\033[0;31m'
NC='\033[0m' # No Color

# Check prerequisites
echo "📋 Checking prerequisites..."

# Check Node.js
if ! command -v node &> /dev/null; then
    echo -e "${RED}❌ Node.js is not installed${NC}"
    echo "Please install Node.js 18+ from https://nodejs.org"
    exit 1
else
    NODE_VERSION=$(node -v)
    echo -e "${GREEN}✓${NC} Node.js $NODE_VERSION"
fi

# Check npm
if ! command -v npm &> /dev/null; then
    echo -e "${RED}❌ npm is not installed${NC}"
    exit 1
else
    NPM_VERSION=$(npm -v)
    echo -e "${GREEN}✓${NC} npm $NPM_VERSION"
fi

# Check Python
if ! command -v python3 &> /dev/null; then
    echo -e "${RED}❌ Python 3 is not installed${NC}"
    echo "Please install Python 3.9+ from https://python.org"
    exit 1
else
    PYTHON_VERSION=$(python3 --version)
    echo -e "${GREEN}✓${NC} $PYTHON_VERSION"
fi

# Check FFmpeg
if ! command -v ffmpeg &> /dev/null; then
    echo -e "${YELLOW}⚠️  FFmpeg is not installed${NC}"
    echo "   Install with: brew install ffmpeg (macOS)"
    echo "   FFmpeg is required for video transcription"
else
    FFMPEG_VERSION=$(ffmpeg -version | head -n1)
    echo -e "${GREEN}✓${NC} FFmpeg installed"
fi

# Check Ollama
if ! command -v ollama &> /dev/null; then
    echo -e "${YELLOW}⚠️  Ollama is not installed (recommended)${NC}"
    echo "   Download from: https://ollama.ai"
    echo "   Then run: ollama pull cogito:70b"
else
    echo -e "${GREEN}✓${NC} Ollama installed"

    # Check if cogito:70b is available
    if ollama list | grep -q "cogito:70b"; then
        echo -e "${GREEN}✓${NC} cogito:70b model available"
    else
        echo -e "${YELLOW}⚠️  cogito:70b model not found${NC}"
        echo "   Run: ollama pull cogito:70b"
    fi
fi

echo ""
echo "📦 Installing dependencies..."

# Install Node dependencies
echo "Installing Node.js dependencies..."
npm install

echo ""
echo "🐍 Setting up Python environment..."

# Navigate to Python directory
cd python

# Create virtual environment
if [ ! -d "venv" ]; then
    echo "Creating Python virtual environment..."
    python3 -m venv venv
else
    echo "Virtual environment already exists"
fi

# Activate virtual environment and install dependencies
echo "Installing Python dependencies..."
source venv/bin/activate
pip install --upgrade pip
pip install -r requirements.txt

# Go back to root
cd ..

echo ""
echo -e "${GREEN}✅ Setup complete!${NC}"
echo ""
echo "Next steps:"
echo "1. Start Ollama (if not running): ollama serve"
echo "2. Pull AI model (if not done): ollama pull cogito:70b"
echo "3. Run LaunchPad: npm run electron:dev"
echo ""
echo "For more information, see README.md"
