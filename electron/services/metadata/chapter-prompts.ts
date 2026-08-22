/**
 * Chapter Prompts — the embedding pipeline's two prompts
 *
 * This file used to hold three prompt sets for three chaptering architectures: the sealed
 * 14B method's five (label / rate / place / summarize / consolidate), the 27B single call's
 * pair, and these two. Both of the others were DELETED on 2026-08-22 along with the code
 * that sent them, when the embedding pipeline stopped being one option among three and
 * became the only way chapters are made. A prompt nothing sends is not documentation, it is
 * a second answer to a question that now has one.
 *
 * What the deleted sets taught, which these two inherit and must keep:
 *
 * - No call ever sees a list, a count, or the whole video. PLACE_BOUNDARY sees ~90 seconds
 *   around ONE junction; SUMMARIZE_CHAPTER sees ONE chapter. The code does all the counting,
 *   ranking, spacing and assembling.
 * - The model NEVER emits a timestamp. It quotes a verbatim sentence and code maps that
 *   quote to a time against the caption word stream (chapter-transcript.ts). An invented
 *   timestamp is a guess; a mapped quote is a measurement.
 * - The summarize call reads the chapter's RAW transcript, never an intermediate label, and
 *   is given the video title and the previous chapter's summary as its only outside context.
 *
 * TWO RULES CHANGED ON 2026-08-22 (this build), and the second one reverses the first:
 *
 * - POSITIVE FORM ONLY. These bodies state the style that is wanted and show correct
 *   examples. They no longer name a wrong form anywhere — no "never say the speaker", no
 *   contrast pair, no list of banned words. Operator's ruling, and the mechanism behind it is
 *   the same one the next bullet describes: a model shown a form reproduces it, and that does
 *   not stop being true because the prompt attached the word "never" to it. The register
 *   failure this replaced ("The speaker debunks ...", "A YouTuber critiques ...") is now
 *   caught in CODE, after the fact, by chapter-title-quality.ts — one re-ask, then a declared
 *   warning, never a rewrite.
 * - REAL NAMES IN THE EXAMPLES, WITH THE RISK STATED. The examples above used to be invented
 *   and neutral-domain, because a prompt example naming a real person leaks into outputs
 *   about a DIFFERENT unnamed person of the same archetype, deterministically, at temperature
 *   0 — "Alex Jones on Sandy Hook" once shipped in here and surfaced in labels for spans that
 *   never mentioned him. The operator supplied his own corrected titles as the target register
 *   and directed that they be used verbatim, so "Gene Bailey", "Luke 19:13", "Jabez" and
 *   "D.L. Moody" are now in the prompt and CAN leak the same way. What makes that a managed
 *   risk rather than a repeat of the old bug: the grounding check added in this build tests
 *   every proper noun in a returned title against that chapter's own transcript, so a leaked
 *   "Gene Bailey" is now DETECTED — re-asked once and then reported in the run's warnings —
 *   instead of shipping unnoticed. If those warnings start naming these example names on
 *   unrelated videos, that is the leak, and the fix is to replace the examples with the
 *   operator rather than to add a ban list.
 */

/**
 * The embedding pipeline's two prompts (2026-08-22).
 *
 * Both bodies are copied from the portable handoff document that is their authority —
 * /Volumes/Callisto/Projects/Briefcase/docs/chapter-pipeline-handoff.md, §3.4 and §8 —
 * which validated them in Briefcase in August 2026 on real broadcast content. The only
 * edits are ContentStudio's `{placeholder}` convention (formatPrompt) in place of the
 * reference implementation's template literals.
 *
 * The laws in this file's header — quote instead of timestamping, one thing per call,
 * positive form only — are all live in these bodies. Read them there before editing either
 * one.
 */
export const CHAPTER_EMBEDDING_PROMPTS = {
  /**
   * Stage 4 — place ONE selected junction to the sentence it turns on.
   *
   * §3.4 verbatim. Every rule in it is load-bearing; the multi-change paragraph in
   * particular exists because a 90-second window sometimes contains several transitions
   * ("we'll be right back" + ad #1 + ad #2) and models otherwise pick one arbitrarily.
   *
   * Placeholders: {title_context} (already rendered, may be empty), {window}
   */
  PLACE_BOUNDARY: `Below is one stretch of a video transcript. Somewhere inside it the speaker moves from one subject to the next.
{title_context}
TRANSCRIPT:
{window}

Find where the handover BEGINS — the first sentence a viewer would want to land on if they clicked a chapter marker here.

That is the sentence where the speaker TURNS AWAY from the old subject, which is usually a beat EARLIER than the sentence that first explains the new one. If the speaker says "anyway, let's talk about X" and then explains X three sentences later, the turn is "anyway, let's talk about X" — quote that, not the explanation. A viewer dropped at the explanation has already missed the start.

Prefer, in this order:
1. the sentence where the speaker announces, introduces or turns toward the new subject
2. the sentence where the speaker closes off the old subject, if the turn is not announced
3. the first sentence that is plainly about the new subject, if there is no turn at all

If the transcript contains MORE THAN ONE subject change, pick the one nearest the MIDDLE of the excerpt — the excerpt is centered on the boundary being placed, so changes near its edges belong to neighboring chapters, not this one.

Copy the sentence EXACTLY as it appears above, word for word, at least six words, no timestamps and no tidying up. That quote is what fixes the chapter's start time to the second, so a quote you reworded points at the wrong moment.

Output exactly this shape and nothing else:
{"quote": "<exact sentence from the transcript above>"}`,

  /**
   * Stage 6 — name and summarize ONE chapter, from its RAW transcript.
   *
   * §8's law, which is the difference between chapters worth reading and "man yells
   * about conspiracies": the summarizing model reads what was actually SAID in the
   * chapter, never an intermediate label, plus two pieces of real context — the video's
   * title or filename (who is speaking and why) and the PREVIOUS chapter's summary
   * (so "back to what we discussed" resolves, and titles do not repeat).
   *
   * The naming rules below the JSON shape are ContentStudio's own. They are what keeps a
   * chapter marker off a filler word and onto the subject matter, and they are stated as
   * what to DO — the "specifically enough that it could not be swapped with a chapter of any
   * other video" line replaced a list of forbidden headings, for the reason in the header.
   *
   * The REGISTER rule is not cosmetic. Left to itself the model writes "The speaker discusses
   * mainstream alien belief" or "A YouTuber critiques Gene Bailey's chapter" — sentences whose
   * subject it invented. It cannot know who is speaking: on this channel the voice in any
   * given second is either the creator or the footage he is reacting to, and the transcript
   * does not always say which. The fix here is a register and four correct examples; the
   * check that the register held is in chapter-title-quality.ts, in code, and it triggers one
   * re-ask and then a declared warning.
   *
   * `{entity_scaffold}` is spec §6.1 lever 3: the proper nouns extracted from THIS chapter's
   * own transcript slice (entity-extraction.ts), per-chapter and never whole-video, because a
   * whole-video list invites the name from chapter 2 into the title of chapter 5. It is
   * already rendered by the caller and is empty when the slice yielded nothing.
   *
   * Placeholders: {number}, {video}, {context_lines} (already rendered, may be empty),
   * {entity_scaffold} (already rendered, may be empty), {transcript}
   */
  SUMMARIZE_CHAPTER: `Label chapter {number} of a video transcript. Output JSON only.
Video: {video}
{context_lines}
Produce:
- title: one sentence (max ~15 words) naming what this chapter is about.
- summary: 2-3 sentences on what this stretch of the video covers.

How to write the title:
- Title the CONTENT itself, in topic form: a bare noun phrase, or a gerund phrase. Build it around the specific people, claims and events this chapter's transcript contains.
- Titles in exactly the right form:
  - "Gene Bailey's chapter on Christian nationalist action and the David and Goliath framing"
  - "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory"
  - "Gene Bailey's use of Jabez, D.L. Moody, and Isaiah to justify Christian political takeover"
  - "Roswell and the UAP disclosure order"
- Every name in your answer comes from the transcript below. Where the transcript names a person, organisation, story or claim, put that name in the title; where it says only "the mayor", the title says "the mayor".
- Where a stretch is somebody's response to something rather than a claim of its own, title the claim and the response as content: "The bridge contract claim, rebutted"; "Patreon plug and a promotion of the book Was Hitler an Atheist"; "Sign-off and a book promotion".

How to write the summary:
- The same topic form as the title, in 2-3 sentences: the claims, the people named in the transcript, and what is said about them.
- Cover the whole chapter. Where it moves through more than one thing, say what it spends most of itself on.

For both fields:
- Say what is there, plainly. Straight description, no colons, no part numbers.
- Name the concrete subject matter of this stretch specifically enough that the answer could not be swapped with a chapter of any other video.
- A sponsor read, a Patreon plug, a channel promo or a sign-off simply says that is what it is.
{entity_scaffold}
Output exactly this shape and nothing else:
{
  "title": "...",
  "summary": "..."
}

TRANSCRIPT:
{transcript}`,

  /**
   * The same call for a transcript that knows who is speaking.
   *
   * ContentStudio's imported AutoCutStudio transcripts carry a HOST/CLIP side per caption
   * (a plain Whisper run does not). Untagged, a summarizer cannot tell the host's verdict
   * from the claim being played and inverts attribution — the sealed pipeline's stage 4
   * was measured doing exactly that, naming the host as the subject of a chapter where he
   * was the one objecting. This body is the untagged one plus the two lines that fix it,
   * and it runs ONLY when every caption resolves to a side.
   *
   * Placeholders: {number}, {video}, {context_lines}, {entity_scaffold}, {transcript}
   */
  SUMMARIZE_CHAPTER_TAGGED: `Label chapter {number} of a video transcript. Output JSON only.
Video: {video}
{context_lines}
The transcript below is tagged by speaker. HOST: is the creator of this video talking. CLIP: is footage he is playing and reacting to — those words are somebody else's, and the claims in them are not his.

Produce:
- title: one sentence (max ~15 words) naming what this chapter is about.
- summary: 2-3 sentences on what this stretch of the video covers.

How to write the title:
- Title the CONTENT itself, in topic form: a bare noun phrase, or a gerund phrase. Build it around the specific people, claims and events this chapter's transcript contains.
- Titles in exactly the right form:
  - "Gene Bailey's chapter on Christian nationalist action and the David and Goliath framing"
  - "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory"
  - "Gene Bailey's use of Jabez, D.L. Moody, and Isaiah to justify Christian political takeover"
  - "The bridge contract claim, rebutted"
- Every name in your answer comes from the transcript below. Where the transcript names a person, organisation, story or claim, put that name in the title; where it says only "the mayor", the title says "the mayor".
- Where a stretch is somebody's response to something rather than a claim of its own, title the claim and the response as content: "The bridge contract claim, rebutted"; "Patreon plug and a promotion of the book Was Hitler an Atheist"; "Sign-off and a book promotion".

How to use the tags:
- A claim in a CLIP line belongs to the footage; the HOST lines are the response to it. Write the chapter around the claim that is actually being made and the response it gets, in that relation.
- Where the HOST lines reach a verdict, carry it — as the content it is ("the bridge contract claim, rebutted").

How to write the summary:
- The same topic form as the title, in 2-3 sentences: the claims, the people named in the transcript, and what is said about them.
- Cover the whole chapter. Where it moves through more than one thing, say what it spends most of itself on.

For both fields:
- Say what is there, plainly. Straight description, no colons, no part numbers.
- Name the concrete subject matter of this stretch specifically enough that the answer could not be swapped with a chapter of any other video.
- A sponsor read, a Patreon plug, a channel promo or a sign-off simply says that is what it is.
{entity_scaffold}
Output exactly this shape and nothing else:
{
  "title": "...",
  "summary": "..."
}

TRANSCRIPT:
{transcript}`,
};
