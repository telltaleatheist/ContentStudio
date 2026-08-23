/**
 * Metadata Generator Service
 * Main orchestrator for metadata generation workflow
 * Replaces the Python metadata_generator.py
 */

import { AIManagerService, AIConfig, MetadataResult } from './ai-manager.service';
import { WhisperService } from './whisper.service';
import { InputHandlerService, ContentItem } from './input-handler.service';
import { Chapter } from './chapter-generator.service';
import { ChapterPipelineResult, MIN_CHAPTERS } from './chapter-transcript';
import { WholeTranscriptChapterService } from './chapter-whole-transcript.service';
import { OutputHandlerService } from './output-handler.service';
import { ContentDeclaration, ContentOrigin, ItemProvenance, ItemSource, SavedTranscriptReuse, sourceKeyOf } from './item-identity';
import { resolveOutputDirectory } from './saved-transcript.service';
import { stripSpeakerPrefixes } from './transcript-import.service';
import { SpeakerTagger, announceSpeakerTagging, resolveSpeakerTagging } from './speaker-tagging.service';
import { getRuntimePaths } from '../../lib/bridges';
import {
  MetadataTaskRun,
  buildTaskPromptsForDisplay,
  planMetadataUnits,
  runMetadataTasks,
} from './metadata-tasks';
import {
  KEY_PHRASE_EMBEDDING_MODEL,
  MetadataRoutingSelections,
  MetadataRoutingTaskId,
  ResolvedMetadataRouting,
  SUMMARIZATION_MODEL,
  resolveChapterModelOption,
  resolveMetadataRouting,
  routingOption,
} from './metadata-routing';
import type { ModelRosterEntry } from './metadata-tasks';
import { JobModelLifecycle } from './model-lifecycle';
import { excludePromoChapters } from './promo-chapters';
import { topEntities, transcriptCasing } from './entity-extraction';
import { rankKeyPhrases } from './key-phrases';
import axios from 'axios';
import { JobCancelledError } from './cancellation';
import type { TranscriptRef } from '../publish/publish-types';
import { queueAITask } from '../queue-manager.service';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';

/**
 * How many proper nouns and key phrases the description, tags and hashtags get to draw on.
 *
 * Not a cap on what the video contains — a cap on what any one call is asked to hold in its
 * head. Twelve names is more than a 300-word body can name; forty phrases is more than a
 * 400-character tag list can spend. Both are generous on purpose so the assembly rules
 * downstream have something to choose from, and both are far short of "everything".
 */
const ENTITY_POOL_SIZE = 12;
const KEY_PHRASE_POOL_SIZE = 40;

export interface GenerationParams {
  inputs: string[];
  mode?: 'individual' | 'compilation';
  aiProvider: 'ollama' | 'openai' | 'claude';
  aiModel?: string; // Legacy single model (backward compatibility)
  summarizationModel?: string; // Model for fast summarization
  metadataModel?: string; // Model for final metadata generation
  aiApiKey?: string;
  /**
   * Keys for the cloud providers the ROUTING may reach, which is not necessarily the
   * provider `aiApiKey` belongs to (see AIConfig.cloudApiKeys).
   */
  cloudApiKeys?: { claude?: string; openai?: string };
  aiHost?: string;
  outputPath?: string;
  promptSet?: string;
  promptSetsDir?: string;
  /**
   * REQUIRED. The renderer's queue id, threaded end to end: it names the report file, keys
   * the publish selections, and registers cancellation. Optional here previously, which let
   * `initializeJob` mint a replacement nobody else could match.
   */
  jobId: string;
  jobName?: string;
  // Pre-resolved "CHANNEL PERFORMANCE DATA" block from the analytics feedback
  // loop (appended to the metadata prompt); undefined = omit (expected state).
  insightsBlock?: string;
  /**
   * The operator's Phase-2 link decision per input, keyed by the input's absolute path.
   * A `TranscriptRef` means "the content fields should
   * come from this editor story"; an explicit `null` means "final export only", which is
   * a declared mode rather than a default (spec §3.2).
   *
   * CONSUMED BY THE INPUT STAGE, not here: the input handler resolves the ref into
   * `ContentItem.contentSource`, and this service reads that through `contentTextOf`.
   * The chapter pipeline still reads `item.srtSegments` only, which is the final
   * export's Whisper output on every path.
   */
  inputTranscripts?: { [key: string]: TranscriptRef | null };
  /**
   * Per-task model routing, as stored in the `metadataRouting` setting (taskId ->
   * optionId, see metadata-routing.ts). Resolved against the registry here, so an absent
   * key means "the shipped defaults" and a bad one fails the job naming the task.
   *
   * This is the ONLY input that decides which model writes which field — and, since
   * 2026-08-23, the chapter model with them: chapters are still not a routed task, but they
   * run on the writing-model slot's projection of this table (resolveChapterModelOption),
   * falling back to CHAPTER_PIPELINE_MODELS when the slot's tasks disagree.
   */
  metadataRouting?: MetadataRoutingSelections;
  /** Chapter context-window FLOOR. One value for the whole run (Ollama reloads on change). */
  chapterNumCtx?: number;
  /**
   * Chapters already produced for these sources (keyed by source label), so a run
   * doesn't repeat the pipeline. This is what makes "Show prompt" honest: that flow
   * has to run the chapters to assemble the real prompt, and "Send to AI" then reuses
   * the SAME chapters rather than re-deriving a possibly different set.
   */
  preComputedChapters?: { [sourceLabel: string]: ChapterPipelineResult };
  /**
   * The inputs that run from their SAVED Whisper transcript instead of being transcribed
   * again, keyed by absolute path and only ever `true` (saved-transcript.service.ts).
   *
   * CONSUMED BY THE INPUT STAGE, like `inputTranscripts`: the input handler reads the
   * record, or fails that item naming the file. An absent key is the default — transcribe
   * it — and there is no third state, because reuse is something the operator ticks.
   */
  useSavedTranscripts?: { [key: string]: boolean };
  /**
   * The operator's voice-enrollment recording (`speakerEnrollmentAudio`), read from the settings
   * by the IPC layer and threaded in as a value.
   *
   * A VALUE ON THE RUN, not a setting the input stage reads for itself, so that the whole queue
   * is tagged the same way: the mode is resolved once from this before any item starts, and an
   * operator who opens Settings mid-run does not end up with half a job attributed and half not.
   * Absent or blank is the untagged MODE, which is what every run did before this existed.
   */
  speakerEnrollmentAudio?: string;
  inputNotes?: { [key: string]: string };
  preTranscribedContent?: ContentItem[]; // Pre-transcribed content from pipeline (skips transcription phase)
  inputWarnings?: string[]; // Input-stage failures from the pipeline (surfaced in result.warnings)
  showPrompt?: boolean; // "Show prompt" flow: assemble the prompt(s) and STOP — no metadata AI call, job, or output
  progressCallback?: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void;
  cancelCallback?: () => boolean; // Returns true if job should be cancelled
  /**
   * Fired the moment cancellation is requested, so a model call ALREADY IN FLIGHT is
   * aborted instead of running to completion and being billed.
   *
   * `cancelCallback` cannot do that job: it is polled, and a poll between stages says
   * nothing about the 28k-token call running inside one. This is threaded into every
   * provider client the run reaches — the AI manager, the local adapters and the
   * chapter pipeline.
   */
  cancelSignal?: AbortSignal;
}

export interface GenerationResult {
  success: boolean;
  metadata?: MetadataResult[];
  output_files?: string[];
  txt_files?: string[];
  json_file?: string;
  job_id?: string;
  processing_time?: number;
  error?: string;
  warnings?: string[]; // Per-item / partial-failure messages surfaced to the user
  prompts?: string[]; // "Show prompt" flow: the assembled prompt(s), one per item (compilation = single)
  /** "Show prompt" flow: chapters computed while assembling, to be handed back on send. */
  computedChapters?: { [sourceLabel: string]: ChapterPipelineResult };
}

/**
 * What the chapter step produced for one item.
 *
 * `chaptersSkipped` is set on EVERY path that leaves a timestamped item without a published
 * chapter list, and it is what makes that visible in the saved report rather than only in
 * the run's warnings. Absent when the input had no timestamped transcript (a text subject,
 * a plain transcript file) — chapters don't apply there, so a report with no chapters and
 * no explanation is correct in that case. Chapters are not a user option: since 2026-08-22
 * every item with SRT segments gets them, whatever the prompt set.
 */
interface ChapterOutcome {
  chapters?: Chapter[];
  excludedChapters?: Chapter[];
  subjects?: string[];
  details?: string[];
  chaptersSkipped?: { outcome: 'failed' | 'skipped'; reason: string };
}

export class MetadataGeneratorService {
  /**
   * Generate metadata for inputs
   */
  static async generate(params: GenerationParams): Promise<GenerationResult> {
    const startTime = Date.now();

    // Hoisted out of the try so the SINGLE cancellation exit in the catch below can mark
    // the job 'cancelled' whichever stage threw. Undefined until the job is initialized
    // (the show-prompt flow never initializes one).
    let outputHandler: OutputHandlerService | undefined;
    let jobId: string | undefined;

    /**
     * THIS JOB's model residence: one object for the whole job, released once in the finally
     * below.
     *
     * Every stage used to release its own model as it finished — the chapter pipeline, then
     * each field unit, then the description unit — and the next stage, usually on the SAME
     * model, re-streamed ~17GB of weights into unified memory and froze the operator's machine
     * for the length of the load. The stages now DECLARE what they made resident here and
     * nothing releases anything until the job is over, which is what the 10-minute keep-alive
     * in ollama-json.ts was always for. It also carries the num_ctx ratchet, so two stages
     * sharing a model cannot reload it by sizing their windows independently.
     */
    const lifecycle = new JobModelLifecycle();

    console.log('[MetadataGenerator] Starting generation...');
    console.log('[MetadataGenerator] Inputs:', params.inputs.length);
    console.log('[MetadataGenerator] AI Provider:', params.aiProvider);
    console.log('[MetadataGenerator] Prompt Set:', params.promptSet || 'default');

    try {
      // Initialize services
      log.info('[MetadataGenerator] Initializing services...');
      log.info('[MetadataGenerator] Creating WhisperService...');
      const whisperService = new WhisperService();
      log.info('[MetadataGenerator] WhisperService created successfully');

      // Resolved once, up here, because two things need the SAME directory: the saved
      // transcripts the input stage reads and writes, and the job report written further
      // down. `outputPath` below is this value.
      const runOutputDir = resolveOutputDirectory(params.outputPath);

      // Speaker tagging, decided ONCE and announced once — in the calls that are the ones doing
      // the transcribing.
      //
      // ONLY THOSE. The ordinary route into this service is ipc-handlers' pipeline, which
      // transcribes on its own side and arrives here with `preTranscribedContent` whose segments
      // are already tagged; it resolved the mode before it started. Resolving it again here would
      // announce the same fact twice and, worse, could fail a job whose transcription is already
      // finished over an enrollment recording that has been moved since it ran. What is left is
      // the direct callers, which do transcribe, and for them this is the top of the run — the
      // cheapest place to learn either that the run is untagged (a declared mode: the pipeline
      // then behaves exactly as it did before this feature existed) or that the enrollment cannot
      // be read at all.
      const willTranscribeHere = !(params.preTranscribedContent && params.preTranscribedContent.length > 0);
      let speakerTagger: SpeakerTagger | undefined;
      if (willTranscribeHere) {
        const speakerMode = await resolveSpeakerTagging(
          params.speakerEnrollmentAudio, getRuntimePaths().speakerModel);
        announceSpeakerTagging(speakerMode);
        if (speakerMode.enabled) speakerTagger = new SpeakerTagger(speakerMode);
      }

      // Progress callback passed through so the handler can send 'preparing' events.
      const inputHandler = new InputHandlerService(
        whisperService, runOutputDir, params.progressCallback, speakerTagger);

      // Initialize AI Manager
      const aiConfig: AIConfig = {
        provider: params.aiProvider,
        // The transcript's direct-pass ceiling follows the ROUTED field models, not the
        // legacy provider above: an all-local run gets the local (90k) window even when
        // the Settings provider is a cloud one. Any routed cloud field → cost ceiling.
        transcriptCeiling: (Object.entries(this.routing(params)) as [MetadataRoutingTaskId, string][])
          .every(([taskId, optionId]) => routingOption(taskId, optionId).kind === 'local')
          ? 'local'
          : 'cloud',
        model: params.aiModel, // Legacy support
        summarizationModel: params.summarizationModel,
        metadataModel: params.metadataModel,
        apiKey: params.aiApiKey,
        cloudApiKeys: params.cloudApiKeys,
        host: params.aiHost,
        promptSet: params.promptSet,
        promptSetsDir: params.promptSetsDir,
        insightsBlock: params.insightsBlock,
        abortSignal: params.cancelSignal,
      };

      log.info('[MetadataGenerator] Creating AIManagerService...');
      const aiManager = new AIManagerService(aiConfig);
      log.info('[MetadataGenerator] Initializing AI manager...');
      const initialized = await aiManager.initialize();

      if (!initialized) {
        log.error('[MetadataGenerator] AI manager initialization failed');
        return {
          success: false,
          error: aiManager.lastInitError
            ? `Failed to initialize AI manager: ${aiManager.lastInitError}`
            : 'Failed to initialize AI manager',
        };
      }
      log.info('[MetadataGenerator] AI manager initialized successfully');

      // Process inputs - normalize input format
      // Inputs can be either strings or objects with {path: string}
      const normalizedInputs = params.inputs.map((input: any) => {
        if (typeof input === 'string') {
          return input;
        } else if (input && typeof input === 'object' && input.path) {
          return input.path;
        }
        return String(input);
      });
      log.info(`[MetadataGenerator] Normalized ${normalizedInputs.length} inputs`);

      // Set up progress forwarding from WhisperService
      // Progress events now include jobId and videoPath for multi-transcription support
      whisperService.on('progress', (progress: any) => {
        console.log(`[MetadataGenerator] Whisper progress [${progress.jobId}]:`, progress.percent, progress.message);
        if (params.progressCallback && progress.videoPath) {
          // Extract filename from videoPath
          const filename = progress.videoPath.split('/').pop() || progress.videoPath;

          // Find itemIndex by matching videoPath against normalized inputs
          let itemIndex: number | undefined = undefined;
          for (let i = 0; i < normalizedInputs.length; i++) {
            if (normalizedInputs[i] === progress.videoPath) {
              itemIndex = i;
              break;
            }
          }

          console.log(`[MetadataGenerator] Sending transcription progress: ${progress.percent}% for ${filename} (item ${itemIndex})`);
          params.progressCallback('transcription', progress.message, progress.percent, filename, itemIndex);
        }
      });

      // Input-stage failures (skipped items) — carried into result.warnings so
      // items can't silently vanish from the job.
      const inputFailures: string[] = [...(params.inputWarnings || [])];

      let contentItems: ContentItem[];
      if (params.preTranscribedContent && params.preTranscribedContent.length > 0) {
        contentItems = params.preTranscribedContent;
        log.info(`[MetadataGenerator] Using ${contentItems.length} pre-transcribed content items`);
      } else {
        const customNotesMap = new Map(Object.entries(params.inputNotes || {}));
        const useSavedTranscriptMap = new Map(
          Object.entries(params.useSavedTranscripts || {}).filter(([, flag]) => flag === true));
        log.info('[MetadataGenerator] Processing inputs...');
        contentItems = await inputHandler.processMultipleInputs(
          normalizedInputs, customNotesMap, inputFailures, undefined, useSavedTranscriptMap);
      }

      this.throwIfCancelled(params, 'after input processing');

      if (contentItems.length === 0) {
        log.error('[MetadataGenerator] No content items processed from inputs');
        return {
          success: false,
          error: inputFailures.length > 0
            ? `No content could be processed: ${inputFailures.join('; ')}`
            : 'No content could be processed',
        };
      }

      log.info(`[MetadataGenerator] Processed ${contentItems.length} content items`);
      contentItems.forEach((item, idx) => {
        // Logs the text that will actually feed the content fields, and says which
        // transcript it is: a linked run whose log showed the final export's words would
        // be describing the one thing this stage no longer does.
        const resolved = this.contentTextOf(item);
        log.info(`[MetadataGenerator]   Item ${idx + 1}: type=${item.contentType}, content_fields=${resolved.origin}, content=${resolved.text.substring(0, 100)}...`);
      });

      // Initialize job and output handler
      const outputPath = runOutputDir;
      // Shared per output directory: the handler's write queue only orders calls that go
      // through the same instance, and a reports-page delete now arrives on that queue too.
      outputHandler = OutputHandlerService.forOutputDir(outputPath);
      const jobName = params.jobName || this.generateJobName(contentItems);

      // Partial failures / dropped-content notices, seeded with input-stage skips.
      // Declared here rather than after job init because the show-prompt flow below
      // runs the chapter stage too and can raise the same warnings.
      const warnings: string[] = [...inputFailures];
      // Chapters produced this run, keyed by source label — handed back to the caller
      // in show-prompt mode so "Send to AI" reuses them.
      const computedChapters: { [sourceLabel: string]: ChapterPipelineResult } = {};

      // "Show prompt" flow: assemble the exact prompt(s) that would be sent to the AI
      // and return them WITHOUT initializing a job, making the metadata call, or
      // writing any output. The IPC layer holds the transcript so "Send to AI" can
      // later run the real generation via preTranscribedContent.
      //
      // Chapters ARE generated here, unlike before. They now feed the metadata prompt,
      // so skipping them would make this flow display a prompt that is not the prompt
      // that gets sent — which is the one thing this flow exists to rule out. The
      // chapters come back with the prompts and are reused on send.
      if (params.showPrompt) {
        const mode = params.mode || 'individual';
        console.log(`[MetadataGenerator] Show-prompt mode: assembling prompt(s) only (${mode})`);
        const prompts: string[] = [];

        if (mode === 'compilation') {
          // Mirror the compilation path's per-item summarize + join so the assembled
          // prompt matches EXACTLY what a real compilation generation would send.
          const contentTypes = contentItems.map(item => item.contentType);
          const uniqueContentTypes = Array.from(new Set(contentTypes));

          params.progressCallback?.('generating', 'Assembling prompt...', 50);
          const itemSummaries: string[] = [];
          for (let i = 0; i < contentItems.length; i++) {
            this.throwIfCancelled(params, `assembling compilation prompt (item ${i + 1}/${contentItems.length})`);
            const item = contentItems[i];
            const sourceLabel = item.source || `Item ${i + 1}`;
            const itemSummary = await aiManager.summarizeTranscript(
              this.contentTextOf(item).text, sourceLabel, { forceCondense: true });
            itemSummaries.push(`ITEM ${i + 1} (${sourceLabel}):\n${itemSummary}`);
          }
          const summary = itemSummaries.join('\n\n');

          prompts.push(aiManager.buildCompilationPrompt(summary, jobName, {
            sourceCount: contentItems.length,
            contentTypes: uniqueContentTypes,
          }));
        } else {
          // Individual mode: one prompt per item, mirroring the normal per-item summarize.
          for (let i = 0; i < contentItems.length; i++) {
            this.throwIfCancelled(params, `assembling prompt (item ${i + 1}/${contentItems.length})`);
            const item = contentItems[i];
            const sourceLabel = item.source || `item_${i + 1}`;

            const { subjects, details } = await this.resolveChapters(
              item,
              aiManager,
              params,
              i,
              contentItems.length,
              warnings,
              lifecycle,
              computedChapters
            );

            this.throwIfCancelled(params, `before summarizing ${sourceLabel} for the prompt`);
            params.progressCallback?.('generating', 'Assembling prompt...', 80, undefined, i);
            const summary = await aiManager.summarizeTranscript(this.contentTextOf(item).text, sourceLabel);

            // The same planning the real run does, so the user reads the prompts that will
            // actually be sent — one labelled block per unit, chapters or no chapters.
            const taskRun = await this.resolveTaskRun(
              aiManager, params, item, sourceLabel, summary, warnings, lifecycle, subjects, details);
            prompts.push(...buildTaskPromptsForDisplay(taskRun));
          }
        }

        // Cleanup — no job was initialized and no output was written.
        aiManager.cleanup();
        console.log(`[MetadataGenerator] Show-prompt: assembled ${prompts.length} prompt(s)`);
        return {
          success: true,
          prompts,
          job_id: params.jobId,
          computedChapters,
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      // Initialize the job (creates job metadata file with empty items).
      //
      // The channel is recorded on the job, so a report a week from now says which channel's
      // brief produced it. It has no default here: the caller resolved it before anything ran
      // (ipc-handlers), and writing "sample-youtube" — a prompt set this repo has not shipped
      // in a very long time — onto a real job would be recording a channel that never existed.
      if (!params.promptSet) {
        throw new Error('A metadata run must name the channel it is generating for; none was given');
      }
      const jobInfo = outputHandler.initializeJob(
        jobName,
        params.promptSet,
        params.jobId
      );

      // Store original inputs and content types for history filtering
      outputHandler.updateJobData(jobInfo.jobId, {
        original_inputs: normalizedInputs,
        input_types: contentItems.map(item => item.contentType),
      });

      jobId = jobInfo.jobId;
      console.log(`[MetadataGenerator] Job initialized: ${jobInfo.jobId}`);

      // Generate metadata based on mode (`warnings` was seeded above, before the
      // show-prompt branch, because that branch raises the same chapter warnings)
      const metadataItems: MetadataResult[] = [];
      const mode = params.mode || 'individual';
      console.log(`[MetadataGenerator] Processing mode: ${mode}`);

      if (mode === 'compilation') {
        // COMPILATION MODE: Combine all content and generate single metadata
        console.log('[MetadataGenerator] Compilation mode: combining all content');

        // Determine content types for compilation context
        const contentTypes = contentItems.map(item => item.contentType);
        const uniqueContentTypes = Array.from(new Set(contentTypes));

        // Resolved BEFORE the first model call: a set whose inputs disagree about where
        // their words came from cannot be recorded as one item, and finding that out
        // after N summarizations and a metadata call would cost the operator the run.
        const compilationProvenance = this.compilationProvenanceOf(contentItems);

        // Summarize each item SEPARATELY to preserve distinct subjects
        // (Combining first then summarizing loses the ITEM structure during chunking)
        params.progressCallback?.('generating', 'Analyzing combined content...', 0);
        const itemSummaries: string[] = [];
        for (let i = 0; i < contentItems.length; i++) {
          // Checked before each (potentially long) summarization
          this.throwIfCancelled(params, `before summarizing compilation item ${i + 1}/${contentItems.length}`);

          const item = contentItems[i];
          const sourceLabel = item.source || `Item ${i + 1}`;
          console.log(`[MetadataGenerator] Summarizing compilation item ${i + 1}/${contentItems.length}: ${sourceLabel}`);
          // Always condense compilation items — their outputs get joined into one prompt
          const itemSummary = await aiManager.summarizeTranscript(
            this.contentTextOf(item).text, sourceLabel, { forceCondense: true });
          itemSummaries.push(`ITEM ${i + 1} (${sourceLabel}):\n${itemSummary}`);
        }

        // Recombine summaries with ITEM labels intact
        const summary = itemSummaries.join('\n\n');

        // Checked before the final (long) metadata generation
        this.throwIfCancelled(params, 'before compilation metadata generation');

        // Generate single metadata for compilation with hardcoded compilation instructions
        params.progressCallback?.('generating', 'Generating metadata for compilation...', 50);
        const metadata = await aiManager.generateCompilationMetadata(
          summary,
          jobName,
          {
            sourceCount: contentItems.length,
            contentTypes: uniqueContentTypes
          }
        );

        // Add compilation info
        (metadata as any)._title = jobName;
        (metadata as any)._prompt_set = params.promptSet;
        (metadata as any)._is_compilation = true;
        (metadata as any)._source_count = contentItems.length;
        // A compilation is one item, so the whole run's trace is its trace.
        (metadata as any)._prompt_trace = aiManager.promptTrace.slice();

        // Save compilation result. A compilation has no single source, so its source_key
        // is an explicit null rather than the first input's: the key exists to answer
        // "is this the same video, generated again?", and a set of N inputs cannot
        // answer it. `_is_compilation` on the item says which kind of item this is.
        const compilationSource: ItemSource = { source_key: null, source_path: null };
        const saveResult = await outputHandler.addItemToJob(
          jobInfo.jobId, metadata, compilationSource, compilationProvenance);
        console.log(`[MetadataGenerator] Saved compilation to: ${saveResult.txtPath}`);

        params.progressCallback?.('generating', 'Compilation complete', 100);
        metadataItems.push(metadata);

      } else {
        // INDIVIDUAL MODE: Process each item separately
        console.log('[MetadataGenerator] Individual mode: processing items separately');

        for (let i = 0; i < contentItems.length; i++) {
        // Checked before each item. This is NOT the whole story: a real job has exactly
        // one item, so every guard that matters is the one at the next STAGE boundary
        // inside the loop body.
        this.throwIfCancelled(params, `at item ${i + 1}/${contentItems.length}`);

        const item = contentItems[i];
        console.log(`[MetadataGenerator] Generating metadata ${i + 1}/${contentItems.length}`);

        // Everything makeRequest sends from here to this item's save belongs to this item:
        // the chapter calls, the field calls, the description calls, the summarization.
        // Sliced onto `_prompt_trace` below so the report can show what the models read.
        const promptTraceStart = aiManager.promptTrace.length;

        try {
          const sourceLabel = item.source || `item_${i + 1}`;

          // ---- Chapters FIRST -------------------------------------------------
          // Chapters are not a trailing decoration any more. Their subject list is
          // what the title, description and tag stages condition on, so it has to
          // exist before the metadata call is assembled (see CHAPTERING.md).
          const {
            chapters,
            excludedChapters,
            subjects: chapterSubjects,
            details: chapterDetails,
            chaptersSkipped,
          } = await this.resolveChapters(
            item,
            aiManager,
            params,
            i,
            contentItems.length,
            warnings,
            lifecycle,
            computedChapters
          );

          // ---- Everything else, conditioned on those chapters -----------------
          this.throwIfCancelled(params, `before summarizing ${sourceLabel}`);
          console.log(`[MetadataGenerator] Sending generating phase: Analyzing content for item ${i}`);
          params.progressCallback?.('generating', `Analyzing content ${i + 1}/${contentItems.length}...`, 60, undefined, i);
          const summary = await aiManager.summarizeTranscript(this.contentTextOf(item).text, sourceLabel);

          this.throwIfCancelled(params, `before generating metadata for ${sourceLabel}`);
          console.log(`[MetadataGenerator] Sending generating phase: Generating metadata for item ${i}`);
          params.progressCallback?.('generating', `Generating metadata ${i + 1}/${contentItems.length}...`, 80, undefined, i);

          // ONE SHAPE, whether or not this item has chapters: the routed units, against the
          // routing table. Chapters change what the units READ (a measured table of contents
          // rather than the operator's subject line) and who writes the tags, and both of those
          // are logged — they no longer change which code path the item takes.
          const taskRun = await this.resolveTaskRun(
            aiManager, params, item, sourceLabel, summary, warnings, lifecycle, chapterSubjects, chapterDetails);
          const metadata = await runMetadataTasks(aiManager, taskRun);

          // Add title and source info. `_is_compilation` is written on BOTH branches now:
          // it used to be true-or-absent, so "not a compilation" and "written by a build
          // that did not record it" were the same value to every reader.
          (metadata as any)._title = this.getCleanTitle(item);
          (metadata as any)._prompt_set = params.promptSet;
          (metadata as any)._is_compilation = false;

          if (chapters) {
            metadata.chapters = chapters;
          }
          // Carried even when no chapters publish (a video that was all promo): the job
          // JSON is where the user finds out what was taken out and why.
          if (excludedChapters) {
            metadata.excludedChapters = excludedChapters;
          }
          // Why there are no chapters, written onto the ITEM rather than left in the
          // run's warnings: warnings die with the response, and the report is read long
          // after. Without this a chapterless item is indistinguishable from one that was
          // never asked for chapters.
          if (chaptersSkipped) {
            metadata.chaptersSkipped = chaptersSkipped;
          }

          // Save this item to the job immediately, with what it was generated FROM —
          // recorded at generation time, never derived on read from `original_inputs`
          // (which is a different array with its own length, and already disagrees with
          // items[] on 16 of the live report files).
          // ...and with which TRANSCRIPT of that source wrote its words, recorded on both
          // branches so the report can always say (spec §3.5).
          (metadata as any)._prompt_trace = aiManager.promptTrace.slice(promptTraceStart);

          const saveResult = await outputHandler.addItemToJob(
            jobInfo.jobId, metadata, this.itemSourceOf(item), this.itemProvenanceOf(item));
          console.log(`[MetadataGenerator] Saved metadata to: ${saveResult.txtPath}`);

          // Mark this item as complete
          console.log(`[MetadataGenerator] Sending generating phase: Completed for item ${i}`);
          params.progressCallback?.('generating', `Completed ${i + 1}/${contentItems.length}`, 100, undefined, i);
          metadataItems.push(metadata);
        } catch (error) {
          // A cancelled run is not a failed item. Demoting it to a warning here is what
          // let a cancel become a 'completed' job: the loop would carry on to the next
          // item and the run would end down the success path.
          if (this.isCancellation(params, error)) {
            throw error;
          }
          const errMsg = error instanceof Error ? error.message : String(error);
          const sourceLabel = item.source || `item_${i + 1}`;
          log.error(`[MetadataGenerator] Failed to generate metadata for item ${i + 1}:`, error);
          console.error(`[MetadataGenerator] Failed to generate metadata for item ${i + 1}:`, error);
          // Record the partial failure so the caller can surface it instead of
          // silently returning success with a missing item. Prefix with the bare
          // filename — the message itself already carries the full path.
          const shortLabel = sourceLabel.split('/').pop() || sourceLabel;
          warnings.push(`${shortLabel}: ${errMsg}`);
          // Continue with other items
        }
      }
      } // End of individual mode else block

      if (metadataItems.length === 0) {
        // Update job status to failed
        outputHandler.updateJobStatus(jobInfo.jobId, 'failed');
        return {
          success: false,
          // The per-item reasons ARE the error: "Failed to generate metadata for
          // any items" told the user nothing when every item failed for a stated,
          // logged reason. The UI shows this string on the failed job.
          error: warnings.length > 0 ? warnings.join('\n') : 'Failed to generate metadata for any items',
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

      // The last guard, and the one that makes the promise hold: a cancel that landed
      // after the final save must not be written down as a completed job.
      this.throwIfCancelled(params, 'before the job was marked complete');

      // Mark job as completed
      outputHandler.updateJobStatus(jobInfo.jobId, 'completed');
      console.log(`[MetadataGenerator] Job completed: ${jobInfo.jobId}`);

      // Cleanup
      aiManager.cleanup();

      const processingTime = (Date.now() - startTime) / 1000;
      console.log(`[MetadataGenerator] Generation complete in ${processingTime.toFixed(2)}s`);

      // Collect all TXT files from the job folder
      const fs = require('fs');
      let txtFiles: string[] = [];

      try {
        // Check if folder exists before trying to read it
        if (fs.existsSync(jobInfo.txtFolder)) {
          txtFiles = fs.readdirSync(jobInfo.txtFolder)
            .filter((file: string) => file.endsWith('.txt'))
            .map((file: string) => require('path').join(jobInfo.txtFolder, file));
        } else {
          console.error(`[MetadataGenerator] TXT folder does not exist: ${jobInfo.txtFolder}`);
        }
      } catch (error) {
        console.error(`[MetadataGenerator] Failed to read TXT folder:`, error);
        console.error(`[MetadataGenerator] Folder path was: ${jobInfo.txtFolder}`);
      }

      return {
        success: true,
        metadata: metadataItems,
        output_files: [jobInfo.txtFolder],
        txt_files: txtFiles,
        json_file: jobInfo.jsonPath,
        job_id: jobInfo.jobId,
        processing_time: processingTime,
        // Partial failures (skipped items, dropped chapters) — success is still true
        // as long as at least one item succeeded, but the caller can surface these.
        warnings: warnings.length > 0 ? warnings : undefined,
      };
    } catch (error) {
      // THE cancellation exit. Every guard and every aborted provider call lands here,
      // so there is one place that decides what a cancelled run is worth: status
      // 'cancelled' on the job, never 'completed' and never 'failed'.
      if (this.isCancellation(params, error)) {
        log.info(
          `[MetadataGenerator] ${error instanceof Error ? error.message : String(error)}`
        );
        if (outputHandler && jobId) {
          outputHandler.updateJobStatus(jobId, 'cancelled');
        }
        return {
          success: false,
          error: 'Job cancelled by user',
        };
      }

      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log.error('[MetadataGenerator] Generation failed:', errorMessage);
      if (errorStack) {
        log.error('[MetadataGenerator] Stack trace:', errorStack);
      }

      console.error('[MetadataGenerator] Generation failed:', error);

      return {
        success: false,
        error: errorMessage,
      };
    } finally {
      // The ONE release, and the only one in the app. Finished, failed and cancelled all land
      // here, so the operator's memory comes back exactly once per job whatever ended it —
      // including the show-prompt flow above, which runs the chapter pipeline for real.
      await lifecycle.releaseAll();
    }
  }

  /**
   * Has the user asked for this run to stop?
   *
   * Both sources are consulted because they answer at different moments: the signal fires
   * the instant cancel is requested (and is what aborts a call already in flight), the
   * callback is the polled flag the caller has always exposed.
   */
  private static cancelRequested(params: GenerationParams): boolean {
    return params.cancelSignal?.aborted === true || params.cancelCallback?.() === true;
  }

  /**
   * The stage-boundary guard: called by every stage that is about to make a model call,
   * so a cancel is never more than one stage stale.
   *
   * The check it replaces ran once per ITEM. A real job has exactly one item, so a cancel
   * arriving after that check ran the entire remaining pipeline — summarization, titles,
   * description, tags, chapters — and billed all of it.
   */
  private static throwIfCancelled(params: GenerationParams, where: string): void {
    if (this.cancelRequested(params)) {
      throw new JobCancelledError(where);
    }
  }

  /**
   * Is this error the run stopping because the user cancelled it?
   *
   * The error itself is only half the answer. An aborted provider call surfaces as that
   * client's own transport error, and the AI queue re-wraps every rejection as a plain
   * Error (queue-manager.service.ts), so the type and message do not survive the trip.
   * What does survive is the fact that cancellation was requested — and once it has been,
   * whatever the run threw on the way down IS the cancellation.
   */
  private static isCancellation(params: GenerationParams, error: unknown): boolean {
    return error instanceof JobCancelledError || this.cancelRequested(params);
  }

  /**
   * Set up this item's routed run. EVERY individual item takes one.
   *
   * WHAT THIS METHOD USED TO DO, because its absence is the change: it decided whether an item
   * was generated as routed units at all, and returned `undefined` — meaning "take the legacy
   * single whole-metadata call" — for anything with no chapter subjects. An item reached that
   * branch by circumstance rather than by choice: a typed text subject, a podcast, a shorts
   * clip, or any video whose chapter pipeline came back short or came back all promo. Those
   * items were then generated by ONE call to whatever model the Settings page's "AI Model"
   * picker named, ignoring the routing table entirely, with nothing in the report to say a
   * different set of decisions had been applied to them.
   *
   * There is no such branch now. A chapterless item plans the SAME units against the SAME
   * routing table; what it lacks is only the chapter list, so the units read the text subject
   * in its place and its tags are written by a model rather than assembled from pools measured
   * against chapters (planMetadataUnits `hasChapters`). Both facts are logged per item.
   *
   * The one whole-metadata call left in the app is the COMPILATION one, which is a mode the
   * operator selects and which never runs from here.
   */
  private static async resolveTaskRun(
    aiManager: AIManagerService,
    params: GenerationParams,
    item: ContentItem,
    sourceLabel: string,
    summary: string,
    warnings: string[],
    lifecycle: JobModelLifecycle,
    chapterSubjects?: string[],
    chapterDetails?: string[]
  ): Promise<MetadataTaskRun> {
    const subjects = chapterSubjects || [];
    const hasChapters = subjects.length > 0;

    // The pools the description prompts, the assembled tags and the derived hashtags all read
    // (spec §2). Both are measured from the app's CONTENT text — the ad-free editor transcript
    // when one is linked, the final export's otherwise — which is the same resolution every
    // content field in this service goes through and never the timed final export by accident.
    const resolvedContent = this.contentTextOf(item);
    const contentText = resolvedContent.text;

    /**
     * The local models this run loads OUTSIDE the metadata calls, so the two-model budget counts
     * what the run actually costs rather than only the part of it planMetadataUnits can see.
     *
     * CHAPTERS: the pipeline made its generation model resident whenever it produced subjects.
     * SUMMARIZATION: only when it FIRED, which since the raw-transcript change means only when
     * the transcript was over ai-manager's direct-pass ceiling — and `summary !== contentText`
     * is exactly that fact, measured rather than assumed.
     */
    const alsoLoads: ModelRosterEntry[] = [];
    // The chapter model counts against the local two-model budget only when it IS local —
    // a slot routed to a cloud option made nothing resident.
    const chapterOption = resolveChapterModelOption(resolveMetadataRouting(params.metadataRouting));
    if (hasChapters && chapterOption.kind === 'local') {
      alsoLoads.push({ model: chapterOption.model, what: 'chapters' });
    }
    if (summary !== contentText) {
      // The summarizer follows the writing slot since 2026-08-23 (ipc-handlers resolves it
      // through resolveChapterModelOption); only a LOCAL summarizer made anything resident,
      // so only that case counts against the budget or gets held.
      const summarizer = (params.summarizationModel || SUMMARIZATION_MODEL);
      if (summarizer.startsWith('ollama:')) {
        const bare = summarizer.replace(/^ollama:/, '');
        alsoLoads.push({ model: bare, what: 'summarization' });
        // It has already run by the time this is reached, so this is a statement about what
        // is resident, not a prediction. Usually the same 27B the fields are routed to, in
        // which case the lifecycle already holds it and this says nothing new.
        lifecycle.holdOllamaModel(params.aiHost || 'http://localhost:11434', bare, 'summarization');
      }
    }

    const plan = planMetadataUnits({
      routing: this.routing(params),
      defaultHost: params.aiHost || 'http://localhost:11434',
      aiManager,
      hasInsights: Boolean(params.insightsBlock),
      hasChapters,
      alsoLoads,
      lifecycle,
      abortSignal: params.cancelSignal,
    });
    console.log(
      `[MetadataGenerator] ${sourceLabel}: ` +
        (hasChapters
          ? `${subjects.length} chapter subjects`
          : 'no chapter subjects, so the text subject is the content every unit reads') +
        ` — ${plan.units.length} unit(s): ${plan.summary}`
    );

    const pools = await this.extractPools(contentText, params, sourceLabel, warnings);

    return {
      plan,
      ctx: {
        content: summary,
        sourceLabel,
        chapterSubjects: subjects,
        chapterDetails: chapterDetails || [],
        videoTitle: this.getCleanTitle(item),
        promptSetName: params.promptSet || 'unknown',
        entities: pools.entities,
        keyPhrases: pools.keyPhrases,
        contentText,
        // Whether the two content slots above are screenplay-labelled. Note that `content` is
        // the SUMMARY on the rare over-ceiling item, where the labels survive only as far as the
        // summarizer carried them; on the ordinary direct-passed item the summary IS the content
        // text and this describes both exactly.
        contentSpeakerTagged: resolvedContent.speakerTagged,
        // Filled by runMetadataTasks as each call returns, and read by the calls that take an
        // earlier field as input data — the thumbnail call reading the titles. It starts empty
        // on every item: nothing carries over from the last one.
        generated: {},
        // A unit's DECLARED degradation lands in the run's warnings beside the chapter
        // pipeline's, which is the only place the operator reads them after the fact.
        warn: (message: string) => {
          console.warn(`[MetadataGenerator] ${sourceLabel}: ${message}`);
          warnings.push(`${sourceLabel}: ${message}`);
        },
      },
    };
  }

  /**
   * The entity and key-phrase pools for one item.
   *
   * Entities are pure code (entity-extraction.ts) and cannot fail. Key phrases want ONE batched
   * embedding call on nomic-embed-text (KEY_PHRASE_EMBEDDING_MODEL); when that model is
   * absent or the host does not answer, the ranking falls to frequency and the run RECORDS it
   * as a declared mode, exactly as the chapter pipeline declares a dropped chapter. The tags
   * and hashtags that come out of a frequency ranking are worse, not wrong, and the report says
   * which ranking produced them.
   *
   * A transcript that cannot be read for proper nouns at all is also declared: an uncased
   * transcript makes the entity half of every pool empty, and "no names in this video" and "no
   * capital letters in this transcript" must not look the same in the report.
   *
   * BOTH MEASUREMENTS READ THE WORDS WITHOUT THEIR SPEAKER LABELS. The labels are a fact about
   * the transcript rather than part of it, and both of these read the text as one flat stream:
   * measured on the calibration transcript, leaving them in put "CLIP Debbie Wasserman Schultz"
   * and "UNSURE Refugee Center" at the top of the entity pool that writes the tags. The model
   * still sees the labels — the prompts explain them — but nothing that counts words does.
   */
  private static async extractPools(
    taggedContentText: string,
    params: GenerationParams,
    sourceLabel: string,
    warnings: string[]
  ): Promise<{ entities: string[]; keyPhrases: string[] }> {
    const contentText = stripSpeakerPrefixes(taggedContentText);
    const casing = transcriptCasing(contentText);
    if (!casing.usable) {
      const msg =
        `${sourceLabel}: the content transcript cannot be read for proper nouns — ${casing.reason} — so the ` +
        `description, tags and hashtags were written with no entity list`;
      console.warn(`[MetadataGenerator] ${msg}`);
      warnings.push(msg);
    }

    const entities = casing.usable ? topEntities(contentText, ENTITY_POOL_SIZE) : [];

    const host = params.aiHost || 'http://localhost:11434';
    const ranked = await rankKeyPhrases(contentText, {
      client: axios.create({ baseURL: host }),
      model: KEY_PHRASE_EMBEDDING_MODEL,
      limit: KEY_PHRASE_POOL_SIZE,
      signal: params.cancelSignal,
      logPrefix: `[MetadataGenerator] ${sourceLabel}:`,
    });
    if (ranked.notice) {
      warnings.push(`${sourceLabel}: ${ranked.notice}`);
    }

    log.info(
      `[MetadataGenerator] ${sourceLabel}: ${entities.length} entit(ies) and ${ranked.phrases.length} ` +
        `key phrase(s) (${ranked.mode} ranking) feed the description, tags and hashtags`
    );
    return { entities, keyPhrases: ranked.phrases };
  }

  /**
   * This run's routing, resolved once against the registry.
   *
   * Read from the params (which the IPC layer fills from the store at job time), so a
   * selection changed in the modal takes effect on the next job with no coupling between
   * the modal and the queue.
   */
  private static routing(params: GenerationParams): ResolvedMetadataRouting {
    return resolveMetadataRouting(params.metadataRouting);
  }

  /**
   * The chapter step, as both the real run and the "Show prompt" assembly see it.
   *
   * Chapters that could not be produced are reported as warnings rather than failing
   * the item — but the warning always says the rest of the metadata was written
   * WITHOUT the chapter subjects, because that is a materially different generation
   * and the user has to know which one they got.
   *
   * Results are recorded in `sink` so "Show prompt" can hand the SAME chapters to
   * "Send to AI" instead of paying for the pipeline twice and possibly getting a
   * different answer the second time.
   *
   * The pipeline's own `warnings` are copied into the run's warnings verbatim. They
   * are the only account the user gets of a chapter list that came out degraded —
   * approximate starts, dropped boundaries, chapters the model would not name — and a
   * degraded list looks exactly like a good one.
   */
  private static async resolveChapters(
    item: ContentItem,
    aiManager: AIManagerService,
    params: GenerationParams,
    itemIndex: number,
    itemCount: number,
    warnings: string[],
    lifecycle: JobModelLifecycle,
    sink?: { [sourceLabel: string]: ChapterPipelineResult }
  ): Promise<ChapterOutcome> {
    const sourceLabel = item.source || `item_${itemIndex + 1}`;

    if (!item.srtSegments || item.srtSegments.length === 0) {
      // Chapters are decided by the INPUT, not by an option: a timestamped transcript
      // (video, imported transcript) gets them, a text subject or plain transcript file
      // has nothing to timestamp. Not a warning — there is nothing to skip.
      console.log(`[MetadataGenerator] ${sourceLabel}: no timestamped transcript, so chapters don't apply`);
      return {};
    }

    const reuse = params.preComputedChapters?.[sourceLabel];
    if (reuse) {
      console.log(`[MetadataGenerator] Reusing ${reuse.chapters.length} already-computed chapters for ${sourceLabel}`);
      // Warnings are NOT re-raised here: these chapters came back from the show-prompt
      // pass, which already reported them, and repeating them would read as a second
      // set of failures. The promo split is re-run rather than carried across, because it
      // is a pure function of the chapters and re-deriving it cannot disagree with them.
      return this.splitOutPromos(reuse, sourceLabel, []);
    }

    this.throwIfCancelled(params, `before the chapter pipeline for ${sourceLabel}`);
    console.log(`[MetadataGenerator] Generating chapters for item ${itemIndex} (before metadata)...`);
    params.progressCallback?.('generating', `Finding chapters ${itemIndex + 1}/${itemCount}...`, 0, undefined, itemIndex);

    try {
      const result = await this.generateChapters(item, aiManager, params, itemIndex, itemCount, lifecycle);

      // Degradations the pipeline recovered from rather than threw on. Surfaced even
      // when the chapters below are then dropped for being too few — the user asked
      // for chapters and is entitled to know what happened to them.
      for (const warning of result.warnings || []) {
        console.warn(`[MetadataGenerator] ${sourceLabel}: ${warning}`);
        warnings.push(`${sourceLabel}: ${warning}`);
      }

      if (result.chapters.length < MIN_CHAPTERS) {
        // <3 chapters are dropped (YouTube requires at least 3). Don't let that vanish
        // silently when the user explicitly asked for chapters.
        const msg = `${sourceLabel}: only ${result.chapters.length} chapter(s) were found (YouTube requires at least ${MIN_CHAPTERS}), so none were added and the rest of the metadata was generated WITHOUT chapter subjects`;
        console.warn(`[MetadataGenerator] ${msg}`);
        warnings.push(msg);
        return {
          chaptersSkipped: {
            outcome: 'skipped',
            reason: `Only ${result.chapters.length} chapter(s) were found, and YouTube requires at least ${MIN_CHAPTERS}, so none were kept.`,
          },
        };
      }

      console.log(
        `[MetadataGenerator] Generated ${result.chapters.length} chapters in ${result.stats.calls} model calls ` +
          `(${result.stats.band} cadence band, ` +
          `${result.stats.chaptersDropped} dropped for an unmeasurable opening sentence, ` +
          `details ${result.stats.speakerTagged ? 'speaker-tagged' : 'untagged'})`
      );
      // The sink holds the PIPELINE's result, promos included: it is what "Send to AI"
      // reuses, and it must be the same list this pass started from, not the filtered one.
      if (sink) sink[sourceLabel] = result;
      return this.splitOutPromos(result, sourceLabel, warnings);
    } catch (error) {
      // A cancelled run is not a degraded chapter list. Reporting it as a warning here
      // would let the item carry on and pay for the metadata call the user just stopped.
      if (this.isCancellation(params, error)) {
        throw error;
      }
      const errMsg = error instanceof Error ? error.message : String(error);
      const msg = `${sourceLabel}: chapter generation failed, so the rest of the metadata was generated WITHOUT chapter subjects: ${errMsg}`;
      console.error(`[MetadataGenerator] ${msg}`);
      warnings.push(msg);
      return { chaptersSkipped: { outcome: 'failed', reason: errMsg } };
    }
  }

  /**
   * Take the ads out of a finished chapter list.
   *
   * Applied to EVERY path that produces chapters, including the reuse path, because the
   * split is a pure function of the chapters and the published list, the TXT block, the
   * description's chapter lines and every task's conditioning all have to see the same
   * one. The pipeline's own result is left untouched — what is excluded travels on to the
   * job JSON as `excludedChapters` rather than disappearing.
   */
  private static splitOutPromos(
    result: ChapterPipelineResult,
    sourceLabel: string,
    warnings: string[]
  ): ChapterOutcome {
    const partition = excludePromoChapters(
      result.chapters,
      result.subjects,
      result.subjectDetails.map((s) => s.detail),
      sourceLabel
    );

    for (const warning of partition.warnings) {
      console.warn(`[MetadataGenerator] ${sourceLabel}: ${warning}`);
      warnings.push(`${sourceLabel}: ${warning}`);
    }

    const excludedChapters = partition.excluded.length > 0 ? partition.excluded : undefined;

    // Nothing but ads. There is no chapter list to publish and no subject list to
    // condition on, so this item takes the legacy single call — stated by returning no
    // subjects, exactly as a run whose pipeline came back short does.
    if (partition.content.length === 0) {
      return {
        excludedChapters,
        chaptersSkipped: {
          outcome: 'skipped',
          reason:
            `All ${partition.excluded.length} chapter(s) the pipeline found were classified as promos, ` +
            `so there was no chapter list left to publish (they are kept under excludedChapters).`,
        },
      };
    }

    return {
      chapters: partition.content,
      excludedChapters,
      subjects: partition.contentSubjects,
      details: partition.contentDetails,
    };
  }

  /**
   * Generate chapters — with the whole-transcript call, which is now the only way.
   *
   * There have been four architectures and three of them are deleted: the sealed 5-stage 14B
   * pipeline (~390 one-question calls a video), the 27B single call, and the embedding
   * pipeline that replaced both on 2026-08-22 and was reversed out the same day when it was
   * measured at 43% boundary recall against 86% for one 27B reading the whole transcript
   * (CHAPTERING.md's reversal section). There is no "fall back to the old pipeline" path to
   * find here: chapters either come out of this method or the item records why they did not.
   *
   * How it works: ONE call reads the whole transcript and reports each chapter as a title
   * plus the verbatim first sentence it opens on; code measures each sentence against the
   * caption word stream, forwards only; then one call per chapter writes the detail the
   * description and tags condition on. 1 + N calls, N being 3 to 8. The model never emits a
   * timestamp and code never computes a chapter count.
   *
   * Its degradations are DECLARED: a chapter whose quote cannot be measured is dropped and
   * named in the run's warnings, a chapter the detail call could not describe carries no
   * detail and says so. Everything else — Ollama unreachable, model missing, timeout, an
   * unusable answer to the one chapter call twice over — throws, and resolveChapters records
   * `chaptersSkipped` on the item.
   *
   * The WHOLE run holds the single AI queue slot rather than queueing each of its calls
   * separately: the method requires one model resident at a time, and that is exactly what
   * the 1-slot AI pool exists to guarantee.
   */
  private static async generateChapters(
    item: ContentItem,
    aiManager: AIManagerService,
    params: GenerationParams,
    itemIndex: number,
    itemCount: number,
    lifecycle: JobModelLifecycle
  ) {
    if (!item.srtSegments || item.srtSegments.length === 0) {
      throw new Error('Chapter generation needs a timestamped transcript');
    }

    // Still not a routed TASK — there is no chapter entry in the store — but no longer a
    // fixed constant either: the chapter model is the writing-model slot's projection
    // (resolveChapterModelOption), because the labels this pipeline writes are the inputs
    // the description conditions on. A store whose slot tasks disagree projects to the
    // declared CHAPTER_PIPELINE_MODELS default, exactly the pre-slot behavior.
    const chapterOption = resolveChapterModelOption(resolveMetadataRouting(params.metadataRouting));
    const model = chapterOption.model;
    const host = params.aiHost || 'http://localhost:11434';
    const label = item.source || `item_${itemIndex + 1}`;

    // Chapter work is 0-60% of this item's "generating" phase; the metadata call that
    // follows takes it from there.
    //
    // The split is deliberately lopsided the way the WORK is. The chapter call prefills the
    // whole transcript and then reasons over it — on a long podcast that is the single
    // longest thing this app does, and it can only ever report 0/1 and 1/1 — so it owns half
    // the bar. The detail calls are short, there are 3 to 8 of them, and they are where the
    // bar actually moves.
    const stageWeights: Record<string, [number, number]> = {
      chapters: [0, 30],
      detail: [30, 60],
    };

    // A stage that reports every ~3s and then says nothing for minutes is
    // indistinguishable, from the progress bar, from a hang. It usually is not one —
    // Ollama loading a model or thrashing KV cache has been clocked here at 516 silent
    // seconds — but only this code knows that, so it says so.
    //
    // A SIGNAL and nothing more: nothing is killed, retried or rerouted. The 4-hour task
    // timeout below remains the only thing that ends a genuinely wedged run.
    const STALL_NOTICE_MS = 60_000;
    let stallTimer: NodeJS.Timeout | undefined;
    // Latched by the final disarm. Without it, the watchdog case re-arms the timer: the
    // queue rejects this promise while the closure is still running, and the closure's
    // next onProgress would put a stall notice on a job that already ended.
    let stallDone = false;
    let lastProgress: { stage: string; percent: number; at: number } = {
      stage: 'chapters',
      percent: 0,
      at: Date.now(),
    };

    const armStallNotice = () => {
      if (stallDone) return;
      clearTimeout(stallTimer);
      stallTimer = setTimeout(() => {
        const silentSec = Math.round((Date.now() - lastProgress.at) / 1000);
        log.warn(
          `[MetadataGenerator] Chapter stage "${lastProgress.stage}" for ${label} has reported no progress ` +
            `for ${silentSec}s; the model call is still in flight`
        );
        params.progressCallback?.(
          'generating',
          `Chapters (${lastProgress.stage}) ${itemIndex + 1}/${itemCount} — no progress for ${silentSec}s, ` +
            `model call still in flight`,
          lastProgress.percent,
          undefined,
          itemIndex
        );
        // Re-armed rather than one-shot: a stall the user is watching should keep
        // counting up, not report 60s once and go quiet again.
        armStallNotice();
      }, STALL_NOTICE_MS);
    };

    const disarmStallNotice = () => {
      stallDone = true;
      clearTimeout(stallTimer);
      stallTimer = undefined;
    };

    const reportProgress = (stage: string, done: number, total: number) => {
      const [from, to] = stageWeights[stage];
      const percent = Math.round(from + ((to - from) * done) / Math.max(1, total));
      lastProgress = { stage, percent, at: Date.now() };
      armStallNotice();
      params.progressCallback?.(
        'generating',
        `Chapters (${stage} ${done}/${total}) ${itemIndex + 1}/${itemCount}...`,
        percent,
        undefined,
        itemIndex
      );
    };

    const chapterer = new WholeTranscriptChapterService({
      host,
      model,
      // The cloud transport, exactly when the slot resolved to a cloud option. `model` is
      // then the provider-prefixed string runJsonRequest routes on, and the service's
      // local machinery (context sizing, residency) stands down — see the option's doc.
      cloudJson:
        chapterOption.kind === 'cloud'
          ? (prompt, cloudModel, what, schema) => aiManager.runJsonRequest(prompt, cloudModel, what, schema)
          : undefined,
      // The pipeline HOLDS its model here rather than unloading it when it finishes: the field
      // calls that run next are routed to the same 27B on most channels, and reloading it
      // between the two stages is the freeze this job stopped paying for.
      lifecycle,
      // Sizes its own context window from the largest prompt the run will send; a
      // configured value can only raise that floor, never lower it.
      numCtx: params.chapterNumCtx,
      // The detail call's second required context input: what the video IS. A filename like
      // "2026-08-19 jesse watters mocks democrat candidates" tells it who is speaking and
      // why, which is what grounds the names it writes.
      videoTitle: item.title || (item.source ? path.basename(item.source) : undefined),
      // The other half of that context: which channel this is for. The prompt set IS the
      // channel in this app — one yml per channel — so the name the run already loaded is
      // the honest answer, and nothing new is plumbed in from elsewhere to produce it.
      channelName: params.promptSet,
      // The channel's own plugs, for the prompts' {promoted_items} slot: plug stretches get
      // bounded and labeled as plugs (code excludes them), passing mentions stay out of
      // content labels and summaries.
      promotedItems: aiManager.promotedItems(),
      cancelCallback: params.cancelCallback,
      abortSignal: params.cancelSignal,
      onProgress: reportProgress,
    });

    log.info(`[MetadataGenerator] Chaptering starting for ${label} on ${model} @ ${host}`);

    // The AI pool's default 30-minute watchdog is sized for ONE stalled request. A long
    // livestream is a few dozen requests in a row on a big model, and on slower hardware
    // that legitimately outruns the default. 4 hours still backstops a genuinely wedged run.
    const CHAPTER_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1000;

    try {
      // On the CLOUD transport the pipeline must not hold the AI queue slot: every one of
      // its calls goes through aiManager.makeRequest, which takes that single slot ITSELF
      // — and makeRequest's own contract forbids callers wrapping it in queueAITask, because
      // nesting deadlocks the 1-slot pool (measured on the first cloud chapter run,
      // 2026-08-23: the chapters task held the slot while its first request sat queued
      // behind it forever). The slot the local path takes is Ollama OOM protection, and a
      // cloud run loads nothing.
      if (chapterOption.kind === 'cloud') {
        armStallNotice();
        return await chapterer.generate(item.srtSegments!);
      }
      return await queueAITask(
        `chapters-${params.jobId || 'job'}-${itemIndex}`,
        `Chapters: ${label}`,
        () => {
          // Armed only once the run actually starts. Time spent waiting for the AI
          // queue slot is not a stall, and the UI already says the job is queued.
          armStallNotice();
          return chapterer.generate(item.srtSegments!);
        },
        undefined,
        CHAPTER_TASK_TIMEOUT_MS
      );
    } finally {
      // Completion, failure, cancellation and the queue watchdog force-failing the task
      // all land here, so the timer cannot outlive the stage and report progress against
      // a job that has already ended. Disarming OUTSIDE the queued closure is what covers
      // the watchdog case: it rejects this promise while the closure is still running.
      disarmStallNotice();
    }
  }

  /**
   * What an item was generated FROM, in the shape the report file stores.
   *
   * A text subject has no source file, and says so with an explicit null — a key derived
   * from the subject text would join two unrelated topics that happen to open with the
   * same words. A file input with no path is a bug in input handling, not an item to
   * record a blank source for.
   */
  /**
   * THE SPLIT. The one place that decides which transcript feeds a CONTENT field.
   *
   * Every `summarizeTranscript` call in this service goes through here, and nothing else
   * does. That is deliberate and it is the whole safety argument for the two-source
   * design: the chapter pipeline reads `item.srtSegments` and never calls this, so a
   * linked run and an unlinked run of the same video produce byte-identical chapters
   * while their titles/description/tags differ (spec §5, PR 5's acceptance test).
   *
   * `origin` comes back with the text because the caller that records provenance and the
   * caller that generates from it must not be able to disagree about which one was used.
   *
   * Public so the split can be tested at this seam without running Whisper or a model.
   */
  static contentTextOf(item: ContentItem): {
    text: string;
    origin: ContentOrigin;
    /**
     * Whether `text` carries screenplay speaker labels. It travels WITH the text for the same
     * reason `origin` does: the two branches are two different transcripts of two different
     * things, and one can be tagged while the other is not — a linked two-track editor story
     * over an untagged Whisper run, or a voice-tagged export beside a single-track story.
     * Reading the flag off the item while reading the text off the branch would eventually
     * describe one transcript's attribution to a model looking at the other.
     */
    speakerTagged: boolean;
  } {
    if (item.contentSource) {
      // Never "if it's non-empty": an empty story transcript is a fault to see, not a
      // reason to silently generate from the ad-carrying final export instead.
      return {
        text: item.contentSource.text,
        origin: item.contentSource.origin,
        speakerTagged: item.contentSource.speakerTagged,
      };
    }
    return {
      text: item.content,
      origin: 'final-export-whisper',
      speakerTagged: item.contentSpeakerTagged === true,
    };
  }

  /**
   * What ONE item was generated from, in the shape the report file stores.
   *
   * Written on BOTH branches (spec §3.5). The unlinked branch is not an absence of a
   * record — it is the record of a declared mode, and it says so with the same fields.
   */
  /**
   * WHY this item took the branch it did, in the vocabulary the report stores.
   *
   * The unlinked branch has three ways in and they are not interchangeable: he declared
   * final-only, he left an item he could have linked unlinked (the default now that
   * linking is optional), or there was never a link to make. Reading them off the item's
   * own recorded declaration keeps this from being a guess made at write time.
   */
  private static declarationOf(item: ContentItem): { declaration: ContentDeclaration; reason: string | null } {
    if (item.contentSource) return { declaration: 'linked', reason: null };
    if (item.finalOnly) {
      return {
        declaration: item.finalOnly.via === 'declared' ? 'final-only-declared' : 'final-only-default',
        reason: item.finalOnly.reason,
      };
    }
    return {
      declaration: 'final-only-unlinkable',
      reason: 'this input had no final export to link an editor story to',
    };
  }

  /**
   * The saved records an item's inputs were read from, or undefined when every one of
   * them was transcribed on this run.
   *
   * Undefined rather than an empty array on the ordinary path: the field's absence is
   * what says "Whisper ran", and an empty array in every report would be noise that a
   * reader has to learn to ignore.
   */
  private static savedTranscriptsOf(items: ContentItem[]): SavedTranscriptReuse[] | undefined {
    const reused = items
      .map((item) => item.savedTranscript)
      .filter((reuse): reuse is SavedTranscriptReuse => !!reuse);
    return reused.length > 0 ? reused : undefined;
  }

  private static itemProvenanceOf(item: ContentItem): ItemProvenance {
    const source = item.contentSource;
    const declared = this.declarationOf(item);
    return {
      content_fields: this.contentTextOf(item).origin,
      saved_transcripts: this.savedTranscriptsOf([item]),
      content_declaration: declared.declaration,
      content_declaration_reason: declared.reason,
      // Structurally constant. See ItemProvenance.timed_fields.
      timed_fields: 'final-export-whisper',
      transcript_ref: source ? source.ref : null,
      final_duration_sec: item.finalDurationSec ?? null,
      // The ref's own duration, not a second reading of the file: `resolveRef` returned
      // 'ok' for this ref, which is precisely the assertion that the file on disk is
      // still the one these numbers were taken from.
      transcript_duration_sec: source ? source.ref.durationSeconds : null,
      drift_sec: source ? source.driftSec : null,
      drift_pct: source ? source.driftPct : null,
      declared_at: new Date().toISOString(),
    };
  }

  /**
   * What a COMPILATION was generated from — one record for N inputs.
   *
   * A compilation has no single source file (its `source_key` is an explicit null for
   * exactly this reason) and therefore no single ref, duration or drift. What it does
   * have is one content origin, and a set whose inputs disagree about that origin has
   * none: rather than pick one and quietly mislabel the other half, this throws, and it
   * is called BEFORE the first model call so the operator finds out in seconds rather
   * than after a full run.
   */
  private static compilationProvenanceOf(items: ContentItem[]): ItemProvenance {
    const linked = items.filter((item) => !!item.contentSource);

    if (linked.length > 0 && linked.length < items.length) {
      const linkedNames = linked.map((i) => i.contentSource!.ref.storyTitle).join(', ');
      throw new Error(
        `This compilation mixes sources: ${linked.length} of ${items.length} inputs are linked ` +
        `to an editor story (${linkedNames}) and the rest are final-export only. One item ` +
        `cannot record two content origins — link every input or none of them.`
      );
    }

    // N inputs, one declaration. Where they disagree the STRONGEST claim wins — an
    // explicit declaration outranks a default, which outranks "there was nothing to
    // link" — and the reason names the mix rather than letting the winner speak for
    // inputs it does not describe.
    const declarations = items.map((item) => this.declarationOf(item));
    const kinds = new Set(declarations.map((d) => d.declaration));
    const rank: ContentDeclaration[] =
      ['linked', 'final-only-declared', 'final-only-default', 'final-only-unlinkable'];
    const declaration = rank.find((k) => kinds.has(k)) || 'final-only-unlinkable';
    const reason = kinds.size > 1
      ? `${items.length} inputs, mixed declarations: ` +
        rank.filter((k) => kinds.has(k))
          .map((k) => `${declarations.filter((d) => d.declaration === k).length} ${k}`)
          .join(', ')
      : declarations[0]?.reason ?? null;

    return {
      content_fields: linked.length > 0 ? 'editor-story-transcript' : 'final-export-whisper',
      // One record per input that reused one. A compilation cannot answer this with a
      // single ref any more than it can answer `transcript_ref` with one, and an omitted
      // answer would read as "all N were transcribed on this run".
      saved_transcripts: this.savedTranscriptsOf(items),
      content_declaration: declaration,
      content_declaration_reason: declaration === 'linked' && kinds.size === 1 ? null : reason,
      timed_fields: 'final-export-whisper',
      transcript_ref: null,
      final_duration_sec: null,
      transcript_duration_sec: null,
      drift_sec: null,
      drift_pct: null,
      declared_at: new Date().toISOString(),
    };
  }

  private static itemSourceOf(item: ContentItem): ItemSource {
    if (item.contentType === 'subject') {
      return { source_key: null, source_path: null };
    }
    if (!item.source || !item.source.trim()) {
      throw new Error(
        `Content item of type ${item.contentType} has no source path — cannot record its source key.`
      );
    }
    return { source_key: sourceKeyOf(item.source), source_path: item.source };
  }

  /**
   * Get clean title from content item
   */
  private static getCleanTitle(item: ContentItem): string {
    // Prefer an explicit title (e.g. an imported story title) over the filename.
    if (item.title && item.title.trim()) {
      return item.title.trim();
    }

    if (item.source) {
      // Extract filename without extension - handle both Windows and Unix paths
      const basename = item.source.split(/[/\\]/).pop() || item.source;
      return basename.replace(/\.[^/.]+$/, ''); // Remove extension
    }

    // For subjects, use first 50 chars
    return item.content.slice(0, 50).replace(/\s+/g, ' ').trim();
  }

  /**
   * Generate job name from content items
   */
  private static generateJobName(items: ContentItem[]): string {
    if (items.length === 0) {
      return 'Untitled Job';
    }

    if (items.length === 1) {
      return this.getCleanTitle(items[0]);
    }

    const firstName = this.getCleanTitle(items[0]);
    return `${firstName} + ${items.length - 1} more`;
  }
}
