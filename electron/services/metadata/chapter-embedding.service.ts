/**
 * Chapter Embedding Service — boundaries scored by an embedding model, selected in code
 *
 * A THIRD chapter architecture, beside the sealed 5-stage pipeline
 * (chapter-pipeline.service.ts) and the 27B single call (chapter-single-call.service.ts).
 * It is a port of the method validated in Briefcase in August 2026 and written up as a
 * portable, self-contained handoff document:
 *
 *   /Volumes/Callisto/Projects/Briefcase/docs/chapter-pipeline-handoff.md
 *
 * THAT DOCUMENT IS THE AUTHORITY for every constant, prompt and stage semantic in this
 * file. Where this file departs from it, the departure is stated in a comment and says
 * why. Reference implementation: Briefcase branch `analysis-pipeline-tuning`,
 * backend/src/analysis/{chapter-detection.service,phrase-matcher,model-utils}.ts.
 *
 * WHY IT EXISTS. The sealed pipeline's law — a 14B cannot select K items from N, so never
 * show it a list — cost ~2 model calls per 45 seconds of video: one to LABEL each stretch,
 * one to RATE each junction. Those O(N) calls only ever answered one question, "how
 * different is what comes before this point from what comes after it", and they answered
 * it weakly (the design's power was in RANKING the ratings, not in any single one). A text
 * embedding model answers the same question in milliseconds, batched, with a continuous
 * score. So embeddings score every junction, CODE selects, and the LLM is kept for the one
 * thing embeddings cannot do: read the junction window and quote the sentence the subject
 * turns on.
 *
 *   1. STRETCH      code        45s stretches, grid-aligned, never splitting a caption
 *   2. SCORE        embeddings  ONE batched /api/embed call; block cosine; valley depth
 *   3. SELECT       code        deepest valleys first, min gap enforced, `wanted` taken
 *   4. PLACE        LLM         one small call per selected junction: quote the turn
 *   5. CONSOLIDATE  code        merge adjacent chapters whose centroids still match
 *   6. SUMMARIZE    LLM         one call per chapter, from its RAW transcript + context
 *
 * ~10 generation calls for an hour of video, against the sealed pipeline's ~170.
 *
 * FAILURE POLICY, which is this app's cardinal rule applied to the handoff document's
 * "graceful degradations". Every degradation the document prescribes happens here as a
 * DECLARED, RECORDED mode: it is logged, it is counted in the run's stats, and it is
 * pushed into `warnings` so the job report says it happened. There is no silent recovery
 * anywhere in this file. Specifically:
 *
 *  - the embed call fails       -> the lexical TF-IDF scorer runs, `stats.scorer` says
 *                                  'lexical', and a warning names the failure.
 *  - a placement answer fails   -> that boundary keeps its raw +/-45s junction time, is
 *    or its quote will not map     counted in `stats.approxStarts`, is marked
 *                                  `startApprox` on the chapter, and a warning names it.
 *  - a placement time regresses -> the boundary is DROPPED and a warning names it. (The
 *                                  reference implementation drops it with no record; that
 *                                  is the one silent degradation in the source method and
 *                                  it is not reproduced here.)
 *  - a summarize answer fails   -> the chapter is named from its own opening words and a
 *                                  warning says so, exactly as the sealed pipeline does.
 *  - under 2 stretches          -> one chapter, zero model calls, `stats.scorer` 'none',
 *                                  and a warning saying the video was too short to score.
 *
 * What is NOT a degradation and therefore throws: a transport failure (Ollama unreachable,
 * model not installed, request timeout). Those mean every remaining call is affected, not
 * that one answer was bad, and resolveChapters already records `chaptersSkipped` and
 * generates the rest of the metadata without chapter subjects — a state the user sees.
 *
 * The result is the SAME ChapterPipelineResult the other two paths return, so promo
 * exclusion, `chaptersSkipped`, the description's chapter lines and report rendering all
 * work against it without knowing which path produced it.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { SRTSegment } from './whisper.service';
import { Chapter, TimeUtils } from './chapter-generator.service';
import {
  buildCues,
  normalizeWords,
  targetSecondsFor,
  ChapterPipelineResult,
  Cue,
} from './chapter-pipeline.service';
import { CHAPTER_EMBEDDING_PROMPTS } from './chapter-prompts';
import { formatPrompt } from './system-prompts';
import { isAbortError } from './cancellation';

/** The three stages that can report progress. Stages 1, 3 and 5 are code and run instantly. */
export type ChapterEmbeddingStage = 'embed' | 'place' | 'summarize';

// =============================================================================
// CONSTANTS — handoff document section 9. Every one is inherited, not chosen here.
// =============================================================================

/**
 * Stretch length (3.1). Inherited from the validated AutoCutStudio method: long enough
 * that a stretch has a topic, short enough that a boundary is located to within one
 * stretch before placement resolves it to the sentence.
 */
const STRETCH_SECONDS = 45;

/**
 * Stretches per side in the block comparison (3.2). Comparing single stretches scores
 * every rhetorical pause as a topic change; averaging two a side (~90s) measures the
 * subject rather than the sentence.
 */
const BLOCK = 2;

/** Section 6. 137M parameters, 274MB — small enough to coexist with any generation model. */
const EMBED_MODEL = 'nomic-embed-text';

/**
 * Section 9. One batched call embedded 85 stretches (63 minutes of video) in ~2s, so a
 * minute is a generous ceiling. It is bounded rather than left hanging because a wedged
 * embed must become the declared lexical mode, not a stalled job.
 */
const EMBED_TIMEOUT_MS = 60_000;

/** 3.2 / 6. Keeps the model resident across the run without unloading anything else. */
const KEEP_ALIVE = '10m';

/**
 * 3.5. Adjacent chapters whose centroid vectors are this similar are the same subject.
 * Calibrated for nomic-embed-text cosines and the least-tuned constant in the method.
 *
 * On the LEXICAL scorer TF-IDF cosines run much lower and this threshold effectively
 * never merges — which fails in the safe direction (too many chapters, not too few) and
 * is stated in the warning that declares the lexical mode.
 */
const CONSOLIDATE_SIMILARITY = 0.8;

/**
 * Section 9. Word-stream similarity a quote must reach to be a measurement rather than a
 * coincidence. Ported from the reference phrase matcher.
 */
const FUZZY_THRESHOLD = 0.65;

/**
 * Section 7. Under two stretches there is no junction to score at all, so the answer is
 * one chapter and zero model calls — a video with one subject is a real answer, not a
 * failure.
 */
const MIN_STRETCHES_TO_SCORE = 2;

/**
 * Ceiling on consolidation, in multiples of the cadence table's target chapter length.
 *
 * 3.5 bounds merging by "the app's maximum chapter length". ContentStudio has no such
 * setting — the sealed pipeline bounds nothing and the single-call path bounds only the
 * minimum — so the cap is derived from the one cadence policy this app does have
 * (targetSecondsFor): a merged chapter may not exceed 3x the target for the video's
 * duration, i.e. ~18 minutes on an hour-long video. STATED rather than hidden because it
 * is the one constant in this file with no measurement behind it; `maxChapterSeconds`
 * overrides it.
 */
const MAX_CHAPTER_TARGET_MULTIPLE = 3;

/**
 * Output budget per generation call.
 *
 * Sized for THINKING, not for the answer. A placement answer is ~15-35 tokens of JSON and
 * a summary ~120, but these models reason first (section 6 measured ~1,900-2,900 tokens of
 * it), and the reasoning has to fit alongside the prompt in the context window.
 * `think: false` is deliberately NOT sent — trap 1: it does not disable thinking, it
 * RELOCATES the reasoning into `response`, breaking the JSON and increasing tokens.
 */
const NUM_PREDICT = 4096;

/** Trap 3. Ollama fully reloads the model on ANY num_ctx change — bucket coarsely. */
const CTX_BUCKET = 4096;

/** Hard refusal point. A prompt that does not fit is a prompt that lies about its span. */
const CTX_MAX = 32768;

/** Tokens per transcript word — the estimate the rest of this codebase uses. */
const TOKENS_PER_WORD = 1.4;

const CALL_TIMEOUT_MS = 600_000;

/**
 * Trap 4. Above this the KV cache spills off the GPU and every token slows down. It is a
 * PERFORMANCE ceiling, not a correctness one: a run that needs more gets more, and says so
 * in a warning, because a truncated prompt would be a wrong answer while a slow one is
 * only a slow one.
 */
function numCtxGpuCeiling(model: string): number {
  const moe = /(\d+)x(\d+(?:\.\d+)?)b/i.exec(model);
  const dense = /(\d+(?:\.\d+)?)b/i.exec(model);
  const sizeB = moe ? parseInt(moe[1], 10) * parseFloat(moe[2]) : dense ? parseFloat(dense[1]) : null;
  if (sizeB !== null && sizeB <= 15) return 16384;
  return 12288;
}

// =============================================================================
// TYPES
// =============================================================================

export interface ChapterEmbeddingOptions {
  /** Ollama base URL. */
  host: string;
  /** Bare Ollama model name for the two generation stages, as `ollama list` prints it. */
  model: string;
  /**
   * Per-stage model overrides. Section 6 measured a ladder for PLACEMENT specifically —
   * qwen3.5:4b is the recommended floor and runs it ~4x faster than a 27B — so the stage
   * that benefits from a smaller model can have one without moving summarization, which
   * is the stage where model quality visibly shows (section 8).
   */
  stageModels?: Partial<Record<ChapterEmbeddingStage, string>>;
  /** Embedding model override. Defaults to nomic-embed-text. */
  embedModel?: string;
  /** Floor for the context window, never a ceiling. The run sizes its own (trap 3). */
  numCtx?: number;
  /** The video's title or filename — section 8's second required context input. */
  videoTitle?: string;
  /** Consolidation ceiling in seconds. Defaults to 3x the cadence target for the duration. */
  maxChapterSeconds?: number;
  onProgress?: (stage: ChapterEmbeddingStage, done: number, total: number) => void;
  cancelCallback?: () => boolean;
  /**
   * Aborts the request in flight. `cancelCallback` is polled between calls and cannot
   * reach inside one — and it is inside one that a stalled stage spends its minutes.
   */
  abortSignal?: AbortSignal;
}

/** One 45-second span of transcript (3.1). */
export interface Stretch {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  /** Index of the first cue in this stretch, and one past the last. */
  cueStart: number;
  cueEnd: number;
}

/** A candidate boundary: the seam between stretch `index` and `index + 1` (3.2). */
export interface Junction {
  index: number;
  /** Start of the stretch AFTER the seam — the candidate chapter start. */
  time: number;
  /** Block cosine similarity across the seam (low = the subject moved). */
  sim: number;
  /** How deep a valley this is, measured against the nearest higher peak on each side. */
  depth: number;
}

/** One placed boundary, and how honestly it was placed. */
interface PlacedBoundary {
  time: number;
  /** True when `time` is the raw +/-45s junction rather than a mapped quote. */
  approx: boolean;
  /** Why it is approximate, for the user-facing warning. Empty when it is not. */
  approxReason: string;
  /** The quote the model returned, when one mapped. Logged, never published. */
  quote: string;
}

/** One merge consolidation made, so the run can state what it collapsed. */
export interface ConsolidationMerge {
  /** The boundary that was removed. */
  removed: number;
  /** The chapter start it was merged into. */
  into: number;
  similarity: number;
}

interface WorkingChapter {
  startSec: number;
  endSec: number;
  title: string;
  summary: string;
  startApprox: boolean;
  approxReason: string;
}

// =============================================================================
// PURE ALGORITHM — no model, no I/O. Exported so it can be tested standalone,
// exactly as the reference implementation exports it.
// =============================================================================

/**
 * 3.1 — cut the cues into 45-second stretches.
 *
 * The window is aligned to a 45s GRID (`floor(start / 45) * 45`) and a new stretch opens
 * when a cue starts at or past the current window's end, so stretch boundaries do not
 * drift with the transcript. No caption is ever split across two stretches, and each
 * stretch keeps its REAL start — the moment something was actually said — rather than the
 * grid line, because that time is what stage 3 hands forward as a candidate boundary.
 *
 * (This is the handoff document's rule, and it is NOT the same as the sealed pipeline's
 * buildStretches, which walks 45s from wherever the previous stretch ended. Both are
 * defensible; this file follows the method it is porting.)
 */
export function buildStretches(cues: Cue[]): Stretch[] {
  const stretches: Stretch[] = [];
  const texts: string[][] = [];
  let windowEnd = -Infinity;

  cues.forEach((cue, i) => {
    if (stretches.length === 0 || cue.startSec >= windowEnd) {
      windowEnd = Math.floor(cue.startSec / STRETCH_SECONDS) * STRETCH_SECONDS + STRETCH_SECONDS;
      stretches.push({
        index: stretches.length,
        startSec: cue.startSec,
        endSec: cue.endSec,
        text: '',
        cueStart: i,
        cueEnd: i,
      });
      texts.push([]);
    }
    const held = stretches[stretches.length - 1];
    texts[texts.length - 1].push(cue.text.trim());
    held.endSec = cue.endSec;
    held.cueEnd = i + 1;
  });

  stretches.forEach((s, i) => {
    s.text = texts[i].join(' ');
  });
  return stretches;
}

const dot = (a: number[], b: number[]): number => {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += a[i] * b[i];
  return sum;
};

/** Cosine similarity. Returns 0 for a zero vector rather than NaN. */
export function cosineSimilarity(a: number[], b: number[]): number {
  const denom = Math.sqrt(dot(a, a)) * Math.sqrt(dot(b, b));
  return denom === 0 ? 0 : dot(a, b) / denom;
}

/** Element-wise mean of vectors (all assumed the same length). */
export function meanVector(vectors: number[][]): number[] {
  const out = new Array<number>(vectors[0].length).fill(0);
  for (const v of vectors) {
    for (let i = 0; i < v.length; i++) out[i] += v[i];
  }
  return out.map((x) => x / vectors.length);
}

/**
 * 3.2 — score every junction by how deep a valley it is in the cohesion curve.
 *
 * Raw similarity is not usable on its own: a talky passage sits at a uniformly low
 * similarity with no topic change in it, and a monologue that drifts is low everywhere.
 * Depth compares each dip against the nearest HIGHER points on both sides, so what is
 * measured is "how much of a local drop is this" rather than an absolute number. Only
 * true topic changes are VALLEYS.
 */
export function scoreJunctions(stretches: Stretch[], vectors: number[][]): Junction[] {
  const sims: number[] = [];
  for (let i = 0; i + 1 < stretches.length; i++) {
    const left = vectors.slice(Math.max(0, i - BLOCK + 1), i + 1);
    const right = vectors.slice(i + 1, i + 1 + BLOCK);
    sims.push(cosineSimilarity(meanVector(left), meanVector(right)));
  }

  const junctions: Junction[] = [];
  for (let i = 0; i < sims.length; i++) {
    // Walk outward while the curve keeps falling; stop at the first higher point.
    let leftPeak = sims[i];
    for (let j = i - 1; j >= 0 && sims[j] >= leftPeak; j--) leftPeak = sims[j];
    let rightPeak = sims[i];
    for (let j = i + 1; j < sims.length && sims[j] >= rightPeak; j++) rightPeak = sims[j];

    junctions.push({
      index: i,
      time: stretches[i + 1].startSec,
      sim: sims[i],
      depth: leftPeak - sims[i] + (rightPeak - sims[i]),
    });
  }

  return junctions;
}

/**
 * 3.3 — choose boundaries: deepest valley first, each at least `minGap` from every
 * boundary already taken, until `wanted` are held.
 *
 * Greedy-by-strength rather than left-to-right is what makes this robust: the strongest
 * evidence in the video is spent first, so a run of mediocre junctions early on can never
 * crowd out the real change later. Being pure code it also cannot return a prefix and
 * stop — the failure that motivated the whole architecture.
 *
 * The cadence comes from `targetSecondsFor`, IMPORTED from the sealed pipeline rather
 * than copied: there is one cadence policy in this app, and a second copy of those
 * numbers would drift. It deliberately over-segments by one; 3.5 merges the excess.
 */
export function selectJunctions(junctions: Junction[], durationSeconds: number): Junction[] {
  const target = targetSecondsFor(durationSeconds);
  const wanted = Math.max(3, Math.round(durationSeconds / target)) - 1;
  const minGap = 0.6 * target;

  const ranked = [...junctions].sort((a, b) => b.depth - a.depth);
  const chosen: Junction[] = [];
  for (const j of ranked) {
    if (chosen.length >= wanted) break;
    if (chosen.every((c) => Math.abs(c.time - j.time) >= minGap)) chosen.push(j);
  }

  chosen.sort((a, b) => a.time - b.time);
  return chosen;
}

/**
 * Section 5 — the fallback scorer: TF-IDF vectors over the same stretches.
 *
 * A genuinely weaker signal — it sees shared WORDS, not shared meaning, so a subject
 * change phrased in synonyms scores as continuity — but it is the same shape of number,
 * so score/select/consolidate run unchanged and the run still produces chapters with zero
 * model calls. It is NEVER chosen silently: `stats.scorer` records it and a warning names
 * why the embedding call did not run.
 */
export function lexicalVectors(stretches: Stretch[]): number[][] {
  const tokenize = (text: string): string[] =>
    text.toLowerCase().replace(/[^\w\s]/g, ' ').split(/\s+/).filter((w) => w.length > 2);

  const docs = stretches.map((s) => tokenize(s.text));
  const df = new Map<string, number>();
  for (const doc of docs) {
    for (const term of new Set(doc)) df.set(term, (df.get(term) || 0) + 1);
  }

  const vocab = [...df.keys()];
  const index = new Map(vocab.map((t, i) => [t, i]));
  const n = docs.length;

  return docs.map((doc) => {
    const vec = new Array<number>(vocab.length).fill(0);
    for (const term of doc) vec[index.get(term)!] += 1;
    for (let i = 0; i < vec.length; i++) {
      if (vec[i] === 0) continue;
      vec[i] = (vec[i] / doc.length) * Math.log(n / (df.get(vocab[i])! + 1));
    }
    return vec;
  });
}

/**
 * 3.5 — merge adjacent chapters that turned out to be the same subject.
 *
 * Selection takes a fixed count of the deepest valleys, so on a video with fewer real
 * subjects than that it necessarily accepts some shallow ones. Comparing the CENTROID of
 * each finished chapter (not the junction it was cut at) is what catches those: two
 * chapters about the same thing have near-identical centroids however plausible the dip
 * between them looked.
 *
 * Merges apply immediately and the cursor stays put, so a subject split three ways
 * collapses in one sweep. `maxChapterSeconds` always wins — a merge that would produce a
 * chapter longer than the cap is refused.
 *
 * Pure: returns the surviving boundary times and the merges it made, so the caller can
 * report both.
 */
export function consolidateBoundaries(
  boundaries: number[],
  stretches: Stretch[],
  vectors: number[][],
  durationSeconds: number,
  maxChapterSeconds: number
): { times: number[]; merges: ConsolidationMerge[] } {
  const merges: ConsolidationMerge[] = [];
  if (boundaries.length < 2) return { times: [...boundaries], merges };

  // Centroid of the stretches inside each chapter. A chapter shorter than one stretch has
  // no centroid and is never merged (null propagates to similarity 0).
  const centroidFor = (start: number, end: number): number[] | null => {
    const members = vectors.filter((_, i) => stretches[i].startSec >= start && stretches[i].startSec < end);
    return members.length > 0 ? meanVector(members) : null;
  };

  const result = [...boundaries];
  let i = 0;
  while (i + 1 < result.length) {
    const start = result[i];
    const middle = result[i + 1];
    const end = i + 2 < result.length ? result[i + 2] : durationSeconds;

    if (end - start > maxChapterSeconds) {
      i++;
      continue;
    }

    const a = centroidFor(start, middle);
    const b = centroidFor(middle, end);
    const similarity = a && b ? cosineSimilarity(a, b) : 0;

    if (similarity > CONSOLIDATE_SIMILARITY) {
      merges.push({ removed: middle, into: start, similarity });
      result.splice(i + 1, 1);
      continue; // re-test the same chapter against its new neighbour
    }
    i++;
  }

  return { times: result, merges };
}

// =============================================================================
// QUOTE -> TIMESTAMP (3.4) — ported from the reference phrase matcher
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
 * Words that carry no identity. Drive the fuzzy shortlist and the distinctive-word pass.
 * Copied from the reference matcher rather than re-derived.
 */
const COMMON_WORDS = new Set([
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
 * The model NEVER emits a timestamp (3.4) — it quotes, and this is the measurement. Five
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
 * Always called with the cues of the WINDOW the model was shown, never the whole video: a
 * quote matched against a whole transcript can land minutes away on a repeated phrase.
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

  const phraseWords = normalizedPhrase.split(/\s+/).filter((w) => w.length > 3 && !COMMON_WORDS.has(w));
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
        // DEVIATION from the reference matcher, and the only one in this file.
        //
        // It tests `phraseWord.includes(cueWord)` with no length floor on the cue word,
        // so a one-letter caption word matches any quote word containing that letter:
        // measured here, "The submarine fleet departed Reykjavik before dawn" scored 4 of
        // 5 against "we have a lot to get through today" on the strength of the word "a"
        // alone, and resolved to a cue that shares nothing with it. That turns "this quote
        // is not in the window" — which this pipeline is supposed to DECLARE as an
        // approximate start — into a confident wrong measurement, which is precisely the
        // failure this app's cardinal rule forbids. The containment test now needs a
        // substantive word on BOTH sides; exact equality is unaffected.
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
// HELPERS
// =============================================================================

function formatClock(seconds: number): string {
  return TimeUtils.secondsToYoutubeTime(Math.max(0, seconds));
}

/** Last-resort name from a span's opening words. Only after a failed call, always warned about. */
function deriveTitle(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 8).join(' ').replace(/[.,;:]+$/, '');
  return words || 'Untitled';
}

// =============================================================================
// SERVICE
// =============================================================================

export class ChapterEmbeddingService {
  private readonly client: AxiosInstance;
  private readonly options: ChapterEmbeddingOptions;
  private readonly warnings: string[] = [];
  private calls = 0;
  private numCtx = 0;
  private speakerTagged = false;

  constructor(options: ChapterEmbeddingOptions) {
    this.options = options;
    this.client = axios.create({
      baseURL: options.host,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Run stages 1-6 over one video's caption segments.
   *
   * Throws only on the failures that mean every remaining call is affected (Ollama
   * unreachable, model missing, timeout, a span whose arithmetic is wrong). Everything the
   * handoff document calls a graceful degradation comes back as a DECLARED mode: marked on
   * the chapters, counted in `stats`, and named in `warnings`.
   */
  async generate(srtSegments: SRTSegment[]): Promise<ChapterPipelineResult> {
    if (!srtSegments || srtSegments.length === 0) {
      throw new Error('Embedding chaptering needs caption segments; none were supplied');
    }

    const cues = buildCues(srtSegments);
    const durationSeconds = cues[cues.length - 1].endSec;
    const stretches = buildStretches(cues);

    // Speaker tags are all-or-nothing, exactly as the other two paths decide it: a prompt
    // that announces HOST:/CLIP: over a transcript where half the lines have none is a
    // prompt that lies, and the model cannot tell which half.
    const rolesResolved = cues.filter((c) => c.role !== null).length;
    this.speakerTagged = rolesResolved === cues.length;
    if (!this.speakerTagged && rolesResolved > 0) {
      this.warn(
        `only ${rolesResolved} of ${cues.length} caption segments carry a usable speaker attribution, ` +
          `so chapter summaries were written WITHOUT speaker tags (attribution between the host and the ` +
          `footage may be inverted)`
      );
    }

    log.info(
      `[ChapterEmbedding] ${formatClock(durationSeconds)} of captions -> ${cues.length} cues, ` +
        `${stretches.length} stretches of ${STRETCH_SECONDS}s, ` +
        `${this.speakerTagged ? 'speaker-tagged' : 'untagged'}`
    );

    // Section 7 — under two stretches there is no junction to score. One chapter, zero
    // calls, and the reason is stated rather than left to look like a model result.
    if (stretches.length < MIN_STRETCHES_TO_SCORE) {
      return this.singleChapterResult(cues, durationSeconds, stretches.length);
    }

    try {
      // ---- stages 1-2: stretch and score ---------------------------------------
      const scoreStart = Date.now();
      this.options.onProgress?.('embed', 0, 1);
      const embedded = await this.embedStretches(stretches);
      const scorer: 'embedding' | 'lexical' = embedded ? 'embedding' : 'lexical';
      const vectors = embedded || lexicalVectors(stretches);
      this.options.onProgress?.('embed', 1, 1);

      const junctions = scoreJunctions(stretches, vectors);
      const chosen = selectJunctions(junctions, durationSeconds);

      log.info(
        `[ChapterEmbedding] ${scorer} scorer: ${stretches.length} stretches, ${junctions.length} junctions, ` +
          `${chosen.length} selected in ${((Date.now() - scoreStart) / 1000).toFixed(1)}s ` +
          `(duration ${formatClock(durationSeconds)}, target ${targetSecondsFor(durationSeconds)}s/chapter, ` +
          `deepest junction ${Math.max(...junctions.map((j) => j.depth)).toFixed(3)})`
      );
      for (const c of chosen) {
        log.info(
          `[ChapterEmbedding] candidate ${formatClock(c.time)} depth=${c.depth.toFixed(3)} sim=${c.sim.toFixed(3)}`
        );
      }

      const maxChapterSeconds =
        this.options.maxChapterSeconds || MAX_CHAPTER_TARGET_MULTIPLE * targetSecondsFor(durationSeconds);

      // ONE num_ctx for the whole run (trap 3), sized from the largest prompt EITHER stage
      // can send, so no call is ever clamped and Ollama never reloads mid-run.
      this.numCtx = this.runNumCtx(cues, stretches, chosen, durationSeconds, maxChapterSeconds);

      // ---- stage 4: place ------------------------------------------------------
      const placed = await this.placeBoundaries(chosen, stretches, cues);

      // ---- stage 5: consolidate ------------------------------------------------
      const boundaryTimes = [0, ...placed.map((p) => p.time)];
      const { times, merges } = consolidateBoundaries(
        boundaryTimes,
        stretches,
        vectors,
        durationSeconds,
        maxChapterSeconds
      );
      for (const merge of merges) {
        log.info(
          `[ChapterEmbedding] Merging the chapter at ${formatClock(merge.removed)} into ${formatClock(merge.into)} ` +
            `(centroid similarity ${merge.similarity.toFixed(3)} > ${CONSOLIDATE_SIMILARITY})`
        );
      }

      // Every surviving boundary keeps whatever honesty it was placed with. 0:00 was never
      // placed by a model and is never approximate.
      const survivors: PlacedBoundary[] = times.map((time) => {
        const match = placed.find((p) => p.time === time);
        return match || { time, approx: false, approxReason: '', quote: '' };
      });

      // ---- stage 6: summarize --------------------------------------------------
      const working = await this.summarizeChapters(survivors, durationSeconds, cues);

      const chapters = this.toChapters(working, durationSeconds);
      this.warnApproximateStarts(working);

      log.info(
        `[ChapterEmbedding] ${chapters.length} chapters in ${this.calls} model calls: ` +
          chapters.map((c) => `${c.timestamp} ${c.title}`).join(' | ')
      );

      return {
        chapters,
        subjects: chapters.map((c) => c.title),
        subjectDetails: working.map((c) => ({ about: c.title, detail: c.summary })),
        warnings: [...this.warnings],
        stats: {
          durationSeconds,
          stretches: stretches.length,
          junctions: junctions.length,
          boundariesSelected: chosen.length,
          chaptersBeforeConsolidation: boundaryTimes.length,
          chaptersAfterConsolidation: times.length,
          // Zero because this path HAS no label or rate stage, not because they failed:
          // stage 2 is one embedding call and stage 3 is pure code.
          labelFailures: 0,
          ratingFailures: 0,
          approxStarts: working.filter((c) => c.startApprox).length,
          speakerTagged: this.speakerTagged,
          calls: this.calls,
          scorer,
        },
      };
    } finally {
      await this.unloadModels();
    }
  }

  // ------------------------------------------------------------------ short videos

  /**
   * Section 7 — the under-two-stretches answer: one chapter, zero model calls.
   *
   * Named from its own opening words because naming it properly would be a model call and
   * this path is defined as making none. The caller drops any list under three chapters
   * and records `chaptersSkipped`, so this reaches the user as "too short to chapter"
   * either way — but it says so here rather than looking like a model result.
   */
  private singleChapterResult(cues: Cue[], durationSeconds: number, stretchCount: number): ChapterPipelineResult {
    const text = cues.map((c) => c.text).join(' ');
    const title = deriveTitle(text);
    this.warn(
      `the transcript is only ${formatClock(durationSeconds)} long (${stretchCount} stretch(es) of ` +
        `${STRETCH_SECONDS}s), which is too short to score a single junction, so it was returned as ONE ` +
        `chapter named from its own opening words ("${title}") with no model calls`
    );

    return {
      chapters: [
        {
          timestamp: TimeUtils.secondsToYoutubeTime(0),
          title,
          sequence: 0,
          endTimestamp: TimeUtils.secondsToYoutubeTime(durationSeconds),
          detail: '',
        },
      ],
      subjects: [title],
      subjectDetails: [{ about: title, detail: '' }],
      warnings: [...this.warnings],
      stats: {
        durationSeconds,
        stretches: stretchCount,
        junctions: 0,
        boundariesSelected: 0,
        chaptersBeforeConsolidation: 1,
        chaptersAfterConsolidation: 1,
        labelFailures: 0,
        ratingFailures: 0,
        approxStarts: 0,
        speakerTagged: this.speakerTagged,
        calls: 0,
        // Neither scorer ran. 'lexical' would claim a measurement that was never made.
        scorer: 'none',
      },
    };
  }

  // ---------------------------------------------------------------------- stage 2

  /**
   * 3.2 — embed every stretch in ONE batched /api/embed call.
   *
   * Returns null (rather than throwing) on any failure, which is what selects the lexical
   * scorer — but never quietly: the caller records `stats.scorer` and this method pushes a
   * warning naming the failure and the remedy. Embeddings are a quality optimization, not
   * a dependency.
   *
   * A CANCELLED run is not a failed embed and does not degrade: it rethrows.
   */
  private async embedStretches(stretches: Stretch[]): Promise<number[][] | null> {
    this.checkCancelled();
    const model = this.options.embedModel || EMBED_MODEL;
    const started = Date.now();

    try {
      const response = await this.client.post(
        '/api/embed',
        { model, input: stretches.map((s) => s.text), keep_alive: KEEP_ALIVE },
        { timeout: EMBED_TIMEOUT_MS, signal: this.options.abortSignal }
      );

      const embeddings = response.data?.embeddings;
      if (
        !Array.isArray(embeddings) ||
        embeddings.length !== stretches.length ||
        !embeddings.every((v: unknown) => Array.isArray(v) && v.length > 0)
      ) {
        throw new Error(
          `Ollama /api/embed returned ${Array.isArray(embeddings) ? embeddings.length : 'no'} usable ` +
            `vectors for ${stretches.length} stretches`
        );
      }

      log.info(
        `[ChapterEmbedding] Embedded ${embeddings.length} stretches with ${model} in ` +
          `${((Date.now() - started) / 1000).toFixed(1)}s`
      );
      return embeddings as number[][];
    } catch (error: any) {
      if (isAbortError(error) || this.options.abortSignal?.aborted) {
        throw new Error('Embedding chaptering was cancelled by the user during the embedding call');
      }
      const status = error?.response?.status;
      const detail = error?.response?.data?.error || error?.message || 'unknown error';
      const because =
        status === 404
          ? `the embedding model "${model}" is not installed — pull it with: ollama pull ${model}`
          : detail;

      this.warn(
        `the embedding scorer did not run (${because}), so boundaries were scored by the LEXICAL ` +
          `fallback instead: it matches shared WORDS rather than shared meaning, so a subject change ` +
          `phrased in synonyms reads as continuity, and chapter consolidation (which is calibrated for ` +
          `embedding cosines) will effectively never merge — expect weaker boundaries and more chapters`
      );
      return null;
    }
  }

  // ---------------------------------------------------------------------- stage 4

  /**
   * 3.4 — resolve each selected junction to a sentence, one small call each.
   *
   * Every call asks ONE local question about ~90 seconds of text and never sees the rest
   * of the video: there is no list to truncate and no global judgment to get wrong.
   *
   * A call whose ANSWER is unusable — truncated by the output ceiling, unparseable, no
   * quote, a quote that maps nowhere, or a quote that maps BACKWARDS — keeps the raw
   * junction time. That floor is 45s-accurate, so it is a degradation and not an error;
   * it is counted in `stats.approxStarts`, marked on the chapter, and named in a warning.
   * A TRANSPORT failure is not degraded: it means every remaining call is affected.
   */
  private async placeBoundaries(chosen: Junction[], stretches: Stretch[], cues: Cue[]): Promise<PlacedBoundary[]> {
    const placed: PlacedBoundary[] = [];

    for (let i = 0; i < chosen.length; i++) {
      const junction = chosen[i];
      const before = stretches[junction.index];
      const after = stretches[junction.index + 1];
      const previous = placed.length > 0 ? placed[placed.length - 1].time : 0;
      let time: number | null = null;
      let quote = '';
      let reason = '';

      const parsed = await this.askJson(
        'place',
        formatPrompt(CHAPTER_EMBEDDING_PROMPTS.PLACE_BOUNDARY, {
          title_context: this.options.videoTitle ? `Video: ${this.options.videoTitle}\n` : '',
          window: `${before.text} ${after.text}`,
        }),
        `the boundary at ${formatClock(junction.time)}`
      );

      if (!parsed) {
        reason = 'the placement call returned no usable JSON';
      } else {
        quote = typeof parsed.quote === 'string' ? parsed.quote.trim() : '';
        if (!quote) {
          reason = 'the placement answer contained no "quote"';
        } else {
          // Searched ONLY in the window the model was shown (3.4).
          const windowCues = cues.slice(before.cueStart, after.cueEnd);
          const mapped = findQuoteTime(quote, windowCues);
          if (mapped === null) {
            reason = `its quote "${quote.slice(0, 60)}" could not be found in the ${STRETCH_SECONDS * 2}s window`;
          } else if (mapped <= previous) {
            reason =
              `its quote resolved to ${formatClock(mapped)}, which does not follow the previous chapter ` +
              `start at ${formatClock(previous)} — the quote matched the wrong sentence`;
          } else {
            time = mapped;
            log.info(
              `[ChapterEmbedding] Placed ${formatClock(junction.time)} -> ${formatClock(mapped)}: "${quote.slice(0, 60)}"`
            );
          }
        }
      }

      if (time === null) {
        if (junction.time > previous) {
          this.warn(
            `the chapter boundary near ${formatClock(junction.time)} could not be placed to the sentence ` +
              `(${reason}), so it kept its raw junction time and is accurate only to +/-${STRETCH_SECONDS}s`
          );
          placed.push({ time: junction.time, approx: true, approxReason: reason, quote });
        } else {
          // The reference implementation drops this boundary with no record. A lost
          // chapter is invisible in the output, so it is stated here instead.
          this.warn(
            `the chapter boundary near ${formatClock(junction.time)} was DROPPED: it could not be placed ` +
              `(${reason}) and its raw junction time does not advance past the previous chapter start at ` +
              `${formatClock(previous)}, so this video has one chapter fewer than the method selected`
          );
        }
      } else {
        placed.push({ time, approx: false, approxReason: '', quote });
      }

      this.options.onProgress?.('place', i + 1, chosen.length);
    }

    return placed;
  }

  // ---------------------------------------------------------------------- stage 6

  /**
   * Section 8 — name and summarize each chapter from its RAW transcript.
   *
   * The law this stage exists to obey: the summarizing model reads WHAT WAS SAID in the
   * chapter, never an intermediate label. The original method summarized chapters from its
   * own 3-6 word stretch labels — a summary of summaries — and produced "man yells about
   * conspiracies" for content a 27B reading the transcript named precisely. It also gets
   * the two other inputs section 8 requires: the video's title/filename, and the PREVIOUS
   * chapter's summary threaded, so chapter N knows what "back to what we discussed" refers
   * to and titles do not repeat.
   *
   * O(chapters) calls, not O(duration) — which is why it is the stage that gets the big
   * model.
   */
  private async summarizeChapters(
    starts: PlacedBoundary[],
    durationSeconds: number,
    cues: Cue[]
  ): Promise<WorkingChapter[]> {
    const chapters: WorkingChapter[] = [];
    let previousSummary = '';

    for (let i = 0; i < starts.length; i++) {
      const startSec = starts[i].time;
      const endSec = i < starts.length - 1 ? starts[i + 1].time : durationSeconds;
      const raw = this.transcriptBetween(cues, startSec, endSec, false);

      if (raw.trim().length === 0) {
        // The boundaries came from cue times, so an empty span means the arithmetic is
        // wrong. Naming a chapter that has no words would be inventing one.
        throw new Error(
          `Embedding chaptering produced the empty chapter span ${formatClock(startSec)}-${formatClock(endSec)}`
        );
      }

      const body = this.speakerTagged ? this.transcriptBetween(cues, startSec, endSec, true) : raw;
      const parsed = await this.askJson(
        'summarize',
        formatPrompt(
          this.speakerTagged
            ? CHAPTER_EMBEDDING_PROMPTS.SUMMARIZE_CHAPTER_TAGGED
            : CHAPTER_EMBEDDING_PROMPTS.SUMMARIZE_CHAPTER,
          {
            number: i + 1,
            video: this.options.videoTitle || 'untitled',
            previous_context: previousSummary ? `Previous chapter: "${previousSummary}"\n` : '',
            // Substituted last, as everywhere else in this codebase: transcript text that
            // happens to contain a brace token must not be rewritten by a later pass.
            transcript: body,
          }
        ),
        `chapter ${i + 1}/${starts.length} (${formatClock(startSec)}-${formatClock(endSec)})`
      );

      let title = ChapterEmbeddingService.readString(parsed?.title);
      let summary = ChapterEmbeddingService.readString(parsed?.summary);

      if (!title) {
        // Named from its own opening words instead of by the model. The chapter still
        // exists at the right second, but its NAME is now a transcript fragment — and that
        // name is what the title, description and tag stages condition on, so the user is
        // told rather than left to notice.
        title = deriveTitle(raw);
        this.warn(
          `the chapter at ${formatClock(startSec)} could not be named by the model, so it is titled from ` +
            `its own opening words ("${title}") and carries no description detail`
        );
        summary = '';
      }

      chapters.push({
        startSec,
        endSec,
        title,
        summary,
        startApprox: starts[i].approx,
        approxReason: starts[i].approxReason,
      });
      previousSummary = summary || title;
      this.options.onProgress?.('summarize', chapters.length, starts.length);
    }

    return chapters;
  }

  // ------------------------------------------------------------------ transcript prep

  /** Raw transcript text between two times — section 8's first required input. */
  private transcriptBetween(cues: Cue[], startSec: number, endSec: number, tagged: boolean): string {
    const inside = cues.filter((c) => c.startSec >= startSec && c.startSec < endSec);
    return tagged
      ? inside.map((c) => `${c.role === 'host' ? 'HOST:' : 'CLIP:'} ${c.text}`).join('\n')
      : inside.map((c) => c.text).join(' ');
  }

  /**
   * ONE num_ctx for the whole run (trap 3: Ollama fully reloads the model on any change),
   * sized from the LARGEST prompt either generation stage can send so that no call is ever
   * clamped.
   *
   * The placement side is exact — those windows are known now. The summarize side is an
   * upper bound: the densest stretch of transcript that could end up inside one chapter,
   * which is the longer of the widest gap between selected boundaries (plus the +/-45s
   * placement can move each end) and the consolidation cap, since no merge may exceed it.
   *
   * Exceeding the GPU ceiling costs speed and is declared; exceeding CTX_MAX refuses,
   * because a truncated prompt summarizes a chapter's opening and calls it the chapter.
   */
  private runNumCtx(
    cues: Cue[],
    stretches: Stretch[],
    chosen: Junction[],
    durationSeconds: number,
    maxChapterSeconds: number
  ): number {
    const placePromptChars = chosen.reduce((max, j) => {
      const window = `${stretches[j.index].text} ${stretches[j.index + 1].text}`;
      return Math.max(max, window.length);
    }, 0);
    // ~4 chars a token for prompt prose, plus the instruction body.
    const placeTokens = Math.ceil(placePromptChars / 4) + 600;

    const starts = [0, ...chosen.map((j) => j.time), durationSeconds];
    let widestGap = 0;
    for (let i = 1; i < starts.length; i++) widestGap = Math.max(widestGap, starts[i] - starts[i - 1]);
    const widestChapter = Math.max(maxChapterSeconds, widestGap + 2 * STRETCH_SECONDS);
    const summarizeTokens = Math.ceil(this.maxWordsInWindow(cues, widestChapter) * TOKENS_PER_WORD) + 700;

    const needed = Math.max(placeTokens, summarizeTokens) + NUM_PREDICT + 512;
    const bucketed = Math.max(CTX_BUCKET, Math.ceil(needed / CTX_BUCKET) * CTX_BUCKET);
    const wanted = Math.max(bucketed, this.options.numCtx || 0);

    if (wanted > CTX_MAX) {
      throw new Error(
        `Embedding chaptering needs a context window of about ${wanted} tokens for this video's longest ` +
          `chapter, which is beyond the ${CTX_MAX}-token ceiling. Refusing rather than summarizing a ` +
          `truncated chapter.`
      );
    }

    const ceiling = numCtxGpuCeiling(this.modelFor('summarize'));
    if (wanted > ceiling) {
      this.warn(
        `this video's longest chapter needs a ${wanted}-token context window, above the ${ceiling}-token ` +
          `size at which this model's KV cache still fits on the GPU — the run will be correct but slower ` +
          `(one spilled layer bottlenecks every token)`
      );
    }

    log.info(
      `[ChapterEmbedding] num_ctx ${wanted} for the whole run ` +
        `(placement needs ~${placeTokens}, the longest chapter ~${summarizeTokens}, output budget ${NUM_PREDICT})`
    );
    return wanted;
  }

  /** The most words any window of `windowSeconds` contains — the densest possible chapter. */
  private maxWordsInWindow(cues: Cue[], windowSeconds: number): number {
    const counts = cues.map((c) => normalizeWords(c.text).length);
    let best = 0;
    let running = 0;
    let left = 0;
    for (let right = 0; right < cues.length; right++) {
      running += counts[right];
      while (left < right && cues[right].startSec - cues[left].startSec > windowSeconds) {
        running -= counts[left];
        left++;
      }
      if (running > best) best = running;
    }
    return best;
  }

  // -------------------------------------------------------------------- model calls

  private modelFor(stage: ChapterEmbeddingStage): string {
    return this.options.stageModels?.[stage] || this.options.model;
  }

  private checkCancelled(): void {
    if (this.options.abortSignal?.aborted || this.options.cancelCallback?.()) {
      throw new Error('Chapter generation cancelled by user');
    }
  }

  private warn(message: string): void {
    log.warn(`[ChapterEmbedding] ${message}`);
    this.warnings.push(message);
  }

  private static readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * One generation call, or null when its ANSWER was unusable.
   *
   * /api/generate, not /api/chat: these models reason by default, and on /api/chat that
   * reasoning lands in `message.thinking` with `message.content` empty. /api/generate
   * returns `response` and `thinking` as separate fields.
   *
   * The section 6 traps, all three of them, live here:
   *  - `think` is NOT sent. `think: false` does not disable thinking, it relocates the
   *    reasoning into `response` and breaks the JSON.
   *  - with `format: "json"` the grammar constrains the WHOLE stream, so a thinking model
   *    sometimes puts the object in `thinking` and leaves `response` empty. Read from
   *    `thinking` in exactly that case and nowhere else.
   *  - one num_ctx for the run, and `keep_alive` long enough to span the gap between calls
   *    so the model stays resident.
   *
   * `done_reason: "length"` is a HARD failure for the call: the text is a truncated
   * fragment, and half a quote maps to the wrong second. Transport failures throw.
   */
  private async askJson(stage: ChapterEmbeddingStage, prompt: string, what: string): Promise<any | null> {
    this.checkCancelled();
    const model = this.modelFor(stage);
    this.calls++;

    let data: any;
    try {
      const response = await this.client.post(
        '/api/generate',
        {
          model,
          prompt,
          stream: false,
          format: 'json',
          keep_alive: KEEP_ALIVE,
          options: {
            temperature: 0,
            seed: 0,
            num_ctx: this.numCtx,
            num_predict: NUM_PREDICT,
          },
        },
        { timeout: CALL_TIMEOUT_MS, signal: this.options.abortSignal }
      );
      data = response.data;
    } catch (error: any) {
      if (isAbortError(error)) {
        throw new Error(`Embedding chaptering was cancelled by the user during ${what} (model ${model})`);
      }
      const status = error?.response?.status;
      const detail = error?.response?.data?.error || error?.message || 'unknown error';
      if (status === 404) {
        throw new Error(
          `Embedding chaptering needs Ollama model "${model}", which is not installed. ` +
            `Pull it with: ollama pull ${model}`
        );
      }
      if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
        throw new Error(
          `Embedding chaptering timed out after ${CALL_TIMEOUT_MS / 1000}s on ${what} (model ${model})`
        );
      }
      throw new Error(`Embedding chaptering failed on ${what} (model ${model}): ${detail}`);
    }

    if (data?.done_reason === 'length') {
      log.warn(
        `[ChapterEmbedding] stage "${stage}" hit the ${NUM_PREDICT}-token output ceiling on ${what}, ` +
          `so its answer is a truncated fragment and is discarded`
      );
      return null;
    }

    const answer = ChapterEmbeddingService.readAnswer(data, stage, what);
    if (!answer) return null;

    const match = answer.match(/\{[\s\S]*\}/);
    if (!match) {
      log.warn(`[ChapterEmbedding] stage "${stage}" returned no JSON object on ${what}: ${answer.slice(0, 200)}`);
      return null;
    }
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      log.warn(`[ChapterEmbedding] stage "${stage}" returned unparseable JSON on ${what}: ${match[0].slice(0, 200)}`);
      return null;
    }
  }

  /**
   * The answer text — trap 2, handled narrowly.
   *
   * Structured output was requested, so when `response` comes back EMPTY and `thinking`
   * does not, the JSON grammar constrained the reasoning channel and the object is in
   * there. Read it, and say so, rather than counting a perfectly good answer as a failure.
   */
  private static readAnswer(data: any, stage: ChapterEmbeddingStage, what: string): string {
    const response = typeof data?.response === 'string' ? data.response : '';
    if (response.trim().length > 0) return response;

    const thinking = typeof data?.thinking === 'string' ? data.thinking : '';
    if (thinking.trim().length > 0) {
      log.info(
        `[ChapterEmbedding] stage "${stage}" answered ${what} in the "thinking" field with "response" empty ` +
          `(the format:json grammar constrained the whole stream) — reading the object from there`
      );
      return thinking;
    }

    log.warn(`[ChapterEmbedding] stage "${stage}" returned an empty response on ${what}`);
    return '';
  }

  /**
   * Release the resident models. Housekeeping — a failure costs VRAM until Ollama's own
   * timer fires, so it warns rather than failing a finished run.
   */
  private async unloadModels(): Promise<void> {
    const models = new Set<string>([this.options.model, ...Object.values(this.options.stageModels || {})]);
    for (const model of models) {
      if (!model) continue;
      try {
        await this.client.post('/api/generate', { model, prompt: '', keep_alive: 0 }, { timeout: 30_000 });
      } catch (error: any) {
        log.warn(`[ChapterEmbedding] Could not unload "${model}": ${error?.message || error}`);
      }
    }
  }

  // ---------------------------------------------------------------------- assembling

  /**
   * The finished chapters. The first is published at 0:00 — YouTube requires a 0:00 marker
   * and 0:00 is never a model output on any of this app's chapter paths.
   */
  private toChapters(working: WorkingChapter[], durationSeconds: number): Chapter[] {
    return working.map((chapter, index) => ({
      timestamp: TimeUtils.secondsToYoutubeTime(index === 0 ? 0 : chapter.startSec),
      title: chapter.title,
      sequence: index,
      endTimestamp: TimeUtils.secondsToYoutubeTime(
        index < working.length - 1 ? working[index + 1].startSec : durationSeconds
      ),
      detail: chapter.summary,
      ...(chapter.startApprox ? { startApprox: true } : {}),
    }));
  }

  /**
   * One warning per start that came from a raw junction, written AFTER naming because a
   * warning a user can act on has to say WHICH chapter — and a chapter has no name until
   * stage 6 has run. (The placement stage already warned about the failure itself; this is
   * the same fact attached to the chapter the user will see.)
   */
  private warnApproximateStarts(working: WorkingChapter[]): void {
    for (const chapter of working) {
      if (!chapter.startApprox) continue;
      this.warnings.push(
        `chapter "${chapter.title}" starts at ${formatClock(chapter.startSec)}, which is approximate ` +
          `(+/-${STRETCH_SECONDS}s): ${chapter.approxReason || 'its quote could not be mapped'}`
      );
    }
  }
}
