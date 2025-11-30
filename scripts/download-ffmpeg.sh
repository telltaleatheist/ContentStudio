#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
NC='\033[0m' # No Color

echo "================================"
echo "FFmpeg Download Script"
echo "================================"

# Parse platform argument
PLATFORM=$1

if [ -z "$PLATFORM" ]; then
    echo -e "${RED}Error: Platform argument required${NC}"
    echo "Usage: $0 [mac|win|linux]"
    exit 1
fi

case $PLATFORM in
    mac|darwin)
        echo -e "${GREEN}Downloading FFmpeg for macOS...${NC}"

        FFMPEG_DIR="resources/bin/mac"
        mkdir -p "$FFMPEG_DIR"

        # Check if already exists
        if [ -f "$FFMPEG_DIR/ffmpeg" ]; then
            echo -e "${YELLOW}FFmpeg already exists at $FFMPEG_DIR/ffmpeg${NC}"
            read -p "Overwrite? (y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Skipping download"
                exit 0
            fi
        fi

        # Try to copy from system first (for development)
        if command -v ffmpeg &> /dev/null; then
            echo -e "${YELLOW}Found system FFmpeg, copying...${NC}"
            cp "$(which ffmpeg)" "$FFMPEG_DIR/ffmpeg"
            chmod +x "$FFMPEG_DIR/ffmpeg"
            echo -e "${GREEN}✓ FFmpeg copied from system${NC}"
            echo -e "${YELLOW}Note: For production, download static build from https://evermeet.cx/ffmpeg/${NC}"
        else
            echo -e "${RED}FFmpeg not found on system${NC}"
            echo "Please download static FFmpeg manually from:"
            echo "  https://evermeet.cx/ffmpeg/"
            echo "Extract and place in: $FFMPEG_DIR/ffmpeg"
            exit 1
        fi
        ;;

    win|windows)
        echo -e "${GREEN}Downloading FFmpeg for Windows...${NC}"

        FFMPEG_DIR="resources/bin/win"
        mkdir -p "$FFMPEG_DIR"

        if [ -f "$FFMPEG_DIR/ffmpeg.exe" ]; then
            echo -e "${YELLOW}FFmpeg already exists at $FFMPEG_DIR/ffmpeg.exe${NC}"
            read -p "Overwrite? (y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Skipping download"
                exit 0
            fi
        fi

        echo "Please download FFmpeg for Windows manually from:"
        echo "  https://www.gyan.dev/ffmpeg/builds/"
        echo "Download the 'essentials' build and extract ffmpeg.exe to:"
        echo "  $FFMPEG_DIR/ffmpeg.exe"

        # Check if running on Windows (WSL or Git Bash)
        if command -v ffmpeg.exe &> /dev/null; then
            echo -e "${YELLOW}Found ffmpeg.exe on PATH, copying...${NC}"
            cp "$(which ffmpeg.exe)" "$FFMPEG_DIR/ffmpeg.exe"
            echo -e "${GREEN}✓ FFmpeg copied from system${NC}"
        else
            exit 1
        fi
        ;;

    linux)
        echo -e "${GREEN}Downloading FFmpeg for Linux...${NC}"

        FFMPEG_DIR="resources/bin/linux"
        mkdir -p "$FFMPEG_DIR"

        if [ -f "$FFMPEG_DIR/ffmpeg" ]; then
            echo -e "${YELLOW}FFmpeg already exists at $FFMPEG_DIR/ffmpeg${NC}"
            read -p "Overwrite? (y/n) " -n 1 -r
            echo
            if [[ ! $REPLY =~ ^[Yy]$ ]]; then
                echo "Skipping download"
                exit 0
            fi
        fi

        # Try to use wget or curl to download
        FFMPEG_URL="https://johnvansickle.com/ffmpeg/releases/ffmpeg-release-amd64-static.tar.xz"

        if command -v wget &> /dev/null; then
            echo "Downloading with wget..."
            wget -O /tmp/ffmpeg-linux.tar.xz "$FFMPEG_URL"
        elif command -v curl &> /dev/null; then
            echo "Downloading with curl..."
            curl -L -o /tmp/ffmpeg-linux.tar.xz "$FFMPEG_URL"
        else
            echo -e "${RED}Neither wget nor curl found${NC}"
            echo "Please download FFmpeg manually from:"
            echo "  https://johnvansickle.com/ffmpeg/"
            echo "Extract and place in: $FFMPEG_DIR/ffmpeg"
            exit 1
        fi

        # Extract
        echo "Extracting..."
        tar -xf /tmp/ffmpeg-linux.tar.xz -C /tmp/
        EXTRACTED_DIR=$(tar -tf /tmp/ffmpeg-linux.tar.xz | head -1 | cut -f1 -d"/")
        cp "/tmp/$EXTRACTED_DIR/ffmpeg" "$FFMPEG_DIR/ffmpeg"
        chmod +x "$FFMPEG_DIR/ffmpeg"

        # Cleanup
        rm -rf /tmp/ffmpeg-linux.tar.xz "/tmp/$EXTRACTED_DIR"

        echo -e "${GREEN}✓ FFmpeg downloaded and installed${NC}"
        ;;

    *)
        echo -e "${RED}Unknown platform: $PLATFORM${NC}"
        echo "Supported platforms: mac, win, linux"
        exit 1
        ;;
esac

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}FFmpeg setup complete!${NC}"
echo -e "${GREEN}================================${NC}"
