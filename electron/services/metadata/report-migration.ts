/**
 * Report migration — retro-fit item identity onto pre-existing job files, once.
 *
 * Every report written before item-identity.ts identified its items by POSITION. This
 * walks the reports directory and gives each item the three things the app now requires
 * of it: an `item_id`, the `txt_path` of the text file that was written for it, and the
 * `source_key` it was generated from. The file is then stamped `schema_version: 2` and
 * never looked at again.
 *
 * Three rules, all of them the same rule:
 *
 * - It runs LAZILY, on a successful read of the reports directory, never at boot. The
 *   output directory is an external volume; a migration that ran at startup with Callisto
 *   unmounted would report "0 files migrated" — a true sentence about nothing, which the
 *   operator would read as "done".
 * - It NEVER guesses. A txt file it cannot match unambiguously is recorded as `null`,
 *   which is a stated fact ("we do not know where this item's text is"), and the delete
 *   path prints that fact rather than deleting a file it merely suspects. A `source_key`
 *   is derived only from arrays that actually line up with items[].
 * - It reports. Every file it could not read is named, and the counts of what it did
 *   reach the operator's eyes.
 *
 * Selection files are deliberately NOT migrated here. PR B repoints the publish store to
 * per-item files; moving the files before their readers move would leave 44 selections
 * that nothing reads — invisible data loss dressed as progress.
 */

import * as fs from 'fs';
import * as path from 'path';
import { SCHEMA_VERSION, isItemId, mintItemId, sourceKeyOf } from './item-identity';
import { sanitizeItemFilename } from './output-handler.service';

export interface ReportMigrationReceipt {
  metadataDir: string;
  filesScanned: number;
  /** Files that were rewritten. */
  filesMigrated: number;
  /** Files already at schema_version >= 2 — the idempotent skip. */
  filesAlreadyCurrent: number;
  itemIdsMinted: number;
  txtPathsResolved: number;
  /** Items whose text file could not be matched unambiguously; recorded as null. */
  txtPathsUnresolved: number;
  sourceKeysDerived: number;
  /** Text subjects, compilations, and jobs whose arrays don't line up with items[]. */
  sourceKeysNull: number;
  /** Named, never swallowed. */
  failures: Array<{ file: string; error: string }>;
}

/** Per-file tallies, folded into the receipt. */
interface FileStats {
  itemIdsMinted: number;
  txtPathsResolved: number;
  txtPathsUnresolved: number;
  sourceKeysDerived: number;
  sourceKeysNull: number;
}

const EMPTY_STATS = (): FileStats => ({
  itemIdsMinted: 0,
  txtPathsResolved: 0,
  txtPathsUnresolved: 0,
  sourceKeysDerived: 0,
  sourceKeysNull: 0,
});

/**
 * Migrate one already-parsed job object in memory. Pure apart from the folder listing,
 * which is injected so this can be reasoned about (and exercised) without touching disk.
 *
 * Returns whether anything changed; the caller writes only when it did.
 */
export function migrateJobObject(
  job: any,
  listFolder: (folder: string) => string[]
): { changed: boolean; stats: FileStats } {
  const stats = EMPTY_STATS();

  if (!job || typeof job !== 'object') {
    throw new Error('not a JSON object');
  }
  if (typeof job.schema_version === 'number' && job.schema_version >= SCHEMA_VERSION) {
    return { changed: false, stats };
  }
  if (!Array.isArray(job.items)) {
    throw new Error('items is not an array');
  }

  const items: any[] = job.items;
  let changed = job.schema_version !== SCHEMA_VERSION;

  // ---- txt_path resolution -------------------------------------------------
  //
  // The generator wrote `<sanitized _title>.txt` into txt_folder, de-colliding with
  // " (1)", " (2)". Reversing that is only safe when exactly ONE file in the folder
  // could have come from this item's title: a folder holding both `X.txt` and
  // `X (1).txt` is a folder where two runs produced the same title, and picking either
  // one for either item is a coin toss dressed as a record. Both get null.
  const folderFiles = typeof job.txt_folder === 'string' && job.txt_folder
    ? listFolder(job.txt_folder)
    : [];

  const baseOf = (item: any): string =>
    sanitizeItemFilename(typeof item?._title === 'string' ? item._title : '');

  // A base shared by two items in THIS job is ambiguous no matter what the folder holds.
  const baseCounts = new Map<string, number>();
  for (const item of items) {
    const base = baseOf(item);
    if (base) baseCounts.set(base, (baseCounts.get(base) ?? 0) + 1);
  }

  const resolveTxtPath = (item: any): string | null => {
    const base = baseOf(item);
    if (!base || (baseCounts.get(base) ?? 0) !== 1) return null;
    const pattern = new RegExp(`^${escapeRegExp(base)}(?: \\(\\d+\\))?\\.txt$`);
    const matches = folderFiles.filter((name) => pattern.test(name));
    if (matches.length !== 1) return null;
    return path.join(job.txt_folder, matches[0]);
  };

  // ---- source_key derivation -----------------------------------------------
  //
  // Only when BOTH companion arrays are the same length as items[], because that is the
  // only case in which position means the same thing in all three. Compilations (one
  // item, N inputs) and the eleven zero-item failures do not qualify, and neither does
  // anything else that has drifted; those items get an explicit null.
  const inputs: string[] | null = Array.isArray(job.original_inputs)
    && job.original_inputs.length === items.length
    ? job.original_inputs
    : null;
  const types: string[] | null = Array.isArray(job.input_types)
    && job.input_types.length === items.length
    ? job.input_types
    : null;
  const arraysAlign = inputs !== null && types !== null;

  for (let i = 0; i < items.length; i++) {
    const item = items[i];
    if (!item || typeof item !== 'object') {
      throw new Error(`items[${i}] is not an object`);
    }

    if (!isItemId(item.item_id)) {
      item.item_id = mintItemId();
      stats.itemIdsMinted++;
      changed = true;
    }

    if (typeof item.txt_path !== 'string' || !item.txt_path.trim()) {
      const resolved = resolveTxtPath(item);
      item.txt_path = resolved;
      if (resolved) stats.txtPathsResolved++;
      else stats.txtPathsUnresolved++;
      changed = true;
    } else {
      stats.txtPathsResolved++;
    }

    if (item.source_key === undefined || item.source_path === undefined) {
      if (arraysAlign && types![i] !== 'subject' && typeof inputs![i] === 'string' && inputs![i].trim()) {
        item.source_key = sourceKeyOf(inputs![i]);
        item.source_path = inputs![i];
        stats.sourceKeysDerived++;
      } else {
        item.source_key = null;
        item.source_path = null;
        stats.sourceKeysNull++;
      }
      changed = true;
    } else if (item.source_key === null) {
      stats.sourceKeysNull++;
    } else {
      stats.sourceKeysDerived++;
    }
  }

  job.schema_version = SCHEMA_VERSION;
  return { changed, stats };
}

/**
 * Walk the reports directory and migrate every job file in it.
 *
 * Throws when the directory itself cannot be read — an unreadable reports directory is
 * not "nothing to migrate", and the caller must not record the migration as done.
 * A single unreadable FILE is a named failure and the sweep continues, because one bad
 * file must not hide the rest.
 */
export function migrateReports(metadataDir: string): ReportMigrationReceipt {
  const receipt: ReportMigrationReceipt = {
    metadataDir,
    filesScanned: 0,
    filesMigrated: 0,
    filesAlreadyCurrent: 0,
    itemIdsMinted: 0,
    txtPathsResolved: 0,
    txtPathsUnresolved: 0,
    sourceKeysDerived: 0,
    sourceKeysNull: 0,
    failures: [],
  };

  const entries = fs.readdirSync(metadataDir);

  // One listing per txt folder, not one per item: seven jobs share a folder in the live
  // data, and the folders sit on an external volume.
  const folderCache = new Map<string, string[]>();
  const listFolder = (folder: string): string[] => {
    const cached = folderCache.get(folder);
    if (cached) return cached;
    let names: string[];
    try {
      names = fs.readdirSync(folder);
    } catch {
      // A missing or unreadable txt folder is not a failure of the file: it means the
      // text output is gone, which resolves every item in it to null — a fact.
      names = [];
    }
    folderCache.set(folder, names);
    return names;
  };

  for (const entry of entries) {
    if (!entry.startsWith('job-') || !entry.endsWith('.json')) continue;
    receipt.filesScanned++;

    const filePath = path.join(metadataDir, entry);
    try {
      const job = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      const { changed, stats } = migrateJobObject(job, listFolder);

      receipt.itemIdsMinted += stats.itemIdsMinted;
      receipt.txtPathsResolved += stats.txtPathsResolved;
      receipt.txtPathsUnresolved += stats.txtPathsUnresolved;
      receipt.sourceKeysDerived += stats.sourceKeysDerived;
      receipt.sourceKeysNull += stats.sourceKeysNull;

      if (!changed) {
        receipt.filesAlreadyCurrent++;
        continue;
      }

      const tmp = `${filePath}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(job, null, 2), 'utf8');
      fs.renameSync(tmp, filePath);
      receipt.filesMigrated++;
    } catch (error) {
      receipt.failures.push({
        file: entry,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return receipt;
}

/** Did the migration actually do (or fail to do) anything worth telling the operator? */
export function migrationIsNoteworthy(receipt: ReportMigrationReceipt): boolean {
  return receipt.filesMigrated > 0 || receipt.failures.length > 0;
}

/** One paragraph, in the operator's terms. */
export function describeMigration(receipt: ReportMigrationReceipt): string {
  const parts: string[] = [];
  parts.push(
    `${receipt.filesMigrated} report file${receipt.filesMigrated === 1 ? '' : 's'} updated ` +
    `(${receipt.itemIdsMinted} item${receipt.itemIdsMinted === 1 ? '' : 's'} given a permanent id).`
  );
  if (receipt.txtPathsResolved > 0 || receipt.txtPathsUnresolved > 0) {
    parts.push(
      `Text files: ${receipt.txtPathsResolved} matched to their item, ` +
      `${receipt.txtPathsUnresolved} could not be matched and are recorded as unknown ` +
      `(deleting those items will leave their .txt on disk and say so).`
    );
  }
  if (receipt.failures.length > 0) {
    const named = receipt.failures.slice(0, 5).map((f) => `${f.file} (${f.error})`).join('; ');
    parts.push(
      `${receipt.failures.length} file${receipt.failures.length === 1 ? '' : 's'} could not be migrated: ${named}` +
      (receipt.failures.length > 5 ? `, and ${receipt.failures.length - 5} more.` : '.')
    );
  }
  return parts.join(' ');
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
