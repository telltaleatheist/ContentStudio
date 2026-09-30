/**
 * WHAT THE METADATA RUN STORES ABOUT AN ITEM'S THUMBNAILS: the `thumbnails` key on the item in its
 * job file (`<outputDir>/.contentstudio/metadata/<jobId>.json`), beside every other field of the
 * report. The reports page's Thumbnails window (phase 2: swaps, re-renders, the ordered picks,
 * screenshots, publishing) reads and writes it through OutputHandlerService.updateItemThumbnails;
 * docs/thumbnails-pipeline.md describes it field by field.
 *
 * One version number, checked on read: a record of another version is refused by name rather than
 * read as if it were this one (Law 10: a cross-layer contract is a type, and its version is part of
 * it).
 */
import * as path from 'path';
import type { TranscriptRef } from '../publish/publish-types';
import { validateAdjust, type CardAdjust, type ThumbnailStyle } from '../../shared/thumbnail-layout';
import type { WordKind } from './prompts';
import type { StoryLinkMethod, StoryMatchEvidence } from './story-match';

export const THUMBNAILS_RECORD_VERSION = 1;

/** The folder under the report's folder that holds every thumbnails folder of that report folder's items. */
export const THUMBNAILS_FOLDER = 'thumbnails';

/** Title and thumbnail pairs for YouTube's Test & Compare ("title and thumbnail" mode takes up to 3). */
export const PAIR_COUNT = 3;

/** The kind of words each pair's default thumbnail starts on, so the three arms test three ideas. */
export const PAIR_KINDS: readonly WordKind[] = ['claim', 'stakes', 'reaction'];

/**
 * The stages, in the order they run. Two were removed on 2026-09-29, both because Owen picks in the
 * Thumbnails window what a model used to pick:
 *   - `tone-photos` (the model's tone read and photo ranking on the `thumbnail_judge` row), Owen:
 *     "just let me pick the image of myself that goes in the corner instead of letting the model
 *     pick it. itll be faster."
 *   - `scoring` (the vision model's frame scoring on the `thumbnail_frames` row): he picks frames
 *     1, 2 and 3 from a flat grid, so the ranking was not needed; its last live run was refused
 *     (the 9B with vision asked for 8192 of context on a host whose ceiling for it is 1700).
 */
export const THUMBNAIL_STAGES = ['story', 'frames', 'words', 'render'] as const;
export type ThumbnailStage = (typeof THUMBNAIL_STAGES)[number];

/**
 * A stage an older record can name that no longer runs. A record that stopped at `tone-photos`
 * (Owen's first run stopped there) or at `scoring` is still read, and "Finish making thumbnails"
 * goes on from what it stores (pipeline.ts resumePlan).
 */
export const RETIRED_STAGES = ['tone-photos', 'scoring'] as const;
export type RecordedStage = ThumbnailStage | (typeof RETIRED_STAGES)[number];

/** A photo and the model's probability for it, in records made before 2026-09-29 (the ranking). */
export interface Ranked {
  name: string;
  p: number | null;
}

/** How a photo was drawn from a ranking's top 3, in records made before 2026-09-29. */
export interface PhotoDraw {
  name: string;
  p: number;
  chance: number;
  pool: Ranked[];
  repeatForced: boolean;
}

/**
 * made        every stage ran; `pairs` holds the three pairs with their words. From a story, no pair
 *             has a frame or a render until Owen fills its card and presses Save thumbnails
 *             (since 2026-09-29); from his screenshots, each pair is drawn on its screenshot.
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

/**
 * One candidate frame: a frame of the Thumbnails window's grid (at most two per scene, frame-scenes.ts
 * `gridFrames`), or one of Owen's screenshots. Paths are absolute. Records made before 2026-09-29
 * also carry the frame scoring's `score`, `reading` and `flag` on each frame; they are read and
 * ignored (nothing reads them now).
 */
export interface StoredFrame {
  id: string;
  /** Seconds into the screen recording. */
  t: number;
  clock: string;
  scene: number;
  /** 640x360 JPEG (the larger view). */
  large: string;
  /** 320x180 JPEG (for the grid). */
  small: string;
}

export interface StoredScene {
  number: number;
  /** Seconds of the story on this scene (every sampled frame counts toward the scene it looks most like). */
  seconds: number;
  /** "Scene 3 · 2:41 on screen". */
  label: string;
  kept: number;
  /**
   * How many of its frames are in the grid (at most two). Records made before 2026-09-29 carry
   * `scored` (the frames sent to the vision model) instead; read and ignored.
   */
  shown?: number;
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

/**
 * `ok: false` only in records written before phase 2, when a phrase too long for the space was
 * refused; the words are always drawn now (layout.ts).
 */
export type StoredRender =
  | { ok: true; file: string; format: 'png' | 'jpeg'; bytes: number; notes: string[] }
  | { ok: false; reason: string };

/** One title and thumbnail pair's current thumbnail: which pieces, and the file. */
export interface StoredDefault {
  /**
   * The frame this pair is drawn on: the frame on Owen's card n, set when he presses Save
   * thumbnails; or screenshot n for a pair made from his screenshots. Null: no frame picked yet
   * (the metadata run assigns none since 2026-09-29, when the frame ranking that chose them was
   * removed), and the pair is not drawn.
   */
  frameId: string | null;
  scene: number | null;
  /** The kind the words were taken from; null for "No text" or words Owen typed. */
  kind: WordKind | null;
  /** Null: Owen chose "No text" for this pair. */
  phrase: string | null;
  /**
   * The title the words were written for (2026-09-29: the window takes words written for ANY of
   * the titles, so thumbnail n's words need not be pair n's own). Null: typed words or no text.
   * Absent in older records: the pair's own title when `kind` is set, else null.
   */
  wordsFor?: string | null;
  /** The reaction photo Owen picked, or null: none picked (the run's defaults have none). */
  photo: string | null;
  /** Records before 2026-09-29: the top-3 draw that chose the photo. Always null now. */
  draw: PhotoDraw | null;
  logo: boolean;
  render: StoredRender;
  /**
   * Owen's edits to this card in the Thumbnails window's card editor (2026-09-29): the frame moved
   * or zoomed, the words in his own box, the photo moved or resized (shared/thumbnail-layout.ts
   * CardAdjust, fractions of the picture). Absent: none, the automatic layout (every record before
   * the editor). Checked on reading; a bad value is refused by name. The render honours it.
   */
  adjust?: CardAdjust;
}

export interface StoredPair {
  /** 1, 2 or 3: the A/B arm. */
  pair: number;
  title: string;
  words: StoredWords;
  /** Records before 2026-09-29: every reaction photo ranked by the model. Empty now (Owen picks). */
  photos: Ranked[];
  /** Records before 2026-09-29: the words the ranking was made for. Not written now. */
  rankedFor?: string | null;
  default: StoredDefault;
  /** One plain line about this pair (a kind with no options, a repeated scene). */
  lines: string[];
}

/**
 * One of Owen's ordered picks (index 0 is the first A/B arm and the video's thumbnail): a pair's
 * current render, or his own image file. Pick n goes with the report's chosen title n (YouTube
 * Test & Compare, "title and thumbnail": pair n = title n + thumbnail n); the pairing is by
 * position and read live, so a reordered title changes whom a pick goes with.
 */
export type ThumbnailPick =
  | {
      kind: 'made';
      /** The pair whose current render this is; the pick follows the pair when it is re-rendered. */
      pair: number;
      /** An absolute path to the render. */
      file: string;
      /** The title the words were written for (the pair's title when it was picked or rewritten). */
      wordsFor: string;
    }
  | {
      kind: 'own';
      /** Owen's own image file, absolute, read in place (never moved or changed). */
      file: string;
      /**
       * The Thumbnails window's card it was put on (1-3; the card editor, 2026-09-29). Absent in
       * picks saved before: such a pick sat on the card of its own position (pick n, card n).
       */
      card?: number;
    };

/** Where the picks are copied for publishing and the A/B test: `<folder>/picks/Pick 1.png` ... */
export const PICKS_FOLDER = 'picks';

/**
 * THE PICKS AS FILES, for publishing and for YouTube's Test & Compare (the browser extension's A/B
 * fill will read these; docs/thumbnails-pipeline.md "The saved picks, for the A/B fill"). Pick n's
 * copy is `<folder>/picks/Pick n.png` (`.jpg` when the picked file is not a PNG), in the picks'
 * order; it goes with the report's chosen title n (the publish record's `chosenTitles[n - 1]`), read
 * live, because Owen can reorder his titles after picking. Pick 1's copy is also the video's
 * thumbnail. The copies are rewritten on every save (report-thumbnails.ts writeCopies).
 */
export function pickCopies(record: Pick<ItemThumbnails, 'folder' | 'picks'>): Array<{ n: number; pick: ThumbnailPick; file: string }> {
  if (record.picks.length === 0) return [];
  if (record.folder === null) throw new Error('The thumbnails record holds picks and no folder.');
  const folder = path.join(record.folder, PICKS_FOLDER);
  return record.picks.map((pick, i) => ({
    n: i + 1,
    pick,
    file: path.join(folder, `Pick ${i + 1}${path.extname(pick.file).toLowerCase() === '.png' ? '.png' : '.jpg'}`),
  }));
}

export interface ItemThumbnails {
  version: typeof THUMBNAILS_RECORD_VERSION;
  state: ThumbnailsState;
  /** The report's one line: what was made, or why not. */
  line: string;
  failure: { stage: RecordedStage; reason: string } | null;
  /** Null only when the run never got as far as the story (off). */
  story: StoredStoryLink | null;
  /** `<report folder>/thumbnails/<jobId>-<item number>/`: frames/, full/ and the renders. Null when nothing was written. */
  folder: string | null;
  /**
   * The screen recording the frames come from, and the source lines (story, stretches, alignment,
   * drift). `video` is null when the backgrounds are Owen's own screenshots (a report with no story).
   */
  source: { video: string | null; lines: string[] } | null;
  scenes: StoredScene[];
  /**
   * The grid's candidate frames, in time order (the only frames kept on disk). Records made before
   * 2026-09-29 also carry `bestScenes` (the ranked rows) and `scoring` (the vision model's line);
   * both are read and ignored.
   */
  frames: StoredFrame[];
  /** The titles the pairs are written for, and where their order came from. */
  titles: { order: 'gate ranking' | 'as written'; subjects: string[] } | null;
  /** Records before 2026-09-29: the model's tone read. Always null now. */
  tone: { ranking: Ranked[]; model: string; server: string } | null;
  pairs: StoredPair[];
  /** Records before 2026-09-29: the photo draw's seed. Always null now. */
  seed: number | null;
  /** The look the defaults were drawn with (the saved `thumbnailLab.style`, or the default look, said in `lines`). */
  look: ThumbnailStyle | null;
  /** The logo file drawn, or null when the app holds none (said in `lines`). */
  logo: string | null;
  lines: string[];
  timings: Array<{ stage: RecordedStage; seconds: number }>;
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
  need(r.state !== 'failed' || (r.failure !== null && ([...THUMBNAIL_STAGES, ...RETIRED_STAGES] as readonly string[]).includes(r.failure.stage)), where, 'is failed and names no stage');
  for (const key of ['scenes', 'frames', 'pairs', 'lines', 'timings', 'picks'] as const) {
    need(Array.isArray(r[key]), where, `has no ${key} list`);
  }
  need(r.state !== 'made' || (r.pairs.length > 0 && r.folder !== null), where, 'is made and holds no pairs');
  // Owen's card edits: refused by name when a value is off (never clamped or dropped).
  for (const p of r.pairs) {
    if (p !== null && typeof p === 'object' && p.default !== null && typeof p.default === 'object' && p.default.adjust !== undefined) {
      validateAdjust(p.default.adjust, `${where}, thumbnail ${p.pair}`);
    }
  }
  checkPicks(r.picks, where);
  return r;
}

/**
 * The picks, checked: at most PAIR_COUNT; each a pair's render (pair number, file, the title its
 * words were written for) or Owen's own image (a file, and the card it was put on when saved by the
 * card editor); no file twice, no pair twice, no card holding two picks.
 */
export function checkPicks(picks: unknown, where: string): ThumbnailPick[] {
  need(Array.isArray(picks), where, 'picks is not a list');
  const list = picks as ThumbnailPick[];
  need(list.length <= PAIR_COUNT, where, `holds ${list.length} picks; Test & Compare takes at most ${PAIR_COUNT}`);
  for (const p of list) {
    need(p !== null && typeof p === 'object' && typeof p.file === 'string' && p.file !== '', where, 'holds a pick with no file');
    need(p.kind === 'own' || (p.kind === 'made' && Number.isInteger(p.pair) && p.pair >= 1 && typeof p.wordsFor === 'string' && p.wordsFor !== ''), where,
      `holds a pick that is neither a pair's render nor your own image (${JSON.stringify(p).slice(0, 120)})`);
    need(p.kind !== 'own' || p.card === undefined || (Number.isInteger(p.card) && p.card >= 1 && p.card <= PAIR_COUNT), where,
      `holds your own image on card ${JSON.stringify(p.kind === 'own' ? p.card : null)}; the cards are 1 to ${PAIR_COUNT}`);
  }
  need(new Set(list.map((p) => p.file)).size === list.length, where, 'picks one file twice');
  const pairs = list.flatMap((p) => (p.kind === 'made' ? [p.pair] : []));
  need(new Set(pairs).size === pairs.length, where, 'picks one pair twice');
  const cards = [...pairs, ...list.flatMap((p) => (p.kind === 'own' && p.card !== undefined ? [p.card] : []))];
  need(new Set(cards).size === cards.length, where, 'puts two picks on one card');
  return list;
}
