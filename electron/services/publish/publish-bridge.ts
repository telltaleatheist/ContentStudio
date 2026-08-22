/**
 * Publish Bridge
 *
 * What the companion extension talks to. Exposed over the existing localhost ingest
 * server (127.0.0.1:43117) rather than a second server, so there's still only one port
 * to configure -- but the server only knows a structural interface, so analytics/ and
 * publish/ stay decoupled in both directions.
 *
 * All the matching intelligence lives HERE, not in the extension. The extension reports
 * only what it can see on the page (the videoId from the URL, the original filename from
 * the Studio sidebar) and this decides which generated item that is. That keeps the
 * fragile, hard-to-update half thin and the tested half in the app.
 *
 * Two reader functions are INJECTED by the host rather than imported:
 *   readGenerated  -- one item's generated titles/description/tags
 *   listGenerated  -- an index of every generated item, newest first
 * That is what keeps this directory free of any services/metadata dependency, so the
 * whole publish feature can be lifted into another host (the planned AutoCutStudio
 * merge) by supplying two functions.
 */

import {
  PublishStoreService,
  GeneratedFallback,
  GeneratedIndex,
  resolveChosenMetadata,
} from './publish-store.service';
import {
  MAX_AB_VARIANTS,
  MAX_TITLE_LENGTH,
  PublishStatus,
  emptyChosenMetadata,
  normalizeForMatch,
  validateChosenTitles,
} from './publish-types';

/** One item the extension can fill, with everything it needs to do it. */
export interface PendingFillItem {
  /** The item's permanent id — what every call back into ContentStudio names. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  /** Ordered. titles[0] is the main title AND A/B variant 1. */
  titles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  channelId: string | null;
  videoId: string | null;
  status: string;
  /** Display label for the extension's list. */
  label: string;
}

export interface ResolveOutcome {
  item: PendingFillItem | null;
  reason: string;
  /** True when the item was already explicitly linked to this videoId. */
  linked: boolean;
  /**
   * Set when a report matched but has no titles picked yet, so the shelf knows to open
   * its picker instead of offering a fill it can't perform properly.
   */
  needsTitles: boolean;
}

/**
 * One row in the shelf's report browser.
 *
 * `status: 'none'` is distinct from `'selecting'`: 'none' means no selection record
 * exists at all, 'selecting' means one exists with an empty title set. Collapsing them
 * would hide the difference between "never opened" and "deliberately cleared".
 */
export interface BrowseRow {
  /** The item's permanent id — what opening this row sends back. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  label: string;
  createdAt: string;
  promptSet: string | null;
  /** How many titles the generator produced for this item. */
  titleCount: number;
  /** How many the operator has picked. */
  chosenCount: number;
  status: PublishStatus | 'none';
  videoId: string | null;
}

export interface BrowsePage {
  rows: BrowseRow[];
  /** Total matching the query, so the shelf can size its scrollbar without fetching all. */
  total: number;
  offset: number;
  /**
   * Report files that could not be read at all. Reported rather than hidden -- a
   * silently shorter list looks like a complete list.
   */
  unreadable: number;
}

/** Everything the shelf needs to pick titles for one item. */
export interface ItemDetail {
  /** The item's permanent id — what saving titles for it names. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  label: string;
  createdAt: string;
  /** EVERY generated title, not just the chosen ones -- this is the picker's source. */
  generatedTitles: string[];
  /** Ordered chosen subset. Empty when nothing is picked yet. */
  chosenTitles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  status: PublishStatus | 'none';
  videoId: string | null;
  /** Sent along so the shelf never hard-codes YouTube's limits. */
  maxVariants: number;
  maxTitleLength: number;
}

/**
 * Validation failures are an expected outcome of a shelf click, not an exception --
 * the operator gets the reason in the shelf rather than a 500.
 */
export type SetTitlesResult =
  | { ok: true; item: ItemDetail }
  | { ok: false; errors: string[] };

const MAX_BROWSE_LIMIT = 200;

export class PublishBridge {
  constructor(
    private store: PublishStoreService,
    private readGenerated: (itemId: string) => GeneratedFallback | null,
    private listGenerated: () => GeneratedIndex
  ) {}

  private toPending(itemId: string): PendingFillItem | null {
    const generated = this.readGenerated(itemId);
    if (!generated) return null;

    const chosen = this.store.get(itemId);
    if (!chosen) return null;

    const r = resolveChosenMetadata(chosen, generated);
    return {
      itemId: r.itemId,
      jobId: r.jobId,
      titles: r.titles,
      description: r.description,
      tags: r.tags,
      sourceFilename: r.sourceFilename,
      channelId: r.channelId,
      videoId: r.videoId,
      status: r.status,
      label: r.sourceFilename || r.titles[0] || itemId,
    };
  }

  /** Everything with titles picked that hasn't been published yet. */
  async listPending(): Promise<PendingFillItem[]> {
    const out: PendingFillItem[] = [];
    for (const sel of this.store.listActionable()) {
      const item = this.toPending(sel.itemId);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * A page of the full report index, so the shelf can reach ANY generated item rather
   * than only the ones already picked. Newest first -- the operator is almost always
   * after something recent, and older pages load as they scroll.
   */
  async listReports(offset: number, limit: number, query: string): Promise<BrowsePage> {
    const index = this.listGenerated();

    const needle = query.trim().toLowerCase();
    const matching = needle
      ? index.items.filter((i) => i.label.toLowerCase().includes(needle))
      : index.items;

    const safeOffset = Math.max(0, Math.floor(offset));
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), MAX_BROWSE_LIMIT);
    const slice = matching.slice(safeOffset, safeOffset + safeLimit);

    // Only the requested page touches the selection store, so browsing 1,000 reports
    // doesn't mean 1,000 file reads.
    const rows: BrowseRow[] = slice.map((i) => {
      const chosen = this.store.get(i.itemId);
      return {
        itemId: i.itemId,
        jobId: i.jobId,
        label: i.label,
        createdAt: i.createdAt,
        promptSet: i.promptSet,
        titleCount: i.titleCount,
        chosenCount: chosen ? chosen.chosenTitles.length : 0,
        status: chosen ? chosen.status : 'none',
        videoId: chosen ? chosen.videoId : null,
      };
    });

    return { rows, total: matching.length, offset: safeOffset, unreadable: index.unreadable };
  }

  /**
   * Full detail for one item: every generated title plus whatever is already picked.
   * Returns null when the item no longer exists on disk.
   */
  async getItem(itemId: string): Promise<ItemDetail | null> {
    const generated = this.readGenerated(itemId);
    if (!generated) return null;

    const chosen = this.store.get(itemId);
    const summary = this.listGenerated().items.find((i) => i.itemId === itemId);

    const sourceFilename = chosen?.sourceFilename ?? generated.sourceFilename ?? null;
    const generatedTitles = generated.titles ?? [];

    return {
      itemId,
      jobId: generated.jobId,
      label: summary?.label ?? sourceFilename ?? generatedTitles[0] ?? itemId,
      createdAt: summary?.createdAt ?? '',
      generatedTitles,
      chosenTitles: chosen?.chosenTitles ?? [],
      description: chosen?.descriptionOverride ?? generated.description ?? '',
      tags: chosen?.tagsOverride ?? generated.tags ?? '',
      sourceFilename,
      status: chosen ? chosen.status : 'none',
      videoId: chosen ? chosen.videoId : null,
      maxVariants: MAX_AB_VARIANTS,
      maxTitleLength: MAX_TITLE_LENGTH,
    };
  }

  /**
   * Set the chosen title set from the shelf. Order is preserved exactly as sent, because
   * index 0 becomes the video's main title and the variant YouTube keeps if the test is
   * inconclusive.
   *
   * The same validation the reports page goes through -- the shelf is a second entry
   * point to one store, not a second set of rules.
   */
  async setTitles(itemId: string, titles: string[]): Promise<SetTitlesResult> {
    const generated = this.readGenerated(itemId);
    if (!generated) {
      return { ok: false, errors: [`No generated item ${itemId} on disk.`] };
    }

    const cleaned = titles.map((t) => t.trim()).filter(Boolean);
    // An empty set is legal: it's how the operator deselects everything.
    if (cleaned.length > 0) {
      const errors = validateChosenTitles(cleaned);
      if (errors.length) return { ok: false, errors };
    }

    await this.store.update(itemId, generated, {
      chosenTitles: cleaned,
      // Capture the source filename at selection time -- the job's input path may be
      // gone by the time this is filled.
      ...(generated.sourceFilename ? { sourceFilename: generated.sourceFilename } : {}),
    });

    const item = await this.getItem(itemId);
    if (!item) {
      // Cannot happen: readGenerated just succeeded above. Loud rather than a silent null.
      throw new Error(`Saved titles for ${itemId} but could not read it back.`);
    }
    return { ok: true, item };
  }

  /**
   * Given what the extension sees on a Studio details page, decide which item it is.
   *
   * Resolution order, most to least trustworthy:
   *   1. an explicit link to this exact videoId (the operator already confirmed it)
   *   2. an exact normalized-filename match against the Studio sidebar filename
   *   3. nothing -- the shelf shows its report browser rather than guessing
   *
   * Step 2 searches EVERY generated report, not just ones with titles picked: a fresh
   * report whose filename matches is exactly the case where the operator still needs to
   * pick, and refusing to find it would defeat the point.
   */
  async resolveForPage(videoId: string, filename: string | null): Promise<ResolveOutcome> {
    const pending = await this.listPending();

    const linked = pending.find((p) => p.videoId && p.videoId === videoId);
    if (linked) {
      return {
        item: linked,
        reason: 'Already linked to this video.',
        linked: true,
        needsTitles: false,
      };
    }

    if (!filename) {
      return {
        item: null,
        reason: 'No filename on this page.',
        linked: false,
        needsTitles: false,
      };
    }

    const wanted = normalizeForMatch(filename);
    const hits = this.listGenerated().items.filter(
      (i) => i.sourceFilename && normalizeForMatch(i.sourceFilename) === wanted
    );

    if (hits.length > 1) {
      // Refuse to guess -- same rule as the draft matcher.
      return {
        item: null,
        reason: `${hits.length} reports share the filename "${filename}".`,
        linked: false,
        needsTitles: false,
      };
    }

    if (hits.length === 1) {
      const hit = hits[0];
      const chosen = this.store.get(hit.itemId);
      const item = this.toPendingFromGenerated(hit.itemId);
      if (!item) {
        return {
          item: null,
          reason: `Matched "${filename}" but the report could not be read.`,
          linked: false,
          needsTitles: false,
        };
      }
      const chosenCount = chosen ? chosen.chosenTitles.length : 0;
      return {
        item,
        reason: `Matched "${filename}".`,
        linked: false,
        needsTitles: chosenCount === 0,
      };
    }

    return {
      item: null,
      reason: `No report matches "${filename}".`,
      linked: false,
      needsTitles: false,
    };
  }

  /**
   * Like toPending but works for an item with NO selection record yet, which is what a
   * fresh filename match usually is. Titles fall back to the generator's top 3 exactly
   * as resolveChosenMetadata does, so the shelf shows the same defaults the reports page
   * would.
   */
  private toPendingFromGenerated(itemId: string): PendingFillItem | null {
    const generated = this.readGenerated(itemId);
    if (!generated) return null;

    const chosen =
      this.store.get(itemId) ??
      // No record yet: resolve against a blank one so the fallback rules stay in one place.
      emptyChosenMetadata(itemId, generated.jobId);

    const r = resolveChosenMetadata(chosen, generated);
    return {
      itemId: r.itemId,
      jobId: r.jobId,
      titles: r.titles,
      description: r.description,
      tags: r.tags,
      sourceFilename: r.sourceFilename,
      channelId: r.channelId,
      videoId: r.videoId,
      status: r.status,
      label: r.sourceFilename || r.titles[0] || itemId,
    };
  }

  /**
   * Record that the extension filled Studio fields for an item.
   *
   * Deliberately NOT 'published': filling only puts text in the form. The operator
   * still has to press Save/Publish in Studio, and we can't observe that from here.
   */
  async markFilled(itemId: string, videoId: string): Promise<void> {
    const generated = this.readGenerated(itemId);
    if (!generated) {
      // The extension just filled a Studio form for an item that is not on disk. Saying
      // so is the only useful thing left: writing a record against an item that does not
      // exist would produce a selection nothing could ever reach.
      throw new Error(`Cannot record a fill for ${itemId}: no such generated item.`);
    }
    await this.store.update(itemId, generated, {
      videoId,
      status: 'filled',
      filledAt: new Date().toISOString(),
    });
  }
}
