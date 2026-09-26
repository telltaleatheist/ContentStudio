/**
 * Title ranking: a snap `choice` over the candidate titles, best to worst (P9; LEDGER #201;
 * plan §11 "title ranking by relative comparison").
 *
 * ONE QUESTION PER ROTATION. A choice's letters are a position, and a model leans on a position
 * (A, most often) whatever sits there. So the candidates are asked n times, rotated by one each
 * time, so every title sits in every position exactly once, and a title's probability is its mean
 * over the n rotations. The options are named by POSITION (`title 1` is always letter A), so the
 * name a title is shown with moves with it and carries no fixed favourite either. The rotations
 * share one state (primed once), and the titles are quoted as the options' text: never an index
 * (plan §0a).
 *
 * THE PER-VIDEO BASELINE (plan §0a). Probabilities over n options sum to one, so an absolute 0.5
 * means nothing: with ten candidates a clear favourite may hold 0.3. Each title's `relative` is its
 * probability over the fair share 1/n — 1.0 is exactly average for this video's list, 2.0 twice
 * it — and that, never the raw probability, is what the ranking reports. Nothing is gated on the
 * rank: it ORDERS, which is what the 177 decided A/B tests measured (P9.md). It is analysis, not
 * title-writing guidance (Law 5 untouched).
 *
 * AT MOST 26 candidates (A..Z). A longer list is refused by name here; the gate declares an item
 * it did not rank rather than ranking a cut of it.
 */

import { promptAssets } from '../prompt-assets';
import { formatPrompt } from '../system-prompts';
import { MAX_OPTIONS, readChoice, wireOptions } from './decide-read';
import { REROLL_FILE } from './rules';
import { ChoiceQuestion, DecideFn, DecideRequest, GateError } from './types';

export interface RankedTitle {
  title: string;
  /** Mean probability over the rotations, renormalised under the declared floor. */
  p: number;
  /** p over the fair share 1/n: the per-video baseline applied. */
  relative: number;
  /** 1 = best. */
  rank: number;
}

export interface RankingResult {
  /** Best first. */
  order: RankedTitle[];
  /** Rotations whose answer fell under the label-mass gate and were left out of the mean (declared). */
  skippedRotations: number;
  request: DecideRequest;
  /** Question name -> the probabilities read, in the question's own option order. */
  answers: Record<string, number[]>;
}

/** Option names by position: `title 1` is letter A in every rotation. */
export function positionNames(n: number): string[] {
  return Array.from({ length: n }, (_, k) => `title ${k + 1}`);
}

/** Rotation r shows title (r + j) mod n at position j. */
export function rotationOrder(n: number, r: number): number[] {
  return Array.from({ length: n }, (_, j) => (r + j) % n);
}

export function rankRequest(titles: readonly string[], channel: string): DecideRequest {
  const n = titles.length;
  if (n < 2) throw new GateError('bad_request', `ranking needs at least 2 titles; got ${n}`);
  if (n > MAX_OPTIONS) throw new GateError('bad_request', `ranking takes at most ${MAX_OPTIONS} titles (A..Z); got ${n}`);
  const clean = titles.map((t) => t.replace(/\s+/g, ' ').trim());
  if (new Set(clean).size !== n) throw new GateError('bad_request', 'ranking was handed the same title twice');
  const instructions = promptAssets().pipeline(REROLL_FILE, 'rank.question');
  const names = positionNames(n);
  const questions: Record<string, ChoiceQuestion> = {};
  for (let r = 0; r < n; r++) {
    questions[`rotation_${r}`] = { type: 'choice', instructions, options: wireOptions(rotationOrder(n, r).map((i) => clean[i]), names) };
  }
  return { state: formatPrompt(promptAssets().pipeline(REROLL_FILE, 'rank.state'), { channel }), questions, missing: 'report' };
}

/** The mean over rotations of each title's probability, read under the floor, best first. */
export function readRanking(titles: readonly string[], request: DecideRequest, response: { answers: Record<string, unknown> }, what: string): RankingResult {
  const n = titles.length;
  const names = positionNames(n);
  const sum = new Array<number>(n).fill(0);
  let used = 0;
  let skippedRotations = 0;
  const answers: Record<string, number[]> = {};
  for (let r = 0; r < n; r++) {
    const name = `rotation_${r}`;
    const dist = readChoice(response.answers[name] as never, names, `${what} [${name}]`);
    answers[name] = dist.probs;
    if (dist.skipped) {
      skippedRotations++;
      continue;
    }
    used++;
    rotationOrder(n, r).forEach((title, position) => {
      sum[title] += dist.probs[position];
    });
  }
  if (used === 0) throw new GateError('no_answer', `${what}: every rotation fell under the label-mass gate; the titles cannot be ordered`);
  const scored = titles.map((title, i) => ({ title, p: sum[i] / used, relative: (sum[i] / used) * n, index: i }));
  // Ties keep the generated order: the rank never invents a preference the probabilities do not hold.
  scored.sort((a, b) => b.p - a.p || a.index - b.index);
  return {
    order: scored.map((s, k) => ({ title: s.title, p: s.p, relative: s.relative, rank: k + 1 })),
    skippedRotations,
    request,
    answers,
  };
}

export async function rankTitles(titles: readonly string[], channel: string, decide: DecideFn, what: string, signal?: AbortSignal): Promise<RankingResult> {
  const request = rankRequest(titles, channel);
  const response = await decide(request, { what, signal });
  return readRanking(titles, request, response, what);
}
