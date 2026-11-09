/**
 * The upload release switch — ONE app-wide answer to "how do the videos I upload next go
 * public?" (Owen, 2026-11-09):
 *
 *   "maybe we should have a switch that flips between private and unlisted for all videos.
 *    if i want to upload some as scheduled->public (which would be marked as private) then i
 *    upload that group, then i flip the switch, then i upload a new group. any video uploaded
 *    while the switch is set to scheduled->public are set to that. any that are uploaded as
 *    unlisted->public are set to that"
 *
 * So the choice moved off the item (the per-item buttons of LEDGER #335) and onto the
 * calendar, beside "Upload all ready". The upload copies the switch onto the record
 * (ChosenMetadata.releaseMode) before a byte goes up, and the item keeps that value: the
 * switch says how the NEXT uploads go, never how an uploaded one goes.
 *
 * ─── WHY A FILE OF ITS OWN ───
 *
 * It is an operator decision about publishing, like primary-sets.json, so it sits beside it
 * under publish/. It is not a setting of any one record and must not be one: a value copied
 * onto every record would be N answers to a question that has one.
 *
 * ─── NEVER SET, AND A BAD FILE ───
 *
 * No file means the switch was never flipped, and reads 'youtube-schedule': private with
 * YouTube's own publish time, which is what every upload did until the switch existed. That
 * is the answer the app has always given, not a guess standing in for a missing one.
 *
 * A file that is THERE but will not parse, or holds anything but one of the two names, is
 * refused by name. Reading it as "never set" would quietly upload a sponsor's video private
 * with a YouTube schedule after he had chosen unlisted. No fallbacks.
 *
 * Writes are one synchronous temp-and-rename, as primary-sets.json's are: nothing awaits in
 * between, so Node cannot interleave two of them.
 */

import * as fs from 'fs';
import * as path from 'path';
import { RELEASE_MODES, type ReleaseMode } from './publish-types';

export const UPLOAD_RELEASE_SWITCH_FILE = 'upload-release-switch.json';

/** What every upload did before the switch existed: private, with YouTube's own schedule. */
export const NEVER_SET_RELEASE_MODE: ReleaseMode = 'youtube-schedule';

const FILE_VERSION = 1;

export interface UploadReleaseSwitchState {
  mode: ReleaseMode;
  /** ISO. When it was last flipped, or null when it never has been (no file). */
  setAt: string | null;
}

export function isReleaseMode(value: unknown): value is ReleaseMode {
  return typeof value === 'string' && (RELEASE_MODES as readonly string[]).includes(value);
}

export class UploadReleaseSwitch {
  private readonly file: string;

  constructor(baseDir: string) {
    if (typeof baseDir !== 'string' || !baseDir.trim()) {
      throw new Error(`UploadReleaseSwitch requires a base directory; got ${JSON.stringify(baseDir)}`);
    }
    if (!fs.existsSync(baseDir)) fs.mkdirSync(baseDir, { recursive: true });
    this.file = path.join(baseDir, UPLOAD_RELEASE_SWITCH_FILE);
  }

  get filePath(): string {
    return this.file;
  }

  /** The switch as it stands. Throws, naming the file, when the file is there and bad. */
  read(): UploadReleaseSwitchState {
    if (!fs.existsSync(this.file)) return { mode: NEVER_SET_RELEASE_MODE, setAt: null };
    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(this.file, 'utf8'));
    } catch (err) {
      throw new Error(
        `${this.file} could not be read: ${err instanceof Error ? err.message : String(err)}. ` +
          `It says whether uploads go private on YouTube's schedule or unlisted first, so nothing ` +
          `is uploaded until it is readable. Flip the calendar's upload switch to write it again.`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.file} does not contain the upload release switch. Nothing is uploaded until it does.`);
    }
    const file = parsed as { version?: unknown; mode?: unknown; setAt?: unknown };
    if (file.version !== FILE_VERSION) {
      throw new Error(
        `${this.file} is version ${JSON.stringify(file.version)}; this build reads version ${FILE_VERSION}. ` +
          `Nothing is uploaded until it is readable.`
      );
    }
    if (!isReleaseMode(file.mode)) {
      throw new Error(
        `${this.file} holds ${JSON.stringify(file.mode)} as the upload release mode; it must be one of ` +
          `${RELEASE_MODES.join(', ')}. Nothing is uploaded until it is one of them.`
      );
    }
    if (typeof file.setAt !== 'string' || Number.isNaN(Date.parse(file.setAt))) {
      throw new Error(`${this.file} has no valid setAt (${JSON.stringify(file.setAt)}). Nothing is uploaded until it does.`);
    }
    return { mode: file.mode, setAt: file.setAt };
  }

  /** Flip it. Refuses anything but the two names. */
  set(mode: unknown, now: Date): UploadReleaseSwitchState {
    if (!isReleaseMode(mode)) {
      throw new Error(`The upload release switch must be one of ${RELEASE_MODES.join(', ')}; got ${JSON.stringify(mode)}.`);
    }
    const state = { mode, setAt: now.toISOString() };
    const tmp = `${this.file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify({ version: FILE_VERSION, ...state }, null, 2), 'utf8');
    fs.renameSync(tmp, this.file); // never leave a half-written switch
    return state;
  }
}
