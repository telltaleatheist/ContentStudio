/**
 * Chapter Prompts — access to the chapter pipeline's three prompts
 *
 * THE BODIES ARE NOT HERE. They are in electron/assets/prompts/shared/pipeline/chapters.yml,
 * along with the header that records what they encode and why — the quoting law, the
 * count-is-the-model's law, the positive-form rule, and the stated leak risk that comes with
 * real names in the examples. Read them there before editing any of them.
 *
 * What is left here is the ACCESS, as getters, so `CHAPTER_PROMPTS.SUMMARIZE_CHAPTER` reads as
 * a constant does. A missing file or key throws naming both (prompt-assets.ts). There is no
 * built-in copy of a chapter prompt anywhere: a substituted one would produce chapters that
 * look measured and were guessed.
 */

import { promptAssets } from './prompt-assets';

const CHAPTERS_FILE = 'chapters.yml';

export const CHAPTER_PROMPTS = {
  /**
   * Stage 1 — read the whole transcript in ONE call and report the chapters in it.
   *
   * Placeholders: {duration} (the runtime in words), {transcript}
   */
  get WHOLE_TRANSCRIPT_CHAPTERS(): string {
    return promptAssets().pipeline(CHAPTERS_FILE, 'whole_transcript_chapters');
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
