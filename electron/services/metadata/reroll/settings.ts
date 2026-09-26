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
  /**
   * A waiver reading (rules.ts WAIVERS: `cta`, "is this an invitation to the viewer") at or over
   * this P(yes) lifts the rules it names on its unit (Owen, #211: a call to action is not a
   * reference to the creator).
   */
  waiverCut: number;
}

/**
 * The pass-score threshold per rule, as measured on the 9B against the 70 hand labels
 * (docs/crucible/P9.md "Calibration"; a unit fails when 1 - P(yes) is under it, so 0.3 means
 * "fails above P(yes) 0.7"):
 *
 *   creator        0.3  bimodal: violators 0.73-0.99, clean median 0.006; 50/50 chapter titles
 *                       right at P 0.7. The two clean-labelled readings above it were calls to
 *                       action ("Subscribe and leave a comment."), which Owen ruled are not a
 *                       reference to the creator (#211). A clause in the statement did not move
 *                       the 9B (0.82 after it), so a `cta` question now WAIVES creator,
 *                       first_person and narrates on a call to action (rules.ts WAIVERS).
 *   first_person   0.5  bimodal: 20/20 descriptions right at P 0.5.
 *   narrates       0.2  the statement that measured (v4, "the one doing the action is the
 *                       video itself or the person presenting it"); v1's wording leaned to a
 *                       0.73 median on CLEAN titles, plan §0a's trap, and was replaced at the
 *                       source rather than baselined. P 0.8: 10/16 chapter violators on its
 *                       own (the rest are caught by creator), 1 false alarm in 34.
 *   sentence       0    MEASURED, NEVER GATING (Owen, #211: chapter titles are "one or two
 *                       sentences describing what's being discussed"). Asked and recorded only.
 *   nonsense       0.5  no garbled unit in the sample; clean readings sit under 0.05.
 *   creator_third_person 0.5  unmeasured (no labelled pinned comments); the symmetric default.
 *
 * Titles, thumbnail text and pinned comments were not in the labelled sample; they take their
 * rule's number from the chapters and descriptions measurement.
 */
const MEASURED_THRESHOLDS: Record<RuleId, number> = {
  creator: 0.3,
  creator_third_person: 0.5,
  first_person: 0.5,
  narrates: 0.2,
  sentence: 0,
  nonsense: 0.5,
  // A waiver, not a violation: it never sends anything back (waiverCut is its own number).
  cta: 0,
};

/**
 * Where one field measured differently from its rule's number (P9.md "Corpus"). Description
 * sentences read higher on narrates than chapter titles do: on 196 unseen sentences, P 0.8 flagged
 * "The clip brands Angie Nixon…" and "The Fox News framing collapses…" (subject-first, 0.82–0.85),
 * while every labelled description violator read 0.94 or more. So a description sentence fails
 * narrates above P 0.9.
 */
const FIELD_THRESHOLDS: Record<string, number> = {
  'description.narrates': 0.1,
  // Two- to four-word captions have no subject to name him with; on 400 unseen ones the only
  // creator readings over 0.7 were "SELF-OWN" (0.87) and "HE HOSTED A RIOTER" (0.84), both clean.
  'thumbnail_text.creator': 0.1,
  // The pinned comment is in the creator's own voice and talks about the people in the video as
  // "he": on 119 unseen comments the only readings over 0.5 were four such comments (0.53-0.62,
  // "He switches Bible translations three times…"), all written as the creator. Fails above 0.7.
  'pinned_comment.creator_third_person': 0.3,
};

/**
 * The declared defaults (P9.md, "Calibration"). `mode` is 'on' because the false-alarm rate held
 * on unseen text at these thresholds (P9.md "Corpus": about 1 unit in 100 on titles, thumbnail
 * text, chapter titles and pinned comments, about 2 in 100 description sentences), with 21 of 23
 * labelled violators caught.
 */
export const REROLL_GATE_DEFAULTS: RerollGateSettings = {
  mode: 'on',
  maxRerolls: REROLL_CAP,
  thresholds: defaultThresholds(),
  // Off: the one rule that leaned (narrates) was fixed in its statement, which measured better
  // than any baseline could (the baseline cannot tell a video of narrated titles from a lean).
  baselineCap: 0,
  baselineMinUnits: 5,
  waiverCut: 0.5,
};


function defaultThresholds(): Record<string, number> {
  const out: Record<string, number> = {};
  for (const field of Object.keys(FIELD_RULES) as GateField[]) {
    for (const rule of FIELD_RULES[field]) {
      const key = thresholdKey(field, rule);
      out[key] = FIELD_THRESHOLDS[key] ?? MEASURED_THRESHOLDS[rule];
    }
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
    } else if (key === 'waiverCut') {
      out.waiverCut = unit(value, 'rerollGateTuning.waiverCut');
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
      throw new GateError('bad_setting', `rerollGateTuning holds "${key}", which the gate does not read (maxRerolls, baselineCap, baselineMinUnits, waiverCut, thresholds)`);
    }
  }
  return out;
}
