/**
 * Chapter Prompts — the sealed 14B chaptering method
 *
 * These five prompts are copied VERBATIM from CHAPTERING.md (sealed 2026-08-02),
 * which in turn copied them from the validated `chapter_prompts/` harness. They are
 * tested artifacts, not suggestions. Every line in them was paid for with a failed
 * architecture:
 *
 * - Nothing here ever shows the model a list, a count, or the whole video. A 14B
 *   cannot select K items from a list of N — it returns a prefix and stops. Each
 *   prompt asks ONE local question about ONE thing; code does all the counting,
 *   ranking, spacing and assembling (see chapter-pipeline.service.ts).
 * - The model NEVER emits a timestamp. It quotes a verbatim sentence and code maps
 *   that quote to a time against the caption word stream. An invented timestamp is a
 *   guess; a mapped quote is a measurement.
 * - The examples are invented and neutral-domain on purpose. A prompt example naming
 *   a real person leaks into outputs about a DIFFERENT unnamed person of the same
 *   archetype, deterministically, at temperature 0.
 *
 * Editing these without re-running the harness in the orpheus-finetune repo is how
 * the method gets quietly un-sealed. Change the code around them first.
 *
 * 2026-08-16 — variant B. The bodies below now carry the evolutions validated in the
 * sibling AutoCutStudio implementation (its chapter-splitter.ts + docs/chaptering-method.md,
 * auditions of 2026-08-03), lifted verbatim rather than re-derived:
 *
 * - The worked examples are DE-LEAKED. "Alex Jones on Sandy Hook" and "TPUSA
 *   fundraising" were still shipping here, and the leak is not hypothetical: those
 *   names surface in labels for spans that never mention them. They are now the
 *   invented Mayor Ellison / Halvorsen Trust pair, plus an inoculation parenthetical
 *   in the summarize prompt saying Ellison is invented — and the code still checks
 *   for the leak, because the inoculation alone did not always hold.
 * - Stage 4 exists in TWO variants, tagged and untagged, and the transcript decides
 *   which runs (see chapter-pipeline.service.ts). Only stage 4 ever sees speaker
 *   tags; stages 1-3 and 5 read the bare text their sealed prompts were tested on.
 * - Stage 4 also returns "detail" now — description-grade prose per chapter, because
 *   a 4-8 word marker sits far below the distribution the downstream description and
 *   tag stages condition on and starves them of specifics.
 */

export const CHAPTER_PROMPTS = {
  /**
   * Stage 1 — label one 45-second stretch.
   * These labels are scaffolding for the stage-2 rater; they are NOT chapter names.
   * Placeholder: {segment}
   */
  LABEL: `Below is one short stretch of a YouTube commentary video's transcript. You are not writing
chapters. You are describing this stretch and nothing else.

TRANSCRIPT:
{segment}

Say what is being discussed here, in 3 to 6 words. Name the person, organisation, story or
claim by name wherever the transcript names one - "Mayor Ellison on the bridge contract"
rather than "local politics", "Halvorsen Trust fundraising" rather than "money". If the
stretch is a sponsor read, a Patreon plug, a sign-off or similar, say so plainly.

Then answer one question about WHERE that subject begins.

Read the opening words of the stretch. If the host was already mid-subject when this stretch
opened - already telling this story, already making this argument - then it started earlier
and "starts_here" is false. If instead the subject arrives somewhere inside this stretch,
with the host moving onto it from something else, "starts_here" is true.

Both answers are common and neither is safer. Most stretches land in the middle of a
subject; do not answer true just because you can find a sentence to point at.

Then quote the sentence that fixes the position:
- if starts_here is true, the exact sentence where the new subject arrives - the first
  sentence about it, not the last one before it
- if starts_here is false, the first sentence of the stretch

Copy it EXACTLY as it appears above, word for word, at least six words, no timestamps and no
tidying up. That quote is what fixes a chapter's start time to the second, so a quote you
reworded points at the wrong moment.

Return JSON only:
{"about": "<3-6 words>", "starts_here": true or false, "opening_phrase": "<exact quote from above>"}`,

  /**
   * Stage 2 — rate how much the subject changes across one junction (0-3).
   * Do NOT threshold this signal; rank by it (see the pipeline's selection stage).
   * Placeholders: {before}, {after}, {window}
   */
  RATE_JUNCTION: `Here are two consecutive stretches of a YouTube commentary video.

The earlier stretch:  {before}
The stretch after it: {after}

TRANSCRIPT ACROSS THE TWO:
{window}

How much does the video change subject between them? Answer with one number:

0 - no change at all. Still the same story, the same person, the same argument. The second
    stretch is simply the first one continuing.
1 - a small move within one subject: a new angle on the same story, the rebuttal to the
    claim just made, reaction to the clip just played, another example of the same point.
2 - a clear move: the video finishes with what it was on and takes up something related but
    separate - a different incident involving the same people, or the same theme through a
    different story.
3 - a complete change: a different person or organisation, an unrelated story, or a sponsor
    read, Patreon plug, sign-off or channel promo starting or ending.

Most pairs of neighbouring stretches are 0 or 1 - a video does not change subject every
minute. Reserve 3 for the places a viewer would actually want a chapter mark.

Judge only these two stretches against each other. Do not think about the rest of the video,
and do not try to make the numbers come out evenly.

Return JSON only:
{"change": 0, "why": "<six words or fewer>"}`,

  /**
   * Stage 3b — place one selected boundary to the second.
   * The "turn, not arrival" ordering is load-bearing: an earlier prompt that rejected
   * "the sentence that merely hints at what is coming" placed boundaries 11.8s LATE on
   * average, because the hint IS where a human puts the mark.
   * Placeholders: {before}, {after}, {window}
   */
  PLACE_BOUNDARY: `Below is one stretch of a YouTube commentary video's transcript. Somewhere inside it the
video moves from one subject to the next.

What it was talking about:  {before}
What it moves on to:        {after}

TRANSCRIPT:
{window}

Find where the handover BEGINS - the first sentence a viewer would want to land on if they
clicked a chapter called "{after}".

That is the sentence where the host turns away from "{before}", which is usually a beat
EARLIER than the sentence that first explains the new subject. If the host says "anyway,
let's talk about X" and then explains X three sentences later, the turn is "anyway, let's
talk about X" - quote that, not the explanation. A viewer dropped at the explanation has
missed the start.

So prefer, in this order:
1. the sentence where the host announces, introduces or turns toward the new subject
2. the sentence where the host closes off the old subject, if the turn is not announced
3. the first sentence that is plainly about the new subject, if there is no turn at all

Copy the sentence EXACTLY as it appears above, word for word, at least six words, no
timestamps and no tidying up. That quote is what fixes a chapter's start time to the second,
so a quote you reworded points at the wrong moment.

Return JSON only:
{"start_phrase": "<exact sentence from the transcript above>"}`,

  /**
   * Stage 4 (untagged) — summarize one chapter's ACTUAL transcript span in 4-8 words.
   * These are the real chapter names AND the subject list handed to the title,
   * description and tag stages. Summarizing the stage-1 labels instead of the
   * transcript produced summary-of-summary mush; that design is dead.
   *
   * This variant runs when the transcript carries no speaker attribution — a plain
   * Whisper transcription. It is the sealed body with the leaked examples replaced,
   * the outside-knowledge clause added, and the "detail" field appended; the
   * HOST:/CLIP: bullets are absent because there are no tags for them to refer to,
   * and a rule about lines the model cannot see is a rule it cannot follow.
   *
   * Placeholders: {start}, {end}, {transcript}
   */
  SUMMARIZE_CHAPTER: `Below is one chapter of a YouTube commentary video - the stretch from {start} to {end}. It
is one subject; the boundaries have already been decided.

TRANSCRIPT OF THIS CHAPTER:
{transcript}

Describe what this chapter covers, in 4 to 8 words.

- Name the person, organisation, story or claim IF the transcript names one: "Mayor Ellison
  on the bridge contract scandal", not "a local corruption argument". (Ellison is invented
  for this instruction - never copy a name from these instructions into your answer.)
- If it names nobody, do not supply a name - describe what is there in its own words. A
  sponsor read, a Patreon plug, a sign-off or a channel promo should simply say that it is
  one. Never mention a person or story that this transcript does not - not even one you are
  sure of from outside knowledge. If the transcript only ever says "the mayor", write "the
  mayor".
- Cover the whole stretch, not just its opening. Where it genuinely moves through more than
  one thing, name what it spends most of itself on.
- Say what happens, plainly. A viewer reads this as a chapter marker before clicking, and
  another model is handed it afterwards, so it has to carry the actual content. No headline
  writing, no teasing, no colons, no "Part 1".
- Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis",
  "Continued", "More on this".

Also write "detail": one or two sentences a video description would use for this chapter - every
name, organisation, claim and outcome that matters, using only names this transcript itself
provides, framed the way the host frames it, 20 to 45 words. All the rules above apply to it
too: right attribution, the host's verdict carried, no timestamps, no teasing.

Return JSON only:
{"about": "<4 to 8 words>", "detail": "<one or two sentences, 20 to 45 words>"}`,

  /**
   * Stage 4 (tagged) — the same call, for a transcript that knows who is speaking.
   *
   * Copied VERBATIM from AutoCutStudio's chapter-splitter.ts (revised 2026-08-03,
   * auditions A-H). Every difference from the untagged body was paid for:
   *
   * - Untagged, "say what happens, plainly" sanitizes the host's framing out of the
   *   label — "Passenger kicked off plane for preaching" for a chapter that is the
   *   host calling the passenger a lying racist. The verdict bullet fixes that.
   * - Tags WITHOUT the attribution bullet inverted who did what: a claim made in the
   *   footage came back out as a fact about the person the footage was attacking.
   * - An untagged tone bullet made "Host" the subject of 4 of 10 labels, which is why
   *   the words host/creator/commentary are banned outright and the code re-asks once
   *   when they appear anyway.
   *
   * Placeholders: {start}, {end}, {transcript}
   */
  SUMMARIZE_CHAPTER_TAGGED: `Below is one chapter of a YouTube commentary video - the stretch from {start} to {end}.
It is one subject; the boundaries have already been decided.

TRANSCRIPT OF THIS CHAPTER (HOST: lines are the video's host speaking; CLIP: lines are the
footage the host is reacting to):
{transcript}

Describe what this chapter covers, in 4 to 8 words.

- Name the person, organisation, story or claim IF the transcript names one: "Mayor Ellison on the
  bridge contract scandal", not "a local corruption argument". (Ellison is invented for this
  instruction - never copy a name from these instructions into your answer.)
- If it names nobody, do not supply a name - describe what is there in its own words. A sponsor
  read, a Patreon plug, a sign-off or a channel promo should simply say that it is one. Never
  mention a person or story that this transcript does not - not even one you are sure of from
  outside knowledge. If the transcript only ever says "the mayor", write "the mayor".
- Cover the whole stretch, not just its opening. Where it genuinely moves through more than one
  thing, name what it spends most of itself on.
- The host's verdict is part of what happens. When the HOST lines dispute, debunk, mock or condemn
  what the CLIP lines claim, carry that verdict in how the story is described: "lies about
  the depot contract", not "discusses the depot contract"; "street closure rumour debunked", not
  "disputes claims about street closures". Keep the story as the
  subject - the words "host", "creator" and "commentary" must not appear in your answer; name what
  is shown, framed the way the host frames it. If the host takes no position, do not invent one.
- Attribute words and deeds to the right person. A claim in a CLIP line belongs to the person in
  the footage, and stays THEIR claim - if the clip's speaker says the inspector took a bribe and
  the host shows that claim is false, the chapter says the speaker lied about the inspector, not
  that the inspector took a bribe. When you cannot tell who did what, describe it neutrally
  rather than guess.
- A stretch that is only HOST lines (a sponsor read, a sign-up attempt, links, a sign-off) is
  named by the activity itself: "Patreon plug and channel links", not "Host promotes his
  Patreon".
- Say what happens, plainly. A viewer reads this as a chapter marker before clicking, and another
  model is handed it afterwards, so it has to carry the actual content. No headline writing, no
  teasing, no colons, no "Part 1".
- Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis",
  "Continued", "More on this".

Also write "detail": one or two sentences a video description would use for this chapter - every
name, organisation, claim and outcome that matters, using only names this transcript itself
provides, framed the way the host frames it, 20 to 45 words. All the rules above apply to it
too: right attribution, the host's verdict carried, no timestamps, no teasing.

Return JSON only:
{"about": "<4 to 8 words>", "detail": "<one or two sentences, 20 to 45 words>"}`,

  /**
   * Stage 5 — one story or two? Asked about EVERY adjacent pair.
   * A gated version (only short-sided or weak-junction pairs eligible) merged 1 of the
   * 8 pairs that needed merging on the livestream test.
   * Placeholders: {a_length}, {a_about}, {b_length}, {b_about}
   */
  CONSOLIDATE_PAIR: `Two consecutive chapters of one video:

Chapter A ({a_length}): {a_about}
Chapter B ({b_length}, comes straight after): {b_about}

Are these one story, or two?

They are ONE story when B is A continuing: the same case, incident or argument carried on,
the rebuttal to the claim A made, reaction to the clip A played, the same person or
organisation stayed with throughout.

They are TWO stories when the video genuinely moves on: a different person or organisation,
an unrelated incident, one story wrapped up and the next begun. A sponsor read, a Patreon
plug or a sign-off is always its own chapter, never part of the story beside it.

The same broad topic is NOT enough to make them one story - two different lawsuits about
two different churches are two stories. Both answers are common; decide from what the
descriptions actually say.

Return JSON only:
{"one_story": true or false, "why": "<six words or fewer>"}`,
};

/**
 * The 27B whole-transcript prompt — the deliberate exception to everything above.
 *
 * NOT part of the sealed method. The five prompts in CHAPTER_PROMPTS each ask ONE local
 * question about ONE stretch, because a 14B cannot select K items from a list of N. These
 * two show the model the WHOLE video and ask for the whole chapter list in one call, which
 * is the architecture CHAPTERING.md records as having been killed five times over.
 *
 * They are here because that constraint was measured at 14B and re-measured at 27B on
 * 2026-08-21, and it did not reproduce: across four videos from 8.8 minutes to 2h08 the
 * 27B showed no prefix behaviour, mapped 100% of its quotes on three runs of four, invented
 * no names at all, and hit 5 of 5 ground-truth story boundaries on the 2h08 stream with a
 * worst offset of 54 s. The full record is
 * /Volumes/Callisto/Projects/tools/chapter-experiment/RESULTS.md.
 *
 * What the same experiment ALSO measured is why the bodies below say what they say:
 *
 * - UNCONSTRAINED CADENCE IS THE FAILURE. Unprompted, the same model at temperature 0 gave
 *   1.1 min/chapter on an 8.8-minute video, 0.36 on a 32-minute one (88 "chapters", median
 *   gap 18 s, titles like "Host interjection") and 16.0 on a 2h08 stream. A 44x spread with
 *   no relation to content. The chapter-count budget paragraph is what fixed it: the same
 *   32-minute video came back with 7 clean chapters, and the 2h08 stream's ground-truth
 *   accuracy IMPROVED (19 s vs 22 s mean offset) rather than degrading into even slicing.
 * - THE BUDGET IS OBEYED LITERALLY, so a wrong budget is obeyed straight into a wrong
 *   answer: given the experiment's first `ceil(M/15)..ceil(M/5)` band the 8.8-minute video
 *   returned exactly 2 chapters and collapsed five separately-clipped people into one. The
 *   numbers substituted into {lo}/{hi} come from the shipped targetSecondsFor() cadence
 *   table and nothing else.
 * - THE SPEAKER-TURN NEGATIVE EXAMPLE is what stops the annotation collapse. The 88-chapter
 *   run was chaptering per speaker turn; naming that mistake concretely ends it.
 * - THE MODEL STILL NEVER EMITS A TIMESTAMP. It quotes, code measures. That corollary of
 *   the sealed method survives intact here, and the transcript is rendered WITHOUT
 *   timestamps so there is nothing for it to copy or imitate.
 * - THE EXAMPLE IS THE SAME INVENTED Mayor Ellison used everywhere else in this file, for
 *   the same reason: a real name in a prompt example surfaces in outputs about a different,
 *   unnamed person of the same archetype, deterministically, at temperature 0.
 *
 * One deviation from the tested artifact, stated because it is one: the experiment's V2
 * asked for two fields, `quote` and `title`. These ask for a third, `summary`, because the
 * pipeline's stage 4 returns a `detail` field that the description and tag prompts condition
 * on, and a single-call path that dropped it would starve them. Everything else is V2's
 * substance.
 *
 * Whichever body runs, the output is VALIDATED IN CODE (chapter-single-call.service.ts):
 * count against the budget, ordering, spacing, quote resolution. Nothing here is trusted.
 * Four tokens of cosmetic punctuation moved this model's chapter count 8 -> 13 at
 * temperature 0, so the prompt is a strong prior and never a guarantee.
 */
export const CHAPTER_SINGLE_CALL_PROMPTS = {
  /**
   * Speaker-tagged transcript (HOST:/CLIP: per line). Runs only when EVERY caption
   * segment resolves to a side — a partly-tagged transcript makes a prompt that lies
   * about the untagged half.
   * Placeholders: {transcript}, {minutes}, {lo}, {hi}, {gap}
   */
  WHOLE_TRANSCRIPT_TAGGED: `Below is the COMPLETE transcript of one YouTube commentary video, from its first word to its last. Lines are tagged HOST: (the presenter speaking) and CLIP: (audio from a clip he is playing). It is an automatic transcript, so it is rough in places.

TRANSCRIPT:
{transcript}

Your job is to find EVERY point in this video where the subject changes, so the video can be split into chapters.

A subject change is where the video finishes with what it was on and takes up something else: a different person, a different organisation, an unrelated story, a different chapter of a book being read, or the start or end of a sponsor read, a Patreon plug, a channel promo or a sign-off. Carrying on with the same story - a new angle on it, the rebuttal to the claim just made, reaction to the clip just played, another example of the same point - is NOT a subject change.

The video opens on a subject, so the FIRST chapter starts at the very first line of the transcript. Then one chapter for each subject change after it.

This video is {minutes} minutes long. Return between {lo} and {hi} chapters - no fewer than {lo}, no more than {hi}. No chapter may cover less than {gap} minutes of the video, so no two chapter starts may sit within {gap} minutes of each other.

A chapter is a SUBJECT change, never a speaker turn. The transcript hands back and forth between HOST: and CLIP: constantly - that is one subject being discussed, not a new chapter each time. Do not start a chapter because the speaker changed, because the host reacts to a clip, or because a clip resumes.

To be concrete about the commonest mistake. Suppose the video plays a council spokesman defending a bridge contract, the host cuts in to call it nonsense, the clip resumes, and the host laughs at it. That is ONE chapter - "Mayor Ellison's bridge contract defence" (Mayor Ellison is invented, for this example only; he is not in the transcript) - covering all four beats. It is NOT four chapters called "Spokesman defends contract", "Host interjection", "Clip resumes", "Host mocks the claim". Chapters named after a speaker taking a turn, or after the host reacting, are always wrong, and a chapter whose quote is one or two words is always wrong.

For each chapter, give me three things.

1. "quote" - the first 8 to 12 words of the sentence where that subject BEGINS, copied EXACTLY as they appear in the transcript above, word for word, including any mistakes in it. Do not tidy it up, do not reword it, do not add the HOST: or CLIP: tag. These words are how the chapter's start time gets measured, so a quote you reworded points at the wrong moment, and a quote that is not in the transcript above throws the whole chapter list away. Never write a timestamp - a timestamp you guessed is worthless and there are none in the text to copy.

2. "title" - what that chapter is about, in 3 to 8 words. Name the person, organisation, story or claim IF the transcript names one - "Mayor Ellison's bridge contract scandal", not "a corruption story". If that stretch of transcript names nobody, do NOT supply a name: describe what is there in its own words. Never name a person, group or story that does not appear in that chapter's own stretch of the transcript. No headline writing, no teasing, no colons, no "Part 1". Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis", "Continued".

3. "summary" - what that chapter covers, in 20 to 45 words. Say what actually happens in it: who is named, what they claim, what the host says back. Another model is handed this to write the video's description, so it has to carry the specifics rather than tease them. Same rule on names as the title: only the ones this chapter's own stretch of the transcript contains.

Cover the WHOLE video. The chapters must run in the order they appear in the transcript, and the last chapter's quote must come from near the END of the transcript above - not the middle. A chapter list that stops partway through the video is wrong.

Return JSON only, in this exact shape:
{"chapters": [{"quote": "<exact words from the transcript>", "title": "<3 to 8 words>", "summary": "<20 to 45 words>"}]}`,

  /**
   * Untagged transcript — plain Whisper, no speaker attribution to render.
   * Identical to the tagged body except that it never claims tags the transcript does
   * not carry. The speaker-turn rule stays: the collapse it prevents is about turns,
   * not about tags.
   * Placeholders: {transcript}, {minutes}, {lo}, {hi}, {gap}
   */
  WHOLE_TRANSCRIPT: `Below is the COMPLETE transcript of one YouTube commentary video, from its first word to its last. It is an automatic transcript, so it is rough in places, and it runs the host's own words and the audio of the clips he plays together without saying which is which.

TRANSCRIPT:
{transcript}

Your job is to find EVERY point in this video where the subject changes, so the video can be split into chapters.

A subject change is where the video finishes with what it was on and takes up something else: a different person, a different organisation, an unrelated story, a different chapter of a book being read, or the start or end of a sponsor read, a Patreon plug, a channel promo or a sign-off. Carrying on with the same story - a new angle on it, the rebuttal to the claim just made, reaction to the clip just played, another example of the same point - is NOT a subject change.

The video opens on a subject, so the FIRST chapter starts at the very first line of the transcript. Then one chapter for each subject change after it.

This video is {minutes} minutes long. Return between {lo} and {hi} chapters - no fewer than {lo}, no more than {hi}. No chapter may cover less than {gap} minutes of the video, so no two chapter starts may sit within {gap} minutes of each other.

A chapter is a SUBJECT change, never a speaker turn. The transcript hands back and forth between the host and the clips he plays constantly - that is one subject being discussed, not a new chapter each time. Do not start a chapter because the speaker changed, because the host reacts to a clip, or because a clip resumes.

To be concrete about the commonest mistake. Suppose the video plays a council spokesman defending a bridge contract, the host cuts in to call it nonsense, the clip resumes, and the host laughs at it. That is ONE chapter - "Mayor Ellison's bridge contract defence" (Mayor Ellison is invented, for this example only; he is not in the transcript) - covering all four beats. It is NOT four chapters called "Spokesman defends contract", "Host interjection", "Clip resumes", "Host mocks the claim". Chapters named after a speaker taking a turn, or after the host reacting, are always wrong, and a chapter whose quote is one or two words is always wrong.

For each chapter, give me three things.

1. "quote" - the first 8 to 12 words of the sentence where that subject BEGINS, copied EXACTLY as they appear in the transcript above, word for word, including any mistakes in it. Do not tidy it up and do not reword it. These words are how the chapter's start time gets measured, so a quote you reworded points at the wrong moment, and a quote that is not in the transcript above throws the whole chapter list away. Never write a timestamp - a timestamp you guessed is worthless and there are none in the text to copy.

2. "title" - what that chapter is about, in 3 to 8 words. Name the person, organisation, story or claim IF the transcript names one - "Mayor Ellison's bridge contract scandal", not "a corruption story". If that stretch of transcript names nobody, do NOT supply a name: describe what is there in its own words. Never name a person, group or story that does not appear in that chapter's own stretch of the transcript. No headline writing, no teasing, no colons, no "Part 1". Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis", "Continued".

3. "summary" - what that chapter covers, in 20 to 45 words. Say what actually happens in it: who is named, what they claim, what the host says back. Another model is handed this to write the video's description, so it has to carry the specifics rather than tease them. Same rule on names as the title: only the ones this chapter's own stretch of the transcript contains.

Cover the WHOLE video. The chapters must run in the order they appear in the transcript, and the last chapter's quote must come from near the END of the transcript above - not the middle. A chapter list that stops partway through the video is wrong.

Return JSON only, in this exact shape:
{"chapters": [{"quote": "<exact words from the transcript>", "title": "<3 to 8 words>", "summary": "<20 to 45 words>"}]}`,
};

/**
 * The embedding pipeline's two prompts (2026-08-22).
 *
 * Kept separate from the sealed five and from the single-call pair for the same reason
 * those two are separate from each other: they belong to a different ARCHITECTURE
 * (chapter-embedding.service.ts), and editing one of these must never be mistaken for
 * editing a sealed artifact.
 *
 * Both bodies are copied from the portable handoff document that is their authority —
 * /Volumes/Callisto/Projects/Briefcase/docs/chapter-pipeline-handoff.md, §3.4 and §8 —
 * which validated them in Briefcase in August 2026 on real broadcast content. The only
 * edits are ContentStudio's `{placeholder}` convention (formatPrompt) in place of the
 * reference implementation's template literals.
 *
 * What survives from the sealed method, unchanged:
 *  - the model NEVER emits a timestamp. It quotes; code measures the quote against the
 *    caption word stream. An invented timestamp is a guess; a mapped quote is a
 *    measurement.
 *  - no call sees a list, a count, or the whole video. PLACE_BOUNDARY sees ~90 seconds
 *    around ONE junction; SUMMARIZE_CHAPTER sees ONE chapter.
 *  - the worked example names the invented Mayor Ellison, never a real person: a real
 *    name in a prompt example surfaces in outputs about a different, unnamed person of
 *    the same archetype, deterministically, at temperature 0.
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
   * sealed stage-4 prompt: they are what keeps a chapter marker out of "Introduction /
   * Overview / Conclusion" and out of names the transcript never contained.
   *
   * Placeholders: {number}, {video}, {previous_context} (already rendered, may be empty),
   * {transcript}
   */
  SUMMARIZE_CHAPTER: `Label chapter {number} of a video transcript. Output JSON only.
Video: {video}
{previous_context}
Produce:
- title: one sentence (max ~15 words) naming what this chapter is about.
- summary: 2-3 sentences on what the speaker actually says.

Rules for both fields:
- Name the person, organisation, story or claim IF this chapter's transcript names one — "Mayor Ellison on the bridge contract scandal", not "a local corruption argument". (Ellison is invented for this instruction — never copy a name from these instructions into your answer.)
- Never mention a person, group or story this chapter's own transcript does not, not even one you are sure of from outside knowledge. If it only ever says "the mayor", write "the mayor".
- Cover the whole chapter, not just its opening. Where it moves through more than one thing, name what it spends most of itself on.
- Say what happens, plainly. No headline writing, no teasing, no colons, no "Part 1".
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
- summary: 2-3 sentences on what the speaker actually says.

Rules for both fields:
- Attribute correctly. A claim made in a CLIP line belongs to whoever is in the footage, and the HOST's response to it is his verdict on it. Never write the chapter as though the host is making the claim he is objecting to.
- Carry the host's verdict where he gives one — that is what the chapter is actually about.
- Never say "the host", "the creator", "the narrator" or "the video". Name the activity or the story itself.
- Name the person, organisation, story or claim IF this chapter's transcript names one — "Mayor Ellison on the bridge contract scandal", not "a local corruption argument". (Ellison is invented for this instruction — never copy a name from these instructions into your answer.)
- Never mention a person, group or story this chapter's own transcript does not, not even one you are sure of from outside knowledge.
- Cover the whole chapter, not just its opening. Say what happens, plainly. No headline writing, no teasing, no colons, no "Part 1".
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
