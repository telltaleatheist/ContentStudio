/**
 * Metadata Generator Service
 * Main orchestrator for metadata generation workflow
 * Replaces the Python metadata_generator.py
 */

import { AIManagerService, AIConfig, MetadataResult } from './ai-manager.service';
import { WhisperService } from './whisper.service';
import { InputHandlerService, ContentItem } from './input-handler.service';
import { ChapterMapper, AIChapter, buildTimestampedTranscript, sampleSegmentsToBudget } from './chapter-generator.service';
import { OutputHandlerService, SaveJobResult } from './output-handler.service';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';
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
  aiHost?: string;
  outputPath?: string;
  promptSet?: string;
  promptSetsDir?: string;
  jobId?: string;
  jobName?: string;
  // Pre-resolved "CHANNEL PERFORMANCE DATA" block from the analytics feedback
  // loop (appended to the metadata prompt); undefined = omit (expected state).
  insightsBlock?: string;
  chapterFlags?: { [key: string]: boolean };
  inputNotes?: { [key: string]: string };
  preTranscribedContent?: ContentItem[]; // Pre-transcribed content from pipeline (skips transcription phase)
  inputWarnings?: string[]; // Input-stage failures from the pipeline (surfaced in result.warnings)
  progressCallback?: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void;
  cancelCallback?: () => boolean; // Returns true if job should be cancelled
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
}

export class MetadataGeneratorService {
  /**
   * Generate metadata for inputs
   */
  static async generate(params: GenerationParams): Promise<GenerationResult> {
    const startTime = Date.now();

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
        host: params.aiHost,
        promptSet: params.promptSet,
        promptSetsDir: params.promptSetsDir,
        insightsBlock: params.insightsBlock,
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

      // Check for cancellation after input processing
      if (params.cancelCallback && params.cancelCallback()) {
        log.info('[MetadataGenerator] Job cancelled after input processing');
        return {
          success: false,
          error: 'Job cancelled by user',
        };
      }

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
      const outputHandler = new OutputHandlerService(outputPath);
      const jobName = params.jobName || this.generateJobName(contentItems);

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

      console.log(`[MetadataGenerator] Job initialized: ${jobInfo.jobId}`);

      // Generate metadata based on mode
      const metadataItems: MetadataResult[] = [];
      // Partial failures / dropped-content notices, seeded with input-stage skips
      const warnings: string[] = [...inputFailures];
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
          // Check for cancellation before each (potentially long) summarization
          if (params.cancelCallback && params.cancelCallback()) {
            console.log(`[MetadataGenerator] Job cancelled while summarizing item ${i + 1}/${contentItems.length}`);
            outputHandler.updateJobStatus(jobInfo.jobId, 'cancelled');
            return {
              success: false,
              error: 'Job cancelled by user',
            };
          }

          const item = contentItems[i];
          const sourceLabel = item.source || `Item ${i + 1}`;
          console.log(`[MetadataGenerator] Summarizing compilation item ${i + 1}/${contentItems.length}: ${sourceLabel}`);
          // Always condense compilation items — their outputs get joined into one prompt
          const itemSummary = await aiManager.summarizeTranscript(item.content, sourceLabel, { forceCondense: true });
          itemSummaries.push(`ITEM ${i + 1} (${sourceLabel}):\n${itemSummary}`);
        }

        // Recombine summaries with ITEM labels intact
        const summary = itemSummaries.join('\n\n');

        // Check for cancellation before the final (long) metadata generation
        if (params.cancelCallback && params.cancelCallback()) {
          console.log('[MetadataGenerator] Job cancelled before compilation metadata generation');
          outputHandler.updateJobStatus(jobInfo.jobId, 'cancelled');
          return {
            success: false,
            error: 'Job cancelled by user',
          };
        }

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

        // Save compilation result
        const saveResult = await outputHandler.addItemToJob(jobInfo.jobId, metadata);
        console.log(`[MetadataGenerator] Saved compilation to: ${saveResult.txtPath}`);

        params.progressCallback?.('generating', 'Compilation complete', 100);
        metadataItems.push(metadata);

      } else {
        // INDIVIDUAL MODE: Process each item separately
        console.log('[MetadataGenerator] Individual mode: processing items separately');

        for (let i = 0; i < contentItems.length; i++) {
        // Check for cancellation before each item
        if (params.cancelCallback && params.cancelCallback()) {
          console.log(`[MetadataGenerator] Job cancelled at item ${i + 1}/${contentItems.length}`);
          outputHandler.updateJobStatus(jobInfo.jobId, 'cancelled');
          return {
            success: false,
            error: 'Job cancelled by user',
          };
        }

        const item = contentItems[i];
        console.log(`[MetadataGenerator] Generating metadata ${i + 1}/${contentItems.length}`);

        try {
          // Summarize transcript and generate metadata - both under 'generating' phase
          console.log(`[MetadataGenerator] Sending generating phase: Analyzing content for item ${i}`);
          params.progressCallback?.('generating', `Analyzing content ${i + 1}/${contentItems.length}...`, 0, undefined, i);
          const summary = await aiManager.summarizeTranscript(
            item.content,
            item.source || `item_${i + 1}`
          );

          console.log(`[MetadataGenerator] Sending generating phase: Generating metadata for item ${i}`);
          params.progressCallback?.('generating', `Generating metadata ${i + 1}/${contentItems.length}...`, 50, undefined, i);

          // Check if chapters should be generated
          const shouldGenerateChapters = params.chapterFlags?.[item.source || ''] || false;

          const metadata = await aiManager.generateMetadata(summary, item.source || `item_${i + 1}`);

          // Add title and source info
          (metadata as any)._title = this.getCleanTitle(item);
          (metadata as any)._prompt_set = params.promptSet;

          if (shouldGenerateChapters) {
            const chapterLabel = item.source || `item_${i + 1}`;

            if (item.srtSegments && item.srtSegments.length > 0) {
              console.log('[MetadataGenerator] Generating chapters...');
              console.log(`[MetadataGenerator] Sending generating phase: Generating chapters for item ${i}`);
              params.progressCallback?.('generating', 'Generating chapters...', 75, undefined, i);

              try {
                const chapters = await this.generateChapters(item, aiManager);
                if (chapters && chapters.length >= 3) {
                  metadata.chapters = chapters;
                  console.log(`[MetadataGenerator] Generated ${chapters.length} chapters`);
                } else {
                  // <3 chapters are dropped (YouTube requires at least 3). Don't let
                  // that vanish silently when the user explicitly asked for chapters.
                  const found = chapters ? chapters.length : 0;
                  const msg = `${chapterLabel}: chapters were requested but only ${found} chapter(s) were found (YouTube requires at least 3), so none were added`;
                  console.warn(`[MetadataGenerator] ${msg}`);
                  warnings.push(msg);
                }
              } catch (error) {
                const errMsg = error instanceof Error ? error.message : String(error);
                const msg = `${chapterLabel}: chapter generation failed: ${errMsg}`;
                console.error(`[MetadataGenerator] ${msg}`);
                warnings.push(msg);
                // Continue without chapters
              }
            } else {
              // Chapters need a timestamped transcript (SRT segments); a subject or
              // plain transcript file has none, so report why they were skipped.
              const msg = `${chapterLabel}: chapters were requested but no timestamped transcript was available to generate them`;
              console.warn(`[MetadataGenerator] ${msg}`);
              warnings.push(msg);
            }
          }

          // Save this item to the job immediately
          const saveResult = await outputHandler.addItemToJob(jobInfo.jobId, metadata);
          console.log(`[MetadataGenerator] Saved metadata to: ${saveResult.txtPath}`);

          // Mark this item as complete
          console.log(`[MetadataGenerator] Sending generating phase: Completed for item ${i}`);
          params.progressCallback?.('generating', `Completed ${i + 1}/${contentItems.length}`, 100, undefined, i);
          metadataItems.push(metadata);
        } catch (error) {
          const errMsg = error instanceof Error ? error.message : String(error);
          const sourceLabel = item.source || `item_${i + 1}`;
          log.error(`[MetadataGenerator] Failed to generate metadata for item ${i + 1}:`, error);
          console.error(`[MetadataGenerator] Failed to generate metadata for item ${i + 1}:`, error);
          // Record the partial failure so the caller can surface it instead of
          // silently returning success with a missing item.
          warnings.push(`${sourceLabel}: ${errMsg}`);
          // Continue with other items
        }
      }
      } // End of individual mode else block

      if (metadataItems.length === 0) {
        // Update job status to failed
        outputHandler.updateJobStatus(jobInfo.jobId, 'failed');
        return {
          success: false,
          error: 'Failed to generate metadata for any items',
          warnings: warnings.length > 0 ? warnings : undefined,
        };
      }

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
   * Generate chapters for a content item using phrase-based timestamp mapping
   */
  private static async generateChapters(
    item: ContentItem,
    aiManager: AIManagerService
  ): Promise<any[]> {
    if (!item.srtSegments || item.srtSegments.length === 0) {
      return [];
    }

    // Sample the transcript to the provider's budget instead of chunking:
    // the model keeps a global view of the WHOLE video in one request, and
    // because sampling keeps whole segments verbatim, every quoted start_phrase
    // still maps back to the full SRT.
    const budget = aiManager.getChapterTranscriptBudgetChars();
    const sampledSegments = sampleSegmentsToBudget(item.srtSegments, budget);

    if (sampledSegments.length < item.srtSegments.length) {
      log.info(
        `[MetadataGenerator] Sampled transcript for chapters: ${item.srtSegments.length} -> ${sampledSegments.length} segments (budget ${budget} chars)`
      );
    }

    // Build timestamped transcript for AI
    const transcript = buildTimestampedTranscript(sampledSegments);

    if (!transcript || transcript.length === 0) {
      return [];
    }

    const allAiChapters = await this.processTranscriptChunk(transcript, aiManager);

    if (allAiChapters.length === 0) {
      return [];
    }

    // Map phrases to timestamps against the FULL segment list
    const mapper = new ChapterMapper(item.srtSegments);
    return mapper.mapChapters(allAiChapters);
  }

  /**
   * Process a single transcript chunk for chapter detection
   */
  private static async processTranscriptChunk(
    transcript: string,
    aiManager: AIManagerService
  ): Promise<AIChapter[]> {
    const prompt = formatPrompt(SYSTEM_PROMPTS.CHAPTER_DETECTION_PROMPT, {
      transcript: transcript,
    });

    const response = await (aiManager as any).makeRequest(prompt, (aiManager as any).metadataModel);

    if (!response) {
      return [];
    }

    return this.parseChaptersFromAI(response);
  }

  /**
   * Parse chapters from AI response (expects {chapters: [...]} format)
   */
  private static parseChaptersFromAI(response: string): AIChapter[] {
    try {
      // Clean up response - remove markdown code blocks if present
      let cleanResponse = response.trim();
      if (cleanResponse.startsWith('```')) {
        const lines = cleanResponse.split('\n');
        cleanResponse = lines
          .filter((l) => !l.startsWith('```'))
          .join('\n');
      }

      // Try to extract JSON object from response
      const jsonMatch = cleanResponse.match(/\{[\s\S]*\}/);
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0]);
        if (parsed.chapters && Array.isArray(parsed.chapters)) {
          return parsed.chapters;
        }
      }

      // Fallback: try to extract JSON array directly
      const arrayMatch = cleanResponse.match(/\[[\s\S]*\]/);
      if (arrayMatch) {
        return JSON.parse(arrayMatch[0]);
      }

      return [];
    } catch (error) {
      console.error('[MetadataGenerator] Failed to parse AI chapters:', error);
      return [];
    }
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
