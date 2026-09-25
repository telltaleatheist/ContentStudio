/**
 * Scoring a field's units against its rules: the decide calls, the declared floor, the per-video
 * baseline, the thresholds (P9; plan §11, §0a).
 *
 * THE SCORE. For each unit and rule, P(yes) is read under the floor (decide-read.ts). The unit's
 * pass score on that rule is 1 - max(0, P(yes) - baseline), and the unit's score is its lowest.
 * A rule whose pass score is under its threshold (settings.ts) is FAILING.
 *
 * THE BASELINE (plan §0a: "a multi-option softmax needs a per-video baseline — measure before
 * trusting an absolute 0.5"). The rule's median P(yes) over THIS field's units, at most
 * `baselineCap`, taken from the first reading of the field and FROZEN for its re-rolls: a re-roll
 * is judged against the same bar its original failed, not against a median its own rewrite moved.
 * With `baselineCap` 0 the baseline is off, which is what the calibration measured best (P9.md).
 *
 * AN ANSWER WITH NO EVIDENCE (under the label-mass gate) PASSES, and is counted: the model put
 * almost none of its mass on Yes or No, so the question was not answered, and an unanswered check
 * sending text back would be a re-roll with no measured reason — the one kind Law 3 still bans.
 * It is declared in the reading (`read: 'no-evidence'`) and in the run's warnings.
 */

import { readYesNo } from './decide-read';
import { ChannelFacts, FIELD_RULES, QuestionSlot, ruleRequests } from './rules';
import { RerollGateSettings, thresholdOf } from './settings';
import { DecideFn, DecideRequest, DecideResponse, GateError, GateField, RuleId, RuleReading, UnitScore } from './types';

/** One decide call as the trace records it (Law 8): what was sent, and every answer as read. */
export interface DecideCallRecord {
  what: string;
  /** When it was sent (Law 8: a request that failed was still sent, so the time is taken first). */
  at: string;
  request: DecideRequest;
  /** Question name -> P(yes) as read (null: no evidence), with how it was read. */
  answers: Record<string, { pYes: number | null; read: RuleReading['read']; labelMass: number }>;
  ms: number;
}

/** A rule's baseline for one field: frozen at the field's first reading. */
export type Baselines = Partial<Record<RuleId, number>>;

function median(xs: number[]): number {
  const s = [...xs].sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

/** The baselines from a field's first reading (see the header). Empty when the baseline is off or the field too short. */
export function baselinesOf(field: GateField, pYes: Array<Partial<Record<RuleId, number | null>>>, settings: RerollGateSettings): Baselines {
  const out: Baselines = {};
  if (settings.baselineCap <= 0 || pYes.length < settings.baselineMinUnits) return out;
  for (const rule of FIELD_RULES[field]) {
    const xs = pYes.map((u) => u[rule]).filter((p): p is number => typeof p === 'number');
    if (xs.length >= settings.baselineMinUnits) out[rule] = Math.min(median(xs), settings.baselineCap);
  }
  return out;
}

/** One unit's readings into its score and failing rules. */
export function unitScore(
  field: GateField,
  text: string,
  raw: Array<{ rule: RuleId; pYes: number | null; read: RuleReading['read']; labelMass: number }>,
  baselines: Baselines,
  settings: RerollGateSettings,
): UnitScore {
  const readings: RuleReading[] = raw.map((r) => {
    const baseline = baselines[r.rule] ?? 0;
    const score = r.pYes === null ? 1 : 1 - Math.max(0, r.pYes - baseline);
    return { rule: r.rule, pYes: r.pYes, baseline, score, read: r.read, labelMass: r.labelMass };
  });
  const failing = readings.filter((r) => r.score < thresholdOf(settings, field, r.rule)).map((r) => r.rule);
  return { text, readings, score: Math.min(...readings.map((r) => r.score)), failing };
}

/**
 * Ask every rule of the units listed in `which` (all when absent) and read the answers.
 * Returns each asked unit's raw readings (by unit index) and the calls, for the trace.
 */
export async function askRules(
  field: GateField,
  stateText: string,
  units: readonly string[],
  facts: ChannelFacts,
  decide: DecideFn,
  options: { what: string; which?: readonly number[]; signal?: AbortSignal },
): Promise<{ raw: Map<number, Array<{ rule: RuleId; pYes: number | null; read: RuleReading['read']; labelMass: number }>>; calls: DecideCallRecord[] }> {
  const raw = new Map<number, Array<{ rule: RuleId; pYes: number | null; read: RuleReading['read']; labelMass: number }>>();
  const calls: DecideCallRecord[] = [];
  const batches = ruleRequests(field, stateText, units, facts, options.which);
  for (const [k, { request, slots }] of batches.entries()) {
    if (options.signal?.aborted) throw new GateError('cancelled', `${options.what} was cancelled`);
    const what = batches.length > 1 ? `${options.what} (${k + 1}/${batches.length})` : options.what;
    const t0 = Date.now();
    const at = new Date(t0).toISOString();
    let response: DecideResponse;
    try {
      response = await decide(request, { what, signal: options.signal });
    } catch (err) {
      const code = (err as { code?: unknown })?.code;
      if (code === 'decide_not_served') {
        // No other way to read a rule (Law 1): the gate stops by name, and the caller fails the
        // stage as any other model call failing fails it. Nothing ships unjudged as if judged.
        throw new GateError('decide_not_served', `${what}: ${(err as Error).message}`);
      }
      throw err;
    }
    const answers: DecideCallRecord['answers'] = {};
    for (const slot of slots) {
      const reading = readSlot(response, slot, what);
      answers[slot.name] = reading;
      const list = raw.get(slot.unit) ?? [];
      list.push({ rule: slot.rule, ...reading });
      raw.set(slot.unit, list);
    }
    calls.push({ what, at, request, answers, ms: Date.now() - t0 });
  }
  return { raw, calls };
}

function readSlot(response: DecideResponse, slot: QuestionSlot, what: string): { pYes: number | null; read: RuleReading['read']; labelMass: number } {
  const r = readYesNo(response.answers?.[slot.name], `${what} [${slot.name}]`);
  return { pYes: r.p, read: r.p === null ? 'no-evidence' : r.floored ? 'floored' : 'answered', labelMass: r.labelMass };
}
