/**
 * THE REPORTS PAGE'S THUMBNAILS WINDOW, main-process side (phase 2, Owen 2026-09-28;
 * docs/thumbnails-pipeline.md). The metadata run already made the title and thumbnail pairs and
 * stored them on the item (`thumbnails`, pipeline-record.ts). Here Owen:
 *
 *   - swaps any piece of a pair (frame, words, photo, logo) and it is drawn again at once, on the
 *     CPU (`renderPair`): a NEW file beside the old one, so a file a pick or the publish record
 *     points at is never overwritten under it;
 *   - has a pair's words written again for another title (`pairTitle`, the 27B on demand: the words
 *     row, then the tone/photo row for that pair's new words, then a draw and a render), when he
 *     reorders his titles so thumbnail n now goes with a different title n;
 *   - saves his ORDERED picks (`savePicks`): up to three, a pair's render or his own image file,
 *     index 0 first. Pick n goes with chosen title n (Test & Compare's "title and thumbnail"). The
 *     picks are copied into `<folder>/picks/Pick 1.png` ...: pick 1's copy is what the reports page
 *     sets as the video's thumbnail through the publish record's one thumbnail door; picks 2 and 3
 *     sit beside it for his manual Test & Compare upload in Studio (YouTube has no API for them);
 *   - for a report with NO STORY (or whose stages failed), gives 1 to 3 of his own screenshots
 *     (`useScreenshots`): that many pairs are made from them, words and photos by the models as in
 *     the run (pipeline.ts ItemThumbnailRun.fromScreenshots).
 *
 * THE MODEL IS HELD between the words and the tone/photo steps (the tab's pattern, which Owen
 * asked for: "if we're using the 27b anyway we might as well keep it loaded"): one held job per
 * local model, given back when another model is needed, when the window closes, on quit, or after
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
import { judgeThumbnails } from './judge';
import { phraseWords } from './layout';
import type { ThumbnailLook } from './look';
import { checkSeed, drawLine, drawPhotos } from './photo-draw';
import {
  ItemThumbnailRun,
  defaultWords,
  drawPair,
  type ThumbnailRunChoice,
  type ThumbnailRunSetup,
} from './pipeline';
import {
  PAIR_COUNT,
  PAIR_KINDS,
  PICKS_FOLDER,
  THUMBNAILS_FOLDER,
  checkPicks,
  readItemThumbnails,
  type ItemThumbnails,
  type StoredPair,
  type ThumbnailPick,
} from './pipeline-record';
import { transcriptLines, WORD_KINDS, type WordKind } from './prompts';
import { safeFileName } from './renderer';
import { writeThumbnailWords } from './words-writer';

/** How long the window keeps its text model held after its last words or tone/photo step. */
export const TEXT_HOLD_IDLE_MS = 5 * 60_000;

/** The file types Owen can give as his own thumbnail or as a screenshot. */
export const IMAGE_EXTENSIONS = ['.png', '.jpg', '.jpeg'] as const;

export interface ReportThumbnailsDeps {
  store: { get(key: string): unknown };
  userDataPath: string;
  ffprobe: string;
  look: ThumbnailLook;
  /** The run's setup read NOW (the saved look, notes, renderer, doors): pipeline-setup.ts thumbnailRunChoice. */
  runChoice: () => ThumbnailRunChoice;
  /** A held Crucible job for the text steps (crucible.transport.job). */
  holdJob: (what: string) => JobLeases;
  aiManager: () => Pick<AIManagerService, 'runPlainRequest'> & { cleanup?(): void };
  /** A picture of a file as a data URL, at most `width` pixels wide (Electron nativeImage in the app). */
  picture: (file: string, width: number) => string;
  /** The library's photos with a small picture each (look.ts photos(): trimming needs Electron). */
  photoList: () => Array<{ name: string; preview: string; note: string | null }>;
  newSeed: () => number;
  /** A progress line for the window that asked. */
  progress: (event: { jobId: string; itemId: string; line: string }) => void;
}

/** A change to one pair: every field left out stays as it is. */
export interface PairChange {
  pair: number;
  frameId?: string;
  /** The words (null: "No text"). */
  phrase?: string | null;
  /** Where the words came from (null: typed by Owen, or no text). */
  kind?: WordKind | null;
  /** A photo name, null for "No photo", or 'draw' for a new draw from the pair's top 3. */
  photo?: string | null | 'draw';
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

/** Everything the window shows. Pictures are keyed by absolute file path, frames by frame id. */
export interface ThumbnailsView extends ThumbnailsSummary {
  jobId: string;
  itemId: string;
  title: string;
  record: ItemThumbnails | null;
  /** The item's generated titles (the words can be rewritten for any title). */
  titles: string[];
  /** Pictures of the pairs' renders (keyed by file path) and of the frames the scene strip shows first (keyed by id). */
  renders: Record<string, string>;
  frames: Record<string, string>;
  photos: Array<{ name: string; preview: string; note: string | null }>;
  hasLogo: boolean;
  /** The text model held for the next words or tone/photo step, or null. */
  heldModel: string | null;
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

  private routed(task: 'thumbnail_words' | 'thumbnail_judge'): MetadataRoutingOption {
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
      this.textHold = { job: this.deps.holdJob('the Thumbnails window (words, tone and photos)'), model, timer: null };
      log.info(`[Thumbnails] holding ${model} across the words and the tone/photo steps`);
    }
    const hold = this.textHold;
    if (hold.timer !== null) clearTimeout(hold.timer);
    hold.timer = setTimeout(() => void this.releaseHold(`no words or tone/photo step for ${TEXT_HOLD_IDLE_MS / 60_000} minutes`), TEXT_HOLD_IDLE_MS);
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

  private copyOf(record: ItemThumbnails, n: number, pick: ThumbnailPick): string {
    const folder = this.picksFolder(record);
    if (folder === null) throw new Error('The thumbnails record holds picks and no folder.');
    const ext = path.extname(pick.file).toLowerCase() === '.png' ? '.png' : '.jpg';
    return path.join(folder, `Pick ${n}${ext}`);
  }

  private summaryOf(record: ItemThumbnails | null, pictureWidth: number): ThumbnailsSummary {
    if (record === null) return { state: null, line: null, canOpen: false, picks: [], picksFolder: null, publishFile: null };
    const picks = record.picks.map((pick, i) => {
      const copy = this.copyOf(record, i + 1, pick);
      return { n: i + 1, pick, copy, picture: fs.existsSync(copy) ? this.deps.picture(copy, pictureWidth) : '' };
    });
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
      const byId = new Map(record.frames.map((f) => [f.id, f]));
      for (const row of record.bestScenes) {
        for (const id of row.ids) {
          const f = byId.get(id);
          if (f !== undefined && fs.existsSync(f.small)) frames[id] = this.deps.picture(f.small, 320);
        }
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
    };
  }

  /** Pictures of more frames ("More from this scene"), keyed by id. */
  framePictures(jobId: string, itemId: string, ids: string[]): Record<string, string> {
    if (!Array.isArray(ids) || ids.some((id) => typeof id !== 'string')) throw new Error(`The frames to show must be a list of frame ids, got ${JSON.stringify(ids)}.`);
    const { record } = this.locate(jobId, itemId);
    if (record === null) throw new Error('This report has no thumbnails record.');
    const out: Record<string, string> = {};
    for (const id of ids) {
      const f = record.frames.find((x) => x.id === id);
      if (f === undefined) throw new Error(`Frame ${id} is not among this report's candidate frames.`);
      out[id] = this.deps.picture(f.small, 320);
    }
    return out;
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
   * `<folder>/picks/`: exactly the picks, in order, as `Pick 1.png` ... (the folder is emptied
   * first, so a pick that moved or went leaves no stale copy). No picks: the folder is removed.
   */
  private writeCopies(record: ItemThumbnails): void {
    const folder = this.picksFolder(record);
    if (folder === null) return;
    if (fs.existsSync(folder)) fs.rmSync(folder, { recursive: true, force: true });
    if (record.picks.length === 0) return;
    fs.mkdirSync(folder, { recursive: true });
    record.picks.forEach((pick, i) => {
      if (!fs.existsSync(pick.file)) throw new Error(`Pick ${i + 1}'s file is not on disk any more: ${pick.file}`);
      fs.copyFileSync(pick.file, this.copyOf(record, i + 1, pick));
    });
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
      }
      if (change.photo !== undefined) {
        if (change.photo === null) {
          d.photo = null;
          d.draw = null;
        } else if (change.photo === 'draw') {
          if (pair.photos.length === 0) throw new Error(`Pair ${pair.pair} has no photo ranking to draw from.`);
          const taken = record.pairs.filter((p) => p.pair !== pair.pair).flatMap((p) => (p.default.photo === null ? [] : [p.default.photo]));
          const seed = checkSeed(this.deps.newSeed());
          const draw = drawPhotos({ X: pair.photos }, ['X'], taken, seed).X;
          d.photo = draw.name;
          d.draw = draw;
        } else {
          if (!this.deps.look.photoNames().includes(change.photo)) throw new Error(`There is no reaction photo "${change.photo}" in the app's library.`);
          d.photo = change.photo;
          d.draw = null;
        }
      }
      if (change.logo !== undefined) {
        if (typeof change.logo !== 'boolean') throw new Error(`The logo is on or off, got ${JSON.stringify(change.logo)}.`);
        d.logo = change.logo;
      }
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
          // A pre-phase-2 record's ranking was made for the first default's words: said before they change.
          rankedFor: p.rankedFor === undefined ? p.default.phrase : p.rankedFor,
          default: d,
        } : p)),
        picks: this.followPair(record.picks, pair.pair, drawn.file, pair.title),
      };
      await this.write(loc, jobId, itemId, next);
      log.info(`[Thumbnails] ${loc.where}: pair ${pair.pair} drawn again (${drawn.file})`);
      return this.view(jobId, itemId);
    });
  }

  /** The item's transcript lines, channel and creator: what the words and the tone read. */
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
   * with another title n), rank the photos for the new words, draw a photo and draw the pair.
   * The model steps are the routing table's rows (`thumbnail_words`, `thumbnail_judge`).
   */
  pairTitle(jobId: string, itemId: string, n: number, title: string): Promise<ThumbnailsView> {
    return this.exclusive(jobId, itemId, 'writing words', async () => {
      if (typeof title !== 'string' || title.trim() === '') throw new Error('Say which title the words are for.');
      const wanted = title.trim();
      const loc = this.locate(jobId, itemId);
      const record = this.actionable(loc, 'rewrite');
      const pair = this.pairOf(record, n);
      const setup = this.setup();
      const ctx = this.itemContext(loc);
      const wordsOption = this.routed('thumbnail_words');
      const judgeOption = this.routed('thumbnail_judge');
      const judgeModel = judgeOption.crucibleModel;
      if (judgeModel === null) throw new Error(`The "Thumbnail tone and photo" row names ${judgeOption.label}, which is not a Crucible model.`);
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
      this.deps.progress({ jobId, itemId, line: 'Ranking the reaction photos for the new words...' });
      const names = this.deps.look.photoNames();
      const judged = await judgeThumbnails({
        deps: setup.doors,
        jobId: `${jobId}-thumbnails-pair-${n}-${Date.now()}`,
        model: judgeModel,
        job: await this.textJob(judgeOption),
        tone: {
          channel: ctx.channel.name,
          creator: ctx.creator,
          hook: typeof loc.item.description_hook === 'string' ? loc.item.description_hook : '',
          description: typeof loc.item.description === 'string' ? loc.item.description : '',
          transcript: ctx.transcript,
        },
        photos: this.deps.look.notesFor(names).map((p) => ({ name: p.name, note: p.note })),
        variants: [{ letter: 'A', text: chosen.phrase }],
      }).catch(async (err) => {
        await this.releaseHold('the tone/photo step failed');
        throw err;
      });
      const taken = record.pairs.filter((p) => p.pair !== n).flatMap((p) => (p.default.photo === null ? [] : [p.default.photo]));
      const seed = checkSeed(this.deps.newSeed());
      const draw = drawPhotos({ A: judged.photos.A }, ['A'], taken, seed).A;
      const frame = record.frames.find((f) => f.id === pair.default.frameId);
      if (frame === undefined) throw new Error(`Pair ${n}'s frame ${pair.default.frameId} is not among this report's candidate frames.`);
      this.deps.progress({ jobId, itemId, line: `Drawing thumbnail ${n}...` });
      const next: StoredPair = {
        pair: n,
        title: wanted,
        words: { claim, stakes, reaction, warnings, model: words.model },
        photos: judged.photos.A,
        rankedFor: chosen.phrase,
        default: {
          frameId: pair.default.frameId,
          scene: pair.default.scene,
          kind: chosen.kind,
          phrase: chosen.phrase,
          photo: draw.name,
          draw,
          logo: pair.default.logo,
          render: { ok: false, reason: 'Not drawn yet.' },
        },
        lines: [
          ...(chosen.line === null ? [] : [chosen.line]),
          `Words written for this title on ${words.model}; photos ranked on ${judged.model} (seed ${seed}).`,
          `Photo: ${drawLine(draw)}.`,
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
          return { kind: 'made', pair: pair.pair, file: pair.default.render.file, wordsFor: pair.title };
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
   * is cut to 16:9 around its centre if it is another shape (said) and written into `full/`. Words,
   * tone and photos run on the routing table's rows, as in the metadata run; the record's story
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
      const judgeOption = this.routed('thumbnail_judge');
      if (judgeOption.crucibleModel === null) throw new Error(`The "Thumbnail tone and photo" row names ${judgeOption.label}, which is not a Crucible model.`);
      const leases = await this.textJob(judgeOption);
      if (leases === undefined) throw new Error(`The "Thumbnail tone and photo" row names ${judgeOption.label}, which runs on no Crucible card to hold.`);
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
        await run.afterFields({
          titles: titles.map((t) => t.trim()),
          reroll_gate: null,
          description_hook: loc.item.description_hook,
          description: loc.item.description,
        });
        const made = run.record();
        if (made.state === 'failed') await this.releaseHold('a screenshots step failed');
        const own = record.picks.filter((p) => p.kind === 'own');
        const next: ItemThumbnails = { ...made, picks: own };
        await this.write(loc, jobId, itemId, next);
        log.info(`[Thumbnails] ${loc.where}: ${files.length} screenshot(s): ${made.line}`);
      } finally {
        ai.cleanup?.();
      }
      return this.view(jobId, itemId);
    });
  }
}
