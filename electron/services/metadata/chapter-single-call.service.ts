/**
 * Chapter Single-Call Service — the 27B whole-transcript exception
 *
 * ONE model call reads the whole transcript and returns the whole chapter list. That is
 * the architecture CHAPTERING.md's one law forbids: "no model call ever sees a list, a
 * count, or the whole video". This file is the qualification to that law, not a repeal of
 * it, and it is opt-in — nothing routes here unless the operator picks the single-call
 * option for the Chapters task.
 *
 * WHY THE EXCEPTION EXISTS. The law was measured on a 14B, which returns a prefix of the
 * boundary list and stops. Re-measured on qwen3.8:27b on 2026-08-21 over four videos from
 * 8.8 minutes to 2h08 (/Volumes/Callisto/Projects/tools/chapter-experiment/RESULTS.md), no
 * prefix behaviour appeared at any length, quotes mapped 100% on three runs of four, no
 * name was invented in any run of either round, and on the 2h08 stream the single call hit
 * 5 of 5 of the creator's own story boundaries with a worst offset of 54 s. It also
 * REPAIRED whisper garble ("As I as 6'8\" and \"I\"V" -> Isaiah 6:8) that a span-local
 * stage-4 call structurally cannot see.
 *
 * WHY IT IS STILL FENCED. The same experiment found the failure this shape actually has,
 * and it is not capability, it is variance. Unprompted cadence swung 44x across four
 * videos at temperature 0 — one 32-minute video came back as 88 sub-minute "chapters"
 * titled "Host interjection" — and four tokens of cosmetic punctuation moved a count 8 ->
 * 13 on a re-run with everything else identical. So the budget is stated in the prompt AND
 * enforced here, and every quote is resolved against the caption word stream rather than
 * trusted.
 *
 * FAILURE POLICY, which is the opposite of chapter-pipeline.service.ts's and deliberately
 * so. The pipeline makes ~390 calls and one bad answer must not destroy a 25-minute run,
 * so it degrades loudly and carries on. This path makes ONE call, so a bad answer is the
 * whole answer: validation failure throws with every violation named, and that is the end
 * of it. No retry, no second call at a different temperature, no falling back to the
 * 5-stage pipeline, no emitting an unvalidated list. The caller (resolveChapters) already
 * records `chaptersSkipped` and generates the rest of the metadata without chapter
 * subjects, which is a state the user can see and act on — a silently rescued chapter list
 * is not.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { SRTSegment } from './whisper.service';
import { Chapter, TimeUtils } from './chapter-generator.service';
import {
  buildCues,
  buildWordStream,
  normalizeWords,
  targetSecondsFor,
  ChapterPipelineResult,
  Cue,
  MIN_CHAPTERS,
  WordStream,
} from './chapter-pipeline.service';
import { CHAPTER_SINGLE_CALL_PROMPTS } from './chapter-prompts';
import { formatPrompt } from './system-prompts';
import { isAbortError } from './cancellation';

/** This path has exactly one stage. Named so the progress channel can say which. */
export type ChapterSingleCallStage = 'single-call';

export interface ChapterSingleCallOptions {
  /** Ollama base URL. */
  host: string;
  /** Bare Ollama model name, as `ollama list` prints it. */
  model: string;
  /**
   * Floor for the context window, not the value. This path sizes num_ctx from the
   * transcript it is about to send (see numCtxFor) because a whole-transcript prompt that
   * does not fit is a truncated prompt, and a chapter list for the first half of a video
   * reads exactly like a chapter list for all of it. A caller-supplied value only ever
   * raises the computed one.
   */
  numCtx?: number;
  onProgress?: (stage: ChapterSingleCallStage, done: number, total: number) => void;
  cancelCallback?: () => boolean;
  /**
   * Aborts the call in flight. This matters more here than in the pipeline: the whole run
   * is one request that can spend minutes inside Ollama, so a cancel flag polled between
   * calls would never be read at all.
   */
  abortSignal?: AbortSignal;
}

/** What the model is asked for, before anything has been checked. */
interface RawChapter {
  quote: string;
  title: string;
  summary: string;
}

/** One raw chapter with its quote measured against the caption word stream. */
interface ResolvedChapter extends RawChapter {
  /** Where the quote resolved to, in seconds. */
  startSec: number;
}

/**
 * How wide the count band is around the cadence target, each side, rounded outward.
 *
 * The budget is a prior the model obeys closely but not exactly — measured overshoot was
 * 1-2 chapters over a ceiling of 9 — so a band with no slack would reject lists that are
 * right. 40% is wide enough to absorb that and still narrow enough to catch the failures
 * that matter: the 88-chapter annotation collapse and the 16 min/chapter under-split are
 * both an order of magnitude outside it.
 */
const BUDGET_TOLERANCE = 0.4;

/**
 * The spacing slack stage 3 of the sealed pipeline uses: no boundary may sit closer than
 * `0.6 x` the cadence it is aiming at. Reused rather than re-picked.
 */
const MIN_GAP_FRACTION = 0.6;

/**
 * Ceiling on the minimum gap between chapters, in seconds — the "3 minutes" the
 * experiment's prompt stated and the model was measured complying with.
 *
 * The gap is otherwise `0.6 x (duration / hi)`: 0.6 of the TIGHTEST cadence the count
 * budget permits, not of the target. That distinction is not a detail. A flat 3 minutes,
 * or 0.6 of the target, contradicts the budget instead of backing it — the budget lets a
 * 44-minute video return 12 chapters, which is 3.6 minutes apart on average, so
 * individual gaps of 2.7-2.9 minutes are inside what was asked for and a 3-minute floor
 * rejects them. Measured: a real 44-minute run came back with 12 chapters, every quote
 * resolved, and a flat floor failed it on three gaps of 165-171 s while accepting the one
 * gap that was actually wrong (52 s).
 *
 * So the two constraints are derived from one table and cannot disagree: the count says
 * how many chapters may come back, and the gap says none of them may be shorter than 60%
 * of what that many chapters implies.
 */
const MAX_MIN_GAP_SECONDS = 180;

/**
 * How far into the video the first chapter's quote may resolve.
 *
 * The published first chapter is pinned to 0:00 in code (YouTube requires it, and the
 * sealed pipeline does the same — 0:00 is never a model output). This check is what stops
 * that pin from papering over a real failure: if the model's first quote lands five
 * minutes in, its first chapter is NAMED for a span that does not include the opening five
 * minutes, and pinning it to 0:00 would silently mislabel them. 30 s allows the model to
 * quote the first sentence properly and nothing more.
 */
const FIRST_CHAPTER_MAX_START_SECONDS = 30;

/**
 * Shortest quote that can be a measurement.
 *
 * The 88-chapter collapse produced quotes of one word — "fucking", "corruption.", "my" —
 * which either fail to resolve or resolve somewhere arbitrary. The prompt asks for 8-12
 * words; anything under 15 characters is not a sentence opening.
 */
const MIN_QUOTE_CHARS = 15;
/** ...and the same floor in words, since a 15-character quote can still be two words. */
const MIN_QUOTE_WORDS = 4;

/**
 * How many of a quote's words have to line up, and be unique, for it to be a position.
 *
 * Same probe length the sealed pipeline maps with. The quote may be longer; matching on
 * the first 12 words is what the caption stream can actually support, because the model
 * reproduces a sentence's opening reliably and its tail less so.
 */
const QUOTE_PROBE_WORDS = 12;

/** Output budget. ~42 chapters x (quote + title + 45-word summary) fits inside this. */
const NUM_PREDICT = 8192;
/**
 * The whole run is this one request. The experiment clocked 174 s for a 24.8k-token
 * prompt on an idle 64 GB Mac Studio; 30 minutes covers a 3-hour transcript on a machine
 * that is also doing something else, and the AI queue's 4-hour task timeout still
 * backstops a wedged Ollama.
 */
const CALL_TIMEOUT_MS = 30 * 60 * 1000;
/** Nothing follows this call, so the model is released the moment it returns. */
const KEEP_ALIVE = '5m';
/** Ollama reloads on a num_ctx change; quantize so repeat runs on similar videos do not. */
const CTX_BUCKET = 8192;
/** Below this there is no point sizing anything — the smallest transcript still needs room. */
const CTX_MIN = 32768;
/** qwen3.8:27b's trained context length. Above it the prompt would be silently truncated. */
const CTX_MAX = 262144;
/** Tokens per transcript word, the estimate the rest of this codebase uses. */
const TOKENS_PER_WORD = 1.4;
/** Tokens per transcript line, for the speaker tag and the newline. */
const TOKENS_PER_LINE = 3;
/** Everything in the prompt that is not the transcript: ~800 tokens of instructions. */
const PROMPT_OVERHEAD_TOKENS = 1200;

/** The chapter-count band this video is allowed to come back inside. */
export interface ChapterBudget {
  /** Chapters the shipped cadence table asks for at this duration. */
  target: number;
  lo: number;
  hi: number;
  /**
   * The spacing the PROMPT asks for: 0.6 of the target cadence, capped at 3 minutes —
   * the number the experiment stated and measured. Stated rather than enforced because
   * the model treats it as a real instruction and its cadence follows it: told 2 minutes
   * instead of 3 on the same 44-minute transcript, the same model returned 13 chapters
   * instead of 12 and four gaps under two minutes instead of one. The prompt asks for the
   * cadence we actually want.
   */
  promptGapSeconds: number;
  /**
   * The spacing CODE enforces: 0.6 of the tightest cadence the count band permits. Looser
   * than what the prompt asks for, on purpose — code rejects what the budget cannot
   * justify, not everything the prompt would have preferred. Tightening this to match the
   * prompt would fail lists whose count is inside the band it was given, which is
   * punishing the model for obeying.
   */
  minGapSeconds: number;
}

/**
 * The budget, derived from the shipped cadence table and nothing else.
 *
 * `targetSecondsFor` is stage 3's own function, imported rather than copied: the two
 * chapter paths have to want the same number of chapters or the operator gets a different
 * video depending on a dropdown. The band is +/-40% rounded outward, floored at the
 * 3-chapter minimum YouTube enforces.
 */
export function chapterBudgetFor(durationSeconds: number): ChapterBudget {
  const targetSeconds = targetSecondsFor(durationSeconds);
  const target = Math.max(MIN_CHAPTERS, Math.round(durationSeconds / targetSeconds));
  const lo = Math.max(MIN_CHAPTERS, Math.floor(target * (1 - BUDGET_TOLERANCE)));
  const hi = Math.max(lo, Math.ceil(target * (1 + BUDGET_TOLERANCE)));
  return {
    target,
    lo,
    hi,
    promptGapSeconds: Math.min(MAX_MIN_GAP_SECONDS, MIN_GAP_FRACTION * targetSeconds),
    minGapSeconds: Math.min(MAX_MIN_GAP_SECONDS, MIN_GAP_FRACTION * (durationSeconds / hi)),
  };
}

function formatClock(seconds: number): string {
  return TimeUtils.secondsToYoutubeTime(Math.max(0, seconds));
}

export class ChapterSingleCallService {
  private readonly client: AxiosInstance;
  private readonly options: ChapterSingleCallOptions;

  constructor(options: ChapterSingleCallOptions) {
    this.options = options;
    this.client = axios.create({
      baseURL: options.host,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * One call, one chapter list, or an exception naming exactly what was wrong with it.
   *
   * Returns the SAME ChapterPipelineResult shape the sealed pipeline returns, so promo
   * exclusion, the job report, the description's chapter lines and `chaptersSkipped` all
   * work against it without knowing which path produced it.
   */
  async generate(srtSegments: SRTSegment[]): Promise<ChapterPipelineResult> {
    if (!srtSegments || srtSegments.length === 0) {
      throw new Error('Single-call chaptering needs caption segments; none were supplied');
    }

    const cues = buildCues(srtSegments);
    const durationSeconds = cues[cues.length - 1].endSec;
    const budget = chapterBudgetFor(durationSeconds);

    // All-or-nothing, exactly as the pipeline's stage 4 decides it: a prompt that
    // announces HOST:/CLIP: tags over a transcript where half the lines have none is a
    // prompt that lies, and the model has no way to tell which half.
    const rolesResolved = cues.filter((c) => c.role !== null).length;
    const speakerTagged = rolesResolved === cues.length;
    const warnings: string[] = [];
    if (!speakerTagged && rolesResolved > 0) {
      const msg =
        `only ${rolesResolved} of ${cues.length} caption segments carry a usable speaker attribution, ` +
        `so the single chapter call ran WITHOUT speaker tags (attribution between the host and the ` +
        `footage may be inverted)`;
      log.warn(`[ChapterSingleCall] ${msg}`);
      warnings.push(msg);
    }

    const transcript = this.renderTranscript(cues, speakerTagged);
    // The readings a quote may faithfully come from. See resolveQuotes.
    const combined = buildWordStream(cues);
    const streams = speakerTagged
      ? [
          combined,
          buildWordStream(cues.filter((c) => c.role === 'host')),
          buildWordStream(cues.filter((c) => c.role === 'clip')),
        ]
      : [combined];
    const wordCount = combined.words.length;
    const numCtx = this.numCtxFor(transcript);
    const prompt = formatPrompt(
      speakerTagged
        ? CHAPTER_SINGLE_CALL_PROMPTS.WHOLE_TRANSCRIPT_TAGGED
        : CHAPTER_SINGLE_CALL_PROMPTS.WHOLE_TRANSCRIPT,
      {
        // Substituted before {transcript} on purpose: formatPrompt runs the replacements
        // in insertion order, and transcript text that happened to contain a brace token
        // must not be rewritten by a later pass.
        minutes: Math.round(durationSeconds / 60),
        lo: budget.lo,
        hi: budget.hi,
        // Stated in whole minutes, as the tested prompt states it. Never below 1: "no
        // chapter may cover less than 0 minutes" is not an instruction.
        gap: Math.max(1, Math.round(budget.promptGapSeconds / 60)),
        transcript,
      }
    );

    log.info(
      `[ChapterSingleCall] ${formatClock(durationSeconds)} of captions -> ${cues.length} cues, ` +
        `${wordCount} words, ${speakerTagged ? 'speaker-tagged' : 'untagged'}; ` +
        `budget ${budget.lo}-${budget.hi} chapters (target ${budget.target}, ` +
        `asking for ${Math.round(budget.promptGapSeconds)}s between starts, ` +
        `enforcing ${Math.round(budget.minGapSeconds)}s), num_ctx ${numCtx}`
    );

    this.options.onProgress?.('single-call', 0, 1);

    let response: unknown;
    try {
      response = await this.ask(prompt, numCtx);
    } finally {
      await this.unloadModel();
    }

    const raw = this.parseChapters(response);
    const resolved = this.resolveQuotes(raw, streams);
    this.validate(resolved, budget, durationSeconds);

    const chapters = this.toChapters(resolved, durationSeconds);
    this.options.onProgress?.('single-call', 1, 1);

    log.info(
      `[ChapterSingleCall] ${chapters.length} chapters validated ` +
        `(budget ${budget.lo}-${budget.hi}): ` +
        chapters.map((c) => `${c.timestamp} ${c.title}`).join(' | ')
    );

    return {
      chapters,
      subjects: chapters.map((c) => c.title),
      subjectDetails: resolved.map((c) => ({ about: c.title, detail: c.summary })),
      warnings,
      stats: {
        durationSeconds,
        // Zero because this path has none of these things, not because they failed: it
        // cuts no stretches, rates no junctions and consolidates nothing.
        stretches: 0,
        junctions: 0,
        boundariesSelected: chapters.length,
        chaptersBeforeConsolidation: chapters.length,
        chaptersAfterConsolidation: chapters.length,
        labelFailures: 0,
        ratingFailures: 0,
        // Every start here is a resolved quote or the run threw. There is no approximate
        // start on this path, by construction.
        approxStarts: 0,
        speakerTagged,
        calls: 1,
      },
    };
  }

  // ------------------------------------------------------------------ transcript prep

  /**
   * The whole transcript as prose, WITHOUT timestamps.
   *
   * No timestamps on purpose. The model is asked for quotes precisely so code can measure
   * where they fall; put clock times in front of it and it will copy or imitate them, and
   * an imitated timestamp is a guess wearing a measurement's clothes. This is the same
   * corollary the sealed method runs on, and the experiment that validated this path
   * stripped timestamps too.
   *
   * ONE LINE PER SPEAKER RUN, not one line per caption cue — the rendering the experiment
   * measured. Caption cues are ~7-word wrapped fragments that cut sentences in half, and
   * the prompt asks for "the first 8 to 12 words of the SENTENCE where the subject
   * begins": handed fragments, the model stitches its own sentence back together across
   * the break and the quote it returns is not text that appears anywhere. Measured on this
   * transcript, cue-per-line rendering produced 2 unresolvable quotes out of 12; joining
   * each speaker's run into one block is what the tested artifact did.
   *
   * Untagged transcripts have no runs to join, so they render as continuous prose — the
   * same join the pipeline's own transcriptBetween() uses.
   */
  private renderTranscript(cues: Cue[], speakerTagged: boolean): string {
    if (!speakerTagged) {
      return cues.map((c) => c.text).join(' ');
    }

    const lines: string[] = [];
    let run: string[] = [];
    let role: Cue['role'] = null;

    const flush = () => {
      if (run.length === 0) return;
      lines.push(`${role === 'host' ? 'HOST:' : 'CLIP:'} ${run.join(' ')}`);
      run = [];
    };

    for (const cue of cues) {
      if (cue.role !== role) {
        flush();
        role = cue.role;
      }
      run.push(cue.text);
    }
    flush();

    return lines.join('\n');
  }

  /**
   * Size the context window to the prompt that is about to be sent.
   *
   * Refuses rather than truncates. A truncated whole-transcript prompt produces a chapter
   * list for the part that fit, which is indistinguishable from a chapter list for the
   * whole video until a viewer clicks the last marker.
   *
   * Sizing is cheap: measured on this model, a 32x increase in num_ctx moved the resident
   * footprint by 0.42 GB (18.15 GB at 8192 vs 18.57 GB at the full 262144), so there is no
   * reason to run this call tight.
   */
  private numCtxFor(transcript: string): number {
    const words = transcript.split(/\s+/).filter((w) => w.length > 0).length;
    const lines = transcript.split('\n').length;
    const estimated =
      Math.ceil(words * TOKENS_PER_WORD) +
      lines * TOKENS_PER_LINE +
      PROMPT_OVERHEAD_TOKENS +
      NUM_PREDICT;

    const bucketed = Math.max(CTX_MIN, Math.ceil(estimated / CTX_BUCKET) * CTX_BUCKET);
    const wanted = Math.max(bucketed, this.options.numCtx || 0);

    if (wanted > CTX_MAX) {
      throw new Error(
        `Single-call chaptering needs a context window of about ${wanted} tokens for this ` +
          `${words}-word transcript, which is beyond the ${CTX_MAX}-token limit of the model. ` +
          `Use the 5-stage chapter pipeline for a transcript this long.`
      );
    }
    return wanted;
  }

  // ------------------------------------------------------------------------ the call

  private checkCancelled(): void {
    if (this.options.abortSignal?.aborted || this.options.cancelCallback?.()) {
      throw new Error('Chapter generation cancelled by user');
    }
  }

  /**
   * The one request.
   *
   * /api/generate, not /api/chat: this model reasons by default, and on /api/chat that
   * reasoning lands in `message.thinking` while `message.content` comes back empty.
   * /api/generate returns `response` and `thinking` as separate fields.
   *
   * `think: false`, temperature 0, seed 0 and format json are the exact configuration the
   * 2026-08-21 experiment measured. Reasoning left on would spend this call's output budget
   * before the chapter list starts.
   */
  private async ask(prompt: string, numCtx: number): Promise<unknown> {
    this.checkCancelled();
    const model = this.options.model;

    let data: any;
    try {
      const response = await this.client.post(
        '/api/generate',
        {
          model,
          prompt,
          stream: false,
          format: 'json',
          think: false,
          keep_alive: KEEP_ALIVE,
          options: {
            temperature: 0,
            seed: 0,
            num_ctx: numCtx,
            num_predict: NUM_PREDICT,
          },
        },
        { timeout: CALL_TIMEOUT_MS, signal: this.options.abortSignal }
      );
      data = response.data;
    } catch (error: any) {
      if (isAbortError(error)) {
        throw new Error(`Single-call chaptering was cancelled by the user (model ${model})`);
      }
      const status = error?.response?.status;
      const detail = error?.response?.data?.error || error?.message || 'unknown error';
      if (status === 404) {
        throw new Error(
          `Single-call chaptering needs Ollama model "${model}", which is not installed. ` +
            `Pull it with: ollama pull ${model}`
        );
      }
      if (error?.code === 'ECONNABORTED' || error?.code === 'ETIMEDOUT') {
        throw new Error(
          `Single-call chaptering timed out after ${CALL_TIMEOUT_MS / 1000}s (model ${model})`
        );
      }
      throw new Error(`Single-call chaptering failed (model ${model}): ${detail}`);
    }

    if (data?.done_reason === 'length') {
      throw new Error(
        `Single-call chaptering hit the ${NUM_PREDICT}-token output limit, so its chapter list is ` +
          `truncated (${data?.eval_count ?? 'unknown'} tokens generated)`
      );
    }

    log.info(
      `[ChapterSingleCall] answered in ${Math.round((data?.total_duration || 0) / 1e9)}s ` +
        `(${data?.prompt_eval_count ?? '?'} prompt tokens, ${data?.eval_count ?? '?'} generated)`
    );
    return data?.response;
  }

  /** Release the model. Housekeeping — a failure costs VRAM until Ollama's timer fires. */
  private async unloadModel(): Promise<void> {
    try {
      await this.client.post(
        '/api/generate',
        { model: this.options.model, prompt: '', keep_alive: 0 },
        { timeout: 30_000 }
      );
    } catch (error: any) {
      log.warn(`[ChapterSingleCall] Could not unload "${this.options.model}": ${error?.message || error}`);
    }
  }

  // ------------------------------------------------------------------------ parsing

  /** The response as chapters, or an exception. Nothing here repairs a malformed answer. */
  private parseChapters(response: unknown): RawChapter[] {
    if (typeof response !== 'string' || response.trim().length === 0) {
      throw new Error('Single-call chaptering got an empty response from the model');
    }

    const match = response.match(/\{[\s\S]*\}/);
    if (!match) {
      throw new Error(
        `Single-call chaptering got no JSON object back: ${response.slice(0, 300)}`
      );
    }

    let parsed: any;
    try {
      parsed = JSON.parse(match[0]);
    } catch (error) {
      throw new Error(
        `Single-call chaptering could not parse the model's JSON ` +
          `(${error instanceof Error ? error.message : String(error)}): ${match[0].slice(0, 300)}`
      );
    }

    const list = parsed?.chapters;
    if (!Array.isArray(list)) {
      throw new Error(
        `Single-call chaptering expected {"chapters": [...]}, got keys: ` +
          `${Object.keys(parsed || {}).join(', ') || '(none)'}`
      );
    }

    const violations: string[] = [];
    const chapters: RawChapter[] = [];
    list.forEach((entry: any, index: number) => {
      const quote = typeof entry?.quote === 'string' ? entry.quote.trim() : '';
      const title = typeof entry?.title === 'string' ? entry.title.trim() : '';
      const summary = typeof entry?.summary === 'string' ? entry.summary.trim() : '';
      if (quote.length === 0) violations.push(`chapter ${index + 1} has no "quote"`);
      if (title.length === 0) violations.push(`chapter ${index + 1} has no "title"`);
      if (summary.length === 0) {
        violations.push(`chapter ${index + 1} ("${title || 'untitled'}") has no "summary"`);
      }
      chapters.push({ quote, title, summary });
    });

    if (violations.length > 0) {
      throw new Error(
        `Single-call chaptering returned ${violations.length} malformed chapter field(s):\n` +
          violations.map((v) => `  - ${v}`).join('\n')
      );
    }
    return chapters;
  }

  // -------------------------------------------------------------- quote -> timestamp

  /**
   * Every quote measured against the caption word stream, or an exception listing the ones
   * that could not be.
   *
   * STRICTER than the pipeline's mapQuote, deliberately. That one falls back to a best
   * fractional match over a ~90-second window because it already knows roughly where the
   * boundary is and is only refining it. Here the quote IS the only evidence of where the
   * chapter starts, over the whole video, so it has to be exact and it has to be unique:
   * a fractional match across a 3-hour word stream is a coincidence, and a quote that
   * appears twice does not say which occurrence it meant.
   *
   * Matching is on normalized words (lowercased, apostrophes dropped, punctuation and
   * whitespace collapsed) because the model reliably reproduces the words of a caption
   * line and not its punctuation.
   *
   * A dual-track transcript has more than one FAITHFUL reading, and the search covers all
   * of them: the flattened time-ordered stream, and (when the transcript is tagged) each
   * speaker's own stream. Both readings were observed on one 43-minute dual-track
   * transcript, in opposite directions:
   *
   *  - `Jesse Deplantis said "All that you cannot do` — one continuous clip sentence, but
   *    the host said the word "my" over the middle of it, so in time order those words are
   *    not adjacent. Found in the clip's own stream.
   *  - `on we go. dude left here is Gene Bailey` — read straight down the page across a
   *    speaker switch, one word from the clip and the rest from the host. Found in the
   *    flattened stream and in neither speaker's.
   *
   * Neither is the model inventing anything, and both point at the same second either way.
   * What is NOT relaxed is uniqueness: hits are collapsed by resolved TIME, and a quote
   * that lands on more than one distinct time is still a failure, because then nothing
   * says which one it meant. An untagged transcript has one reading and this is a no-op.
   */
  private resolveQuotes(chapters: RawChapter[], streams: WordStream[]): ResolvedChapter[] {
    const violations: string[] = [];
    const resolved: ResolvedChapter[] = [];

    chapters.forEach((chapter, index) => {
      const label = `chapter ${index + 1} ("${chapter.title}")`;
      const words = normalizeWords(chapter.quote);

      if (chapter.quote.length < MIN_QUOTE_CHARS || words.length < MIN_QUOTE_WORDS) {
        violations.push(
          `${label} has a degenerate quote ${JSON.stringify(chapter.quote)} — ` +
            `a chapter start must be quoted with at least ${MIN_QUOTE_WORDS} words`
        );
        return;
      }

      const probe = words.slice(0, QUOTE_PROBE_WORDS);
      const times = new Set<number>();
      for (const stream of streams) {
        for (const index of this.findOccurrences(probe, stream)) {
          times.add(stream.times[index]);
        }
      }
      const hits = [...times].sort((a, b) => a - b);

      if (hits.length === 0) {
        violations.push(
          `${label} quotes ${JSON.stringify(chapter.quote)}, which does not appear in the transcript`
        );
        return;
      }
      if (hits.length > 1) {
        violations.push(
          `${label} quotes ${JSON.stringify(chapter.quote)}, which appears ${hits.length} times in the ` +
            `transcript (at ${hits.map(formatClock).join(', ')}) — ` +
            `there is no way to tell which one it meant`
        );
        return;
      }

      resolved.push({ ...chapter, startSec: hits[0] });
    });

    if (violations.length > 0) {
      throw new Error(
        `Single-call chaptering could not measure ${violations.length} of its ${chapters.length} ` +
          `chapter start(s):\n${violations.map((v) => `  - ${v}`).join('\n')}`
      );
    }
    return resolved;
  }

  /** Every position in the word stream where this exact word sequence starts. */
  private findOccurrences(probe: string[], stream: WordStream): number[] {
    const hits: number[] = [];
    const last = stream.words.length - probe.length;
    for (let i = 0; i <= last; i++) {
      let match = true;
      for (let k = 0; k < probe.length; k++) {
        if (stream.words[i + k] !== probe[k]) {
          match = false;
          break;
        }
      }
      if (match) hits.push(i);
    }
    return hits;
  }

  // ---------------------------------------------------------------------- validation

  /**
   * Everything the prompt asked for, checked in code, all at once.
   *
   * Collected rather than short-circuited so one run tells the operator everything that
   * was wrong with the answer. Then it throws — there is no repair path and no retry. The
   * prompt moves this model's cadence by an order of magnitude but it does not pin it, and
   * a list that misses these checks is not a list that a nudge would fix.
   */
  private validate(chapters: ResolvedChapter[], budget: ChapterBudget, durationSeconds: number): void {
    const violations: string[] = [];

    if (chapters.length < MIN_CHAPTERS) {
      violations.push(
        `only ${chapters.length} chapter(s) came back; YouTube needs at least ${MIN_CHAPTERS}`
      );
    }
    if (chapters.length < budget.lo || chapters.length > budget.hi) {
      violations.push(
        `${chapters.length} chapters came back for a ${Math.round(durationSeconds / 60)}-minute video, ` +
          `outside the ${budget.lo}-${budget.hi} the shipped cadence allows ` +
          `(target ${budget.target})`
      );
    }

    if (chapters.length > 0 && chapters[0].startSec > FIRST_CHAPTER_MAX_START_SECONDS) {
      violations.push(
        `the first chapter ("${chapters[0].title}") starts at ${formatClock(chapters[0].startSec)}, ` +
          `so the opening of the video belongs to no chapter — its quote must come from the first ` +
          `${FIRST_CHAPTER_MAX_START_SECONDS}s of the transcript`
      );
    }

    for (let i = 1; i < chapters.length; i++) {
      const previous = chapters[i - 1];
      const current = chapters[i];
      if (current.startSec <= previous.startSec) {
        violations.push(
          `chapter ${i + 1} ("${current.title}") starts at ${formatClock(current.startSec)}, ` +
            `which is not after chapter ${i} ("${previous.title}") at ${formatClock(previous.startSec)} — ` +
            `the chapters are out of order`
        );
        continue;
      }
      const gap = current.startSec - previous.startSec;
      if (gap < budget.minGapSeconds) {
        violations.push(
          `chapter ${i + 1} ("${current.title}") starts ${Math.round(gap)}s after chapter ${i} ` +
            `("${previous.title}"), under the ${Math.round(budget.minGapSeconds)}s minimum for a ` +
            `${Math.round(durationSeconds / 60)}-minute video`
        );
      }
    }

    const seenQuotes = new Map<string, number>();
    const seenTitles = new Map<string, number>();
    chapters.forEach((chapter, index) => {
      const quoteKey = normalizeWords(chapter.quote).slice(0, QUOTE_PROBE_WORDS).join(' ');
      const first = seenQuotes.get(quoteKey);
      if (first !== undefined) {
        violations.push(
          `chapter ${index + 1} ("${chapter.title}") repeats the quote of chapter ${first + 1}: ` +
            `${JSON.stringify(chapter.quote)}`
        );
      } else {
        seenQuotes.set(quoteKey, index);
      }

      const titleKey = chapter.title.toLowerCase();
      const firstTitle = seenTitles.get(titleKey);
      if (firstTitle !== undefined) {
        violations.push(
          `chapter ${index + 1} has the same title as chapter ${firstTitle + 1}: "${chapter.title}"`
        );
      } else {
        seenTitles.set(titleKey, index);
      }
    });

    if (violations.length > 0) {
      throw new Error(
        `Single-call chaptering produced a chapter list that failed ${violations.length} check(s):\n` +
          violations.map((v) => `  - ${v}`).join('\n')
      );
    }
  }

  // ---------------------------------------------------------------------- assembling

  /**
   * The validated list as Chapters.
   *
   * The first chapter is published at 0:00 rather than at its own resolved quote. That is
   * a code guarantee, not a correction of the model: YouTube requires a 0:00 marker, the
   * sealed pipeline pins its first chapter to 0 the same way, and validate() has already
   * confirmed the quote landed inside the opening seconds of the transcript
   * (FIRST_CHAPTER_MAX_START_SECONDS), so the chapter's name covers what the pin extends
   * it over.
   */
  private toChapters(chapters: ResolvedChapter[], durationSeconds: number): Chapter[] {
    return chapters.map((chapter, index) => ({
      timestamp: TimeUtils.secondsToYoutubeTime(index === 0 ? 0 : chapter.startSec),
      title: chapter.title,
      sequence: index,
      endTimestamp: TimeUtils.secondsToYoutubeTime(
        index < chapters.length - 1 ? chapters[index + 1].startSec : durationSeconds
      ),
      detail: chapter.summary,
    }));
  }
}
