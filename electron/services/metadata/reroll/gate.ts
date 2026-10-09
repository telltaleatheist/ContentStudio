/**
 * The re-roll gate (P9; LEDGER #201; Law 3's ONE declared exception; plan §11).
 *
 * WHAT IT DOES, per field. Every unit (each title, each chapter title, each description sentence,
 * each thumbnail text, each pinned comment) is scored against the field's rules (checks.ts). A unit
 * whose score falls under a rule's threshold is SENT BACK: the failing units go to one fresh call
 * on the field's routed model with the failed rule named in the prompt (Owen: "everything that
 * scores under 0.5 gets sent back, up to three times"), and the answers are scored again. At most
 * `maxRerolls` rounds (the cap is 3, #201). Each unit keeps its BEST-scoring text across its
 * attempts — a rewrite that scores worse than what it replaced never ships over it — and whatever
 * still fails after the last round SHIPS, with a warning naming the field, the text and the rule
 * that still fails. Nothing is withheld, ever (Law 3): the gate can only replace a unit with a
 * better-scoring one or leave it as it was, flagged.
 *
 * WHY PER UNIT, NOT PER FIELD. A title list is a pick-field (LEDGER §1): one weak title among ten
 * is expected, and re-writing all ten to fix one would throw away nine the operator might have
 * picked. So the unit that failed is the unit that goes back, and the rest of its field is left
 * exactly as the run wrote it. A field "fails" in the record when any unit of it still does.
 *
 * GROUPED BY RULE. One round sends one call per failing rule of the field (each unit under the
 * first rule it fails, FIELD_RULES order), so every call's prompt names ONE rule in positive form
 * (Law 4) rather than a list of everything that went wrong at once.
 *
 * DECLARED (Law 8). Every decide call, every answer as read, every re-roll call and every attempt's
 * text and score is returned in the `GateRecord`, which the service writes onto the item and into
 * `_prompt_trace`; every unit still failing, every unanswered question and every unranked list is
 * a warning.
 *
 * FAILURES ARE LOUD (Law 1). A decide the server cannot serve, an answer that cannot be read, a
 * re-roll that comes back with the wrong number of lines: each throws, and the item fails the way
 * any model call failing fails it. Nothing ships "judged" that was not judged.
 */

import { askRules, baselinesOf, Baselines, DecideCallRecord, unitScore } from './checks';
import { settleTogether, valuesInOrder } from '../../../crucible/fan-out';
import { pendingStep } from '../../../crucible/pending-work';
import { ChannelFacts, FIELD_RULES, revisePrompt } from './rules';
import { rankTitles, RankingResult } from './ranking';
import { RerollGateSettings } from './settings';
import { DecideFn, GateError, GateField, ReviseFn, RuleId, RuleReading, UnitScore } from './types';
import { MAX_OPTIONS } from './decide-read';

/** One field as the gate reads it: its units, and how its state lays them out. */
export interface GateFieldInput {
  field: GateField;
  units: string[];
  /**
   * The state's text for the given units: one per line for a list, the prose (hook, blank line,
   * body) for the description. A function, because a re-roll changes the units the state shows.
   */
  stateText: (units: readonly string[]) => string;
}

export interface UnitAttempt {
  /** 0 = what the run wrote; 1..cap = the re-rolls. */
  attempt: number;
  text: string;
  score: number;
  failing: RuleId[];
  readings: RuleReading[];
}

export interface UnitRecord {
  /** Position in the field. */
  index: number;
  attempts: UnitAttempt[];
  /** Index into `attempts` of the text that ships. */
  kept: number;
}

export interface RerollCallRecord {
  field: GateField;
  at: string;
  attempt: number;
  rule: RuleId;
  units: number[];
  prompt: string;
  answers: string[];
}

export interface FieldRecord {
  field: GateField;
  rules: readonly RuleId[];
  baselines: Baselines;
  units: UnitRecord[];
  /** Rounds actually run (0 when every unit passed first time). */
  rerolls: number;
  /** Units still failing after the last round, with the rules they fail. */
  stillFailing: Array<{ index: number; text: string; rules: RuleId[]; score: number }>;
}

export interface GateRecord {
  settings: RerollGateSettings;
  fields: FieldRecord[];
  decideCalls: DecideCallRecord[];
  rerollCalls: RerollCallRecord[];
  ranking: RankingResult | null;
  warnings: string[];
}

export interface GateInput {
  fields: GateFieldInput[];
  facts: ChannelFacts;
  decide: DecideFn;
  revise: ReviseFn;
  settings: RerollGateSettings;
  /** For every `what` the gate names: the item's own label. */
  sourceLabel: string;
  /** Titles to rank once the titles field is settled; absent when the item carries none. */
  rank: boolean;
  signal?: AbortSignal;
  /**
   * Awaited before each round's checks (`check-N`) and rewrites (`revise-N`): a stage-major batch's
   * gate (crucible/batch.ts, LEDGER #266). Absent: the gate runs straight through.
   */
  phase?: (phase: GatePhase) => Promise<void>;
}

/** The points in the gate a batch may hold it at (see `runGate`). */
export type GatePhase = `check-${number}` | `revise-${number}`;

function rawToUnit(field: GateField, text: string, raw: Parameters<typeof unitScore>[2] | undefined, baselines: Baselines, settings: RerollGateSettings, what: string): UnitScore {
  if (!raw || raw.length !== FIELD_RULES[field].length) {
    throw new GateError('no_answer', `${what}: the rule checks for "${text.slice(0, 60)}" came back incomplete`);
  }
  return unitScore(field, text, raw, baselines, settings);
}

/** One field's state across the rounds. */
interface FieldRun {
  fin: GateFieldInput;
  baselines: Baselines;
  units: UnitRecord[];
  /** Rounds actually run for this field. */
  rounds: number;
  /** This round's rewrites, by unit index, between its revise and its check. */
  proposed: Map<number, string>;
}

const whatOf = (input: GateInput, field: GateField, attempt: number) =>
  `re-roll gate: ${field} rule checks for ${input.sourceLabel}${attempt === 0 ? '' : `, re-roll ${attempt}`}`;

const current = (run: FieldRun) => run.units.map((u) => u.attempts[u.kept]);

/** Attempt 0 of one field: every unit asked, the baselines frozen from it. Answers its decide calls for the record. */
async function firstCheck(input: GateInput, fin: GateFieldInput): Promise<{ run: FieldRun; calls: DecideCallRecord[] }> {
  const { field } = fin;
  const settings = input.settings;
  const first = await askRules(field, fin.stateText(fin.units), fin.units, input.facts, input.decide, { what: whatOf(input, field, 0), signal: input.signal });
  const pYes = fin.units.map((_, i) => Object.fromEntries((first.raw.get(i) ?? []).map((r) => [r.rule, r.pYes])) as Partial<Record<RuleId, number | null>>);
  const baselines = baselinesOf(field, pYes, settings);
  const units: UnitRecord[] = fin.units.map((text, i) => {
    const s = rawToUnit(field, text, first.raw.get(i), baselines, settings, whatOf(input, field, 0));
    return { index: i, attempts: [{ attempt: 0, text, score: s.score, failing: s.failing, readings: s.readings }], kept: 0 };
  });
  return { run: { fin, baselines, units, rounds: 0, proposed: new Map() }, calls: first.calls };
}

/**
 * One round's rewrites of one field: one call per rule, each unit under the first rule it fails
 * (FIELD_RULES order). The rules' calls go out together (each rewrites its own units and reads no
 * other rule's answer, LEDGER #270); their answers are checked and applied in rule order, so the
 * first wrong-shaped answer in that order is the one that throws. Answers the calls for the record.
 */
async function revise(input: GateInput, run: FieldRun, attempt: number): Promise<RerollCallRecord[]> {
  const { field } = run.fin;
  const failing = run.units.filter((u) => u.attempts[u.kept].failing.length > 0);
  const byRule = new Map<RuleId, UnitRecord[]>();
  for (const u of failing) {
    const rule = FIELD_RULES[field].find((r) => u.attempts[u.kept].failing.includes(r))!;
    byRule.set(rule, [...(byRule.get(rule) ?? []), u]);
  }
  run.proposed = new Map();
  const asked = valuesInOrder(await settleTogether([...byRule].map(([rule, group]) => async () => {
    const sent = group.map((u) => u.attempts[u.kept].text);
    const prompt = revisePrompt(field, rule, sent, input.facts);
    const at = new Date().toISOString();
    const answers = await input.revise({ field, rule, units: sent, attempt, prompt });
    return { rule, group, sent, prompt, at, answers };
  })));
  const calls: RerollCallRecord[] = [];
  for (const { rule, group, sent, prompt, at, answers } of asked) {
    if (answers.length !== sent.length) {
      throw new GateError('answer_shape', `the ${field} re-roll ${attempt} for ${input.sourceLabel} sent ${sent.length} entr${sent.length === 1 ? 'y' : 'ies'} and got ${answers.length} back; nothing was applied`);
    }
    calls.push({ field, at, attempt, rule, units: group.map((u) => u.index), prompt, answers });
    group.forEach((u, k) => run.proposed.set(u.index, answers[k].replace(/\s+/g, ' ').trim()));
  }
  return calls;
}

/** One round's check of one field: the rewrites judged in the field as it would ship with them in it. Answers its decide calls. */
async function recheck(input: GateInput, run: FieldRun, attempt: number): Promise<DecideCallRecord[]> {
  const { field } = run.fin;
  const candidate = current(run).map((a, i) => run.proposed.get(i) ?? a.text);
  const which = [...run.proposed.keys()].sort((a, b) => a - b);
  const again = await askRules(field, run.fin.stateText(candidate), candidate, input.facts, input.decide, { what: whatOf(input, field, attempt), which, signal: input.signal });
  for (const i of which) {
    const s = rawToUnit(field, candidate[i], again.raw.get(i), run.baselines, input.settings, whatOf(input, field, attempt));
    const u = run.units[i];
    u.attempts.push({ attempt, text: candidate[i], score: s.score, failing: s.failing, readings: s.readings });
    // The best attempt ships: a higher score, or an equal one that fails fewer rules. A rewrite
    // that is no better never replaces what it was asked to fix.
    const best = u.attempts[u.kept];
    if (s.score > best.score || (s.score === best.score && s.failing.length < best.failing.length)) u.kept = u.attempts.length - 1;
  }
  run.proposed = new Map();
  return again.calls;
}

/** One field's record and warnings, once its rounds are over. */
function settle(run: FieldRun, record: GateRecord): string[] {
  const { field } = run.fin;
  const stillFailing = run.units
    .filter((u) => u.attempts[u.kept].failing.length > 0)
    .map((u) => ({ index: u.index, text: u.attempts[u.kept].text, rules: u.attempts[u.kept].failing, score: u.attempts[u.kept].score }));
  const rounds = run.rounds;
  for (const f of stillFailing) {
    record.warnings.push(
      `re-roll gate: ${field} "${f.text}" still fails ${f.rules.join(' and ')} (score ${f.score.toFixed(2)}) after ` +
        `${rounds} re-roll${rounds === 1 ? '' : 's'}; it ships as the best-scoring attempt, flagged (LEDGER #201).`,
    );
  }
  const noEvidence = run.units.reduce((n, u) => n + u.attempts.reduce((m, a) => m + a.readings.filter((r) => r.read === 'no-evidence').length, 0), 0);
  if (noEvidence > 0) {
    record.warnings.push(`re-roll gate: ${noEvidence} ${field} rule question(s) came back with almost no weight on Yes or No, and were counted as passes (no evidence is no reason to re-roll).`);
  }
  record.fields.push({ field, rules: FIELD_RULES[field], baselines: run.baselines, units: run.units, rerolls: rounds, stillFailing });
  return current(run).map((a) => a.text);
}

/**
 * Run the gate over the given fields, then rank the settled titles. Returns the text of every field
 * as it ships (same unit count, same order) and the record of how it got there.
 *
 * ROUND-MAJOR (LEDGER #266): every field's checks of a round, then every field's rewrites of the
 * next, then their checks, rather than one field's whole loop before the next field's. Each field's
 * rounds are exactly what they were (a field's checks, baselines and rewrites read only that field),
 * so what ships is the same; what changes is that the scorer and the writing models trade the card
 * once per ROUND instead of once per field and round. `phase` is awaited before each round's checks
 * (`check-N`, on the scorer) and rewrites (`revise-N`, on the fields' own models): a stage-major
 * batch puts its gate (crucible/batch.ts) at those points, so every job's checks run before anyone's
 * rewrites. The title ranking (the scorer) runs inside the last check phase. The decide and re-roll
 * records list the calls in the order they were made.
 */
export async function runGate(input: GateInput): Promise<{ fields: Map<GateField, string[]>; record: GateRecord }> {
  const record: GateRecord = { settings: input.settings, fields: [], decideCalls: [], rerollCalls: [], ranking: null, warnings: [] };
  const out = new Map<GateField, string[]>();
  const fields = input.fields.filter((fin) => fin.units.length > 0);
  const runs: FieldRun[] = [];
  // A ROUND'S CALLS GO OUT TOGETHER (LEDGER #270): every field's checks of a round at once (all on
  // the scorer), then every field's rewrites at once (each on its field's own routed model; the
  // lane lets one local model's calls run together and holds another model's until they finish),
  // then their checks. A field's calls read only that field, so nothing in a round waits for
  // another field's answer. The rounds stay rounds and per field: a field's rewrite still waits
  // for its own check, and its check for its own rewrite. Records are written in field order,
  // and the first failure in field order is thrown, once every call of the round has settled.
  // Every awaited point is a named step of a batch member (crucible/pending-work.ts, LEDGER #279):
  // a stall here says which phase and which field it sits in.
  const phase = (p: GatePhase): Promise<void> => (input.phase === undefined ? Promise.resolve() : pendingStep(`the re-roll gate's ${p} gate`, () => input.phase!(p)));
  if (fields.length > 0) {
    await phase('check-0');
    for (const first of valuesInOrder(await settleTogether(fields.map((fin) => () => pendingStep(`the gate's check-0 of ${fin.field}`, () => firstCheck(input, fin)))))) {
      record.decideCalls.push(...first.calls);
      runs.push(first.run);
    }
  }
  for (let attempt = 1; attempt <= input.settings.maxRerolls; attempt++) {
    const pending = runs.filter((run) => run.units.some((u) => u.attempts[u.kept].failing.length > 0));
    if (pending.length === 0) break;
    if (input.signal?.aborted) throw new GateError('cancelled', `${whatOf(input, pending[0].fin.field, attempt)} was cancelled`);
    await phase(`revise-${attempt}`);
    for (const run of pending) run.rounds = attempt;
    for (const calls of valuesInOrder(await settleTogether(pending.map((run) => () => pendingStep(`the gate's revise-${attempt} of ${run.fin.field}`, () => revise(input, run, attempt)))))) {
      record.rerollCalls.push(...calls);
    }
    await phase(`check-${attempt}`);
    for (const calls of valuesInOrder(await settleTogether(pending.map((run) => () => pendingStep(`the gate's check-${attempt} of ${run.fin.field}`, () => recheck(input, run, attempt)))))) {
      record.decideCalls.push(...calls);
    }
  }
  for (const run of runs) out.set(run.fin.field, settle(run, record));
  if (input.rank) {
    const titles = out.get('titles');
    if (!titles || titles.length < 2) {
      record.warnings.push('re-roll gate: the titles were not ranked, because this item carries fewer than two.');
    } else if (titles.length > MAX_OPTIONS || new Set(titles).size !== titles.length) {
      record.warnings.push(
        `re-roll gate: the ${titles.length} titles were not ranked: ranking reads at most ${MAX_OPTIONS} distinct titles (A..Z), ` +
          'and ranking a cut of the list would order titles the operator never sees next to the ones it left out.',
      );
    } else {
      record.ranking = await pendingStep('the gate\'s title ranking', () => rankTitles(titles, input.facts.channel, input.decide, `re-roll gate: title ranking for ${input.sourceLabel}`, input.signal));
      if (record.ranking.skippedRotations > 0) {
        record.warnings.push(`re-roll gate: ${record.ranking.skippedRotations} of ${titles.length} ranking rotations came back with almost no weight on any title and were left out of the mean.`);
      }
    }
  }
  return { fields: out, record };
}
