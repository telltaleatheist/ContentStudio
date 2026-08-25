/**
 * The operator's voice, enrolled once.
 *
 * Speaker tagging needs one thing the app cannot work out for itself: what the host sounds
 * like. So the operator points Settings at a clean solo recording of himself — a minute of him
 * talking with nothing playing under it is plenty; the reference used to calibrate the
 * thresholds was 75 seconds — and this file turns that into the embedding every caption is
 * compared against.
 *
 * IT IS COMPUTED ONCE AND CACHED, in userData, because it costs an ffmpeg decode and a model
 * load and it is the same answer every time. The cache is STAMPED exactly the way
 * saved-transcript.service.ts stamps a video, and for the same reason: an embedding is only the
 * embedding of the bytes it was taken from. If the operator re-records over the same filename,
 * the stamp disagrees and the embedding is computed again. The model file is part of the stamp
 * too — a different model is a different vector space, and a cosine between spaces is a number
 * with no meaning.
 *
 * NOTHING HERE FALLS BACK. Enrollment not configured is a MODE (tagging is off, the run says so
 * once, the pipeline behaves exactly as it did before this feature existed). Enrollment
 * configured but unreadable, undecodable or unembeddable is a FAILURE, named, because the
 * operator asked for tagging and silently not tagging would hand him metadata whose speaker
 * attribution he believes was checked.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as crypto from 'crypto';
import * as log from 'electron-log';

import { FfmpegBridge, getRuntimePaths } from '../../lib/bridges';
import { EMBEDDING_SAMPLE_RATE, SpeakerEmbeddingModel, readPcm16Mono } from './speaker-embedding';


/**
 * Bumped when the cache shape changes. A record written by another version is recomputed rather
 * than read leniently — recomputing costs seconds, and reading a vector whose meaning you are
 * guessing at costs a whole run of wrongly attributed metadata.
 */
const ENROLLMENT_CACHE_VERSION = 1;

interface EnrollmentFileStamp {
  size: number;
  /** Whole milliseconds — see SavedTranscriptVideoStamp for why the sub-millisecond tail is dropped. */
  mtimeMs: number;
}

interface EnrollmentCacheRecord {
  schema_version: number;
  audio_path: string;
  audio: EnrollmentFileStamp;
  /** Basename and size of the ONNX graph the embedding came out of. */
  model_file: string;
  model_bytes: number;
  computed_at: string;
  dim: number;
  embedding: number[];
}

/**
 * A ready-to-use enrollment: the vector, and the short identity string that goes into the
 * saved-transcript record so a reused transcript can say whose voice it was tagged against.
 */
export interface SpeakerEnrollment {
  embedding: Float32Array;
  audioPath: string;
  /** `<basename>@<size>-<mtimeMs>`, stable for as long as the file is unchanged. */
  stamp: string;
  /** ISO, when the embedding was computed (cached or fresh). */
  computedAt: string;
}

function stampOf(filePath: string): EnrollmentFileStamp {
  const stats = fs.statSync(filePath);
  return { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) };
}

function stampString(audioPath: string, stamp: EnrollmentFileStamp): string {
  return `${path.basename(audioPath)}@${stamp.size}-${stamp.mtimeMs}`;
}

function cachePath(): string {
  // Required here rather than at module scope so this file can be imported (and unit-reasoned
  // about) outside a live Electron app; every caller that reaches this line is inside one.
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const { app } = require('electron');
  return path.join(app.getPath('userData'), 'speaker-enrollment.json');
}

function readCache(): EnrollmentCacheRecord | null {
  const file = cachePath();
  if (!fs.existsSync(file)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf-8')) as EnrollmentCacheRecord;
    if (!parsed || parsed.schema_version !== ENROLLMENT_CACHE_VERSION) return null;
    if (!Array.isArray(parsed.embedding) || parsed.embedding.length === 0) return null;
    return parsed;
  } catch (error) {
    // A corrupt cache is not a failure of the run — it is a cache. Say so and recompute.
    log.warn(`[SpeakerEnrollment] Ignoring unreadable cache at ${file}: ${error instanceof Error ? error.message : String(error)}`);
    return null;
  }
}

function writeCache(record: EnrollmentCacheRecord): void {
  const file = cachePath();
  fs.mkdirSync(path.dirname(file), { recursive: true });
  // Written aside and renamed, as the component manifest is: a half-flushed vector would parse
  // as a shorter embedding and compare against nothing.
  const temporary = `${file}.writing`;
  fs.writeFileSync(temporary, JSON.stringify(record, null, 2), 'utf-8');
  fs.renameSync(temporary, file);
}

/**
 * Decode the operator's recording into the one audio format the model reads.
 *
 * Through the SAME ffmpeg the transcription path uses, and to the same 16 kHz mono PCM, so the
 * enrollment and the captions it is compared against have been through an identical decode.
 * Accepts whatever ffmpeg accepts — the operator can point this at an mp4, an m4a or a wav.
 */
async function decodeEnrollmentAudio(audioPath: string): Promise<string> {
  const paths = getRuntimePaths();
  const ffmpeg = new FfmpegBridge(paths.ffmpeg);

  const workingDir = path.join(os.tmpdir(), `speaker-enroll-${crypto.randomBytes(6).toString('hex')}`);
  fs.mkdirSync(workingDir, { recursive: true });
  const wavPath = path.join(workingDir, 'enrollment.wav');

  const result = await ffmpeg.extractAudio(audioPath, wavPath, {
    sampleRate: EMBEDDING_SAMPLE_RATE,
    channels: 1,
  });
  if (!result.success) {
    fs.rmSync(workingDir, { recursive: true, force: true });
    throw new Error(`ffmpeg could not read the enrollment recording ${audioPath}: ${result.error}`);
  }
  return wavPath;
}

/**
 * The enrolled embedding for this run, computing it if the cache does not already hold one for
 * exactly this recording and exactly this model.
 *
 * Throws, naming the cause, on anything that stops it. The caller only reaches this function
 * because the operator configured an enrollment, which is a request for tagging.
 */
export async function loadSpeakerEnrollment(audioPath: string, modelPath: string): Promise<SpeakerEnrollment> {
  if (typeof audioPath !== 'string' || audioPath.trim().length === 0) {
    throw new Error('loadSpeakerEnrollment requires the path to the enrollment recording');
  }
  if (!fs.existsSync(audioPath)) {
    throw new Error(
      `The voice enrollment recording is set to ${audioPath}, and there is no file there. ` +
      `Point Settings → Speaker tagging at the recording again, or clear it to turn tagging off.`
    );
  }
  if (!fs.existsSync(modelPath)) {
    throw new Error(
      `Speaker tagging is enabled but its embedding model is not installed (expected at ${modelPath}). ` +
      `Open Settings → Transcription Downloads and install the speaker embedding model.`
    );
  }

  const audioStamp = stampOf(audioPath);
  const modelStamp = stampOf(modelPath);
  const stamp = stampString(audioPath, audioStamp);

  const cached = readCache();
  if (
    cached &&
    cached.audio_path === audioPath &&
    cached.audio.size === audioStamp.size &&
    Math.round(cached.audio.mtimeMs) === audioStamp.mtimeMs &&
    cached.model_file === path.basename(modelPath) &&
    cached.model_bytes === modelStamp.size
  ) {
    log.info(`[SpeakerEnrollment] Using the cached embedding for ${stamp} (computed ${cached.computed_at})`);
    return {
      embedding: Float32Array.from(cached.embedding),
      audioPath,
      stamp,
      computedAt: cached.computed_at,
    };
  }

  log.info(`[SpeakerEnrollment] Computing the enrollment embedding for ${audioPath}`);
  const wavPath = await decodeEnrollmentAudio(audioPath);
  try {
    const samples = readPcm16Mono(wavPath);
    const seconds = samples.length / EMBEDDING_SAMPLE_RATE;
    if (seconds < 5) {
      throw new Error(
        `The enrollment recording ${path.basename(audioPath)} is only ${seconds.toFixed(1)} seconds of audio. ` +
        `An embedding taken from that little speech does not describe a voice — record at least ` +
        `30 seconds of yourself talking with nothing playing underneath.`
      );
    }

    const model = new SpeakerEmbeddingModel(modelPath);
    const embedding = model.embed(samples);

    const record: EnrollmentCacheRecord = {
      schema_version: ENROLLMENT_CACHE_VERSION,
      audio_path: audioPath,
      audio: audioStamp,
      model_file: path.basename(modelPath),
      model_bytes: modelStamp.size,
      computed_at: new Date().toISOString(),
      dim: embedding.length,
      embedding: Array.from(embedding),
    };
    writeCache(record);

    log.info(
      `[SpeakerEnrollment] Enrolled ${stamp}: ${seconds.toFixed(0)}s of audio, ` +
      `${embedding.length}-dimension embedding, cached at ${cachePath()}`
    );

    return { embedding, audioPath, stamp, computedAt: record.computed_at };
  } finally {
    fs.rmSync(path.dirname(wavPath), { recursive: true, force: true });
  }
}
