/**
 * THE THUMBNAILS TAB'S MAIN-PROCESS SIDE: one testing workflow for Owen (2026-09-28).
 *
 *   1. Pick a processed item. Its frames come from the editor story it is linked to: the pieces of
 *      the session's clean SCREEN RECORDING that story is made of (story-source.ts), never the
 *      finished export (camera and screen together). An item with no link gets a picker (editor
 *      session, then story), and the choice is saved as the item's link: the publish selection
 *      record's `transcriptRef`, the same field the Inputs page and regeneration use.
 *   2. Find frames: ffmpeg samples ~1/s, the cheap filters drop repeats and blurry frames, what is
 *      left is grouped into SCENES by how it looks (frame-scenes.ts), the routed vision model
 *      scores at most MAX_FRAMES_TO_SCORE of it (every scene some, the rest by screen time), the
 *      desktop answer rejects screens, and the best view shows each scene's top few frames.
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
import { MAX_FRAMES_TO_SCORE, filterFrames } from './frame-metrics';
import { rankFrames, type FrameReading, type RankedFrame } from './frame-ranking';
import { SCENE_FLOOR, allocateScoring, framesToScore, groupScenes, sceneRows, type Scene, type SceneRow } from './frame-scenes';
import { clock, extractFullFrame, probeVideo, sampleFrames, type SampledFrame } from './frame-sampler';
import { resolveStorySource, type StorySource } from './story-source';
import {
  isLinkable,
  listProjectStories,
  listWeekStories,
  refFromCandidate,
  weekFolderOfExport,
  whyNotLinkable,
  type TranscriptCandidate,
} from '../metadata/editor-transcript-link';
import type { ChosenMetadata, TranscriptRef } from '../publish/publish-types';
import type { SelectionSeed } from '../publish/publish-store.service';
import { scoreFrames, type ScorerDeps } from './frame-scorer';
import { transcriptLine, type WordKind, type WordOptions } from './prompts';
import { writeThumbnailWords } from './words-writer';
import { renderThumbnail } from './renderer';
import { DEFAULT_STYLE, validateStyle, type ThumbnailStyle } from './layout';
import { dataUrlOf, type ThumbnailCanvas } from './canvas-page';
import type { AIManagerService } from '../metadata/ai-manager.service';
import { listReactionPhotos, photoPreview, trimmedPhoto } from './reaction-photos';
import { draftNotes, judgeThumbnails, type Ranked } from './judge';
import { combine, type CombineMode, type Favourites } from './combine';

/** The store key holding the tab's look (font, colours, slots). Absent: DEFAULT_STYLE, said in the view. */
export const STYLE_STORE_KEY = 'thumbnailLab.style';

/** The store key holding the folder of Owen's reaction photos. Absent: none chosen yet (not a default). */
export const PHOTO_FOLDER_STORE_KEY = 'thumbnailLab.reactionFolder';

/**
 * Owen's note per reaction photo (name -> note), stored with the folder setting, never in the repo.
 * A photo with no stored note shows the draft from thumbnails.yml `photo.drafts`, marked as a
 * draft, until he saves one; a photo with neither has no note, and the legend lists its name alone.
 */
export const PHOTO_NOTES_STORE_KEY = 'thumbnailLab.reactionNotes';

/** The folder beside an item's report the renders go into. */
export const OUTPUT_FOLDER = 'thumbnail tests';

export interface LabItem {
  jobId: string;
  itemId: string;
  title: string;
  createdAt: string;
  sourcePath: string | null;
  titles: string[];
  promptSet: string | null;
  hasTranscript: boolean;
  reportFolder: string | null;
  /** The report's description hook and description (for the tone and the photo suggestion). */
  hook: string;
  description: string;
  /**
   * The editor story the RUN generated from (`content_provenance.transcript_ref`): the seed of the
   * item's durable link, used only while the item has no publish selection record. Undefined for
   * an item written before provenance existed.
   */
  runStoryRef: TranscriptRef | null | undefined;
  /** Why the item cannot be used, in plain words; null when it can. */
  problem: string | null;
}

/** The item's story link as the tab shows it. */
export interface LabStoryLink {
  storyTitle: string;
  storyNumber: number;
  session: string;
  projectFolder: string;
  /** 'saved': the item's selection record holds it. 'run': the run generated from it and no record exists yet. */
  from: 'saved' | 'run';
}

/** One story the picker offers, and whether it can be linked. */
export interface LabStoryChoice {
  projectFolder: string;
  session: string;
  number: number;
  title: string;
  slug: string;
  /** Why it cannot be linked (its transcript was never exported, ...), or null. */
  why: string | null;
}

export interface LabStoryState {
  link: LabStoryLink | null;
  /** The stories of the item's week, for the picker (every session under `<week>/files`). */
  choices: LabStoryChoice[];
  /** Where the picker looked, or why it could not. */
  searched: string;
  problems: string[];
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
  /** The scene the frame belongs to (1-based, by first appearance). */
  scene: number;
}

/** One scene of the run: how long the story shows it, how many frames it kept and sends to scoring. */
export interface LabSceneView {
  number: number;
  seconds: number;
  /** "Scene 3 · 2:41 on screen". */
  label: string;
  kept: number;
  scoring: number;
}

export interface LabRunView {
  runId: string;
  itemId: string;
  /** The screen recording the frames come from. */
  video: string;
  start: number;
  end: number;
  lines: string[];
  frames: LabFrameView[];
  /** Frame ids the scorer reads (the kept frames, shared across the scenes up to the cap). */
  toScore: string[];
  /** The scenes, in order of first appearance. */
  scenes: LabSceneView[];
  /** Once scored: one row per scene with its best frames, scenes ordered by their best frame. */
  bestScenes: SceneRow[] | null;
  scoring: { server: string; model: string; line: string } | null;
}

interface Run {
  runId: string;
  item: LabItem;
  source: StorySource;
  video: string;
  dir: string;
  start: number;
  end: number;
  frames: SampledFrame[];
  toScore: Set<string>;
  scenes: Scene<SampledFrame>[];
  sceneOf: Map<string, number>;
  lines: string[];
  ranked: RankedFrame[] | null;
  readings: Map<string, FrameReading>;
  flags: Map<string, 'screen' | 'unreadable'>;
  bestScenes: SceneRow[] | null;
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
  /** The publish selection records: where an item's story link is kept (`transcriptRef`). */
  publishStore: {
    get(itemId: string): ChosenMetadata | null;
    update(itemId: string, seed: SelectionSeed, patch: Partial<Omit<ChosenMetadata, 'itemId' | 'jobId'>>): Promise<ChosenMetadata>;
  };
  /** The editor's timeline manifest for a compounds zip (PythonService.editorManifest). */
  manifest: (zipPath: string) => Promise<unknown>;
  progress: (event: { runId: string; stage: 'sampling' | 'filtering' | 'scoring'; done: number; total: number }) => void;
}

function frameId(frame: { index: number }): string {
  return `f${frame.index}`;
}

function srtSeconds(value: string, what: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!m) throw new Error(`${what}: "${value}" is not a caption time.`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/** "Scene 3 · 2:41 on screen". */
function sceneLabel(scene: { number: number; seconds: number }): string {
  return `Scene ${scene.number} · ${clock(scene.seconds).replace(/^0(\d:)/, '$1')} on screen`;
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

  private routed(task: 'thumbnail_frames' | 'thumbnail_words' | 'thumbnail_judge'): MetadataRoutingOption {
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
          titles,
          promptSet: typeof raw._prompt_set === 'string' ? raw._prompt_set : (typeof job.prompt_set === 'string' ? job.prompt_set : null),
          hasTranscript,
          reportFolder: typeof raw.txt_path === 'string' ? path.dirname(raw.txt_path) : null,
          hook: typeof raw.description_hook === 'string' ? raw.description_hook : '',
          description: typeof raw.description === 'string' ? raw.description : '',
          runStoryRef: raw.content_provenance && typeof raw.content_provenance === 'object'
            ? (raw.content_provenance.transcript_ref ?? null)
            : undefined,
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

  /**
   * The item's story link: the selection record's `transcriptRef` when the item has a record (the
   * operator's durable choice; null there means he linked nothing or cleared it), otherwise the
   * story its run generated from, which is what the record is seeded with when it is created
   * (publish-store.service.ts createRecord). Never a match by name.
   */
  private linkOf(item: LabItem): { ref: TranscriptRef; from: 'saved' | 'run' } | null {
    const record = this.deps.publishStore.get(item.itemId);
    if (record !== null) return record.transcriptRef === null ? null : { ref: record.transcriptRef, from: 'saved' };
    return item.runStoryRef ? { ref: item.runStoryRef, from: 'run' } : null;
  }

  private choiceOf(c: TranscriptCandidate): LabStoryChoice {
    return {
      projectFolder: c.projectFolder,
      session: path.basename(c.projectFolder),
      number: c.storyNumber,
      title: c.storyTitle,
      slug: c.storySlug,
      why: isLinkable(c) ? null : whyNotLinkable(c),
    };
  }

  /** Step 1: the item's link, and the stories of its week for the picker. */
  storyState(jobId: string, itemId: string): LabStoryState {
    const item = this.item(jobId, itemId);
    const found = this.linkOf(item);
    const link: LabStoryLink | null = found === null ? null : {
      storyTitle: found.ref.storyTitle,
      storyNumber: found.ref.storyNumber,
      session: found.ref.sourceSession,
      projectFolder: found.ref.projectFolder,
      from: found.from,
    };
    const week = weekFolderOfExport(item.sourcePath!);
    if (week === null) {
      return {
        link,
        choices: [],
        searched: `${item.sourcePath} is not in a <week>/complete folder, so there is no week of editor sessions to list. Choose an editor project folder instead.`,
        problems: [],
      };
    }
    const { candidates, problems } = listWeekStories(week);
    return { link, choices: candidates.map((c) => this.choiceOf(c)), searched: `Editor sessions in ${path.join(week, 'files')}`, problems };
  }

  /** The stories of one editor project folder the operator chose (a session outside the item's week). */
  storiesIn(projectFolder: string): { choices: LabStoryChoice[]; problems: string[] } {
    const { candidates, problems } = listProjectStories(projectFolder);
    if (candidates.length === 0 && problems.length > 0) throw new Error(problems.join(' '));
    return { choices: candidates.map((c) => this.choiceOf(c)), problems };
  }

  /**
   * Save a story as the item's link, through the selection record (the one door every writer of
   * that record uses; it also runs the record's automatic channel and thumbnail pass). The story is
   * found again in its project by number AND slug, and the link is built by the transcript-link
   * module's own refFromCandidate, recorded as 'manual'.
   */
  async linkStory(jobId: string, itemId: string, projectFolder: string, storyNumber: number, storySlug: string): Promise<LabStoryState> {
    const item = this.item(jobId, itemId);
    const { candidates, problems } = listProjectStories(projectFolder);
    const candidate = candidates.find((c) => c.storyNumber === storyNumber && c.storySlug === storySlug);
    if (candidate === undefined) {
      throw new Error(`Story ${storyNumber} ("${storySlug}") is not in ${projectFolder} any more.${problems.length ? ` ${problems.join(' ')}` : ''}`);
    }
    const ref = refFromCandidate(candidate, 'manual');
    await this.deps.publishStore.update(
      item.itemId,
      { jobId: item.jobId, transcriptRef: item.runStoryRef, promptSet: item.promptSet, sourcePath: item.sourcePath },
      { transcriptRef: ref },
    );
    log.info(`[ThumbnailLab] ${item.itemId} linked to story ${ref.storyNumber} "${ref.storyTitle}" of session ${ref.sourceSession} (${ref.projectFolder})`);
    return this.storyState(jobId, itemId);
  }

  /** Step 2a: sample the story's stretches of the screen recording, filter, thin. The grid pictures come back with the run. */
  async findFrames(req: { jobId: string; itemId: string }): Promise<LabRunView> {
    const item = this.item(req.jobId, req.itemId);
    const link = this.linkOf(item);
    if (link === null) throw new Error(`${item.title} is not linked to an editor story yet. Pick its story first.`);
    const source = await resolveStorySource(link.ref, {
      manifest: (zipPath) => this.deps.manifest(zipPath),
      duration: async (video) => (await probeVideo(this.deps.ffprobe, video)).duration,
    });
    const video = source.screenFile;
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
      spans: source.plan.screen,
      outDir: path.join(dir, 'frames'),
      signal: controller.signal,
      onProgress: (done, total) => this.deps.progress({ runId, stage: 'sampling', done, total }),
    });
    this.deps.progress({ runId, stage: 'filtering', done: 0, total: sampled.frames.length });
    const filtered = filterFrames(sampled.frames);
    const keptIds = new Set(filtered.kept.map(frameId));
    const kept = sampled.frames.filter((f) => keptIds.has(frameId(f)));
    const scenes = groupScenes(kept, sampled.frames, sampled.every);
    const allocation = allocateScoring(scenes.map((s) => ({ number: s.number, size: s.frames.length, seconds: s.seconds })), MAX_FRAMES_TO_SCORE);
    const toScore = framesToScore(scenes, allocation.quota);
    const blurry = filtered.dropped.filter((d) => d.reason === 'blurry').length;
    const repeats = filtered.dropped.filter((d) => d.reason === 'repeat').length;
    const lines = [
      ...source.lines,
      `Sampled ${sampled.frames.length} frames across those stretches (${clock(sampled.seconds)} of the screen recording, between ${clock(sampled.start)} and ${clock(sampled.end)} of it; one every ${sampled.every.toFixed(sampled.every === 1 ? 0 : 1)} s).`,
      `Removed ${repeats} repeated and ${blurry} blurry frames; ${kept.length} kept.`,
      `The kept frames look like ${scenes.length} different scene${scenes.length === 1 ? '' : 's'} (grouped by their colours and layout; a clip that comes back joins its scene).`,
      toScore.length < kept.length
        ? allocation.short
          ? `${toScore.length} of them will be scored (the most one run scores is ${MAX_FRAMES_TO_SCORE}). There are too many scenes for ${SCENE_FLOOR} each, so every scene gets at least one, the longest on screen first.`
          : `${toScore.length} of them will be scored (the most one run scores is ${MAX_FRAMES_TO_SCORE}): up to ${SCENE_FLOOR} from every scene, the rest shared by time on screen.`
        : `All ${kept.length} will be scored.`,
    ];
    log.info(`[ThumbnailLab] ${runId} for ${item.title}: ${lines.join(' ')}`);
    const run: Run = {
      runId, item, source, video, dir, start: sampled.start, end: sampled.end, frames: kept, toScore: new Set(toScore.map(frameId)),
      scenes, sceneOf: new Map(scenes.flatMap((s) => s.frames.map((f) => [frameId(f), s.number] as const))),
      lines, ranked: null, readings: new Map(), flags: new Map(), bestScenes: null, scoring: null, controller: null,
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
          scene: run.sceneOf.get(id)!,
        };
      }),
      toScore: run.frames.map(frameId).filter((id) => run.toScore.has(id)),
      scenes: run.scenes.map((s) => ({
        number: s.number,
        seconds: s.seconds,
        label: sceneLabel(s),
        kept: s.frames.length,
        scoring: s.frames.filter((f) => run.toScore.has(frameId(f))).length,
      })),
      bestScenes: run.bestScenes,
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
      const { ranked, screens } = rankFrames(outcome.scored);
      run.flags = new Map([
        ...screens.map((s) => [s.id, 'screen'] as const),
        ...outcome.unreadable.map((u) => [u.id, 'unreadable'] as const),
      ]);
      run.ranked = ranked;
      const rows = sceneRows(ranked, run.sceneOf, run.scenes.map((s) => s.number));
      run.bestScenes = rows.rows;
      const noRow = rows.empty.length > 0
        ? ` ${rows.empty.length === 1 ? 'Scene' : 'Scenes'} ${rows.empty.join(', ')} ${rows.empty.length === 1 ? 'has' : 'have'} no frame to show (every scored frame was a computer screen or unreadable).`
        : '';
      const unreadable = outcome.unreadable.length > 0 ? ` ${outcome.unreadable.length} frame(s) could not be read and were set aside (${outcome.unreadable.map((u) => `${clock(u.t)}: ${u.reason}`).join('; ')}).` : '';
      run.scoring = {
        server: outcome.server,
        model: outcome.model,
        line: `Scored ${outcome.scored.length} frames on ${outcome.model} on "${outcome.server}" (${outcome.widthBasis}). ${screens.length} were computer screens and are left out.${unreadable}${noRow}`,
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

  private storedNotes(): Record<string, string> {
    const stored = this.deps.store.get(PHOTO_NOTES_STORE_KEY);
    if (stored === undefined || stored === null) return {};
    if (typeof stored !== 'object' || Array.isArray(stored) || Object.values(stored).some((v) => typeof v !== 'string')) {
      throw new Error(`The saved reaction photo notes are not a list of name: note (${JSON.stringify(stored).slice(0, 120)}).`);
    }
    return stored as Record<string, string>;
  }

  /** Each photo's note: Owen's saved one, else the draft (marked), else none. */
  private notesFor(names: readonly string[]): Array<{ name: string; note: string | null; draft: boolean }> {
    const stored = this.storedNotes();
    const drafts = draftNotes();
    return names.map((name) =>
      stored[name] !== undefined ? { name, note: stored[name], draft: false }
      : drafts[name] !== undefined ? { name, note: drafts[name], draft: true }
      : { name, note: null, draft: false });
  }

  /** Save one photo's note (an empty note is saved as empty: the legend then lists the name alone). */
  setPhotoNote(name: string, note: string): void {
    const folder = this.photoFolder();
    if (folder === null) throw new Error('No reaction photos folder is set.');
    if (!listReactionPhotos(folder).some((p) => p.name === name)) throw new Error(`There is no reaction photo "${name}" in ${folder}.`);
    this.deps.store.set(PHOTO_NOTES_STORE_KEY, { ...this.storedNotes(), [name]: note.trim() });
  }

  /** The folder's photos, trimmed, each with a small picture for the picker and its note. */
  photos(): { folder: string | null; photos: Array<{ name: string; preview: string; trim: string | null; note: string | null; draft: boolean }> } {
    const folder = this.photoFolder();
    if (folder === null) return { folder: null, photos: [] };
    const list = listReactionPhotos(folder);
    const notes = this.notesFor(list.map((p) => p.name));
    return {
      folder,
      photos: list.map((p, i) => {
        const trimmed = trimmedPhoto(p);
        return { name: p.name, preview: photoPreview(trimmed), trim: trimmed.note, note: notes[i].note, draft: notes[i].draft };
      }),
    };
  }

  /**
   * The tone, and the photos ranked for each variant from its words (judge.ts), on the
   * `thumbnail_judge` row. The ranking is every photo, in order; nothing is left out.
   */
  async suggest(runId: string, variants: Array<{ letter: string; text: string | null }>): Promise<{ tone: Ranked[]; photos: Record<string, Ranked[]>; line: string }> {
    const run = this.run(runId);
    const folder = this.photoFolder();
    if (folder === null) throw new Error('Choose the reaction photos folder first.');
    const option = this.routed('thumbnail_judge');
    if (option.crucibleModel === null) throw new Error(`The tone and photo row names ${option.label}, which is not a Crucible model.`);
    if (run.item.promptSet === null) throw new Error(`${run.item.title} names no prompt set, so nothing says whose channel it is.`);
    const channel = promptAssets().channel(run.item.promptSet);
    const terms = (channel.brandTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
    if (terms.length === 0) throw new Error(`The prompt set "${channel.name}" declares no brand_terms, so nothing says who its creator is.`);
    const { record } = loadSavedTranscript(this.outputDir(), run.item.sourcePath!);
    const out = await judgeThumbnails({
      deps: this.deps.scorer(),
      jobId: `${runId}-judge-${Date.now()}`,
      model: option.crucibleModel,
      tone: {
        channel: channel.name,
        creator: terms.join(', '),
        hook: run.item.hook,
        description: run.item.description,
        transcript: record.segments.map((s, i) => transcriptLine(srtSeconds(s.start, `caption ${i + 1}`), s.text)),
      },
      photos: this.notesFor(listReactionPhotos(folder).map((p) => p.name)),
      variants,
    });
    const top = out.tone[0];
    const line = `The tone reads as ${top.name} (${Math.round((top.p ?? 0) * 100)}%), on ${out.model} on "${out.server}".`;
    log.info(`[ThumbnailLab] ${runId}: ${line} Photos: ${Object.entries(out.photos).map(([l, r]) => `${l}=${r[0].name}`).join(', ')}`);
    return { tone: out.tone, photos: out.photos, line };
  }

  /** The starting layout of A/B/C from the favourites (combine.ts). */
  combine(fav: Favourites, how: CombineMode, rank: Record<string, readonly string[]> | null) {
    return combine(fav, how, rank);
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
