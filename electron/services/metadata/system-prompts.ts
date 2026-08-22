/**
 * The pipeline system prompts, read from prompts/shared/pipeline/system.yml
 *
 * THIS FILE USED TO BE THE PROMPTS. It held ~200 lines of model-facing text as string
 * constants, which meant that reading what this app asks a model required opening a .ts file,
 * and editing it required a rebuild. The text now lives in the one prompt directory
 * (electron/assets/prompts/) and this module keeps only the ACCESS, so every existing call site
 * — `SYSTEM_PROMPTS.JSON_SYSTEM` and friends — reads unchanged.
 *
 * Each property is a GETTER that resolves through prompt-assets.ts on access. A missing file or
 * a missing key throws right there, naming both. Nothing here has a built-in copy to fall back
 * to, which is the point: a substituted prompt produces output that looks generated and was
 * written to no brief.
 */

import { promptAssets } from './prompt-assets';

const SYSTEM_FILE = 'system.yml';

export const SYSTEM_PROMPTS = {
  /** Core JSON format enforcement — prepended to all metadata requests. */
  get JSON_SYSTEM(): string {
    return promptAssets().pipeline(SYSTEM_FILE, 'json_system');
  },

  /** Compilation mode context. Placeholders: {sourceCount}, {contentTypes} */
  get COMPILATION_CONTEXT(): string {
    return promptAssets().pipeline(SYSTEM_FILE, 'compilation_context');
  },

  /**
   * Compilation mode instructions override, appended AFTER the assembled instructions to
   * replace the TITLES / DESCRIPTION / TAGS rules. Placeholder: {sourceCount}
   */
  get COMPILATION_INSTRUCTIONS_OVERRIDE(): string {
    return promptAssets().pipeline(SYSTEM_FILE, 'compilation_instructions_override');
  },

  /**
   * The chapter list, prepended to the metadata prompt's subject block.
   *
   * Not a hint — a measured table of contents, written span by span by the embedding pipeline,
   * and the most reliable statement of what the video contains that any later call gets.
   *
   * Placeholder: {chapterList}
   */
  get CHAPTER_SUBJECTS_CONTEXT(): string {
    return promptAssets().pipeline(SYSTEM_FILE, 'chapter_subjects_context');
  },

  /**
   * OUTPUT FORMAT for a single group, naming only that group's keys.
   *
   * A model told to return seven keys returns seven, and the six belonging to other units
   * would be thrown away or merged over another unit's real answer.
   *
   * Placeholder: {keyLines}
   */
  get TASK_OUTPUT_FORMAT(): string {
    return promptAssets().pipeline(SYSTEM_FILE, 'task_output_format');
  },

  /**
   * Fills the {subject} content slot for a group conditioned on the chapter list INSTEAD of
   * the transcript. Without it the "is this a transcript or a one-line topic" instruction
   * resolves the wrong way: the chapter block is short, so the model treats it as a bare topic
   * and refuses to be specific.
   */
  get TASK_CHAPTERS_ONLY_INPUT(): string {
    return promptAssets().pipeline(SYSTEM_FILE, 'task_chapters_only_input');
  },

  /** Episode boundaries in a multi-hour stream. Placeholders: {transcript}, {duration}, {episodeCount} */
  get EPISODE_SPLIT_PROMPT(): string {
    return promptAssets().pipeline(SYSTEM_FILE, 'episode_split');
  },
};

/**
 * Helper to replace placeholders in prompts.
 *
 * Function replacer, always: a plain string replacement would interpret $-patterns ($&, $', $`)
 * inside transcript text and corrupt the prompt.
 */
export function formatPrompt(
  prompt: string,
  replacements: Record<string, string | number>
): string {
  let result = prompt;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), () => String(value));
  }
  return result;
}
