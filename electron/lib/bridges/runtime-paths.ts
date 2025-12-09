/**
 * Runtime path resolution for bundled binaries
 * Central source of truth for all binary locations
 */

import * as path from 'path';
import * as fs from 'fs';

// Try to load electron app, but don't fail if not available
let app: any = null;
try {
  app = require('electron').app;
} catch {
  // Electron not available
}

/**
 * Check if running in a packaged Electron app
 */
export function isPackaged(): boolean {
  if (app?.isPackaged !== undefined) {
    return app.isPackaged;
  }

  if (process.env.NODE_ENV === 'production') {
    return true;
  }

  const resourcesPath = (process as any).resourcesPath;
  if (resourcesPath) {
    if (resourcesPath.includes('node_modules/electron') ||
        resourcesPath.includes('node_modules\\electron')) {
      return false;
    }
    return true;
  }

  return false;
}

/**
 * Get the base resources directory
 */
export function getResourcesPath(): string {
  if ((process as any).resourcesPath && isPackaged()) {
    return (process as any).resourcesPath;
  }

  if (app?.getAppPath && isPackaged()) {
    return path.dirname(app.getAppPath());
  }

  // Development: use project root
  if (process.env.CONTENTSTUDIO_PROJECT_ROOT) {
    return process.env.CONTENTSTUDIO_PROJECT_ROOT;
  }

  return process.cwd();
}

/**
 * Get platform folder for npm installer packages
 */
export function getPlatformFolder(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'win32-x64';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
  }
  return 'linux-x64';
}

/**
 * Get platform-specific binary extension
 */
export function getBinaryExtension(): string {
  return process.platform === 'win32' ? '.exe' : '';
}

/**
 * Get whisper binary name for current platform/architecture
 */
function getWhisperBinaryName(): string {
  const platform = process.platform;
  const arch = process.arch;

  if (platform === 'win32') {
    return 'whisper-cli.exe';
  } else if (platform === 'darwin') {
    return arch === 'arm64' ? 'whisper-cli-arm64' : 'whisper-cli-x64';
  }
  return 'whisper-cli';
}

/**
 * Runtime paths configuration
 */
export interface RuntimePaths {
  ffmpeg: string;
  ffprobe: string;
  whisper: string;
  whisperModelsDir: string;
}

/**
 * Get all runtime binary paths
 */
export function getRuntimePaths(): RuntimePaths {
  const resourcesPath = getResourcesPath();
  const platformFolder = getPlatformFolder();
  const ext = getBinaryExtension();

  let ffmpegPath: string;
  let ffprobePath: string;
  let whisperPath: string;

  if (isPackaged()) {
    // Packaged: binaries in resources/utilities/bin/
    ffmpegPath = path.join(resourcesPath, 'utilities', 'bin', `ffmpeg${ext}`);
    ffprobePath = path.join(resourcesPath, 'utilities', 'bin', `ffprobe${ext}`);
    whisperPath = path.join(resourcesPath, 'utilities', 'bin', getWhisperBinaryName());
  } else {
    // Development: ffmpeg from npm package, whisper from utilities/bin
    ffmpegPath = path.join(
      resourcesPath,
      'node_modules',
      '@ffmpeg-installer',
      platformFolder,
      `ffmpeg${ext}`
    );
    ffprobePath = path.join(
      resourcesPath,
      'node_modules',
      '@ffprobe-installer',
      platformFolder,
      `ffprobe${ext}`
    );
    whisperPath = path.join(resourcesPath, 'utilities', 'bin', getWhisperBinaryName());
  }

  return {
    ffmpeg: ffmpegPath,
    ffprobe: ffprobePath,
    whisper: whisperPath,
    whisperModelsDir: path.join(resourcesPath, 'utilities', 'models'),
  };
}

/**
 * Verify a binary exists and optionally check architecture (macOS)
 */
export function verifyBinary(binaryPath: string, name: string): void {
  if (!fs.existsSync(binaryPath)) {
    throw new Error(`${name} binary not found at: ${binaryPath}`);
  }

  // Verify architecture on macOS
  if (process.platform === 'darwin') {
    try {
      const { execSync } = require('child_process');
      const result = execSync(`file "${binaryPath}"`, { encoding: 'utf8' });
      const expectedArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      const hasCorrectArch = result.includes(expectedArch) || result.includes('universal');

      if (!hasCorrectArch) {
        throw new Error(
          `${name} has wrong architecture. Expected: ${expectedArch}, Got: ${result.trim()}`
        );
      }
    } catch (err: any) {
      if (err.message?.includes('wrong architecture')) {
        throw err;
      }
      // Ignore verification errors
    }
  }
}

/**
 * Get DYLD_LIBRARY_PATH for whisper dylibs (macOS)
 */
export function getWhisperLibraryPath(): string | undefined {
  if (process.platform !== 'darwin') {
    return undefined;
  }

  const resourcesPath = getResourcesPath();
  const binDir = isPackaged()
    ? path.join(resourcesPath, 'utilities', 'bin')
    : path.join(resourcesPath, 'utilities', 'bin');

  return binDir;
}
