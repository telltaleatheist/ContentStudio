/**
 * THE THUMBNAILS' ONE MODEL-FACING SHAPE, assembled from
 * electron/assets/prompts/shared/pipeline/thumbnails.yml (Law 2: code assembles, never authors).
 *
 * THE WORDS: one plain-text call on the `thumbnail_words` routing row. The answer is plain text in
 * three labelled blocks (Law 12), read by `parseThumbnailWords` below. (The five frame questions a
 * vision model answered per frame on the `thumbnail_frames` row were removed 2026-09-29 with the
 * frame scoring: Owen picks the frames himself.)
 *
 * THE NEW TEXT RULES (Owen, 2026-09-28), replacing the old three-word logic for this tab only: 2-5
 * words, capitals, a complete thought to a stranger that opens a question; adds to the paired
 * title, never restates it; grounded in the transcript (the subject's claim lightly paraphrased,
 * or the host's reaction). Three kinds, one per A/B variant, so the test compares ideas: claim,
 * stakes/absurdity, reaction. The metadata pipeline's THUMBNAIL TEXT OPTIONS field is untouched.
 */
import { promptAssets } from '../metadata/prompt-assets';

export const THUMBNAILS_PROMPT_FILE = 'thumbnails.yml';

/** The three kinds of option, in the order the prompt asks for them and the tab lists them. */
export const WORD_KINDS = ['claim', 'stakes', 'reaction'] as const;
export type WordKind = (typeof WORD_KINDS)[number];

/** How many options of each kind are asked for (Owen: "offer several options per kind"). */
export const OPTIONS_PER_KIND = 5;

/** The word count each option should have. Outside it the option is kept and a warning says so (Law 3). */
export const MIN_WORDS = 2;
export const MAX_WORDS = 5;

function asset(key: string): string {
  return promptAssets().pipeline(THUMBNAILS_PROMPT_FILE, key);
}

/** One caption line as the prompt shows it: `[m:ss] text`. */
export function transcriptLine(startSeconds: number, text: string): string {
  const s = Math.max(0, Math.floor(startSeconds));
  const clock = s >= 3600
    ? `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`
    : `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
  return `[${clock}] ${text.replace(/\s+/g, ' ').trim()}`;
}

/** A caption's `HH:MM:SS,mmm` start in seconds; anything else is refused naming the caption. */
export function srtSeconds(value: string, what: string): number {
  const m = /^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/.exec(value.trim());
  if (!m) throw new Error(`${what}: "${value}" is not a caption time.`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4].padEnd(3, '0')) / 1000;
}

/**
 * A transcript's captions as the words prompt shows them, one `[m:ss] text` line
 * each. Shared by the Thumbnails tab (the saved transcript) and the metadata run's thumbnails stage
 * (the item's own captions, thumbnails/pipeline.ts).
 */
export function transcriptLines(segments: ReadonlyArray<{ start: string; text: string }>): string[] {
  return segments.map((s, i) => transcriptLine(srtSeconds(s.start, `caption ${i + 1}`), s.text));
}

/**
 * The words prompt, every slot filled in one pass with a function replacer (PROMPT-LEARNINGS:
 * a `$` in a transcript must never be read as a replacement pattern). An unfilled slot throws.
 *
 * `avoid` ("More options" in the Thumbnails window, 2026-09-29): the lines already written for this
 * title, shown to the model in the asset's `more` paragraph so it writes others. Empty: the `more`
 * slot is empty and the prompt is exactly the one without it.
 */
export function buildWordsPrompt(input: { channel: string; creator: string; title: string; transcript: readonly string[]; avoid?: readonly string[] }): string {
  if (input.transcript.length === 0) throw new Error('The thumbnail words need the video\'s transcript, and it has no lines.');
  if (input.title.trim() === '') throw new Error('The thumbnail words are written as a pair with a title, and no title was picked.');
  const values: Record<string, string> = {
    channel: input.channel,
    creator: input.creator,
    title: input.title.trim(),
    transcript: input.transcript.join('\n'),
    per_kind: String(OPTIONS_PER_KIND),
    more: '',
  };
  const avoid = [...new Set((input.avoid ?? []).map((l) => l.trim()).filter((l) => l !== ''))];
  if (avoid.length > 0) {
    // The paragraph sits after the three kinds' descriptions, before the answer's shape.
    values.more = '\n\n' + asset('more').replace(/\{written\}/g, () => avoid.join('\n'));
  }
  return asset('text').replace(/\{([a-z_]+)\}/g, (whole, name: string) => {
    const value = values[name];
    if (value === undefined) throw new Error(`thumbnails.yml "text" has a slot {${name}} that nothing fills.`);
    return value;
  });
}

export interface WordOptions {
  claim: string[];
  stakes: string[];
  reaction: string[];
  /** Plain sentences about what came back that was off the brief. The options are kept regardless. */
  warnings: string[];
}

const HEADER = /^[\s#*_>-]*(CLAIMS?|STAKES|REACTIONS?)[\s*_:.-]*$/i;
const LIST_MARKER = /^\s*(?:[-*•]\s+|\d{1,3}[.)]\s+)/;

function kindOf(header: string): WordKind {
  const word = header.toLowerCase();
  if (word.startsWith('claim')) return 'claim';
  if (word.startsWith('stakes')) return 'stakes';
  return 'reaction';
}

/**
 * Read the words answer: a kind's name on its own line, then its options one per line. List
 * markers, surrounding quotes and emphasis are decoration and are stripped; options are shown in
 * capitals (the style is capitals, as a CSS text-transform would be). Text before the first kind is
 * set aside with a warning. A kind with no options is a warning; an answer with no options at all
 * throws with what came back.
 */
export function parseThumbnailWords(text: string, what: string): WordOptions {
  const out: WordOptions = { claim: [], stakes: [], reaction: [], warnings: [] };
  let kind: WordKind | null = null;
  const stray: string[] = [];
  for (const raw of text.split('\n')) {
    const line = raw.trim();
    if (line === '') continue;
    const header = HEADER.exec(line);
    if (header) {
      kind = kindOf(header[1]);
      continue;
    }
    const option = line
      .replace(LIST_MARKER, '')
      .replace(/^[*_]+|[*_]+$/g, '')
      .replace(/^["'“‘]+|["'”’]+$/g, '')
      .trim()
      .toUpperCase();
    if (option === '') continue;
    if (kind === null) {
      stray.push(option);
      continue;
    }
    if (!out[kind].includes(option)) out[kind].push(option);
  }
  const total = out.claim.length + out.stakes.length + out.reaction.length;
  if (total === 0) {
    throw new Error(`The answer to ${what} has no options under CLAIM, STAKES or REACTION (got: "${text.slice(0, 200)}")`);
  }
  if (stray.length > 0) out.warnings.push(`The model wrote ${stray.length} line(s) before the first kind; they were left out: ${stray.join(' / ')}`);
  for (const k of WORD_KINDS) {
    if (out[k].length === 0) out.warnings.push(`The model wrote no ${k.toUpperCase()} options.`);
    for (const option of out[k]) {
      const n = option.split(/\s+/).length;
      if (n < MIN_WORDS || n > MAX_WORDS) out.warnings.push(`"${option}" is ${n} word${n === 1 ? '' : 's'}; the brief asks for ${MIN_WORDS} to ${MAX_WORDS}.`);
    }
  }
  return out;
}
