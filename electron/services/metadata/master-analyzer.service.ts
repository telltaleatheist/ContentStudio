/**
 * Master Analyzer Service
 * Analyzes long-form livestream videos to identify distinct sections/segments
 * Each section can become a separate video subject for metadata generation
 */

import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import { app } from 'electron';

import { WhisperService, SRTSegment } from './whisper.service';
import { AIManagerService, AIConfig } from './ai-manager.service';
import { buildPlainTranscript, findPhraseTimestamp, TimeUtils } from './chapter-generator.service';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';

/**
 * A detected section in the master video
 */
export interface MasterSection {
  startTimestamp: string;      // YouTube format: "1:23:45"
  endTimestamp: string;        // YouTube format
  startSeconds: number;        // For sorting/comparison
  endSeconds: number;
  title: string;               // Section title
  description: string;         // Text summary that becomes the subject
  startPhrase: string;         // Original phrase used for timestamp mapping
}

/**
 * The master report containing all sections
 */
export interface MasterReport {
  masterVideoPath: string;
  masterVideoName: string;
  totalDuration: string;
  totalDurationSeconds: number;
  analyzedAt: string;
  sectionCount: number;
  sections: MasterSection[];
}

/**
 * Result of master analysis
 */
export interface MasterAnalysisResult {
  success: boolean;
  report?: MasterReport;
  reportPath?: string;
  error?: string;
}

/**
 * AI response format for section detection
 */
interface AISectionResponse {
  sections: Array<{
    start_phrase: string;    // Exact phrase for matching to timestamps
    title: string;
    description: string;
  }>;
}

/**
 * Parameters for master analysis
 */
export interface MasterAnalysisParams {
  videoPath: string;
  outputDirectory: string;
  masterPrompt?: string;  // Custom prompt from YAML, if not provided uses default
  aiProvider: string;
  aiModel: string;
  aiApiKey?: string;
  aiHost?: string;
  progressCallback?: (phase: string, message: string, percent?: number) => void;
  cancelCallback?: () => boolean;
}

export class MasterAnalyzerService {
  /**
   * Analyze a master video to identify sections
   */
  static async analyze(params: MasterAnalysisParams): Promise<MasterAnalysisResult> {
    const {
      videoPath,
      outputDirectory,
      masterPrompt,
      aiProvider,
      aiModel,
      aiApiKey,
      aiHost,
      progressCallback,
      cancelCallback,
    } = params;

    log.info(`[MasterAnalyzer] Starting analysis of: ${videoPath}`);

    const sendProgress = (phase: string, message: string, percent?: number) => {
      log.info(`[MasterAnalyzer] Progress: ${phase} - ${message} (${percent}%)`);
      if (progressCallback) {
        progressCallback(phase, message, percent);
      }
    };

    const isCancelled = () => {
      return cancelCallback ? cancelCallback() : false;
    };

    try {
      // Validate input file
      if (!fs.existsSync(videoPath)) {
        return { success: false, error: `Video file not found: ${videoPath}` };
      }

      const videoName = path.basename(videoPath, path.extname(videoPath));

      // Phase 1: Transcribe video (0-50%)
      sendProgress('transcribing', 'Extracting audio from video...', 5);

      if (isCancelled()) {
        return { success: false, error: 'Cancelled by user' };
      }

      const whisperService = new WhisperService();

      // Forward transcription progress
      whisperService.on('progress', (progress) => {
        // Scale whisper progress (0-100) to our range (5-50)
        const scaledPercent = Math.round(5 + (progress.percent * 0.45));
        sendProgress('transcribing', progress.message, scaledPercent);
      });

      const transcriptionResult = await whisperService.transcribeVideo(videoPath);
      const { segments: srtSegments } = transcriptionResult;

      if (!srtSegments || srtSegments.length === 0) {
        return { success: false, error: 'Transcription produced no segments' };
      }

      log.info(`[MasterAnalyzer] Transcription complete: ${srtSegments.length} segments`);

      // Calculate total duration
      const lastSegment = srtSegments[srtSegments.length - 1];
      const totalDurationSeconds = TimeUtils.srtTimeToSeconds(lastSegment.end);
      const totalDuration = TimeUtils.secondsToYoutubeTime(totalDurationSeconds);

      if (isCancelled()) {
        return { success: false, error: 'Cancelled by user' };
      }

      // Phase 2: AI section detection (50-90%)
      sendProgress('analyzing', 'Building transcript...', 52);

      // Build plain transcript (no timestamps)
      // AI returns phrases that we match programmatically to timestamps
      const transcript = buildPlainTranscript(srtSegments);

      sendProgress('analyzing', 'Analyzing transcript for sections...', 55);

      // Initialize AI service
      const aiConfig: AIConfig = {
        provider: aiProvider as 'ollama' | 'openai' | 'claude',
        metadataModel: aiModel,
        summarizationModel: aiModel,
        apiKey: aiApiKey,
        host: aiHost,
      };

      const aiService = new AIManagerService(aiConfig);
      const initialized = await aiService.initialize();

      if (!initialized) {
        return { success: false, error: 'Failed to initialize AI service' };
      }

      // Detect sections using AI
      const sections = await this.detectSections(
        aiService,
        transcript,
        srtSegments,
        totalDurationSeconds,
        masterPrompt,
        (percent) => sendProgress('analyzing', 'Detecting sections...', percent)
      );

      if (isCancelled()) {
        return { success: false, error: 'Cancelled by user' };
      }

      if (sections.length === 0) {
        return { success: false, error: 'No sections detected in the video' };
      }

      log.info(`[MasterAnalyzer] Detected ${sections.length} sections`);

      // Phase 3: Generate report (90-100%)
      sendProgress('generating', 'Generating master report...', 92);

      const report: MasterReport = {
        masterVideoPath: videoPath,
        masterVideoName: videoName,
        totalDuration,
        totalDurationSeconds,
        analyzedAt: new Date().toISOString(),
        sectionCount: sections.length,
        sections,
      };

      // Save report
      const reportPath = await this.saveReport(report, outputDirectory);

      sendProgress('complete', 'Master analysis complete!', 100);

      // Cleanup
      aiService.cleanup();

      return {
        success: true,
        report,
        reportPath,
      };

    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`[MasterAnalyzer] Analysis failed: ${errorMessage}`);
      return { success: false, error: errorMessage };
    }
  }

  // Maximum section duration before splitting (1 hour)
  private static readonly MAX_SECTION_SECONDS = 3600;

  /**
   * Detect sections using AI (with multi-pass for long sections)
   */
  private static async detectSections(
    aiService: AIManagerService,
    transcript: string,
    srtSegments: SRTSegment[],
    totalDurationSeconds: number,
    masterPrompt?: string,
    progressCallback?: (percent: number) => void
  ): Promise<MasterSection[]> {
    // Use provided prompt or fall back to hardcoded default
    let promptTemplate = masterPrompt;
    if (!promptTemplate) {
      log.warn('[MasterAnalyzer] No master prompt provided, using default');
      promptTemplate = SYSTEM_PROMPTS.MASTER_SECTION_DETECTION_PROMPT;
    }

    // Format total duration as human-readable string
    const hours = Math.floor(totalDurationSeconds / 3600);
    const minutes = Math.floor((totalDurationSeconds % 3600) / 60);
    const durationStr = hours > 0
      ? `${hours} hour${hours > 1 ? 's' : ''} ${minutes} minutes`
      : `${minutes} minutes`;

    // Replace placeholders with actual values
    let prompt = promptTemplate.replace('{transcript}', transcript);
    prompt = prompt.replace('{duration}', durationStr);

    if (progressCallback) progressCallback(60);

    // PASS 1: Get initial story boundaries
    log.info('[MasterAnalyzer] Pass 1: Detecting story boundaries...');
    log.info(`[MasterAnalyzer] Transcript length: ${transcript.length} chars`);
    const response = await this.makeAIRequest(aiService, prompt);

    // Log raw AI response for debugging
    log.info('[MasterAnalyzer] Raw AI response:', response?.substring(0, 1000));

    if (progressCallback) progressCallback(70);

    if (!response) {
      log.error('[MasterAnalyzer] No response from AI');
      return [];
    }

    // Parse AI response
    const aiSections = this.parseAIResponse(response);

    if (progressCallback) progressCallback(75);

    // Log parsed sections before mapping
    log.info('[MasterAnalyzer] Parsed AI sections:');
    for (const s of aiSections) {
      log.info(`  - "${s.title}" start_phrase: "${s.start_phrase?.substring(0, 50)}..."`);
    }

    // Map sections to timestamps
    let mappedSections = this.mapSectionsToTimestamps(
      aiSections,
      srtSegments,
      totalDurationSeconds
    );

    // Log mapped sections with timestamps
    log.info('[MasterAnalyzer] Mapped sections with timestamps:');
    for (const s of mappedSections) {
      const duration = Math.round((s.endSeconds - s.startSeconds) / 60);
      log.info(`  - "${s.title}" ${s.startTimestamp} - ${s.endTimestamp} (${duration} min)`);
    }

    if (progressCallback) progressCallback(80);

    // PASS 2: Split any sections over 1 hour
    const longSections = mappedSections.filter(
      s => (s.endSeconds - s.startSeconds) > this.MAX_SECTION_SECONDS
    );

    if (longSections.length > 0) {
      log.info(`[MasterAnalyzer] Pass 2: Found ${longSections.length} sections over 1 hour, splitting...`);

      for (const longSection of longSections) {
        const durationSeconds = longSection.endSeconds - longSection.startSeconds;
        const durationMinutes = Math.round(durationSeconds / 60);
        const numSplits = Math.ceil(durationSeconds / this.MAX_SECTION_SECONDS);

        log.info(`[MasterAnalyzer] Splitting "${longSection.title}" (${durationMinutes} min) into ~${numSplits} parts`);

        // Extract transcript for this section
        let sectionTranscript = this.extractTranscriptRange(
          srtSegments,
          longSection.startSeconds,
          longSection.endSeconds
        );

        // Log transcript size for debugging
        log.info(`[MasterAnalyzer] Section transcript: ${sectionTranscript.length} chars`);

        // If transcript is very long, truncate to avoid token limits (keep ~100k chars max)
        const MAX_TRANSCRIPT_CHARS = 100000;
        if (sectionTranscript.length > MAX_TRANSCRIPT_CHARS) {
          log.warn(`[MasterAnalyzer] Truncating long transcript from ${sectionTranscript.length} to ${MAX_TRANSCRIPT_CHARS} chars`);
          sectionTranscript = sectionTranscript.substring(0, MAX_TRANSCRIPT_CHARS) + '\n[TRANSCRIPT TRUNCATED]';
        }

        // Ask AI for breakpoints within this section
        const subSections = await this.findBreakpoints(
          aiService,
          longSection,
          sectionTranscript,
          srtSegments,
          numSplits
        );

        if (subSections.length > 1) {
          // Remove the original long section and add sub-sections
          mappedSections = mappedSections.filter(s => s !== longSection);
          mappedSections.push(...subSections);
        }
      }

      // Re-sort after adding sub-sections
      mappedSections.sort((a, b) => a.startSeconds - b.startSeconds);

      // Recalculate end times
      for (let i = 0; i < mappedSections.length; i++) {
        if (i < mappedSections.length - 1) {
          mappedSections[i].endSeconds = mappedSections[i + 1].startSeconds;
          mappedSections[i].endTimestamp = TimeUtils.secondsToYoutubeTime(mappedSections[i].endSeconds);
        }
      }

      // Ensure last section ends at video end
      if (mappedSections.length > 0) {
        const lastIndex = mappedSections.length - 1;
        mappedSections[lastIndex].endSeconds = totalDurationSeconds;
        mappedSections[lastIndex].endTimestamp = TimeUtils.secondsToYoutubeTime(totalDurationSeconds);
      }
    }

    if (progressCallback) progressCallback(90);

    return mappedSections;
  }

  /**
   * Extract plain transcript text for a specific time range (no timestamps)
   */
  private static extractTranscriptRange(
    srtSegments: SRTSegment[],
    startSeconds: number,
    endSeconds: number
  ): string {
    const lines: string[] = [];

    for (const segment of srtSegments) {
      const segStart = TimeUtils.srtTimeToSeconds(segment.start);

      // Only include segments within the range
      if (segStart >= startSeconds && segStart < endSeconds) {
        const text = segment.text.trim();
        if (text.length > 0) {
          lines.push(text);
        }
      }
    }

    return lines.join(' ').trim();
  }

  /**
   * Find breakpoints within a long section (Pass 2)
   */
  private static async findBreakpoints(
    aiService: AIManagerService,
    originalSection: MasterSection,
    sectionTranscript: string,
    srtSegments: SRTSegment[],
    numSplits: number
  ): Promise<MasterSection[]> {
    const durationMinutes = Math.round((originalSection.endSeconds - originalSection.startSeconds) / 60);
    const targetMinutes = Math.round(durationMinutes / numSplits);

    // Log first 500 chars of transcript for debugging
    log.info(`[MasterAnalyzer] Pass 2 transcript preview: "${sectionTranscript.substring(0, 500)}..."`);

    const prompt = `Split this ${durationMinutes}-minute transcript into ${numSplits} roughly equal parts of ~${targetMinutes} minutes each.

Find ${numSplits - 1} natural break points: topic shifts, new clips being discussed, argument changes, Q&A moments, or natural pauses.

CRITICAL: Each start_phrase MUST be copied EXACTLY from the transcript - copy-paste 5-8 consecutive words.

Return ONLY valid JSON:
{"sections":[
{"start_phrase":"EXACT 5-8 words from transcript","title":"${originalSection.title} Part 1","description":"brief summary"},
{"start_phrase":"EXACT 5-8 words from transcript","title":"${originalSection.title} Part 2","description":"brief summary"}
]}

Rules:
- start_phrase for Part 1: copy the first 5-8 words of the transcript
- start_phrase for Parts 2-${numSplits}: copy 5-8 words from where each part should begin
- DO NOT paraphrase or modify the text - copy EXACTLY as written
- Keep descriptions under 20 words, no special characters or quotes
- Output valid JSON only, no markdown or extra text

Transcript:
${sectionTranscript}`;

    const response = await this.makeAIRequest(aiService, prompt);

    if (!response) {
      log.warn('[MasterAnalyzer] No response for breakpoints, keeping original section');
      return [originalSection];
    }

    // Log raw response for debugging
    log.info(`[MasterAnalyzer] Pass 2 raw AI response: ${response.substring(0, 1000)}...`);

    const aiSections = this.parseAIResponse(response);

    log.info(`[MasterAnalyzer] Pass 2 parsed ${aiSections.length} sections`);
    for (const s of aiSections) {
      log.info(`[MasterAnalyzer] Pass 2 section: "${s.title}" - phrase: "${s.start_phrase?.substring(0, 50)}..."`);
    }

    if (aiSections.length < 2) {
      log.warn('[MasterAnalyzer] Not enough breakpoints found, keeping original section');
      return [originalSection];
    }

    // Map the sub-sections to timestamps
    const subSections: MasterSection[] = [];
    let matchedCount = 0;
    let failedPhrases: string[] = [];

    for (let i = 0; i < aiSections.length; i++) {
      const section = aiSections[i];
      const startPhrase = section.start_phrase || '';
      const title = section.title?.trim() || `${originalSection.title} Part ${i + 1}`;
      const description = section.description?.trim() || '';

      // Find timestamp for start phrase
      let startSeconds = findPhraseTimestamp(startPhrase, srtSegments);

      // First sub-section should start at original section's start
      if (i === 0 && (startSeconds === null || startSeconds < originalSection.startSeconds)) {
        log.info(`[MasterAnalyzer] Part 1 using section start: ${originalSection.startSeconds}s`);
        startSeconds = originalSection.startSeconds;
      }

      if (startSeconds === null) {
        log.warn(`[MasterAnalyzer] Could not find timestamp for sub-section ${i + 1}: "${startPhrase}"`);
        failedPhrases.push(startPhrase);
        continue;
      }

      log.info(`[MasterAnalyzer] Matched Part ${i + 1}: "${startPhrase.substring(0, 40)}..." → ${TimeUtils.secondsToYoutubeTime(startSeconds)}`);
      matchedCount++;

      // End time will be recalculated after sorting
      subSections.push({
        startTimestamp: TimeUtils.secondsToYoutubeTime(startSeconds),
        endTimestamp: TimeUtils.secondsToYoutubeTime(originalSection.endSeconds),
        startSeconds,
        endSeconds: originalSection.endSeconds,
        title,
        description,
        startPhrase,
      });
    }

    log.info(`[MasterAnalyzer] Pass 2 phrase matching: ${matchedCount}/${aiSections.length} succeeded`);

    if (subSections.length < 2) {
      log.warn(`[MasterAnalyzer] Not enough valid sub-sections (${subSections.length}), using time-based fallback`);

      // Fallback: split evenly by time
      return this.createTimeBasedSplits(originalSection, numSplits);
    }

    // Sort sub-sections
    subSections.sort((a, b) => a.startSeconds - b.startSeconds);

    // Recalculate end times
    for (let i = 0; i < subSections.length; i++) {
      if (i < subSections.length - 1) {
        subSections[i].endSeconds = subSections[i + 1].startSeconds;
        subSections[i].endTimestamp = TimeUtils.secondsToYoutubeTime(subSections[i].endSeconds);
      } else {
        subSections[i].endSeconds = originalSection.endSeconds;
        subSections[i].endTimestamp = TimeUtils.secondsToYoutubeTime(originalSection.endSeconds);
      }
    }

    log.info(`[MasterAnalyzer] Split "${originalSection.title}" into ${subSections.length} parts`);
    return subSections;
  }

  /**
   * Create time-based splits when phrase matching fails (fallback)
   */
  private static createTimeBasedSplits(
    originalSection: MasterSection,
    numSplits: number
  ): MasterSection[] {
    log.info(`[MasterAnalyzer] Creating ${numSplits} time-based splits for "${originalSection.title}"`);

    const totalDuration = originalSection.endSeconds - originalSection.startSeconds;
    const partDuration = totalDuration / numSplits;
    const subSections: MasterSection[] = [];

    for (let i = 0; i < numSplits; i++) {
      const startSeconds = originalSection.startSeconds + (i * partDuration);
      const endSeconds = i === numSplits - 1
        ? originalSection.endSeconds
        : originalSection.startSeconds + ((i + 1) * partDuration);

      subSections.push({
        startTimestamp: TimeUtils.secondsToYoutubeTime(startSeconds),
        endTimestamp: TimeUtils.secondsToYoutubeTime(endSeconds),
        startSeconds,
        endSeconds,
        title: `${originalSection.title} Part ${i + 1}`,
        description: `Part ${i + 1} of ${numSplits} (auto-split by time)`,
        startPhrase: `[time-based split at ${TimeUtils.secondsToYoutubeTime(startSeconds)}]`,
      });

      log.info(`[MasterAnalyzer] Time-split Part ${i + 1}: ${TimeUtils.secondsToYoutubeTime(startSeconds)} - ${TimeUtils.secondsToYoutubeTime(endSeconds)}`);
    }

    return subSections;
  }

  /**
   * Make AI request using the service's model configuration
   */
  private static async makeAIRequest(
    aiService: AIManagerService,
    prompt: string
  ): Promise<string | null> {
    // We'll use a workaround since makeRequest is private
    // Create a mock "metadata generation" that just returns the raw response

    try {
      // Access the private method via any casting (not ideal but works)
      const service = aiService as any;

      // Get the model from the service
      const model = service.metadataModel;

      log.info(`[MasterAnalyzer] Making AI request with model: ${model}`);

      // Call the private makeRequest method
      const response = await service.makeRequest(prompt, model, 600); // 10 minute timeout

      return response;
    } catch (error) {
      log.error('[MasterAnalyzer] AI request failed:', error);
      return null;
    }
  }

  /**
   * Parse AI response to extract sections
   */
  private static parseAIResponse(response: string): AISectionResponse['sections'] {
    try {
      // Clean up response - remove markdown code blocks and headers
      let cleaned = response.trim();

      // Remove any text before the JSON (like "# Analysis" headers)
      const jsonStart = cleaned.indexOf('{');
      if (jsonStart > 0) {
        cleaned = cleaned.substring(jsonStart);
      }

      // Remove markdown code fences
      cleaned = cleaned.replace(/^```json\s*/gim, '');
      cleaned = cleaned.replace(/^```\s*/gim, '');
      cleaned = cleaned.replace(/\s*```\s*$/gim, '');

      // Extract JSON object (greedy match to get complete object)
      const jsonMatch = cleaned.match(/\{[\s\S]*\}/);
      if (!jsonMatch) {
        log.error('[MasterAnalyzer] No JSON found in AI response');
        log.error('[MasterAnalyzer] Cleaned response:', cleaned.substring(0, 500));
        return [];
      }

      let jsonStr = jsonMatch[0];

      // Try to parse, if it fails try to fix common issues
      try {
        const parsed = JSON.parse(jsonStr) as AISectionResponse;
        if (!parsed.sections || !Array.isArray(parsed.sections)) {
          log.error('[MasterAnalyzer] Invalid sections array in AI response');
          return [];
        }
        return parsed.sections;
      } catch (parseError) {
        // Try to fix truncated JSON by finding complete sections
        log.warn('[MasterAnalyzer] Initial parse failed, attempting to recover...');

        const sections: AISectionResponse['sections'] = [];

        // Extract sections with start_phrase format
        const phraseRegex = /\{\s*"start_phrase"\s*:\s*"([^"]*(?:\\.[^"]*)*)"\s*,\s*"title"\s*:\s*"([^"]*(?:\\.[^"]*)*)"\s*,\s*"description"\s*:\s*"([^"]*(?:\\.[^"]*)*)"\s*\}/g;
        let match;
        while ((match = phraseRegex.exec(jsonStr)) !== null) {
          sections.push({
            start_phrase: match[1].replace(/\\"/g, '"'),
            title: match[2].replace(/\\"/g, '"'),
            description: match[3].replace(/\\"/g, '"'),
          });
        }

        if (sections.length > 0) {
          log.info(`[MasterAnalyzer] Recovered ${sections.length} sections from malformed JSON`);
          return sections;
        }

        throw parseError;
      }
    } catch (error) {
      log.error('[MasterAnalyzer] Failed to parse AI response:', error);
      log.error('[MasterAnalyzer] Response preview:', response.substring(0, 1000));
      return [];
    }
  }

  /**
   * Map AI-detected sections to timestamps using phrase matching
   * Enforces chronological order - each section must start after the previous
   */
  private static mapSectionsToTimestamps(
    aiSections: AISectionResponse['sections'],
    srtSegments: SRTSegment[],
    totalDurationSeconds: number
  ): MasterSection[] {
    const mappedSections: MasterSection[] = [];
    let lastTimestamp = 0;  // Track last matched timestamp for chronological enforcement

    for (let i = 0; i < aiSections.length; i++) {
      const section = aiSections[i];
      const title = section.title?.trim();
      const description = section.description?.trim();
      const startPhrase = section.start_phrase || '';

      if (!title || !description) {
        log.warn(`[MasterAnalyzer] Skipping section ${i}: missing title or description`);
        continue;
      }

      // Find timestamp using phrase matching, enforcing chronological order
      // Each section must start at or after the previous section's start
      let startSeconds = findPhraseTimestamp(startPhrase, srtSegments, 0.5, lastTimestamp);
      log.info(`[MasterAnalyzer] Phrase matching (minTime=${TimeUtils.secondsToYoutubeTime(lastTimestamp)}): "${startPhrase.substring(0, 50)}..." → ${startSeconds !== null ? TimeUtils.secondsToYoutubeTime(startSeconds) : 'NOT FOUND'}`);

      // Default first section to 0:00 if phrase not found
      if (startSeconds === null && i === 0) {
        log.info(`[MasterAnalyzer] First section defaulting to 0:00`);
        startSeconds = 0;
      }

      if (startSeconds === null) {
        log.warn(`[MasterAnalyzer] Could not find timestamp for section ${i}: "${title}"`);
        continue;
      }

      // Update last timestamp for next iteration (add small buffer to avoid same-second matches)
      lastTimestamp = startSeconds + 1;

      mappedSections.push({
        startTimestamp: TimeUtils.secondsToYoutubeTime(startSeconds),
        endTimestamp: '', // Will be calculated after all sections are mapped
        startSeconds,
        endSeconds: totalDurationSeconds,
        title,
        description,
        startPhrase,
      });
    }

    // Ensure first section starts at 0:00
    if (mappedSections.length > 0 && mappedSections[0].startSeconds > 0) {
      mappedSections[0].startSeconds = 0;
      mappedSections[0].startTimestamp = '0:00';
    }

    // Calculate end times based on next section's start
    for (let i = 0; i < mappedSections.length; i++) {
      if (i < mappedSections.length - 1) {
        mappedSections[i].endSeconds = mappedSections[i + 1].startSeconds;
        mappedSections[i].endTimestamp = TimeUtils.secondsToYoutubeTime(mappedSections[i].endSeconds);
      } else {
        mappedSections[i].endSeconds = totalDurationSeconds;
        mappedSections[i].endTimestamp = TimeUtils.secondsToYoutubeTime(totalDurationSeconds);
      }
    }

    return mappedSections;
  }

  /**
   * Save master report to file
   */
  private static async saveReport(
    report: MasterReport,
    outputDirectory: string
  ): Promise<string> {
    // Create master reports directory
    const reportsDir = path.join(outputDirectory, '.contentstudio', 'master-reports');

    if (!fs.existsSync(reportsDir)) {
      fs.mkdirSync(reportsDir, { recursive: true });
    }

    // Generate filename
    const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
    const safeName = report.masterVideoName.replace(/[^a-z0-9]/gi, '-').toLowerCase();
    const filename = `master-${timestamp}-${safeName}.json`;
    const reportPath = path.join(reportsDir, filename);

    // Write report
    fs.writeFileSync(reportPath, JSON.stringify(report, null, 2), 'utf-8');

    log.info(`[MasterAnalyzer] Report saved to: ${reportPath}`);

    return reportPath;
  }

  /**
   * Load a master report from file
   */
  static loadReport(reportPath: string): MasterReport | null {
    try {
      if (!fs.existsSync(reportPath)) {
        return null;
      }

      const content = fs.readFileSync(reportPath, 'utf-8');
      return JSON.parse(content) as MasterReport;
    } catch (error) {
      log.error(`[MasterAnalyzer] Failed to load report: ${error}`);
      return null;
    }
  }

  /**
   * List all master reports in output directory
   */
  static listReports(outputDirectory: string): Array<{ path: string; report: MasterReport }> {
    const reportsDir = path.join(outputDirectory, '.contentstudio', 'master-reports');

    if (!fs.existsSync(reportsDir)) {
      return [];
    }

    const reports: Array<{ path: string; report: MasterReport }> = [];

    const files = fs.readdirSync(reportsDir);
    for (const file of files) {
      if (file.startsWith('master-') && file.endsWith('.json')) {
        const reportPath = path.join(reportsDir, file);
        const report = this.loadReport(reportPath);
        if (report) {
          reports.push({ path: reportPath, report });
        }
      }
    }

    // Sort by analysis date (newest first)
    reports.sort((a, b) => {
      return new Date(b.report.analyzedAt).getTime() - new Date(a.report.analyzedAt).getTime();
    });

    return reports;
  }
}
