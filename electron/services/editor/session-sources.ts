/**
 * How a session's recordings are named beside its master, as the editor's source detection reads
 * them ('auto-detect-audio' in editor-ipc.ts). Lifted out of that handler on 2026-09-28 so the
 * Thumbnails tab finds a session's screen capture by the SAME rule the editor used to pick it for
 * processing, instead of a second pattern that agrees until the day one of them is changed.
 *
 * No Electron import: the Thumbnails tab's checks require this under plain Node.
 */
import * as path from 'path';

/**
 * The session prefix of a master's file name: everything before " master"
 * ("2025-11-23 4 master" -> "2025-11-23 4"), or the whole name when it has no such suffix.
 */
export function sessionOfMaster(masterVideoPath: string): { session: string; fromMasterSuffix: boolean } {
  const masterFilename = path.basename(masterVideoPath, path.extname(masterVideoPath));
  const masterWordMatch = masterFilename.match(/^(.+?)\s+master$/i);
  return masterWordMatch
    ? { session: masterWordMatch[1].trim(), fromMasterSuffix: true }
    : { session: masterFilename, fromMasterSuffix: false };
}

/**
 * The video recordings' name patterns for one session (keys use camelCase to match the editor's
 * frontend types).
 *
 * A capture recorded in one go has no number; one that was stopped and restarted is written as
 * "... screen capture 1.mp4", "... 2.mp4", so the unnumbered and the "1" form both mean the FIRST
 * part. Parts 2 and 3 are matched separately and become continuation sources, which the workflow
 * splices onto part 1 before anything else looks at them.
 */
export function sessionVideoPatterns(session: string): { [key: string]: RegExp } {
  const escapedSession = session.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return {
    'cam1': new RegExp(`^${escapedSession}\\s+cam\\.(mp4|mov|avi|mkv)$`, 'i'),
    'cam2': new RegExp(`^${escapedSession}\\s+cam\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
    'screenVideo': new RegExp(`^${escapedSession}\\s+screen\\s*capture(\\s*1)?\\.(mp4|mov|avi|mkv)$`, 'i'),
    'gameVideo': new RegExp(`^${escapedSession}\\s+game\\s*capture(\\s*1)?\\.(mp4|mov|avi|mkv)$`, 'i'),
    'screenVideo2': new RegExp(`^${escapedSession}\\s+screen\\s*capture\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
    'screenVideo3': new RegExp(`^${escapedSession}\\s+screen\\s*capture\\s*3\\.(mp4|mov|avi|mkv)$`, 'i'),
    'gameVideo2': new RegExp(`^${escapedSession}\\s+game\\s*capture\\s*2\\.(mp4|mov|avi|mkv)$`, 'i'),
    'gameVideo3': new RegExp(`^${escapedSession}\\s+game\\s*capture\\s*3\\.(mp4|mov|avi|mkv)$`, 'i'),
  };
}
