/**
 * THE SPELLING SEED FROM A LINKED EDITOR STORY (LEDGER #281). Owen, 2026-10-09: "find the proper
 * nouns and unusual words from the original story, and feed them into the prompt for it. the
 * 1.7b gets proper nouns right more often. it could help the 0.6b get it right."
 *
 * A video linked to an editor story (its TranscriptRef) has a second transcript already: the
 * story's words, made in the editor by the 1.7B. The metadata run transcribes the final export
 * again (on the 0.6B by default), and this file takes from the story the terms worth spelling for
 * it: the proper nouns and the unusual words. asr-context.ts puts them right after the title.
 *
 * THE RULES, each one a choice:
 *
 *  - PROPER NOUNS are entity-extraction.ts `extractProperNouns`, the repo's one capitalized-run
 *    extractor: multi-word runs kept whole ("Jim Bakker", "PTL Club", "Church of the Nazarene"),
 *    ordinary words never glued on ("So Jim Bakker" is Jim Bakker), possessives cut. A ONE-word
 *    mention whose every occurrence opened a sentence is dropped: its capital is explained by
 *    position ("Ministries" opening a sentence says nothing). A shorter mention inside a longer
 *    one ("Bakker" inside "Jim Bakker", even opening a sentence) folds into it, and its count
 *    with it. Fillers are trimmed off a run's ends ("Uh, Tammy Faye" is Tammy Faye).
 *  - UNUSUAL WORDS are lowercase words of four letters or more that are not in COMMON_ENGLISH
 *    (common-english.ts, the 30,000 most frequent words), judged with their plain inflections
 *    taken off ("televangelists" is checked as "televangelist", "talked" as "talk"). A word with
 *    an apostrophe or a digit is a spoken form, never a spelling seed, and is left out.
 *  - FILLERS (um, uh, ...) are never terms. Punctuation is stripped; letters, digits, inner
 *    apostrophes, hyphens and an acronym's periods stay.
 *  - ONE TERM PER SPELLING, compared case-insensitively, the first spelling in the story kept.
 *  - RANKED BY HOW OFTEN THE STORY SAYS IT, most first (ties: first said first), so a context
 *    cut at the end drops the rarest. At most {@link MAX_VOCABULARY_TERMS}.
 *
 * PURE: words in, terms out. Nothing here is model-facing wording (Law 2): the label is
 * `shared/pipeline/transcription.yml` `labels.vocabulary`.
 */

import { COMMON_WORDS, extractProperNouns } from '../metadata/entity-extraction';
import { COMMON_ENGLISH } from './common-english';

/** The most terms one story contributes. The context budget usually cuts well before this. */
export const MAX_VOCABULARY_TERMS = 150;
/** A lowercase word shorter than this is never unusual enough to seed a spelling. */
const MIN_RARE_LETTERS = 4;

/** Filler sounds, which are never a term (the transcript keeps them; the seed does not need them). */
const FILLERS = new Set(['um', 'umm', 'uh', 'uhh', 'uhm', 'ah', 'ahh', 'er', 'erm', 'hm', 'hmm', 'mm', 'mmm', 'mhm', 'uh-huh', 'huh', 'eh', 'oh']);

/** One word of a story transcript, as transcript-import.service.ts parses it (only the text is read). */
export interface StoryWord {
  readonly text: string;
}

/** The story's words as running text, joined the way the import path joins them (no space before punctuation). */
export function storyText(words: readonly StoryWord[]): string {
  return words
    .map((w) => (typeof w?.text === 'string' ? w.text.trim() : ''))
    .filter((t) => t !== '')
    .join(' ')
    .replace(/\s+([,.!?;:…])/g, '$1')
    .replace(/\s+/g, ' ')
    .trim();
}

/** A term with its punctuation stripped (inner apostrophes, hyphens and an acronym's periods kept). */
function clean(term: string): string {
  return term
    .replace(/[^\p{L}\p{N}\s'’.-]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^[.'’-]+/, '')
    .replace(/(?<![A-Z])\.+$/, '')
    .replace(/[-'’]+$/, '')
    .trim();
}

/** A mention with filler words trimmed off both ends ("Uh Tammy Faye" is Tammy Faye); '' when only fillers. */
function withoutFillers(term: string): string {
  const words = term.split(' ');
  while (words.length > 0 && FILLERS.has(words[0].toLowerCase())) words.shift();
  while (words.length > 0 && FILLERS.has(words[words.length - 1].toLowerCase())) words.pop();
  return words.join(' ');
}

/** Is `word` (lowercase) a common word, as written or with a plain inflection taken off? */
function isCommon(word: string): boolean {
  if (COMMON_ENGLISH.has(word) || COMMON_WORDS.has(word)) return true;
  const stems: string[] = [];
  const cut = (suffix: string, add = ''): void => {
    if (word.length > suffix.length + 1 && word.endsWith(suffix)) stems.push(word.slice(0, -suffix.length) + add);
  };
  cut('s'); cut('es'); cut('ies', 'y'); cut('ed'); cut('d'); cut('ied', 'y'); cut('ing'); cut('ing', 'e');
  cut('ly'); cut('er'); cut('ers'); cut('est'); cut('ness'); cut('ment'); cut('ments');
  // A doubled consonant before -ed / -ing ("stopped", "running").
  for (const suffix of ['ed', 'ing']) {
    if (word.endsWith(suffix)) {
      const stem = word.slice(0, -suffix.length);
      if (stem.length > 2 && stem[stem.length - 1] === stem[stem.length - 2]) stems.push(stem.slice(0, -1));
    }
  }
  return stems.some((s) => COMMON_ENGLISH.has(s) || COMMON_WORDS.has(s));
}

/** Does `haystack` contain `needle` as whole words (case-insensitive)? */
function containsWords(haystack: string, needle: string): boolean {
  const h = ` ${haystack.toLowerCase()} `;
  return h.includes(` ${needle.toLowerCase()} `);
}

/** Where `term` is first said in `text` (case-insensitive, whole words); the end when never found. */
function firstAt(text: string, term: string): number {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const match = new RegExp(`(?<![\\p{L}\\p{N}])${escaped}(?![\\p{L}\\p{N}])`, 'iu').exec(text);
  return match === null ? text.length : match.index;
}

interface Term {
  text: string;
  count: number;
  at: number;
}

/**
 * The story's spelling seed: its proper nouns and unusual words, most-said first. Empty when the
 * story has none (the context then carries no vocabulary field).
 */
export function storyVocabulary(words: readonly StoryWord[]): string[] {
  const text = storyText(words);
  if (text === '') return [];

  // ── Proper nouns, folded longest first so "Bakker" counts toward "Jim Bakker". ──
  // Folded BEFORE the sentence-initial rule: "Bakker said ..." opening a sentence is still a
  // mention of Jim Bakker and counts toward him; only a one-word mention left on its own is dropped.
  const folded: (Term & { initialOnly: boolean })[] = [];
  const mentions = extractProperNouns(text)
    .map((m) => ({ ...m, text: withoutFillers(clean(m.text)) }))
    .filter((m) => m.text !== '')
    .sort((a, b) => b.text.length - a.text.length);
  for (const mention of mentions) {
    const container = folded.find((p) => containsWords(p.text, mention.text));
    if (container) {
      container.count += mention.count;
      continue;
    }
    folded.push({ text: mention.text, count: mention.count, at: firstAt(text, mention.text), initialOnly: mention.sentenceInitialOnly });
  }
  const proper: Term[] = folded
    .filter((p) => !(p.initialOnly && p.text.split(' ').length === 1))
    .map(({ text: t, count, at }) => ({ text: t, count, at }));

  // ── Unusual lowercase words, counted where they are said. ──
  const rare = new Map<string, Term>();
  const tokens = /[\p{L}\p{N}][\p{L}\p{N}'’-]*/gu;
  for (let match = tokens.exec(text); match !== null; match = tokens.exec(text)) {
    const word = match[0].replace(/[-'’]+$/, '');
    if (!/^[a-z][a-z-]*$/.test(word)) continue;
    if (word.replace(/-/g, '').length < MIN_RARE_LETTERS || FILLERS.has(word)) continue;
    if (word.split('-').every((part) => part === '' || isCommon(part))) continue;
    const held = rare.get(word);
    if (held) held.count += 1;
    else rare.set(word, { text: word, count: 1, at: match.index });
  }

  // ── One term per spelling, the first spelling in the story kept, most said first. ──
  const byKey = new Map<string, Term>();
  for (const term of [...proper, ...rare.values()]) {
    const key = term.text.toLowerCase();
    const held = byKey.get(key);
    if (held === undefined) {
      byKey.set(key, { ...term });
    } else {
      held.count += term.count;
      if (term.at < held.at) {
        held.at = term.at;
        held.text = term.text;
      }
    }
  }
  return [...byKey.values()]
    .sort((a, b) => b.count - a.count || a.at - b.at)
    .slice(0, MAX_VOCABULARY_TERMS)
    .map((t) => t.text);
}
