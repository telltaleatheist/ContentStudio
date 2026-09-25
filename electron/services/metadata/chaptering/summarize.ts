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
 * An answer that cannot be read costs this ONE chapter its title and prose, warned about and
 * never re-asked (Law 3); the chapter still exists at the right second and carries its
 * outline label. A transport failure throws out.
 */

import { CHAPTER_PROMPTS } from '../chapter-prompts';
import { parseTitleDetail } from '../plain-call';
import { formatPrompt } from '../system-prompts';
import { ChatFn } from './types';
import { promotedItemsLine } from './prompts';

/** The detail call's output budget: sized for thinking as much as the answer (chapter-whole-transcript.service.ts NUM_PREDICT). */
export const SUMMARIZE_MAX_TOKENS = 8192;

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
  /** The chapter's own sentences, joined. */
  transcript: string;
  /** Rendered by the caller, may be empty (the whole-video name scaffold is P4's; empty here). */
  entityScaffold: string;
  clock: string;
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

export function summarizePrompt(input: SummarizeInput): string {
  return formatPrompt(CHAPTER_PROMPTS.SUMMARIZE_CHAPTER, {
    number: input.number,
    video: input.videoTitle || 'untitled',
    promoted_items: promotedItemsLine(input.promotedItems),
    context_lines: contextLines(input.channelName, input.previousDetail, input.previousTitles),
    entity_scaffold: input.entityScaffold,
    transcript: input.transcript,
  });
}

export async function summarizeChapter(
  chat: ChatFn,
  input: SummarizeInput,
  warn: (message: string) => void,
  signal?: AbortSignal,
): Promise<{ title: string; summary: string }> {
  const what = `chapter ${input.number}/${input.total} (${input.clock})`;
  const result = await chat(summarizePrompt(input), { role: 'summarize', maxTokens: SUMMARIZE_MAX_TOKENS, thinking: true, what, signal });
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
