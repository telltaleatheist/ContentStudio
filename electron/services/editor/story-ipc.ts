// electron/services/editor/story-ipc.ts
import { ipcMain } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';

import { AnalysisCancelledError, analyzeChapters, suggestTitle, Segment } from './chapter-splitter';
import { StoryModel, resolveStoryModel } from './story-routing';
import { AIManagerService, AIConfig } from '../metadata/ai-manager.service';
import { crucibleTransport } from '../../crucible/transport';
import { isCrucibleCallError } from '../../crucible/errors';
import type { JobLeases } from '../../crucible/lease';

/**
 * The editor's Story-analysis channels, in a module of their own rather than inside
 * editor-ipc.ts. Two reasons: editor-ipc.ts imports the app entry (main.ts, for the main
 * window), so nothing in it can be loaded by the plain-Node pure checks; and these handlers
 * are the one part of the editor that decides which model runs, which is exactly what those
 * checks exist to assert (LEDGER #204, #205).
 */

/**
 * What the story handlers need from the host that is not the store: where the prompt assets
 * live. AIManagerService's constructor loads them whatever the caller intends to ask for, and
 * ipc-handlers.ts is the one place that knows the directory — passed in rather than recomputed
 * here, so the two cannot drift (Law 10).
 */
export interface StoryIpcDeps {
  promptSetsDir: string;
}

/**
 * A story prompt the routed LOCAL model cannot read whole. The Crucible door refuses a prompt
 * over the loaded context BEFORE sending (`over_context`, plan 6.1), which is chapter-splitter's
 * own contract too: refuse rather than summarize a truncated chapter. Carried out as the abort
 * signal's REASON, because the splitter's askJson turns any other thrown error into
 * "unparseable, try again, then use the opening words" (Law 1). Read by its typed code, never
 * its sentence (Law 10).
 */
export class StoryPromptTooLongError extends Error {
  constructor(refusal: string, what: string) {
    super(
      `The ${what} prompt does not fit the routed model whole (${refusal}). Refusing rather than ` +
        `analyzing a truncated chapter: split the story into shorter stories, or route chapters to claude -p.`
    );
    this.name = 'StoryPromptTooLongError';
  }
}

/**
 * The shape of every story call (plan 6.3's story-title row): thinking OFF, a 2048-token answer.
 * These are short one-question JSON calls; a thinking pass at this budget returns no answer.
 * The local window is the 32768 tokens makeOllamaRequest loaded at, which is the splitter's own
 * ceiling (CHAPTER_CTX_MAX), so no call it sized smaller gets less.
 */
const STORY_MAX_TOKENS = 2048;
const STORY_LOAD_CONTEXT = 32768;

/**
 * Story-analysis handlers: chapter splitting + title suggestions for Story Mode. All
 * synchronous request/response — the renderer holds the transcript and passes the relevant
 * segments in; the main process only runs the model calls + phrase→timestamp mapping.
 * Failures reject with the real error (model unreachable, empty response, unparseable) —
 * never a fabricated result.
 *
 * THE MODEL IS THE CHAPTERS ROW OF THE METADATA ROUTING TABLE (LEDGER #204, #205). The
 * analyzer used to run on a picker of its own — whatever Ollama had pulled, chosen in the
 * editor window — which made it the one model call in the app the routing table did not
 * choose. Owen: "it should never call something i didnt expect it to call". It is resolved
 * per call through story-routing.ts, with the same three functions the transcript episode
 * splitter uses, and every call goes through AIManagerService.runPlainRequest, the door every
 * routed field call uses: a `claude-cli:` selection goes to `claude -p`, anything else to the
 * Crucible door (P2), through the same single-slot AI queue and the same cancel path as a
 * generation run.
 *
 * WHAT THAT COSTS, KNOWINGLY. chapter-splitter.ts is many small single-question calls: about
 * 40 for a 12-minute video, about 390 for a 2-hour stream. On claude -p each one is a separate
 * process launch. Owen chose this with the count in front of him (#205), until P8 replaces
 * the analyzer with snap chaptering at broad grain. The splitter's per-call hints —
 * temperature 0, `format: "json"`, num_predict, num_ctx — do not travel through this door:
 * every story call states the one shape above (STORY_MAX_TOKENS, thinking off), no sampling
 * parameter crosses (the 2026-08-24 ruling every other call runs under), and the splitter's
 * parser reads the first JSON object out of a plain answer either way. A local route is held
 * under a lease for the run (the analysis) or for the titling loop, and released where the old
 * code unloaded the model: the server settles its own card (plan 6.5).
 *
 * Exported for tools/routing-publish-checks.js, which registers it against a recording ipcMain
 * and asserts which model each handler resolves; the app registers it through setupEditorIpc.
 */
export function setupStoryAnalysisHandlers(store: Store<any>, deps: StoryIpcDeps): void {
  // The single in-flight analysis (chapter split OR title suggestion). Only one runs at a time —
  // the renderer gates on `analyzing`/`splitRunning` — so one controller is enough. 'story:cancel'
  // aborts it: AIManagerService hands the signal to every transport (the HTTP request is
  // dropped, the claude -p child is killed), and chapter-splitter unwinds on its next check.
  let activeRun: AbortController | null = null;

  // The titling loop's lease on its local model, for 'story:unload-model'. Taken by the first
  // titling call on a local selection and held across the loop (evicting between titles would
  // reload the model every time); a cloud selection has nothing to hold.
  let titleJob: { job: JobLeases; model: string } | null = null;

  // Resolved on EVERY call, not once at registration: a selection changed in Settings →
  // Routing takes effect on the next run, exactly as it does for a generation job. A stored
  // selection this build cannot honour throws here, naming the entry, before anything runs.
  const routedModel = (): StoryModel => resolveStoryModel((store as any).get('metadataRouting'));

  /**
   * Built for ONE analysis, the way `titles:generate-more` builds its manager: without
   * initialize() — there is no prompt set to load and nothing to probe; the door prepares the
   * call on the model this run names and refuses by name what it cannot run. `promptSetsDir` is
   * still required because the constructor loads the prompt assets whatever the caller asks for.
   */
  const storyManager = (signal: AbortSignal, jobLeases?: JobLeases): AIManagerService => {
    const aiConfig: AIConfig = {
      promptSetsDir: deps.promptSetsDir,
      abortSignal: signal,
      ...(jobLeases === undefined ? {} : { jobLeases }),
    };
    return new AIManagerService(aiConfig);
  };

  /**
   * chapter-splitter's `generate` callback over runPlainRequest. The splitter's per-call
   * options are accepted and not forwarded (see the header). A cancelled request's error is
   * not what says it was a stop; the signal is, and it is rethrown as the splitter's own cancel
   * type so both handlers surface "Analysis stopped." to the renderer rather than a transport
   * message. A local prompt the door refuses as over the loaded context aborts the run with a
   * StoryPromptTooLongError as the reason, which `refusalOr` surfaces.
   */
  const generateOn = (aiManager: AIManagerService, routed: StoryModel, controller: AbortController, what: string) =>
    async (prompt: string): Promise<string> => {
      let text: string | null;
      try {
        text = await aiManager.runPlainRequest(
          prompt,
          routed.model,
          what,
          routed.kind === 'local'
            ? { thinking: false, maxTokens: STORY_MAX_TOKENS, loadContext: STORY_LOAD_CONTEXT }
            : { thinking: false }
        );
      } catch (err) {
        if (isCrucibleCallError(err, 'over_context')) {
          const refusal = new StoryPromptTooLongError(err.message, what);
          controller.abort(refusal);
          throw refusal;
        }
        if (controller.signal.aborted) throw new AnalysisCancelledError();
        throw err;
      }
      if (controller.signal.aborted) throw new AnalysisCancelledError();
      if (text === null) throw new Error(`"${routed.model}" answered ${what} with nothing`);
      return text;
    };

  // A run aborted by a refusal ends as the splitter's cancel; the refusal is the real reason.
  const refusalOr = (controller: AbortController, err: unknown): unknown =>
    controller.signal.reason instanceof StoryPromptTooLongError ? controller.signal.reason : err;

  // What the routing table currently names, for the editor's read-only line ("Stories run on
  // <label>"). Throws when the stored routing cannot be resolved — the same refusal the
  // analysis itself would make, shown before the operator presses anything.
  ipcMain.handle('story:routed-model', async () => {
    const routed = routedModel();
    return { model: routed.model, label: routed.label, kind: routed.kind };
  });

  // Stop whatever analysis is running. Safe to call when nothing is — returns `stopped: false`
  // rather than throwing, so a stale click from a closed dialog is harmless.
  ipcMain.handle('story:cancel', async () => {
    if (!activeRun) return { stopped: false };
    log.info('[Story] cancel requested — aborting the in-flight analysis');
    activeRun.abort();
    return { stopped: true };
  });

  // Split a span of transcript into consecutive subject chapters. The pipeline is many small
  // single-question calls (~40 for a 12-minute video, ~390 for a 2-hour livestream), so step
  // progress is streamed back to the calling renderer on 'story:analyze-progress'. A local
  // model is held under one lease for the run and released afterwards — a 27B pinned after a
  // 25-minute run is memory nobody asked for.
  ipcMain.handle(
    'story:analyze-chapters',
    async (event, payload: { segments: Segment[]; consolidate?: boolean }) => {
      const { segments, consolidate } = payload || ({} as any);
      if (!Array.isArray(segments) || segments.length === 0) {
        throw new Error('No transcript segments provided for chapter analysis.');
      }
      const routed = routedModel();
      log.info(`[Story] chapter analysis runs on the chapters routing: ${routed.model} (${routed.label})`);
      const controller = new AbortController();
      activeRun = controller;
      const job = routed.kind === 'local' ? crucibleTransport().job('story chapter analysis') : undefined;
      const aiManager = storyManager(controller.signal, job);
      const generate = generateOn(aiManager, routed, controller, 'story chapter analysis');
      const onProgress = (p: { phase: string; done: number; total: number }) => {
        if (!event.sender.isDestroyed()) event.sender.send('story:analyze-progress', p);
      };
      try {
        // `consolidate` is forwarded, NOT defaulted here — chapter-splitter owns the default (true).
        // The renderer sends false when the span is a story it has already defined, where stage 5
        // can only produce false merges. Defaulting in two places is how the two drift apart.
        const chapters = await analyzeChapters(
          segments, routed.model, generate, onProgress, controller.signal, { consolidate }
        );
        return { chapters };
      } catch (err) {
        throw refusalOr(controller, err);
      } finally {
        if (activeRun === controller) activeRun = null;
        aiManager.cleanup();
        // Released on a stop too — a stopped run has no more claim on the card than a finished
        // one, and stopping is usually how a user reacts to the machine being busy. Only a local
        // selection holds a lease; claude -p and Anthropic hold nothing. The release goes through
        // the same object a generation job releases its leases with (the unload it replaces).
        if (job !== undefined) {
          const lost = await job.releaseAll();
          for (const line of lost) log.error(`[Story] the analysis lost its lease on ${line} before it ended`);
        }
      }
    }
  );

  // Suggest a single title for a story's transcript text. NOT unloaded afterwards — titling runs
  // once per story in a tight loop, and evicting between them would reload the model every time.
  // The renderer unloads once when its loop ends (or is stopped) via 'story:unload-model'.
  ipcMain.handle(
    'story:suggest-title',
    // `text` is either transcript text or a story's chapter labels. A subject list is the better
    // input — no truncation, and it is the shape the eventual titling adapter conditions on — so
    // the type must admit it rather than let an array cross a `string` boundary unremarked.
    async (_event, payload: { text: string | string[] }) => {
      const { text } = payload || ({} as any);
      const routed = routedModel();
      const controller = new AbortController();
      activeRun = controller;
      if (routed.kind === 'local' && titleJob?.model !== routed.model) {
        // A new loop, or the routing changed mid-loop: the old hold goes, a new one is taken.
        if (titleJob !== null) await titleJob.job.releaseAll();
        titleJob = { job: crucibleTransport().job('story title suggestions'), model: routed.model };
      }
      const aiManager = storyManager(controller.signal, routed.kind === 'local' ? titleJob!.job : undefined);
      const generate = generateOn(aiManager, routed, controller, 'story title suggestion');
      try {
        const title = await suggestTitle(text, generate);
        return { title };
      } catch (err) {
        throw refusalOr(controller, err);
      } finally {
        if (activeRun === controller) activeRun = null;
        aiManager.cleanup();
        // Held however the call ended: a failed or stopped titling call has still taken the
        // lease, and the renderer's unload at the end of its loop is what releases it.
      }
    }
  );

  // Release the lease the titling loop held (end of the loop, or a stop): the old unload,
  // now a lease release (plan 6.5), and the server settles its own card. Nothing to do after a
  // cloud run, or when no titling call has run. Never throws — releaseAll warns and carries on,
  // because a failure to release is housekeeping (the lease expires on its own).
  ipcMain.handle('story:unload-model', async () => {
    const held = titleJob;
    titleJob = null;
    if (!held) return { ok: true, released: null };
    const lost = await held.job.releaseAll();
    for (const line of lost) log.error(`[Story] the titling loop lost its lease on ${line} before it ended`);
    return { ok: true, released: held.model };
  });
}
