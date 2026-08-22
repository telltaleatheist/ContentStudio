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
 *
 * The per-field validator table lives in field-validators.ts rather than here, because
 * carry-forward.ts writes the same fields and has to face the same rules — and it cannot
 * import this module, which pulls in `electron`.
 */

import { ipcMain, nativeImage } from 'electron';
import * as log from 'electron-log';
import type { UploadStatusEntry } from '../youtube/youtube-api.service';
import {
  PublishStoreService,
  GeneratedFallback,
  GeneratedItemSummary,
  resolveChosenMetadata,
} from './publish-store.service';
import { matchDraft, toFillCandidates } from './video-matcher';
import { YouTubePushApi, pushItemToYouTube } from './youtube-push';
import {
  SpreakerTarget,
  SpreakerUploadApi,
  pushEpisodeToSpreaker,
} from './spreaker-push';
import {
  AudioProbe,
  deriveProposedAudioPaths,
  validateAudioFile,
} from './audio-validate';
import { RoutableChannel, resolveChannelForPromptSet } from './channel-routing';
import { buildFieldPatch, describeValue } from './field-validators';
import {
  CarriedRefResolution,
  applyCarryForward,
  findCarryForward,
} from './carry-forward';
import {
  ThumbnailValidation,
  deriveProposedThumbnailPath,
  validateThumbnailFile,
} from './thumbnail-validate';
import {
  TranscriptRef,
  MAX_AB_VARIANTS,
  emptyChosenMetadata,
  isItemId,
  validateChosenTitles,
} from './publish-types';
import * as fs from 'fs';

export { buildFieldPatch };

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
  /**
   * The host's index of every generated item, newest-first.
   *
   * Injected for the same reason readGenerated is: knowing which report file an item
   * lives in, and what `source_key` that report recorded, is format knowledge and it
   * belongs to services/metadata. Carry-forward is the caller — it is the one thing here
   * that has to look at OTHER items than the one it was asked about.
   */
  listGenerated: () => { items: GeneratedItemSummary[] };
  /**
   * Is a stored transcript ref still the file that was linked? Three states, ok /
   * missing / changed (spec §3.1).
   *
   * Injected: the resolver is services/metadata/editor-transcript-link.ts. Carry-forward
   * refuses to carry anything but `ok` — a link that resolves to a re-exported session
   * would otherwise arrive on the new item looking exactly like a confirmed one.
   */
  resolveTranscriptRef: (ref: TranscriptRef) => CarriedRefResolution;
  /**
   * The three YouTube write calls "Push to YouTube" needs, injected exactly like
   * listRecentUploads — as a narrow surface rather than the whole client.
   *
   * That is not decoration here: this is the seam where a push can be exercised against
   * a fixture instead of a real channel, and a mistake in the read-modify-write rewrites
   * a live video. Nothing in publish/ constructs a YouTube client.
   */
  pushApi: YouTubePushApi;
  /**
   * The ONE Spreaker write, injected exactly like pushApi and for a sharper version of
   * the same reason: an episode upload is a CREATE against a live podcast feed, so the
   * only acceptable way to exercise it is against a fixture.
   */
  spreakerApi: SpreakerUploadApi;
  /**
   * The configured show, or a throw naming what is missing and where to put it.
   *
   * Returns NO TOKEN. publish/ never handles the credential — this function's caller has
   * already established that one exists, which is what makes "Spreaker is not configured"
   * a refusal before the file is read rather than a 401 after it was uploaded.
   */
  requireSpreakerTarget: () => SpreakerTarget;
  /**
   * ffprobe, as one function. The host owns the binary path (lib/bridges/runtime-paths);
   * publish/ owns the rules about what the answer has to say.
   */
  probeAudio: (file: string) => Promise<AudioProbe>;
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
  const {
    store,
    readGenerated,
    listRecentUploads,
    listChannels,
    listGenerated,
    resolveTranscriptRef,
    pushApi,
    spreakerApi,
    requireSpreakerTarget,
    probeAudio,
  } = deps;

  if (typeof listChannels !== 'function') {
    throw new Error('setupPublishIpc requires listChannels: channel routing cannot be faked.');
  }

  if (typeof listGenerated !== 'function' || typeof resolveTranscriptRef !== 'function') {
    throw new Error(
      'setupPublishIpc requires listGenerated and resolveTranscriptRef: carry-forward joins ' +
      'items on the source_key their reports recorded and refuses a transcript link it ' +
      'cannot re-resolve. Neither can be inferred here.'
    );
  }

  if (!pushApi || typeof pushApi.getVideoParts !== 'function' || typeof pushApi.updateVideo !== 'function'
      || typeof pushApi.setThumbnail !== 'function') {
    throw new Error(
      'setupPublishIpc requires pushApi with getVideoParts, updateVideo and setThumbnail. ' +
      'A push that could not read the video first would replace its snippet with whatever ' +
      'this app happened to know.'
    );
  }

  if (!spreakerApi || typeof spreakerApi.createEpisode !== 'function'
      || typeof requireSpreakerTarget !== 'function' || typeof probeAudio !== 'function') {
    throw new Error(
      'setupPublishIpc requires spreakerApi.createEpisode, requireSpreakerTarget and ' +
      'probeAudio. An episode upload creates a public episode from a file on an external ' +
      'volume: none of the three can be inferred here.'
    );
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

  /**
   * What carry-forward reads and writes through. Bound once from this handler's own deps
   * so the finder and the applier can never be looking at a different store, registry or
   * index than the rest of this file.
   */
  const carryDeps = { store, listGenerated, readGenerated, listChannels, resolveTranscriptRef };

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

  /**
   * Push the item's chosen metadata onto its linked video.
   *
   * The ONE channel in this file that writes to YouTube. It reads the video's current
   * snippet and status first and hands them back with only the fields it means to change
   * replaced — videos.update replaces a whole part, so anything less would clear the
   * fields it did not mention.
   *
   * Failures arrive VERBATIM. A 403 from a revoked grant, a quota message, "this video
   * is PUBLIC and cannot be scheduled" — all of them are the operator's next action, and
   * summarising them into "push failed" would delete the only useful part.
   */
  ipcMain.handle('publish-push-youtube', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const outcome = await pushItemToYouTube(id, { store, readGenerated, api: pushApi });
      return ok(outcome);
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  // ------------------------------------------------------------------ Spreaker
  //
  // The podcast half. An item marked `isPodcast` gets an audio file (proposed from the
  // export's sibling, confirmed by the operator) and then one upload, which CREATES a
  // public episode. The shape mirrors the thumbnail channels above deliberately: propose,
  // inspect, set — because it is the same problem (a file on an external volume that this
  // app must never pick on the operator's behalf) and a second idiom for it would be a
  // second set of rules to keep in agreement.

  /**
   * Where this item's episode audio would be, by the naming convention. READ-ONLY: it
   * stores nothing and changes nothing.
   *
   * `null` is a FACT, not a failure — most items are videos with no exported audio beside
   * them. A file that IS there and is not usable still throws, naming it.
   *
   * Never applied automatically, for the same reason the thumbnail proposal is not: the
   * convention (`podcast 1.mp3` beside `podcast 1.mov`) is a good guess about the file
   * and no guess at all about whether this item is that episode.
   */
  ipcMain.handle('publish-propose-audio', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const generated = requireGenerated(id);

      for (const candidate of deriveProposedAudioPaths(generated.sourcePath ?? null)) {
        if (!fs.existsSync(candidate)) continue;
        const { meta, warnings } = await validateAudioFile(candidate, probeAudio);
        return ok({ path: candidate, meta, warnings });
      }
      return ok(null);
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Re-measure the audio file this item already has, or null when it has none.
   *
   * The panel calls this on every load rather than reading measurements off the record,
   * and that is why no AudioMeta is stored: a duration and a size are facts about a file
   * on Callisto AT A MOMENT, and the only honest moment is now. A stored path whose file
   * has gone is an ERROR here, not a null — null means "nothing chosen", and the two must
   * not look alike.
   */
  ipcMain.handle('publish-inspect-audio', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const stored = store.get(id)?.spreakerAudioPath ?? null;
      if (!stored) return ok(null);

      const { meta, warnings } = await validateAudioFile(stored, probeAudio);
      return ok({ path: stored, meta, warnings });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Attach (or clear) the episode audio file.
   *
   * Its own channel rather than a field in publish-set-fields for the same reason
   * publish-set-thumbnail is: the path is only half the value. The file is validated
   * against the bytes AND probed before anything is stored, so a .mov picked by mistake,
   * a 400 MB export or a file with no audio stream is refused by name and nothing dead is
   * written.
   *
   * Warnings travel WITH the success — an .m4a is stored and used, and the panel says
   * that Spreaker does not document that extension.
   */
  ipcMain.handle('publish-set-audio', async (_e, itemId: string, absPath: string | null) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const generated = requireGenerated(id);

      if (absPath === null) {
        const cleared = await store.update(id, generated, { spreakerAudioPath: null });
        return ok({ selection: cleared, meta: null, warnings: [] as string[] });
      }

      const { meta, warnings } = await validateAudioFile(absPath, probeAudio);
      const selection = await store.update(id, generated, { spreakerAudioPath: absPath });
      return ok({ selection, meta, warnings });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Upload the item as an episode of the configured Spreaker show.
   *
   * The second channel in this file that writes to the outside world, and the only one
   * that CREATES something: after this there is an episode in a public podcast feed that
   * did not exist before, published immediately unless the item carries a schedule.
   *
   * Everything that can refuse it — not a podcast, no title, no audio, audio that no
   * longer validates, an item already uploaded, Spreaker not configured — refuses BEFORE
   * the request. Failures arrive verbatim: a 401 from an expired token and a 404 from a
   * wrong show id are different next actions, and "upload failed" is neither.
   */
  ipcMain.handle('publish-push-spreaker', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      log.info(`[Publish] Spreaker upload requested for ${id}`);
      const outcome = await pushEpisodeToSpreaker(id, {
        store,
        readGenerated,
        api: spreakerApi,
        requireTarget: requireSpreakerTarget,
        probeAudio,
      });
      log.info(
        `[Publish] Spreaker episode ${outcome.receipt.episodeId} created for ${id} ` +
        `("${outcome.receipt.uploaded.title}", ${outcome.receipt.encodingStatus ?? 'no status'})`
      );
      return ok(outcome);
    } catch (err: any) {
      log.error(`[Publish] Spreaker upload for ${itemId} failed:`, err);
      return fail(err?.message || String(err));
    }
  });

  /**
   * Forget that this item was uploaded, so it can be uploaded again.
   *
   * DELETES NOTHING ON SPREAKER — it cannot, and pretending otherwise would be the worst
   * possible lie here. It exists because the duplicate guard would otherwise be a dead
   * end: an operator who deleted the episode on Spreaker's site has no way to tell this
   * app so, and an unclearable refusal is a bug with a good reason attached.
   *
   * The episode id it drops is LOGGED, because after this call nothing else remembers it.
   */
  ipcMain.handle('publish-forget-spreaker-episode', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const record = store.get(id);
      if (!record) {
        throw new Error(`Nothing has been saved for item ${id}, so there is no episode to forget.`);
      }
      if (record.spreakerEpisodeId === null) {
        throw new Error(
          `Item ${id} has no Spreaker episode recorded, so there is nothing to forget.`
        );
      }
      log.warn(
        `[Publish] forgetting Spreaker episode ${record.spreakerEpisodeId} on item ${id} — ` +
        `the episode itself is NOT deleted and still exists on the show.`
      );

      const generated = requireGenerated(id);
      return ok(
        await store.update(id, generated, {
          spreakerEpisodeId: null,
          spreakerPushedAt: null,
          spreakerReceipt: null,
        })
      );
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

  /**
   * Was this video generated before, and does that earlier run carry publish state?
   *
   * READ-ONLY, and it is the whole of the "hint" half of ITEM-ID-PLAN §3.2: it answers,
   * the panel offers, the operator clicks. `null` is the ordinary answer — most items are
   * the only run over their source, and an item whose source_key is null (a text subject,
   * a compilation) has no regeneration join at all.
   */
  ipcMain.handle('publish-find-carry-forward', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      return ok(findCarryForward(id, carryDeps));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Carry the earlier run's channel / thumbnail / podcast flag / transcript link onto
   * this item. One click, and LOGGED with both ids — this is the one action in the
   * publish panel that writes values the operator did not type, so the record of which
   * item they came from is part of the action, not a nicety.
   *
   * Every field comes back accounted for in the receipt: applied, skipped, or refused
   * with the validator's own message. A thumbnail whose file has since vanished is
   * refused BY NAME and nothing dead is stored.
   */
  ipcMain.handle('publish-apply-carry-forward', async (_e, itemId: string, fromItemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const from = requireItemId(fromItemId, 'fromItemId');
      log.info(`[Publish] carry-forward: applying ${from} -> ${id}`);

      const receipt = await applyCarryForward(id, from, carryDeps);
      log.info(
        `[Publish] carry-forward ${from} -> ${id}: ` +
        `applied ${receipt.applied.map((o) => o.field).join(', ') || 'nothing'}; ` +
        `skipped ${receipt.skipped.map((o) => o.field).join(', ') || 'nothing'}; ` +
        `refused ${receipt.refused.map((o) => `${o.field} (${o.detail})`).join('; ') || 'nothing'}`
      );
      return ok(receipt);
    } catch (err: any) {
      log.error(`[Publish] carry-forward ${fromItemId} -> ${itemId} failed:`, err);
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
