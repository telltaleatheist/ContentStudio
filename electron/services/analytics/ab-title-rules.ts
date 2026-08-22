/**
 * A/B Title Rule Derivation
 *
 * Turns a channel's DECIDED A/B title tests (ab-tests.json) into the two things a
 * generation prompt can actually use:
 *
 *   1. AGGREGATE RULES — structural traits measured in isolation across every decided
 *      head-to-head, asserted ONLY when the evidence clears a band threshold, and always
 *      carrying their own provenance inline so a rule built on 25 losses cannot read like
 *      one built on 2.
 *   2. EXEMPLARS — a capped, ranked list of this channel's own winning titles.
 *
 * This is a TypeScript port of the LOGIC in
 * /Volumes/Callisto/Projects/tools/title-generator/derive_rules.py — the feature
 * definitions, the isolation counting and the band thresholds are deliberately identical
 * so the numbers this emits reconcile with the numbers that tool prints. Change one here
 * and the two stop agreeing; change both or neither.
 *
 * Everything in this module is PURE (records in, data/string out): no store, no fs, no
 * Electron runtime, no clock of its own — `derivedAt` is passed in. That is what makes it
 * testable, and what makes two runs over the same file produce byte-identical output.
 *
 * NOTHING here is lenient. A record that cannot be read as a head-to-head throws by
 * videoId rather than being skipped: a silently dropped test changes every count in the
 * block without changing anything a reader can see.
 */

import {
  AbTestResult,
  AbTitleExemplar,
  AbTitleRule,
  AbTitleRuleObservation,
  AbTitleRulesDerivation,
  AbTitleTraitId,
} from './analytics-types';

/**
 * The traits under test. Each must be a property of the title STRING ALONE — a trait
 * needing outside knowledge (is the subject famous? is the claim true?) cannot be counted
 * the same way across variants, so it cannot be measured this way at all.
 *
 * `test` mirrors derive_rules.py's FEATURES exactly:
 *   colon    `":" in t`
 *   question `t.rstrip().endswith("?")`
 *   digit    `re.search(r"\d", t)` — Python's `\d` is Unicode-aware on str, hence \p{Nd}
 *            rather than JavaScript's ASCII-only \d.
 *
 * `flat` is the wording for a STRONG band, `hedged` for WEAK. A trait at 8-vs-7 is not a
 * rule and must never be worded like one — that is the whole point of the two bands.
 */
const TRAITS: Array<{
  id: AbTitleTraitId;
  test: (title: string) => boolean;
  flat: string;
  hedged: string;
}> = [
  {
    id: 'colon',
    test: (title) => title.includes(':'),
    flat: 'Never put a colon in a title. Write one continuous claim, not `Topic: elaboration`.',
    hedged: 'Prefer titles without a colon: the `Topic: elaboration` shape tends to lose head-to-head.',
  },
  {
    id: 'question',
    test: (title) => title.trimEnd().endsWith('?'),
    flat: 'Never end a title with a question mark. State the claim; do not ask it.',
    hedged: 'Prefer stating the claim over asking it: titles ending in a question mark tend to lose head-to-head.',
  },
  {
    id: 'digit',
    test: (title) => /\p{Nd}/u.test(title),
    flat: 'Never put a digit in a title. Name what happened instead of counting it.',
    hedged: 'Prefer titles without digits: numbered/listicle framing tends to lose head-to-head.',
  },
];

/** STRONG band: this many isolated losses AND this loss:win ratio. */
const STRONG_MIN_LOSSES = 15;
const STRONG_MIN_RATIO = 3.0;

/** WEAK band: this many isolated losses AND this loss:win ratio. */
const WEAK_MIN_LOSSES = 8;
const WEAK_MIN_RATIO = 2.0;

/**
 * Below this many decided tests no trait can possibly reach even the WEAK band, so the
 * block says "not enough evidence yet" rather than reporting three traits that all failed
 * a threshold they never had the sample size to clear.
 */
const MIN_DECIDED_TESTS_FOR_RULES = WEAK_MIN_LOSSES;

/** Hard cap on exemplars per channel. The prompt block must not grow with the store. */
export const EXEMPLAR_CAP = 10;

/** A decided head-to-head, validated and reduced to what the counting needs. */
interface DecidedTest {
  videoId: string;
  winner: string;
  losers: string[];
  /** Highest-share loser — the title the winner actually beat. */
  runnerUp: string;
  /** Winner's watch-time share minus the runner-up's, in percentage POINTS. */
  liftPts: number;
  decidedAt: string;
}

/**
 * Thrown when an ab-tests.json record cannot be read as a decided head-to-head.
 * The store is written by the collector, which already rejects undecided tests and ties;
 * a record that fails here means the file was hand-edited or the writer regressed, and
 * either way the derived block would be quietly wrong.
 */
export class AbTestRecordError extends Error {
  constructor(videoId: string, reason: string) {
    super(`ab-tests record ${videoId} is not a usable decided head-to-head: ${reason}`);
    this.name = 'AbTestRecordError';
  }
}

/** Validate + reduce the raw store records. Throws on anything unusable. */
function toDecidedTests(records: AbTestResult[], channelId: string): DecidedTest[] {
  return records.map((record) => {
    const videoId = record.videoId;
    if (record.channelId !== channelId) {
      throw new AbTestRecordError(videoId, `channelId ${record.channelId} in ${channelId}'s store`);
    }
    if (!Array.isArray(record.variants) || record.variants.length < 2) {
      throw new AbTestRecordError(videoId, 'fewer than two variants');
    }
    if (!record.variants.includes(record.winner)) {
      throw new AbTestRecordError(videoId, `winner "${record.winner}" is not one of the variants`);
    }
    if (!Array.isArray(record.shares) || record.shares.length !== record.variants.length) {
      throw new AbTestRecordError(videoId, 'shares do not line up one-to-one with variants');
    }
    if (!Number.isFinite(record.liftPct)) {
      throw new AbTestRecordError(videoId, `liftPct ${record.liftPct} is not a finite number`);
    }
    if (Number.isNaN(Date.parse(record.decidedAt))) {
      throw new AbTestRecordError(videoId, `decidedAt "${record.decidedAt}" is not a date`);
    }

    // Losers keep their share so the runner-up is the loser the winner actually beat,
    // not merely the first one listed.
    const losers = record.variants
      .map((title, index) => ({ title, share: record.shares[index] }))
      .filter((entry) => entry.title !== record.winner);
    if (losers.length === 0) {
      throw new AbTestRecordError(videoId, 'every variant equals the winner');
    }
    const runnerUp = losers.reduce((best, entry) => (entry.share > best.share ? entry : best));

    return {
      videoId,
      winner: record.winner,
      losers: losers.map((entry) => entry.title),
      runnerUp: runnerUp.title,
      liftPts: record.liftPct,
      decidedAt: record.decidedAt,
    };
  });
}

/**
 * Isolated win/loss counts for one trait.
 *
 * lostAlone: the winner did NOT carry the trait, and some loser carried it AND NEITHER of
 *            the other two traits — so the loss cannot be borrowed from a co-occurring
 *            trait.
 * wonAlone:  the winner DID carry the trait and beat a loser clean of all three.
 *
 * A test can count for several traits, and a test where every variant carries the trait
 * counts for none of them. That is the intended behaviour: only contrasts are evidence.
 */
function countIsolated(tests: DecidedTest[], traitIndex: number): { lostAlone: number; wonAlone: number } {
  const trait = TRAITS[traitIndex];
  const others = TRAITS.filter((_, index) => index !== traitIndex);
  const carriesOnlyThis = (title: string) => trait.test(title) && !others.some((o) => o.test(title));
  const carriesNothing = (title: string) => !trait.test(title) && !others.some((o) => o.test(title));

  let lostAlone = 0;
  let wonAlone = 0;
  for (const test of tests) {
    if (!trait.test(test.winner) && test.losers.some(carriesOnlyThis)) {
      lostAlone++;
    }
    if (trait.test(test.winner) && test.losers.some(carriesNothing)) {
      wonAlone++;
    }
  }
  return { lostAlone, wonAlone };
}

/** 'strong' | 'weak' | null (null = below the weak band, so NO rule is stated). */
function bandOf(lostAlone: number, wonAlone: number): AbTitleRule['confidence'] | null {
  const ratio = lostAlone / Math.max(1, wonAlone);
  if (lostAlone >= STRONG_MIN_LOSSES && ratio >= STRONG_MIN_RATIO) {
    return 'strong';
  }
  if (lostAlone >= WEAK_MIN_LOSSES && ratio >= WEAK_MIN_RATIO) {
    return 'weak';
  }
  return null;
}

/** YYYY-MM-DD from an ISO timestamp. */
function isoDate(timestamp: string): string {
  return timestamp.slice(0, 10);
}

/** One decimal, for lift figures read by a human and a model. */
function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

/**
 * Derive one channel's title rules and exemplars from its decided A/B tests.
 *
 * `derivedAt` is injected rather than read from the clock so the result is a pure function
 * of its inputs — the same store plus the same date always yields the same block.
 */
export function deriveAbTitleRules(
  records: AbTestResult[],
  options: { channelId: string; channelName: string; derivedAt: Date }
): AbTitleRulesDerivation {
  const tests = toDecidedTests(records, options.channelId);
  const decidedDates = tests.map((test) => test.decidedAt).sort();

  const rules: AbTitleRule[] = [];
  const observations: AbTitleRuleObservation[] = [];

  TRAITS.forEach((trait, index) => {
    const { lostAlone, wonAlone } = countIsolated(tests, index);
    const confidence = tests.length >= MIN_DECIDED_TESTS_FOR_RULES ? bandOf(lostAlone, wonAlone) : null;
    if (confidence) {
      rules.push({
        id: trait.id,
        directive: confidence === 'strong' ? trait.flat : trait.hedged,
        lostAlone,
        wonAlone,
        confidence,
      });
    } else {
      // Recorded, never asserted, and never rendered into the prompt as a rule: an
      // observation below the band is not evidence of anything, and reads like a rule the
      // moment it is written next to one.
      observations.push({ id: trait.id, lostAlone, wonAlone });
    }
  });

  // Strongest evidence first; the trait order above breaks ties, so this is deterministic.
  rules.sort((a, b) => b.lostAlone - a.lostAlone);

  const exemplars: AbTitleExemplar[] = [...tests]
    // Ties broken by videoId so the cap never depends on the store's file order.
    .sort((a, b) => b.liftPts - a.liftPts || a.videoId.localeCompare(b.videoId))
    .slice(0, EXEMPLAR_CAP)
    .map((test) => ({
      winner: test.winner,
      beat: test.runnerUp,
      liftPts: round1(test.liftPts),
      decidedAt: isoDate(test.decidedAt),
    }));

  return {
    channelId: options.channelId,
    channelName: options.channelName,
    derivedAt: options.derivedAt.toISOString(),
    decidedTests: tests.length,
    earliestDecidedAt: decidedDates.length > 0 ? isoDate(decidedDates[0]) : null,
    latestDecidedAt: decidedDates.length > 0 ? isoDate(decidedDates[decidedDates.length - 1]) : null,
    rules,
    observations,
    exemplars,
  };
}

/**
 * Render a derivation as the plain-text block that goes into the generation prompt.
 *
 * Bounded by construction: at most three rules and EXEMPLAR_CAP exemplars, whatever the
 * size of the store. The empty case is a NORMAL state (no channel here has the sample size
 * for a strong rule on its own), so it is stated in words rather than left blank — silence
 * reads to a model as "nothing to avoid", which is the opposite of what an empty
 * derivation means.
 */
export function renderAbTitleRulesBlock(derivation: AbTitleRulesDerivation): string {
  const asOf = isoDate(derivation.derivedAt);
  const lines: string[] = [];

  lines.push(`TITLE A/B EVIDENCE — ${derivation.channelName}`);
  if (derivation.decidedTests === 0) {
    lines.push(`Evidence window: 0 decided A/B title tests (as of ${asOf}).`);
  } else {
    lines.push(
      `Evidence window: ${derivation.decidedTests} decided A/B title tests, ` +
        `${derivation.earliestDecidedAt} to ${derivation.latestDecidedAt} (as of ${asOf}). ` +
        `Measured on this channel's own head-to-heads — it outranks generic title advice.`
    );
  }

  lines.push('');
  lines.push('AGGREGATE RULES');
  if (derivation.rules.length > 0) {
    for (const rule of derivation.rules) {
      lines.push(
        `- ${rule.directive} (won ${rule.wonAlone} / lost ${rule.lostAlone} across ` +
          `${derivation.decidedTests} decided tests, channel ${derivation.channelName}, as of ${asOf})`
      );
    }
  } else if (derivation.decidedTests < MIN_DECIDED_TESTS_FOR_RULES) {
    lines.push(
      `No statistically defensible title rules yet: only ${derivation.decidedTests} decided tests ` +
        `(a rule needs at least ${WEAK_MIN_LOSSES} isolated losses).`
    );
  } else {
    lines.push(
      `No statistically defensible title rules yet: none of the ${derivation.observations.length} ` +
        `structural traits cleared the evidence threshold across ${derivation.decidedTests} decided tests. ` +
        `Absence of a rule is not permission to invent one.`
    );
  }

  lines.push('');
  if (derivation.exemplars.length > 0) {
    lines.push(
      `EXEMPLARS — this channel's ${derivation.exemplars.length} biggest A/B wins ` +
        `(watch-time share, percentage POINTS over the runner-up; not a percentage lift):`
    );
    for (const exemplar of derivation.exemplars) {
      lines.push(`- "${exemplar.winner}" (+${exemplar.liftPts} pts, ${exemplar.decidedAt}) beat "${exemplar.beat}"`);
    }
  } else {
    lines.push('EXEMPLARS');
    lines.push('None: this channel has no decided A/B title tests yet.');
  }

  return lines.join('\n');
}

/**
 * Convenience composition: raw store records straight to the prompt block.
 * Pure, and the shortest thing to point a test at.
 */
export function buildAbTitleRulesBlock(
  records: AbTestResult[],
  options: { channelId: string; channelName: string; derivedAt: Date }
): string {
  return renderAbTitleRulesBlock(deriveAbTitleRules(records, options));
}
