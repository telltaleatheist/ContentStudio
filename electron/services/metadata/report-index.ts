/**
 * Report Index
 *
 * The reports page's and the calendar's view of `<outputDir>/.contentstudio/metadata/`:
 * one row per generated ITEM, newest first, carrying everything a browse list needs
 * (which file it lives in, its position inside that file, its display title, its text
 * file) on top of the identity/join facts `GeneratedItemSummary` already describes.
 *
 * Why this exists at all: the reports page used to read and `JSON.parse` all 111 job
 * files IN THE RENDERER, on every mount and every refresh (metadata-reports.ts
 * `loadReports`), and the publish calendar would have needed the same scan a second
 * time. Both now ask the main process, which has been caching these files by mtime for
 * the publish surface since generated-index.ts shipped.
 *
 * Why it is not just `createGeneratedIndexReader`: that index is the PUBLISH projection —
 * the fields carry-forward and the extension bridge join on — and it deliberately says
 * nothing about where a row came from on disk. This one is the BROWSE projection, and it
 * is a superset: it calls `summarizeJob` for the identity half so there is exactly one
 * implementation of "what is an item", and adds the display/location half beside it.
 *
 * Same caching discipline as the generated index, for the same reason: cached per file,
 * keyed by mtime, no TTL, so there is no window in which a stale report is served and a
 * deleted report drops out on the next read.
 *
 * REQUIRES `item_id` on every item of a file (summarizeJob throws without one). A file
 * that has not been migrated is therefore counted and NAMED as unreadable rather than
 * listed with the items that happen to have ids — a half-listed job is indistinguishable
 * from a complete one, and every action on a row is keyed by that id.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GeneratedItemSummary } from '../publish/publish-store.service';
import { IndexProblem, summarizeJob } from './generated-index';

/**
 * One generated item, as a browse list needs it.
 *
 * Extends the publish summary rather than restating it: `itemId`, `jobId`, `label`,
 * `createdAt`, `promptSet`, `sourceFilename`, `sourceKey` and `titleCount` all mean
 * exactly what they mean everywhere else, because they are produced by the same
 * function.
 */
export interface ReportItemRow extends GeneratedItemSummary {
  /** Absolute path of the job JSON this item lives in. What the page opens to read it. */
  jobPath: string;
  /** Size of that job file in bytes, as the directory listing reported it. */
  jobSizeBytes: number;
  /**
   * Position within `items[]`.
   *
   * For READING the array and nothing else — it is not an identity, and the moment a
   * sibling is deleted it names a different item. Every action is keyed by `itemId`.
   */
  itemIndex: number;
  /**
   * What the list prints: the item's own `_title`, else `Item <n>`.
   *
   * Composed here, with the exact expression the renderer used, so the switch to this
   * index cannot change a single rendered row.
   */
  displayTitle: string;
  /** The job's `txt_folder`, or null when the run recorded none. */
  txtFolder: string | null;
  /** The item's own `txt_path`, or null when the run recorded none. */
  txtFilePath: string | null;
  /**
   * The date the row sorts and prints by: the job's `created_at`, else the file's mtime.
   *
   * The mtime leg is not a guess dressed up as data — it is the existing behaviour of
   * the list this replaces (`new Date(jobData.created_at || file.mtime)`), preserved
   * deliberately so the page renders identically. Reports written by the current
   * generator always carry `created_at`.
   */
  dateIso: string;
}

export interface ReportIndexResult {
  rows: ReportItemRow[];
  /** Files that could not be indexed, each with its reason. Counted, never dropped. */
  problems: IndexProblem[];
  /**
   * True when the reports directory does not exist at all.
   *
   * Distinct from "it exists and holds nothing", because the two mean different things
   * to the caller: nothing has been generated yet versus the older on-disk layout may
   * still be in play. Collapsing them is what used to make an unreadable output volume
   * look like an empty list.
   */
  directoryMissing: boolean;
  /** The directory that was read, so the page can name it. */
  directory: string;
}

/**
 * Build a cached index reader.
 *
 * @param metadataDir Resolves the reports directory. A function, not a string, because
 *                    the output directory is a setting the operator can change at runtime.
 */
export function createReportIndexReader(
  metadataDir: () => string
): () => ReportIndexResult {
  // Cached per file by mtime, INCLUDING the files that would not parse. A corrupt report
  // re-read on every call is a file the operator has not fixed; re-parsing it to produce
  // the same message is work for nothing, and the moment it IS fixed its mtime changes and
  // the entry is discarded. Same rule for both outcomes, one rule to reason about.
  const cache = new Map<
    string,
    { mtimeMs: number; rows: ReportItemRow[]; problem: string | null }
  >();

  return function readReportIndex(): ReportIndexResult {
    const dir = metadataDir();

    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (error: any) {
      // A missing directory is a fact the caller acts on (see directoryMissing). Every
      // OTHER error — permissions, an unmounted output volume — must surface: "no
      // reports" and "cannot see the reports" are not the same answer.
      if (error?.code === 'ENOENT') {
        return { rows: [], problems: [], directoryMissing: true, directory: dir };
      }
      throw error;
    }

    const rows: ReportItemRow[] = [];
    const problems: IndexProblem[] = [];
    const live = new Set<string>();

    for (const file of files) {
      const full = path.join(dir, file);
      live.add(full);

      let stat: fs.Stats;
      try {
        stat = fs.statSync(full);
      } catch (error) {
        problems.push({ file, message: `cannot stat: ${describe(error)}` });
        continue;
      }

      const cached = cache.get(full);
      if (cached && cached.mtimeMs === stat.mtimeMs) {
        if (cached.problem !== null) problems.push({ file, message: cached.problem });
        else rows.push(...cached.rows);
        continue;
      }

      let parsed: ReportItemRow[];
      try {
        parsed = projectJobFile(JSON.parse(fs.readFileSync(full, 'utf8')), full, stat);
      } catch (error) {
        // One corrupt report must not blank the browser, but it must be COUNTED and
        // named — a quietly shorter list looks exactly like a complete one.
        const message = describe(error);
        cache.set(full, { mtimeMs: stat.mtimeMs, rows: [], problem: message });
        problems.push({ file, message });
        continue;
      }

      cache.set(full, { mtimeMs: stat.mtimeMs, rows: parsed, problem: null });
      rows.push(...parsed);
    }

    // Forget reports that no longer exist, so a deleted job doesn't stay listed.
    for (const key of [...cache.keys()]) {
      if (!live.has(key)) cache.delete(key);
    }

    // Newest first, by the same key the list sorts on today.
    rows.sort((a, b) => new Date(b.dateIso).getTime() - new Date(a.dateIso).getTime());
    return { rows, problems, directoryMissing: false, directory: dir };
  };
}

/**
 * Every row for one already-parsed job file.
 *
 * Throws — via summarizeJob — when the file has no items array or an item has no
 * `item_id`. Both are the caller's `problems` entry, named by file.
 */
function projectJobFile(job: any, jobPath: string, stat: fs.Stats): ReportItemRow[] {
  const fallbackJobId = path.basename(jobPath).replace(/\.json$/, '');

  // The one thing the browse list refuses that the publish index tolerates: a job file
  // with no `items` array. summarizeJob reads it as zero items, which is right for an
  // index of items — but the reports page skipped and NAMED such a file, because it is
  // corrupt rather than empty, and that distinction is worth keeping.
  if (!Array.isArray(job?.items)) {
    throw new Error('has no items array');
  }
  if (typeof job?.job_id !== 'string' || !job.job_id) {
    // Same rule the renderer applied: no `|| filename` fallback. Every delete and every
    // publish selection is keyed by ids read out of this file, so a file that cannot
    // name itself is not a file to invent a name for.
    throw new Error('has no job_id');
  }

  const summaries = summarizeJob(job, fallbackJobId);
  const txtFolder = typeof job.txt_folder === 'string' && job.txt_folder ? job.txt_folder : null;
  const createdAt = typeof job.created_at === 'string' && job.created_at ? job.created_at : null;
  const mtimeIso = new Date(stat.mtimeMs).toISOString();

  return summaries.map((summary, itemIndex): ReportItemRow => {
    const item = job.items[itemIndex];
    return {
      ...summary,
      jobPath,
      jobSizeBytes: stat.size,
      itemIndex,
      displayTitle:
        typeof item?._title === 'string' && item._title ? item._title : `Item ${itemIndex + 1}`,
      txtFolder,
      txtFilePath: typeof item?.txt_path === 'string' && item.txt_path ? item.txt_path : null,
      dateIso: createdAt ?? mtimeIso,
    };
  });
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
