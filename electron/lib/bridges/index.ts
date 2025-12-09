/**
 * Bridges - Process wrappers for external binaries
 *
 * Provides clean interfaces to ffmpeg, ffprobe, and whisper.cpp
 * with support for multiple concurrent processes and individualized feedback.
 *
 * Usage:
 *   import { getRuntimePaths, FfmpegBridge, FfprobeBridge, WhisperBridge } from '../lib/bridges';
 *
 *   const paths = getRuntimePaths();
 *   const ffmpeg = new FfmpegBridge(paths.ffmpeg);
 *   const ffprobe = new FfprobeBridge(paths.ffprobe);
 *   const whisper = new WhisperBridge({
 *     binaryPath: paths.whisper,
 *     modelsDir: paths.whisperModelsDir,
 *     libraryPath: getWhisperLibraryPath(),
 *   });
 */

// Runtime path resolution
export {
  getRuntimePaths,
  getResourcesPath,
  isPackaged,
  getPlatformFolder,
  getBinaryExtension,
  verifyBinary,
  getWhisperLibraryPath,
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

// Whisper bridge
export {
  WhisperBridge,
  type WhisperProgress,
  type WhisperProcessInfo,
  type WhisperResult,
  type WhisperConfig,
} from './whisper-bridge';
