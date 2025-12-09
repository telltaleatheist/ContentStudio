/**
 * Whisper Service - Video Transcription using whisper.cpp
 *
 * High-level service that orchestrates transcription workflow:
 * 1. Extract audio from video using FFmpeg
 * 2. Transcribe audio using Whisper
 * 3. Parse and return SRT segments
 *
 * Uses bridge libraries for binary management.
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as log from 'electron-log';

import {
  getRuntimePaths,
  getWhisperLibraryPath,
  verifyBinary,
  FfmpegBridge,
  FfprobeBridge,
  WhisperBridge,
  type WhisperProgress,
} from '../../lib/bridges';

export interface TranscriptionProgress {
  jobId: string;
  videoPath: string;
  percent: number;
  message: string;
}

export interface SRTSegment {
  index: number;
  start: string;
  end: string;
  text: string;
}

interface TranscriptionJob {
  id: string;
  videoPath: string;
  tempDir: string;
  audioPath: string | null;
  aborted: boolean;
}

export class WhisperService extends EventEmitter {
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;
  private whisper: WhisperBridge;
  private activeJobs = new Map<string, TranscriptionJob>();

  constructor() {
    super();

    log.info('[WhisperService] Initializing...');
    log.info('[WhisperService] Platform:', process.platform);
    log.info('[WhisperService] Architecture:', process.arch);

    // Get runtime paths
    const paths = getRuntimePaths();

    // Verify binaries exist and have correct architecture
    verifyBinary(paths.ffmpeg, 'FFmpeg');
    verifyBinary(paths.whisper, 'Whisper');

    // Initialize bridges
    this.ffmpeg = new FfmpegBridge(paths.ffmpeg);
    this.ffprobe = new FfprobeBridge(paths.ffprobe);
    this.whisper = new WhisperBridge({
      binaryPath: paths.whisper,
      modelsDir: paths.whisperModelsDir,
      libraryPath: getWhisperLibraryPath(),
    });

    // Forward whisper progress events
    this.whisper.on('progress', (progress: WhisperProgress) => {
      const job = this.findJobByProcessId(progress.processId);
      if (job) {
        this.emit('progress', {
          jobId: job.id,
          videoPath: job.videoPath,
          percent: Math.round(15 + (progress.percent * 0.85)), // Scale 0-100 to 15-100
          message: progress.message,
        } as TranscriptionProgress);
      }
    });

    log.info('[WhisperService] Initialized successfully');
    log.info('[WhisperService] FFmpeg:', paths.ffmpeg);
    log.info('[WhisperService] Whisper:', paths.whisper);
    log.info('[WhisperService] Models:', paths.whisperModelsDir);
  }

  /**
   * Find job by whisper process ID
   */
  private findJobByProcessId(processId: string): TranscriptionJob | undefined {
    // The processId from whisper matches the jobId we pass
    return this.activeJobs.get(processId);
  }

  /**
   * Transcribe a video file to SRT format
   * Returns job ID for tracking progress
   */
  async transcribeVideo(
    videoPath: string,
    modelName?: string
  ): Promise<{ jobId: string; srtPath: string; segments: SRTSegment[] }> {
    // Generate unique job ID
    const jobId = crypto.randomBytes(8).toString('hex');

    // Create temporary directory
    const tempDir = path.join(os.tmpdir(), `whisper-${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });

    // Initialize job tracking
    const job: TranscriptionJob = {
      id: jobId,
      videoPath,
      tempDir,
      audioPath: null,
      aborted: false,
    };
    this.activeJobs.set(jobId, job);

    log.info(`[WhisperService] [${jobId}] Starting transcription for: ${videoPath}`);

    try {
      // Validate input file
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }

      // Get video duration for progress tracking
      let duration: number | undefined;
      try {
        duration = await this.ffprobe.getDuration(videoPath);
        log.info(`[WhisperService] [${jobId}] Video duration: ${duration}s`);
      } catch (err) {
        log.warn(`[WhisperService] [${jobId}] Could not get duration: ${err}`);
      }

      // Extract audio
      this.emitProgress(jobId, 5, 'Extracting audio...');
      const audioPath = path.join(tempDir, 'audio.wav');

      const extractResult = await this.ffmpeg.extractAudio(videoPath, audioPath, {
        processId: `${jobId}-extract`,
        duration,
      });

      if (!extractResult.success) {
        throw new Error(`Audio extraction failed: ${extractResult.error}`);
      }

      job.audioPath = audioPath;
      log.info(`[WhisperService] [${jobId}] Audio extracted to: ${audioPath}`);

      // Transcribe with whisper
      this.emitProgress(jobId, 15, 'Starting transcription...');

      const whisperResult = await this.whisper.transcribe(audioPath, tempDir, {
        model: modelName,
        processId: jobId, // Use jobId so we can correlate progress events
      });

      if (!whisperResult.success || !whisperResult.srtPath) {
        throw new Error(`Transcription failed: ${whisperResult.error}`);
      }

      // Parse SRT file
      const srtContent = fs.readFileSync(whisperResult.srtPath, 'utf-8');
      const segments = this.parseSRT(srtContent);

      log.info(`[WhisperService] [${jobId}] Transcription complete: ${segments.length} segments`);
      this.emitProgress(jobId, 100, 'Transcription complete');

      // Clean up audio file (keep SRT)
      this.cleanupAudio(job);

      // Remove from active jobs
      this.activeJobs.delete(jobId);

      return { jobId, srtPath: whisperResult.srtPath, segments };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`[WhisperService] [${jobId}] Transcription failed: ${errorMessage}`);

      // Clean up on error
      this.cleanupJob(job);
      this.activeJobs.delete(jobId);

      throw error;
    }
  }

  /**
   * Emit progress event
   */
  private emitProgress(jobId: string, percent: number, message: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    this.emit('progress', {
      jobId,
      videoPath: job.videoPath,
      percent,
      message,
    } as TranscriptionProgress);
  }

  /**
   * Parse SRT file into segments
   */
  private parseSRT(srtContent: string): SRTSegment[] {
    const segments: SRTSegment[] = [];
    const blocks = srtContent.trim().split(/\n\n+/);

    for (const block of blocks) {
      const lines = block.trim().split('\n');
      if (lines.length < 3) continue;

      const index = parseInt(lines[0], 10);
      const timeParts = lines[1].split(' --> ');
      if (timeParts.length !== 2) continue;

      const [start, end] = timeParts;
      const text = lines.slice(2).join('\n');

      segments.push({ index, start, end, text });
    }

    return segments;
  }

  /**
   * Clean up audio file from job
   */
  private cleanupAudio(job: TranscriptionJob): void {
    if (job.audioPath && fs.existsSync(job.audioPath)) {
      try {
        fs.unlinkSync(job.audioPath);
      } catch (err) {
        log.warn(`[WhisperService] [${job.id}] Failed to clean up audio: ${err}`);
      }
    }
  }

  /**
   * Clean up all job files
   */
  private cleanupJob(job: TranscriptionJob): void {
    this.cleanupAudio(job);

    if (job.tempDir && fs.existsSync(job.tempDir)) {
      try {
        fs.rmSync(job.tempDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`[WhisperService] [${job.id}] Failed to clean up temp directory: ${err}`);
      }
    }
  }

  /**
   * Cancel ongoing transcription(s)
   * @param jobId Optional specific job to cancel. If not provided, cancels all jobs.
   */
  cancel(jobId?: string): void {
    if (jobId) {
      const job = this.activeJobs.get(jobId);
      if (job) {
        log.info(`[WhisperService] [${jobId}] Cancelling transcription`);
        job.aborted = true;
        this.whisper.abort(jobId);
        this.ffmpeg.abort(`${jobId}-extract`);
      }
    } else {
      log.info('[WhisperService] Cancelling all transcriptions');
      this.whisper.abortAll();
      this.ffmpeg.abortAll();
      for (const job of this.activeJobs.values()) {
        job.aborted = true;
      }
    }
  }

  /**
   * Get list of available models
   */
  getAvailableModels(): string[] {
    return this.whisper.getAvailableModels();
  }
}
