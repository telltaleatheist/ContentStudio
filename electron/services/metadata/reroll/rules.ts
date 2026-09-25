/**
 * The rule checks as snap yes/no questions (P9; LEDGER #201; plan §11).
 *
 * WHAT A CHECK IS. The field's text is the primed STATE, together with the one channel fact every
 * rule needs — who made the video (reroll.yml `state`). Each question is a STATEMENT that QUOTES
 * the unit it judges ("The chapter title "…" refers to the video's creator…"), never a line number
 * or an index (plan §0a; Owen: "we give it the thing it's judging"). Crucible asks "Is this
 * statement true of the state above?" (PHASE22 §2.3), so a YES is a violation, and P(yes) is read
 * under the floor copied from chaptering (decide-read.ts).
 *
 * THE BODIES ARE NOT HERE. Every statement is a `rules.<id>` key of
 * electron/assets/prompts/shared/pipeline/reroll.yml (Law 2), and the measurement behind each is in
 * PROMPT-LEARNINGS.md Part 12. A statement names the WRONG form on purpose: it is a judge's
 * question, not a generation prompt, and Law 4 governs what a writing model is shown. The re-roll
 * prompt that follows a failure states the wanted form (reroll.yml `reroll.rules`).
 *
 * QUESTION NAMES are `u<unit>_<rule>`: never integer-like, so a JS object cannot reorder them
 * (assign.ts's wire fact), and they carry nothing the model reads — Crucible shows the statement,
 * not the name.
 */

import { promptAssets } from '../prompt-assets';
import { formatPrompt } from '../system-prompts';
import { integerLike } from './decide-read';
import { DecideRequest, GateError, GateField, RuleId, YesNoQuestion } from './types';

export const REROLL_FILE = 'reroll.yml';

/** Questions per decide request, as chaptering batches (segment.py BATCH): the state is primed once per request. */
export const QUESTIONS_PER_DECIDE = 64;

/**
 * Which rules each field is asked, and why (LEDGER §1's per-field bars; #183's framing classes).
 *
 *   titles          creator, narrates, nonsense. A title is about the video's subject; one that is
 *                   cut off or garbled is not SAFE to ship (§1: "complete thoughts").
 *   chapters        + sentence: §1 wants "labels in subject-first topic form"; this is the format
 *                   rule for a chapter list.
 *   description     + first_person: §1: "no first person" is the description's format rule. The
 *                   hook is its first unit; the link block is held back.
 *   thumbnail_text  creator, nonsense. Three words have no narrator to frame.
 *   pinned_comment  creator_third_person, nonsense. The ONE field in the creator's own voice (§1),
 *                   so the format rule is the inverse of the others: he writes it, he is never its
 *                   third person.
 *
 * The ORDER is the order a re-roll names them in: the first failing rule of a unit is the one its
 * re-roll call is about.
 */
export const FIELD_RULES: Record<GateField, readonly RuleId[]> = {
  titles: ['creator', 'narrates', 'nonsense'],
  chapters: ['creator', 'narrates', 'sentence', 'nonsense'],
  description: ['creator', 'first_person', 'narrates', 'nonsense'],
  thumbnail_text: ['creator', 'nonsense'],
  pinned_comment: ['creator_third_person', 'nonsense'],
};

/** What the gate knows about the channel: the facts the state and the statements name. */
export interface ChannelFacts {
  /** The channel's display name (the prompt set's `name`). */
  channel: string;
  /**
   * How the creator is known: the prompt set's `brand_terms`, joined. A set that declares none
   * cannot be checked for the creator rules, and that is refused by name, never guessed.
   */
  creator: string;
}

/** The channel facts from a prompt set's name and brand terms; refused when the set names no creator. */
export function channelFacts(name: string, brandTerms: readonly string[] | undefined): ChannelFacts {
  const terms = (brandTerms ?? []).map((t) => t.trim()).filter((t) => t.length > 0);
  if (terms.length === 0) {
    throw new GateError(
      'bad_setting',
      `the prompt set "${name}" declares no brand_terms, so nothing says who its creator is and the creator rules ` +
        `cannot be asked. Add the creator's names to its brand_terms.`,
    );
  }
  return { channel: name, creator: terms.join(', ') };
}

function asset(key: string): string {
  return promptAssets().pipeline(REROLL_FILE, key);
}

/**
 * The description cut into sentences for the questions to quote, with the separators kept so the
 * prose can be rebuilt byte for byte around a re-rolled sentence (`joinSentences`). A sentence
 * ends at . ! or ? (optionally closed by a quote or bracket) followed by whitespace and a capital,
 * a quote or a digit; a paragraph break always ends one.
 */
export function splitSentences(prose: string): { sentences: string[]; separators: string[]; lead: string } {
  const lead = /^\s*/.exec(prose)![0];
  const body = prose.slice(lead.length);
  const sentences: string[] = [];
  const separators: string[] = [];
  const boundary = /([.!?]["'”’)\]]*)(\s+)(?=["'“‘(\[]?[A-Z0-9])|(\n\s*\n\s*)/g;
  let start = 0;
  let m: RegExpExecArray | null;
  while ((m = boundary.exec(body)) !== null) {
    const end = m[3] !== undefined ? m.index : m.index + m[1].length;
    const sep = m[3] !== undefined ? m[3] : m[2];
    const sentence = body.slice(start, end);
    if (sentence.trim().length > 0) {
      sentences.push(sentence);
      separators.push(sep);
    } else if (separators.length > 0) {
      separators[separators.length - 1] += body.slice(start, end) + sep;
    }
    start = end + sep.length;
  }
  const tail = body.slice(start);
  if (tail.trim().length > 0) {
    sentences.push(tail);
    separators.push('');
  } else if (separators.length > 0) {
    separators[separators.length - 1] += tail;
  }
  return { sentences, separators, lead };
}

/** The inverse of splitSentences: `joinSentences(splitSentences(x))` is `x`. */
export function joinSentences(parts: { sentences: string[]; separators: string[]; lead: string }): string {
  return parts.lead + parts.sentences.map((s, i) => s + parts.separators[i]).join('');
}

/** The primed state for one field: its label, the channel facts, and the text, one unit per line for a list. */
export function stateFor(field: GateField, stateText: string, facts: ChannelFacts): string {
  return formatPrompt(asset('state'), {
    label: asset(`labels.${field}.what`),
    channel: facts.channel,
    creator: facts.creator,
    label_heading: asset(`labels.${field}.heading`),
    // Filled LAST: formatPrompt fills one key at a time, and a title holding "{creator}" must not be filled too.
    text: stateText,
  });
}

/** One rule's statement about one unit, QUOTING it. */
export function statementFor(field: GateField, rule: RuleId, unit: string, facts: ChannelFacts): string {
  if (!FIELD_RULES[field].includes(rule)) {
    throw new GateError('bad_request', `the rule "${rule}" is not asked of ${field} (rules.ts FIELD_RULES)`);
  }
  const quoted = unit.replace(/\s+/g, ' ').trim();
  if (quoted.length === 0) throw new GateError('bad_request', `an empty ${field} unit cannot be quoted in a question`);
  return formatPrompt(asset(`rules.${rule}`), {
    unit: asset(`labels.${field}.unit`),
    creator: facts.creator,
    text: quoted,
  });
}

export function questionName(unitIndex: number, rule: RuleId): string {
  const name = `u${unitIndex}_${rule}`;
  if (integerLike(name)) throw new GateError('bad_request', `question name '${name}' is integer-like`);
  return name;
}

/** Where one question's answer goes back: which unit, which rule. */
export interface QuestionSlot {
  name: string;
  unit: number;
  rule: RuleId;
}

/**
 * The decide requests for a field's units: every applicable rule of every unit listed in `which`
 * (all of them when absent), over one state, cut into requests of at most QUESTIONS_PER_DECIDE.
 */
export function ruleRequests(
  field: GateField,
  stateText: string,
  units: readonly string[],
  facts: ChannelFacts,
  which?: readonly number[],
): Array<{ request: DecideRequest; slots: QuestionSlot[] }> {
  const state = stateFor(field, stateText, facts);
  const slots: Array<QuestionSlot & { question: YesNoQuestion }> = [];
  const indices = which ?? units.map((_, i) => i);
  for (const i of indices) {
    if (i < 0 || i >= units.length) throw new GateError('bad_request', `unit ${i} is outside the ${units.length} units of ${field}`);
    for (const rule of FIELD_RULES[field]) {
      slots.push({ name: questionName(i, rule), unit: i, rule, question: { type: 'yesno', instructions: statementFor(field, rule, units[i], facts) } });
    }
  }
  const out: Array<{ request: DecideRequest; slots: QuestionSlot[] }> = [];
  for (let k = 0; k < slots.length; k += QUESTIONS_PER_DECIDE) {
    const batch = slots.slice(k, k + QUESTIONS_PER_DECIDE);
    const questions: Record<string, YesNoQuestion> = {};
    for (const s of batch) questions[s.name] = s.question;
    out.push({ request: { state, questions, missing: 'report' }, slots: batch.map(({ name, unit, rule }) => ({ name, unit, rule })) });
  }
  return out;
}

// --------------------------------------------------------------------------- the re-roll prompt

/**
 * The re-roll call's prompt (plain text, Law 12): who the entries are for, the WANTED form the
 * failed rule names (positive form, Law 4), the keep clause, the lines shape, and the entries.
 * The failing entries are the input of a revision call, the one place Law 4 lets a wrong form
 * appear.
 */
export function revisePrompt(field: GateField, rule: RuleId, units: readonly string[], facts: ChannelFacts): string {
  if (units.length === 0) throw new GateError('bad_request', `a re-roll of ${field} was asked with no entries`);
  const intro = formatPrompt(asset('reroll.intro'), { what: asset(`labels.${field}.what`), channel: facts.channel, creator: facts.creator });
  const shape = formatPrompt(asset('reroll.shapes.lines'), { count: units.length });
  const lines = units.map((u) => u.replace(/\s+/g, ' ').trim());
  return [intro, asset(`reroll.rules.${rule}`), asset('reroll.keep'), shape].join('\n\n') + '\n\n' + lines.join('\n') + '\n';
}
