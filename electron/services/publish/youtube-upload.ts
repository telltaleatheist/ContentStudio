/**
 * YouTube Upload
 *
 * Creates ONE video on YouTube from an item's source file and chosen metadata:
 * videos.insert (title, description, tags, category, schedule) and then, when the item
 * has one, thumbnails.set. The API sibling of youtube-push.ts — that file writes onto a
 * video that already exists, this one brings the video into existence. Everything the
 * two would otherwise share (chosen-title rule, thumbnail validation, receipt shape) is
 * deliberately mirrored, not imported, so each file's refusals read complete on their own.
 *
 * ── AUDIT GATE ───────────────────────────────────────────────────────────────────────
 *
 * Until Google approves the app's API audit, a video uploaded THROUGH THE API is locked
 * private: it cannot be made public, not by the operator and not by its own publishAt.
 * The schedule still travels — YouTube holds it and it takes effect once the audit
 * clears — but until then release uploads belong in the browser. The Copy Desk labels
 * this; the receipt records it; nothing here pretends otherwise.
 *
 * ── What it refuses to do ────────────────────────────────────────────────────────────
 *
 * Nothing here has a fallback. Each of these throws, naming the item and the value:
 *   - no chosen title / no channel — same rules as the push, same wording.
 *   - a record already linked to a video. That is a metadata push, not an upload, and
 *     uploading would mint a DUPLICATE of a video that already exists.
 *   - a missing or empty source file. The path was recorded at generation time and
 *     points at an external volume; "it was there then" is not a claim about now.
 *   - no categoryId derivable from the channel's own uploads. videos.insert requires
 *     one, this app has no category picker, and inventing "22" here would be a silent
 *     editorial decision.
 *   - a thumbnail path that no longer validates — checked BEFORE the upload starts,
 *     so a bad file stops the run instead of surfacing after a gigabyte went up.
 *
 * ── Structure ────────────────────────────────────────────────────────────────────────
 *
 * `planVideoInsert` is PURE: record + resolved metadata + file facts + categoryId in,
 * the exact insert body out (or a throw). Every rule above lives in it, so all of them
 * are testable without a token or a disk.
 *
 * Sequencing after the insert is deliberate: the videoId is written onto the record
 * IMMEDIATELY — before the thumbnail — because from that moment the video exists on
 * YouTube, and a thumbnail failure must leave a linked record (retriable via Push),
 * never an orphan upload the app has forgotten it made.
 */

import * as fs from 'fs';
import { PublishStoreService, GeneratedFallback, resolveChosenMetadata } from './publish-store.service';
import { validateThumbnailFile } from './thumbnail-validate';
import { ChosenMetadata, UploadReceipt } from './publish-types';
import { firstLineOf, splitTags } from './youtube-push';

/** The API surface an upload needs. Structural, like YouTubePushApi, and for the same
 *  reason: the whole flow must be exercisable against a fake in the offline harness. */
export interface YouTubeUploadApi {
  insertVideo(
    channelId: string,
    filePath: string,
    body: VideoInsertBody,
    onProgress?: (sentBytes: number, totalBytes: number) => void,
    signal?: AbortSignal
  ): Promise<{ videoId: string }>;
  setThumbnail(
    channelId: string,
    videoId: string,
    image: Buffer,
    mime: 'image/png' | 'image/jpeg'
  ): Promise<unknown>;
  getLatestCategoryId(channelId: string): Promise<string | null>;
}

export interface VideoInsertBody {
  snippet: { title: string; description: string; tags: string[]; categoryId: string };
  status: {
    privacyStatus: 'private';
    publishAt?: string;
    /**
     * Always false. All three channels are adult commentary; the browser flow declares
     * the same thing on every upload, and leaving it unset would park the video behind
     * a Studio question the operator answered years ago.
     */
    selfDeclaredMadeForKids: boolean;
  };
}

export interface UploadOutcome {
  selection: ChosenMetadata;
  receipt: UploadReceipt;
}

export interface UploadPlanInput {
  record: ChosenMetadata;
  resolved: { title: string | null; description: string; tags: string };
  file: { path: string; sizeBytes: number };
  categoryId: string | null;
}

export interface UploadPlan {
  channelId: string;
  body: VideoInsertBody;
}

/** Pure: everything checkable without a token or a disk, checked. */
export function planVideoInsert(input: UploadPlanInput): UploadPlan {
  const { record, resolved, file, categoryId } = input;

  if (record.videoId) {
    throw new Error(
      `Item ${record.itemId} is already linked to video ${record.videoId}. Uploading would ` +
      `create a duplicate — use Push to update the existing video's metadata instead.`
    );
  }
  if (!record.channelId) {
    throw new Error(
      `Item ${record.itemId} has no channel, so an upload has no channel to authorize as. ` +
      `Route it to a channel first.`
    );
  }
  if (!resolved.title) {
    throw new Error(
      `Item ${record.itemId} has no chosen title. The first chosen title IS the video's ` +
      `title; nothing is uploaded until the operator has picked one.`
    );
  }
  if (file.sizeBytes <= 0) {
    throw new Error(`Item ${record.itemId}'s source file "${file.path}" is empty (0 bytes).`);
  }
  if (!categoryId) {
    throw new Error(
      `No categoryId could be derived from channel ${record.channelId}'s own uploads, and ` +
      `videos.insert requires one. Upload one video in the browser first, or add a category ` +
      `to the record by hand.`
    );
  }

  const body: VideoInsertBody = {
    snippet: {
      title: resolved.title,
      description: resolved.description,
      tags: splitTags(resolved.tags),
      categoryId,
    },
    status: {
      privacyStatus: 'private',
      ...(record.publishAt ? { publishAt: record.publishAt } : {}),
      selfDeclaredMadeForKids: false,
    },
  };
  return { channelId: record.channelId, body };
}

export interface UploadDeps {
  store: PublishStoreService;
  readGenerated: (itemId: string) => GeneratedFallback | null;
  api: YouTubeUploadApi;
  onProgress?: (sentBytes: number, totalBytes: number) => void;
  signal?: AbortSignal;
  now?: () => Date;
}

export async function uploadItemToYouTube(itemId: string, deps: UploadDeps): Promise<UploadOutcome> {
  const { store, readGenerated, api, onProgress, signal } = deps;
  const now = deps.now ?? (() => new Date());

  const generated = readGenerated(itemId);
  if (!generated) {
    throw new Error(`No generated metadata for item ${itemId} — there is nothing to upload.`);
  }
  const record = store.get(itemId);
  if (!record) {
    throw new Error(
      `Nothing has been saved for item ${itemId}, so it has no chosen title and no ` +
      `channel. There is nothing to upload.`
    );
  }

  const sourcePath = generated.sourcePath ?? null;
  if (!sourcePath) {
    throw new Error(
      `Item ${itemId}'s report records no source file path, so there is no video file to ` +
      `upload. Items generated before source paths were recorded need a browser upload.`
    );
  }
  if (!fs.existsSync(sourcePath)) {
    throw new Error(
      `Item ${itemId}'s source file is gone: "${sourcePath}". If the volume is unmounted, ` +
      `mount it; if the file moved, upload in the browser and link the video instead.`
    );
  }
  const sizeBytes = fs.statSync(sourcePath).size;

  // Thumbnail validated and read BEFORE the upload — a bad file stops the run now,
  // not after the gigabyte.
  let thumbnail: { path: string; bytes: Buffer; mime: 'image/png' | 'image/jpeg' } | null = null;
  let thumbnailSkipped: string | undefined;
  if (record.thumbnailPath) {
    const { meta } = validateThumbnailFile(record.thumbnailPath);
    thumbnail = { path: record.thumbnailPath, bytes: fs.readFileSync(record.thumbnailPath), mime: meta.mime };
  } else {
    thumbnailSkipped = 'No thumbnail is attached to this item, so none was uploaded.';
  }

  const resolved = resolveChosenMetadata(record, generated);
  const categoryId = await api.getLatestCategoryId(record.channelId!);
  const plan = planVideoInsert({
    record,
    // chosenTitles[0] IS the title — resolved.titles is NOT used here, because it falls
    // back to the generator's suggestions and an upload must never title a video with
    // something nobody picked. Same rule, same wording as the push.
    resolved: {
      title: record.chosenTitles[0] ?? null,
      description: resolved.description ?? '',
      tags: resolved.tags ?? '',
    },
    file: { path: sourcePath, sizeBytes },
    categoryId,
  });

  const { videoId } = await api.insertVideo(plan.channelId, sourcePath, plan.body, onProgress, signal);

  // The video now EXISTS. Link it before anything else can fail, so a thumbnail error
  // leaves a linked record the operator can retry via Push — never an orphan upload.
  await store.update(itemId, generated, { videoId, status: 'linked' });

  if (thumbnail) {
    await api.setThumbnail(plan.channelId, videoId, thumbnail.bytes, thumbnail.mime);
  }

  const receipt: UploadReceipt = {
    videoId,
    channelId: plan.channelId,
    uploadedAt: now().toISOString(),
    file: { path: sourcePath, bytes: sizeBytes },
    categoryId: plan.body.snippet.categoryId,
    title: plan.body.snippet.title,
    description: {
      chars: plan.body.snippet.description.length,
      firstLine: firstLineOf(plan.body.snippet.description),
    },
    tags: { count: plan.body.snippet.tags.length },
    ...(plan.body.status.publishAt ? { publishAt: plan.body.status.publishAt } : {}),
    ...(thumbnail ? { thumbnail: thumbnail.path } : {}),
    skipped: { ...(thumbnailSkipped ? { thumbnail: thumbnailSkipped } : {}) },
    lockedPrivatePendingAudit: true,
  };

  const selection = await store.update(itemId, generated, {
    pushedAt: receipt.uploadedAt,
    uploadReceipt: receipt,
  });

  return { selection, receipt };
}
