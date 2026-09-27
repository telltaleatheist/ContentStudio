/**
 * Video Source — which video file a report was made from, said in plain words.
 *
 * Every report starts from a video: the only way to make one is to hand the app a file,
 * and the run writes that file's path onto the item as `source_path`. So a report with no
 * path is not an ordinary state to offer a picker for — it is the app having lost track
 * of something it was given (Owen, 2026-09-26: "the only route to add a metadata report in
 * the first place is to provide a video ... the fact that its unlinked in the first place
 * is an error"). This module answers the Video row on the reports page, and it tells the
 * YouTube matcher which name and which file to go by.
 *
 * PURE: the filesystem is injected, so the rules are checked offline
 * (tools/routing-publish-checks.js).
 */
import * as path from 'path';

/** What the reports page's Video row says about the item's own source file. */
export interface VideoSource {
  /** The path the run recorded, or null when the report has lost track of it. */
  path: string | null;
  /** The file's own name, for display and for matching a YouTube draft title. */
  fileName: string | null;
  /** True when the recorded file is on disk right now. */
  onDisk: boolean;
  /**
   * A fault the operator has to know about: the report no longer says which video it came
   * from. null when the path is recorded. Shown amber, and logged by the caller.
   */
  problem: string | null;
  /**
   * The recorded file is not where the report says. Not a fault in the report — a drive
   * can be unplugged — but finding the YouTube upload then goes by the name alone.
   */
  notice: string | null;
}

/** The two facts the report reader carries about an item's source. */
export interface SourceFacts {
  sourcePath?: string | null;
  sourcePathDeclared?: boolean;
}

export function describeVideoSource(
  facts: SourceFacts,
  exists: (p: string) => boolean,
): VideoSource {
  const recorded = typeof facts.sourcePath === 'string' ? facts.sourcePath.trim() : '';
  if (!recorded) {
    return {
      path: null,
      fileName: null,
      onDisk: false,
      problem: facts.sourcePathDeclared
        ? 'This report has lost track of the video it was made from: its record says it had none.'
        : 'This report has lost track of the video it was made from: its record has no video path.',
      notice: null,
    };
  }
  const onDisk = exists(recorded);
  return {
    path: recorded,
    fileName: path.basename(recorded),
    onDisk,
    problem: null,
    notice: onDisk
      ? null
      : `The video is not at ${recorded} right now. If its drive is unplugged, plug it in.`,
  };
}

/**
 * The name the matcher goes by: the publish record's own sourceFilename when it has one
 * (it is null on every record today), else the name of the file the run recorded.
 */
export function matchFileName(recordName: string | null | undefined, source: VideoSource): string | null {
  if (typeof recordName === 'string' && recordName.trim()) return recordName;
  return source.fileName;
}

/**
 * Why the match is on the file name alone, or null when the video's length was read.
 * The length only VERIFIES a name match; without it the match says "unverified" rather
 * than failing, and this sentence says why.
 */
export function durationNote(source: VideoSource, probeError: string | null): string | null {
  if (!source.path) return null;
  if (!source.onDisk) return 'The video file is not on disk right now, so its length could not be compared.';
  if (probeError) return `The video's length could not be read (${probeError}), so it was not compared.`;
  return null;
}
