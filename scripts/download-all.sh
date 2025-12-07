#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "========================================"
echo "ContentStudio Binary Download Script"
echo "========================================"
echo ""

PLATFORM=$1
ARCH=$2

if [ -z "$PLATFORM" ]; then
    echo -e "${RED}Error: Platform argument required${NC}"
    echo ""
    echo "Usage: $0 [mac|mac-arm64|mac-x64|win|linux] [arch]"
    echo ""
    echo "Examples:"
    echo "  $0 mac          # Universal macOS (downloads both architectures)"
    echo "  $0 mac-arm64    # macOS Apple Silicon only"
    echo "  $0 mac-x64      # macOS Intel only"
    echo "  $0 win          # Windows x64"
    echo "  $0 linux        # Linux x64"
    echo ""
    exit 1
fi

# Parse platform and architecture
case $PLATFORM in
    mac)
        # Universal build - download both architectures
        PLATFORM_BASE="mac"
        ARCHITECTURES=("arm64" "x64")
        ;;
    mac-arm64)
        PLATFORM_BASE="mac"
        ARCHITECTURES=("arm64")
        ;;
    mac-x64|mac-intel)
        PLATFORM_BASE="mac"
        ARCHITECTURES=("x64")
        ;;
    win|win-x64|windows)
        PLATFORM_BASE="win"
        ARCHITECTURES=("x64")
        ;;
    linux|linux-x64)
        PLATFORM_BASE="linux"
        ARCHITECTURES=("x64")
        ;;
    *)
        echo -e "${RED}Unknown platform: $PLATFORM${NC}"
        exit 1
        ;;
esac

echo -e "${BLUE}Target Platform: $PLATFORM_BASE${NC}"
echo -e "${BLUE}Architectures: ${ARCHITECTURES[*]}${NC}"
echo ""

# FFmpeg is now handled by npm packages (@ffmpeg-installer/ffmpeg)
# No manual download needed

# Download whisper.cpp
echo -e "${GREEN}[1/1] Downloading whisper.cpp...${NC}"
echo "----------------------------------------"
node scripts/download-whisper-cpp.js
echo ""

echo ""
echo -e "${GREEN}=======================================${NC}"
echo -e "${GREEN}All binaries downloaded successfully!${NC}"
echo -e "${GREEN}=======================================${NC}"
echo ""
echo -e "${BLUE}Downloaded:${NC}"
echo "  - whisper.cpp (all architectures)"
echo ""
echo -e "${BLUE}Note:${NC} FFmpeg is handled by npm packages (@ffmpeg-installer)"
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  Run: npm run package:$PLATFORM"
echo ""
