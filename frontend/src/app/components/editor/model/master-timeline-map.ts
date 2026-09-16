// The map between the MASTER recording and the EDITOR'S TIMELINE, on its own.
//
// Pure — no Angular, no component state, no host. This is a property of the TIMELINE, not of
// stream marks: it came out of the stream-marks import (LEDGER #189) because that is where the
// non-linearity was first measured, but the same table answers "where in the recording is this
// moment of the timeline" for anything that has to move a timeline position by a REAL-TIME
// amount. Two callers have it now — the import dialog placing a night's marks, and the ribbon's
// shift-drag moving every story by one shared recording-time delta — and a second copy of a
// binary search over 1954 segments is exactly the pair that agrees until the day one of them
// learns about reordered footage (LEDGER law 10).
//
// THE ONE IDEA WORTH KNOWING: the timeline is NOT the recording. See masterToTimeline.

/**
 * The timeline's segment table, structurally — one piece of the master file on the timeline.
 *
 * This is `manifest.segments` for the video track, narrowed to the three numbers the mapping
 * needs, so this module needs no import from host-data/editor-manifest.ts (an EditorSegment is
 * assignable to it as it stands).
 */
export interface TimelineSegment {
  /** Seconds into the MASTER media file where this piece starts. */
  sourceStart: number;
  /** Seconds on the TIMELINE where it starts. */
  timelineStart: number;
  /** Seconds. The same length in both frames — a segment is a copy, never a stretch. */
  duration: number;
}

/** Where a master second landed, and whether it had to be moved to get there. */
export interface MappedMoment {
  /** Timeline seconds. */
  seconds: number;
  /**
   * True when the master second asked about is not ON the timeline at all — it sits in
   * material the edit removed (or before/after the kept range) — and `seconds` is therefore
   * the nearest place the content resumes rather than the exact instant asked for.
   */
  inGap: boolean;
}

/**
 * THE MAP BETWEEN THE MASTER FILE AND THE TIMELINE, and why one number cannot be it.
 *
 * A moment of the recording is a moment of the recording. The editor's timeline is not the
 * recording: the processing step drops dead air, so the timeline is a NON-LINEAR remap of the
 * master, and the further into the night you go the further the two clocks have drifted apart.
 *
 * Measured on Owen's 2026-09-14 session (the run this code was written for):
 *
 *   master file        11785.2 s (ffprobe)
 *   timelineDuration    9869.2 s, over 1954 segments covering 9868.6 s of the master
 *   dropped            1916 s — 32 minutes of the master is not on the timeline at all
 *
 * Six stream marks, mapped through the segment table against what a single additive offset
 * produced for the same night (the offset had been tuned until the LAST story landed):
 *
 *   mark (master s)   mapped      one-offset      error
 *        3927         3226.8         1991        20m36s
 *        5161         4257.7         3225        17m13s
 *        6530         5343.8         4594        12m30s
 *        9880         8252.5         7944         5m09s
 *       10834         9053.0         8898         2m35s
 *       11777         9865.9         9841           25s
 *
 * "Each story starts three minutes late" was that error, and no value of the offset fixes it:
 * an additive constant can only be right at ONE point on the timeline. The marks were always
 * right; the arithmetic was not. Nothing is ever added to a timeline second; a real-time delta
 * is applied in the MASTER's seconds and mapped back.
 *
 * THE SEGMENTS MUST BE ORDERED BY sourceStart before any of this is called: these run per
 * mouse move over 1954 segments × N boundaries, so they binary-search and do not sort. Use
 * `orderSegmentsBySource` once, where the manifest is ingested.
 */
export function orderSegmentsBySource(segments: readonly TimelineSegment[]): TimelineSegment[] {
  if (!Array.isArray(segments) || segments.length === 0) {
    throw new Error(
      'orderSegmentsBySource needs the timeline\'s segment table (manifest.segments for the ' +
      'video track); an empty one is not a timeline the marks can be mapped onto.'
    );
  }
  const ordered = segments
    .map((seg, i) => {
      if (!Number.isFinite(seg.sourceStart) || !Number.isFinite(seg.timelineStart) || !(seg.duration > 0)) {
        throw new Error(
          `Segment ${i} of the timeline is not a mappable piece: sourceStart=${seg.sourceStart}, ` +
          `timelineStart=${seg.timelineStart}, duration=${seg.duration}.`
        );
      }
      return { sourceStart: seg.sourceStart, timelineStart: seg.timelineStart, duration: seg.duration };
    })
    .sort((a, b) => a.sourceStart - b.sourceStart);
  // Overlapping source, or a timeline that runs backwards against the master, means the edit
  // has REORDERED its material — and a reordered timeline has no single answer to "where is
  // this master second", in either direction. Said rather than mapped to the first of several
  // truths (LEDGER law 1).
  for (let i = 1; i < ordered.length; i++) {
    const prev = ordered[i - 1];
    const seg = ordered[i];
    if (seg.sourceStart < prev.sourceStart + prev.duration - 1e-6) {
      throw new Error(
        `The timeline's segments ${i - 1} and ${i} overlap in the master file ` +
        `(${prev.sourceStart}+${prev.duration} runs past ${seg.sourceStart}), so one master ` +
        'second is in two places on the timeline and the stream marks cannot be mapped onto it.'
      );
    }
    if (seg.timelineStart < prev.timelineStart - 1e-6) {
      throw new Error(
        `The timeline plays the master out of order (segment ${i} starts at ${seg.timelineStart} s, ` +
        `after segment ${i - 1} at ${prev.timelineStart} s), so there is no single place a stream ` +
        'mark belongs. Stream marks can only be imported onto a timeline that runs forwards.'
      );
    }
  }
  return ordered;
}

/** Index of the last segment whose `key` is ≤ t, or -1 when t is before them all. */
function lastSegmentAtOrBefore(
  segments: readonly TimelineSegment[],
  t: number,
  key: (seg: TimelineSegment) => number
): number {
  let lo = 0;
  let hi = segments.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (key(segments[mid]) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

/**
 * A master second → where it is on the timeline. See the map's comment above.
 *
 * A second inside a kept piece maps exactly. A second in REMOVED material maps to where the
 * next kept piece starts — content resumes there, which is where a story boundary belongs —
 * and says so with `inGap`, because a boundary that moved is a boundary the operator did not
 * choose and must be told about. Before the first kept piece → its start; after the last →
 * the end of the last piece. Both are gaps too.
 */
export function masterToTimeline(segments: readonly TimelineSegment[], t: number): MappedMoment {
  if (segments.length === 0) {
    throw new Error('masterToTimeline needs the timeline\'s segment table; it was empty.');
  }
  if (!Number.isFinite(t)) {
    throw new Error(`masterToTimeline needs a finite master second, got ${JSON.stringify(t)}.`);
  }
  const first = segments[0];
  if (t < first.sourceStart) return { seconds: first.timelineStart, inGap: true };
  const i = lastSegmentAtOrBefore(segments, t, (seg) => seg.sourceStart);
  const seg = segments[i];
  const into = t - seg.sourceStart;
  if (into < seg.duration) return { seconds: seg.timelineStart + into, inGap: false };
  if (i + 1 < segments.length) return { seconds: segments[i + 1].timelineStart, inGap: true };
  return { seconds: seg.timelineStart + seg.duration, inGap: true };
}

/**
 * A timeline second → the master second it came from. The exact inverse of the above for any
 * `t` that is ON the timeline, which is what a drag needs: the pointer is a timeline position
 * and the answer it has to produce is a position in the recording.
 *
 * Past the end of the kept material → the last kept frame; before the start → the first.
 * There is no `inGap` here because there are no gaps in this direction: every second of the
 * timeline came from somewhere in the master.
 */
export function timelineToMaster(segments: readonly TimelineSegment[], t: number): number {
  if (segments.length === 0) {
    throw new Error('timelineToMaster needs the timeline\'s segment table; it was empty.');
  }
  if (!Number.isFinite(t)) {
    throw new Error(`timelineToMaster needs a finite timeline second, got ${JSON.stringify(t)}.`);
  }
  const first = segments[0];
  if (t <= first.timelineStart) return first.sourceStart;
  const i = lastSegmentAtOrBefore(segments, t, (seg) => seg.timelineStart);
  const seg = segments[i];
  const into = t - seg.timelineStart;
  if (into < seg.duration) return seg.sourceStart + into;
  // Between two pieces (the manifest's pieces are contiguous on the timeline, so this is a
  // rounding crack rather than a real gap) the next piece's first frame is the honest answer;
  // past the last piece, the last frame is.
  if (i + 1 < segments.length) return segments[i + 1].sourceStart;
  return seg.sourceStart + seg.duration;
}

/**
 * The master seconds the timeline is made of: [first kept frame, last kept frame].
 *
 * The one thing a caller moving a SET of timeline positions by a recording-time delta needs and
 * cannot get from the two mappings above. masterToTimeline answers every master second — a
 * second past the end of the recording maps to the end of the timeline, which is correct and is
 * also a collapse: push a whole set past the end and every boundary in it piles onto the same
 * frame, losing the relative positions that made it a set. Knowing where the recording's kept
 * material starts and stops is how a caller clamps the DELTA instead of the members.
 */
export function masterKeptRange(segments: readonly TimelineSegment[]): { from: number; to: number } {
  if (segments.length === 0) {
    throw new Error('masterKeptRange needs the timeline\'s segment table; it was empty.');
  }
  const last = segments[segments.length - 1];
  return { from: segments[0].sourceStart, to: last.sourceStart + last.duration };
}
