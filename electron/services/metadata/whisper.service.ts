/**
 * Whisper Service - Video Transcription using whisper.cpp
 *
 * Uses whisper.cpp (C++ implementation) instead of Python whisper
 * - No Python dependencies
 * - Faster transcription
 * - Works out of the box on all platforms
 */

import { spawn, ChildProcess } from 'child_process';
import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as log from 'electron-log';

export interface TranscriptionProgress {
  jobId: string;
  videoPath: string;
  percent: number;
  message: string;
}

interface TranscriptionJob {
  id: string;
  videoPath: string;
  process: ChildProcess;
  aborted: boolean;
  lastReportedPercent: number;
  tempDir: string | null;
  audioPath: string | null;
}

export interface SRTSegment {
  index: number;
  start: string;
  end: string;
  text: string;
}

export class WhisperService extends EventEmitter {
  private whisperPath: string;
  private modelsDir: string;
  private ffmpegPath: string;
  private activeJobs = new Map<string, TranscriptionJob>();

  // Available models
  private static readonly AVAILABLE_MODELS = ['tiny', 'base', 'small'];
  private static readonly DEFAULT_MODEL = 'base';

  constructor(ffmpegPath?: string) {
    super();

    log.info('[WhisperService] Initializing...');
    log.info('[WhisperService] Platform:', process.platform);
    log.info('[WhisperService] Architecture:', process.arch);
    log.info('[WhisperService] process.cwd():', process.cwd());
    log.info('[WhisperService] process.resourcesPath:', process.resourcesPath);

    // Get whisper.cpp binary path
    this.whisperPath = this.getWhisperPath();
    this.modelsDir = this.getModelsDir();

    // Get ffmpeg path (or use system ffmpeg)
    this.ffmpegPath = ffmpegPath || 'ffmpeg';

    log.info('[WhisperService] Initialized successfully');
    log.info('[WhisperService] Whisper binary:', this.whisperPath);
    log.info('[WhisperService] Models directory:', this.modelsDir);
    log.info('[WhisperService] FFmpeg path:', this.ffmpegPath);

    // Verify binary architectures at startup (macOS only)
    if (process.platform === 'darwin') {
      this.verifyBinaryArchitecture(this.whisperPath, 'whisper-cli');
      if (this.ffmpegPath !== 'ffmpeg') {
        this.verifyBinaryArchitecture(this.ffmpegPath, 'ffmpeg');
      }
    }
  }

  /**
   * Verify that a binary matches the current architecture (macOS only)
   */
  private verifyBinaryArchitecture(binaryPath: string, name: string): void {
    try {
      const { execSync } = require('child_process');
      const result = execSync(`file "${binaryPath}"`, { encoding: 'utf8' });

      const expectedArch = process.arch === 'arm64' ? 'arm64' : 'x86_64';
      const hasCorrectArch = result.includes(expectedArch) || result.includes('universal');

      if (hasCorrectArch) {
        log.info(`[WhisperService] ${name} architecture OK: ${expectedArch}`);
      } else {
        log.warn(`[WhisperService] ${name} may have wrong architecture!`);
        log.warn(`[WhisperService] Expected: ${expectedArch}`);
        log.warn(`[WhisperService] Binary info: ${result.trim()}`);
      }
    } catch (err) {
      log.warn(`[WhisperService] Could not verify ${name} architecture: ${err}`);
    }
  }

  /**
   * Get the platform/architecture-specific binary name
   */
  private getBinaryName(): string {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'win32') {
      return 'whisper-cli.exe';
    } else if (platform === 'darwin') {
      // macOS: architecture-specific binaries
      return arch === 'arm64' ? 'whisper-cli-arm64' : 'whisper-cli-x64';
    } else {
      // Linux
      return 'whisper-cli';
    }
  }

  /**
   * Check if running in packaged Electron app
   */
  private isPackaged(): boolean {
    const resourcesPath = (process as any).resourcesPath || '';
    return resourcesPath &&
      !resourcesPath.includes('node_modules/electron') &&
      !resourcesPath.includes('node_modules\\electron');
  }

  /**
   * Get platform folder name for binaries
   */
  private getPlatformFolder(): string {
    const platform = process.platform;
    const arch = process.arch;

    if (platform === 'win32') {
      return 'win32';
    } else if (platform === 'darwin') {
      return arch === 'arm64' ? 'darwin-arm64' : 'darwin-x64';
    }
    return 'linux-x64';
  }

  /**
   * Get the path to the whisper.cpp executable
   */
  private getWhisperPath(): string {
    const binaryName = this.getBinaryName();
    let whisperPath: string;

    if (this.isPackaged()) {
      // Packaged: binaries are at resources/utilities/bin/
      whisperPath = path.join((process as any).resourcesPath, 'utilities', 'bin', binaryName);
    } else {
      // Development: binaries are at utilities/bin/{platform}/
      whisperPath = path.join(process.cwd(), 'utilities', 'bin', this.getPlatformFolder(), binaryName);
    }

    log.info('[WhisperService] Whisper binary path:', whisperPath);

    if (!fs.existsSync(whisperPath)) {
      throw new Error(`Whisper binary not found at: ${whisperPath}`);
    }

    return whisperPath;
  }

  /**
   * Get the models directory path
   */
  private getModelsDir(): string {
    let modelsDir: string;

    if (this.isPackaged()) {
      modelsDir = path.join((process as any).resourcesPath, 'utilities', 'models');
    } else {
      modelsDir = path.join(process.cwd(), 'utilities', 'models');
    }

    log.info('[WhisperService] Models directory:', modelsDir);

    if (!fs.existsSync(modelsDir)) {
      throw new Error(`Models directory not found at: ${modelsDir}`);
    }

    return modelsDir;
  }

  /**
   * Get the path to a specific Whisper model file
   */
  private getModelPath(modelName: string = WhisperService.DEFAULT_MODEL): string {
    // Normalize model name
    let normalizedName = modelName.toLowerCase();
    if (normalizedName.startsWith('ggml-')) {
      normalizedName = normalizedName.substring(5);
    }
    if (normalizedName.endsWith('.bin')) {
      normalizedName = normalizedName.slice(0, -4);
    }

    // Validate model name
    if (!WhisperService.AVAILABLE_MODELS.includes(normalizedName)) {
      console.warn(`[WhisperService] Invalid model: ${modelName}, using ${WhisperService.DEFAULT_MODEL}`);
      normalizedName = WhisperService.DEFAULT_MODEL;
    }

    const modelFile = `ggml-${normalizedName}.bin`;
    const modelPath = path.join(this.modelsDir, modelFile);

    // Check if model exists
    if (!fs.existsSync(modelPath)) {
      throw new Error(`Model ${modelFile} not found at ${modelPath}`);
    }

    return modelPath;
  }

  /**
   * Extract audio from video using FFmpeg
   */
  private async extractAudio(videoPath: string, outputDir: string): Promise<string> {
    const audioPath = path.join(outputDir, 'audio.wav');

    log.info(`[WhisperService] Extracting audio from: ${videoPath}`);
    log.info(`[WhisperService] FFmpeg path: ${this.ffmpegPath}`);
    log.info(`[WhisperService] Output audio path: ${audioPath}`);

    const args = [
      '-y',
      '-i', videoPath,
      '-vn',                    // No video
      '-acodec', 'pcm_s16le',   // PCM 16-bit little-endian
      '-ar', '16000',           // 16kHz sample rate (optimal for whisper)
      '-ac', '1',               // Mono
      '-f', 'wav',              // WAV format
      audioPath
    ];

    log.info(`[WhisperService] FFmpeg args: ${args.join(' ')}`);

    return new Promise((resolve, reject) => {
      log.info(`[WhisperService] Spawning FFmpeg process...`);

      const proc = spawn(this.ffmpegPath, args);

      log.info(`[WhisperService] FFmpeg spawned with PID: ${proc.pid}`);

      let stderrBuffer = '';

      proc.stderr.on('data', (data: Buffer) => {
        stderrBuffer += data.toString();
      });

      proc.on('close', (code: number) => {
        log.info(`[WhisperService] FFmpeg exited with code: ${code}`);
        if (code === 0) {
          log.info(`[WhisperService] Audio extraction complete: ${audioPath}`);
          resolve(audioPath);
        } else {
          log.error(`[WhisperService] Audio extraction failed with code ${code}`);
          log.error(`[WhisperService] FFmpeg stderr: ${stderrBuffer}`);
          reject(new Error(`Failed to extract audio: FFmpeg exited with code ${code}\n${stderrBuffer}`));
        }
      });

      proc.on('error', (err: Error) => {
        log.error(`[WhisperService] FFmpeg spawn error: ${err.message}`);

        // Check for common architecture mismatch errors
        if (err.message.includes('ENOENT')) {
          log.error(`[WhisperService] FFmpeg binary not found at: ${this.ffmpegPath}`);
        } else if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          log.error(`[WhisperService] FFmpeg binary has wrong architecture for this system (${process.arch})`);
          log.error(`[WhisperService] Binary path: ${this.ffmpegPath}`);
          log.error(`[WhisperService] Try installing FFmpeg via Homebrew: brew install ffmpeg`);
        }

        reject(new Error(`Failed to extract audio: ${err.message}`));
      });
    });
  }

  /**
   * Transcribe a video file to SRT format
   * Always uses the 'small' model for best accuracy
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
      process: null as any, // Will be set in runWhisperCpp
      aborted: false,
      lastReportedPercent: 0,
      tempDir,
      audioPath: null,
    };
    this.activeJobs.set(jobId, job);

    log.info(`[WhisperService] [${jobId}] Starting transcription for: ${videoPath}`);
    log.info(`[WhisperService] [${jobId}] Temp directory: ${tempDir}`);

    try {
      // Validate input file
      log.info(`[WhisperService] [${jobId}] Checking if video file exists...`);
      if (!fs.existsSync(videoPath)) {
        log.error(`[WhisperService] [${jobId}] Video file not found: ${videoPath}`);
        throw new Error(`Video file not found: ${videoPath}`);
      }
      log.info(`[WhisperService] [${jobId}] Video file exists`);

      // Extract audio
      log.info(`[WhisperService] [${jobId}] Starting audio extraction...`);
      this.emitProgress(jobId, 5, 'Extracting audio...');
      job.audioPath = await this.extractAudio(videoPath, tempDir);
      log.info(`[WhisperService] [${jobId}] Audio extracted to: ${job.audioPath}`);

      // Get model path
      log.info(`[WhisperService] [${jobId}] Getting model path...`);
      const modelPath = this.getModelPath(modelName);
      const actualModelName = path.basename(modelPath, '.bin').replace('ggml-', '');

      log.info(`[WhisperService] [${jobId}] Using model: ${actualModelName}`);
      log.info(`[WhisperService] [${jobId}] Model path: ${modelPath}`);

      // Prepare output paths
      const basename = path.basename(job.audioPath, path.extname(job.audioPath));
      const outputBase = path.join(tempDir, basename);
      const srtPath = `${outputBase}.srt`;

      // Transcribe with whisper.cpp
      this.emitProgress(jobId, 15, 'Starting transcription...');
      await this.runWhisperCpp(jobId, job.audioPath, modelPath, outputBase);

      // Check if SRT was created
      if (!fs.existsSync(srtPath)) {
        throw new Error('Transcription completed but no SRT file was created');
      }

      // Parse SRT file
      const segments = this.parseSRT(fs.readFileSync(srtPath, 'utf-8'));

      console.log(`[WhisperService] [${jobId}] Transcription complete: ${segments.length} segments`);
      this.emitProgress(jobId, 100, 'Transcription complete');

      // Clean up audio file
      if (job.audioPath && fs.existsSync(job.audioPath)) {
        fs.unlinkSync(job.audioPath);
      }

      // Remove from active jobs
      this.activeJobs.delete(jobId);

      return { jobId, srtPath, segments };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log.error(`[WhisperService] [${jobId}] Transcription failed: ${errorMessage}`);
      if (errorStack) {
        log.error(`[WhisperService] [${jobId}] Stack trace: ${errorStack}`);
      }

      // Clean up on error
      if (job.audioPath && fs.existsSync(job.audioPath)) {
        fs.unlinkSync(job.audioPath);
      }
      if (tempDir && fs.existsSync(tempDir)) {
        try {
          fs.rmSync(tempDir, { recursive: true, force: true });
        } catch (cleanupError) {
          log.warn(`[WhisperService] [${jobId}] Failed to clean up temp directory: ${cleanupError}`);
        }
      }

      // Remove from active jobs
      this.activeJobs.delete(jobId);

      throw error;
    }
  }

  /**
   * Run whisper.cpp transcription
   */
  private async runWhisperCpp(
    jobId: string,
    audioPath: string,
    modelPath: string,
    outputBase: string
  ): Promise<void> {
    const job = this.activeJobs.get(jobId);
    if (!job) {
      throw new Error(`Job ${jobId} not found`);
    }

    const args = [
      '-m', modelPath,
      '-f', audioPath,
      '-osrt',              // Output SRT format
      '-of', outputBase,    // Output file base
      '-pp',                // Print progress
    ];

    log.info(`[WhisperService] [${jobId}] Running: ${this.whisperPath} ${args.join(' ')}`);

    // Set up environment for dylib loading on macOS
    const env = { ...process.env };
    if (process.platform === 'darwin') {
      const whisperDir = path.dirname(this.whisperPath);
      const pathSeparator = ':';
      env.DYLD_LIBRARY_PATH = `${whisperDir}${pathSeparator}${env.DYLD_LIBRARY_PATH || ''}`;
      log.info(`[WhisperService] [${jobId}] DYLD_LIBRARY_PATH: ${env.DYLD_LIBRARY_PATH}`);
    }

    return new Promise<void>((resolve, reject) => {
      log.info(`[WhisperService] [${jobId}] Spawning process...`);

      const proc = spawn(this.whisperPath, args, {
        cwd: path.dirname(outputBase),
        env
      });

      log.info(`[WhisperService] [${jobId}] Process spawned with PID: ${proc.pid}`);

      job.process = proc;

      let stdoutBuffer = '';
      let stderrBuffer = '';

      proc.stdout?.on('data', (data) => {
        const chunk = data.toString();
        stdoutBuffer += chunk;
        log.debug(`[WhisperService] [${jobId}] stdout: ${chunk.substring(0, 200)}`);
        this.parseProgress(jobId, chunk);
      });

      proc.stderr?.on('data', (data) => {
        const chunk = data.toString();
        stderrBuffer += chunk;
        log.debug(`[WhisperService] [${jobId}] stderr: ${chunk.substring(0, 200)}`);
        this.parseProgress(jobId, chunk);
      });

      proc.on('close', (code) => {
        log.info(`[WhisperService] [${jobId}] Process exited with code: ${code}`);

        if (job.aborted) {
          reject(new Error('Transcription was cancelled'));
          return;
        }

        if (code === 0) {
          log.info(`[WhisperService] [${jobId}] Transcription completed successfully`);
          resolve();
        } else {
          log.error(`[WhisperService] [${jobId}] Transcription failed with exit code ${code}`);
          log.error(`[WhisperService] [${jobId}] STDOUT: ${stdoutBuffer}`);
          log.error(`[WhisperService] [${jobId}] STDERR: ${stderrBuffer}`);
          reject(new Error(`Transcription failed with exit code ${code}`));
        }
      });

      proc.on('error', (err) => {
        log.error(`[WhisperService] [${jobId}] Failed to start whisper.cpp: ${err.message}`);

        // Check for common architecture mismatch errors
        if (err.message.includes('ENOENT')) {
          log.error(`[WhisperService] [${jobId}] whisper-cli binary not found at: ${this.whisperPath}`);
        } else if (err.message.includes('bad CPU type') || err.message.includes('ENOEXEC')) {
          log.error(`[WhisperService] [${jobId}] whisper-cli binary has wrong architecture for this system (${process.arch})`);
          log.error(`[WhisperService] [${jobId}] Binary path: ${this.whisperPath}`);
          log.error(`[WhisperService] [${jobId}] Expected binary: whisper-cli-${process.arch === 'arm64' ? 'arm64' : 'x64'}`);
        }

        reject(new Error(`Failed to start whisper.cpp: ${err.message}`));
      });
    });
  }

  /**
   * Emit progress event for a specific job
   */
  private emitProgress(jobId: string, percent: number, message: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    this.emit('progress', {
      jobId,
      videoPath: job.videoPath,
      percent,
      message
    });
  }

  /**
   * Parse progress from whisper.cpp output
   */
  private parseProgress(jobId: string, output: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;

    // whisper.cpp with -pp outputs: "progress = XX%"
    const progressMatch = output.match(/progress\s*=\s*(\d+)%/i);
    if (progressMatch) {
      const percent = Math.min(95, parseInt(progressMatch[1], 10));
      if (percent > job.lastReportedPercent) {
        job.lastReportedPercent = percent;
        this.emitProgress(jobId, percent, this.getCurrentMessage(percent));
      }
      return;
    }

    // Simple percentage pattern
    const simpleMatch = output.match(/(\d+)%/);
    if (simpleMatch) {
      const percent = Math.min(95, parseInt(simpleMatch[1], 10));
      if (percent > job.lastReportedPercent + 5) {
        job.lastReportedPercent = percent;
        this.emitProgress(jobId, percent, this.getCurrentMessage(percent));
      }
    }

    // Loading messages
    if (output.includes('loading model') || output.includes('whisper_init')) {
      if (job.lastReportedPercent < 20) {
        this.emitProgress(jobId, 20, 'Loading Whisper model');
        job.lastReportedPercent = 20;
      }
    } else if (output.includes('processing') || output.includes('run_whisper')) {
      if (job.lastReportedPercent < 30) {
        this.emitProgress(jobId, 30, 'Processing audio');
        job.lastReportedPercent = 30;
      }
    }
  }

  private getCurrentMessage(percent: number): string {
    if (percent < 20) return 'Initializing';
    if (percent < 30) return 'Loading model';
    if (percent < 40) return 'Detecting language';
    if (percent < 60) return 'Processing audio';
    if (percent < 80) return 'Generating transcript';
    if (percent < 95) return 'Processing segments';
    return 'Finalizing transcript';
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
      const [start, end] = lines[1].split(' --> ');
      const text = lines.slice(2).join('\n');

      segments.push({ index, start, end, text });
    }

    return segments;
  }

  /**
   * Cancel ongoing transcription(s)
   * @param jobId Optional specific job to cancel. If not provided, cancels all jobs.
   */
  cancel(jobId?: string): void {
    if (jobId) {
      // Cancel specific job
      const job = this.activeJobs.get(jobId);
      if (job && job.process) {
        console.log(`[WhisperService] [${jobId}] Cancelling transcription`);
        job.aborted = true;

        if (process.platform === 'win32') {
          const { execSync } = require('child_process');
          try {
            execSync(`taskkill /pid ${job.process.pid} /T /F`, { stdio: 'ignore' });
          } catch (err) {
            console.warn(`[WhisperService] [${jobId}] Failed to kill process`);
          }
        } else {
          job.process.kill('SIGTERM');
        }
      }
    } else {
      // Cancel all jobs
      console.log('[WhisperService] Cancelling all transcriptions');
      const jobEntries = Array.from(this.activeJobs.entries());
      for (const [id, job] of jobEntries) {
        if (job.process) {
          job.aborted = true;

          if (process.platform === 'win32') {
            const { execSync } = require('child_process');
            try {
              execSync(`taskkill /pid ${job.process.pid} /T /F`, { stdio: 'ignore' });
            } catch (err) {
              console.warn(`[WhisperService] [${id}] Failed to kill process`);
            }
          } else {
            job.process.kill('SIGTERM');
          }
        }
      }
    }
  }

  /**
   * Get list of available models
   */
  getAvailableModels(): string[] {
    const available: string[] = [];
    for (const model of WhisperService.AVAILABLE_MODELS) {
      const modelPath = path.join(this.modelsDir, `ggml-${model}.bin`);
      if (fs.existsSync(modelPath)) {
        available.push(model);
      }
    }
    return available;
  }
}
