/**
 * Tags and hashtags — code-owned, no model call
 *
 * The metadata spec's ruling (§2 ownership table, §4, §6.2, §6.3 of
 * /Volumes/Callisto/Projects/Briefcase/docs/youtube-metadata-spec.md): both of these are
 * assembled by code from the entity and key-phrase pools, and neither is ever emitted by a
 * model. Two reasons, and the second is the one that decided it.
 *
 *  1. They are rules, not judgment. "Most specific first, entity names before key phrases,
 *     stop at ~400 characters, never truncate mid-tag" is a sort and a budget. A model asked
 *     to do that does it approximately and costs a call.
 *  2. YouTube reads a tag that is not in the content as a SPAM SIGNAL (§6.2). A model writing
 *     tags from a summary will occasionally write a plausible one the video never mentions,
 *     and nothing downstream can tell that tag from a real one. Every tag this file emits came
 *     out of the content text, and `occursIn` is the test.
 *
 * WHAT THIS FILE DOES NOT OWN: the channel and creator tags. Those are appended by
 * AIManagerService.appendChannelTags from the prompt set's `channel_tags`, after this list is
 * assembled, and that machinery already handles YouTube's 500-character budget including the
 * two-character cost of a quoted multi-word tag. This file's ~400-character cap is the spec's
 * budget for the GENERATED portion, deliberately under the hard limit so the channel tags
 * still fit.
 *
 * PURE. No I/O, no model, no config.
 */

import { occursIn } from './entity-extraction';

/** Spec §4: stop adding at ~400 characters so the channel tags still fit under YouTube's 500. */
export const GENERATED_TAG_BUDGET_CHARS = 400;

/** How far down the key-phrase ranking a tag may come from. See assembleTags. */
const KEY_PHRASE_TAG_LIMIT = 12;

export interface TagInputs {
  /**
   * The single most specific phrase for what this video is, first in the list. Usually the
   * top-ranked key phrase; the video title's own subject when there is a better one.
   */
  primaryPhrase: string;
  /** Entity surfaces, people first, in the order they should be offered. */
  entities: string[];
  /** Ranked key phrases. */
  keyPhrases: string[];
  /** One or two broad category terms for the channel's beat. */
  categories: string[];
  /**
   * The text every tag must occur in (spec §6.2). This is the app's CONTENT text —
   * `contentTextOf(item)`, the ad-free editor transcript when one is linked and the final
   * export's otherwise.
   */
  contentText: string;
}

export interface TagAssembly {
  tags: string[];
  /** Characters the joined list costs, against GENERATED_TAG_BUDGET_CHARS. */
  cost: number;
  /** Candidates left out because the budget ran out, in the order they were offered. */
  dropped: string[];
  /** Candidates left out because the content text does not contain them. */
  notInContent: string[];
}

/**
 * Spec §4's order, applied: exact primary phrase, entity names (people first), key phrases,
 * deliberate misspellings of distinctive names, 1-2 broad category terms.
 *
 * Two filters run over that order:
 *
 *  - NOT IN THE CONTENT — dropped and recorded. The one exception is a misspelling, which
 *    exists precisely because it is NOT in the content: it is the spelling a searcher types,
 *    and it is derived mechanically from a name that IS in the content.
 *  - SINGLE GENERIC WORD — dropped. §6.2 names "news" and "politics" alone as the shape to
 *    skip; a one-word tag is only worth a slot when it is a name.
 *
 * The budget STOPS rather than truncates. A tag cut in half is a tag for something else.
 */
export function assembleTags(inputs: TagInputs): TagAssembly {
  const offered: Array<{ tag: string; requiresContent: boolean }> = [];
  const push = (tag: string, requiresContent = true) => {
    const cleaned = cleanTag(tag);
    if (cleaned.length === 0) return;
    offered.push({ tag: cleaned, requiresContent });
  };

  push(inputs.primaryPhrase);
  for (const entity of inputs.entities) push(entity);
  // Key phrases earn a tag slot only when they are PHRASES, and only the best of them.
  //
  // One-word key phrases are bare frequent words — a real run offered "believes", "saying" and
  // "heard" — and §6.2's rule is to skip single generic words; a single word that IS a name
  // reaches the list through the entity pool above, which is where names live.
  //
  // The LIMIT is the other half of the same lesson. The character budget is big enough to hold
  // rank-30 candidates, and rank 30 on a spoken transcript is "book titled" and "lies told".
  // §6.2 is explicit that tags are generated because they are free, never at the price of
  // quality, so the budget is allowed to go unspent rather than be filled with noise.
  for (const phrase of inputs.keyPhrases.slice(0, KEY_PHRASE_TAG_LIMIT)) {
    if (phrase.trim().includes(' ')) push(phrase);
  }
  // Misspellings are the one class that is deliberately absent from the content (§4, §6.2):
  // they catch the search, not the transcript.
  for (const misspelling of misspellingsFor(inputs.entities)) push(misspelling, false);
  for (const category of inputs.categories) push(category);

  const tags: string[] = [];
  const dropped: string[] = [];
  const notInContent: string[] = [];
  const seen = new Set<string>();

  for (const candidate of offered) {
    const key = candidate.tag.toLowerCase();
    if (seen.has(key)) continue;
    if (isGenericSingleWord(candidate.tag)) continue;
    if (candidate.requiresContent && !occursIn(inputs.contentText, candidate.tag)) {
      notInContent.push(candidate.tag);
      continue;
    }
    const next = [...tags, candidate.tag];
    if (joinedCost(next) > GENERATED_TAG_BUDGET_CHARS) {
      dropped.push(candidate.tag);
      continue;
    }
    seen.add(key);
    tags.push(candidate.tag);
  }

  return { tags, cost: joinedCost(tags), dropped, notInContent };
}

function joinedCost(tags: string[]): number {
  return tags.join(',').length;
}

/**
 * A tag as it should be published.
 *
 * The APOSTROPHE SURVIVES, and that is the point of this being its own function: stripping it
 * turned "nazi germany god's" into "nazi germany gods", which the in-content test then correctly
 * reported as a phrase the video never says — a real tag lost to its own cleaning step.
 */
function cleanTag(value: string): string {
  return value.replace(/[#"]/g, '').replace(/\s+/g, ' ').trim();
}

/**
 * Single words that are too broad to be worth a tag slot on their own (§6.2).
 *
 * A single word that is a NAME is fine — "Roswell" is a tag. The test is therefore not "one
 * word" but "one word from the small set of category words a million videos share".
 */
const GENERIC_SINGLE_WORDS = new Set([
  'news', 'politics', 'political', 'religion', 'religious', 'christian', 'church', 'video',
  'commentary', 'reaction', 'discussion', 'analysis', 'update', 'live', 'stream', 'podcast',
  'america', 'american', 'people', 'money', 'government', 'today', 'truth', 'story',
]);

function isGenericSingleWord(tag: string): boolean {
  return !tag.includes(' ') && GENERIC_SINGLE_WORDS.has(tag.toLowerCase());
}

/**
 * Deliberate misspellings, from a small static rules table (spec §4: "a static rules table"
 * — explicitly NOT a model call, because tags are marginal and a call is not).
 *
 * The rules are the mistakes a listener makes typing a name they have only HEARD, which is
 * the whole use YouTube's own documentation still endorses for tags:
 *   - a doubled consonant flattened, or a single one doubled ("Bailey" / "Bailley")
 *   - "ph" heard as "f"
 *   - a trailing "-son" / "-sen" swap
 *   - initials run together ("D.L. Moody" -> "DL Moody")
 *
 * Applied only to MULTI-WORD names, i.e. the ones a person is called by, and capped so the
 * misspelling block never crowds out the real phrases.
 */
export function misspellingsFor(entities: string[], limit = 2): string[] {
  const out: string[] = [];
  for (const entity of entities) {
    if (out.length >= limit) break;
    if (!entity.includes(' ') && !/[.]/.test(entity)) continue;

    const flattened = entity.replace(/([bcdfglmnprstz])\1/gi, '$1');
    if (flattened !== entity) {
      out.push(flattened);
      continue;
    }
    const noDots = entity.replace(/\./g, '');
    if (noDots !== entity) {
      out.push(noDots.replace(/\s+/g, ' ').trim());
      continue;
    }
    const phToF = entity.replace(/ph/gi, 'f');
    if (phToF !== entity) {
      out.push(phToF);
      continue;
    }
    const sonSen = /son\b/i.test(entity)
      ? entity.replace(/son\b/i, 'sen')
      : /sen\b/i.test(entity)
        ? entity.replace(/sen\b/i, 'son')
        : entity;
    if (sonSen !== entity) out.push(sonSen);
  }
  return out.slice(0, limit);
}

// ---------------------------------------------------------------------------
// Hashtags
// ---------------------------------------------------------------------------

export interface HashtagInputs {
  /** Entity surfaces, headline entity first. */
  entities: string[];
  /** Ranked key phrases. */
  keyPhrases: string[];
  /** The chosen video title, or the working title — hashtags are deduped against its words. */
  title: string;
  /** The channel's brand tag, when the prompt set declares one. Optional and never invented. */
  brandTag?: string;
}

/**
 * Spec §6.3: 3-5 hashtags, 1-2 entity + 1-2 topic + the channel brand tag when there is one,
 * deduped against words already in the title, camel-cased when multiword.
 *
 * The title dedupe is the rule with the most bite: a hashtag repeating a word the title
 * already carries adds nothing to what the viewer sees, so it costs one of at most five
 * slots for no gain.
 *
 * Under three available hashtags this returns what it has. It is not an error and not padded:
 * three is where YouTube's above-the-title display stops mattering, and inventing a third from
 * nothing would be inventing a topic.
 */
export function buildHashtags(inputs: HashtagInputs): string[] {
  const titleWords = new Set(
    inputs.title
      .toLowerCase()
      .replace(/[^a-z0-9\s]/g, ' ')
      .split(/\s+/)
      .filter((w) => w.length > 3)
  );

  const chosen: string[] = [];
  const seen = new Set<string>();

  const offer = (source: string): boolean => {
    // A hashtag is READ, in one glance, above the title. Four words camel-cased into one
    // string is not read, it is decoded — a real run produced "#GodAndRyanWalters" and
    // "#ISorryNoIM" before this bound existed.
    const wordCount = source.trim().split(/\s+/).filter(Boolean).length;
    if (wordCount > 3) return false;
    const tag = camelCaseHashtag(source);
    if (tag.length <= 1 || tag.length > 30) return false;
    const key = tag.toLowerCase();
    if (seen.has(key)) return false;
    // Deduped against the TITLE's words: a hashtag whose every significant word is already
    // in the title is repeating what the viewer can see.
    const words = source.toLowerCase().replace(/[^a-z0-9\s]/g, ' ').split(/\s+/).filter((w) => w.length > 3);
    if (words.length > 0 && words.every((w) => titleWords.has(w))) return false;
    seen.add(key);
    chosen.push(`#${tag}`);
    return true;
  };

  let entityCount = 0;
  for (const entity of inputs.entities) {
    if (entityCount >= 2) break;
    if (offer(entity)) entityCount++;
  }

  let topicCount = 0;
  for (const phrase of inputs.keyPhrases) {
    if (topicCount >= 2) break;
    if (offer(phrase)) topicCount++;
  }

  if (inputs.brandTag) offer(inputs.brandTag);

  // Still short of three? Take more topics before giving up — the entity/topic mix is a
  // preference, and three hashtags is what actually displays.
  for (const phrase of inputs.keyPhrases) {
    if (chosen.length >= 3) break;
    offer(phrase);
  }

  return chosen.slice(0, 5);
}

/** "christian nationalist action" -> "ChristianNationalistAction". */
export function camelCaseHashtag(value: string): string {
  return value
    // The possessive goes BEFORE the punctuation strip, or "nazi germany god's" camel-cases to
    // "NaziGermanyGodS" — a trailing capital S nobody typed.
    .replace(/['’]s\b/g, '')
    .replace(/[^A-Za-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join('');
}

/** The hashtags field's stored shape: one space-separated line, as the .txt writer expects. */
export function hashtagLine(hashtags: string[]): string {
  return hashtags.join(' ');
}
