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
 *     when he reorders his titles so card n now goes with a different title;
 *   - for a report with NO STORY (or whose stages failed), gives 1 to 3 of his own screenshots
 *     (`useScreenshots`): that many pairs are made from them, the words by the model as in the run
 *     (pipeline.ts ItemThumbnailRun.fromScreenshots);
 *   - for a report whose thumbnail stages STOPPED, the window prepares what is missing on opening
 *     (`finish`): the stages it stores are kept (frames, words) and only the missing ones run
 *     (pipeline.ts resumePlan / ItemThumbnailRun.resume).
 *
 * THE MODEL IS HELD across the window's words steps (the tab's pattern, which Owen asked for: "if
 * we're using the 27b anyway we might as well keep it loaded"): one held job per local model,
 * given back when another model is needed, when the window closes, on quit, or after
 * TEXT_HOLD_IDLE_MS with no step.
 *
 * ONE ACTION PER ITEM AT A TIME: a model step reads the record, waits a minute for the model and
 * writes it back, and a save landing in between would be written away; a second action on the same
 * item is refused in plain words while one runs. Every write goes through the one door,
 * OutputHandlerService.updateItemThumbnails.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import type { JobLeases } from '../../crucible/lease';
import type { AIManagerService } from '../metadata/ai-manager.service';
import { migrateStoredRouting, resolveMetadataRouting, routingOption, type MetadataRoutingOption, type ResolvedMetadataRouting, type RoutingModels } from '../metadata/metadata-routing';
import { readRoutingModels } from '../metadata/routing-models';
import { OutputHandlerService } from '../metadata/output-handler.service';
import { promptAssets } from '../metadata/prompt-assets';
import { loadSavedTranscript } from '../metadata/saved-transcript.service';
import { validateThumbnailFile } from '../publish/thumbnail-validate';
import { noAdjust, phraseWords, placeLogo, validateAdjust, type CardAdjust, type Rect, type ThumbnailStyle } from '../../shared/thumbnail-layout';
import { prepareStill } from './frame-sampler';
import type { ThumbnailLook } from './look';
import { libraryBorder, libraryLogo, libraryPhotos } from './photo-library';
import {
  ItemThumbnailRun,
  defaultWords,
  drawPair,
  fullFrame,
  NO_FRAME_YET,
  NO_PHOTO_YET,
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
  checkPicks,
  pickCopies,
  readItemThumbnails,
  type ItemThumbnails,
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

/** The file types Owen can give as his own thumbnail or as a screenshot. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

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
  holdJob: (what: string) => JobLeases;
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
  /** True when the window has something to do: pairs to pick from, or screenshots to give. */
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

export class ReportThumbnails {
  private readonly busy = new Map<string, string>();
  private textHold: { job: JobLeases; model: string; timer: ReturnType<typeof setTimeout> | null } | null = null;
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
    const outputDir = this.outputDir();
    const handler = OutputHandlerService.forOutputDir(outputDir);
    const job = handler.getJobMetadata(jobId) as unknown as Located['job'] | null;
    if (job === null) throw new Error(`The report's job ${jobId} is not there any more.`);
    if (!Array.isArray(job.items)) throw new Error(`Job ${jobId} has no items list; the report file is damaged.`);
    const item = job.items.find((i) => i && i.item_id === itemId);
    if (item === undefined) throw new Error(`Item ${itemId} is not in job ${jobId} any more.`);
    const where = `item ${itemId} of job ${jobId}`;
    return { outputDir, handler, job, item, record: readItemThumbnails(item.thumbnails, where), where };
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
  private async textJob(option: MetadataRoutingOption): Promise<JobLeases | undefined> {
    if (option.kind !== 'local' || option.crucibleModel === null) return undefined;
    const model = option.crucibleModel;
    if (this.textHold !== null && this.textHold.model !== model) await this.releaseHold(`the next step runs on ${model}`);
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

  /** Give the text model's lease back. Never throws: it is housekeeping. Returns the model released. */
  async releaseHold(reason: string): Promise<string | null> {
    const hold = this.textHold;
    this.textHold = null;
    if (hold === null) return null;
    if (hold.timer !== null) clearTimeout(hold.timer);
    const lost = await hold.job.releaseAll();
    for (const line of lost) log.error(`[Thumbnails] the window's text steps lost their lease on ${line} before it was given back`);
    log.info(`[Thumbnails] released ${hold.model}: ${reason}`);
    return hold.model;
  }

  /** The window closed: the text model goes back and the face search's hidden page goes. Never throws. */
  async closed(): Promise<string | null> {
    this.deps.pieces.close();
    return this.releaseHold('the Thumbnails window was closed');
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
      line: record.line,
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
    };
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
    const next = fullFrame({ ffmpeg: setup.ffmpeg, video: record.source?.video ?? null, folder: record.folder, frame: { id: frame.id, t: frame.t } })
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

  /** Owen's own image for a card: checked against YouTube's thumbnail rules now, so a refusal comes at once. */
  ownImage(file: string): { file: string; picture: string } {
    this.checkOwn(file);
    return { file, picture: this.deps.picture(file, 640) };
  }

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
    if (record.state !== 'made') throw new Error(`There are no thumbnails to change: ${record.line}`);
    const pair = record.pairs.find((p) => p.pair === n);
    if (pair === undefined) throw new Error(`There is no title and thumbnail pair ${n} to draw card ${n} into: this report has ${record.pairs.length}.`);
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
        // A report with no story and only Owen's own images: the picks still need their folder.
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
                frame: { id: frame.id, t: frame.t },
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
          scene: frame.scene,
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
    if (typeof sourcePath !== 'string' || sourcePath === '') throw new Error('This report has lost track of the video it was made from, so there is no transcript to write words from.');
    const promptSet = typeof loc.item._prompt_set === 'string' ? loc.item._prompt_set : null;
    if (promptSet === null) throw new Error('This report names no prompt set, so nothing says whose channel it is.');
    const channel = promptAssets().channel(promptSet);
    const terms = (channel.brandTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    if (terms.length === 0) throw new Error(`The prompt set "${channel.name}" declares no brand_terms, so nothing says who its creator is.`);
    const { record } = loadSavedTranscript(loc.outputDir, sourcePath);
    return { transcript: transcriptLines(record.segments), channel, creator: terms.join(', '), segments: record.segments };
  }

  /**
   * Write pair `n`'s words again for `title` (Owen reordered his titles, so card n now goes with
   * another title) on the `thumbnail_words` row. The pair takes the title and the new words; its
   * saved card is left as it is (nothing is drawn: the window puts the new words on card n, and Save
   * thumbnails draws it). Answers the words to put on the card: the first of the kind the card's
   * words were (claim, stakes, reaction for cards 1-3 when it had none), else the first there is.
   */
  pairTitle(jobId: string, itemId: string, n: number, title: string, kind: WordKind | null): Promise<{ view: ThumbnailsView; text: { kind: WordKind; phrase: string; wordsFor: string } }> {
    return this.exclusive(jobId, itemId, 'writing words', async () => {
      if (typeof title !== 'string' || title.trim() === '') throw new Error('Say which title the words are for.');
      if (kind !== null && !(WORD_KINDS as readonly string[]).includes(kind)) throw new Error(`"${kind}" is not a kind of words (${WORD_KINDS.join(', ')}).`);
      const wanted = title.trim();
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'rewrite');
      const pair = this.pairOf(record, n);
      const ctx = this.itemContext(loc);
      const wordsOption = (await this.routed('thumbnail_words', 'the Thumbnails window\'s words')).option;
      this.deps.progress({ jobId, itemId, line: `Writing the words for “${wanted}”...` });
      const ai = this.deps.aiManager();
      let words;
      try {
        words = await writeThumbnailWords({
          aiManager: ai,
          option: wordsOption,
          job: await this.textJob(wordsOption),
          channel: ctx.channel.name,
          creator: ctx.creator,
          title: wanted,
          transcript: ctx.transcript,
          sourceLabel: `${loc.item._title ?? itemId} (pair ${n})`,
        });
      } catch (err) {
        await this.releaseHold('the words step failed');
        throw err;
      } finally {
        ai.cleanup?.();
      }
      const { claim, stakes, reaction, warnings } = words.options;
      const chosen = defaultWords({ claim, stakes, reaction }, kind ?? PAIR_KINDS[(n - 1) % PAIR_KINDS.length]);
      if (chosen === null) throw new Error(`The words for “${wanted}” came back with no option of any kind.`);
      const next: StoredPair = {
        ...pair,
        title: wanted,
        words: { claim, stakes, reaction, warnings, model: words.model },
        photos: [],
        lines: [
          ...pair.lines.filter((l) => l === NO_FRAME_YET || l === NO_PHOTO_YET),
          ...(chosen.line === null ? [] : [chosen.line]),
          `Words written for this title on ${words.model}.`,
        ],
      };
      await this.write(loc, jobId, itemId, { ...record, pairs: record.pairs.map((p) => (p.pair === n ? next : p)) });
      log.info(`[Thumbnails] ${loc.where}: pair ${n}'s words rewritten for “${wanted}” on ${words.model}`);
      return { view: this.view(jobId, itemId), text: { kind: chosen.kind, phrase: chosen.phrase, wordsFor: wanted } };
    });
  }

  /**
   * NO STORY: 1 to 3 of Owen's screenshots become that many pairs, for `titles` (the page sends his
   * chosen titles first, then the generated ones, one per screenshot). His files are only read; each
   * is cut to 16:9 around its centre if it is another shape (said) and written into `full/`. The
   * words run on the routing table's row, as in the metadata run (no photo until he picks); the record's story
   * (and why there was none) is kept. His own-image picks stay; pair picks are cleared (new pairs).
   */
  useScreenshots(jobId: string, itemId: string, files: string[], titles: string[]): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'making thumbnails from your screenshots', async () => {
      if (!Array.isArray(files) || files.length < 1 || files.length > PAIR_COUNT) throw new Error(`Give 1 to ${PAIR_COUNT} screenshots; ${Array.isArray(files) ? files.length : 'none'} were given.`);
      for (const f of files) {
        if (typeof f !== 'string' || !path.isAbsolute(f) || !fs.existsSync(f)) throw new Error(`The screenshot is not a file on this Mac: ${JSON.stringify(f)}.`);
        if (!(IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(f).toLowerCase())) throw new Error(`${path.basename(f)} is not a PNG or JPEG.`);
      }
      if (!Array.isArray(titles) || titles.length !== files.length || titles.some((t) => typeof t !== 'string' || t.trim() === '')) {
        throw new Error(`Each screenshot needs a title to write its words for: ${files.length} screenshot(s), ${Array.isArray(titles) ? titles.length : 0} title(s).`);
      }
      if (new Set(titles.map((t) => t.trim())).size !== titles.length) throw new Error('One title is named twice; each screenshot gets its own title.');
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'make');
      const fromShots = record.state === 'made' && record.source !== null && record.source.video === null;
      if (record.state === 'made' && !fromShots) throw new Error('This report already has thumbnails from its story; screenshots are for a report with no story.');
      const txtFolder = loc.job.txt_folder;
      if (typeof txtFolder !== 'string' || txtFolder === '') throw new Error('The report records no folder, so there is nowhere to put the thumbnails.');
      const parent = path.join(txtFolder, THUMBNAILS_FOLDER);
      const folder = record.folder ?? path.join(parent, `${jobId}-${itemId}`);
      if (path.dirname(path.resolve(folder)) !== path.resolve(parent)) throw new Error(`The record's folder ${folder} is not in this report's ${THUMBNAILS_FOLDER} folder, so it is not replaced.`);
      const setup = this.setup();
      const ctx = this.itemContext(loc);
      // A failed run's frames, or earlier screenshots, are replaced; the picks folder is rewritten.
      if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
      this.facesCache.clear();
      const shots: Array<{ id: string; full: string; lines: string[] }> = [];
      for (const [i, file] of files.entries()) {
        const id = `shot${i + 1}`;
        const full = path.join(folder, 'full', `${id}.png`);
        const still = await prepareStill(setup.ffmpeg, this.deps.ffprobe, file, full);
        shots.push({ id, full, lines: [`Screenshot ${i + 1}: ${still.line}`] });
      }
      // The words on the window's held model when the row is local; a cloud or `claude -p` row
      // holds no card, and its run gets a job of its own (nothing is leased on it), given back after.
      const words = await this.routed('thumbnail_words', 'Thumbnails from your screenshots');
      const held = await this.textJob(words.option);
      const own = held === undefined ? this.deps.holdJob('Thumbnails from your screenshots') : null;
      const leases = held ?? own!;
      const ai = this.deps.aiManager();
      try {
        const run = ItemThumbnailRun.fromScreenshots(
          setup,
          {
            jobId,
            itemIndex: 0,
            sourceLabel: String(loc.item._title ?? itemId),
            contentType: 'video',
            videoPath: typeof loc.item.source_path === 'string' ? loc.item.source_path : null,
            operatorRef: null,
            segments: ctx.segments,
            reportFolder: txtFolder,
            channel: ctx.channel,
          },
          {
            leases,
            aiManager: ai,
            routing: words.routing,
            models: words.models,
            cancelled: () => false,
            progress: (line) => this.deps.progress({ jobId, itemId, line }),
          },
          { story: record.story, folder },
          shots,
        );
        await run.afterFields({ titles: titles.map((t) => t.trim()), reroll_gate: null });
        const made = run.record();
        if (made.state === 'failed') await this.releaseHold('a screenshots step failed');
        const own = record.picks.filter((p) => p.kind === 'own');
        const next: ItemThumbnails = { ...made, picks: own };
        await this.write(loc, jobId, itemId, next);
        log.info(`[Thumbnails] ${loc.where}: ${files.length} screenshot(s): ${made.line}`);
      } finally {
        ai.cleanup?.();
        if (own !== null) {
          const lost = await own.releaseAll();
          for (const line of lost) log.error(`[Thumbnails] the screenshots run lost its lease on ${line} before it was given back`);
        }
      }
      return this.view(jobId, itemId);
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
    const leases = this.deps.holdJob(what);
    const ai = this.deps.aiManager();
    try {
      const routing = this.routing();
      const run = make({
        leases,
        aiManager: ai,
        routing,
        // Bound on the server these stages run on, from one catalog read, before anything is loaded.
        models: await readRoutingModels(what, [routing.thumbnail_words], this.deps.gpuVenue),
        cancelled: () => false,
        progress: (line) => this.deps.progress({ jobId, itemId, line }),
      });
      await run.beforeChapters();
      await run.afterFields(fields);
      return run.record();
    } finally {
      ai.cleanup?.();
      const lost = await leases.releaseAll();
      for (const line of lost) log.error(`[Thumbnails] ${what} lost its lease on ${line} before it was given back`);
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
