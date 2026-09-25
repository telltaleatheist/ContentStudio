/**
 * The final title and summary of each chapter — `summarize_chapter` on the 'summarize' role
 * (the capable routed model, the 27B: LEDGER #199 "final chapter -> 27b -> chapter title").
 *
 * The prompt, its placeholders and the answer's shape are the ones the whole-transcript
 * service sends today (chapter-whole-transcript.service.ts detailChapters / askDetail), so a
 * chapter titled here reads exactly as one titled there: title on the first line, summary
 * after it, plain text (Law 12). Thinking ON, deliberately, as that service says: this
 * title-plus-summary shape was tested thinking-on across the pipeline's history, and the one
 * afternoon it ran thinking-off it dropped summaries.
 *
 * A LONG CHAPTER IS READ IN PARTS (LEDGER #196: every local call under ~12-16k tokens). An
 * `episodes` chapter of a stream can be an hour and a half of speech, ~15k tokens on its own;
 * with the 8192-token thinking budget on top it fits no 16,384 load. So a chapter whose own
 * transcript is over SUMMARIZE_TRANSCRIPT_TOKENS is cut at sentence boundaries into equal
 * windows under it; each window is titled and summarised by the same summarize_chapter body,
 * and the chapter's title comes from `summarize_chapter_parts` over those parts in order. It
 * is DECLARED: the chapter is listed in stats.titledFromParts and a warning names it (Law 8).
 * Nothing is truncated: every sentence of the chapter is read by some call.
 *
 * An answer that cannot be read costs this ONE chapter (or part) its title and prose, warned
 * about and never re-asked (Law 3); the chapter still exists at the right second and carries
 * its outline label. A transport failure throws out.
 */

import { CHAPTER_PROMPTS } from '../chapter-prompts';
import { parseTitleDetail } from '../plain-call';
import { formatPrompt } from '../system-prompts';
import { ChatFn } from './types';
import { SNAP_PROMPTS, promotedItemsLine } from './prompts';
import { CHARS_PER_TOKEN } from './chunks';

/** The detail call's output budget: sized for thinking as much as the answer (chapter-whole-transcript.service.ts NUM_PREDICT). */
export const SUMMARIZE_MAX_TOKENS = 8192;

/**
 * The most transcript one title call reads, in tokens (the declared ~4 characters per token of
 * chunks.ts). 6,000 + the ~900-token body + the 8,192 budget stays under a 16,384 load.
 */
export const SUMMARIZE_TRANSCRIPT_TOKENS = 6000;

/** One sentence of the chapter, as the title call needs it. */
export interface SummarizeUnit {
  text: string;
  start: number;
  end: number;
}

export interface SummarizeInput {
  number: number;
  total: number;
  videoTitle: string;
  channelName?: string;
  promotedItems?: readonly string[];
  /** The previous chapter's summary (or its title when it had none): the deleted pipeline's law, kept. */
  previousDetail: string;
  /** The last few titles already written, so this one names what is new (2026-08-30 campaign). */
  previousTitles: readonly string[];
  /** The chapter's own sentences, in order. */
  units: readonly SummarizeUnit[];
  /** Rendered by the caller, may be empty (the whole-video name scaffold is P4's; empty here). */
  entityScaffold: string;
  clock: string;
  /**
   * Thinking on the title call. The service's default is ON (the header says why); a run may
   * turn it off as a declared setting (chaptering.service.ts `titleThinking`), never silently.
   */
  thinking: boolean;
}

export interface SummarizeResult {
  title: string;
  summary: string;
  /** How many parts the chapter was read in (1 = its whole transcript in one call). */
  parts: number;
}

/** The context lines above the transcript, as chapter-whole-transcript.service.ts contextLines renders them. */
export function contextLines(channelName: string | undefined, previousDetail: string, previousTitles: readonly string[]): string {
  const lines: string[] = [];
  if (channelName) lines.push(`Channel: ${channelName}`);
  if (previousDetail) lines.push(`Previous chapter: "${previousDetail}"`);
  if (previousTitles.length > 0) {
    lines.push(
      `The chapters just before this one are titled ${previousTitles.map((t) => `"${t}"`).join(', ')} — ` +
        `this chapter continues from them, so its title names what is NEW in this stretch, not their ` +
        `wording or their angle re-used.`,
    );
  }
  return lines.length > 0 ? `${lines.join('\n')}\n` : '';
}

export function summarizePrompt(input: Omit<SummarizeInput, 'units' | 'number'> & { number: number | string; transcript: string }): string {
  return formatPrompt(CHAPTER_PROMPTS.SUMMARIZE_CHAPTER, {
    number: input.number,
    video: input.videoTitle || 'untitled',
    promoted_items: promotedItemsLine(input.promotedItems),
    context_lines: contextLines(input.channelName, input.previousDetail, input.previousTitles),
    entity_scaffold: input.entityScaffold,
    transcript: input.transcript,
  });
}

/**
 * The windows a chapter is read in: one when its transcript fits the budget, else the fewest
 * equal windows (by characters, at sentence boundaries) that each fit it.
 */
export function summaryWindows(texts: readonly string[], budgetTokens: number = SUMMARIZE_TRANSCRIPT_TOKENS): Array<[number, number]> {
  const chars = texts.map((t) => t.length + 1);
  const total = chars.reduce((a, b) => a + b, 0);
  const budget = budgetTokens * CHARS_PER_TOKEN;
  if (total <= budget || texts.length < 2) return [[0, texts.length]];
  const count = Math.ceil(total / budget);
  const target = total / count;
  const out: Array<[number, number]> = [];
  let from = 0;
  let acc = 0;
  for (let i = 0; i < texts.length; i++) {
    acc += chars[i];
    const left = count - out.length - 1;
    if (left > 0 && acc >= target * (out.length + 1) && texts.length - (i + 1) >= left) {
      out.push([from, i + 1]);
      from = i + 1;
    }
  }
  out.push([from, texts.length]);
  return out;
}

async function titleCall(
  chat: ChatFn,
  prompt: string,
  what: string,
  warn: (message: string) => void,
  thinking: boolean,
  signal?: AbortSignal,
): Promise<{ title: string; summary: string }> {
  const result = await chat(prompt, { role: 'summarize', maxTokens: SUMMARIZE_MAX_TOKENS, thinking, what, signal });
  if (result.finishReason === 'length') {
    warn(`${what} hit its ${SUMMARIZE_MAX_TOKENS}-token cap, so it carries no title or summary from the model`);
    return { title: '', summary: '' };
  }
  try {
    const { title, detail } = parseTitleDetail(result.text, `${what} (chapters)`);
    if (!detail) warn(`${what} could not be described by the model, so it carries no summary`);
    return { title, summary: detail };
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error));
    return { title: '', summary: '' };
  }
}

export async function summarizeChapter(
  chat: ChatFn,
  input: SummarizeInput,
  warn: (message: string) => void,
  signal?: AbortSignal,
  clockOf: (seconds: number) => string = (s) => `${Math.floor(s)}s`,
): Promise<SummarizeResult> {
  const what = `chapter ${input.number}/${input.total} (${input.clock})`;
  const texts = input.units.map((u) => u.text);
  const windows = summaryWindows(texts);
  if (windows.length === 1) {
    const answer = await titleCall(chat, summarizePrompt({ ...input, transcript: texts.join(' ') }), what, warn, input.thinking, signal);
    return { ...answer, parts: 1 };
  }

  warn(
    `${what} is over the title call's ${SUMMARIZE_TRANSCRIPT_TOKENS}-token transcript budget, so it was read in ` +
      `${windows.length} parts and titled from their titles and summaries`,
  );
  const parts: string[] = [];
  let previousDetail = input.previousDetail;
  for (let k = 0; k < windows.length; k++) {
    const [a, b] = windows[k];
    const clock = `${clockOf(input.units[a].start)}-${clockOf(input.units[b - 1].end)}`;
    const part = await titleCall(
      chat,
      summarizePrompt({ ...input, number: `${input.number} (part ${k + 1} of ${windows.length})`, previousDetail, transcript: texts.slice(a, b).join(' ') }),
      `${what} part ${k + 1}/${windows.length} (${clock})`,
      warn,
      input.thinking,
      signal,
    );
    parts.push(`Part ${k + 1} (${clock}): ${part.title || '(untitled)'}\n${part.summary}`.trim());
    previousDetail = part.summary || part.title || previousDetail;
  }
  const answer = await titleCall(
    chat,
    SNAP_PROMPTS.summarizeParts({
      number: input.number,
      video: input.videoTitle || 'untitled',
      promoted_items: promotedItemsLine(input.promotedItems),
      context_lines: contextLines(input.channelName, input.previousDetail, input.previousTitles),
      parts: parts.join('\n\n'),
    }),
    `${what} from its ${windows.length} parts`,
    warn,
    input.thinking,
    signal,
  );
  return { ...answer, parts: windows.length };
}
