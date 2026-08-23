/**
 * Saved transcripts — the Whisper output of a video, kept on disk so a second run over
 * the same file does not pay for it twice.
 *
 * Until now a transcript existed only for the length of one run: the pipeline transcribed
 * into a temp dir, parsed the SRT into memory and deleted the dir (whisper.service.ts).
 * Re-queueing the same 90-minute export therefore meant another 90 minutes of Whisper for
 * a result that could not differ, because the input file had not changed.
 *
 * So every Whisper run now writes its segments beside the job reports, and a video that
 * has a record gets a checkbox on its queue row offering to reuse it. Reuse is the
 * OPERATOR'S CHOICE and never a default: an unticked row transcribes exactly as before
 * and overwrites the record with the new result.
 *
 * WHAT MAKES THIS SAFE IS THE STALENESS STAMP. A transcript is only the transcript of the
 * bytes it was taken from, and a re-render under the same filename is a different video
 * with the same name. The record stores the video's size and mtime at save time; every
 * read re-stats the file and compares. A record that disagrees is not "close enough" —
 * silently applying it would generate a whole set of metadata for a video nobody
 * transcribed, which is the worst failure this app has. So the reader REFUSES it: the UI
 * treats it as no record at all (the checkbox simply does not appear), and a ticked flag
 * that reaches the pipeline anyway fails that item by name. Nothing anywhere quietly
 * re-transcribes to paper over it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as log from 'electron-log';

import { sourceKeyOf, type SavedTranscriptReuse } from './item-identity';
import type { SRTSegment } from './whisper.service';

/**
 * Bumped when the on-disk shape changes. A record written by another version is REFUSED
 * rather than read leniently — the reader would be guessing which fields it can trust,
 * and the whole point of the record is that it is trustworthy.
 *
 * 2 (speaker tagging): the segments may now carry `speaker`/`speakerLabel`, and the record says
 * whether they do and against whose voice. A version-1 record has neither, and its segments are
 * untagged in a way a reader could not distinguish from "tagged, and every caption came out
 * UNSURE" — which is why this is a version bump and not an optional field. Refusing them costs
 * one re-transcription of anything the operator saved before this build.
 */
export const SAVED_TRANSCRIPT_SCHEMA_VERSION = 2;

/** The video identity a transcript is only valid for. */
export interface SavedTranscriptVideoStamp {
  /** Bytes, exactly as `fs.stat` reports them. */
  size: number;
  /**
   * Modification time in WHOLE milliseconds.
   *
   * Rounded on the way in and on the way out because the sub-millisecond part is not a
   * stable property of the file: APFS, an SMB mount and a network volume can each report
   * a different tail for the same unchanged video, and a stamp that drifts on its own
   * would condemn every good record it guards.
   */
  mtimeMs: number;
}

/**
 * What speaker tagging did to the segments in this record, or that it did not run.
 *
 * PERSISTED WITH THE SEGMENTS, because the tags are persisted with the segments: reuse hands
 * the pipeline the same `speaker`/`speakerLabel` the tagging run put there, and this is the
 * record's own statement of where they came from. `enrollment` is the stamp of the recording
 * the captions were scored against (`<basename>@<size>-<mtimeMs>`), so a transcript tagged
 * against an enrollment the operator has since re-recorded is visibly a transcript tagged
 * against the old one.
 */
export interface SavedTranscriptSpeakerTagging {
  enrollment: string;
  host: number;
  clip: number;
  unsure: number;
}

export interface SavedTranscriptRecord {
  schema_version: number;
  /** `sourceKeyOf(source_path)` — the cross-run join key, and this file's name. */
  source_key: string;
  /** The path the transcript was taken from, for the operator to read in an error. */
  source_path: string;
  video: SavedTranscriptVideoStamp;
  /** The Whisper model that produced these segments, as the run resolved it. */
  whisper_model: string;
  /** ISO. When this record was written. */
  saved_at: string;
  /** The final export's duration as the transcription stage ffprobed it; null if it could not. */
  duration_sec: number | null;
  /** null when the transcribing run was in the untagged mode — see SavedTranscriptSpeakerTagging. */
  speaker_tagging: SavedTranscriptSpeakerTagging | null;
  segments: SRTSegment[];
}

/**
 * What a lookup found. `exists: false` carries the REASON, because every caller has
 * something to do with it: the UI logs it, and the pipeline puts it in the failure the
 * operator reads.
 */
export type SavedTranscriptLookup =
  | { exists: true; record: SavedTranscriptRecord; recordPath: string }
  | { exists: false; reason: string; recordPath: string };

/**
 * Where a run's output goes when nothing names a directory.
 *
 * THE one definition. It used to live only inside MetadataGeneratorService, which was
 * fine while the generator was the only thing that needed it; the moment a second caller
 * (the "does this video have a saved transcript?" check the UI makes) has to resolve the
 * SAME directory, a second copy is a bug waiting for someone to change one of them — the
 * checkbox would offer a record the pipeline then looks for somewhere else.
 */
export function defaultOutputDirectory(): string {
  return path.join(os.homedir(), 'Documents', 'ContentStudio Output');
}

/** `params.outputPath || settings.outputDirectory`, already collapsed by the caller, or the default. */
export function resolveOutputDirectory(outputPath?: string | null): string {
  return typeof outputPath === 'string' && outputPath.trim()
    ? outputPath
    : defaultOutputDirectory();
}

/** Sibling of `.contentstudio/metadata`, for the same reason: it belongs to the output dir. */
export function savedTranscriptDir(outputDir: string): string {
  if (typeof outputDir !== 'string' || !outputDir.trim()) {
    throw new Error('savedTranscriptDir requires an output directory');
  }
  return path.join(outputDir, '.contentstudio', 'transcripts');
}

export function savedTranscriptPathFor(outputDir: string, videoPath: string): string {
  return path.join(savedTranscriptDir(outputDir), `${sourceKeyOf(videoPath)}.json`);
}

/** The video's identity right now. Throws if it cannot be read — the caller has no video. */
function stampVideo(videoPath: string): SavedTranscriptVideoStamp {
  const stats = fs.statSync(videoPath);
  return { size: stats.size, mtimeMs: Math.round(stats.mtimeMs) };
}

function describeStamp(stamp: SavedTranscriptVideoStamp): string {
  return `${stamp.size} bytes, modified ${new Date(stamp.mtimeMs).toISOString()}`;
}

/**
 * Persist the segments Whisper just produced. Called on EVERY successful transcription,
 * overwriting whatever was there — the run that just read the file is by definition the
 * most recent word on it.
 *
 * Throws on any failure. A save that quietly did not happen would leave the operator with
 * a checkbox that never appears and no idea why, so an unwritable output directory is a
 * fault to see now rather than a mystery later.
 */
export function saveTranscript(args: {
  outputDir: string;
  videoPath: string;
  segments: SRTSegment[];
  durationSec: number | null;
  whisperModel: string;
  /** What the speaker tagger did to these segments; null when the run was in the untagged mode. */
  speakerTagging: SavedTranscriptSpeakerTagging | null;
}): SavedTranscriptReuse {
  const { outputDir, videoPath, segments, durationSec, whisperModel, speakerTagging } = args;

  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error(
      `Refusing to save an empty transcript for ${path.basename(videoPath)} — a record with ` +
      `no segments would be offered for reuse and then generate metadata from nothing.`
    );
  }
  if (typeof whisperModel !== 'string' || !whisperModel.trim()) {
    throw new Error(
      `Refusing to save the transcript for ${path.basename(videoPath)} without the Whisper ` +
      `model that produced it — the record could not say what it is a transcript by.`
    );
  }

  const recordPath = savedTranscriptPathFor(outputDir, videoPath);
  const record: SavedTranscriptRecord = {
    schema_version: SAVED_TRANSCRIPT_SCHEMA_VERSION,
    source_key: sourceKeyOf(videoPath),
    source_path: videoPath,
    // Stamped from the file the segments were just read out of, so the comparison a later
    // run makes is against the bytes Whisper actually heard.
    video: stampVideo(videoPath),
    whisper_model: whisperModel,
    saved_at: new Date().toISOString(),
    duration_sec: durationSec,
    speaker_tagging: speakerTagging,
    segments,
  };

  try {
    fs.mkdirSync(path.dirname(recordPath), { recursive: true });
    // Written aside and renamed: a record half-flushed when the app is killed would parse
    // as corrupt at best and as a short transcript at worst, and rename is the one step
    // the filesystem will not leave half-done.
    const tempPath = `${recordPath}.writing`;
    fs.writeFileSync(tempPath, JSON.stringify(record, null, 2), 'utf-8');
    fs.renameSync(tempPath, recordPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(`Could not save the transcript for ${path.basename(videoPath)} to ${recordPath}: ${reason}`);
  }

  log.info(
    `[SavedTranscript] Saved ${record.segments.length} segments for ${record.source_key} ` +
    `(${record.whisper_model}${record.speaker_tagging ? `, speaker-tagged against ${record.speaker_tagging.enrollment}` : ''}) ` +
    `to ${recordPath}`
  );

  return {
    source_key: record.source_key,
    saved_at: record.saved_at,
    whisper_model: record.whisper_model,
    record_path: recordPath,
    speaker_enrollment: record.speaker_tagging ? record.speaker_tagging.enrollment : null,
  };
}

/**
 * Is there a record for this video that is still a record OF this video?
 *
 * Every rejection is a stated reason, never a thrown exception: this is the question the
 * UI asks about every video on the list, and "there is no usable record" is an ordinary
 * answer to it. The pipeline asks the same question through `loadSavedTranscript` below,
 * which turns the same reason into a per-item failure.
 */
export function inspectSavedTranscript(outputDir: string, videoPath: string): SavedTranscriptLookup {
  const recordPath = savedTranscriptPathFor(outputDir, videoPath);

  if (!fs.existsSync(recordPath)) {
    return { exists: false, reason: 'no saved transcript has been written for this video', recordPath };
  }

  let record: SavedTranscriptRecord;
  try {
    record = JSON.parse(fs.readFileSync(recordPath, 'utf-8'));
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exists: false, reason: `the saved transcript could not be read: ${reason}`, recordPath };
  }

  if (!record || typeof record !== 'object') {
    return { exists: false, reason: 'the saved transcript is not a record', recordPath };
  }
  if (record.schema_version !== SAVED_TRANSCRIPT_SCHEMA_VERSION) {
    return {
      exists: false,
      reason: `the saved transcript is schema_version ${record.schema_version}, and this build ` +
        `reads ${SAVED_TRANSCRIPT_SCHEMA_VERSION}`,
      recordPath,
    };
  }
  if (!Array.isArray(record.segments) || record.segments.length === 0) {
    return { exists: false, reason: 'the saved transcript has no segments', recordPath };
  }
  // A v2 record STATES its tagging, including stating that there was none. `undefined` is not
  // "untagged" — it is a record that does not answer the question, and the answer decides
  // whether the metadata calls are told who is speaking.
  if (record.speaker_tagging !== null && typeof record.speaker_tagging !== 'object') {
    return {
      exists: false,
      reason: 'the saved transcript does not say whether its captions were speaker-tagged',
      recordPath,
    };
  }
  for (const segment of record.segments) {
    if (!segment || typeof segment.text !== 'string' ||
        typeof segment.start !== 'string' || typeof segment.end !== 'string') {
      return {
        exists: false,
        reason: 'the saved transcript contains a segment with no text or no timing — chapters ' +
          'are built from these timings and cannot be built from this',
        recordPath,
      };
    }
  }

  // The filename is the source key, so a mismatch means the file was renamed or hand-moved
  // into place. Say so rather than generate from a transcript of a different video.
  const expectedKey = sourceKeyOf(videoPath);
  if (record.source_key !== expectedKey) {
    return {
      exists: false,
      reason: `the saved transcript is filed under "${record.source_key}" but this video's key ` +
        `is "${expectedKey}"`,
      recordPath,
    };
  }

  let current: SavedTranscriptVideoStamp;
  try {
    current = stampVideo(videoPath);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    return { exists: false, reason: `the video itself could not be read: ${reason}`, recordPath };
  }

  const saved = record.video;
  if (!saved || typeof saved.size !== 'number' || typeof saved.mtimeMs !== 'number') {
    return { exists: false, reason: 'the saved transcript carries no video stamp to verify', recordPath };
  }
  if (saved.size !== current.size || Math.round(saved.mtimeMs) !== current.mtimeMs) {
    return {
      exists: false,
      reason: `the video has changed since it was transcribed — transcribed from ` +
        `${describeStamp(saved)}, the file on disk is now ${describeStamp(current)}`,
      recordPath,
    };
  }

  return { exists: true, record, recordPath };
}

/**
 * The pipeline's read. The operator TICKED the box, so there is no second-best outcome
 * here: either the record is usable or this item fails saying which file and why.
 *
 * Re-transcribing instead would be the fallback this codebase does not allow — the run
 * would silently cost an hour the operator explicitly declined, and (worse) it would hide
 * the fact that the video he is generating for is not the video he transcribed.
 */
export function loadSavedTranscript(outputDir: string, videoPath: string): {
  record: SavedTranscriptRecord;
  reuse: SavedTranscriptReuse;
} {
  const lookup = inspectSavedTranscript(outputDir, videoPath);
  if (!lookup.exists) {
    throw new Error(
      `"Use saved transcript" is ticked for ${path.basename(videoPath)} but the saved transcript ` +
      `cannot be used: ${lookup.reason} (${lookup.recordPath}). Untick the box to transcribe it again.`
    );
  }

  const { record, recordPath } = lookup;
  log.info(
    `[SavedTranscript] Reusing ${record.segments.length} segments for ${record.source_key} ` +
    `saved ${record.saved_at} by ${record.whisper_model} ` +
    `(${record.speaker_tagging ? `speaker-tagged against ${record.speaker_tagging.enrollment}` : 'untagged'}) ` +
    `(${recordPath})`
  );

  return {
    record,
    reuse: {
      source_key: record.source_key,
      saved_at: record.saved_at,
      whisper_model: record.whisper_model,
      record_path: recordPath,
      speaker_enrollment: record.speaker_tagging ? record.speaker_tagging.enrollment : null,
    },
  };
}
