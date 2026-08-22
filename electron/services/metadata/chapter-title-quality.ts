/**
 * Chapter-title quality — the two checks and the one metric, in code
 *
 * The bar the metadata spec sets for a chapter title (§6.1 of
 * /Volumes/Callisto/Projects/Briefcase/docs/youtube-metadata-spec.md) has TWO independent
 * dimensions, and a run can pass one while failing the other:
 *
 *  - SPECIFICITY. "Man yells about conspiracies" fails; "Kent Christmas's 2021 death-angel
 *    prophecy" passes. Measured as proper nouns per title and the share of titles with none.
 *  - REGISTER. "The speaker debunks Gene Bailey's misreading of Luke 19:13" is entity-rich
 *    and still wrong: its grammatical subject is an actor the transcript never identified.
 *    A real run produced exactly that, alongside "A YouTuber critiques ..." — which is why
 *    the check cannot be a search for the string "the speaker". Measured as the share of
 *    titles whose subject is a narrating actor.
 *
 * WHAT THIS FILE IS AND IS NOT. It is MEASUREMENT and a RE-ASK TRIGGER. It is not a filter
 * and not a rewriter: nothing here edits a title, and nothing here refuses to publish one.
 * A title that fails gets one more attempt from the model and, if the second answer fails
 * too, is kept exactly as the model wrote it with a declared warning on the run. That is the
 * operator's standing rule — deliver the output, the operator curates — and it is why
 * `narratesAnActor` returning true is called a signal in every caller rather than a verdict.
 *
 * WHAT MUST NEVER HAPPEN: none of the vocabulary below may appear in a PROMPT. The operator's
 * ruling (2026-08-22) is that a prompt states the wanted style positively and shows correct
 * examples only, because a model shown the wrong form reproduces it. These lists exist so
 * code can recognize the failure after the fact; the prompts in chapter-prompts.ts say what
 * good looks like and never mention what bad looks like.
 *
 * SCOPE. Viewer-facing text only: chapter titles, the description hook and the description
 * body. Per-chapter SUMMARIES are internal data feeding later calls, and the register that
 * is wrong in a title is not wrong there.
 *
 * PURE. No I/O, no model, no config.
 */

import { extractProperNouns, occursIn } from './entity-extraction';

/**
 * Nouns that stand in for whoever is talking.
 *
 * The failure this catches is a title whose SUBJECT is an actor the content never named. Two
 * families: pronouns and role nouns. Real names are deliberately absent — "Gene Bailey's
 * chapter on Christian nationalist action" is the target form, so a real person at subject
 * position is only a problem in the narration-verb pattern below.
 */
/**
 * The INVENTED-NARRATOR family: an actor that exists only because the writing needed a subject.
 *
 * These are the ones the operator objected to by name. Nothing on screen is "the speaker" — the
 * voice in any given second is either the creator or the footage he is reacting to, and the
 * transcript does not say which — so a title asserting one asserts something it cannot know.
 *
 * They are flagged EVEN IN POSSESSIVE FORM, which is the one place this list behaves differently
 * from the rest: "the speaker's book on Christian nationalism" is grammatically topic form and
 * still invents the speaker. A REAL name in the same shape ("Gene Bailey's use of Jabez") and a
 * concrete collective ("The panel's debate over whether the ceasefire holds") are the target
 * register and stay clean — they name something a viewer can see.
 */
const INVENTED_NARRATORS = [
  'speaker', 'host', 'narrator', 'creator', 'youtuber', 'commentator', 'presenter',
  'video', 'channel', 'podcast', 'episode',
];

const ACTOR_NOUNS = [
  ...INVENTED_NARRATORS,
  'panel', 'panelist', 'panellist', 'guest', 'interviewer', 'author', 'writer', 'reporter',
  'journalist', 'pastor', 'preacher', 'man', 'woman', 'guy',
];

const ACTOR_PRONOUNS = ['he', 'she', 'they', 'it', 'we', 'i', 'you'];

/**
 * Verbs that describe the ACT OF COVERING something rather than the something.
 *
 * These are what make "Pastor Brad Wells shares his prayer ministry" narrated even though
 * Pastor Brad Wells is a real, named person: the title is about him doing an act of
 * communication. The topic form of the same chapter is "Pastor Brad Wells's prayer ministry".
 */
const NARRATION_VERBS = [
  'critiques', 'critique', 'reacts', 'react', 'responds', 'respond', 'discusses', 'discuss',
  'covers', 'cover', 'debates', 'debate', 'shares', 'share', 'explains', 'explain', 'describes',
  'describe', 'talks', 'talk', 'argues', 'argue', 'says', 'say', 'claims', 'claim', 'debunks',
  'debunk', 'dismantles', 'dismantle', 'breaks', 'break', 'walks', 'walk', 'examines', 'examine',
  'analyzes', 'analyse', 'analyses', 'analyzes', 'addresses', 'address', 'mocks', 'mock',
  'exposes', 'expose', 'reviews', 'review', 'reads', 'read', 'plays', 'play', 'considers',
  'consider', 'recounts', 'recount', 'reflects', 'reflect', 'weighs', 'weigh', 'unpacks',
  'unpack', 'tackles', 'tackle', 'lays', 'lay', 'goes', 'go', 'takes', 'take', 'looks', 'look',
];

const ARTICLES = ['the', 'a', 'an', 'this', 'that', 'his', 'her', 'their', 'our', 'my'];

/**
 * A possessive, in BOTH apostrophe characters.
 *
 * Real model output uses the typographic apostrophe as readily as the ASCII one, and a check
 * that only knew the ASCII one reported the target register as the failure it was written to
 * replace.
 */
const POSSESSIVE = /['’]s$/;

/**
 * Prepositions that turn an ambiguous word into a noun taking a complement.
 *
 * "debate over", "report on", "discussion of", "account of" — the same spellings that are
 * verbs elsewhere. Without this the detector flagged "Debate about Trump's refusal to extend
 * the Iran ceasefire", which is the operator's own worked example of the CORRECT register.
 */
const NOUN_COMPLEMENTS = new Set(['about', 'of', 'on', 'over', 'into', 'for', 'with', 'from', 'between']);

/** Why a title reads as narrated, or that it does not. */
export interface NarratedActorVerdict {
  narrated: boolean;
  /**
   * Which pattern matched, for the log line and the run's declared warning. Empty when
   * nothing matched. Never shown to a model.
   */
  pattern: 'actor-subject' | 'actor-verb' | '';
}

/**
 * Does this title narrate an actor rather than name its content?
 *
 * TWO PATTERNS, per the spec's detector alignment note so the number is comparable with
 * Briefcase's:
 *
 *  1. ACTOR SUBJECT — the title opens with an actor noun in subject position, with or
 *     without an article ("The speaker ...", "A YouTuber ...", "Panel ...", "He ...").
 *  2. ACTOR + NARRATION VERB — any subject, real name included, followed within the first
 *     few words by a verb that describes covering something ("Pastor Brad Wells shares ...").
 *
 * Deliberately shallow: it reads the first clause, because that is where a title's
 * grammatical subject is, and a deeper parse would need a parser. False negatives are
 * expected and acceptable — this triggers one re-ask and feeds a metric, and both of those
 * are improved by a check that is easy to reason about.
 */
export function narratesAnActor(title: string): NarratedActorVerdict {
  const clause = firstClause(title);
  const words = clause.split(/\s+/).filter(Boolean);
  if (words.length === 0) return { narrated: false, pattern: '' };

  const lower = words.map((w) => w.toLowerCase().replace(/[^a-z']/g, ''));

  // Pattern 1: subject position is an actor.
  //
  // With ONE exception, which the spec's own alignment case depends on: an actor noun
  // immediately followed by a NAME is a form of address, not an invented actor. "Pastor Brad
  // Wells's prayer ministry" is the target topic form; "The pastor's prayer ministry" without a
  // name would be too. What makes "Pastor Brad Wells shares his prayer ministry" narrated is
  // the verb, and pattern 2 below is what catches it.
  let subjectAt = 0;
  if (ARTICLES.includes(lower[0]) && lower.length > 1) subjectAt = 1;
  const subject = lower[subjectAt];
  const followedByAName = subjectAt + 1 < words.length && /^[A-Z]/.test(words[subjectAt + 1]);
  // A POSSESSIVE actor is not a narrating subject, it is a noun-phrase constituent, and the
  // possessive form is the TARGET register: "The panel's debate over X" is what the operator
  // asked for and "The panel debates X" is what he asked to be caught. Tested on the raw word
  // because both apostrophe characters occur in real output and the lowercased comparison form
  // drops the curly one — which turned "The panel’s debate" into "panels" and flagged it.
  const possessiveSubject = POSSESSIVE.test(words[subjectAt]);
  // The possessive exemption does NOT extend to the invented-narrator family — see that list.
  const stem = possessiveSubject ? singular(subject.replace(/['’]s$/, '')) : singular(subject);
  if (subject && !followedByAName && possessiveSubject && INVENTED_NARRATORS.includes(stem)) {
    return { narrated: true, pattern: 'actor-subject' };
  }
  if (subject && !followedByAName && !possessiveSubject && ACTOR_NOUNS.includes(stem)) {
    return { narrated: true, pattern: 'actor-subject' };
  }
  if (subjectAt === 0 && ACTOR_PRONOUNS.includes(subject)) return { narrated: true, pattern: 'actor-subject' };

  // Pattern 2: a narration verb early enough to be this clause's main verb. A possessive
  // subject ("Gene Bailey's use of Jabez") never reaches one, which is the target form.
  const verbWindow = lower.slice(0, Math.min(6, lower.length));
  const verbAt = verbWindow.findIndex((w) => NARRATION_VERBS.includes(w));
  if (verbAt !== -1) {
    // Three ways the apparent verb is really a NOUN, all of which are the target register:
    //
    //  - AT POSITION 0. English does not open a declarative clause with its finite verb, so
    //    "Debate about Trump's refusal ..." is a noun phrase — and it is precisely the form
    //    the operator asked the body to be written in.
    //  - FOLLOWED BY A PREPOSITION. "report on X", "discussion of Y", "debate over Z": the
    //    word takes a complement, which a finite verb in this position would not.
    //  - AFTER A POSSESSIVE. "Gene Bailey's call to occupy territory", "Paul Petit's report".
    const nounAtStart = verbAt === 0;
    const takesAComplement = NOUN_COMPLEMENTS.has(lower[verbAt + 1] || '');
    const possessiveBefore = words.slice(0, verbAt).some((w) => POSSESSIVE.test(w));
    if (!nounAtStart && !takesAComplement && !possessiveBefore) {
      return { narrated: true, pattern: 'actor-verb' };
    }
  }

  return { narrated: false, pattern: '' };
}

function singular(word: string): string {
  return word.endsWith('s') && word.length > 3 ? word.slice(0, -1) : word;
}

/** The title up to its first clause break — where the grammatical subject lives. */
function firstClause(title: string): string {
  return title.split(/[,;:—–]|\s+(?:and|but|before|while|then)\s+/i)[0].trim();
}

/** Proper nouns a title asserts, and whether the chapter's own transcript contains them. */
export interface GroundingVerdict {
  /** Every proper noun the title used. */
  properNouns: string[];
  /** The ones this chapter's transcript does not contain. Empty means grounded. */
  ungrounded: string[];
  grounded: boolean;
}

/**
 * Spec §6.1 lever 3's grounding rule: every proper noun in a title must appear in THAT
 * chapter's transcript.
 *
 * It catches two different mistakes with one test. The first is the model supplying a name
 * from world knowledge that the chapter never said. The second is subtler and is the reason
 * this became worth writing: a real person named in the PROMPT'S OWN EXAMPLES leaking into a
 * title about somebody else — measured behaviour on this exact prompt, documented in
 * chapter-prompts.ts's header, and now detectable rather than merely warned about in a
 * comment.
 *
 * Compared per WHOLE surface AND per word, so "Gene Bailey" counts as grounded when the
 * transcript says "Gene Bailey" and as ungrounded when it says neither word.
 */
export function groundTitle(title: string, chapterTranscript: string): GroundingVerdict {
  const properNouns = extractProperNouns(title).map((m) => m.text);
  const ungrounded = properNouns.filter((noun) => !groundedIn(chapterTranscript, noun));
  return { properNouns, ungrounded, grounded: ungrounded.length === 0 };
}

/**
 * A surface is grounded when the transcript contains it whole, or contains every word of it.
 *
 * The per-word half matters because transcripts spell names apart from how a title says them
 * — "D.L. Moody" in a title against "D. L. Moody" in the captions — and `occursIn` already
 * normalizes punctuation away, so word-wise containment is the honest test rather than a
 * loosening of it.
 */
function groundedIn(transcript: string, surface: string): boolean {
  if (occursIn(transcript, surface)) return true;
  const words = surface.split(/\s+/).filter((w) => w.replace(/[^A-Za-z0-9]/g, '').length > 1);
  return words.length > 0 && words.every((word) => occursIn(transcript, word));
}

/**
 * The shared three-number metric (spec §6.1), scored over one video's chapter titles.
 *
 * Reported in the same shape in both apps so a change here can be compared with Briefcase's
 * baseline (63-minute validation video, 27b, levers 1-2 only: 1/7 generic, ~1.6
 * entities/title, 3/7 narrated).
 *
 * `generic` and `narrated` are INDEPENDENT counts on purpose. The run that motivated the
 * narrated-actor number scored well on entities and badly on register, and a single combined
 * score would have hidden exactly that.
 */
export interface ChapterTitleMetric {
  titles: number;
  /** Total proper nouns across all titles. */
  properNouns: number;
  /** properNouns / titles. */
  properNounsPerTitle: number;
  /** Titles with zero proper nouns. */
  genericTitles: number;
  genericRate: number;
  /** Titles whose grammatical subject is a narrating actor. */
  narratedTitles: number;
  narratedRate: number;
  /** Per-title detail, in the order given, for a report that has to name the offender. */
  perTitle: Array<{ title: string; properNouns: string[]; generic: boolean; narrated: boolean }>;
}

export function scoreChapterTitles(titles: string[]): ChapterTitleMetric {
  const perTitle = titles.map((title) => {
    const properNouns = extractProperNouns(title).map((m) => m.text);
    return {
      title,
      properNouns,
      generic: properNouns.length === 0,
      narrated: narratesAnActor(title).narrated,
    };
  });

  const count = perTitle.length;
  const properNouns = perTitle.reduce((sum, t) => sum + t.properNouns.length, 0);
  const genericTitles = perTitle.filter((t) => t.generic).length;
  const narratedTitles = perTitle.filter((t) => t.narrated).length;

  return {
    titles: count,
    properNouns,
    properNounsPerTitle: count === 0 ? 0 : properNouns / count,
    genericTitles,
    genericRate: count === 0 ? 0 : genericTitles / count,
    narratedTitles,
    narratedRate: count === 0 ? 0 : narratedTitles / count,
    perTitle,
  };
}

/** One line for a log or a report: "7 titles, 1.6 proper nouns each, 1 generic, 3 narrated". */
export function describeChapterTitleMetric(metric: ChapterTitleMetric): string {
  return (
    `${metric.titles} title(s), ${metric.properNounsPerTitle.toFixed(2)} proper noun(s) each, ` +
    `${metric.genericTitles}/${metric.titles} generic, ${metric.narratedTitles}/${metric.titles} narrated`
  );
}
