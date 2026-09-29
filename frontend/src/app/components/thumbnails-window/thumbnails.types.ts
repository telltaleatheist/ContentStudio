/**
 * The shapes the Thumbnails window and the Thumbnail look read from the main process (phase 2,
 * 2026-09-28). They mirror electron/services/thumbnails/pipeline-record.ts (the stored record),
 * report-thumbnails.ts (the window's view) and look.ts (the one look); change them together.
 */

export type ThumbnailsAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

export type WordKind = 'claim' | 'stakes' | 'reaction';
export const WORD_KINDS: readonly WordKind[] = ['claim', 'stakes', 'reaction'];

export interface Ranked {
  name: string;
  p: number | null;
}

export interface PhotoDraw {
  name: string;
  p: number;
  chance: number;
  pool: Ranked[];
  repeatForced: boolean;
}

export type StoredRender =
  | { ok: true; file: string; format: 'png' | 'jpeg'; bytes: number; notes: string[] }
  | { ok: false; reason: string };

export interface StoredDefault {
  frameId: string;
  scene: number;
  kind: WordKind | null;
  phrase: string | null;
  /** The title the words were written for; null for typed words or no text; absent in older records. */
  wordsFor?: string | null;
  photo: string | null;
  draw: PhotoDraw | null;
  logo: boolean;
  render: StoredRender;
}

export interface StoredPair {
  pair: number;
  title: string;
  words: { claim: string[]; stakes: string[]; reaction: string[]; warnings: string[]; model: string };
  photos: Ranked[];
  rankedFor?: string | null;
  default: StoredDefault;
  lines: string[];
}

export interface StoredFrame {
  id: string;
  t: number;
  clock: string;
  scene: number;
  large: string;
  small: string;
  score: number | null;
  flag: 'screen' | 'unreadable' | null;
}

export interface SceneRow {
  scene: number;
  ids: string[];
  more: string[];
  best: number;
}

export type ThumbnailPick =
  | { kind: 'made'; pair: number; file: string; wordsFor: string }
  | { kind: 'own'; file: string };

export type ThumbnailsState = 'made' | 'no-story' | 'off' | 'failed';

export interface ItemThumbnails {
  version: 1;
  state: ThumbnailsState;
  line: string;
  failure: { stage: ThumbnailStage; reason: string } | null;
  story:
    | { state: 'linked'; method: string; line: string }
    | { state: 'none'; reason: string }
    | null;
  folder: string | null;
  source: { video: string | null; lines: string[] } | null;
  scenes: Array<{ number: number; seconds: number; label: string; kept: number; scored: number }>;
  frames: StoredFrame[];
  bestScenes: SceneRow[];
  scoring: { server: string; model: string; line: string } | null;
  titles: { order: string; subjects: string[] } | null;
  tone: { ranking: Ranked[]; model: string; server: string } | null;
  pairs: StoredPair[];
  seed: number | null;
  logo: string | null;
  lines: string[];
  picks: ThumbnailPick[];
}

export interface PickView {
  n: number;
  pick: ThumbnailPick;
  copy: string;
  picture: string;
}

export interface ThumbnailsSummary {
  state: ThumbnailsState | null;
  line: string | null;
  canOpen: boolean;
  picks: PickView[];
  picksFolder: string | null;
  publishFile: string | null;
}

export type ThumbnailStage = 'story' | 'frames' | 'scoring' | 'words' | 'tone-photos' | 'render';

export interface FinishView {
  stage: ThumbnailStage;
  reason: string;
  keep: ThumbnailStage[];
  run: ThumbnailStage[];
  blocked: string | null;
}

export interface ThumbnailsView extends ThumbnailsSummary {
  jobId: string;
  itemId: string;
  title: string;
  record: ItemThumbnails | null;
  titles: string[];
  renders: Record<string, string>;
  frames: Record<string, string>;
  photos: Array<{ name: string; preview: string; note: string | null }>;
  hasLogo: boolean;
  heldModel: string | null;
  finish: FinishView | null;
  remake: { blocked: string | null } | null;
}

export interface PairChange {
  pair: number;
  frameId?: string;
  phrase?: string | null;
  kind?: WordKind | null;
  wordsFor?: string | null;
  photo?: string | null | 'draw';
  rankingOf?: number;
  logo?: boolean;
}

export type PickRequest = { kind: 'made'; pair: number } | { kind: 'own'; file: string };

export interface ThumbnailsProgress {
  jobId: string;
  itemId: string;
  line: string;
}

// ── the look ─────────────────────────────────────────────────────────────────

export interface LookSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface LookStyle {
  font: string;
  fill: string;
  stroke: string;
  strokeRatio: number;
  patch: boolean;
  patchDarken: number;
  vignette: boolean;
  vignetteStrength: number;
  reactionSlot: LookSlot;
  reactionOutlinePx: number;
  reactionBleed: number;
  logoSlot: LookSlot;
  minCapFraction: number;
  maxCapFraction: number;
}

export interface LookPhotos {
  folder: string;
  photos: Array<{ name: string; preview: string; trim: string | null; note: string | null; draft: boolean }>;
  offer: { from: string; count: number } | null;
}

export interface LookLogo {
  logo: { file: string; name: string; width: number; height: number; preview: string } | null;
  offer: { from: string } | null;
}

export interface LookAddPhotos {
  chosen: string[];
  added: string[];
  replaced: string[];
  already: string[];
}
