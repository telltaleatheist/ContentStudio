/**
 * Runtime path resolution for bundled binaries
 * Central source of truth for all binary locations
 */

import * as path from 'path';
import * as fs from 'fs';
import { expectedEntry, resolveEntry } from '../../components/component-manager';

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
 * The speaker-embedding graph, by name.
 *
 * NeMo TitaNet-small, from the sherpa-onnx speaker-recognition release. It is the model
 * speaker tagging is calibrated against — see the model comparison in
 * services/metadata/speaker-embedding.ts, which measured three alternatives that do not
 * separate this material at all. The filename is here rather than in the tagger because it is
 * the same kind of fact as ffmpeg's entry path: what the installer put on disk.
 */
const SPEAKER_MODEL_FILE = 'nemo_en_titanet_small.onnx';

/**
 * Runtime paths configuration
 */
export interface RuntimePaths {
  ffmpeg: string;
  ffprobe: string;
  /**
   * The speaker-embedding ONNX file, resolved whether or not it is installed.
   *
   * A PATH, not a promise that the file is there.
   * Speaker tagging is optional, so its consumer checks existence and says what to install;
   * nothing at startup fails over a model an operator may never turn on.
   */
  speakerModel: string;
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

  if (isPackaged()) {
    ffmpegPath = resolveEntry('ffmpeg') || expectedEntry('ffmpeg');
    ffprobePath = ffmpegPath ? path.join(path.dirname(ffmpegPath), `ffprobe${ext}`) : '';
  } else {
    // Development: ffmpeg and ffprobe from their npm packages
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
  }

  // Two-arm resolution, deliberately: installed component when packaged, utilities/models in
  // development.
  const installedSpeakerModel = isPackaged()
    ? (resolveEntry('speaker-embedding') || expectedEntry('speaker-embedding'))
    : null;
  return {
    ffmpeg: ffmpegPath,
    ffprobe: ffprobePath,
    speakerModel: installedSpeakerModel || path.join(resourcesPath, 'utilities', 'models', SPEAKER_MODEL_FILE),
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
      // The `file` check itself failed (not an architecture mismatch). Don't block
      // startup on it, but don't hide it either — a corrupt binary that slips past
      // here fails later at spawn time with a far less clear error.
      console.warn(`[RuntimePaths] Could not verify ${name} binary at ${binaryPath}:`, err?.message || err);
    }
  }
}
