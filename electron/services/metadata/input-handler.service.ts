/**
 * Input Handler Service
 * Processes all input types and normalizes them to content strings
 */

import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import { WhisperService, SRTSegment } from './whisper.service';
import type { TranscriptImportMeta } from './transcript-import.service';
import {
  parseTranscriptImport,
  buildImportedContentItem,
  isTranscriptImportPath,
} from './transcript-import.service';
import { resolveRef, probeDrift } from './editor-transcript-link';
import type { TranscriptRef } from '../publish/publish-types';

/**
 * The SECOND transcript of a video input: the editor story the operator linked it to.
 *
 * Present only when a link was declared AND honored. It sits BESIDE `content`, never
 * instead of it — `content` and `srtSegments` are the final export's Whisper output on
 * every path, and `srtSegments` is what chapters read (spec §3.3). The generator's one
 * resolver (`contentTextOf`) is what decides that content FIELDS read `text` from here.
 */
export interface ContentSource {
  /** The story's words, joined exactly as the transcript-import path joins them. */
  text: string;
  origin: 'editor-story-transcript';
  /** The link that produced `text`, already resolved 'ok' against the file on disk. */
  ref: TranscriptRef;
  /** probeDrift, measured at GENERATION time: final export duration − story duration. */
  driftSec: number;
  /** The same drift as a percentage of the story's duration. Negative = final is shorter. */
  driftPct: number;
}

export interface ContentItem {
  content: string;
  contentType: 'subject' | 'video' | 'transcript_file';
  source?: string;
  processingNotes?: string;
  srtSegments?: SRTSegment[];
  /** Preferred display title (used for the job/TXT name). Set for imported
   *  transcripts so the project reads as the story title rather than a filename. */
  title?: string;
  /** Provenance + speaker/split data for transcripts imported from AutoCutStudio. */
  importMeta?: TranscriptImportMeta;
  /**
   * The editor story transcript the operator linked this input to (Phase 2), or null when
   * he declared "final export only".
   *
   * The DECLARATION. `contentSource` below is what became of it. `content` is still the
   * final export's Whisper transcript on every path, and `srtSegments` — the only thing
   * chapters ever read — stays the final export's for good.
   *
   * `undefined` means the input was never offered a choice (a subject, a text item, an
   * already-imported transcript); `null` means the operator was offered one and declared
   * final-only. The three states are not interchangeable.
   */
  transcriptRef?: TranscriptRef | null;
  /**
   * The linked story's words, when a declared link was honored (spec §3.3).
   *
   * Set ONLY on the linked branch, and a declared link that could not be honored throws
   * rather than leaving this undefined: quietly generating final-only from a link the
   * operator asked for is the one outcome §3.4 rule 4 rules out.
   */
  contentSource?: ContentSource;
  /**
   * The final export's duration in seconds as the transcription stage ffprobed it, or
   * null when nothing measured one (no video, or the probe failed).
   *
   * Recorded, not re-derived: this is the single source of `ItemProvenance.
   * final_duration_sec` on BOTH branches, so the linked and unlinked reports quote the
   * same measurement of the same file.
   */
  finalDurationSec?: number | null;
}

export class InputDetector {
  private static readonly SUPPORTED_MEDIA_FORMATS = new Set([
    // Video formats
    '.mp4', '.avi', '.mov', '.mkv', '.webm', '.m4v', '.flv',
    '.wmv', '.mpg', '.mpeg', '.3gp', '.ogv',
    // Audio formats
    '.mp3', '.wav', '.aiff', '.aif', '.m4a', '.aac', '.flac', '.ogg', '.wma',
  ]);

  /**
   * Detect input type
   */
  static detectInputType(input: string): 'subject' | 'video' | 'directory' | 'transcript_file' {
    // First check: if input has path separators and the file/dir exists, it's definitely a path
    const hasPathSeparators = input.includes('/') || input.includes('\\');

    if (hasPathSeparators && fs.existsSync(input)) {
      const stats = fs.statSync(input);
      if (stats.isFile()) {
        const ext = path.extname(input).toLowerCase();
        if (this.SUPPORTED_MEDIA_FORMATS.has(ext)) {
          return 'video';
        }
        return 'transcript_file';
      } else if (stats.isDirectory()) {
        return 'directory';
      }
    }

    // Check for valid file extensions (not just any period - must be a real extension)
    const ext = path.extname(input).toLowerCase();
    const validFileExtensions = new Set([
      ...this.SUPPORTED_MEDIA_FORMATS,
      '.txt', '.srt', '.vtt', '.json'
    ]);

    // Only treat as file path if it has a recognized file extension
    if (validFileExtensions.has(ext)) {
      if (fs.existsSync(input)) {
        if (this.SUPPORTED_MEDIA_FORMATS.has(ext)) {
          return 'video';
        }
        return 'transcript_file';
      }
      // File doesn't exist but has valid extension - still treat as file path
      if (this.SUPPORTED_MEDIA_FORMATS.has(ext)) {
        return 'video';
      }
      return 'transcript_file';
    }

    // Everything else (including text with periods like sentences) is a subject
    return 'subject';
  }

  /**
   * Validate input
   */
  static validateInput(
    input: string,
    inputType: string,
    maxFileSizeMB: number = 500
  ): { valid: boolean; error?: string } {
    if (inputType === 'subject') {
      if (!input || input.trim().length < 3) {
        return { valid: false, error: 'Subject must be at least 3 characters' };
      }
      if (input.length > 2000) {
        return { valid: false, error: 'Subject too long (max 2000 characters)' };
      }
      return { valid: true };
    }

    if (inputType === 'video' || inputType === 'transcript_file') {
      if (!fs.existsSync(input)) {
        return { valid: false, error: `File not found: ${input}` };
      }

      const stats = fs.statSync(input);
      if (!stats.isFile()) {
        return { valid: false, error: `Path is not a file: ${input}` };
      }
      if (stats.size === 0) {
        return { valid: false, error: `File is empty: ${input}` };
      }

      return { valid: true };
    }

    if (inputType === 'directory') {
      if (!fs.existsSync(input)) {
        return { valid: false, error: `Directory not found: ${input}` };
      }

      const stats = fs.statSync(input);
      if (!stats.isDirectory()) {
        return { valid: false, error: `Path is not a directory: ${input}` };
      }

      return { valid: true };
    }

    return { valid: true };
  }

  /**
   * Check if file should be skipped
   */
  static shouldSkipFile(filePath: string): boolean {
    const filename = path.basename(filePath);

    // Skip macOS metadata files
    if (filename.startsWith('._')) {
      return true;
    }

    // Skip hidden files
    if (filename.startsWith('.')) {
      return true;
    }

    // Skip system files
    if (filename === 'Thumbs.db' || filename === 'desktop.ini') {
      return true;
    }

    return false;
  }
}

export class InputHandlerService {
  private whisperService: WhisperService;
  private progressCallback?: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void;
  public currentFilename: string = '';
  public currentItemIndex: number = -1;

  constructor(whisperService: WhisperService, progressCallback?: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void) {
    this.whisperService = whisperService;
    this.progressCallback = progressCallback;
  }

  /**
   * Process a single input item
   */
  async processInput(
    input: string,
    customNotes?: string,
    itemIndex?: number,
    transcriptRef?: TranscriptRef | null
  ): Promise<ContentItem> {
    console.log(`[InputHandler] Processing input: ${input}`);

    const inputType = InputDetector.detectInputType(input);
    console.log(`[InputHandler] Detected type: ${inputType}`);

    // Validate input
    const validation = InputDetector.validateInput(input, inputType);
    if (!validation.valid) {
      throw new Error(validation.error);
    }

    // Process based on type
    if (inputType === 'subject') {
      return this.processSubject(input, customNotes);
    } else if (inputType === 'video') {
      return await this.processVideo(input, customNotes, itemIndex, transcriptRef);
    } else if (inputType === 'transcript_file') {
      return this.processTranscriptFile(input, customNotes);
    } else if (inputType === 'directory') {
      throw new Error('Directory processing should be handled by processDirectory()');
    }

    throw new Error(`Unsupported input type: ${inputType}`);
  }

  /**
   * Process a subject string
   */
  private processSubject(subject: string, customNotes?: string): ContentItem {
    console.log(`[InputHandler] Processing subject: ${subject}`);

    let content = subject.trim();

    // Add custom notes if provided
    if (customNotes && customNotes.trim()) {
      content += `\n\nAdditional context:\n${customNotes.trim()}`;
    }

    return {
      content,
      contentType: 'subject',
      source: undefined,
      processingNotes: customNotes?.trim(),
    };
  }

  /**
   * Process a video file
   */
  private async processVideo(
    videoPath: string,
    customNotes?: string,
    itemIndex?: number,
    transcriptRef?: TranscriptRef | null
  ): Promise<ContentItem> {
    log.info(`[InputHandler] Processing video: ${videoPath}`);

    // Whisper the FINAL EXPORT, exactly as before — on both branches, unconditionally.
    // A link changes where content FIELDS get their words; it never changes what the
    // timeline is measured from, because chapters have to land on the published video.
    let result: { jobId: string; segments: SRTSegment[]; durationSec: number | null };
    try {
      // Send 'preparing' event before transcription starts. The item index is
      // threaded in per-call (not read from a shared instance field) so concurrent
      // transcriptions don't attribute progress to the wrong item.
      const filename = path.basename(videoPath);

      if (this.progressCallback) {
        log.info(`[InputHandler] Sending preparing phase for: ${filename}`);
        this.progressCallback('preparing', `Preparing ${filename}`, 0, filename, itemIndex !== undefined && itemIndex >= 0 ? itemIndex : undefined);
      }

      // Transcribe video (returns jobId along with result)
      log.info(`[InputHandler] Calling whisperService.transcribeVideo...`);
      result = await this.whisperService.transcribeVideo(videoPath);

      log.info(`[InputHandler] [${result.jobId}] Video transcribed: ${result.segments.length} segments`);
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      const errorStack = error instanceof Error ? error.stack : undefined;

      log.error(`[InputHandler] Failed to process video: ${errorMessage}`);
      if (errorStack) {
        log.error(`[InputHandler] Stack trace: ${errorStack}`);
      }

      throw new Error(`Failed to transcribe video: ${errorMessage}`);
    }

    // OUTSIDE the catch above, so a link that cannot be honored is not reported as a
    // transcription failure. Transcription succeeded; this is a different fault.

    // Convert segments to text
    const transcript = result.segments.map(seg => seg.text).join(' ');

    let content = transcript;

    // Add custom notes if provided
    if (customNotes && customNotes.trim()) {
      content += `\n\nAdditional context:\n${customNotes.trim()}`;
    }

    // A declared link is HONORED here or the item fails; there is no third outcome.
    const contentSource = transcriptRef
      ? await this.resolveContentSource(videoPath, transcriptRef, customNotes)
      : undefined;

    return {
      content,
      contentType: 'video',
      source: videoPath,
      processingNotes: customNotes?.trim(),
      srtSegments: result.segments,
      // The declaration, carried onto the item so the generator can record what was
      // asked for as well as what was done.
      transcriptRef,
      finalDurationSec: result.durationSec,
      contentSource,
    };
  }

  /**
   * Turn a declared link into the story's words, or fail the item saying why.
   *
   * §3.4 rule 4: "a declared link whose file is missing/changed FAILS the run — it never
   * quietly runs final-only". So there is no recovery path in here. Both non-'ok'
   * resolutions throw with the resolver's own reason, which names the file, the story and
   * exactly which identity field disagreed; the caller turns that into a per-item failure
   * the operator reads on the queue.
   *
   * The words are produced by the EXISTING import path — the same parse and the same
   * word→segment→text join `processTranscriptImport` uses for a hand-imported story — so
   * a linked run and an imported run cannot feed the model differently worded transcripts
   * of the same story.
   */
  private async resolveContentSource(
    videoPath: string,
    ref: TranscriptRef,
    customNotes?: string
  ): Promise<ContentSource> {
    const resolution = resolveRef(ref);
    if (resolution.state !== 'ok') {
      throw new Error(
        `The linked editor transcript for ${path.basename(videoPath)} is ${resolution.state}: ` +
        `${resolution.reason}`
      );
    }

    const raw = fs.readFileSync(ref.path, 'utf-8');
    const parsed = parseTranscriptImport(raw, ref.path);
    if (!parsed.ok) {
      throw new Error(`The linked editor transcript ${ref.path} cannot be parsed: ${parsed.error}`);
    }

    // `content`, not a bespoke join: buildImportedContentItem is the one place that turns
    // parsed words into the text the summarizer reads, notes appended and all. Only its
    // text is kept — its srtSegments belong to the EDITOR timeline, and nothing timed may
    // ever be built from those (they would move every chapter by the drift below).
    const text = buildImportedContentItem(parsed.data, ref.path, customNotes).content;

    // Measured now, against the file that is being generated from, rather than trusted
    // from the Inputs row: the row's number was measured when the operator linked, and
    // the export can be re-rendered between linking and queueing. probeDrift is the
    // single source of truth for drift on this branch.
    const probe = await probeDrift(videoPath, ref);

    log.info(
      `[InputHandler] Content fields will come from editor story "${ref.storyTitle}" ` +
      `(${ref.sourceSession}): ${text.length} chars, drift ${probe.driftSec.toFixed(1)}s ` +
      `(${probe.driftPct.toFixed(1)}%)`
    );

    return {
      text,
      origin: 'editor-story-transcript',
      ref,
      driftSec: probe.driftSec,
      driftPct: probe.driftPct,
    };
  }

  /**
   * Process a transcript file
   */
  private processTranscriptFile(filePath: string, customNotes?: string): ContentItem {
    console.log(`[InputHandler] Processing transcript file: ${filePath}`);

    // A .json file is treated as an AutoCutStudio transcript import: parse the
    // word-level data into a fully-timestamped ContentItem (content + srtSegments
    // + speaker attribution) so it lands in the same state a Whisper transcription
    // would, without ever calling Whisper.
    if (isTranscriptImportPath(filePath)) {
      return this.processTranscriptImport(filePath, customNotes);
    }

    try {
      let content = fs.readFileSync(filePath, 'utf-8');

      // Clean up common transcript artifacts
      content = this.cleanTranscript(content);

      // Add custom notes if provided
      if (customNotes && customNotes.trim()) {
        content += `\n\nAdditional context:\n${customNotes.trim()}`;
      }

      console.log(`[InputHandler] Transcript loaded: ${content.length} characters`);

      return {
        content,
        contentType: 'transcript_file',
        source: filePath,
        processingNotes: customNotes?.trim(),
      };
    } catch (error) {
      console.error(`[InputHandler] Failed to read transcript file:`, error);
      throw new Error(`Failed to read transcript file: ${error}`);
    }
  }

  /**
   * Process an AutoCutStudio transcript import (.json).
   * Parses the word-level transcript into a ContentItem with plain-text content,
   * timestamped srtSegments (grouped from words), and preserved mic/screen
   * speaker attribution. Whisper is never invoked.
   */
  private processTranscriptImport(filePath: string, customNotes?: string): ContentItem {
    log.info(`[InputHandler] Importing transcript: ${filePath}`);

    let raw: string;
    try {
      raw = fs.readFileSync(filePath, 'utf-8');
    } catch (error) {
      throw new Error(`Failed to read transcript file: ${error instanceof Error ? error.message : String(error)}`);
    }

    const parsed = parseTranscriptImport(raw, filePath);
    if (!parsed.ok) {
      throw new Error(`Invalid transcript import: ${parsed.error}`);
    }

    const item = buildImportedContentItem(parsed.data, filePath, customNotes);
    log.info(
      `[InputHandler] Imported "${item.title}": ${item.srtSegments?.length ?? 0} segments, ` +
      `${item.content.length} chars, speakers=[${parsed.data.meta.speakers.map(s => s.id).join(', ')}]`
    );
    return item;
  }

  /**
   * Clean transcript text
   */
  private cleanTranscript(text: string): string {
    // Remove excessive whitespace
    text = text.replace(/\s+/g, ' ');

    // Remove common artifacts
    text = text.replace(/\[MUSIC\]/gi, '');
    text = text.replace(/\[APPLAUSE\]/gi, '');
    text = text.replace(/\[LAUGHTER\]/gi, '');

    return text.trim();
  }

  /**
   * Process a directory of files
   */
  async processDirectory(dirPath: string): Promise<ContentItem[]> {
    console.log(`[InputHandler] Processing directory: ${dirPath}`);

    const items: ContentItem[] = [];
    const files = fs.readdirSync(dirPath);

    for (const file of files) {
      const filePath = path.join(dirPath, file);

      // Skip files that should be skipped
      if (InputDetector.shouldSkipFile(filePath)) {
        continue;
      }

      const stats = fs.statSync(filePath);

      if (stats.isFile()) {
        try {
          const item = await this.processInput(filePath);
          items.push(item);
        } catch (error) {
          console.error(`[InputHandler] Failed to process file ${filePath}:`, error);
          // Continue with other files
        }
      }
    }

    console.log(`[InputHandler] Processed ${items.length} files from directory`);
    return items;
  }

  /**
   * Process multiple inputs.
   *
   * Inputs that fail (e.g. transcription produced no speech segments) are skipped
   * so the rest of the batch still processes; when `failures` is provided, a
   * "<input>: <reason>" entry is pushed for each skip so the caller can surface
   * them instead of items silently vanishing from the job.
   */
  async processMultipleInputs(
    inputs: string[],
    customNotesMap?: Map<string, string>,
    failures?: string[],
    transcriptRefMap?: Map<string, TranscriptRef | null>
  ): Promise<ContentItem[]> {
    console.log(`[InputHandler] Processing ${inputs.length} inputs (max 5 concurrent transcriptions)`);

    const items: ContentItem[] = [];
    const MAX_CONCURRENT = 5;

    // Process inputs with concurrency limit
    const processInput = async (input: string, index: number): Promise<ContentItem | null> => {
      try {
        // Thread the item index through the call chain (per-task) so that under the
        // concurrent processing loop below, progress events are attributed to the
        // correct item rather than to whichever task last wrote a shared field.
        const inputType = InputDetector.detectInputType(input);

        if (inputType === 'directory') {
          const dirItems = await this.processDirectory(input);
          return dirItems[0] || null; // Return first item (directories processed separately)
        } else {
          const customNotes = customNotesMap?.get(input);
          // `has` rather than `get`: an entry whose value is null is the operator having
          // DECLARED final-only, which is not the same as no entry at all (never offered
          // a choice). Collapsing them would erase the declaration.
          const transcriptRef = transcriptRefMap?.has(input)
            ? transcriptRefMap.get(input)
            : undefined;
          return await this.processInput(input, customNotes, index, transcriptRef);
        }
      } catch (error) {
        console.error(`[InputHandler] Failed to process input ${input}:`, error);
        const reason = error instanceof Error ? error.message : String(error);
        const label = input.includes('/') || input.includes('\\')
          ? path.basename(input)
          : input.slice(0, 60);
        failures?.push(`${label}: ${reason}`);
        return null;
      }
    };

    // Process items with concurrency limit
    const executing = new Set<Promise<void>>();

    for (let i = 0; i < inputs.length; i++) {
      const input = inputs[i];

      const promise = processInput(input, i).then(item => {
        if (item) items.push(item);
      }).finally(() => {
        executing.delete(promise);
      });

      executing.add(promise);

      // Wait if we've reached max concurrency
      if (executing.size >= MAX_CONCURRENT) {
        await Promise.race(executing);
      }
    }

    // Wait for all remaining promises to complete
    await Promise.all(executing);

    console.log(`[InputHandler] Processed ${items.length} content items`);
    return items;
  }

  /**
   * Get transcript from content item as plain text
   */
  getTranscriptText(item: ContentItem): string {
    // Remove any custom notes that were appended
    if (item.processingNotes) {
      const notesMarker = `\n\nAdditional context:\n${item.processingNotes}`;
      if (item.content.endsWith(notesMarker)) {
        return item.content.slice(0, -notesMarker.length);
      }
    }

    return item.content;
  }
}
