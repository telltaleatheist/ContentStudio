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
 * A set's `<session> sync.json`, the manifest Utility Suite writes (`"format": "obs-set"`,
 * version 1 or 2), or null when there is none (a vMix set). Anything else at that name is an
 * error, never "no manifest": it would otherwise silently drop Mic 2.
 */
function readObsManifest(masterVideoPath: string): { manifest: any; manifestName: string; dir: string; session: string } | null {
  const { session } = sessionOfMaster(masterVideoPath);
  const dir = path.dirname(masterVideoPath);
  const manifestPath = path.join(dir, `${session} sync.json`);
  if (!fs.existsSync(manifestPath)) return null;
  const manifestName = path.basename(manifestPath);

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf-8'));
  if (manifest?.format !== 'obs-set') {
    throw new Error(`${manifestName} is not an OBS-set manifest (format is not "obs-set")`);
  }
  if (manifest.version !== 1 && manifest.version !== 2) {
    throw new Error(`${manifestName} is OBS-set manifest version ${manifest.version}; this build reads versions 1 and 2`);
  }
  if (!Array.isArray(manifest.files)) {
    throw new Error(`${manifestName} has no "files" list`);
  }
  return { manifest, manifestName, dir, session };
}

/**
 * The audio sources an OBS set carries only inside its video recordings, keyed by audio type
 * (`{ mic2: '/…/2026-10-08 cam 2.mp4' }`), from the set's manifest, whose `files` list names
 * each present file's `role`. Returns null when there is no manifest (a vMix set).
 *
 * The caller fills a slot from this only when no WAV was detected or planned for it, because
 * the WAVs are lossless and the recordings' audio is AAC.
 *
 * A manifest that names a recording that is not in the folder is an error.
 */
export function obsSetEmbeddedAudio(masterVideoPath: string): { [audioType: string]: string } | null {
  const read = readObsManifest(masterVideoPath);
  if (!read) return null;
  const { manifest, manifestName, dir } = read;

  const embedded: { [audioType: string]: string } = {};
  for (const entry of manifest.files) {
    const audioType = OBS_ROLE_AUDIO[entry?.role];
    if (!audioType) continue;
    const filePath = path.join(dir, String(entry.file));
    if (!fs.existsSync(filePath)) {
      throw new Error(`${manifestName} lists "${entry.file}" (${entry.role}), which is not in ${dir}`);
    }
    embedded[audioType] = filePath;
  }
  return embedded;
}

/**
 * What a program-recording track holds (the manifest's "audio" label) -> the audio slot it fills
 * and the WAV it becomes, named as the vMix-era files were. The run writes these files
 * (editor-backend/core/obs_program_audio.py, PROGRAM_TRACK_WAVS); the two tables must agree.
 * "on-air mix" and "everything merged" fill no slot: nothing takes a master mix as a source.
 */
const PROGRAM_TRACK_WAVS: { [label: string]: { audioType: string; wav: string } } = {
  'Mic 1': { audioType: 'mic1', wav: 'mic audio' },
  'Mic 2': { audioType: 'mic2', wav: 'mic 2 audio' },
  'Mac': { audioType: 'screen', wav: 'screen audio' },
  'game': { audioType: 'game', wav: 'game audio' },
};
const PROGRAM_TRACKS_NOT_EXTRACTED = new Set(['on-air mix', 'everything merged']);

/**
 * The WAVs of an OBS set of manifest version 2, keyed by audio type
 * (`{ mic1: '/…/2026-10-11 2 mic audio.wav' }`). Version 2 delivers no WAVs: they are the
 * lossless PCM tracks of `<session> program.mkv`, which the processing run extracts at its
 * start into these paths. They need not exist yet. Returns null for a set without a version-2
 * manifest.
 *
 * A WAV not on disk needs the program recording, so its absence is an error here rather than
 * at the end of a long wait; so is a track label this table does not know.
 */
export function obsSetProgramAudio(masterVideoPath: string): { [audioType: string]: string } | null {
  const read = readObsManifest(masterVideoPath);
  if (!read || read.manifest.version !== 2) return null;
  const { manifest, manifestName, dir, session } = read;

  const programs = manifest.files.filter((e: any) => e?.role === 'program');
  if (programs.length !== 1) {
    throw new Error(`${manifestName} is version 2 but lists ${programs.length} program recordings, not one; the set's WAVs come from it`);
  }
  const program = programs[0];
  if (!Array.isArray(program.tracks) || program.tracks.length === 0) {
    throw new Error(`${manifestName} lists "${program.file}" without its "tracks"`);
  }

  const planned: { [audioType: string]: string } = {};
  for (const track of program.tracks) {
    if (PROGRAM_TRACKS_NOT_EXTRACTED.has(track?.audio)) continue;
    const target = PROGRAM_TRACK_WAVS[track?.audio];
    if (!target) {
      throw new Error(`${manifestName}: program track ${track?.track} holds "${track?.audio}", which this build does not know how to name`);
    }
    planned[target.audioType] = path.join(dir, `${session} ${target.wav}.wav`);
  }

  const programPath = path.join(dir, String(program.file));
  const unmade = Object.values(planned).filter(p => !fs.existsSync(p));
  if (unmade.length > 0 && !fs.existsSync(programPath)) {
    throw new Error(`"${program.file}" is not in ${dir}. This OBS set's WAVs are taken from it, and ${unmade.length} of them are not made yet.`);
  }
  return planned;
}
