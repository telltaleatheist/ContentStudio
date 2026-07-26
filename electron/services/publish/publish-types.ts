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

/** YouTube enforces a 100-character title limit. */
export const MAX_TITLE_LENGTH = 100;

export type PublishStatus =
  | 'selecting'   // operator is still choosing; not ready to fill
  | 'ready'       // titles chosen, no YouTube video linked yet
  | 'linked'      // matched to a specific videoId
  | 'filled'      // extension has filled Studio fields (operator may not have saved yet)
  | 'published';  // operator saved/published; test presumed running

/** Which Studio fields the extension has been asked to fill. */
export type FillTarget = 'title' | 'description' | 'tags';

/**
 * The operator's chosen metadata for one generated item.
 * Keyed by (jobId, itemIndex) -- a job can produce many items.
 */
export interface ChosenMetadata {
  jobId: string;
  itemIndex: number;

  /** Ordered A/B variants; index 0 becomes the video's main title. Length <= MAX_AB_VARIANTS. */
  chosenTitles: string[];

  /** null = not edited, fall back to the generated description. */
  descriptionOverride: string | null;
  /** null = not edited, fall back to the generated tags. Comma-separated, matching MetadataResult.tags. */
  tagsOverride: string | null;

  /** Channel this item is destined for. Resolved from the prompt set when possible. */
  channelId: string | null;

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
  jobId: string;
  itemIndex: number;
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
  jobId: string;
  itemIndex: number;
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
 * SAFETY: this is the most important guard in the feature. `private` on its own also
 * covers finished videos awaiting a scheduled publish (which carry a real title, a
 * full description, and a publishAt). Filling those would destroy finished work.
 */
export function isDraftCandidate(c: DraftCandidate): boolean {
  return c.privacyStatus === 'private' && !c.publishAt;
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

export function emptyChosenMetadata(jobId: string, itemIndex: number): ChosenMetadata {
  return {
    jobId,
    itemIndex,
    chosenTitles: [],
    descriptionOverride: null,
    tagsOverride: null,
    channelId: null,
    videoId: null,
    sourceFilename: null,
    sourceDurationSec: null,
    status: 'selecting',
    updatedAt: new Date().toISOString(),
    filledAt: null,
  };
}
