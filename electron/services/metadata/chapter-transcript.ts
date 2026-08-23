/**
 * Chapter transcript machinery — the pure, model-free half of chaptering
 *
 * WHAT THIS FILE IS NOW. It used to be `chapter-pipeline.service.ts`, and most of it was
 * the sealed 14B pipeline: label -> rate -> select -> place -> summarize -> consolidate,
 * ~390 one-question model calls a video. That pipeline, the 27B single-call path beside it,
 * and (on 2026-08-22, later the same day) the embedding pipeline that replaced both have all
 * been deleted in turn. The one architecture left is the whole-transcript single call in
 * chapter-whole-transcript.service.ts, and CHAPTERING.md's 2026-08-22 reversal section says
 * what was measured to get there.
 *
 * What survives here is everything that never had a model in it: the transcript reader, the
 * quote matcher, the cadence BAND the prompt states, and the result shape every downstream
 * stage is written against. The chapter service imports all of it rather than growing a
 * second copy — two transcript readers means two word streams, and a quote measured against
 * the wrong one points at the wrong moment.
 *
 * THE ONE LAW that shaped every deleted pipeline still shapes this one, and belongs with the
 * code rather than only in CHAPTERING.md: the model NEVER emits a timestamp. It quotes; this
 * file's word stream is what turns the quote into a time. An invented timestamp is a guess.
 * A mapped quote is a measurement.
 *
 * WHAT IS NOT HERE ANY MORE: `targetSecondsFor`, the code-side cadence table. The cadence is
 * a rate the model is told and applies to content it can see, stated in the prompt body in
 * shared/pipeline/chapters.yml. A second copy of it in code would be a count computed behind
 * the model's back, which is exactly the design the measurement rejected.
 */

import { SRTSegment } from './whisper.service';
import { Chapter, TimeUtils } from './chapter-generator.service';

/** YouTube refuses a chapter list with fewer than 3 entries. */
export const MIN_CHAPTERS = 3;

/** Lowercase, drop apostrophes, split on anything else. Contractions stay one word. */
export function normalizeWords(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

/**
 * Which side of the commentary a caption segment is: the host's own mic, the footage being
 * reacted to, or NEITHER.
 *
 * ContentStudio's segments carry free-form track ids (AutoCutStudio imports use "mic"/"screen";
 * the voice tagger writes "host"/"clip"/"unsure"; a plain Whisper run with no enrollment leaves
 * them undefined), so the sides are matched by name rather than assumed. An id that matches more
 * than one side, or none of them, returns null and the whole run stays untagged — a segment
 * silently rendered as CLIP would put the host's own words in the footage's mouth, which is the
 * exact error the tags exist to prevent.
 *
 * 'unsure' IS A THIRD SIDE, added with voice tagging (2026-08-23), and it is emphatically not
 * the same as null. null means "this transcript does not say"; 'unsure' means "this transcript
 * says nobody". The voice tagger produces it for a caption that straddles a cut — whisper.cpp
 * does not break its captions on speaker changes, so a caption containing both voices embeds as
 * a blend and scores between the two thresholds. Those words belong to neither side and the
 * prompt tells the model so, which is a better answer than picking whichever side is nearer.
 */
export type SpeakerRole = 'host' | 'clip' | 'unsure';

function speakerRoleOf(segment: SRTSegment): SpeakerRole | null {
  const id = `${segment.speaker || ''} ${segment.speakerLabel || ''}`.toLowerCase().trim();
  if (id.length === 0) return null;
  const host = /mic|host/.test(id);
  const clip = /screen|clip|footage/.test(id);
  const unsure = /unsure/.test(id);
  // Exactly one side, or it is not a usable attribution.
  if ([host, clip, unsure].filter(Boolean).length !== 1) return null;
  if (unsure) return 'unsure';
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
   * Human-readable degradations from this run: chapters dropped for an opening sentence
   * that could not be measured, chapters the model could not describe, titles that name
   * something their own transcript does not. Empty on a clean run. Surfaced to the user by
   * resolveChapters — a degraded chapter list looks exactly like a good one, so the only way
   * the user learns is if we say so.
   */
  warnings: string[];
  stats: ChapterRunStats;
}

/**
 * What one chapter run actually did, in the numbers this architecture can measure.
 *
 * Every REQUIRED field is one the whole-transcript path writes. The optional block below it
 * is history: job JSON written before 2026-08-22 carries stretch/junction/scorer counts from
 * two architectures that no longer exist, and the report reader must not start throwing on
 * its own past. Nothing writes them any more, and nothing derives anything from them.
 */
export interface ChapterRunStats {
  durationSeconds: number;
  /** Which rung of the prompt's cadence band this runtime landed on. */
  band: CadenceBand;
  /** Chapters the one call claimed, before any were dropped for an unmappable quote. */
  chaptersClaimed: number;
  /** ...and how many of those quotes measured to a time ahead of the previous chapter. */
  chaptersMapped: number;
  /**
   * Claimed chapters DROPPED because their quote could not be measured: it is not in the
   * transcript, or it resolves behind a chapter already placed. Each one is also named in
   * `warnings` — this is the count for the report, not the account for the user.
   */
  chaptersDropped: number;
  /**
   * Chapters published at an approximate start. STRUCTURALLY ZERO on this path and kept so
   * the shape does not change under the report reader: the quote is the only positional
   * evidence a whole-transcript call produces, so a chapter whose quote will not map has no
   * second, weaker time to fall back to and is dropped instead of guessed at.
   */
  approxStarts: number;
  /** The per-chapter detail calls ran with HOST:/CLIP: speaker tags. */
  speakerTagged: boolean;
  /** Generation calls: one for the chapters, one per chapter for its detail. */
  calls: number;

  // ---- read-back only: written by architectures that are deleted -------------------
  stretches?: number;
  junctions?: number;
  boundariesSelected?: number;
  chaptersBeforeConsolidation?: number;
  chaptersAfterConsolidation?: number;
  labelFailures?: number;
  ratingFailures?: number;
  scorer?: 'embedding' | 'lexical' | 'none';
}


// =============================================================================
// THE RUNTIME, AND THE CADENCE BAND IT SELECTS
//
// The prompt states a RATE — how close together turns of subject are allowed to sit at this
// runtime — and the model works the count out from the content. Code never computes a count;
// the deleted architectures did, and a count computed behind the model's back is what made a
// 45-second valley into a chapter boundary on a video that had four real ones.
//
// What code does own is the two inputs to that rate: the runtime, stated as a plain fact, and
// which rung of the band the runtime falls on — the latter only so a run can REPORT the rung it
// was judged against rather than leave it to an impression.
// =============================================================================

/** The rungs of the cadence band stated in shared/pipeline/chapters.yml. */
export type CadenceBand = 'under-10-minutes' | '10-to-30-minutes' | '30-minutes-and-longer';

/**
 * The runtime in the words the band language uses.
 *
 * Rounded to whole minutes on purpose: the model is being given the input to a rate rule, not
 * a measurement, and a spurious "58 minutes 41 seconds" invites arithmetic that is not the
 * point.
 */
export function runtimePhrase(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes} minutes`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  const hours = `${h} hour${h === 1 ? '' : 's'}`;
  return m === 0 ? hours : `${hours} ${m} minutes`;
}

/**
 * Which rung of the prompt's band this runtime falls on.
 *
 * The boundaries are the prompt's own — "under 10 minutes", "10 to 30 minutes", "30 minutes
 * and longer" — and they are here so the run's stats can name the rung. Nothing selects,
 * spaces or counts anything from this value.
 */
export function cadenceBandFor(durationSeconds: number): CadenceBand {
  const minutes = durationSeconds / 60;
  if (minutes < 10) return 'under-10-minutes';
  if (minutes < 30) return '10-to-30-minutes';
  return '30-minutes-and-longer';
}

// =============================================================================
// QUOTE -> TIMESTAMP — the phrase matcher, ported from the reference implementation
//
// It arrived with the embedding pipeline and outlived it: the whole-transcript call quotes the
// first sentence of each chapter exactly as the placement stage quoted the turn, and this is
// still the measurement that turns that sentence into a second. It lives HERE rather than in
// the service because it is pure, because it is what `mapChapterQuotes` below is built on, and
// because a second copy of it would be a second word stream.
// =============================================================================

/** Levenshtein distance: the minimum number of single-character edits between two strings. */
function levenshteinDistance(str1: string, str2: string): number {
  const m = str1.length;
  const n = str2.length;
  let previous = new Array<number>(n + 1);
  let current = new Array<number>(n + 1);
  for (let j = 0; j <= n; j++) previous[j] = j;

  for (let i = 1; i <= m; i++) {
    current[0] = i;
    for (let j = 1; j <= n; j++) {
      current[j] =
        str1[i - 1] === str2[j - 1]
          ? previous[j - 1]
          : 1 + Math.min(previous[j], current[j - 1], previous[j - 1]);
    }
    const swap = previous;
    previous = current;
    current = swap;
  }
  return previous[n];
}

/** Similarity ratio 0-1: Levenshtein distance normalized by the longer string. */
function stringSimilarity(str1: string, str2: string): number {
  if (str1 === str2) return 1;
  if (str1.length === 0 || str2.length === 0) return 0;
  return 1 - levenshteinDistance(str1, str2) / Math.max(str1.length, str2.length);
}

/** Lowercase, drop punctuation, collapse whitespace. The comparison space for quotes. */
function normalizeForComparison(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\w\s]/g, '')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * Word-stream similarity a quote must reach to be a measurement rather than a coincidence.
 * Ported from the reference phrase matcher.
 */
const FUZZY_THRESHOLD = 0.65;

/**
 * Words that carry no identity. Drive the fuzzy shortlist and the distinctive-word pass.
 * Copied from the reference matcher rather than re-derived.
 */
const QUOTE_COMMON_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'must', 'shall', 'can', 'need', 'dare',
  'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from', 'as',
  'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'and', 'but', 'or', 'nor', 'so', 'yet', 'both', 'either', 'neither',
  'not', 'only', 'own', 'same', 'than', 'too', 'very', 'just',
  'that', 'this', 'these', 'those', 'what', 'which', 'who', 'whom',
  'i', 'you', 'he', 'she', 'it', 'we', 'they', 'me', 'him', 'her', 'us', 'them',
  'my', 'your', 'his', 'its', 'our', 'their', 'mine', 'yours', 'hers', 'ours', 'theirs',
  'about', 'also', 'back', 'because', 'come', 'day', 'even',
  'first', 'get', 'give', 'go', 'good', 'know', 'like', 'look', 'make',
  'new', 'now', 'one', 'people', 'say', 'see', 'some', 'take', 'think',
  'time', 'two', 'use', 'want', 'way', 'well', 'work', 'year',
]);

/**
 * Measure where a quoted sentence starts, in seconds, or null if it is not in these cues.
 *
 * The model NEVER emits a timestamp — it quotes, and this is the measurement. Five
 * strategies, cheapest first, ported from the reference implementation:
 *
 *  1. the quote's first 50 normalized characters appear inside one cue;
 *  2. the same for its first 25, for a quote that straddles a cue break;
 *  3. Levenshtein similarity >= 65% against a SHORTLIST of cues sharing a distinctive
 *     word with the quote (a cue that could clear 65% necessarily shares one, so the
 *     shortlist cannot change which cue wins — it only skips ones that cannot);
 *  4. distinctive-word overlap, for a quote reworded despite the instruction not to;
 *  5. the same fuzzy test across each pair of consecutive cues, because auto-caption cues
 *     are ~7-word fragments and a quoted sentence usually spans two of them.
 *
 * WHICH CUES TO PASS IT. The embedding pipeline could only ever hand it the ~90s window its
 * placement call had seen, because a short quote matched against a whole video lands minutes
 * away on a repeated phrase. The whole-transcript call has no window — it read everything —
 * and the guard against that failure is the quote itself: a FULL first sentence of six words
 * or more is long enough to be unique, and `mapChapterQuotes` below narrows the search to the
 * cues after the previous chapter anyway. Across the measurement runs that combination mapped
 * 137 of 138 quotes with none out of order.
 */
export function findQuoteTime(quote: string, cues: Cue[]): number | null {
  if (!quote || !cues || cues.length === 0) return null;

  const normalizedPhrase = normalizeForComparison(quote);
  if (normalizedPhrase.length < 3) return null;

  const searchPhrase = normalizedPhrase.substring(0, 50);
  const normCues = cues.map((c) => normalizeForComparison(c.text));

  // Strategy 1: direct substring match on the first 50 characters.
  for (let i = 0; i < cues.length; i++) {
    if (normCues[i].includes(searchPhrase)) return cues[i].startSec;
  }

  // Strategy 2: shorter prefix, for a quote whose opening straddles a cue break.
  if (searchPhrase.length > 25) {
    const shortPhrase = normalizedPhrase.substring(0, 25);
    for (let i = 0; i < cues.length; i++) {
      if (normCues[i].includes(shortPhrase)) return cues[i].startSec;
    }
  }

  const phraseWords = normalizedPhrase
    .split(/\s+/)
    .filter((w) => w.length > 3 && !QUOTE_COMMON_WORDS.has(w));
  const phraseWordSet = new Set(phraseWords);
  const cueWordLists = normCues.map((t) => t.split(/\s+/));

  let candidateIdx: number[];
  if (phraseWords.length > 0) {
    candidateIdx = [];
    for (let i = 0; i < normCues.length; i++) {
      if (cueWordLists[i].some((w) => phraseWordSet.has(w))) candidateIdx.push(i);
    }
    if (candidateIdx.length === 0) candidateIdx = normCues.map((_, i) => i);
  } else {
    candidateIdx = normCues.map((_, i) => i);
  }

  // Strategy 3: fuzzy match over the shortlist.
  let best: { time: number; score: number } | null = null;
  for (const i of candidateIdx) {
    const text = normCues[i];

    if (text.length >= searchPhrase.length) {
      const similarity = stringSimilarity(searchPhrase, text.substring(0, searchPhrase.length + 10));
      if (similarity > FUZZY_THRESHOLD && (!best || similarity > best.score)) {
        best = { time: cues[i].startSec, score: similarity };
      }
    }

    const cmpLen = Math.min(normalizedPhrase.length, text.length);
    const fullSimilarity = stringSimilarity(
      normalizedPhrase.substring(0, cmpLen),
      text.substring(0, cmpLen)
    );
    if (fullSimilarity > FUZZY_THRESHOLD && (!best || fullSimilarity > best.score)) {
      best = { time: cues[i].startSec, score: fullSimilarity };
    }
  }
  if (best) return best.time;

  // Strategy 4: distinctive-word overlap.
  if (phraseWords.length > 0) {
    let bestWord: { time: number; total: number } | null = null;
    for (let i = 0; i < cues.length; i++) {
      const cueWords = cueWordLists[i];
      let exact = 0;
      let fuzzy = 0;
      for (const phraseWord of phraseWords) {
        // DEVIATION from the reference matcher, and the only one in this function.
        //
        // It tests `phraseWord.includes(cueWord)` with no length floor on the cue word,
        // so a one-letter caption word matches any quote word containing that letter:
        // measured here, "The submarine fleet departed Reykjavik before dawn" scored 4 of
        // 5 against "we have a lot to get through today" on the strength of the word "a"
        // alone, and resolved to a cue that shares nothing with it. That turns "this quote
        // is not in the transcript" — which the caller is supposed to DECLARE and drop —
        // into a confident wrong measurement, which is precisely the failure this app's
        // cardinal rule forbids. The containment test now needs a substantive word on BOTH
        // sides; exact equality is unaffected.
        if (cueWords.some((w) => w === phraseWord || (w.length > 3 && (w.includes(phraseWord) || phraseWord.includes(w))))) {
          exact++;
        } else if (cueWords.some((w) => w.length > 3 && stringSimilarity(phraseWord, w) > 0.75)) {
          fuzzy++;
        }
      }
      const total = exact + fuzzy * 0.8;
      if (total / phraseWords.length > 0.4 && (!bestWord || total > bestWord.total)) {
        bestWord = { time: cues[i].startSec, total };
      }
    }
    if (bestWord) return bestWord.time;
  }

  // Strategy 5: across consecutive cues.
  for (let i = 0; i < cues.length - 1; i++) {
    const combined = `${normCues[i]} ${normCues[i + 1]}`;
    if (combined.includes(searchPhrase)) return cues[i].startSec;
    const similarity = stringSimilarity(searchPhrase, combined.substring(0, searchPhrase.length + 15));
    if (similarity > FUZZY_THRESHOLD) return cues[i].startSec;
  }

  return null;
}

// =============================================================================
// THE CHRONOLOGICAL CURSOR
// =============================================================================

/** One chapter as the model claimed it: a title, and the sentence it says the chapter opens on. */
export interface ChapterClaim {
  label: string;
  quote: string;
}

/** One claim, and what measuring its quote against the caption word stream found. */
export interface ChapterQuoteMapping {
  /** 1-based position in the model's own list — the number the warnings name. */
  ordinal: number;
  label: string;
  quote: string;
  /** The measured start, or null when nothing ahead of the previous chapter matched. */
  time: number | null;
  /**
   * The same quote measured against the WHOLE cue stream. It is what tells "this sentence is
   * not in the transcript" apart from "this sentence is in it, behind a chapter already
   * placed" — two different faults that produce the same null, and the warning has to say
   * which one happened.
   */
  wholeVideoTime: number | null;
  status: 'mapped' | 'unmapped' | 'out-of-order';
}

/**
 * Measure each claimed chapter's opening sentence, forwards only.
 *
 * THE CURSOR IS THE WHOLE POINT. Each quote is searched only in the cues AFTER the cue that
 * placed the previous chapter, so a sentence the speaker says twice cannot pull chapter 5 back
 * to minute 2, and a list that is in order stays in order by construction. A quote that will
 * not match ahead of the cursor is NOT re-searched behind it and quietly accepted: it comes
 * back with `time: null` and a status, and the caller drops it and says so.
 *
 * Pure, so the ordering rule can be asserted without a model (tools/routing-publish-checks.js).
 */
export function mapChapterQuotes(claims: ChapterClaim[], cues: Cue[]): ChapterQuoteMapping[] {
  const results: ChapterQuoteMapping[] = [];
  let cursor = 0;
  let lastTime = -Infinity;

  claims.forEach((claim, i) => {
    const forward = cues.slice(cursor);
    const time = forward.length > 0 ? findQuoteTime(claim.quote, forward) : null;
    const wholeVideoTime = findQuoteTime(claim.quote, cues);
    const base = { ordinal: i + 1, label: claim.label, quote: claim.quote, wholeVideoTime };

    // `time === lastTime` is possible without the cursor catching it: two caption cues can
    // carry the same start second. A chapter that starts where the previous one started is
    // not a chapter, so it is refused here on the same terms as one that resolves backwards.
    if (time === null || time <= lastTime) {
      results.push({
        ...base,
        time: null,
        status: wholeVideoTime !== null ? 'out-of-order' : 'unmapped',
      });
      return;
    }

    const hitIndex = cues.findIndex((c, idx) => idx >= cursor && c.startSec === time);
    cursor = hitIndex >= 0 ? hitIndex + 1 : cursor;
    lastTime = time;

    results.push({ ...base, time, status: 'mapped' });
  });

  return results;
}
