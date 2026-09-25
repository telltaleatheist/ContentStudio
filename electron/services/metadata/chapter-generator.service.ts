/**
 * Shared transcript/timestamp utilities and the `Chapter` shape.
 *
 * Chapters themselves are no longer built here — and the embedding pipeline this header
 * once pointed at is gone too (measured out 2026-08-22; CHAPTERING.md carries the numbers).
 * Chaptering lives in chaptering/ (snap, LEDGER #199) and chapter-whole-transcript.service.ts.
 * What remains here is SRT/YouTube time conversion and the `Chapter` shape every consumer emits
 * and reads. The episode splitter's budget sampling, sparse-timestamp transcripts and phrase
 * matcher went with it (P8b, plan §6.5). The filename outlives its meaning; renaming it would
 * touch nine importers for zero behavior, so it stays.
 */

/**
 * One PRE-consolidation chapter — the fine tier, as stage 4 named it from its own
 * transcript span, before stage 5 merged spans into stories.
 *
 * Retained rather than discarded because every one of these was already computed and
 * named before consolidation ran, and because it is exactly what a description's
 * chapter markers can use when a merged story is long. Only present on a chapter that
 * actually absorbed a neighbour.
 */
export interface SubChapter {
  timestamp: string;
  title: string;
  /** See Chapter.startApprox — carried per sub-chapter for the same reason. */
  startApprox?: boolean;
}

export interface Chapter {
  timestamp: string;
  title: string;
  sequence: number;
  endTimestamp?: string;
  /**
   * Description-grade prose for this chapter (20-45 words), written by the same
   * stage-4 call as `title`. The 4-8 word title is a marker; this is what the
   * description and tag stages actually have enough specifics to condition on.
   * Absent when the chapter came from a path that does not produce one.
   */
  detail?: string;
  /**
   * This start is a raw ±45s junction, not a mapped quote: no quote for it could be
   * located in the caption word stream.
   *
   * Carried on the chapter rather than left in a log because the failure is invisible
   * in the output — a chapter list built from these reads exactly like one built from
   * mapped quotes, and the only symptom is a viewer clicking a marker and landing half
   * a minute off. Absent = placed from a quote.
   */
  startApprox?: boolean;
  /** The chapters this one was consolidated from, in time order. Absent if never merged. */
  subChapters?: SubChapter[];
  /**
   * This chapter is a sponsor read, a Patreon plug, a sign-off or another ad break —
   * classified in code from its own name and detail (see promo-chapters.ts), never by
   * the chapter pipeline itself.
   *
   * Ads are not content: a promo chapter is kept out of the published chapter list and
   * out of everything the metadata tasks condition on, but it is LABELLED here and
   * carried in `metadata.excludedChapters` rather than deleted, because a chapter the
   * pipeline measured and named should never vanish without a trace.
   */
  isPromo?: boolean;
}

/**
 * Utility class for SRT time conversions
 */
export class TimeUtils {
  /**
   * Convert SRT time format (hh:mm:ss,ms) to seconds
   */
  static srtTimeToSeconds(srtTime: string): number {
    const [timePart, msPart] = srtTime.split(',');
    const [hours, minutes, seconds] = timePart.split(':').map(Number);
    const milliseconds = Number(msPart) || 0;
    return hours * 3600 + minutes * 60 + seconds + milliseconds / 1000.0;
  }

  /**
   * Convert seconds to YouTube chapter format (M:SS or H:MM:SS)
   */
  static secondsToYoutubeTime(seconds: number): string {
    const hours = Math.floor(seconds / 3600);
    const minutes = Math.floor((seconds % 3600) / 60);
    const secs = Math.floor(seconds % 60);

    if (hours > 0) {
      return `${hours}:${minutes.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
    } else {
      return `${minutes}:${secs.toString().padStart(2, '0')}`;
    }
  }

  /**
   * Convert YouTube time format to seconds
   */
  static youtubeTimeToSeconds(timeStr: string): number {
    const parts = timeStr.split(':').map(Number);

    if (parts.length === 3) {
      const [hours, minutes, seconds] = parts;
      return hours * 3600 + minutes * 60 + seconds;
    } else if (parts.length === 2) {
      const [minutes, seconds] = parts;
      return minutes * 60 + seconds;
    } else {
      return parts[0];
    }
  }
}
