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

export function parseOutline(content: string, maxItems: number = MAX_ITEMS): string[] {
  const items: string[] = [];
  const seen = new Set<string>();
  for (const raw of content.split(SPLITLINES)) {
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
  return parseOutline(result.text);
}
