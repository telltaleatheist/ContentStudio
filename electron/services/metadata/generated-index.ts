/**
 * Generated Report Index
 *
 * Reads the generator's own `<outputDir>/.contentstudio/metadata/<jobId>.json` reports and
 * produces a flat, newest-first index of every generated ITEM (a job can produce many).
 *
 * Lives in services/metadata because it encodes the report file FORMAT — job_id,
 * original_inputs, items[] — which is this module's business. The publish feature consumes
 * it as an injected function and never imports from here, so publish/ stays liftable into
 * another host (the planned AutoCutStudio merge): that host supplies its own reader.
 *
 * The shelf's report browser re-queries this on every search keystroke and the directory
 * runs to tens of megabytes, so results are CACHED PER FILE AND KEYED BY MTIME. A changed
 * mtime re-parses that one file; a deleted file drops out. There is no TTL, which means
 * there is no window in which a stale report can be served.
 */

import * as fs from 'fs';
import * as path from 'path';
import type { GeneratedIndex, GeneratedItemSummary } from '../publish/publish-store.service';
import { isItemId } from './item-identity';

/** Reasons a report file did not make it into the index. Counted, never silently dropped. */
export interface IndexProblem {
  file: string;
  message: string;
}

export interface GeneratedIndexResult extends GeneratedIndex {
  /** Detail behind GeneratedIndex.unreadable, for logging. */
  problems: IndexProblem[];
}

/**
 * Basename of the source file for one item, or null when it has none.
 *
 * Read off the ITEM's own `source_path`, which the generator records at write time (and
 * the migration back-filled). It used to be inferred by indexing `original_inputs` at the
 * item's position and hoping the two arrays lined up — an inference that was already
 * wrong for 16 of the 111 live reports, and that silently attributed one item's source
 * file to another whenever a mid-job item had been deleted.
 *
 * null is the honest answer for a text subject (there is no file) and for a compilation
 * (many files, no single one), and it downgrades draft matching to a manual pick rather
 * than to a wrong one.
 */
export function sourceFilenameOf(item: any): string | null {
  const raw = item?.source_path;
  if (typeof raw !== 'string' || !/\.[A-Za-z0-9]{2,5}$/.test(raw)) return null;
  return path.basename(raw);
}

/**
 * Summaries for every item in one already-parsed report.
 *
 * REQUIRES item_id on every item. After the report migration every item has one, so an
 * item without is a corrupt or hand-edited record — and since the id is what every
 * publish action is keyed by, listing such a row would put something on screen that
 * nothing can act on. It throws, and the index reader counts the file as unreadable and
 * names it (ITEM-ID-PLAN.md §3.4: "after migration, readers REQUIRE item_id").
 */
export function summarizeJob(job: any, fallbackJobId: string): GeneratedItemSummary[] {
  const jobId = typeof job?.job_id === 'string' && job.job_id ? job.job_id : fallbackJobId;
  const createdAt = typeof job?.created_at === 'string' ? job.created_at : '';
  const promptSet = typeof job?.prompt_set === 'string' ? job.prompt_set : null;
  const jobName = typeof job?.job_name === 'string' ? job.job_name : null;
  const items = Array.isArray(job?.items) ? job.items : [];

  return items.map((item: any, itemIndex: number): GeneratedItemSummary => {
    if (!isItemId(item?.item_id)) {
      throw new Error(
        `items[${itemIndex}] has no item_id (${JSON.stringify(item?.item_id)}) — the report has not been migrated, or has been edited by hand.`
      );
    }
    const titles: string[] = Array.isArray(item?.titles) ? item.titles : [];
    const sourceFilename = sourceFilenameOf(item);
    return {
      itemId: item.item_id,
      jobId,
      // Whatever the operator recognises it by, best first.
      label:
        sourceFilename ||
        jobName ||
        (typeof item?._title === 'string' ? item._title : '') ||
        titles[0] ||
        `${jobId} item ${itemIndex + 1}`,
      createdAt,
      promptSet,
      sourceFilename,
      titleCount: titles.length,
    };
  });
}

/**
 * Build a cached index reader.
 *
 * @param metadataDir  Resolves the reports directory. A function, not a string, because
 *                     the output directory is a setting the operator can change at runtime.
 */
export function createGeneratedIndexReader(
  metadataDir: () => string
): () => GeneratedIndexResult {
  const cache = new Map<string, { mtimeMs: number; items: GeneratedItemSummary[] }>();

  return function readGeneratedIndex(): GeneratedIndexResult {
    const dir = metadataDir();

    // A missing directory means nothing has been generated yet — an empty index, not a
    // failure. Every OTHER error (permissions, an unmounted volume) must surface, because
    // "no reports" and "cannot see the reports" are very different facts.
    let files: string[];
    try {
      files = fs.readdirSync(dir).filter((f) => f.endsWith('.json'));
    } catch (error: any) {
      if (error?.code === 'ENOENT') return { items: [], unreadable: 0, problems: [] };
      throw error;
    }

    const items: GeneratedItemSummary[] = [];
    const problems: IndexProblem[] = [];
    const live = new Set<string>();

    for (const file of files) {
      const full = path.join(dir, file);
      live.add(full);

      let mtimeMs: number;
      try {
        mtimeMs = fs.statSync(full).mtimeMs;
      } catch (error) {
        problems.push({ file, message: `cannot stat: ${describe(error)}` });
        continue;
      }

      const cached = cache.get(full);
      if (cached && cached.mtimeMs === mtimeMs) {
        items.push(...cached.items);
        continue;
      }

      let parsed: GeneratedItemSummary[];
      try {
        const job = JSON.parse(fs.readFileSync(full, 'utf8'));
        parsed = summarizeJob(job, file.replace(/\.json$/, ''));
      } catch (error) {
        // One corrupt report must not blank the browser, but it must be COUNTED —
        // a quietly shorter list is indistinguishable from a complete one.
        problems.push({ file, message: describe(error) });
        continue;
      }

      cache.set(full, { mtimeMs, items: parsed });
      items.push(...parsed);
    }

    // Forget reports that no longer exist, so a deleted job doesn't stay listed.
    for (const key of [...cache.keys()]) {
      if (!live.has(key)) cache.delete(key);
    }

    // Newest first: the operator is nearly always after something recent.
    items.sort((a, b) => (b.createdAt || '').localeCompare(a.createdAt || ''));
    return { items, unreadable: problems.length, problems };
  };
}

function describe(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
