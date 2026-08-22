/**
 * Chapter Prompts — access to the embedding pipeline's two prompts
 *
 * THE BODIES MOVED. They are in electron/assets/prompts/shared/pipeline/chapters.yml now,
 * byte-identical, along with the header that records what they encode and why — the quoting
 * law, the one-thing-per-call law, the positive-form rule, and the stated leak risk that comes
 * with real names in the examples. Read them there before editing either one.
 *
 * What is left here is the ACCESS, as getters, so `CHAPTER_EMBEDDING_PROMPTS.PLACE_BOUNDARY`
 * reads exactly as it did. A missing file or key throws naming both (prompt-assets.ts). There
 * is no built-in copy of a chapter prompt anywhere: a substituted one would place boundaries
 * that look measured and were guessed.
 */

import { promptAssets } from './prompt-assets';

const CHAPTERS_FILE = 'chapters.yml';

export const CHAPTER_EMBEDDING_PROMPTS = {
  /**
   * Stage 4 — place ONE selected junction to the sentence it turns on.
   *
   * Placeholders: {title_context} (already rendered, may be empty), {window}
   */
  get PLACE_BOUNDARY(): string {
    return promptAssets().pipeline(CHAPTERS_FILE, 'place_boundary');
  },

  /**
   * Stage 6 — name and summarize ONE chapter, from its RAW transcript.
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
