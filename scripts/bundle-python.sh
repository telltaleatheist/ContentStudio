#!/bin/bash
set -e

echo "================================"
echo "Python Bundling Script"
echo "================================"

# Determine platform
if [[ "$OSTYPE" == "darwin"* ]]; then
    PLATFORM="mac"
    PYTHON_EXEC="python3"
elif [[ "$OSTYPE" == "linux-gnu"* ]]; then
    PLATFORM="linux"
    PYTHON_EXEC="python3"
elif [[ "$OSTYPE" == "msys" || "$OSTYPE" == "win32" ]]; then
    PLATFORM="win"
    PYTHON_EXEC="python"
else
    echo "Unsupported platform: $OSTYPE"
    exit 1
fi

echo "Platform: $PLATFORM"

# Create resources directory
BUNDLE_DIR="resources/python/$PLATFORM"
mkdir -p "$BUNDLE_DIR"

# Check if we should use the existing venv or create a new one
if [ -d "python/venv" ]; then
    echo "Using existing Python venv..."
    PYTHON_PATH="python/venv/bin/python"
else
    echo "Creating new Python venv..."
    cd python
    $PYTHON_EXEC -m venv venv
    source venv/bin/activate
    pip install --upgrade pip
    pip install -r requirements.txt
    deactivate
    cd ..
    PYTHON_PATH="python/venv/bin/python"
fi

# Verify Python and packages
echo "Verifying Python installation..."
$PYTHON_PATH --version

echo "Checking installed packages..."
$PYTHON_PATH -m pip list | grep -E "(whisper|torch|openai|anthropic)" || true

# For now, we'll use a symlink approach for development
# In production, you'd want to use python-build-standalone or similar
echo ""
echo "================================"
echo "Python venv is ready at: python/venv"
echo "================================"
echo ""
echo "For production builds, consider using python-build-standalone:"
echo "https://github.com/indygreg/python-build-standalone/releases"
echo ""
echo "Download a standalone Python build and extract to:"
echo "  resources/python/mac/    (for macOS)"
echo "  resources/python/win/    (for Windows)"
echo "  resources/python/linux/  (for Linux)"
echo ""
echo "Then install requirements into the standalone Python:"
echo "  resources/python/mac/bin/python3 -m pip install -r python/requirements.txt"
echo ""
