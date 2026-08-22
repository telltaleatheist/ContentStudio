/**
 * Selection migration — move the operator's publish selections off positions and onto
 * item ids, once.
 *
 * The old layout was `selections/<jobId>.json`, a map keyed by the item's POSITION in
 * the job's items[]. The new one is `selections/items/<itemId>.json`, one record per
 * file. This walks the former and produces the latter.
 *
 * ORDERING IS THE WHOLE PROBLEM. An index can only be turned into an id by asking the
 * report file what the item at that index is called, and report files only acquired
 * item_ids in the report migration (report-migration.ts). So this must run AFTER that
 * sweep has succeeded, against the files it just wrote — never before, and never on its
 * own schedule. The caller enforces that by running both in one pass; see
 * ipc-handlers.ts's `reports-ensure-migrated`.
 *
 * The resolver is INJECTED rather than reading report files here, for the same reason
 * every other seam in publish/ is injected: this directory must not know the generator's
 * file format, so it can be lifted into another host.
 *
 * Three rules:
 *
 * - It NEVER deletes. A file it cannot resolve is MOVED to `selections/orphaned/` intact
 *   and counted. Those are hand-picked A/B titles, description overrides and a videoId
 *   link; "we could not work out which item this belongs to" is a thing to say, not a
 *   thing to tidy away.
 * - A file migrates ALL of its entries or NONE of them. A half-moved file would be a file
 *   whose remaining keys still mean positions, sitting in a directory nothing reads.
 * - It is idempotent: once the legacy files are gone there is nothing to find, and a
 *   second pass reports zeros rather than doing something.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ChosenMetadata, isItemId } from './publish-types';

export interface SelectionMigrationReceipt {
  selectionsDir: string;
  /** Legacy `<jobId>.json` files found directly in selections/. */
  filesScanned: number;
  /** Files whose every entry resolved, and which were rewritten as per-item records. */
  filesMigrated: number;
  /** Per-item records written. */
  selectionsMigrated: number;
  /** Files moved to selections/orphaned/ because an entry could not be resolved. */
  filesOrphaned: number;
  /** Where those went, so the operator can go and look. */
  orphanedDir: string;
  /** Named, never swallowed. The file is left exactly where it was. */
  failures: Array<{ file: string; error: string }>;
}

/**
 * Resolve one legacy (jobId, itemIndex) pair to the item's permanent id.
 *
 * Returns null when the pair names nothing on disk — a job whose report file is gone, or
 * an index past the end of its items[]. Null is a fact ("no such item"), and its file is
 * orphaned rather than guessed at.
 */
export type ItemIdResolver = (jobId: string, itemIndex: number) => string | null;

/**
 * Migrate every legacy selection file in `selectionsDir`.
 *
 * Throws when the directory itself cannot be read: an unreadable selections directory is
 * not "nothing to migrate", and the caller must not record the migration as done.
 */
export function migrateSelections(
  selectionsDir: string,
  itemsDir: string,
  resolveItemId: ItemIdResolver
): SelectionMigrationReceipt {
  const orphanedDir = path.join(selectionsDir, 'orphaned');
  const receipt: SelectionMigrationReceipt = {
    selectionsDir,
    filesScanned: 0,
    filesMigrated: 0,
    selectionsMigrated: 0,
    filesOrphaned: 0,
    orphanedDir,
    failures: [],
  };

  // Only files directly in selections/ are legacy. `items/` and `orphaned/` are the new
  // layout and this must not walk into them.
  const entries = fs.readdirSync(selectionsDir, { withFileTypes: true });

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.json')) continue;
    receipt.filesScanned++;

    const filePath = path.join(selectionsDir, entry.name);
    const jobId = entry.name.replace(/\.json$/, '');

    try {
      const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        throw new Error('not a selection map');
      }

      // Resolve EVERY entry before writing ANY of them.
      const resolved: Array<{ itemId: string; record: ChosenMetadata }> = [];
      let unresolved: string | null = null;

      for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
        const itemIndex = Number(key);
        if (!Number.isInteger(itemIndex) || itemIndex < 0) {
          throw new Error(`key ${JSON.stringify(key)} is not an item index`);
        }
        if (!value || typeof value !== 'object') {
          throw new Error(`entry ${key} is not a selection record`);
        }

        const itemId = resolveItemId(jobId, itemIndex);
        if (itemId === null) {
          unresolved = `item ${itemIndex}`;
          break;
        }
        if (!isItemId(itemId)) {
          throw new Error(`resolver returned a malformed item id for item ${itemIndex}: ${JSON.stringify(itemId)}`);
        }

        const target = path.join(itemsDir, `${itemId}.json`);
        if (fs.existsSync(target)) {
          // Two legacy files claiming one item. Nothing here can say which is current, so
          // neither wins and the operator is told.
          throw new Error(`item ${itemIndex} resolves to ${itemId}, which already has a selection file`);
        }

        // The legacy record minus its position, plus its identity. jobId comes from the
        // FILE NAME, not from the record's own copy of it, because the file name is what
        // the resolution above was actually based on.
        const { itemIndex: _position, jobId: _staleJobId, ...rest } = value as Record<string, unknown>;
        resolved.push({
          itemId,
          record: { itemId, jobId, ...(rest as object) } as ChosenMetadata,
        });
      }

      if (unresolved !== null) {
        moveToOrphaned(filePath, orphanedDir, entry.name);
        receipt.filesOrphaned++;
        continue;
      }

      for (const { itemId, record } of resolved) {
        const target = path.join(itemsDir, `${itemId}.json`);
        const tmp = `${target}.tmp`;
        fs.writeFileSync(tmp, JSON.stringify(record, null, 2), 'utf8');
        fs.renameSync(tmp, target);
        receipt.selectionsMigrated++;
      }

      // Only once every record is safely on disk under its new name.
      fs.unlinkSync(filePath);
      receipt.filesMigrated++;
    } catch (error) {
      // Left exactly where it is, so the next pass tries again rather than trusting a
      // move that was based on something we could not read.
      receipt.failures.push({
        file: entry.name,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return receipt;
}

/**
 * Move, never delete, and never overwrite: a second orphan of the same name gets a
 * suffix rather than replacing the first.
 */
function moveToOrphaned(filePath: string, orphanedDir: string, name: string): void {
  if (!fs.existsSync(orphanedDir)) {
    fs.mkdirSync(orphanedDir, { recursive: true });
  }
  let target = path.join(orphanedDir, name);
  let n = 1;
  while (fs.existsSync(target)) {
    target = path.join(orphanedDir, name.replace(/\.json$/, `.${n}.json`));
    n++;
  }
  fs.renameSync(filePath, target);
}

/** Did the selection migration do (or fail to do) anything worth telling the operator? */
export function selectionMigrationIsNoteworthy(receipt: SelectionMigrationReceipt): boolean {
  return receipt.filesMigrated > 0 || receipt.filesOrphaned > 0 || receipt.failures.length > 0;
}

/** One sentence, in the operator's terms. Joined onto the report migration's own. */
export function describeSelectionMigration(receipt: SelectionMigrationReceipt): string {
  const parts: string[] = [];
  if (receipt.filesMigrated > 0) {
    parts.push(
      `${receipt.selectionsMigrated} publish selection${receipt.selectionsMigrated === 1 ? '' : 's'} ` +
      `moved onto permanent item ids.`
    );
  }
  if (receipt.filesOrphaned > 0) {
    parts.push(
      `${receipt.filesOrphaned} selection file${receipt.filesOrphaned === 1 ? ' could not be matched to an item and was' : 's could not be matched to an item and were'} ` +
      `moved, unchanged, to ${receipt.orphanedDir}.`
    );
  }
  if (receipt.failures.length > 0) {
    const named = receipt.failures.slice(0, 5).map((f) => `${f.file} (${f.error})`).join('; ');
    parts.push(
      `${receipt.failures.length} selection file${receipt.failures.length === 1 ? ' could not be migrated and was' : 's could not be migrated and were'} ` +
      `left in place: ${named}` +
      (receipt.failures.length > 5 ? `, and ${receipt.failures.length - 5} more.` : '.')
    );
  }
  return parts.join(' ');
}
