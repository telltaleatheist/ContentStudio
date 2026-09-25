/**
 * Chaptering at a chosen granularity — OUTLINE + ASSIGN + Viterbi on snap (LEDGER #199, #208).
 *
 * One service, two grains (plan §10.1 as renamed by #208): `chapters`, the subject changes inside
 * a video that go to YouTube (the metadata pipeline), and `stories`, the stream-level splits into
 * completely different subjects (the editor's Stories and the in-queue split of a stream). The
 * method, ported from segment.py (docs/crucible/reference/segment.py) by way of Briefcase's
 * TypeScript, measured on YTSeg at F1@±1 0.72:
 *
 *   1. UNITS      the transcript cut into sentence units, times from the captions (units.ts).
 *   2. OUTLINE    the scorer model (the 9B) lists the sections as plain lines, at the grain's
 *                 prompt (outline.ts, prompts.ts). A long transcript is cut into chunks that
 *                 each fit one state under ~12k tokens (chunks.ts), and each chunk writes its
 *                 own outline. At `stories` those outlines are MERGED into one stream-level
 *                 outline (#208) that every chunk is assigned against; at `chapters` each chunk
 *                 is assigned against its own and the chunks are stitched at the seams.
 *   3. ASSIGN     one snap choice per sentence, quoting the sentence and the one before it;
 *                 the options are the outline items plus the ad item (assign.ts).
 *   4. BASELINE   the ad option is read as its rise above its own median over the video
 *                 (plugs.ts, plan §0a), so its lean stops pulling sentences to it.
 *   5. VITERBI    the best item per sentence under the dial's flat switch cost (viterbi.ts,
 *                 granularity.ts): one pass over the whole stream with a stream outline, one per
 *                 chunk without. Boundaries are where the item changes.
 *   6. ADS        every stretch assigned to the ad item is confirmed by a yes/no (at a lower bar
 *                 near Owen's usual ad marks at `chapters`); a rejected one is re-segmented
 *                 without it. A run the outline itself named, on which the ad option was a
 *                 close second, is asked the same yes/no and flagged when it says so (plugs.ts).
 *   7. LEVEL 2    at `chapters`, every long level-1 section gets the same method over its own
 *                 units (a sub-outline, no ad item); the children tile the parent. That is the
 *                 plan's two-level outline (§10.2), which keeps every state small and every
 *                 question inside 26 options.
 *   8. TITLES     each chapter's title and summary from `summarize_chapter` on the capable
 *                 model (the 27B; summarize.ts), thinking ON with a declared budget (#208),
 *                 tagged HOST:/CLIP: when the transcript knows its speakers.
 *
 * PURE ORCHESTRATION: every model call goes through the injected `chat` and `decide`
 * (types.ts), so tools/chaptering-checks.js drives the whole thing with a fake and the app with
 * the Crucible transport (snap-chapters.ts). Nothing here picks a model (#204) and nothing here
 * imports electron/crucible/.
 *
 * WHAT IS DECLARED, NEVER SILENT (Laws 1 and 8): a `decide_not_served` from the transport is
 * a refusal by name (there is no fall back to the whole-transcript call); an outline answered in
 * prose is a refusal naming the call; a unit under the label-mass gate is recorded as skipped; a
 * floored label is counted; the ad baseline, the stream outline and every ad verdict with its
 * threshold are in the result; an unreadable title costs one chapter its title, warned, never
 * re-asked (Law 3).
 */

import * as log from 'electron-log';
import { TranscriptInput, UnitOptions, captionsOf, sentenceUnits, speakerRolesOf } from './units';
import { granularitySetting, isLongSection } from './granularity';
import { BATCH, MAX_ITEMS, SNAP_PROMPTS } from './prompts';
import { writeOutline } from './outline';
import { assignQuestions, optionNames, questionName, readChoiceDistribution, readYesNo, wireOptions } from './assign';
import { viterbi } from './viterbi';
import { CONFIRM_THRESHOLD, adBaseline, baselineRow, confirmPlugs, confirmThreshold, confirmWindows, isOutlineItemCandidate, trimToCores } from './plugs';
import { Chunk, ChunkPath, ChunkPlanOptions, Piece, pathPieces, planChunks, stitchChunks, unitTokens } from './chunks';
import { Span, childrenOf, piecesToSpans } from './chapters';
import { TITLE_MAX_TOKENS, summarizeChapter } from './summarize';
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
  SpeakerRole,
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
  /** Write titles and summaries on the capable model. Default true; off for a boundaries-only run. */
  summarize?: boolean;
  /**
   * Thinking on the title calls. Default ON (Owen, 2026-09-25, LEDGER #208: a title and summary is
   * a judgment call, and thinking goes on "if we're doing something that might require it").
   * OFF is a declared setting of a run: logged, and stated in its warnings (Law 8).
   */
  titleThinking?: boolean;
  /** The title calls' output budget. Default TITLE_MAX_TOKENS (16,384, #208's starting point). */
  titleMaxTokens?: number;
  /**
   * Override the grain's switch cost: the dial (#208 "we should be able to draw chapters out at
   * any granularity level"). Declared: logged and reported in the result.
   */
  switchCost?: number;
  chunking?: ChunkPlanOptions;
  /** A real token count of the whole state text on the scorer model. Absent: ~4 characters per token. */
  countTokens?: (text: string, signal?: AbortSignal) => Promise<number>;
  unitOptions?: UnitOptions;
  /**
   * Which side each speaker id is (units.ts `speakerRolesOf`). `chapter()` reads it off the
   * transcript; a caller with a unit list states it or leaves the titles untagged.
   */
  speakerRoles?: ReadonlyMap<string, SpeakerRole>;
  signal?: AbortSignal;
  onProgress?: (p: ChapteringProgress) => void;
  /** Return each chunk's per-sentence reading in `result.diagnostics` (tools/chaptering-run.js). */
  diagnostics?: boolean;
}

/**
 * Share of the progress bar per phase, weighted by work rather than by stage (plan §0a). Assign is
 * most of a run's wall time with titles thinking off (P8a: 2,683 s of assign against 525 s of
 * titles on the stream); a thinking title costs minutes where a plain one costs ~12 s (P8a, P8b),
 * so with thinking on the titles take the larger share.
 */
const W_LEVEL1 = 0.45;
const W_REFINE = 0.4;
const W_SUMMARIZE = 0.15;
const W_SUMMARIZE_THINKING = 0.5;

/**
 * A transcript -> its chapters at the chosen granularity. The one entry point (plan §10.1):
 * captions, or any transcript file ContentStudio holds (units.ts TranscriptInput).
 */
export async function chapter(transcript: TranscriptInput, options: ChapterOptions): Promise<ChapteringResult> {
  const units = sentenceUnits(captionsOf(transcript), options.unitOptions);
  return chapterUnits(units, { ...options, speakerRoles: options.speakerRoles ?? speakerRolesOf(transcript) });
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
    streamOutline: null,
    adBaseline: null,
    speakerTagged: false,
    titleMs: [],
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
    log.info(`[Chaptering] switch cost ${options.switchCost} overrides the ${options.granularity} grain's ${setting.switchCost} for this run (the dial)`);
  }
  throwIfAborted(signal);

  const refine = setting.refine;
  const summarize = options.summarize ?? true;
  const titleThinking = options.titleThinking ?? true;
  const titleMaxTokens = options.titleMaxTokens ?? TITLE_MAX_TOKENS;
  if (summarize) {
    log.info(`[Chaptering] titles: thinking ${titleThinking ? 'ON' : 'OFF'}, budget ${titleMaxTokens} tokens`);
    if (!titleThinking) warn('titles were written with thinking OFF on the title model (a declared setting of this run)');
  }

  // Speaker tags are all-or-nothing (chapter-whole-transcript.service.ts's rule): every unit's
  // speaker resolves to a side, or no title call is tagged.
  const roles = options.speakerRoles;
  const resolved = roles ? units.filter((u) => u.speaker !== undefined && roles.has(u.speaker)).length : 0;
  stats.speakerTagged = roles !== undefined && resolved === units.length;
  if (!stats.speakerTagged && resolved > 0) {
    warn(
      `only ${resolved} of ${units.length} sentences have a speaker that resolves to HOST or CLIP, so the titles were ` +
        `written WITHOUT speaker tags (attribution between the host and the footage may be inverted)`,
    );
  }
  const roleOf = (u: SentenceUnit): SpeakerRole | undefined => (stats.speakerTagged ? roles!.get(u.speaker!) : undefined);

  const wLevel1 = refine ? W_LEVEL1 : W_LEVEL1 + W_REFINE;
  const wSummarize = summarize ? (titleThinking ? W_SUMMARIZE_THINKING : W_SUMMARIZE) : 0;
  const scale = wLevel1 + (refine ? W_REFINE : 0) + wSummarize;
  let base = 0;
  const progress = (phase: ChapteringProgress['phase'], done: number, total: number, share: number, within: number) =>
    options.onProgress?.({ phase, done, total, fraction: Math.min(1, (base + share * within) / scale) });

  const diagnostics: ChunkDiagnostic[] = [];
  const ctx: LevelContext = { options, stats, warn, signal, detectAds, diagnostics: options.diagnostics ? diagnostics : null };
  const texts = units.map((u) => u.text);

  // Level 1: the whole video at the grain's outline and the dial's switch cost.
  progress('outline', 0, units.length, wLevel1, 0);
  const level1 = await runLevel(ctx, units, 0, {
    outlinePrompt: (text, seconds) => SNAP_PROMPTS.outline(options.granularity, text, MAX_ITEMS, runtimeWords(seconds)),
    mergeKey: setting.mergeKey,
    switchCost,
    withAds: detectAds,
    adPrior: setting.adPrior,
    prevBefore: SNAP_PROMPTS.START_OF_VIDEO,
    level: 1,
    onProgress: (phase, done, total, within) => progress(phase, done, total, wLevel1, within),
  });
  stats.chunkCount = level1.chunkCount;
  stats.streamOutline = level1.streamOutline;
  stats.adBaseline = level1.adBaseline;
  const totalSeconds = options.totalSeconds ?? units[units.length - 1].end;
  let spans: Array<Span & { level: number }> = piecesToSpans(level1.pieces, units, totalSeconds).map((s) => ({ ...s, level: 1 }));
  base += wLevel1;

  // Level 2: a sub-outline inside every long level-1 section (chapters only), at the run's dial.
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
          mergeKey: null,
          switchCost,
          withAds: false,
          adPrior: false,
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
          units: units.slice(s.unitRange[0], s.unitRange[1]).map((u) => ({ text: u.text, start: u.start, end: u.end, role: roleOf(u) })),
          entityScaffold: '',
          thinking: titleThinking,
          maxTokens: titleMaxTokens,
          tagged: stats.speakerTagged,
          clock: `${formatClock(s.startSec)}-${formatClock(s.endSec)}`,
        },
        warn,
        signal,
        formatClock,
      );
      stats.chatCalls += answered.callMs.length;
      stats.titleMs.push(...answered.callMs);
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
  /** The merge body for a stream-level outline, or null to assign each chunk against its own. */
  mergeKey: string | null;
  switchCost: number;
  withAds: boolean;
  /** Lower the confirm bar near the channel's usual ad marks (plugs.ts AD_PRIOR). */
  adPrior: boolean;
  prevBefore: string;
  level: number;
  onProgress: (phase: 'outline' | 'assign' | 'plugs', done: number, total: number, within: number) => void;
}

interface LevelResult {
  /** Global unit pieces, contiguous over the level's units. */
  pieces: Piece[];
  outline: string[];
  streamOutline: string[] | null;
  adBaseline: number | null;
  verdicts: PlugVerdict[];
  chunkCount: number;
}

/** One chunk's outline and assign, before Viterbi. */
interface ChunkReading {
  chunk: Chunk;
  /** The chunk's sentences, joined: the decide state. */
  text: string;
  items: string[];
  /** Index of the ad item in `items`, or -1. */
  plug: number;
  /** Local unit index (within the level) -> its log distribution, for every unit that was asked. */
  rows: Map<number, number[]>;
}

/** Progress shares inside one level: the outline calls, then assign by question, then the ad checks. */
const P_OUTLINE = 0.08;
const P_PLUGS = 0.02;

/**
 * Outline, assign, Viterbi and (level 1) ad confirmation over `units` (global indices `offset` +
 * local), chunked when they do not fit one state. Returns contiguous pieces covering every unit.
 *
 * Two modes (granularity.ts):
 *   - PER CHUNK (`mergeKey` null, or one chunk): each chunk is assigned against its own outline,
 *     every unit of its state is asked, Viterbi runs per chunk, and the chunks are stitched where
 *     their overlaps agree (chunks.ts). This is P8a's path, unchanged but for the baseline.
 *   - STREAM (`mergeKey` set and more than one chunk, #208): the chunk outlines are merged into
 *     one, every chunk is assigned against it, only the units a chunk's CORE owns are asked (the
 *     overlap stays in the state as context: every unit is asked exactly once), and one Viterbi
 *     pass runs over the whole stream.
 */
async function runLevel(ctx: LevelContext, units: SentenceUnit[], offset: number, spec: LevelSpec): Promise<LevelResult> {
  const { options, stats, signal } = ctx;
  const texts = units.map((u) => u.text);
  const tokens = unitTokens(texts, options.countTokens ? await options.countTokens(texts.join('\n'), signal) : undefined);
  const chunks = planChunks(tokens, options.chunking);
  const streamMode = spec.mergeKey !== null && chunks.length > 1;
  const where = (k: number) => `level ${spec.level}, chunk ${k + 1}/${chunks.length} (units ${offset + chunks[k].start}-${offset + chunks[k].end})`;
  const plugItem = spec.withAds ? SNAP_PROMPTS.plugItem(options.promotedItems) : null;

  // --- outlines ---------------------------------------------------------------------
  const outline: string[] = [];
  const seen = new Set<string>();
  const own: string[][] = [];
  const outlineCalls = chunks.length + (streamMode ? 1 : 0);
  for (let k = 0; k < chunks.length; k++) {
    throwIfAborted(signal);
    spec.onProgress('outline', k, outlineCalls, (P_OUTLINE * k) / outlineCalls);
    const chunk = chunks[k];
    const t = Date.now();
    const seconds = units[chunk.end - 1].end - units[chunk.start].start;
    const items = await writeOutline(options.chat, spec.outlinePrompt(texts.slice(chunk.start, chunk.end).join('\n'), seconds), `outline of ${where(k)}`, signal);
    stats.chatCalls++;
    stats.outlineMs += Date.now() - t;
    own.push(items);
    for (const item of items) {
      if (!seen.has(item.toLowerCase())) {
        seen.add(item.toLowerCase());
        outline.push(item);
      }
    }
    log.info(`[Chaptering] ${where(k)}: outline of ${items.length}: ${items.map((i) => JSON.stringify(i)).join(', ')}`);
  }
  let streamOutline: string[] | null = null;
  if (streamMode) {
    throwIfAborted(signal);
    spec.onProgress('outline', chunks.length, outlineCalls, (P_OUTLINE * chunks.length) / outlineCalls);
    const t = Date.now();
    const whole = units[units.length - 1].end - units[0].start;
    const stretches = chunks.map((c, k) => ({ clock: `${formatClock(units[c.coreStart].start)}-${formatClock(units[c.coreEnd - 1].end)}`, items: own[k] }));
    streamOutline = await writeOutline(
      options.chat,
      SNAP_PROMPTS.streamMerge(spec.mergeKey!, stretches, MAX_ITEMS, runtimeWords(whole)),
      `stream outline over ${chunks.length} chunk outlines (level ${spec.level})`,
      signal,
    );
    stats.chatCalls++;
    stats.outlineMs += Date.now() - t;
    log.info(`[Chaptering] level ${spec.level}: stream outline of ${streamOutline.length} over ${chunks.length} chunks: ${streamOutline.map((i) => JSON.stringify(i)).join(', ')}`);
  }

  // --- assign -----------------------------------------------------------------------
  // Which units each chunk asks about: all of its state per chunk; only its core in stream mode.
  const asked = chunks.map((c) => (streamMode ? [c.coreStart, c.coreEnd] : [c.start, c.end]) as [number, number]);
  const questionsTotal = asked.reduce((n, [a, b]) => n + (b - a), 0);
  let questionsDone = 0;
  const readings: ChunkReading[] = [];
  const tAssign = Date.now();
  for (let k = 0; k < chunks.length; k++) {
    const chunk = chunks[k];
    const text = texts.slice(chunk.start, chunk.end).join('\n');
    let items = streamOutline ?? own[k];
    const rows = new Map<number, number[]>();
    // A one-item outline: nothing to choose between, so no assign and no ad pass. The chunk
    // is one run of that item.
    if (items.length === 1) {
      readings.push({ chunk, text, items, plug: -1, rows });
      questionsDone += asked[k][1] - asked[k][0];
      continue;
    }
    if (plugItem !== null) items = [...items, plugItem];
    const plug = plugItem !== null ? items.length - 1 : -1;
    const names = optionNames(items.length);
    const wire = wireOptions(items, names);
    const [from, to] = asked[k];
    // Local indices inside the chunk's state, as assignQuestions reads them.
    const sents = texts.slice(chunk.start, chunk.end);
    const prevBefore = chunk.start > 0 ? texts[chunk.start - 1] : spec.prevBefore;
    for (let b = from - chunk.start; b < to - chunk.start; b += BATCH) {
      throwIfAborted(signal);
      const end = Math.min(to - chunk.start, b + BATCH);
      const request: DecideRequest = { state: text, questions: assignQuestions(sents, b, end, wire, prevBefore), missing: 'report' };
      const response = await decideOrRefuse(ctx, request, `assign ${where(k)}, sentences ${b}-${end}`);
      for (let i = b; i < end; i++) {
        const unit = offset + chunk.start + i;
        const dist = readChoiceDistribution(response.answers[questionName(i)], names, `sentence ${unit} (${questionName(i)})`);
        if (dist.missing.length) stats.flooredUnits.push(unit);
        if (dist.skipped) stats.skippedUnits.push(unit);
        rows.set(chunk.start + i, dist.logProbs);
      }
      questionsDone += end - b;
      spec.onProgress('assign', questionsDone, questionsTotal, P_OUTLINE + (1 - P_OUTLINE - P_PLUGS) * (questionsDone / questionsTotal));
    }
    readings.push({ chunk, text, items, plug, rows });
  }
  stats.assignMs += Date.now() - tAssign;

  // --- the ad baseline (plan §0a) -----------------------------------------------------
  // Over the units each chunk's CORE owns, so a sentence in two chunks' overlap counts once.
  let baseline: number | null = null;
  if (plugItem !== null) {
    const owned: Array<{ row: number[]; plug: number }> = [];
    for (const r of readings) {
      if (r.plug < 0) continue;
      for (let u = r.chunk.coreStart; u < r.chunk.coreEnd; u++) {
        const row = r.rows.get(u);
        if (row) owned.push({ row, plug: r.plug });
      }
    }
    if (owned.length > 0) {
      baseline = adBaseline(owned);
      for (const r of readings) {
        if (r.plug < 0) continue;
        for (const [u, row] of r.rows) r.rows.set(u, baselineRow(row, r.plug, baseline));
      }
      log.info(
        `[Chaptering] level ${spec.level}: the ad option's median over ${owned.length} sentences is read as a baseline of ` +
          `${baseline.toFixed(3)}; every ad score is its rise above it (plan §0a)`,
      );
    }
  }

  // --- Viterbi and the ad checks ------------------------------------------------------
  spec.onProgress('plugs', questionsDone, questionsTotal, 1 - P_PLUGS);
  const tPlugs = Date.now();
  const verdicts: PlugVerdict[] = [];
  /** Which chunk owns each local unit (its core), for the yes/no's state. */
  const ownerOf = (u: number) => readings.findIndex((r) => u >= r.chunk.coreStart && u < r.chunk.coreEnd);
  const secondsOf = (a: number, b: number): [number, number] => [units[a].start, units[b - 1].end];
  /** One yes/no over local units [a, b), on chunk `k`'s state; P(yes) under the declared reading. */
  const askPlug = async (k: number, a: number, b: number, source: PlugVerdict['source']): Promise<{ p: number; read: PlugVerdict['read'] }> => {
    throwIfAborted(signal);
    const span = `sentences ${offset + a}-${offset + b}`;
    const request: DecideRequest = {
      state: readings[k].text,
      questions: { q: { type: 'yesno', instructions: SNAP_PROMPTS.plugConfirm(texts.slice(a, b), options.promotedItems) } },
      missing: 'report',
    };
    const response = await decideOrRefuse(ctx, request, `ad confirm (${source}) ${where(k)}, ${span}`);
    const read = readYesNo(response.answers.q, `ad confirm ${span}`);
    if (read.p === null) {
      // An ad nobody confirmed is not an ad.
      ctx.warn(
        `the ad check at ${span} got an answer with almost no weight on Yes or No (label mass ${read.labelMass.toFixed(4)}); ` +
          `the stretch is not confirmed as an ad${source === 'ad-option' ? ' and was chaptered without the ad item' : ''}`,
      );
      return { p: 0, read: 'no-evidence' };
    }
    return { p: read.p, read: read.floored ? 'floored' : 'answered' };
  };
  const threshold = (a: number, b: number) => {
    const [s, e] = secondsOf(a, b);
    return confirmThreshold(s, e, spec.adPrior);
  };

  let pieces: Piece[];
  /** Local unit -> its (baselined) row and the ad option's index in it, for the outline-item check. */
  const rowOf = (u: number): { row: number[]; plug: number } | null => {
    const k = ownerOf(u);
    const row = k >= 0 ? readings[k].rows.get(u) : undefined;
    return row ? { row, plug: readings[k].plug } : null;
  };

  if (streamMode) {
    const items = readings[0].items;
    const plug = readings[0].plug;
    const L: number[][] = [];
    for (let u = 0; u < units.length; u++) {
      const own = rowOf(u);
      if (!own && items.length > 1) throw new Error(`stream assign: sentence ${offset + u} was asked by no chunk`);
      L.push(own ? own.row : [0]);
    }
    let path: number[];
    if (items.length === 1) path = units.map(() => 0);
    else if (plug >= 0) {
      const reads = new Map<string, PlugVerdict['read']>();
      const confirmed = await confirmPlugs(L, plug, spec.switchCost, async (a, b) => {
        const answer = await askPlug(ownerOf(Math.floor((a + b - 1) / 2)), a, b, 'ad-option');
        reads.set(`${a}:${b}`, answer.read);
        return answer.p;
      }, threshold);
      const trimmed = trimToCores(confirmed.logProbs, confirmed.path, plug, spec.switchCost);
      path = trimmed.path;
      for (const v of confirmed.verdicts) {
        const trim = trimmed.trims.find((t) => t.start === v.start && t.end === v.end);
        verdicts.push({
          start: offset + v.start, end: offset + v.end, p: v.p, threshold: v.threshold, read: reads.get(`${v.start}:${v.end}`)!, source: 'ad-option',
          ...(trim ? { kept: [offset + trim.core[0], offset + trim.core[1]] as [number, number] } : {}),
        });
      }
    } else path = viterbi(L, spec.switchCost);
    pieces = pathPieces(path, items, plug, offset);
    diagnose(ctx, spec.level, offset, 0, units.length, items, plug, L, path);
  } else {
    const paths: ChunkPath[] = [];
    for (let k = 0; k < readings.length; k++) {
      const r = readings[k];
      const n = r.chunk.end - r.chunk.start;
      if (r.items.length === 1) {
        paths.push({ chunk: shift(r.chunk, offset), path: Array.from({ length: n }, () => 0), items: r.items, plug: -1 });
        continue;
      }
      const L = Array.from({ length: n }, (_, i) => r.rows.get(r.chunk.start + i)!);
      let path: number[];
      if (r.plug >= 0) {
        const reads = new Map<string, PlugVerdict['read']>();
        const at = r.chunk.start;
        const confirmed = await confirmPlugs(L, r.plug, spec.switchCost, async (a, b) => {
          const answer = await askPlug(k, at + a, at + b, 'ad-option');
          reads.set(`${a}:${b}`, answer.read);
          return answer.p;
        }, (a, b) => threshold(at + a, at + b));
        const trimmed = trimToCores(confirmed.logProbs, confirmed.path, r.plug, spec.switchCost);
        path = trimmed.path;
        for (const v of confirmed.verdicts) {
          const trim = trimmed.trims.find((t) => t.start === v.start && t.end === v.end);
          verdicts.push({
            start: offset + at + v.start, end: offset + at + v.end, p: v.p, threshold: v.threshold,
            read: reads.get(`${v.start}:${v.end}`)!, source: 'ad-option',
            ...(trim ? { kept: [offset + at + trim.core[0], offset + at + trim.core[1]] as [number, number] } : {}),
          });
        }
      } else path = viterbi(L, spec.switchCost);
      paths.push({ chunk: shift(r.chunk, offset), path, items: r.items, plug: r.plug });
      diagnose(ctx, spec.level, offset, r.chunk.start, r.chunk.end, r.items, r.plug, L, path);
    }
    pieces = stitchChunks(paths).pieces;
  }

  // --- a plug the outline named as an ordinary item (plugs.ts header, 3) ---------------
  if (plugItem !== null) {
    for (const piece of pieces) {
      if (piece.isAd) continue;
      const a = piece.start - offset;
      const b = piece.end - offset;
      // Each sentence's own row: a piece may cross two chunks' own outlines (different widths),
      // so every row carries the index of its own ad option.
      const rows: Array<{ row: number[]; plug: number }> = [];
      for (let u = a; u < b; u++) {
        const own = rowOf(u);
        if (own && own.plug >= 0) rows.push(own);
      }
      if (!isOutlineItemCandidate(rows)) continue;
      // Every sentence is read: a plug throughout, or not a plug (plugs.ts confirmWindows).
      const windows = confirmWindows(texts, a, b);
      const answer = { p: 1, read: 'answered' as PlugVerdict['read'] };
      for (const [x, y] of windows) {
        const one = await askPlug(ownerOf(Math.floor((x + y - 1) / 2)), x, y, 'outline-item');
        if (one.p < answer.p) answer.p = one.p;
        if (one.read !== 'answered') answer.read = one.read;
      }
      // segment.py's 0.5, never the prior's lower bar: the outline named this stretch as content,
      // and on Duffy the prior's 0.25 flagged a parenting critique near 10:00 (P8b.md).
      const need = CONFIRM_THRESHOLD;
      verdicts.push({
        start: piece.start, end: piece.end, p: answer.p, threshold: need, read: answer.read, source: 'outline-item',
        ...(windows.length > 1 ? { windows: windows.length } : {}),
      });
      if (answer.p >= need) {
        piece.isAd = true;
        log.info(`[Chaptering] level ${spec.level}: "${piece.label}" (sentences ${piece.start}-${piece.end}) is a plug the outline named; the yes/no said ${answer.p.toFixed(2)}`);
      }
    }
  }
  stats.plugMs += Date.now() - tPlugs;
  verdicts.sort((x, y) => x.start - y.start);
  return { pieces, outline: streamOutline ?? outline, streamOutline, adBaseline: baseline, verdicts, chunkCount: chunks.length };
}

/** Record one Viterbi pass's reading for a measurement run (never read by the pipeline). */
function diagnose(ctx: LevelContext, level: number, offset: number, start: number, end: number, items: string[], plug: number, L: number[][], path: number[]): void {
  if (!ctx.diagnostics) return;
  const top = L.map((row) => row.reduce((best, x, j) => (x > row[best] ? j : best), 0));
  ctx.diagnostics.push({
    level,
    start: offset + start,
    end: offset + end,
    items,
    plug,
    top,
    topP: L.map((row, i) => Math.exp(row[top[i]])),
    plugP: plug >= 0 ? L.map((row) => Math.exp(row[plug])) : [],
    path,
  });
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
