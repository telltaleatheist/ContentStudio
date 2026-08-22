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
 * A link to one story's editor transcript (Phase 2).
 *
 * The Inputs page finds, confirms and stores one, and it rides the job. As of PR 5 the
 * generator CONSUMES it: content fields are written from the linked story's words, while
 * chapters stay on the final export's Whisper transcript, always.
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

/**
 * What one "Push to YouTube" actually did.
 *
 * Every part is named either in `updated` or in `skipped` with the reason it was not
 * sent — there is no third state, so "did the thumbnail go?" always has an answer.
 */
export interface PushReceipt {
  videoId: string;
  /** The channel that video belongs to, as YouTube reported it at push time. */
  channelId: string;
  /** ISO. When the push completed. */
  pushedAt: string;
  updated: {
    /** snippet.title as sent — chosenTitles[0]. */
    title: string;
    description: { chars: number; firstLine: string };
    tags: { count: number };
    /** Present only when this push set a schedule. */
    publishAt?: string;
    /** Present only when a thumbnail was uploaded; the file that was sent. */
    thumbnail?: string;
  };
  /** The parts this push did not send, each with its reason. */
  skipped: {
    publishAt?: string;
    thumbnail?: string;
  };
}

/**
 * The four fields that survive a regeneration, because each is a fact about the VIDEO
 * rather than about the run that generated it. Mirrors carry-forward.ts's CarryField.
 */
export type CarryField = 'transcriptRef' | 'channelId' | 'thumbnail' | 'isPodcast';

/** What an earlier run over the same source file holds that could be carried. */
export interface CarryableState {
  transcriptRef: TranscriptRef | null;
  channelId: string | null;
  thumbnailPath: string | null;
  thumbnailMeta: ThumbnailMeta | null;
  isPodcast: boolean;
}

/**
 * The offer: this video was generated before, and that run carries publish state.
 *
 * A HINT, never an inheritance (ITEM-ID-PLAN §3.2). Nothing is applied until the operator
 * clicks, and the main process re-reads and re-validates everything when they do.
 */
export interface CarryForwardCandidate {
  fromItemId: string;
  fromJobId: string;
  /** ISO. When the earlier run happened — the DATE in "generated before (…)". */
  jobCreatedAt: string;
  state: CarryableState;
  /** The normalized source basename that joins the two runs. */
  sourceKey: string;
  /** How many earlier items share it, whether or not they carry state. */
  siblingCount: number;
}

/** One field's outcome in a carry-forward receipt. */
export interface CarryFieldOutcome {
  field: CarryField;
  detail: string;
}

/**
 * What one carry-forward actually did — every one of the four fields in exactly one
 * bucket. `refused` is the loud half: a thumbnail whose file has vanished lands there
 * with the path named, and nothing dead is stored.
 */
export interface CarryReceipt {
  fromItemId: string;
  toItemId: string;
  applied: CarryFieldOutcome[];
  skipped: CarryFieldOutcome[];
  refused: CarryFieldOutcome[];
  warnings: string[];
  selection: ChosenMetadata | null;
}

/** What publish-push-youtube returns: the updated record plus the receipt stored on it. */
export interface PushOutcome {
  selection: ChosenMetadata;
  receipt: PushReceipt;
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
  /**
   * Monetization intent. Never absent, and three-valued: true / false / null, where null
   * means nobody has decided and the extension leaves Studio's control alone. Mirrors
   * publish-types.ChosenMetadata.monetize.
   */
  monetize: boolean | null;
  /** Phase 2. Always present, null until an editor story is linked. */
  transcriptRef: TranscriptRef | null;
  /** ISO. When metadata was last pushed to the linked video, or null for never. */
  pushedAt: string | null;
  /** What that push sent, part by part. null exactly when pushedAt is. Last push only. */
  pushReceipt: PushReceipt | null;
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
  /** Monetization intent, passed through unresolved — there is no generated counterpart. */
  monetize: boolean | null;
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
