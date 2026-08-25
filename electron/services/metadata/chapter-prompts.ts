/**
 * Chapter Prompts — access to the chapter pipeline's three prompts
 *
 * THE BODIES ARE NOT HERE. They are in electron/assets/prompts/shared/pipeline/chapters.yml,
 * which carries the bodies and nothing else. What they encode and why — the quoting law, the
 * count-is-the-model's law, the positive-form rule, and the stated leak risk that comes with
 * real names in the examples — is in PROMPT-LEARNINGS.md at the repo root. Read both before
 * editing any of them.
 *
 * What is left here is the ACCESS, as getters, so `CHAPTER_PROMPTS.SUMMARIZE_CHAPTER` reads as
 * a constant does. A missing file or key throws naming both (prompt-assets.ts). There is no
 * built-in copy of a chapter prompt anywhere: a substituted one would produce chapters that
 * look measured and were guessed.
 */

import { promptAssets } from './prompt-assets';

const CHAPTERS_FILE = 'chapters.yml';

/**
 * What stage 1 is detecting — the operator's pick, made at queue time (LEDGER #170).
 * 'detailed' is the default: a standalone video's internal turns. 'broad' is the same
 * subject in larger pieces. 'stories' is for compilations — a run of separate stories.
 * The model decides the count inside the selected grain's band; code counts nothing.
 */
export type ChapterGrain = 'detailed' | 'broad' | 'stories';

const GRAIN_KEYS: Record<ChapterGrain, string> = {
  detailed: 'whole_transcript_detailed',
  broad: 'whole_transcript_broad',
  stories: 'whole_transcript_stories',
};

export const CHAPTER_PROMPTS = {
  /**
   * Stage 1 — read the whole transcript in ONE call and report the chapters in it, at the
   * operator's grain. An unknown grain throws — there is no quiet fallback body.
   *
   * Placeholders: {duration} (the runtime in words), {promoted_items}, {transcript}
   */
  wholeTranscript(grain: ChapterGrain): string {
    const key = GRAIN_KEYS[grain];
    if (!key) throw new Error(`unknown chapter grain "${grain}" — expected detailed, broad, or stories`);
    return promptAssets().pipeline(CHAPTERS_FILE, key);
  },

  /**
   * Stage 3 — describe ONE chapter, from its RAW transcript. Its `title` is read only for a
   * chapter stage 1 did not label; see THE TITLE RULE in chapter-whole-transcript.service.ts.
   *
   * Placeholders: {number}, {video}, {context_lines} (already rendered, may be empty),
   * {entity_scaffold} (already rendered, may be empty), {transcript}
   */
  get SUMMARIZE_CHAPTER(): string {
    return promptAssets().pipeline(CHAPTERS_FILE, 'summarize_chapter');
  },

  /**
   * The same call for a transcript that knows who is speaking (imported AutoCutStudio
   * transcripts carry a HOST/CLIP side per caption). Runs ONLY when every caption resolves to
   * a side.
   *
   * Placeholders: {number}, {video}, {context_lines}, {entity_scaffold}, {transcript}
   */
  get SUMMARIZE_CHAPTER_TAGGED(): string {
    return promptAssets().pipeline(CHAPTERS_FILE, 'summarize_chapter_tagged');
  },
};
