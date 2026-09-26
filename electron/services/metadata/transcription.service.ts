/**
 * The pipeline's transcriber — Crucible's `asr` job on `qwen3-asr-1.7b` (P5, LEDGER #206).
 *
 * It carried whisper.cpp's name (whisper.service.ts) until P10 took whisper.cpp out of the app
 * and renamed it for what it is.
 *
 * One transcription:
 *  1. ffmpeg extracts 16 kHz mono FLAC (the upload) — and, when a speaker tagger runs, the
 *     16-bit WAV it scores, extracted first and the FLAC made from it, so the video is decoded
 *     once.
 *  2. The context is built from what the item already knows (services/transcription/
 *     asr-facts.ts): the verbatim instruction (#203) and every fact that could spell a proper
 *     noun. The filename-title seed whisper.cpp got through `--prompt` rides in it.
 *  3. One Crucible asr job (services/transcription/crucible-transcription.ts →
 *     electron/crucible/asr.ts), progress mapped onto this service's bar.
 *  4. `transcript.json` → `SRTSegment[]` cut at sentence punctuation at the aligner's word
 *     times (crucible-transcript.ts), and the words themselves kept.
 *  5. Speaker tagging per caption, while the WAV is still on disk.
 *
 * Every failure fails the item with the server's own message; nothing falls back (Law 1).
 */

import { EventEmitter } from 'events';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as crypto from 'crypto';
import * as log from 'electron-log';

import {
  getRuntimePaths,
  verifyBinary,
  FfmpegBridge,
  FfprobeBridge,
} from '../../lib/bridges';
// TYPE-ONLY, and that matters: speaker-tagging.service.ts imports `SRTSegment` from this file,
// so a value import here would be a runtime cycle. `import type` is erased at compile time, and
// the two modules only ever meet through the object the caller passes in.
import type { SpeakerTagger, SpeakerTaggingSummary } from './speaker-tagging.service';
import { pipelineAsrContext, type PipelineItemFactsInput } from '../transcription/asr-facts';
import { transcribeOnCrucible } from '../transcription/crucible-transcription';
import { transcriptToSegments, type TranscriptWord } from '../transcription/crucible-transcript';

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
  /** Speaker/track id this segment is attributed to (e.g. "mic", "screen").
   *  Set only for imported transcripts that carry source attribution, or by speaker tagging;
   *  a fresh transcription leaves it undefined. */
  speaker?: string;
  /** Human-readable speaker label (e.g. "Mic", "Screen audio"). */
  speakerLabel?: string;
}

/** What the caller knows about the item, for the context (asr-facts.ts). `videoPath` is the call's own. */
export type TranscriptionFacts = Omit<PipelineItemFactsInput, 'videoPath'>;

export interface TranscribeVideoOptions {
  speakerTagger?: SpeakerTagger;
  /** The facts that seed the context. REQUIRED as an object: `{}` states "nothing known beyond the file". */
  facts: TranscriptionFacts;
}

interface TranscriptionJob {
  id: string;
  videoPath: string;
  tempDir: string;
  abort: AbortController;
}

export class TranscriptionService extends EventEmitter {
  private ffmpeg: FfmpegBridge;
  private ffprobe: FfprobeBridge;
  private activeJobs = new Map<string, TranscriptionJob>();

  constructor() {
    super();
    const paths = getRuntimePaths();
    // Only ffmpeg and ffprobe are local now; the model is Crucible's.
    try {
      verifyBinary(paths.ffmpeg, 'FFmpeg');
      verifyBinary(paths.ffprobe, 'FFprobe');
    } catch (error) {
      throw new Error(`Transcription needs FFmpeg, which is not installed. Open Settings → Transcription Downloads and install FFmpeg. ${error instanceof Error ? error.message : String(error)}`);
    }
    this.ffmpeg = new FfmpegBridge(paths.ffmpeg);
    this.ffprobe = new FfprobeBridge(paths.ffprobe);
  }

  /**
   * Transcribe one video.
   *
   * `speakerTagger`, when the run has one, scores every caption against the operator's enrolled
   * voice before this method returns, while the WAV it needs is still on disk (the very next
   * thing this method does is delete it).
   */
  async transcribeVideo(
    videoPath: string,
    options: TranscribeVideoOptions
  ): Promise<{
    jobId: string;
    segments: SRTSegment[];
    /** The aligner's words, punctuated (crucible-transcript.ts `segmentTokens`), in seconds. */
    words: TranscriptWord[];
    durationSec: number | null;
    /** `crucible:<server>:qwen3-asr-1.7b` — what the saved transcript records. */
    model: string;
    /** Present only when a tagger ran. Absent means this run was in the untagged mode. */
    speakerTagging?: SpeakerTaggingSummary;
  }> {
    const jobId = crypto.randomBytes(8).toString('hex');
    const tempDir = path.join(os.tmpdir(), `asr-${jobId}`);
    fs.mkdirSync(tempDir, { recursive: true });
    const job: TranscriptionJob = { id: jobId, videoPath, tempDir, abort: new AbortController() };
    this.activeJobs.set(jobId, job);
    log.info(`[Transcription] [${jobId}] Starting transcription for: ${videoPath}`);

    try {
      if (!fs.existsSync(videoPath)) {
        throw new Error(`Video file not found: ${videoPath}`);
      }
      const speakerTagger = options.speakerTagger;

      // Reported with the result (ItemProvenance.final_duration_sec); a failed probe stays a
      // stated null rather than a guessed number.
      let duration: number | undefined;
      try {
        duration = await this.ffprobe.getDuration(videoPath);
        log.info(`[Transcription] [${jobId}] Video duration: ${duration}s`);
      } catch (err) {
        log.warn(`[Transcription] [${jobId}] Could not get duration: ${err}`);
      }

      this.emitProgress(jobId, 2, 'Extracting audio...');
      const flacPath = path.join(tempDir, 'audio.flac');
      const wavPath = speakerTagger ? path.join(tempDir, 'audio.wav') : null;
      const extract = async (from: string, to: string, codec: 'pcm_s16le' | 'flac'): Promise<void> => {
        const result = await this.ffmpeg.extractAudio(from, to, { codec, processId: `${jobId}-extract`, duration });
        if (!result.success) throw new Error(`Audio extraction failed: ${result.error}`);
      };
      if (wavPath) {
        await extract(videoPath, wavPath, 'pcm_s16le');
        await extract(wavPath, flacPath, 'flac');
      } else {
        await extract(videoPath, flacPath, 'flac');
      }
      if (job.abort.signal.aborted) throw new Error('Transcription cancelled');

      const { context, account } = pipelineAsrContext({ videoPath, ...options.facts });
      log.info(`[Transcription] [${jobId}] asr context from ${account}: ${JSON.stringify(context)}`);

      const outcome = await transcribeOnCrucible({
        audioFile: flacPath,
        context,
        clientRefStem: `pipeline:${jobId}`,
        tag: jobId,
        signal: job.abort.signal,
        band: { from: 10, to: 94 },
        onProgress: (percent, message) => this.emitProgress(jobId, percent, message),
      });

      const { segments, words, transcript, unalignedSegments } = transcriptToSegments(outcome.transcript);
      if (unalignedSegments > 0) {
        // The declared alternate in crucible-transcript.ts: those pieces are cued from the
        // aligner's own words, unpunctuated, rather than lost.
        log.warn(`[Transcription] [${jobId}] ${unalignedSegments} piece(s) of ${path.basename(videoPath)} did not line up with ` +
          'their word timings; their captions were cut from the words themselves, without punctuation');
      }
      // No speech is not a success: generating metadata from nothing would fabricate it.
      if (segments.length === 0) {
        throw new Error(`Transcription produced no speech segments for ${videoPath}`);
      }
      log.info(`[Transcription] [${jobId}] ${segments.length} captions, ${words.length} words from ${transcript.model}` +
        `${transcript.redecoded > 0 ? `, ${transcript.redecoded} piece(s) re-decoded by the server's loop guard` : ''}` +
        ` (job ${outcome.jobId} on ${outcome.server}, ${outcome.wallSeconds.toFixed(1)} s)`);

      // Speaker tagging, while audio.wav is still on disk. Any failure THROWS and fails the item:
      // an enrollment is a request for tagged output.
      let speakerTagging: SpeakerTaggingSummary | undefined;
      if (speakerTagger && wavPath) {
        this.emitProgress(jobId, 95, 'Identifying speakers...');
        speakerTagging = speakerTagger.tagSegments(segments, wavPath, path.basename(videoPath));
      }

      this.emitProgress(jobId, 100, 'Transcription complete');
      return { jobId, segments, words, durationSec: duration ?? null, model: outcome.model, speakerTagging };
    } catch (error) {
      log.error(`[Transcription] [${jobId}] Transcription failed: ${error instanceof Error ? error.message : String(error)}`);
      throw error;
    } finally {
      this.cleanupJob(job);
      this.activeJobs.delete(jobId);
    }
  }

  private emitProgress(jobId: string, percent: number, message: string): void {
    const job = this.activeJobs.get(jobId);
    if (!job) return;
    this.emit('progress', { jobId, videoPath: job.videoPath, percent, message } as TranscriptionProgress);
  }

  private cleanupJob(job: TranscriptionJob): void {
    if (job.tempDir && fs.existsSync(job.tempDir)) {
      try {
        fs.rmSync(job.tempDir, { recursive: true, force: true });
      } catch (err) {
        log.warn(`[Transcription] [${job.id}] Failed to clean up temp directory: ${err}`);
      }
    }
  }

  /**
   * Cancel ongoing transcription(s): the extraction is killed and the Crucible job DELETEd
   * (asr.ts), never merely abandoned.
   * @param jobId Optional specific job to cancel. If not provided, cancels all jobs.
   */
  cancel(jobId?: string): void {
    const jobs = jobId ? [this.activeJobs.get(jobId)].filter((j): j is TranscriptionJob => !!j) : [...this.activeJobs.values()];
    for (const job of jobs) {
      log.info(`[Transcription] [${job.id}] Cancelling transcription`);
      job.abort.abort();
      this.ffmpeg.abort(`${job.id}-extract`);
    }
  }
}
