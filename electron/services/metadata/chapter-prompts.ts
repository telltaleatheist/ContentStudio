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
 * - The examples are invented and neutral-domain on purpose. A prompt example naming a real
 *   person leaks into outputs about a DIFFERENT unnamed person of the same archetype,
 *   deterministically, at temperature 0. "Alex Jones on Sandy Hook" once shipped in here and
 *   surfaced in labels for spans that never mentioned him; Mayor Ellison is invented, and
 *   the summarize prompt says so inside itself because the inoculation alone did not hold.
 * - The summarize call reads the chapter's RAW transcript, never an intermediate label, and
 *   is given the video title and the previous chapter's summary as its only outside context.
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
 * The three laws in this file's header — quote instead of timestamping, one thing per
 * call, invented examples only — are all live in these bodies. Read them there before
 * editing either one.
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
   * The naming rules below the JSON shape are ContentStudio's own, carried over from the
   * deleted pipeline's stage-4 prompt: they are what keeps a chapter marker out of
   * "Introduction / Overview / Conclusion" and out of names the transcript never contained.
   *
   * The REGISTER rule at the top of that list was added 2026-08-22 and is not cosmetic. Left
   * to itself the model writes "The speaker discusses mainstream alien belief, Roswell, and
   * Trump's UAP disclosure order" — a sentence whose subject it invented. It cannot know who
   * is speaking: on this channel the voice in any given second is either the creator or the
   * footage he is reacting to, and the transcript does not always say which. The fix is a
   * register, not a banned-word check: asked for topic and noun-phrase form, the phrasing
   * never arises, and nothing has to police the output afterwards.
   *
   * Placeholders: {number}, {video}, {previous_context} (already rendered, may be empty),
   * {transcript}
   */
  SUMMARIZE_CHAPTER: `Label chapter {number} of a video transcript. Output JSON only.
Video: {video}
{previous_context}
Produce:
- title: one sentence (max ~15 words) naming what this chapter is about.
- summary: 2-3 sentences on what this stretch of the video covers.

Rules for both fields:
- Write about the CONTENT, in topic and noun-phrase form: "Roswell and the UAP disclosure order", "Discussion of mainstream alien belief". Never invent a subject to attribute it to — no "the speaker", "the host", "the narrator", "the creator", "this video", and no bare "he" or "she" standing in for whoever is talking. You cannot tell from a transcript who is speaking at any moment, the answer changes from line to line, and a viewer reading a chapter marker can already see who is on screen.
- Name the person, organisation, story or claim IF this chapter's transcript names one — "Mayor Ellison on the bridge contract scandal", not "a local corruption argument". (Ellison is invented for this instruction — never copy a name from these instructions into your answer.) That is a real name from the content and is exactly what is wanted; it is the opposite of inventing an unnamed speaker.
- Never mention a person, group or story this chapter's own transcript does not, not even one you are sure of from outside knowledge. If it only ever says "the mayor", write "the mayor".
- Cover the whole chapter, not just its opening. Where it moves through more than one thing, name what it spends most of itself on.
- Say what is there, plainly. No headline writing, no teasing, no colons, no "Part 1".
- Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis", "Continued", "More on this".
- A sponsor read, a Patreon plug, a channel promo or a sign-off should simply say that is what it is.

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
   * Placeholders: {number}, {video}, {previous_context}, {transcript}
   */
  SUMMARIZE_CHAPTER_TAGGED: `Label chapter {number} of a video transcript. Output JSON only.
Video: {video}
{previous_context}
The transcript below is tagged by speaker. HOST: is the creator of this video talking. CLIP: is footage he is playing and reacting to — those words are somebody else's, and the claims in them are not his.

Produce:
- title: one sentence (max ~15 words) naming what this chapter is about.
- summary: 2-3 sentences on what this stretch of the video covers.

Rules for both fields:
- Write about the CONTENT, in topic and noun-phrase form: "Roswell and the UAP disclosure order", "Rebuttal of the bridge contract claim". Never invent a subject to attribute it to — no "the speaker", "the host", "the narrator", "the creator", "this video", and no bare "he" or "she" standing in for whoever is talking. The tags below tell you which SIDE a line came from, which is not the same as knowing who said it, and a viewer reading a chapter marker can already see who is on screen.
- Use the tags to get the claim the right way round. A claim made in a CLIP line is the footage's, not this channel's, and the HOST lines are the response to it. Never write the chapter as though the claim being objected to is the one being made.
- Carry the verdict where the HOST lines give one — that is what the chapter is actually about — but write it as the content it is ("the bridge contract claim, rebutted"), not as something a person did.
- Name the person, organisation, story or claim IF this chapter's transcript names one — "Mayor Ellison on the bridge contract scandal", not "a local corruption argument". (Ellison is invented for this instruction — never copy a name from these instructions into your answer.) That is a real name from the content and is exactly what is wanted; it is the opposite of inventing an unnamed speaker.
- Never mention a person, group or story this chapter's own transcript does not, not even one you are sure of from outside knowledge.
- Cover the whole chapter, not just its opening. Say what is there, plainly. No headline writing, no teasing, no colons, no "Part 1".
- Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis", "Continued", "More on this".
- A sponsor read, a Patreon plug, a channel promo or a sign-off should simply say that is what it is.

Output exactly this shape and nothing else:
{
  "title": "...",
  "summary": "..."
}

TRANSCRIPT:
{transcript}`,
};
