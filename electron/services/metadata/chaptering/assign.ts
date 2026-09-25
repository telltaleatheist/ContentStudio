/**
 * Assign: one snap `choice` question per sentence — "which section of the video is this
 * sentence part of?" — quoting the sentence and the one before it, NEVER an index (plan §0a;
 * Owen: "we give it the thing it's judging"). The options are the outline items, plus the ad
 * item last when ads are on. segment.py `assign()` (docs/crucible/reference/segment.py:60-81).
 *
 * TWO WIRE FACTS this file guards (plan §10.3 "Wire"):
 *
 *   - Questions and options cross to Crucible as JSON objects, and their insertion order IS
 *     the letter order (PHASE22 §2.2: "the first option is A"). A JS object lists
 *     integer-like keys first whatever order they were written in, so `{"2": …, "1": …}`
 *     would silently re-letter the options. The measured names are `section 1`..`section n`
 *     (segment.py:62) and `s0`..`s63`, neither integer-like; `wireOptions` refuses any name
 *     that is, by name, and proves the order survived before the request leaves.
 *   - A label outside the engine's top-K comes back null (`missing: 'report'`, N7). The
 *     finite floor Viterbi needs is THIS client's declared rule, `readChoiceDistribution`,
 *     ported from Briefcase crucible-decide.ts floorAnswer: the tighter of two upper bounds
 *     the answer itself proves, clamped to ln(1e-12), then the row renormalised in log space.
 *     Every floored unit is counted; a unit under the label-mass gate is recorded as SKIPPED
 *     and its row flattened (no evidence: the switch cost decides it), never floored quietly.
 */

import { ChoiceAnswer, ChoiceQuestion, ChapteringError, DecideAnswer } from './types';
import { SNAP_PROMPTS } from './prompts';

/** segment.py:80 — log(max(p, 1e-12)): the matrix's floor, the lowest a label may go. */
export const LOG_FLOOR = Math.log(1e-12);

/**
 * Below this much raw mass on the returned letters the answer says nothing about the options:
 * the model wanted to write something that is not a letter (PHASE22 §2.2: "a caller gates on
 * label_mass before it believes p"). 0.01 is ~50x under anything the 9B was seen to answer on
 * a real question (label_mass 0.9+; Briefcase LABEL_MASS_GATE).
 */
export const LABEL_MASS_GATE = 0.01;

/** The server's top-K margin (PHASE22 §2.4: K is the labels plus 4). Bounds a missing label's probability. */
export const DECIDE_TOP_K_MARGIN = 4;

/** A JS object lists integer-like keys first, whatever order they were written in. */
export function integerLike(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}

/** segment.py:62 — the option names, in order: label A = "section 1". */
export function optionNames(count: number): string[] {
  return Array.from({ length: count }, (_, k) => `section ${k + 1}`);
}

/**
 * The options object for the wire, {name: description} in item order, refused by name when a
 * name is integer-like or duplicated, and checked to have kept its order.
 */
export function wireOptions(items: readonly string[], names: readonly string[] = optionNames(items.length)): Record<string, string> {
  if (names.length !== items.length) throw new ChapteringError('bad_request', `${names.length} option names for ${items.length} items`);
  if (items.length < 2) throw new ChapteringError('bad_request', `a choice needs at least 2 options; got ${items.length}`);
  if (items.length > 26) throw new ChapteringError('bad_request', `a choice takes at most 26 options (A..Z); got ${items.length}`);
  const options: Record<string, string> = {};
  names.forEach((name, k) => {
    if (integerLike(name)) throw new ChapteringError('bad_request', `option name '${name}' is integer-like; the wire would re-letter it`);
    if (name in options) throw new ChapteringError('bad_request', `duplicate option name '${name}'`);
    if (!items[k]) throw new ChapteringError('bad_request', `option '${name}' has an empty description`);
    options[name] = items[k];
  });
  const kept = Object.keys(options);
  if (kept.some((name, k) => name !== names[k])) {
    throw new ChapteringError('bad_request', `the wire object reordered the options: ${kept.join(', ')}`);
  }
  return options;
}

/** The question name of unit `i`; `s0`.. as segment.py names them. Never integer-like. */
export function questionName(i: number): string {
  return `s${i}`;
}

/**
 * The choice questions for units [from, to) of `texts`, keyed by name in unit order.
 * `prevBefore` is the sentence before texts[0]: the real previous unit when a chunk starts
 * mid-video, else "(start of the video)".
 */
export function assignQuestions(
  texts: readonly string[],
  from: number,
  to: number,
  options: Record<string, string>,
  prevBefore: string,
): Record<string, ChoiceQuestion> {
  const out: Record<string, ChoiceQuestion> = {};
  for (let i = from; i < to; i++) {
    const prev = i ? texts[i - 1] : prevBefore;
    const name = questionName(i);
    if (integerLike(name)) throw new ChapteringError('bad_request', `question name '${name}' is integer-like`);
    out[name] = { type: 'choice', instructions: SNAP_PROMPTS.assign(texts[i], prev), options };
  }
  return out;
}

export interface ChoiceDistribution {
  /** ln P(option), renormalised over every option (floored ones included), in option order. What Viterbi reads. */
  logProbs: number[];
  /** Options whose letter was outside the top-K and took the floor, in option order. */
  missing: string[];
  /** True when the answer fell under the gate and the row was flattened: this unit carries no evidence. */
  skipped: boolean;
  labelMass: number;
}

function logSumExp(xs: number[]): number {
  const m = Math.max(...xs);
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

/**
 * One choice answer read into Viterbi's row under the declared rule (see the header).
 *
 * Raw (full-vocabulary) log-probabilities are the renormalised ones plus ln(labelMass). A
 * missing label's floor is the tighter of: the smallest returned label's raw probability
 * (every returned label is in the top-K; a missing one is not), and the raw mass NOT on the
 * returned letters shared over the top-K's other entries — at least (missing + margin) tokens
 * each at or above the missing label's probability. Clamped to ln(1e-12).
 */
export function readChoiceDistribution(answer: DecideAnswer | undefined, names: readonly string[], what: string): ChoiceDistribution {
  if (!answer) throw new ChapteringError('no_answer', `decide returned no answer for ${what}`);
  if (answer.type !== 'choice') throw new ChapteringError('answer_shape', `${what} was a choice and came back a ${answer.type}`);
  const mass = answer.labelMass;
  if (typeof mass !== 'number' || !Number.isFinite(mass)) throw new ChapteringError('answer_shape', `${what}: labelMass is not a number`);
  const lnMass = mass > 0 ? Math.log(mass) : -Infinity;
  const missingSet = new Set(answer.missingLabels ?? []);
  const raw: Array<number | null> = names.map((name) => {
    if (missingSet.has(name)) return null;
    if (!(name in answer.probabilities)) throw new ChapteringError('answer_shape', `${what}: no probability for option '${name}'`);
    const p = answer.probabilities[name];
    if (p === null) return null;
    if (typeof p !== 'number' || !Number.isFinite(p)) throw new ChapteringError('answer_shape', `${what}: probability of '${name}' is not a number`);
    return p > 0 ? Math.log(p) + lnMass : -Infinity;
  });
  const missing = names.filter((_, i) => raw[i] === null);
  const rawLogProbs = floorRaw(raw, mass, `${what}: the engine returned no option with any probability`);

  if (mass < LABEL_MASS_GATE) {
    const flat = -Math.log(names.length);
    return { logProbs: names.map(() => flat), missing, skipped: true, labelMass: mass };
  }
  const logZ = logSumExp(rawLogProbs);
  return { logProbs: rawLogProbs.map((lp) => lp - logZ), missing, skipped: false, labelMass: mass };
}

/**
 * The declared floor over one answer's raw log-probabilities (null = the label was outside the
 * top-K). See readChoiceDistribution for the two bounds. Every label with no probability at all
 * is refused: there is no answer to read.
 */
function floorRaw(raw: Array<number | null>, mass: number, refusal: string): number[] {
  if (raw.every((x) => x === null || x === -Infinity)) throw new ChapteringError('answer_shape', refusal);
  const missingCount = raw.filter((x) => x === null).length;
  let floor = -Infinity;
  if (missingCount) {
    const returned = raw.filter((x): x is number => x !== null && Number.isFinite(x));
    const smallest = returned.length ? Math.min(...returned) : -Infinity;
    const rest = 1 - mass;
    const shared = rest > 0 ? Math.log(rest / (missingCount + DECIDE_TOP_K_MARGIN)) : -Infinity;
    floor = Math.max(LOG_FLOOR, Math.min(smallest, shared));
  }
  return raw.map((x) => (x === null ? floor : Math.max(x, LOG_FLOOR)));
}

export interface YesNoReading {
  /** P(yes) under the declared rule; null when the answer carried no evidence (under the gate). */
  p: number | null;
  /** Yes or No was outside the top-K and took the floor. */
  floored: boolean;
  labelMass: number;
}

/**
 * P(yes) of a yes/no answer under the SAME declared rule as a choice. In report mode a one-sided
 * answer comes back renormalised alone (`p` = 1.0 with No missing, 0.0 with Yes missing;
 * PHASE22 §2.2 calls that "honest and useless"), so `p` is rebuilt from the raw mass: the
 * returned letter at ln(labelMass), the missing one at the floor. Under the label-mass gate the
 * answer says nothing and `p` is null — the CALLER declares what an unanswered check means
 * (chaptering.service.ts: an ad span nobody confirmed is not an ad).
 */
export function readYesNo(answer: DecideAnswer | undefined, what: string): YesNoReading {
  if (!answer) throw new ChapteringError('no_answer', `decide returned no answer for ${what}`);
  if (answer.type !== 'yesno') throw new ChapteringError('answer_shape', `${what} was a yes/no and came back a ${answer.type}`);
  const mass = answer.labelMass;
  if (typeof mass !== 'number' || !Number.isFinite(mass)) throw new ChapteringError('answer_shape', `${what}: labelMass is not a number`);
  if (typeof answer.p !== 'number' || !Number.isFinite(answer.p)) throw new ChapteringError('answer_shape', `${what}: p is not a number`);
  const missing = new Set(answer.missingLabels ?? []);
  if (mass < LABEL_MASS_GATE) return { p: null, floored: missing.size > 0, labelMass: mass };
  if (missing.size === 0) return { p: answer.p, floored: false, labelMass: mass };
  const lnMass = Math.log(mass);
  const yes = missing.has('Yes') ? null : answer.p > 0 ? Math.log(answer.p) + lnMass : -Infinity;
  const no = missing.has('No') ? null : answer.p < 1 ? Math.log1p(-answer.p) + lnMass : -Infinity;
  const [y, n] = floorRaw([yes, no], mass, `${what}: the engine returned neither Yes nor No`);
  return { p: Math.exp(y - logSumExp([y, n])), floored: true, labelMass: mass };
}

/** Narrow a DecideAnswer for callers that already checked the type. */
export function isChoice(answer: DecideAnswer): answer is ChoiceAnswer {
  return answer.type === 'choice';
}
