/**
 * Mute words (LEDGER #226) — the main-process half: the word list the modal shows, and each
 * project's saved choice.
 *
 * The word groups live in ONE data file, `editor-backend/core/mute_words.json`, which the
 * Python pass (`core/word_mutes.py`) matches with. This module only READS it and hands it to the
 * modal, so what the modal says a group covers is exactly what gets muted.
 *
 * A project's choice is `<cleanName>_mute-words.json` in the project folder — beside the
 * `_compounds.zip`, `_edits.json` and `_transcript.json` it belongs with, so it travels with the
 * project and survives a re-process (it is a choice, not timeline state). The last choice saved
 * for any project is remembered in the config directory as the starting point for new ones.
 *
 * Pure on purpose (no electron import): the paths it needs are passed in, so the offline check
 * (tools/word-mute-checks.js) drives this exact code. `validateMuteSettings` mirrors
 * `core/word_mutes.validate_settings`; that check runs both over the same inputs (Law 10).
 */

import * as fs from 'fs';
import * as path from 'path';

export type MuteMode = 'off' | 'everywhere' | 'opening';

export interface MuteGroup {
  readonly id: string;
  readonly label: string;
  /** A transcript word containing any of these is in the group. */
  readonly contains: readonly string[];
  /** A transcript word equal to one of these (or to one of its hyphen parts) is in the group. */
  readonly exact: readonly string[];
}

export interface MuteCatalog {
  readonly groups: readonly MuteGroup[];
  /** Mirrors core/word_mutes.py — shown in the modal so the numbers are never a mystery. */
  readonly padMs: number;
  readonly defaultMinutes: number;
  readonly maxMinutes: number;
}

export interface MuteSettings {
  schemaVersion: 1;
  groups: Record<string, MuteMode>;
  customWords: string[];
  customMode: MuteMode;
  openingWindow: { allSwearing: boolean; minutes: number };
}

export const MUTE_MODES: readonly MuteMode[] = ['off', 'everywhere', 'opening'];
export const CUSTOM_GROUP_ID = 'custom';
/** core/word_mutes.py MUTE_PAD_SECONDS, DEFAULT_WINDOW_MINUTES, MAX_WINDOW_MINUTES. */
export const PAD_MS = 50;
export const DEFAULT_WINDOW_MINUTES = 3;
export const MAX_WINDOW_MINUTES = 600;

const DEFAULT_FILE = 'mute-words-default.json';

function norm(w: string): string {
  return w.toLowerCase().replace(/[‘’]/g, "'")
    .replace(/^[\s.,!?;:"'()[\]{}<>*_~`“”…]+|[\s.,!?;:"'()[\]{}<>*_~`“”…]+$/g, '');
}

/** The word list, validated as the Python side validates it. A broken shipped file throws. */
export function readMuteCatalog(catalogPath: string): MuteCatalog {
  let data: any;
  try {
    data = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
  } catch (e: any) {
    throw new Error(`The word list ${catalogPath} cannot be read: ${e?.message || e}`);
  }
  const groups = data?.muteGroups;
  if (!Array.isArray(groups) || groups.length === 0) throw new Error(`The word list ${catalogPath} has no muteGroups`);
  const seen = new Set<string>();
  const out: MuteGroup[] = groups.map((g: any) => {
    const id = g?.id;
    if (typeof id !== 'string' || !id || id === CUSTOM_GROUP_ID || seen.has(id)) {
      throw new Error(`The word list ${catalogPath} has a group with a missing, reserved or repeated id: ${JSON.stringify(id)}`);
    }
    seen.add(id);
    const lists = [g.contains ?? [], g.exact ?? []];
    for (const l of lists) {
      if (!Array.isArray(l) || !l.every((w: unknown) => typeof w === 'string' && w !== '' && norm(w) === w)) {
        throw new Error(`The word list ${catalogPath}: group ${id} must list lowercase words with no surrounding punctuation`);
      }
    }
    if (typeof g.label !== 'string' || !g.label) throw new Error(`The word list ${catalogPath}: group ${id} has no label`);
    if (lists[0].length + lists[1].length === 0) throw new Error(`The word list ${catalogPath}: group ${id} lists no words`);
    return { id, label: g.label, contains: [...lists[0]], exact: [...lists[1]] };
  });
  return { groups: out, padMs: PAD_MS, defaultMinutes: DEFAULT_WINDOW_MINUTES, maxMinutes: MAX_WINDOW_MINUTES };
}

/** The starting point when nothing was ever saved anywhere: everything off, a 3-minute window. */
export function blankMuteSettings(catalog: MuteCatalog): MuteSettings {
  const groups: Record<string, MuteMode> = {};
  for (const g of catalog.groups) groups[g.id] = 'off';
  return { schemaVersion: 1, groups, customWords: [], customMode: 'off',
           openingWindow: { allSwearing: false, minutes: DEFAULT_WINDOW_MINUTES } };
}

/** The same rules as core/word_mutes.validate_settings. Throws with the reason; returns the value. */
export function validateMuteSettings(data: any, catalog: MuteCatalog, label = 'Mute words settings'): MuteSettings {
  const bad = (why: string): never => { throw new Error(`${label}: ${why}`); };
  if (!data || typeof data !== 'object' || Array.isArray(data)) bad('not an object');
  if (data.schemaVersion !== 1) bad(`schemaVersion ${JSON.stringify(data.schemaVersion)} is not 1`);
  const groups = data.groups;
  if (!groups || typeof groups !== 'object' || Array.isArray(groups)) bad("'groups' is not an object");
  const ids = catalog.groups.map((g) => g.id);
  for (const k of Object.keys(groups)) if (!ids.includes(k)) bad(`group ${k} is not in the word list`);
  for (const id of ids) {
    if (!(id in groups)) bad(`no choice saved for the ${id} group — open Mute words and save again`);
    if (!MUTE_MODES.includes(groups[id])) bad(`group ${id} is ${JSON.stringify(groups[id])}, expected off / everywhere / opening`);
  }
  if (!Array.isArray(data.customWords) || !data.customWords.every((w: unknown) => typeof w === 'string')) {
    bad("'customWords' is not a list of words");
  }
  for (const w of data.customWords) if (!norm(w.replace(/\*/g, ''))) bad(`custom word ${JSON.stringify(w)} has no letters in it`);
  if (!MUTE_MODES.includes(data.customMode)) bad(`'customMode' is ${JSON.stringify(data.customMode)}`);
  const win = data.openingWindow;
  if (!win || typeof win !== 'object' || typeof win.allSwearing !== 'boolean') bad("'openingWindow.allSwearing' is not true/false");
  const m = win.minutes;
  if (typeof m !== 'number' || !Number.isFinite(m) || m <= 0 || m > MAX_WINDOW_MINUTES) {
    bad(`'openingWindow.minutes' must be a number above 0 and at most ${MAX_WINDOW_MINUTES}`);
  }
  return data as MuteSettings;
}

/** `<folder>/<cleanName>_mute-words.json`. cleanName is the scan's (no separators allowed). */
export function projectMuteSettingsPath(folder: string, cleanName: string): string {
  if (typeof folder !== 'string' || !folder.trim()) throw new Error('Mute words needs the project folder');
  if (typeof cleanName !== 'string' || !cleanName.trim() || /[\\/]/.test(cleanName)) {
    throw new Error(`Mute words needs the project's session name, got ${JSON.stringify(cleanName)}`);
  }
  return path.join(folder, `${cleanName}_mute-words.json`);
}

function readJson(p: string): any {
  try {
    return JSON.parse(fs.readFileSync(p, 'utf8'));
  } catch (e: any) {
    throw new Error(`${path.basename(p)} cannot be read: ${e?.message || e} — fix or delete it`);
  }
}

function writeJsonAtomic(p: string, value: unknown): void {
  const tmp = `${p}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), 'utf8');
  fs.renameSync(tmp, p);
}

/**
 * The project's choice, or — when it has none — the remembered default (or blank), marked
 * `saved: false` so the modal can say "not saved for this project yet". A saved file that does
 * not validate THROWS: it is never silently replaced by the default.
 */
export function loadProjectMuteSettings(
  catalog: MuteCatalog, folder: string, cleanName: string, configDir: string
): { settings: MuteSettings; saved: boolean; source: 'project' | 'remembered' | 'blank' } {
  const p = projectMuteSettingsPath(folder, cleanName);
  if (fs.existsSync(p)) return { settings: validateMuteSettings(readJson(p), catalog, path.basename(p)), saved: true, source: 'project' };
  const d = path.join(configDir, DEFAULT_FILE);
  if (fs.existsSync(d)) {
    let remembered: MuteSettings | null = null;
    try {
      remembered = validateMuteSettings(readJson(d), catalog, DEFAULT_FILE);
    } catch (e: any) {
      // The remembered default is a convenience, but a broken one is still said out loud: the
      // modal shows this message instead of pretending the blank settings were remembered.
      throw new Error(`The remembered Mute words default is unusable (${e?.message || e}). Save a choice in Mute words to replace it.`);
    }
    return { settings: remembered, saved: false, source: 'remembered' };
  }
  return { settings: blankMuteSettings(catalog), saved: false, source: 'blank' };
}

/** Save the project's choice, and remember it as the starting point for new projects. */
export function saveProjectMuteSettings(
  catalog: MuteCatalog, folder: string, cleanName: string, configDir: string, settings: unknown
): { path: string } {
  const valid = validateMuteSettings(settings, catalog);
  const clean: MuteSettings = {
    schemaVersion: 1,
    groups: Object.fromEntries(catalog.groups.map((g) => [g.id, valid.groups[g.id]])),
    customWords: valid.customWords.map((w) => w.trim()).filter((w) => w !== ''),
    customMode: valid.customMode,
    openingWindow: { allSwearing: valid.openingWindow.allSwearing, minutes: valid.openingWindow.minutes },
  };
  if (!fs.existsSync(folder)) throw new Error(`Project folder not found: ${folder}`);
  const p = projectMuteSettingsPath(folder, cleanName);
  writeJsonAtomic(p, clean);
  fs.mkdirSync(configDir, { recursive: true });
  writeJsonAtomic(path.join(configDir, DEFAULT_FILE), clean);
  return { path: p };
}

/**
 * Give a project the remembered choice if it has none of its own yet — called when a run is
 * started, so what the setup modal's summary showed is what the project keeps. Never overwrites.
 */
export function ensureProjectMuteSettings(
  catalog: MuteCatalog, folder: string, cleanName: string, configDir: string
): { settings: MuteSettings; wrote: boolean } {
  const loaded = loadProjectMuteSettings(catalog, folder, cleanName, configDir);
  if (loaded.saved) return { settings: loaded.settings, wrote: false };
  writeJsonAtomic(projectMuteSettingsPath(folder, cleanName), loaded.settings);
  return { settings: loaded.settings, wrote: true };
}
