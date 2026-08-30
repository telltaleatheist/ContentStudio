/**
 * Ads are not chapters
 *
 * The chapter pipeline is deliberately good at isolating the parts of a video that are
 * not the video: stage 4's prompt makes it NAME a sponsor read, a Patreon plug or a
 * sign-off plainly instead of folding it into the story either side of it. That is the
 * right pipeline behaviour and it is sealed. What it produces, though, is a chapter that
 * is correct and unpublishable — nobody wants "Patreon support request" in the chapter
 * bar, and nothing about the ad should reach the title, description or tags.
 *
 * So the promo decision is made HERE, in code, after the pipeline: pattern-matched over
 * the chapter's own name and detail. It is not asked for in a prompt, because a
 * classifier that lives in a prompt cannot be read, tested or corrected without
 * retraining the thing it lives in.
 *
 * Excluded, not discarded. A promo chapter leaves the published list and every task's
 * conditioning, and lands in `metadata.excludedChapters` with `isPromo: true` on it. The
 * user can always see what was taken out and why.
 *
 * Timestamps are NEVER rebased. If the video opens with a cold plug, the chapter list
 * genuinely no longer starts at 0:00 and YouTube will not build markers from it — that
 * is a fact about the video, and the honest response is to say so in a warning, not to
 * move a measured timestamp to a moment the pipeline never placed.
 */

import * as log from 'electron-log';
import { Chapter } from './chapter-generator.service';

/**
 * The promo vocabulary, as the user specified it.
 *
 * Word-boundary alternation over one case-insensitive regex, matched against the
 * chapter's `title` (stage 4's `about`) ONLY — never its `detail` prose. The prompt
 * contract makes a real plug segment be NAMED as one ("Patreon plug and ..."), so the
 * label is the reliable signal; the detail of a long content chapter legitimately
 * mentions the brief plug interspersed inside it ("interspersed is a brief Patreon
 * plug"), and matching prose excluded four content chapters of a compilation as ads
 * (podcast 1, 2026-08-23). Inflections are spelled out rather than reached with a
 * prefix match: `\bplugs?\b` must not fire on "plugged in", and `\bpromos?\b` must not
 * fire on "promotion of a book" — those are content.
 */
const PROMO_PATTERN =
  /\b(?:patreon|sponsor|sponsors|sponsored|sponsorship|plug|plugs|promo|promos|sign[-\s]?off|sign[-\s]?offs|signoff|signoffs|ad read|ad reads|advertisement|advertisements|channel link|channel links|merch|merchandise|membership|memberships|subscribe push|superchat|superchats)\b/i;

/** Why one chapter was excluded — the word that matched its label, for the log line. */
/** A chapter's span in whole seconds, or null when its end is not recorded. */
function spanSeconds(chapter: Chapter): number | null {
  if (!chapter.endTimestamp) return null;
  const toSec = (ts: string) => ts.split(':').reduce((acc, part) => acc * 60 + Number(part), 0);
  const span = toSec(chapter.endTimestamp) - toSec(chapter.timestamp);
  return Number.isFinite(span) && span >= 0 ? span : null;
}

/**
 * The distinctive phrases of the channel's own promoted items, for the second match below.
 *
 * Each promoted_items entry ('the book "God''s People: Christian Nationalism in the Third
 * Reich"', 'the Patreon (owenmorgan.com/patreon)') is reduced to the substring a chapter
 * title would actually carry: the quoted span when there is one, otherwise the entry with
 * its leading article/category words and any parenthetical stripped. Lowercased for the
 * containment test; empty results are dropped.
 */
function promotedPhrases(promotedItems: string[]): string[] {
  return promotedItems
    .map((item) => {
      const quoted = item.match(/"([^"]+)"/);
      const phrase = quoted
        ? quoted[1]
        : item
            .replace(/\([^)]*\)/g, ' ')
            .replace(/^\s*the\s+(?:book|website|merch shop|creator's[^,]*)?\s*/i, '')
            .trim();
      return normalizeForContainment(phrase);
    })
    .filter((p) => p.length > 3);
}

/**
 * Lowercase, apostrophes dropped (not split — "Jehovah's" must equal "Jehovahs"), remaining
 * punctuation collapsed to spaces. The same apostrophe rule normalizeWords uses.
 */
function normalizeForContainment(text: string): string {
  return text
    .toLowerCase()
    .replace(/['’]/g, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

function promoMatch(chapter: Chapter, phrases: string[]): string | undefined {
  const hit = chapter.title.match(PROMO_PATTERN);
  if (hit) return hit[0];
  // "Promotion of the book God's People..." (2026-08-30). The generic promotion words are
  // deliberately NOT in PROMO_PATTERN — a chapter about someone ELSE'S promotion is content,
  // which is the measured rule above — but a title that both speaks of promoting and names
  // one of the CREATOR'S OWN promoted items is the creator's plug by definition. The chapter
  // prompt's plug register leads with "Promotion of ..." often enough that the word-list
  // alone misses it (seen live the day the register shipped: the plug stayed in the
  // published list and drew a sliver warning meant for content).
  if (/\bpromot(?:ion|ions|ing|es?)\b/i.test(chapter.title)) {
    const title = normalizeForContainment(chapter.title);
    for (const phrase of phrases) {
      if (title.includes(phrase)) return `promotion of "${phrase}"`;
    }
  }
  return undefined;
}


export interface PromoPartition {
  /** The chapters that get published, in order. Empty when the whole video was promo. */
  content: Chapter[];
  /** The excluded ones, each carrying `isPromo: true`. Kept for metadata.excludedChapters. */
  excluded: Chapter[];
  /** `content`-aligned subject lines — what every metadata task conditions on. */
  contentSubjects: string[];
  /** Index-aligned with contentSubjects; entries may be blank. */
  contentDetails: string[];
  /** Degradations the caller must surface. See the three cases below. */
  warnings: string[];
}

/**
 * Split a chapter list into what publishes and what does not.
 *
 * `subjects` and `details` are the pipeline's index-aligned views of the same chapters
 * (ChapterPipelineResult.subjects / subjectDetails). They are filtered by the SAME
 * indices rather than re-derived, so the subject list a task sees cannot drift from the
 * chapter list the viewer sees. A length mismatch is a caller bug and throws: silently
 * zipping mismatched lists would attach one chapter's detail to another chapter's name.
 */
export function excludePromoChapters(
  chapters: Chapter[],
  subjects: string[],
  details: string[],
  sourceLabel: string,
  /** The channel's promoted_items list, for the own-item promotion match. Absent = word-list only. */
  promotedItems: string[] = []
): PromoPartition {
  if (subjects.length !== chapters.length) {
    throw new Error(
      `Promo exclusion for ${sourceLabel} got ${chapters.length} chapter(s) but ${subjects.length} subject line(s) — ` +
        `they are the same list seen two ways and must be the same length`
    );
  }
  if (details.length !== 0 && details.length !== chapters.length) {
    throw new Error(
      `Promo exclusion for ${sourceLabel} got ${chapters.length} chapter(s) but ${details.length} detail line(s) — ` +
        `details must be index-aligned with the chapters or absent entirely`
    );
  }

  const content: Chapter[] = [];
  const excluded: Chapter[] = [];
  const contentSubjects: string[] = [];
  const contentDetails: string[] = [];
  const warnings: string[] = [];
  const reasons: string[] = [];

  const phrases = promotedPhrases(promotedItems);
  chapters.forEach((chapter, i) => {
    const matched = promoMatch(chapter, phrases);
    if (matched) {
      excluded.push({ ...chapter, isPromo: true });
      reasons.push(`"${chapter.title}" (${chapter.timestamp}, matched "${matched}")`);
      return;
    }
    // The sliver warning (2026-08-24, measured on "3 - islam"): stage 1's prompt states a
    // half-minute floor for content chapters, and an 11-second orphan — an introduction a
    // promotion cut off from the thing it introduced — still slips through about one run in
    // four. Kept exactly as written (no merges, no re-asks); the warning is the operator's
    // pointer to the one chapter worth an eyeball. Promo chapters are exempt on purpose: a
    // 26-second plug is a legitimate chapter, which is why this sits AFTER the promo match.
    const span = spanSeconds(chapter);
    if (span !== null && span < 30) {
      warnings.push(
        `the chapter at ${chapter.timestamp} ("${chapter.title}") covers only ${span}s of video, under the ` +
          `half-minute floor the chapter prompt asks for — usually a few seconds of connective tissue the ` +
          `model cut loose; it is kept as written and worth an eyeball before publishing`
      );
    }
    content.push(chapter);
    contentSubjects.push(subjects[i]);
    contentDetails.push(details[i] || '');
  });

  if (excluded.length === 0) {
    return { content, excluded, contentSubjects, contentDetails, warnings };
  }

  // One line naming what left and why. It is an INFO, not a warning: excluding an ad is
  // the intended behaviour, and the two things below are the ones that cost the user
  // something.
  log.info(
    `[PromoChapters] ${sourceLabel}: excluded ${excluded.length} promo chapter(s) from the published list and from ` +
      `every task's conditioning — ads are not content: ${reasons.join('; ')}`
  );

  if (content.length === 0) {
    warnings.push(
      `every chapter this video produced was a promo (${reasons.join('; ')}), so no chapters were published and the ` +
        `rest of the metadata was generated WITHOUT chapter subjects`
    );
    return { content, excluded, contentSubjects, contentDetails, warnings };
  }

  // The video opens with a plug. The next chapter's real timestamp stays where the
  // pipeline measured it — YouTube simply will not build a chapter bar from a list whose
  // first entry is not 0:00, and the user needs to know that before they paste it.
  if (chapters[0].isPromo || promoMatch(chapters[0], phrases)) {
    warnings.push(
      `the video opens with a promo ("${chapters[0].title}"), which was excluded, so the chapter list now starts at ` +
        `${content[0].timestamp} instead of 0:00. YouTube only builds chapter markers when the first timestamp is ` +
        `0:00 — the timestamps were NOT rebased, because they are measured positions in this video`
    );
  }

  if (content.length < 3) {
    warnings.push(
      `YouTube needs 3+ timestamps for chapter markers; only ${content.length} content chapter(s) after excluding ads`
    );
  }

  return { content, excluded, contentSubjects, contentDetails, warnings };
}
