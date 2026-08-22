/**
 * Publish IPC
 *
 * Every publish-related ipcMain channel, registered in one call so the feature stays a
 * single seam rather than another few hundred lines inside ipc-handlers.ts. All channels
 * are namespaced `publish-*`.
 *
 * Every channel names ONE item, by its permanent `itemId`. The (jobId, itemIndex) pair
 * these used to take was not an identity — see publish-types.ts's note on ChosenMetadata.
 * The jobId is no longer sent at all: it is a property OF the item, read back from the
 * generated report, not something a caller gets to assert.
 *
 * The generated-metadata reader is INJECTED (`readGenerated`) rather than imported: that
 * is what keeps this module free of any services/metadata dependency, so publish/ can be
 * lifted into another host wholesale.
 */

import { ipcMain } from 'electron';
import type { UploadStatusEntry } from '../youtube/youtube-api.service';
import { PublishStoreService, GeneratedFallback, resolveChosenMetadata } from './publish-store.service';
import { matchDraft, toFillCandidates } from './video-matcher';
import {
  ChosenMetadata,
  MAX_AB_VARIANTS,
  emptyChosenMetadata,
  isItemId,
  validateChosenTitles,
} from './publish-types';

export interface PublishIpcDeps {
  store: PublishStoreService;
  /**
   * Returns the generated titles/description/tags for one item (plus the job it came
   * from), or null if the item no longer exists. Supplied by the host.
   */
  readGenerated: (itemId: string) => GeneratedFallback | null;
  /**
   * Recent uploads (with status) for a channel. Injected as a narrow function rather
   * than the whole YouTubeApiService so this module stays independently testable.
   */
  listRecentUploads: (channelId: string) => Promise<UploadStatusEntry[]>;
}

/** Uniform envelope so the renderer can branch on success without try/catch everywhere. */
type Result<T> = { success: true; data: T } | { success: false; error: string };

function ok<T>(data: T): Result<T> {
  return { success: true, data };
}
function fail(error: string): Result<never> {
  return { success: false, error };
}

function requireString(value: unknown, name: string): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error(`${name} is required`);
  }
  return value;
}

/**
 * An item id, or a refusal.
 *
 * A NUMBER here is the old positional call shape. It is named as such and rejected — it
 * is never translated into an id, because the translation is the bug: index 2 in a job
 * that has since had an item deleted is a different item than the caller means, and the
 * caller has no way to know that.
 */
function requireItemId(value: unknown, name: string): string {
  if (typeof value === 'number') {
    throw new Error(
      `${name} must be an item id, not a position. This call is using the old ` +
      `(jobId, itemIndex) shape, which named the wrong item whenever a sibling was deleted.`
    );
  }
  if (!isItemId(value)) {
    throw new Error(`${name} must be an item id of the form itm-<time>-<random>; got ${JSON.stringify(value)}`);
  }
  return value;
}

export function setupPublishIpc(deps: PublishIpcDeps): void {
  const { store, readGenerated, listRecentUploads } = deps;

  /**
   * The generated values for an item, or a thrown refusal naming the item.
   *
   * Every write goes through here first, because the record's `jobId` back-reference has
   * to come from the report rather than from the caller.
   */
  function requireGenerated(itemId: string): GeneratedFallback {
    const generated = readGenerated(itemId);
    if (!generated) throw new Error(`No generated metadata for item ${itemId}`);
    return generated;
  }

  /** One item's stored selection, or null when the operator has never touched it. */
  ipcMain.handle('publish-get-selection', async (_e, itemId: string) => {
    try {
      return ok(store.get(requireItemId(itemId, 'itemId')));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Replace the chosen title set for an item.
   *
   * Order is meaningful and preserved exactly as sent: index 0 becomes the video's main
   * title and A/B variant 1, which is what YouTube falls back to on an inconclusive test.
   */
  ipcMain.handle('publish-set-titles', async (_e, itemId: string, titles: string[]) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      if (!Array.isArray(titles) || titles.some((t) => typeof t !== 'string')) {
        return fail('titles must be an array of strings');
      }

      const cleaned = titles.map((t) => t.trim()).filter(Boolean);
      // An empty set is legal -- it's how the operator deselects everything.
      if (cleaned.length > 0) {
        const errors = validateChosenTitles(cleaned);
        if (errors.length) return fail(errors.join(' '));
      }

      const generated = requireGenerated(id);
      return ok(await store.update(id, generated.jobId, { chosenTitles: cleaned }));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Set (or clear) the description/tags overrides.
   *
   * Passing null for a field clears the override, which restores the generated value --
   * that's deliberate, so regenerating an item isn't shadowed by a stale edit.
   */
  ipcMain.handle(
    'publish-set-fields',
    async (
      _e,
      itemId: string,
      fields: { descriptionOverride?: string | null; tagsOverride?: string | null; channelId?: string | null }
    ) => {
      try {
        const id = requireItemId(itemId, 'itemId');
        if (!fields || typeof fields !== 'object') return fail('fields object is required');

        const patch: Partial<ChosenMetadata> = {};
        for (const key of ['descriptionOverride', 'tagsOverride', 'channelId'] as const) {
          if (!(key in fields)) continue;
          const v = fields[key];
          if (v !== null && typeof v !== 'string') return fail(`${key} must be a string or null`);
          patch[key] = v as any;
        }
        if (Object.keys(patch).length === 0) return fail('nothing to update');

        const generated = requireGenerated(id);
        return ok(await store.update(id, generated.jobId, patch));
      } catch (err: any) {
        return fail(err?.message || String(err));
      }
    }
  );

  /**
   * The item's metadata with generated fallbacks merged in -- what the extension fills.
   */
  ipcMain.handle('publish-get-resolved', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const generated = requireGenerated(id);

      // Nothing chosen yet is still resolvable -- resolveChosenMetadata falls back to
      // the generator's top-3, which the prompts already order as the A/B candidates.
      const chosen = store.get(id) ?? emptyChosenMetadata(id, generated.jobId);
      return ok(resolveChosenMetadata(chosen, generated));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Find the YouTube draft that belongs to an item.
   *
   * Returns the match plus the other recent uploads on the channel so the operator can
   * override, and never auto-links: linking is a separate, explicit call.
   */
  ipcMain.handle('publish-find-draft', async (_e, itemId: string, channelId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const channel = requireString(channelId, 'channelId');

      const generated = requireGenerated(id);
      const chosen = store.get(id) ?? emptyChosenMetadata(id, generated.jobId);
      const resolved = resolveChosenMetadata(chosen, generated);

      const uploads = await listRecentUploads(channel);
      const candidates = toFillCandidates(uploads, channel);

      const outcome = matchDraft(
        { sourceFilename: resolved.sourceFilename, sourceDurationSec: resolved.sourceDurationSec },
        candidates
      );

      return ok({
        ...outcome,
        sourceFilename: resolved.sourceFilename,
        candidateCount: candidates.length,
      });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Bind an item to a specific video. Explicit and operator-confirmed — the matcher
   * only ever proposes.
   */
  ipcMain.handle(
    'publish-link-video',
    async (_e, itemId: string, videoId: string, channelId: string) => {
      try {
        const id = requireItemId(itemId, 'itemId');
        const video = requireString(videoId, 'videoId');
        const channel = requireString(channelId, 'channelId');
        const generated = requireGenerated(id);

        return ok(
          await store.update(id, generated.jobId, {
            videoId: video,
            channelId: channel,
            status: 'linked',
          })
        );
      } catch (err: any) {
        return fail(err?.message || String(err));
      }
    }
  );

  /** Undo a link, dropping the item back to 'ready'. */
  ipcMain.handle('publish-unlink-video', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const generated = requireGenerated(id);
      return ok(await store.update(id, generated.jobId, { videoId: null, status: 'ready' }));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /** Everything the extension could act on right now. */
  ipcMain.handle('publish-list-actionable', async () => {
    try {
      return ok(store.listActionable());
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /** Forget one item's selection. */
  ipcMain.handle('publish-clear', async (_e, itemId: string) => {
    try {
      await store.clearItem(requireItemId(itemId, 'itemId'));
      return ok(true);
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  console.log(`[PublishIpc] Registered (max ${MAX_AB_VARIANTS} A/B variants)`);
}
