/**
 * Mute words (LEDGER #226) — the renderer's types and the one-line summary.
 *
 * The word groups themselves are NOT here: they come from `editor-backend/core/mute_words.json`
 * through the main process (`editor:mute-words-catalog`), the same file the Python pass matches
 * with. These types mirror `electron/services/editor/mute-words.ts`.
 */

export type MuteMode = 'off' | 'everywhere' | 'opening';

export interface MuteGroup {
  id: string;
  label: string;
  contains: string[];
  exact: string[];
}

export interface MuteCatalog {
  groups: MuteGroup[];
  padMs: number;
  defaultMinutes: number;
  maxMinutes: number;
}

export interface MuteSettings {
  schemaVersion: 1;
  groups: Record<string, MuteMode>;
  customWords: string[];
  customMode: MuteMode;
  openingWindow: { allSwearing: boolean; minutes: number };
}

export interface MuteSettingsLoad {
  settings: MuteSettings;
  /** False = the project has no saved choice yet; `settings` is the remembered default (or blank). */
  saved: boolean;
  source: 'project' | 'remembered' | 'blank';
}

/** One word the pass did not mute, and why (cli/word_mute_pass.py _report). */
export interface WordMuteMiss {
  word: string;
  at: string | null;
  seconds: number | null;
  track: string;
  kind: 'failed' | 'cut' | 'switched-off';
  why: string;
}

/** The pass's report. `active: false` carries only `reason` (and `removedOld` on Apply). */
export interface WordMuteReport {
  active: boolean;
  reason?: string;
  matches?: number;
  muted?: number;
  leftByChoice?: number;
  mutesWritten?: number;
  clips?: number;
  removedOld?: number;
  groups?: Record<string, { label: string; found: number; muted: number }>;
  notMuted?: WordMuteMiss[];
}

/** "3:00" style for a minutes value (2.5 -> "2:30"). */
export function windowClock(minutes: number): string {
  const total = Math.round(minutes * 60);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, '0')}`;
}

/** Owen's own words as typed: commas or new lines between them, blanks dropped. */
export function parseCustomWords(text: string): string[] {
  return text.split(/[,\n]/).map((w) => w.trim()).filter((w) => w !== '');
}

/**
 * The one-line summary shown next to the "Mute words…" buttons, e.g.
 * "F-word everywhere; all swearing in the first 3:00". "Nothing muted" when nothing is on.
 */
export function muteSummary(settings: MuteSettings, catalog: MuteCatalog): string {
  const win = windowClock(settings.openingWindow.minutes);
  const every: string[] = [];
  const opening: string[] = [];
  const hasCustom = settings.customWords.length > 0;
  for (const g of catalog.groups) {
    const m = settings.groups[g.id];
    if (m === 'everywhere') every.push(g.label);
    if (m === 'opening') opening.push(g.label);
  }
  if (hasCustom && settings.customMode === 'everywhere') every.push('your words');
  if (hasCustom && settings.customMode === 'opening') opening.push('your words');
  const parts: string[] = [];
  if (every.length) parts.push(`${every.join(', ')} everywhere`);
  if (settings.openingWindow.allSwearing) parts.push(`all swearing in the first ${win}`);
  else if (opening.length) parts.push(`${opening.join(', ')} in the first ${win}`);
  return parts.length ? parts.join('; ') : 'Nothing muted';
}
