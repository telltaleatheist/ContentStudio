/**
 * Asset catalog — the list of downloadable components and where to get them.
 *
 * Hardcoded (no manifest server): version bumps happen here. After building +
 * uploading an artifact with `scripts/publish-assets.mjs`, paste the printed
 * sha256 + bytes into the matching artifact below.
 *
 * Artifacts are hosted on the project's own GitHub releases under a single tag
 * (RELEASE_TAG). The Python env is app-specific; ffmpeg/ffprobe are generic and
 * land in the cross-app OwenMorgan shared dir, so if another app
 * already downloaded them this app reuses them (see asset-manager).
 */

import type { AssetComponent } from './asset-types';

// Mirrored verbatim from telltaleatheist/autocutstudio's assets-v1 on 2026-08-17 —
// that repo is retired; ContentStudio hosts its own copies now. Same artifacts,
// same sha256s, so machines that already installed from the old release are
// unaffected (identity is the checksum, not the URL).
export const RELEASE_REPO = 'telltaleatheist/ContentStudio';
export const RELEASE_TAG = 'assets-v1';
const BASE = `https://github.com/${RELEASE_REPO}/releases/download/${RELEASE_TAG}`;

const CATALOG: AssetComponent[] = [
  // ── ffmpeg + ffprobe (one archive, two binaries) ───────────────────────────
  {
    id: 'ffmpeg-tools',
    name: 'FFmpeg + FFprobe',
    description: 'Audio/video processing tools required for all editing workflows.',
    category: 'managed-bins',
    required: true,
    version: '7.1.1',
    binaries: ['ffmpeg', 'ffprobe'],
    artifacts: [
      {
        platform: 'darwin',
        arch: 'arm64',
        kind: 'archive',
        url: `${BASE}/ffmpeg-tools-darwin-arm64.tar.gz`,
        sha256: '81a02701d5b71d3c891da9a90e2e813825fb2c0b15d832db0b90b7417bf0bf7e',
        bytes: 31216095,
      },
      {
        platform: 'darwin',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/ffmpeg-tools-darwin-x64.tar.gz`,
        sha256: 'a14905a31eac2de157f65ab8c13da4a949ecca0f08621ed918accb104725a05e',
        bytes: 53479928,
      },
      {
        platform: 'win32',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/ffmpeg-tools-win32-x64.zip`,
        sha256: '',
        bytes: 0,
      },
      {
        platform: 'linux',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/ffmpeg-tools-linux-x64.tar.gz`,
        sha256: '',
        bytes: 0,
      },
    ],
  },

  // ── Python runtime (conda-pack tarball) ────────────────────────────────────
  {
    id: 'python-env',
    name: 'Python runtime',
    description: 'Bundled Python environment with all processing dependencies.',
    category: 'runtime',
    required: true,
    installSubdir: 'autocutstudio-env',
    version: '2026.06.19',
    entry: process.platform === 'win32' ? 'python.exe' : 'bin/python3',
    postInstall: 'conda-unpack',
    artifacts: [
      {
        platform: 'darwin',
        arch: 'arm64',
        kind: 'archive',
        url: `${BASE}/python-env-darwin-arm64.tar.gz`,
        sha256: '5bf73d8a077516e57d75f4e816fc62bb49437042cc3b45ba4997f0ae0ad4c7fb',
        bytes: 236197403,
      },
      {
        platform: 'darwin',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/python-env-darwin-x64.tar.gz`,
        sha256: 'bf2b4fb34c3367a6a74743e3264222a71d6684139623e25333eddc275dcda99c',
        bytes: 163363809,
      },
      {
        platform: 'win32',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/python-env-win32-x64.tar.gz`,
        sha256: '',
        bytes: 0,
      },
      {
        platform: 'linux',
        arch: 'x64',
        kind: 'archive',
        url: `${BASE}/python-env-linux-x64.tar.gz`,
        sha256: '',
        bytes: 0,
      },
    ],
  },

  // voice-separator-env and the whisper.cpp models (whisper-large-v3-turbo, whisper-base) left
  // with P10: voice isolation is Crucible's denoise job (LEDGER #200) and every transcription is
  // Crucible's asr job (#206). An install that still has them on disk loses them once to the
  // retired-component cleanup (electron/retired-components.ts).
];

export function getCatalog(): AssetComponent[] {
  return CATALOG;
}

export function getComponent(id: string): AssetComponent | undefined {
  return CATALOG.find((c) => c.id === id);
}
