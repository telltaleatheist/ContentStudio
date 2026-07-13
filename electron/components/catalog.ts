import type { OptionalComponent } from './component-types';

const RELEASE_BASE =
  'https://github.com/telltaleatheist/ContentStudio/releases/download/binaries-v1';
const WHISPER_MODELS =
  'https://huggingface.co/ggerganov/whisper.cpp/resolve/main';

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
    id: 'whisper-engine',
    name: 'Whisper transcription engine',
    description: 'Runs downloaded Whisper models locally. Required for transcription.',
    category: 'tool',
    required: true,
    sizeBytes: 2_000_000,
    entryPath: process.platform === 'win32' ? 'whisper-cli.exe' : `whisper-cli-${process.arch}`,
    version: 'whisper.cpp-1.8.2',
    artifacts: [
      { platform: 'darwin', arch: 'arm64', kind: 'archive', url: `${RELEASE_BASE}/whisper-darwin-arm64.tar.gz`, sha256: '8562cb5f1e0329a8ec69b173576e265d52551fd46b880000c784544a62afaf7d', bytes: 864_993, entry: 'whisper-cli-arm64' },
      { platform: 'darwin', arch: 'x64', kind: 'archive', url: `${RELEASE_BASE}/whisper-darwin-x64.tar.gz`, sha256: 'acad8080ffa3a3d0f8b2ce47eaa0f91f8dbeec9e271872867e96250901d1b908', bytes: 1_160_425, entry: 'whisper-cli-x64' },
      { platform: 'win32', arch: 'x64', kind: 'archive', url: `${RELEASE_BASE}/whisper-win32-x64.zip`, sha256: '703dbf6419dd4273b2e60ac72cf4980d2be72b4d4338401e5241451a20af420e', bytes: 1_982_464, entry: 'whisper-cli.exe' },
    ],
  },
];

const modelSpecs = [
  ['tiny', 'Tiny', 77_691_713, 'Fastest; best for quick drafts.', false, 'be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21'],
  ['base', 'Base', 147_951_465, 'Fast with better accuracy than Tiny.', false, '60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe'],
  ['small', 'Small', 487_601_967, 'Balanced speed and accuracy.', true, '1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b'],
] as const;

const modelComponents: OptionalComponent[] = modelSpecs.map(([model, name, bytes, description, recommended, sha256]) => ({
  id: `whisper-${model}`,
  name: `Whisper ${name}`,
  description,
  category: 'whisper',
  recommended,
  sizeBytes: bytes,
  entryPath: `ggml-${model}.bin`,
  version: 'whisper.cpp',
  artifacts: (['darwin-arm64', 'darwin-x64', 'win32-x64', 'linux-x64'] as const).map((target) => {
    const split = target.lastIndexOf('-');
    return {
      platform: target.slice(0, split) as NodeJS.Platform,
      arch: target.slice(split + 1),
      kind: 'file' as const,
      url: `${WHISPER_MODELS}/ggml-${model}.bin`,
      sha256,
      bytes,
      fileName: `ggml-${model}.bin`,
    };
  }),
}));

const catalog = [...toolComponents, ...modelComponents];

export function getCatalog(): OptionalComponent[] {
  return catalog;
}

export function getComponent(id: string): OptionalComponent | undefined {
  return catalog.find((component) => component.id === id);
}
