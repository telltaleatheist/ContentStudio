/**
 * Publish IPC
 *
 * Every publish-related ipcMain channel, registered in one call so the feature stays a
 * single seam rather than another few hundred lines inside ipc-handlers.ts. All channels
 * are namespaced `publish-*`.
 *
 * The generated-metadata reader is INJECTED (`readGenerated`) rather than imported: that
 * is what keeps this module free of any services/metadata dependency, so publish/ can be
 * lifted into another host wholesale.
 */

import { ipcMain } from 'electron';
import type { UploadStatusEntry } from '../youtube/youtube-api.service';
import { PublishStoreService, GeneratedFallback, resolveChosenMetadata } from './publish-store.service';
import { matchDraft, toDraftCandidates } from './video-matcher';
import {
  ChosenMetadata,
  MAX_AB_VARIANTS,
  emptyChosenMetadata,
  validateChosenTitles,
} from './publish-types';

export interface PublishIpcDeps {
  store: PublishStoreService;
  /**
   * Returns the generated titles/description/tags for one item, or null if the job or
   * item no longer exists. Supplied by the host.
   */
  readGenerated: (jobId: string, itemIndex: number) => GeneratedFallback | null;
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

function requireIndex(value: unknown, name: string): number {
  if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
    throw new Error(`${name} must be a non-negative integer`);
  }
  return value;
}

export function setupPublishIpc(deps: PublishIpcDeps): void {
  const { store, readGenerated, listRecentUploads } = deps;

  /** All selections for a job, keyed by item index. */
  ipcMain.handle('publish-get-selections', async (_e, jobId: string) => {
    try {
      return ok(store.getForJob(requireString(jobId, 'jobId')));
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
  ipcMain.handle('publish-set-titles', async (_e, jobId: string, itemIndex: number, titles: string[]) => {
    try {
      const job = requireString(jobId, 'jobId');
      const idx = requireIndex(itemIndex, 'itemIndex');
      if (!Array.isArray(titles) || titles.some((t) => typeof t !== 'string')) {
        return fail('titles must be an array of strings');
      }

      const cleaned = titles.map((t) => t.trim()).filter(Boolean);
      // An empty set is legal -- it's how the operator deselects everything.
      if (cleaned.length > 0) {
        const errors = validateChosenTitles(cleaned);
        if (errors.length) return fail(errors.join(' '));
      }

      return ok(await store.update(job, idx, { chosenTitles: cleaned }));
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
      jobId: string,
      itemIndex: number,
      fields: { descriptionOverride?: string | null; tagsOverride?: string | null; channelId?: string | null }
    ) => {
      try {
        const job = requireString(jobId, 'jobId');
        const idx = requireIndex(itemIndex, 'itemIndex');
        if (!fields || typeof fields !== 'object') return fail('fields object is required');

        const patch: Partial<ChosenMetadata> = {};
        for (const key of ['descriptionOverride', 'tagsOverride', 'channelId'] as const) {
          if (!(key in fields)) continue;
          const v = fields[key];
          if (v !== null && typeof v !== 'string') return fail(`${key} must be a string or null`);
          patch[key] = v as any;
        }
        if (Object.keys(patch).length === 0) return fail('nothing to update');

        return ok(await store.update(job, idx, patch));
      } catch (err: any) {
        return fail(err?.message || String(err));
      }
    }
  );

  /**
   * The item's metadata with generated fallbacks merged in -- what the extension fills.
   */
  ipcMain.handle('publish-get-resolved', async (_e, jobId: string, itemIndex: number) => {
    try {
      const job = requireString(jobId, 'jobId');
      const idx = requireIndex(itemIndex, 'itemIndex');

      const generated = readGenerated(job, idx);
      if (!generated) return fail(`No generated metadata for ${job} item ${idx}`);

      // Nothing chosen yet is still resolvable -- resolveChosenMetadata falls back to
      // the generator's top-3, which the prompts already order as the A/B candidates.
      const chosen = store.get(job, idx) ?? emptyChosenMetadata(job, idx);
      return ok(resolveChosenMetadata(chosen, generated));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Find the YouTube draft that belongs to an item.
   *
   * Only ever returns TRUE drafts (private, never scheduled) — see isDraftCandidate.
   * Returns the match plus the other drafts on the channel so the operator can
   * override, and never auto-links: linking is a separate, explicit call.
   */
  ipcMain.handle('publish-find-draft', async (_e, jobId: string, itemIndex: number, channelId: string) => {
    try {
      const job = requireString(jobId, 'jobId');
      const idx = requireIndex(itemIndex, 'itemIndex');
      const channel = requireString(channelId, 'channelId');

      const generated = readGenerated(job, idx);
      if (!generated) return fail(`No generated metadata for ${job} item ${idx}`);

      const chosen = store.get(job, idx) ?? emptyChosenMetadata(job, idx);
      const resolved = resolveChosenMetadata(chosen, generated);

      const uploads = await listRecentUploads(channel);
      const drafts = toDraftCandidates(uploads, channel);

      const outcome = matchDraft(
        { sourceFilename: resolved.sourceFilename, sourceDurationSec: resolved.sourceDurationSec },
        drafts
      );

      return ok({ ...outcome, sourceFilename: resolved.sourceFilename, draftCount: drafts.length });
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
    async (_e, jobId: string, itemIndex: number, videoId: string, channelId: string) => {
      try {
        const job = requireString(jobId, 'jobId');
        const idx = requireIndex(itemIndex, 'itemIndex');
        const video = requireString(videoId, 'videoId');
        const channel = requireString(channelId, 'channelId');

        return ok(
          await store.update(job, idx, { videoId: video, channelId: channel, status: 'linked' })
        );
      } catch (err: any) {
        return fail(err?.message || String(err));
      }
    }
  );

  /** Undo a link, dropping the item back to 'ready'. */
  ipcMain.handle('publish-unlink-video', async (_e, jobId: string, itemIndex: number) => {
    try {
      const job = requireString(jobId, 'jobId');
      const idx = requireIndex(itemIndex, 'itemIndex');
      return ok(await store.update(job, idx, { videoId: null, status: 'ready' }));
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
  ipcMain.handle('publish-clear', async (_e, jobId: string, itemIndex: number) => {
    try {
      await store.clear(requireString(jobId, 'jobId'), requireIndex(itemIndex, 'itemIndex'));
      return ok(true);
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  console.log(`[PublishIpc] Registered (max ${MAX_AB_VARIANTS} A/B variants)`);
}
