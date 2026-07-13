#!/usr/bin/env node
const fs = require('fs');
const path = require('path');

const BLUE = '\x1b[34m';
const GREEN = '\x1b[32m';
const YELLOW = '\x1b[33m';
const RED = '\x1b[31m';
const NC = '\x1b[0m';

// Anchor everything to the project root (parent of scripts/) so the script
// works regardless of the current working directory.
const ROOT = path.join(__dirname, '..');

/**
 * Resolve the staging target.
 * Priority: explicit CLI arg > TARGET_PLATFORM env > the build machine's platform.
 * Returns one of: 'mac' | 'mac-arm64' | 'mac-x64' | 'win' | 'linux'
 */
function resolveTarget() {
  const arg = (process.argv[2] || process.env.TARGET_PLATFORM || '').toLowerCase();
  if (arg) {
    if (arg === 'mac-arm64') return 'mac-arm64';
    if (arg === 'mac-x64' || arg === 'mac-intel') return 'mac-x64';
    if (arg.startsWith('mac')) return 'mac';
    if (arg.startsWith('win')) return 'win';
    if (arg.startsWith('linux')) return 'linux';
  }
  if (process.platform === 'darwin') return 'mac';
  if (process.platform === 'win32') return 'win';
  return 'linux';
}

const target = resolveTarget();

// Which platform binaries (ffmpeg/ffprobe) are REQUIRED for this target.
// A missing required binary hard-fails the run so packaging cannot ship a
// broken installer. Cross-platform copies are best-effort (warn only).
const requiredPlatforms = new Set();
if (target === 'mac') {
  requiredPlatforms.add('darwin-arm64');
  requiredPlatforms.add('darwin-x64');
} else if (target === 'mac-arm64') {
  requiredPlatforms.add('darwin-arm64');
} else if (target === 'mac-x64') {
  requiredPlatforms.add('darwin-x64');
} else if (target === 'win') {
  requiredPlatforms.add('win32');
}
// 'linux' stages nothing via this script (no bundled ffmpeg installer for linux).

console.log(`${BLUE}Copying binaries from node_modules to utilities/bin (target: ${target})...${NC}\n`);

// Create platform-specific directories
['utilities/bin/darwin-arm64', 'utilities/bin/darwin-x64', 'utilities/bin/win32'].forEach(dir => {
  const full = path.join(ROOT, dir);
  if (!fs.existsSync(full)) {
    fs.mkdirSync(full, { recursive: true });
  }
});

const missingRequired = [];

/**
 * Copy an ffmpeg/ffprobe binary. `platform` identifies which platform bucket
 * this binary belongs to; if that platform is required for the target and the
 * source is missing, it is recorded as a hard failure.
 */
function copyBinary(src, dest, description, platform) {
  const srcFull = path.join(ROOT, src);
  const destFull = path.join(ROOT, dest);
  if (fs.existsSync(srcFull)) {
    console.log(`Copying ${description}...`);
    fs.copyFileSync(srcFull, destFull);
    return true;
  }
  if (platform && requiredPlatforms.has(platform)) {
    console.error(`${RED}ERROR: required binary missing: ${description} (${src})${NC}`);
    missingRequired.push(`${description} (expected at ${src})`);
  } else {
    console.warn(`${YELLOW}  (skip) ${description} not found, optional for target "${target}": ${src}${NC}`);
  }
  return false;
}

/**
 * Copy an optional artifact (whisper binaries / dylibs). These are staged by
 * the download step and may legitimately be absent when copy:ffmpeg runs on
 * its own, so a miss is a warning, never a failure.
 */
function copyOptional(src, dest, description) {
  const srcFull = path.join(ROOT, src);
  const destFull = path.join(ROOT, dest);
  if (fs.existsSync(srcFull)) {
    console.log(`Copying ${description}...`);
    fs.copyFileSync(srcFull, destFull);
    return true;
  }
  return false;
}

const binDir = path.join(ROOT, 'utilities/bin');

// --- macOS ARM64 --------------------------------------------------------
copyBinary(
  'node_modules/@ffmpeg-installer/darwin-arm64/ffmpeg',
  'utilities/bin/darwin-arm64/ffmpeg',
  'FFmpeg (macOS ARM64)',
  'darwin-arm64'
);
copyBinary(
  'node_modules/@ffprobe-installer/darwin-arm64/ffprobe',
  'utilities/bin/darwin-arm64/ffprobe',
  'FFprobe (macOS ARM64)',
  'darwin-arm64'
);
copyOptional(
  'utilities/bin/whisper-cli-arm64',
  'utilities/bin/darwin-arm64/whisper-cli-arm64',
  'Whisper (macOS ARM64)'
);
if (fs.existsSync(binDir)) {
  fs.readdirSync(binDir).forEach(file => {
    if (file.endsWith('-arm64.dylib')) {
      copyOptional(
        path.join('utilities/bin', file),
        path.join('utilities/bin/darwin-arm64', file),
        file
      );
    }
  });
}

// --- macOS x64 ----------------------------------------------------------
copyBinary(
  'node_modules/@ffmpeg-installer/darwin-x64/ffmpeg',
  'utilities/bin/darwin-x64/ffmpeg',
  'FFmpeg (macOS x64)',
  'darwin-x64'
);
copyBinary(
  'node_modules/@ffprobe-installer/darwin-x64/ffprobe',
  'utilities/bin/darwin-x64/ffprobe',
  'FFprobe (macOS x64)',
  'darwin-x64'
);
copyOptional(
  'utilities/bin/whisper-cli-x64',
  'utilities/bin/darwin-x64/whisper-cli-x64',
  'Whisper (macOS x64)'
);
if (fs.existsSync(binDir)) {
  fs.readdirSync(binDir).forEach(file => {
    if (file.endsWith('-x64.dylib')) {
      copyOptional(
        path.join('utilities/bin', file),
        path.join('utilities/bin/darwin-x64', file),
        file
      );
    }
  });
}

// --- Windows x64 --------------------------------------------------------
copyBinary(
  'node_modules/@ffmpeg-installer/win32-x64/ffmpeg.exe',
  'utilities/bin/win32/ffmpeg.exe',
  'FFmpeg (Windows x64)',
  'win32'
);
copyBinary(
  'node_modules/@ffprobe-installer/win32-x64/ffprobe.exe',
  'utilities/bin/win32/ffprobe.exe',
  'FFprobe (Windows x64)',
  'win32'
);

// --- Result -------------------------------------------------------------
if (missingRequired.length > 0) {
  console.error(
    `\n${RED}FAILED: ${missingRequired.length} required binary/binaries missing for target "${target}":${NC}`
  );
  missingRequired.forEach(m => console.error(`${RED}  - ${m}${NC}`));
  console.error(
    `${RED}Refusing to continue — packaging would ship an installer without ffmpeg/ffprobe.${NC}\n`
  );
  process.exit(1);
}

console.log(`\n${GREEN}All required binaries copied successfully! (target: ${target})${NC}\n`);
