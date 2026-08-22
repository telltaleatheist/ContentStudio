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
 * A link from a generated item to ONE story's editor transcript (Phase 2).
 *
 * THE TYPE ONLY. Nothing in this PR resolves, finds, or consumes one — that is PR 4.
 * It is declared here now so the record shape is settled in the same change that
 * settles the rest of ChosenMetadata, rather than migrating the file twice.
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
   * The operator's durable choice of editor-story transcript for this item, or null for
   * "generate content fields from the final export's own transcript".
   *
   * PHASE 2. Nothing in this PR sets, resolves or consumes it — the field exists so the
   * record shape is settled once. null here is not a fallback: it is the declared
   * final-export-only mode (spec §3.4).
   */
  transcriptRef: TranscriptRef | null;

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
    transcriptRef: null,
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
  if (!('transcriptRef' in stored)) upgraded.transcriptRef = null;

  return upgraded;
}
