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

# Download FFmpeg
echo -e "${GREEN}[1/2] Downloading FFmpeg...${NC}"
echo "----------------------------------------"
bash scripts/download-ffmpeg.sh "$PLATFORM_BASE"
echo ""

# Download Python for each architecture
echo -e "${GREEN}[2/2] Downloading Python...${NC}"
echo "----------------------------------------"

for arch in "${ARCHITECTURES[@]}"; do
    echo -e "${BLUE}Downloading Python for ${PLATFORM_BASE}-${arch}...${NC}"
    bash scripts/download-python.sh "$PLATFORM_BASE" "$arch"
    echo ""
done

echo ""
echo -e "${GREEN}=======================================${NC}"
echo -e "${GREEN}All binaries downloaded successfully!${NC}"
echo -e "${GREEN}=======================================${NC}"
echo ""
echo -e "${BLUE}Downloaded:${NC}"
echo "  - FFmpeg for $PLATFORM_BASE"
for arch in "${ARCHITECTURES[@]}"; do
    echo "  - Python 3.11 for ${PLATFORM_BASE}-${arch}"
done
echo ""
echo -e "${YELLOW}Next steps:${NC}"
echo "  Run: npm run package:$PLATFORM"
echo ""
