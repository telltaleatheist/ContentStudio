/**
 * The shapes the Thumbnails window and the Thumbnail look read from the main process (phase 2,
 * 2026-09-28). They mirror electron/services/thumbnails/pipeline-record.ts (the stored record),
 * report-thumbnails.ts (the window's view) and look.ts (the one look); change them together.
 */

export type ThumbnailsAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

export type WordKind = 'claim' | 'stakes' | 'reaction';
export const WORD_KINDS: readonly WordKind[] = ['claim', 'stakes', 'reaction'];

/** A ranked photo, in records made before 2026-09-29 (the model's ranking; Owen picks photos now). */
export interface Ranked {
  name: string;
  p: number | null;
}

/** Records before 2026-09-29: how a photo was drawn from the ranking's top 3. */
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
  /** Owen's frame pick for this place (or screenshot n); null: no frame picked yet, not drawn. */
  frameId: string | null;
  scene: number | null;
  kind: WordKind | null;
  phrase: string | null;
  /** The title the words were written for; null for typed words or no text; absent in older records. */
  wordsFor?: string | null;
  /** The reaction photo Owen picked, or null for none. */
  photo: string | null;
  draw: PhotoDraw | null;
  logo: boolean;
  render: StoredRender;
}

export interface StoredPair {
  pair: number;
  title: string;
  words: { claim: string[]; stakes: string[]; reaction: string[]; warnings: string[]; model: string };
  /** Records before 2026-09-29 only (the model's ranking); empty now. */
  photos: Ranked[];
  rankedFor?: string | null;
  default: StoredDefault;
  lines: string[];
}

/** A grid frame. Records made before 2026-09-29 also carry the frame scoring's score/reading/flag (ignored). */
export interface StoredFrame {
  id: string;
  t: number;
  clock: string;
  scene: number;
  large: string;
  small: string;
}

export type ThumbnailPick =
  | { kind: 'made'; pair: number; file: string; wordsFor: string }
  | { kind: 'own'; file: string };

export type ThumbnailsState = 'made' | 'no-story' | 'off' | 'failed';

export interface ItemThumbnails {
  version: 1;
  state: ThumbnailsState;
  line: string;
  failure: { stage: RecordedStage; reason: string } | null;
  story:
    | { state: 'linked'; method: string; line: string }
    | { state: 'none'; reason: string }
    | null;
  folder: string | null;
  source: { video: string | null; lines: string[] } | null;
  scenes: Array<{ number: number; seconds: number; label: string; kept: number; shown?: number }>;
  /** The grid's frames, in time order. Older records' `bestScenes` and `scoring` are ignored. */
  frames: StoredFrame[];
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

export type ThumbnailStage = 'story' | 'frames' | 'words' | 'render';
/**
 * A stage an older record can name: `tone-photos` (the model's photo ranking) and `scoring` (the
 * vision model's frame ranking) were removed 2026-09-29.
 */
export type RecordedStage = ThumbnailStage | 'tone-photos' | 'scoring';

export interface FinishView {
  stage: RecordedStage;
  /** The stage it stopped at has since been removed, so its old reason is not shown. */
  retired: boolean;
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
  photos: Array<{ name: string; preview: string }>;
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
  /** A photo name from the library, or null for none. */
  photo?: string | null;
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
  /** Owen's border overlay over the picture (when a border file is kept); replaced the vignette 2026-09-29. */
  border: boolean;
  reactionSlot: LookSlot;
  reactionOutlinePx: number;
  reactionBleed: number;
  logoSlot: LookSlot;
  minCapFraction: number;
  maxCapFraction: number;
  /** The words drawn at this fraction of the largest size that fits (0.85 by default since 2026-09-29). */
  textScale: number;
}

export interface LookPhotos {
  folder: string;
  photos: Array<{ name: string; preview: string; trim: string | null }>;
  offer: { from: string; count: number } | null;
}

export interface LookLogo {
  logo: { file: string; name: string; width: number; height: number; preview: string } | null;
  offer: { from: string } | null;
}

export interface LookBorder {
  border: { file: string; name: string; width: number; height: number; preview: string } | null;
}

export interface LookAddPhotos {
  chosen: string[];
  added: string[];
  replaced: string[];
  already: string[];
}
