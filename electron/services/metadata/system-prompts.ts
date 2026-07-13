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
   - Each line: compelling 1-2 sentence summary in your editorial voice
   - NEVER write "This compilation also covers..." or "This compilation includes..." or any sentence starting with "This compilation"
   - NEVER add any framing, context, or commentary around the bullets — output ONLY the bulleted lines

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
This compilation also covers Topic X...  <-- NO framing text
Watch these people embarrass themselves...  <-- NO outro text
===
`,

  /**
   * Compilation mode instructions override
   * Appended AFTER the prompt set's instructions_prompt to replace the
   * TITLES / DESCRIPTION / TAGS rules when in compilation mode.
   * Placeholder: {sourceCount}
   */
  COMPILATION_INSTRUCTIONS_OVERRIDE: `
## COMPILATION MODE OVERRIDES

This is a compilation of {sourceCount} separate items. The rules in this section REPLACE the TITLES, DESCRIPTION, and TAGS rules above. Every other section (thumbnail text, hashtags, pinned comment, chapters, output format, self-check) still applies unchanged.

TITLES (replaces the rules above):
- Generate 10 title options, 45-60 characters each
- Each title must focus on ONE specific item's subject OR use a generic umbrella title
- DO NOT merge/blend subjects from different items into one title
- Include a mix: some titles based on different items, some umbrella titles
- Example umbrella: "{sourceCount} Stories That Will Blow Your Mind" (illustration only — never output it verbatim)

DESCRIPTION (replaces the rules above):
- Generate ONLY a bulleted list using "-" prefix (no intro or outro text)
- Write exactly {sourceCount} bullet points (one per item, in ITEM order)
- Each bullet: compelling 1-2 sentence summary of that item's subject
- NEVER write "This compilation also covers..." or any framing text — ONLY output the bulleted lines

TAGS (replaces the rules above):
- 15-20 tags that reflect ALL {sourceCount} items in the compilation
- Include key names, topics, and themes from EACH item
- Mix of broad topics and specific phrases
- Format as comma-separated list
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
- Typical videos (30-60 minutes) should have 4-8 chapters - prefer fewer, longer chapters
- Multi-hour videos scale up: roughly one chapter per 10-20 minutes (use the [H:MM:SS] timestamps to judge total duration, and spread chapters across the ENTIRE runtime - do not stop partway)
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
- The transcript may be an evenly-sampled excerpt of the full video (some sentences omitted between lines) - quote start_phrase EXACTLY as it appears in the text provided, never bridge or paraphrase across gaps
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

  /**
   * Episode split prompt - for finding episode boundaries in multi-hour streams
   * The transcript comes from multiple sequential audio files concatenated with global timestamps
   * Placeholders: {transcript}, {duration}, {episodeCount}
   */
  EPISODE_SPLIT_PROMPT: `You are analyzing a transcript from a continuous multi-hour livestream (total duration: {duration}).
The stream was recorded in multiple sequential files that have been combined into one continuous transcript. Time markers in the form [H:MM:SS] (for example [1:35:00]) are inserted throughout the text every few minutes — each marks how far into the stream that point occurs. Use these markers to measure elapsed time and pace the episode boundaries.

Your task: Split this stream into approximately {episodeCount} episodes of roughly 1 hour each.

RULES FOR EPISODE BOUNDARIES:
1. Target duration: ~60 minutes per episode — use the [H:MM:SS] markers to gauge this
2. Maximum duration: 70 minutes (1 hour 10 minutes) - NEVER exceed this
3. SPREAD the boundaries across the ENTIRE runtime, all the way to {duration} - do not bunch them early or stop partway. Consecutive boundaries should sit roughly 60 minutes apart on the [H:MM:SS] markers, so every episode comes out roughly the same length (the shortest at least 70% as long as the longest).
4. Find natural topic/subject changes near each ~60-minute target
5. Look for verbal break cues where the host manually inserted break points:
   - "tell me what you think in the comments"
   - "this is [name] and he's/she's talking about [topic]" (intro patterns)
   - Sign-off phrases, outros, or transitions like "alright, moving on..."
   - "subscribe", "like and share", "see you next time" type phrases
   - Any clear verbal indication the host intended a break here
6. Prefer placing breaks at verbal cues even if the resulting episode is shorter than 60 minutes
7. The first episode MUST start at the very beginning of the transcript

For each episode provide:
1. start_phrase: An exact quote (5-10 words) of the SPOKEN words from where this episode begins in the transcript
2. title: A brief topic label or subject name for this episode segment
3. description: 1-2 sentences summarizing what this episode covers
4. verbal_cue_nearby: true/false - whether a verbal break cue was detected near this boundary

Return ONLY valid JSON:
{
  "episodes": [
    {
      "start_phrase": "exact quote from transcript",
      "title": "Episode Topic",
      "description": "Summary of what this episode covers...",
      "verbal_cue_nearby": false
    }
  ]
}

CRITICAL RULES:
- start_phrase MUST be verbatim spoken text copied from the transcript (5-10 consecutive words)
- NEVER quote a [H:MM:SS] time marker as a start_phrase - those are inserted markers, not spoken words. Quote the actual words spoken at that point instead.
- The transcript may be an evenly-sampled excerpt (some sentences omitted between lines) - quote start_phrase EXACTLY as it appears in the text provided, never bridge or paraphrase across gaps
- The first episode's start_phrase should be from the very beginning of the transcript
- DO NOT paraphrase or modify the text - copy EXACTLY as written
- Episodes are sequential - each one ends where the next begins
- The last episode ends at the end of the stream
- Output valid JSON only, no markdown or extra text

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
    // Function replacer: a plain string replacement would interpret $-patterns
    // ($&, $', $`) inside transcript text and corrupt the prompt.
    result = result.replace(new RegExp(`\\{${key}\\}`, 'g'), () => String(value));
  }
  return result;
}
