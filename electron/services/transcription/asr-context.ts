/**
 * WHAT QWEN3-ASR IS TOLD ABOUT A RECORDING BEFORE IT HEARS IT (LEDGER #203, #206).
 *
 * Qwen3-ASR reads a `context` in its system turn: an instruction and a vocabulary. Two things
 * go in it, and #206 names both:
 *
 *  1. THE VERBATIM INSTRUCTION (#203): transcribe every disfluency exactly as spoken. Owen cuts
 *     on the ums and uhs, and the same 10-minute window went from 9 fillers to 19 with it
 *     (crucible `jobs/asr/__init__.py` AsrParams docstring). Merged with Briefcase's line that
 *     the facts are for SPELLING only: metadata names people who may never speak, and a name in
 *     the context must never be written into the transcript.
 *  2. EVERY FACT THE ITEM ALREADY CARRIES THAT COULD SPELL A PROPER NOUN (#206, Owen: "in case
 *     it might have proper nouns spelled out correctly and it can act as a seed for proper
 *     nouns"): the filename title (whisper.cpp's `--prompt` seed, which turned "Jake Lane" into
 *     Jake Lang on 2026-08-24 and must not be lost), the job name, the channel's brand terms and
 *     promoted items, known speaker names, and whatever titles, tags and description an earlier
 *     run, a linked editor story or the operator's notes already wrote.
 *
 * PORTED from Briefcase `backend/src/crucible/asr/asr-context.ts` (cb7c45d): the conservative
 * token estimate, the control-token scrub, the word-boundary cut. Changed for ContentStudio:
 * the wording is a prompt asset (Law 2: `shared/pipeline/transcription.yml`, passed in as
 * {@link AsrContextTemplate}, so this file stays pure and never authors a model-facing string),
 * and more than one field can be cut — in the order below, least specific first.
 *
 * LIMITS, the server's: at most 1,024 tokens of the model's own tokenizer, which only the
 * worker can count, so a context over it fails the job. The length here is ESTIMATED
 * conservatively (a token per three ASCII characters, one per anything else) against a budget
 * well under that. The chat template's control tokens (`<|...|>`, `<asr_text>`) are refused by
 * the server, so they are removed from the facts: they are never something a title means.
 */

/** What is known about one recording. Every field optional; absent means "not known". */
export interface AsrItemFacts {
  /** The recording's own title: the filename, less its extension and slot prefix. */
  readonly title?: string | null;
  /** The queue job's name, when the operator gave one. */
  readonly jobName?: string | null;
  /** Other titles the item already has: an earlier run's titles, a linked editor story's title. */
  readonly otherTitles?: readonly (string | null | undefined)[];
  /** People known to speak or be discussed: speaker names, the channel's brand terms. */
  readonly names?: readonly (string | null | undefined)[];
  /** Tags an earlier run wrote for this item: dense with names and terms. */
  readonly tags?: readonly (string | null | undefined)[];
  /** The channel's promoted items (its books, sites, other channels). */
  readonly promotedItems?: readonly (string | null | undefined)[];
  /** The operator's notes on this input. */
  readonly notes?: string | null;
  /** A description an earlier run wrote. The longest, least specific field: cut first. */
  readonly description?: string | null;
}

/** The model-facing words, from `shared/pipeline/transcription.yml` (Law 2). */
export interface AsrContextTemplate {
  readonly instruction: string;
  readonly labels: {
    readonly title: string;
    readonly job: string;
    readonly also_titled: string;
    readonly names: string;
    readonly tags: string;
    readonly promoted: string;
    readonly notes: string;
    readonly description: string;
  };
}

/** The estimated tokens a context may use: under the server's 1,024 with room for the estimate to be wrong. */
export const ASR_CONTEXT_TOKEN_BUDGET = 700;
/** A field cut to less room than this is dropped instead: a stub of a description spells nothing. */
const MIN_FIELD_TOKENS = 20;

const CHAT_CONTROL = /<\|[^|]*\|>|<asr_text>/g;
const MEDIA_EXTENSION = /\.(mp4|m4v|mov|mkv|webm|avi|flv|wmv|mpg|mpeg|ts|mts|m2ts|3gp|mp3|m4a|wav|aac|flac|ogg|opus)$/i;
/**
 * The queue's slot prefix ("u2 - ", "3 - "), which names a position on the week's list, not the
 * recording. whisper.service.ts (now transcription.service.ts) stripped it from the seed before P5 with `^[a-z]?\d+\s*-\s*`,
 * which also ate the year off a dated name ("2026-09-23 master" → "09-23 master"); a slot is
 * one or two digits with spaces around its dash.
 */
const SLOT_PREFIX = /^[a-z]?\d{1,2}\s+-\s+/i;

/** A conservative token count: a token per three ASCII characters, one per any other character. */
export function estimateTokens(text: string): number {
  let ascii = 0;
  let other = 0;
  for (const ch of text) {
    if (ch.charCodeAt(0) < 128) ascii += 1;
    else other += 1;
  }
  return Math.ceil(ascii / 3) + other;
}

/** One line of plain text with the chat template's control tokens removed. */
export function scrub(value: string | null | undefined): string {
  if (value === null || value === undefined) return '';
  return value.replace(CHAT_CONTROL, ' ').replace(/\s+/g, ' ').trim();
}

/** A file name as a title: no directory, no media extension, no slot prefix, separators as spaces. */
export function titleFromFilename(file: string): string {
  const base = file.split(/[\\/]/).pop() ?? file;
  return scrub(base.replace(MEDIA_EXTENSION, '').replace(/[_]+/g, ' ').replace(SLOT_PREFIX, ''));
}

/** Cut `text` at a word boundary so it fits `tokens`, with an ellipsis when cut ('' when nothing fits). */
function fitTo(text: string, tokens: number): string {
  if (estimateTokens(text) <= tokens) return text;
  let cut = text;
  while (cut.length > 0 && estimateTokens(`${cut}…`) > tokens) {
    const space = cut.lastIndexOf(' ', cut.length - 2);
    cut = space > 0 ? cut.slice(0, space) : cut.slice(0, Math.floor(cut.length * 0.9));
  }
  return cut.length > 0 ? `${cut}…` : '';
}

/** Unique, scrubbed, non-empty, first spelling kept, compared case-insensitively. */
function uniqueList(values: readonly (string | null | undefined)[] | undefined, exclude: ReadonlySet<string> = new Set()): string[] {
  const seen = new Set<string>(exclude);
  const out: string[] = [];
  for (const raw of values ?? []) {
    const value = scrub(raw);
    const key = value.toLowerCase();
    if (value === '' || seen.has(key)) continue;
    seen.add(key);
    out.push(value);
  }
  return out;
}

interface Field {
  readonly label: string;
  readonly value: string;
}

function render(instruction: string, fields: readonly Field[]): string {
  return [instruction, ...fields.map((f) => `${f.label}: ${f.value}`)].join('\n');
}

/**
 * The context for one recording. Never null and never blank: the instruction is always there
 * (#203), so a recording nothing is known about still gets its fillers.
 *
 * ORDER, most specific first, which is also the order in which they SURVIVE: title, job name,
 * other titles, names, tags, promoted items, notes, description. Over the budget, the LAST
 * field still present is cut to the room left at a word boundary (or dropped, if that room is
 * under {@link MIN_FIELD_TOKENS}), then the one before it, until the whole fits — so the
 * description goes first and the title last. The instruction itself is never cut: should it
 * alone overrun the budget the template is wrong, and that throws naming the file.
 */
export function buildAsrContext(facts: AsrItemFacts, template: AsrContextTemplate): string {
  const instruction = scrub(template.instruction);
  if (instruction === '') throw new Error('the transcription context template has no instruction (shared/pipeline/transcription.yml: instruction)');
  if (estimateTokens(instruction) > ASR_CONTEXT_TOKEN_BUDGET) {
    throw new Error(
      `the transcription instruction alone is ~${estimateTokens(instruction)} tokens, over the ${ASR_CONTEXT_TOKEN_BUDGET}-token ` +
      'context budget (shared/pipeline/transcription.yml: instruction)');
  }
  const L = template.labels;
  const title = scrub(facts.title);
  const job = scrub(facts.jobName);
  const titleKeys = new Set<string>([title.toLowerCase(), job.toLowerCase()].filter((k) => k !== ''));
  const otherTitles = uniqueList(facts.otherTitles, titleKeys);
  const names = uniqueList(facts.names);
  const tags = uniqueList(facts.tags, new Set(names.map((n) => n.toLowerCase())));
  const promoted = uniqueList(facts.promotedItems);

  const fields: Field[] = [];
  if (title) fields.push({ label: L.title, value: title });
  if (job && job.toLowerCase() !== title.toLowerCase()) fields.push({ label: L.job, value: job });
  if (otherTitles.length > 0) fields.push({ label: L.also_titled, value: otherTitles.join(' / ') });
  if (names.length > 0) fields.push({ label: L.names, value: names.join(', ') });
  if (tags.length > 0) fields.push({ label: L.tags, value: tags.join(', ') });
  if (promoted.length > 0) fields.push({ label: L.promoted, value: promoted.join('; ') });
  const notes = scrub(facts.notes);
  if (notes) fields.push({ label: L.notes, value: notes });
  const description = scrub(facts.description);
  if (description) fields.push({ label: L.description, value: description });

  while (fields.length > 0 && estimateTokens(render(instruction, fields)) > ASR_CONTEXT_TOKEN_BUDGET) {
    const last = fields.pop()!;
    const room = ASR_CONTEXT_TOKEN_BUDGET - estimateTokens(`${render(instruction, fields)}\n${last.label}: `);
    const fitted = room >= MIN_FIELD_TOKENS ? fitTo(last.value, room) : '';
    if (fitted !== '') {
      fields.push({ label: last.label, value: fitted });
      break;
    }
  }
  return render(instruction, fields);
}
