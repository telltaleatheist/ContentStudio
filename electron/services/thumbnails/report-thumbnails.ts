/**
 * THE REPORTS PAGE'S THUMBNAILS WINDOW, main-process side (phase 2, Owen 2026-09-28; the card
 * editor 2026-09-29; docs/thumbnails-pipeline.md). The metadata run already made the title and
 * thumbnail pairs and stored them on the item (`thumbnails`, pipeline-record.ts). The window shows
 * three CARDS, card n = pair n, each a live preview Owen fills from the trays (a frame, a line of
 * text, a reaction photo) and can edit (the frame zoomed or moved, the words in his own box, the
 * photo moved or resized). The preview is drawn IN THE WINDOW with the same layout and drawing the
 * final render uses (shared/thumbnail-layout.ts, shared/thumbnail-draw.ts); here Owen:
 *
 *   - gets what the preview needs and only the main process has (`frameDetail`: a frame at full
 *     size, extracted from the screen recording the first time, and the faces Apple Vision finds in
 *     it, the render's own search; `photoDetail`: a photo trimmed as the render trims it; the view's
 *     `compose`: the look, the border and the logo at its drawn size);
 *   - SAVES the cards (`saveCards`, "Save thumbnails"): every card with a frame is drawn at
 *     1280x720 on the CPU with its edits, as a NEW file beside the old one (so a file a pick or the
 *     publish record points at is never overwritten under it), then the cards in order become the
 *     ORDERED picks: card 1 first, a card with no frame left out and the rest closing up, his own
 *     image where he put one. Pick n goes with chosen title n (Test & Compare's "title and
 *     thumbnail"); the picks are copied into `<folder>/picks/Pick 1.png` ...: pick 1's copy is what
 *     the reports page sets as the video's thumbnail through the publish record's one thumbnail
 *     door; picks 2 and 3 sit beside it for his manual Test & Compare upload in Studio. A card that
 *     cannot be drawn stops the save with its reason, and nothing is saved;
 *   - has a pair's words written again for another title (`pairTitle`, the words row on demand),
 *     when he reorders his titles so card n now goes with a different title; or more of them for
 *     the same title (`writeWords`: "New options" puts a fresh set first, "More options" adds
 *     lines it has not written yet). NO WORDS ARE EVER DROPPED: a set that is followed by a newer
 *     one is kept in the record's `earlierWords`, and every set is written into the record the
 *     moment the model answers (Owen, 2026-09-29: "that should be kept even if i leave the modal");
 *   - adds his own images as frames (`addFrames`: dropped on a card or the Frames tray, or "Add an
 *     image…"): each cut to fill 16:9 around its centre and kept in the record's folder;
 *   - for a report with NO STORY (a subject for a video not recorded yet, or a video no story
 *     matched), fills the cards the same way from his images, his words and a photo (2026-09-30,
 *     Owen: "it should let me type it and pick the thumbnail background and foreground myself"): the
 *     record reads with one pair per title (`locate`, pipeline.ts noStoryPairs), written into it on
 *     the window's first write. It replaced the screenshots path (1 to 3 screenshots made that many
 *     pairs with the model's words), whose records are still read;
 *   - for a report whose thumbnail stages STOPPED, the window prepares what is missing on opening
 *     (`finish`): the stages it stores are kept (frames, words) and only the missing ones run
 *     (pipeline.ts resumePlan / ItemThumbnailRun.resume).
 *
 * THE MODEL IS HELD across the window's words steps (the tab's pattern, which Owen asked for: "if
 * we're using the 27b anyway we might as well keep it loaded"): one held job per local model,
 * given back when another model is needed, when the window closes, on quit, or after
 * TEXT_HOLD_IDLE_MS with no step. A words step that is running when the window closes (or the idle
 * clock runs out) runs to its end and saves what it wrote; the model is given back AFTER it
 * (2026-09-29: closing used to give the hold back under the running request). Only quitting the
 * app gives it back at once.
 *
 * ONE ACTION PER ITEM AT A TIME: a model step reads the record, waits a minute for the model and
 * writes it back, and a save landing in between would be written away; a second action on the same
 * item is refused in plain words while one runs. Every write goes through the one door,
 * OutputHandlerService.updateItemThumbnails.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import type { JobSessions } from '../../crucible/session';
import type { AIManagerService } from '../metadata/ai-manager.service';
import { migrateStoredRouting, resolveMetadataRouting, routingOption, type MetadataRoutingOption, type ResolvedMetadataRouting, type RoutingModels } from '../metadata/metadata-routing';
import { readRoutingModels } from '../metadata/routing-models';
import { OutputHandlerService } from '../metadata/output-handler.service';
import { promptAssets } from '../metadata/prompt-assets';
import { loadSavedTranscript } from '../metadata/saved-transcript.service';
import { validateThumbnailFile } from '../publish/thumbnail-validate';
import { noAdjust, phraseWords, placeLogo, validateAdjust, type CardAdjust, type Rect, type ThumbnailStyle } from '../../shared/thumbnail-layout';
import { prepareStill, writeGridPictures } from './frame-sampler';
import type { ThumbnailLook } from './look';
import { libraryBorder, libraryLogo, libraryPhotos } from './photo-library';
import {
  ItemThumbnailRun,
  defaultWords,
  drawPair,
  fullFrame,
  NO_FRAME_YET,
  NO_PHOTO_YET,
  noStoryPairs,
  resumePlan,
  type DrawnRender,
  type ThumbnailItemInput,
  type ThumbnailRunChoice,
  type ThumbnailRunSetup,
} from './pipeline';
import {
  PAIR_COUNT,
  PAIR_KINDS,
  PICKS_FOLDER,
  THUMBNAILS_FOLDER,
  appendWords,
  checkPicks,
  keepEarlier,
  linesWrittenFor,
  nextAddedFrameId,
  pickCopies,
  readItemThumbnails,
  type ItemThumbnails,
  type StoredFrame,
  type StoredDefault,
  type StoredPair,
  type RecordedStage,
  type ThumbnailPick,
  type ThumbnailStage,
} from './pipeline-record';
import { transcriptLines, WORD_KINDS, type WordKind } from './prompts';
import { OUTPUT_HEIGHT, OUTPUT_WIDTH, safeFileName } from './renderer';
import { writeThumbnailWords } from './words-writer';

/** How long the window keeps its text model held after its last words step. */
export const TEXT_HOLD_IDLE_MS = 5 * 60_000;

/**
 * The file types Owen can give as an image to use as a frame (and that an old own-image pick was). PNG and JPEG only: the app's ffmpeg reads both; it cannot read HEIC, and
 * WebP was not checked, so neither is taken.
 */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

/** What the reports page and the window say about a report with no story (the record keeps why). */
export const NO_STORY_LINE = 'No frames were taken for this one: make its thumbnails from your own images.';

/**
 * Why New options and More options cannot run for a report made from a subject or a compilation:
 * the words are written from one video's transcript, and neither has one.
 */
export const NO_TRANSCRIPT_WORDS = 'This one was made from a subject or is a compilation, so there is no one video transcript to write text from. Type your own words.';

/** Where an added image's two grid pictures are kept, under the record's folder (its full size is in `full/`). */
export const ADDED_FOLDER = 'added';

/**
 * What the live preview needs that only the main process can make (Electron's nativeImage and the
 * hidden canvas page's face search). The app's are in thumbnails-ipc.ts; the keeper hands stand-ins.
 */
export interface PreviewPieces {
  /** A frame file as the preview draws it (a data URL at most OUTPUT_WIDTH wide) and the file's own size. */
  framePicture(file: string): { picture: string; width: number; height: number };
  /** The faces Apple Vision finds in the frame file, in its own pixels: the final render's own search. */
  faces(file: string): Promise<Rect[]>;
  /** A library photo trimmed as the render trims it: its trimmed size, and a picture of it for the preview. */
  photo(name: string, file: string): { image: string; width: number; height: number };
  /** The logo file's visible size, and its picture at exactly w x h (the render's own downscale). */
  logo(file: string): { width: number; height: number; at(w: number, h: number): string };
  /** The border file, checked as the render checks it, as a data URL. */
  border(file: string): string;
  /** The window closed: the face search's hidden page goes. */
  close(): void;
}

export interface ReportThumbnailsDeps {
  store: { get(key: string): unknown };
  userDataPath: string;
  ffprobe: string;
  look: ThumbnailLook;
  /** The run's setup read NOW (the saved look, the renderer): pipeline-setup.ts thumbnailRunChoice. */
  runChoice: () => ThumbnailRunChoice;
  /** A held Crucible job for the text steps (crucible.transport.job). */
  holdJob: (what: string) => JobSessions;
  aiManager: () => Pick<AIManagerService, 'runPlainRequest'> & { cleanup?(): void };
  /** A picture of a file as a data URL, at most `width` pixels wide (Electron nativeImage in the app). */
  picture: (file: string, width: number) => string;
  /** The library's photos with a small picture each (look.ts photos(): trimming needs Electron). */
  photoList: () => Array<{ name: string; preview: string }>;
  pieces: PreviewPieces;
  /** A progress line for the window that asked; `card` names the card being drawn while saving. */
  progress: (event: { jobId: string; itemId: string; line: string; card?: number }) => void;
  /** The Crucible server a GPU step started now would run on, or why there is none (lanes.gpuVenue). */
  gpuVenue: () => { server: string } | { server: null; reason: string };
}

/**
 * One card as the window sends it to Save thumbnails. Every card is sent, 1 to PAIR_COUNT:
 *   made   a frame (and maybe words and a photo, and Owen's edits): drawn into pair `card`;
 *   own    his own image file on this card;
 *   empty  nothing to save (no frame): left out of the picks, and pair `card` loses the frame it had.
 */
export type CardRequest =
  | { card: number; kind: 'empty' }
  | { card: number; kind: 'own'; file: string }
  | {
      card: number;
      kind: 'made';
      frameId: string;
      /** The words, or null for none. */
      phrase: string | null;
      /** Where the words came from (null: typed by Owen, or none). */
      textKind: WordKind | null;
      /** The title the words were written for (null: typed words or none). */
      wordsFor: string | null;
      /** A photo name from the library, or null for none. */
      photo: string | null;
      adjust: CardAdjust;
    };

/** One saved pick with its copy (the file that is uploaded) and a small picture. */
export interface PickView {
  n: number;
  pick: ThumbnailPick;
  /** `<folder>/picks/Pick n.png`: pick 1's is the video's thumbnail, 2 and 3 are for the A/B test. */
  copy: string;
  picture: string;
}

/** What the reports page shows about an item's thumbnails without opening the window. */
export interface ThumbnailsSummary {
  /** Null: the report was made before thumbnails were made in the metadata run. */
  state: ItemThumbnails['state'] | null;
  line: string | null;
  /** True when the window has something to do: cards to fill (from the story's frames or his own images). */
  canOpen: boolean;
  picks: PickView[];
  picksFolder: string | null;
  /** The file to set as the video's thumbnail (pick 1's copy), or null with no picks. */
  publishFile: string | null;
}

/**
 * A record whose stages stopped: where, why, what preparing it keeps and runs, and why it cannot
 * run now (null when it can).
 */
export interface FinishView {
  stage: RecordedStage;
  /** The stage it stopped at has since been removed: the window says only that it is not finished. */
  retired: boolean;
  /** Why it stopped; null for a removed stage (its old reason no longer applies). */
  reason: string | null;
  keep: ThumbnailStage[];
  run: ThumbnailStage[];
  blocked: string | null;
}

/**
 * What the live preview draws with besides the frame, the words and the photo: the saved look, the
 * border (when the look has it on and one is kept) and the logo (always, when one is kept: Owen,
 * "logo goes in top right automatically, border goes on top of the image automatically and neither
 * of those two should be edited"). The logo's picture is at its drawn size on a 1280x720 thumbnail,
 * the render's own downscale. `ok: false` says why there can be no preview (the same reason a save
 * would stop on).
 */
export type ComposeView =
  | {
      ok: true;
      style: ThumbnailStyle;
      width: number;
      height: number;
      border: string | null;
      logo: { image: string; width: number; height: number } | null;
      /** Plain lines: an older saved look read with new defaults, no logo kept, no border. */
      lines: string[];
    }
  | { ok: false; error: string };

/** A frame at full size for the preview, and its faces (or why they could not be found). */
export interface FrameDetail {
  frameId: string;
  picture: string;
  /** The full-size frame's own size (what the face boxes are measured in). */
  width: number;
  height: number;
  /** Null when the face search failed: `facesError` says why, and the save would stop on it too. */
  faces: Rect[] | null;
  facesError: string | null;
}

/** Everything the window shows. Pictures are keyed by frame id. */
export interface ThumbnailsView extends ThumbnailsSummary {
  jobId: string;
  itemId: string;
  title: string;
  record: ItemThumbnails | null;
  /** The item's generated titles (the words can be rewritten for any title). */
  titles: string[];
  /** Small pictures of every candidate frame, for the Frames tray (keyed by id). */
  frames: Record<string, string>;
  photos: Array<{ name: string; preview: string }>;
  compose: ComposeView;
  /** The text model held for the next words step, or null. */
  heldModel: string | null;
  /** Set when the record's stages stopped (state `failed`): the window prepares what is missing. */
  finish: FinishView | null;
  /**
   * What is running for this item now ("writing words", ...), or null. A window opened while a
   * step started from an earlier one runs says so and waits for it (`running`).
   */
  running: string | null;
  /** Why New options and More options cannot write text for this report (no transcript), or null. */
  wordsBlocked: string | null;
}

/** Images added as frames: the view, the new frames' ids in the order given, and one plain line each. */
export interface AddedFrames {
  view: ThumbnailsView;
  added: string[];
  lines: string[];
}

/** New or more words for one pair's title: the view and a plain line about what was written. */
export interface WrittenWords {
  view: ThumbnailsView;
  line: string;
}

interface Located {
  outputDir: string;
  handler: OutputHandlerService;
  job: { txt_folder?: string; items: any[] };
  item: any;
  record: ItemThumbnails | null;
  where: string;
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * One item's job file and thumbnails record, read now. THE ONE LOOKUP: the window's every action
 * (ReportThumbnails.locate) and the browser extension's A/B fill (`abTestPickFiles`) both come
 * through here, so the two can never disagree about which record an item has.
 */
function locateItem(outputDir: string, jobId: string, itemId: string): Located {
  const handler = OutputHandlerService.forOutputDir(outputDir);
  const job = handler.getJobMetadata(jobId) as unknown as Located['job'] | null;
  if (job === null) throw new Error(`The report's job ${jobId} is not there any more.`);
  if (!Array.isArray(job.items)) throw new Error(`Job ${jobId} has no items list; the report file is damaged.`);
  const item = job.items.find((i) => i && i.item_id === itemId);
  if (item === undefined) throw new Error(`Item ${itemId} is not in job ${jobId} any more.`);
  const where = `item ${itemId} of job ${jobId}`;
  return { outputDir, handler, job, item, record: readItemThumbnails(item.thumbnails, where), where };
}

/**
 * The saved picks' copies, in order, for the browser extension's A/B fill (LEDGER #250): pick n
 * goes into Studio's "Title and thumbnail" test beside chosen title n. The paths only, read from
 * the record now; whether each file is there and usable is the publish bridge's check, where the
 * bytes are read. A report with no thumbnails record (made before the pipeline) or no picks has
 * none: an empty list, a state rather than a failure, and the extension then fills titles only.
 */
export function abTestPickFiles(outputDir: string, jobId: string, itemId: string): Array<{ n: number; file: string }> {
  const { record } = locateItem(outputDir, jobId, itemId);
  if (record === null) return [];
  return pickCopies(record).map(({ n, file }) => ({ n, file }));
}

function linesOfCount(words: { claim: string[]; stakes: string[]; reaction: string[] }): number {
  return words.claim.length + words.stakes.length + words.reaction.length;
}

/** A stored frame as the drawing takes it: an added image says so, so it is never taken from the recording. */
function frameRef(frame: StoredFrame): { id: string; t: number; origin?: 'added' } {
  return { id: frame.id, t: frame.t, ...(frame.origin === undefined ? {} : { origin: frame.origin }) };
}

export class ReportThumbnails {
  private readonly busy = new Map<string, string>();
  private textHold: { job: JobSessions; model: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
  /** Words steps running on the held model now: the hold is never given back under one. */
  private textSteps = 0;
  /** Why the hold goes once the running words steps end (the window closed, the idle clock, a failure). */
  private releaseAfterSteps: string | null = null;
  /** Faces found per frame file (and its modification time): a frame is searched once per window session. */
  private readonly facesCache = new Map<string, { mtimeMs: number; faces: Promise<Rect[]> }>();
  /** A full frame being extracted, so two asks for the same frame run ffmpeg once. */
  private readonly extracting = new Map<string, Promise<string>>();

  constructor(private readonly deps: ReportThumbnailsDeps) {}

  // ── housekeeping ─────────────────────────────────────────────────────────────

  private outputDir(): string {
    const dir = this.deps.store.get('outputDirectory');
    if (typeof dir !== 'string' || dir.trim() === '') throw new Error('No output directory is set in Settings, so there are no reports.');
    return dir;
  }

  private locate(jobId: string, itemId: string): Located {
    const located = locateItem(this.outputDir(), jobId, itemId);
    return { ...located, record: this.withCards(located.record, located.item) };
  }

  /**
   * A record with no story holds no pairs as the run wrote it: it is read with one pair per title
   * (pipeline.ts noStoryPairs), so its cards fill like any other; the window's first write stores
   * them. Every other record is read as it is.
   */
  private withCards(record: ItemThumbnails | null, item: any): ItemThumbnails | null {
    if (record === null || record.state !== 'no-story' || record.pairs.length > 0) return record;
    return { ...record, ...noStoryPairs(this.fieldsOf(item)) };
  }

  /** Run `fn` as the one action on this item, refusing a second while it runs. */
  private async exclusive<T>(jobId: string, itemId: string, what: string, fn: () => Promise<T>): Promise<T> {
    const key = `${jobId}/${itemId}`;
    const running = this.busy.get(key);
    if (running !== undefined) throw new Error(`Still ${running} for this report; wait for it to finish.`);
    this.busy.set(key, what);
    try {
      return await fn();
    } finally {
      this.busy.delete(key);
    }
  }

  private setup(): ThumbnailRunSetup {
    const choice = this.deps.runChoice();
    if (choice.mode === 'off') throw new Error(choice.reason);
    return choice.setup;
  }

  /** The routing table, read now, as the metadata run reads it (ipc-handlers generate-metadata). */
  private routing(): ResolvedMetadataRouting {
    return resolveMetadataRouting(migrateStoredRouting(this.deps.store.get('metadataRouting')).selections);
  }

  /**
   * The row read now and bound on the server this step runs on (`gpuVenue`), from one catalog read:
   * the row names a model, that server's catalog names the build, refused by name when it has none.
   */
  private async routed(task: 'thumbnail_words', what: string): Promise<{ routing: ResolvedMetadataRouting; models: RoutingModels; option: MetadataRoutingOption }> {
    const routing = this.routing();
    const models = await readRoutingModels(what, [routing[task]], this.deps.gpuVenue);
    return { routing, models, option: routingOption(task, routing[task], models) };
  }

  /**
   * The held job for a text step on `option`, or undefined for a cloud or `claude -p` option (which
   * holds no card). A different local model releases the old hold first; the idle clock restarts.
   */
  private async textJob(option: MetadataRoutingOption): Promise<JobSessions | undefined> {
    if (option.kind !== 'local' || option.crucibleModel === null) return undefined;
    const model = option.crucibleModel;
    if (this.textHold !== null && this.textHold.model !== model) {
      if (this.textSteps > 0) throw new Error(`${this.textHold.model} is still writing words for another report, and this step needs ${model}; wait for it to finish.`);
      await this.releaseHold(`the next step runs on ${model}`);
    }
    if (this.textHold === null) {
      this.textHold = { job: this.deps.holdJob('the Thumbnails window (words)'), model, timer: null };
      log.info(`[Thumbnails] holding ${model} across the window's words steps`);
    }
    const hold = this.textHold;
    if (hold.timer !== null) clearTimeout(hold.timer);
    hold.timer = setTimeout(() => void this.releaseHold(`no words step for ${TEXT_HOLD_IDLE_MS / 60_000} minutes`), TEXT_HOLD_IDLE_MS);
    hold.timer.unref?.();
    return hold.job;
  }

  /**
   * Run one words step on `option` (the held job for a local model, none for a cloud or `claude -p`
   * one). While it runs the hold is never given back: a release asked for meanwhile (the window
   * closed, the idle clock) waits for the last running step to end. A failed step gives the model
   * back after it.
   */
  private async textStep<T>(option: MetadataRoutingOption, fn: (job: JobSessions | undefined) => Promise<T>): Promise<T> {
    const job = await this.textJob(option);
    this.textSteps++;
    try {
      return await fn(job);
    } catch (err) {
      if (job !== undefined) this.releaseAfterSteps ??= 'a words step failed';
      throw err;
    } finally {
      this.textSteps--;
      const reason = this.releaseAfterSteps;
      if (this.textSteps === 0 && reason !== null) {
        this.releaseAfterSteps = null;
        await this.releaseHold(reason);
      }
    }
  }

  /**
   * Let go of the text model's session. Never throws: it is housekeeping. Returns the model released,
   * or null when none was held, or when a words step is running: then it is given back when the
   * step ends (said in the log).
   */
  async releaseHold(reason: string): Promise<string | null> {
    if (this.textSteps > 0 && this.textHold !== null) {
      this.releaseAfterSteps = reason;
      log.info(`[Thumbnails] ${this.textHold.model} is given back when the running words step ends (${reason})`);
      return null;
    }
    return this.releaseNow(reason);
  }

  /** Let go of the held session now, whatever runs (quitting the app). Never throws. */
  private async releaseNow(reason: string): Promise<string | null> {
    const hold = this.textHold;
    this.textHold = null;
    if (hold === null) return null;
    if (hold.timer !== null) clearTimeout(hold.timer);
    await hold.job.releaseAll();
    log.info(`[Thumbnails] released ${hold.model}: ${reason}`);
    return hold.model;
  }

  /**
   * The window closed: the face search's hidden page goes, and the text model goes back, after
   * any words step still running (it runs to its end and saves what it wrote). Never throws.
   */
  async closed(): Promise<string | null> {
    this.deps.pieces.close();
    return this.releaseHold('the Thumbnails window was closed');
  }

  /** The app is quitting: the text model goes back now. Never throws. */
  async quit(): Promise<string | null> {
    this.deps.pieces.close();
    return this.releaseNow('the app is quitting');
  }

  /** What is running for this item now, or null (a reopened window waits for it). */
  running(jobId: string, itemId: string): string | null {
    return this.busy.get(`${jobId}/${itemId}`) ?? null;
  }

  heldModel(): string | null {
    return this.textHold?.model ?? null;
  }

  // ── reading ─────────────────────────────────────────────────────────────────

  private picksFolder(record: ItemThumbnails): string | null {
    return record.folder === null ? null : path.join(record.folder, PICKS_FOLDER);
  }

  private summaryOf(record: ItemThumbnails | null, pictureWidth: number): ThumbnailsSummary {
    if (record === null) return { state: null, line: null, canOpen: false, picks: [], picksFolder: null, publishFile: null };
    const picks = pickCopies(record).map(({ n, pick, file }) => (
      { n, pick, copy: file, picture: fs.existsSync(file) ? this.deps.picture(file, pictureWidth) : '' }
    ));
    return {
      state: record.state,
      // The record's line says why no frames were taken, in the pipeline's terms; Owen reads this.
      line: record.state === 'no-story' ? NO_STORY_LINE : record.line,
      canOpen: record.state === 'made' || record.state === 'no-story' || record.state === 'failed',
      picks,
      picksFolder: this.picksFolder(record),
      publishFile: picks.length > 0 ? picks[0].copy : null,
    };
  }

  /** The reports page's line, picks and the file to publish, for one item. Cheap: small pictures only. */
  summary(jobId: string, itemId: string): ThumbnailsSummary {
    return this.summaryOf(this.locate(jobId, itemId).record, 240);
  }

  /** The look, border and logo the preview draws with, read now; or why there can be no preview. */
  private composeView(): ComposeView {
    try {
      const setup = this.setup();
      const style = setup.style;
      const lines: string[] = setup.styleLine === null ? [] : [setup.styleLine];
      let border: string | null = null;
      if (!style.border) lines.push('The border is switched off in Thumbnail look.');
      else {
        const file = libraryBorder(this.deps.userDataPath);
        if (file === null) lines.push('No border is kept in the app, so none is drawn.');
        else border = this.deps.pieces.border(file);
      }
      let logo: { image: string; width: number; height: number } | null = null;
      const logoFile = libraryLogo(this.deps.userDataPath);
      if (logoFile === null) lines.push('No logo is kept in the app, so none is drawn.');
      else {
        const read = this.deps.pieces.logo(logoFile);
        const at = placeLogo(read.width, read.height, style, OUTPUT_WIDTH, OUTPUT_HEIGHT);
        logo = { image: read.at(at.w, at.h), width: read.width, height: read.height };
      }
      return { ok: true, style, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, border, logo, lines };
    } catch (err) {
      return { ok: false, error: message(err) };
    }
  }

  /** Everything the window shows for one item. */
  view(jobId: string, itemId: string): ThumbnailsView {
    const { item, record } = this.locate(jobId, itemId);
    const frames: Record<string, string> = {};
    if (record !== null) {
      // Every candidate: the grid shows them all (at most two per scene since 2026-09-29; a record
      // made before keeps the frames it sent to the since-removed scoring, all of them on disk).
      for (const f of record.frames) {
        if (fs.existsSync(f.small)) frames[f.id] = this.deps.picture(f.small, 320);
      }
    }
    return {
      ...this.summaryOf(record, 320),
      jobId,
      itemId,
      title: typeof item._title === 'string' ? item._title : path.basename(String(item.source_path ?? itemId)),
      record,
      titles: Array.isArray(item.titles) ? [...new Set((item.titles as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== ''))] : [],
      frames,
      photos: this.deps.photoList(),
      compose: this.composeView(),
      heldModel: this.heldModel(),
      finish: this.finishView(record),
      running: this.running(jobId, itemId),
      wordsBlocked: this.hasTranscript(item) ? null : NO_TRANSCRIPT_WORDS,
    };
  }

  /** Whether the item was made from a video or a transcript file (a subject records no source). */
  private hasTranscript(item: any): boolean {
    return typeof item.source_path === 'string' && item.source_path !== '';
  }

  /** A frame file at full size, extracted once even when asked for twice at once. */
  private async fullFrameOf(record: ItemThumbnails, frameId: string): Promise<string> {
    const frame = record.frames.find((f) => f.id === frameId);
    if (frame === undefined) throw new Error(`Frame ${frameId} is not among this report's candidate frames.`);
    if (record.folder === null) throw new Error('The thumbnails record names no folder, so there are no frames to draw.');
    const key = path.join(record.folder, 'full', `${frame.id}.png`);
    const running = this.extracting.get(key);
    if (running !== undefined) return running;
    const setup = this.setup();
    const next = fullFrame({ ffmpeg: setup.ffmpeg, video: record.source?.video ?? null, folder: record.folder, frame: frameRef(frame) })
      .finally(() => this.extracting.delete(key));
    this.extracting.set(key, next);
    return next;
  }

  /**
   * One frame for the live preview: its full-size picture and the faces the final render will find
   * in it (Apple Vision on the same file), so the preview puts the words where the saved thumbnail
   * will. A face search that fails is said (`facesError`), not hidden: the preview then places the
   * words by the layout alone and says so, and a save would stop on the same failure.
   */
  async frameDetail(jobId: string, itemId: string, frameId: string): Promise<FrameDetail> {
    const loc = this.locate(jobId, itemId);
    const record = this.actionable(loc, 'show');
    const file = await this.fullFrameOf(record, frameId);
    const picture = this.deps.pieces.framePicture(file);
    const mtimeMs = fs.statSync(file).mtimeMs;
    let hit = this.facesCache.get(file);
    if (hit === undefined || hit.mtimeMs !== mtimeMs) {
      // One search per frame, even when two cards ask for it at once; a failed one is asked again next time.
      const faces = this.deps.pieces.faces(file);
      hit = { mtimeMs, faces };
      this.facesCache.set(file, hit);
      faces.catch(() => {
        if (this.facesCache.get(file)?.faces === faces) this.facesCache.delete(file);
      });
    }
    try {
      return { frameId, ...picture, faces: await hit.faces, facesError: null };
    } catch (err) {
      return { frameId, ...picture, faces: null, facesError: message(err) };
    }
  }

  /** One reaction photo for the live preview, trimmed as the render trims it. */
  photoDetail(name: string): { name: string; image: string; width: number; height: number } {
    if (typeof name !== 'string' || name === '') throw new Error(`Say which reaction photo, got ${JSON.stringify(name)}.`);
    const file = libraryPhotos(this.deps.userDataPath).find((p) => p.name === name)?.file;
    if (file === undefined) throw new Error(`There is no reaction photo "${name}" in the app's library.`);
    return { name, ...this.deps.pieces.photo(name, file) };
  }

  /**
   * An own-image pick saved before 2026-09-29, still on its card, saved again as it is: checked
   * against YouTube's thumbnail rules. Nothing makes a new one (Owen's images are added as frames).
   */
  private checkOwn(file: unknown): string {
    if (typeof file !== 'string' || !path.isAbsolute(file)) throw new Error(`Your own image must be a file on this Mac, got ${JSON.stringify(file)}.`);
    if (!(IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(file).toLowerCase())) throw new Error(`${path.basename(file)} is not a PNG or JPEG.`);
    validateThumbnailFile(file);
    return file;
  }

  /**
   * Why a run of `stages` cannot start now: no Crucible server for the words (the one stage that
   * calls a model since the frame scoring was removed 2026-09-29). Null when it can. Checked again
   * when it is asked for.
   */
  private blockedFor(stages: readonly ThumbnailStage[]): string | null {
    if (stages.includes('words')) {
      const venue = this.deps.gpuVenue();
      if (venue.server === null) return `No Crucible server to run the models on: ${venue.reason}`;
    }
    return null;
  }

  private finishView(record: ItemThumbnails | null): FinishView | null {
    if (record === null || record.state !== 'failed' || record.failure === null) return null;
    const plan = resumePlan(record, fs.existsSync);
    // A record that stopped at a removed stage (the model's photo ranking, or its frame scoring) is
    // simply unfinished (Owen: "if the step was removed, why would it say it was removed?"): its old
    // reason no longer applies and the removed step is not named.
    const retired = record.failure.stage === 'tone-photos' || record.failure.stage === 'scoring';
    const reason = retired ? null : record.failure.reason;
    return { stage: record.failure.stage, retired, reason, keep: plan.keep, run: plan.run, blocked: this.blockedFor(plan.run) };
  }

  // ── writing ─────────────────────────────────────────────────────────────────

  /**
   * The picks' copies are rewritten to match `next` (a pick whose file is gone stops here, before
   * anything is saved), then the record is written through the one door.
   */
  private async write(loc: Located, jobId: string, itemId: string, next: ItemThumbnails): Promise<ItemThumbnails> {
    checkPicks(next.picks, loc.where);
    this.writeCopies(next);
    return loc.handler.updateItemThumbnails(jobId, itemId, () => next);
  }

  /**
   * After a save: a pair's old render goes when nothing points at it any more (no pick; the
   * published file is the pick's COPY in `picks/`, never the render) and it sits in the record's
   * folder. Keeps the folder to the renders in use while Owen saves again and again.
   */
  private dropOldRender(record: ItemThumbnails, old: StoredDefault['render'], where: string): void {
    if (!old.ok || record.folder === null) return;
    if (record.pairs.some((p) => p.default.render.ok && p.default.render.file === old.file)) return;
    if (record.picks.some((p) => p.file === old.file)) return;
    if (path.dirname(path.resolve(old.file)) !== path.resolve(record.folder)) return;
    if (!fs.existsSync(old.file)) return;
    fs.rmSync(old.file);
    log.info(`[Thumbnails] ${where}: removed the replaced render ${path.basename(old.file)} (no pick points at it)`);
  }

  /**
   * `<folder>/picks/`: exactly the picks, in order, as `Pick 1.png` ... (the folder is emptied
   * first, so a pick that moved or went leaves no stale copy). No picks: the folder is removed.
   */
  private writeCopies(record: ItemThumbnails): void {
    const folder = this.picksFolder(record);
    if (folder === null) return;
    if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
    if (record.picks.length === 0) return;
    fs.mkdirSync(folder, { recursive: true });
    for (const { n, pick, file } of pickCopies(record)) {
      if (!fs.existsSync(pick.file)) throw new Error(`Pick ${n}'s file is not on disk any more: ${pick.file}`);
      fs.copyFileSync(pick.file, file);
    }
  }

  /** The record, for a window action: refused, in plain words, when there is nothing to act on. */
  private actionable(loc: Located, what: string): ItemThumbnails {
    const r = loc.record;
    if (r === null) throw new Error(`This report was made before thumbnails were made in the metadata run, so there is nothing to ${what}. Use the Thumbnail row's Choose… for your own image.`);
    if (r.state === 'off') throw new Error(`${r.line} There is nothing to ${what}.`);
    return r;
  }

  private pairOf(record: ItemThumbnails, n: number): StoredPair {
    if (record.state !== 'made' && record.state !== 'no-story') throw new Error(`There are no thumbnails to change: ${record.line}`);
    const pair = record.pairs.find((p) => p.pair === n);
    if (pair === undefined) {
      if (record.pairs.length === 0) throw new Error(`Thumbnail ${n} has no title to go with: this report has no titles.`);
      throw new Error(`There is no title and thumbnail pair ${n} to draw card ${n} into: this report has ${record.pairs.length}.`);
    }
    return pair;
  }

  /** `Pair 1 - <title> (2)`, the first number whose .png and .jpg are both free. */
  private nextStem(folder: string, pair: StoredPair): string {
    const base = path.join(folder, `Pair ${pair.pair} - ${safeFileName(pair.title)}`);
    for (let k = 2; ; k++) {
      const stem = `${base} (${k})`;
      if (!fs.existsSync(`${stem}.png`) && !fs.existsSync(`${stem}.jpg`)) return stem;
    }
  }

  /** The cards as sent, checked: every card 1 to PAIR_COUNT once, each a known kind with its pieces. */
  private checkCards(record: ItemThumbnails, cards: unknown): CardRequest[] {
    if (!Array.isArray(cards)) throw new Error(`The cards must be a list, got ${JSON.stringify(cards)}.`);
    if (cards.length !== PAIR_COUNT) throw new Error(`The window sends all ${PAIR_COUNT} cards; ${cards.length} came.`);
    const seen = new Set<number>();
    const photos = new Set(this.deps.look.photoNames());
    return cards.map((raw, i) => {
      const c = raw as CardRequest;
      if (c === null || typeof c !== 'object') throw new Error(`Card ${i + 1} is not a card: ${JSON.stringify(raw)}.`);
      if (!Number.isInteger(c.card) || c.card < 1 || c.card > PAIR_COUNT) throw new Error(`A card is numbered ${JSON.stringify(c.card)}; the cards are 1 to ${PAIR_COUNT}.`);
      if (seen.has(c.card)) throw new Error(`Card ${c.card} came twice.`);
      seen.add(c.card);
      if (c.kind === 'empty') return { card: c.card, kind: 'empty' };
      if (c.kind === 'own') return { card: c.card, kind: 'own', file: this.checkOwn(c.file) };
      if (c.kind !== 'made') throw new Error(`Card ${(c as { card: number }).card} is neither a thumbnail, your own image nor empty: ${JSON.stringify(raw).slice(0, 160)}.`);
      this.pairOf(record, c.card);
      if (typeof c.frameId !== 'string' || !record.frames.some((f) => f.id === c.frameId)) throw new Error(`Card ${c.card}'s frame ${JSON.stringify(c.frameId)} is not among this report's candidate frames.`);
      let phrase: string | null = null;
      if (c.phrase !== null) {
        if (typeof c.phrase !== 'string') throw new Error(`Card ${c.card}'s words must be text or none, got ${JSON.stringify(c.phrase)}.`);
        phraseWords(c.phrase);
        phrase = c.phrase.trim();
      }
      if (c.textKind !== null && !(WORD_KINDS as readonly string[]).includes(c.textKind)) throw new Error(`Card ${c.card}: "${c.textKind}" is not a kind of words (${WORD_KINDS.join(', ')}).`);
      if (c.wordsFor !== null && (typeof c.wordsFor !== 'string' || c.wordsFor.trim() === '')) throw new Error(`Card ${c.card}: the title its words were written for must be text, got ${JSON.stringify(c.wordsFor)}.`);
      if (phrase === null && (c.textKind !== null || c.wordsFor !== null)) throw new Error(`Card ${c.card} has no words, and names where they came from.`);
      if (c.photo !== null && (typeof c.photo !== 'string' || !photos.has(c.photo))) throw new Error(`Card ${c.card}: there is no reaction photo ${JSON.stringify(c.photo)} in the app's library.`);
      const adjust = validateAdjust(c.adjust, `Card ${c.card}`);
      if (adjust.photo !== undefined && c.photo === null) throw new Error(`Card ${c.card} places a photo and has none.`);
      if (adjust.text !== undefined && phrase === null) throw new Error(`Card ${c.card} places words and has none.`);
      return { card: c.card, kind: 'made', frameId: c.frameId, phrase, textKind: c.textKind, wordsFor: c.wordsFor, photo: c.photo, adjust };
    });
  }

  /**
   * SAVE THUMBNAILS: the cards as Owen left them. Every card with a frame is drawn at 1280x720 with
   * its words, photo, edits, the border and the logo (a new file; the current saved look, so a look
   * changed since applies), one after another, the window told which card is being drawn. If one
   * cannot be drawn, what this save drew is removed and nothing is saved: the failure names the card.
   * Then the record takes every card (pair n = card n; an empty card's pair loses its frame) and
   * the picks become the cards in order, empty cards left out: card 1 is pick 1 when it is saved.
   */
  saveCards(jobId: string, itemId: string, cards: unknown): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'saving the thumbnails', async () => {
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'save');
      const asked = this.checkCards(record, cards);
      const made = asked.filter((c): c is Extract<CardRequest, { kind: 'made' }> => c.kind === 'made');
      let folder = record.folder;
      if (folder === null) {
        // A report with no story whose cards hold only an old own-image pick: the picks still need their folder.
        const txtFolder = loc.job.txt_folder;
        if (typeof txtFolder !== 'string' || txtFolder === '') throw new Error('The report records no folder, so there is nowhere to put the picks.');
        folder = path.join(txtFolder, THUMBNAILS_FOLDER, `${jobId}-${itemId}`);
      }
      const drawn = new Map<number, DrawnRender>();
      let style = record.look;
      let logo = false;
      if (made.length > 0) {
        const setup = this.setup();
        style = setup.style;
        logo = libraryLogo(this.deps.userDataPath) !== null;
        const renderer = setup.openRenderer();
        try {
          for (const [i, c] of made.entries()) {
            const pair = this.pairOf(record, c.card);
            const frame = record.frames.find((f) => f.id === c.frameId)!;
            this.deps.progress({ jobId, itemId, line: `Drawing thumbnail ${c.card} (${i + 1} of ${made.length})…`, card: c.card });
            try {
              drawn.set(c.card, await drawPair({
                renderer,
                ffmpeg: setup.ffmpeg,
                video: record.source?.video ?? null,
                folder,
                frame: frameRef(frame),
                phrase: c.phrase,
                photo: c.photo,
                logo,
                style: setup.style,
                userDataPath: this.deps.userDataPath,
                outStem: this.nextStem(folder, pair),
                adjust: noAdjust(c.adjust) ? null : c.adjust,
              }));
            } catch (err) {
              for (const d of drawn.values()) if (fs.existsSync(d.file)) fs.rmSync(d.file);
              throw new Error(`Thumbnail ${c.card} could not be drawn, so nothing was saved: ${message(err)}`);
            }
          }
        } finally {
          renderer.close();
        }
      }
      const byCard = new Map(asked.map((c) => [c.card, c]));
      const pairs = record.pairs.map((p): StoredPair => {
        const c = byCard.get(p.pair);
        if (c === undefined || c.kind === 'own') return p;
        if (c.kind === 'empty') {
          if (p.default.frameId === null && !p.default.render.ok && p.default.adjust === undefined) return p;
          const { adjust: _gone, ...rest } = p.default;
          return {
            ...p,
            default: { ...rest, frameId: null, scene: null, render: { ok: false, reason: 'Not drawn yet.' } },
            lines: p.lines.includes(NO_FRAME_YET) ? p.lines : [...p.lines, NO_FRAME_YET],
          };
        }
        const frame = record.frames.find((f) => f.id === c.frameId)!;
        const d: StoredDefault = {
          frameId: frame.id,
          scene: frame.origin === 'added' ? null : frame.scene,
          kind: c.phrase === null ? null : c.textKind,
          phrase: c.phrase,
          wordsFor: c.phrase === null ? null : c.wordsFor,
          photo: c.photo,
          draw: null,
          logo,
          render: drawn.get(p.pair)!,
          ...(noAdjust(c.adjust) ? {} : { adjust: c.adjust }),
        };
        // The run's "no frame / no photo picked yet" lines go once the card is saved.
        return { ...p, default: d, lines: p.lines.filter((l) => l !== NO_FRAME_YET && l !== NO_PHOTO_YET) };
      });
      const picks: ThumbnailPick[] = [];
      for (const c of [...asked].sort((a, b) => a.card - b.card)) {
        if (c.kind === 'own') picks.push({ kind: 'own', file: c.file, card: c.card });
        if (c.kind === 'made') {
          const pair = pairs.find((p) => p.pair === c.card)!;
          picks.push({ kind: 'made', pair: c.card, file: drawn.get(c.card)!.file, wordsFor: c.wordsFor ?? pair.title });
        }
      }
      const next: ItemThumbnails = { ...record, folder, look: style, pairs, picks };
      try {
        await this.write(loc, jobId, itemId, next);
      } catch (err) {
        for (const d of drawn.values()) if (fs.existsSync(d.file)) fs.rmSync(d.file);
        throw err;
      }
      for (const p of record.pairs) this.dropOldRender(next, p.default.render, loc.where);
      log.info(`[Thumbnails] ${loc.where}: saved the cards (${asked.map((c) => `${c.card} ${c.kind}`).join(', ')}): ${picks.length} pick(s)`);
      return this.view(jobId, itemId);
    });
  }

  /** The item's transcript lines, channel and creator: what the words read. */
  private itemContext(loc: Located): { transcript: string[]; channel: ReturnType<ReturnType<typeof promptAssets>['channel']>; creator: string; segments: any[] } {
    const sourcePath = loc.item.source_path;
    if (!this.hasTranscript(loc.item)) throw new Error(NO_TRANSCRIPT_WORDS);
    const promptSet = typeof loc.item._prompt_set === 'string' ? loc.item._prompt_set : null;
    if (promptSet === null) throw new Error('This report names no prompt set, so nothing says whose channel it is.');
    const channel = promptAssets().channel(promptSet);
    const terms = (channel.brandTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    if (terms.length === 0) throw new Error(`The prompt set "${channel.name}" declares no brand_terms, so nothing says who its creator is.`);
    const { record } = loadSavedTranscript(loc.outputDir, sourcePath);
    return { transcript: transcriptLines(record.segments), channel, creator: terms.join(', '), segments: record.segments };
  }

  /**
   * One words call for `title` on the `thumbnail_words` row (the window's held model), `avoid`
   * being lines already written for it ("More options"). The caller writes what comes back into
   * the record at once.
   */
  private async wordsCall(jobId: string, itemId: string, loc: Located, n: number, title: string, avoid: readonly string[], line: string): Promise<{ claim: string[]; stakes: string[]; reaction: string[]; warnings: string[]; model: string }> {
    const ctx = this.itemContext(loc);
    const option = (await this.routed('thumbnail_words', 'the Thumbnails window\'s words')).option;
    this.deps.progress({ jobId, itemId, line });
    const ai = this.deps.aiManager();
    try {
      const words = await this.textStep(option, (job) => writeThumbnailWords({
        aiManager: ai,
        option,
        ...(job === undefined ? {} : { job }),
        channel: ctx.channel.name,
        creator: ctx.creator,
        title,
        transcript: ctx.transcript,
        sourceLabel: `${loc.item._title ?? itemId} (pair ${n})`,
        avoid,
      }));
      const { claim, stakes, reaction, warnings } = words.options;
      return { claim, stakes, reaction, warnings, model: words.model };
    } finally {
      ai.cleanup?.();
    }
  }

  /**
   * The record as it is NOW with pair `n` changed by `change`, written through the one door. Read
   * again after the model answered, so nothing written meanwhile is lost (only one action runs per
   * item, and this is the same door every write takes).
   */
  private async writePair(jobId: string, itemId: string, n: number, change: (record: ItemThumbnails, pair: StoredPair) => ItemThumbnails): Promise<void> {
    const loc = this.locate(jobId, itemId);
    const record = this.actionable(loc, 'change');
    await this.write(loc, jobId, itemId, change(record, this.pairOf(record, n)));
  }

  /**
   * Write pair `n`'s words again for `title` (Owen reordered his titles, so card n now goes with
   * another title) on the `thumbnail_words` row. The pair takes the title and the new words; the
   * words it had are KEPT as earlier options for their title (never dropped). Its saved card is left
   * as it is (nothing is drawn: the window puts the new words on card n, and Save thumbnails draws
   * it). Answers the words to put on the card: the first of the kind the card's words were (claim,
   * stakes, reaction for cards 1-3 when it had none), else the first there is.
   */
  pairTitle(jobId: string, itemId: string, n: number, title: string, kind: WordKind | null): Promise<{ view: ThumbnailsView; text: { kind: WordKind; phrase: string; wordsFor: string } }> {
    return this.exclusive(jobId, itemId, 'writing words', async () => {
      if (typeof title !== 'string' || title.trim() === '') throw new Error('Say which title the words are for.');
      if (kind !== null && !(WORD_KINDS as readonly string[]).includes(kind)) throw new Error(`"${kind}" is not a kind of words (${WORD_KINDS.join(', ')}).`);
      const wanted = title.trim();
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'rewrite');
      this.pairOf(record, n);
      const words = await this.wordsCall(jobId, itemId, loc, n, wanted, [], `Writing the words for “${wanted}”...`);
      const { claim, stakes, reaction } = words;
      const chosen = defaultWords({ claim, stakes, reaction }, kind ?? PAIR_KINDS[(n - 1) % PAIR_KINDS.length]);
      if (chosen === null) throw new Error(`The words for “${wanted}” came back with no option of any kind.`);
      await this.writePair(jobId, itemId, n, (now, pair) => {
        const next: StoredPair = {
          ...pair,
          title: wanted,
          words,
          photos: [],
          lines: [
            ...pair.lines.filter((l) => l === NO_FRAME_YET || l === NO_PHOTO_YET),
            ...(chosen.line === null ? [] : [chosen.line]),
            `Words written for this title on ${words.model}.`,
          ],
        };
        return { ...now, earlierWords: keepEarlier(now, [{ ...pair.words, title: pair.title }]), pairs: now.pairs.map((p) => (p.pair === n ? next : p)) };
      });
      log.info(`[Thumbnails] ${loc.where}: pair ${n}'s words rewritten for “${wanted}” on ${words.model}; the ones it had are kept as earlier options`);
      return { view: this.view(jobId, itemId), text: { kind: chosen.kind, phrase: chosen.phrase, wordsFor: wanted } };
    });
  }

  /**
   * THE TEXT TRAY'S "NEW OPTIONS" AND "MORE OPTIONS" for pair `n`'s title (Owen, 2026-09-29: "i
   * should have a re-roll option to regenerate options (or MORE options if i want) but it shouldnt
   * disappear"). Nothing already written is dropped:
   *   new   a fresh set becomes the pair's words, listed first; the set it had is kept as earlier
   *         options for the title;
   *   more  the model is shown every line already written for the title and asked for others; the
   *         new lines are added after the pair's own, a line already written never twice.
   * Written into the record the moment the model answers, whether the window is still open or not.
   */
  writeWords(jobId: string, itemId: string, n: number, mode: 'new' | 'more'): Promise<WrittenWords> {
    return this.exclusive(jobId, itemId, 'writing words', async () => {
      if (mode !== 'new' && mode !== 'more') throw new Error(`Ask for "new" or "more" options, got ${JSON.stringify(mode)}.`);
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'write words for');
      const title = this.pairOf(record, n).title;
      const avoid = mode === 'more' ? linesWrittenFor(record, title) : [];
      const words = await this.wordsCall(jobId, itemId, loc, n, title, avoid,
        mode === 'more' ? `Writing more options for “${title}”...` : `Writing new options for “${title}”...`);
      let line = '';
      await this.writePair(jobId, itemId, n, (now, pair) => {
        if (pair.title !== title) throw new Error(`Pair ${n}'s title changed to “${pair.title}” while the words for “${title}” were written.`);
        if (mode === 'new') {
          line = `${linesOfCount(words)} new options for “${title}” on ${words.model}; the earlier ones are kept below them.`;
          return {
            ...now,
            earlierWords: keepEarlier(now, [{ ...pair.words, title }]),
            pairs: now.pairs.map((p) => (p.pair === n ? { ...p, words, lines: [...p.lines, `New options written on ${words.model}.`] } : p)),
          };
        }
        const merged = appendWords(pair.words, words, linesWrittenFor(now, title));
        line = merged.added === 0
          ? `The model wrote nothing new for “${title}”: all ${merged.repeated} of its lines were already there.`
          : `${merged.added} more option${merged.added === 1 ? '' : 's'} for “${title}” on ${words.model}` + (merged.repeated > 0 ? ` (${merged.repeated} it repeated were left out).` : '.');
        return {
          ...now,
          pairs: now.pairs.map((p) => (p.pair === n ? { ...p, words: merged.words, lines: merged.added === 0 ? p.lines : [...p.lines, `More options written on ${words.model}.`] } : p)),
        };
      });
      log.info(`[Thumbnails] ${loc.where}: ${line}`);
      return { view: this.view(jobId, itemId), line };
    });
  }

  // ── images Owen adds as frames ───────────────────────────────────────────────

  /**
   * IMAGES OWEN ADDS AS FRAMES (2026-09-29, Owen: "it didnt come up with any good screenshots for
   * one of my videos... lets make it so i can drag/drop them into the slot ... it should just fit to
   * fill the whole thing. if it needs to be adjusted, i can edit it already"). Each file (absolute,
   * on disk, PNG or JPEG) becomes a new candidate frame `addedN`: cut to fill 16:9 around its centre
   * and written at 1920x1080 into `<folder>/full/<id>.png` (prepareStill, its line logged and kept
   * on the record), with the grid's two JPEGs beside the sampler's in `<folder>/added/`. His file is
   * only read. They are listed first in the Frames tray; the words, photo, logo and border go on top
   * as on any frame, and Edit zooms or moves them. A report with no folder yet (one with no
   * story) gets `<report folder>/thumbnails/<jobId>-<itemId>/`, and its cards' pairs are stored. One that is not ready (failed) is refused: it is prepared first. If one
   * file cannot be read, nothing is added and the file is named.
   */
  addFrames(jobId: string, itemId: string, files: unknown): Promise<AddedFrames> {
    return this.exclusive(jobId, itemId, 'adding your images', async () => {
      if (!Array.isArray(files) || files.length === 0) throw new Error('Give at least one image to add.');
      for (const f of files) {
        if (typeof f !== 'string' || !path.isAbsolute(f)) throw new Error(`The image must be a file on this Mac, got ${JSON.stringify(f)}.`);
        if (!fs.existsSync(f) || !fs.statSync(f).isFile()) throw new Error(`${path.basename(f)} is not a file on this Mac (${f}).`);
        if (!(IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(f).toLowerCase())) throw new Error(`${path.basename(f)} is not a PNG or JPEG, so it cannot be used as a frame.`);
      }
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'add images to');
      if (record.state === 'failed') throw new Error("This video's frames and text are not ready yet; they are prepared first, then you can add your images.");
      let folder = record.folder;
      if (folder === null) {
        const txtFolder = loc.job.txt_folder;
        if (typeof txtFolder !== 'string' || txtFolder === '') throw new Error('The report records no folder, so there is nowhere to put your images.');
        folder = path.join(txtFolder, THUMBNAILS_FOLDER, `${jobId}-${itemId}`);
      }
      const setup = this.setup();
      const frames: StoredFrame[] = [];
      const lines: string[] = [];
      const written: string[] = [];
      try {
        for (const [i, file] of (files as string[]).entries()) {
          const id = nextAddedFrameId([...record.frames, ...frames]);
          const full = path.join(folder, 'full', `${id}.png`);
          const large = path.join(folder, ADDED_FOLDER, `${id}.jpg`);
          const small = path.join(folder, ADDED_FOLDER, `${id}-small.jpg`);
          if ([full, large, small].some((x) => fs.existsSync(x))) throw new Error(`${path.basename(full)} is already in ${folder} and the record does not name it; it is not written over.`);
          this.deps.progress({ jobId, itemId, line: `Adding your image ${i + 1} of ${files.length}: ${path.basename(file)}...` });
          written.push(full, large, small);
          let still: { line: string };
          try {
            still = await prepareStill(setup.ffmpeg, this.deps.ffprobe, file, full);
            await writeGridPictures(setup.ffmpeg, full, large, small);
          } catch (err) {
            throw new Error(`${path.basename(file)} could not be used as a frame, so no image was added: ${message(err)}`);
          }
          frames.push({ id, t: 0, clock: '', scene: 0, large, small, origin: 'added', from: path.basename(file) });
          lines.push(still.line);
          log.info(`[Thumbnails] ${loc.where}: added ${id}: ${still.line}`);
        }
      } catch (err) {
        for (const x of written) if (fs.existsSync(x)) fs.rmSync(x);
        throw err;
      }
      const next: ItemThumbnails = {
        ...record,
        folder,
        frames: [...record.frames, ...frames],
        lines: [...record.lines, ...frames.map((f, i) => `Your image ${f.id}: ${lines[i]}`)],
      };
      try {
        await this.write(loc, jobId, itemId, next);
      } catch (err) {
        for (const x of written) if (fs.existsSync(x)) fs.rmSync(x);
        throw err;
      }
      return { view: this.view(jobId, itemId), added: frames.map((f) => f.id), lines };
    });
  }

  // ── a report whose thumbnail stages stopped ──────────────────────────────────

  /**
   * The item as the stages read it, for preparing it: its saved transcript, channel, report folder,
   * the content link Owen made on the Inputs page (the story's manual method), and whether it is a
   * video. The report does not store the item's input kind; a measured video duration
   * (content_provenance.final_duration_sec, ffprobed by transcription for a video only) says it is
   * one, and without it the story stage says there is no video to take frames from. `linked`: the
   * record already linked a story, which only a video item gets.
   */
  private itemInput(loc: Located, jobId: string, linked: boolean): ThumbnailItemInput {
    const ctx = this.itemContext(loc);
    const txtFolder = loc.job.txt_folder;
    if (typeof txtFolder !== 'string' || txtFolder === '') throw new Error('The report records no folder, so there is nowhere to put the thumbnails.');
    const provenance = loc.item.content_provenance ?? null;
    const measured = provenance !== null && typeof provenance.final_duration_sec === 'number';
    return {
      jobId,
      itemIndex: loc.job.items.indexOf(loc.item),
      sourceLabel: String(loc.item._title ?? loc.item.item_id),
      contentType: linked || measured ? 'video' : 'transcript_file',
      videoPath: typeof loc.item.source_path === 'string' ? loc.item.source_path : null,
      operatorRef: provenance?.transcript_ref ?? null,
      segments: ctx.segments,
      reportFolder: txtFolder,
      channel: ctx.channel,
    };
  }

  /** The item's fields the words read (as the metadata run hands them over). */
  private fieldsOf(item: any): { titles: unknown; reroll_gate: any } {
    return { titles: item.titles, reroll_gate: item.reroll_gate ?? null };
  }

  /**
   * Run the stages on ONE held Crucible job (the window's text hold is given back first, so this
   * window has one job on the card), and give it back after, whatever happened. Every model call
   * inside is its own GPU step on the lanes, as in the metadata run.
   */
  private async stagesOnOneJob(jobId: string, itemId: string, what: string, make: (doors: import('./pipeline').ThumbnailJobDoors) => ItemThumbnailRun, fields: ReturnType<ReportThumbnails['fieldsOf']>): Promise<ItemThumbnails> {
    await this.releaseHold(`${what} takes the card`);
    const sessions = this.deps.holdJob(what);
    const ai = this.deps.aiManager();
    try {
      const routing = this.routing();
      const run = make({
        sessions,
        aiManager: ai,
        routing,
        // Bound on the server these stages run on, from one catalog read, before anything is loaded.
        models: await readRoutingModels(what, [routing.thumbnail_words], this.deps.gpuVenue),
        cancelled: () => false,
        progress: (line) => this.deps.progress({ jobId, itemId, line }),
      });
      // The frames (ffmpeg, CPU) and the words (the model) side by side when the story is kept:
      // neither reads what the other makes. The render needs both, so it comes after.
      if (run.storyKept()) {
        await Promise.all([run.beforeChapters(), run.wordsStage(fields)]);
      } else {
        await run.beforeChapters();
        await run.wordsStage(fields);
      }
      await run.renderStage();
      return run.record();
    } finally {
      ai.cleanup?.();
      await sessions.releaseAll();
    }
  }

  /**
   * PREPARING A VIDEO THAT IS NOT READY (the window does it on opening): a record whose stages
   * stopped goes on from what it stores. The stages whose output is all there are kept (frames and
   * words are never made again); the missing ones run in order on the routing table's rows, on one
   * held job. The new record is written whatever happened: made, or stopped again with the new
   * stage and reason.
   */
  finish(jobId: string, itemId: string): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'preparing the frames and text', async () => {
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'prepare');
      if (record.state !== 'failed' || record.failure === null) throw new Error(`Nothing stopped, so there is nothing to prepare: ${record.line}`);
      const plan = resumePlan(record, fs.existsSync);
      const blocked = this.blockedFor(plan.run);
      if (blocked !== null) throw new Error(blocked);
      const setup = this.setup();
      const input = this.itemInput(loc, jobId, record.story?.state === 'linked');
      this.deps.progress({ jobId, itemId, line: plan.run.includes('frames') ? 'Picking the frames, then writing the text...' : plan.run.includes('words') ? 'Writing the text...' : 'Drawing...' });
      if (plan.run.includes('frames')) this.facesCache.clear();
      const made = await this.stagesOnOneJob(jobId, itemId, 'Preparing thumbnail frames and text',
        (doors) => ItemThumbnailRun.resume(setup, input, doors, record, plan), this.fieldsOf(loc.item));
      await this.write(loc, jobId, itemId, made);
      log.info(`[Thumbnails] ${loc.where}: prepared (kept ${plan.keep.join(', ') || 'nothing'}; ran ${plan.run.join(', ')}): ${made.line}`);
      return this.view(jobId, itemId);
    });
  }
}
