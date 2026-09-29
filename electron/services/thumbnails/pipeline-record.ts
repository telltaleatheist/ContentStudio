/**
 * WHAT THE METADATA RUN STORES ABOUT AN ITEM'S THUMBNAILS: the `thumbnails` key on the item in its
 * job file (`<outputDir>/.contentstudio/metadata/<jobId>.json`), beside every other field of the
 * report. The contract phase 2 (the reports page's thumbnail pop-up, the ordered picks, publishing)
 * is written against; docs/thumbnails-pipeline.md describes it field by field.
 *
 * One version number, checked on read: a record of another version is refused by name rather than
 * read as if it were this one (Law 10: a cross-layer contract is a type, and its version is part of
 * it).
 */
import type { TranscriptRef } from '../publish/publish-types';
import type { FrameReading } from './frame-ranking';
import type { SceneRow } from './frame-scenes';
import type { Ranked } from './judge';
import type { ThumbnailStyle } from './layout';
import type { PhotoDraw } from './photo-draw';
import type { WordKind } from './prompts';
import type { StoryLinkMethod, StoryMatchEvidence } from './story-match';

export const THUMBNAILS_RECORD_VERSION = 1;

/** The folder under the report's folder that holds every thumbnails folder of that report folder's items. */
export const THUMBNAILS_FOLDER = 'thumbnails';

/** Title and thumbnail pairs for YouTube's Test & Compare ("title and thumbnail" mode takes up to 3). */
export const PAIR_COUNT = 3;

/** The kind of words each pair's default thumbnail starts on, so the three arms test three ideas. */
export const PAIR_KINDS: readonly WordKind[] = ['claim', 'stakes', 'reaction'];

/** The stages, in the order they run. */
export const THUMBNAIL_STAGES = ['story', 'frames', 'scoring', 'words', 'tone-photos', 'render'] as const;
export type ThumbnailStage = (typeof THUMBNAIL_STAGES)[number];

/**
 * made        every stage ran; `pairs` holds the three defaults (a pair whose words did not fit
 *             says so on its own render).
 * no-story    the item has no editor story to take frames from; `reason` says why. Not a failure.
 * off         the run did not make thumbnails: switched off for this run, a channel that makes none,
 *             a channel file that does not say, or a caller with no thumbnail setup. `reason` says which.
 * failed      a stage failed; `failure` names it and says why in plain words. The rest of the item
 *             was generated and saved as usual.
 */
export type ThumbnailsState = 'made' | 'no-story' | 'off' | 'failed';

export type StoredStoryLink =
  | { state: 'linked'; method: StoryLinkMethod; ref: TranscriptRef; line: string; evidence: StoryMatchEvidence | null }
  | { state: 'none'; reason: string; evidence: StoryMatchEvidence | null };

/** One candidate frame: a frame the vision model was asked about. Paths are absolute. */
export interface StoredFrame {
  id: string;
  /** Seconds into the screen recording. */
  t: number;
  clock: string;
  scene: number;
  /** 640x360 JPEG (what the model read). */
  large: string;
  /** 320x180 JPEG (for a grid). */
  small: string;
  /** Null when the frame was set aside (a computer screen, or an unreadable answer). */
  score: number | null;
  reading: FrameReading | null;
  flag: 'screen' | 'unreadable' | null;
}

export interface StoredScene {
  number: number;
  /** Seconds of the story on this scene (every sampled frame counts toward the scene it looks most like). */
  seconds: number;
  /** "Scene 3 · 2:41 on screen". */
  label: string;
  kept: number;
  scored: number;
}

export interface StoredWords {
  claim: string[];
  stakes: string[];
  reaction: string[];
  /** What came back off the brief (kept regardless). */
  warnings: string[];
  /** The routed model that wrote them. */
  model: string;
}

export type StoredRender =
  | { ok: true; file: string; format: 'png' | 'jpeg'; bytes: number; notes: string[] }
  | { ok: false; reason: string };

/** One title and thumbnail pair's default thumbnail: which pieces, and the file. */
export interface StoredDefault {
  frameId: string;
  scene: number;
  kind: WordKind;
  phrase: string;
  photo: string;
  /** The top-3 draw that chose the photo (its seed is the record's `seed`). */
  draw: PhotoDraw;
  logo: boolean;
  render: StoredRender;
}

export interface StoredPair {
  /** 1, 2 or 3: the A/B arm. */
  pair: number;
  title: string;
  words: StoredWords;
  /** Every reaction photo ranked for the default's words (most fitting first, none left out). */
  photos: Ranked[];
  default: StoredDefault;
  /** One plain line about this pair (a kind with no options, a repeated scene). */
  lines: string[];
}

/** The ordered picks phase 2 saves: index 0 is the first A/B arm. Empty until then. */
export interface ThumbnailPick {
  title: string;
  /** An absolute path to a rendered thumbnail. */
  file: string;
}

export interface ItemThumbnails {
  version: typeof THUMBNAILS_RECORD_VERSION;
  state: ThumbnailsState;
  /** The report's one line: what was made, or why not. */
  line: string;
  failure: { stage: ThumbnailStage; reason: string } | null;
  /** Null only when the run never got as far as the story (off). */
  story: StoredStoryLink | null;
  /** `<report folder>/thumbnails/<jobId>-<item number>/`: frames/, full/ and the renders. Null when nothing was written. */
  folder: string | null;
  /** The screen recording the frames come from, and the source lines (story, stretches, alignment, drift). */
  source: { video: string; lines: string[] } | null;
  scenes: StoredScene[];
  /** The scored frames, in time order. */
  frames: StoredFrame[];
  /** One row per scene, best scene first (frame-scenes.ts sceneRows). */
  bestScenes: SceneRow[];
  scoring: { server: string; model: string; line: string } | null;
  /** The titles the pairs are written for, and where their order came from. */
  titles: { order: 'gate ranking' | 'as written'; subjects: string[] } | null;
  tone: { ranking: Ranked[]; model: string; server: string } | null;
  pairs: StoredPair[];
  /** The photo draw's seed (photo-draw.ts): the same seed and rankings draw the same photos. */
  seed: number | null;
  /** The look the defaults were drawn with (the saved `thumbnailLab.style`, or the default look, said in `lines`). */
  look: ThumbnailStyle | null;
  /** The logo file drawn, or null when the app holds none (said in `lines`). */
  logo: string | null;
  lines: string[];
  timings: Array<{ stage: ThumbnailStage; seconds: number }>;
  picks: ThumbnailPick[];
}

function need(cond: boolean, where: string, what: string): void {
  if (!cond) throw new Error(`${where}: the thumbnails record ${what}.`);
}

/**
 * Read an item's `thumbnails` record, checked. Undefined (an item written before the thumbnails
 * pipeline) is `null`; anything else that is not a record of this version is refused by name.
 */
export function readItemThumbnails(value: unknown, where: string): ItemThumbnails | null {
  if (value === undefined) return null;
  const r = value as ItemThumbnails;
  need(r !== null && typeof r === 'object', where, 'is not an object');
  need(r.version === THUMBNAILS_RECORD_VERSION, where, `is version ${JSON.stringify(r.version)}, and this build reads version ${THUMBNAILS_RECORD_VERSION}`);
  need(['made', 'no-story', 'off', 'failed'].includes(r.state), where, `has the state ${JSON.stringify(r.state)}`);
  need(typeof r.line === 'string' && r.line !== '', where, 'has no line');
  need(r.state !== 'failed' || (r.failure !== null && (THUMBNAIL_STAGES as readonly string[]).includes(r.failure.stage)), where, 'is failed and names no stage');
  for (const key of ['scenes', 'frames', 'bestScenes', 'pairs', 'lines', 'timings', 'picks'] as const) {
    need(Array.isArray(r[key]), where, `has no ${key} list`);
  }
  need(r.state !== 'made' || (r.pairs.length > 0 && r.folder !== null), where, 'is made and holds no pairs');
  checkPicks(r.picks, where);
  return r;
}

/** The picks, checked: at most PAIR_COUNT, each a title and a file, no title twice. */
export function checkPicks(picks: unknown, where: string): ThumbnailPick[] {
  need(Array.isArray(picks), where, 'picks is not a list');
  const list = picks as ThumbnailPick[];
  need(list.length <= PAIR_COUNT, where, `holds ${list.length} picks; Test & Compare takes at most ${PAIR_COUNT}`);
  for (const p of list) need(p !== null && typeof p === 'object' && typeof p.title === 'string' && p.title !== '' && typeof p.file === 'string' && p.file !== '', where, 'holds a pick that is not a title and a file');
  need(new Set(list.map((p) => p.title)).size === list.length, where, 'picks one title twice');
  return list;
}
