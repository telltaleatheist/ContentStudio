/**
 * THE THUMBNAILS TAB'S TWO MODEL-FACING SHAPES, assembled from
 * electron/assets/prompts/shared/pipeline/thumbnails.yml (Law 2: code assembles, never authors).
 *
 *   1. THE WORDS: one plain-text call on the `thumbnail_words` routing row. The answer is plain
 *      text in three labelled blocks (Law 12), read by `parseThumbnailWords` below.
 *   2. THE FRAME QUESTIONS: five fixed-answer questions asked of ONE frame per decide call on the
 *      `thumbnail_frames` row (a vision model). One image per call on purpose (Owen, 2026-09-28):
 *      a question about a multi-image state is ambiguous about which image it means.
 *
 * THE NEW TEXT RULES (Owen, 2026-09-28), replacing the old three-word logic for this tab only: 2-5
 * words, capitals, a complete thought to a stranger that opens a question; adds to the paired
 * title, never restates it; grounded in the transcript (the subject's claim lightly paraphrased,
 * or the host's reaction). Three kinds, one per A/B variant, so the test compares ideas: claim,
 * stakes/absurdity, reaction. The metadata pipeline's THUMBNAIL TEXT OPTIONS field is untouched.
 */
import type { DecideQuestion } from '@crucible/client';
import { promptAssets } from '../metadata/prompt-assets';
import { FRAME_QUESTIONS, SCREEN_OPTIONS } from './frame-ranking';

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

/**
 * The words prompt, every slot filled in one pass with a function replacer (PROMPT-LEARNINGS:
 * a `$` in a transcript must never be read as a replacement pattern). An unfilled slot throws.
 */
export function buildWordsPrompt(input: { channel: string; creator: string; title: string; transcript: readonly string[] }): string {
  if (input.transcript.length === 0) throw new Error('The thumbnail words need the video\'s transcript, and it has no lines.');
  if (input.title.trim() === '') throw new Error('The thumbnail words are written as a pair with a title, and no title was picked.');
  const values: Record<string, string> = {
    channel: input.channel,
    creator: input.creator,
    title: input.title.trim(),
    transcript: input.transcript.join('\n'),
    per_kind: String(OPTIONS_PER_KIND),
  };
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

/** The decide call's state text for one frame; the image carries the rest. */
export function frameState(): string {
  return asset('frames.state');
}

/** The five frame questions, words from thumbnails.yml, shapes fixed here (frame-ranking.ts reads them). */
export function frameQuestions(): Record<(typeof FRAME_QUESTIONS)[number], DecideQuestion> {
  const levels = asset('frames.expression.levels').split('\n').map((l) => l.trim()).filter((l) => l.length > 0);
  if (levels.length !== 5) {
    throw new Error(`thumbnails.yml "frames.expression.levels" lists ${levels.length} levels; the expression scale has 5 (blank to extreme).`);
  }
  return {
    screen: {
      type: 'choice',
      instructions: asset('frames.screen.instructions'),
      options: { [SCREEN_OPTIONS[0]]: asset('frames.screen.video'), [SCREEN_OPTIONS[1]]: asset('frames.screen.screen') },
    },
    face: { type: 'yesno', instructions: asset('frames.face') },
    expression: { type: 'score', instructions: asset('frames.expression.instructions'), levels },
    eyes: { type: 'yesno', instructions: asset('frames.eyes') },
    strong: { type: 'yesno', instructions: asset('frames.strong') },
  } as Record<(typeof FRAME_QUESTIONS)[number], DecideQuestion>;
}
