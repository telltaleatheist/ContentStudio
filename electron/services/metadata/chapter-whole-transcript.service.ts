/**
 * Chapter Service — ONE call reads the whole transcript and names the chapters
 *
 * THE FOURTH CHAPTER ARCHITECTURE, and a deliberate REVERSAL to the shape of the first.
 * Three are deleted: the sealed 5-stage 14B pipeline (~390 one-question calls a video), the
 * 27B single call it replaced, and the embedding pipeline that replaced both on 2026-08-22.
 * CHAPTERING.md's 2026-08-22 reversal section carries the measurement; the short version is
 * the reason this file exists, so it belongs with the code:
 *
 *   The embedding pipeline found 43% of the labelled boundaries at 60 seconds (12 of 28) at
 *   32% precision. Its failure was not tuning — the best configuration in a full parameter
 *   sweep reached 61% — it was the premise. A cosine valley between two 90-second blocks
 *   measures how much the VOCABULARY changed. A commentary video that plays four clips of
 *   four different people all saying the same thing about Islam has one vocabulary and four
 *   chapters, and there is no valley to find. Nine of the eleven boundaries the best sweep
 *   still missed had no valley at the labelled second at all.
 *
 *   A 27B reading the WHOLE transcript in one call found 86% of them at 60 seconds (24 of
 *   28), 79% precision, and every boundary in the clear-split class inside 30 seconds
 *   (14 of 14). It is not seeing a different signal better; it is seeing a different signal.
 *   Recognising "this is a new source" is reading comprehension.
 *
 * THE ARCHITECTURE, in full:
 *
 *   1. CHAPTERS   LLM     a ROLLING WINDOW of one-or-more calls (usually exactly one): as
 *                         much transcript as fits, no timestamps, the window's runtime
 *                         stated once as a fact, a cadence BAND graduated by that runtime —
 *                         and the answer is PLAIN TEXT, one verbatim first sentence per
 *                         line, per the operator's 2026-08-24 no-JSON ruling. The model
 *                         derives the COUNT. A longer transcript rolls: the next window
 *                         starts at the last boundary the previous one mapped, so the tail
 *                         is re-read in full context and no seam splits a subject.
 *                         ON THE LOCAL TRANSPORT each window is asked FIVE TIMES and the
 *                         boundaries are put to a vote (2026-08-30 campaign — see the
 *                         consensus constants below for the measurement); the cloud path
 *                         keeps its measured-good single ask.
 *   2. MAP        code    each quoted sentence -> a second, forwards only, against that
 *                         window's caption word stream, per sample. Unmappable casts no
 *                         vote (single-sample: is DROPPED and named), never guessed at.
 *                         Then the VOTE: mapped times cluster within 25s and a boundary is
 *                         published when >=3 of 5 samples agree on it.
 *   3. SCAFFOLD   LLM     one whole-video call (windowed on long videos): the people and
 *                         organisations in the video with STANDARD SPELLINGS, shown to
 *                         every detail call so all chapters spell a garbled name the same
 *                         way (2026-08-30 campaign: one person, four spellings, without it).
 *   4. DETAIL     LLM     one call per chapter, from its RAW transcript: a title line and
 *                         the 20-45 word prose the description and tag stages condition on.
 *                         It sees the last few titles already written, and names what is
 *                         NEW rather than repeating their angle.
 *
 * 5-per-window + 1 + N calls locally, N being 3 to 8; 1 + 1 + N on the cloud.
 *
 * WHAT THE MODEL DECIDES AND WHAT CODE DECIDES. The model decides where the chapters are,
 * how many there are, and what they are called. Code decides nothing about content: it
 * states the runtime, measures the quotes, and refuses the ones that do not measure. Every
 * deleted architecture computed a chapter COUNT in code from a cadence table and handed the
 * model a target; that is what turned a rhetorical pause into a boundary on a video with
 * four real ones. There is no code-computed count anywhere in this file, and the cadence
 * lives in the prompt body where the model can apply it to content it can see.
 *
 * NO SECOND PATH. The embedding scorer and its lexical TF-IDF fallback are deleted, not kept
 * behind a flag. Two chapter architectures in one tree means one of them runs when something
 * goes wrong, which is this app's cardinal rule violated by construction: a fallback is an
 * unexpected code path in production.
 *
 * FAILURE POLICY, unchanged in substance from the pipeline this replaces — every degradation
 * is DECLARED: logged, counted in the run's stats, and pushed into `warnings` so the job
 * report says it happened. There is no silent recovery anywhere in this file.
 *
 *  - the ONE chapter call answers unusably -> the run THROWS (no re-asks anywhere —
 *                                  operator, 2026-08-24). There are no chapters to
 *                                  degrade to; resolveChapters records `chaptersSkipped` and
 *                                  the user sees that the item has none and why.
 *  - a quote will not map        -> that chapter is DROPPED and a warning names it and its
 *                                  quote. NOT kept at an approximate time: the quote is the
 *                                  only positional evidence a whole-transcript call
 *                                  produces, so there is no weaker second measurement to
 *                                  fall back on and an interpolated time would be a
 *                                  confident wrong answer wearing a measurement's clothes.
 *  - a quote maps BACKWARDS      -> the same: dropped, and the warning says the sentence was
 *                                  found earlier in the video than the chapter before it.
 *  - a detail answer fails       -> that chapter keeps its title and carries no detail, and
 *                                  a warning says the description was written without it.
 *  - a title names something     -> the title is KEPT exactly as written and a warning names
 *    its chapter never said,        it. Never a rewrite, never a block, never a re-ask: the
 *    or narrates an actor           operator curates the output, and a fault that recurs is
 *                                  a prompt problem to fix at the source.
 *  - the transcript is uncased   -> the entity scaffold and the grounding check cannot run,
 *                                  and a warning says the titles were written without them.
 *
 * What is NOT a degradation and therefore throws: a transport failure (Ollama unreachable,
 * model not installed, request timeout), and a chapter span with no words in it (the
 * boundaries came from cue times, so an empty span means the arithmetic is wrong).
 *
 * ONE TITLE SOURCE (which is what THE TITLE RULE used to arbitrate). Stage 1's answer is
 * bare quote lines — it names nothing — so every chapter's title comes from its own detail
 * call, the one that read that chapter's raw transcript. There is no second source left to
 * fight it, and the 0:00 opening chapter is named exactly like every other.
 *
 * The result is the SAME ChapterPipelineResult every deleted path returned, so promo
 * exclusion, `chaptersSkipped`, the description's chapter lines and report rendering all
 * work against it without knowing which architecture produced it.
 */

import axios, { AxiosInstance } from 'axios';
import * as log from 'electron-log';
import { SRTSegment } from './whisper.service';
import { Chapter, TimeUtils } from './chapter-generator.service';
import {
  buildCues,
  cadenceBandFor,
  mapChapterQuotes,
  normalizeWords,
  runtimePhrase,
  voteBoundaries,
  ChapterClaim,
  ChapterPipelineResult,
  Cue,
} from './chapter-transcript';
import { CHAPTER_PROMPTS, ChapterGrain } from './chapter-prompts';
import { bucketNumCtx, estimateTokens, TOKENS_PER_WORD, OLLAMA_KEEP_ALIVE } from './ollama-json';
import { askOllamaPlain, parseLines, parseTitleDetail } from './plain-call';
import { JobModelLifecycle } from './model-lifecycle';
import { formatPrompt } from './system-prompts';
import { topEntities, transcriptCasing } from './entity-extraction';
import { groundTitle, narratesAnActor } from './chapter-title-quality';

/** The two stages that make model calls, and therefore the two that report progress. */
export type ChapterStage = 'chapters' | 'detail';

// =============================================================================
// CONSTANTS
// =============================================================================

/** Keeps the model resident across the run without unloading anything else. */
const KEEP_ALIVE = OLLAMA_KEEP_ALIVE;

/**
 * Output budget per generation call.
 *
 * Sized for THINKING, not for the answer: a 3-8 chapter list of quoted sentences is a few
 * hundred tokens and a detail answer ~120, but these models reason first and the reasoning
 * has to fit alongside the prompt in the context window. 4096 was measured to be too small
 * for this shape of call — a 72-minute podcast hit the ceiling on both the first ask and the
 * re-ask and produced NOTHING — so the budget is 8192 and the extra 4096 is reasoning
 * headroom. `think: false` is deliberately NOT sent (trap 2: it does not disable thinking,
 * it RELOCATES the reasoning into `response`, breaking the JSON).
 */
const NUM_PREDICT = 8192;

/** Hard refusal point. A prompt that does not fit is a prompt that lies about its span. */
const CTX_MAX = 32768;

/**
 * The whole-transcript call prefills every word of the video before it emits a token, and on
 * a two-hour podcast above the GPU ceiling that is measured in minutes rather than seconds.
 */
const CHAPTERS_TIMEOUT_MS = 900_000;

/** A detail call reads ONE chapter and is the size the deleted pipeline's summarize call was. */
const DETAIL_TIMEOUT_MS = 600_000;

/**
 * How many proper nouns the per-chapter entity scaffold offers.
 *
 * Eight is a chapter's worth of names on this content class. A longer list stops being a
 * scaffold and starts being a checklist the model tries to satisfy.
 */
const ENTITY_SCAFFOLD_LIMIT = 8;

/*
 * No sampling parameters are set anywhere in this pipeline (operator's ruling 2026-08-24:
 * provider defaults everywhere; a model that cannot perform there is replaced, not tuned) —
 * WITH ONE MEASURED EXCEPTION, below: stage 1's consensus samples set a temperature, because
 * diversity across deliberate repeat-asks is their mechanism, not a tuning rescue. The
 * re-ask machinery that once rode on the old temperature-0 design is GONE with the
 * no-re-asks ruling of the same day, and consensus is not it coming back: a re-ask asks
 * again because the first answer failed; consensus asks five times because ONE answer of
 * this question is a coin-flip, and publishes only what most of them agree on.
 */

/**
 * STAGE 1 CONSENSUS (2026-08-30 overnight campaign; ledger and run-book in
 * /Volumes/Callisto/ContentStudio/.contentstudio/chapter-campaign/).
 *
 * The measurement that forced this: two stage-1 asks of the SAME prompt on the SAME video at
 * provider defaults returned 19 and 14 chapters. Variance, not prompt wording, was the
 * dominant failure — sliver chapters, missed plugs and drifting boundaries all traced to it.
 * Freezing it with low temperature locked in one mediocre reading instead. What matched the
 * shipped baseline's boundaries on the measured corpus (including every isolated ad read) was:
 * ask five times at temperature 0.7, cluster the mapped boundary times within 25 seconds, and
 * keep the clusters at least three samples voted for.
 *
 * LOCAL TRANSPORT ONLY. The cloud models were already measured single-call good (2026-08-24,
 * u2/dont-be-a-sucker runs), a cloud call costs real money per sample, and the campaign's
 * evidence is all from the local 27B — so the cloud path keeps its one ask, which is exactly
 * what SAMPLES=1 degrades to. One pipeline, one code path, two sample counts.
 */
const STAGE1_SAMPLES_LOCAL = 5;
const STAGE1_SAMPLE_TEMPERATURE = 0.7;
const CONSENSUS_CLUSTER_SECONDS = 25;
/** ceil(samples * this) votes keep a boundary: 3 of 5, and 1 of 1 on the cloud path. */
const CONSENSUS_VOTE_FRACTION = 0.6;


/**
 * Above this the KV cache spills off the GPU and every token slows down. It is a PERFORMANCE
 * ceiling, not a correctness one: a run that needs more gets more, and says so in a warning,
 * because a truncated prompt would be a wrong answer while a slow one is only a slow one.
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

export interface WholeTranscriptChapterOptions {
  /** Ollama base URL. */
  host: string;
  /** Bare Ollama model name for both stages, as `ollama list` prints it. */
  model: string;
  /**
   * The JOB's model residence. This stage holds its model here instead of releasing it when it
   * finishes: the next stage usually wants the same one, and re-streaming 17GB of weights
   * between two stages of one job is what froze the operator's machine. The job releases the
   * set once, at the end (model-lifecycle.ts).
   *
   * It also carries the num_ctx ratchet, so a stage that shares this model with the field calls
   * does not size a SMALLER window than the one already resident and reload it for nothing.
   */
  lifecycle: JobModelLifecycle;
  /** Floor for the context window, never a ceiling. The run sizes its own (trap 3). */
  numCtx?: number;
  /** The video's title or filename — the detail call's second required context input. */
  videoTitle?: string;
  /**
   * What stage 1 detects: the operator's pick from the queue-time selector (LEDGER #170).
   * REQUIRED — the caller states the grain; this service never guesses one.
   */
  grain: ChapterGrain;
  /**
   * The channel this video is for, when the caller already has it: give the model whatever
   * real context exists. OPTIONAL and never derived — the caller passes the loaded prompt
   * set's name, and an absent one simply does not appear in the prompt.
   */
  channelName?: string;
  /**
   * Cloud transport for both stages, present exactly when the writing model resolved to a
   * cloud option (resolveChapterModelOption). The caller passes AIManagerService's
   * runPlainRequest bound to itself; `model` is then the provider-prefixed string that method
   * routes on ("claude:claude-sonnet-5") rather than an Ollama tag. Null is an EMPTY answer —
   * one decision for the caller — and a transport failure throws, same as the local branch.
   *
   * When present, nothing local happens: no context-window sizing (the provider owns its
   * window), no model residency (`lifecycle` holds nothing), no Ollama traffic. The
   * local path is otherwise UNTOUCHED — this is a second transport inside `ask()`, not a
   * second pipeline, and every stage, retry rule and warning reads identically on both.
   */
  cloudPlain?: (prompt: string, model: string, what: string) => Promise<string | null>;
  /**
   * The rolling window's input ceiling on the cloud transport, in characters — the caller's
   * direct-pass ceiling. Required with cloudPlain: this service must not import the cloud
   * ceiling from the module that imports it back.
   */
  cloudWindowChars?: number;
  /**
   * The channel's promoted_items list (prompts/channels/*.yml), filled into the prompts'
   * {promoted_items} slot: the chapter call uses it to bound plug chapters and keep passing
   * mentions out of content labels; the detail calls to keep them out of titles/summaries.
   */
  promotedItems?: string[];
  onProgress?: (stage: ChapterStage, done: number, total: number) => void;
  cancelCallback?: () => boolean;
  /**
   * Aborts the request in flight. `cancelCallback` is polled between calls and cannot reach
   * inside one — and it is inside one that a stalled stage spends its minutes.
   */
  abortSignal?: AbortSignal;
}

interface WorkingChapter {
  startSec: number;
  endSec: number;
  title: string;
  detail: string;
  /** Where `title` came from, so the run can say which call is worth a look. */
  titleSource: 'detail call' | 'opening words';
}

/** What one stage-1 window came back with. */
interface WindowAnswer {
  claims: ChapterClaim[];
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

/** Cue text, in order, single-spaced — the same string the quote matcher searches. */
function plainTranscript(cues: Cue[]): string {
  return cues.map((c) => c.text.replace(/\s+/g, ' ').trim()).join(' ');
}

/**
 * Read stage 1's plain answer into quote claims.
 *
 * One copied sentence per line, per the prompt; the label field is structurally empty because
 * stage 1 no longer names anything — every chapter is named by its own detail call. A line is
 * the measurement, and a lineless answer is no answer (parseLines throws; the caller's
 * failure policy owns that).
 */
function readQuoteLines(text: string, what: string): ChapterClaim[] {
  return parseLines(text, what).map((quote) => ({ label: '', quote }));
}

// =============================================================================
// SERVICE
// =============================================================================

export class WholeTranscriptChapterService {
  private readonly client: AxiosInstance;
  private readonly options: WholeTranscriptChapterOptions;
  private readonly warnings: string[] = [];
  private calls = 0;
  /** The whole video, single-spaced — the grounding context judgeTitle checks names against. */
  private wholeTranscriptText = '';
  private numCtx = 0;
  private speakerTagged = false;
  private groundingUsable = false;
  /** The whole-video name list (standard spellings), comma-joined. Empty when it could not be written. */
  private nameScaffold = '';

  constructor(options: WholeTranscriptChapterOptions) {
    this.options = options;
    this.client = axios.create({
      baseURL: options.host,
      headers: { 'Content-Type': 'application/json' },
    });
  }

  /**
   * Run all three stages over one video's caption segments.
   *
   * Throws only on the failures that mean there is no chapter list to publish (the chapter
   * call answered unusably twice, Ollama unreachable, model missing, timeout, a span whose
   * arithmetic is wrong). Everything else comes back as a DECLARED mode: counted in `stats`
   * and named in `warnings`.
   */
  async generate(srtSegments: SRTSegment[]): Promise<ChapterPipelineResult> {
    if (!srtSegments || srtSegments.length === 0) {
      throw new Error('Chapter generation needs caption segments; none were supplied');
    }

    const cues = buildCues(srtSegments);
    this.wholeTranscriptText = plainTranscript(cues);
    const durationSeconds = cues[cues.length - 1].endSec;
    const band = cadenceBandFor(durationSeconds);

    // Speaker tags are all-or-nothing, exactly as every deleted path decided it: a prompt
    // that announces HOST:/CLIP: over a transcript where half the lines have none is a
    // prompt that lies, and the model cannot tell which half.
    //
    // "RESOLVES TO A SIDE" NOW INCLUDES UNSURE, which is what changed when voice tagging
    // arrived (2026-08-23). The gate is unchanged in form and in intent — every cue must carry
    // an attribution — but a cue attributed to NOBODY is carrying one. It is the honest answer
    // for a caption that straddles a cut, the tagged prompt is written to handle it, and
    // treating it as "missing" would have thrown away the tags on the other 94% of a video over
    // the 6% that genuinely contain two voices in one line.
    const rolesResolved = cues.filter((c) => c.role !== null).length;
    this.speakerTagged = rolesResolved === cues.length;
    if (!this.speakerTagged && rolesResolved > 0) {
      this.warn(
        `only ${rolesResolved} of ${cues.length} caption segments carry a usable speaker attribution, ` +
          `so the chapter details were written WITHOUT speaker tags (attribution between the host and the ` +
          `footage may be inverted)`
      );
    }

    // The entity scaffold and the grounding check both read capitalization as the name
    // signal, so a transcript without sentence casing silently disables both. Measured once
    // per run and DECLARED when it fails, because "no entities in this chapter" and "no
    // capital letters in this transcript" are different facts with the same symptom.
    const casing = transcriptCasing(cues.map((c) => c.text).join(' '));
    this.groundingUsable = casing.usable;
    if (!casing.usable) {
      this.warn(
        `this transcript cannot be read for proper nouns — ${casing.reason} — so chapter details were ` +
          `written with no per-chapter name scaffold, and the check that a title's names come from its ` +
          `own transcript could not run`
      );
    }

    const transcript = plainTranscript(cues);
    const runtime = runtimePhrase(durationSeconds);

    log.info(
      `[Chapters] ${formatClock(durationSeconds)} of captions -> ${cues.length} cues, ` +
        `stated to the model as "${runtime}" (${band} band), ` +
        `${this.speakerTagged ? 'speaker-tagged' : 'untagged'}`
    );

    // ---- stage 1: the rolling window -------------------------------------------
    // The context window is an Ollama concern: sized, ratcheted and GPU-checked only on the
    // local transport. A cloud provider owns its own window and the sizing would record a
    // residency for a model that never loads.
    if (!this.options.cloudPlain) this.numCtx = this.runNumCtx(transcript);
    const windowed = await this.rollingWindows(cues);
    const starts = windowed.starts;
    const claimed = windowed.claimed;
    const mapped = starts.length;
    const dropped = windowed.dropped;

    // The opening chapter is at 0:00 and the model usually does not report it: the prompt
    // asks for the TURNS, and the opening of a video is not a turn. A model that reports it
    // anyway produced a redundant boundary (code puts the first chapter at 0:00 regardless),
    // which the window loop already deduped along with every other at-window-start line.
    const spans: { startSec: number; endSec: number }[] = [
      {
        startSec: 0,
        endSec: starts.length > 0 ? starts[0] : durationSeconds,
      },
      ...starts.map((startSec, i) => ({
        startSec,
        endSec: i + 1 < starts.length ? starts[i + 1] : durationSeconds,
      })),
    ];

    // ---- the name scaffold: one whole-video list every detail call reads ------
    this.nameScaffold = await this.wholeVideoNameScaffold(cues);

    // ---- stage 3: one call per chapter for its detail -------------------------
    const working = await this.detailChapters(spans, cues);

    const chapters = this.toChapters(working, durationSeconds);
    log.info(
      `[Chapters] ${chapters.length} chapters in ${this.calls} model calls` +
        (dropped > 0
          ? this.options.cloudPlain
            ? ` (${dropped} dropped for an unmeasurable opening sentence)`
            : ` (${dropped} candidate boundary(ies) failed the consensus vote or could not be measured)`
          : '') +
        ': ' +
        chapters.map((c) => `${c.timestamp} ${c.title}`).join(' | ')
    );

    return {
      chapters,
      subjects: chapters.map((c) => c.title),
      subjectDetails: working.map((c) => ({ about: c.title, detail: c.detail })),
      warnings: [...this.warnings],
      stats: {
        durationSeconds,
        band,
        chaptersClaimed: claimed,
        chaptersMapped: mapped,
        chaptersDropped: dropped,
        // Structurally zero: see ChapterRunStats.approxStarts. A chapter here is measured
        // or it is dropped; there is no third state to count.
        approxStarts: 0,
        speakerTagged: this.speakerTagged,
        calls: this.calls,
      },
    };
  }

  // ---------------------------------------------------------------------- stage 1

  /**
   * The input budget of ONE stage-1 window, in transcript WORDS.
   *
   * Local: what fits beside the prompt overhead and the output budget inside CTX_MAX. Cloud:
   * the caller's direct-pass ceiling, converted at this codebase's chars-per-word estimate.
   * Both are ceilings on the same thing — how much transcript one call may carry — expressed
   * in the unit each transport is bounded in.
   */
  /**
   * The TRACTABILITY cap on a stage-1 window, in transcript words.
   *
   * The rolling window was built for context limits, but the binding limit turned out to be
   * REASONING: the boundary decisions in one call scale superlinearly with the span it holds,
   * and the thinking scales with them. Measured on 2026-08-24: a 13-minute window succeeds
   * every time (f3, ~3.8k output tokens, both transports); a 42-minute window fails every
   * time (u2 — 8k of inline thinking truncated on the system-prompt build, then the full 16k
   * adaptive budget spent without reaching an answer). ~2,800 words is ~15-17 minutes of
   * speech: comfortably inside the measured-good regime, so a long video runs as a few
   * tractable windows chained by last-boundary instead of one call that drowns.
   *
   * RE-MEASURED THE SAME NIGHT for the cloud transport, after the minimal grain bodies
   * (LEDGER #170) collapsed the reasoning load that set the cap above: u2's full 42 minutes
   * (6,522 words) succeeded single-call on the cloud model three times running, and the
   * 41-minute dont-be-a-sucker twice — short answers, band honoured, ads to the second.
   * Windowing was ALSO the mechanism inflating chapter counts: each window is told its own
   * runtime, so each applies the grain's band to itself and the counts stack (three windows
   * of one 41-minute video produced 25 "broad" chapters where one call produces 14). So the
   * cloud cap now covers the operator's real videos in one call; the local cap keeps the
   * measured 27B limit, and a video past the cloud cap still windows — the count inflation
   * returns there, known and accepted until multi-hour content is re-measured.
   */
  private static readonly STAGE1_WINDOW_WORDS = 2800;
  private static readonly STAGE1_WINDOW_WORDS_CLOUD = 7000;

  private windowWordBudget(): number {
    const overheadChars = CHAPTER_PROMPTS.wholeTranscript(this.options.grain).length + this.promotedItemsLine().length + 64;
    if (this.options.cloudPlain) {
      const ceiling = this.options.cloudWindowChars;
      if (!ceiling || ceiling <= overheadChars) {
        throw new Error(
          `The chapter pipeline is on the cloud transport with no usable cloudWindowChars ceiling ` +
            `(got ${ceiling ?? 'none'}); the caller passes its direct-pass ceiling with the transport`
        );
      }
      // ~6 chars per English word incl. the space; deliberately conservative so a window is
      // never refused by the provider for length.
      return Math.min(
        Math.floor((ceiling - overheadChars) / 6),
        WholeTranscriptChapterService.STAGE1_WINDOW_WORDS_CLOUD
      );
    }
    const promptTokenBudget = CTX_MAX - NUM_PREDICT - 512 - estimateTokens(overheadChars);
    return Math.min(
      Math.floor(promptTokenBudget / TOKENS_PER_WORD),
      WholeTranscriptChapterService.STAGE1_WINDOW_WORDS
    );
  }

  /** The exclusive cue index where a window starting at `from` runs out of word budget. */
  private static windowEnd(cues: Cue[], from: number, budgetWords: number): number {
    let words = 0;
    for (let i = from; i < cues.length; i++) {
      words += cues[i].text.split(/\s+/).filter(Boolean).length;
      if (words > budgetWords && i > from) return i;
    }
    return cues.length;
  }

  /**
   * Stage 1 as a ROLLING WINDOW (operator's design, 2026-08-24).
   *
   * Send as much transcript as fits, starting at the current position; keep every boundary
   * the window maps; advance the position to the LAST mapped boundary and send everything
   * from there forward in the next window. The tail past the last boundary is deliberately
   * RE-READ in full context, which is the whole point: no artificial seam ever splits a
   * subject. A transcript that fits one window is exactly the single-call architecture — the
   * loop runs once and reaches the end.
   *
   * A window's own start is already a chapter start (0:00 for window 1, a mapped boundary
   * for every later one), so a returned line mapping at or before it is a redundant echo and
   * is deduped — which is the same handling the 0:00 opening report has always had.
   *
   * PROGRESS IS GUARANTEED. Every round advances the position strictly: a window that maps a
   * fresh boundary advances to it, and the one degenerate case — a window that does NOT reach
   * the video's end and returns nothing past its own start — advances to the window's end,
   * which introduces the one artificial seam this design otherwise eliminates, and WARNS
   * naming the timestamps. A declared degradation, never a silent one.
   */
  private async rollingWindows(cues: Cue[]): Promise<{ starts: number[]; claimed: number; dropped: number }> {
    const budgetWords = this.windowWordBudget();
    const starts: number[] = [];
    const ranges: string[] = [];
    let claimed = 0;
    let dropped = 0;
    let from = 0;

    while (from < cues.length) {
      const to = WholeTranscriptChapterService.windowEnd(cues, from, budgetWords);
      const windowCues = cues.slice(from, to);
      const reachesEnd = to >= cues.length;
      const windowStartSec = windowCues[0].startSec;
      const windowEndSec = windowCues[windowCues.length - 1].endSec;
      ranges.push(`${formatClock(windowStartSec)}-${formatClock(windowEndSec)}`);

      // CONSENSUS SAMPLING (see the constants block): several asks of the same window on the
      // local transport, one on the cloud. Each sample's quotes are measured exactly as one
      // call's always were; what changes is that a boundary is published on AGREEMENT rather
      // than on one sample's say-so.
      const sampleCount = this.options.cloudPlain ? 1 : STAGE1_SAMPLES_LOCAL;
      const sampleTimes: number[][] = [];
      for (let sample = 1; sample <= sampleCount; sample++) {
        const answer = await this.askWindow(windowCues, ranges.length, sample, sampleCount);
        if (!answer) continue; // a lost vote, already warned about — the vote absorbs it
        if (sampleCount === 1) claimed += answer.claims.length;

        const mappings = mapChapterQuotes(answer.claims, windowCues);
        for (const mapping of mappings) {
          if (mapping.status === 'mapped') {
            log.info(
              `[Chapters] sample ${sample}/${sampleCount} boundary at ${formatClock(mapping.time!)}: ` +
                `"${mapping.quote.slice(0, 60)}"`
            );
            continue;
          }
          // Single-sample: the old declared drop — that quote was the only measurement there
          // was. Consensus: one sample failing to cast a vote at one spot is what the vote
          // threshold exists to absorb, so it is logged, not warned — a warning per occurrence
          // would report the mechanism working as a defect several times a run.
          if (sampleCount === 1) {
            dropped++;
            this.warn(
              mapping.status === 'out-of-order'
                ? `a chapter boundary was DROPPED: its opening sentence ("${mapping.quote.slice(0, 60)}") is in ` +
                    `this transcript at ${formatClock(mapping.wholeVideoTime!)}, which is not after the boundary ` +
                    `before it, so the model listed it out of order or quoted a sentence the speaker says twice`
                : `a chapter boundary was DROPPED: its opening sentence ("${mapping.quote.slice(0, 60)}") is not ` +
                    `in this transcript, so there is no measured time for it and nothing is guessed at`
            );
          } else {
            log.info(
              `[Chapters] sample ${sample}/${sampleCount}: a quote did not map ` +
                `("${mapping.quote.slice(0, 60)}") — that sample casts no vote there`
            );
          }
        }
        sampleTimes.push(mappings.filter((m) => m.status === 'mapped').map((m) => m.time!));
      }

      if (sampleTimes.length === 0) {
        throw new Error(
          `The chapter call on ${this.options.model} returned no usable boundary list in any of ` +
            `${sampleCount} sample(s) (see the log for what came back). Nothing is substituted and nothing ` +
            `more is asked: these calls are the chapter list, and the fix belongs at the source — the ` +
            `prompt, the window size, or the model.`
        );
      }

      // The vote. On the single-sample path every mapped time is its own one-vote cluster and
      // the threshold is 1, so this stage is exactly the old behavior there.
      const minVotes = Math.max(1, Math.ceil(sampleTimes.length * CONSENSUS_VOTE_FRACTION));
      const candidates = voteBoundaries(sampleTimes, CONSENSUS_CLUSTER_SECONDS);
      const kept = candidates.filter((c) => c.votes >= minVotes);
      if (sampleCount > 1) {
        claimed += candidates.length;
        dropped += candidates.length - kept.length;
        log.info(
          `[Chapters] consensus over ${sampleTimes.length} sample(s): ${candidates.length} candidate ` +
            `boundaries -> ${kept.length} with >=${minVotes} votes`
        );
      }

      // The window's own start is already a chapter start; a line mapping at (or before) it
      // is the redundant echo described above, not a boundary. Under consensus the echo zone
      // widens to one cluster width: at temperature 0.7 several samples quote the video's
      // SECOND sentence as a turn, which clusters into a "boundary" seconds after the start
      // (verified on the first integration run — a 5-second opening chapter), and a boundary
      // closer to the start than the vote's own resolution is the start, restated.
      const echoZoneSec = sampleCount > 1 ? CONSENSUS_CLUSTER_SECONDS : 0;
      const mapped = kept.map((c) => c.time).sort((a, b) => a - b);
      const fresh = mapped.filter((timeSec) => timeSec > windowStartSec + echoZoneSec);
      if (mapped.length > fresh.length) {
        log.info(
          `[Chapters] ${mapped.length - fresh.length} reported boundary(ies) sit at this window's own start ` +
            `(${formatClock(windowStartSec)}), which is already a chapter start — deduped`
        );
      }
      starts.push(...fresh);

      if (reachesEnd) break;
      if (fresh.length > 0) {
        const lastSec = fresh[fresh.length - 1];
        const nextFrom = cues.findIndex((c) => c.startSec >= lastSec);
        // lastSec > windowStartSec, so nextFrom is strictly past `from`: progress holds.
        from = nextFrom;
      } else {
        this.warn(
          `stage 1's window ${formatClock(windowStartSec)}-${formatClock(windowEndSec)} did not reach the end ` +
            `of the video and returned no boundary past its own start, so the next window starts at ` +
            `${formatClock(windowEndSec)} — an artificial seam this run otherwise avoids, and a subject ` +
            `spanning it may be split in two`
        );
        from = to;
      }
    }

    log.info(`[Chapters] stage 1 ran as ${ranges.length} window(s): ${ranges.join(' | ')}`);
    if (ranges.length > 1) {
      this.warn(
        `this transcript was too long for one chapter call, so stage 1 ran as ${ranges.length} rolling ` +
          `windows (${ranges.join('; ')}); each next window started at the last boundary the previous one ` +
          `found, so no seam was cut mid-subject`
      );
    }
    return { starts, claimed, dropped };
  }

  /**
   * ONE window's stage-1 call — one SAMPLE of it, under consensus.
   *
   * Single-sample (cloud): an unusable answer THROWS, exactly as it always has — no re-ask
   * (operator, 2026-08-24: "let it fail and we'll tweak things until it's right"). That call
   * IS the chapter list.
   *
   * Consensus (local, several samples): an unusable answer is ONE LOST VOTE, warned about and
   * returned as null — the other samples still are the chapter list. This is not a retry in
   * disguise: nothing is asked again because this answer failed, and a window where EVERY
   * sample fails still throws (the caller owns that). The sample temperature is the campaign's
   * measured setting; the single-sample path sends none and stays on provider defaults.
   */
  private async askWindow(
    windowCues: Cue[],
    windowNumber: number,
    sample: number,
    sampleCount: number
  ): Promise<WindowAnswer | null> {
    const spanSeconds = windowCues[windowCues.length - 1].endSec - windowCues[0].startSec;
    const prompt = formatPrompt(CHAPTER_PROMPTS.wholeTranscript(this.options.grain), {
      duration: runtimePhrase(spanSeconds),
      promoted_items: this.promotedItemsLine(),
      // Substituted last, as everywhere else in this codebase: transcript text that happens
      // to contain a brace token must not be rewritten by a later pass.
      transcript: plainTranscript(windowCues),
    });
    const windowWhat =
      windowNumber > 1 ? `this video's chapters, window ${windowNumber}` : "this video's chapters";
    const what = sampleCount > 1 ? `${windowWhat}, sample ${sample}/${sampleCount}` : windowWhat;

    // Consensus samples run without the thinking pass, exactly as the campaign measured them:
    // with it, one temp-0.7 sample can reason for 15 minutes; without it, a sample is about a
    // minute and the answer shape is the same quote lines. The single-sample (cloud) path is
    // untouched.
    const text = await this.ask(
      'chapters',
      prompt,
      what,
      CHAPTERS_TIMEOUT_MS,
      sampleCount > 1 ? STAGE1_SAMPLE_TEMPERATURE : undefined,
      sampleCount > 1 ? false : undefined
    );
    if (text) {
      try {
        return { claims: readQuoteLines(text, `${what} (chapters)`) };
      } catch (error) {
        log.warn(`[Chapters] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    if (sampleCount > 1) {
      this.warn(
        `stage 1's ${what} returned no usable boundary list, so that sample cast no votes — the ` +
          `published boundaries rest on the remaining samples' agreement`
      );
      return null;
    }
    throw new Error(
      `The chapter call on ${this.options.model} returned no usable boundary list (see the log for what ` +
        `came back). Nothing is substituted and nothing is re-asked: this call is the chapter list, and ` +
        `the fix belongs at the source — the prompt, the window size, or the model.`
    );
  }

  // ------------------------------------------------------------------ name scaffold

  /**
   * ONE list of the video's people and organisations, with standard public spellings, shown
   * to EVERY detail call (2026-08-30 campaign; ledger in
   * /Volumes/Callisto/ContentStudio/.contentstudio/chapter-campaign/).
   *
   * WHY A MODEL CALL, AND WHY WHOLE-VIDEO. The per-chapter scaffold reads capitalization out
   * of each chapter's own slice, so a garbled name reaches each chapter in whatever form
   * whisper left it THERE — and the campaign's held-out run rendered one person four ways
   * across four chapters ("Johnny N. Lowe" / "Johnny envelope" / "Johnny Unlow" / "Johnny and
   * low lay"). No per-chapter prompt can fix that: each call corrects blindly, alone. One
   * whole-video list, shown to every detail call with "use exactly these spellings", made
   * every chapter agree. A bigger model does NOT fix the garble itself — the 72B also wrote
   * "Johnny N. Lowe" — so consistent-and-garbled is the local ceiling, and one consistent
   * spelling is one operator spot-fix instead of four.
   *
   * Windowed under stage 1's word budget so it can never outgrow the run's context window;
   * window lists are merged, deduped case-insensitively, and capped — past a point a scaffold
   * stops being a spelling reference and starts being a checklist.
   *
   * FAILURE IS A DECLARED DEGRADATION, never a throw: with no scaffold the detail calls keep
   * the per-chapter capitalization scaffold they always had, and the run says so once.
   */
  private static readonly NAME_SCAFFOLD_MAX = 40;

  private async wholeVideoNameScaffold(cues: Cue[]): Promise<string> {
    const budgetWords = this.windowWordBudget();
    const names: string[] = [];
    const seen = new Set<string>();
    let answered = 0;
    let windows = 0;
    let from = 0;
    while (from < cues.length && names.length < WholeTranscriptChapterService.NAME_SCAFFOLD_MAX) {
      const to = WholeTranscriptChapterService.windowEnd(cues, from, budgetWords);
      windows++;
      const prompt = formatPrompt(CHAPTER_PROMPTS.NAME_SCAFFOLD, {
        transcript: plainTranscript(cues.slice(from, to)),
      });
      const what = windows > 1 ? `this video's name list, window ${windows}` : "this video's name list";
      // No thinking pass: listing names is transcription, not reasoning, and the campaign ran
      // this call thinking-off. On the cloud transport `ask` ignores both extra arguments.
      const text = await this.ask('detail', prompt, what, DETAIL_TIMEOUT_MS, undefined, false);
      if (text) {
        try {
          for (const line of parseLines(text, `${what} (chapters)`)) {
            const key = line.toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
            if (key.length === 0 || seen.has(key)) continue;
            if (names.length >= WholeTranscriptChapterService.NAME_SCAFFOLD_MAX) break;
            seen.add(key);
            names.push(line);
          }
          answered++;
        } catch (error) {
          log.warn(`[Chapters] ${error instanceof Error ? error.message : String(error)}`);
        }
      }
      from = to;
    }
    if (answered === 0 || names.length === 0) {
      this.warn(
        `the whole-video name list could not be written, so each chapter was scaffolded only by the ` +
          `capitalized names in its own slice — the same person may be spelled differently across chapters`
      );
      return '';
    }
    log.info(`[Chapters] name scaffold: ${names.length} name(s) from ${windows} window(s): ${names.join(', ')}`);
    return names.join(', ');
  }

  // ---------------------------------------------------------------------- stage 3

  /**
   * Name and describe each chapter from its RAW transcript.
   *
   * The law this stage exists to obey: the model reads WHAT WAS SAID in the chapter, never an
   * intermediate label. It also gets the two other context inputs the body requires — the
   * video's title/filename, and the PREVIOUS chapter's detail threaded, so chapter N knows
   * what "back to what we discussed" refers to and the details do not repeat.
   *
   * Its `title` answer IS every chapter's title — stage 1 names nothing — and the grounding
   * and register checks judge each one ONCE, warning on the answer kept exactly as written
   * (no re-asks anywhere — operator, 2026-08-24).
   */
  private async detailChapters(
    spans: { startSec: number; endSec: number }[],
    cues: Cue[]
  ): Promise<WorkingChapter[]> {
    const chapters: WorkingChapter[] = [];
    let previousDetail = '';

    for (let i = 0; i < spans.length; i++) {
      const { startSec, endSec } = spans[i];
      const raw = this.transcriptBetween(cues, startSec, endSec, false);

      if (raw.trim().length === 0) {
        // The boundaries came from cue times, so an empty span means the arithmetic is
        // wrong. Describing a chapter that has no words would be inventing one.
        throw new Error(
          `Chapter generation produced the empty chapter span ${formatClock(startSec)}-${formatClock(endSec)}`
        );
      }

      const body = this.speakerTagged ? this.transcriptBetween(cues, startSec, endSec, true) : raw;
      // The whole-video name scaffold when it exists (cross-chapter spelling consistency —
      // see wholeVideoNameScaffold); the per-chapter capitalization scaffold is the declared
      // degradation when it does not, warned about once where the list failed to be written.
      const entities =
        !this.nameScaffold && this.groundingUsable ? topEntities(raw, ENTITY_SCAFFOLD_LIMIT) : [];
      const what = `chapter ${i + 1}/${spans.length} (${formatClock(startSec)}-${formatClock(endSec)})`;
      const prompt = formatPrompt(
        this.speakerTagged ? CHAPTER_PROMPTS.SUMMARIZE_CHAPTER_TAGGED : CHAPTER_PROMPTS.SUMMARIZE_CHAPTER,
        {
          number: i + 1,
          video: this.options.videoTitle || 'untitled',
          promoted_items: this.promotedItemsLine(),
          context_lines: this.contextLines(previousDetail, chapters.slice(-3).map((c) => c.title)),
          entity_scaffold: this.nameScaffold
            ? `\nPeople and organisations in this video, with standard spellings — when this chapter's ` +
              `title or summary refers to one of them, use exactly these spellings: ${this.nameScaffold}.\n`
            : entities.length > 0
              ? `\nNames this chapter's transcript uses, to build the title around where they fit: ${entities.join(', ')}.\n`
              : '',
          transcript: body,
        }
      );

      const answered = await this.askDetail(prompt, what);
      let title = answered.title;
      let detail = answered.detail;

      if (!detail) {
        this.warn(
          `the chapter at ${formatClock(startSec)} could not be described by the model, so it carries no ` +
            `detail and the description, tags and hashtags were written without it`
        );
      }

      // EVERY chapter is named by its detail call — and judged ONCE, never re-asked
      // (operator, 2026-08-24). A fault is a warning on the kept answer: the operator
      // curates it, and a fault that recurs is a prompt problem to fix at the source, not
      // something a second roll of the same dice should paper over — the u2 audit measured
      // eight re-asks in one run, every one a wasted duplicate call.
      let titleSource: WorkingChapter['titleSource'] = 'detail call';
      const faults = title ? this.judgeTitle(title, raw) : [];
      if (title && faults.length > 0) {
        this.warn(
          `the chapter at ${formatClock(startSec)} is titled "${title}", and ${faults.join(' and ')}; the ` +
            `model's answer is kept as written and nothing was rewritten, so this title is worth a look ` +
            `before publishing`
        );
      }

      if (!title) {
        // Named from its own opening words instead of by the model. The chapter still
        // exists at the right second, but its NAME is now a transcript fragment — and that
        // name is what the title, description and tag stages condition on, so the user is
        // told rather than left to notice.
        title = deriveTitle(raw);
        titleSource = 'opening words';
        this.warn(
          `the chapter at ${formatClock(startSec)} was not named by the detail call, so it is titled from ` +
            `its own opening words ("${title}")`
        );
      }

      chapters.push({ startSec, endSec, title, detail, titleSource });
      previousDetail = detail || title;
      this.options.onProgress?.('detail', chapters.length, spans.length);
    }

    return chapters;
  }

  /**
   * The context lines above the transcript: the channel, the previous chapter's detail, and
   * the last few chapter TITLES with a do-not-repeat instruction.
   *
   * All are context seeding — give the model whatever real context exists. The previous
   * detail is the deleted pipeline's law and has always been here; the channel is only
   * present when the caller had one to give. The recent-titles line is the 2026-08-30
   * campaign's fix for adjacent near-duplicate titles: two neighbouring chapters about the
   * same claim were both titled by it ("Trump is King Cyrus", twice) until the call could
   * SEE the titles already written and was told to name what is new instead.
   */
  private contextLines(previousDetail: string, previousTitles: string[]): string {
    const lines: string[] = [];
    if (this.options.channelName) lines.push(`Channel: ${this.options.channelName}`);
    if (previousDetail) lines.push(`Previous chapter: "${previousDetail}"`);
    if (previousTitles.length > 0) {
      lines.push(
        `The chapters just before this one are titled ${previousTitles.map((t) => `"${t}"`).join(', ')} — ` +
          `this chapter continues from them, so its title names what is NEW in this stretch, not their ` +
          `wording or their angle re-used.`
      );
    }
    return lines.length > 0 ? `${lines.join('\n')}\n` : '';
  }

  /**
   * What is wrong with this title, in the words the run's warning will use. Empty means
   * nothing is.
   *
   * TWO INDEPENDENT CHECKS, because a title can pass one and fail the other — the run that
   * motivated the register check was entity-rich and still narrated:
   *
   *  - GROUNDING: every proper noun in the title occurs in this chapter's own transcript.
   *    Catches both a name the model knew from the world and a name it took from the prompt's
   *    own examples. Cannot run on an uncased transcript, which is declared once per run.
   *  - REGISTER: the title names the content rather than an actor covering it.
   *
   * Returns REASONS, never a corrected title. Nothing in this file rewrites a model's words.
   */
  private judgeTitle(title: string, chapterTranscript: string): string[] {
    const faults: string[] = [];

    if (this.groundingUsable) {
      // Grounded against the WHOLE video plus its title, not the chapter's slice alone. The
      // per-slice test read as rigor and measured as waste: on u2 (2026-08-24) all eight
      // grounding re-asks flagged the video's own subject — named in the FILENAME the prompt
      // itself carries — because a 23-second outro slice happened not to repeat it. The model
      // legitimately knows the video title and the threaded context; a name is invented when
      // the VIDEO never contains it, which still catches world-knowledge names and the
      // prompt-example leak this check exists for.
      // The name scaffold is part of the grounding context: a title spelling "Daigle" the
      // standard way over a transcript that garbled it to "Dagle" took that spelling from an
      // input the prompt itself supplied, which is the opposite of inventing a name.
      const grounding = groundTitle(
        title,
        `${this.options.videoTitle || ''}\n${this.nameScaffold}\n${chapterTranscript}\n${this.wholeTranscriptText}`
      );
      if (!grounding.grounded) {
        faults.push(
          `it names ${grounding.ungrounded.map((n) => `"${n}"`).join(', ')}, which this video ` +
            `does not contain`
        );
      }
    }

    const register = narratesAnActor(title);
    if (register.narrated) {
      faults.push('it is written about someone covering the subject rather than about the subject');
    }

    return faults;
  }

  // ------------------------------------------------------------------ transcript prep

  /**
   * Raw transcript text between two times.
   *
   * The tagged rendering labels EVERY line, including the UNSURE ones. Dropping an unsure line
   * would hide words the video says; giving it to whichever side is adjacent would be a guess
   * printed as a fact. Labelled, it is a line the prompt has an explicit instruction for.
   */
  private transcriptBetween(cues: Cue[], startSec: number, endSec: number, tagged: boolean): string {
    const inside = cues.filter((c) => c.startSec >= startSec && c.startSec < endSec);
    return tagged
      ? inside.map((c) => `${(c.role ?? 'unsure').toUpperCase()}: ${c.text}`).join('\n')
      : inside.map((c) => c.text).join(' ');
  }

  /**
   * ONE num_ctx for the whole run (trap 4: Ollama fully reloads the model on any change).
   *
   * Sized from the whole-transcript call, which is the largest prompt this run can send by
   * construction — every detail call reads a SLICE of the same transcript under a shorter
   * instruction body, so nothing else can exceed it and no call is ever clamped.
   *
   * Exceeding the GPU ceiling costs speed and is DECLARED in the run's warnings rather than
   * only logged; exceeding CTX_MAX refuses, because a truncated transcript would produce
   * chapters for the first half of a video and no indication that is what happened.
   */
  private runNumCtx(transcript: string): number {
    // Capped at one WINDOW's worth: a transcript past the budget runs as rolling windows
    // (rollingWindows above), each of which fits by construction, so CTX_MAX is a sizing cap
    // now and nothing here can ask for a window it would refuse.
    const words = Math.min(normalizeWords(transcript).length, this.windowWordBudget());
    const promptTokens =
      Math.ceil(words * TOKENS_PER_WORD) +
      estimateTokens(CHAPTER_PROMPTS.wholeTranscript(this.options.grain).length);

    // The GPU ceiling is checked here rather than passed to bucketNumCtx, which only logs it:
    // a run that will be slow for a stated reason is something the job report should carry.
    //
    // The floor is the LARGER of the configured one and whatever window this job has already
    // made resident on this model (model-lifecycle.ts): sizing under a resident window reloads
    // the model to make it smaller, which buys nothing and costs the operator a UI freeze.
    // Clamped to CTX_MAX by `contextFloor`, so a floor can never turn into the refusal below.
    const numCtx = bucketNumCtx({
      promptTokens,
      numPredict: NUM_PREDICT,
      configured: Math.max(
        this.options.numCtx || 0,
        this.options.lifecycle.contextFloor(this.options.model, CTX_MAX)
      ),
      max: CTX_MAX,
      logPrefix: '[Chapters]',
      what: `reading this ${Math.round(words / 1000)}k-word transcript in one call`,
    });
    this.options.lifecycle.recordContext(this.options.model, numCtx);

    const ceiling = numCtxGpuCeiling(this.options.model);
    if (numCtx > ceiling) {
      this.warn(
        `this video's transcript needs a ${numCtx}-token context window, above the ${ceiling}-token size ` +
          `at which this model's KV cache still fits on the GPU — the run will be correct but slower ` +
          `(one spilled layer bottlenecks every token)`
      );
    }

    log.info(
      `[Chapters] num_ctx ${numCtx} for the whole run (${words} transcript words ~${promptTokens} prompt ` +
        `tokens, output budget ${NUM_PREDICT})`
    );
    return numCtx;
  }

  // -------------------------------------------------------------------- model calls

  private checkCancelled(): void {
    if (this.options.abortSignal?.aborted || this.options.cancelCallback?.()) {
      throw new Error('Chapter generation cancelled by user');
    }
  }

  private warn(message: string): void {
    log.warn(`[Chapters] ${message}`);
    this.warnings.push(message);
  }

  /**
   * The {promoted_items} slot's text. A channel that declares none still gets a truthful
   * sentence rather than a literal brace or an exclusion about nothing.
   */
  private promotedItemsLine(): string {
    const items = (this.options.promotedItems || []).map((t) => t.trim()).filter((t) => t.length > 0);
    return items.length > 0 ? items.join('; ') : 'none are declared for this channel';
  }

  /**
   * One detail answer, read into its two parts, or empty parts when the ANSWER was unusable.
   *
   * The caller's declared policies are built on the empty string — no detail is a warning, no
   * title falls to the opening words — so an answer that could not be read at all (empty, or
   * carrying no title line) lands there rather than throwing: it costs this one chapter its
   * name and prose, exactly as the failure policy states. A transport failure still throws
   * out of `ask` beneath.
   */
  private async askDetail(prompt: string, what: string): Promise<{ title: string; detail: string }> {
    const text = await this.ask('detail', prompt, what, DETAIL_TIMEOUT_MS);
    if (!text) return { title: '', detail: '' };
    try {
      return parseTitleDetail(text, `${what} (chapters)`);
    } catch (error) {
      log.warn(`[Chapters] ${error instanceof Error ? error.message : String(error)}`);
      return { title: '', detail: '' };
    }
  }

  /**
   * One generation call, PLAIN TEXT, or null when its ANSWER was unusable.
   *
   * No JSON on either transport (operator's ruling 2026-08-24): stage 1's answer is quote
   * lines and stage 3's is a title line and a summary, so there is no grammar, no schema and
   * no repair anywhere in this pipeline. The local traps that survive the change —
   * /api/generate, no `think` key, one num_ctx per run — live in plain-call.ts. This method
   * is the POLICY: an unusable answer costs the caller ONE decision, so it returns null and
   * the caller applies its own rule. A transport failure affects every remaining call, so it
   * throws.
   */
  private async ask(
    stage: ChapterStage,
    prompt: string,
    what: string,
    timeoutMs: number,
    temperature?: number,
    think?: false
  ): Promise<string | null> {
    this.checkCancelled();
    this.calls++;

    if (this.options.cloudPlain) {
      // Same policy as the local branch: an empty ANSWER comes back as null and costs the
      // caller one decision; a TRANSPORT failure affects every remaining call and throws.
      // `temperature` never reaches here: the cloud path is single-sample by construction.
      return await this.options.cloudPlain(prompt, this.options.model, `${what} (chapters)`);
    }

    const result = await askOllamaPlain(this.client, {
      model: this.options.model,
      prompt,
      numCtx: this.numCtx,
      numPredict: NUM_PREDICT,
      keepAlive: KEEP_ALIVE,
      temperature,
      think,
      timeoutMs,
      signal: this.options.abortSignal,
      what: `${what} (chapters)`,
      logPrefix: `[Chapters] stage "${stage}"`,
    });

    // Resident from here until the JOB ends. The next stage — the detail calls, then the field
    // calls when they are routed to the same model — finds it loaded, which is what the
    // 10-minute keep-alive is for.
    this.options.lifecycle.holdOllamaModel(this.options.host, this.options.model, 'the chapter pipeline');

    if (!result.ok) {
      log.warn(`[Chapters] stage "${stage}" got no usable answer: ${result.detail}`);
      return null;
    }
    return result.text;
  }

  // ---------------------------------------------------------------------- assembling

  /**
   * The finished chapters. The first is published at 0:00 — YouTube requires a 0:00 marker,
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
      detail: chapter.detail,
    }));
  }
}
