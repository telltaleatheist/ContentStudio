/**
 * What a job's work in a batch stage will need of each model's load (crucible/batch.ts
 * `StageNeed`, LEDGER #266): stated at the stage's gate so the batch's first load of the stage is
 * at the largest context any of its jobs needs there, and no later job reloads the model.
 *
 * TWO KINDS OF NUMBER, and which is which is said on each:
 *
 *   EXACT       the scorer's (`chapters` stage): its decide and outline states are the transcript's
 *               own chunks, planned by the same pure functions chaptering runs (units.ts, chunks.ts:
 *               the state is a chunk's sentences joined by newlines, chaptering.service.ts runLevel and
 *               stories.ts), sized by the same `loadContextFor` the calls size themselves with.
 *   ESTIMATED   the writing model's (`fields` stage): the chapter titles are sized from the stored
 *               boundaries with the real title prompt (summarize.ts), allowing for the previous
 *               chapter's summary and titles that are not written yet; a field call is the content it
 *               reads plus the measured largest prompt around it (docs/crucible/P4.md's table); the
 *               scrub is its measured prompt plus its 16,384 budget. A call that needs more than the
 *               floor this sets grows the load once, as a single job's would, and session.ts says so
 *               loudly; nothing is cut and nothing is refused because of an estimate.
 *
 * Nothing here picks a model (#204): the caller names the model each need is for, bound from the
 * routing exactly as the call will bind it. Pure: no Crucible, no electron.
 */

import type { StageNeed } from '../../crucible/batch';
import { DECIDE_QUESTION_TOKENS, estimateTokens, loadContextFor } from '../../crucible/context-check';
import { planChunks, unitTokens, CHARS_PER_TOKEN as CHUNK_CHARS_PER_TOKEN } from './chaptering/chunks';
import { MAX_ITEMS, OUTLINE_MAX_TOKENS, SNAP_PROMPTS } from './chaptering/prompts';
import { SUMMARIZE_TRANSCRIPT_TOKENS, TITLE_MAX_TOKENS, renderTranscript, summarizePrompt } from './chaptering/summarize';
import type { ChapteringResult, SentenceUnit, SpeakerRole } from './chaptering/types';

/**
 * Everything in a field call's prompt that is not the content it reads, at its largest: P4's table
 * (docs/crucible/P4.md, "raw prompt tokens") has the thumbnail-text call for u1 milo at 27,702
 * estimated tokens over a 69,356-char transcript (19,816 tokens), so 7,886 tokens of preamble, field
 * section, insights and entity lists; the other rows are smaller. 8,000 tokens at the codebase's
 * 3.5 characters a token.
 */
export const FIELD_PROMPT_OVERHEAD_CHARS = 28_000;

/**
 * The scrub's prompt at its largest: P4 measured the description scrubs at ~4,807 estimated tokens
 * (docs/crucible/P4.md, "the two alternate-description scrubs 840/840 chars at 4,807/4,807 tokens").
 * 6,000 tokens' worth at 3.5 characters a token, so a longer description still fits the step.
 */
export const SCRUB_PROMPT_CHARS = 21_000;

/**
 * What a title prompt carries before its chapter is written: the previous chapter's summary (a few
 * sentences) and the last three titles. Not measured; stated so the estimate can be read: 1,500
 * characters of summary and three 120-character titles (the outline's clip length, prompts.ts).
 */
export const TITLE_CONTEXT_ALLOWANCE = { previousDetailChars: 1_500, previousTitles: 3, titleChars: 120 } as const;

function largest(needs: StageNeed[]): StageNeed | null {
  return needs.reduce<StageNeed | null>((best, n) => (best === null || n.tokens > best.tokens ? n : best), null);
}

/**
 * The scorer's largest load in the `chapters` stage, EXACT: every level-1 chunk's decide state
 * (`DECIDE_QUESTION_TOKENS` on top) and, at the chapters grain, its outline prompt
 * (`OUTLINE_MAX_TOKENS` on top). Level 2 and the ad checks read sub-ranges of the same states, and
 * the stories grain's pair and place states are clipped smaller. Null for a transcript with no units.
 */
export function scorerNeed(units: readonly SentenceUnit[], model: string, method: 'outline' | 'junctions', label: string): StageNeed | null {
  if (units.length === 0) return null;
  const texts = units.map((u) => u.text);
  const chunks = planChunks(unitTokens(texts));
  const needs: StageNeed[] = [];
  chunks.forEach((chunk, k) => {
    const state = texts.slice(chunk.start, chunk.end).join('\n');
    const where = `${label}, chunk ${k + 1}/${chunks.length}`;
    needs.push({ model, tokens: loadContextFor(state.length, DECIDE_QUESTION_TOKENS), why: `${where}: a decide state of ~${estimateTokens(state.length)} tokens` });
    if (method === 'outline') {
      const prompt = SNAP_PROMPTS.outline(state, MAX_ITEMS);
      needs.push({ model, tokens: loadContextFor(prompt.length, OUTLINE_MAX_TOKENS), why: `${where}: an outline prompt of ~${estimateTokens(prompt.length)} tokens` });
    }
  });
  return largest(needs);
}

/**
 * The title model's largest load for this item's chapter titles, ESTIMATED from the stored
 * boundaries: each chapter's real title prompt over its own sentences (a chapter longer than one
 * title call reads is read in windows of SUMMARIZE_TRANSCRIPT_TOKENS, summarize.ts), with the
 * TITLE_CONTEXT_ALLOWANCE for what the earlier titles will have written, plus the title budget.
 */
export function titleNeed(
  boundaries: ChapteringResult,
  model: string,
  options: { videoTitle: string; channelName?: string; promotedItems?: readonly string[]; titleMaxTokens?: number; speakerRoles?: ReadonlyMap<string, SpeakerRole>; label: string },
): StageNeed | null {
  const tagged = boundaries.stats.speakerTagged;
  const window = SUMMARIZE_TRANSCRIPT_TOKENS * CHUNK_CHARS_PER_TOKEN;
  const previousDetail = 'x'.repeat(TITLE_CONTEXT_ALLOWANCE.previousDetailChars);
  const previousTitles = Array.from({ length: TITLE_CONTEXT_ALLOWANCE.previousTitles }, () => 'x'.repeat(TITLE_CONTEXT_ALLOWANCE.titleChars));
  const needs = boundaries.chapters.map((c, i): StageNeed => {
    const units = boundaries.units.slice(c.unitRange[0], c.unitRange[1]).map((u) => ({
      text: u.text, start: u.start, end: u.end, role: tagged ? options.speakerRoles?.get(u.speaker!) ?? 'unsure' : undefined,
    }));
    const transcript = renderTranscript(units, tagged).slice(0, window);
    const prompt = summarizePrompt({
      number: i + 1, total: boundaries.chapters.length, videoTitle: options.videoTitle, channelName: options.channelName,
      promotedItems: options.promotedItems, previousDetail, previousTitles, entityScaffold: '', clock: '', tagged, transcript,
    });
    const budget = options.titleMaxTokens ?? TITLE_MAX_TOKENS;
    return { model, tokens: loadContextFor(prompt.length, budget), why: `${options.label}, chapter ${i + 1}'s title: ~${estimateTokens(prompt.length)} tokens of prompt and a ${budget}-token budget (estimated)` };
  });
  return largest(needs);
}

/** A field call's load, ESTIMATED: the content it reads plus FIELD_PROMPT_OVERHEAD_CHARS, and its answer budget. */
export function fieldNeed(contentChars: number, answerTokens: number, model: string, label: string): StageNeed {
  const chars = contentChars + FIELD_PROMPT_OVERHEAD_CHARS;
  return { model, tokens: loadContextFor(chars, answerTokens), why: `${label}, the field calls: ${contentChars} chars of content plus the measured largest prompt around it (estimated)` };
}

/** The scrub's load, ESTIMATED: SCRUB_PROMPT_CHARS and its answer budget. */
export function scrubNeed(answerTokens: number, model: string, label: string): StageNeed {
  return { model, tokens: loadContextFor(SCRUB_PROMPT_CHARS, answerTokens), why: `${label}, the scrub: its measured prompt and a ${answerTokens}-token budget (estimated)` };
}
