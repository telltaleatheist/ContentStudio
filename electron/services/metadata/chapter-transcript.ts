/**
 * Chapter transcript machinery — the pure, model-free half of chaptering
 *
 * WHAT THIS FILE IS NOW. It used to be `chapter-pipeline.service.ts`, and most of it was
 * the sealed 14B pipeline: label -> rate -> select -> place -> summarize -> consolidate,
 * ~390 one-question model calls a video. That pipeline and the 27B single-call path that
 * sat beside it were both DELETED on 2026-08-22 when the embedding pipeline
 * (chapter-embedding.service.ts) became the only chaptering architecture — not the default
 * among three, the only one. Leaving two slower, worse implementations in the tree with no
 * way to reach them would be leaving three chaptering methods and one of them wired up.
 *
 * What survives is everything that never had a model in it: the transcript reader, the
 * cadence table, and the result shape every downstream stage is written against. The
 * embedding pipeline imports all of it rather than growing a second copy — two transcript
 * readers means two word streams, and a quote measured against the wrong one points at the
 * wrong moment.
 *
 * THE ONE LAW that shaped the deleted pipeline still shapes its replacement, and belongs
 * with the code rather than only in CHAPTERING.md: no model call ever sees a list, a count,
 * or the whole video. It quotes; this file's word stream is what turns the quote into a
 * timestamp. An invented timestamp is a guess. A mapped quote is a measurement.
 */

import { SRTSegment } from './whisper.service';
import { Chapter, TimeUtils } from './chapter-generator.service';

/** YouTube refuses a chapter list with fewer than 3 entries; also the over-collapse floor. */
export const MIN_CHAPTERS = 3;

/**
 * Cadence measured across 3,000+ published chapters. Drives both the target chapter
 * count and the minimum spacing between selected boundaries.
 *
 * The embedding pipeline derives its minimum boundary gap and its consolidation ceiling
 * from this same table. There is one cadence policy in this app and this is it — a second
 * copy of these numbers would drift.
 */
export function targetSecondsFor(durationSeconds: number): number {
  if (durationSeconds < 10 * 60) return 2.2 * 60;
  if (durationSeconds < 30 * 60) return 3.5 * 60;
  if (durationSeconds < 60 * 60) return 5.6 * 60;
  return 6 * 60;
}

/** Lowercase, drop apostrophes, split on anything else. Contractions stay one word. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Which side of the commentary a caption segment is: the host's own mic, or the
 * footage being reacted to.
 *
 * ContentStudio's segments carry free-form track ids (AutoCutStudio imports use
 * "mic"/"screen"; plain Whisper leaves them undefined), so the two sides are matched
 * by name rather than assumed. An id that matches BOTH sides, or neither, returns null
 * and the whole run stays untagged — a segment silently rendered as CLIP would put the
 * host's own words in the footage's mouth, which is the exact error the tags exist to
 * prevent.
 */
type SpeakerRole = 'host' | 'clip';

function speakerRoleOf(segment: SRTSegment): SpeakerRole | null {
  const id = `${segment.speaker || ''} ${segment.speakerLabel || ''}`.toLowerCase().trim();
  if (id.length === 0) return null;
  const host = /mic|host/.test(id);
  const clip = /screen|clip|footage/.test(id);
  if (host === clip) return null; // both or neither — not a usable attribution
  return host ? 'host' : 'clip';
}

/** One caption cue, with its slice of the flattened word stream. */
export interface Cue {
  startSec: number;
  endSec: number;
  text: string;
  wordStart: number;
  wordEnd: number; // exclusive
  /** Speaker side, when the transcript carries one. Read by stage 4 and nothing else. */
  role: SpeakerRole | null;
}

/**
 * Cues, with auto-caption rolling-window repeats removed.
 *
 * Auto-captions repeat the previous line as they scroll. The dedupe rule is the one
 * from the sealed method: drop a line that equals the previous line, or that the
 * previous line ends with.
 *
 * Module-level and EXPORTED because every consumer has to read the transcript through
 * exactly the same de-duplication and the same word cursor. Two transcript readers would
 * mean two word streams, and a quote measured against the wrong one points at the wrong
 * moment.
 */
export function buildCues(srtSegments: SRTSegment[]): Cue[] {
  const cues: Cue[] = [];
  let previous = '';
  let wordCursor = 0;

  for (const segment of srtSegments) {
    const text = (segment.text || '').trim();
    if (text.length === 0) continue;
    if (text === previous || (previous.length > 0 && previous.endsWith(text))) {
      continue;
    }
    previous = text;

    const wordCount = normalizeWords(text).length;
    if (wordCount === 0) continue;

    cues.push({
      startSec: TimeUtils.srtTimeToSeconds(segment.start),
      endSec: TimeUtils.srtTimeToSeconds(segment.end),
      text,
      wordStart: wordCursor,
      wordEnd: wordCursor + wordCount,
      role: speakerRoleOf(segment),
    });
    wordCursor += wordCount;
  }

  if (cues.length === 0) {
    throw new Error('Chapter pipeline found no usable caption text after de-duplication');
  }
  return cues;
}

/** One chapter's subject as the summarize stage wrote it: the marker, and the prose behind it. */
export interface ChapterSubject {
  /** The short chapter name. */
  about: string;
  /** Description-grade prose. Empty when the summarize call could not name it. */
  detail: string;
}

export interface ChapterPipelineResult {
  chapters: Chapter[];
  /** Chapter subjects in order, timestamps stripped — the input to every downstream field. */
  subjects: string[];
  /**
   * The same subjects with their `detail` prose alongside, in the same order.
   * `subjects` stays a plain string list because that is what the title stage is written
   * against; this is the richer conditioning input for description and tags.
   */
  subjectDetails: ChapterSubject[];
  /**
   * Human-readable degradations from this run: approximate starts, dropped boundaries,
   * chapters the model could not name, stretches it could not label. Empty on a clean
   * run. Surfaced to the user by resolveChapters — a degraded chapter list looks
   * exactly like a good one, so the only way the user learns is if we say so.
   */
  warnings: string[];
  stats: {
    durationSeconds: number;
    stretches: number;
    junctions: number;
    boundariesSelected: number;
    chaptersBeforeConsolidation: number;
    chaptersAfterConsolidation: number;
    /**
     * Kept at 0 by the embedding pipeline, which has no label or rate stage — they are the
     * two stages the batched embed call replaced. Retained on the shape because saved job
     * JSON from before 2026-08-22 carries real numbers in them and the report reader must
     * not start throwing on its own history.
     */
    labelFailures: number;
    ratingFailures: number;
    /** Final chapters whose start is a raw ±45s junction rather than a mapped quote. */
    approxStarts: number;
    /** Stage 4 ran with HOST:/CLIP: speaker tags. */
    speakerTagged: boolean;
    calls: number;
    /**
     * WHICH SCORER decided this run's boundaries, on the paths that have a choice.
     *
     * 'embedding' when the batched /api/embed call ran, 'lexical' when it failed and the
     * TF-IDF fallback scored the junctions instead, 'none' when the video was too short to
     * score at all. The lexical mode is a real degradation — it matches words, not meaning
     * — so it is recorded here as well as warned about, because a warning scrolls past and
     * a stat stays on the run.
     *
     * Absent on chapter lists read back from job JSON written before 2026-08-22, whose
     * boundaries came from model ratings and had no scorer to name.
     */
    scorer?: 'embedding' | 'lexical' | 'none';
  };
}

