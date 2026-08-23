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
 *   1. CHAPTERS   LLM     ONE call. The whole transcript, no timestamps, the runtime stated
 *                         once as a fact, a cadence BAND graduated by that runtime, and a
 *                         first-sentence quote per chapter. The model derives the COUNT.
 *   2. MAP        code    each quote -> a second, forwards only, against the caption word
 *                         stream. Unmappable is DROPPED and named, never guessed at.
 *   3. DETAIL     LLM     one call per chapter, from its RAW transcript: the 20-45 word
 *                         prose the description and tag stages condition on.
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
 *    or narrates an actor           the output. Where the title came from the detail call
 *                                  (see THE TITLE RULE below) there is ONE re-ask first,
 *                                  because that is the one title a second sample can change.
 *  - the transcript is uncased   -> the entity scaffold and the grounding check cannot run,
 *                                  and a warning says the titles were written without them.
 *
 * What is NOT a degradation and therefore throws: a transport failure (Ollama unreachable,
 * model not installed, request timeout), and a chapter span with no words in it (the
 * boundaries came from cue times, so an empty span means the arithmetic is wrong).
 *
 * THE TITLE RULE, stated because two stages could otherwise fight over one string and the
 * loser would be invisible. Every chapter has exactly ONE source for its title:
 *
 *   - the chapter call's `label`, for every chapter it reported;
 *   - the detail call's `title`, for a chapter the chapter call did NOT label — normally the
 *     opening 0:00 chapter, because the prompt asks for the turns and the opening of a video
 *     is not a turn, and otherwise only an entry that came back with an empty label. (A model
 *     that reports the opening anyway is not overruled: its label names that chapter and its
 *     redundant boundary is dropped, which is the one case where 0:00 has a stage-1 name.)
 *
 * The detail call still asks for a title on every chapter (its prompt body is unchanged, and
 * naming the chapter is part of how it reads it), and that answer is DISCARDED wherever the
 * chapter call already supplied one. The discard is the explicit choice; the alternative —
 * letting stage 3 overwrite stage 1's title — would silently replace the string the
 * measurement was about.
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
import {
  askOllamaJson,
  bucketNumCtx,
  estimateTokens,
  TOKENS_PER_WORD,
  OLLAMA_KEEP_ALIVE,
} from './ollama-json';
import { JobModelLifecycle } from './model-lifecycle';
import { CloudAnswerUnusableError } from './ai-manager.service';
import { formatPrompt } from './system-prompts';
import { topEntities, transcriptCasing } from './entity-extraction';
import { groundTitle, narratesAnActor } from './chapter-title-quality';

/** The two stages that make model calls, and therefore the two that report progress. */
export type ChapterStage = 'chapters' | 'detail';

/**
 * The answer shape of each stage's call, for the CLOUD transport only.
 *
 * The local path deliberately sends no schema — grammar-constraining the decode measurably
 * destroys the chapter judgment there, because the local model reasons in the same token
 * stream the grammar constrains. The cloud models think BEFORE the constrained answer, so
 * the schema only guarantees the answer's syntax (the API's structured outputs) and the
 * judgment is untouched. Added after the 2026-08-23 runs, where free-form cloud answers
 * arrived with unterminated strings and trailing commas and cost chapters their details.
 */
const CLOUD_STAGE_SCHEMAS: Record<ChapterStage, Record<string, unknown>> = {
  chapters: {
    type: 'object',
    properties: {
      chapters: {
        type: 'array',
        items: {
          type: 'object',
          properties: { label: { type: 'string' }, first_sentence: { type: 'string' } },
          required: ['label', 'first_sentence'],
          additionalProperties: false,
        },
      },
    },
    required: ['chapters'],
    additionalProperties: false,
  },
  detail: {
    type: 'object',
    properties: { title: { type: 'string' }, summary: { type: 'string' } },
    required: ['title', 'summary'],
    additionalProperties: false,
  },
};

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

/**
 * The sampling a SECOND look uses.
 *
 * The run asks at temperature 0 with seed 0, so re-sending an identical prompt unchanged
 * would return an identical answer — a re-ask that cannot produce a different result is not a
 * re-ask. A different seed and a little temperature is what makes it a second SAMPLE. Nothing
 * about the prompt changes: per the operator's ruling a re-ask never quotes the rejected
 * answer back and never describes what was wrong with it, because a prompt that shows a model
 * the wrong form teaches it that form.
 */
const RE_ASK_SAMPLING = { temperature: 0.3, seed: 1 };

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
   * runJsonRequest bound to itself; `model` is then the provider-prefixed string that method
   * routes on ("claude:claude-sonnet-5") rather than an Ollama tag.
   *
   * When present, nothing local happens: no context-window sizing (the provider owns its
   * window), no model residency (`lifecycle` holds nothing), no Ollama traffic. The
   * local path is otherwise UNTOUCHED — this is a second transport inside `ask()`, not a
   * second pipeline, and every stage, retry rule and warning reads identically on both.
   */
  cloudJson?: (
    prompt: string,
    model: string,
    what: string,
    schema?: Record<string, unknown>
  ) => Promise<Record<string, unknown>>;
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
  titleSource: 'chapter call' | 'detail call' | 'opening words';
}

/** What the one chapter call came back with, or why there is nothing to work with. */
interface ChapterAnswer {
  claims: ChapterClaim[];
  /** Entries with no `first_sentence`. Dropped, counted, never filled in from the label. */
  malformed: number;
  retried: boolean;
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
 * Read the model's object into (label, quote) pairs.
 *
 * An entry with no quote is DROPPED and counted, never filled in from the label and never
 * interpolated between its neighbours: the quote is the measurement, and a chapter with no
 * measurement is a chapter with no time.
 */
function readClaims(value: Record<string, unknown>): { claims: ChapterClaim[]; malformed: number } {
  const raw = Array.isArray(value.chapters) ? value.chapters : null;
  if (!raw) return { claims: [], malformed: 0 };

  const claims: ChapterClaim[] = [];
  let malformed = 0;
  for (const entry of raw) {
    if (!entry || typeof entry !== 'object') {
      malformed++;
      continue;
    }
    const record = entry as Record<string, unknown>;
    const quote = typeof record.first_sentence === 'string' ? record.first_sentence.trim() : '';
    const label = typeof record.label === 'string' ? record.label.trim() : '';
    if (quote.length === 0) {
      malformed++;
      continue;
    }
    claims.push({ label, quote });
  }
  return { claims, malformed };
}

// =============================================================================
// SERVICE
// =============================================================================

export class WholeTranscriptChapterService {
  private readonly client: AxiosInstance;
  private readonly options: WholeTranscriptChapterOptions;
  private readonly warnings: string[] = [];
  private calls = 0;
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

    // ---- stage 1: the one call ------------------------------------------------
    // The context window is an Ollama concern: sized, ratcheted and GPU-checked only on the
    // local transport. A cloud provider owns its own window and the sizing would record a
    // residency for a model that never loads.
    if (!this.options.cloudJson) this.numCtx = this.runNumCtx(transcript);
    this.options.onProgress?.('chapters', 0, 1);
    const answer = await this.askForChapters(transcript, runtime);
    this.options.onProgress?.('chapters', 1, 1);

    if (answer.malformed > 0) {
      this.warn(
        `${answer.malformed} of the ${answer.claims.length + answer.malformed} chapters the model listed ` +
          `came back with no opening sentence to measure, so they were dropped rather than placed by ` +
          `guesswork — this video has ${answer.malformed} chapter(s) fewer than the model found`
      );
    }

    // ---- stage 2: measure every quote, forwards only --------------------------
    const mappings = mapChapterQuotes(answer.claims, cues);
    for (const mapping of mappings) {
      if (mapping.status === 'mapped') {
        log.info(
          `[Chapters] chapter ${mapping.ordinal} at ${formatClock(mapping.time!)}: ` +
            `"${mapping.quote.slice(0, 60)}" — ${mapping.label}`
        );
        continue;
      }
      this.warn(
        mapping.status === 'out-of-order'
          ? `the chapter the model called "${mapping.label || 'untitled'}" was DROPPED: its opening ` +
              `sentence ("${mapping.quote.slice(0, 60)}") is in this transcript at ` +
              `${formatClock(mapping.wholeVideoTime!)}, which is not after the chapter before it, so the ` +
              `model listed it out of order or quoted a sentence the speaker says twice`
          : `the chapter the model called "${mapping.label || 'untitled'}" was DROPPED: its opening ` +
              `sentence ("${mapping.quote.slice(0, 60)}") is not in this transcript, so there is no ` +
              `measured time for it and nothing is guessed at`
      );
    }

    const starts = mappings.filter((m) => m.status === 'mapped');
    const mapped = starts.length;
    const dropped = mappings.filter((m) => m.status !== 'mapped').length + answer.malformed;

    // The prompt says the opening chapter needs no entry, and a model that reports it
    // anyway has not made a mistake worth a warning — it has named the one chapter this
    // architecture otherwise has no name for. Its boundary is redundant (code puts the
    // first chapter at 0:00 regardless) and is taken off the front so the opening span
    // cannot be 0:00-0:00, which would be an empty chapter and would throw.
    let openingLabel = '';
    if (starts.length > 0 && starts[0].time === 0) {
      openingLabel = starts[0].label;
      starts.shift();
      log.info(
        `[Chapters] the model reported the opening of the video as a chapter; 0:00 is already the ` +
          `first chapter, so its entry is not a second boundary — it is the opening chapter's name ` +
          `("${openingLabel || 'unnamed'}")`
      );
    }

    // The opening chapter is at 0:00 and the model usually does not report it: the prompt
    // asks for the TURNS, and the opening of the video is not a turn. Where it has no label
    // from the chapter call, THE TITLE RULE's second clause names it from its detail call.
    const spans: { startSec: number; endSec: number; label: string }[] = [
      {
        startSec: 0,
        endSec: starts.length > 0 ? starts[0].time! : durationSeconds,
        label: openingLabel,
      },
      ...starts.map((m, i) => ({
        startSec: m.time!,
        endSec: i + 1 < starts.length ? starts[i + 1].time! : durationSeconds,
        label: m.label,
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
        chaptersClaimed: answer.claims.length + answer.malformed,
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
   * The ONE call: the whole transcript in, a list of (title, opening sentence) out.
   *
   * ONE re-ask at a different SAMPLE when the answer is unusable, and then the run THROWS.
   * That is not a fallback and there is nothing to degrade to — this call IS the chapter
   * list. resolveChapters records `chaptersSkipped` with this message on it, so the item
   * says out loud that it has no chapters and why, which is a state the user sees.
   */
  private async askForChapters(transcript: string, runtime: string): Promise<ChapterAnswer> {
    const prompt = formatPrompt(CHAPTER_PROMPTS.WHOLE_TRANSCRIPT_CHAPTERS, {
      duration: runtime,
      // Substituted last, as everywhere else in this codebase: transcript text that happens
      // to contain a brace token must not be rewritten by a later pass.
      transcript,
    });

    const send = async (retried: boolean, sampling?: { temperature: number; seed: number }) => {
      const result = await this.ask(
        'chapters',
        prompt,
        retried ? "this video's chapters, second attempt" : "this video's chapters",
        CHAPTERS_TIMEOUT_MS,
        sampling
      );
      if (!result) return null;
      const { claims, malformed } = readClaims(result);
      if (claims.length === 0) {
        log.warn(`[Chapters] the answer parsed but carried no usable chapter (${malformed} had no quote)`);
        return null;
      }
      return { claims, malformed, retried };
    };

    const first = await send(false);
    if (first) return first;

    log.warn(`[Chapters] no usable chapter list on the first ask; re-asking once at a different sample`);
    const second = await send(true, RE_ASK_SAMPLING);
    if (second) {
      this.warn(
        `the chapter call had to be asked twice — the first answer carried no usable chapter — so this ` +
          `video's chapters come from a second sample rather than the run's pinned one, and asking again ` +
          `may not reproduce them`
      );
      return second;
    }

    throw new Error(
      `The chapter call on ${this.options.model} returned no usable chapter list, twice (see the log for ` +
        `what came back). Nothing is substituted for it: this call is the chapter list.`
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
   * Its `title` answer is used only where the chapter call did not supply a label — see THE
   * TITLE RULE in this file's header. Where it IS the title, the grounding and register
   * checks get ONE re-ask, because that is the one title a second sample can change.
   */
  private async detailChapters(
    spans: { startSec: number; endSec: number; label: string }[],
    cues: Cue[]
  ): Promise<WorkingChapter[]> {
    const chapters: WorkingChapter[] = [];
    let previousDetail = '';

    for (let i = 0; i < spans.length; i++) {
      const { startSec, endSec, label } = spans[i];
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
          context_lines: this.contextLines(previousDetail),
          entity_scaffold:
            entities.length > 0
              ? `\nNames this chapter's transcript uses, to build the title around where they fit: ${entities.join(', ')}.\n`
              : '',
          transcript: body,
        }
      );

      const parsed = await this.ask('detail', prompt, what, DETAIL_TIMEOUT_MS);
      let detail = WholeTranscriptChapterService.readString(parsed?.summary);

      if (!detail) {
        this.warn(
          `the chapter at ${formatClock(startSec)} could not be described by the model, so it carries no ` +
            `detail and the description, tags and hashtags were written without it`
        );
      }

      // THE TITLE RULE. The chapter call's label wins wherever there is one; the detail
      // call's title is read only for a chapter that has none — always the opening one.
      let title = label;
      let titleSource: WorkingChapter['titleSource'] = 'chapter call';
      if (!title) {
        title = WholeTranscriptChapterService.readString(parsed?.title);
        titleSource = 'detail call';

        // The one title a second sample can change, so the one that gets a re-ask.
        const faults = title ? this.judgeTitle(title, raw) : [];
        if (title && faults.length > 0) {
          const second = await this.ask('detail', prompt, `${what}, second attempt`, DETAIL_TIMEOUT_MS, RE_ASK_SAMPLING);
          const retitled = WholeTranscriptChapterService.readString(second?.title);
          const secondFaults = retitled ? this.judgeTitle(retitled, raw) : ['it came back with no title'];
          if (retitled && secondFaults.length === 0) {
            log.info(`[Chapters] ${what}: re-asked (${faults.join('; ')}) and the second answer holds`);
            title = retitled;
            detail = WholeTranscriptChapterService.readString(second?.summary) || detail;
          } else {
            // Both attempts failed the same class of check. The FIRST answer is kept — it is
            // the one the run's own sampling settings produced — and the run says so.
            this.warn(
              `the chapter at ${formatClock(startSec)} is titled "${title}", which was asked for twice and ` +
                `both times ${faults.join(' and ')}; the model's answer is kept as written and nothing was ` +
                `rewritten, so this title is worth a look before publishing`
            );
          }
        }

        if (!title) {
          // Named from its own opening words instead of by the model. The chapter still
          // exists at the right second, but its NAME is now a transcript fragment — and that
          // name is what the title, description and tag stages condition on, so the user is
          // told rather than left to notice.
          title = deriveTitle(raw);
          titleSource = 'opening words';
          this.warn(
            `the chapter at ${formatClock(startSec)} was not named by either call, so it is titled from ` +
              `its own opening words ("${title}")`
          );
        }
      } else {
        // A title from the chapter call gets the same two checks and no re-ask: re-sampling
        // one whole-video call to change one of its titles would move every OTHER chapter in
        // the list as a side effect. Declared and kept as written, per the failure policy.
        const faults = this.judgeTitle(title, raw);
        if (faults.length > 0) {
          this.warn(
            `the chapter at ${formatClock(startSec)} is titled "${title}", which ${faults.join(' and ')}; ` +
              `the model's answer is kept as written and nothing was rewritten, so this title is worth a ` +
              `look before publishing`
          );
        }
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
      const grounding = groundTitle(title, chapterTranscript);
      if (!grounding.grounded) {
        faults.push(
          `it names ${grounding.ungrounded.map((n) => `"${n}"`).join(', ')}, which this chapter's own ` +
            `transcript does not contain`
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
    const words = normalizeWords(transcript).length;
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

  private static readString(value: unknown): string {
    return typeof value === 'string' ? value.trim() : '';
  }

  /**
   * One generation call, or null when its ANSWER was unusable.
   *
   * The mechanism — /api/generate, no `think` key, `format: "json"`, the `thinking` fallback
   * when the grammar swallowed `response`, one num_ctx for the run, and the transport error
   * messages — lives in ollama-json.ts, which is where those traps are written down. This
   * method is the POLICY: an unusable answer costs the caller ONE decision, so it returns
   * null and the caller applies its own rule. A transport failure affects every remaining
   * call, so it throws.
   *
   * No `schema` is sent, deliberately: schema-constraining a chapter judgment measurably
   * destroys it — the reasoning a grammar suppresses is doing real work here.
   */
  private async ask(
    stage: ChapterStage,
    prompt: string,
    what: string,
    timeoutMs: number,
    /**
     * Sampling for a SECOND look at the same prompt. Omitted everywhere the run is taking a
     * measurement, which is everywhere but a re-ask: temperature 0 and a pinned seed are what
     * make a quote resolve to the same sentence every run.
     */
    sampling?: { temperature: number; seed: number }
  ): Promise<Record<string, unknown> | null> {
    this.checkCancelled();
    this.calls++;

    if (this.options.cloudJson) {
      // Same policy as the local branch: an unusable ANSWER costs the caller one decision
      // (null), a TRANSPORT failure affects every remaining call and throws. The two are
      // told apart by TYPE (CloudAnswerUnusableError), never by message text — a message
      // substring match here misread one truncated answer as transport on 2026-08-23 and
      // failed the whole run. The stage schema makes the unusable case near-impossible
      // (structured outputs guarantee valid JSON), so this catch is the backstop.
      try {
        return await this.options.cloudJson(
          prompt, this.options.model, `${what} (chapters)`, CLOUD_STAGE_SCHEMAS[stage]
        );
      } catch (error) {
        if (error instanceof CloudAnswerUnusableError) {
          log.warn(`[Chapters] stage "${stage}" got no usable answer: ${error.message}`);
          return null;
        }
        throw error;
      }
    }

    const result = await askOllamaJson(this.client, {
      model: this.options.model,
      prompt,
      numCtx: this.numCtx,
      numPredict: NUM_PREDICT,
      temperature: sampling?.temperature ?? 0,
      seed: sampling?.seed ?? 0,
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
    return result.value;
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
