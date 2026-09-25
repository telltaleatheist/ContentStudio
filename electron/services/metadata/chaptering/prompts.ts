/**
 * The snap chaptering prompts — access only. THE BODIES ARE NOT HERE.
 *
 * They are the `snap_*` keys of electron/assets/prompts/shared/pipeline/chapters.yml, beside
 * the whole-transcript bodies they will replace (Law 2: code assembles, never authors; a
 * missing key throws naming the file and the key). What each body encodes and the
 * measurement behind it is in PROMPT-LEARNINGS.md, Part 5. The outline body for `detailed`,
 * the assign question and the plug statement are segment.py's VERBATIM (docs/crucible/
 * reference/segment.py) — they are part of the measured result (YTSeg F1@±1 0.72), and a
 * reworded one has to be re-benchmarked.
 *
 * Placeholders are filled with system-prompts.ts formatPrompt (function replacers, so a `$`
 * in a transcript cannot corrupt the prompt).
 */

import { promptAssets } from '../prompt-assets';
import { formatPrompt } from '../system-prompts';
import { granularitySetting } from './granularity';
import { Granularity } from './types';

const CHAPTERS_FILE = 'chapters.yml';

/** The label set is A..Z: 25 outline items + the ad item = 26 letters (segment.py MAX_ITEMS). */
export const MAX_OPTIONS = 26;
export const MAX_ITEMS = MAX_OPTIONS - 1;

/** Sentences per decide request; each request primes the shared state once (segment.py BATCH). */
export const BATCH = 64;

/** segment.py:44-47 — the outline request's output cap. */
export const OUTLINE_MAX_TOKENS = 1000;

/**
 * segment.py:28 `clip`: `s` when it is at most `n` characters, else its first n-1 plus an
 * ellipsis. Counts code points, as Python does.
 */
export function clip(s: string, n: number): string {
  const cps = Array.from(s);
  return cps.length <= n ? s : cps.slice(0, n - 1).join('') + '…';
}

/**
 * The {promoted_items} slot's text for summarize_chapter; a channel that declares none gets a
 * truthful sentence, not a brace (chapter-whole-transcript.service.ts's rule, kept so a chapter
 * titled here reads as one titled there).
 */
export function promotedItemsLine(items: readonly string[] | undefined): string {
  return declaredPromotions(items) ?? 'none are declared for this channel';
}

/**
 * The channel's promoted items as one slot's text, or null when it declares none. Null selects
 * the MEASURED ad item and statement (segment.py's verbatim text); a list selects the
 * `_promoted` bodies, which name this channel's own plugs (plan §10.2 step 2). Nothing is
 * invented for a channel with none.
 */
export function declaredPromotions(items: readonly string[] | undefined): string | null {
  const list = (items || []).map((t) => t.trim()).filter((t) => t.length > 0);
  return list.length > 0 ? list.join('; ') : null;
}

export const SNAP_PROMPTS = {
  /**
   * The level-1 outline body for a granularity. Placeholders: {transcript}, {max_items},
   * {duration} (the runtime in words, the episodes body reads it).
   */
  outline(granularity: Granularity, transcript: string, maxItems: number, duration: string): string {
    const body = promptAssets().pipeline(CHAPTERS_FILE, granularitySetting(granularity).outlineKey);
    // The transcript is filled LAST: formatPrompt fills one key at a time, and a transcript
    // holding a literal "{max_items}" would otherwise have it filled too.
    return formatPrompt(body, { max_items: maxItems, duration, transcript });
  },

  /** The sub-outline body (level 2, inside one long section): segment.py's, over that section only. */
  subOutline(transcript: string, maxItems: number): string {
    const body = promptAssets().pipeline(CHAPTERS_FILE, 'snap_outline_detailed');
    return formatPrompt(body, { max_items: maxItems, duration: '', transcript });
  },

  /** segment.py:71-73 — the per-sentence assign question. Placeholders: {sentence}, {previous}. */
  assign(sentence: string, previous: string): string {
    const body = promptAssets().pipeline(CHAPTERS_FILE, 'snap_assign');
    return formatPrompt(body, { sentence: clip(sentence, 300), previous: clip(previous, 200) });
  },

  /** segment.py:65 — the previous-sentence stand-in for the first sentence of the video. */
  get START_OF_VIDEO(): string {
    return promptAssets().pipeline(CHAPTERS_FILE, 'snap_assign_start');
  },

  /**
   * The fixed ad / self-promotion outline item: segment.py:23 verbatim for a channel that
   * declares no promoted items, the `_promoted` body naming them otherwise.
   */
  plugItem(promotedItems: readonly string[] | undefined): string {
    const line = declaredPromotions(promotedItems);
    if (line === null) return promptAssets().pipeline(CHAPTERS_FILE, 'snap_plug_item');
    return formatPrompt(promptAssets().pipeline(CHAPTERS_FILE, 'snap_plug_item_promoted'), { promoted_items: line });
  },

  /**
   * segment.py:94-96 — the yes/no that confirms a stretch assigned to the ad item, QUOTING the
   * passage (clipped at 700 characters, as measured). Verbatim without promoted items, the
   * `_promoted` body with them. Placeholders: {passage}, {promoted_items}.
   */
  plugConfirm(sentences: readonly string[], promotedItems: readonly string[] | undefined): string {
    const line = declaredPromotions(promotedItems);
    const passage = clip(sentences.join(' '), 700);
    if (line === null) return formatPrompt(promptAssets().pipeline(CHAPTERS_FILE, 'snap_plug_confirm'), { passage });
    // The passage is filled LAST, for the reason outline() gives.
    return formatPrompt(promptAssets().pipeline(CHAPTERS_FILE, 'snap_plug_confirm_promoted'), { promoted_items: line, passage });
  },

  /**
   * The title call for a chapter too long to read in one window (summarize.ts): its parts'
   * titles and summaries, in order. Placeholders as summarize_chapter's, plus {parts}.
   */
  summarizeParts(fill: { number: number; video: string; promoted_items: string; context_lines: string; parts: string }): string {
    return formatPrompt(promptAssets().pipeline(CHAPTERS_FILE, 'summarize_chapter_parts'), fill);
  },
};
