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
 *   2. MAP        code    each quoted sentence -> a second, forwards only, against that
 *                         window's caption word stream. Unmappable is DROPPED and named,
 *                         never guessed at.
 *   3. DETAIL     LLM     one call per chapter, from its RAW transcript: a title line and
 *                         the 20-45 word prose the description and tag stages condition on.
 *
 * 1 + N calls, N being 3 to 8. An hour of video costs 5 to 9 generation calls.
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
 *  - the ONE chapter call answers unusably -> ONE re-ask at a different SAMPLE, and if that
 *                                  also fails the run THROWS. There are no chapters to
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
 *    its chapter never said,        it. Never a rewrite, never a block: the operator curates
 *    or narrates an actor           the output. Every title comes from its detail call, so
 *                                  every one gets ONE re-ask first — that is the one title a
 *                                  second sample can change.
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
  ChapterClaim,
  ChapterPipelineResult,
  Cue,
} from './chapter-transcript';
import { CHAPTER_PROMPTS } from './chapter-prompts';
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
 * provider defaults everywhere; a model that cannot perform there is replaced, not tuned).
 * At default sampling every ask is already a fresh draw, so a re-ask IS a second sample with
 * no seed juggling — the earlier temperature-0/seed-0 measurement design is superseded. The
 * re-ask prompt still never quotes the rejected answer back and never describes what was
 * wrong with it, because a prompt that shows a model the wrong form teaches it that form.
 */


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
 * re-ask policy owns that).
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

    // ---- stage 3: one call per chapter for its detail -------------------------
    const working = await this.detailChapters(spans, cues);

    const chapters = this.toChapters(working, durationSeconds);
    log.info(
      `[Chapters] ${chapters.length} chapters in ${this.calls} model calls` +
        (dropped > 0 ? ` (${dropped} dropped for an unmeasurable opening sentence)` : '') +
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
   */
  private static readonly STAGE1_WINDOW_WORDS = 2800;

  private windowWordBudget(): number {
    const overheadChars = CHAPTER_PROMPTS.WHOLE_TRANSCRIPT_CHAPTERS.length + this.promotedItemsLine().length + 64;
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
        WholeTranscriptChapterService.STAGE1_WINDOW_WORDS
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

      const answer = await this.askWindow(windowCues, ranges.length);
      claimed += answer.claims.length;

      const mappings = mapChapterQuotes(answer.claims, windowCues);
      for (const mapping of mappings) {
        if (mapping.status === 'mapped') {
          log.info(
            `[Chapters] boundary at ${formatClock(mapping.time!)}: "${mapping.quote.slice(0, 60)}"`
          );
          continue;
        }
        dropped++;
        this.warn(
          mapping.status === 'out-of-order'
            ? `a chapter boundary was DROPPED: its opening sentence ("${mapping.quote.slice(0, 60)}") is in ` +
                `this transcript at ${formatClock(mapping.wholeVideoTime!)}, which is not after the boundary ` +
                `before it, so the model listed it out of order or quoted a sentence the speaker says twice`
            : `a chapter boundary was DROPPED: its opening sentence ("${mapping.quote.slice(0, 60)}") is not ` +
                `in this transcript, so there is no measured time for it and nothing is guessed at`
        );
      }

      // The window's own start is already a chapter start; a line mapping at (or before) it
      // is the redundant echo described above, not a boundary.
      const mapped = mappings.filter((m) => m.status === 'mapped').map((m) => m.time!);
      const fresh = mapped.filter((timeSec) => timeSec > windowStartSec);
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
   * ONE window's stage-1 call: its transcript slice in, opening-sentence lines out.
   *
   * ONE ask, and an unusable answer THROWS — no re-ask (operator, 2026-08-24: "let it fail
   * and we'll tweak things until it's right"; a retry is a fallback covering the failure the
   * prompt should be fixed for). These calls ARE the chapter list; resolveChapters records
   * `chaptersSkipped` with this message on it, so the item says out loud that it has no
   * chapters and why, which is a state the user sees and fixes at the source.
   */
  private async askWindow(windowCues: Cue[], windowNumber: number): Promise<WindowAnswer> {
    const spanSeconds = windowCues[windowCues.length - 1].endSec - windowCues[0].startSec;
    const prompt = formatPrompt(CHAPTER_PROMPTS.WHOLE_TRANSCRIPT_CHAPTERS, {
      duration: runtimePhrase(spanSeconds),
      promoted_items: this.promotedItemsLine(),
      // Substituted last, as everywhere else in this codebase: transcript text that happens
      // to contain a brace token must not be rewritten by a later pass.
      transcript: plainTranscript(windowCues),
    });
    const what = windowNumber > 1 ? `this video's chapters, window ${windowNumber}` : "this video's chapters";

    const text = await this.ask('chapters', prompt, what, CHAPTERS_TIMEOUT_MS);
    if (text) {
      try {
        return { claims: readQuoteLines(text, `${what} (chapters)`) };
      } catch (error) {
        log.warn(`[Chapters] ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    throw new Error(
      `The chapter call on ${this.options.model} returned no usable boundary list (see the log for what ` +
        `came back). Nothing is substituted and nothing is re-asked: this call is the chapter list, and ` +
        `the fix belongs at the source — the prompt, the window size, or the model.`
    );
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
   * Its `title` answer IS every chapter's title — stage 1 names nothing — so the grounding
   * and register checks get ONE re-ask on every chapter, because a second sample is the one
   * thing that can change a detail-call title.
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
      // Per-chapter and never whole-video: the names in THIS slice, so the model is
      // scaffolded toward what is here and not toward what chapter 2 was about.
      const entities = this.groundingUsable ? topEntities(raw, ENTITY_SCAFFOLD_LIMIT) : [];
      const what = `chapter ${i + 1}/${spans.length} (${formatClock(startSec)}-${formatClock(endSec)})`;
      const prompt = formatPrompt(
        this.speakerTagged ? CHAPTER_PROMPTS.SUMMARIZE_CHAPTER_TAGGED : CHAPTER_PROMPTS.SUMMARIZE_CHAPTER,
        {
          number: i + 1,
          video: this.options.videoTitle || 'untitled',
          promoted_items: this.promotedItemsLine(),
          context_lines: this.contextLines(previousDetail),
          entity_scaffold:
            entities.length > 0
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
   * The two context lines above the transcript: the channel, and the previous chapter.
   *
   * Both are context seeding — give the model whatever real context exists. The previous
   * detail is the deleted pipeline's law and has always been here; the channel is only
   * present when the caller had one to give.
   */
  private contextLines(previousDetail: string): string {
    const lines: string[] = [];
    if (this.options.channelName) lines.push(`Channel: ${this.options.channelName}`);
    if (previousDetail) lines.push(`Previous chapter: "${previousDetail}"`);
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
      const grounding = groundTitle(title, `${this.options.videoTitle || ''}\n${chapterTranscript}\n${this.wholeTranscriptText}`);
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
      estimateTokens(CHAPTER_PROMPTS.WHOLE_TRANSCRIPT_CHAPTERS.length);

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
    timeoutMs: number
  ): Promise<string | null> {
    this.checkCancelled();
    this.calls++;

    if (this.options.cloudPlain) {
      // Same policy as the local branch: an empty ANSWER comes back as null and costs the
      // caller one decision; a TRANSPORT failure affects every remaining call and throws.
      return await this.options.cloudPlain(prompt, this.options.model, `${what} (chapters)`);
    }

    const result = await askOllamaPlain(this.client, {
      model: this.options.model,
      prompt,
      numCtx: this.numCtx,
      numPredict: NUM_PREDICT,
      keepAlive: KEEP_ALIVE,
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
