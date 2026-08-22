/**
 * Output Handler Service
 * Saves metadata to files in user-friendly formats
 */

import * as fs from 'fs';
import * as path from 'path';
import { MetadataResult } from './ai-manager.service';
import { Chapter } from './chapter-generator.service';
import { METADATA_FIELDS } from './metadata-fields';

export interface JobMetadata {
  job_id: string;
  job_name: string;
  prompt_set: string;
  created_at: string;
  txt_folder: string;
  items: MetadataResult[];
  status: string;
  source_items?: any[];
  original_inputs?: string[];  // Raw inputs provided by the user
  input_types?: string[];      // Content types: 'subject' | 'video' | 'transcript_file'
}

export class OutputHandlerService {
  private userOutputDir: string;
  private metadataDir: string;
  // Serializes addItemToJob so concurrent calls can't clobber each other's
  // read-modify-write of the job JSON.
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(outputDir: string) {
    this.userOutputDir = outputDir;
    this.metadataDir = path.join(outputDir, '.contentstudio', 'metadata');

    // Create directories
    if (!fs.existsSync(this.userOutputDir)) {
      fs.mkdirSync(this.userOutputDir, { recursive: true });
    }
    if (!fs.existsSync(this.metadataDir)) {
      fs.mkdirSync(this.metadataDir, { recursive: true });
    }

    console.log('[OutputHandler] Initialized');
    console.log('[OutputHandler] User output dir:', this.userOutputDir);
    console.log('[OutputHandler] Metadata dir:', this.metadataDir);
  }

  /**
   * Initialize a new job (creates job metadata with empty items).
   *
   * `jobId` is REQUIRED, and minting one here would be worse than failing. The id is the
   * renderer's — its queue row is keyed by it, and so are the publish selections and the
   * cancellation registration — so an id invented in the main process names a job file that
   * the queue cannot match, the operator cannot delete and the publish feature cannot reach.
   * The mint that used to sit here was unreachable (the single caller always passes one) and
   * would have produced exactly that orphan the day it was not.
   */
  initializeJob(
    jobName: string,
    promptSet: string,
    jobId: string
  ): { jobId: string; txtFolder: string; jsonPath: string } {
    if (typeof jobId !== 'string' || !jobId.trim()) {
      throw new Error('initializeJob requires a jobId — the renderer owns it and must supply it.');
    }

    // Clean job name for folder
    const cleanFolderName = this.cleanNameWithSpaces(jobName);

    // Create TXT output folder
    const txtFolder = path.join(this.userOutputDir, cleanFolderName);
    if (!fs.existsSync(txtFolder)) {
      fs.mkdirSync(txtFolder, { recursive: true });
    }

    // Prepare initial job metadata
    const jobMetadata: JobMetadata = {
      job_id: jobId,
      job_name: jobName,
      prompt_set: promptSet,
      created_at: new Date().toISOString(),
      txt_folder: txtFolder,
      items: [],
      status: 'processing',
    };

    // Save JSON metadata file
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    this.saveJson(jobMetadata, jsonPath);
    console.log(`[OutputHandler] Job initialized: ${jobId}`);

    return { jobId, txtFolder, jsonPath };
  }

  /**
   * Add a single item to an existing job.
   *
   * Concurrent calls are serialized through a per-instance promise chain so the
   * json read -> push -> write sequence for one item can't clobber another's.
   * Rejects (rather than silently returning null) on a genuine failure so the
   * caller can surface it.
   */
  addItemToJob(
    jobId: string,
    metadataItem: MetadataResult
  ): Promise<{ txtPath: string }> {
    const run = this.writeQueue.then(() => this.writeItemToJob(jobId, metadataItem));
    // Keep the chain alive even if this call rejects, so one failed item doesn't
    // poison the queue for subsequent items.
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Synchronous read-modify-write for a single job item (serialized via writeQueue).
   */
  private writeItemToJob(
    jobId: string,
    metadataItem: MetadataResult
  ): { txtPath: string } {
    // Load existing job
    const job = this.getJobMetadata(jobId);
    if (!job) {
      const message = `Job not found: ${jobId}`;
      console.error(`[OutputHandler] ${message}`);
      throw new Error(message);
    }

    // Add item to job
    job.items.push(metadataItem);

    // Save updated job metadata
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    this.saveJson(job, jsonPath);

    // Save TXT file for this item. The AI-generated title is untrusted input, so
    // sanitize it for filesystem use and de-collide so untitled/duplicate items
    // don't throw or overwrite each other.
    const rawName = (metadataItem as any)._title || `item_${job.items.length}`;
    const cleanName = this.sanitizeFilename(rawName) || `item_${job.items.length}`;
    const txtPath = this.resolveUniqueTxtPath(job.txt_folder, cleanName);
    this.saveReadable(metadataItem, txtPath, job.prompt_set);

    console.log(`[OutputHandler] Added item to job ${jobId}: ${cleanName}`);

    return { txtPath };
  }

  /**
   * Update job status
   */
  updateJobStatus(jobId: string, status: string): boolean {
    try {
      const job = this.getJobMetadata(jobId);
      if (!job) {
        return false;
      }

      job.status = status;

      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      this.saveJson(job, jsonPath);

      console.log(`[OutputHandler] Updated job ${jobId} status to: ${status}`);
      return true;
    } catch (error) {
      console.error(`[OutputHandler] Failed to update job status:`, error);
      return false;
    }
  }

  /**
   * Update arbitrary job data fields
   */
  updateJobData(jobId: string, data: Partial<JobMetadata>): boolean {
    try {
      const job = this.getJobMetadata(jobId);
      if (!job) {
        return false;
      }

      Object.assign(job, data);

      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      this.saveJson(job, jsonPath);

      console.log(`[OutputHandler] Updated job ${jobId} data`);
      return true;
    } catch (error) {
      console.error(`[OutputHandler] Failed to update job data:`, error);
      return false;
    }
  }


  /**
   * Save metadata to JSON file
   */
  private saveJson(metadata: any, outputPath: string): void {
    try {
      fs.writeFileSync(outputPath, JSON.stringify(metadata, null, 2), 'utf-8');
      console.log(`[OutputHandler] JSON saved: ${outputPath}`);
    } catch (error) {
      throw new Error(`Failed to save JSON: ${error}`);
    }
  }

  /**
   * Save metadata as human-readable text file
   */
  private saveReadable(metadata: MetadataResult, outputPath: string, promptSet: string): void {
    try {
      const lines: string[] = [];

      // Header
      lines.push('='.repeat(80));
      lines.push(`METADATA - ${promptSet}`);
      lines.push(`Generated: ${new Date().toLocaleString()}`);
      lines.push('='.repeat(80));
      lines.push('');

      // Emit one section (label line, 80-dash line, content, blank line).
      const emitSection = (label: string, contentLines: string[]): void => {
        lines.push(label);
        lines.push('-'.repeat(80));
        contentLines.forEach((l) => lines.push(l));
        lines.push('');
      };

      // Sections are driven by the field registry so adding a future field is a
      // single entry in metadata-fields.ts. Chapters are not in the registry
      // (typed object array) and are injected right after thumbnail_text.
      for (const def of METADATA_FIELDS) {
        const value = (metadata as any)[def.key];

        if (def.txtStyle === 'numbered') {
          if (Array.isArray(value) && value.length > 0) {
            emitSection(def.txtLabel, value.map((v: string, i: number) => `${i + 1}. ${v}`));
          }
        } else if (def.txtStyle === 'block') {
          if (value) {
            emitSection(def.txtLabel, [value]);
          }
        } else if (def.txtStyle === 'inline') {
          if (Array.isArray(value)) {
            if (value.length > 0) {
              emitSection(def.txtLabel, [value.join(', ')]);
            }
          } else if (value) {
            emitSection(def.txtLabel, [value]);
          }
        }

        // Chapters section - injected in its current position (after thumbnail_text).
        // When there are none and the run recorded why, the reason takes the section's
        // place: a file that simply omits CHAPTERS cannot tell the reader whether they
        // were never asked for or were lost.
        if (def.key === 'thumbnail_text') {
          if (metadata.chapters && metadata.chapters.length > 0) {
            emitSection('CHAPTERS', this.renderChapters(metadata.chapters));
          } else if (metadata.chaptersSkipped) {
            const { outcome, reason } = metadata.chaptersSkipped;
            emitSection('CHAPTERS', [
              outcome === 'failed' ? 'Chapter generation FAILED. No chapters were added.' : 'No chapters were added.',
              reason,
            ]);
          }
        }
      }

      // Write to file
      fs.writeFileSync(outputPath, lines.join('\n'), 'utf-8');
      console.log(`[OutputHandler] TXT saved: ${outputPath}`);
    } catch (error) {
      throw new Error(`Failed to save readable text: ${error}`);
    }
  }

  /**
   * The CHAPTERS block: one line per chapter, in the paste-into-YouTube shape.
   *
   * Two additions ride along with the chapter now, and both have to be visible here
   * because this file is what the user actually reads:
   *
   * - An approximate start is marked. It came from a ±45s junction rather than a
   *   mapped quote, and nothing else about the line would ever tell you — the symptom
   *   is a viewer clicking the marker and landing half a minute off.
   * - A chapter that consolidation built out of several is followed by the chapters it
   *   swallowed, indented. They are already named and already timed, and they are what
   *   a long merged story needs if the description wants finer markers.
   */
  private renderChapters(chapters: Chapter[]): string[] {
    const lines: string[] = [];
    for (const chapter of chapters) {
      lines.push(`${chapter.timestamp} - ${chapter.title}${chapter.startApprox ? '   [start approximate ±45s]' : ''}`);
      for (const sub of chapter.subChapters || []) {
        lines.push(`    ${sub.timestamp} - ${sub.title}${sub.startApprox ? '   [start approximate ±45s]' : ''}`);
      }
    }
    return lines;
  }

  /**
   * Sanitize an AI-generated title for safe use as a filename.
   * Replaces path separators / reserved characters / control chars with spaces,
   * collapses whitespace, trims, and caps the length (leaving room for a numeric
   * de-collision suffix and the .txt extension).
   */
  private sanitizeFilename(name: string): string {
    let clean = (name || '')
      .replace(/[/\\:*?"<>|\x00-\x1F]/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();

    const MAX_LEN = 120;
    if (clean.length > MAX_LEN) {
      clean = clean.slice(0, MAX_LEN).trim();
    }

    return clean;
  }

  /**
   * Resolve a collision-free `<baseName>.txt` path inside `dir`, appending a
   * numeric suffix (" (1)", " (2)", ...) if a file with that name already exists.
   */
  private resolveUniqueTxtPath(dir: string, baseName: string): string {
    let candidate = path.join(dir, `${baseName}.txt`);
    let counter = 1;
    while (fs.existsSync(candidate)) {
      candidate = path.join(dir, `${baseName} (${counter}).txt`);
      counter++;
    }
    return candidate;
  }

  /**
   * Clean name for filesystem (keep spaces, remove invalid chars and file extensions)
   */
  private cleanNameWithSpaces(name: string): string {
    // Remove file extension if present (video/audio files)
    const nameWithoutExt = name.replace(/\.(mp4|mov|avi|mkv|webm|m4v|mp3|wav|m4a|txt)$/i, '');

    // Remove invalid filesystem characters but keep spaces
    return nameWithoutExt.replace(/[<>:"/\\|?*\x00-\x1F]/g, '').trim();
  }

  /**
   * Get job metadata from file
   */
  getJobMetadata(jobId: string): JobMetadata | null {
    try {
      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      if (!fs.existsSync(jsonPath)) {
        return null;
      }

      const content = fs.readFileSync(jsonPath, 'utf-8');
      return JSON.parse(content);
    } catch (error) {
      console.error(`[OutputHandler] Failed to read job metadata:`, error);
      return null;
    }
  }

  /**
   * List all jobs
   */
  listJobs(): JobMetadata[] {
    try {
      const files = fs.readdirSync(this.metadataDir);
      const jobs: JobMetadata[] = [];

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          const jobId = file.replace('.json', '');
          const job = this.getJobMetadata(jobId);
          if (job) {
            jobs.push(job);
          }
        }
      }

      // Sort by creation date (newest first)
      jobs.sort((a, b) => {
        const dateA = new Date(a.created_at).getTime();
        const dateB = new Date(b.created_at).getTime();
        return dateB - dateA;
      });

      return jobs;
    } catch (error) {
      console.error(`[OutputHandler] Failed to list jobs:`, error);
      return [];
    }
  }

  /**
   * Delete job metadata and files
   */
  deleteJob(jobId: string): boolean {
    try {
      const job = this.getJobMetadata(jobId);
      if (!job) {
        return false;
      }

      // Delete JSON file
      const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
      if (fs.existsSync(jsonPath)) {
        fs.unlinkSync(jsonPath);
      }

      // Delete TXT folder if it exists
      if (job.txt_folder && fs.existsSync(job.txt_folder)) {
        fs.rmSync(job.txt_folder, { recursive: true, force: true });
      }

      console.log(`[OutputHandler] Deleted job: ${jobId}`);
      return true;
    } catch (error) {
      console.error(`[OutputHandler] Failed to delete job:`, error);
      return false;
    }
  }
}
