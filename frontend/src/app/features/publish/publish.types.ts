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

/**
 * Spreaker's episode title limit — a DIFFERENT limit from YouTube's 100, on the same
 * string. Whichever destination is being pushed to is the one that binds.
 */
export const SPREAKER_MAX_TITLE_LENGTH = 140;

/**
 * The destination picker's value for "this goes to the podcast feed".
 *
 * Not a channel id and never stored as one: it is the UI's name for `isPodcast === true`,
 * which is the field that already carries this fact. Kept as a constant so the template,
 * the picker's handler and the manifest all say the same word.
 */
export const SPREAKER_DESTINATION = 'spreaker';

/** How the podcast destination reads in the picker and the manifest. */
export const SPREAKER_DESTINATION_LABEL = 'Spreaker (podcast)';

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

/**
 * What an episode audio file measured when it was last looked at.
 *
 * Deliberately NOT stored on the record, unlike ThumbnailMeta: a duration and a size are
 * facts about a file on an external volume at a moment, and the panel re-reads them
 * (publish-inspect-audio) every time it opens rather than showing what was true in July.
 */
export interface AudioMeta {
  bytes: number;
  /** Seconds, as ffprobe reports it. Always finite and > 0. */
  durationSec: number;
  /** Lower-case, with the dot: '.mp3'. */
  extension: string;
  audioCodec: string;
  /** True when the file also carries a video stream — legal, and worth saying. */
  hasVideo: boolean;
}

/**
 * An audio file this item could be, or already is, uploaded as.
 *
 * One type for both the PROPOSAL (the sibling export found on disk, never applied on its
 * own) and the INSPECTION (the file already chosen, re-measured). They carry the same
 * three things and the difference is entirely which question was asked.
 */
export interface AudioFile {
  path: string;
  meta: AudioMeta;
  /** Non-fatal notes — an undocumented extension, a file that still has video in it. */
  warnings: string[];
}

/** What publish-set-audio returns: the updated record, the measurements, any notes. */
export interface AudioSetResult {
  selection: ChosenMetadata;
  /** null exactly when the audio was CLEARED. */
  meta: AudioMeta | null;
  warnings: string[];
}

/**
 * What one "Upload to Spreaker" actually did.
 *
 * Same discipline as PushReceipt — every part either in `uploaded` or in `skipped` with
 * its reason — plus the identifiers Spreaker minted, which are the only way back to the
 * episode from here.
 */
export interface SpreakerReceipt {
  episodeId: number;
  showId: string;
  showTitle: string | null;
  /** ISO. When the upload completed. */
  pushedAt: string;
  uploaded: {
    title: string;
    description: { chars: number; firstLine: string };
    tags: { count: number };
    audio: { path: string; bytes: number; durationSec: number };
    /** Present only when the upload asked Spreaker to schedule publication. */
    autoPublishedAt?: string;
  };
  skipped: {
    autoPublishedAt?: string;
  };
  siteUrl: string | null;
  /**
   * PENDING | PROCESSING | READY | ERROR at the moment of the reply.
   *
   * A fresh upload is never READY — Spreaker re-encodes first — so this is what keeps the
   * receipt from being read as "the episode is live".
   */
  encodingStatus: string | null;
}

/** What publish-push-spreaker returns: the updated record plus the receipt stored on it. */
export interface SpreakerPushOutcome {
  selection: ChosenMetadata;
  receipt: SpreakerReceipt;
}

/**
 * Whether this machine can upload to Spreaker, and if not, what is missing.
 *
 * NEVER CARRIES THE TOKEN — only whether one is stored. `credentialsPath` is here so the
 * unconfigured state can say where the token goes instead of being a disabled button with
 * nothing to say for itself.
 */
export interface SpreakerStatus {
  configured: boolean;
  hasToken: boolean;
  showId: string | null;
  showName: string | null;
  savedAt: string | null;
  credentialsPath: string;
  /** Why `configured` is false, in the words to show. null when it is true. */
  reason: string | null;
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
  /**
   * Whether the chapter block is part of the composed description that gets pushed.
   *
   * Strictly boolean and never absent — records written before it existed are upgraded to
   * `true` on read, which is what they have always published.
   *
   * It governs the COMPOSED description only. Once `descriptionOverride` is set, that text
   * is pushed verbatim and this flag changes nothing.
   */
  chaptersInDescription: boolean;
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
   * Absolute path to the episode audio, or null. Proposed from the export's sibling
   * (`podcast 1.mp3` beside `podcast 1.mov`), never applied without confirmation, and
   * re-validated at upload time.
   */
  spreakerAudioPath: string | null;
  /**
   * Spreaker's episode id once uploaded, or null for never — AND the duplicate guard.
   * A Spreaker push is a CREATE, so pushing twice publishes a second episode rather than
   * replacing the first; a non-null value here refuses the next upload by name.
   */
  spreakerEpisodeId: number | null;
  /** ISO of that upload. null exactly when spreakerEpisodeId is. */
  spreakerPushedAt: string | null;
  /** What that upload sent, part by part. Last upload only. */
  spreakerReceipt: SpreakerReceipt | null;
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

/**
 * What one item's selection record says, for a list that shows many items at once.
 *
 * Mirror of PublishFacts in electron/services/publish/publish-ipc.ts. A projection, not
 * the record: a list needs to know WHETHER there is a thumbnail and HOW MANY variants are
 * picked, not the path or the strings.
 */
export interface PublishFacts {
  /** null = not routed yet. A real state, and the majority one today. */
  channelId: string | null;
  publishAt: string | null;
  publishAtSetAt: string | null;
  status: PublishStatus;
  videoId: string | null;
  isPodcast: boolean;
  pushedAt: string | null;
  filledAt: string | null;
  hasThumbnail: boolean;
  /** Three-valued exactly as the record holds it: true, false, or null for "not decided". */
  monetize: boolean | null;
  /** Spreaker's episode id once uploaded, or null for never — the podcast half of "sent". */
  spreakerEpisodeId: number | null;
  abCount: number;
  /** The first chosen title — the video's title — or null when none is picked yet. */
  mainTitle: string | null;
}

/**
 * One generated item joined to what the operator has decided about it.
 *
 * Mirror of ReportIndexEntry in electron/services/publish/publish-ipc.ts. `publish` is
 * null when the operator has never touched the item — the unstarted state, not missing
 * data.
 */
export interface ReportIndexEntry {
  itemId: string;
  jobId: string;
  label: string;
  displayTitle: string;
  createdAt: string;
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
  publish: PublishFacts | null;
  /** Why this item's selection record could not be read, or null. The row still exists. */
  publishFault: string | null;
}

/** Mirror of ReportIndexResponse. Every kind of trouble travels in its own field. */
export interface ReportIndexResponse {
  entries: ReportIndexEntry[];
  problems: Array<{ file: string; message: string }>;
  /** The reports directory does not exist at all — not the same as "it is empty". */
  directoryMissing: boolean;
  directory: string;
  /** Selection records whose report is gone. Named, never rendered or dropped. */
  orphanedSelections: string[];
}
