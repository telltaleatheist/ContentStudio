// electron/services/editor/story-ipc.ts
import { ipcMain, app } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';
import axios from 'axios';

import { AnalysisCancelledError, analyzeChapters, suggestTitle, Segment } from './chapter-splitter';
import { StoryModel, resolveStoryModel } from './story-routing';
import { AIManagerService, AIConfig } from '../metadata/ai-manager.service';
import { unloadOllamaModels } from '../metadata/ollama-json';

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
 * A story prompt the routed LOCAL model cannot read whole. makeOllamaRequest middle-truncates
 * anything over AIManagerService.OLLAMA_MAX_PROMPT_CHARS and only warns; chapter-splitter's own
 * contract is to refuse rather than summarize a truncated chapter (chapterNumCtx). Its ceiling
 * (32768 tokens, about 125k characters) sits above the transport's (about 98k), so without this
 * the move onto the shared door would have brought back the truncation the splitter refuses.
 * Carried out as the abort signal's REASON, because the splitter's askJson turns any other
 * thrown error into "unparseable, try again, then use the opening words" (Law 1).
 */
export class StoryPromptTooLongError extends Error {
  constructor(chars: number, limit: number, model: string, what: string) {
    super(
      `The ${what} prompt is ${chars} characters, and "${model}" is sent at most ${limit} whole ` +
        `(a longer prompt would be cut in the middle). Refusing rather than analyzing a truncated ` +
        `chapter: split the story into shorter stories, or route chapters to claude -p.`
    );
    this.name = 'StoryPromptTooLongError';
  }
}

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
 * routed field call uses: a `claude-cli:` selection goes to `claude -p`, a local selection
 * goes to Ollama through the same client, the same single-slot AI queue and the same cancel
 * path as a generation run.
 *
 * WHAT THAT COSTS, KNOWINGLY. chapter-splitter.ts is many small single-question calls: about
 * 40 for a 12-minute video, about 390 for a 2-hour stream. On claude -p each one is a separate
 * process launch. Owen chose this with the count in front of him (#205), until P8 replaces
 * the analyzer with snap chaptering at broad grain. The splitter's per-call hints —
 * temperature 0, `format: "json"`, num_predict, num_ctx — do not travel through this door:
 * runPlainRequest sends provider defaults, per the 2026-08-24 no-sampling-parameters ruling
 * every other call runs under, and the splitter's parser reads the first JSON object out of a
 * plain answer either way. On a local route makeOllamaRequest loads the model at a fixed
 * 32768-token context, which is the splitter's own ceiling (CHAPTER_CTX_MAX), so no call it
 * would have sized smaller gets less; the character ceiling below that is enforced here
 * (StoryPromptTooLongError). The pipeline and its prompts are otherwise untouched; only the
 * transport changed.
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

  // The local model the last titling call left resident, for 'story:unload-model'. Set only
  // for a local selection: a cloud selection has nothing resident and nothing to release.
  let resident: { host: string; model: string } | null = null;

  const ollamaHost = (): string => String((store as any).get('ollamaHost') || 'http://localhost:11434');

  // Resolved on EVERY call, not once at registration: a selection changed in Settings →
  // Routing takes effect on the next run, exactly as it does for a generation job. A stored
  // selection this build cannot honour throws here, naming the entry, before anything runs.
  const routedModel = (): StoryModel => resolveStoryModel((store as any).get('metadataRouting'));

  /**
   * Built for ONE analysis, the way `titles:generate-more` builds its manager: without
   * initialize() — there is no prompt set to load and no connection to probe; the transport
   * for the model this run names is prepared on first use by ensureProviderReady, which names
   * a missing key rather than substituting a provider that has one. `promptSetsDir` is still
   * required because the constructor loads the prompt assets whatever the caller asks for.
   */
  const storyManager = (signal: AbortSignal): AIManagerService => {
    const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
    const apiKeys: any = fs.existsSync(apiKeysPath) ? JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8')) : {};
    const aiConfig: AIConfig = {
      provider: 'claude',
      host: ollamaHost(),
      cloudApiKeys: { claude: apiKeys.claudeApiKey, openai: apiKeys.openaiApiKey },
      promptSetsDir: deps.promptSetsDir,
      abortSignal: signal,
    };
    return new AIManagerService(aiConfig);
  };

  /**
   * chapter-splitter's `generate` callback over runPlainRequest. The splitter's per-call
   * options are accepted and not forwarded (see the header). A cancelled request comes back
   * through the AI queue as a plain Error; the signal is what says it was a stop, and it is
   * rethrown as the splitter's own cancel type so both handlers surface "Analysis stopped."
   * to the renderer rather than a transport message. A local prompt too long to send whole
   * aborts the run with a StoryPromptTooLongError as the reason, which `refusalOr` surfaces.
   */
  const generateOn = (aiManager: AIManagerService, routed: StoryModel, controller: AbortController, what: string) =>
    async (prompt: string): Promise<string> => {
      const limit = AIManagerService.OLLAMA_MAX_PROMPT_CHARS;
      if (routed.kind === 'local' && prompt.length > limit) {
        const refusal = new StoryPromptTooLongError(prompt.length, limit, routed.model, what);
        controller.abort(refusal);
        throw refusal;
      }
      let text: string | null;
      try {
        text = await aiManager.runPlainRequest(prompt, routed.model, what);
      } catch (err) {
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
  // model is unloaded afterwards — a 27B left resident after a 25-minute run is memory nobody
  // asked for.
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
      const aiManager = storyManager(controller.signal);
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
        // Unloaded on a stop too — a stopped run has no more claim on the memory than a finished
        // one, and stopping is usually how a user reacts to the machine being busy. Only a local
        // selection has anything resident; claude -p and the API leave nothing to unload. The
        // release goes through the same call a generation job releases its models with.
        if (routed.kind === 'local') {
          await unloadOllamaModels(axios.create({ baseURL: ollamaHost() }), [routed.option.model], '[Story]');
          resident = null;
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
      const aiManager = storyManager(controller.signal);
      const generate = generateOn(aiManager, routed, controller, 'story title suggestion');
      try {
        const title = await suggestTitle(text, generate);
        return { title };
      } catch (err) {
        throw refusalOr(controller, err);
      } finally {
        if (activeRun === controller) activeRun = null;
        aiManager.cleanup();
        // Recorded however the call ended: a failed or stopped titling call has still loaded
        // the model, and the renderer's unload at the end of its loop is what releases it.
        if (routed.kind === 'local') resident = { host: ollamaHost(), model: routed.option.model };
      }
    }
  );

  // Evict the local model the titling loop left resident (end of the loop, or a stop). Nothing
  // to do after a cloud run, or when no titling call has run. Never throws — unloadOllamaModels
  // warns and carries on, because a failure to release is housekeeping.
  ipcMain.handle('story:unload-model', async () => {
    const held = resident;
    resident = null;
    if (!held) return { ok: true, released: null };
    await unloadOllamaModels(axios.create({ baseURL: held.host }), [held.model], '[Story]');
    return { ok: true, released: held.model };
  });
}
