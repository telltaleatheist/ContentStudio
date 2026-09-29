/**
 * THE REPORTS PAGE'S THUMBNAILS WINDOW, main-process side (phase 2, Owen 2026-09-28;
 * docs/thumbnails-pipeline.md). The metadata run already made the title and thumbnail pairs and
 * stored them on the item (`thumbnails`, pipeline-record.ts). Here Owen:
 *
 *   - swaps any piece of a pair (frame, words, photo, logo) and it is drawn again, on the CPU
 *     (`renderPair`; the window asks for it when he presses Generate thumbnails): a NEW file beside
 *     the old one, so a file a pick or the publish record points at is never overwritten under it;
 *   - has a pair's words written again for another title (`pairTitle`, the words row on demand,
 *     then a render with the photo he picked), when he reorders his titles so thumbnail n now goes
 *     with a different title n;
 *   - saves his ORDERED picks (`savePicks`): up to three, a pair's render or his own image file,
 *     index 0 first. Pick n goes with chosen title n (Test & Compare's "title and thumbnail"). The
 *     picks are copied into `<folder>/picks/Pick 1.png` ...: pick 1's copy is what the reports page
 *     sets as the video's thumbnail through the publish record's one thumbnail door; picks 2 and 3
 *     sit beside it for his manual Test & Compare upload in Studio (YouTube has no API for them);
 *   - for a report with NO STORY (or whose stages failed), gives 1 to 3 of his own screenshots
 *     (`useScreenshots`): that many pairs are made from them, the words by the model as in the run
 *     (pipeline.ts ItemThumbnailRun.fromScreenshots);
 *   - for a report whose thumbnail stages STOPPED, "Finish making thumbnails" (`finish`, 2026-09-29):
 *     the stages it stores are kept (frames, words) and only the missing ones run
 *     (pipeline.ts resumePlan / ItemThumbnailRun.resume); "Make thumbnails again from scratch"
 *     (`remake`) runs every thumbnail stage again for the item.
 *
 * THE WINDOW COMPOSES (2026-09-29, Owen: "i pick three [frames]. the text it generated. i pick
 * three. it overlays them"): thumbnail n is drawn into pair n from frame n, text n (written for ANY
 * of the titles: `wordsFor`), photo n (Owen's pick, or none: the model's photo ranking was removed
 * the same day, "just let me pick the image of myself ... itll be faster") and the logo. A redrawn
 * pair's old file is removed once no pick points at it (the picks' copies in `picks/` are what is
 * published), so generating again does not pile files up.
 *
 * THE MODEL IS HELD across the window's words steps (the tab's pattern, which Owen asked for: "if
 * we're using the 27b anyway we might as well keep it loaded"): one held job per local model,
 * given back when another model is needed, when the window closes, on quit, or after
 * TEXT_HOLD_IDLE_MS with no step.
 *
 * ONE ACTION PER ITEM AT A TIME: a model step reads the record, waits a minute for the model and
 * writes it back, and a swap landing in between would be written away; a second action on the same
 * item is refused in plain words while one runs. Every write goes through the one door,
 * OutputHandlerService.updateItemThumbnails.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import type { JobLeases } from '../../crucible/lease';
import type { AIManagerService } from '../metadata/ai-manager.service';
import { migrateStoredRouting, resolveMetadataRouting, routingOption, type MetadataRoutingOption, type ResolvedMetadataRouting } from '../metadata/metadata-routing';
import { OutputHandlerService } from '../metadata/output-handler.service';
import { promptAssets } from '../metadata/prompt-assets';
import { loadSavedTranscript } from '../metadata/saved-transcript.service';
import { validateThumbnailFile } from '../publish/thumbnail-validate';
import { prepareStill } from './frame-sampler';
import { phraseWords } from './layout';
import type { ThumbnailLook } from './look';
import {
  ItemThumbnailRun,
  defaultWords,
  drawPair,
  NO_FRAME_YET,
  NO_PHOTO_YET,
  resumePlan,
  type ThumbnailItemInput,
  type ThumbnailRunChoice,
  type ThumbnailRunSetup,
} from './pipeline';
import {
  PAIR_COUNT,
  PAIR_KINDS,
  PICKS_FOLDER,
  THUMBNAIL_STAGES,
  THUMBNAILS_FOLDER,
  checkPicks,
  pickCopies,
  readItemThumbnails,
  type ItemThumbnails,
  type StoredPair,
  type RecordedStage,
  type ThumbnailPick,
  type ThumbnailStage,
} from './pipeline-record';
import { transcriptLines, WORD_KINDS, type WordKind } from './prompts';
import { safeFileName } from './renderer';
import { writeThumbnailWords } from './words-writer';

/** How long the window keeps its text model held after its last words step. */
export const TEXT_HOLD_IDLE_MS = 5 * 60_000;

/** The file types Owen can give as his own thumbnail or as a screenshot. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

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
  /** A progress line for the window that asked. */
  progress: (event: { jobId: string; itemId: string; line: string }) => void;
  /** The Crucible server a GPU step started now would run on, or why there is none (lanes.gpuVenue). */
  gpuVenue: () => { server: string } | { server: null; reason: string };
}

/** A change to one pair: every field left out stays as it is. */
export interface PairChange {
  pair: number;
  frameId?: string;
  /** The words (null: "No text"). */
  phrase?: string | null;
  /** Where the words came from (null: typed by Owen, or no text). */
  kind?: WordKind | null;
  /**
   * The title the words were written for (the window offers every pair's words, so thumbnail n may
   * carry words written for title 2). Left out: the pair's own title for generated words, null for
   * typed words or no text.
   */
  wordsFor?: string | null;
  /** A photo name from the library, or null for no photo. */
  photo?: string | null;
  logo?: boolean;
}

/** The picks as the page sends them. */
export type PickRequest = { kind: 'made'; pair: number } | { kind: 'own'; file: string };

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
 * A record whose stages stopped: where, why, what "Finish making thumbnails" keeps and runs, and why
 * it cannot run now (null when it can).
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

/** Everything the window shows. Pictures are keyed by absolute file path, frames by frame id. */
export interface ThumbnailsView extends ThumbnailsSummary {
  jobId: string;
  itemId: string;
  title: string;
  record: ItemThumbnails | null;
  /** The item's generated titles (the words can be rewritten for any title). */
  titles: string[];
  /** Pictures of the pairs' renders (keyed by file path) and of every candidate frame (keyed by id). */
  renders: Record<string, string>;
  frames: Record<string, string>;
  photos: Array<{ name: string; preview: string }>;
  hasLogo: boolean;
  /** The text model held for the next words step, or null. */
  heldModel: string | null;
  /** Set when the record's stages stopped (state `failed`): "Finish making thumbnails". */
  finish: FinishView | null;
  /**
   * "Make thumbnails again from scratch": null when it is not offered (no record, off, or made from
   * screenshots); else why it cannot run now, or null inside when it can.
   */
  remake: { blocked: string | null } | null;
}

interface Located {
  outputDir: string;
  handler: OutputHandlerService;
  job: { txt_folder?: string; items: any[] };
  item: any;
  record: ItemThumbnails | null;
  where: string;
}

export class ReportThumbnails {
  private readonly busy = new Map<string, string>();
  private textHold: { job: JobLeases; model: string; timer: ReturnType<typeof setTimeout> | null } | null = null;

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

  private routed(task: 'thumbnail_words'): MetadataRoutingOption {
    return routingOption(task, this.routing()[task]);
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

  /** Everything the window shows for one item. */
  view(jobId: string, itemId: string): ThumbnailsView {
    const { item, record } = this.locate(jobId, itemId);
    const renders: Record<string, string> = {};
    const frames: Record<string, string> = {};
    if (record !== null) {
      for (const p of record.pairs) {
        if (p.default.render.ok && fs.existsSync(p.default.render.file)) renders[p.default.render.file] = this.deps.picture(p.default.render.file, 640);
      }
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
      renders,
      frames,
      photos: this.deps.photoList(),
      hasLogo: this.deps.look.logoFile() !== null,
      heldModel: this.heldModel(),
      finish: this.finishView(record),
      remake: this.remakeView(record),
    };
  }

  /**
   * Why a run of `stages` cannot start now: no Crucible server for the words (the one stage that
   * calls a model since the frame scoring was removed 2026-09-29). Null when it can. Checked again
   * when the button is pressed.
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
    // reason no longer applies and the removed step is not named; the window says what Finish runs.
    const retired = record.failure.stage === 'tone-photos' || record.failure.stage === 'scoring';
    const reason = retired ? null : record.failure.reason;
    return { stage: record.failure.stage, retired, reason, keep: plan.keep, run: plan.run, blocked: this.blockedFor(plan.run) };
  }

  private remakeView(record: ItemThumbnails | null): { blocked: string | null } | null {
    if (record === null || record.state === 'off') return null;
    if (record.state === 'made' && record.source !== null && record.source.video === null) return null;
    return { blocked: this.blockedFor(THUMBNAIL_STAGES) };
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
   * After a pair was drawn again and the record written: its old render goes when nothing points at
   * it any more (no pick; the published file is the pick's COPY in `picks/`, never the render) and
   * it sits in the record's folder. Keeps the folder to the renders in use while Owen clicks through.
   */
  private dropOldRender(record: ItemThumbnails, old: StoredPair['default']['render'], now: string, where: string): void {
    if (!old.ok || old.file === now || record.folder === null) return;
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
    if (pair === undefined) throw new Error(`There is no pair ${n}; this report has ${record.pairs.length}.`);
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

  /** The picks after pair `n`'s render moved to `file` (its words written for `wordsFor`). */
  private followPair(picks: ThumbnailPick[], n: number, file: string, wordsFor: string): ThumbnailPick[] {
    return picks.map((p) => (p.kind === 'made' && p.pair === n ? { kind: 'made', pair: n, file, wordsFor } : p));
  }

  /**
   * Swap pieces of one pair and draw it again (CPU only). The current saved look is used (one look
   * for every channel; a look changed since the run applies from here on).
   */
  renderPair(jobId: string, itemId: string, change: PairChange): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'drawing a thumbnail', async () => {
      if (change === null || typeof change !== 'object' || !Number.isInteger(change.pair)) throw new Error(`A change names its pair by number, got ${JSON.stringify(change)}.`);
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'draw');
      const pair = this.pairOf(record, change.pair);
      const d = { ...pair.default };
      if (change.frameId !== undefined) {
        const frame = record.frames.find((f) => f.id === change.frameId);
        if (frame === undefined) throw new Error(`Frame ${change.frameId} is not among this report's candidate frames.`);
        d.frameId = frame.id;
        d.scene = frame.scene;
      }
      if (change.phrase !== undefined) {
        if (change.phrase === null) {
          d.phrase = null;
          d.kind = null;
        } else {
          if (typeof change.phrase !== 'string') throw new Error(`The words must be text, got ${JSON.stringify(change.phrase)}.`);
          phraseWords(change.phrase);
          const kind = change.kind ?? null;
          if (kind !== null && !(WORD_KINDS as readonly string[]).includes(kind)) throw new Error(`"${kind}" is not a kind of words (${WORD_KINDS.join(', ')}).`);
          d.phrase = change.phrase.trim();
          d.kind = kind;
        }
        if (change.wordsFor !== undefined && change.wordsFor !== null && (typeof change.wordsFor !== 'string' || change.wordsFor.trim() === '')) {
          throw new Error(`The title the words were written for must be text, got ${JSON.stringify(change.wordsFor)}.`);
        }
        d.wordsFor = change.wordsFor !== undefined ? change.wordsFor : d.kind !== null ? pair.title : null;
      }
      if (change.photo !== undefined) {
        if (change.photo !== null) {
          if (typeof change.photo !== 'string') throw new Error(`The photo is a name from your reaction photos or none, got ${JSON.stringify(change.photo)}.`);
          if (!this.deps.look.photoNames().includes(change.photo)) throw new Error(`There is no reaction photo "${change.photo}" in the app's library.`);
        }
        d.photo = change.photo;
        d.draw = null;
      }
      if (change.logo !== undefined) {
        if (typeof change.logo !== 'boolean') throw new Error(`The logo is on or off, got ${JSON.stringify(change.logo)}.`);
        d.logo = change.logo;
      }
      // A story's pairs have no frame until Owen picks one (the window sends it with every draw).
      if (d.frameId === null) throw new Error(`Thumbnail ${pair.pair} has no frame yet: pick its frame in the grid above, then press Generate thumbnails.`);
      const setup = this.setup();
      const frame = record.frames.find((f) => f.id === d.frameId);
      if (frame === undefined) throw new Error(`Pair ${pair.pair}'s frame ${d.frameId} is not among this report's candidate frames.`);
      this.deps.progress({ jobId, itemId, line: `Drawing thumbnail ${pair.pair}...` });
      const renderer = setup.openRenderer();
      let drawn;
      try {
        drawn = await drawPair({
          renderer,
          ffmpeg: setup.ffmpeg,
          video: record.source?.video ?? null,
          folder: record.folder!,
          frame: { id: frame.id, t: frame.t },
          phrase: d.phrase,
          photo: d.photo,
          logo: d.logo,
          style: setup.style,
          userDataPath: this.deps.userDataPath,
          outStem: this.nextStem(record.folder!, pair),
        });
      } finally {
        renderer.close();
      }
      d.render = drawn;
      const next: ItemThumbnails = {
        ...record,
        look: setup.style,
        pairs: record.pairs.map((p) => (p.pair === pair.pair ? {
          ...p,
          default: d,
          // The run's "no frame / no photo picked yet" lines go once they are picked for this pair.
          lines: p.lines.filter((l) => l !== NO_FRAME_YET && (d.photo === null || l !== NO_PHOTO_YET)),
        } : p)),
        picks: this.followPair(record.picks, pair.pair, drawn.file, d.wordsFor ?? pair.title),
      };
      await this.write(loc, jobId, itemId, next);
      this.dropOldRender(next, pair.default.render, drawn.file, loc.where);
      log.info(`[Thumbnails] ${loc.where}: pair ${pair.pair} drawn again (${drawn.file})`);
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
   * Write pair `n`'s words again for `title` (Owen reordered his titles, so thumbnail n now goes
   * with another title n) on the `thumbnail_words` row, and draw the pair with its frame, the photo
   * he picked (or none) and the logo as they are.
   */
  pairTitle(jobId: string, itemId: string, n: number, title: string): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'writing words', async () => {
      if (typeof title !== 'string' || title.trim() === '') throw new Error('Say which title the words are for.');
      const wanted = title.trim();
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'rewrite');
      const pair = this.pairOf(record, n);
      // Offered only on a generated thumbnail, which has its frame; one without is refused before the model call.
      if (pair.default.frameId === null) throw new Error(`Thumbnail ${n} has no frame yet: pick its frame and press Generate thumbnails first.`);
      const setup = this.setup();
      const ctx = this.itemContext(loc);
      const wordsOption = this.routed('thumbnail_words');
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
      const kind = pair.default.kind ?? PAIR_KINDS[(n - 1) % PAIR_KINDS.length];
      const chosen = defaultWords({ claim, stakes, reaction }, kind);
      if (chosen === null) throw new Error(`The words for “${wanted}” came back with no option of any kind.`);
      const frame = record.frames.find((f) => f.id === pair.default.frameId);
      if (frame === undefined) throw new Error(`Pair ${n}'s frame ${pair.default.frameId} is not among this report's candidate frames.`);
      this.deps.progress({ jobId, itemId, line: `Drawing thumbnail ${n}...` });
      const next: StoredPair = {
        pair: n,
        title: wanted,
        words: { claim, stakes, reaction, warnings, model: words.model },
        photos: [],
        default: {
          frameId: pair.default.frameId,
          scene: pair.default.scene,
          kind: chosen.kind,
          phrase: chosen.phrase,
          wordsFor: wanted,
          photo: pair.default.photo,
          draw: null,
          logo: pair.default.logo,
          render: { ok: false, reason: 'Not drawn yet.' },
        },
        lines: [
          ...(chosen.line === null ? [] : [chosen.line]),
          `Words written for this title on ${words.model}.`,
          ...(pair.default.photo === null ? [NO_PHOTO_YET] : []),
        ],
      };
      const renderer = setup.openRenderer();
      let drawn;
      try {
        drawn = await drawPair({
          renderer,
          ffmpeg: setup.ffmpeg,
          video: record.source?.video ?? null,
          folder: record.folder!,
          frame: { id: frame.id, t: frame.t },
          phrase: next.default.phrase,
          photo: next.default.photo,
          logo: next.default.logo,
          style: setup.style,
          userDataPath: this.deps.userDataPath,
          outStem: this.nextStem(record.folder!, next),
        });
      } finally {
        renderer.close();
      }
      next.default.render = drawn;
      const updated: ItemThumbnails = {
        ...record,
        look: setup.style,
        pairs: record.pairs.map((p) => (p.pair === n ? next : p)),
        picks: this.followPair(record.picks, n, drawn.file, wanted),
      };
      await this.write(loc, jobId, itemId, updated);
      this.dropOldRender(updated, pair.default.render, drawn.file, loc.where);
      log.info(`[Thumbnails] ${loc.where}: pair ${n}'s words rewritten for “${wanted}” on ${words.model}`);
      return this.view(jobId, itemId);
    });
  }

  /**
   * Save Owen's ordered picks (index 0 first). A pair's pick is its CURRENT render; his own image
   * is checked against YouTube's thumbnail rules (thumbnail-validate.ts, LEDGER #219) and read in
   * place. The copies in `<folder>/picks/` are rewritten; the page then sets pick 1's copy as the
   * video's thumbnail through the publish record.
   */
  savePicks(jobId: string, itemId: string, requests: PickRequest[]): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'saving the picks', async () => {
      if (!Array.isArray(requests)) throw new Error(`The picks must be a list, got ${JSON.stringify(requests)}.`);
      if (requests.length > PAIR_COUNT) throw new Error(`Test & Compare takes at most ${PAIR_COUNT} thumbnails; ${requests.length} were picked.`);
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'pick');
      const pairsAsked = requests.flatMap((r) => (r !== null && typeof r === 'object' && r.kind === 'made' ? [r.pair] : []));
      const twice = pairsAsked.find((n, i) => pairsAsked.indexOf(n) !== i);
      if (twice !== undefined) throw new Error(`Thumbnail ${twice} is picked twice; each thumbnail is one pick.`);
      const picks: ThumbnailPick[] = requests.map((r, i) => {
        if (r === null || typeof r !== 'object') throw new Error(`Pick ${i + 1} is not a pick: ${JSON.stringify(r)}.`);
        if (r.kind === 'made') {
          const pair = this.pairOf(record, r.pair);
          if (!pair.default.render.ok) throw new Error(`Thumbnail ${pair.pair} was not drawn (${pair.default.render.reason}), so it cannot be picked.`);
          return { kind: 'made', pair: pair.pair, file: pair.default.render.file, wordsFor: pair.default.wordsFor ?? pair.title };
        }
        if (r.kind === 'own') {
          if (typeof r.file !== 'string' || !path.isAbsolute(r.file)) throw new Error(`Your own image must be a file on this Mac, got ${JSON.stringify(r.file)}.`);
          if (!(IMAGE_EXTENSIONS as readonly string[]).includes(path.extname(r.file).toLowerCase())) throw new Error(`${path.basename(r.file)} is not a PNG or JPEG.`);
          validateThumbnailFile(r.file);
          return { kind: 'own', file: r.file };
        }
        throw new Error(`Pick ${i + 1} is neither a pair nor your own image: ${JSON.stringify(r)}.`);
      });
      checkPicks(picks, loc.where);
      let folder = record.folder;
      if (folder === null) {
        // A report with no story and only Owen's own images: the picks still need their folder.
        const txtFolder = loc.job.txt_folder;
        if (typeof txtFolder !== 'string' || txtFolder === '') throw new Error('The report records no folder, so there is nowhere to put the picks.');
        folder = path.join(txtFolder, THUMBNAILS_FOLDER, `${jobId}-${itemId}`);
      }
      await this.write(loc, jobId, itemId, { ...record, folder, picks });
      log.info(`[Thumbnails] ${loc.where}: ${picks.length} pick(s) saved`);
      return this.view(jobId, itemId);
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
      const shots: Array<{ id: string; full: string; lines: string[] }> = [];
      for (const [i, file] of files.entries()) {
        const id = `shot${i + 1}`;
        const full = path.join(folder, 'full', `${id}.png`);
        const still = await prepareStill(setup.ffmpeg, this.deps.ffprobe, file, full);
        shots.push({ id, full, lines: [`Screenshot ${i + 1}: ${still.line}`] });
      }
      // The words on the window's held model when the row is local; a cloud or `claude -p` row
      // holds no card, and its run gets a job of its own (nothing is leased on it), given back after.
      const held = await this.textJob(this.routed('thumbnail_words'));
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
            routing: this.routing(),
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
   * The item as the stages read it, for Finish and From scratch: its saved transcript, channel,
   * report folder, the content link Owen made on the Inputs page (the story's manual method), and
   * whether it is a video. The report does not store the item's input kind; a measured video
   * duration (content_provenance.final_duration_sec, ffprobed by transcription for a video only)
   * says it is one, and without it the story stage says there is no video to take frames from.
   * `linked`: the record already linked a story, which only a video item gets.
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
      const run = make({
        leases,
        aiManager: ai,
        routing: this.routing(),
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
   * "FINISH MAKING THUMBNAILS": a record whose stages stopped goes on from what it stores. The
   * stages whose output is all there are kept (frames and words are never made again); the
   * missing ones run in order on the routing table's rows, on one held job. The new record is
   * written whatever happened: made, or stopped again with the new stage and reason.
   */
  finish(jobId: string, itemId: string): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'finishing the thumbnails', async () => {
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'finish');
      if (record.state !== 'failed' || record.failure === null) throw new Error(`Nothing stopped, so there is nothing to finish: ${record.line}`);
      const plan = resumePlan(record, fs.existsSync);
      const blocked = this.blockedFor(plan.run);
      if (blocked !== null) throw new Error(blocked);
      const setup = this.setup();
      const input = this.itemInput(loc, jobId, record.story?.state === 'linked');
      this.deps.progress({ jobId, itemId, line: plan.run.includes('frames') ? 'Picking the frames, then writing the text...' : plan.run.includes('words') ? 'Writing the text...' : 'Drawing...' });
      const made = await this.stagesOnOneJob(jobId, itemId, 'Preparing thumbnail frames and text',
        (doors) => ItemThumbnailRun.resume(setup, input, doors, record, plan), this.fieldsOf(loc.item));
      await this.write(loc, jobId, itemId, made);
      log.info(`[Thumbnails] ${loc.where}: finished (kept ${plan.keep.join(', ') || 'nothing'}; ran ${plan.run.join(', ')}): ${made.line}`);
      return this.view(jobId, itemId);
    });
  }

  /**
   * "MAKE THUMBNAILS AGAIN FROM SCRATCH": every thumbnail stage runs again for the item (the story
   * link found again, frames sampled, words; a story's pairs wait for Owen's frame picks), into its folder,
   * on one held job. Own-image picks stay; pair picks go (the pairs are new).
   */
  remake(jobId: string, itemId: string): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'making the thumbnails again', async () => {
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'make again');
      if (this.remakeView(record) === null) throw new Error('These thumbnails were made from your screenshots; choose screenshots again instead.');
      const blocked = this.blockedFor(THUMBNAIL_STAGES);
      if (blocked !== null) throw new Error(blocked);
      const setup = this.setup();
      const input = this.itemInput(loc, jobId, record.story?.state === 'linked');
      const parent = path.join(input.reportFolder, THUMBNAILS_FOLDER);
      const folder = record.folder ?? path.join(parent, `${jobId}-${input.itemIndex + 1}`);
      if (path.dirname(path.resolve(folder)) !== path.resolve(parent)) throw new Error(`The record's folder ${folder} is not in this report's ${THUMBNAILS_FOLDER} folder, so it is not replaced.`);
      this.deps.progress({ jobId, itemId, line: 'Making the thumbnails again from scratch...' });
      const made = await this.stagesOnOneJob(jobId, itemId, 'Make thumbnails again',
        (doors) => ItemThumbnailRun.start({ mode: 'on', setup }, input, doors, { folder }), this.fieldsOf(loc.item));
      const next: ItemThumbnails = { ...made, picks: record.picks.filter((p) => p.kind === 'own') };
      // A record with no folder (no story again) still needs one for Owen's own picks' copies.
      if (next.folder === null && next.picks.length > 0) next.folder = folder;
      await this.write(loc, jobId, itemId, next);
      log.info(`[Thumbnails] ${loc.where}: made again from scratch: ${made.line}`);
      return this.view(jobId, itemId);
    });
  }
}
