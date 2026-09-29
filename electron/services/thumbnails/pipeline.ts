/**
 * THE THUMBNAILS STAGES OF THE METADATA RUN (phase 1 of moving thumbnails out of the test tab,
 * Owen 2026-09-28; docs/thumbnails-pipeline.md). The report opens with three title and thumbnail
 * pairs ready for YouTube's Test & Compare ("title and thumbnail" mode, up to 3 pairs). Each pair's
 * words are written to COMPLEMENT its title, never restate it.
 *
 * The stages, in the metadata job's order (metadata-generator.service.ts calls them):
 *
 *   story        CPU  which editor story the frames come from (story-match.ts: manual | name |
 *                     transcript, or "no story" with the reason, and the thumbnail stages stop).
 *   frames       CPU  the story's stretches of the session's screen recording (story-source.ts),
 *                     sampled ~1/s, repeats and blurry frames dropped, grouped into scenes, the
 *                     scoring budget shared across the scenes. The tab's own modules, unchanged.
 *   scoring      GPU  the `thumbnail_frames` row (the 9B with vision), ONE lease of the metadata
 *                     job: right after transcription and before the chapters, so the job loads it
 *                     once and the chapters' model replaces it (one swap).
 *   ...the chapters and the metadata fields run here (the titles now exist)...
 *   words        GPU  the `thumbnail_words` row: for each of the three titles, the words that go
 *                     beside it (claim, stakes, reaction; several each).
 *   render       CPU  three default thumbnails, one per pair, with NO reaction photo: Owen picks
 *                     the photos himself in the Thumbnails window (2026-09-29: "just let me pick the
 *                     image of myself that goes in the corner instead of letting the model pick it.
 *                     itll be faster"). The `tone-photos` stage and its `thumbnail_judge` row are gone.
 *
 * THE 27B IS NOT LOADED AGAIN when routing names it for the fields and for the words: every call here runs on the metadata job's own leases (`JobLeases`: one hold per
 * server; the same model on the same server is the same hold; a different model replaces it).
 *
 * FAILURES follow the job's conventions for a stage that is not the item (the chapters' and the
 * scrub's, LEDGER #148 and #223): the item is still generated and saved, and the record says which
 * stage failed and why, in plain words, with the run's warnings saying it too. A cancel, a park or a
 * stall is never recorded as a failure: it ends the job (the generator's one cancellation exit).
 *
 * WHERE THINGS GO. `<report folder>/thumbnails/<jobId>-<item number>/`: `frames/` (the scored
 * frames, 640 and 320 wide), `full/` (the default frames at full size) and the three renders. The
 * report folder is the job's, never the week's `thumbnails/` folder that the publish pass proposes
 * from (LEDGER #219; thumbnail-validate.ts looks only at `<week>/thumbnails/<export name>`), so no
 * render is attached to anything before Owen picks.
 */
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import type { TranscriptRef } from '../publish/publish-types';
import type { AIManagerService } from '../metadata/ai-manager.service';
import type { ChannelData } from '../metadata/prompt-assets';
import type { SRTSegment } from '../metadata/transcription.service';
import { routingOption, type MetadataRoutingOption, type ResolvedMetadataRouting } from '../metadata/metadata-routing';
import type { JobLeases } from '../../crucible/lease';
import { crucibleStepHooks } from '../../crucible/lanes';
import { MAX_FRAMES_TO_SCORE, filterFrames } from './frame-metrics';
import { rankFrames } from './frame-ranking';
import { allocateScoring, framesToScore, groupScenes, sceneRows, type SceneRow } from './frame-scenes';
import { clock, extractFullFrame, frameId, probeVideo, sampleFrames, sceneLabel, type SampledFrame } from './frame-sampler';
import { plainScoringError, scoreFramesOnCard, type ScorerDeps } from './frame-scorer';
import type { ThumbnailStyle } from './layout';
import { libraryBorder, libraryLogo, libraryPhotos } from './photo-library';
import { transcriptLines, WORD_KINDS, type WordKind } from './prompts';
import { safeFileName, type RenderResult } from './renderer';
import type { StoredRender } from './pipeline-record';
import { resolveStorySource } from './story-source';
import { resolveThumbnailStory } from './story-match';
import { writeThumbnailWords } from './words-writer';
import {
  PAIR_COUNT,
  PAIR_KINDS,
  THUMBNAIL_STAGES,
  THUMBNAILS_FOLDER,
  THUMBNAILS_RECORD_VERSION,
  type ItemThumbnails,
  type StoredPair,
  type ThumbnailStage,
} from './pipeline-record';

/** Draws one thumbnail; the Electron one is pipeline-electron.ts (a hidden canvas page). */
export interface ThumbnailRenderer {
  render(input: {
    frame: string;
    /** Null: no words on this one (Owen's "No text"). */
    phrase: string | null;
    style: ThumbnailStyle;
    /** Null: no reaction photo (none picked). */
    photo: { name: string; file: string } | null;
    logoFile: string | null;
    /** Owen's border overlay (the app's border file), or null: none kept, or switched off in the look. */
    borderFile: string | null;
    outStem: string;
  }): Promise<RenderResult>;
  close(): void;
}

/** A drawn pair, as the record stores it. */
export type DrawnRender = Extract<StoredRender, { ok: true }>;

/**
 * Draw one pair's thumbnail: the frame at full size (extracted from the screen recording into
 * `<folder>/full/` the first time; a screenshot is already there), the app's border overlay when
 * the look has it on and one is kept, the words, the photo from the app's library and the app's
 * logo when `logo` is on. Used by the render stage and by the reports
 * page's Thumbnails window (report-thumbnails.ts), so both draw the same way.
 */
export async function drawPair(input: {
  renderer: ThumbnailRenderer;
  ffmpeg: string;
  /** The screen recording, or null when the backgrounds are screenshots (already in `full/`). */
  video: string | null;
  folder: string;
  frame: { id: string; t: number };
  phrase: string | null;
  photo: string | null;
  logo: boolean;
  style: ThumbnailStyle;
  userDataPath: string;
  outStem: string;
  signal?: AbortSignal;
}): Promise<DrawnRender> {
  const full = path.join(input.folder, 'full', `${input.frame.id}.png`);
  if (!fs.existsSync(full)) {
    if (input.video === null) throw new Error(`The background ${input.frame.id} is not in ${path.dirname(full)} any more, and there is no screen recording to take it from again.`);
    await extractFullFrame(input.ffmpeg, input.video, input.frame.t, full, input.signal);
  }
  let photo: { name: string; file: string } | null = null;
  if (input.photo !== null) {
    const file = libraryPhotos(input.userDataPath).find((p) => p.name === input.photo)?.file;
    if (file === undefined) throw new Error(`The reaction photo "${input.photo}" is not in the app's library any more.`);
    photo = { name: input.photo, file };
  }
  let logoFile: string | null = null;
  if (input.logo) {
    logoFile = libraryLogo(input.userDataPath);
    if (logoFile === null) throw new Error('The logo is switched on for this thumbnail, and the app keeps no logo. Add one in Thumbnail look, or switch the logo off.');
  }
  const borderFile = input.style.border ? libraryBorder(input.userDataPath) : null;
  const r = await input.renderer.render({ frame: full, phrase: input.phrase, style: input.style, photo, logoFile, borderFile, outStem: input.outStem });
  return { ok: true, file: r.path, format: r.format, bytes: r.bytes, notes: r.notes };
}

/** What the run needs from the app, read AT JOB TIME by the IPC layer (ipc-handlers.ts). */
export interface ThumbnailRunSetup {
  userDataPath: string;
  ffmpeg: string;
  ffprobe: string;
  /** The editor's manifest for a compounds zip (PythonService.editorManifest). */
  manifest: (zipPath: string) => Promise<unknown>;
  /** Opened for the render stage, closed after it. */
  openRenderer: () => ThumbnailRenderer;
  /** The one look for every channel (the store's `thumbnailLab.style`, look.ts), and whether it was saved. */
  style: ThumbnailStyle;
  styleSaved: boolean;
  /** Said in the record's lines when the saved look was read with a newer default (layout.ts readStoredStyle). */
  styleLine: string | null;
  /** The doors a GPU stage calls: the lanes (its GPU step), the transport, a client for the engine width. */
  doors: Pick<ScorerDeps, 'lanes' | 'transport' | 'clientFor'>;
}

/**
 * Whether this run makes thumbnails. `off` carries the reason, stated on every item's record.
 * Absent on GenerationParams (a caller that predates this, the test CLI) the generator states that.
 */
export type ThumbnailRunChoice = { mode: 'on'; setup: ThumbnailRunSetup } | { mode: 'off'; reason: string };

/** One item, as the stages need it. */
export interface ThumbnailItemInput {
  jobId: string;
  /** 0-based position in the job. */
  itemIndex: number;
  sourceLabel: string;
  contentType: 'subject' | 'video' | 'transcript_file';
  videoPath: string | null;
  /** The item's CONTENT link as the Inputs page sent it (see story-match.ts). */
  operatorRef: TranscriptRef | null | undefined;
  segments: readonly SRTSegment[];
  /** The job's report folder (`txt_folder`). */
  reportFolder: string;
  channel: ChannelData;
}

/** The metadata job's doors, for this item. */
export interface ThumbnailJobDoors {
  leases: JobLeases;
  aiManager: Pick<AIManagerService, 'runPlainRequest'>;
  routing: ResolvedMetadataRouting;
  signal?: AbortSignal;
  /** True once the run is being stopped (cancel, park, stall): a failure then is the stop, rethrown. */
  cancelled: () => boolean;
  /** A progress line for the queue row; also the job's sign of life. */
  progress: (message: string) => void;
}

/** What the words stage reads off the generated item. */
export interface GeneratedFields {
  titles: unknown;
  reroll_gate?: { ranking?: { order?: Array<{ title: string }> } | null } | null;
}

/** Each default pair's line about its photo: none is drawn until Owen picks one. */
export const NO_PHOTO_YET = 'No photo picked yet: pick one in the Thumbnails window.';

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function routed(routing: ResolvedMetadataRouting, task: 'thumbnail_frames' | 'thumbnail_words'): MetadataRoutingOption {
  return routingOption(task, routing[task]);
}

/** The creator's names for the prompts, from the channel's brand terms (refused when it has none). */
function creatorOf(channel: ChannelData): string {
  const terms = (channel.brandTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (terms.length === 0) throw new Error(`The prompt set "${channel.name}" declares no brand_terms, so nothing says who its creator is.`);
  return terms.join(', ');
}

/**
 * The three titles the pairs are written for: the re-roll gate's ranking when it ranked the titles,
 * else the titles in the order the titles field wrote them (the gate is off by default, LEDGER
 * #210). The order used is recorded; phase 2 re-asks for words when Owen reorders them.
 */
export function pairSubjects(fields: GeneratedFields): { order: 'gate ranking' | 'as written'; subjects: string[] } {
  const titles = Array.isArray(fields.titles) ? [...new Set((fields.titles as unknown[]).filter((t): t is string => typeof t === 'string' && t.trim() !== ''))] : [];
  if (titles.length === 0) throw new Error('The item has no titles, so there is nothing to pair thumbnails with.');
  const ranked = fields.reroll_gate?.ranking?.order;
  if (Array.isArray(ranked) && ranked.length > 0) {
    return { order: 'gate ranking', subjects: ranked.map((r) => r.title).filter((t) => titles.includes(t)).slice(0, PAIR_COUNT) };
  }
  return { order: 'as written', subjects: titles.slice(0, PAIR_COUNT) };
}

/**
 * Each pair's default frame: the best frame of a different scene for each pair, best scene first;
 * with fewer scenes than pairs, the scenes' second ("clearly different") frames next, in the same
 * order. Returns fewer than PAIR_COUNT only when the rows hold fewer frames in all.
 */
export function defaultFrames(rows: readonly SceneRow[]): Array<{ id: string; scene: number; repeat: boolean }> {
  const out: Array<{ id: string; scene: number; repeat: boolean }> = [];
  for (const r of rows) if (out.length < PAIR_COUNT) out.push({ id: r.ids[0], scene: r.scene, repeat: false });
  for (const r of rows) if (out.length < PAIR_COUNT && r.ids[1] !== undefined) out.push({ id: r.ids[1], scene: r.scene, repeat: true });
  return out;
}

/** A pair's default words: the first option of its kind, or of the next kind that has one (said). */
export function defaultWords(words: Record<WordKind, string[]>, kind: WordKind): { kind: WordKind; phrase: string; line: string | null } | null {
  if (words[kind].length > 0) return { kind, phrase: words[kind][0], line: null };
  const other = WORD_KINDS.find((k) => words[k].length > 0);
  if (other === undefined) return null;
  return { kind: other, phrase: words[other][0], line: `The model wrote no ${kind} words, so this pair starts on its first ${other} option.` };
}

/**
 * WHAT "FINISH MAKING THUMBNAILS" KEEPS AND WHAT IT RUNS (2026-09-29, Owen's run stopped at the
 * since-removed tone-photos stage on an empty photo library; such a record keeps its words and is
 * only drawn): a stage is kept when what it stores is all there, and
 * every stage after the first one that is not kept runs again (each reads what the one before it
 * wrote). The frames and the scoring are kept or run TOGETHER: the scene rows are built from the
 * frames' colour signatures, which are not stored, so scoring again means sampling again. A record
 * whose backgrounds are screenshots keeps its story, frames and scoring (there is nothing to sample
 * or score). `exists` is fs.existsSync in the app (a render file that went missing is drawn again).
 */
export function resumePlan(r: ItemThumbnails, exists: (file: string) => boolean): { keep: ThumbnailStage[]; run: ThumbnailStage[] } {
  const fromShots = r.source !== null && r.source.video === null && r.frames.length > 0;
  const kept: Record<ThumbnailStage, boolean> = { story: false, frames: false, scoring: false, words: false, render: false };
  kept.story = fromShots || r.story?.state === 'linked';
  kept.frames = kept.story && (fromShots || (r.source !== null && r.frames.length > 0 && r.scoring !== null && r.bestScenes.length > 0));
  kept.scoring = kept.frames;
  kept.words = kept.scoring && r.titles !== null && r.pairs.length > 0 &&
    r.pairs.every((p) => p.words.claim.length + p.words.stakes.length + p.words.reaction.length > 0);
  kept.render = kept.words && r.pairs.every((p) => p.default.render.ok && exists(p.default.render.file));
  const firstRun = THUMBNAIL_STAGES.findIndex((s) => !kept[s]);
  if (firstRun === -1) return { keep: [...THUMBNAIL_STAGES], run: [] };
  return { keep: THUMBNAIL_STAGES.slice(0, firstRun), run: THUMBNAIL_STAGES.slice(firstRun) };
}

/** What the record says about the look it was drawn with. */
function lookLines(setup: ThumbnailRunSetup): string[] {
  if (!setup.styleSaved) return ['No thumbnail look is saved, so the default look is used.'];
  return setup.styleLine === null ? [] : [setup.styleLine];
}

function offRecord(line: string, story: ItemThumbnails['story'] = null, state: 'off' | 'no-story' = 'off'): ItemThumbnails {
  return {
    version: THUMBNAILS_RECORD_VERSION, state, line, failure: null, story, folder: null, source: null, scenes: [], frames: [], bestScenes: [],
    scoring: null, titles: null, tone: null, pairs: [], seed: null, look: null, logo: null, lines: [], timings: [], picks: [],
  };
}

/**
 * One item's thumbnails across the job: `beforeChapters()` (story, frames, scoring), then
 * `afterFields()` (words, render) once the item's fields are written; `record()` is
 * what the item stores. A stage after a failure, a skip or "off" does nothing.
 */
export class ItemThumbnailRun {
  private readonly rec: ItemThumbnails;
  private stopped: boolean;
  /** Stages a resumed run keeps as stored (ItemThumbnailRun.resume): they do not run again. */
  private skip = new Set<ThumbnailStage>();
  /** What the frames stage says when it replaces an existing folder. */
  private replacingLine: (folder: string) => string = (folder) => `An earlier attempt of this job left thumbnail files in ${folder}; they were replaced.`;
  private video: string | null = null;
  private frameFiles = new Map<string, { t: number; large: string }>();

  private constructor(
    private readonly setup: ThumbnailRunSetup | null,
    private readonly item: ThumbnailItemInput,
    private readonly doors: ThumbnailJobDoors,
    rec: ItemThumbnails,
  ) {
    this.rec = rec;
    this.stopped = rec.state !== 'made';
  }

  /**
   * The run for one item, or a record that already says why there are none. `again` is the
   * Thumbnails window's "Make thumbnails again from scratch": the item's existing folder (which the
   * frames stage replaces, said in the record's lines).
   */
  static start(choice: ThumbnailRunChoice | undefined, item: ThumbnailItemInput, doors: ThumbnailJobDoors, again?: { folder: string }): ItemThumbnailRun {
    const off = (line: string) => new ItemThumbnailRun(null, item, doors, offRecord(line));
    if (choice === undefined) return off('This run was started without the thumbnail setup (the test CLI, or a caller from before the thumbnails pipeline), so no thumbnails were made.');
    if (choice.mode === 'off') return off(choice.reason);
    if (item.channel.thumbnails === null) {
      return off(`The channel file for "${item.channel.name}" does not say whether it makes thumbnails (its "thumbnails" key is missing, ${item.channel.sourcePath}), so none were made.`);
    }
    if (item.channel.thumbnails === false) return off(`The channel "${item.channel.name}" makes no thumbnails.`);
    const rec = offRecord('Thumbnails are being made.');
    rec.state = 'made';
    rec.folder = again?.folder ?? path.join(item.reportFolder, THUMBNAILS_FOLDER, `${item.jobId}-${item.itemIndex + 1}`);
    rec.look = choice.setup.style;
    rec.lines.push(...lookLines(choice.setup));
    const run = new ItemThumbnailRun(choice.setup, item, doors, rec);
    if (again !== undefined) {
      rec.lines.push('Made again from scratch in the Thumbnails window.');
      run.replacingLine = (folder) => `The earlier thumbnails in ${folder} were removed to make them again from scratch.`;
    }
    return run;
  }

  /**
   * "FINISH MAKING THUMBNAILS" (the Thumbnails window, 2026-09-29): a record whose stages stopped
   * (state `failed`) goes on from what it stores. The stages `plan.keep` names are not run again
   * (their frames, scores and words are used as stored); the rest run in order, on the doors given
   * (the window's one held job), exactly as in the metadata run. What each later stage writes is
   * cleared first, so nothing half-written from the stopped attempt survives. Own-image picks stay;
   * pair picks go (their pairs are drawn again). A record from before 2026-09-29 keeps its ranked
   * photos and tone as stored (read by nothing now); every pair is drawn with no photo.
   */
  static resume(
    setup: ThumbnailRunSetup,
    item: ThumbnailItemInput,
    doors: ThumbnailJobDoors,
    stored: ItemThumbnails,
    plan: { keep: readonly ThumbnailStage[]; run: readonly ThumbnailStage[] },
  ): ItemThumbnailRun {
    if (plan.run.length === 0) throw new Error('Nothing is missing from these thumbnails, so there is nothing to finish.');
    const rec = JSON.parse(JSON.stringify(stored)) as ItemThumbnails;
    const keep = new Set(plan.keep);
    const stoppedAt = stored.failure === null ? null : `${stored.failure.stage}`;
    rec.state = 'made';
    rec.failure = null;
    rec.line = 'Thumbnails are being finished.';
    rec.look = setup.style;
    rec.picks = rec.picks.filter((p) => p.kind === 'own');
    if (!keep.has('story')) rec.story = null;
    if (!keep.has('frames')) {
      rec.source = null;
      rec.scenes = [];
      rec.frames = [];
      rec.bestScenes = [];
      rec.scoring = null;
    }
    if (!keep.has('words')) {
      rec.titles = null;
      rec.pairs = [];
    }
    for (const p of rec.pairs) {
      p.default.photo = null;
      p.default.draw = null;
      p.lines = [...p.lines.filter((l) => !l.startsWith('Photo: ') && l !== NO_PHOTO_YET), NO_PHOTO_YET];
      p.default.render = { ok: false, reason: 'Not drawn yet.' };
    }
    rec.lines.push(
      `Finished in the Thumbnails window${stoppedAt === null ? '' : ` after stopping at the ${stoppedAt} stage`}: ` +
        (plan.keep.length > 0 ? `${plan.keep.join(', ')} kept as stored; ` : '') + `${plan.run.join(', ')} run.`,
    );
    const run = new ItemThumbnailRun(setup, item, doors, rec);
    // `render` is never kept (a plan with nothing to run is refused above), so every pair is drawn.
    for (const s of plan.keep) run.skip.add(s);
    run.video = rec.source?.video ?? null;
    for (const f of rec.frames) run.frameFiles.set(f.id, { t: f.t, large: f.large });
    return run;
  }

  /**
   * THE NO-STORY PATH (phase 2, Owen 2026-09-28): the backgrounds are Owen's own screenshots, one
   * pair per screenshot (1 to 3), for the titles the Thumbnails window names. Each screenshot is
   * already a 16:9 PNG in `<folder>/full/<id>.png` (report-thumbnails.ts prepared it); the record's
   * frames, scenes and rows are the screenshots, and `afterFields` then writes the words and draws
   * (no photo until Owen picks one), exactly as the metadata run does. `rec` is the record to replace (its story
   * is kept, so "no story" and why stay said).
   */
  static fromScreenshots(
    setup: ThumbnailRunSetup,
    item: ThumbnailItemInput,
    doors: ThumbnailJobDoors,
    base: { story: ItemThumbnails['story']; folder: string },
    shots: ReadonlyArray<{ id: string; full: string; lines: string[] }>,
  ): ItemThumbnailRun {
    if (shots.length < 1 || shots.length > PAIR_COUNT) throw new Error(`Screenshots make 1 to ${PAIR_COUNT} thumbnails; ${shots.length} were given.`);
    const rec = offRecord('Thumbnails are being made from your screenshots.', base.story);
    rec.state = 'made';
    rec.folder = base.folder;
    rec.look = setup.style;
    rec.lines.push(...lookLines(setup));
    rec.source = { video: null, lines: [`Backgrounds: your ${shots.length} screenshot${shots.length === 1 ? '' : 's'}.`, ...shots.flatMap((s) => s.lines)] };
    rec.scenes = shots.map((s, i) => ({ number: i + 1, seconds: 0, label: `Screenshot ${i + 1}`, kept: 1, scored: 0 }));
    rec.frames = shots.map((s, i) => ({ id: s.id, t: 0, clock: '', scene: i + 1, large: s.full, small: s.full, score: null, reading: null, flag: null }));
    rec.bestScenes = shots.map((s, i) => ({ scene: i + 1, ids: [s.id], more: [], best: 0 }));
    const run = new ItemThumbnailRun(setup, item, doors, rec);
    for (const s of shots) run.frameFiles.set(s.id, { t: 0, large: s.full });
    return run;
  }

  record(): ItemThumbnails {
    return this.rec;
  }

  /**
   * Remove this item's thumbnails folder (the item failed and is not saved, so nothing will ever
   * point at it). Returns the folder removed, or null when nothing was written.
   */
  removeFiles(): string | null {
    const folder = this.rec.folder;
    if (folder === null || !fs.existsSync(folder)) return null;
    fs.rmSync(folder, { recursive: true, force: true });
    return folder;
  }

  /** The run's warning line when a stage failed, else null. */
  warning(): string | null {
    return this.rec.state === 'failed' ? `${this.item.sourceLabel}: ${this.rec.line}` : null;
  }

  private async stage(name: ThumbnailStage, fn: () => Promise<void> | void): Promise<void> {
    if (this.stopped || this.skip.has(name)) return;
    const t0 = Date.now();
    try {
      await fn();
    } catch (err) {
      // A stop is the job's, never this stage's failure: it goes to the generator's one exit.
      if (this.doors.cancelled()) throw err;
      const reason = message(err);
      this.rec.state = 'failed';
      this.rec.failure = { stage: name, reason };
      this.rec.line = `The thumbnails stopped at the ${name} stage: ${reason}`;
      this.stopped = true;
      log.error(`[Thumbnails] ${this.item.sourceLabel}: ${this.rec.line}`);
    } finally {
      this.rec.timings.push({ stage: name, seconds: Math.round((Date.now() - t0) / 100) / 10 });
    }
  }

  private noStory(reason: string): void {
    this.rec.state = 'no-story';
    this.rec.line = `No thumbnails: ${reason}`;
    this.rec.folder = null;
    this.rec.look = null;
    this.stopped = true;
    log.info(`[Thumbnails] ${this.item.sourceLabel}: ${this.rec.line}`);
  }

  /** Story, frames (CPU) and scoring (GPU): before the chapters. */
  async beforeChapters(): Promise<void> {
    await this.stage('story', () => {
      const { item } = this;
      if (item.contentType !== 'video') {
        this.rec.story = { state: 'none', reason: 'This item is not a video file, so there is no editor story to take frames from.', evidence: null };
        this.noStory(this.rec.story.reason);
        return;
      }
      const text = item.segments.map((s) => s.text).join(' ');
      const story = resolveThumbnailStory({ videoPath: item.videoPath, operatorRef: item.operatorRef, transcriptText: text });
      this.rec.story = story;
      if (story.state === 'none') this.noStory(story.reason);
      else log.info(`[Thumbnails] ${item.sourceLabel}: ${story.line}`);
    });
    await this.stage('frames', () => this.frames());
    await this.stage('scoring', () => this.score());
  }

  private async frames(): Promise<void> {
    const setup = this.setup!;
    const story = this.rec.story;
    if (story === null || story.state !== 'linked') throw new Error('The frames stage ran without a linked story.');
    const folder = this.rec.folder!;
    if (fs.existsSync(folder)) {
      // Only an earlier attempt of THIS job writes here (the folder is named by the job id), and
      // starting the job again rewrote its report without that attempt's items.
      fs.rmSync(folder, { recursive: true, force: true });
      this.rec.lines.push(this.replacingLine(folder));
    }
    this.doors.progress('Thumbnails: finding frames in the story\'s screen recording...');
    const source = await resolveStorySource(story.ref, {
      manifest: setup.manifest,
      duration: async (video) => (await probeVideo(setup.ffprobe, video)).duration,
    });
    this.video = source.screenFile;
    const sampled = await sampleFrames({
      ffmpeg: setup.ffmpeg,
      ffprobe: setup.ffprobe,
      video: source.screenFile,
      spans: source.plan.screen,
      outDir: path.join(folder, 'frames'),
      ...(this.doors.signal === undefined ? {} : { signal: this.doors.signal }),
      onProgress: (done, total) => {
        if (done % 50 === 0 || done === total) this.doors.progress(`Thumbnails: sampled ${done} of ${total} frames...`);
      },
    });
    const filtered = filterFrames(sampled.frames);
    const keptIds = new Set(filtered.kept.map(frameId));
    const kept = sampled.frames.filter((f) => keptIds.has(frameId(f)));
    const scenes = groupScenes(kept, sampled.frames, sampled.every);
    const allocation = allocateScoring(scenes.map((s) => ({ number: s.number, size: s.frames.length, seconds: s.seconds })), MAX_FRAMES_TO_SCORE);
    const toScore = framesToScore(scenes, allocation.quota);
    const scoreIds = new Set(toScore.map(frameId));
    // Only the frames the model is asked about stay on disk: they are the candidates.
    for (const f of sampled.frames) {
      if (scoreIds.has(frameId(f))) continue;
      fs.rmSync(f.large, { force: true });
      fs.rmSync(f.small, { force: true });
    }
    const sceneOf = new Map(scenes.flatMap((s) => s.frames.map((f) => [frameId(f), s.number] as const)));
    this.rec.source = { video: source.screenFile, lines: source.lines };
    this.rec.scenes = scenes.map((s) => ({
      number: s.number, seconds: s.seconds, label: sceneLabel(s), kept: s.frames.length,
      scored: s.frames.filter((f) => scoreIds.has(frameId(f))).length,
    }));
    this.rec.frames = toScore.sort((a, b) => a.t - b.t).map((f: SampledFrame) => ({
      id: frameId(f), t: f.t, clock: clock(f.t), scene: sceneOf.get(frameId(f))!, large: f.large, small: f.small, score: null, reading: null, flag: null,
    }));
    this.signatures = new Map(kept.map((f) => [frameId(f), f.colour]));
    this.sceneOf = sceneOf;
    const blurry = filtered.dropped.filter((d) => d.reason === 'blurry').length;
    const repeats = filtered.dropped.filter((d) => d.reason === 'repeat').length;
    this.rec.lines.push(
      `Sampled ${sampled.frames.length} frames of the story's ${clock(sampled.seconds)} of screen recording; removed ${repeats} repeated and ${blurry} blurry; ` +
        `${kept.length} kept in ${scenes.length} scene${scenes.length === 1 ? '' : 's'}; ${toScore.length} sent to be scored.`,
    );
  }

  private signatures = new Map<string, Uint8Array>();
  private sceneOf = new Map<string, number>();

  private async score(): Promise<void> {
    const setup = this.setup!;
    const option = routed(this.doors.routing, 'thumbnail_frames');
    const model = option.crucibleModel;
    if (model === null) throw new Error(`The "Thumbnail frames" row names ${option.label}, which is not a Crucible model; frames are scored on a Crucible server.`);
    const frames = this.rec.frames.map((f) => ({ id: f.id, t: f.t, image: f.large }));
    this.doors.progress(`Thumbnails: scoring ${frames.length} frames on ${model}...`);
    const outcome = await setup.doors.lanes.aiCall({ lane: 'gpu', model }, `Thumbnail frames (${this.item.jobId})`, () => {
      const server = crucibleStepHooks().server;
      if (server === null) throw new Error('The frame scoring step has no server to run on.');
      return scoreFramesOnCard(setup.doors, {
        job: this.doors.leases,
        server,
        model,
        frames,
        signal: this.doors.signal ?? new AbortController().signal,
        beat: () => undefined,
        onProgress: (done, total) => {
          if (done % 10 === 0 || done === total) this.doors.progress(`Thumbnails: scored ${done} of ${total} frames...`);
        },
      });
    }).catch((err) => {
      throw plainScoringError(err, model);
    });
    const { ranked, screens } = rankFrames(outcome.scored);
    const readings = new Map(outcome.scored.map((s) => [s.id, s.reading]));
    const scores = new Map(ranked.map((r) => [r.id, r.score]));
    const flags = new Map<string, 'screen' | 'unreadable'>([
      ...screens.map((s) => [s.id, 'screen'] as const),
      ...outcome.unreadable.map((u) => [u.id, 'unreadable'] as const),
    ]);
    this.rec.frames = this.rec.frames.map((f) => ({ ...f, score: scores.get(f.id) ?? null, reading: readings.get(f.id) ?? null, flag: flags.get(f.id) ?? null }));
    const rows = sceneRows(ranked, this.sceneOf, this.rec.scenes.map((s) => s.number), this.signatures);
    this.rec.bestScenes = rows.rows;
    for (const f of this.rec.frames) this.frameFiles.set(f.id, { t: f.t, large: f.large });
    this.rec.scoring = {
      server: outcome.server,
      model: outcome.model,
      line: `Scored ${outcome.scored.length} frames on ${outcome.model} on "${outcome.server}" (${outcome.widthBasis}); ${screens.length} were computer screens` +
        (outcome.unreadable.length > 0 ? `, ${outcome.unreadable.length} could not be read` : '') + '.',
    };
    if (rows.rows.length === 0) throw new Error('Every scored frame was a computer screen or could not be read, so there is no frame to put on a thumbnail.');
  }

  /** The words (GPU), then the three renders (CPU, no photo): after the item's fields are written. */
  async afterFields(fields: GeneratedFields): Promise<void> {
    await this.stage('words', async () => {
      const titles = pairSubjects(fields);
      this.rec.titles = titles;
      await this.words(titles.subjects);
    });
    await this.stage('render', () => this.render());
    if (!this.stopped) {
      const made = this.rec.pairs.filter((p) => p.default.render.ok).length;
      this.rec.line = made === this.rec.pairs.length
        ? `${made} title and thumbnail pair${made === 1 ? ' is' : 's are'} ready to pick from; no photo picked yet.`
        : `${made} of ${this.rec.pairs.length} thumbnails were drawn; ${this.rec.pairs.filter((p) => !p.default.render.ok).map((p) => `pair ${p.pair}: ${(p.default.render as { reason: string }).reason}`).join('; ')}`;
    }
  }

  private async words(subjects: readonly string[]): Promise<void> {
    const option = routed(this.doors.routing, 'thumbnail_words');
    const creator = creatorOf(this.item.channel);
    const transcript = transcriptLines(this.item.segments);
    const frames = defaultFrames(this.rec.bestScenes);
    if (frames.length === 0) throw new Error('There is no ranked frame to put on a thumbnail.');
    for (const [i, title] of subjects.entries()) {
      this.doors.progress(`Thumbnails: writing the words for title ${i + 1} of ${subjects.length}...`);
      const result = await writeThumbnailWords({
        aiManager: this.doors.aiManager,
        option,
        job: this.doors.leases,
        channel: this.item.channel.name,
        creator,
        title,
        transcript,
        sourceLabel: `${this.item.sourceLabel} (pair ${i + 1})`,
      });
      const { claim, stakes, reaction, warnings } = result.options;
      const kind = PAIR_KINDS[i];
      const chosen = defaultWords({ claim, stakes, reaction }, kind);
      if (chosen === null) throw new Error(`The words for "${title}" came back with no option of any kind.`);
      const frame = frames[i % frames.length];
      const lines: string[] = [];
      if (chosen.line !== null) lines.push(chosen.line);
      if (i >= frames.length) lines.push(`There are only ${frames.length} ranked frames, so this pair repeats pair ${(i % frames.length) + 1}'s frame.`);
      else if (frame.repeat) lines.push(`There are fewer scenes than pairs, so this pair takes a second frame of scene ${frame.scene}.`);
      this.rec.pairs.push({
        pair: i + 1,
        title,
        words: { claim, stakes, reaction, warnings, model: result.model },
        photos: [],
        default: {
          frameId: frame.id, scene: frame.scene, kind: chosen.kind, phrase: chosen.phrase, photo: null,
          draw: null, logo: false, render: { ok: false, reason: 'Not drawn yet.' },
        },
        lines: [...lines, NO_PHOTO_YET],
      });
    }
  }

  private async render(): Promise<void> {
    const setup = this.setup!;
    const folder = this.rec.folder!;
    const logoFile = libraryLogo(setup.userDataPath);
    this.rec.logo = logoFile;
    if (logoFile === null) this.rec.lines.push('No logo is kept in the app, so none is drawn.');
    if (!setup.style.border) this.rec.lines.push('The border is switched off in Thumbnail look, so none is drawn.');
    else if (libraryBorder(setup.userDataPath) === null) this.rec.lines.push('No border is kept in the app, so none is drawn.');
    this.doors.progress(`Thumbnails: drawing the ${this.rec.pairs.length} thumbnails...`);
    const renderer = setup.openRenderer();
    try {
      for (const p of this.rec.pairs) {
        const d = p.default;
        const frame = this.frameFiles.get(d.frameId);
        if (frame === undefined) throw new Error(`Pair ${p.pair}'s frame ${d.frameId} is not among the scored frames.`);
        d.render = await drawPair({
          renderer,
          ffmpeg: setup.ffmpeg,
          video: this.video,
          folder,
          frame: { id: d.frameId, t: frame.t },
          phrase: d.phrase,
          photo: d.photo,
          logo: logoFile !== null,
          style: setup.style,
          userDataPath: setup.userDataPath,
          outStem: path.join(folder, `Pair ${p.pair} - ${safeFileName(p.title)}`),
          ...(this.doors.signal === undefined ? {} : { signal: this.doors.signal }),
        });
        d.logo = logoFile !== null;
      }
    } finally {
      renderer.close();
    }
  }
}

