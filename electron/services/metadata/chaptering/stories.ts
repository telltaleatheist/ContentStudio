/**
 * The STORIES grain: 45-second stretches judged one against the last, on snap (LEDGER #212).
 *
 * Owen, 2026-09-25: "we got REALLY close to perfect when we were taking it in 45 second chunks with
 * a smaller model. we could probably try that again with snap - send 45 seconds worth of text
 * through and judge whether it's a new subject from the one before." The stream-level merged
 * outline this replaces found 2 of his 7 edges on the 2026-09-23 stream and lost the Pokémon story
 * (docs/crucible/P8b.md). The method is the editor's old analyzer, chapter-splitter.ts (kept as the
 * spec in docs/crucible/reference/chapter-splitter.ts), stage for stage, with every question it
 * asked a 14B in JSON re-asked as a snap decision on the scorer (the 9B):
 *
 *   1  STRETCHES    the sentence units cut into ~45 s stretches, each ending at a sentence end.
 *   2  JUNCTIONS    one yes/no per junction QUOTING the stretch before and the stretch after:
 *                   "the stretch after it starts a completely different story". P(yes) is read and
 *                   ranked, never thresholded.
 *   3  SELECT       code only: the reference's duration-derived count (its cadence table), taken
 *                   in rank order of P(yes) with a minimum gap of 0.6 × the cadence, ties
 *                   farthest-first. It deliberately OVER-segments: an over-split is one click for
 *                   Owen to join, a missed story cannot be added back by hand.
 *   4  PLACE        one choice per selected junction over the lines of its two stretches: "which
 *                   line is the first line of the new subject". The cut is that sentence's start
 *                   (Law 6: the model never emits a time).
 *   5  CONSOLIDATE  one yes/no per adjacent pair QUOTING both parts: "part B carries on the same
 *                   story as part A". The most probable merge is applied first and its two new
 *                   neighbours re-asked, while the model's answer is Yes (P(yes) ≥ 0.5, its own
 *                   letter), down to a floor of 3 stories (the reference's MIN_CHAPTERS).
 *
 * What differs from the reference, and why: stage 1's per-stretch labels are gone (a snap
 * question quotes the text itself, so no label scaffolding is needed), stage 2 reads a probability
 * where the reference read a 0-3 rating (ranked the same way), stage 3b's quoted sentence is a
 * choice over the window's own lines, and stage 4's per-chapter summaries are not written before
 * consolidation: the pair question quotes the two parts' text. Titles come after, on the existing
 * title path (chaptering.service.ts), for the final stories only.
 *
 * DECLARED, NEVER SILENT (Law 8): a junction or a pair whose answer carried no weight on Yes or No
 * is not ranked or merged, counted and warned; a placement with no evidence keeps the junction's
 * own sentence, counted and warned; a window longer than the choice's 26 letters is trimmed to the
 * lines nearest the junction, counted and logged. The stories grain runs no ad check: a plug inside
 * a story is a chapter of that story's own metadata run.
 */

import * as log from 'electron-log';
import { SNAP_PROMPTS, BATCH, MAX_OPTIONS, clip } from './prompts';
import { readChoiceDistribution, readYesNo } from './assign';
import { planChunks, unitTokens, ChunkPlanOptions, CHARS_PER_TOKEN } from './chunks';
import type { Span } from './chapters';
import { DecideRequest, DecideResponse, SentenceUnit } from './types';

/** The method's constants: the reference's own numbers (chapter-splitter.ts), in one place. */
export const STORY_METHOD = {
  /** Stage 1's granularity, and the accuracy of an unplaced junction. */
  stretchSeconds: 45,
  /** Consolidation's floor: never collapse below this many stories (reference MIN_CHAPTERS). */
  minStories: 3,
  /** Stage 3's minimum gap between chosen junctions, as a fraction of the cadence. */
  minGapFraction: 0.6,
  /** A quoted stretch is clipped to this many characters (45 s of fast speech is ~1,000). */
  stretchQuoteChars: 1400,
  /** Each side of a pair question carries at most this many tokens of its part (A's tail, B's head). */
  pairPartTokens: 5000,
  /** The model's own answer: Yes is the more probable letter. */
  mergeAt: 0.5,
} as const;

/**
 * Target seconds per piece, from the reference (cadence measured across 3,000+ published chapters):
 * ~2.2 min under 10 min, 3.5 at 10-30, 5.6 at 30-60, 6 beyond an hour. It sets how many junctions
 * stage 3 takes, deliberately more than there are stories; stage 5 decides how many stay.
 */
export function targetSecondsFor(durationSeconds: number): number {
  const minutes = durationSeconds / 60;
  if (minutes < 10) return 2.2 * 60;
  if (minutes < 30) return 3.5 * 60;
  if (minutes < 60) return 5.6 * 60;
  return 6 * 60;
}

export function boundaryCountFor(durationSeconds: number): number {
  return Math.max(STORY_METHOD.minStories, Math.round(durationSeconds / targetSecondsFor(durationSeconds))) - 1;
}

/** A stretch: units [start, end), about 45 s, ending at a sentence end. */
export interface Stretch {
  start: number;
  end: number;
}

/** Stage 1. A stretch takes every unit that STARTS within 45 s of its first unit's start. */
export function cutStretches(units: readonly SentenceUnit[], seconds: number = STORY_METHOD.stretchSeconds): Stretch[] {
  const out: Stretch[] = [];
  let a = 0;
  while (a < units.length) {
    let b = a + 1;
    while (b < units.length && units[b].start < units[a].start + seconds) b++;
    out.push({ start: a, end: b });
    a = b;
  }
  return out;
}

export interface Junction {
  /** Between stretch `index` and `index + 1`. */
  index: number;
  /** The after-stretch's first unit: the cut if nothing places it. */
  unit: number;
  at: number;
  /** P(yes: the next stretch is a new subject); null when the answer carried no evidence. */
  p: number | null;
}

/**
 * Stage 3: the reference's selectBoundaries with P(yes) for the rating. Rank order, a minimum gap
 * against every junction already chosen (0:00 seeds the set), ties farthest-first. Unrated
 * junctions are never selectable.
 */
export function selectJunctions(junctions: readonly Junction[], count: number, minGap: number): Junction[] {
  const chosenTimes = [0];
  const chosen: Junction[] = [];
  const pool = junctions.filter((j) => j.p !== null && j.at > 0);
  while (chosen.length < count && pool.length > 0) {
    const eligible = pool.filter((j) => chosenTimes.every((t) => Math.abs(j.at - t) >= minGap));
    if (eligible.length === 0) break;
    const top = Math.max(...eligible.map((j) => j.p!));
    let best = eligible.find((j) => j.p === top)!;
    let bestDistance = -1;
    for (const cand of eligible) {
      if (cand.p !== top) continue;
      const d = Math.min(...chosenTimes.map((t) => Math.abs(cand.at - t)));
      if (d > bestDistance) {
        bestDistance = d;
        best = cand;
      }
    }
    chosen.push(best);
    chosenTimes.push(best.at);
    pool.splice(pool.indexOf(best), 1);
  }
  return chosen.sort((x, y) => x.at - y.at);
}

/** The window stage 4 chooses in: the two stretches, trimmed to the 26 lines nearest the junction. */
export function placementWindow(stretches: readonly Stretch[], j: Junction): { start: number; end: number; trimmed: boolean } {
  let start = stretches[j.index].start;
  let end = stretches[j.index + 1].end;
  if (end - start <= MAX_OPTIONS) return { start, end, trimmed: false };
  const half = Math.floor(MAX_OPTIONS / 2);
  start = Math.max(start, j.unit - half);
  end = Math.min(end, start + MAX_OPTIONS);
  start = Math.max(stretches[j.index].start, end - MAX_OPTIONS);
  return { start, end, trimmed: true };
}

/** One story piece while consolidating: units [start, end). */
export interface Piece {
  start: number;
  end: number;
}

export interface StoryMerge {
  /** The second part's first unit, where the cut that went away was. */
  unit: number;
  at: number;
  p: number;
}

export interface StoryStats {
  stretches: number;
  /** Every junction asked, in time order: where it is and P(yes). */
  junctions: Array<{ at: number; p: number | null }>;
  targetSeconds: number;
  boundaryTarget: number;
  minGapSeconds: number;
  /** The junctions stage 3 took, and where stage 4 placed each (seconds). */
  selected: Array<{ at: number; p: number; placedAt: number | null }>;
  /** Placements with no evidence that kept the junction's own sentence. */
  unplaced: number;
  /** Windows trimmed to the 26 lines nearest the junction. */
  trimmedWindows: number;
  /** Consolidation: every merge applied, in order, and how many pair questions were asked. */
  merges: StoryMerge[];
  pairQuestions: number;
  /** P(yes) of every adjacent pair left standing at the end (the model said two stories). */
  finalPairs: Array<{ at: number; p: number | null }>;
  junctionMs: number;
  placeMs: number;
  consolidateMs: number;
}

export interface StoryDeps {
  decide: (request: DecideRequest, what: string) => Promise<DecideResponse>;
  warn: (message: string) => void;
  throwIfAborted: () => void;
  onProgress: (phase: 'junctions' | 'place' | 'consolidate', done: number, total: number, within: number) => void;
  chunking?: ChunkPlanOptions;
  countTokens?: (text: string) => Promise<number>;
  totalSeconds: number;
}

/** Progress shares inside the stories stage, by work: junction questions dominate. */
const P_JUNCTIONS = 0.6;
const P_PLACE = 0.1;

export async function storySpans(units: readonly SentenceUnit[], deps: StoryDeps): Promise<{ spans: Span[]; stats: StoryStats; chunkCount: number }> {
  const texts = units.map((u) => u.text);
  const duration = deps.totalSeconds - units[0].start;
  const targetSeconds = targetSecondsFor(duration);
  const boundaryTarget = boundaryCountFor(duration);
  const minGap = STORY_METHOD.minGapFraction * targetSeconds;
  const stats: StoryStats = {
    stretches: 0, junctions: [], targetSeconds, boundaryTarget, minGapSeconds: minGap, selected: [], unplaced: 0, trimmedWindows: 0,
    merges: [], pairQuestions: 0, finalPairs: [], junctionMs: 0, placeMs: 0, consolidateMs: 0,
  };

  // --- 1: stretches ---------------------------------------------------------------------
  const stretches = cutStretches(units);
  stats.stretches = stretches.length;
  const junctionCount = stretches.length - 1;
  log.info(
    `[Stories] ${units.length} sentences, ${(duration / 60).toFixed(1)} min -> ${stretches.length} stretches of ~${STORY_METHOD.stretchSeconds} s, ` +
      `${junctionCount} junctions; cadence ${(targetSeconds / 60).toFixed(1)} min -> ${boundaryTarget} cuts before consolidation (min gap ${Math.round(minGap)} s)`,
  );

  // --- 2: one yes/no per junction, on the state of the chunk that holds it ------------------
  const tokens = unitTokens(texts, deps.countTokens ? await deps.countTokens(texts.join('\n')) : undefined);
  const chunks = planChunks(tokens, deps.chunking);
  const junctions: Junction[] = [];
  for (let i = 0; i < junctionCount; i++) {
    const unit = stretches[i + 1].start;
    junctions.push({ index: i, unit, at: units[unit].start, p: null });
  }
  const t2 = Date.now();
  let done = 0;
  let unrated = 0;
  for (let k = 0; k < chunks.length; k++) {
    const c = chunks[k];
    const mine = junctions.filter((j) => j.unit >= c.coreStart && j.unit < c.coreEnd);
    const state = texts.slice(c.start, c.end).join('\n');
    for (let b = 0; b < mine.length; b += BATCH) {
      deps.throwIfAborted();
      const batch = mine.slice(b, b + BATCH);
      const questions: DecideRequest['questions'] = {};
      for (const j of batch) {
        const before = stretches[j.index];
        const after = stretches[j.index + 1];
        questions[`j${j.index}`] = {
          type: 'yesno',
          instructions: SNAP_PROMPTS.storyJunction(
            clipTail(texts.slice(before.start, before.end).join(' '), STORY_METHOD.stretchQuoteChars),
            clip(texts.slice(after.start, after.end).join(' '), STORY_METHOD.stretchQuoteChars),
          ),
        };
      }
      const response = await deps.decide({ state, questions, missing: 'report' }, `story junctions, chunk ${k + 1}/${chunks.length}, ${b + 1}-${b + batch.length} of ${mine.length}`);
      for (const j of batch) {
        const read = readYesNo(response.answers[`j${j.index}`], `junction at ${clockOf(j.at)}`);
        j.p = read.p;
        if (read.p === null) unrated++;
      }
      done += batch.length;
      deps.onProgress('junctions', done, junctionCount, P_JUNCTIONS * (done / Math.max(1, junctionCount)));
    }
  }
  stats.junctionMs = Date.now() - t2;
  stats.junctions = junctions.map((j) => ({ at: j.at, p: j.p }));
  if (unrated) deps.warn(`${unrated} of ${junctionCount} story junctions got an answer with almost no weight on Yes or No; they were not ranked`);

  // --- 3: select, ranked, never thresholded ---------------------------------------------------
  const selected = selectJunctions(junctions, boundaryTarget, minGap);
  log.info(`[Stories] selected ${selected.length}/${boundaryTarget}: ${selected.map((j) => `${clockOf(j.at)}(${j.p!.toFixed(2)})`).join(' ')}`);

  // --- 4: place each cut at the sentence where the new subject starts --------------------------
  const t4 = Date.now();
  const cuts: number[] = [];
  for (let s = 0; s < selected.length; s++) {
    deps.throwIfAborted();
    const j = selected[s];
    const w = placementWindow(stretches, j);
    if (w.trimmed) {
      stats.trimmedWindows++;
      log.info(`[Stories] the window at ${clockOf(j.at)} has more lines than the choice's ${MAX_OPTIONS} letters; the ${MAX_OPTIONS} nearest the junction were offered`);
    }
    const names = Array.from({ length: w.end - w.start }, (_, i) => `line ${i + 1}`);
    const options: Record<string, string> = {};
    names.forEach((n, i) => (options[n] = clip(texts[w.start + i], 300)));
    const response = await deps.decide(
      { state: texts.slice(w.start, w.end).join('\n'), questions: { place: { type: 'choice', instructions: SNAP_PROMPTS.storyPlace(), options } }, missing: 'report' },
      `story cut ${s + 1}/${selected.length} at ${clockOf(j.at)}`,
    );
    const dist = readChoiceDistribution(response.answers.place, names, `story cut at ${clockOf(j.at)}`);
    let unit = j.unit;
    if (dist.skipped) {
      stats.unplaced++;
      deps.warn(`the story cut near ${clockOf(j.at)} got a placement answer with almost no weight on any line; it stays at the junction's own sentence (±${STORY_METHOD.stretchSeconds} s)`);
    } else {
      unit = w.start + dist.logProbs.reduce((best, x, i) => (x > dist.logProbs[best] ? i : best), 0);
    }
    const previous = cuts.length ? cuts[cuts.length - 1] : 0;
    if (unit <= previous) {
      if (j.unit > previous) {
        deps.warn(`the story cut placed at ${clockOf(units[unit].start)} fell behind the one before it; it stays at the junction's own sentence, ${clockOf(j.at)}`);
        unit = j.unit;
      } else {
        deps.warn(`the story cut near ${clockOf(j.at)} lands on the cut before it and was dropped`);
        stats.selected.push({ at: j.at, p: j.p!, placedAt: null });
        continue;
      }
    }
    cuts.push(unit);
    stats.selected.push({ at: j.at, p: j.p!, placedAt: units[unit].start });
    deps.onProgress('place', s + 1, selected.length, P_JUNCTIONS + P_PLACE * ((s + 1) / Math.max(1, selected.length)));
  }
  stats.placeMs = Date.now() - t4;

  // --- 5: consolidate adjacent pairs, most probable merge first -------------------------------
  const t5 = Date.now();
  const pieces: Piece[] = [];
  [0, ...cuts].forEach((a, i, all) => pieces.push({ start: a, end: i + 1 < all.length ? all[i + 1] : units.length }));
  const partChars = STORY_METHOD.pairPartTokens * CHARS_PER_TOKEN;
  const pairEstimate = Math.max(1, (pieces.length - 1) * 2);
  let noEvidence = 0;
  const askPair = async (i: number): Promise<number | null> => {
    deps.throwIfAborted();
    const a = pieces[i];
    const b = pieces[i + 1];
    const clockA = `${clockOf(units[a.start].start)}-${clockOf(units[b.start].start)}`;
    const clockB = `${clockOf(units[b.start].start)}-${clockOf(i + 2 < pieces.length ? units[pieces[i + 2].start].start : deps.totalSeconds)}`;
    const state = SNAP_PROMPTS.storyPairState(clockA, clipTail(texts.slice(a.start, a.end).join('\n'), partChars), clockB, clip(texts.slice(b.start, b.end).join('\n'), partChars));
    stats.pairQuestions++;
    const response = await deps.decide({ state, questions: { same: { type: 'yesno', instructions: SNAP_PROMPTS.storyPair() } }, missing: 'report' }, `story pair ${clockA} | ${clockB}`);
    const read = readYesNo(response.answers.same, `story pair at ${clockOf(units[b.start].start)}`);
    if (read.p === null) noEvidence++;
    deps.onProgress('consolidate', stats.pairQuestions, pairEstimate, P_JUNCTIONS + P_PLACE + (1 - P_JUNCTIONS - P_PLACE) * Math.min(1, stats.pairQuestions / pairEstimate));
    return read.p;
  };
  const pairP: Array<number | null> = [];
  for (let i = 0; i + 1 < pieces.length; i++) pairP.push(await askPair(i));
  while (pieces.length > STORY_METHOD.minStories) {
    let best = -1;
    for (let i = 0; i < pairP.length; i++) if (pairP[i] !== null && (best < 0 || pairP[i]! > pairP[best]!)) best = i;
    if (best < 0 || pairP[best]! < STORY_METHOD.mergeAt) break;
    const at = units[pieces[best + 1].start].start;
    stats.merges.push({ unit: pieces[best + 1].start, at, p: pairP[best]! });
    log.info(`[Stories] merge at ${clockOf(at)} (P(same story) ${pairP[best]!.toFixed(2)}); ${pieces.length - 1} stories left`);
    pieces[best].end = pieces[best + 1].end;
    pieces.splice(best + 1, 1);
    pairP.splice(best, 1);
    // The merged piece's two neighbours are different questions now.
    if (best > 0) pairP[best - 1] = await askPair(best - 1);
    if (best < pairP.length) pairP[best] = await askPair(best);
  }
  if (pieces.length <= STORY_METHOD.minStories && pairP.some((p) => p !== null && p >= STORY_METHOD.mergeAt)) {
    log.info(`[Stories] consolidation stopped at the ${STORY_METHOD.minStories}-story floor`);
  }
  if (noEvidence) deps.warn(`${noEvidence} story pair questions got an answer with almost no weight on Yes or No; those pairs were not merged`);
  stats.finalPairs = pairP.map((p, i) => ({ at: units[pieces[i + 1].start].start, p }));
  stats.consolidateMs = Date.now() - t5;
  log.info(`[Stories] ${stats.merges.length} merges -> ${pieces.length} stories: ${pieces.map((p) => clockOf(p.start === 0 ? 0 : units[p.start].start)).join(' ')}`);

  const spans: Span[] = pieces.map((p, i) => ({
    startSec: i === 0 ? 0 : units[p.start].start,
    endSec: i + 1 < pieces.length ? units[pieces[i + 1].start].start : Math.max(deps.totalSeconds, units[p.start].start),
    unitRange: [p.start, p.end] as [number, number],
    // No outline names a story: its label is its opening line, quoted, until the title call names it.
    label: `"${clip(texts[p.start], 80)}"`,
    isAd: false,
  }));
  return { spans, stats, chunkCount: chunks.length };
}

/** The tail of `s`: its last n-1 code points after an ellipsis (the end of a stretch is what meets the junction). */
export function clipTail(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : '…' + cps.slice(cps.length - (n - 1)).join('');
}

function clockOf(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}
