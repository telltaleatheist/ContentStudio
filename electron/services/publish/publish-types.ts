/**
 * Publish Types
 *
 * Schema for the publish / title-A-B feature: the operator's CHOSEN metadata for a
 * generated item, plus the link from that item to a real YouTube video.
 *
 * Deliberately self-contained. This module may depend on `services/youtube` and on
 * `services/analytics` TYPES, but nothing here reaches into `services/metadata`
 * internals -- the generator upstream stays swappable so this whole directory can be
 * lifted into another Electron/Angular host (the planned AutoCutStudio merge).
 *
 * Key invariants:
 *  - `chosenTitles` is ORDERED. Index 0 is A/B variant 1, which YouTube falls back to
 *    when a test comes back inconclusive, so "which is first" is a real decision.
 *  - `descriptionOverride` / `tagsOverride` are null when the operator hasn't edited
 *    them. null means "use the generated value" -- so regenerating an item still flows
 *    through. Callers should read the RESOLVED value (see resolveChosenMetadata).
 *  - A YouTube "draft" is just a private video. `privacyStatus === 'private'` alone
 *    means "draft OR finished-and-scheduled"; a true draft additionally has NO
 *    publishAt. See isDraftCandidate().
 */

/** YouTube's native A/B test accepts at most 3 title variants. */
export const MAX_AB_VARIANTS = 3;

/**
 * Exact shape of an item id: `itm-<epochMs base36>-<8 base36>`.
 *
 * The regex lives HERE, not in services/metadata, for the reason this whole file exists:
 * publish/ must not import from the generator. services/metadata/item-identity.ts mints
 * the ids and re-exports this predicate, so there is exactly ONE definition of the shape
 * and the two sides agree by construction rather than by two regexes that look alike.
 *
 * Anything failing this is REJECTED at the boundary it arrived on. Nothing is coerced,
 * and in particular an itemIndex is never translated into an id — see publish-ipc.ts and
 * the ingest server's publish routes.
 */
export function isItemId(value: unknown): value is string {
  return typeof value === 'string' && /^itm-[0-9a-z]+-[0-9a-z]{8}$/.test(value);
}

/** YouTube enforces a 100-character title limit. */
export const MAX_TITLE_LENGTH = 100;

/**
 * Spreaker enforces a 140-character episode title limit — a DIFFERENT limit from
 * YouTube's 100, on the same string.
 *
 * Both are stated because the same `chosenTitles[0]` goes to both places, and the one
 * that binds is whichever destination is being pushed to. A title that passes here can
 * still be refused by the YouTube push, and that is not a contradiction.
 *
 * Source: developers.spreaker.com/api/episodes/ (title, "Max 140 characters"), read
 * 2026-08-22.
 */
export const SPREAKER_MAX_TITLE_LENGTH = 140;

/**
 * A schedule must be at least this far in the future when it is SET.
 *
 * Not re-checked on read: a schedule that has since gone stale is a real state the
 * calendar has to be able to show and explain (that is what `publishAtSetAt` is for),
 * not something to quietly scrub out of the record.
 */
export const PUBLISH_AT_MIN_LEAD_MINUTES = 15;

/** And no further out than this. A date beyond it is a typo, not a plan. */
export const PUBLISH_AT_MAX_HORIZON_YEARS = 2;

/**
 * ISO-8601 instant with an EXPLICIT zone — `Z` or `±HH:MM`.
 *
 * A bare `2026-09-01T14:00` is rejected rather than interpreted. It means a different
 * moment depending on who reads it, and the reader here is not the machine that typed
 * it: YouTube takes a UTC instant, so a local string would silently ship an upload at
 * the wrong hour whenever the app's TZ and the operator's intent disagreed (a DST
 * boundary between now and the date is enough to do that on its own).
 */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}(:\d{2})?(\.\d{1,9})?([Zz]|[+-]\d{2}:\d{2})$/;

export type PublishStatus =
  | 'selecting'   // operator is still choosing; not ready to fill
  | 'ready'       // titles chosen, no YouTube video linked yet
  | 'linked'      // matched to a specific videoId
  | 'filled'      // extension has filled Studio fields (operator may not have saved yet)
  | 'published';  // operator saved/published; test presumed running

/** Which Studio fields the extension has been asked to fill. */
export type FillTarget = 'title' | 'description' | 'tags';

/**
 * What was measured about a thumbnail file at the moment it was accepted.
 *
 * Stored alongside the path because the path alone cannot answer "is this still the
 * image I approved?" — Callisto is an external volume, and the file can be replaced,
 * re-exported at a different size, or gone entirely by the time we upload. The
 * validator is re-run at use time and its result compared against this.
 */
export interface ThumbnailMeta {
  bytes: number;
  width: number;
  height: number;
  mime: 'image/png' | 'image/jpeg';
}

/**
 * What one "Push to YouTube" actually did.
 *
 * Every part of the push is named here EITHER in `updated` OR in `skipped` with the
 * reason it was not sent. There is no third state: a part that is in neither would be a
 * part nobody can account for, and "did the thumbnail go?" is exactly the question this
 * record exists to answer weeks later.
 *
 * Sizes rather than contents for description and tags — the values themselves are already
 * on the record (or regenerable from the report), and a receipt that duplicated them
 * would be a second copy that could disagree with the first.
 */
export interface PushReceipt {
  /** The video that was written to. */
  videoId: string;
  /** The channel that video belongs to, as YouTube reported it at push time. */
  channelId: string;
  /** ISO. When the push completed. */
  pushedAt: string;
  updated: {
    /** snippet.title as sent — chosenTitles[0], the operator's variant 1. */
    title: string;
    /** Characters of description sent, and its first line, which is what a human recognises. */
    description: { chars: number; firstLine: string };
    /** How many tags were sent. */
    tags: { count: number };
    /** Present only when status.publishAt was set by this push. */
    publishAt?: string;
    /** Present only when a thumbnail was uploaded; the absolute path of the file sent. */
    thumbnail?: string;
  };
  /**
   * The parts this push did NOT send, each with the reason. A part is absent from here
   * exactly when it is present in `updated`.
   */
  skipped: {
    publishAt?: string;
    thumbnail?: string;
  };
}

/**
 * What was measured about an episode audio file at the moment it was accepted.
 *
 * The audio analogue of ThumbnailMeta, and it exists for the same reason: the path alone
 * cannot answer "is this still the file I approved?". It is NOT stored on the record —
 * unlike a thumbnail, whose dimensions the panel shows on every load, this is measured by
 * ffprobe (a subprocess against a file on an external volume) and re-measuring it is the
 * only honest answer at any later moment. It travels with the propose / inspect / set
 * replies, and a copy of it lands in the push receipt as the description of what was
 * actually sent.
 */
export interface AudioMeta {
  bytes: number;
  /** Seconds, as ffprobe reports the container's duration. Always finite and > 0. */
  durationSec: number;
  /** Lower-case, with the dot: '.mp3'. */
  extension: string;
  /** The audio stream's codec, e.g. 'mp3', 'aac', 'pcm_s16le'. */
  audioCodec: string;
  /** True when the file also carries a video stream — legal, and worth saying. */
  hasVideo: boolean;
}

/**
 * What one "Push to Spreaker" actually did.
 *
 * Same shape and same discipline as PushReceipt: every part of the upload is named EITHER
 * in `uploaded` OR in `skipped` with the reason. The difference from YouTube's is that
 * this one describes a CREATE — the episode did not exist before this call — so it also
 * carries the identifiers Spreaker minted, which are the only way to find the episode
 * again from here.
 */
export interface SpreakerReceipt {
  /** Spreaker's own episode id, as returned. Numeric in their API. */
  episodeId: number;
  /** The show it was created under, as this app asked for it. */
  showId: string;
  /** The show's title as Spreaker reported it, or null when the response carried none. */
  showTitle: string | null;
  /** ISO. When the upload completed. */
  pushedAt: string;
  uploaded: {
    /** The episode title as sent — chosenTitles[0]. */
    title: string;
    /** Characters of description sent, and its first line. */
    description: { chars: number; firstLine: string };
    /** How many tags were sent. */
    tags: { count: number };
    /** The file that was uploaded, as it measured at upload time. */
    audio: { path: string; bytes: number; durationSec: number };
    /** Present only when this upload asked Spreaker to schedule publication. */
    autoPublishedAt?: string;
  };
  /** The parts this upload did NOT send, each with the reason. */
  skipped: {
    autoPublishedAt?: string;
  };
  /** The episode's page on Spreaker, as reported. null when the response carried none. */
  siteUrl: string | null;
  /**
   * Spreaker's encoding status at the moment of the reply — PENDING or PROCESSING for a
   * fresh upload, never READY.
   *
   * Recorded because "the upload succeeded" and "the episode is playable" are different
   * facts and this receipt must not be read as claiming the second one. Spreaker
   * re-encodes every upload to CBR MP3 and that takes seconds to minutes.
   */
  encodingStatus: string | null;
}

/**
 * A link from a generated item to ONE story's editor transcript (Phase 2).
 *
 * Declared here because this is where the operator's DURABLE choice is stored; it is
 * found and confirmed by services/metadata/editor-transcript-link.ts and honored by the
 * input stage, which is also what records it in the report's content_provenance.
 *
 * The identity fields travel ALONGSIDE the path on purpose. A path that no longer
 * resolves can then say what it lost ("story 3 'jake lang' from session 2026-08-12"),
 * and a path that still resolves but whose session was re-exported can be detected as
 * CHANGED rather than reused as if nothing happened — see spec §3.1's three-state
 * resolution (ok / missing / changed).
 */
export interface TranscriptRef {
  kind: 'acs-story';
  /** Absolute path to <session>_stories_transcripts/<NN>-<slug>.json. */
  path: string;
  /** The editor session the story came from, e.g. the `<session>` in the filename. */
  sourceSession: string;
  /** The editor project folder that session lives in. */
  projectFolder: string;
  storyNumber: number;
  storySlug: string;
  storyTitle: string;
  /** Duration the transcript itself claims, used to compute drift against the export. */
  durationSeconds: number;
  /** Word count at link time: the cheap check that says "this file changed under us". */
  wordCount: number;
  /** ISO. When the operator made this link. */
  linkedAt: string;
  /** How the candidate was found — never a silent auto-link; see spec §3.2. */
  via: 'exact-title' | 'label-match' | 'manual';
}

/**
 * The operator's chosen metadata for one generated item.
 *
 * Keyed by `itemId` alone. It used to be keyed by (jobId, itemIndex), which is not a key:
 * the index changes the moment a sibling item is deleted, and every selection above the
 * hole then names a different item's chosen titles — which were still served to the
 * extension. See ITEM-ID-PLAN.md P4/P5.
 *
 * `jobId` survives as a DISPLAY BACK-REFERENCE only: it says which run produced this
 * item, which is worth showing, and it is what `clearItemsOfJob` matches when a whole job
 * is deleted from history. Nothing looks an item up by it.
 */
export interface ChosenMetadata {
  itemId: string;
  /** Display back-reference to the run that produced this item. Never a lookup key. */
  jobId: string;

  /** Ordered A/B variants; index 0 becomes the video's main title. Length <= MAX_AB_VARIANTS. */
  chosenTitles: string[];

  /** null = not edited, fall back to the generated description. */
  descriptionOverride: string | null;
  /** null = not edited, fall back to the generated tags. Comma-separated, matching MetadataResult.tags. */
  tagsOverride: string | null;

  /**
   * Channel this item is destined for.
   *
   * A VALUE HERE IS A KNOWN CHANNEL. It is seeded from the job's prompt set via
   * channels.json (resolveChannelForPromptSet), the operator can override it, and the
   * override is sticky — but every write goes through the validator, which refuses any
   * id that is not in the registry and names it. So a non-null channelId can be handed
   * to the YouTube API without being re-checked.
   *
   * null means "not routed yet", which is a real state and the only other one: an
   * unmapped prompt set stays null WITH A REASON rather than defaulting to Telltale
   * (spec §2.2 / Q6). Seeding happens lazily when the panel opens, not by a migration
   * that would have to guess for the 44 live records.
   */
  channelId: string | null;

  /**
   * When the operator intends this to go live: ISO-8601 with an explicit zone, or null
   * for "no schedule". See PUBLISH_AT_MIN_LEAD_MINUTES / PUBLISH_AT_MAX_HORIZON_YEARS
   * and validatePublishAt.
   *
   * This is INTENT, not state. YouTube only accepts a publishAt while a video is still
   * private and never-published; that constraint is enforced at the API call in Phase
   * 3/4, deliberately not here (spec Q4). Phase 1 stores what the operator asked for.
   */
  publishAt: string | null;

  /**
   * ISO. When `publishAt` was last set — recorded on EVERY set, including the set that
   * clears it to null.
   *
   * Provenance, not decoration: a schedule whose time has passed is ambiguous on its own
   * ("did it publish, or did we miss it?"), and the answer usually starts with when the
   * operator asked for it. Without this the calendar can only show a stale date and
   * shrug.
   */
  publishAtSetAt: string | null;

  /**
   * Absolute path to the thumbnail image, or null for none.
   *
   * Validated when set (PNG/JPEG by extension AND magic bytes, ≤2 MiB, ≥1280x720) and
   * RE-VALIDATED at use time — this points at an external volume, so "it was fine when
   * I picked it" is not a claim about now.
   */
  thumbnailPath: string | null;
  /** What the file measured when it was accepted. null exactly when thumbnailPath is. */
  thumbnailMeta: ThumbnailMeta | null;

  /**
   * True when this item is a podcast episode rather than a YouTube-first video.
   *
   * A STRICT BOOLEAN, NEVER ABSENT. Written explicitly by emptyChosenMetadata and
   * filled in by upgradeStoredMetadata for records written before the field existed.
   * That is the `_is_compilation` lesson: an absent flag read as falsy is
   * indistinguishable from a flag deliberately set false, so the day the reader's
   * defaulting changed, every old record silently changed meaning.
   */
  isPodcast: boolean;

  /**
   * Absolute path to the episode audio this item would be uploaded to Spreaker as, or
   * null for none chosen.
   *
   * PROPOSED, never assumed. The workflow exports `podcast 1.mp3` beside `podcast 1.mov`,
   * so a sibling with an audio extension is a good guess — and a guess is all it is, which
   * is why it is offered and confirmed exactly the way an exported thumbnail is. Nothing
   * writes this field except the operator accepting a file.
   *
   * Validated when set (exists, regular file, audio extension, ≤300 MB, and ffprobe finds
   * a real audio stream) and RE-VALIDATED at push time — it points at Callisto, and a
   * 132 MB file that was there when it was picked is not a claim about now.
   */
  spreakerAudioPath: string | null;

  /**
   * Spreaker's episode id once this item has been uploaded, or null for never.
   *
   * ALSO THE DUPLICATE GUARD, and that is the sharper half. The YouTube push is an
   * UPDATE and pushing twice is harmless; a Spreaker push is a CREATE, and pushing twice
   * publishes the same episode to the podcast feed twice. So a non-null value here makes
   * the next push refuse by name, and the only way past it is the operator explicitly
   * forgetting the link (which does not delete anything on Spreaker, and says so).
   */
  spreakerEpisodeId: number | null;

  /** ISO. When the episode was uploaded, or null for never. Null exactly when the id is. */
  spreakerPushedAt: string | null;

  /**
   * What that upload sent, part by part. null exactly when spreakerPushedAt is.
   *
   * Only the last one is kept, for the same reason pushReceipt keeps only the last: this
   * is a record of what is on Spreaker as far as this app knows, not a history.
   */
  spreakerReceipt: SpreakerReceipt | null;

  /**
   * Whether this video should be monetized — the operator's INTENT, three-valued.
   *
   *   true  -> turn monetization ON in Studio
   *   false -> turn it OFF in Studio
   *   null  -> NO DECISION RECORDED. The extension does not touch the control at all.
   *
   * null is a third state, not a default-off. The YouTube Data API cannot set
   * monetization (PUBLISH-PIPELINE-PLAN Phase 5), so the only thing that acts on this is
   * the companion extension typing into Studio's Monetization tab, and "the operator
   * never said" must not read as "the operator said off" — that would flip monetization
   * off on every legacy record the day the field shipped. Hence `boolean | null` rather
   * than the strict boolean `isPodcast` uses: isPodcast's false is a real answer, this
   * one's absence is not.
   *
   * Like isPodcast it is NEVER ABSENT: written explicitly by emptyChosenMetadata and
   * filled in by upgradeStoredMetadata, so `'monetize' in record` is always true.
   */
  monetize: boolean | null;

  /**
   * The operator's durable choice of editor-story transcript for this item, or null for
   * "generate content fields from the final export's own transcript".
   *
   * PHASE 2. SEEDED ONCE, when the record is created, from the run's own
   * `content_provenance.transcript_ref` — what the generator actually honored — and never
   * overwritten from a report afterwards. null here is not a fallback: it is the declared
   * final-export-only mode (spec §3.4).
   */
  transcriptRef: TranscriptRef | null;

  /**
   * ISO. When metadata was last PUSHED to the linked video, or null for never.
   *
   * Distinct from `filledAt`, which records the extension typing into Studio's form and
   * says nothing about whether the operator then saved it. This one is an API write that
   * either happened or threw, so it is the only timestamp here that means "YouTube has
   * these values".
   */
  pushedAt: string | null;

  /**
   * What that push sent, part by part. null exactly when pushedAt is.
   *
   * Only the LAST push is kept. This is a record of the video's current state as far as
   * this app knows it, not a history: a log of pushes belongs in a log, and keeping an
   * array here would grow a selection file without anything ever reading past index 0.
   */
  pushReceipt: PushReceipt | null;

  /** Set once the item is linked to a real video. */
  videoId: string | null;

  /**
   * Basename of the analyzed source file, used to match against a YouTube draft.
   * Stored because the job's input path may be gone by the time we go to publish.
   */
  sourceFilename: string | null;
  /** Source duration in seconds, used as a verification guard on the filename match. */
  sourceDurationSec: number | null;

  status: PublishStatus;
  updatedAt: string;         // ISO
  filledAt: string | null;   // ISO, when the extension last filled Studio
}

/** A ChosenMetadata with generated values merged in -- what the extension actually consumes. */
export interface ResolvedMetadata {
  itemId: string;
  /** Display back-reference to the run that produced this item. Never a lookup key. */
  jobId: string;
  channelId: string | null;
  videoId: string | null;
  /** Ordered. titles[0] is the main title AND A/B variant 1. */
  titles: string[];
  description: string;
  /** Comma-separated, as YouTube expects when typed into the tags field. */
  tags: string;
  sourceFilename: string | null;
  sourceDurationSec: number | null;
  status: PublishStatus;
  /**
   * The monetization intent, passed through UNRESOLVED — there is no generated value to
   * fall back to, so this is the stored three-valued field verbatim. null reaches the
   * extension as "leave Studio's monetization control alone".
   */
  monetize: boolean | null;
}

/** A YouTube video the matcher considers a fillable draft. */
export interface DraftCandidate {
  videoId: string;
  channelId: string;
  /** Current YouTube title -- for an unconfigured draft this is the mangled filename. */
  title: string;
  privacyStatus: 'private' | 'unlisted' | 'public';
  /** Absent on a true draft; present means the video is SCHEDULED -- do not touch. */
  publishAt: string | null;
  durationSec: number | null;
  descriptionLength: number;
  tagCount: number;
}

export type MatchConfidence =
  | 'exact'        // filename matches and duration agrees
  | 'filename'     // filename matches but duration disagrees -- probably a different cut
  | 'duration'     // duration matches but filename doesn't
  | 'none';

export interface DraftMatch {
  videoId: string;
  itemId: string;
  /** Display back-reference to the run that produced this item. Never a lookup key. */
  jobId: string;
  confidence: MatchConfidence;
  /** Human-readable reason, surfaced in the confirm panel. */
  reason: string;
}

/**
 * Normalize a filename (or a YouTube title derived from one) for comparison.
 *
 * YouTube mangles the uploaded filename into the initial title: it strips the
 * extension and collapses separators. Verified live 2026-07-26 --
 * `f2 - amanda grace.mov` arrives as the title `f2   amanda grace`.
 *
 * Applying this to BOTH sides makes the comparison an exact join rather than a
 * fuzzy similarity score.
 */
export function normalizeForMatch(nameOrTitle: string): string {
  return nameOrTitle
    .replace(/\.[A-Za-z0-9]{1,5}$/, '')  // strip a trailing file extension
    .replace(/[_.\-]+/g, ' ')            // separators become spaces
    .replace(/\s+/g, ' ')                // collapse whitespace runs
    .trim()
    .toLowerCase();
}

/**
 * A true draft is private AND never scheduled.
 *
 * `private` on its own also covers finished videos awaiting a scheduled publish (which
 * carry a real title, a full description, and a publishAt).
 *
 * This is no longer a filter -- scheduled and public videos are valid fill targets, and
 * in fact the only ones YouTube will A/B test, since a draft is ineligible. It is now a
 * CLASSIFIER: what it decides gets shown to the operator (see videoStateOf) and used to
 * break ties, so nobody rewrites finished work without seeing that that is what they are
 * doing.
 */
export function isDraftCandidate(c: DraftCandidate): boolean {
  return c.privacyStatus === 'private' && !c.publishAt;
}

/** What the operator is actually about to edit. */
export type VideoState = 'draft' | 'scheduled' | 'unlisted' | 'public';

export function videoStateOf(c: DraftCandidate): VideoState {
  if (isDraftCandidate(c)) return 'draft';
  if (c.privacyStatus === 'private') return 'scheduled';
  return c.privacyStatus;
}

/** Plain-language warning for a non-draft target, or null when it's a fresh draft. */
export function stateCaution(state: VideoState): string | null {
  switch (state) {
    case 'draft':
      return null;
    case 'scheduled':
      return 'scheduled — it already has finished metadata';
    case 'unlisted':
      return 'unlisted — already published';
    case 'public':
      return 'PUBLIC — live right now';
  }
}

/** Validation for a chosen-title set, surfaced in the UI before anything is filled. */
export function validateChosenTitles(titles: string[]): string[] {
  const errors: string[] = [];
  if (titles.length === 0) {
    errors.push('Pick at least one title.');
  }
  if (titles.length > MAX_AB_VARIANTS) {
    errors.push(`YouTube accepts at most ${MAX_AB_VARIANTS} A/B variants (got ${titles.length}).`);
  }
  titles.forEach((t, i) => {
    const trimmed = t.trim();
    if (!trimmed) {
      errors.push(`Variant ${i + 1} is empty.`);
    } else if (trimmed.length > MAX_TITLE_LENGTH) {
      errors.push(`Variant ${i + 1} is ${trimmed.length} chars; YouTube's limit is ${MAX_TITLE_LENGTH}.`);
    }
  });
  const seen = new Set<string>();
  for (const t of titles) {
    const key = t.trim().toLowerCase();
    if (key && seen.has(key)) {
      errors.push('Variants must be different from each other.');
      break;
    }
    seen.add(key);
  }
  return errors;
}

/**
 * Validate a schedule, returning the error message or null when it passes.
 *
 * Pure, and takes `now` as an argument so the two time-relative rules are testable
 * without waiting. Every message names the OFFENDING VALUE and the rule it broke —
 * "invalid date" tells the operator nothing about which of four things they got wrong.
 *
 * null is not passed here: clearing is handled by the caller, because clearing has no
 * rules to break.
 */
export function validatePublishAt(value: string, now: Date = new Date()): string | null {
  if (typeof value !== 'string' || !value.trim()) {
    return `publishAt must be an ISO-8601 timestamp with an explicit zone; got ${JSON.stringify(value)}.`;
  }
  const raw = value.trim();

  if (!ISO_WITH_ZONE.test(raw)) {
    return (
      `publishAt ${JSON.stringify(raw)} has no explicit time zone. ` +
      `Use an offset or Z (e.g. 2026-09-01T14:00:00-04:00 or 2026-09-01T18:00:00Z) — ` +
      `a local-looking timestamp means a different moment to whoever reads it, and ` +
      `YouTube reads it as an instant.`
    );
  }

  const when = new Date(raw);
  if (Number.isNaN(when.getTime())) {
    // Shape was right, calendar was not: 2026-02-30T00:00:00Z gets here.
    return `publishAt ${JSON.stringify(raw)} is not a real date and time.`;
  }

  const leadMs = when.getTime() - now.getTime();
  const minLeadMs = PUBLISH_AT_MIN_LEAD_MINUTES * 60_000;
  if (leadMs < minLeadMs) {
    const minutes = Math.round(leadMs / 60_000);
    const howFar =
      minutes < 0 ? `${Math.abs(minutes)} minutes in the PAST` : `only ${minutes} minutes away`;
    return (
      `publishAt ${JSON.stringify(raw)} is ${howFar}; a schedule must be at least ` +
      `${PUBLISH_AT_MIN_LEAD_MINUTES} minutes in the future when it is set.`
    );
  }

  const horizon = new Date(now.getTime());
  horizon.setFullYear(horizon.getFullYear() + PUBLISH_AT_MAX_HORIZON_YEARS);
  if (when.getTime() > horizon.getTime()) {
    return (
      `publishAt ${JSON.stringify(raw)} is more than ${PUBLISH_AT_MAX_HORIZON_YEARS} years out ` +
      `(the limit is ${horizon.toISOString()}); that is a typo, not a plan.`
    );
  }

  return null;
}

/**
 * A blank record for an item that has none yet.
 *
 * Both arguments are validated rather than trusted: this is the one place a selection
 * record comes into existence, and a record filed under a malformed id is a record
 * nothing will ever find again.
 */
export function emptyChosenMetadata(itemId: string, jobId: string): ChosenMetadata {
  if (!isItemId(itemId)) {
    throw new Error(`emptyChosenMetadata requires a valid item id; got ${JSON.stringify(itemId)}`);
  }
  if (typeof jobId !== 'string' || !jobId.trim()) {
    throw new Error(`emptyChosenMetadata requires the item's jobId; got ${JSON.stringify(jobId)}`);
  }
  return {
    itemId,
    jobId,
    chosenTitles: [],
    descriptionOverride: null,
    tagsOverride: null,
    channelId: null,
    // EVERY field is written explicitly, including the ones whose value is null and the
    // one whose value is false. A record is never partially shaped: `'isPodcast' in
    // record` is always true, so "absent" never has to be given a meaning.
    publishAt: null,
    publishAtSetAt: null,
    thumbnailPath: null,
    thumbnailMeta: null,
    isPodcast: false,
    // The four Spreaker fields, written out like every other one. The three that describe
    // an upload are null TOGETHER and stay that way until a push succeeds — there is no
    // state in which an item has an episode id but no receipt.
    spreakerAudioPath: null,
    spreakerEpisodeId: null,
    spreakerPushedAt: null,
    spreakerReceipt: null,
    // null, not false: "no monetization decision recorded" is a distinct state from
    // "monetize: off", and only the first one means the extension leaves the control
    // alone. See the field's doc comment.
    monetize: null,
    transcriptRef: null,
    pushedAt: null,
    pushReceipt: null,
    videoId: null,
    sourceFilename: null,
    sourceDurationSec: null,
    status: 'selecting',
    updatedAt: new Date().toISOString(),
    filledAt: null,
  };
}

/**
 * A record read from disk, brought up to the current field set.
 *
 * This is NOT a fallback and it is not error recovery. It is a one-way schema upgrade
 * for fields that DID NOT EXIST when the record was written: the 44 live selections
 * predate publishAt / thumbnailPath / isPodcast / transcriptRef entirely, and each one
 * gets exactly the value emptyChosenMetadata would have written on the day that field
 * shipped. Nothing is inferred, guessed, or repaired.
 *
 * Everything ALREADY PRESENT is left exactly as found — including values this version
 * would reject on a write. Stored data is the operator's, and quietly "correcting" it on
 * read would hide the fact that it needs attention.
 */
export function upgradeStoredMetadata(record: ChosenMetadata): ChosenMetadata {
  // The static type says every field is there; the FILE is what is actually being
  // described, and it was written by an older version. `in` on the raw object is the
  // only thing that can tell "written as null" from "did not exist yet" — which is the
  // distinction this function is about.
  const stored = record as unknown as Record<string, unknown>;
  const upgraded: ChosenMetadata = { ...record };

  if (!('publishAt' in stored)) upgraded.publishAt = null;
  if (!('publishAtSetAt' in stored)) upgraded.publishAtSetAt = null;
  if (!('thumbnailPath' in stored)) upgraded.thumbnailPath = null;
  if (!('thumbnailMeta' in stored)) upgraded.thumbnailMeta = null;
  if (!('isPodcast' in stored)) upgraded.isPodcast = false;
  // Every record written before the Spreaker upload shipped gets null on all four —
  // no audio chosen, and no episode uploaded. Neither is an inference: a record that
  // predates the feature cannot have uploaded anything through it.
  if (!('spreakerAudioPath' in stored)) upgraded.spreakerAudioPath = null;
  if (!('spreakerEpisodeId' in stored)) upgraded.spreakerEpisodeId = null;
  if (!('spreakerPushedAt' in stored)) upgraded.spreakerPushedAt = null;
  if (!('spreakerReceipt' in stored)) upgraded.spreakerReceipt = null;
  // Every record written before Phase 5 gets `null` — "nobody has decided" — which is
  // exactly what emptyChosenMetadata writes today. Reading absence as `false` would be
  // an inference: it would tell the extension to switch monetization OFF on 44 videos
  // whose operator never said anything of the kind.
  if (!('monetize' in stored)) upgraded.monetize = null;
  if (!('transcriptRef' in stored)) upgraded.transcriptRef = null;
  if (!('pushedAt' in stored)) upgraded.pushedAt = null;
  if (!('pushReceipt' in stored)) upgraded.pushReceipt = null;

  return upgraded;
}
