#!/bin/bash
set -e

# Colors for output
GREEN='\033[0;32m'
BLUE='\033[0;34m'
NC='\033[0m'

echo -e "${BLUE}Copying binaries from node_modules to utilities/bin...${NC}"
echo ""

# Create platform-specific directories
mkdir -p utilities/bin/darwin-arm64
mkdir -p utilities/bin/darwin-x64
mkdir -p utilities/bin/win32

# Copy macOS ARM64 binaries
if [ -f "node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg" ]; then
    echo "Copying FFmpeg (macOS ARM64)..."
    cp node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg utilities/bin/darwin-arm64/
    chmod +x utilities/bin/darwin-arm64/ffmpeg
fi

if [ -f "node_modules/@ffprobe-installer/darwin-arm64/ffprobe" ]; then
    echo "Copying FFprobe (macOS ARM64)..."
    cp node_modules/@ffprobe-installer/darwin-arm64/ffprobe utilities/bin/darwin-arm64/
    chmod +x utilities/bin/darwin-arm64/ffprobe
fi

# Copy macOS x64 binaries
if [ -f "node_modules/@ffmpeg-installer/darwin-x64/ffmpeg" ]; then
    echo "Copying FFmpeg (macOS x64)..."
    cp node_modules/@ffmpeg-installer/darwin-x64/ffmpeg utilities/bin/darwin-x64/
    chmod +x utilities/bin/darwin-x64/ffmpeg
fi

if [ -f "node_modules/@ffprobe-installer/darwin-x64/ffprobe" ]; then
    echo "Copying FFprobe (macOS x64)..."
    cp node_modules/@ffprobe-installer/darwin-x64/ffprobe utilities/bin/darwin-x64/
    chmod +x utilities/bin/darwin-x64/ffprobe
fi

# Copy Windows binaries if they exist
if [ -f "node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe" ]; then
    echo "Copying FFmpeg (Windows x64)..."
    cp node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe utilities/bin/win32/
fi

if [ -f "node_modules/@ffprobe-installer/win32-x64/ffprobe.exe" ]; then
    echo "Copying FFprobe (Windows x64)..."
    cp node_modules/@ffprobe-installer/win32-x64/ffprobe.exe utilities/bin/win32/
fi

echo ""
echo -e "${GREEN}All binaries copied successfully!${NC}"
echo ""
