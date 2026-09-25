/**
 * Chaptering at a chosen granularity — the types every file in this directory shares.
 *
 * THE TRANSPORTS ARE INJECTED. This service never talks to a server: it is handed a `chat`
 * and a `decide` function (LEDGER #199, plan §10.3). P2's Crucible transport will satisfy
 * both; tools/chaptering-run.js satisfies them with raw fetch for the live acceptance and
 * with a deterministic fake for the checks. Nothing here imports electron/crucible/, and the
 * routing (which model answers which role) stays the transport's business: the service names
 * the ROLE of every call and the transport maps it through the routing table (#204).
 *
 * THE WIRE SHAPES are Crucible's `POST /v1/decide` (crucible docs/PHASE22-DECIDE.md §2.2),
 * camelCased the way the vendored SDK reads them, minus the fields the service never reads.
 * Questions and options cross as JSON objects whose insertion order IS the letter order, so a
 * JS object must never be allowed to reorder them (see assign.ts: integer-like keys go first
 * whatever order they were written in).
 */

/** How finely the sections are kept (Law 6 as amended by #199). */
export type Granularity = 'detailed' | 'broad' | 'stories' | 'episodes';

/** One sentence-sized unit of the transcript: the thing every decide question quotes. */
export interface SentenceUnit {
  /** Position in the unit list. */
  index: number;
  /** Seconds. An estimate inside a caption (units.ts says how), the caption's own time at its edges. */
  start: number;
  end: number;
  text: string;
  /** The transcript's speaker/track id for the caption the unit starts in, when it carried one. */
  speaker?: string;
}

// --------------------------------------------------------------------------- chat

export type ChatRole = 'outline' | 'summarize';

export interface ChatOptions {
  /**
   * Which routed model answers: 'outline' is the scorer (the 9B, #199: "9b -> outline");
   * 'summarize' is the capable chapters model (the 27B: "final chapter -> 27b -> chapter title").
   */
  role: ChatRole;
  /** Hard cap on generated tokens. */
  maxTokens: number;
  /** Stated on every call (plan §6.3 "think is stated on every call"). */
  thinking: boolean;
  /** Sent only when set; the outline is the one caller (temperature 0, the measured setup). */
  temperature?: number;
  /** For the transport's trace line. */
  what: string;
  signal?: AbortSignal;
}

export interface ChatResult {
  text: string;
  /** The engine's `finish_reason`, verbatim. A `length` stop is a truncated answer (LEDGER #112). */
  finishReason: string;
}

/** One generation call. The transport routes `role`, records the trace, and throws on failure. */
export type ChatFn = (prompt: string, options: ChatOptions) => Promise<ChatResult>;

// --------------------------------------------------------------------------- decide

export interface ChoiceQuestion {
  type: 'choice';
  instructions: string;
  /** Option name -> one-line description. Insertion order is the letter order (A = first). */
  options: Record<string, string>;
}

export interface YesNoQuestion {
  type: 'yesno';
  /** A statement the model is asked whether is true of the state. */
  instructions: string;
}

export type DecideQuestion = ChoiceQuestion | YesNoQuestion;

export interface DecideRequest {
  /** The primed state: the chunk's sentences joined with "\n" (segment.py:112). */
  state: string;
  /** Question name -> question. Insertion order is the answer order. */
  questions: Record<string, DecideQuestion>;
  /**
   * Always 'report' (plan §0a, N7): a label outside the engine's top-K comes back null and
   * named in `missingLabels`, and the finite floor is THIS client's declared rule
   * (assign.ts readChoiceDistribution), never the server's invention.
   */
  missing: 'report';
}

export interface DecideOptions {
  what: string;
  signal?: AbortSignal;
}

export interface ChoiceAnswer {
  type: 'choice';
  /** Option name -> renormalised probability over the letters returned; null for a missing label. */
  probabilities: Record<string, number | null>;
  /** The raw probability the option letters held together before renormalising. */
  labelMass: number;
  /** Option names whose letter the engine did not return (report mode: present, `[]` when none). */
  missingLabels?: string[];
}

export interface YesNoAnswer {
  type: 'yesno';
  /** Renormalised P(Yes). */
  p: number;
  labelMass: number;
  missingLabels?: string[];
}

export type DecideAnswer = ChoiceAnswer | YesNoAnswer;

export interface DecideResponse {
  /** Question name -> answer. Every question asked must be answered (the service refuses otherwise). */
  answers: Record<string, DecideAnswer>;
}

/** One decision call. The transport adds the model and the act and throws on failure. */
export type DecideFn = (request: DecideRequest, options: DecideOptions) => Promise<DecideResponse>;

// --------------------------------------------------------------------------- errors

/**
 * The codes a transport failure may carry that this service reads (Law 10: a typed contract,
 * not a message substring). A thrown error with `code: 'decide_not_served'` is Crucible saying
 * this engine cannot read the question (PHASE22 §2.4), and the service refuses by name: there
 * is no other way to assign sentences (Law 1; plan §10.5).
 */
export interface TransportFailure {
  code: string;
  /** The server that refused, when the transport knows it. */
  server?: string;
  message: string;
}

export function isTransportFailure(err: unknown): err is Error & TransportFailure {
  return err instanceof Error && typeof (err as Partial<TransportFailure>).code === 'string';
}

export type ChapteringErrorCode =
  | 'decide_not_served'
  | 'no_answer'
  | 'answer_shape'
  | 'outline_empty'
  | 'bad_request'
  | 'truncated'
  | 'cancelled'
  | 'empty_transcript';

/** Every failure this service reports has a name and says what is missing (Law 1). */
export class ChapteringError extends Error {
  constructor(readonly code: ChapteringErrorCode, message: string) {
    super(`${code}: ${message}`);
    this.name = 'ChapteringError';
  }
}

// --------------------------------------------------------------------------- results

export interface PlugVerdict {
  /** Unit range [start, end) over the whole video's units. */
  start: number;
  end: number;
  /**
   * P(yes: this stretch is a promotion), as used. Under 0.5 the stretch was re-segmented
   * without the ad item. 0 for an answer with no evidence (see `read`).
   */
  p: number;
  /**
   * How the answer was read (Law 8): 'answered' as the engine gave it; 'floored' when Yes or
   * No was outside the top-K and took the declared floor; 'no-evidence' when the answer fell
   * under the label-mass gate — an ad nobody confirmed is not an ad, so it counts as a
   * rejection and is warned about.
   */
  read: 'answered' | 'floored' | 'no-evidence';
}

export interface Chapter {
  /** 1-based, in time order. */
  number: number;
  /** Seconds. The first chapter starts at 0 (YouTube needs a 0:00 marker); the last ends at the transcript end. */
  startSec: number;
  endSec: number;
  /** Unit range [start, end) over the video's units. */
  unitRange: [number, number];
  /** The outline item snap assigned (the ad item's text for an ad). */
  label: string;
  /** 1 = a level-1 (broad) section; 2 = a refinement inside one (detailed on a long video). */
  level: number;
  /** From summarize_chapter on the capable model. Empty when the answer could not be read (warned, never re-asked: Law 3). */
  title: string;
  summary: string;
  /** Assigned to the ad item and confirmed by the yes/no. A typed signal for promo exclusion (Law 10). */
  isAd: boolean;
}

export interface ChapteringStats {
  unitCount: number;
  /** Level-1 chunks the transcript was cut into (1 when it fit one state). */
  chunkCount: number;
  /** Level-1 sections a sub-outline was written over. */
  refinedSections: number;
  outlineMs: number;
  assignMs: number;
  plugMs: number;
  summarizeMs: number;
  totalMs: number;
  chatCalls: number;
  decideCalls: number;
  /**
   * Units (global indices, ascending) whose answer had at least one label outside the engine's
   * top-K, floored under the declared rule (assign.ts). Reported, and summarised in `warnings`.
   */
  flooredUnits: number[];
  /** Chapters whose transcript was over the title call's budget and were titled from their parts (summarize.ts). */
  titledFromParts: number[];
  /**
   * Units whose answer fell under the label-mass gate: the model put almost none of its mass on
   * any letter, so the unit carries no evidence and Viterbi's switch cost decides it. Recorded
   * and reported (Law 8), never silently floored.
   */
  skippedUnits: number[];
  warnings: string[];
}

export interface ChapteringResult {
  granularity: Granularity;
  switchCost: number;
  units: SentenceUnit[];
  /** The level-1 outline items in order, de-duplicated, without the ad item. */
  outline: string[];
  chapters: Chapter[];
  plugVerdicts: PlugVerdict[];
  stats: ChapteringStats;
  /** Per chunk, what the model answered; only when `diagnostics` was asked for (measurement runs). */
  diagnostics?: ChunkDiagnostic[];
}

/** One chunk's reading, for measuring the method (P8b's acceptance), never read by the pipeline. */
export interface ChunkDiagnostic {
  level: number;
  /** Global unit range [start, end) of the chunk's state. */
  start: number;
  end: number;
  /** The options in letter order, the ad item last when ads were on. */
  items: string[];
  /** Index of the ad item in `items`, or -1. */
  plug: number;
  /** Per unit of the chunk: the most probable option, its probability, and the ad item's. */
  top: number[];
  topP: number[];
  plugP: number[];
  /** Per unit of the chunk: the final Viterbi item (after ad confirmation). */
  path: number[];
}

export type ChapteringPhase = 'units' | 'outline' | 'assign' | 'plugs' | 'refine' | 'summarize' | 'done';

export interface ChapteringProgress {
  phase: ChapteringPhase;
  /** Work done and to do inside this phase (units for assign, chapters for summarize). */
  done: number;
  total: number;
  /** 0..1 over the whole run, weighted by work rather than by stage (plan §0a). */
  fraction: number;
}
