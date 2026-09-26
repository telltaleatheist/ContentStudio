// electron/services/editor/story-ipc.ts
import { ipcMain, IpcMainInvokeEvent } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';

import { StoryModel, resolveStoryModel } from './story-routing';
import { AIManagerService, AIConfig } from '../metadata/ai-manager.service';
import { crucibleTransport } from '../../crucible/transport';
import { installedLanes } from '../../crucible/lanes';
import type { JobLeases } from '../../crucible/lease';
import { migrateStoredRouting, resolveMetadataRouting, resolveSnapChapterModels } from '../metadata/metadata-routing';
import { chapter } from '../metadata/chaptering/chaptering.service';
import { TITLE_MAX_TOKENS, titleFromParts } from '../metadata/chaptering/summarize';
import { ChapteringError } from '../metadata/chaptering/types';
import type { ChapteringProgress, Granularity } from '../metadata/chaptering/types';
import { CloudPlain, snapTransports, titleChat } from '../metadata/snap-chapters';
import { formatClock } from '../metadata/chaptering/chaptering.service';

/**
 * The editor's Story-analysis channels, in a module of their own rather than inside
 * editor-ipc.ts. Two reasons: editor-ipc.ts imports the app entry (main.ts, for the main
 * window), so nothing in it can be loaded by the plain-Node pure checks; and these handlers
 * are the one part of the editor that decides which model runs, which is exactly what those
 * checks exist to assert (LEDGER #204, #205).
 *
 * STORIES ARE CHAPTERING (LEDGER #199, #208, plan §10.1). Owen: "it's just chapters for a
 * livestream". Two channels, each the snap chaptering service over the editor's segments at ONE
 * grain, fixed by the channel (LEDGER #213: splitting a master livestream is always stories):
 *
 *   'story:analyze-chapters'  `stories`: the whole timeline split into stories (run 1), and a story
 *                             split into several (the Split modal), by 45-second junctions (#212);
 *   'story:chapter-story'     `chapters`: one story's own chapter list (run 2), the subject changes
 *                             that go to YouTube, by outline + assign.
 *
 * `story:suggest-title` titles a story from the chapters the editor already derived inside it,
 * with the same service's `summarize_chapter_parts` (a story is a `stories` chapter; its parts
 * are its chapters). The chapter-splitter analyzer, its five stages and its inline prompts are
 * gone (plan §10.4; Law 2), and so is its "consolidate" switch: the grain says what is detected.
 *
 * THE MODELS: the outline and every decide question on the fixed scorer (CHAPTER_SCORER_MODEL,
 * the 9B, on the selected Crucible server), the titles on the CHAPTERS row of the routing table,
 * resolved per call exactly as a generation run resolves it (story-routing.ts), so a selection
 * changed in Settings takes effect on the next run. A stored selection this build cannot honour
 * throws, naming the entry, before anything runs; so does a snap run with no Crucible server to
 * put its scorer on, whatever the chapters row is (resolveSnapChapterModels).
 *
 * THE RUN: one job's leases (released when it ends, finished, failed or stopped: the server
 * settles its own card, plan 6.5); every local call on its lane, call by call; progress events
 * weighted by work on 'story:analyze-progress'; Stop aborts the in-flight call (and kills a
 * claude -p child) and the run ends as the renderer's stop, never as an error.
 *
 * Exported for tools/routing-publish-checks.js, which registers it against a recording ipcMain
 * and asserts which models each handler resolves; the app registers it through setupEditorIpc.
 */

export interface StoryIpcDeps {
  /**
   * Where the prompt assets live. AIManagerService's constructor loads them whatever the caller
   * intends to ask for, and ipc-handlers.ts is the one place that knows the directory, passed in
   * rather than recomputed here so the two cannot drift (Law 10).
   */
  promptSetsDir: string;
  /** Where a GPU step would run now (lanes.ts `gpuVenue`). A keeper passes its own. */
  venue?: () => { server: string } | { server: null; reason: string };
}

/** The editor's transcript, as the renderer hands it over: timeline seconds, the side each line is. */
export interface Segment {
  text: string;
  startSeconds: number;
  endSeconds: number;
  /** The host's own mic, or the footage he reacts to: the titles read HOST:/CLIP: lines from it. */
  speaker: 'host' | 'clip';
}

/** One chapter (a story at 'stories') in the shape the editor has always read. */
export interface StoryChapter {
  index: number;
  startSeconds: number;
  endSeconds: number;
  /** The model's title; the outline label when the title call had no answer (warned). */
  label: string;
  /** The model's summary: the titling input and the description's chapter prose. */
  detail: string;
  /** Kept for the renderer's shape: snap reads no verbal cue, so it is always false. */
  verbalCue: boolean;
  /** Snap's ad check confirmed this stretch as a plug (a typed signal, Law 10). */
  isAd: boolean;
  /** The finer tier the editor keeps as provisional markers. Snap draws one grain per run: the chapter itself. */
  subChapters: Array<{ startSeconds: number; endSeconds: number; label: string; detail: string }>;
}

/** Thrown when the user stops a run. Distinct from a failure so the UI never shows an error for something the user asked for. */
export class AnalysisCancelledError extends Error {
  constructor() {
    super('Analysis stopped.');
    this.name = 'AnalysisCancelledError';
  }
}


export function setupStoryAnalysisHandlers(store: Store<any>, deps: StoryIpcDeps): void {
  // The single in-flight analysis (a split OR a title). Only one runs at a time (the renderer
  // gates on `analyzing`/`splitRunning`), so one controller is enough. 'story:cancel' aborts it.
  let activeRun: AbortController | null = null;

  // The titling loop's lease on its local model, for 'story:unload-model'. Taken by the first
  // titling call on a local selection and held across the loop (evicting between titles would
  // reload the model every time); a cloud selection has nothing to hold.
  let titleJob: { job: JobLeases; model: string } | null = null;

  const routedModel = (): StoryModel => resolveStoryModel((store as any).get('metadataRouting'));
  const venue = deps.venue ?? (() => installedLanes().gpuVenue());

  /**
   * A manager for the cloud title door only (runPlainRequest: the plain system turn, <think>
   * stripped, claude -p outside Crucible), built without initialize() as `titles:generate-more`
   * builds it: the door prepares the call on the model this run names.
   */
  const cloudDoor = (signal: AbortSignal): { door: CloudPlain; cleanup: () => void } => {
    const aiConfig: AIConfig = { promptSetsDir: deps.promptSetsDir, abortSignal: signal };
    const manager = new AIManagerService(aiConfig);
    return { door: (prompt, model, what, shape) => manager.runPlainRequest(prompt, model, what, shape), cleanup: () => manager.cleanup() };
  };

  // A stop surfaces as the renderer's stop, whatever layer noticed it first.
  const stopOr = (controller: AbortController, err: unknown): unknown =>
    controller.signal.aborted || (err instanceof ChapteringError && err.code === 'cancelled') ? new AnalysisCancelledError() : err;

  // What the routing table currently names for the titles, for the editor's read-only line.
  ipcMain.handle('story:routed-model', async () => {
    const routed = routedModel();
    return { model: routed.model, label: routed.label, kind: routed.kind };
  });

  ipcMain.handle('story:cancel', async () => {
    if (!activeRun) return { stopped: false };
    log.info('[Story] cancel requested — aborting the in-flight analysis');
    activeRun.abort();
    return { stopped: true };
  });

  // The channel says the grain; a payload that names one is a caller written before #213, refused.
  const segmentsOf = (channel: string, payload: unknown): Segment[] => {
    const { segments } = (payload || {}) as { segments?: Segment[] };
    if (payload && typeof payload === 'object' && 'grain' in payload) {
      throw new Error(`${channel} takes no grain: the channel is the grain (LEDGER #213). Got ${JSON.stringify((payload as { grain: unknown }).grain)}.`);
    }
    if (!Array.isArray(segments) || segments.length === 0) {
      throw new Error('No transcript segments provided for chapter analysis.');
    }
    return segments;
  };

  // Split a span into stories: the whole timeline, or one story in several. Always `stories` (#213).
  ipcMain.handle('story:analyze-chapters', async (event, payload: { segments: Segment[] }) =>
    analyze(event, segmentsOf('story:analyze-chapters', payload), 'stories'));

  // One story's own chapter list, the subject changes that go to YouTube. Always `chapters`.
  ipcMain.handle('story:chapter-story', async (event, payload: { segments: Segment[] }) =>
    analyze(event, segmentsOf('story:chapter-story', payload), 'chapters'));

  async function analyze(event: IpcMainInvokeEvent, segments: Segment[], grain: Granularity) {
    const models = resolveSnapChapterModels(
      resolveMetadataRouting(migrateStoredRouting((store as any).get('metadataRouting')).selections),
      venue(),
    );
    log.info(
      `[Story] ${grain} analysis on snap: outline and decide on ${models.scorer.model} on "${models.scorer.server}", ` +
        `titles on the chapters routing, ${models.titles.model} (${models.titles.label})`,
    );
    const controller = new AbortController();
    activeRun = controller;
    const job = crucibleTransport().job(`story ${grain} analysis`);
    const cloud = models.titles.kind === 'cloud' ? cloudDoor(controller.signal) : null;
    try {
      const transports = snapTransports({
        models,
        job,
        trace: null,
        ...(cloud ? { cloudPlain: cloud.door } : {}),
        signal: controller.signal,
        laneName: `story ${grain} analysis`,
      });
      // The service starts its first chapter at 0 (YouTube's rule); a span starts where its
      // first line does, so the times are rebased onto it and back.
      const t0 = segments[0].startSeconds;
      const captions = segments.map((s) => ({ start: s.startSeconds - t0, end: s.endSeconds - t0, text: s.text, speaker: s.speaker }));
      const onProgress = (p: ChapteringProgress) => {
        if (!event.sender.isDestroyed()) event.sender.send('story:analyze-progress', { phase: p.phase, done: p.done, total: p.total, fraction: p.fraction });
      };
      const result = await chapter(captions, {
        granularity: grain,
        chat: transports.chat,
        decide: transports.decide,
        totalSeconds: segments[segments.length - 1].endSeconds - t0,
        signal: controller.signal,
        onProgress,
      });
      const chapters: StoryChapter[] = result.chapters.map((c, i) => {
        const one = { startSeconds: c.startSec + t0, endSeconds: c.endSec + t0, label: c.title || c.label, detail: c.summary };
        return { index: i, ...one, verbalCue: false, isAd: c.isAd, subChapters: [one] };
      });
      return { chapters, warnings: result.stats.warnings };
    } catch (err) {
      throw stopOr(controller, err);
    } finally {
      if (activeRun === controller) activeRun = null;
      cloud?.cleanup();
      // Released on a stop too: a stopped run has no more claim on the card than a finished one.
      const lost = await job.releaseAll();
      for (const line of lost) log.error(`[Story] the analysis lost its lease on ${line} before it ended`);
    }
  }

  // Title one story from the chapters derived inside it: `summarize_chapter_parts` on the
  // chapters row, thinking ON (LEDGER #208). NOT released afterwards: titling runs once per story
  // in a tight loop; the renderer releases once when its loop ends via 'story:unload-model'.
  ipcMain.handle(
    'story:suggest-title',
    async (_event, payload: { name?: string; chapters: Array<{ label: string; detail?: string; startSeconds: number; endSeconds: number }> }) => {
      const parts = (payload?.chapters || []).filter((c) => c && typeof c.label === 'string' && c.label.trim().length > 0);
      if (parts.length === 0) throw new Error('This story has nothing to title — no chapters with a label.');
      const routed = routedModel();
      const controller = new AbortController();
      activeRun = controller;
      if (routed.kind === 'local' && titleJob?.model !== routed.model) {
        // A new loop, or the routing changed mid-loop: the old hold goes, a new one is taken.
        if (titleJob !== null) await titleJob.job.releaseAll();
        titleJob = { job: crucibleTransport().job('story title suggestions'), model: routed.model };
      }
      const cloud = routed.kind === 'cloud' ? cloudDoor(controller.signal) : null;
      const warnings: string[] = [];
      try {
        const chat = titleChat({
          titles: routed.option,
          ...(routed.kind === 'local' ? { job: titleJob!.job } : {}),
          trace: null,
          ...(cloud ? { cloudPlain: cloud.door } : {}),
          signal: controller.signal,
          laneName: 'story title',
        });
        const name = (payload.name || '').trim() || 'this story';
        const answer = await titleFromParts(
          chat,
          { number: 1, videoTitle: name, previousDetail: '', previousTitles: [], what: `the title of ${name}` },
          parts.map((c) => ({ clock: `${formatClock(c.startSeconds)}-${formatClock(c.endSeconds)}`, title: c.label.trim(), summary: (c.detail || '').trim() })),
          (w) => warnings.push(w),
          { thinking: true, maxTokens: TITLE_MAX_TOKENS },
          [],
          controller.signal,
        );
        for (const w of warnings) log.warn(`[Story] ${w}`);
        if (!answer.title) throw new Error(`The model did not name ${name}${warnings.length ? `: ${warnings.join('; ')}` : ''}`);
        return { title: answer.title };
      } catch (err) {
        throw stopOr(controller, err);
      } finally {
        if (activeRun === controller) activeRun = null;
        cloud?.cleanup();
        // Held however the call ended: the renderer's unload at the end of its loop releases it.
      }
    }
  );

  // Release the lease the titling loop held (end of the loop, or a stop): the server settles its
  // own card. Never throws: a failure to release is housekeeping (the lease expires on its own).
  ipcMain.handle('story:unload-model', async () => {
    const held = titleJob;
    titleJob = null;
    if (!held) return { ok: true, released: null };
    const lost = await held.job.releaseAll();
    for (const line of lost) log.error(`[Story] the titling loop lost its lease on ${line} before it ended`);
    return { ok: true, released: held.model };
  });
}
