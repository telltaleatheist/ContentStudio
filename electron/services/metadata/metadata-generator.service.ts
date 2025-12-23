/**
 * Metadata Generator Service
 * Main orchestrator for metadata generation workflow
 * Replaces the Python metadata_generator.py
 */

import { AIManagerService, AIConfig, MetadataResult } from './ai-manager.service';
import { WhisperService } from './whisper.service';
import { InputHandlerService, ContentItem } from './input-handler.service';
import { ChapterMapper, AIChapter, buildTimestampedTranscript } from './chapter-generator.service';
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
  chapterFlags?: { [key: string]: boolean };
  inputNotes?: { [key: string]: string };
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
      };

      const aiManager = new AIManagerService(aiConfig);
      const initialized = await aiManager.initialize();

      if (!initialized) {
        return {
          success: false,
          error: 'Failed to initialize AI manager',
        };
      }

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

      const customNotesMap = new Map(Object.entries(params.inputNotes || {}));
      const contentItems = await inputHandler.processMultipleInputs(normalizedInputs, customNotesMap);

      // Check for cancellation after input processing
      if (params.cancelCallback && params.cancelCallback()) {
        console.log('[MetadataGenerator] Job cancelled after input processing');
        return {
          success: false,
          error: 'Job cancelled by user',
        };
      }

      if (contentItems.length === 0) {
        return {
          success: false,
          error: 'No content could be processed',
        };
      }

      console.log(`[MetadataGenerator] Processed ${contentItems.length} content items`);

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

      console.log(`[MetadataGenerator] Job initialized: ${jobInfo.jobId}`);

      // Generate metadata based on mode
      const metadataItems: MetadataResult[] = [];
      const mode = params.mode || 'individual';
      console.log(`[MetadataGenerator] Processing mode: ${mode}`);

      if (mode === 'compilation') {
        // COMPILATION MODE: Combine all content and generate single metadata
        console.log('[MetadataGenerator] Compilation mode: combining all content');

        // Determine content types for compilation context
        const contentTypes = contentItems.map(item => item.contentType);
        const uniqueContentTypes = Array.from(new Set(contentTypes));

        // Combine all content with numbered ITEM format (for bulleted description ordering)
        const combinedContent = contentItems.map((item, idx) => {
          const sourceLabel = item.source || `Item ${idx + 1}`;
          return `ITEM ${idx + 1} (${sourceLabel}):\n${item.content}`;
        }).join('\n\n');

        // Summarize combined content
        params.progressCallback?.('generating', 'Analyzing combined content...', 0);
        const summary = await aiManager.summarizeTranscript(combinedContent, jobName);

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
        const saveResult = outputHandler.addItemToJob(jobInfo.jobId, metadata);
        if (saveResult) {
          console.log(`[MetadataGenerator] Saved compilation to: ${saveResult.txtPath}`);
        }

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

          if (shouldGenerateChapters && item.srtSegments && item.srtSegments.length > 0) {
            console.log('[MetadataGenerator] Generating chapters...');
            console.log(`[MetadataGenerator] Sending generating phase: Generating chapters for item ${i}`);
            params.progressCallback?.('generating', 'Generating chapters...', 75, undefined, i);

            try {
              const chapters = await this.generateChapters(item, aiManager);
              if (chapters && chapters.length >= 3) {
                metadata.chapters = chapters;
                console.log(`[MetadataGenerator] Generated ${chapters.length} chapters`);
              }
            } catch (error) {
              console.error('[MetadataGenerator] Chapter generation failed:', error);
              // Continue without chapters
            }
          }

          // Save this item to the job immediately
          const saveResult = outputHandler.addItemToJob(jobInfo.jobId, metadata);
          if (saveResult) {
            console.log(`[MetadataGenerator] Saved metadata to: ${saveResult.txtPath}`);
          }

          // Mark this item as complete
          console.log(`[MetadataGenerator] Sending generating phase: Completed for item ${i}`);
          params.progressCallback?.('generating', `Completed ${i + 1}/${contentItems.length}`, 100, undefined, i);
          metadataItems.push(metadata);
        } catch (error) {
          log.error(`[MetadataGenerator] Failed to generate metadata for item ${i + 1}:`, error);
          console.error(`[MetadataGenerator] Failed to generate metadata for item ${i + 1}:`, error);
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

    // Build timestamped transcript for AI
    const transcript = buildTimestampedTranscript(item.srtSegments);

    if (!transcript || transcript.length === 0) {
      return [];
    }

    // Limit transcript length to avoid token limits (keep ~30k chars)
    const limitedTranscript = transcript.substring(0, 30000);

    // Ask AI to identify chapter points using phrase-based approach
    const prompt = formatPrompt(SYSTEM_PROMPTS.CHAPTER_DETECTION_PROMPT, {
      transcript: limitedTranscript,
    });

    const response = await (aiManager as any).makeRequest(prompt, (aiManager as any).metadataModel);

    if (!response) {
      return [];
    }

    // Parse response
    const aiChapters = this.parseChaptersFromAI(response);
    if (aiChapters.length === 0) {
      return [];
    }

    // Map phrases to timestamps
    const mapper = new ChapterMapper(item.srtSegments);
    return mapper.mapChapters(aiChapters);
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
