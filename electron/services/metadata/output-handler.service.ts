/**
 * Output Handler Service
 * Saves metadata to files in user-friendly formats
 */

import * as fs from 'fs';
import * as path from 'path';
import { MetadataResult } from './ai-manager.service';
import { Chapter } from './chapter-generator.service';
import { METADATA_FIELDS } from './metadata-fields';
import { ItemIdentity, ItemSource, SCHEMA_VERSION, isItemId, mintItemId } from './item-identity';

/** An item as it is stored: the generator's result plus its identity. */
export type StoredItem = MetadataResult & ItemIdentity;

export interface JobMetadata {
  job_id: string;
  job_name: string;
  prompt_set: string;
  created_at: string;
  txt_folder: string;
  items: StoredItem[];
  status: string;
  /** 2 once items carry item_id/txt_path/source_key. Absent means a pre-migration file. */
  schema_version?: number;
  source_items?: any[];
  original_inputs?: string[];  // Raw inputs provided by the user
  input_types?: string[];      // Content types: 'subject' | 'video' | 'transcript_file'
}

/**
 * How a delete disposed of the item's publish selection.
 *
 * Supplied by the caller rather than reached for here: publish state is the publish
 * store's business, and this module deliberately knows nothing about it (the dependency
 * runs the other way — publish-store imports nothing from services/metadata).
 */
export interface SelectionRemoval {
  /** Whether a stored selection for this item existed and was removed. */
  removed: boolean;
  /** How many higher-indexed selections were shifted down to stay aligned. */
  shifted: number;
}

export interface DeleteItemHooks {
  removeSelection: (jobId: string, itemIndex: number) => Promise<SelectionRemoval>;
}

/** The facts of one delete. Every field is an outcome, not an intention. */
export interface DeleteItemReceipt {
  jobId: string;
  itemId: string;
  /** The position the item held at delete time — for the log, never for identity. */
  itemIndex: number;
  jobFileDeleted: boolean;
  txtDeleted: boolean;
  /** Present only when txtDeleted is false, saying why. */
  txtReason?: string;
  txtFolderRemoved: boolean;
  selectionDeleted: boolean;
  selectionsShifted: number;
  /** False when the array's length didn't match items[] and was therefore left alone. */
  inputsSpliced: boolean;
  inputTypesSpliced: boolean;
}

export class OutputHandlerService {
  private userOutputDir: string;
  private metadataDir: string;
  // Serializes addItemToJob/deleteItem so concurrent calls can't clobber each other's
  // read-modify-write of the job JSON.
  private writeQueue: Promise<unknown> = Promise.resolve();

  /**
   * One instance per output directory, so the write queue actually serializes.
   *
   * A queue only orders the calls that go through the SAME instance. A delete arriving
   * over IPC on a freshly constructed handler while a generation run writes items
   * through its own handler is two unsynchronized read-modify-write cycles over the same
   * job file — the exact clobber the queue exists to prevent. Every caller must go
   * through here.
   */
  private static readonly instances = new Map<string, OutputHandlerService>();

  static forOutputDir(outputDir: string): OutputHandlerService {
    if (typeof outputDir !== 'string' || !outputDir.trim()) {
      throw new Error('OutputHandlerService.forOutputDir requires an output directory');
    }
    const key = path.resolve(outputDir);
    let instance = OutputHandlerService.instances.get(key);
    if (!instance) {
      instance = new OutputHandlerService(key);
      OutputHandlerService.instances.set(key, instance);
    }
    return instance;
  }

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
      schema_version: SCHEMA_VERSION,
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
    metadataItem: MetadataResult,
    source: ItemSource
  ): Promise<{ txtPath: string; itemId: string }> {
    const run = this.writeQueue.then(() => this.writeItemToJob(jobId, metadataItem, source));
    // Keep the chain alive even if this call rejects, so one failed item doesn't
    // poison the queue for subsequent items.
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Synchronous read-modify-write for a single job item (serialized via writeQueue).
   *
   * This is where an item's identity is minted: the one place in the app where an item
   * first exists on disk, already serialized against every other write to the same job.
   *
   * The TXT is written BEFORE the JSON now, and that order is load-bearing: the item
   * record carries the txt path, so the path has to be real before it is recorded. The
   * old order (JSON then TXT) could only ever have recorded a path it hoped would exist.
   */
  private writeItemToJob(
    jobId: string,
    metadataItem: MetadataResult,
    source: ItemSource
  ): { txtPath: string; itemId: string } {
    // The generator is REQUIRED to say what this item came from, including saying "a
    // text subject, so nothing" explicitly. A missing argument is a caller bug: derived
    // later from `original_inputs` it would be a guess, and the arrays are already known
    // to disagree with items[] on 16 of the live files.
    if (!source || typeof source !== 'object'
      || !('source_key' in source) || !('source_path' in source)) {
      throw new Error(
        `addItemToJob requires an ItemSource ({ source_key, source_path }, null allowed) for job ${jobId}`
      );
    }

    // Load existing job
    const job = this.getJobMetadata(jobId);
    if (!job) {
      const message = `Job not found: ${jobId}`;
      console.error(`[OutputHandler] ${message}`);
      throw new Error(message);
    }

    // Save TXT file for this item. The AI-generated title is untrusted input, so
    // sanitize it for filesystem use and de-collide so untitled/duplicate items
    // don't throw or overwrite each other.
    const ordinal = job.items.length + 1;
    const rawName = (metadataItem as any)._title || `item_${ordinal}`;
    const cleanName = this.sanitizeFilename(rawName) || `item_${ordinal}`;
    const txtPath = this.resolveUniqueTxtPath(job.txt_folder, cleanName);
    this.saveReadable(metadataItem, txtPath, job.prompt_set);

    // Add item to job, carrying its identity and the de-collided path just written.
    const itemId = mintItemId();
    const stored: StoredItem = Object.assign(metadataItem as StoredItem, {
      item_id: itemId,
      txt_path: txtPath,
      source_key: source.source_key,
      source_path: source.source_path,
    });
    job.items.push(stored);
    job.schema_version = SCHEMA_VERSION;

    // Save updated job metadata
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    this.saveJson(job, jsonPath);

    console.log(`[OutputHandler] Added item ${itemId} to job ${jobId}: ${cleanName}`);

    return { txtPath, itemId };
  }

  /**
   * Delete ONE item: its text file, its row in the job file, and its publish selection.
   *
   * Runs on the same queue as item writes, so it cannot interleave with a generation
   * run appending to the same job. Every failure throws — there is no `force` and no
   * "already gone is success" here (deliberately unlike delete-job-history's bulk
   * sweep): the caller asked to delete a specific item, and if that item is not there,
   * the caller is wrong about what it is looking at.
   */
  deleteItem(jobId: string, itemId: string, hooks: DeleteItemHooks): Promise<DeleteItemReceipt> {
    const run = this.writeQueue.then(() => this.runDeleteItem(jobId, itemId, hooks));
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  private async runDeleteItem(
    jobId: string,
    itemId: string,
    hooks: DeleteItemHooks
  ): Promise<DeleteItemReceipt> {
    if (typeof jobId !== 'string' || !jobId.trim()) {
      throw new Error('deleteItem requires a non-empty jobId');
    }
    if (!isItemId(itemId)) {
      throw new Error(`deleteItem requires a valid item id; got ${JSON.stringify(itemId)}`);
    }
    if (!hooks || typeof hooks.removeSelection !== 'function') {
      throw new Error('deleteItem requires a removeSelection hook — publish state cannot be left behind');
    }

    // 1. Resolve, or refuse.
    const jsonPath = path.join(this.metadataDir, `${jobId}.json`);
    const job = this.getJobMetadata(jobId);
    if (!job) {
      throw new Error(`Job not found: ${jobId}`);
    }
    if (!Array.isArray(job.items)) {
      throw new Error(`Job ${jobId} has no items array — the report file is corrupt.`);
    }
    const itemIndex = job.items.findIndex((item) => item && (item as StoredItem).item_id === itemId);
    if (itemIndex < 0) {
      throw new Error(`Item ${itemId} is not in job ${jobId}`);
    }
    const item = job.items[itemIndex];

    // 2. The item's OWN text file, never the folder. txt_folder is derived from the job
    //    name, so the same source regenerated shares one folder with up to six other
    //    jobs; removing it takes their output with it (P2).
    let txtDeleted = false;
    let txtReason: string | undefined;
    const txtPath = item.txt_path;
    if (typeof txtPath !== 'string' || !txtPath.trim()) {
      txtReason = 'no path recorded';
    } else if (!fs.existsSync(txtPath)) {
      txtReason = `no file at ${txtPath}`;
    } else {
      fs.unlinkSync(txtPath);
      txtDeleted = true;
    }

    // 3. The job file, atomically. `original_inputs` / `input_types` are spliced only
    //    when they are actually aligned with items[]; when they are not (compilations,
    //    and the 16 live files that already disagree) they are left exactly as they are
    //    and the receipt says so, because a splice at a position that means nothing in
    //    that array would corrupt filename matching for the whole job (P8).
    const itemsBefore = job.items.length;
    job.items.splice(itemIndex, 1);

    const inputsSpliced = Array.isArray(job.original_inputs) && job.original_inputs.length === itemsBefore;
    if (inputsSpliced) {
      job.original_inputs!.splice(itemIndex, 1);
    }
    const inputTypesSpliced = Array.isArray(job.input_types) && job.input_types.length === itemsBefore;
    if (inputTypesSpliced) {
      job.input_types!.splice(itemIndex, 1);
    }

    let jobFileDeleted = false;
    let txtFolderRemoved = false;
    if (job.items.length === 0) {
      fs.unlinkSync(jsonPath);
      jobFileDeleted = true;

      // Only when it is EMPTY. Anything still in there belongs to another job.
      if (job.txt_folder && fs.existsSync(job.txt_folder) && fs.readdirSync(job.txt_folder).length === 0) {
        fs.rmdirSync(job.txt_folder);
        txtFolderRemoved = true;
      }
    } else {
      this.saveJson(job, jsonPath);
    }

    // 4. Publish state. A selection left pointing at a deleted item is still served to
    //    the extension (P5), so a failure here is a failure of the delete.
    const selection = await hooks.removeSelection(jobId, itemIndex);

    const receipt: DeleteItemReceipt = {
      jobId,
      itemId,
      itemIndex,
      jobFileDeleted,
      txtDeleted,
      ...(txtReason ? { txtReason } : {}),
      txtFolderRemoved,
      selectionDeleted: selection.removed,
      selectionsShifted: selection.shifted,
      inputsSpliced,
      inputTypesSpliced,
    };
    console.log(`[OutputHandler] Deleted item ${itemId} from job ${jobId}:`, receipt);
    return receipt;
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
      // tmp + rename: a job file half-written by a crash or a full disk is a report the
      // operator cannot open and cannot delete, since every path into it starts by
      // parsing it.
      const tmp = `${outputPath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(metadata, null, 2), 'utf-8');
      fs.renameSync(tmp, outputPath);
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
    return sanitizeItemFilename(name);
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

  // `deleteJob(jobId)` used to live here: unlink the JSON, then `fs.rmSync(txt_folder,
  // { recursive: true, force: true })`. It had no call sites and never had any, which is
  // the only reason it never destroyed anything — that folder is shared by every job
  // generated from the same source (seven of them, for one live folder), so the one call
  // it was waiting for would have taken six other reports' text output with it. Deleting
  // a whole job is delete-job-history's, which now unlinks the recorded per-item paths.
}

/**
 * Sanitize an AI-generated title for safe use as a filename.
 *
 * Exported because the migration has to reproduce it EXACTLY: matching a legacy item to
 * the .txt that was written for it is a comparison against the name this function
 * produced, and a second copy of these rules that drifted by one character would resolve
 * the wrong file — or, worse, resolve one confidently.
 */
export function sanitizeItemFilename(name: string): string {
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
 * Remove the text files a job owns — the per-item paths it recorded, and nothing else.
 *
 * Used wherever a WHOLE job goes away (history delete, the four-week prune). The folder
 * itself is only removed when it is empty afterwards, because `txt_folder` is derived
 * from the job NAME: regenerating a source produces a new job pointing at the same
 * folder, and `rm -rf` on it is the live data-loss bug this replaces (P2).
 *
 * Pre-migration items recorded no path. Their text is LEFT, and the count says so — an
 * unrecorded file is not a file we know to be ours.
 */
export interface JobTxtCleanup {
  deleted: number;
  /** Recorded a path, but nothing was there. */
  missing: number;
  /** Left on disk because the item recorded no path. */
  left: number;
  folderRemoved: boolean;
  /** Paths we tried and could not unlink, with the reason. */
  failed: Array<{ path: string; error: string }>;
}

export function deleteJobTxtFiles(job: { items?: any[]; txt_folder?: string }): JobTxtCleanup {
  const result: JobTxtCleanup = { deleted: 0, missing: 0, left: 0, folderRemoved: false, failed: [] };

  const items = Array.isArray(job.items) ? job.items : [];
  for (const item of items) {
    const txtPath = item && typeof item.txt_path === 'string' ? item.txt_path.trim() : '';
    if (!txtPath) {
      result.left++;
      continue;
    }
    if (!fs.existsSync(txtPath)) {
      result.missing++;
      continue;
    }
    try {
      fs.unlinkSync(txtPath);
      result.deleted++;
    } catch (error) {
      result.failed.push({ path: txtPath, error: error instanceof Error ? error.message : String(error) });
    }
  }

  if (job.txt_folder && fs.existsSync(job.txt_folder)) {
    try {
      if (fs.readdirSync(job.txt_folder).length === 0) {
        fs.rmdirSync(job.txt_folder);
        result.folderRemoved = true;
      }
    } catch (error) {
      result.failed.push({
        path: job.txt_folder,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return result;
}
