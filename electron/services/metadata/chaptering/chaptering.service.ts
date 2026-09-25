/**
 * Chaptering at a chosen granularity — OUTLINE + ASSIGN + Viterbi on snap (LEDGER #199).
 *
 * One service, three consumers (plan §10.1): metadata chapters (`detailed`, `broad`,
 * `stories`), editor Stories (`broad`: "just chapters for a livestream") and episode
 * splitting (`episodes`, the coarsest). The method, ported from segment.py (docs/crucible/
 * reference/segment.py) by way of Briefcase's TypeScript, measured on YTSeg at F1@±1 0.72:
 *
 *   1. UNITS      the transcript cut into sentence units, times from the captions (units.ts).
 *   2. OUTLINE    the scorer model (the 9B) lists the sections as plain lines, at the
 *                 granularity's prompt (outline.ts, prompts.ts). A long transcript is cut into
 *                 chunks that each fit one state under ~12k tokens (chunks.ts), outlined and
 *                 assigned one at a time and stitched at the seams.
 *   3. ASSIGN     one snap choice per sentence, quoting the sentence and the one before it;
 *                 the options are the outline items plus the ad item (assign.ts).
 *   4. VITERBI    the best item per sentence under the granularity's flat switch cost
 *                 (viterbi.ts, granularity.ts). Boundaries are where the item changes.
 *   5. ADS        every stretch assigned to the ad item is confirmed by a yes/no; a rejected
 *                 one is re-segmented without it (plugs.ts).
 *   6. LEVEL 2    at `detailed`, every long level-1 section gets the same method over its own
 *                 units (a sub-outline, no ad item); the children tile the parent. That is the
 *                 plan's two-level outline (§10.2), which keeps every state small and every
 *                 question inside 26 options.
 *   7. TITLES     each chapter's title and summary from `summarize_chapter` on the capable
 *                 model (the 27B; summarize.ts).
 *
 * PURE ORCHESTRATION: every model call goes through the injected `chat` and `decide`
 * (types.ts), so tools/chaptering-checks.js drives the whole thing with a fake and
 * tools/chaptering-run.js with the live Mac Crucible. Nothing here picks a model (#204) and
 * nothing here imports electron/crucible/.
 *
 * WHAT IS DECLARED, NEVER SILENT (Laws 1 and 8): a `decide_not_served` from the transport is
 * a refusal by name (there is no fall back to the whole-transcript call); a unit under the
 * label-mass gate is recorded as skipped; a floored label is counted; an unreadable title
 * costs one chapter its title, warned, never re-asked (Law 3).
 */

import * as log from 'electron-log';
import { TranscriptInput, UnitOptions, captionsOf, sentenceUnits } from './units';
import { GRANULARITY, granularitySetting, isLongSection } from './granularity';
import { BATCH, MAX_ITEMS, SNAP_PROMPTS } from './prompts';
import { writeOutline } from './outline';
import { assignQuestions, optionNames, questionName, readChoiceDistribution, readYesNo, wireOptions } from './assign';
import { viterbi } from './viterbi';
import { confirmPlugs } from './plugs';
import { Chunk, ChunkPath, ChunkPlanOptions, planChunks, stitchChunks, unitTokens } from './chunks';
import { Span, childrenOf, piecesToSpans } from './chapters';
import { summarizeChapter } from './summarize';
import {
  Chapter,
  ChapteringError,
  ChapteringProgress,
  ChapteringResult,
  ChapteringStats,
  ChunkDiagnostic,
  ChatFn,
  DecideFn,
  DecideRequest,
  Granularity,
  PlugVerdict,
  SentenceUnit,
  isTransportFailure,
} from './types';

export interface ChapterOptions {
  granularity: Granularity;
  chat: ChatFn;
  decide: DecideFn;
  /** The channel's promoted_items (prompts/channels/*.yml): named in the ad item, the ad confirm and the titles. */
  promotedItems?: string[];
  channelName?: string;
  videoTitle?: string;
  /** End of the last chapter, in seconds (the media duration). Default: the last unit's end. */
  totalSeconds?: number;
  /** Include the ad item and confirm its stretches (segment.py run(plugs=True)). Default true. */
  detectAds?: boolean;
  /** Write titles and summaries on the capable model. Default true; off for a boundaries-only measurement run. */
  summarize?: boolean;
  /**
   * Thinking on the title calls. Default true: the whole-transcript service's measured setting
   * (summarize.ts). Measured 2026-09-25 on the Mac's 27B-4bit (docs/crucible/P8a.md): a title
   * with thinking took 37-412 s and one ran out its 8192 tokens without answering, so a long
   * run may turn it off. Declared: logged, and stated in the run's warnings (Law 8).
   */
  titleThinking?: boolean;
  /**
   * Override the granularity's switch cost for a measurement run. A declared override: it is
   * logged and reported in the result, and the production dial stays granularity.ts's.
   */
  switchCost?: number;
  chunking?: ChunkPlanOptions;
  /** A real token count of the whole state text on the scorer model. Absent: ~4 characters per token. */
  countTokens?: (text: string, signal?: AbortSignal) => Promise<number>;
  unitOptions?: UnitOptions;
  signal?: AbortSignal;
  onProgress?: (p: ChapteringProgress) => void;
  /** Return each chunk's per-sentence reading in `result.diagnostics` (tools/chaptering-run.js). */
  diagnostics?: boolean;
}

/** Share of the progress bar per phase, weighted by work rather than by stage (plan §0a). */
const W_LEVEL1 = 0.45;
const W_REFINE = 0.4;
const W_SUMMARIZE = 0.15;

/**
 * A transcript -> its chapters at the chosen granularity. The one entry point (plan §10.1):
 * captions, or any transcript file ContentStudio holds (units.ts TranscriptInput).
 */
export async function chapter(transcript: TranscriptInput, options: ChapterOptions): Promise<ChapteringResult> {
  const units = sentenceUnits(captionsOf(transcript), options.unitOptions);
  return chapterUnits(units, options);
}

/** The same pipeline over a unit list the caller already built. */
export async function chapterUnits(units: SentenceUnit[], options: ChapterOptions): Promise<ChapteringResult> {
  const t0 = Date.now();
  const setting = granularitySetting(options.granularity);
  const switchCost = options.switchCost ?? setting.switchCost;
  const detectAds = options.detectAds ?? true;
  const signal = options.signal;
  const stats: ChapteringStats = {
    unitCount: units.length,
    chunkCount: 0,
    refinedSections: 0,
    outlineMs: 0,
    assignMs: 0,
    plugMs: 0,
    summarizeMs: 0,
    totalMs: 0,
    chatCalls: 0,
    decideCalls: 0,
    flooredUnits: [],
    skippedUnits: [],
    titledFromParts: [],
    warnings: [],
  };
  const warn = (message: string) => {
    log.warn(`[Chaptering] ${message}`);
    stats.warnings.push(message);
  };
  if (units.length === 0) {
    throw new ChapteringError('empty_transcript', 'the transcript has no words to chapter');
  }
  if (options.switchCost !== undefined && options.switchCost !== setting.switchCost) {
    log.info(`[Chaptering] switch cost ${options.switchCost} overrides the ${options.granularity} dial (${setting.switchCost}) for this run`);
  }
  throwIfAborted(signal);

  const refine = setting.refine;
  const summarize = options.summarize ?? true;
  const titleThinking = options.titleThinking ?? true;
  if (summarize && !titleThinking) warn('titles were written with thinking OFF on the title model (a declared setting of this run)');
  const wLevel1 = refine ? W_LEVEL1 : W_LEVEL1 + W_REFINE;
  const wSummarize = summarize ? W_SUMMARIZE : 0;
  const scale = wLevel1 + (refine ? W_REFINE : 0) + wSummarize;
  let base = 0;
  const progress = (phase: ChapteringProgress['phase'], done: number, total: number, share: number, within: number) =>
    options.onProgress?.({ phase, done, total, fraction: Math.min(1, (base + share * within) / scale) });

  const diagnostics: ChunkDiagnostic[] = [];
  const ctx: LevelContext = { options, stats, warn, signal, detectAds, diagnostics: options.diagnostics ? diagnostics : null };
  const texts = units.map((u) => u.text);

  // Level 1: the whole video at the granularity's outline and switch cost.
  progress('outline', 0, units.length, wLevel1, 0);
  const level1 = await runLevel(ctx, units, 0, {
    outlinePrompt: (text, seconds) => SNAP_PROMPTS.outline(options.granularity, text, MAX_ITEMS, runtimeWords(seconds)),
    switchCost,
    withAds: detectAds,
    prevBefore: SNAP_PROMPTS.START_OF_VIDEO,
    level: 1,
    onProgress: (phase, done, total, within) => progress(phase, done, total, wLevel1, within),
  });
  stats.chunkCount = level1.chunkCount;
  const totalSeconds = options.totalSeconds ?? units[units.length - 1].end;
  let spans: Array<Span & { level: number }> = piecesToSpans(level1.pieces, units, totalSeconds).map((s) => ({ ...s, level: 1 }));
  base += wLevel1;

  // Level 2: a sub-outline inside every long level-1 section (detailed only).
  if (refine) {
    const todo = spans.filter((s) => !s.isAd && isLongSection(s.unitRange[1] - s.unitRange[0], s.endSec - s.startSec));
    const unitsTotal = todo.reduce((n, s) => n + (s.unitRange[1] - s.unitRange[0]), 0);
    let unitsBefore = 0;
    const replaced = new Map<Span, Array<Span & { level: number }>>();
    for (const parent of todo) {
      throwIfAborted(signal);
      const [a, b] = parent.unitRange;
      const size = b - a;
      stats.refinedSections++;
      let sub: LevelResult | null = null;
      try {
        sub = await runLevel(ctx, units.slice(a, b), a, {
          outlinePrompt: (text) => SNAP_PROMPTS.subOutline(text, MAX_ITEMS),
          switchCost: GRANULARITY.detailed.switchCost,
          withAds: false,
          prevBefore: a > 0 ? texts[a - 1] : SNAP_PROMPTS.START_OF_VIDEO,
          level: 2,
          onProgress: (phase, done, total, within) =>
            progress(phase === 'outline' ? 'refine' : phase, done, total, W_REFINE, (unitsBefore + within * size) / unitsTotal),
        });
      } catch (err) {
        if (!(err instanceof ChapteringError) || err.code !== 'outline_empty') throw err;
        log.info(`[Chaptering] level 2: "${parent.label}" stays one chapter (${err.message.slice(0, 120)})`);
      }
      unitsBefore += size;
      if (sub) {
        // The sub-run's spans are relative to the section; childrenOf rebases and tiles them.
        const local = piecesToSpans(sub.pieces.map((p) => ({ ...p, start: p.start - a, end: p.end - a })), units.slice(a, b), parent.endSec);
        const kids = childrenOf(parent, local, units);
        if (kids.length >= 2) replaced.set(parent, kids.map((k) => ({ ...k, level: 2 })));
      }
    }
    spans = spans.flatMap((s) => replaced.get(s) ?? [s]);
    base += W_REFINE;
  }

  // Titles and summaries, in time order, each call seeing the summary and titles before it.
  const chapters: Chapter[] = [];
  let previousDetail = '';
  const tSum = Date.now();
  for (let i = 0; i < spans.length; i++) {
    throwIfAborted(signal);
    const s = spans[i];
    let title = '';
    let summary = '';
    if (summarize) {
      progress('summarize', i, spans.length, wSummarize, i / spans.length);
      const answered = await summarizeChapter(
        options.chat,
        {
          number: i + 1,
          total: spans.length,
          videoTitle: options.videoTitle || 'untitled',
          channelName: options.channelName,
          promotedItems: options.promotedItems,
          previousDetail,
          previousTitles: chapters.slice(-3).map((c) => c.title).filter((t) => t.length > 0),
          units: units.slice(s.unitRange[0], s.unitRange[1]),
          entityScaffold: '',
          thinking: titleThinking,
          clock: `${formatClock(s.startSec)}-${formatClock(s.endSec)}`,
        },
        warn,
        signal,
        formatClock,
      );
      stats.chatCalls += answered.parts === 1 ? 1 : answered.parts + 1;
      if (answered.parts > 1) stats.titledFromParts.push(i + 1);
      title = answered.title;
      summary = answered.summary;
      if (!title) warn(`the chapter at ${formatClock(s.startSec)} was not named by the model; it carries its outline label "${s.label}"`);
      previousDetail = summary || title;
    }
    chapters.push({
      number: i + 1,
      startSec: s.startSec,
      endSec: s.endSec,
      unitRange: s.unitRange,
      label: s.label,
      level: s.level,
      title,
      summary,
      isAd: s.isAd,
    });
  }
  stats.summarizeMs = Date.now() - tSum;
  // Law 8: what was read under a declared rule is counted AND said, once per run.
  stats.flooredUnits = [...new Set(stats.flooredUnits)].sort((a, b) => a - b);
  stats.skippedUnits = [...new Set(stats.skippedUnits)].sort((a, b) => a - b);
  if (stats.flooredUnits.length) {
    warn(
      `${stats.flooredUnits.length} of ${units.length} sentences had an option outside the engine's top letters; ` +
        `each was read with that option at the declared floor (first: sentence ${stats.flooredUnits[0]})`,
    );
  }
  if (stats.skippedUnits.length) {
    warn(
      `${stats.skippedUnits.length} of ${units.length} sentences got an answer with almost no weight on any letter; ` +
        `they carry no evidence and the switch cost placed them (first: sentence ${stats.skippedUnits[0]})`,
    );
  }
  stats.totalMs = Date.now() - t0;
  options.onProgress?.({ phase: 'done', done: chapters.length, total: chapters.length, fraction: 1 });
  return {
    granularity: options.granularity,
    switchCost,
    units,
    outline: level1.outline,
    chapters,
    plugVerdicts: level1.verdicts,
    stats,
    ...(options.diagnostics ? { diagnostics } : {}),
  };
}

// --------------------------------------------------------------------------- one level

interface LevelContext {
  options: ChapterOptions;
  stats: ChapteringStats;
  warn: (message: string) => void;
  signal?: AbortSignal;
  detectAds: boolean;
  /** Collected only on a measurement run. */
  diagnostics: ChunkDiagnostic[] | null;
}

interface LevelSpec {
  outlinePrompt: (text: string, seconds: number) => string;
  switchCost: number;
  withAds: boolean;
  prevBefore: string;
  level: number;
  onProgress: (phase: 'outline' | 'assign' | 'plugs', done: number, total: number, within: number) => void;
}

interface LevelResult {
  /** Global unit pieces, contiguous over the level's units. */
  pieces: ReturnType<typeof stitchChunks>['pieces'];
  outline: string[];
  verdicts: PlugVerdict[];
  chunkCount: number;
}

/** Share of one chunk's progress spent on its outline call; the rest is assign. */
const W_OUTLINE = 0.1;

/**
 * Outline, assign, Viterbi and (level 1) ad confirmation over `units`, chunked when they do
 * not fit one state, stitched back into pieces with global indices (`offset` + local).
 */
async function runLevel(ctx: LevelContext, units: SentenceUnit[], offset: number, spec: LevelSpec): Promise<LevelResult> {
  const { options, stats, signal } = ctx;
  const texts = units.map((u) => u.text);
  const tokens = unitTokens(texts, options.countTokens ? await options.countTokens(texts.join('\n'), signal) : undefined);
  const chunks = planChunks(tokens, options.chunking);
  const unitsTotal = chunks.reduce((n, c) => n + (c.end - c.start), 0);
  let unitsDone = 0;
  let doneWeight = 0;
  const outline: string[] = [];
  const seen = new Set<string>();
  const verdicts: PlugVerdict[] = [];
  const paths: ChunkPath[] = [];
  const plugItem = spec.withAds ? SNAP_PROMPTS.plugItem(options.promotedItems) : null;

  for (let k = 0; k < chunks.length; k++) {
    const chunk = chunks[k];
    const w = (chunk.end - chunk.start) / unitsTotal;
    const report = (phase: 'outline' | 'assign' | 'plugs', within: number) =>
      spec.onProgress(phase, unitsDone, unitsTotal, Math.min(1, doneWeight + w * within));
    const sents = texts.slice(chunk.start, chunk.end);
    const text = sents.join('\n');
    const where = `level ${spec.level}, chunk ${k + 1}/${chunks.length} (units ${offset + chunk.start}-${offset + chunk.end})`;

    // outline
    throwIfAborted(signal);
    report('outline', 0);
    let t = Date.now();
    const seconds = units[chunk.end - 1].end - units[chunk.start].start;
    let items = await writeOutline(options.chat, spec.outlinePrompt(text, seconds), `outline of ${where}`, signal);
    stats.chatCalls++;
    stats.outlineMs += Date.now() - t;
    for (const item of items) {
      if (!seen.has(item.toLowerCase())) {
        seen.add(item.toLowerCase());
        outline.push(item);
      }
    }
    log.info(`[Chaptering] ${where}: outline of ${items.length}: ${items.map((i) => JSON.stringify(i)).join(', ')}`);

    // A one-item outline: nothing to choose between, so no assign and no ad pass. The chunk
    // is one run of that item.
    if (items.length === 1) {
      const path = sents.map(() => 0);
      unitsDone += sents.length;
      doneWeight += w;
      paths.push({ chunk: shift(chunk, offset), path, items, plug: -1 });
      continue;
    }

    if (plugItem !== null) items = [...items, plugItem];
    const plug = plugItem !== null ? items.length - 1 : -1;
    const names = optionNames(items.length);
    const wire = wireOptions(items, names);

    // assign
    t = Date.now();
    const prevBefore = chunk.start > 0 ? texts[chunk.start - 1] : spec.prevBefore;
    const L: number[][] = [];
    report('assign', W_OUTLINE);
    for (let b = 0; b < sents.length; b += BATCH) {
      throwIfAborted(signal);
      const end = Math.min(sents.length, b + BATCH);
      const request: DecideRequest = { state: text, questions: assignQuestions(sents, b, end, wire, prevBefore), missing: 'report' };
      const response = await decideOrRefuse(ctx, request, `assign ${where}, sentences ${b}-${end}`);
      for (let i = b; i < end; i++) {
        const unit = offset + chunk.start + i;
        const dist = readChoiceDistribution(response.answers[questionName(i)], names, `sentence ${unit} (${questionName(i)})`);
        if (dist.missing.length) stats.flooredUnits.push(unit);
        if (dist.skipped) stats.skippedUnits.push(unit);
        L.push(dist.logProbs);
      }
      unitsDone += end - b;
      report('assign', W_OUTLINE + (1 - W_OUTLINE) * (end / sents.length));
    }
    stats.assignMs += Date.now() - t;

    // Viterbi, with ad confirmation at level 1
    throwIfAborted(signal);
    t = Date.now();
    let path: number[];
    if (plug >= 0) {
      report('plugs', 1);
      const reads = new Map<string, PlugVerdict['read']>();
      const ask = async (a: number, b: number): Promise<number> => {
        throwIfAborted(signal);
        const request: DecideRequest = {
          state: text,
          questions: { q: { type: 'yesno', instructions: SNAP_PROMPTS.plugConfirm(sents.slice(a, b), options.promotedItems) } },
          missing: 'report',
        };
        const span = `sentences ${offset + chunk.start + a}-${offset + chunk.start + b}`;
        const response = await decideOrRefuse(ctx, request, `ad confirm ${where}, sentences ${a}-${b}`);
        const read = readYesNo(response.answers.q, `ad confirm ${span}`);
        if (read.p === null) {
          // An ad nobody confirmed is not an ad: the span is re-segmented without the ad item.
          reads.set(`${a}:${b}`, 'no-evidence');
          ctx.warn(
            `the ad check at ${span} got an answer with almost no weight on Yes or No (label mass ${read.labelMass.toFixed(4)}); ` +
              `the stretch is not confirmed as an ad and was chaptered without the ad item`,
          );
          return 0;
        }
        reads.set(`${a}:${b}`, read.floored ? 'floored' : 'answered');
        return read.p;
      };
      const confirmed = await confirmPlugs(L, plug, spec.switchCost, ask);
      path = confirmed.path;
      for (const v of confirmed.verdicts) {
        const read = reads.get(`${v.start}:${v.end}`);
        if (read === undefined) throw new Error(`ad verdict ${v.start}-${v.end} has no reading recorded`);
        verdicts.push({ start: offset + chunk.start + v.start, end: offset + chunk.start + v.end, p: v.p, read });
      }
      if (confirmed.verdicts.length) {
        log.info(`[Chaptering] ${where}: ad verdicts ${confirmed.verdicts.map((v) => `${v.start}-${v.end}:${v.p.toFixed(2)}`).join(' ')}`);
      }
    } else {
      path = viterbi(L, spec.switchCost);
    }
    stats.plugMs += Date.now() - t;
    doneWeight += w;
    paths.push({ chunk: shift(chunk, offset), path, items, plug });
    if (ctx.diagnostics) {
      const top = L.map((row) => row.reduce((best, x, j) => (x > row[best] ? j : best), 0));
      ctx.diagnostics.push({
        level: spec.level,
        start: offset + chunk.start,
        end: offset + chunk.end,
        items,
        plug,
        top,
        topP: L.map((row, i) => Math.exp(row[top[i]])),
        plugP: plug >= 0 ? L.map((row) => Math.exp(row[plug])) : [],
        path,
      });
    }
  }

  const { pieces } = stitchChunks(paths);
  return { pieces, outline, verdicts, chunkCount: chunks.length };
}

/** A chunk's ranges in global unit indices. */
function shift(chunk: Chunk, offset: number): Chunk {
  return { start: chunk.start + offset, end: chunk.end + offset, coreStart: chunk.coreStart + offset, coreEnd: chunk.coreEnd + offset };
}

/**
 * One decide call, counted, with the one refusal this service reads by name: an engine that
 * cannot serve the decision (PHASE22 §2.4 `decide_not_served`) ends the run, naming the
 * server. There is no other way to assign sentences (Law 1, plan §10.5).
 */
async function decideOrRefuse(ctx: LevelContext, request: DecideRequest, what: string) {
  ctx.stats.decideCalls++;
  try {
    return await ctx.options.decide(request, { what, signal: ctx.signal });
  } catch (err) {
    if (isTransportFailure(err) && err.code === 'decide_not_served') {
      const server = err.server ? `Crucible "${err.server}"` : 'the Crucible server';
      throw new ChapteringError(
        'decide_not_served',
        `${server} cannot serve this decision (${err.message}). Sentences cannot be assigned any other way, ` +
          `so chaptering on snap stops here; nothing falls back to the whole-transcript call (${what}).`,
      );
    }
    throw err;
  }
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new ChapteringError('cancelled', 'chaptering was cancelled');
}

/** "2 hours 12 minutes" / "48 minutes" / "under a minute": the runtime in words, as the whole-transcript prompts state it. */
export function runtimeWords(seconds: number): string {
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  if (h > 0) return `${h} hour${h === 1 ? '' : 's'}${m > 0 ? ` ${m} minute${m === 1 ? '' : 's'}` : ''}`;
  if (m > 0) return `${m} minute${m === 1 ? '' : 's'}`;
  return 'under a minute';
}

/** H:MM:SS or M:SS. */
export function formatClock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
