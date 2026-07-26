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
 * SAFETY: only true drafts are ever offered. A private video WITH publishAt is
 * scheduled, finished work -- see isDraftCandidate().
 */

import type { UploadStatusEntry } from '../youtube/youtube-api.service';
import {
  DraftCandidate,
  MatchConfidence,
  isDraftCandidate,
  normalizeForMatch,
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
  /** Other drafts on the channel, so the operator can override the pick. */
  alternatives: DraftCandidate[];
}

/** Map the YouTube API shape onto the matcher's own, then keep only true drafts. */
export function toDraftCandidates(
  entries: UploadStatusEntry[],
  channelId: string
): DraftCandidate[] {
  return entries
    .map((e): DraftCandidate => ({
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
    }))
    .filter(isDraftCandidate);
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

/**
 * Pick the best draft for one item.
 *
 * Never guesses when it can't tell: an ambiguous or absent filename match returns the
 * full draft list for the operator to choose from rather than picking one arbitrarily.
 */
export function matchDraft(input: MatchInput, drafts: DraftCandidate[]): MatchOutcome {
  if (drafts.length === 0) {
    return {
      candidate: null,
      confidence: 'none',
      reason: 'No unconfigured drafts on this channel.',
      alternatives: [],
    };
  }

  if (!input.sourceFilename) {
    return {
      candidate: null,
      confidence: 'none',
      reason: 'No source filename recorded for this item — pick the draft manually.',
      alternatives: drafts,
    };
  }

  const wanted = normalizeForMatch(input.sourceFilename);
  const byFilename = drafts.filter((d) => normalizeForMatch(d.title) === wanted);

  // More than one draft normalizes to the same name: refuse to guess.
  if (byFilename.length > 1) {
    const durationHits = byFilename.filter((d) =>
      durationsAgree(d.durationSec, input.sourceDurationSec)
    );
    if (durationHits.length === 1) {
      return {
        candidate: durationHits[0],
        confidence: 'exact',
        reason: `Several drafts share this name; matched on duration (${describeDuration(durationHits[0].durationSec)}).`,
        alternatives: byFilename.filter((d) => d.videoId !== durationHits[0].videoId),
      };
    }
    return {
      candidate: null,
      confidence: 'none',
      reason: `${byFilename.length} drafts share the name "${input.sourceFilename}" — pick one.`,
      alternatives: byFilename,
    };
  }

  if (byFilename.length === 1) {
    const hit = byFilename[0];
    const others = drafts.filter((d) => d.videoId !== hit.videoId);

    // No duration on one side: filename alone is still a strong signal, just unverified.
    if (input.sourceDurationSec === null || hit.durationSec === null) {
      return {
        candidate: hit,
        confidence: 'filename',
        reason: 'Filename matches. Duration unavailable, so this is unverified.',
        alternatives: others,
      };
    }

    if (durationsAgree(hit.durationSec, input.sourceDurationSec)) {
      return {
        candidate: hit,
        confidence: 'exact',
        reason: `Filename and duration both match (${describeDuration(hit.durationSec)}).`,
        alternatives: others,
      };
    }

    return {
      candidate: hit,
      confidence: 'filename',
      reason:
        `Filename matches, but this draft is ${describeDuration(hit.durationSec)} ` +
        `and the analyzed file was ${describeDuration(input.sourceDurationSec)} — different cut?`,
      alternatives: others,
    };
  }

  // No filename hit. Fall back to a unique duration match before giving up.
  const byDuration = drafts.filter((d) => durationsAgree(d.durationSec, input.sourceDurationSec));
  if (byDuration.length === 1) {
    return {
      candidate: byDuration[0],
      confidence: 'duration',
      reason:
        `No filename match, but exactly one draft is ${describeDuration(byDuration[0].durationSec)}. ` +
        `Was it renamed before upload?`,
      alternatives: drafts.filter((d) => d.videoId !== byDuration[0].videoId),
    };
  }

  return {
    candidate: null,
    confidence: 'none',
    reason: `No draft matches "${input.sourceFilename}" — pick one manually.`,
    alternatives: drafts,
  };
}
