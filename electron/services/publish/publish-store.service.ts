/**
 * Publish Store Service
 *
 * Persists the operator's CHOSEN metadata (which 3 titles, plus any description/tags
 * edits) and the link from a generated item to a real YouTube video.
 *
 * Layout, under <userData>/publish/ -- deliberately separate from analytics/:
 *
 *   publish/
 *     selections/<jobId>.json    { "<itemIndex>": ChosenMetadata, ... }
 *
 * Kept out of the job's own <jobId>.json on purpose: that file is the raw generator
 * output and should stay pristine, so an item can be regenerated without losing (or
 * silently keeping) a stale selection.
 *
 * All mutations run through a serialized write queue, matching the discipline in
 * OutputHandlerService / AnalyticsStoreService -- the renderer, the IPC layer and the
 * extension's ingest server can all touch this concurrently.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ChosenMetadata,
  ResolvedMetadata,
  PublishStatus,
  emptyChosenMetadata,
  MAX_AB_VARIANTS,
} from './publish-types';

/** The generated values a selection falls back to. Supplied by the caller so this
 *  module never has to import from services/metadata. */
export interface GeneratedFallback {
  titles: string[];
  description: string;
  tags: string;
  /** Basename of the analyzed source file, when the host can determine it. */
  sourceFilename?: string | null;
  /** Source duration in seconds, when known. null just means the match is unverified. */
  sourceDurationSec?: number | null;
}

/**
 * One entry in the host's index of generated items -- enough to list and search without
 * loading the full metadata for every report. Cheap fields only.
 */
export interface GeneratedItemSummary {
  jobId: string;
  itemIndex: number;
  /** What the operator recognises it by: source filename, else job name, else title. */
  label: string;
  /** ISO. The job's creation time, so the index can be sorted newest-first. */
  createdAt: string;
  promptSet: string | null;
  /** Basename of the analyzed source file, used for filename matching. */
  sourceFilename: string | null;
  /** How many titles the generator produced. */
  titleCount: number;
}

/**
 * The full index, newest first.
 *
 * `unreadable` is a COUNT, not a silent omission: a browse list that is quietly short
 * looks exactly like a complete one, so the number of reports that failed to parse
 * travels with the data and gets shown.
 */
export interface GeneratedIndex {
  items: GeneratedItemSummary[];
  unreadable: number;
}

export class PublishStoreService {
  private readonly baseDir: string;
  private readonly selectionsDir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.selectionsDir = path.join(baseDir, 'selections');
    if (!fs.existsSync(this.selectionsDir)) {
      fs.mkdirSync(this.selectionsDir, { recursive: true });
    }
    console.log('[PublishStore] Initialized:', this.baseDir);
  }

  // ---------------------------------------------------------------- paths / io

  private jobPath(jobId: string): string {
    // jobIds are app-generated (`job-<ts>-<rand>`), but they reach us over IPC, so
    // refuse anything that could escape the selections directory.
    if (!/^[A-Za-z0-9._-]+$/.test(jobId)) {
      throw new Error(`Invalid jobId: ${jobId}`);
    }
    return path.join(this.selectionsDir, `${jobId}.json`);
  }

  private readJobFile(jobId: string): Record<string, ChosenMetadata> {
    const file = this.jobPath(jobId);
    if (!fs.existsSync(file)) return {};
    try {
      const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
      return parsed && typeof parsed === 'object' ? parsed : {};
    } catch (err) {
      // A corrupt selection file must not take down the reports page. Surface it and
      // treat the job as having no selections rather than throwing.
      console.error(`[PublishStore] Corrupt selection file for ${jobId}:`, err);
      return {};
    }
  }

  private writeJobFile(jobId: string, data: Record<string, ChosenMetadata>): void {
    const file = this.jobPath(jobId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2), 'utf8');
    fs.renameSync(tmp, file);  // atomic-ish: never leave a half-written selection file
  }

  // ------------------------------------------------------------------- reading

  /** All selections for a job, keyed by itemIndex. */
  getForJob(jobId: string): Record<number, ChosenMetadata> {
    const raw = this.readJobFile(jobId);
    const out: Record<number, ChosenMetadata> = {};
    for (const [k, v] of Object.entries(raw)) {
      const idx = Number(k);
      if (Number.isInteger(idx)) out[idx] = v;
    }
    return out;
  }

  get(jobId: string, itemIndex: number): ChosenMetadata | null {
    return this.readJobFile(jobId)[String(itemIndex)] ?? null;
  }

  /**
   * Every selection that is far enough along for the extension to act on.
   * This is what backs the extension's pending-work endpoint.
   */
  listActionable(): ChosenMetadata[] {
    const out: ChosenMetadata[] = [];
    let files: string[];
    try {
      files = fs.readdirSync(this.selectionsDir).filter((f) => f.endsWith('.json'));
    } catch {
      return out;
    }
    const actionable: PublishStatus[] = ['ready', 'linked', 'filled'];
    for (const f of files) {
      const jobId = f.replace(/\.json$/, '');
      for (const sel of Object.values(this.getForJob(jobId))) {
        if (actionable.includes(sel.status)) out.push(sel);
      }
    }
    return out;
  }

  // ------------------------------------------------------------------- writing

  /**
   * Read-modify-write a single selection, serialized against every other mutation.
   * Creates the record if it doesn't exist yet.
   */
  update(
    jobId: string,
    itemIndex: number,
    patch: Partial<Omit<ChosenMetadata, 'jobId' | 'itemIndex'>>
  ): Promise<ChosenMetadata> {
    const run = this.writeQueue.then(() => {
      const all = this.readJobFile(jobId);
      const key = String(itemIndex);
      const existing = all[key] ?? emptyChosenMetadata(jobId, itemIndex);

      const next: ChosenMetadata = {
        ...existing,
        ...patch,
        jobId,
        itemIndex,
        updatedAt: new Date().toISOString(),
      };

      if (next.chosenTitles.length > MAX_AB_VARIANTS) {
        throw new Error(
          `Cannot store ${next.chosenTitles.length} titles; YouTube allows ${MAX_AB_VARIANTS} A/B variants.`
        );
      }

      // Status is derived unless the caller set it explicitly: picking titles makes an
      // item 'ready', clearing them drops it back to 'selecting'. Never downgrade a
      // linked/filled/published record just because titles were edited.
      if (patch.status === undefined) {
        const terminal: PublishStatus[] = ['linked', 'filled', 'published'];
        if (!terminal.includes(next.status)) {
          next.status = next.chosenTitles.length > 0 ? 'ready' : 'selecting';
        }
      }

      all[key] = next;
      this.writeJobFile(jobId, all);
      return next;
    });

    // Keep the chain alive on failure so one bad write doesn't poison later ones.
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Forget a single item's selection. */
  clear(jobId: string, itemIndex: number): Promise<void> {
    const run = this.writeQueue.then(() => {
      const all = this.readJobFile(jobId);
      delete all[String(itemIndex)];
      if (Object.keys(all).length === 0) {
        const file = this.jobPath(jobId);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        this.writeJobFile(jobId, all);
      }
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run as Promise<void>;
  }

  /**
   * Forget the selection for a deleted item, and close the gap it leaves.
   *
   * Selections are still keyed by itemIndex (PR B moves them to item ids). An index-keyed
   * map over an array that just had an element spliced out of it is wrong the instant
   * the delete lands: every selection above the hole now names the item BELOW the one it
   * was chosen for, and those chosen A/B titles are served to the extension. So the
   * removal and the shift are one read-modify-write, not two — a crash between them
   * would leave exactly the mis-pointing this exists to prevent.
   *
   * Every live job has one item, so the shift moves nothing today. It is written because
   * the day it does move something, nothing will announce it.
   */
  removeIndexAndShift(jobId: string, itemIndex: number): Promise<{ removed: boolean; shifted: number }> {
    const run = this.writeQueue.then(() => {
      if (!Number.isInteger(itemIndex) || itemIndex < 0) {
        throw new Error(`removeIndexAndShift requires a non-negative item index; got ${itemIndex}`);
      }

      const all = this.readJobFile(jobId);
      const removed = Object.prototype.hasOwnProperty.call(all, String(itemIndex));
      let shifted = 0;

      const next: Record<string, ChosenMetadata> = {};
      for (const [key, value] of Object.entries(all)) {
        const idx = Number(key);
        if (!Number.isInteger(idx)) {
          // A non-numeric key in an index-keyed file is not something to route around.
          throw new Error(`Selection file for ${jobId} has a non-numeric key: ${key}`);
        }
        if (idx === itemIndex) continue;
        if (idx > itemIndex) {
          const movedIndex = idx - 1;
          next[String(movedIndex)] = { ...value, itemIndex: movedIndex };
          shifted++;
        } else {
          next[key] = value;
        }
      }

      if (Object.keys(next).length === 0) {
        const file = this.jobPath(jobId);
        if (fs.existsSync(file)) fs.unlinkSync(file);
      } else {
        this.writeJobFile(jobId, next);
      }

      return { removed, shifted };
    });

    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /** Forget every selection for a job (used when a job is deleted from history). */
  clearJob(jobId: string): Promise<void> {
    const run = this.writeQueue.then(() => {
      const file = this.jobPath(jobId);
      if (fs.existsSync(file)) fs.unlinkSync(file);
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run as Promise<void>;
  }
}

/**
 * Merge a stored selection with the generated values it falls back to.
 *
 * `descriptionOverride` / `tagsOverride` of null mean "the operator didn't edit this",
 * so the current generated value wins -- that way regenerating an item flows through
 * instead of silently serving a stale copy.
 *
 * Pure function, and it takes the generated values as an argument rather than importing
 * them, which is what keeps this module independent of services/metadata.
 */
export function resolveChosenMetadata(
  chosen: ChosenMetadata,
  generated: GeneratedFallback
): ResolvedMetadata {
  // Fall back to the generator's top-3 when the operator hasn't picked yet -- the
  // prompts already order titles with the first three intended as A/B variants.
  const titles = chosen.chosenTitles.length
    ? chosen.chosenTitles
    : (generated.titles || []).slice(0, MAX_AB_VARIANTS);

  return {
    jobId: chosen.jobId,
    itemIndex: chosen.itemIndex,
    channelId: chosen.channelId,
    videoId: chosen.videoId,
    titles,
    description: chosen.descriptionOverride ?? generated.description ?? '',
    tags: chosen.tagsOverride ?? generated.tags ?? '',
    // Stored value wins (it was captured at selection time); otherwise fall back to
    // whatever the host can still determine from the job.
    sourceFilename: chosen.sourceFilename ?? generated.sourceFilename ?? null,
    sourceDurationSec: chosen.sourceDurationSec ?? generated.sourceDurationSec ?? null,
    status: chosen.status,
  };
}
