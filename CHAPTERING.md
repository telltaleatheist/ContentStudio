# Chaptering with a local 14B — the sealed method

How ContentStudio should turn a transcript into YouTube chapters using a local 14B model.
This is the method sealed on 2026-08-02 after it passed the ultimate test: a 2:10:46
livestream chaptered against Owen's own story list — all 7 stories found, in order, with
the intro, the mid-stream app demo, and the sign-off correctly isolated. Reference
implementation: `chapter_harness.py` + `chapter_prompts/` in the `orpheus-finetune` repo
(telltaleatheist/orpheus-voice-finetune). The prompts in this document are copied from
there verbatim — treat them as tested artifacts, not suggestions.

Where this sits in Headline: chapters are the FIRST stage. The user curates the chapter
list (marks which chapters belong to a video, joins any strays), and the curated subject
list — timestamps stripped — is what the title, description, and tags adapters condition
on. Chapters are both a shipped product (clickable description links, so starts must land
within ~5 seconds) and the conditioning input for everything downstream.

## The one law that shaped everything

**A 14B cannot select K items from a list of N.** Ask it which 12 of 70 candidate
boundaries are real and it returns a prefix — the first few — and stops. This one failure
sank five architectures (whole-transcript chaptering, windowed lists, merge lists,
delete-the-dividers, pick-the-headings) before it was isolated. The fix is absolute:

> **No model call ever sees a list, a count, or the whole video. Every call asks ONE
> local question about ONE thing. Code does all counting, ranking, spacing, and
> assembling.**

Corollaries that follow from it, each learned the hard way:

- **The model never emits a timestamp.** It quotes a verbatim sentence; code maps the
  quote to a time by matching words against the caption stream. A model-invented
  timestamp is a guess; a mapped quote is a measurement.
- **Temperature 0 always, `format: json` always.** Single-video results at temp > 0 are
  not measurements (same config scored 0.50 then 0.00 on consecutive runs).
- **Worked examples leak.** A prompt example naming a real person WILL surface in outputs
  where the input has an unnamed person of the same archetype ("Kenneth Copeland" from a
  prompt example appeared in 3 of 2,828 outputs, deterministically, at temp 0). Use
  invented, neutral-domain examples ("Mayor Ellison's bridge contract scandal").
- **Prompts that demand what the input lacks get fabrications.** Ask for a name when the
  span names nobody and the model supplies the highest-prior name for the archetype —
  "Alex Jones" appeared in four labels of a stream that never mentions him, because the
  spans contained an unnamed screaming right-wing voice. Every naming prompt needs an
  explicit no-name branch, and outputs should be proper-noun-checked against their span
  (see Known limitations).

## Model requirements

- **14B is the floor.** A full end-to-end run on qwen2.5:3b produced mega-chapters (one
  32-minute chapter swallowing three stories) and mislabeled spans. Small models fail in
  the direction the user cannot fix by joining — missed boundaries — so they are out
  until task-specific adapters exist.
- **Rating quality is model-sensitive.** qwen2.5:14b is the validated rater (healthy
  0–3 spread). cogito:14b rates with almost no variance on some corpora and is fine for
  the label stage. When in doubt, run qwen2.5:14b for stages 2, 4 and 5.
- Serve via local Ollama, `temperature 0`, `format: json`, one model resident at a time,
  unload (`keep_alive: 0`) when the run finishes.

## The pipeline: label → rate → select → summarize → consolidate

No stage sees the whole video. A 3-hour livestream and a 12-minute upload run identical
logic — only the number of calls differs.

### Stage 1 — label (one call per 45-second stretch)

Cut the transcript into 45 s stretches. For each, one call describes what is being
discussed in 3–6 words. These labels are scaffolding for stage 2 — they are NOT the
chapter names (a later stage that summarized labels instead of transcript produced
summary-of-summary mush; that design is dead).

```
Below is one short stretch of a YouTube commentary video's transcript. You are not writing
chapters. You are describing this stretch and nothing else.

TRANSCRIPT:
{segment}

Say what is being discussed here, in 3 to 6 words. Name the person, organisation, story or
claim by name wherever the transcript names one - "Alex Jones on Sandy Hook" rather than
"conspiracy theories", "TPUSA fundraising" rather than "money". If the stretch is a sponsor
read, a Patreon plug, a sign-off or similar, say so plainly.

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
{"about": "<3-6 words>", "starts_here": true or false, "opening_phrase": "<exact quote from above>"}
```

### Stage 2 — rate each junction (one call per junction)

For every boundary between consecutive stretches, one call rates how much the subject
changes (0–3) across it. This is the signal selection ranks by. Run on **qwen2.5:14b**.

```
Here are two consecutive stretches of a YouTube commentary video.

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
{"change": 0, "why": "<six words or fewer>"}
```

**Do not threshold this signal — rank by it.** Individually these ratings look weak
(AUC ~0.55 against reference boundaries), but ranking junctions by rating doubles
end-to-end F1 versus not ranking. Judge any selector end-to-end, never by a
near/far threshold test.

### Stage 3 — select boundaries (code only, zero model calls)

1. Derive a target chapter count from duration. Cadence measured across 3,000+ published
   chapters: ~2.2 min/chapter under 10 min, 3.5 at 10–30, 5.6 at 30–60, ~6 beyond an
   hour. `count = max(3, round(duration / target_seconds)) - 1` boundaries.
2. Rank junctions strongest-change first.
3. Take boundaries in rank order, enforcing a minimum gap of `0.6 × target` seconds;
   break ties farthest-first from already-chosen boundaries.
4. 0:00 is always a chapter and is never scored.

### Stage 3b — place each boundary to the second (one call per boundary)

A junction is only accurate to ±45 s. For each selected boundary, one call reads the
transcript window around it and quotes the sentence where the host TURNS to the new
subject. Code maps the quote to a timestamp. Validated placement: 64% within 5 s, 77%
within 10 s of human marks, mean bias +0.8 s.

```
Below is one stretch of a YouTube commentary video's transcript. Somewhere inside it the
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
{"start_phrase": "<exact sentence from the transcript above>"}
```

The "turn, not arrival" ordering matters: an earlier prompt that rejected "the sentence
that merely hints at what is coming" placed boundaries 11.8 s late on average, because
the hint IS where a human puts the mark.

**Quote→timestamp mapping** must run against the flattened word stream, not per caption
cue — auto-caption cues are ~7-word wrapped fragments, so sentences straddle cues and
per-cue matching fails. Flatten all cue words into one list with a parallel start-time
list; find the quote's first 12 words exactly, falling back to the best fractional match
(threshold 0.5). Auto-captions repeat lines in a rolling window — dedupe with the
per-line rule `text == previous or previous.endswith(text)` before flattening.

### Stage 4 — summarize each chapter (one call per chapter)

With boundaries fixed, each chapter's ACTUAL transcript span is summarized in 4–8 words.
These are the real chapter names, and the subject list handed to the title stage.

```
Below is one chapter of a YouTube commentary video - the stretch from {start} to {end}. It
is one subject; the boundaries have already been decided.

TRANSCRIPT OF THIS CHAPTER:
{transcript}

Describe what this chapter covers, in 4 to 8 words.

- Name the person, organisation, story or claim IF the transcript names one: "Alex Jones on
  the TPUSA feud", not "a conspiracy theory argument".
- If it names nobody, do not supply a name - describe what is there in its own words. A
  sponsor read, a Patreon plug, a sign-off or a channel promo should simply say that it is
  one. Never mention a person or story that this transcript does not.
- Cover the whole stretch, not just its opening. Where it genuinely moves through more than
  one thing, name what it spends most of itself on.
- Say what happens, plainly. A viewer reads this as a chapter marker before clicking, and
  another model is handed it afterwards, so it has to carry the actual content. No headline
  writing, no teasing, no colons, no "Part 1".
- Never "Introduction", "Overview", "Background", "Conclusion", "Discussion", "Analysis",
  "Continued", "More on this".

Return JSON only:
{"about": "<4 to 8 words>"}
```

Guard the context window: estimate tokens as `words × 1.4 + 600` and REFUSE (raise, ask
for a bigger `num_ctx`) rather than truncate — a summary of a chapter's opening teaches
nothing about the chapter. A ~18-minute consolidated chapter needs `num_ctx` 16384.

### Stage 5 — consolidate (one call per adjacent pair)

The forced count over-segments on purpose — a 2-hour stream gets ~21 initial boundaries
for ~7 real stories. Walk the chapters left to right; for each adjacent pair, one call
judges "one story or two?" on the genuine summaries. Merges apply immediately (so a
story split three ways collapses in one sweep), and every merged span is re-summarized
from its full transcript afterwards.

```
Two consecutive chapters of one video:

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
{"one_story": true or false, "why": "<six words or fewer>"}
```

**Ask about EVERY adjacent pair.** A gated version (only short-sided or weak-junction
pairs eligible) merged 1 pair of the 8 needed on the livestream test: livestream
overshoot selects strong-but-intra-story junctions with full-length sides that the gate
never questions. Wide eligibility took 21 chapters → 13 and fixed every multi-way story
split it was allowed to see. Protect against over-collapse with a minimum chapter count
(3) — and remember the user curation step is the real backstop: the errors that survive
wide consolidation are over-SPLITS, which the user fixes by joining in one click.
Under-splits (lost boundaries) are the errors to fear, because nobody can fix them by
hand.

## Cost and runtime

Calls per video ≈ `stretches + junctions + boundaries + chapters + pairs` ≈
`2 × (duration/45s) + ~3 × chapter_count`. On a 24 GB-class GPU with a 14B at Q4:

| video | calls | wall time |
|---|---|---|
| 12 min | ~40 | ~2 min |
| 20 min | ~60 | ~3–5 min |
| 2 h 10 m livestream | ~390 | ~25 min |

## Validation results (why this is the sealed method)

- Livestream RU4hZVpjA8c (2:10:46), graded against the creator's own 7-story list: 13
  chapters vs an ideal ~11; all 7 stories present in order; eugenics 3-way split, Shane
  Vaughn, and the Tate arrest→Top G continuation all consolidated correctly; opening,
  mid-stream app demo, and sign-off (placed within 23 s of stream end) isolated.
- Placement: 64% within 5 s, 77% within 10 s of human marks; bias +0.8 s.
- Always report the no-model baseline alongside any accuracy claim: uniform spacing
  alone scores F1 0.141 @ 15 s tolerance. A pipeline change that cannot beat the dumb
  baseline by a wide margin is noise.

## Known limitations (open items, with intended fixes)

1. **Fabricated names poison consolidation.** When a span leaves its subject unnamed,
   the summarizer can supply a famous name from its prior (deterministically, at temp 0)
   — and two summaries naming different people for the same story will refuse to merge.
   Intended fix, code not prompts: extract proper nouns from each summary, fuzzy-match
   them against the span's words, and on a miss retry the summary with "the transcript
   does not mention X."
2. **Topic-similarity over-merge.** The pair judge occasionally calls two religion-
   adjacent stories one story despite the "same broad topic is NOT enough" line (a
   faith-healer story was absorbed into a Christian-nationalism chapter on the livestream
   test). Intended fix: hand the pair judge a short transcript excerpt from each side of
   the seam, not just the 8-word summaries.
3. **Auto-caption proper-noun garble** ("Eric Metaxas" → "Mataxis") both feeds fix #1
   and occasionally cuts a name introduction off a chapter's opening — a boundary landing
   4 s after "This is Eric Metaxas" leaves the span with an anonymous ranter.
