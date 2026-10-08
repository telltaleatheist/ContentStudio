/**
 * How a session's recordings are named beside its master, as the editor's source detection reads
 * them ('auto-detect-audio' in editor-ipc.ts). Lifted out of that handler on 2026-09-28 so the
 * Thumbnails tab finds a session's screen capture by the SAME rule the editor used to pick it for
 * processing, instead of a second pattern that agrees until the day one of them is changed.
 *
 * No Electron import: the Thumbnails tab's checks require this under plain Node.
 */
import * as fs from 'fs';
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

/**
 * An OBS set's camera, screen and game recordings each carry one mic or feed in their own audio
 * track, and Utility Suite extracts a lossless WAV for only some of them (mic audio, screen
 * audio). This is which audio source each recording role's sound is, read from the set's
 * manifest (LEDGER #275).
 */
const OBS_ROLE_AUDIO: { [role: string]: string } = {
  cam: 'mic1',
  cam2: 'mic2',
  screen: 'screen',
  game: 'game',
};

/**
 * The audio sources an OBS set carries only inside its video recordings, keyed by audio type
 * (`{ mic2: '/…/2026-10-08 cam 2.mp4' }`), from `<session> sync.json` beside the master: the
 * manifest Utility Suite writes, `"format": "obs-set"`, version 1, whose `files` list names each
 * present file's `role`. Returns null when there is no manifest (a vMix set).
 *
 * The caller fills a slot from this only when no WAV was detected for it, because the WAVs are
 * lossless and the recordings' audio is AAC.
 *
 * A manifest that cannot be read, is not an obs-set v1, or names a file that is not in the
 * folder is an error, never "no manifest": it would otherwise silently drop Mic 2.
 */
export function obsSetEmbeddedAudio(masterVideoPath: string): { [audioType: string]: string } | null {
  const { session } = sessionOfMaster(masterVideoPath);
  const dir = path.dirname(masterVideoPath);
  const manifestPath = path.join(dir, `${session} sync.json`);
  if (!fs.existsSync(manifestPath)) return null;

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (manifest?.format !== 'obs-set') {
    throw new Error(`${path.basename(manifestPath)} is not an OBS-set manifest (format is not "obs-set")`);
  }
  if (manifest.version !== 1) {
    throw new Error(`${path.basename(manifestPath)} is OBS-set manifest version ${manifest.version}; this build reads version 1 only`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${path.basename(manifestPath)} has no "files" list`);
  }

  const embedded: { [audioType: string]: string } = {};
  for (const entry of manifest.files) {
    const audioType = OBS_ROLE_AUDIO[entry?.role];
    if (!audioType) continue;
    const filePath = path.join(dir, String(entry.file));
    if (!fs.existsSync(filePath)) {
      throw new Error(`${path.basename(manifestPath)} lists "${entry.file}" (${entry.role}), which is not in ${dir}`);
    }
    embedded[audioType] = filePath;
  }
  return embedded;
}
