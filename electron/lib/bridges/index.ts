/**
 * Bridges - Process wrappers for external binaries
 *
 * Provides clean interfaces to ffmpeg and ffprobe with support for multiple concurrent
 * processes and individualized feedback. (whisper.cpp's bridge left with P10: every
 * transcription is Crucible's asr job, LEDGER #206.)
 *
 * Usage:
 *   import { getRuntimePaths, FfmpegBridge, FfprobeBridge } from '../lib/bridges';
 *
 *   const paths = getRuntimePaths();
 *   const ffmpeg = new FfmpegBridge(paths.ffmpeg);
 *   const ffprobe = new FfprobeBridge(paths.ffprobe);
 */

// Runtime path resolution
export {
  getRuntimePaths,
  getResourcesPath,
  isPackaged,
  getPlatformFolder,
  getBinaryExtension,
  verifyBinary,
  type RuntimePaths,
} from './runtime-paths';

// FFmpeg bridge
export {
  FfmpegBridge,
  type FfmpegProgress,
  type FfmpegProcessInfo,
  type FfmpegResult,
} from './ffmpeg-bridge';

// FFprobe bridge
export {
  FfprobeBridge,
  type StreamInfo,
  type FormatInfo,
  type ProbeResult,
  type MediaInfo,
} from './ffprobe-bridge';

