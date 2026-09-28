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

/** One row of the best view: the best frame and the best clearly different one; `more` behind "More from this scene". */
export interface ThumbsSceneRow {
  scene: number;
  ids: string[];
  more: string[];
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

/**
 * A variant's photo (combine.ts PhotoPick): a named photo, Owen's explicit "No photo", or the photo
 * the suggestion ranks first for thumbnail `of`'s words (resolved when the thumbnails are made).
 */
export type ThumbsPhotoPick = { pick: 'photo'; name: string } | { pick: 'none' } | { pick: 'top'; of: string };

export interface ThumbsVariantRequest {
  letter: string;
  frameId: string;
  phrase: string | null;
  kind: ThumbsWordKind | null;
  photo: ThumbsPhotoPick;
}

/** The logo file as the tab shows it (lab-service.ts logo()). */
export interface ThumbsLogo {
  file: string;
  name: string;
  width: number;
  height: number;
  preview: string;
}

/** The app's logo, or none with the old setting's file offered for copying. */
export interface ThumbsLogoState {
  logo: ThumbsLogo | null;
  offer: { from: string } | null;
}

/** "Add photos…": what was chosen and what happened; `already` names photos not added (ask, then replace). */
export interface ThumbsAddPhotos {
  chosen: string[];
  added: string[];
  replaced: string[];
  already: string[];
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
  /** The app's library folder. */
  folder: string;
  photos: ThumbsPhoto[];
  /** While the library is empty: the old folder setting's photos, offered for copying. */
  offer: { from: string; count: number } | null;
}

/** A photo drawn from a ranking's top 3 (photo-draw.ts). */
export interface ThumbsPhotoDraw {
  of: string;
  name: string;
  p: number;
  chance: number;
  pool: ThumbsRanked[];
  repeatForced: boolean;
  line: string;
}

export interface ThumbsRanked {
  name: string;
  p: number | null;
}

export interface ThumbsSuggestion {
  tone: ThumbsRanked[];
  photos: Record<string, ThumbsRanked[]>;
  /** The words each ranking was made for: a ranking for other words is not used. */
  texts: Record<string, string | null>;
  line: string;
}

/** Each variant's photo ranking with the words it was made for (combine.ts Rankings). */
export type ThumbsRankings = Record<string, { text: string | null; ranked: string[] }>;

/** The lines the model wrote, per kind (combine.ts WrittenWords). */
export interface ThumbsWrittenWords {
  claim: string[];
  stakes: string[];
  reaction: string[];
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
  photo: ThumbsPhotoPick;
}

export type ThumbsCombineResult = { ok: true; variants: ThumbsVariant[] } | { ok: false; reason: string };

export type ThumbsRenderResult =
  | {
      letter: string; ok: true; path: string; bytes: number; format: 'png' | 'jpeg'; picture: string; notes: string[]; at: string;
      /** The photo drawn (null: none), and whether the logo was drawn. */
      photo: string | null;
      logo: boolean;
      /** Set when the photo was drawn from the top 3 for its words. */
      draw: ThumbsPhotoDraw | null;
    }
  | { letter: string; ok: false; reason: string; at: string };

export interface ThumbsRenderOutcome {
  folder: string;
  results: ThumbsRenderResult[];
  /** The suggestion the photos came from (run first when it had not run for these words), or null. */
  suggestion: ThumbsSuggestion | null;
  suggested: boolean;
  /** The seed the photo draw used (enter it again to repeat the draw). */
  seed: number;
  draws: Record<string, ThumbsPhotoDraw>;
  /** The run's lines, with the draw's line. */
  lines: string[];
}

export interface ThumbsProgress {
  runId: string;
  stage: 'sampling' | 'filtering' | 'scoring' | 'suggesting' | 'drawing';
  done: number;
  total: number;
}
