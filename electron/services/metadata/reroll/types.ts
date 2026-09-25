/**
 * The re-roll gate — the types every file in this directory shares (P9; LEDGER #201; plan §11).
 *
 * THE TRANSPORTS ARE INJECTED, as the chaptering service's are (chaptering/types.ts): the gate
 * is handed a `decide` and a `revise` function and never talks to a server itself. The app
 * binds them to the Crucible transport and the field's routed model (reroll.service.ts); the
 * calibration tool binds `decide` to a CLI's lanes; the keeper binds both to fakes. So every
 * rule of the gate — the questions, the floor, the cap, the ship-with-warning — is testable in
 * plain Node with no server.
 *
 * THE WIRE SHAPES are Crucible's `POST /v1/decide` as the vendored SDK reads them (camelCase),
 * restated here minus what the gate never reads, for the reason chaptering restates them: the
 * gate must not reach into another service's module for its contract.
 */

// --------------------------------------------------------------------------- decide wire

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option name -> the text the model reads. Insertion order IS the letter order (A = first). */
  options: Record<string, string>;
}

export interface YesNoQuestion {
  type: 'yesno';
  /** A statement; Crucible asks "Is this statement true of the state above?" (PHASE22 §2.3). */
  instructions: string;
}

export type DecideQuestion = ChoiceQuestion | YesNoQuestion;

export interface DecideRequest {
  /** The primed state: the field's text and the channel's facts (reroll.yml `state`). */
  state: string;
  /** Question name -> question. Insertion order is the answer order. Names are never integer-like. */
  questions: Record<string, DecideQuestion>;
  /** Always 'report' (plan §0a, N7): the floor is this client's declared rule (decide-read.ts). */
  missing: 'report';
}

export interface ChoiceAnswer {
  type: 'choice';
  probabilities: Record<string, number | null>;
  labelMass: number;
  missingLabels?: readonly string[];
}

export interface YesNoAnswer {
  type: 'yesno';
  p: number;
  labelMass: number;
  missingLabels?: readonly string[];
}

export type DecideAnswer = ChoiceAnswer | YesNoAnswer;

export interface DecideResponse {
  answers: Record<string, DecideAnswer>;
}

/** One decision. The binding adds the model, the act, the lane and the lease, and throws on failure. */
export type DecideFn = (request: DecideRequest, options: { what: string; signal?: AbortSignal }) => Promise<DecideResponse>;

// --------------------------------------------------------------------------- the fields

/**
 * The fields the gate reads, in the item's own vocabulary. `chapters` means the chapter TITLES
 * (a timestamp never reaches a model, standing law); `description` means the hook and the
 * primary description's prose, sentence by sentence, with the link block held back (scrub.ts's
 * reason: fifteen URLs have nothing to be judged on and everything to lose in a rewrite).
 */
export type GateField = 'titles' | 'chapters' | 'description' | 'thumbnail_text' | 'pinned_comment';

export const GATE_FIELDS: readonly GateField[] = ['titles', 'chapters', 'description', 'thumbnail_text', 'pinned_comment'];

/**
 * The rules, each a yes/no statement in reroll.yml `rules.<id>` (Law 2). A YES is a violation.
 * Which fields each one is asked of is `FIELD_RULES` (rules.ts), and why is written there.
 */
export type RuleId =
  | 'creator'
  | 'creator_third_person'
  | 'first_person'
  | 'narrates'
  | 'sentence'
  | 'nonsense';

/** How one field's text is cut into the units a question quotes. */
export interface FieldUnits {
  field: GateField;
  /** The whole text the state carries (the list one per line, or the prose). */
  text: string;
  /** The units questions quote: each title, each chapter title, each sentence of the description. */
  units: string[];
}

/** One rule's reading on one unit. */
export interface RuleReading {
  rule: RuleId;
  /** P(yes: the unit breaks the rule) under the declared floor; null when the answer carried no evidence. */
  pYes: number | null;
  /** The per-video baseline subtracted (the rule's median over this field's units, capped), or 0 when the rule takes none. */
  baseline: number;
  /** 1 - max(0, pYes - baseline): the unit's pass score on this rule. 1 for an answer with no evidence (declared in `read`). */
  score: number;
  /** 'answered' as given; 'floored' when Yes or No took the declared floor; 'no-evidence' under the label-mass gate. */
  read: 'answered' | 'floored' | 'no-evidence';
  labelMass: number;
}

export interface UnitScore {
  text: string;
  readings: RuleReading[];
  /** The lowest rule score: the unit passes only when every rule does. */
  score: number;
  /** The rules whose score fell under that rule's threshold. Empty: the unit passes. */
  failing: RuleId[];
}

// --------------------------------------------------------------------------- re-roll

/**
 * One re-roll call: the failing units of one field, rewritten on that field's routed model with
 * the failed rule named in the prompt (plain text, Law 12). Returns exactly one answer per unit,
 * in order, or throws (a count that does not match is the call's failure, never partially
 * applied — rewrite-pass.ts's rule).
 */
export interface ReviseRequest {
  field: GateField;
  /** The rule the call is about: the first failing rule of the units sent, in rule order. */
  rule: RuleId;
  /** The units to rewrite, in order: failing titles, chapter titles, or description sentences. */
  units: string[];
  /** 1..cap, for the trace. */
  attempt: number;
  /** The whole prompt, built by the gate (rules.ts revisePrompt) so what is sent is what is recorded. */
  prompt: string;
}

export type ReviseFn = (request: ReviseRequest) => Promise<string[]>;

// --------------------------------------------------------------------------- errors

export type GateErrorCode = 'decide_not_served' | 'no_answer' | 'answer_shape' | 'bad_request' | 'bad_setting' | 'cancelled';

/** Every failure the gate reports has a name and says what is missing (Law 1). */
export class GateError extends Error {
  constructor(readonly code: GateErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'GateError';
  }
}
