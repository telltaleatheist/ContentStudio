import type { OptionalComponent } from './component-types';

const RELEASE_BASE =
  'https://github.com/telltaleatheist/ContentStudio/releases/download/binaries-v1';
const SHERPA_SPEAKER_MODELS =
  'https://github.com/k2-fsa/sherpa-onnx/releases/download/speaker-recongition-models';

const toolComponents: OptionalComponent[] = [
  {
    id: 'ffmpeg',
    name: 'FFmpeg & FFprobe',
    description: 'Extracts and inspects audio and video. Required for transcription.',
    category: 'tool',
    required: true,
    sizeBytes: 75_000_000,
    entryPath: process.platform === 'win32' ? 'ffmpeg.exe' : 'ffmpeg',
    version: 'binaries-v1',
    artifacts: [
      { platform: 'darwin', arch: 'arm64', kind: 'archive', url: `${RELEASE_BASE}/ffmpeg-tools-darwin-arm64.tar.gz`, sha256: '802d14109e0ac0dc37c06cb9c95db8e0e69c848f9e911b2f6b093c752c09aa84', bytes: 24_148_420, entry: 'ffmpeg' },
      { platform: 'darwin', arch: 'x64', kind: 'archive', url: `${RELEASE_BASE}/ffmpeg-tools-darwin-x64.tar.gz`, sha256: 'aa3f9be5d07e00e95e526af48cc8a41f8deff3bf9ba15b76d23387847a2e61f5', bytes: 47_474_181, entry: 'ffmpeg' },
      { platform: 'win32', arch: 'x64', kind: 'archive', url: `${RELEASE_BASE}/ffmpeg-tools-win32-x64.zip`, sha256: '041a4a887ac47ba9e2713e3b3b48df7041471ade0d31e79daad1be8f7b0dd989', bytes: 51_174_807, entry: 'ffmpeg.exe' },
    ],
  },
  {
    // Speaker tagging's embedding model. OPTIONAL and not `recommended`: it does nothing until
    // the operator also enrolls his voice in Settings, and an app with no enrollment transcribes
    // exactly as it did before this component existed.
    //
    // One artifact for every target — an ONNX graph is portable, and the same 38 MB file is the
    // one the thresholds in speaker-embedding.ts were calibrated against. The URL misspells
    // "recognition"; that is the upstream release tag, not a typo here.
    id: 'speaker-embedding',
    name: 'Speaker embedding model',
    description:
      'Identifies who is talking in each caption, so descriptions and chapters can tell the host apart from the footage he is reacting to. Needs a voice enrollment in Settings to do anything.',
    category: 'tool',
    sizeBytes: 40_257_283,
    entryPath: 'nemo_en_titanet_small.onnx',
    version: 'sherpa-onnx-titanet-small',
    artifacts: (['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const).map((target) => {
      const split = target.lastIndexOf('-');
      return {
        platform: target.slice(0, split) as NodeJS.Platform,
        arch: target.slice(split + 1),
        kind: 'file' as const,
        url: `${SHERPA_SPEAKER_MODELS}/nemo_en_titanet_small.onnx`,
        sha256: 'ad4a1802485d8b34c722d2a9d04249662f2ece5d28a7a039063ca22f515a789e',
        bytes: 40_257_283,
        fileName: 'nemo_en_titanet_small.onnx',
      };
    }),
  },
];

// whisper-engine and the whisper-* model components left with P10: every transcription is
// Crucible's asr job (LEDGER #206). An install that still has them on disk loses them once to
// the retired-component cleanup (electron/retired-components.ts).
const catalog = [...toolComponents];

export function getCatalog(): OptionalComponent[] {
  return catalog;
}

export function getComponent(id: string): OptionalComponent | undefined {
  return catalog.find((component) => component.id === id);
}
