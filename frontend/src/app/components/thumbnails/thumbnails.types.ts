// The Thumbnails tab's shapes, as the main process sends them (electron/services/thumbnails/
// lab-service.ts). Kept beside the tab, since nothing else in the app reads them.

export type ThumbsAnswer<T> = { ok: true; value: T } | { ok: false; error: string };

export interface ThumbsItem {
  jobId: string;
  itemId: string;
  title: string;
  createdAt: string;
  sourcePath: string | null;
  titles: string[];
  promptSet: string | null;
  hasTranscript: boolean;
  reportFolder: string | null;
  problem: string | null;
}

/** The item's editor-story link (lab-service.ts LabStoryLink). */
export interface ThumbsStoryLink {
  storyTitle: string;
  storyNumber: number;
  session: string;
  projectFolder: string;
  from: 'saved' | 'run';
}

export interface ThumbsStoryChoice {
  projectFolder: string;
  session: string;
  number: number;
  title: string;
  slug: string;
  why: string | null;
}

export interface ThumbsStoryState {
  link: ThumbsStoryLink | null;
  choices: ThumbsStoryChoice[];
  searched: string;
  problems: string[];
}

export interface ThumbsReading {
  pScreen: number;
  pFace: number;
  expression: number;
  pEyesOpen: number;
  pStrong: number;
}

export interface ThumbsFrame {
  id: string;
  t: number;
  clock: string;
  small: string;
  score: number | null;
  reading: ThumbsReading | null;
  flag: 'screen' | 'unreadable' | null;
  /** The scene the frame belongs to (1-based, by first appearance). */
  scene: number;
}

export interface ThumbsScene {
  number: number;
  seconds: number;
  /** "Scene 3 · 2:41 on screen". */
  label: string;
  kept: number;
  scoring: number;
}

/** One row of the best view: a scene's best frames, best first. */
export interface ThumbsSceneRow {
  scene: number;
  ids: string[];
  best: number;
}

export interface ThumbsRun {
  runId: string;
  itemId: string;
  video: string;
  start: number;
  end: number;
  lines: string[];
  frames: ThumbsFrame[];
  toScore: string[];
  scenes: ThumbsScene[];
  bestScenes: ThumbsSceneRow[] | null;
  scoring: { server: string; model: string; line: string } | null;
}

export type ThumbsWordKind = 'claim' | 'stakes' | 'reaction';

export interface ThumbsWords {
  claim: string[];
  stakes: string[];
  reaction: string[];
  warnings: string[];
  model: string;
}

export interface ThumbsSlot {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface ThumbsStyle {
  font: string;
  fill: string;
  stroke: string;
  strokeRatio: number;
  patch: boolean;
  patchDarken: number;
  vignette: boolean;
  vignetteStrength: number;
  reactionSlot: ThumbsSlot;
  reactionOutlinePx: number;
  reactionBleed: number;
  logoSlot: ThumbsSlot;
  minCapFraction: number;
  maxCapFraction: number;
}

export interface ThumbsVariantRequest {
  letter: string;
  frameId: string;
  phrase: string | null;
  kind: ThumbsWordKind | null;
  /** A reaction photo's name ("oh please"), or null for none. */
  photo: string | null;
}

export interface ThumbsPhoto {
  name: string;
  preview: string;
  /** A sentence when the trim dropped specks, else null. */
  trim: string | null;
  /** Owen's note, or the draft (draft: true), or null for none. */
  note: string | null;
  draft: boolean;
}

export interface ThumbsPhotos {
  folder: string | null;
  photos: ThumbsPhoto[];
}

export interface ThumbsRanked {
  name: string;
  p: number | null;
}

export interface ThumbsSuggestion {
  tone: ThumbsRanked[];
  photos: Record<string, ThumbsRanked[]>;
  line: string;
}

export interface ThumbsWordPick {
  phrase: string | null;
  kind: ThumbsWordKind | null;
}

export type ThumbsPiece = 'frame' | 'text' | 'photo';
export type ThumbsCombineMode = { mode: 'best' } | { mode: 'test'; vary: ThumbsPiece };

export interface ThumbsVariant {
  letter: string;
  frameId: string;
  text: ThumbsWordPick;
  photo: string | null;
}

export type ThumbsCombineResult = { ok: true; variants: ThumbsVariant[] } | { ok: false; reason: string };

export type ThumbsRenderResult =
  | { letter: string; ok: true; path: string; bytes: number; format: 'png' | 'jpeg'; picture: string; notes: string[]; at: string }
  | { letter: string; ok: false; reason: string; at: string };

export interface ThumbsProgress {
  runId: string;
  stage: 'sampling' | 'scoring';
  done: number;
  total: number;
}
