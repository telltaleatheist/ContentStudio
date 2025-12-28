#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const NC = '\x1b[0m';

console.log(`${BLUE}Copying binaries from node_modules to utilities/bin...${NC}\n`);

// Create platform-specific directories
const dirs = [
    'utilities/bin/darwin-arm64',
    'utilities/bin/darwin-x64',
    'utilities/bin/win32'
];

dirs.forEach(dir => {
    if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
    }
});

function copyIfExists(src, dest, description) {
    if (fs.existsSync(src)) {
        console.log(`Copying ${description}...`);
        fs.copyFileSync(src, dest);
        return true;
    }
    return false;
}

// Copy macOS ARM64 binaries
copyIfExists(
    'node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg',
    'utilities/bin/darwin-arm64/ffmpeg',
    'FFmpeg (macOS ARM64)'
);

copyIfExists(
    'node_modules/@ffprobe-installer/darwin-arm64/ffprobe',
    'utilities/bin/darwin-arm64/ffprobe',
    'FFprobe (macOS ARM64)'
);

// Copy Whisper binaries for ARM64
copyIfExists(
    'utilities/bin/whisper-cli-arm64',
    'utilities/bin/darwin-arm64/whisper-cli-arm64',
    'Whisper (macOS ARM64)'
);

// Copy ARM64 dylibs
const binDir = 'utilities/bin';
if (fs.existsSync(binDir)) {
    fs.readdirSync(binDir).forEach(file => {
        if (file.endsWith('-arm64.dylib')) {
            copyIfExists(
                path.join(binDir, file),
                path.join('utilities/bin/darwin-arm64', file),
                file
            );
        }
    });
}

// Copy macOS x64 binaries
copyIfExists(
    'node_modules/@ffmpeg-installer/darwin-x64/ffmpeg',
    'utilities/bin/darwin-x64/ffmpeg',
    'FFmpeg (macOS x64)'
);

copyIfExists(
    'node_modules/@ffprobe-installer/darwin-x64/ffprobe',
    'utilities/bin/darwin-x64/ffprobe',
    'FFprobe (macOS x64)'
);

// Copy Whisper binaries for x64
copyIfExists(
    'utilities/bin/whisper-cli-x64',
    'utilities/bin/darwin-x64/whisper-cli-x64',
    'Whisper (macOS x64)'
);

// Copy x64 dylibs
if (fs.existsSync(binDir)) {
    fs.readdirSync(binDir).forEach(file => {
        if (file.endsWith('-x64.dylib')) {
            copyIfExists(
                path.join(binDir, file),
                path.join('utilities/bin/darwin-x64', file),
                file
            );
        }
    });
}

// Copy Windows binaries
copyIfExists(
    'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe',
    'utilities/bin/win32/ffmpeg.exe',
    'FFmpeg (Windows x64)'
);

copyIfExists(
    'node_modules/@ffprobe-installer/win32-x64/ffprobe.exe',
    'utilities/bin/win32/ffprobe.exe',
    'FFprobe (Windows x64)'
);

console.log(`\n${GREEN}All binaries copied successfully!${NC}\n`);
