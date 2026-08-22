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

import { ipcMain, nativeImage } from 'electron';
import type { UploadStatusEntry } from '../youtube/youtube-api.service';
import { PublishStoreService, GeneratedFallback, resolveChosenMetadata } from './publish-store.service';
import { matchDraft, toFillCandidates } from './video-matcher';
import { RoutableChannel, findChannelById, resolveChannelForPromptSet } from './channel-routing';
import {
  ThumbnailValidation,
  deriveProposedThumbnailPath,
  validateThumbnailFile,
} from './thumbnail-validate';
import {
  ChosenMetadata,
  MAX_AB_VARIANTS,
  emptyChosenMetadata,
  isItemId,
  validateChosenTitles,
  validatePublishAt,
} from './publish-types';
import * as fs from 'fs';

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
  /**
   * The channel registry, read fresh on every call.
   *
   * Injected exactly like readGenerated, and for the same reason: channels.json belongs
   * to services/analytics, and publish/ importing it would tie this directory to that
   * one. Not cached — connecting a channel or editing its prompt sets has to take effect
   * without a restart, and a stale copy would reject an id that is in fact valid.
   */
  listChannels: () => RoutableChannel[];
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

/** A short, safe rendering of whatever the renderer actually sent. */
function describeValue(value: unknown): string {
  if (typeof value === 'string') {
    return value.length > 60 ? `${JSON.stringify(value.slice(0, 60))}… (${value.length} chars)` : JSON.stringify(value);
  }
  if (value === null) return 'null';
  if (Array.isArray(value)) return `an array of ${value.length}`;
  if (typeof value === 'object') return 'an object';
  return `${typeof value} ${JSON.stringify(value)}`;
}

/** What a field validator may write. Never the identity fields. */
type FieldPatch = Partial<Omit<ChosenMetadata, 'itemId' | 'jobId'>>;

/** What a validator is allowed to consult beyond the value itself. */
interface FieldContext {
  /** The channel registry, read at validation time. */
  listChannels: () => RoutableChannel[];
  /** "Now" for the time-relative rules, so they are testable. */
  now: Date;
}

/**
 * The per-field validator table — Q7, and the reason this PR exists as much as the new
 * fields do.
 *
 * What was here before was a loop over a whitelist of key names that copied whatever
 * arrived as long as it was a string or null. That accepted `channelId: "UCnonsense"`,
 * and it would have accepted `publishAt: "next tuesday"` and `isPodcast: "false"` the
 * moment those fields existed — the last of which is truthy, which is exactly the
 * `_is_compilation` bug in a new place.
 *
 * Each entry OWNS its field: it decides the type, the rule, the message, AND what the
 * patch actually contains — which is why publishAt's entry can write two keys. A key
 * with no entry here is REFUSED rather than ignored, because a caller sending a field
 * this doesn't know is a caller whose write is not going to happen, and finding that out
 * silently is worse than being told.
 *
 * Every message names the offending value and the rule it broke. "Invalid field" would
 * be a bug report with no information in it.
 */
const FIELD_VALIDATORS: Record<string, (value: unknown, ctx: FieldContext) => FieldPatch> = {
  /** null clears the override, restoring the generated description. */
  descriptionOverride(value) {
    if (value !== null && typeof value !== 'string') {
      throw new Error(
        `descriptionOverride must be a string or null (null clears the override and ` +
        `restores the generated description); got ${describeValue(value)}.`
      );
    }
    return { descriptionOverride: value };
  },

  /** Comma-separated, matching MetadataResult.tags. null clears. */
  tagsOverride(value) {
    if (value !== null && typeof value !== 'string') {
      throw new Error(
        `tagsOverride must be a comma-separated string or null (null clears the override ` +
        `and restores the generated tags); got ${describeValue(value)}.`
      );
    }
    return { tagsOverride: value };
  },

  /**
   * Must be a channel that actually exists in the registry.
   *
   * The check is membership, not shape: "looks like a UC… id" would pass a channel Owen
   * does not own, and the whole point of the field is that a non-null channelId can be
   * handed to the API without a second look. null is legal and means "not routed yet".
   */
  channelId(value, ctx) {
    if (value === null) return { channelId: null };
    if (typeof value !== 'string' || !value.trim()) {
      throw new Error(
        `channelId must be a registered channel id or null; got ${describeValue(value)}.`
      );
    }
    const channels = ctx.listChannels();
    if (!findChannelById(value, channels)) {
      const known = channels.length
        ? channels.map((c) => `${c.name} (${c.channelId})`).join(', ')
        : 'none are registered';
      throw new Error(
        `channelId ${JSON.stringify(value)} is not a registered channel. Known channels: ${known}.`
      );
    }
    return { channelId: value };
  },

  /**
   * A schedule, or null to clear it. See validatePublishAt for the four rules.
   *
   * Writes publishAtSetAt ON EVERY SET, INCLUDING THE CLEAR. "When did this stop being
   * scheduled" is as much a question as "when was it scheduled", and a provenance stamp
   * that only exists on one branch answers neither reliably.
   */
  publishAt(value, ctx) {
    const setAt = ctx.now.toISOString();
    if (value === null) return { publishAt: null, publishAtSetAt: setAt };
    if (typeof value !== 'string') {
      throw new Error(
        `publishAt must be an ISO-8601 timestamp with an explicit zone, or null to clear ` +
        `the schedule; got ${describeValue(value)}.`
      );
    }
    const error = validatePublishAt(value, ctx.now);
    if (error) throw new Error(error);
    return { publishAt: value.trim(), publishAtSetAt: setAt };
  },

  /**
   * Strictly boolean. Not truthy, not "true", not 1.
   *
   * A coerced flag is how `_is_compilation` came to mean different things in different
   * readers, and this one decides whether an item is treated as a podcast episode.
   */
  isPodcast(value) {
    if (typeof value !== 'boolean') {
      throw new Error(
        `isPodcast must be exactly true or false; got ${describeValue(value)}. ` +
        `It is never absent and never coerced.`
      );
    }
    return { isPodcast: value };
  },
};

/**
 * Turn a fields object into a patch, or throw naming the field and the rule.
 *
 * Exported for the same reason the validators are a table: this is testable without an
 * ipcMain, and it is the single place a set-fields write is decided.
 */
export function buildFieldPatch(fields: Record<string, unknown>, ctx: FieldContext): FieldPatch {
  if (!fields || typeof fields !== 'object' || Array.isArray(fields)) {
    throw new Error(`fields must be an object of field names to values; got ${describeValue(fields)}.`);
  }

  const known = Object.keys(FIELD_VALIDATORS);
  const patch: FieldPatch = {};

  for (const key of Object.keys(fields)) {
    const validator = FIELD_VALIDATORS[key];
    if (!validator) {
      // Not skipped. A field this handler cannot write is a write that is not going to
      // happen, and the caller has to hear that rather than watch a success come back.
      throw new Error(
        `publish-set-fields cannot write ${JSON.stringify(key)}. It accepts: ${known.join(', ')}. ` +
        `(thumbnailPath has its own channel, publish-set-thumbnail, because it is validated ` +
        `against the file on disk.)`
      );
    }
    Object.assign(patch, validator(fields[key], ctx));
  }

  if (Object.keys(patch).length === 0) {
    throw new Error(`nothing to update: fields was empty. It accepts: ${known.join(', ')}.`);
  }
  return patch;
}

export function setupPublishIpc(deps: PublishIpcDeps): void {
  const { store, readGenerated, listRecentUploads, listChannels } = deps;

  if (typeof listChannels !== 'function') {
    throw new Error('setupPublishIpc requires listChannels: channel routing cannot be faked.');
  }

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
      return ok(await store.update(id, generated, { chosenTitles: cleaned }));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Set (or clear) the operator-editable publish fields.
   *
   * Every field goes through FIELD_VALIDATORS. Passing null where the field allows it
   * clears that field, which for the overrides restores the generated value -- that's
   * deliberate, so regenerating an item isn't shadowed by a stale edit.
   *
   * ALL-OR-NOTHING. The patch is built completely before anything is written, so a call
   * setting three fields with one bad value writes none of them. A partial write would
   * leave the record in a state the caller never asked for and has no way to learn about
   * from an error message about a different field.
   */
  ipcMain.handle(
    'publish-set-fields',
    async (_e, itemId: string, fields: Record<string, unknown>) => {
      try {
        const id = requireItemId(itemId, 'itemId');
        const patch = buildFieldPatch(fields, { listChannels, now: new Date() });
        const generated = requireGenerated(id);
        return ok(await store.update(id, generated, patch));
      } catch (err: any) {
        return fail(err?.message || String(err));
      }
    }
  );

  /**
   * Attach (or clear) a thumbnail file.
   *
   * Its own channel rather than a field in publish-set-fields because it is validated
   * against a FILE — the path is only half the value, and the measurements that come
   * back are stored with it so a later re-check can say what changed.
   *
   * Warnings travel with the success: a non-16:9 image is accepted and stored, and the
   * panel says so. That is not the same as it passing quietly.
   */
  ipcMain.handle('publish-set-thumbnail', async (_e, itemId: string, absPath: string | null) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const generated = requireGenerated(id);

      if (absPath === null) {
        const cleared = await store.update(id, generated, {
          thumbnailPath: null,
          thumbnailMeta: null,
        });
        return ok({ selection: cleared, warnings: [] as string[] });
      }

      // Throws with the file, the value and the rule when it fails. Nothing is stored.
      const { meta, warnings }: ThumbnailValidation = validateThumbnailFile(absPath);
      const selection = await store.update(id, generated, {
        thumbnailPath: absPath,
        thumbnailMeta: meta,
      });
      return ok({ selection, warnings });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Where this item's exported thumbnail would be, if one was exported. READ-ONLY:
   * it stores nothing and changes nothing.
   *
   * `null` is a FACT, not a failure — most items have no exported thumbnail, and the
   * three ways to get null (no source path, a source path outside the export layout, no
   * file at the derived path) are all "there is nothing to offer". A rejection would be
   * a file that IS there and is not usable, and that still throws.
   *
   * Never applied automatically. Slots are renumbered between export and upload often
   * enough (13 of 40 live exports) that a pre-applied proposal would be wrong routinely
   * and invisibly.
   */
  ipcMain.handle('publish-propose-thumbnail', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const generated = requireGenerated(id);

      const candidate = deriveProposedThumbnailPath(generated.sourcePath ?? null);
      if (!candidate) return ok(null);
      if (!fs.existsSync(candidate)) return ok(null);

      const { meta, warnings } = validateThumbnailFile(candidate);
      return ok({ path: candidate, meta, warnings });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * A downscaled data URL for a thumbnail, for the preview.
   *
   * Done in the MAIN PROCESS, with Electron's own nativeImage, for one reason: the
   * alternative is pointing an <img> at a file:// path on an external volume from a
   * renderer, which means relaxing webSecurity. Nothing is worth that. nativeImage also
   * means no image dependency for a resize the framework already does.
   *
   * TWO CALLERS, and the optional `absPath` is which one:
   *   omitted  -> the item's STORED thumbnail, or null when it has none.
   *   given    -> THAT file, which is how a PROPOSAL is previewed. A proposal is by
   *               definition not stored (spec Q5: never pre-applied, always confirmed),
   *               so previewing one from the record would show the operator the image
   *               they already have while asking them to accept a different one.
   *               With a path there is no null answer: a file that cannot be previewed
   *               is an error, not an empty slot.
   *
   * The file is re-validated first, either way. This runs long after the path was chosen,
   * against a volume that can be unplugged, so "it was valid when picked" is not a claim
   * about the file the operator is about to look at.
   */
  ipcMain.handle('publish-read-thumbnail', async (
    _e,
    itemId: string,
    maxPx: number,
    requestedPath?: string | null
  ) => {
    try {
      const id = requireItemId(itemId, 'itemId');

      let absPath: string;
      if (requestedPath === undefined || requestedPath === null) {
        const stored = store.get(id)?.thumbnailPath ?? null;
        if (!stored) {
          // Nothing chosen is a state, not a fault: the panel shows its empty slot.
          return ok(null);
        }
        absPath = stored;
      } else {
        if (typeof requestedPath !== 'string' || !requestedPath.trim()) {
          throw new Error(
            `publish-read-thumbnail's path must be an absolute file path, or omitted to ` +
            `read the item's stored thumbnail; got ${describeValue(requestedPath)}.`
          );
        }
        absPath = requestedPath;
      }

      if (!Number.isInteger(maxPx) || maxPx < 16 || maxPx > 4096) {
        throw new Error(
          `maxPx must be a whole number of pixels between 16 and 4096; got ${describeValue(maxPx)}.`
        );
      }

      const { meta, warnings } = validateThumbnailFile(absPath);

      const image = nativeImage.createFromPath(absPath);
      if (image.isEmpty()) {
        throw new Error(
          `Thumbnail ${absPath} passed its header checks but could not be decoded for preview.`
        );
      }
      const { width, height } = image.getSize();
      const longest = Math.max(width, height);
      const preview =
        longest > maxPx
          ? image.resize({
              width: Math.round((width / longest) * maxPx),
              height: Math.round((height / longest) * maxPx),
              quality: 'good',
            })
          : image;

      return ok({
        path: absPath,
        dataUrl: preview.toDataURL(),
        meta,
        warnings,
        previewSize: preview.getSize(),
      });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Which channel a prompt set routes to.
   *
   * The seeding half of channelId lives in the UI (PR 3): the panel asks this when it
   * opens and offers the answer. This channel only ANSWERS — it writes nothing, so a
   * prompt set that stops being mapped never silently rewrites a stored choice.
   *
   * Two channels claiming one prompt set throws, and surfaces here as a failed call
   * naming both. That is a contradiction in channels.json, and the operator is the only
   * one who can resolve it.
   */
  ipcMain.handle('publish-resolve-channel', async (_e, promptSet: string) => {
    try {
      return ok(resolveChannelForPromptSet(requireString(promptSet, 'promptSet'), listChannels()));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

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
          await store.update(id, generated, {
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
      return ok(await store.update(id, generated, { videoId: null, status: 'ready' }));
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
