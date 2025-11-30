#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "================================"
echo "Python Standalone Download Script"
echo "================================"

# Parse platform and architecture arguments
PLATFORM=$1
ARCH=$2

if [ -z "$PLATFORM" ]; then
    echo -e "${RED}Error: Platform argument required${NC}"
    echo "Usage: $0 [mac|win|linux] [arm64|x64]"
    exit 1
fi

# Set architecture defaults
if [ -z "$ARCH" ]; then
    case $PLATFORM in
        mac|darwin)
            # Default to current architecture on macOS
            if [[ $(uname -m) == "arm64" ]]; then
                ARCH="arm64"
            else
                ARCH="x64"
            fi
            ;;
        win|windows|linux)
            ARCH="x64"
            ;;
    esac
fi

echo -e "${BLUE}Platform: $PLATFORM${NC}"
echo -e "${BLUE}Architecture: $ARCH${NC}"
echo ""

# Python version to download
PYTHON_VERSION="3.11.9"

# Construct platform-specific details
case $PLATFORM in
    mac|darwin)
        PLATFORM_NAME="mac"
        if [ "$ARCH" == "arm64" ]; then
            PYTHON_BUILD="cpython-${PYTHON_VERSION}+20240726-aarch64-apple-darwin-install_only.tar.gz"
        else
            PYTHON_BUILD="cpython-${PYTHON_VERSION}+20240726-x86_64-apple-darwin-install_only.tar.gz"
        fi
        PYTHON_DIR="resources/python/$PLATFORM_NAME-$ARCH"
        ;;

    win|windows)
        PLATFORM_NAME="win"
        PYTHON_BUILD="cpython-${PYTHON_VERSION}+20240726-x86_64-pc-windows-msvc-shared-install_only.tar.gz"
        PYTHON_DIR="resources/python/$PLATFORM_NAME-$ARCH"
        ;;

    linux)
        PLATFORM_NAME="linux"
        PYTHON_BUILD="cpython-${PYTHON_VERSION}+20240726-x86_64-unknown-linux-gnu-install_only.tar.gz"
        PYTHON_DIR="resources/python/$PLATFORM_NAME-$ARCH"
        ;;

    *)
        echo -e "${RED}Unknown platform: $PLATFORM${NC}"
        echo "Supported platforms: mac, win, linux"
        exit 1
        ;;
esac

mkdir -p "$PYTHON_DIR"

# Check if already exists
if [ -d "$PYTHON_DIR/bin" ] || [ -d "$PYTHON_DIR/python.exe" ]; then
    echo -e "${YELLOW}Python already exists at $PYTHON_DIR${NC}"
    read -p "Overwrite? (y/n) " -n 1 -r
    echo
    if [[ ! $REPLY =~ ^[Yy]$ ]]; then
        echo "Skipping download"

        # Still try to install requirements
        echo -e "${BLUE}Installing Python requirements...${NC}"
        bash scripts/install-python-deps.sh "$PLATFORM_NAME-$ARCH"
        exit 0
    fi
    rm -rf "$PYTHON_DIR"/*
fi

echo -e "${GREEN}Downloading Python ${PYTHON_VERSION} for ${PLATFORM_NAME}-${ARCH}...${NC}"

DOWNLOAD_URL="https://github.com/indygreg/python-build-standalone/releases/download/20240726/${PYTHON_BUILD}"

# Download
echo -e "${BLUE}Downloading from: $DOWNLOAD_URL${NC}"

if command -v curl &> /dev/null; then
    curl -L -o "/tmp/$PYTHON_BUILD" "$DOWNLOAD_URL" || {
        echo -e "${RED}Download failed${NC}"
        exit 1
    }
elif command -v wget &> /dev/null; then
    wget -O "/tmp/$PYTHON_BUILD" "$DOWNLOAD_URL" || {
        echo -e "${RED}Download failed${NC}"
        exit 1
    }
else
    echo -e "${RED}Neither curl nor wget found${NC}"
    echo "Please install curl or wget to download Python"
    exit 1
fi

# Extract
echo -e "${BLUE}Extracting Python to $PYTHON_DIR...${NC}"
tar -xzf "/tmp/$PYTHON_BUILD" -C "$PYTHON_DIR" --strip-components=1

# Cleanup
rm "/tmp/$PYTHON_BUILD"

echo -e "${GREEN}✓ Python extracted successfully${NC}"

# Install requirements
echo ""
echo -e "${BLUE}Installing Python requirements...${NC}"
bash scripts/install-python-deps.sh "$PLATFORM_NAME-$ARCH"

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}Python setup complete!${NC}"
echo -e "${GREEN}Location: $PYTHON_DIR${NC}"
echo -e "${GREEN}================================${NC}"
