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
 */

// TYPE-ONLY, and deliberately: metadata-tasks.ts imports `FieldContentMode` from this file and
// ai-manager.service.ts imports metadata-tasks, so a value import of the chapter service or of
// the tasks module here would close a require() cycle. `import type` is erased at compile time.
import type { Chapter } from './chapter-generator.service';
import { SYSTEM_PROMPTS, formatPrompt } from './system-prompts';
import { DIRECT_PASS_MAX_CHARS, directPassesRaw } from './ai-manager.service';

/** Which of the two declared modes an item's content slot is in. */
export type FieldContentMode = 'raw-transcript' | 'chapter-digest';

export interface FieldContentDecision {
  mode: FieldContentMode;
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
 */
export function resolveFieldContent(options: {
  transcript: string;
  sourceLabel: string;
  ceiling: 'local' | 'cloud';
  chapters: DigestChapter[];
}): FieldContentDecision {
  const { transcript, sourceLabel, ceiling, chapters } = options;
  const max = DIRECT_PASS_MAX_CHARS[ceiling];

  if (directPassesRaw({ chars: transcript.length, ceiling })) {
    return { mode: 'raw-transcript', content: transcript, declaration: '' };
  }

  if (chapters.length === 0) {
    throw new Error(
      `${sourceLabel}: its transcript is ${transcript.length} characters, over the ${max}-character ` +
        `${ceiling} direct-pass ceiling, AND this item has no chapter list — so there is nothing to give ` +
        `the field calls. The chapter digest is the only condensation this pipeline makes (the ` +
        `transcript summarizer was retired from this path on 2026-08-23, operator's ruling), and it ` +
        `needs chapters. Either the chapters have to be produced for this item, or the fields have to ` +
        `be routed somewhere the whole transcript fits. Nothing was summarized or truncated for you.`
    );
  }

  const content = renderChapterDigest(chapters);
  const declaration =
    `${sourceLabel}: the transcript is ${transcript.length} chars, over the ${max}-char ${ceiling} ` +
    `direct-pass ceiling, so the content fields read the chapter digest ` +
    `(${chapters.length} chapters, ${content.length} chars); verbatim phrasing is preserved inside ` +
    `each chapter's own detail, which was written from that chapter's raw transcript`;

  return { mode: 'chapter-digest', content, declaration };
}

/** The digest form of a pipeline `Chapter[]`, which carries more fields than the digest reads. */
export function digestChaptersOf(chapters: Chapter[] | undefined): DigestChapter[] {
  return (chapters || []).map((c) => ({ timestamp: c.timestamp, title: c.title, detail: c.detail }));
}
