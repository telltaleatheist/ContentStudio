/**
 * Updated Video — a re-render published in place of the video a report was made from
 * (LEDGER #316; Owen, 2026-10-18: "i just rendered an updated version of f1 - kent christmas
 * with the ads inserted. i want to be able to update the video for a metadata set so it
 * uploads that to youtube instead"; then "we can exclude chapters if we update the video").
 *
 * The item keeps its identity: the report's source_path and source_key are not touched, so the
 * saved transcript, thumbnails, re-rolls, calendar and primary-set joins all stay on the
 * original. The publish record's `updatedVideo` says which file goes out instead, and:
 *   - the YouTube upload sends it, and matches the channel's uploads by its name and length;
 *   - the composed description leaves the chapter block out (composePublishedText);
 *   - an edited description with chapter lines in it refuses the upload / push / episode upload,
 *     rather than having text stripped out of the operator's own words;
 *   - the Spreaker episode audio is offered from beside it, and an audio file chosen for the
 *     original refuses the episode upload.
 *
 * PURE: the filesystem and ffprobe are injected, so every rule is checked offline
 * (tools/updated-video-checks.js).
 */
import * as path from 'path';
import { deriveProposedAudioPaths } from './audio-validate';
import type { ChosenMetadata, UpdatedVideo } from './publish-types';

/** What the picker offers and the set accepts. */
export const UPDATED_VIDEO_EXTENSIONS = ['.mov', '.mp4', '.m4v', '.mkv', '.webm', '.avi'];

/** One file as it is now, or null when nothing is at the path. */
export interface FileStat {
  bytes: number;
  mtimeMs: number;
  isFile: boolean;
}
export type StatFn = (p: string) => FileStat | null;

export interface ChooseUpdatedVideoInput {
  itemId: string;
  /** The item's publish record, or null when it has none yet. */
  record: ChosenMetadata | null;
  /** The report's own source_path, or null when it records none. */
  originalPath: string | null;
  filePath: string;
  stat: StatFn;
  /** ffprobe's length in seconds. Throws when the file cannot be read. */
  probeDurationSec: (file: string) => Promise<number>;
  now: Date;
}

/** The updated-video value to store, or a throw naming what is wrong. Nothing is written here. */
export async function chooseUpdatedVideo(input: ChooseUpdatedVideoInput): Promise<UpdatedVideo> {
  const { itemId, record, originalPath, filePath, stat } = input;
  if (record?.videoId) {
    throw new Error(
      `Item ${itemId} is already on YouTube as video ${record.videoId}, and YouTube cannot replace an ` +
      `uploaded video's file. Mark it unpublished first, then upload the new render.`
    );
  }
  if (!originalPath) {
    throw new Error(
      `Item ${itemId}'s report records no video file, so there is no video for an updated one to replace.`
    );
  }
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) {
    throw new Error(`The updated video must be an absolute file path; got ${JSON.stringify(filePath)}.`);
  }
  const extension = path.extname(filePath).toLowerCase();
  if (!UPDATED_VIDEO_EXTENSIONS.includes(extension)) {
    throw new Error(
      `${path.basename(filePath)} is not a video file: the updated video must be one of ` +
      `${UPDATED_VIDEO_EXTENSIONS.join(', ')}, and this is ${extension || 'a file with no extension'}.`
    );
  }
  if (path.resolve(filePath) === path.resolve(originalPath)) {
    throw new Error(
      `${path.basename(filePath)} is the video this report was made from, so it does not update anything. ` +
      `Choose the new render.`
    );
  }
  const now = stat(filePath);
  if (!now) throw new Error(`The updated video is not on disk: "${filePath}".`);
  if (!now.isFile) throw new Error(`The updated video "${filePath}" is not a file.`);
  if (now.bytes <= 0) throw new Error(`The updated video "${filePath}" is empty (0 bytes).`);

  const durationSec = await input.probeDurationSec(filePath);
  if (!Number.isFinite(durationSec) || durationSec <= 0) {
    throw new Error(
      `The length of "${filePath}" could not be read (ffprobe reported ${durationSec}), and the upload ` +
      `matches the channel's uploads by it. Check the render plays, then choose it again.`
    );
  }
  return {
    path: filePath,
    bytes: now.bytes,
    mtimeMs: now.mtimeMs,
    durationSec,
    setAt: input.now.toISOString(),
    replacesPath: originalPath,
  };
}

/** Why the chosen updated video cannot be used now, or null when it is the file that was chosen. */
export function updatedVideoFileProblem(itemId: string, updated: UpdatedVideo, stat: StatFn): string | null {
  const now = stat(updated.path);
  if (!now || !now.isFile) {
    return (
      `Item ${itemId}'s updated video is not on disk: "${updated.path}". If its drive is unplugged, ` +
      `plug it in; if it moved, choose it again with Update video….`
    );
  }
  if (now.bytes !== updated.bytes || now.mtimeMs !== updated.mtimeMs) {
    return (
      `Item ${itemId}'s updated video "${updated.path}" has changed since it was chosen on ${updated.setAt} ` +
      `(it was ${updated.bytes} bytes, modified ${new Date(updated.mtimeMs).toISOString()}; it is now ` +
      `${now.bytes} bytes, modified ${new Date(now.mtimeMs).toISOString()}). It was rendered again, so its ` +
      `length may have changed: choose it again with Update video….`
    );
  }
  return null;
}

/** The file an upload sends: the updated video when set (checked), else nothing to say here. */
export function requireUpdatedVideoFile(itemId: string, updated: UpdatedVideo, stat: StatFn): { path: string; sizeBytes: number } {
  const problem = updatedVideoFileProblem(itemId, updated, stat);
  if (problem) throw new Error(problem);
  return { path: updated.path, sizeBytes: updated.bytes };
}

/** A line that starts with a chapter timestamp: "4:58 - …", "1:02:03 …", "0:00". */
const CHAPTER_LINE = /^\s*(?:\d{1,2}:)?\d{1,2}:\d{2}(?!\d)/;

/** The lines of a text that start with a chapter timestamp. */
export function chapterLinesIn(text: string): string[] {
  return text.split('\n').filter((line) => CHAPTER_LINE.test(line)).map((line) => line.trim());
}

/**
 * Why the description cannot go out with an updated video set, or null.
 *
 * The composed description leaves the chapter block out by itself. An edited description is the
 * operator's own text: it replaces the prose section only (the chapters are their own section),
 * so it never carries the generated block, but nothing stops chapter lines being typed into it.
 * Those would be the original video's times, and stripping them silently would rewrite his
 * words, so the publish stops and says which lines.
 */
export function updatedVideoDescriptionProblem(
  record: Pick<ChosenMetadata, 'updatedVideo' | 'descriptionOverride'>
): string | null {
  if (!record.updatedVideo || record.descriptionOverride === null) return null;
  const lines = chapterLinesIn(record.descriptionOverride);
  if (lines.length === 0) return null;
  return (
    `The edited description has ${lines.length} chapter line${lines.length === 1 ? '' : 's'} ` +
    `(${lines.slice(0, 3).map((l) => JSON.stringify(l)).join(', ')}${lines.length > 3 ? ', …' : ''}), and an ` +
    `updated video is set: those times were for ${path.basename(record.updatedVideo.replacesPath)} and no ` +
    `longer match ${path.basename(record.updatedVideo.path)}. Take the chapter lines out of the edited ` +
    `description (or Revert it), or use the original video.`
  );
}

/**
 * Why the episode audio cannot go out with an updated video set, or null: an audio file that is
 * the original video's own (the source itself, or a sibling export of it) is the old cut.
 */
export function updatedVideoAudioProblem(
  record: Pick<ChosenMetadata, 'updatedVideo' | 'spreakerAudioPath'>
): string | null {
  const updated = record.updatedVideo;
  const audio = record.spreakerAudioPath;
  if (!updated || !audio) return null;
  const original = [updated.replacesPath, ...deriveProposedAudioPaths(updated.replacesPath)];
  if (!original.includes(audio)) return null;
  return (
    `The episode audio ${path.basename(audio)} belongs to the original video ${path.basename(updated.replacesPath)}, ` +
    `and an updated video is set (${path.basename(updated.path)}). Choose the updated render's audio, ` +
    `or use the original video.`
  );
}

/** Where the episode audio is offered from: beside the updated video when one is set. */
export function audioProposalSource(
  record: Pick<ChosenMetadata, 'updatedVideo'> | null,
  originalPath: string | null
): string | null {
  return record?.updatedVideo ? record.updatedVideo.path : originalPath;
}

/** What the Video row shows about the updated video. */
export interface UpdatedVideoView {
  path: string;
  fileName: string;
  replacesPath: string;
  replacesFileName: string;
  setAt: string;
  onDisk: boolean;
  /** Missing, or changed since it was chosen: the upload will refuse with this. */
  problem: string | null;
}

export function describeUpdatedVideo(itemId: string, updated: UpdatedVideo | null, stat: StatFn): UpdatedVideoView | null {
  if (!updated) return null;
  const now = stat(updated.path);
  return {
    path: updated.path,
    fileName: path.basename(updated.path),
    replacesPath: updated.replacesPath,
    replacesFileName: path.basename(updated.replacesPath),
    setAt: updated.setAt,
    onDisk: !!now && now.isFile,
    problem: updatedVideoFileProblem(itemId, updated, stat),
  };
}
