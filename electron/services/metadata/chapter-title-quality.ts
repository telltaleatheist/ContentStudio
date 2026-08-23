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

import { COMMON_WORDS, extractProperNouns, INNER_FUNCTION_WORDS, occursIn } from './entity-extraction';

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
  'video', 'channel', 'podcast', 'episode', 'transcript', 'summary', 'segment', 'content',
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

/**
 * Clauses of a DESCRIPTION whose grammatical subject is the person or artifact doing the
 * describing — "we", "I", "the speaker", "this video" — rather than something from inside the
 * video.
 *
 * WHY THIS IS NOT `narratesAnActor`, measured on the first run under the topic-form
 * description prompts. That check is written for a chapter title, where "Pastor Brad Wells
 * shares his prayer ministry" is the failure and the narration VERB is the tell. A description
 * is sentences about claims, so its subjects legitimately argue, claim and say things — "The
 * Intelligent Design Facebook page argues a Christian God is necessary" is the target register,
 * and `narratesAnActor` flagged it on the verb alone. On the same run the real failures — "but
 * we debunk its miracle lies" after the hook's comma, "The speaker exposes" at sentence three —
 * sat in clauses and sentences the old first-clause / first-sentence plumbing never read. So
 * this check is the inverse shape: EVERY clause of EVERY sentence is read, and only the
 * describer SUBJECTS are the tell; verbs are not consulted at all.
 *
 * Returns the offending clauses so the warning can name each one rather than the first.
 */
export function describerClauses(text: string): string[] {
  const offending: string[] = [];
  for (const sentence of text.split(/(?<=[.!?])\s+/)) {
    for (const clause of sentence.split(/[,;:—–]|\s+(?:and|but|or|yet|so|then|while|though|although|whereas|since|unless|until|before|after|because)\s+/i)) {
      const words = clause.trim().split(/\s+/).filter(Boolean);
      if (words.length < 2) continue;
      const lower = words.map((w) => w.toLowerCase().replace(/[^a-z']/g, ''));
      let subjectAt = 0;
      if (ARTICLES.includes(lower[0]) && lower.length > 1) subjectAt = 1;
      // "I" and "we" only count in subject position at the clause's front; an invented
      // narrator noun counts wherever the article put it. Possessives are constituents of a
      // topic noun phrase ("the video's premise"), not subjects, and stay.
      const isDescriberPronoun = subjectAt === 0 && ['i', 'we'].includes(lower[0]);
      const isNarratorNoun =
        !POSSESSIVE.test(words[subjectAt]) && INVENTED_NARRATORS.includes(singular(lower[subjectAt]));
      if (isDescriberPronoun || isNarratorNoun) offending.push(clause.trim());
    }
  }
  return offending;
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
  const ungrounded: string[] = [];
  for (const noun of properNouns) {
    if (groundedIn(chapterTranscript, noun)) continue;
    // A mention that OPENS the title is capitalized for position as much as for namehood.
    // The topic-form register opens titles with gerunds ("Debunking Gene Bailey's misreading
    // of ..."), and the extractor welds that opener onto whatever capitalized run or glued
    // function word follows it, so the mention "Debunking Gene Bailey" asserts one name, not
    // two. Position explains the opener; what the title actually asserts is the rest. Measured
    // on the first run under the topic-form labels: "Debunking the AI-generated intelligent
    // design Facebook page ..." was reported ungrounded as the "name" "Debunking the
    // AI-generated" on a chapter whose transcript contains both AI and the page.
    if (!title.trimStart().replace(/^["'\u2018\u2019\u201C\u201D]+/, '').startsWith(noun.split(/\s+/)[0])) {
      ungrounded.push(noun);
      continue;
    }
    const rest = noun.split(/\s+/).slice(1);
    while (rest.length > 0 && INNER_FUNCTION_WORDS.has(rest[0].toLowerCase())) rest.shift();
    if (rest.length === 0) continue; // nothing but the ambiguous opener: the title asserts no name here
    const asserted = rest.join(' ');
    if (!groundedIn(chapterTranscript, asserted)) ungrounded.push(asserted);
  }
  return { properNouns, ungrounded, grounded: ungrounded.length === 0 };
}

/**
 * The grounding rule for a VIEWER-FACING title, which is Title Cased and therefore lies about
 * which of its words are names.
 *
 * WHY THIS IS NOT `groundTitle` ABOVE, measured on this build's own harness run against the
 * 27b. `groundTitle` is written for a CHAPTER title, which is sentence-cased topic form, so a
 * mid-string capital really is evidence of a proper noun. A YouTube title capitalizes every
 * word, so the same extractor returned "Buy", "Zero Accountability", "Critics Demons" and
 * "Preachers Need" as names: seven of ten titles came back ungrounded in a run where one of
 * them actually was. A check that fires on almost everything is not a check — the operator
 * learns to scroll past it, and the one real hallucination in that run ("a Fourteenth Seat",
 * against a transcript that says twelve seats) scrolls past with it.
 *
 * WHAT IT ACTUALLY TESTS, stated plainly because the honest name is not "proper nouns": TWO OR
 * MORE ADJACENT CAPITALIZED WORDS THAT THE INPUTS DO NOT CONTAIN AT ALL. Not "is this a name" —
 * without a lexicon you cannot tell an invented name from an invented abstract phrase, and both
 * of them are the operator's problem anyway. What it catches:
 *
 *   - a name from world knowledge ("Kenneth Copeland" on a video that never mentions him),
 *   - a name leaking out of the prompt's own examples ("Gene Bailey" on an unrelated video) —
 *     the measured failure mode documented in the chapter prompts' header, and
 *   - a claim built from words the video never said ("Occupy Territory"), which for a channel
 *     whose brief opens by naming libel exposure is worth the same look.
 *
 * Adjacency and the two-word minimum are what keep it quiet. A single capitalized word in Title
 * Case is just a word; a function word between two unknown words ("Kenneth And Copeland") means
 * two things rather than one; and one word the transcript does contain anywhere in the run ends
 * it, because a phrase sharing vocabulary with the video came from the video.
 *
 * Comparison is case-insensitive, punctuation-insensitive, possessive-stripped and singularized
 * ("Preachers" is grounded by a transcript that says "preacher"), all via `occursIn`.
 */
export function groundViewerTitle(title: string, groundingText: string): GroundingVerdict {
  const words = title.split(/\s+/).filter(Boolean);
  const properNouns: string[] = [];
  const ungrounded: string[] = [];

  let run: string[] = [];
  const closeRun = () => {
    if (run.length >= 2) {
      const surface = run.join(' ');
      properNouns.push(surface);
      ungrounded.push(surface);
    }
    run = [];
  };

  for (const word of words) {
    const bare = word.replace(/['’]s\b/i, '').replace(/[^A-Za-z0-9]/g, '');
    // Not a capitalized word, or a word that is capitalized for grammar rather than for being
    // a name. Either way it ends the run: a function word between two unknown words means they
    // are two things, not one name.
    if (bare.length < 2 || !/^[A-Z]/.test(word) || COMMON_WORDS.has(bare.toLowerCase())) {
      closeRun();
      continue;
    }
    const known = occursIn(groundingText, bare) || occursIn(groundingText, singular(bare));
    if (known) {
      closeRun();
      continue;
    }
    run.push(word.replace(/[.,;:!?]+$/, ''));
  }
  closeRun();

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
