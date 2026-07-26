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
 */

import { PublishStoreService, GeneratedFallback, resolveChosenMetadata } from './publish-store.service';
import { normalizeForMatch } from './publish-types';

/** One item the extension can fill, with everything it needs to do it. */
export interface PendingFillItem {
  jobId: string;
  itemIndex: number;
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
}

export class PublishBridge {
  constructor(
    private store: PublishStoreService,
    private readGenerated: (jobId: string, itemIndex: number) => GeneratedFallback | null
  ) {}

  private toPending(jobId: string, itemIndex: number): PendingFillItem | null {
    const generated = this.readGenerated(jobId, itemIndex);
    if (!generated) return null;

    const chosen = this.store.get(jobId, itemIndex);
    if (!chosen) return null;

    const r = resolveChosenMetadata(chosen, generated);
    return {
      jobId: r.jobId,
      itemIndex: r.itemIndex,
      titles: r.titles,
      description: r.description,
      tags: r.tags,
      sourceFilename: r.sourceFilename,
      channelId: r.channelId,
      videoId: r.videoId,
      status: r.status,
      label: r.sourceFilename || r.titles[0] || `${jobId} item ${itemIndex}`,
    };
  }

  /** Everything with titles picked that hasn't been published yet. */
  async listPending(): Promise<PendingFillItem[]> {
    const out: PendingFillItem[] = [];
    for (const sel of this.store.listActionable()) {
      const item = this.toPending(sel.jobId, sel.itemIndex);
      if (item) out.push(item);
    }
    return out;
  }

  /**
   * Given what the extension sees on a Studio details page, decide which item it is.
   *
   * Resolution order, most to least trustworthy:
   *   1. an explicit link to this exact videoId (the operator already confirmed it)
   *   2. an exact normalized-filename match against the Studio sidebar filename
   *   3. nothing -- the extension shows a manual picker rather than guessing
   */
  async resolveForPage(videoId: string, filename: string | null): Promise<ResolveOutcome> {
    const pending = await this.listPending();

    const linked = pending.find((p) => p.videoId && p.videoId === videoId);
    if (linked) {
      return { item: linked, reason: 'Already linked to this video.', linked: true };
    }

    if (!filename) {
      return {
        item: null,
        reason: 'No filename visible on the page — pick the item manually.',
        linked: false,
      };
    }

    const wanted = normalizeForMatch(filename);
    const hits = pending.filter(
      (p) => p.sourceFilename && normalizeForMatch(p.sourceFilename) === wanted
    );

    if (hits.length === 1) {
      return {
        item: hits[0],
        reason: `Matched "${filename}" by filename.`,
        linked: false,
      };
    }
    if (hits.length > 1) {
      // Refuse to guess -- same rule as the draft matcher.
      return {
        item: null,
        reason: `${hits.length} pending items share the filename "${filename}" — pick one.`,
        linked: false,
      };
    }

    return {
      item: null,
      reason: `No pending item matches "${filename}".`,
      linked: false,
    };
  }

  /**
   * Record that the extension filled Studio fields for an item.
   *
   * Deliberately NOT 'published': filling only puts text in the form. The operator
   * still has to press Save/Publish in Studio, and we can't observe that from here.
   */
  async markFilled(jobId: string, itemIndex: number, videoId: string): Promise<void> {
    await this.store.update(jobId, itemIndex, {
      videoId,
      status: 'filled',
      filledAt: new Date().toISOString(),
    });
  }
}
