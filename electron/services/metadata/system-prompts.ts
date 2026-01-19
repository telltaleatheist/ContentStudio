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
   * Chapter detection prompt - uses phrase-based timestamp mapping
   * Placeholder: {transcript}
   */
  CHAPTER_DETECTION_PROMPT: `Identify chapter boundaries based on MAJOR topic/subject changes in this transcript.

Rules:
- First chapter MUST start at the very beginning of the transcript
- Create a new chapter ONLY when there is a SIGNIFICANT topic shift (not minor tangents)
- Very short videos (under 5 minutes) may have just 1-2 chapters
- Longer videos should have 4-6 chapters maximum - prefer fewer, longer chapters
- Minimum chapter length: 3-4 minutes of content (be conservative - don't over-segment)
- If unsure whether something is a new chapter, keep it as part of the current one

Title requirements:
- Titles should be 50-80 characters - concise but descriptive
- Explain specifically what happens in this section
- Include key details: names, topics, actions
- Avoid generic labels like "Introduction", "Overview", "Conclusion"
- Write as complete thoughts, not fragments

Return JSON:
{"chapters": [{"start_phrase": "exact quote from transcript", "title": "Concise description"}]}

Important:
- start_phrase MUST be verbatim text copied from the transcript (3-8 words)
- The first chapter's start_phrase should be from the very beginning
- Each subsequent chapter's start_phrase marks where a new topic begins
- Chapters are sequential - each one ends where the next begins

Transcript:
{transcript}`,

  /**
   * Master section detection prompt - for analyzing long-form livestreams
   * Identifies distinct topic segments that could be separate videos
   * Placeholder: {transcript}
   */
  MASTER_SECTION_DETECTION_PROMPT: `Analyze this livestream transcript and identify the MAIN STORIES/SEGMENTS.

Your task is to find where the host completely changes to a NEW, UNRELATED story - not where they explore different angles of the SAME story.

Understanding story boundaries:
- A "story" is a self-contained narrative about one primary subject (a person, event, or news item)
- Everything discussed IN RESPONSE to that subject is part of the same story
- Example: If the host discusses "Streamer X's bad take" then pivots to "here's how Germany handled similar people historically" as commentary/response - that's still ONE story about Streamer X, not two separate stories
- Example: If the host shows multiple clips from the same person, that's ONE story about that person
- A NEW story begins when the host introduces a completely different subject that has no narrative connection to what came before

SKIP entirely:
- Stream intros, setup, greetings, technical stuff
- Breaks or meta-commentary about the stream itself

For each story, provide:
1. start_phrase: An exact quote (5-10 words) from where this story FIRST begins
2. title: The primary subject's name or a short topic label (e.g., "John Smith", "New Product Launch", "Breaking News Story")
3. description: 2-3 sentences summarizing what happens - who is discussed and what they did or said.

Return JSON:
{
  "sections": [
    {
      "start_phrase": "exact quote from transcript",
      "title": "Primary Subject Name",
      "description": "Summary of what this story covers..."
    }
  ]
}

Key principles:
- Think like an editor: each story should work as a standalone video
- Most livestreams have 4-8 distinct stories (occasionally up to 10, rarely fewer than 4)
- Stories are typically 10-30 minutes each, though some may be shorter (~6 min) or longer (up to an hour)
- If content is thematically connected to or a response to the current subject, it's part of the current story
- Only create a new section when there's a clear narrative break to an unrelated topic
- When uncertain, keep it as one story - fewer sections is better than over-segmenting

Transcript:
{transcript}`,
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
