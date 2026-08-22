/**
 * Entity extraction — proper nouns out of a transcript, in code, with no model
 *
 * WHY CODE AND NOT A MODEL. The metadata spec
 * (/Volumes/Callisto/Projects/Briefcase/docs/youtube-metadata-spec.md, §2 and §6.1 lever 3)
 * wants an entity list for two different consumers: the chapter summarizer, which is told
 * to build its title around the specific people and claims actually present in ITS chapter,
 * and the description/tags layer, which needs the names a searcher would type. Both want the
 * same property — that the list is a MEASUREMENT of the transcript rather than a model's
 * recollection of it. A deterministic extractor cannot hallucinate a name, which is exactly
 * what makes it usable as the grounding reference for the model that can.
 *
 * The spec's table names a BERT-class NER model for this. This is deliberately not that: no
 * new 100M-parameter dependency, no second model to install and keep resident, and the
 * grounding rule downstream only needs "did this string occur in the transcript", which is
 * a question about the text and not about the world. What it costs is precision — this
 * extractor cannot tell a person from a place from the first word of a sentence, and does
 * not try to. It ranks capitalized sequences by how often they occur.
 *
 * WHAT IT ASSUMES ABOUT CASING, which is the one assumption that can invalidate it: Whisper
 * transcripts are punctuated and cased. `transcriptCasing` measures that rather than trusting
 * it, and callers are expected to record what it says — on an uncased transcript this
 * extractor returns nothing useful, and returning nothing is the honest answer, not a reason
 * to lower the bar to "any frequent word".
 *
 * PURE. No I/O, no model, no config. Every function here is testable from a string.
 */

/** One extracted proper-noun surface form and how often the text used it. */
export interface EntityMention {
  /** The surface as it appeared, e.g. "Gene Bailey", "Luke 19:13". */
  text: string;
  /** Occurrences in the slice this was extracted from. */
  count: number;
  /**
   * True when EVERY occurrence was sentence-initial, so its capitalization is explained by
   * position alone and says nothing about whether it is a name. Kept rather than dropped:
   * "Jesus wept" opens plenty of sentences and is still the entity of the chapter.
   */
  sentenceInitialOnly: boolean;
}

/**
 * Words that are capitalized for reasons other than being a name, which a
 * capitalized-sequence extractor would otherwise return as entities.
 *
 * Two kinds live here and they are not the same kind:
 *
 *  - FUNCTION WORDS that appear INSIDE real multi-word names ("of", "the", "and"): they are
 *    allowed inside a sequence but never start or end one, so "Church of the Nazarene"
 *    survives whole while "The" alone does not.
 *  - SENTENCE OPENERS. English capitalizes the first word of a sentence, so the single most
 *    common "entity" in any transcript is whatever word the speaker starts sentences with.
 *    These are dropped when they stand alone; they are NOT dropped from inside a longer
 *    sequence, because "So" in "So Paul Petit says" is the opener and "Paul Petit" is the
 *    name, and the sequence logic already separates them.
 */
const INNER_FUNCTION_WORDS = new Set([
  'of', 'the', 'de', 'la', 'le', 'von', 'van', 'del', 'da', 'bin', 'al',
]);
// DELIBERATELY SHORT, and each omission was measured on a real 67-minute transcript:
//  - "and" joined two separate entities far more often than it appeared inside one, producing
//    "God and Ryan Walters" as a single name. A conjunction between two capitalized words is
//    two names.
//  - "in", "on", "at", "to", "for" did the same across a clause: "Audible in Amazon",
//    "Hitler in Atheist". Only "of" and "the" genuinely appear inside names at any rate
//    ("Church of the Nazarene", "Statue of Liberty"), so only those two survive.

/**
 * Common English words that are frequently sentence-initial or otherwise capitalized without
 * being names. Deliberately a SHORT list of high-frequency words — a long one starts deleting
 * real names ("Christian", "Bishop", "Bible" are all names of things this channel covers).
 */
export const COMMON_WORDS = new Set([
  'a', 'about', 'after', 'again', 'all', 'also', 'although', 'always', 'am', 'an', 'and', 'another',
  'any', 'anyway', 'are', 'as', 'at', 'back', 'because', 'been', 'before', 'being', 'both', 'but',
  'by', 'can', 'come', 'could', 'did', 'do', 'does', 'down', 'each', 'even', 'ever', 'every',
  'first', 'for', 'from', 'get', 'go', 'going', 'good', 'got', 'had', 'has', 'have', 'he', 'her',
  'here', 'hey', 'him', 'his', 'how', 'however', 'i', 'if', 'in', 'into', 'is', 'it', 'its', 'just',
  'know', 'let', 'like', 'look', 'made', 'make', 'many', 'maybe', 'me', 'more', 'most', 'much',
  'must', 'my', 'never', 'new', 'no', 'not', 'now', 'of', 'off', 'oh', 'ok', 'okay', 'on', 'once',
  'one', 'only', 'or', 'other', 'our', 'out', 'over', 'people', 'right', 'said', 'same', 'say',
  'says', 'see', 'she', 'should', 'since', 'so', 'some', 'something', 'still', 'such', 'sure',
  'take', 'than', 'that', 'the', 'their', 'them', 'then', 'there', 'these', 'they', 'thing',
  'things', 'think', 'this', 'those', 'though', 'thought', 'through', 'time', 'to', 'today', 'too',
  'two', 'under', 'until', 'up', 'us', 'very', 'want', 'was', 'way', 'we', 'well', 'went', 'were',
  'what', 'when', 'where', 'which', 'while', 'who', 'why', 'will', 'with', 'would', 'yeah', 'yes',
  'yet', 'you', 'your',
  // Common nouns that open sentences and headlines constantly and are never names. Without
  // them "Man yells about conspiracies" scores as a title with an entity in it, which is the
  // exact sentence the spec uses as its example of a GENERIC title.
  'man', 'men', 'woman', 'women', 'guy', 'guys', 'kid', 'kids', 'boy', 'boys', 'girl', 'girls',
  'everyone', 'everybody', 'nobody', 'somebody', 'someone', 'anyone', 'anybody', 'life',
  'world', 'part', 'lot', 'bit', 'day', 'days', 'night', 'year', 'years', 'week', 'month',
  'place', 'work', 'name', 'question', 'answer', 'point', 'reason', 'problem', 'guys',
  // Spoken filler and speech verbs. A transcript is full of them, they open sentences, and as
  // key phrases they are pure noise — a real run offered "believes", "saying", "heard",
  // "wrote", "listen" and "happening" as candidate tags for a video about televangelists.
  'whenever', 'wherever', 'whoever', 'sorry', 'anyway', 'alright', 'please', 'thanks', 'welcome',
  'actually', 'basically', 'honestly', 'literally', 'obviously', 'really', 'seriously',
  'everything', 'nothing', 'anything', 'believe', 'believes', 'saying', 'heard', 'hear',
  'wrote', 'writing', 'happening', 'happen', 'happens', 'quote', 'listen', 'gonna', 'wanna',
]);

/** A token that could be part of a proper noun: capitalized, or a capitalized-and-punctuated form. */
const CAPITALIZED = /^[A-Z][\w'’.-]*$/;

/**
 * Is this token an ordinary English word wearing a capital letter?
 *
 * Cut at the apostrophe, so a CONTRACTION is judged by its stem: "You're" and "I'm" open
 * sentences constantly and were reaching the entity list as the name "You're I'm". A possessive
 * is cut by the same rule and judged on the noun, which is what it is.
 */
function isOrdinaryWord(token: string): boolean {
  return COMMON_WORDS.has(token.toLowerCase().replace(/['’].*$/, '').replace(/[^a-z]/g, ''));
}

/**
 * How cased a piece of text actually is.
 *
 * Reported rather than assumed. A transcript with no capitalization at all makes every
 * function in this file return nothing, and a caller that treats "no entities" as "this
 * chapter has no names" would be wrong about the transcript rather than about the chapter.
 */
export interface CasingReport {
  /** Words that start with an uppercase letter, over all alphabetic words. */
  capitalizedRatio: number;
  /** Sentence-ending punctuation marks per 100 words. Zero means an unpunctuated stream. */
  terminatorsPer100Words: number;
  /**
   * True when the text carries both capitalization and sentence punctuation in the
   * proportions ordinary written English does, i.e. proper-noun extraction can work on it.
   */
  usable: boolean;
  /** Why not, when `usable` is false. Empty when it is. */
  reason: string;
}

/**
 * Measure a transcript's casing.
 *
 * The thresholds: ordinary English capitalizes roughly 5-15% of words (sentence openers plus
 * names) and ends a sentence every 10-25 words. Below 2% capitalized there is nothing to
 * extract; above 60% the text is a headline, an all-caps stretch or a speaker-tagged dump
 * whose capitalization means something else. Both are stated as the reason.
 */
export function transcriptCasing(text: string): CasingReport {
  const words = text.match(/[A-Za-z][A-Za-z'’-]*/g) || [];
  if (words.length === 0) {
    return { capitalizedRatio: 0, terminatorsPer100Words: 0, usable: false, reason: 'there are no words in it' };
  }
  const capitalized = words.filter((w) => /^[A-Z]/.test(w)).length;
  const terminators = (text.match(/[.!?]/g) || []).length;
  const capitalizedRatio = capitalized / words.length;
  const terminatorsPer100Words = (terminators / words.length) * 100;

  if (capitalizedRatio < 0.02) {
    return {
      capitalizedRatio,
      terminatorsPer100Words,
      usable: false,
      reason:
        `only ${(capitalizedRatio * 100).toFixed(1)}% of its words are capitalized, so it is an ` +
        `uncased transcript and proper nouns cannot be told from ordinary words`,
    };
  }
  if (capitalizedRatio > 0.6) {
    return {
      capitalizedRatio,
      terminatorsPer100Words,
      usable: false,
      reason:
        `${(capitalizedRatio * 100).toFixed(0)}% of its words are capitalized, which is not sentence ` +
        `casing — capitalization carries no name signal in it`,
    };
  }
  return { capitalizedRatio, terminatorsPer100Words, usable: true, reason: '' };
}

/**
 * Every capitalized sequence in the text, ranked by frequency then by length.
 *
 * The sequence rule: a run of capitalized tokens, optionally joined by the small function
 * words that appear inside real names, bounded by a capitalized token at each end. That is
 * what keeps "Church of the Nazarene" and "D.L. Moody" whole while splitting "Anyway Paul
 * Petit" into the opener and the name.
 *
 * SENTENCE-INITIAL AMBIGUITY. A capitalized word at the start of a sentence is capitalized
 * for two possible reasons and the text does not say which. Handled by recording the fact
 * (`sentenceInitialOnly`) rather than by guessing: a single-word candidate whose every
 * occurrence was sentence-initial AND which is a common English word is dropped, because
 * position explains it; one that also occurs mid-sentence somewhere is kept, because
 * position does not. Multi-word sequences are kept either way — "Gene Bailey" opening a
 * sentence is still Gene Bailey.
 */
export function extractProperNouns(text: string): EntityMention[] {
  if (!text || text.trim().length === 0) return [];

  const found = new Map<string, { text: string; count: number; midSentence: number }>();

  // Split into sentences first so "first token of a sentence" is a fact rather than a guess.
  for (const sentence of splitSentences(text)) {
    const tokens = sentence.match(/[A-Za-z0-9][\w'’.-]*/g) || [];
    let i = 0;
    while (i < tokens.length) {
      // A capitalized ORDINARY word is not part of a name and does not glue the next one to
      // itself. Measured on a real transcript: without this the extractor returned "Whenever
      // Trump", "Okay Jesus Christ" and "I-- Sorry. No I'm" as entities, because a spoken
      // transcript starts sentences with words like these constantly and the name follows.
      if (!CAPITALIZED.test(tokens[i]) || isOrdinaryWord(tokens[i])) {
        i++;
        continue;
      }
      const startedSentence = i === 0;
      const sequence: string[] = [tokens[i]];
      let j = i + 1;
      while (j < tokens.length) {
        const token = tokens[j];
        if (CAPITALIZED.test(token) && !isOrdinaryWord(token)) {
          sequence.push(token);
          j++;
          continue;
        }
        // A function word only continues a sequence when a capitalized token follows it.
        if (INNER_FUNCTION_WORDS.has(token.toLowerCase()) && j + 1 < tokens.length && CAPITALIZED.test(tokens[j + 1])) {
          sequence.push(token);
          j++;
          continue;
        }
        break;
      }
      // Trim any trailing function word: "Paul of" is not a name.
      while (sequence.length > 0 && INNER_FUNCTION_WORDS.has(sequence[sequence.length - 1].toLowerCase())) {
        sequence.pop();
      }

      if (sequence.length > 0) {
        // The possessive belongs to the sentence, not to the name: "Gene Bailey's" is Gene
        // Bailey said one way, and keeping both spellings would be two entities for one person.
        const surface = sequence.join(' ').replace(/[.,;:!?]+$/, '').replace(/['’]s$/, '');
        const key = surface.toLowerCase();
        const held = found.get(key) || { text: surface, count: 0, midSentence: 0 };
        held.count++;
        // A sequence that starts at token 0 is sentence-initial; anywhere else is not.
        if (!startedSentence) held.midSentence++;
        found.set(key, held);
      }
      i = Math.max(j, i + 1);
    }
  }

  const mentions: EntityMention[] = [];
  for (const held of found.values()) {
    const words = held.text.split(/\s+/);
    const sentenceInitialOnly = held.midSentence === 0;
    if (words.length === 1) {
      const lower = held.text.toLowerCase().replace(/[^a-z']/g, '');
      // Position explains it and it is an ordinary word: not an entity.
      if (COMMON_WORDS.has(lower)) continue;
      // A single capitalized letter or a bare number is not a name.
      if (held.text.replace(/[^A-Za-z]/g, '').length < 2) continue;
    }
    mentions.push({ text: held.text, count: held.count, sentenceInitialOnly });
  }

  return mentions.sort((a, b) => b.count - a.count || b.text.length - a.text.length || a.text.localeCompare(b.text));
}

/**
 * The top N entity surfaces, with sub-names folded into the longer name that contains them.
 *
 * "Gene", "Bailey" and "Gene Bailey" are one entity said three ways, and a list that spends
 * three of its slots on them is a list that names one person. The longest surface wins and
 * its count absorbs the shorter ones, which is also what makes the count a usable ranking:
 * a person referred to by first name for a whole chapter ranks by how often they came up,
 * not by how often their full name was said.
 */
export function topEntities(text: string, limit: number): string[] {
  const mentions = extractProperNouns(text);
  const kept: Array<{ text: string; count: number }> = [];

  for (const mention of mentions.slice().sort((a, b) => b.text.length - a.text.length)) {
    const container = kept.find((k) => containsPhrase(k.text, mention.text));
    if (container) {
      container.count += mention.count;
      continue;
    }
    kept.push({ text: mention.text, count: mention.count });
  }

  return kept
    .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
    .slice(0, limit)
    .map((k) => k.text);
}

/** Is `needle` a whole-word subsequence of `haystack`? ("Bailey" is inside "Gene Bailey".) */
function containsPhrase(haystack: string, needle: string): boolean {
  if (haystack.toLowerCase() === needle.toLowerCase()) return true;
  const words = haystack.toLowerCase().split(/\s+/);
  const parts = needle.toLowerCase().split(/\s+/);
  for (let i = 0; i + parts.length <= words.length; i++) {
    if (parts.every((p, k) => words[i + k] === p)) return true;
  }
  return false;
}

/**
 * Sentences, for the sentence-initial rule.
 *
 * Splits on terminal punctuation followed by whitespace. Newlines end a sentence too, so a
 * caption-per-line transcript that never punctuates still gets a sensible answer to "was
 * this word at the start". Abbreviations ("D.L. Moody") are not split because the split
 * requires whitespace AFTER the mark and a capital letter to follow — "D.L." keeps its own
 * sentence, which is the harmless direction.
 */
function splitSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+(?=[A-Z"'“])|\n+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Candidate noun phrases for embedding-based key phrase ranking (spec §2, KeyBERT-style).
 *
 * Candidates are 1-4 word runs of content words taken from the text with the stopwords
 * stripped out, lowercased and deduped. This is the CANDIDATE half only — the ranking half
 * is an embedding call and lives in key-phrases.ts, because that half needs a model and this
 * half must stay testable from a string.
 */
export function candidateKeyPhrases(text: string, options?: { maxWords?: number; minCount?: number }): string[] {
  const maxWords = options?.maxWords ?? 4;
  const minCount = options?.minCount ?? 2;
  const counts = new Map<string, { text: string; count: number }>();

  for (const sentence of splitSentences(text)) {
    const tokens = (sentence.match(/[A-Za-z][A-Za-z'’-]*/g) || []).map((t) => t.replace(/['’-]+$/, ''));
    let run: string[] = [];
    const flush = () => {
      for (let size = 1; size <= maxWords; size++) {
        for (let i = 0; i + size <= run.length; i++) {
          const phrase = run.slice(i, i + size);
          // A phrase that is one short word is noise; two-plus words always earn their slot.
          if (size === 1 && phrase[0].length < 5) continue;
          const surface = phrase.join(' ');
          const key = surface.toLowerCase();
          const held = counts.get(key) || { text: surface.toLowerCase(), count: 0 };
          held.count++;
          counts.set(key, held);
        }
      }
      run = [];
    };
    for (const token of tokens) {
      if (COMMON_WORDS.has(token.toLowerCase())) {
        flush();
        continue;
      }
      run.push(token);
      if (run.length > maxWords * 2) flush();
    }
    flush();
  }

  return Array.from(counts.values())
    .filter((c) => c.count >= minCount)
    .sort((a, b) => b.count - a.count || b.text.length - a.text.length)
    .map((c) => c.text);
}

/**
 * Does this phrase actually occur in this text?
 *
 * Whole-word, case- and punctuation-insensitive. It is the primitive under the chapter-title
 * grounding rule (§6.1 lever 3) and under the tags rule that nothing absent from the content
 * may be published as a tag (§6.2 — YouTube reads irrelevant tags as a spam signal).
 */
export function occursIn(text: string, phrase: string): boolean {
  const haystack = normalizeForMatch(text);
  const needle = normalizeForMatch(phrase);
  // Both sides already carry their own boundary spaces, which is what makes `includes` a
  // whole-word test. Adding another pair around the needle would look for a double space and
  // never match anything — the shape of this comparison is load-bearing.
  if (needle.trim().length === 0) return false;
  return haystack.includes(needle);
}

/**
 * ` lowercased words separated by single spaces `, with the possessive dropped.
 *
 * The possessive matters more than it looks: a title says "Gene Bailey's misreading" and the
 * transcript says "Gene Bailey", so a grounding check that kept the `'s` would report a
 * perfectly grounded name as invented on every possessive title — which is the target form the
 * prompt asks for.
 */
function normalizeForMatch(value: string): string {
  return ` ${value
    .toLowerCase()
    .replace(/['’]s\b/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()} `;
}
