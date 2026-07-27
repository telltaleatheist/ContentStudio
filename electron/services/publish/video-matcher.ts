/**
 * Video Matcher
 *
 * Links a generated item to the YouTube draft it belongs to.
 *
 * Matching key is the ORIGINAL FILENAME, normalized on both sides. That works because
 * the same file is dropped into ContentStudio and uploaded to YouTube, and YouTube
 * derives an unconfigured draft's title from the filename (verified live 2026-07-26:
 * `f2 - amanda grace.mov` arrives as the title `f2   amanda grace`).
 *
 * Duration is a VERIFICATION GUARD, not the key. It catches the case that actually
 * bites in practice: re-exporting a cut, uploading v2, and the stale filename still
 * matching the old job. Filename agrees, duration doesn't, so we flag instead of
 * silently writing the wrong titles onto a new cut.
 *
 * SCOPE: every recent upload is a candidate, not just drafts. Scheduled and public videos
 * are legitimate targets -- a draft cannot be A/B tested at all, so the published case is
 * the one that matters most. What used to be a filter is now a LABEL: each candidate
 * carries its state, a true draft wins any tie, and the reason text names what the
 * operator is about to edit. Filling still only proposes text; they press Save.
 */

import type { UploadStatusEntry } from '../youtube/youtube-api.service';
import {
  DraftCandidate,
  MatchConfidence,
  VideoState,
  isDraftCandidate,
  normalizeForMatch,
  stateCaution,
  videoStateOf,
} from './publish-types';

/** Durations within this tolerance count as the same cut. */
const DURATION_TOLERANCE_SEC = 2;

export interface MatchInput {
  /** Basename of the analyzed source file, e.g. `f2 - amanda grace.mov`. */
  sourceFilename: string | null;
  /** Source duration in seconds, when known. */
  sourceDurationSec: number | null;
}

export interface MatchOutcome {
  candidate: DraftCandidate | null;
  confidence: MatchConfidence;
  reason: string;
  /** What the matched video currently is, so the UI can warn before overwriting it. */
  state: VideoState | null;
  /** Other candidates on the channel, so the operator can override the pick. */
  alternatives: DraftCandidate[];
}

/**
 * Map the YouTube API shape onto the matcher's own.
 *
 * No filtering: a scheduled or public video is a valid fill target. `videoStateOf` labels
 * each one so the caller can show what it is.
 */
export function toFillCandidates(
  entries: UploadStatusEntry[],
  channelId: string
): DraftCandidate[] {
  return entries.map((e): DraftCandidate => ({
    videoId: e.videoId,
    channelId,
    title: e.title,
    privacyStatus:
      e.privacyStatus === 'public' || e.privacyStatus === 'unlisted'
        ? e.privacyStatus
        : 'private',
    publishAt: e.publishAt,
    durationSec: e.durationSec || null,
    descriptionLength: e.descriptionLength,
    tagCount: e.tagCount,
  }));
}

function durationsAgree(a: number | null, b: number | null): boolean {
  if (a === null || b === null) return false;
  return Math.abs(a - b) <= DURATION_TOLERANCE_SEC;
}

function describeDuration(sec: number | null): string {
  if (sec === null) return 'unknown length';
  const m = Math.floor(sec / 60);
  const s = Math.round(sec % 60);
  return `${m}:${String(s).padStart(2, '0')}`;
}

/** Append the state caution to a reason, so a non-draft target always announces itself. */
function withState(candidate: DraftCandidate, reason: string): Pick<MatchOutcome, 'reason' | 'state'> {
  const state = videoStateOf(candidate);
  const caution = stateCaution(state);
  return { reason: caution ? `${reason} This video is ${caution}.` : reason, state };
}

/**
 * Pick the best video for one item.
 *
 * Never guesses when it can't tell: an ambiguous or absent filename match returns the
 * full candidate list for the operator to choose from rather than picking one arbitrarily.
 */
export function matchDraft(input: MatchInput, candidates: DraftCandidate[]): MatchOutcome {
  if (candidates.length === 0) {
    return {
      candidate: null,
      confidence: 'none',
      reason: 'No recent uploads on this channel.',
      state: null,
      alternatives: [],
    };
  }

  if (!input.sourceFilename) {
    return {
      candidate: null,
      confidence: 'none',
      reason: 'No source filename recorded for this item — pick the video manually.',
      state: null,
      alternatives: candidates,
    };
  }

  const wanted = normalizeForMatch(input.sourceFilename);
  const byFilename = candidates.filter((d) => normalizeForMatch(d.title) === wanted);

  // More than one video normalizes to the same name: refuse to guess.
  if (byFilename.length > 1) {
    const durationHits = byFilename.filter((d) =>
      durationsAgree(d.durationSec, input.sourceDurationSec)
    );
    if (durationHits.length === 1) {
      return {
        candidate: durationHits[0],
        confidence: 'exact',
        ...withState(
          durationHits[0],
          `Several videos share this name; matched on duration (${describeDuration(durationHits[0].durationSec)}).`
        ),
        alternatives: byFilename.filter((d) => d.videoId !== durationHits[0].videoId),
      };
    }

    // A still-unconfigured draft keeps its filename as its title, so if exactly one
    // candidate is a draft it is far and away the likeliest — an already-published video
    // matching the filename usually means this job was filled once before.
    const drafts = byFilename.filter(isDraftCandidate);
    if (drafts.length === 1) {
      return {
        candidate: drafts[0],
        confidence: 'filename',
        ...withState(
          drafts[0],
          `${byFilename.length} videos share the name "${input.sourceFilename}"; only one is still a draft.`
        ),
        alternatives: byFilename.filter((d) => d.videoId !== drafts[0].videoId),
      };
    }

    return {
      candidate: null,
      confidence: 'none',
      reason: `${byFilename.length} videos share the name "${input.sourceFilename}" — pick one.`,
      state: null,
      alternatives: byFilename,
    };
  }

  if (byFilename.length === 1) {
    const hit = byFilename[0];
    const others = candidates.filter((d) => d.videoId !== hit.videoId);

    // No duration on one side: filename alone is still a strong signal, just unverified.
    if (input.sourceDurationSec === null || hit.durationSec === null) {
      return {
        candidate: hit,
        confidence: 'filename',
        ...withState(hit, 'Filename matches. Duration unavailable, so this is unverified.'),
        alternatives: others,
      };
    }

    if (durationsAgree(hit.durationSec, input.sourceDurationSec)) {
      return {
        candidate: hit,
        confidence: 'exact',
        ...withState(hit, `Filename and duration both match (${describeDuration(hit.durationSec)}).`),
        alternatives: others,
      };
    }

    return {
      candidate: hit,
      confidence: 'filename',
      ...withState(
        hit,
        `Filename matches, but this video is ${describeDuration(hit.durationSec)} ` +
          `and the analyzed file was ${describeDuration(input.sourceDurationSec)} — different cut?`
      ),
      alternatives: others,
    };
  }

  // No filename hit. A unique duration match is the last signal worth reporting.
  const byDuration = candidates.filter((d) =>
    durationsAgree(d.durationSec, input.sourceDurationSec)
  );
  if (byDuration.length === 1) {
    return {
      candidate: byDuration[0],
      confidence: 'duration',
      ...withState(
        byDuration[0],
        `No filename match, but exactly one video is ${describeDuration(byDuration[0].durationSec)}. ` +
          `Was it renamed before upload?`
      ),
      alternatives: candidates.filter((d) => d.videoId !== byDuration[0].videoId),
    };
  }

  return {
    candidate: null,
    confidence: 'none',
    reason: `No video matches "${input.sourceFilename}" — pick one manually.`,
    state: null,
    alternatives: candidates,
  };
}
