/**
 * THE THUMBNAILS TAB'S MAIN-PROCESS SIDE: one testing workflow for Owen (2026-09-28).
 *
 *   1. Pick a processed item: its video (or another 16:9 file, e.g. the master), an optional range.
 *   2. Find frames: ffmpeg samples ~1/s, the cheap filters drop repeats and blurry frames, the
 *      routed vision model scores what is left (at most MAX_FRAMES_TO_SCORE, spread evenly), the
 *      desktop answer rejects screens, the rest is ranked and ~20 are picked across the sections.
 *   3. Write words: three kinds (claim, stakes, reaction), several each, paired with the title the
 *      operator picks from the item's report.
 *   4. Render three variants deterministically, each with words or none, into a folder beside the
 *      item's report: `<report folder>/thumbnail tests/`.
 *
 * STATE. A run lives in memory (and its frames in userData/thumbnail-lab/<item>/<run>/), because
 * this is a testing tab: a restarted app starts a new run. The frame cache for an item keeps only
 * its latest run; older runs of the same item are removed when a new one starts.
 *
 * Every refusal throws with the missing thing named (Law 1); the IPC layer hands the message to the
 * tab unchanged.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import { OutputHandlerService } from '../metadata/output-handler.service';
import { inspectSavedTranscript, loadSavedTranscript } from '../metadata/saved-transcript.service';
import { promptAssets } from '../metadata/prompt-assets';
import { resolveMetadataRouting, routingOption, type MetadataRoutingOption } from '../metadata/metadata-routing';
import { MAX_FRAMES_TO_SCORE, filterFrames, thinAcrossRange } from './frame-metrics';
import { BEST_COUNT, pickDiverse, rankFrames, type FrameReading, type RankedFrame } from './frame-ranking';
import { clock, extractFullFrame, parseClock, sampleFrames, type SampledFrame } from './frame-sampler';
import { scoreFrames, type ScorerDeps } from './frame-scorer';
import { transcriptLine, type WordKind, type WordOptions } from './prompts';
import { writeThumbnailWords } from './words-writer';
import { renderThumbnail } from './renderer';
import { DEFAULT_STYLE, validateStyle, type ThumbnailStyle } from './layout';
import { dataUrlOf, type ThumbnailCanvas } from './canvas-page';
import type { AIManagerService } from '../metadata/ai-manager.service';
import { listReactionPhotos, photoPreview, trimmedPhoto } from './reaction-photos';

/** The store key holding the tab's look (font, colours, slots). Absent: DEFAULT_STYLE, said in the view. */
export const STYLE_STORE_KEY = 'thumbnailLab.style';

/** The store key holding the folder of Owen's reaction photos. Absent: none chosen yet (not a default). */
export const PHOTO_FOLDER_STORE_KEY = 'thumbnailLab.reactionFolder';

/** The folder beside an item's report the renders go into. */
export const OUTPUT_FOLDER = 'thumbnail tests';

export interface LabItem {
  jobId: string;
  itemId: string;
  title: string;
  createdAt: string;
  sourcePath: string | null;
  videoOnDisk: boolean;
  titles: string[];
  promptSet: string | null;
  hasTranscript: boolean;
  reportFolder: string | null;
  /** Why the item cannot be used, in plain words; null when it can. */
  problem: string | null;
}

export interface LabFrameView {
  id: string;
  t: number;
  clock: string;
  /** The 320x180 picture, as a data URL. */
  small: string;
  /** Set once scored. */
  score: number | null;
  reading: FrameReading | null;
  /** 'screen' when the model read it as a computer screen (rejected), 'unreadable' when its answer was. */
  flag: 'screen' | 'unreadable' | null;
  section: number | null;
}

export interface LabRunView {
  runId: string;
  itemId: string;
  video: string;
  start: number;
  end: number;
  lines: string[];
  frames: LabFrameView[];
  /** Frame ids the scorer reads (the kept frames, thinned to the cap). */
  toScore: string[];
  /** Once scored: the ~20 best, spread across the range, best first. */
  best: string[] | null;
  scoring: { server: string; model: string; line: string } | null;
}

interface Run {
  runId: string;
  item: LabItem;
  video: string;
  dir: string;
  start: number;
  end: number;
  frames: SampledFrame[];
  toScore: Set<string>;
  lines: string[];
  ranked: RankedFrame[] | null;
  readings: Map<string, FrameReading>;
  flags: Map<string, 'screen' | 'unreadable'>;
  best: string[] | null;
  scoring: LabRunView['scoring'];
  controller: AbortController | null;
}

export interface LabDeps {
  store: { get(key: string): unknown; set(key: string, value: unknown): void };
  userDataPath: string;
  ffmpeg: string;
  ffprobe: string;
  canvas: () => ThumbnailCanvas;
  scorer: () => ScorerDeps;
  aiManager: () => Pick<AIManagerService, 'runPlainRequest'> & { cleanup?(): void };
  progress: (event: { runId: string; stage: 'sampling' | 'scoring'; done: number; total: number }) => void;
}

function frameId(frame: { index: number }): string {
  return `f${frame.index}`;
}

function srtSeconds(value: string, what: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!m) throw new Error(`${what}: "${value}" is not a caption time.`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

function safeFileName(text: string): string {
  return text.replace(/[/\\:*?"<>|]+/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 80);
}

export class ThumbnailLab {
  private readonly runs = new Map<string, Run>();

  constructor(private readonly deps: LabDeps) {}

  private outputDir(): string {
    const dir = this.deps.store.get('outputDirectory');
    if (typeof dir !== 'string' || dir.trim() === '') throw new Error('No output directory is set in Settings, so there are no reports to pick from.');
    return dir;
  }

  private routed(task: 'thumbnail_frames' | 'thumbnail_words'): MetadataRoutingOption {
    const resolved = resolveMetadataRouting(this.deps.store.get('metadataRouting'));
    return routingOption(task, resolved[task]);
  }

  private run(runId: string): Run {
    const run = this.runs.get(runId);
    if (run === undefined) throw new Error(`Run ${runId} is not open any more (the app was restarted or a newer run replaced it). Find frames again.`);
    return run;
  }

  /** Every item with a report, newest first; unusable ones say why. */
  listItems(): LabItem[] {
    const outputDir = this.outputDir();
    const jobs = OutputHandlerService.forOutputDir(outputDir).listJobs();
    const items: LabItem[] = [];
    for (const job of jobs) {
      for (const raw of (job.items ?? []) as any[]) {
        if (!raw || typeof raw.item_id !== 'string') continue;
        const sourcePath = typeof raw.source_path === 'string' ? raw.source_path : null;
        const titles = Array.isArray(raw.titles) ? [...new Set((raw.titles as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== ''))] : [];
        const videoOnDisk = sourcePath !== null && fs.existsSync(sourcePath);
        const hasTranscript = sourcePath !== null && inspectSavedTranscript(outputDir, sourcePath).exists;
        const problem =
          sourcePath === null ? 'This report has lost track of the video it was made from.'
          : titles.length === 0 ? 'This report has no titles to pair the words with.'
          : !hasTranscript ? 'No saved transcript for this video, so there is nothing to write the words from.'
          : null;
        items.push({
          jobId: job.job_id,
          itemId: raw.item_id,
          title: typeof raw._title === 'string' ? raw._title : path.basename(sourcePath ?? raw.item_id),
          createdAt: job.created_at,
          sourcePath,
          videoOnDisk,
          titles,
          promptSet: typeof raw._prompt_set === 'string' ? raw._prompt_set : (typeof job.prompt_set === 'string' ? job.prompt_set : null),
          hasTranscript,
          reportFolder: typeof raw.txt_path === 'string' ? path.dirname(raw.txt_path) : null,
          problem,
        });
      }
    }
    return items;
  }

  private item(jobId: string, itemId: string): LabItem {
    const item = this.listItems().find((i) => i.jobId === jobId && i.itemId === itemId);
    if (item === undefined) throw new Error(`Item ${itemId} is not in job ${jobId}.`);
    if (item.problem !== null) throw new Error(item.problem);
    return item;
  }

  /** Step 2a: sample, filter, thin. The frames' grid pictures come back with the run. */
  async findFrames(req: { jobId: string; itemId: string; video: string | null; start: string | null; end: string | null }): Promise<LabRunView> {
    const item = this.item(req.jobId, req.itemId);
    const video = req.video ?? item.sourcePath!;
    if (!fs.existsSync(video)) throw new Error(`The video is not on disk (is the drive plugged in?): ${video}`);
    const start = parseClock(req.start, 'start');
    const end = parseClock(req.end, 'end');
    const itemDir = path.join(this.deps.userDataPath, 'thumbnail-lab', item.itemId);
    const runId = `thumbs-${Date.now()}`;
    // One run per item on disk: the older runs of this item are this tab's own cache.
    if (fs.existsSync(itemDir)) {
      for (const old of fs.readdirSync(itemDir)) fs.rmSync(path.join(itemDir, old), { recursive: true, force: true });
    }
    for (const [id, run] of this.runs) if (run.item.itemId === item.itemId) this.runs.delete(id);
    const dir = path.join(itemDir, runId);
    const controller = new AbortController();
    const sampled = await sampleFrames({
      ffmpeg: this.deps.ffmpeg,
      ffprobe: this.deps.ffprobe,
      video,
      start,
      end,
      outDir: path.join(dir, 'frames'),
      signal: controller.signal,
      onProgress: (done, total) => this.deps.progress({ runId, stage: 'sampling', done, total }),
    });
    const filtered = filterFrames(sampled.frames);
    const keptIds = new Set(filtered.kept.map(frameId));
    const kept = sampled.frames.filter((f) => keptIds.has(frameId(f)));
    const toScore = thinAcrossRange(kept, sampled.start, sampled.end, MAX_FRAMES_TO_SCORE);
    const blurry = filtered.dropped.filter((d) => d.reason === 'blurry').length;
    const repeats = filtered.dropped.filter((d) => d.reason === 'repeat').length;
    const lines = [
      `Sampled ${sampled.frames.length} frames from ${clock(sampled.start)} to ${clock(sampled.end)} (one every ${sampled.every.toFixed(sampled.every === 1 ? 0 : 1)} s).`,
      `Removed ${repeats} repeated and ${blurry} blurry frames; ${kept.length} kept.`,
      toScore.length < kept.length
        ? `${toScore.length} of them, spread evenly across the range, will be scored (the most one run scores is ${MAX_FRAMES_TO_SCORE}).`
        : `All ${kept.length} will be scored.`,
    ];
    log.info(`[ThumbnailLab] ${runId} for ${item.title}: ${lines.join(' ')}`);
    const run: Run = {
      runId, item, video, dir, start: sampled.start, end: sampled.end, frames: kept, toScore: new Set(toScore.map(frameId)),
      lines, ranked: null, readings: new Map(), flags: new Map(), best: null, scoring: null, controller: null,
    };
    this.runs.set(runId, run);
    return this.view(run, true);
  }

  private view(run: Run, withPictures: boolean): LabRunView {
    const rankedById = new Map((run.ranked ?? []).map((r) => [r.id, r]));
    return {
      runId: run.runId,
      itemId: run.item.itemId,
      video: run.video,
      start: run.start,
      end: run.end,
      lines: run.lines,
      frames: run.frames.map((f) => {
        const id = frameId(f);
        const ranked = rankedById.get(id);
        return {
          id,
          t: f.t,
          clock: clock(f.t),
          small: withPictures ? dataUrlOf(f.small) : '',
          score: ranked?.score ?? null,
          reading: run.readings.get(id) ?? null,
          flag: run.flags.get(id) ?? null,
          section: ranked?.section ?? null,
        };
      }),
      toScore: run.frames.map(frameId).filter((id) => run.toScore.has(id)),
      best: run.best,
      scoring: run.scoring,
    };
  }

  /** A frame's 640x360 picture, for the large view. */
  framePicture(runId: string, id: string): string {
    const frame = this.run(runId).frames.find((f) => frameId(f) === id);
    if (frame === undefined) throw new Error(`Frame ${id} is not in run ${runId}.`);
    return dataUrlOf(frame.large);
  }

  /** Step 2b: the vision model scores the frames; the ranking and the best ~20 come back. */
  async score(runId: string): Promise<LabRunView> {
    const run = this.run(runId);
    const option = this.routed('thumbnail_frames');
    if (option.crucibleModel === null) throw new Error(`The frame row names ${option.label}, which is not a Crucible model; frames are scored on a Crucible server.`);
    const frames = run.frames.filter((f) => run.toScore.has(frameId(f))).map((f) => ({ id: frameId(f), t: f.t, image: f.large }));
    run.controller = new AbortController();
    try {
      const outcome = await scoreFrames({
        deps: this.deps.scorer(),
        jobId: `${runId}-score`,
        model: option.crucibleModel,
        frames,
        signal: run.controller.signal,
        onProgress: (done, total) => this.deps.progress({ runId, stage: 'scoring', done, total }),
      });
      run.readings = new Map(outcome.scored.map((s) => [s.id, s.reading]));
      const { ranked, screens } = rankFrames(outcome.scored, run.start, run.end);
      run.flags = new Map([
        ...screens.map((s) => [s.id, 'screen'] as const),
        ...outcome.unreadable.map((u) => [u.id, 'unreadable'] as const),
      ]);
      run.ranked = ranked;
      run.best = pickDiverse(ranked, BEST_COUNT).map((r) => r.id);
      const unreadable = outcome.unreadable.length > 0 ? ` ${outcome.unreadable.length} frame(s) could not be read and were set aside (${outcome.unreadable.map((u) => `${clock(u.t)}: ${u.reason}`).join('; ')}).` : '';
      run.scoring = {
        server: outcome.server,
        model: outcome.model,
        line: `Scored ${outcome.scored.length} frames on ${outcome.model} on "${outcome.server}" (${outcome.widthBasis}). ${screens.length} were computer screens and are left out.${unreadable}`,
      };
      log.info(`[ThumbnailLab] ${runId}: ${run.scoring.line}`);
      return this.view(run, false);
    } finally {
      run.controller = null;
    }
  }

  stop(runId: string): void {
    this.run(runId).controller?.abort(new Error('Stopped.'));
  }

  /** Step 3: the words, paired with one of the item's titles. */
  async words(runId: string, title: string): Promise<WordOptions & { model: string }> {
    const run = this.run(runId);
    if (!run.item.titles.includes(title)) throw new Error(`"${title}" is not one of this item's titles.`);
    if (run.item.promptSet === null) throw new Error(`${run.item.title} names no prompt set, so nothing says whose channel it is.`);
    const channel = promptAssets().channel(run.item.promptSet);
    const terms = (channel.brandTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    if (terms.length === 0) throw new Error(`The prompt set "${channel.name}" declares no brand_terms, so nothing says who its creator is.`);
    const { record } = loadSavedTranscript(this.outputDir(), run.item.sourcePath!);
    const transcript = record.segments.map((s, i) => transcriptLine(srtSeconds(s.start, `caption ${i + 1}`), s.text));
    const ai = this.deps.aiManager();
    try {
      const result = await writeThumbnailWords({
        aiManager: ai,
        option: this.routed('thumbnail_words'),
        channel: channel.name,
        creator: terms.join(', '),
        title,
        transcript,
        sourceLabel: run.item.title,
      });
      log.info(`[ThumbnailLab] ${runId}: words on ${result.model}: ${result.options.claim.length} claim, ${result.options.stakes.length} stakes, ${result.options.reaction.length} reaction${result.options.warnings.length ? ` (${result.options.warnings.join(' ')})` : ''}`);
      return { ...result.options, model: result.model };
    } finally {
      ai.cleanup?.();
    }
  }

  /** The reaction photos folder, or null when none has been chosen. */
  photoFolder(): string | null {
    const folder = this.deps.store.get(PHOTO_FOLDER_STORE_KEY);
    if (folder === undefined || folder === null || folder === '') return null;
    if (typeof folder !== 'string') throw new Error(`The saved reaction photos folder is not a path: ${JSON.stringify(folder)}`);
    return folder;
  }

  /** Save the folder, after checking it holds photos (a bad folder is refused, not saved). */
  setPhotoFolder(folder: string): string {
    listReactionPhotos(folder);
    this.deps.store.set(PHOTO_FOLDER_STORE_KEY, folder);
    return folder;
  }

  /** The folder's photos, trimmed, each with a small picture for the picker. */
  photos(): { folder: string | null; photos: Array<{ name: string; preview: string; note: string | null }> } {
    const folder = this.photoFolder();
    if (folder === null) return { folder: null, photos: [] };
    return {
      folder,
      photos: listReactionPhotos(folder).map((p) => {
        const trimmed = trimmedPhoto(p);
        return { name: p.name, preview: photoPreview(trimmed), note: trimmed.note };
      }),
    };
  }

  private photoNamed(name: string) {
    const folder = this.photoFolder();
    if (folder === null) throw new Error(`Variant asks for the reaction photo "${name}", and no reaction photos folder is set.`);
    const photo = listReactionPhotos(folder).find((p) => p.name === name);
    if (photo === undefined) throw new Error(`There is no reaction photo "${name}" in ${folder}.`);
    return trimmedPhoto(photo);
  }

  getStyle(): { style: ThumbnailStyle; stored: boolean } {
    const stored = this.deps.store.get(STYLE_STORE_KEY);
    if (stored === undefined || stored === null) return { style: DEFAULT_STYLE, stored: false };
    return { style: validateStyle(stored), stored: true };
  }

  setStyle(value: unknown): ThumbnailStyle {
    const style = validateStyle(value);
    this.deps.store.set(STYLE_STORE_KEY, style);
    return style;
  }

  /** Step 4: three variants. Each is rendered or refused on its own; one refusal does not stop the others. */
  async render(runId: string, variants: Array<{ letter: string; frameId: string; phrase: string | null; kind: WordKind | null; photo: string | null }>) {
    const run = this.run(runId);
    if (variants.length === 0) throw new Error('Mark at least one frame to render.');
    if (run.item.reportFolder === null) throw new Error(`${run.item.title} has no report folder recorded, so there is nowhere beside it to save the thumbnails.`);
    const style = this.getStyle().style;
    const outDir = path.join(run.item.reportFolder, OUTPUT_FOLDER);
    const results = [];
    // The hidden canvas window lives for this batch only: a window left open would sit in
    // BrowserWindow.getAllWindows() and keep "all windows closed" from ever firing.
    const canvas = this.deps.canvas();
    try {
    for (const v of variants) {
      if (!/^[A-Z]$/.test(v.letter)) throw new Error(`"${v.letter}" is not a variant letter.`);
      const frame = run.frames.find((f) => frameId(f) === v.frameId);
      if (frame === undefined) throw new Error(`Frame ${v.frameId} is not in this run.`);
      const full = path.join(run.dir, 'full', `${v.frameId}.png`);
      if (!fs.existsSync(full)) await extractFullFrame(this.deps.ffmpeg, run.video, frame.t, full);
      const photo = v.photo === null ? null : this.photoNamed(v.photo);
      const words = v.phrase === null ? 'no text' : `${v.kind ?? 'words'} - ${safeFileName(v.phrase)}`;
      const label = photo === null ? words : `${words}, ${safeFileName(photo.name)}`;
      const outStem = path.join(outDir, `${safeFileName(run.item.title)} - ${v.letter} (${label})`);
      const r = await renderThumbnail({ canvas, frame: full, phrase: v.phrase, style, photo, outStem });
      results.push(
        r.ok
          ? { letter: v.letter, ok: true as const, path: r.path, bytes: r.bytes, format: r.format, picture: dataUrlOf(r.path), notes: r.notes, at: clock(frame.t) }
          : { letter: v.letter, ok: false as const, reason: r.reason, at: clock(frame.t) },
      );
    }
    } finally {
      canvas.close();
    }
    log.info(`[ThumbnailLab] ${runId}: rendered ${results.filter((r) => r.ok).length} of ${results.length} into ${outDir}`);
    return { folder: outDir, results };
  }
}
