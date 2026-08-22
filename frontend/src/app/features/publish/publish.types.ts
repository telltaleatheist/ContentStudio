/**
 * Publish types — renderer-side mirror of electron/services/publish/publish-types.ts.
 *
 * Mirrored rather than imported because the renderer is a separate compilation unit
 * (same pattern as extension/src/types.ts mirroring analytics-types.ts). Keep the two
 * in sync when either changes.
 */

/** YouTube's native A/B test accepts at most 3 title variants. */
export const MAX_AB_VARIANTS = 3;

/** YouTube enforces a 100-character title limit. */
export const MAX_TITLE_LENGTH = 100;

export type PublishStatus = 'selecting' | 'ready' | 'linked' | 'filled' | 'published';

/** What a thumbnail file measured when it was accepted. */
export interface ThumbnailMeta {
  bytes: number;
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg';
}

/**
 * A link to one story's editor transcript (Phase 2). TYPE ONLY in this release —
 * nothing sets, resolves or consumes one yet.
 */
export interface TranscriptRef {
  kind: 'acs-story';
  path: string;
  sourceSession: string;
  projectFolder: string;
  storyNumber: number;
  storySlug: string;
  storyTitle: string;
  durationSeconds: number;
  wordCount: number;
  linkedAt: string;
  via: 'exact-title' | 'label-match' | 'manual';
}

/**
 * The outcome of routing a prompt set to a channel.
 *
 * A null channelId is a normal answer with a reason attached, not an error — the reason
 * is what the panel shows in place of a channel. (An AMBIGUOUS registry is an error and
 * arrives as a failed PublishResult instead.)
 */
export interface ChannelResolution {
  channelId: string | null;
  name: string | null;
  reason: string;
}

/** An exported thumbnail found on disk for an item. Never applied without confirmation. */
export interface ThumbnailProposal {
  path: string;
  meta: ThumbnailMeta;
  /** Non-fatal notes (e.g. not 16:9). The image is usable; these are shown beside it. */
  warnings: string[];
}

/** A thumbnail preview, downscaled in the main process. */
export interface ThumbnailPreview {
  path: string;
  /** data: URL — the renderer never reads the file itself. */
  dataUrl: string;
  meta: ThumbnailMeta;
  warnings: string[];
  previewSize: { width: number; height: number };
}

/** What publish-set-thumbnail returns: the updated record plus any non-fatal notes. */
export interface ThumbnailSetResult {
  selection: ChosenMetadata;
  warnings: string[];
}

export interface ChosenMetadata {
  /** The item's permanent id — the only thing that identifies it. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  /** Ordered. Index 0 becomes the main title AND A/B variant 1. */
  chosenTitles: string[];
  descriptionOverride: string | null;
  tagsOverride: string | null;
  /** A value here is always a REGISTERED channel id; null means "not routed yet". */
  channelId: string | null;
  /** ISO-8601 with an explicit zone, or null for no schedule. Intent, not YouTube state. */
  publishAt: string | null;
  /** ISO. When publishAt was last set — including the set that cleared it. */
  publishAtSetAt: string | null;
  /** Absolute path to an accepted PNG/JPEG, or null. Re-validated at use time. */
  thumbnailPath: string | null;
  /** What that file measured when accepted. null exactly when thumbnailPath is. */
  thumbnailMeta: ThumbnailMeta | null;
  /** Strictly boolean and never absent — see the _is_compilation lesson. */
  isPodcast: boolean;
  /** Phase 2. Always present, null until an editor story is linked. */
  transcriptRef: TranscriptRef | null;
  videoId: string | null;
  sourceFilename: string | null;
  sourceDurationSec: number | null;
  status: PublishStatus;
  updatedAt: string;
  filledAt: string | null;
}

export interface ResolvedMetadata {
  /** The item's permanent id — the only thing that identifies it. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  channelId: string | null;
  videoId: string | null;
  titles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  sourceDurationSec: number | null;
  status: PublishStatus;
}

/**
 * Uniform envelope returned by every publish-* IPC channel.
 *
 * Modelled with optional payload fields rather than a discriminated union to match the
 * convention used by every other IPC result type here — the renderer's tsconfig leaves
 * `strict` off, and without strictNullChecks a `success: true | false` union does not
 * narrow, so `res.error` after an `if (!res.success)` guard fails to compile.
 */
export interface PublishResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}
