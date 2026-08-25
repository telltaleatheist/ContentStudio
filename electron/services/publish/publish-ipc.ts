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

import { dialog, ipcMain, nativeImage } from 'electron';
import * as log from 'electron-log';
import type { UploadStatusEntry } from '../youtube/youtube-api.service';
import {
  PublishStoreService,
  GeneratedFallback,
  GeneratedItemSummary,
  HostReportIndex,
  resolveChosenMetadata,
} from './publish-store.service';
import { matchDraft, toFillCandidates } from './video-matcher';
import { YouTubePushApi, pushItemToYouTube } from './youtube-push';
import { YouTubeUploadApi, uploadItemToYouTube } from './youtube-upload';
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
// The rescan reports in the automatic pass's own vocabulary — applied / skipped / refused,
// each a whole sentence — because it answers the same question that pass does, only on a
// click instead of on a write. A second set of words for the same three outcomes would be
// a second thing to read the log against.
import { AutoDecision } from './auto-config';
import { buildFieldPatch, describeValue } from './field-validators';
import {
  CarriedRefResolution,
  applyCarryForward,
  findCarryForward,
} from './carry-forward';
import {
  ThumbnailValidation,
  deriveProposedThumbnailPaths,
  validateThumbnailFile } from './thumbnail-validate';
import {
  ThumbnailSource,
  TranscriptRef,
  MAX_AB_VARIANTS,
  MONETIZATION_ALWAYS_ON,
  emptyChosenMetadata,
  isItemId,
  validateChosenTitles,
} from './publish-types';
import * as fs from 'fs';

export { buildFieldPatch };

/**
 * What one item's selection record says, for a list that shows many items at once.
 *
 * A projection, not the record: the calendar and the reports list need to know WHETHER
 * there is a thumbnail and HOW MANY A/B variants are picked, not the path or the strings.
 * Sending the whole record for 111 items would put every chosen title and every
 * description override on the wire for a view that renders none of them.
 */
export interface PublishFacts {
  /** null means "not routed yet" — a real state, and the majority one today. */
  channelId: string | null;
  /** ISO with an explicit offset, or null for "no schedule". */
  publishAt: string | null;
  /** ISO. When publishAt was last set, including the set that cleared it. */
  publishAtSetAt: string | null;
  status: string;
  videoId: string | null;
  /** Strict boolean; never absent (upgradeStoredMetadata fills it on read). */
  isPodcast: boolean;
  /** ISO. When metadata was last pushed to the linked video, or null for never. */
  pushedAt: string | null;
  /** ISO. When the extension last filled Studio's form, or null for never. */
  filledAt: string | null;
  hasThumbnail: boolean;
  /**
   * Who put that thumbnail there — 'auto', 'manual', or null for "nobody has decided".
   *
   * Projected alongside hasThumbnail rather than folded into it because the two answer
   * different questions in a list: hasThumbnail is "will an image go up with this video",
   * and this is "did anyone look at it". A row whose image was found automatically is
   * worth a glance in a way a hand-picked one is not.
   */
  thumbnailSource: ThumbnailSource | null;
  /**
   * Monetization. Always true — see MONETIZATION_ALWAYS_ON.
   *
   * Kept in the projection, rather than dropped now that it cannot vary, because the
   * reports list's fact row ANSWERS "is this monetized?" and an answer that has to be
   * assumed from a missing field is not one.
   */
  monetize: true;
  /**
   * Spreaker's episode id once uploaded, or null for never.
   *
   * The podcast half of "has this been dispatched", and the same size as `videoId` next
   * to it: a list needs to know WHETHER an episode exists, and the id is what says so.
   */
  spreakerEpisodeId: number | null;
  /** How many A/B variants are chosen. 0..MAX_AB_VARIANTS. */
  abCount: number;
  /**
   * The first chosen title — the one that becomes the video's title — or null when the
   * operator has not picked yet.
   *
   * The one string from the record worth sending to a list: a calendar chip that says
   * "Item 1" is useless, and the item's generated `_title` is the source's name, not the
   * video's. Variants 2 and 3 are not sent; nothing in a list renders them.
   */
  mainTitle: string | null;
}

/**
 * One generated item plus what the operator has decided about it.
 *
 * The join the reports list and the publish calendar both wanted and neither could do:
 * the display facts live in the job JSON on the output volume, the publish facts live in
 * `<userData>/publish/selections/items/<itemId>.json`, and joining them in the renderer
 * meant reading both trees from a sandboxed process on every mount.
 *
 * `publish` is null when the operator has never touched the item. That is not missing
 * data — it is the unstarted state, and the calendar renders it as such.
 */
export interface ReportIndexEntry {
  itemId: string;
  jobId: string;
  /** Source filename, else job name, else title — what the operator recognises it by. */
  label: string;
  /** The item's own `_title`, else `Item <n>`. What the reports list prints. */
  displayTitle: string;
  createdAt: string;
  /** ISO the list sorts and prints by (job `created_at`, else the file's mtime). */
  dateIso: string;
  promptSet: string | null;
  sourceFilename: string | null;
  sourceKey: string | null;
  titleCount: number;
  jobPath: string;
  jobSizeBytes: number;
  itemIndex: number;
  txtFolder: string | null;
  txtFilePath: string | null;
  /**
   * The channel this row's prompt set routes to, resolved from the registry at index
   * time, or null when nothing claims it. THE ROUTING DECISION WAS MADE AT GENERATION
   * (operator, 2026-08-24): picking the prompt set picked the channel, so the list shows
   * the channel as answered from the very first render — the record still gets its own
   * channelId written by the auto-route on the first save, and a stored channel always
   * wins over this. Carried at the entry level, not inside `publish`, because the rows
   * that need it most are exactly the ones with no record yet.
   */
  promptSetChannelId: string | null;
  promptSetChannelName: string | null;
  publish: PublishFacts | null;
  /**
   * Why this item's selection record could not be read, or null.
   *
   * The row is still returned. A calendar that silently dropped the one item whose
   * record is corrupt would look exactly like a calendar of everything, and the operator
   * would find out by missing an upload.
   */
  publishFault: string | null;
}

export interface ReportIndexResponse {
  entries: ReportIndexEntry[];
  /** Report files that could not be indexed, each named with its reason. */
  problems: Array<{ file: string; message: string }>;
  /** True when the reports directory does not exist at all — not the same as empty. */
  directoryMissing: boolean;
  /** The reports directory that was read. */
  directory: string;
  /**
   * Selection records whose item is not in the report index, by item id.
   *
   * A record for a report that has been deleted. It cannot be rendered — there is no
   * title, no date and nothing to open — so it is NAMED rather than rendered or dropped:
   * the calendar shows the count, and the operator can see that a schedule they set is
   * no longer attached to anything.
   */
  orphanedSelections: string[];
}

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
   * The host's BROWSE index of every generated item — the same files `listGenerated`
   * reads, projected for a list rather than for a join (services/metadata/report-index.ts).
   *
   * Injected for the same reason as everything else here: the report format is the
   * host's. This is what `publish-list-index` joins the selection records onto, and it
   * is the reason the reports page no longer parses 111 job files in the renderer.
   */
  listReportRows: () => HostReportIndex;
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
   * The three calls "Upload to YouTube" needs (videos.insert, thumbnails.set, and the
   * categoryId read), injected exactly like pushApi and for the same reason: an insert
   * CREATES a video on a live channel, and the only acceptable way to exercise the flow
   * is against a fixture.
   */
  uploadApi: YouTubeUploadApi;
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

/**
 * The most items one `publish-thumb-strip` call may name.
 *
 * A ceiling rather than a page size: the reports list is the caller and it holds a few
 * hundred rows, so the whole visible list fits in one call and nothing has to paginate.
 * What the number prevents is a caller asking for every item ever generated in a single
 * synchronous decode pass, which would block the main process — and therefore every
 * window — for as long as it took.
 */
const MAX_THUMB_STRIP_ITEMS = 300;

/** One row of `publish-thumb-strip`. Three states, never fewer — see the handler. */
export interface ThumbStripEntry {
  itemId: string;
  /** The downscaled preview, or null when there is none to show. */
  dataUrl: string | null;
  /**
   * Why there is no preview, when the reason is a PROBLEM. null covers both "there is a
   * preview" and "nothing is attached to this item", which is not a problem at all.
   */
  fault: string | null;
}

/**
 * Decode a file that has already been validated and scale its longest edge to `maxPx`.
 *
 * ONE definition of what a preview is, shared by the single-item read and the list strip,
 * because two copies of this arithmetic are two answers to "how big is the image the
 * operator is looking at" — and the row and the panel showing different crops of the same
 * thumbnail is exactly the kind of disagreement nobody would think to check for.
 *
 * An image SMALLER than maxPx is returned untouched: upscaling a 320px export to fill a
 * 512px slot would show the operator detail the file does not contain.
 */
function renderThumbnailPreview(
  absPath: string,
  maxPx: number
): { dataUrl: string; previewSize: { width: number; height: number } } {
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

  return { dataUrl: preview.toDataURL(), previewSize: preview.getSize() };
}


export function setupPublishIpc(deps: PublishIpcDeps): void {
  const {
    store,
    readGenerated,
    listRecentUploads,
    listChannels,
    listGenerated,
    listReportRows,
    resolveTranscriptRef,
    pushApi,
    uploadApi,
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

  if (typeof listReportRows !== 'function') {
    throw new Error(
      'setupPublishIpc requires listReportRows: publish-list-index is the reports page\'s ' +
      'and the calendar\'s only source of rows, and there is nothing here that could ' +
      'read the report files itself.'
    );
  }

  if (!uploadApi || typeof uploadApi.insertVideo !== 'function'
      || typeof uploadApi.setThumbnail !== 'function' || typeof uploadApi.getLatestCategoryId !== 'function') {
    throw new Error(
      'setupPublishIpc requires uploadApi with insertVideo, setThumbnail and getLatestCategoryId. ' +
      'An upload without all three would half-create videos it cannot finish.'
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

  /**
   * Every generated item, joined to what the operator has decided about it.
   *
   * ONE call, for two pages. The reports list gets its rows from here instead of reading
   * and parsing 111 job files in the renderer on every mount, and the publish calendar
   * gets the join it could not do at all — display facts live on the output volume,
   * publish facts live under userData, and nothing before this had both.
   *
   * The selections are read ONCE into a map rather than per row: 111 rows against 44
   * records is 111 file reads the other way around, for a page that is meant to have
   * stopped doing exactly that.
   *
   * Three kinds of trouble are reported rather than swallowed, each in its own field: a
   * report file that will not parse (`problems`), a selection record that will not parse
   * (`publishFault` on its row), and a selection whose report is gone
   * (`orphanedSelections`). None of them shortens the list silently.
   */
  ipcMain.handle('publish-list-index', async () => {
    try {
      const index = listReportRows();
      const { records, faults } = store.listAllRecords();

      const byItem = new Map(records.map((r) => [r.itemId, r]));
      const faultByItem = new Map(faults.map((f) => [f.itemId, f.message]));

      // Prompt-set routing, once per distinct prompt set rather than once per row. An
      // ambiguous registry THROWS in the resolver (two channels claiming one set is a
      // config error) — here that lands in `problems` naming the prompt set, and the
      // rows carry null rather than the whole index failing.
      const channels = listChannels();
      const routeMemo = new Map<string, { channelId: string | null; name: string | null }>();
      const routeFor = (promptSet: string | null): { channelId: string | null; name: string | null } => {
        if (!promptSet || !promptSet.trim()) return { channelId: null, name: null };
        const memoed = routeMemo.get(promptSet);
        if (memoed) return memoed;
        let resolved: { channelId: string | null; name: string | null };
        try {
          const r = resolveChannelForPromptSet(promptSet, channels);
          resolved = { channelId: r.channelId, name: r.name };
        } catch (error: any) {
          index.problems.push({
            file: `prompt-set "${promptSet}"`,
            message: error?.message || String(error),
          });
          resolved = { channelId: null, name: null };
        }
        routeMemo.set(promptSet, resolved);
        return resolved;
      };

      const entries: ReportIndexEntry[] = index.rows.map((row): ReportIndexEntry => {
        const record = byItem.get(row.itemId) ?? null;
        const routed = routeFor(row.promptSet);
        return {
          promptSetChannelId: routed.channelId,
          promptSetChannelName: routed.name,
          itemId: row.itemId,
          jobId: row.jobId,
          label: row.label,
          displayTitle: row.displayTitle,
          createdAt: row.createdAt,
          dateIso: row.dateIso,
          promptSet: row.promptSet,
          sourceFilename: row.sourceFilename,
          sourceKey: row.sourceKey,
          titleCount: row.titleCount,
          jobPath: row.jobPath,
          jobSizeBytes: row.jobSizeBytes,
          itemIndex: row.itemIndex,
          txtFolder: row.txtFolder,
          txtFilePath: row.txtFilePath,
          publish: record
            ? {
                channelId: record.channelId,
                publishAt: record.publishAt,
                publishAtSetAt: record.publishAtSetAt,
                status: record.status,
                videoId: record.videoId,
                isPodcast: record.isPodcast,
                pushedAt: record.pushedAt,
                filledAt: record.filledAt,
                hasThumbnail: record.thumbnailPath !== null,
                thumbnailSource: record.thumbnailSource,
                monetize: MONETIZATION_ALWAYS_ON,
                spreakerEpisodeId: record.spreakerEpisodeId,
                abCount: record.chosenTitles.length,
                mainTitle: record.chosenTitles.length > 0 ? record.chosenTitles[0] : null,
              }
            : null,
          publishFault: faultByItem.get(row.itemId) ?? null,
        };
      });

      const known = new Set(index.rows.map((r) => r.itemId));
      const orphanedSelections = [
        ...records.filter((r) => !known.has(r.itemId)).map((r) => r.itemId),
        ...faults.filter((f) => !known.has(f.itemId)).map((f) => f.itemId),
      ];

      return ok<ReportIndexResponse>({
        entries,
        problems: index.problems,
        directoryMissing: index.directoryMissing,
        directory: index.directory,
        orphanedSelections,
      });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

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
   * Mark an item published by hand, or take that mark back.
   *
   * The operator sometimes uploads a video himself, outside both the API and the
   * extension; this is how the record catches up with reality. Its own channel rather
   * than a status field in publish-set-fields because the UNMARK direction is not a
   * value the caller can supply: what a record goes back to depends on what it holds
   * (a linked video, chosen titles, nothing), and that derivation belongs here where
   * the record can be read, not in a renderer guessing at store rules.
   */
  ipcMain.handle('publish-mark-published', async (_e, itemId: string, published: boolean) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      if (typeof published !== 'boolean') {
        return fail(`publish-mark-published requires a boolean; got ${describeValue(published)}.`);
      }
      const generated = requireGenerated(id);
      if (published) {
        return ok(await store.update(id, generated, { status: 'published' }));
      }
      const record = store.get(id);
      if (!record || record.status !== 'published') {
        return fail(
          `Item ${id} is not marked published (status "${record?.status ?? 'no record'}"), ` +
          `so there is no mark to take back.`
        );
      }
      const fallback = record.videoId
        ? 'linked'
        : record.chosenTitles.length > 0
          ? 'ready'
          : 'selecting';
      return ok(await store.update(id, generated, { status: fallback }));
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

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
        // 'manual' WITH A NULL PATH, and this is the case the field exists for: "no
        // thumbnail, because I removed it" is a decision, and leaving the source null
        // here would let automatic discovery re-attach the image the operator just took
        // off on the very next save. See ThumbnailSource.
        const cleared = await store.update(id, generated, {
          thumbnailPath: null,
          thumbnailMeta: null,
          thumbnailSource: 'manual',
        });
        return ok({ selection: cleared, warnings: [] as string[] });
      }

      // Throws with the file, the value and the rule when it fails. Nothing is stored.
      const { meta, warnings }: ThumbnailValidation = validateThumbnailFile(absPath);
      const selection = await store.update(id, generated, {
        thumbnailPath: absPath,
        thumbnailMeta: meta,
        thumbnailSource: 'manual',
      });
      return ok({ selection, warnings });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Choose a thumbnail file with the native picker.
   *
   * Its own channel rather than a reuse of 'select-files' for the reason
   * 'select-enrollment-audio' has its own: that dialog is multi-select with no filters
   * and hands back `files: string[]`, and a thumbnail is exactly one image out of a
   * folder that also holds .mov exports and project junk. The filter is the same three
   * extensions validateThumbnailFile accepts, so the picker cannot offer a file the
   * validator is about to refuse.
   *
   * It STORES NOTHING. The path comes back and the renderer sends it to
   * publish-set-thumbnail, which is the one place a thumbnail is validated and written —
   * the same door the drag-and-drop path goes through. A picker that wrote directly would
   * be a second writer with its own idea of what a valid thumbnail is.
   */
  ipcMain.handle('publish-choose-thumbnail', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Choose Thumbnail',
        filters: [{ name: 'Images', extensions: ['png', 'jpg', 'jpeg'] }],
        properties: ['openFile'],
      });
      // Cancelling is an answer, not a failure: null means "the operator changed their
      // mind", and the caller leaves the current thumbnail exactly as it was.
      if (result.canceled || result.filePaths.length === 0) return ok(null);
      return ok(result.filePaths[0]);
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
   * WHAT REACHES HERE, now that auto-config.ts exists: the SLOT-ONLY spelling, and only
   * it. A thumbnail named after this export has already been attached automatically by
   * the time the panel opens, so the item has one and never asks; a thumbnail named
   * `2 - youtube-thumbnail.png` follows the slot, and slots are renumbered between export
   * and upload often enough (13 of 40 live exports) that attaching one would be wrong
   * routinely and invisibly. So this is what is left to confirm by eye, which is what it
   * was always for.
   */
  ipcMain.handle('publish-propose-thumbnail', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const generated = requireGenerated(id);

      const candidates = deriveProposedThumbnailPaths(generated.sourcePath ?? null);
      const found = candidates.find((c) => fs.existsSync(c.path));
      if (!found) return ok(null);

      const { meta, warnings } = validateThumbnailFile(found.path);
      return ok({ path: found.path, meta, warnings });
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
      const { dataUrl, previewSize } = renderThumbnailPreview(absPath, maxPx);

      return ok({
        path: absPath,
        dataUrl,
        meta,
        warnings,
        previewSize,
      });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * "Look again" — re-run thumbnail discovery for ONE item, on the operator's click.
   *
   * The automatic pass (auto-config.ts) only ever fills a field NOBODY HAS ANSWERED, and
   * it runs on writes. Both of those are right for a pass nobody asked for, and both are
   * wrong for a button: the operator who makes the thumbnail after the run has an item
   * whose record already says "looked, found nothing", and no write he is about to make
   * would change that answer. This channel is the ask.
   *
   * WHAT THE CLICK AUTHORIZES, precisely: replacing an AUTOMATICALLY attached path with
   * the one on disk now. That is the stale case — a re-export under the same name, or an
   * image that arrived after the record was born — and re-deriving it is the whole point.
   * It authorizes nothing about a MANUAL choice, including a manual clear: a rescan that
   * could bring back an image the operator deleted by hand would make "remove this
   * thumbnail" a temporary state, so a 'manual' source is reported as skipped and the
   * record is not opened at all.
   *
   * A 'slot'-only match is still not attached, exactly as the automatic pass refuses to
   * attach one (see deriveProposedThumbnailPaths): slots are renumbered between export
   * and upload, so that filename can name another video's image, and a click meaning
   * "look again" is not a click meaning "and take one you cannot verify". It comes back
   * as skipped, naming the file, and publish-propose-thumbnail is where it gets confirmed
   * by eye.
   *
   * The three buckets are auto-config.ts's, for the reason they exist there: a field that
   * ended in none of them would be one the operator cannot account for afterwards.
   */
  ipcMain.handle('publish-rescan-thumbnail', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');

      const applied: AutoDecision[] = [];
      const skipped: AutoDecision[] = [];
      const refused: AutoDecision[] = [];

      // Read BEFORE the record, and failed on rather than worked around: the generated
      // report carries the sourcePath every candidate is derived from and the jobId every
      // write is seeded with, so without it there is no rescan to run — not an empty one.
      const generated = readGenerated(id);
      if (!generated) {
        return fail(
          `Item ${id} has no readable generated report, so there is nowhere to rescan for a ` +
          `thumbnail: the folder to look in comes from the run's recorded source path, and ` +
          `that report is missing or could not be read.`
        );
      }

      let record = store.get(id);
      if (!record) {
        // FIRST FILL. An item nobody has saved anything about has no record yet, and the
        // empty patch is how it gets one: the write rides the store's single door, so the
        // automatic pass runs on it and fills the channel and the thumbnail together —
        // the same thing that would have happened on the operator's first manual save.
        record = await store.update(id, generated, {});
        (record.channelId ? applied : skipped).push({
          field: 'channelId',
          detail: record.channelId
            ? `this item had no publish record; the rescan created one and routed it to ` +
              `${record.channelId} from the prompt set the run recorded.`
            : `this item had no publish record; the rescan created one, and it is not routed ` +
              `to a channel — the run recorded no prompt set, or no channel in channels.json ` +
              `claims the one it did. Pick a channel by hand.`,
        });
      }

      if (record.thumbnailSource === 'manual') {
        skipped.push({
          field: 'thumbnail',
          detail: record.thumbnailPath
            ? `${record.thumbnailPath} was chosen by hand, and a rescan never replaces a ` +
              `manually chosen thumbnail. Clear it in the panel first if you want the ` +
              `exported image instead.`
            : `the thumbnail was cleared by hand, and a rescan never undoes that. Attach one ` +
              `from the panel if you want an image on this item after all.`,
        });
        return ok({ applied, skipped, refused });
      }

      const candidates = deriveProposedThumbnailPaths(generated.sourcePath ?? null);
      if (candidates.length === 0) {
        skipped.push({
          field: 'thumbnail',
          detail: generated.sourcePath
            ? `${generated.sourcePath} is not inside a "complete" export folder, so there is ` +
              `no sibling "thumbnails" folder to look in.`
            : `this item has no single source file, so there is nowhere to look for an ` +
              `exported thumbnail.`,
        });
        return ok({ applied, skipped, refused });
      }

      const found = candidates.find((c) => fs.existsSync(c.path));
      if (!found) {
        skipped.push({
          field: 'thumbnail',
          detail:
            `still no exported thumbnail on disk. Looked for ${candidates.length} names, ` +
            `starting with ${candidates[0].path}.`,
        });
        return ok({ applied, skipped, refused });
      }

      // A slot-only match attaches like any other since 2026-08-25 (the operator's call,
      // made the day row thumbnails became visible): the attach sentence below flags it,
      // and a wrong image is caught by eye and corrected rather than gated up front.
      let validation: ThumbnailValidation;
      try {
        validation = validateThumbnailFile(found.path);
      } catch (err: any) {
        // The file IS there and cannot be used. Refused with the validator's own sentence
        // rather than thrown, so the panel can print what is wrong with the image the
        // operator just made instead of showing a failed call with no file named.
        refused.push({ field: 'thumbnail', detail: err?.message || String(err) });
        return ok({ applied, skipped, refused });
      }

      if (record.thumbnailPath === found.path) {
        skipped.push({
          field: 'thumbnail',
          detail:
            `${found.path} is already attached to this item — the rescan found the same file ` +
            `and left the record untouched.`,
        });
        return ok({ applied, skipped, refused });
      }

      const previous = record.thumbnailPath;
      await store.update(id, generated, {
        thumbnailPath: found.path,
        thumbnailMeta: validation.meta,
        thumbnailSource: 'auto',
      });

      const notes = validation.warnings.length ? ` ${validation.warnings.join(' ')}` : '';
      applied.push({
        field: 'thumbnail',
        detail:
          `attached ${found.path} — the sibling export of ${generated.sourcePath}, ` +
          `${validation.meta.width}x${validation.meta.height}, ${validation.meta.bytes} bytes` +
          (previous ? `, replacing the automatically attached ${previous}` : '') +
          (found.match === 'slot'
            ? `. The match was on the SLOT NUMBER only (legacy naming) — check the image, ` +
              `a renumbered slot can point at another video's thumbnail`
            : '') +
          `.${notes}`,
      });

      return ok({ applied, skipped, refused });
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * One downscaled preview per item, for a LIST.
   *
   * publish-read-thumbnail answers the same question for one item, and the reports list
   * would have to ask it once per row: 111 rows is 111 IPC round trips and 111 separate
   * decode passes scheduled by the renderer, which is the shape that made the reports page
   * slow enough to need publish-list-index in the first place. This is that call's list
   * form — one round trip, one pass, results in the order they were asked for so the
   * caller can zip them onto its rows without matching on ids.
   *
   * NOTHING HERE THROWS FOR ONE ITEM. A list of forty rows must not go blank because one
   * external volume was unplugged or one PNG is truncated, so per-item trouble travels IN
   * the row as `fault` — the validator's or the decoder's own sentence — and every other
   * row still renders. The ARGUMENTS still throw: a bad itemIds array or a bad maxPx is
   * the caller being wrong about the call, not a file being wrong on disk.
   *
   * `dataUrl: null, fault: null` is the ordinary, majority answer and NOT a failure: it
   * means nothing is attached to that item yet. The two nulls are what let the row render
   * an empty slot rather than an error badge.
   */
  ipcMain.handle('publish-thumb-strip', async (_e, itemIds: string[], maxPx: number) => {
    try {
      if (!Array.isArray(itemIds) || itemIds.length === 0) {
        throw new Error(
          `publish-thumb-strip needs a non-empty array of item ids — it is the list form of ` +
          `publish-read-thumbnail and there is nothing to read for an empty list; got ` +
          `${describeValue(itemIds)}.`
        );
      }
      if (itemIds.length > MAX_THUMB_STRIP_ITEMS) {
        throw new Error(
          `publish-thumb-strip was asked for ${itemIds.length} items; the limit is ` +
          `${MAX_THUMB_STRIP_ITEMS}, because every one of them is decoded on the main ` +
          `process and the whole app is unresponsive until the batch finishes. Ask for the ` +
          `rows being shown.`
        );
      }
      // Validated up front, all of them, before a single file is touched: a bad id in the
      // middle of the list is the caller's bug, and finding out about it after twenty rows
      // have already been decoded tells nobody which call was wrong.
      const ids = itemIds.map((value, i) => requireItemId(value, `itemIds[${i}]`));

      if (!Number.isInteger(maxPx) || maxPx < 16 || maxPx > 512) {
        throw new Error(
          `maxPx must be a whole number of pixels between 16 and 512 for a list strip ` +
          `(the row previews are thumbnails of thumbnails; use publish-read-thumbnail for a ` +
          `full-size preview); got ${describeValue(maxPx)}.`
        );
      }

      const results: ThumbStripEntry[] = [];
      for (const id of ids) {
        let record;
        try {
          record = store.get(id);
        } catch (err: any) {
          // An unreadable selection FILE, which is a fault about this row and not about
          // the image: named here so the list shows which record is corrupt.
          results.push({ itemId: id, dataUrl: null, fault: err?.message || String(err) });
          continue;
        }

        if (!record || !record.thumbnailPath) {
          results.push({ itemId: id, dataUrl: null, fault: null });
          continue;
        }

        try {
          // Re-validated on every read, exactly as the single-item preview is: the path was
          // checked when it was stored, which says nothing about the file now that the
          // volume it lives on can be unplugged or the image replaced.
          validateThumbnailFile(record.thumbnailPath);
          const { dataUrl } = renderThumbnailPreview(record.thumbnailPath, maxPx);
          results.push({ itemId: id, dataUrl, fault: null });
        } catch (err: any) {
          results.push({ itemId: id, dataUrl: null, fault: err?.message || String(err) });
        }
      }

      return ok(results);
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

  /**
   * Upload the item's SOURCE FILE as a new video, with its chosen metadata, schedule and
   * thumbnail — videos.insert, the API sibling of the push above. Refuses items already
   * linked to a video (that is a push). One upload per item at a time.
   *
   * AUDIT GATE: until Google approves the app's API audit the created video is locked
   * private regardless of its schedule. The UI says so next to the button; the receipt
   * records it (`lockedPrivatePendingAudit`).
   *
   * Progress travels as `publish-upload-progress` {itemId, sentBytes, totalBytes} on the
   * calling WebContents, throttled to ~4 Hz plus the final tick. Failures arrive
   * VERBATIM, exactly like the push.
   */
  const activeUploads = new Map<string, AbortController>();

  ipcMain.handle('publish-upload-youtube', async (e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      if (activeUploads.has(id)) {
        throw new Error(`Item ${id} is already uploading. Cancel it first or wait for it to finish.`);
      }
      const controller = new AbortController();
      activeUploads.set(id, controller);
      const sender = e.sender;
      let lastTickMs = 0;
      try {
        const outcome = await uploadItemToYouTube(id, {
          store,
          readGenerated,
          api: uploadApi,
          signal: controller.signal,
          onProgress: (sentBytes, totalBytes) => {
            const nowMs = Date.now();
            if (nowMs - lastTickMs < 250 && sentBytes !== totalBytes) return;
            lastTickMs = nowMs;
            if (!sender.isDestroyed()) {
              sender.send('publish-upload-progress', { itemId: id, sentBytes, totalBytes });
            }
          },
        });
        return ok(outcome);
      } finally {
        activeUploads.delete(id);
      }
    } catch (err: any) {
      return fail(err?.message || String(err));
    }
  });

  /**
   * Abort a running upload. `cancelled: false` is a FACT (nothing was running), not an
   * error — the operator clicking cancel a beat after the upload finished did nothing
   * wrong and there is nothing to report as failed.
   */
  ipcMain.handle('publish-upload-cancel', async (_e, itemId: string) => {
    try {
      const id = requireItemId(itemId, 'itemId');
      const controller = activeUploads.get(id);
      if (!controller) return ok({ cancelled: false });
      controller.abort();
      return ok({ cancelled: true });
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
