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
 *   tone-photos  GPU  the `thumbnail_judge` row: the tone, and every reaction photo ranked for each
 *                     pair's default words.
 *   render       CPU  three default thumbnails, one per pair.
 *
 * THE 27B IS NOT LOADED AGAIN when routing names it for the fields and for the words and the
 * tone/photo: every call here runs on the metadata job's own leases (`JobLeases`: one hold per
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
import { draftNotes, judgeThumbnails } from './judge';
import type { ThumbnailStyle } from './layout';
import { drawLine, drawPhotos } from './photo-draw';
import { libraryLogo, libraryPhotos } from './photo-library';
import { transcriptLines, WORD_KINDS, type WordKind } from './prompts';
import { safeFileName, type RenderResult } from './renderer';
import { resolveStorySource } from './story-source';
import { resolveThumbnailStory } from './story-match';
import { writeThumbnailWords } from './words-writer';
import {
  PAIR_COUNT,
  PAIR_KINDS,
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
    phrase: string;
    style: ThumbnailStyle;
    photo: { name: string; file: string };
    logoFile: string | null;
    outStem: string;
  }): Promise<RenderResult>;
  close(): void;
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
  /** The one look for every channel (the store's `thumbnailLab.style`), and whether it was saved. */
  style: ThumbnailStyle;
  styleSaved: boolean;
  /** Owen's photo notes (`thumbnailLab.reactionNotes`); a photo without one uses its draft. */
  photoNotes: Record<string, string>;
  /** A seed for the photo draw (crypto.randomInt in the IPC layer); stored with the record. */
  newSeed: () => number;
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

/** What the words and tone/photo stages read off the generated item. */
export interface GeneratedFields {
  titles: unknown;
  reroll_gate?: { ranking?: { order?: Array<{ title: string }> } | null } | null;
  description_hook?: unknown;
  description?: unknown;
}

/** The pair letters the photo ranking and draw key on (the tab's A/B/C). */
const LETTERS = ['A', 'B', 'C'] as const;

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

function routed(routing: ResolvedMetadataRouting, task: 'thumbnail_frames' | 'thumbnail_words' | 'thumbnail_judge'): MetadataRoutingOption {
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

function offRecord(line: string, story: ItemThumbnails['story'] = null, state: 'off' | 'no-story' = 'off'): ItemThumbnails {
  return {
    version: THUMBNAILS_RECORD_VERSION, state, line, failure: null, story, folder: null, source: null, scenes: [], frames: [], bestScenes: [],
    scoring: null, titles: null, tone: null, pairs: [], seed: null, look: null, logo: null, lines: [], timings: [], picks: [],
  };
}

/**
 * One item's thumbnails across the job: `beforeChapters()` (story, frames, scoring), then
 * `afterFields()` (words, tone-photos, render) once the item's fields are written; `record()` is
 * what the item stores. A stage after a failure, a skip or "off" does nothing.
 */
export class ItemThumbnailRun {
  private readonly rec: ItemThumbnails;
  private stopped: boolean;
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

  /** The run for one item, or a record that already says why there are none. */
  static start(choice: ThumbnailRunChoice | undefined, item: ThumbnailItemInput, doors: ThumbnailJobDoors): ItemThumbnailRun {
    const off = (line: string) => new ItemThumbnailRun(null, item, doors, offRecord(line));
    if (choice === undefined) return off('This run was started without the thumbnail setup (the test CLI, or a caller from before the thumbnails pipeline), so no thumbnails were made.');
    if (choice.mode === 'off') return off(choice.reason);
    if (item.channel.thumbnails === null) {
      return off(`The channel file for "${item.channel.name}" does not say whether it makes thumbnails (its "thumbnails" key is missing, ${item.channel.sourcePath}), so none were made.`);
    }
    if (item.channel.thumbnails === false) return off(`The channel "${item.channel.name}" makes no thumbnails.`);
    const rec = offRecord('Thumbnails are being made.');
    rec.state = 'made';
    rec.folder = path.join(item.reportFolder, THUMBNAILS_FOLDER, `${item.jobId}-${item.itemIndex + 1}`);
    rec.look = choice.setup.style;
    if (!choice.setup.styleSaved) rec.lines.push('No look is saved on the Thumbnails tab, so the default look is used.');
    return new ItemThumbnailRun(choice.setup, item, doors, rec);
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
    if (this.stopped) return;
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
      this.rec.lines.push(`An earlier attempt of this job left thumbnail files in ${folder}; they were replaced.`);
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

  /** Words, tone and photos (GPU), then the three renders (CPU): after the item's fields are written. */
  async afterFields(fields: GeneratedFields): Promise<void> {
    let subjects: string[] = [];
    await this.stage('words', async () => {
      const titles = pairSubjects(fields);
      this.rec.titles = titles;
      subjects = titles.subjects;
      await this.words(subjects);
    });
    await this.stage('tone-photos', () => this.tonePhotos(fields));
    await this.stage('render', () => this.render());
    if (!this.stopped) {
      const made = this.rec.pairs.filter((p) => p.default.render.ok).length;
      this.rec.line = made === this.rec.pairs.length
        ? `${made} title and thumbnail pairs are ready to pick from.`
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
          frameId: frame.id, scene: frame.scene, kind: chosen.kind, phrase: chosen.phrase, photo: '',
          draw: { name: '', p: 0, chance: 0, pool: [], repeatForced: false }, logo: false, render: { ok: false, reason: 'Not drawn yet.' },
        },
        lines,
      });
    }
  }

  private async tonePhotos(fields: GeneratedFields): Promise<void> {
    const setup = this.setup!;
    const option = routed(this.doors.routing, 'thumbnail_judge');
    const model = option.crucibleModel;
    if (model === null) throw new Error(`The "Thumbnail tone and photo" row names ${option.label}, which is not a Crucible model.`);
    const drafts = draftNotes();
    const photos = libraryPhotos(setup.userDataPath).map((p) => ({
      name: p.name,
      note: setup.photoNotes[p.name] !== undefined ? setup.photoNotes[p.name] : drafts[p.name] ?? null,
    }));
    this.doors.progress('Thumbnails: reading the tone and ranking the reaction photos...');
    const out = await judgeThumbnails({
      deps: setup.doors,
      jobId: `${this.item.jobId}-thumbnails-${this.item.itemIndex + 1}`,
      model,
      job: this.doors.leases,
      ...(this.doors.signal === undefined ? {} : { signal: this.doors.signal }),
      tone: {
        channel: this.item.channel.name,
        creator: creatorOf(this.item.channel),
        hook: typeof fields.description_hook === 'string' ? fields.description_hook : '',
        description: typeof fields.description === 'string' ? fields.description : '',
        transcript: transcriptLines(this.item.segments),
      },
      photos,
      variants: this.rec.pairs.map((p) => ({ letter: LETTERS[p.pair - 1], text: p.default.phrase })),
    });
    this.rec.tone = { ranking: out.tone, model: out.model, server: out.server };
    const seed = setup.newSeed();
    const letters = this.rec.pairs.map((p) => LETTERS[p.pair - 1]);
    const draws = drawPhotos(out.photos, letters, [], seed);
    this.rec.seed = seed;
    for (const p of this.rec.pairs) {
      const letter = LETTERS[p.pair - 1];
      p.photos = out.photos[letter];
      p.default.photo = draws[letter].name;
      p.default.draw = draws[letter];
      p.lines.push(`Photo: ${drawLine(draws[letter])}.`);
    }
    const top = out.tone[0];
    this.rec.lines.push(`The tone reads as ${top.name} (${Math.round((top.p ?? 0) * 100)}%), on ${out.model}; photos drawn with seed ${seed}.`);
  }

  private async render(): Promise<void> {
    const setup = this.setup!;
    const folder = this.rec.folder!;
    const video = this.video;
    if (video === null) throw new Error('The render stage ran without a screen recording.');
    const logoFile = libraryLogo(setup.userDataPath);
    this.rec.logo = logoFile;
    if (logoFile === null) this.rec.lines.push('No logo is kept in the app, so none is drawn.');
    const photoFiles = new Map(libraryPhotos(setup.userDataPath).map((p) => [p.name, p.file]));
    this.doors.progress('Thumbnails: drawing the three thumbnails...');
    const renderer = setup.openRenderer();
    try {
      for (const p of this.rec.pairs) {
        const d = p.default;
        const frame = this.frameFiles.get(d.frameId);
        if (frame === undefined) throw new Error(`Pair ${p.pair}'s frame ${d.frameId} is not among the scored frames.`);
        const photoFile = photoFiles.get(d.photo);
        if (photoFile === undefined) throw new Error(`The reaction photo "${d.photo}" is not in the app's library any more.`);
        const full = path.join(folder, 'full', `${d.frameId}.png`);
        if (!fs.existsSync(full)) await extractFullFrame(setup.ffmpeg, video, frame.t, full, this.doors.signal);
        const r = await renderer.render({
          frame: full,
          phrase: d.phrase,
          style: setup.style,
          photo: { name: d.photo, file: photoFile },
          logoFile,
          outStem: path.join(folder, `Pair ${p.pair} - ${safeFileName(p.title)}`),
        });
        d.logo = r.ok && r.logo !== null;
        d.render = r.ok ? { ok: true, file: r.path, format: r.format, bytes: r.bytes, notes: r.notes } : { ok: false, reason: r.reason };
      }
    } finally {
      renderer.close();
    }
  }
}

