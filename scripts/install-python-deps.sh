#!/bin/bash
set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

echo "================================"
echo "Python Dependencies Installer"
echo "================================"

PLATFORM_ARCH=$1

if [ -z "$PLATFORM_ARCH" ]; then
    echo -e "${RED}Error: Platform-architecture argument required${NC}"
    echo "Usage: $0 [mac-arm64|mac-x64|win-x64|linux-x64]"
    exit 1
fi

PYTHON_DIR="resources/python/$PLATFORM_ARCH"

if [ ! -d "$PYTHON_DIR" ]; then
    echo -e "${RED}Error: Python directory not found: $PYTHON_DIR${NC}"
    echo "Run download-python.sh first"
    exit 1
fi

# Determine Python executable
if [[ "$PLATFORM_ARCH" == win-* ]]; then
    PYTHON_EXEC="$PYTHON_DIR/python.exe"
else
    PYTHON_EXEC="$PYTHON_DIR/bin/python3"
fi

if [ ! -f "$PYTHON_EXEC" ]; then
    echo -e "${RED}Error: Python executable not found: $PYTHON_EXEC${NC}"
    exit 1
fi

echo -e "${GREEN}Found Python: $PYTHON_EXEC${NC}"

# Verify Python works
echo -e "${BLUE}Verifying Python installation...${NC}"
"$PYTHON_EXEC" --version || {
    echo -e "${RED}Python verification failed${NC}"
    exit 1
}

echo ""
echo -e "${BLUE}Installing pip dependencies...${NC}"

# Upgrade pip first
echo -e "${YELLOW}Upgrading pip...${NC}"
"$PYTHON_EXEC" -m pip install --upgrade pip

# Install NumPy < 2 first (required for torch compatibility)
echo -e "${YELLOW}Installing NumPy < 2.0...${NC}"
"$PYTHON_EXEC" -m pip install "numpy<2"

# Install requirements
echo -e "${YELLOW}Installing requirements from python/requirements.txt...${NC}"
"$PYTHON_EXEC" -m pip install -r python/requirements.txt

echo ""
echo -e "${BLUE}Verifying installations...${NC}"

# Verify key packages
PACKAGES=("whisper" "torch" "openai" "anthropic")
for pkg in "${PACKAGES[@]}"; do
    if "$PYTHON_EXEC" -c "import $pkg" 2>/dev/null; then
        echo -e "${GREEN}✓ $pkg${NC}"
    else
        echo -e "${RED}✗ $pkg (import failed)${NC}"
    fi
done

echo ""
echo -e "${GREEN}================================${NC}"
echo -e "${GREEN}Dependencies installed!${NC}"
echo -e "${GREEN}================================${NC}"

# Show installed packages
echo ""
echo -e "${BLUE}Installed packages:${NC}"
"$PYTHON_EXEC" -m pip list
