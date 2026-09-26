/**
 * Reading a decision under the DECLARED FLOOR — copied from the chaptering service
 * (chaptering/assign.ts at `crucible` 4ba2580: `readYesNo`, `readChoiceDistribution`, `floorRaw`,
 * `wireOptions`, `integerLike`), which ported it from Briefcase crucible-decide.ts floorAnswer.
 *
 * COPIED, NOT IMPORTED, on purpose: another agent owns chaptering/ and is changing it, and the
 * gate's reading must not move under it when that file does. `npm run check:reroll` holds the
 * two to the same answers on the same fixtures, so a change on either side is a failing check,
 * not a silent drift (plan §10.3's copy-with-parity rule, applied here).
 *
 * THE RULE (plan §0a, N7). A label outside the engine's top-K comes back null (`missing:
 * 'report'`); its probability is floored at the tighter of two upper bounds the answer itself
 * proves — the smallest returned label's raw probability, and the raw mass NOT on the returned
 * letters shared over (missing + margin) tokens — clamped to ln(1e-12), and the row is
 * renormalised in log space. Under the label-mass gate the answer carries no evidence and says so;
 * the CALLER declares what an unanswered check means (checks.ts: it passes, and is counted).
 */

import { DecideAnswer, GateError } from './types';

/** segment.py:80 — log(max(p, 1e-12)). */
export const LOG_FLOOR = Math.log(1e-12);

/** Under this much raw mass on the letters the answer says nothing (Briefcase LABEL_MASS_GATE; assign.ts). */
export const LABEL_MASS_GATE = 0.01;

/** The server's top-K margin (PHASE22 §2.4: K is the labels plus 4). */
export const DECIDE_TOP_K_MARGIN = 4;

/** A choice takes A..Z. */
export const MAX_OPTIONS = 26;

/** A JS object lists integer-like keys first, whatever order they were written in (assign.ts). */
export function integerLike(key: string): boolean {
  return /^(0|[1-9]\d*)$/.test(key) && Number(key) < 4294967295;
}

/**
 * The options object for the wire, {name: text} in order, refused by name when a name is
 * integer-like or duplicated or the count is outside 2..26, and checked to have kept its order.
 */
export function wireOptions(texts: readonly string[], names: readonly string[]): Record<string, string> {
  if (names.length !== texts.length) throw new GateError('bad_request', `${names.length} option names for ${texts.length} options`);
  if (texts.length < 2) throw new GateError('bad_request', `a choice needs at least 2 options; got ${texts.length}`);
  if (texts.length > MAX_OPTIONS) throw new GateError('bad_request', `a choice takes at most ${MAX_OPTIONS} options (A..Z); got ${texts.length}`);
  const options: Record<string, string> = {};
  names.forEach((name, k) => {
    if (integerLike(name)) throw new GateError('bad_request', `option name '${name}' is integer-like; the wire would re-letter it`);
    if (name in options) throw new GateError('bad_request', `duplicate option name '${name}'`);
    if (!texts[k]) throw new GateError('bad_request', `option '${name}' has an empty text`);
    options[name] = texts[k];
  });
  const kept = Object.keys(options);
  if (kept.some((name, k) => name !== names[k])) {
    throw new GateError('bad_request', `the wire object reordered the options: ${kept.join(', ')}`);
  }
  return options;
}

function logSumExp(xs: number[]): number {
  const m = Math.max(...xs);
  if (!Number.isFinite(m)) return m;
  let s = 0;
  for (const x of xs) s += Math.exp(x - m);
  return m + Math.log(s);
}

function floorRaw(raw: Array<number | null>, mass: number, refusal: string): number[] {
  if (raw.every((x) => x === null || x === -Infinity)) throw new GateError('answer_shape', refusal);
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
  /** P(yes) under the declared rule; null under the label-mass gate. */
  p: number | null;
  floored: boolean;
  labelMass: number;
}

/** assign.ts `readYesNo`, verbatim in rule. */
export function readYesNo(answer: DecideAnswer | undefined, what: string): YesNoReading {
  if (!answer) throw new GateError('no_answer', `decide returned no answer for ${what}`);
  if (answer.type !== 'yesno') throw new GateError('answer_shape', `${what} was a yes/no and came back a ${answer.type}`);
  const mass = answer.labelMass;
  if (typeof mass !== 'number' || !Number.isFinite(mass)) throw new GateError('answer_shape', `${what}: labelMass is not a number`);
  if (typeof answer.p !== 'number' || !Number.isFinite(answer.p)) throw new GateError('answer_shape', `${what}: p is not a number`);
  const missing = new Set(answer.missingLabels ?? []);
  if (mass < LABEL_MASS_GATE) return { p: null, floored: missing.size > 0, labelMass: mass };
  if (missing.size === 0) return { p: answer.p, floored: false, labelMass: mass };
  const lnMass = Math.log(mass);
  const yes = missing.has('Yes') ? null : answer.p > 0 ? Math.log(answer.p) + lnMass : -Infinity;
  const no = missing.has('No') ? null : answer.p < 1 ? Math.log1p(-answer.p) + lnMass : -Infinity;
  const [y, n] = floorRaw([yes, no], mass, `${what}: the engine returned neither Yes nor No`);
  return { p: Math.exp(y - logSumExp([y, n])), floored: true, labelMass: mass };
}

export interface ChoiceDistribution {
  /** P(option), renormalised over every option (floored ones included), in option order. */
  probs: number[];
  missing: string[];
  /** Under the label-mass gate: the row is flat and carries no evidence. */
  skipped: boolean;
  labelMass: number;
}

/** assign.ts `readChoiceDistribution`, returned as probabilities rather than log-probabilities. */
export function readChoice(answer: DecideAnswer | undefined, names: readonly string[], what: string): ChoiceDistribution {
  if (!answer) throw new GateError('no_answer', `decide returned no answer for ${what}`);
  if (answer.type !== 'choice') throw new GateError('answer_shape', `${what} was a choice and came back a ${answer.type}`);
  const mass = answer.labelMass;
  if (typeof mass !== 'number' || !Number.isFinite(mass)) throw new GateError('answer_shape', `${what}: labelMass is not a number`);
  const lnMass = mass > 0 ? Math.log(mass) : -Infinity;
  const missingSet = new Set(answer.missingLabels ?? []);
  const raw: Array<number | null> = names.map((name) => {
    if (missingSet.has(name)) return null;
    if (!(name in answer.probabilities)) throw new GateError('answer_shape', `${what}: no probability for option '${name}'`);
    const p = answer.probabilities[name];
    if (p === null) return null;
    if (typeof p !== 'number' || !Number.isFinite(p)) throw new GateError('answer_shape', `${what}: probability of '${name}' is not a number`);
    return p > 0 ? Math.log(p) + lnMass : -Infinity;
  });
  const missing = names.filter((_, i) => raw[i] === null);
  const rawLogProbs = floorRaw(raw, mass, `${what}: the engine returned no option with any probability`);
  if (mass < LABEL_MASS_GATE) {
    return { probs: names.map(() => 1 / names.length), missing, skipped: true, labelMass: mass };
  }
  const logZ = logSumExp(rawLogProbs);
  return { probs: rawLogProbs.map((lp) => Math.exp(lp - logZ)), missing, skipped: false, labelMass: mass };
}
