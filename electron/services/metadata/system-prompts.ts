/**
 * Centralized System Prompts
 * All hardcoded AI prompts in one place for easy editing
 */

export const SYSTEM_PROMPTS = {
  /**
   * Core JSON format enforcement - prepended to all metadata requests
   */
  JSON_SYSTEM: `Return a valid JSON object containing ONLY the fields requested below.
Use ASCII characters only. No markdown, no explanation - just the JSON object.`,

  /**
   * Compilation mode context
   * Placeholders: {sourceCount}, {contentTypes}
   */
  COMPILATION_CONTEXT: `
=== COMPILATION MODE ===
This is a COMPILATION of {sourceCount} separate items ({contentTypes}).

CRITICAL REQUIREMENTS:
1. For the TITLE: Pick the SINGLE most compelling item and base the title on that ONE subject.
   - DO NOT merge or blend subjects from different items into one title
   - Each item covers a SEPARATE topic - treat them as unrelated
   - Either use ONE item's subject OR use a generic compilation title (e.g., "3 Stories That...")
   - WRONG: "MAGA Influencer George Washington Is Weird" (merging two unrelated subjects)
   - CORRECT: "Glenn Beck's AI George Washington Is Unhinged" (one subject)
   - CORRECT: "3 Wild Political Stories You Need to See" (generic umbrella)

2. For the DESCRIPTION: Generate ONLY a bulleted list - nothing else!
   - NO intro paragraph before the list
   - NO outro paragraph after the list
   - ONLY the bulleted list itself
   - Use "-" prefix for each line
   - Write exactly {sourceCount} lines (one per item)
   - Each line: compelling one-sentence summary in your editorial voice
   - Keep each line to 10-15 words maximum

   CRITICAL: The order MUST match the ITEM numbers below!
   - Line 1 of your list = ITEM 1
   - Line 2 of your list = ITEM 2
   - And so on...

CORRECT DESCRIPTION FORMAT (just this, nothing else):
- Summary for ITEM 1 here
- Summary for ITEM 2 here
- Summary for ITEM 3 here

WRONG (do not do this):
Here's a compilation about religious grifters...  <-- NO intro text
- First bullet
- Second bullet
Watch these people embarrass themselves...  <-- NO outro text
===
`,

  /**
   * Chapter generation instructions - appended to instructions_prompt when chapters requested
   */
  CHAPTERS_INSTRUCTIONS: `
CHAPTERS:
- Generate 3-10 chapters based on major topic shifts and content segments
- Each chapter must be at least 10 seconds long (minimum gap between timestamps)
- Use clear, descriptive, keyword-rich titles that reflect the segment content
- Format as JSON array: [{"timestamp": "0:00", "title": "Introduction"}, {"timestamp": "5:23", "title": "Main Topic"}]
- First chapter MUST start at 0:00 (YouTube requirement)
- Avoid creating too many short chapters - focus on logical content divisions
- Space chapters evenly throughout the video based on natural topic transitions`,

  /**
   * Chapter generation from segments (for long videos with 20+ chunks)
   * Placeholder: {formattedText}
   */
  CHAPTER_SEGMENTS_PROMPT: `Based on these video segments, identify 3-8 chapter markers. Return JSON array:
[{"segment_id": 1, "title": "Chapter Title"}, ...]

Segments:
{formattedText}`,

  /**
   * Chapter generation from chunks (for shorter videos)
   * Placeholder: {formattedText}
   */
  CHAPTER_CHUNKS_PROMPT: `Based on these video timestamps, identify 3-8 chapter markers. Return JSON array:
[{"chunk_id": 1, "title": "Chapter Title"}, ...]

Chunks:
{formattedText}`,
};

/**
 * Helper to replace placeholders in prompts
 */
export function formatPrompt(
  prompt: string,
  replacements: Record<string, string | number>
): string {
  let result = prompt;
  for (const [key, value] of Object.entries(replacements)) {
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
  }
  return result;
}
