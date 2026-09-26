/**
 * What the per-item field calls READ when the transcript does not fit.
 *
 * THE RULE, in the operator's words (2026-08-23): "I don't want summaries. We should try to
 * pass the whole thing in. If we're using summaries instead then it should be in the form of
 * chapters being passed in."
 *
 * So there are exactly two content modes on the per-item metadata path, and both are declared:
 *
 *   raw-transcript — the transcript is at or under the applicable direct-pass ceiling
 *     (ai-manager.service.ts DIRECT_PASS_MAX_CHARS: cloud 400k, local 90k) and reaches every
 *     field call BYTE FOR BYTE. The ordinary case, and since the cloud ceiling moved to 400k
 *     on 2026-08-23 it is very nearly the only case on a cloud-routed run.
 *
 *   chapter-digest — the transcript is over the ceiling, so the field calls read the chapter
 *     list instead: every chapter, its timestamp, its title and its detail paragraph.
 *
 * WHY THE DIGEST AND NOT A SUMMARY. The digest is a condensation the run has ALREADY paid for,
 * and it was produced the right way round. The chapter pipeline runs BEFORE any field call, and
 * each chapter's 20-45 word detail is written by its own call reading THAT CHAPTER'S RAW
 * TRANSCRIPT (CHAPTERING.md; LEDGER II-A #11) — so the names, claims and numbers inside a detail
 * came out of the video's own words. The blind chunk summarizer this replaces did the opposite:
 * it sliced the transcript at a fixed character count with no regard for where the video turns,
 * and its own log line admitted the cost — "verbatim quotes and phrasing do not survive that
 * step." Two condensations, one of them free and structurally better, and the pipeline was
 * paying for the worse one.
 *
 * WHAT THIS MODULE WILL NOT DO. There is no third mode. An item that is over the ceiling and has
 * NO chapters has no condensation left that anyone has agreed to, and inventing one — truncating
 * the transcript, or re-introducing the summarizer for "just this case" — is Law 1's fallback.
 * `resolveFieldContent` throws instead, naming BOTH facts, because either one alone is normal:
 * chapterless items are routine (a typed text subject, a plain transcript file with no
 * timestamps), and over-ceiling items are routine (a six-hour livestream). It is the pair that
 * has no answer.
 *
 * WHAT STILL SUMMARIZES. Compilation mode, and only compilation mode — see
 * `AIManagerService.summarizeTranscript` and metadata-routing.ts SUMMARIZATION_MODEL.
 *
 * THE INPUT POLICY (P4, CRUCIBLE-MIGRATION-PLAN.md 7.2, LEDGER #196). Which of the two modes an
 * item lands in is decided by a declared policy, stated per run:
 *
 *   raw     — the rule above, and the DEFAULT: the raw transcript until it is over the ceiling,
 *             then the digest; chapterless AND over the ceiling fails naming both facts.
 *   digest  — `digest-default`: every CHAPTERED item's field calls (titles, description, tags,
 *             thumbnail text, pinned comment) read the chapter digest whatever the transcript's
 *             length, so a local call stays near 8k instead of carrying the whole video. A
 *             chapterless item keeps the raw transcript (there is nothing else to stand on), and
 *             chapterless over the ceiling still fails naming both facts.
 *
 * The default switches to `digest` only on Owen's verdict from the plan 7.4 A/B (full transcript
 * vs digest, blind, on his videos). Until then `digest` is a store key (`fieldInput`) and the
 * test CLI's `--field-input digest`, never a Settings control (LEDGER #214).
 */

// TYPE-ONLY, and deliberately: metadata-tasks.ts imports `FieldContentMode` from this file and
// ai-manager.service.ts imports metadata-tasks, so a value import of the chapter service or of
// the tasks module here would close a require() cycle. `import type` is erased at compile time.
import type { Chapter } from './chapter-generator.service';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';
import { DIRECT_PASS_MAX_CHARS, directPassesRaw } from './ai-manager.service';

/** Which of the two declared modes an item's content slot is in. */
export type FieldContentMode = 'raw-transcript' | 'chapter-digest';

/** The input policy a run states (see the header): today's rule, or the digest for every chaptered item. */
export type FieldInputPolicy = 'raw' | 'digest';

export const FIELD_INPUT_POLICIES: readonly FieldInputPolicy[] = ['raw', 'digest'];

/** The default, stated once: today's rule. It moves only on Owen's verdict (plan 7.4). */
export const DEFAULT_FIELD_INPUT_POLICY: FieldInputPolicy = 'raw';

/**
 * The run's policy from what the caller stated (the store's `fieldInput`, or the CLI flag), and
 * the line that says which one ran and why (Law 8). Absent means the default, SAID; a value this
 * build does not know is refused by name, never read as the default.
 */
export function resolveFieldInputPolicy(stated: unknown, source: string): { policy: FieldInputPolicy; line: string } {
  if (stated === undefined || stated === null) {
    return {
      policy: DEFAULT_FIELD_INPUT_POLICY,
      line:
        `field input policy "${DEFAULT_FIELD_INPUT_POLICY}" (the declared default; ${source} states none): ` +
        `each item's fields read its raw transcript unless it is over the direct-pass ceiling`,
    };
  }
  if (stated !== 'raw' && stated !== 'digest') {
    throw new Error(
      `unknown field input policy ${JSON.stringify(stated)} from ${source} — expected ${FIELD_INPUT_POLICIES.join(' or ')}`
    );
  }
  return {
    policy: stated,
    line:
      stated === 'digest'
        ? `field input policy "digest" (stated by ${source}): every chaptered item's fields read its chapter ` +
          `digest; a chapterless item keeps its raw transcript`
        : `field input policy "raw" (stated by ${source}): each item's fields read its raw transcript unless it ` +
          `is over the direct-pass ceiling`,
  };
}

export interface FieldContentDecision {
  mode: FieldContentMode;
  /** The policy this decision was made under. */
  policy: FieldInputPolicy;
  /** Exactly what goes into `MetadataRunContext.content`. */
  content: string;
  /**
   * The DECLARATION (Law 8), or empty on the raw path.
   *
   * A statement of a mode this pipeline has, not an apology for one it fell into: it names the
   * measurement, the ceiling, what the field calls are reading instead, and what survives. The
   * caller logs it and pushes it into the run's warnings, which is where the operator reads
   * what happened to an item after the fact.
   */
  declaration: string;
}

/**
 * One chapter, as the digest renders it. The subset of `Chapter` this needs, spelled out so the
 * renderer can be exercised without building a whole pipeline result.
 */
export interface DigestChapter {
  timestamp: string;
  title: string;
  detail?: string;
}

/**
 * The digest text itself: the chapter list, each chapter's own paragraph indented under it.
 *
 * The prose around it is an ASSET (prompts/shared/pipeline/system.yml `chapter_digest`), per
 * Law 2 — this function assembles the list and fills one slot, and authors nothing.
 *
 * A chapter whose detail call could not describe it renders as its title alone. That is already
 * a declared degradation of the chapter pipeline (it warns and carries the chapter with no
 * detail), and dropping the chapter here would take a span of the video out of the digest to
 * punish a missing sentence.
 */
export function renderChapterList(chapters: DigestChapter[]): string {
  if (chapters.length === 0) {
    throw new Error('renderChapterList was called with no chapters; the caller decides that case, not this');
  }
  return chapters
    .map((chapter, i) => {
      const detail = (chapter.detail || '').trim();
      const head = `${i + 1}. ${chapter.timestamp} - ${chapter.title}`;
      return detail ? `${head}\n   ${detail}` : head;
    })
    .join('\n');
}

export function renderChapterDigest(chapters: DigestChapter[]): string {
  return formatPrompt(SYSTEM_PROMPTS.CHAPTER_DIGEST, { chapterList: renderChapterList(chapters) });
}

/**
 * Decide, once, what one item's field calls read — and say so.
 *
 * `chapters` is the item's PUBLISHED chapter list (promos already excluded), so the digest and
 * the chapter list under the video are the same list. Empty means the pipeline produced none:
 * no timestamped transcript, fewer than three chapters, all-promo, or a failure the item
 * already recorded in `chaptersSkipped`.
 *
 * `policy` is REQUIRED: the caller resolved it once for the run (resolveFieldInputPolicy) and
 * said which; this function never assumes one.
 */
export function resolveFieldContent(options: {
  transcript: string;
  sourceLabel: string;
  ceiling: 'local' | 'cloud';
  chapters: DigestChapter[];
  policy: FieldInputPolicy;
}): FieldContentDecision {
  const { transcript, sourceLabel, ceiling, chapters, policy } = options;
  if (policy !== 'raw' && policy !== 'digest') {
    throw new Error(`resolveFieldContent for ${sourceLabel} was given the field input policy ${JSON.stringify(policy)}`);
  }
  const max = DIRECT_PASS_MAX_CHARS[ceiling];
  const fits = directPassesRaw({ chars: transcript.length, ceiling });

  if (chapters.length === 0) {
    if (fits) {
      // Both policies read a chapterless item raw: there is no digest to read. Under `digest` the
      // run asked for something this item cannot give, so that is said; under `raw` it is the
      // ordinary case and says nothing.
      return {
        mode: 'raw-transcript',
        policy,
        content: transcript,
        declaration:
          policy === 'digest'
            ? `${sourceLabel}: field input policy "digest", and this item has no chapter list, so its content ` +
              `fields read the raw transcript (${transcript.length} chars), as every chapterless item does`
            : '',
      };
    }
    throw new Error(
      `${sourceLabel}: its transcript is ${transcript.length} characters, over the ${max}-character ` +
        `${ceiling} direct-pass ceiling, AND this item has no chapter list — so there is nothing to give ` +
        `the field calls. The chapter digest is the only condensation this pipeline makes (the ` +
        `transcript summarizer was retired from this path on 2026-08-23, operator's ruling), and it ` +
        `needs chapters. Either the chapters have to be produced for this item, or the fields have to ` +
        `be routed somewhere the whole transcript fits. Nothing was summarized or truncated for you.`
    );
  }

  if (policy === 'raw' && fits) {
    return { mode: 'raw-transcript', policy, content: transcript, declaration: '' };
  }

  const content = renderChapterDigest(chapters);
  const why = fits
    ? `field input policy "digest": the content fields read the chapter digest in place of the ` +
      `${transcript.length}-char transcript, which is under the ${max}-char ${ceiling} direct-pass ceiling`
    : `the transcript is ${transcript.length} chars, over the ${max}-char ${ceiling} direct-pass ceiling, so ` +
      `the content fields read the chapter digest` +
      (policy === 'digest' ? ` (field input policy "digest" reads it either way)` : '');
  const declaration =
    `${sourceLabel}: ${why} (${chapters.length} chapters, ${content.length} chars); verbatim phrasing is ` +
    `preserved inside each chapter's own detail, which was written from that chapter's raw transcript`;

  return { mode: 'chapter-digest', policy, content, declaration };
}

/** The digest form of a pipeline `Chapter[]`, which carries more fields than the digest reads. */
export function digestChaptersOf(chapters: Chapter[] | undefined): DigestChapter[] {
  return (chapters || []).map((c) => ({ timestamp: c.timestamp, title: c.title, detail: c.detail }));
}
