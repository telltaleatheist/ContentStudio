/**
 * Publish Store Service
 *
 * Persists the operator's CHOSEN metadata (which 3 titles, plus any description/tags
 * edits) and the link from a generated item to a real YouTube video.
 *
 * Layout, under <userData>/publish/ -- deliberately separate from analytics/:
 *
 *   publish/
 *     selections/items/<itemId>.json   one record, one file
 *     selections/orphaned/             legacy files the migration could not resolve
 *
 * ONE FILE PER ITEM, keyed by the item's permanent id. It used to be one file per JOB,
 * a map keyed by the item's POSITION in items[] -- which meant deleting a mid-job item
 * silently re-pointed every selection above it at the wrong item's titles, and those
 * titles were then served to the extension (ITEM-ID-PLAN.md P4/P5). Under this layout a
 * delete is one unlink and a renumber is not expressible.
 *
 * Kept out of the job's own <jobId>.json on purpose: that file is the raw generator
 * output and should stay pristine, so an item can be regenerated without losing (or
 * silently keeping) a stale selection.
 *
 * All mutations run through a serialized write queue, matching the discipline in
 * OutputHandlerService / AnalyticsStoreService -- the renderer, the IPC layer and the
 * extension's ingest server can all touch this concurrently.
 *
 * NOTHING here recovers from a corrupt record. A selection file that will not parse is
 * the operator's hand-curated A/B choice in an unreadable state; reporting it as "no
 * selection" would look exactly like an item they never opened, and the next write would
 * overwrite it. It throws, naming the file.
 */

import * as fs from 'fs';
import * as path from 'path';
import {
  ChosenMetadata,
  ResolvedMetadata,
  PublishStatus,
  emptyChosenMetadata,
  isItemId,
  upgradeStoredMetadata,
  MAX_AB_VARIANTS,
} from './publish-types';

/** The generated values a selection falls back to. Supplied by the caller so this
 *  module never has to import from services/metadata. */
export interface GeneratedFallback {
  /**
   * The run that produced this item. Carried on the generated values because the store
   * records it as a display back-reference, and the reader is the only thing that knows
   * which report file the item came out of.
   */
  jobId: string;
  titles: string[];
  description: string;
  tags: string;
  /** Basename of the analyzed source file, when the host can determine it. */
  sourceFilename?: string | null;
  /**
   * FULL path to the analyzed source file, when the host can determine it.
   *
   * Distinct from sourceFilename, which is a basename for matching a YouTube title. This
   * is the one thing that can locate the item's week on disk, and therefore the only
   * input the thumbnail proposal has (<week>/complete/<slot> - <label>.mov beside
   * <week>/thumbnails/<slot> - youtube-thumbnail.png). null for a text subject or a
   * compilation, both of which have no single source file and therefore no proposal.
   */
  sourcePath?: string | null;
  /** Source duration in seconds, when known. null just means the match is unverified. */
  sourceDurationSec?: number | null;
}

/**
 * One entry in the host's index of generated items -- enough to list and search without
 * loading the full metadata for every report. Cheap fields only.
 */
export interface GeneratedItemSummary {
  /** The item's permanent id. The only field here that is an identity. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
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

/** What clearing a whole job's selections actually did. */
export interface JobSelectionClear {
  /** Files unlinked. */
  removed: number;
  /**
   * Files that could not be read, and were therefore LEFT: a record we cannot attribute
   * to a job is not a record to delete on that job's behalf. Named, never counted away.
   */
  unreadable: string[];
}

export class PublishStoreService {
  private readonly baseDir: string;
  private readonly selectionsDir: string;
  private readonly itemsDir: string;
  private writeQueue: Promise<unknown> = Promise.resolve();

  constructor(baseDir: string) {
    this.baseDir = baseDir;
    this.selectionsDir = path.join(baseDir, 'selections');
    this.itemsDir = path.join(this.selectionsDir, 'items');
    if (!fs.existsSync(this.itemsDir)) {
      fs.mkdirSync(this.itemsDir, { recursive: true });
    }
    console.log('[PublishStore] Initialized:', this.baseDir);
  }

  /** Where the per-item records live. The migration writes into this same directory. */
  get selectionsItemsDir(): string {
    return this.itemsDir;
  }

  // ---------------------------------------------------------------- paths / io

  private itemPath(itemId: string): string {
    // Item ids are app-minted, but they reach us over IPC and over the extension's HTTP
    // routes, and they are turned into filenames. An id that is not exactly the minted
    // shape is refused rather than sanitized -- a coerced id names a different record.
    if (!isItemId(itemId)) {
      throw new Error(`Invalid item id: ${JSON.stringify(itemId)}`);
    }
    return path.join(this.itemsDir, `${itemId}.json`);
  }

  private readItemFile(itemId: string): ChosenMetadata | null {
    const file = this.itemPath(itemId);
    if (!fs.existsSync(file)) return null;

    let parsed: unknown;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      throw new Error(
        `Selection file ${file} could not be read: ${err instanceof Error ? err.message : String(err)}`
      );
    }
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`Selection file ${file} does not contain a selection record.`);
    }
    const record = parsed as ChosenMetadata;
    if (record.itemId !== itemId) {
      // The filename and the record disagree about which item this is. One of them is
      // wrong and there is no way to tell which, so neither is used.
      throw new Error(
        `Selection file ${file} records item ${JSON.stringify(record.itemId)} — the file name and its contents disagree.`
      );
    }
    // Fields added after this record was written get the value they would have been born
    // with. See upgradeStoredMetadata: a one-way schema upgrade, not a repair — anything
    // present is returned exactly as stored.
    return upgradeStoredMetadata(record);
  }

  private writeItemFile(record: ChosenMetadata): void {
    const file = this.itemPath(record.itemId);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
    fs.renameSync(tmp, file);  // atomic-ish: never leave a half-written selection file
  }

  /** Every item id with a record on disk. */
  private listItemIds(): string[] {
    return fs
      .readdirSync(this.itemsDir)
      .filter((f) => f.endsWith('.json'))
      .map((f) => f.replace(/\.json$/, ''));
  }

  // ------------------------------------------------------------------- reading

  /** One item's selection, or null when the operator has never touched it. */
  get(itemId: string): ChosenMetadata | null {
    return this.readItemFile(itemId);
  }

  /**
   * Every selection that is far enough along for the extension to act on.
   * This is what backs the extension's pending-work endpoint.
   */
  listActionable(): ChosenMetadata[] {
    const actionable: PublishStatus[] = ['ready', 'linked', 'filled'];
    const out: ChosenMetadata[] = [];
    for (const itemId of this.listItemIds()) {
      // Not caught: an unreadable selection is a fault to report, not a row to drop.
      // A silently short pending list is indistinguishable from an empty in-tray.
      const record = this.readItemFile(itemId);
      if (record && actionable.includes(record.status)) out.push(record);
    }
    return out;
  }

  // ------------------------------------------------------------------- writing

  /**
   * Read-modify-write a single selection, serialized against every other mutation.
   * Creates the record if it doesn't exist yet.
   *
   * `jobId` is required for the create case only -- it is the record's display
   * back-reference. It is taken from the generated item the caller just read, so it is
   * always the job the item actually came from.
   */
  update(
    itemId: string,
    jobId: string,
    patch: Partial<Omit<ChosenMetadata, 'itemId' | 'jobId'>>
  ): Promise<ChosenMetadata> {
    const run = this.writeQueue.then(() => {
      const existing = this.readItemFile(itemId) ?? emptyChosenMetadata(itemId, jobId);

      const next: ChosenMetadata = {
        ...existing,
        ...patch,
        itemId,
        jobId,
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

      this.writeItemFile(next);
      return next;
    });

    // Keep the chain alive on failure so one bad write doesn't poison later ones.
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Forget one item's selection: one unlink.
   *
   * This replaces `clear(jobId, itemIndex)` AND the `removeIndexAndShift` bridge that
   * PR A needed while selections were still index-keyed. There is no shift, because
   * there is no longer anything a sibling's deletion could move.
   */
  clearItem(itemId: string): Promise<{ removed: boolean }> {
    const run = this.writeQueue.then(() => {
      const file = this.itemPath(itemId);
      if (!fs.existsSync(file)) return { removed: false };
      fs.unlinkSync(file);
      return { removed: true };
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
  }

  /**
   * Forget every selection belonging to a job (used when a job is deleted from history).
   *
   * The job is no longer a directory entry, so this is a scan-and-match over the records'
   * `jobId` back-reference rather than a single unlink. A record that cannot be read is
   * LEFT and NAMED: it might belong to this job or to another one, and deleting a file we
   * could not attribute is exactly the class of bug this whole layout exists to end.
   */
  clearItemsOfJob(jobId: string): Promise<JobSelectionClear> {
    const run = this.writeQueue.then(() => {
      if (typeof jobId !== 'string' || !jobId.trim()) {
        throw new Error(`clearItemsOfJob requires a non-empty jobId; got ${JSON.stringify(jobId)}`);
      }

      const result: JobSelectionClear = { removed: 0, unreadable: [] };
      for (const itemId of this.listItemIds()) {
        let record: ChosenMetadata | null;
        try {
          record = this.readItemFile(itemId);
        } catch (err) {
          result.unreadable.push(
            `${itemId}.json (${err instanceof Error ? err.message : String(err)})`
          );
          continue;
        }
        if (!record || record.jobId !== jobId) continue;
        fs.unlinkSync(this.itemPath(itemId));
        result.removed++;
      }
      return result;
    });
    this.writeQueue = run.then(() => undefined, () => undefined);
    return run;
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
    itemId: chosen.itemId,
    jobId: chosen.jobId,
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
