/**
 * The outline: the scorer model lists the sections of the transcript, in order, as plain
 * lines (segment.py `outline()`, docs/crucible/reference/segment.py:39-58). Thinking off,
 * temperature 0, at most 25 items so that with the ad item every assign question stays inside
 * the 26 letters snap can read (PHASE22 §2.2).
 *
 * The parsing is segment.py's: strip " -*•\t" from each line, drop empties, de-duplicate
 * case-insensitively keeping the first, cap at `maxItems`. Two defensive additions from
 * Briefcase (no effect on what the measured model writes): a leading "1." / "2)" and markdown
 * "**" are removed, and a label is clipped to 120 characters.
 *
 * ONE item is an answer, not an error: a single-topic stretch has a one-item outline and
 * becomes one chapter spanning it (chaptering.service.ts). NO usable item is refused — there
 * is nothing to name a chapter with, and inventing a label would be a fallback (Law 1).
 *
 * A PROSE ANSWER IS REFUSED, naming the call (P8b's brief, decision 4). Measured once in P8a
 * (docs/crucible/P8a.md): one chunk of the 2026-09-23 stream answered "Analysis of the
 * transcript reveals that…" and "The stream flows as follows:", and the parser, reading every
 * line, made those sentences into options. Reading prose line by line under some guessed rule
 * would be a fallback (Law 1), so an answer whose lines are not labels fails loudly. What is not
 * a label is declared in `proseLine`: a lead-in ending in a colon, a line holding two sentences,
 * or a line over PROSE_WORDS words (the longest label the 9B wrote across P8a's runs was 17).
 */

import { ChatFn, ChapteringError } from './types';
import { MAX_ITEMS, OUTLINE_MAX_TOKENS, clip } from './prompts';

/** Longest outline label kept. */
export const MAX_LABEL_CHARS = 120;

/** Python str.splitlines() line breaks. */
const SPLITLINES = new RegExp('\\r\\n|[\\n\\r\\v\\f\\x1c\\x1d\\x1e\\x85\\u2028\\u2029]');
const STRIP = ' -*•\t';

/** Python str.strip(chars). */
function stripChars(s: string, chars: string): string {
  let a = 0;
  let b = s.length;
  while (a < b && chars.includes(s[a])) a++;
  while (b > a && chars.includes(s[b - 1])) b--;
  return s.slice(a, b);
}

/** A line longer than this many words is a sentence of prose, not an outline label. */
export const PROSE_WORDS = 30;

/**
 * Why a line is not an outline label, or null when it is one. The two-sentence rule wants a word
 * of three or more letters, an all-capitals word ("AI.") or a number before the stop, so the
 * short abbreviations of a label ("vs. Biden", "Dr. Phil") stay labels.
 */
export function proseLine(line: string): string | null {
  const l = line.trim();
  if (/:\s*$/.test(l)) return 'it is a lead-in ending in a colon';
  if (/(?:[A-Za-z]{3,}|[A-Z]{2,}|\d+)[.!?]["')\]]*\s+["'(]?[A-Z0-9]/.test(l)) return 'it holds more than one sentence';
  const words = l.split(/\s+/).filter((w) => w.length > 0).length;
  if (words > PROSE_WORDS) return `it runs ${words} words (a label is at most ${PROSE_WORDS})`;
  return null;
}

export function parseOutline(content: string, maxItems: number = MAX_ITEMS, what: string = 'the outline'): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(SPLITLINES)) {
    const why = raw.trim() ? proseLine(stripChars(raw, STRIP)) : null;
    if (why !== null) {
      throw new ChapteringError(
        'outline_prose',
        `${what} was answered in prose, not as a list of labels: the line ${JSON.stringify(raw.trim().slice(0, 160))} ` +
          `is not a label (${why}). Nothing is read from a prose outline under a guessed rule (Law 1).`,
      );
    }
    let l = stripChars(raw, STRIP);
    l = l.replace(/^\d+[.)]\s*/, '').replace(/\*\*/g, '');
    l = clip(stripChars(l, STRIP), MAX_LABEL_CHARS);
    const key = l.toLowerCase();
    if (l && !seen.has(key)) {
      items.push(l);
      seen.add(key);
    }
  }
  const capped = items.slice(0, maxItems);
  if (capped.length === 0) {
    throw new ChapteringError('outline_empty', `the outline came back with no usable item: ${JSON.stringify(content.slice(0, 300))}`);
  }
  return capped;
}

/**
 * One outline call on the 'outline' role (the routed scorer model), thinking off, temperature
 * 0, and the answer parsed. A truncated answer (`length`) is refused: an outline cut off
 * mid-list would silently drop the sections at the end of the video.
 */
export async function writeOutline(chat: ChatFn, prompt: string, what: string, signal?: AbortSignal): Promise<string[]> {
  const result = await chat(prompt, { role: 'outline', maxTokens: OUTLINE_MAX_TOKENS, thinking: false, temperature: 0, what, signal });
  if (result.finishReason === 'length') {
    throw new ChapteringError('truncated', `${what}: the outline hit its ${OUTLINE_MAX_TOKENS}-token cap, so the list is cut off`);
  }
  return parseOutline(result.text, MAX_ITEMS, what);
}
