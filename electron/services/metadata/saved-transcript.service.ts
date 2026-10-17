/**
 * Saved transcripts — the transcription of a video, kept on disk so a second run over the
 * same file does not pay for it twice.
 *
 * Until now a transcript existed only for the length of one run: the pipeline transcribed
 * into a temp dir, parsed the SRT into memory and deleted the dir (whisper.service.ts).
 * Re-queueing the same 90-minute export therefore meant another 90 minutes of transcription
 * for a result that could not differ, because the input file had not changed.
 *
 * WHERE: BESIDE THE VIDEO (Owen, 2026-10-17, LEDGER #313: "the transcript should be saved
 * per-project"; asked where, "Beside the video file"). The record of `<dir>/<name.ext>` is
 * `<dir>/.contentstudio/transcripts/<name.ext>.json` — `savedTranscriptPathFor`, the one
 * definition. It used to be one global store under the output directory, filed by
 * `sourceKeyOf`; that store is no longer written or read here. Its records are moved
 * beside their videos at app start by saved-transcript-migration.ts, each move logged and
 * every record it cannot move left where it is with the reason. Beside the video, the record
 * travels with the week's folder, needs no output directory to find, and a `.mov` and a
 * `.mp3` of one episode (one source key) each get their own. A video directory that cannot
 * be written fails the save naming the path; there is no second location.
 *
 * Every transcription writes its record, and a video that has one gets a "Replace existing
 * transcript" checkbox on its queue row, UNTICKED: unticked reuses the record and skips
 * transcription, ticked transcribes again and overwrites it (#313; this reverses #48's
 * "reuse is never a default", at Owen's word). A video with no record has no box and is
 * transcribed as always.
 *
 * WHAT MAKES THIS SAFE IS THE STALENESS STAMP. A transcript is only the transcript of the
 * bytes it was taken from, and a re-render under the same filename is a different video
 * with the same name. The record stores the video's size and mtime at save time; every
 * read re-stats the file and compares. A record that disagrees is not "close enough" —
 * silently applying it would generate a whole set of metadata for a video nobody
 * transcribed, which is the worst failure this app has. So the reader REFUSES it: the UI
 * treats it as no record at all (the checkbox simply does not appear), and a reuse that
 * reaches the pipeline anyway fails that item by name. Nothing anywhere quietly
 * re-transcribes to paper over it.
 */

import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as log from 'electron-log';

import { sourceKeyOf, type SavedTranscriptReuse } from './item-identity';
import type { SRTSegment } from './transcription.service';

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
  /**
   * `sourceKeyOf(source_path)` at save time — the cross-run join key a reuse reports. No longer
   * the record's file name (the sidecar is named by the video's file name), and not compared on
   * read: the key is the whole path, and a week's folder moved with its sidecars changes it.
   */
  source_key: string;
  /**
   * The path the transcript was taken from, for the operator to read in an error. Its FILE NAME
   * must be the video's: the sidecar is filed by it, so a mismatch is a record copied or renamed
   * into place by hand.
   */
  source_path: string;
  video: SavedTranscriptVideoStamp;
  /**
   * The model that produced these segments, as the run resolved it. Since P5 (LEDGER #206)
   * `crucible:<server>:<model>`: `qwen3-asr-0.6b` or `qwen3-asr-1.7b`, whichever the routing's
   * Transcription row named (LEDGER #281), and a reuse logs it; older records name a whisper.cpp model (`base`,
   * `large-v3-turbo`) and stay reusable. The key keeps its old name so they do.
   */
  whisper_model: string;
  /** ISO. When this record was written. */
  saved_at: string;
  /** The final export's duration as the transcription stage ffprobed it; null if it could not. */
  duration_sec: number | null;
  /** null when the transcribing run was in the untagged mode — see SavedTranscriptSpeakerTagging. */
  speaker_tagging: SavedTranscriptSpeakerTagging | null;
  segments: SRTSegment[];
  /**
   * The aligner's words beside the captions, in seconds of the video: what cut-by-word reads.
   * ADDITIVE, so no schema bump: a record without it (every whisper.cpp record) has no word
   * timings, which is what it always had, and nothing that reads segments reads this.
   */
  words?: { start: number; end: number; word: string }[];
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
 * has to resolve the SAME directory, a second copy is a bug waiting for someone to change
 * one of them. It lives here because the saved transcripts used to be filed under it; since
 * #313 they sit beside their videos, and only the one-time move of the old store
 * (saved-transcript-migration.ts) still looks under the output directory for them.
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

/**
 * The sidecar of `<dir>/<name.ext>`: `<dir>/.contentstudio/transcripts/<name.ext>.json` (#313).
 *
 * THE one definition, read by the pipeline, the inputs page's probe, the metadata CLI and the
 * reports' readers alike. The file name keeps the video's extension, so the `.mov` and the
 * `.mp3` of one episode in one folder are two records, never one record each would condemn as
 * stale. A dot directory, so the folder listings that read a week (`complete/`) skip it as they
 * skip `.DS_Store`.
 *
 * ABSOLUTE PATHS ONLY: a relative one would put the record wherever the process happened to
 * be started from, and the next reader would look somewhere else.
 */
export function savedTranscriptPathFor(videoPath: string): string {
  if (typeof videoPath !== 'string' || !path.isAbsolute(videoPath)) {
    throw new Error(`A saved transcript is filed beside its video, which needs an absolute video path; got ${JSON.stringify(videoPath)}`);
  }
  return path.join(path.dirname(videoPath), '.contentstudio', 'transcripts', `${path.basename(videoPath)}.json`);
}

/**
 * Can this video's sidecar be written? Asked BEFORE transcribing, because the save comes after
 * an hour of transcription and a read-only folder (a network mount, a locked archive) would
 * otherwise throw that hour away at the last step. Throws naming the folder; there is no other
 * place the record could go (#313).
 *
 * The nearest existing ancestor is what is checked: `.contentstudio/transcripts` is created on
 * the first save, so before then the video's own folder is what must be writable.
 */
export function assertSavedTranscriptWritable(videoPath: string): void {
  let dir = path.dirname(savedTranscriptPathFor(videoPath));
  while (!fs.existsSync(dir)) {
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  try {
    fs.accessSync(dir, fs.constants.W_OK);
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error);
    throw new Error(
      `The transcript of ${path.basename(videoPath)} is saved beside it, in ` +
      `${path.dirname(savedTranscriptPathFor(videoPath))}, and ${dir} cannot be written (${reason}). ` +
      `Nothing was transcribed. Make that folder writable, or move the video somewhere that is.`
    );
  }
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
 * a checkbox that never appears and no idea why, so an unwritable video folder is a fault
 * to see now rather than a mystery later — and the pipeline asks
 * `assertSavedTranscriptWritable` before it transcribes, so that is seen before the hour.
 */
export function saveTranscript(args: {
  videoPath: string;
  segments: SRTSegment[];
  durationSec: number | null;
  whisperModel: string;
  /** The words beside the captions; null when the transcriber gave none. */
  words: { start: number; end: number; word: string }[] | null;
  /** What the speaker tagger did to these segments; null when the run was in the untagged mode. */
  speakerTagging: SavedTranscriptSpeakerTagging | null;
}): SavedTranscriptReuse {
  const { videoPath, segments, durationSec, whisperModel, words, speakerTagging } = args;

  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error(
      `Refusing to save an empty transcript for ${path.basename(videoPath)} — a record with ` +
      `no segments would be offered for reuse and then generate metadata from nothing.`
    );
  }
  if (typeof whisperModel !== 'string' || !whisperModel.trim()) {
    throw new Error(
      `Refusing to save the transcript for ${path.basename(videoPath)} without the ` +
      `model that produced it — the record could not say what it is a transcript by.`
    );
  }

  const recordPath = savedTranscriptPathFor(videoPath);
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
    ...(words ? { words } : {}),
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
export function inspectSavedTranscript(videoPath: string): SavedTranscriptLookup {
  const recordPath = savedTranscriptPathFor(videoPath);

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

  // The sidecar is filed by the video's file name, so a record that names another file was
  // renamed or copied into place by hand. Say so rather than generate from a transcript of a
  // different video. The folder is NOT compared: a week moved whole (to the NAS, say) carries
  // its sidecars with it, and the stamp below is what says the bytes are the same.
  if (typeof record.source_path !== 'string' || path.basename(record.source_path) !== path.basename(videoPath)) {
    return {
      exists: false,
      reason: `the saved transcript beside this video was taken from ${JSON.stringify(record.source_path)}, ` +
        `not from a file named "${path.basename(videoPath)}"`,
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
 * The read of a caller that needs the record: the pipeline reusing it (the row's "Replace
 * existing transcript" box was left unticked), or a report's reader. There is no
 * second-best outcome here: either the record is usable or this throws saying which file
 * and why, and the caller adds what its operator can do about it.
 *
 * Re-transcribing instead would be the fallback this codebase does not allow — the run
 * would silently cost an hour the operator explicitly declined, and (worse) it would hide
 * the fact that the video he is generating for is not the video he transcribed.
 */
export function loadSavedTranscript(videoPath: string): {
  record: SavedTranscriptRecord;
  reuse: SavedTranscriptReuse;
} {
  const lookup = inspectSavedTranscript(videoPath);
  if (!lookup.exists) {
    throw new Error(
      `The saved transcript of ${path.basename(videoPath)} cannot be used: ${lookup.reason} (${lookup.recordPath}).`
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
