/**
 * Metadata Generator Service
 * Main orchestrator for metadata generation workflow
 * Replaces the Python metadata_generator.py
 */

import { AIManagerService, AIConfig, MetadataResult } from './ai-manager.service';
import { WhisperService } from './whisper.service';
import { InputHandlerService, ContentItem } from './input-handler.service';
import { Chapter } from './chapter-generator.service';
import { ChapterPipelineService, ChapterStage, ChapterPipelineResult } from './chapter-pipeline.service';
import { ChapterSingleCallService } from './chapter-single-call.service';
import { OutputHandlerService } from './output-handler.service';
import { ItemSource, sourceKeyOf } from './item-identity';
import {
  MetadataTaskRun,
  buildTaskPromptsForDisplay,
  planMetadataUnits,
  runMetadataTasks,
} from './metadata-tasks';
import {
  CHAPTERS_SINGLE_CALL_OPTION_ID,
  MetadataRoutingSelections,
  ResolvedMetadataRouting,
  resolveMetadataRouting,
  routingOption,
} from './metadata-routing';
import { excludePromoChapters } from './promo-chapters';
import { JobCancelledError } from './cancellation';
import type { TranscriptRef } from '../publish/publish-types';
import { queueAITask } from '../queue-manager.service';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';

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
  chapterFlags?: { [key: string]: boolean };
  /**
   * The operator's Phase-2 link decision per input, keyed by the input's absolute path —
   * the same key `chapterFlags` uses. A `TranscriptRef` means "the content fields should
   * come from this editor story"; an explicit `null` means "final export only", which is
   * a declared mode rather than a default (spec §3.2).
   *
   * CARRIED, NOT CONSUMED. Nothing in this service reads it: `summarizeTranscript` still
   * reads `item.content` and the chapter pipeline still reads `item.srtSegments` only.
   * It is threaded now so PR 5's split has the choice already in hand, and so a queued job
   * carries the decision the operator made when he queued it.
   */
  inputTranscripts?: { [key: string]: TranscriptRef | null };
  /**
   * Per-task model routing, as stored in the `metadataRouting` setting (taskId ->
   * optionId, see metadata-routing.ts). Resolved against the registry here, so an absent
   * key means "the shipped defaults" and a bad one fails the job naming the task.
   *
   * This is the ONLY input that decides which model writes which field, including the
   * chapter pipeline's.
   */
  metadataRouting?: MetadataRoutingSelections;
  /** Optional per-stage overrides, e.g. running stages 2/4/5 on a different rater. */
  chapterStageModels?: Partial<Record<ChapterStage, string>>;
  /** Chapter-pipeline context window. One value for the whole run (Ollama reloads on change). */
  chapterNumCtx?: number;
  /**
   * Chapters already produced for these sources (keyed by source label), so a run
   * doesn't repeat the pipeline. This is what makes "Show prompt" honest: that flow
   * has to run the chapters to assemble the real prompt, and "Send to AI" then reuses
   * the SAME chapters rather than re-deriving a possibly different set.
   */
  preComputedChapters?: { [sourceLabel: string]: ChapterPipelineResult };
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
 * `chaptersSkipped` is set on EVERY path that leaves the item without a published chapter
 * list after the user asked for one, and it is what makes that visible in the saved report
 * rather than only in the run's warnings. Absent when chapters were never requested — a
 * report with no chapters and no explanation is correct in that case.
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

      // Pass progress callback to inputHandler so it can send 'preparing' events
      const inputHandler = new InputHandlerService(whisperService, params.progressCallback);

      // Initialize AI Manager
      const aiConfig: AIConfig = {
        provider: params.aiProvider,
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
        log.info('[MetadataGenerator] Processing inputs...');
        contentItems = await inputHandler.processMultipleInputs(normalizedInputs, customNotesMap, inputFailures);
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
        log.info(`[MetadataGenerator]   Item ${idx + 1}: type=${item.contentType}, content=${item.content.substring(0, 100)}...`);
      });

      // Initialize job and output handler
      const outputPath = params.outputPath || this.getDefaultOutputPath();
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
            const itemSummary = await aiManager.summarizeTranscript(item.content, sourceLabel, { forceCondense: true });
            itemSummaries.push(`ITEM ${i + 1} (${sourceLabel}):\n${itemSummary}`);
          }
          const summary = itemSummaries.join('\n\n');

          prompts.push(aiManager.buildMetadataPrompt(summary, jobName, {
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
              params,
              i,
              contentItems.length,
              params.chapterFlags?.[item.source || ''] || false,
              warnings,
              computedChapters
            );

            this.throwIfCancelled(params, `before summarizing ${sourceLabel} for the prompt`);
            params.progressCallback?.('generating', 'Assembling prompt...', 80, undefined, i);
            const summary = await aiManager.summarizeTranscript(item.content, sourceLabel);

            // Same mode decision the real run makes, so the user reads the prompts that
            // will actually be sent — three labelled task prompts when chapters exist,
            // the one whole-metadata prompt when they don't.
            const taskRun = this.resolveTaskRun(aiManager, params, sourceLabel, summary, subjects, details);
            if (taskRun) {
              prompts.push(...buildTaskPromptsForDisplay(taskRun));
            } else {
              prompts.push(aiManager.buildMetadataPrompt(summary, sourceLabel, undefined, subjects, details));
            }
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

      // Initialize the job (creates job metadata file with empty items)
      const jobInfo = outputHandler.initializeJob(
        jobName,
        params.promptSet || 'sample-youtube',
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
          const itemSummary = await aiManager.summarizeTranscript(item.content, sourceLabel, { forceCondense: true });
          itemSummaries.push(`ITEM ${i + 1} (${sourceLabel}):\n${itemSummary}`);
        }

        // Recombine summaries with ITEM labels intact
        const summary = itemSummaries.join('\n\n');

        // Checked before the final (long) metadata generation
        this.throwIfCancelled(params, 'before compilation metadata generation');

        // Generate single metadata for compilation with hardcoded compilation instructions
        params.progressCallback?.('generating', 'Generating metadata for compilation...', 50);
        const metadata = await aiManager.generateMetadata(
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

        // Save compilation result. A compilation has no single source, so its source_key
        // is an explicit null rather than the first input's: the key exists to answer
        // "is this the same video, generated again?", and a set of N inputs cannot
        // answer it. `_is_compilation` on the item says which kind of item this is.
        const compilationSource: ItemSource = { source_key: null, source_path: null };
        const saveResult = await outputHandler.addItemToJob(jobInfo.jobId, metadata, compilationSource);
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

        try {
          const sourceLabel = item.source || `item_${i + 1}`;
          const shouldGenerateChapters = params.chapterFlags?.[item.source || ''] || false;

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
            params,
            i,
            contentItems.length,
            shouldGenerateChapters,
            warnings,
            computedChapters
          );

          // ---- Everything else, conditioned on those chapters -----------------
          this.throwIfCancelled(params, `before summarizing ${sourceLabel}`);
          console.log(`[MetadataGenerator] Sending generating phase: Analyzing content for item ${i}`);
          params.progressCallback?.('generating', `Analyzing content ${i + 1}/${contentItems.length}...`, 60, undefined, i);
          const summary = await aiManager.summarizeTranscript(item.content, sourceLabel);

          this.throwIfCancelled(params, `before generating metadata for ${sourceLabel}`);
          console.log(`[MetadataGenerator] Sending generating phase: Generating metadata for item ${i}`);
          params.progressCallback?.('generating', `Generating metadata ${i + 1}/${contentItems.length}...`, 80, undefined, i);

          // Chapters decide the SHAPE of this call, not just its contents: with a chapter
          // list the fields are generated as separate task units (metadata-tasks.ts),
          // without one they come back from the single legacy call.
          const taskRun = this.resolveTaskRun(aiManager, params, sourceLabel, summary, chapterSubjects, chapterDetails);
          const metadata = taskRun
            ? await runMetadataTasks(aiManager, taskRun)
            : await aiManager.generateMetadata(summary, sourceLabel, undefined, chapterSubjects, chapterDetails);

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
          const saveResult = await outputHandler.addItemToJob(jobInfo.jobId, metadata, this.itemSourceOf(item));
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
   * Decide whether this item's metadata is generated as separate task units, and set up
   * the run if it is. Returns undefined for the legacy single call.
   *
   * The condition is chapters, and only chapters. The description and tags units are
   * conditioned on the chapter subject list INSTEAD of the transcript — the conditioning
   * their local adapters will get — so without a chapter list they would have nothing to
   * work from. Compilations, podcast prompt sets, shorts and any run whose chapter
   * pipeline came back short all land here with no subjects and take the single call.
   *
   * This is a mode decision made and logged from what the run actually has, not a
   * recovery: an item never silently splits without chapters, and never silently merges
   * back with them.
   */
  private static resolveTaskRun(
    aiManager: AIManagerService,
    params: GenerationParams,
    sourceLabel: string,
    summary: string,
    chapterSubjects?: string[],
    chapterDetails?: string[]
  ): MetadataTaskRun | undefined {
    if (!chapterSubjects || chapterSubjects.length === 0) {
      console.log(`[MetadataGenerator] ${sourceLabel}: no chapter subjects — one call generates every field (legacy path)`);
      return undefined;
    }

    const plan = planMetadataUnits(
      this.routing(params),
      params.aiHost || 'http://localhost:11434',
      aiManager,
      Boolean(params.insightsBlock),
      params.cancelSignal
    );
    console.log(
      `[MetadataGenerator] ${sourceLabel}: ${chapterSubjects.length} chapter subjects — ` +
        `${plan.units.length} unit(s): ${plan.summary}`
    );
    if (plan.hashtagsOwnedByDescription) {
      console.log(
        `[MetadataGenerator] ${sourceLabel}: hashtags come from the description adapter; ` +
          `no cloud group will request them`
      );
    }

    return {
      plan,
      ctx: {
        content: summary,
        sourceLabel,
        chapterSubjects,
        chapterDetails: chapterDetails || [],
      },
    };
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
    params: GenerationParams,
    itemIndex: number,
    itemCount: number,
    requested: boolean,
    warnings: string[],
    sink?: { [sourceLabel: string]: ChapterPipelineResult }
  ): Promise<ChapterOutcome> {
    const sourceLabel = item.source || `item_${itemIndex + 1}`;
    if (!requested) {
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

    if (!item.srtSegments || item.srtSegments.length === 0) {
      // Chapters need a timestamped transcript (SRT segments); a subject or plain
      // transcript file has none, so report why they were skipped.
      const msg = `${sourceLabel}: chapters were requested but no timestamped transcript was available to generate them, so the rest of the metadata was generated WITHOUT chapter subjects`;
      console.warn(`[MetadataGenerator] ${msg}`);
      warnings.push(msg);
      return { chaptersSkipped: { outcome: 'skipped', reason: 'No timestamped transcript (SRT segments) was available, so the chapter pipeline never ran.' } };
    }

    this.throwIfCancelled(params, `before the chapter pipeline for ${sourceLabel}`);
    console.log(`[MetadataGenerator] Generating chapters for item ${itemIndex} (before metadata)...`);
    params.progressCallback?.('generating', `Finding chapters ${itemIndex + 1}/${itemCount}...`, 0, undefined, itemIndex);

    try {
      const result = await this.generateChapters(item, params, itemIndex, itemCount);

      // Degradations the pipeline recovered from rather than threw on. Surfaced even
      // when the chapters below are then dropped for being too few — the user asked
      // for chapters and is entitled to know what happened to them.
      for (const warning of result.warnings || []) {
        console.warn(`[MetadataGenerator] ${sourceLabel}: ${warning}`);
        warnings.push(`${sourceLabel}: ${warning}`);
      }

      if (result.chapters.length < 3) {
        // <3 chapters are dropped (YouTube requires at least 3). Don't let that vanish
        // silently when the user explicitly asked for chapters.
        const msg = `${sourceLabel}: chapters were requested but only ${result.chapters.length} chapter(s) were found (YouTube requires at least 3), so none were added and the rest of the metadata was generated WITHOUT chapter subjects`;
        console.warn(`[MetadataGenerator] ${msg}`);
        warnings.push(msg);
        return {
          chaptersSkipped: {
            outcome: 'skipped',
            reason: `Only ${result.chapters.length} chapter(s) were found, and YouTube requires at least 3, so none were kept.`,
          },
        };
      }

      console.log(
        `[MetadataGenerator] Generated ${result.chapters.length} chapters in ${result.stats.calls} model calls ` +
          `(stage 4 ${result.stats.speakerTagged ? 'speaker-tagged' : 'untagged'}, ` +
          `${result.stats.approxStarts} approximate start(s))`
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
   * Generate chapters — with the sealed 14B pipeline (CHAPTERING.md), or, when the
   * routing says so, with the 27B single call.
   *
   * The pipeline replaced a single "here is the whole video, give me the chapters" call.
   * That shape cannot work on a 14B: asked to pick K boundaries out of N candidates it
   * returns the first few and stops, which produces mega-chapters and lost stories.
   * The pipeline asks one local question at a time and does the selection in code.
   *
   * The single-call option (2026-08-21) is that shape brought back for one model class
   * that measurably does not fail this way, fenced by a code-enforced budget and quote
   * resolution. It is opt-in and never a recovery path: if it fails validation the
   * chapter stage fails, and resolveChapters records `chaptersSkipped` exactly as it does
   * for any other chapter failure. It does NOT retry and it does NOT drop back here.
   *
   * The WHOLE run holds the single AI queue slot rather than queueing each of its
   * hundreds of calls separately: the method requires one model resident at a time,
   * and that is exactly what the 1-slot AI pool exists to guarantee.
   */
  private static async generateChapters(
    item: ContentItem,
    params: GenerationParams,
    itemIndex: number,
    itemCount: number
  ) {
    if (!item.srtSegments || item.srtSegments.length === 0) {
      throw new Error('Chapter generation needs a timestamped transcript');
    }

    // The chapter pipeline's model comes from the same routing table as every other
    // field's. It is local by construction — the 'chapters' task offers local options
    // only, because the sealed method makes hundreds of one-question calls per video.
    const routing = this.routing(params);
    const option = routingOption('chapters', routing.chapters);
    const model = option.model;

    const host = option.host || params.aiHost || 'http://localhost:11434';
    const label = item.source || `item_${itemIndex + 1}`;

    // WHICH ARCHITECTURE. Every other chapter option in the routing table names a model
    // for the sealed 5-stage pipeline; this one selects a different code path entirely —
    // ONE call over the whole transcript, validated in code (chapter-single-call.service.ts
    // explains what was measured and what is fenced). Chosen by option id, so the picker
    // is the only place it can be turned on.
    const singleCall = routing.chapters === CHAPTERS_SINGLE_CALL_OPTION_ID;

    // Chapter work is 0-60% of this item's "generating" phase; the metadata call that
    // follows takes it from there. Weighted by the real call counts: labelling and
    // rating are ~2 x (duration/45s) calls, the rest are ~3 x chapter_count.
    //
    // The single-call path has one stage that spans the whole allowance. It reports once
    // at the start and once at the end and says nothing in between — which is what the
    // stall notice below exists for, and on this path a long silence is the normal case
    // rather than a symptom.
    const stageWeights: Record<string, [number, number]> = {
      label: [0, 22],
      rate: [22, 44],
      place: [44, 50],
      summarize: [50, 55],
      consolidate: [55, 60],
      'single-call': [0, 60],
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
      stage: singleCall ? 'single-call' : 'label',
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

    const chapterer = singleCall
      ? new ChapterSingleCallService({
          host,
          model,
          // The single call sizes its own context from the transcript it is about to
          // send; the configured value can only raise that, never lower it below what
          // the prompt needs.
          numCtx: params.chapterNumCtx,
          cancelCallback: params.cancelCallback,
          abortSignal: params.cancelSignal,
          onProgress: reportProgress,
        })
      : new ChapterPipelineService({
          host,
          model,
          stageModels: params.chapterStageModels,
          numCtx: params.chapterNumCtx,
          cancelCallback: params.cancelCallback,
          abortSignal: params.cancelSignal,
          onProgress: reportProgress,
        });

    log.info(
      `[MetadataGenerator] ${singleCall ? 'Single-call chaptering' : 'Chapter pipeline'} starting for ` +
        `${label} on ${model} @ ${host}`
    );

    // The AI pool's default 30-minute watchdog is sized for ONE stalled request. This
    // task is hundreds of short requests in a row: CHAPTERING.md clocks a 2h10m
    // livestream at ~390 calls / ~25 minutes on a 24GB-class GPU, so the default would
    // force-fail legitimate long-form runs on anything slower. 4 hours still backstops
    // a genuinely wedged run.
    const CHAPTER_TASK_TIMEOUT_MS = 4 * 60 * 60 * 1000;

    try {
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

  /**
   * Get default output path
   */
  private static getDefaultOutputPath(): string {
    const os = require('os');
    return path.join(os.homedir(), 'Documents', 'ContentStudio Output');
  }
}
