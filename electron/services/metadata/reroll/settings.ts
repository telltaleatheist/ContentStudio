/**
 * The re-roll gate's declared settings (P9; LEDGER #201, Law 1: a setting, never a quiet default).
 *
 * EVERY NUMBER HERE IS MEASURED, and where it was measured is docs/crucible/P9.md: the rule
 * thresholds and the baseline cap from the calibration over tools/fixtures/titlecheck (1,528
 * chapter titles, 571 description texts, hand labels in labels.jsonl), the rank rotation from the
 * 177 decided A/B tests. A value an operator stores overrides one of these by name; a stored value
 * that is not a number in range, or names a rule this build does not have, THROWS — the operator
 * asked for something specific and must not silently get something else (metadata-routing.ts's
 * rule).
 *
 * THE CAP IS NOT A SETTING. Law 3's one declared exception is "at most 3 re-rolls" (#201); a
 * stored number cannot widen it, only lower it.
 */

import { GateError, GateField, RuleId } from './types';
import { FIELD_RULES } from './rules';

/** Law 3's exception, as ruled (#201): at most three re-rolls, then the best attempt ships flagged. */
export const REROLL_CAP = 3;

export type RerollGateMode = 'on' | 'off';

export interface RerollGateSettings {
  /** `rerollGate`: whether generation runs the gate at all. */
  mode: RerollGateMode;
  /** Re-rolls per field, 0..REROLL_CAP. */
  maxRerolls: number;
  /**
   * A unit FAILS a rule when its pass score (1 - P(yes) above the baseline) is under this, keyed
   * `<field>.<rule>`. Measured per field and rule because the model leans differently on each:
   * see P9.md's score distributions.
   */
  thresholds: Record<string, number>;
  /**
   * The per-video baseline (plan §0a): each rule's median P(yes) over this field's units is
   * subtracted before the threshold, at most this much, so a model that leans on a rule across a
   * whole video does not fail every unit of it, and a genuine whole-video failure still reads
   * above the cap. 0 turns the baseline off. Applied only to a field with at least
   * `baselineMinUnits` units: a median of two is not a baseline.
   */
  baselineCap: number;
  baselineMinUnits: number;
}

/**
 * The measured defaults (P9.md, "Calibration"). `mode` is 'on' only because the calibration
 * passed; the numbers that decided it are in P9.md.
 */
export const REROLL_GATE_DEFAULTS: RerollGateSettings = {
  mode: 'off',
  maxRerolls: REROLL_CAP,
  thresholds: defaultThresholds(0.5),
  baselineCap: 0,
  baselineMinUnits: 5,
};

function defaultThresholds(value: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of Object.keys(FIELD_RULES) as GateField[]) {
    for (const rule of FIELD_RULES[field]) out[thresholdKey(field, rule)] = value;
  }
  return out;
}

export function thresholdKey(field: GateField, rule: RuleId): string {
  return `${field}.${rule}`;
}

/** The threshold for one field's rule; a key the defaults do not hold is a build bug and throws. */
export function thresholdOf(settings: RerollGateSettings, field: GateField, rule: RuleId): number {
  const t = settings.thresholds[thresholdKey(field, rule)];
  if (typeof t !== 'number') throw new GateError('bad_setting', `no threshold is declared for ${thresholdKey(field, rule)}`);
  return t;
}

function unit(value: unknown, what: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0 || value > 1) {
    throw new GateError('bad_setting', `${what} must be a number from 0 to 1; the store holds ${JSON.stringify(value)}`);
  }
  return value;
}

/**
 * The settings a run uses: the declared defaults, with what the operator stored over them.
 * `stored.rerollGate` is 'on' or 'off'; `stored.rerollGateTuning` may hold `maxRerolls`,
 * `baselineCap`, `baselineMinUnits` and `thresholds` (a partial map of `<field>.<rule>`). Anything
 * else there is refused by name.
 */
export function resolveRerollGateSettings(stored: { rerollGate?: unknown; rerollGateTuning?: unknown }): RerollGateSettings {
  const out: RerollGateSettings = { ...REROLL_GATE_DEFAULTS, thresholds: { ...REROLL_GATE_DEFAULTS.thresholds } };
  if (stored.rerollGate !== undefined) {
    if (stored.rerollGate !== 'on' && stored.rerollGate !== 'off') {
      throw new GateError('bad_setting', `rerollGate must be "on" or "off"; the store holds ${JSON.stringify(stored.rerollGate)}`);
    }
    out.mode = stored.rerollGate;
  }
  const tuning = stored.rerollGateTuning;
  if (tuning === undefined) return out;
  if (tuning === null || typeof tuning !== 'object' || Array.isArray(tuning)) {
    throw new GateError('bad_setting', `rerollGateTuning must be an object; the store holds ${JSON.stringify(tuning)}`);
  }
  for (const [key, value] of Object.entries(tuning as Record<string, unknown>)) {
    if (key === 'maxRerolls') {
      if (!Number.isInteger(value) || (value as number) < 0 || (value as number) > REROLL_CAP) {
        throw new GateError('bad_setting', `rerollGateTuning.maxRerolls must be a whole number from 0 to ${REROLL_CAP} (Law 3's cap, #201); the store holds ${JSON.stringify(value)}`);
      }
      out.maxRerolls = value as number;
    } else if (key === 'baselineCap') {
      out.baselineCap = unit(value, 'rerollGateTuning.baselineCap');
    } else if (key === 'baselineMinUnits') {
      if (!Number.isInteger(value) || (value as number) < 2) {
        throw new GateError('bad_setting', `rerollGateTuning.baselineMinUnits must be a whole number of at least 2; the store holds ${JSON.stringify(value)}`);
      }
      out.baselineMinUnits = value as number;
    } else if (key === 'thresholds') {
      if (value === null || typeof value !== 'object' || Array.isArray(value)) {
        throw new GateError('bad_setting', `rerollGateTuning.thresholds must be an object of "<field>.<rule>": number`);
      }
      for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
        if (!(k in out.thresholds)) {
          throw new GateError('bad_setting', `rerollGateTuning.thresholds names "${k}", which is not a rule the gate asks (known: ${Object.keys(out.thresholds).join(', ')})`);
        }
        out.thresholds[k] = unit(v, `rerollGateTuning.thresholds["${k}"]`);
      }
    } else {
      throw new GateError('bad_setting', `rerollGateTuning holds "${key}", which the gate does not read (maxRerolls, baselineCap, baselineMinUnits, thresholds)`);
    }
  }
  return out;
}
