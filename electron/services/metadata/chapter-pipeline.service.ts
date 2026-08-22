/**
 * Chapter Pipeline Service — the sealed 14B chaptering method
 *
 * Implements CHAPTERING.md (sealed 2026-08-02): label -> rate -> select -> place ->
 * summarize -> consolidate. Chapters are the FIRST stage of metadata generation; the
 * resulting subject list is what the title, description and tag stages condition on.
 *
 * THE ONE LAW: a 14B cannot select K items from a list of N. Ask it which 12 of 70
 * candidate boundaries are real and it returns a prefix and stops. So no model call
 * here ever sees a list, a count, or the whole video. Every call asks ONE local
 * question about ONE thing, and this file does all the counting, ranking, spacing and
 * assembling. Five architectures died before that was isolated — if you find yourself
 * adding a prompt that shows the model more than one boundary at a time, stop.
 *
 * The model never emits a timestamp either. It quotes a verbatim sentence and
 * mapQuote() measures where that sentence falls in the caption word stream.
 *
 * Everything runs at temperature 0 with format:json. Single-video results at temp > 0
 * are not measurements — the same config scored 0.50 then 0.00 on consecutive runs.
 *
 * 2026-08-16 — variant B. Ported from the sibling AutoCutStudio implementation
 * (electron/services/chapter-splitter.ts + docs/chaptering-method.md), which ran the
 * same method against more videos and evolved four things:
 *
 * - FAILURE POLICY. This file used to throw a 25-minute run away over one bad JSON
 *   object or one unmappable quote. Now a single call may fail (one retry, then null)
 *   and the stage recovers — but never silently. Degradation is either an aggregate
 *   THROW naming what failed (>50% of labels or ratings), or it is marked on the
 *   output (`startApprox`) AND stated in `warnings`, which resolveChapters surfaces to
 *   the user. Nothing here swallows a failure into a plausible-looking chapter list.
 * - PLACEMENT FALLBACK CHAIN. Mapped placement quote -> the stretch's own stage-1
 *   opening quote -> the raw ±45s junction, flagged.
 * - SPEAKER TAGS AND `detail` IN STAGE 4. See stageSummarize.
 * - The pre-consolidation chapter tier is RETAINED on each merged chapter instead of
 *   being spliced away, and consolidation itself is now optional.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { SRTSegment } from './whisper.service';
import { Chapter, SubChapter, TimeUtils } from './chapter-generator.service';
import { CHAPTER_PROMPTS } from './chapter-prompts';
import { formatPrompt } from './system-prompts';
import { isAbortError } from './cancellation';

export type ChapterStage = 'label' | 'rate' | 'place' | 'summarize' | 'consolidate';

export interface ChapterPipelineOptions {
  /** Ollama base URL. */
  host: string;
  /** Model used for every stage that has no override. No provider prefix. */
  model: string;
  /**
   * Per-stage model overrides.
   *
   * CHAPTERING.md validates qwen2.5:14b as the RATER (healthy 0-3 spread) and notes
   * cogito:14b rates with almost no variance on some corpora while being fine for the
   * label stage — "when in doubt, run qwen2.5:14b for stages 2, 4 and 5". This hook is
   * how you act on that without a code change; it is deliberately not defaulted, so
   * the configured model is the model that runs.
   */
  stageModels?: Partial<Record<ChapterStage, string>>;
  /**
   * Context window. One value for the WHOLE run on purpose: Ollama reloads the model
   * whenever num_ctx changes, and a run makes hundreds of calls. 16384 is the floor
   * for summarizing a ~18-minute consolidated chapter. Stage 4 may raise it for a
   * single oversized chapter (bucketed — see chapterNumCtx), never lower it.
   */
  numCtx?: number;
  /**
   * Run stage 5 (consolidation). Default true.
   *
   * Set FALSE when the span handed in is already known to be ONE unit — a story the
   * user has defined and curated. Consolidation exists to decide where one story ends
   * and the next begins; inside a declared story there is no such seam to find, so
   * every merge it makes is a false positive that flattens two real chapters into one.
   * Skipping it returns the stage-4 tier directly, which IS the chapter layer.
   *
   * A correctness switch, not an optimisation — the saving is about one call per
   * chapter, but a wrong merge silently costs the user a chapter marker.
   */
  consolidate?: boolean;
  onProgress?: (stage: ChapterStage, done: number, total: number) => void;
  cancelCallback?: () => boolean;
  /**
   * Fired when the run is cancelled, so the call currently in flight is aborted instead
   * of running to completion. `cancelCallback` is polled between calls and cannot reach
   * inside one — and it is inside one that a stalled stage spends its minutes.
   */
  abortSignal?: AbortSignal;
}

/** One chapter's subject as stage 4 wrote it: the marker, and the prose behind it. */
export interface ChapterSubject {
  /** The 4-8 word chapter name. */
  about: string;
  /** 20-45 words of description-grade prose. Empty when stage 4 could not name it. */
  detail: string;
}

export interface ChapterPipelineResult {
  chapters: Chapter[];
  /** Chapter subjects in order, timestamps stripped — the input to every downstream field. */
  subjects: string[];
  /**
   * The same subjects with their `detail` prose alongside, in the same order.
   * `subjects` stays a plain string list because that is what the sealed method hands
   * the title stage; this is the richer conditioning input for description and tags.
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
    /** Stretches whose label call failed and fell back to their own opening words. */
    labelFailures: number;
    /** Junctions with no usable rating — excluded from selection entirely. */
    ratingFailures: number;
    /** Final chapters whose start is a raw ±45s junction rather than a mapped quote. */
    approxStarts: number;
    /** Stage 4 ran with HOST:/CLIP: speaker tags. */
    speakerTagged: boolean;
    calls: number;
  };
}

/** Stage 1 cuts the transcript into stretches this long; also the accuracy of a raw junction. */
const STRETCH_SECONDS = 45;
/** YouTube refuses a chapter list with fewer than 3 entries; also the over-collapse floor. */
export const MIN_CHAPTERS = 3;
const DEFAULT_NUM_CTX = 16384;
/** Post-placement dedupe: boundaries closer together than this collide. */
const MIN_BOUNDARY_GAP = 5;
/** Outputs are one-line JSON objects; 512 is far more than any stage needs, detail field included. */
const NUM_PREDICT = 512;
const CALL_TIMEOUT_MS = 600_000;
/** Long enough to span the gap between consecutive calls, so the model stays resident. */
const KEEP_ALIVE = '10m';
/** Ollama reloads the model whenever num_ctx changes — quantize so it reloads rarely. */
const CTX_BUCKET = 4096;
/** Stage 4 refuses above this rather than summarize a truncated chapter. */
const CHAPTER_CTX_MAX = 32768;
/** Exact-match probe length for quote -> timestamp mapping. */
const QUOTE_PROBE_WORDS = 12;
/** Best fractional match below this is not a measurement — it is a coincidence. */
const QUOTE_MATCH_THRESHOLD = 0.5;

/**
 * Cadence measured across 3,000+ published chapters. Drives both the target chapter
 * count and the minimum spacing between selected boundaries.
 *
 * EXPORTED because the 27B single-call path (chapter-single-call.service.ts) derives its
 * chapter-count budget and its minimum gap from this same table. There is one cadence
 * policy in this app and this is it — a second copy of these numbers would drift.
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

function formatDuration(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const mins = Math.floor(total / 60);
  const secs = total % 60;
  if (mins === 0) return `${secs}s`;
  return `${mins}m ${secs}s`;
}

/** Last-resort name from a span's opening words. Only ever used after a failed call, always warned about. */
function deriveLabel(text: string): string {
  const words = text.trim().split(/\s+/).slice(0, 8).join(' ').replace(/[.,;:]+$/, '');
  return words || 'Untitled';
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

/** A 45-second stretch of cues — the unit stage 1 labels and stage 2 rates across. */
interface Stretch {
  index: number;
  startSec: number;
  endSec: number;
  text: string;
  wordStart: number;
  wordEnd: number; // exclusive
}

/**
 * The flattened caption word stream.
 *
 * Mapping MUST run against this, not against individual cues: auto-caption cues are
 * ~7-word wrapped fragments, so a quoted sentence straddles cues and per-cue matching
 * fails outright.
 */
export interface WordStream {
  words: string[];
  /** times[i] is the start time of the cue word i came from. */
  times: number[];
}

/**
 * Cues, with auto-caption rolling-window repeats removed.
 *
 * Auto-captions repeat the previous line as they scroll. The dedupe rule is the one
 * from the sealed method: drop a line that equals the previous line, or that the
 * previous line ends with.
 *
 * Module-level and EXPORTED (it was a private method until 2026-08-21) because the
 * single-call path has to read the transcript through exactly the same de-duplication
 * and the same word cursor. Two transcript readers would mean two word streams, and a
 * quote measured against the wrong one points at the wrong moment.
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

export function buildWordStream(cues: Cue[]): WordStream {
  const words: string[] = [];
  const times: number[] = [];
  for (const cue of cues) {
    for (const word of normalizeWords(cue.text)) {
      words.push(word);
      times.push(cue.startSec);
    }
  }
  return { words, times };
}

interface StretchLabel {
  about: string;
  startsHere: boolean;
  /**
   * The stage-1 quote for where this stretch's subject begins.
   *
   * RETAINED as of 2026-08-16, where it used to be parsed and then deliberately
   * ignored. It is the middle link of stage 3b's fallback chain: when the placement
   * call's own quote cannot be mapped, this one usually can, and it is still a MAPPED
   * QUOTE — same ~5s accuracy, not a degradation. Only when both miss does a boundary
   * drop to the raw ±45s junction.
   */
  openingPhrase: string;
}

/** One rated seam between consecutive stretches. */
interface Junction {
  index: number; // sits between stretches[index] and stretches[index + 1]
  timeSeconds: number; // = stretches[index + 1].startSec
  change: number; // 0-3, clamped
  /** False when the rating call produced nothing usable — never selectable. */
  rated: boolean;
}

/** One placed boundary, and how honestly it was placed. */
interface PlacedBoundary {
  time: number;
  /** True when `time` is the raw ±45s junction rather than a mapped quote. */
  approx: boolean;
  /** Why it is approximate, for the user-facing warning. Empty when it is not. */
  approxReason: string;
}

interface WorkingChapter {
  startSec: number;
  endSec: number;
  about: string;
  detail: string;
  /** Set when stage 5 merged this span, so it gets re-summarized from its full transcript. */
  merged: boolean;
  startApprox: boolean;
  approxReason: string;
  /**
   * The pre-consolidation chapters this span covers, in time order. Seeded with itself
   * the moment stage 4 names it, and it absorbs the other side's members on every
   * merge — so the fine tier survives the sweep instead of being spliced away with the
   * chapter object.
   */
  members: Array<{ startSec: number; about: string; startApprox: boolean; approxReason: string }>;
}

export class ChapterPipelineService {
  private readonly client: AxiosInstance;
  private readonly options: ChapterPipelineOptions;
  private readonly numCtx: number;
  private readonly warnings: string[] = [];
  private calls = 0;
  /** Stretches whose label call produced nothing usable (they fell back to their opening words). */
  private labelFailures = 0;
  /** Stage 4 renders speaker-tagged transcript. Decided by the input, logged, never guessed. */
  private speakerTagged = false;

  constructor(options: ChapterPipelineOptions) {
    this.options = options;
    this.numCtx = options.numCtx || DEFAULT_NUM_CTX;
    this.client = axios.create({
      baseURL: options.host,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Run the full pipeline over one video's caption segments.
   *
   * Throws when the run cannot produce a chapter list worth having — a wedged Ollama,
   * a missing model, a rater that failed on most junctions. Everything short of that
   * comes back with the degradation marked on the chapters and stated in `warnings`:
   * a chapter list that quietly lost a boundary is unfixable by hand, and it is also
   * the conditioning input for every other metadata field, so a silent hole propagates
   * into the title and description too.
   */
  async generate(srtSegments: SRTSegment[]): Promise<ChapterPipelineResult> {
    if (!srtSegments || srtSegments.length === 0) {
      throw new Error('Chapter pipeline needs caption segments; none were supplied');
    }

    const cues = buildCues(srtSegments);
    const stream = buildWordStream(cues);
    const stretches = this.buildStretches(cues);
    const durationSeconds = cues[cues.length - 1].endSec;

    // Stage 4 tags speakers only when EVERY cue resolves to a side. A partly-tagged
    // transcript is not a partly-tagged prompt — it is a prompt that lies about the
    // untagged half — so it runs untagged, and says so.
    const rolesResolved = cues.filter((c) => c.role !== null).length;
    this.speakerTagged = rolesResolved === cues.length;
    if (this.speakerTagged) {
      log.info(
        `[ChapterPipeline] stage 4 will run TAGGED: all ${cues.length} cues carry a HOST/CLIP attribution`
      );
    } else if (rolesResolved > 0) {
      const msg =
        `only ${rolesResolved} of ${cues.length} caption segments carry a usable speaker attribution, ` +
        `so chapter summaries were written WITHOUT speaker tags (attribution between the host and the ` +
        `footage may be inverted)`;
      log.warn(`[ChapterPipeline] ${msg}`);
      this.warnings.push(msg);
    } else {
      log.info('[ChapterPipeline] stage 4 will run UNTAGGED: no caption segment carries speaker info');
    }

    log.info(
      `[ChapterPipeline] ${formatDuration(durationSeconds)} of captions -> ${cues.length} cues, ` +
        `${stream.words.length} words, ${stretches.length} stretches of ${STRETCH_SECONDS}s`
    );

    try {
      const labels = await this.stageLabel(stretches);
      const junctions = await this.stageRate(stretches, labels);
      const selected = this.stageSelect(junctions, durationSeconds);
      const boundaries = await this.stagePlace(selected, stretches, labels, stream);
      const initial = await this.stageSummarize(boundaries, durationSeconds, cues);
      const consolidated = await this.stageConsolidate(initial, cues);

      const chapters = this.toChapters(consolidated, durationSeconds);
      this.warnApproximateStarts(consolidated);

      return {
        chapters,
        subjects: chapters.map((c) => c.title),
        subjectDetails: consolidated.map((c) => ({ about: c.about, detail: c.detail })),
        warnings: [...this.warnings],
        stats: {
          durationSeconds,
          stretches: stretches.length,
          junctions: junctions.length,
          boundariesSelected: selected.length,
          chaptersBeforeConsolidation: initial.length,
          chaptersAfterConsolidation: consolidated.length,
          labelFailures: this.labelFailures,
          ratingFailures: junctions.filter((j) => !j.rated).length,
          approxStarts: consolidated.filter((c) => c.startApprox).length,
          speakerTagged: this.speakerTagged,
          calls: this.calls,
        },
      };
    } finally {
      await this.unloadModels();
    }
  }

  // ---------------------------------------------------------------- transcript prep

  private buildStretches(cues: Cue[]): Stretch[] {
    const stretches: Stretch[] = [];
    let current: Cue[] = [];
    let stretchStart = cues[0].startSec;

    const flush = () => {
      if (current.length === 0) return;
      stretches.push({
        index: stretches.length,
        startSec: current[0].startSec,
        endSec: current[current.length - 1].endSec,
        text: current.map((c) => c.text).join(' '),
        wordStart: current[0].wordStart,
        wordEnd: current[current.length - 1].wordEnd,
      });
      current = [];
    };

    for (const cue of cues) {
      if (current.length > 0 && cue.startSec - stretchStart >= STRETCH_SECONDS) {
        flush();
        stretchStart = cue.startSec;
      }
      current.push(cue);
    }
    flush();

    return stretches;
  }

  /** Raw transcript text between two times, for the summarize stages. */
  private transcriptBetween(cues: Cue[], startSec: number, endSec: number): string {
    return cues
      .filter((c) => c.startSec >= startSec && c.startSec < endSec)
      .map((c) => c.text)
      .join(' ');
  }

  /**
   * The same range rendered one line per cue, each carrying its speaker tag.
   *
   * ONLY stage 4 sees this. Stages 1-3 and 5 keep the bare text their sealed prompts
   * were tested on — the tags are a stage-4 fix for a stage-4 failure (the summarizer
   * inverting attribution, naming the host as the subject) and nothing else was
   * validated against them.
   */
  private taggedTranscriptBetween(cues: Cue[], startSec: number, endSec: number): string {
    return cues
      .filter((c) => c.startSec >= startSec && c.startSec < endSec)
      .map((c) => `${c.role === 'host' ? 'HOST:' : 'CLIP:'} ${c.text}`)
      .join('\n');
  }

  // ------------------------------------------------------------- quote -> timestamp

  /**
   * Measure where a quoted sentence starts, searching only the word range it was
   * quoted from. Exact match on the first 12 words; otherwise the best positional
   * match, which must clear 0.5 to count.
   */
  private mapQuote(
    quote: string,
    stream: WordStream,
    fromIndex: number,
    toIndex: number
  ): number | null {
    const quoteWords = normalizeWords(quote);
    if (quoteWords.length === 0) return null;

    const probe = quoteWords.slice(0, QUOTE_PROBE_WORDS);
    const last = Math.min(toIndex, stream.words.length) - probe.length;

    for (let i = Math.max(0, fromIndex); i <= last; i++) {
      let hit = true;
      for (let k = 0; k < probe.length; k++) {
        if (stream.words[i + k] !== probe[k]) {
          hit = false;
          break;
        }
      }
      if (hit) return stream.times[i];
    }

    let bestScore = 0;
    let bestIndex = -1;
    for (let i = Math.max(0, fromIndex); i <= last; i++) {
      let matches = 0;
      for (let k = 0; k < probe.length; k++) {
        if (stream.words[i + k] === probe[k]) matches++;
      }
      const score = matches / probe.length;
      if (score > bestScore) {
        bestScore = score;
        bestIndex = i;
      }
    }

    if (bestIndex !== -1 && bestScore >= QUOTE_MATCH_THRESHOLD) {
      return stream.times[bestIndex];
    }
    return null;
  }

  // -------------------------------------------------------------------- model calls

  private modelFor(stage: ChapterStage): string {
    return this.options.stageModels?.[stage] || this.options.model;
  }

  private checkCancelled(): void {
    if (this.options.abortSignal?.aborted || this.options.cancelCallback?.()) {
      throw new Error('Chapter generation cancelled by user');
    }
  }

  /**
   * Parse the first {...} object out of a response. With format:json that is the whole
   * body, but a model that ignores the flag still parses here.
   */
  private parseJsonObject(raw: unknown): any | null {
    if (typeof raw !== 'string') return null;
    const match = raw.match(/\{[\s\S]*\}/);
    if (!match) return null;
    try {
      const parsed = JSON.parse(match[0]);
      return parsed && typeof parsed === 'object' ? parsed : null;
    } catch {
      return null;
    }
  }

  /**
   * One model call, retried ONCE on unusable JSON, then reported as a miss.
   *
   * Returns null rather than throwing so one bad answer out of ~390 cannot destroy a
   * 25-minute run — the caller decides what a miss means for its stage, and every
   * caller either recovers loudly or counts the miss toward an aggregate throw.
   *
   * Two failures still end the run on the spot, because both mean every remaining call
   * is affected or the data is wrong rather than missing:
   *  - transport failures (Ollama unreachable, model not installed, timeout);
   *  - `done_reason: length`, which is a TRUNCATED answer, not a missing one.
   */
  private async askJson(
    stage: ChapterStage,
    prompt: string,
    what: string,
    opts?: { numCtx?: number }
  ): Promise<any | null> {
    const model = this.modelFor(stage);

    for (let attempt = 1; attempt <= 2; attempt++) {
      // Checked before EVERY attempt, not once per call: a cancel during the first
      // attempt would otherwise be swallowed by the retry.
      this.checkCancelled();
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
              num_ctx: opts?.numCtx || this.numCtx,
              num_predict: NUM_PREDICT,
            },
          },
          { timeout: CALL_TIMEOUT_MS, signal: this.options.abortSignal }
        );
        data = response.data;
      } catch (error: any) {
        if (isAbortError(error)) {
          throw new Error(`Chapter stage "${stage}" was cancelled by the user during ${what} (model ${model})`);
        }
        const status = error?.response?.status;
        const detail = error?.response?.data?.error || error?.message || 'unknown error';
        if (status === 404) {
          throw new Error(
            `Chapter stage "${stage}" needs Ollama model "${model}", which is not installed. Pull it with: ollama pull ${model}`
          );
        }
        if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
          throw new Error(
            `Chapter stage "${stage}" timed out after ${CALL_TIMEOUT_MS / 1000}s on ${what} (model ${model})`
          );
        }
        throw new Error(`Chapter stage "${stage}" failed on ${what} (model ${model}): ${detail}`);
      }

      if (data?.done_reason === 'length') {
        throw new Error(
          `Chapter stage "${stage}" hit the ${NUM_PREDICT}-token output limit on ${what}, so its JSON is truncated`
        );
      }

      const parsed = this.parseJsonObject(data?.response);
      if (parsed) return parsed;

      log.warn(
        `[ChapterPipeline] stage "${stage}" returned unusable JSON on ${what} ` +
          `(attempt ${attempt}/2): ${String(data?.response ?? '').slice(0, 200)}`
      );
    }

    return null;
  }

  /**
   * Release the resident model(s). Purely housekeeping — a failure here costs VRAM
   * until Ollama's own timer fires, so it warns rather than failing a finished run.
   */
  private async unloadModels(): Promise<void> {
    const models = new Set<string>([this.options.model, ...Object.values(this.options.stageModels || {})]);
    for (const model of models) {
      if (!model) continue;
      try {
        await this.client.post('/api/generate', { model, prompt: '', keep_alive: 0 }, { timeout: 30_000 });
      } catch (error: any) {
        console.warn(`[ChapterPipeline] Could not unload "${model}": ${error?.message || error}`);
      }
    }
  }

  private static readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  // ------------------------------------------------------------------------ stage 1

  /**
   * One call per 45s stretch. These labels are scaffolding for stage 2, not chapter
   * names — a stretch whose label call misses falls back to its own opening words,
   * which is enough for the rater to compare against, and the miss is counted.
   */
  private async stageLabel(stretches: Stretch[]): Promise<StretchLabel[]> {
    const labels: StretchLabel[] = [];
    let failures = 0;
    this.labelFailures = 0;

    for (const stretch of stretches) {
      const what = `stretch ${stretch.index + 1}/${stretches.length} at ${TimeUtils.secondsToYoutubeTime(stretch.startSec)}`;
      const parsed = await this.askJson(
        'label',
        formatPrompt(CHAPTER_PROMPTS.LABEL, { segment: stretch.text }),
        what
      );

      const about = ChapterPipelineService.readString(parsed?.about);
      if (about.length > 0) {
        labels.push({
          about,
          startsHere: parsed?.starts_here === true || parsed?.starts_here === 'true',
          openingPhrase: ChapterPipelineService.readString(parsed?.opening_phrase),
        });
      } else {
        failures++;
        this.labelFailures++;
        log.warn(`[ChapterPipeline] label failed for ${what} — using its opening words`);
        labels.push({ about: deriveLabel(stretch.text), startsHere: false, openingPhrase: '' });
      }

      this.options.onProgress?.('label', labels.length, stretches.length);
    }

    // Half the labels missing is not a bad patch of transcript, it is the wrong model:
    // everything downstream ranks on comparisons between these, so the run is over.
    if (failures > stretches.length / 2) {
      throw new Error(
        `Chapter stage "label" failed on ${failures} of ${stretches.length} transcript stretches. ` +
          `"${this.modelFor('label')}" on ${this.options.host} did not return usable output — check Model ` +
          `routing and that this model is one of your installed Ollama models.`
      );
    }
    if (failures > 0) {
      const msg =
        `${failures} of ${stretches.length} transcript stretches could not be labelled, so the ` +
        `chapter boundaries around them were ranked on weaker evidence`;
      log.warn(`[ChapterPipeline] ${msg}`);
      this.warnings.push(msg);
    }

    return labels;
  }

  // ------------------------------------------------------------------------ stage 2

  /**
   * One call per junction. Individually these ratings look weak (AUC ~0.55 against
   * reference boundaries) — do NOT threshold them. Ranking by them doubles end-to-end
   * F1 versus not ranking, which is what stage 3 does.
   *
   * A junction the model would not rate at all is marked UNRATED and excluded from
   * selection rather than guessed at: a fabricated 0 would silently suppress a real
   * boundary, and a missed boundary is the error nobody can fix. A rating that IS a
   * number but sits outside 0-3 is a scale error, not a missing answer — it is clamped
   * (and logged) and stays in the ranking, which is variant B's behaviour.
   */
  private async stageRate(stretches: Stretch[], labels: StretchLabel[]): Promise<Junction[]> {
    const junctions: Junction[] = [];
    let failures = 0;
    const total = Math.max(0, stretches.length - 1);

    for (let j = 0; j < total; j++) {
      const what = `junction ${j + 1}/${total} at ${TimeUtils.secondsToYoutubeTime(stretches[j + 1].startSec)}`;
      const parsed = await this.askJson(
        'rate',
        formatPrompt(CHAPTER_PROMPTS.RATE_JUNCTION, {
          before: labels[j].about,
          after: labels[j + 1].about,
          window: `${stretches[j].text} ${stretches[j + 1].text}`,
        }),
        what
      );

      const raw = typeof parsed?.change === 'number' ? parsed.change : Number(parsed?.change);
      const rated = Number.isFinite(raw);
      if (!rated) {
        failures++;
        log.warn(`[ChapterPipeline] rating failed for ${what} — excluded from boundary selection`);
      } else if (raw < 0 || raw > 3) {
        log.warn(`[ChapterPipeline] rating ${raw} for ${what} is outside 0-3 — clamped`);
      }

      junctions.push({
        index: j,
        timeSeconds: stretches[j + 1].startSec,
        change: rated ? Math.max(0, Math.min(3, Math.round(raw))) : 0,
        rated,
      });
      this.options.onProgress?.('rate', junctions.length, total);
    }

    if (total > 0 && failures > total / 2) {
      throw new Error(
        `Chapter stage "rate" failed on ${failures} of ${total} transcript junctions, so boundary ` +
          `selection has nothing left to rank. "${this.modelFor('rate')}" on ${this.options.host} did not ` +
          `return usable output — check Model routing and that this model is one of your installed Ollama models.`
      );
    }
    if (failures > 0) {
      const msg =
        `${failures} of ${total} chapter boundaries could not be rated and were excluded from ` +
        `selection, so a real subject change at one of them would have been missed`;
      log.warn(`[ChapterPipeline] ${msg}`);
      this.warnings.push(msg);
    }

    // The rating spread IS the selection signal. A rater answering the same number
    // everywhere degrades selection to uniform spacing — visible here, not guessed at
    // later when the chapters look oddly evenly spaced.
    const histogram = [0, 0, 0, 0];
    for (const j of junctions) if (j.rated) histogram[j.change]++;
    log.info(
      `[ChapterPipeline] stage 2: change ratings 0=${histogram[0]} 1=${histogram[1]} ` +
        `2=${histogram[2]} 3=${histogram[3]} (${failures} unrated)`
    );

    return junctions;
  }

  // ------------------------------------------------------------------------ stage 3

  /**
   * Select boundaries — zero model calls. Rank by change, take strongest-first while
   * enforcing minimum spacing, break ties farthest-from-already-chosen. 0:00 is always
   * a chapter and is never scored, but it does anchor the spacing.
   *
   * The count deliberately OVER-segments: stage 5 consolidates back down. Over-splits
   * the user fixes by joining in one click; under-splits nobody can fix by hand.
   */
  private stageSelect(junctions: Junction[], durationSeconds: number): Junction[] {
    const target = targetSecondsFor(durationSeconds);
    const wanted = Math.max(MIN_CHAPTERS, Math.round(durationSeconds / target)) - 1;
    const minGap = 0.6 * target;

    const chosen: Junction[] = [];
    const chosenTimes: number[] = [0]; // 0:00 anchors spacing without being scored

    while (chosen.length < wanted) {
      let best: { junction: Junction; distance: number } | null = null;

      for (const candidate of junctions) {
        if (!candidate.rated) continue; // an unrated junction is not evidence of anything
        if (chosen.includes(candidate)) continue;
        const distance = Math.min(...chosenTimes.map((t) => Math.abs(candidate.timeSeconds - t)));
        if (distance < minGap) continue;
        if (
          !best ||
          candidate.change > best.junction.change ||
          (candidate.change === best.junction.change && distance > best.distance)
        ) {
          best = { junction: candidate, distance };
        }
      }

      if (!best) break; // spacing exhausted the candidates before the target count
      chosen.push(best.junction);
      chosenTimes.push(best.junction.timeSeconds);
    }

    chosen.sort((a, b) => a.index - b.index);
    log.info(
      `[ChapterPipeline] Selected ${chosen.length}/${wanted} boundaries ` +
        `(target ${Math.round(target)}s per chapter, min gap ${Math.round(minGap)}s)`
    );
    return chosen;
  }

  // ----------------------------------------------------------------------- stage 3b

  /**
   * Place each selected boundary to the second. A junction is only accurate to +/-45s,
   * so one call reads the two stretches around it and quotes the sentence where the
   * host TURNS to the new subject; mapQuote() measures where that lands.
   *
   * Consecutive selections are always >= 2 stretches apart (min gap 0.6 x target, and
   * the smallest target is 132s), so these windows never overlap and the placements
   * come out ordered.
   *
   * The fallback chain, in order, and why it stops where it does:
   *  1. the placement call's own quote, mapped;
   *  2. the stage-1 opening quote of the stretch the boundary opens, mapped — still a
   *     measurement, same ~5s accuracy, just a different sentence;
   *  3. the raw junction, which is a whole order of magnitude worse (~5s -> ±45s) and
   *     is therefore FLAGGED on the chapter and warned about, not just logged. Losing
   *     the chapter entirely would be worse: nobody can add a missing chapter back by
   *     hand, but anyone can nudge a start they were told is approximate.
   */
  private async stagePlace(
    selected: Junction[],
    stretches: Stretch[],
    labels: StretchLabel[],
    stream: WordStream
  ): Promise<PlacedBoundary[]> {
    const placed: PlacedBoundary[] = [];

    for (let i = 0; i < selected.length; i++) {
      const junction = selected[i];
      const before = stretches[junction.index];
      const after = stretches[junction.index + 1];
      const at = TimeUtils.secondsToYoutubeTime(after.startSec);
      const what = `boundary ${i + 1}/${selected.length} near ${at}`;

      const parsed = await this.askJson(
        'place',
        formatPrompt(CHAPTER_PROMPTS.PLACE_BOUNDARY, {
          before: labels[junction.index].about,
          after: labels[junction.index + 1].about,
          window: `${before.text} ${after.text}`,
        }),
        what
      );

      const quote = ChapterPipelineService.readString(parsed?.start_phrase);
      let seconds = quote ? this.mapQuote(quote, stream, before.wordStart, after.wordEnd) : null;
      let approxReason = '';

      if (seconds === null && labels[junction.index + 1].openingPhrase) {
        seconds = this.mapQuote(
          labels[junction.index + 1].openingPhrase,
          stream,
          before.wordStart,
          after.wordEnd
        );
        if (seconds !== null) {
          log.warn(
            `[ChapterPipeline] ${what}: placement quote could not be mapped — used the stretch's own opening quote`
          );
        }
      }

      if (seconds === null) {
        seconds = junction.timeSeconds;
        approxReason = quote
          ? 'the model quoted a sentence that does not appear in the transcript there'
          : 'the model returned no usable quote';
        log.warn(
          `[ChapterPipeline] ${what}: no quote mapped — falling back to the raw junction at ${at} (±${STRETCH_SECONDS}s)`
        );
      }

      // Placement can move a boundary backwards past its predecessor. Keep the list
      // strictly increasing: prefer the raw junction over an out-of-order placement,
      // and drop the boundary entirely rather than emit a zero-length chapter.
      const previous = placed.length > 0 ? placed[placed.length - 1].time : 0;
      if (seconds - previous < MIN_BOUNDARY_GAP) {
        if (junction.timeSeconds - previous >= MIN_BOUNDARY_GAP) {
          log.warn(
            `[ChapterPipeline] ${what}: placement at ${TimeUtils.secondsToYoutubeTime(seconds)} collided with the ` +
              `previous chapter start — using the raw junction`
          );
          seconds = junction.timeSeconds;
          approxReason = 'the placed quote landed before the previous chapter start';
        } else {
          const msg =
            `a chapter boundary near ${at} was dropped: every placement for it landed within ` +
            `${MIN_BOUNDARY_GAP}s of the previous chapter start, so the two would have collided`;
          log.warn(`[ChapterPipeline] ${msg}`);
          this.warnings.push(msg);
          this.options.onProgress?.('place', i + 1, selected.length);
          continue;
        }
      }

      placed.push({ time: seconds, approx: approxReason.length > 0, approxReason });
      this.options.onProgress?.('place', i + 1, selected.length);
    }

    const approx = placed.filter((p) => p.approx).length;
    if (approx > 0) {
      log.warn(
        `[ChapterPipeline] stage 3b: ${approx}/${placed.length} chapter starts fell back to the raw ` +
          `junction (±${STRETCH_SECONDS}s) — flagged on the chapters as startApprox`
      );
    }

    return placed;
  }

  // ------------------------------------------------------------------------ stage 4

  /**
   * Summarize each chapter's ACTUAL transcript span. These are the real chapter names
   * and the subject list the downstream fields condition on.
   *
   * Two things arrived here on 2026-08-16, both from the sibling implementation:
   *
   * - SPEAKER TAGS, when the transcript carries them (imported AutoCutStudio
   *   transcripts do; a plain Whisper run does not). Untagged, the summarizer cannot
   *   tell the host's verdict from the footage's claim and inverts attribution —
   *   "racist flight attendant" for a chapter where the host is calling the PASSENGER
   *   racist. Which prompt runs is a fact about the input, decided once in generate()
   *   and logged; stages 1-3 and 5 never see a tag.
   * - A `detail` field: 20-45 words of description-grade prose per chapter. The 4-8
   *   word marker is what a viewer clicks; `detail` is what the description and tag
   *   stages need in order to say anything specific.
   */
  private async stageSummarize(
    boundaries: PlacedBoundary[],
    durationSeconds: number,
    cues: Cue[]
  ): Promise<WorkingChapter[]> {
    // 0:00 is always a chapter and was never placed by a model, so it is never approximate.
    const starts: PlacedBoundary[] = [{ time: 0, approx: false, approxReason: '' }, ...boundaries];
    const chapters: WorkingChapter[] = [];

    for (let i = 0; i < starts.length; i++) {
      const startSec = starts[i].time;
      const endSec = i < starts.length - 1 ? starts[i + 1].time : durationSeconds;
      const named = await this.summarizeSpan(startSec, endSec, cues, `chapter ${i + 1}/${starts.length}`);

      chapters.push({
        startSec,
        endSec,
        about: named.about,
        detail: named.detail,
        merged: false,
        startApprox: starts[i].approx,
        approxReason: starts[i].approxReason,
        // Snapshot the fine tier the moment it is named — BEFORE consolidation can
        // splice it away.
        members: [
          { startSec, about: named.about, startApprox: starts[i].approx, approxReason: starts[i].approxReason },
        ],
      });
      this.options.onProgress?.('summarize', chapters.length, starts.length);
    }

    return chapters;
  }

  /**
   * Context needed to summarize one span, bucketed for Ollama.
   *
   * words x 1.4 + 900 — the +900 (was +600) pays for the three extra bullets and the
   * 20-45 word detail field. Never smaller than the configured window, so the common
   * case still runs the whole pipeline at one num_ctx and Ollama never reloads;
   * 4096-token buckets keep the reload count to a handful when a long chapter does
   * need more. Above 32768 it REFUSES: a summary of a chapter's opening teaches
   * nothing about the chapter, and it would go on to mislead every downstream field
   * too.
   */
  private chapterNumCtx(transcript: string, startSec: number, endSec: number): number {
    const words = normalizeWords(transcript).length;
    const needed = Math.ceil(words * 1.4 + 900);
    if (needed > CHAPTER_CTX_MAX) {
      throw new Error(
        `Chapter span ${TimeUtils.secondsToYoutubeTime(startSec)}-${TimeUtils.secondsToYoutubeTime(endSec)} ` +
          `needs about ${needed} tokens to summarize but the ceiling is ${CHAPTER_CTX_MAX}. ` +
          `Refusing rather than summarizing a truncated chapter.`
      );
    }
    return Math.max(this.numCtx, Math.ceil(needed / CTX_BUCKET) * CTX_BUCKET);
  }

  /**
   * Does this answer break a rule the prompt actually stated?
   *
   * "Ellison" exists only as the invented example in the summarize prompt; a label
   * copying it is the overwhelmingly likelier read of a chapter whose transcript names
   * no Ellison, and the inoculation parenthetical did not always hold. The host/creator
   * ban is only checked in tagged mode because only the tagged prompt states it —
   * re-asking against a rule the model was never given would be inventing one.
   */
  private ruleBroken(text: string): 'example' | 'host' | null {
    if (/\bellison\b/i.test(text)) return 'example';
    if (this.speakerTagged && /\b(host|creator)\b/i.test(text)) return 'host';
    return null;
  }

  /**
   * One summarize call for one span, with one corrective re-ask.
   *
   * A span with no transcript text at all still throws: the boundaries came from cue
   * times, so an empty span means the time arithmetic is wrong, and naming a chapter
   * that has no words would be inventing one.
   */
  private async summarizeSpan(
    startSec: number,
    endSec: number,
    cues: Cue[],
    what: string
  ): Promise<ChapterSubject> {
    const transcript = this.transcriptBetween(cues, startSec, endSec);
    if (transcript.trim().length === 0) {
      throw new Error(
        `Chapter span ${TimeUtils.secondsToYoutubeTime(startSec)}-${TimeUtils.secondsToYoutubeTime(endSec)} has no transcript text`
      );
    }

    const body = this.speakerTagged
      ? this.taggedTranscriptBetween(cues, startSec, endSec)
      : transcript;
    const numCtx = this.chapterNumCtx(body, startSec, endSec);
    const prompt = formatPrompt(
      this.speakerTagged ? CHAPTER_PROMPTS.SUMMARIZE_CHAPTER_TAGGED : CHAPTER_PROMPTS.SUMMARIZE_CHAPTER,
      {
        start: TimeUtils.secondsToYoutubeTime(startSec),
        end: TimeUtils.secondsToYoutubeTime(endSec),
        transcript: body,
      }
    );

    const parsed = await this.askJson('summarize', prompt, what, { numCtx });
    let about = ChapterPipelineService.readString(parsed?.about);
    let detail = ChapterPipelineService.readString(parsed?.detail);

    // The prompt bans naming the host and bans copying its own invented example name;
    // a 14B still breaks each on occasion, stably across prompt wordings — more words
    // did not move it. One corrective re-ask, stating the prompt's own rule back with
    // the offending answer, fixed every case tried. If it insists a second time its
    // answer stands and the log says so.
    const broken = about ? this.ruleBroken(about) || this.ruleBroken(detail) : null;
    if (broken) {
      const offending = this.ruleBroken(about) ? about : detail;
      const rule =
        broken === 'host'
          ? 'the rule against the word "host". Rewrite both fields: name the activity or story itself'
          : 'the rule against copying names from these instructions (Ellison is invented). Rewrite both fields using only names the transcript provides';
      const retry = await this.askJson(
        'summarize',
        `${prompt}\n\nYour previous answer was "${offending}". It broke ${rule}.`,
        `${what} rule retry`,
        { numCtx }
      );
      const retriedAbout = ChapterPipelineService.readString(retry?.about);
      if (retriedAbout) {
        about = retriedAbout;
        detail = ChapterPipelineService.readString(retry?.detail) || detail;
        if (this.ruleBroken(about) || this.ruleBroken(detail)) {
          log.warn(`[ChapterPipeline] ${what}: still rule-breaking after the corrective retry — keeping "${about}"`);
        }
      }
    }

    if (about) return { about, detail };

    // Named from its own opening words instead of by the model. The chapter still
    // exists at the right second, but its NAME is now a transcript fragment — and that
    // name is also what the title and description stages condition on, so the user is
    // told rather than left to notice.
    const derived = deriveLabel(transcript);
    const msg =
      `the chapter at ${TimeUtils.secondsToYoutubeTime(startSec)} could not be named by the model, so it is ` +
      `titled from its own opening words ("${derived}") and carries no description detail`;
    log.warn(`[ChapterPipeline] ${msg}`);
    this.warnings.push(msg);
    return { about: derived, detail: '' };
  }

  // ------------------------------------------------------------------------ stage 5

  /**
   * Consolidate. Walk left to right asking "one story or two?" about EVERY adjacent
   * pair — a gated version (only short-sided or weak-junction pairs eligible) merged 1
   * of the 8 pairs that needed merging on the livestream test.
   *
   * Merges apply immediately and the cursor stays put, so a story split three ways
   * collapses in one sweep. Merged spans keep chapter A's summary DURING the sweep and
   * are re-summarized from their full transcript afterwards. The merged chapter also
   * inherits A's start — and therefore A's placement accuracy — and absorbs B's
   * pre-consolidation members so the fine tier survives.
   *
   * A pair the model would not judge is left SEPARATE. That is the recoverable
   * direction: an over-split is one click to join, an under-split is a chapter the
   * user cannot get back.
   */
  private async stageConsolidate(initial: WorkingChapter[], cues: Cue[]): Promise<WorkingChapter[]> {
    if (this.options.consolidate === false) {
      log.info(
        `[ChapterPipeline] stage 5 skipped by request — the caller declared this span a single story, ` +
          `so there is no story seam to find; returning the ${initial.length}-chapter stage-4 tier`
      );
      return initial.map((c) => ({ ...c, members: [...c.members] }));
    }

    const chapters = initial.map((c) => ({ ...c, members: [...c.members] }));
    let i = 0;
    let comparisons = 0;
    let judgementFailures = 0;
    const totalPairs = Math.max(1, chapters.length - 1);

    while (i < chapters.length - 1 && chapters.length > MIN_CHAPTERS) {
      const a = chapters[i];
      const b = chapters[i + 1];
      const what = `pair ${i + 1} (${TimeUtils.secondsToYoutubeTime(a.startSec)} + ${TimeUtils.secondsToYoutubeTime(b.startSec)})`;

      const parsed = await this.askJson(
        'consolidate',
        formatPrompt(CHAPTER_PROMPTS.CONSOLIDATE_PAIR, {
          a_length: formatDuration(a.endSec - a.startSec),
          a_about: a.about,
          b_length: formatDuration(b.endSec - b.startSec),
          b_about: b.about,
        }),
        what
      );

      comparisons++;
      this.options.onProgress?.('consolidate', Math.min(comparisons, totalPairs), totalPairs);

      const oneStory = parsed?.one_story === true || parsed?.one_story === 'true';
      const answered =
        typeof parsed?.one_story === 'boolean' || parsed?.one_story === 'true' || parsed?.one_story === 'false';

      if (!answered) {
        judgementFailures++;
        log.warn(`[ChapterPipeline] ${what}: no usable "one story or two?" answer — keeping them separate`);
        i++;
        continue;
      }

      if (oneStory) {
        log.info(`[ChapterPipeline] Merging ${what}: "${a.about}" + "${b.about}" (${parsed?.why || 'no reason given'})`);
        a.endSec = b.endSec;
        a.merged = true;
        a.members.push(...b.members);
        chapters.splice(i + 1, 1);
        // Cursor stays at i so the merged span is compared to what follows.
      } else {
        i++;
      }
    }

    if (judgementFailures > 0) {
      const msg =
        `${judgementFailures} chapter-merge judgement(s) failed, so those chapters were left separate — ` +
        `the list may contain a story split across two chapters that should be joined`;
      log.warn(`[ChapterPipeline] ${msg}`);
      this.warnings.push(msg);
    }

    // Re-summarize every merged span from its full transcript — chapter A's summary
    // (and its detail) described only the first slice of what is now one chapter.
    for (let k = 0; k < chapters.length; k++) {
      if (!chapters[k].merged) continue;
      const renamed = await this.summarizeSpan(
        chapters[k].startSec,
        chapters[k].endSec,
        cues,
        `merged chapter ${k + 1}/${chapters.length}`
      );
      chapters[k].about = renamed.about;
      chapters[k].detail = renamed.detail;
    }

    log.info(
      `[ChapterPipeline] Consolidated ${initial.length} chapters -> ${chapters.length} ` +
        `(${chapters.reduce((n, c) => n + c.members.length, 0)} pre-consolidation chapters retained)`
    );
    return chapters;
  }

  // ---------------------------------------------------------------------- assembling

  private toChapters(working: WorkingChapter[], durationSeconds: number): Chapter[] {
    return working.map((chapter, index) => {
      // A chapter that was never merged has exactly one member — itself. That is
      // accurate but useless to a consumer, so it carries no subChapters at all.
      const subChapters: SubChapter[] | undefined =
        chapter.members.length > 1
          ? chapter.members
              .slice()
              .sort((a, b) => a.startSec - b.startSec)
              .map((m) => ({
                timestamp: TimeUtils.secondsToYoutubeTime(m.startSec),
                title: m.about,
                ...(m.startApprox ? { startApprox: true } : {}),
              }))
          : undefined;

      return {
        timestamp: TimeUtils.secondsToYoutubeTime(chapter.startSec),
        title: chapter.about,
        sequence: index,
        endTimestamp: TimeUtils.secondsToYoutubeTime(
          index < working.length - 1 ? working[index + 1].startSec : durationSeconds
        ),
        detail: chapter.detail,
        ...(chapter.startApprox ? { startApprox: true } : {}),
        ...(subChapters ? { subChapters } : {}),
      };
    });
  }

  /**
   * One warning per start that came from a raw junction. Written here, after naming,
   * because a warning a user can act on has to say WHICH chapter — and the chapter has
   * no name until stage 4 has run.
   *
   * Sub-chapter starts are warned about too. A merged chapter keeps the LEFT side's
   * start, so an approximate start on the right side of a merge survives only inside
   * the fine tier — and it is still a marker somebody may publish.
   */
  private warnApproximateStarts(working: WorkingChapter[]): void {
    for (const chapter of working) {
      if (chapter.startApprox) {
        this.warnings.push(
          `chapter "${chapter.about}" starts at ${TimeUtils.secondsToYoutubeTime(chapter.startSec)}, which is ` +
            `approximate (±${STRETCH_SECONDS}s): ${chapter.approxReason || 'its quote could not be mapped'}`
        );
      }
      // members[0] is the chapter's own start, already covered above.
      for (const member of chapter.members.slice(1)) {
        if (!member.startApprox) continue;
        this.warnings.push(
          `inside chapter "${chapter.about}", the section "${member.about}" starts at ` +
            `${TimeUtils.secondsToYoutubeTime(member.startSec)}, which is approximate (±${STRETCH_SECONDS}s): ` +
            `${member.approxReason || 'its quote could not be mapped'}`
        );
      }
    }
  }
}
