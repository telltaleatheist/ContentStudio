# Chaptering with a local 14B — the sealed method

How ContentStudio should turn a transcript into YouTube chapters using a local 14B model.
This is the method sealed on 2026-08-02 after it passed the ultimate test: a 2:10:46
livestream chaptered against Owen's own story list — all 7 stories found, in order, with
the intro, the mid-stream app demo, and the sign-off correctly isolated. Reference
implementation: `chapter_harness.py` + `chapter_prompts/` in the `orpheus-finetune` repo
(telltaleatheist/orpheus-voice-finetune). The prompts in this document are copied from
there verbatim — treat them as tested artifacts, not suggestions.

> **2026-08-16 — the shipped prompts are now variant B.** The sibling AutoCutStudio
> implementation kept running this method and evolved it; those changes have been ported
> into `chapter-prompts.ts` / `chapter-pipeline.service.ts` verbatim: **de-leaked worked
> examples**, a **speaker-tagged stage 4 that also returns a `detail` field**, and
> **soft-failure placement** that marks a fallback start `startApprox` instead of
> throwing the run away. The prompt bodies quoted below are the 2026-08-02 originals and
> are kept as the record of what was sealed; where they differ from the code, the code is
> variant B and the newer validation data is in
> `AutoCutStudioApp/docs/chaptering-method.md`.

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

> **2026-08-21 — this is a 14B law, and it now has one measured exception.** The
> paragraph above stands for the sealed pipeline and for every model this document was
> written about. It does NOT hold for qwen3.8:27b, which was measured doing the whole
> video in one call without the prefix failure. See the addendum
> "[The 27B single-call exception](#2026-08-21--addendum-the-27b-single-call-exception)"
> at the end of this document for what was measured, what is qualified, and what is not.
> The corollary below it — the model never emits a timestamp — survives unchanged.

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

*2026-08-16: the shipped prompt's examples are de-leaked — "Mayor Ellison on the bridge
contract" / "Halvorsen Trust fundraising" in place of the real names below. The
`opening_phrase` this stage returns is also retained now instead of ignored: it is the
middle link of stage 3b's fallback chain.*

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

*2026-08-16: an unmappable quote no longer fails the run. The chain is mapped placement
quote → the stretch's own stage-1 `opening_phrase` (still a mapped quote, still ~5 s) →
the raw ±45 s junction, which is flagged `startApprox` on the chapter, warned about, and
rendered as such in the output. Out-of-order placements prefer the raw junction and are
dropped only if even that collides. See `AutoCutStudioApp/docs/chaptering-method.md`.*

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

*2026-08-16: the shipped stage 4 is variant B's (auditions A–H, 2026-08-03). It exists in
two forms and the transcript decides which runs: when the segments carry speaker
attribution the span is rendered `HOST:`/`CLIP:` line by line and the prompt gains the
verdict / attribution / host-only bullets, because untagged the summarizer inverts who
did what; with no attribution the untagged body runs unchanged. Stage 4 only — stages 1–3
and 5 still read bare text. Both forms now also return a **`detail`** field (20–45 words
of description-grade prose), which flows into the chapter-subjects block the metadata
prompt injects. Context is sized `words × 1.4 + 900` (the extra 300 pays for the bullets
and the detail field), bucketed to 4096, refusing above 32768. The examples are de-leaked
and a code-side check re-asks once when the invented example name — or, in tagged mode,
the banned word "host" — comes back in the answer.*

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

*2026-08-16: a merged chapter now KEEPS the pre-consolidation chapters it was built from
(`subChapters` — already computed, already named), and the stage can be skipped entirely
via the pipeline's `consolidate: false` option when the caller already knows the span is
one story. A pair the model will not judge is left separate, which is the direction the
user can undo.*

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

---

## 2026-08-21 — addendum: the 27B single-call exception

Nothing above is retracted. This section qualifies exactly one sentence of it — "no model
call ever sees a list, a count, or the whole video" — and says what the qualification is
allowed to cover.

**The law is a 14B result, and it does not reproduce at 27B.** Measured on 2026-08-21 on
`qwen3.8:27b` (Q4_K_M, trained context 262144) over four videos from 8.8 minutes to 2h08,
temperature 0, `format: json`, thinking off. Full record and raw responses:
`/Volumes/Callisto/Projects/tools/chapter-experiment/RESULTS.md`.

- **No prefix behaviour at any length.** The failure that sank whole-transcript chaptering
  at 14B — the model returning the first few boundaries and stopping — did not occur once,
  up to a 24,831-token prompt. Final-chapter coverage was 89 / 97 / 99 / 100%.
- **Story boundaries as good as the sealed method's.** On the 2h08 session master, graded
  against the creator's own `edits.json` story list: 5 of 5 stories found, in order, worst
  offset +54 s, intro and sign-off both isolated. One call, 174 seconds, against ~390 calls
  and ~25 minutes.
- **Zero fabricated names in any run of either round**, and whole-video context REPAIRED
  whisper garble a span-local call cannot see (`Occupy to early 1913 KJV` → Luke 19:13,
  `As I as 6'8" and "I"V` → Isaiah 6:8). That is limitation #1 and limitation #3 above,
  fixed by the thing this document forbids.
- **Context was never the constraint.** The 2h08 run used 51% of its window with
  `truncated = 0`, re-running at 65536 was byte-identical to 49152, and a 32x increase in
  `num_ctx` moves this model's resident footprint by 0.42 GB.

**What did NOT survive, and is why the exception is fenced rather than adopted.**
Unconstrained, cadence is not a stable quantity: the same model at temperature 0 produced
1.1 min/chapter at 8.8 minutes, 0.36 at 32 minutes (88 "chapters", median gap 18 s, titles
like "Host interjection" attached to one-word quotes) and 16.0 at 2h08 — a 44x spread with
no relation to content. And four tokens of cosmetic punctuation, with everything else
identical, moved a chapter count from 8 to 13. Stating a duration-derived chapter budget in
the prompt fixes both directions — the 32-minute collapse becomes 7 clean chapters and the
2h08 under-split becomes 12-14 with ground-truth accuracy *improving* — but the budget is a
strong prior, not a constraint the model is bound by.

### The qualification, in full

> A model call MAY see the whole transcript, and MAY be told a count, **only** when all of
> the following hold. This is the ONLY exception; adding a second one requires the same
> evidence.
>
> 1. **Opt-in.** It runs because the operator selected the "Qwen 27B — single call
>    (experimental)" option for the Chapters task. It is never a default and never a
>    recovery path.
> 2. **The count comes from the shipped cadence table.** The prompt states a chapter-count
>    budget computed from `targetSecondsFor()` — the same function stage 3 selects with,
>    imported, not copied. A budget derived any other way is obeyed literally into the
>    wrong answer: given `ceil(M/15)..ceil(M/5)` the model returned exactly 2 chapters for
>    an 8.8-minute video and collapsed five separately-clipped people into one.
> 3. **The model still never emits a timestamp.** It returns an exact quote per chapter and
>    code resolves that quote against the caption word stream. The resolution is stricter
>    than the pipeline's `mapQuote`: exact on the first 12 normalized words and UNIQUE, no
>    fractional match, because here the quote is the only evidence of where the chapter
>    starts rather than a refinement of a boundary already known to ±45 s.
> 4. **Everything is validated in code, and validation is the whole answer.** Count inside
>    the budget band, first chapter at 0:00, strictly monotonic starts, a minimum gap
>    derived from the same table, at least 3 chapters, no degenerate or duplicated quotes,
>    no duplicated titles. Every violation is named.
> 5. **Failure is failure.** One call means one answer, so a list that misses any check
>    fails the chapter stage outright — no retry, no second call, no falling back to the
>    5-stage pipeline, no emitting the list anyway. The item records `chaptersSkipped` and
>    the rest of the metadata is generated without chapter subjects, exactly as it is for
>    any other chapter failure.

Implementation: `electron/services/metadata/chapter-single-call.service.ts`, prompts in
`chapter-prompts.ts` as `CHAPTER_SINGLE_CALL_PROMPTS` (kept separate from the sealed five),
routing option `chapters-qwen27b-single`.

### Two things the integration learned that the experiment did not

- **Render one line per SPEAKER RUN, not per caption cue.** The prompt asks for the first
  8-12 words of the *sentence* a subject begins on. Handed ~7-word caption fragments, the
  model stitches the sentence back together across the break and returns text that appears
  nowhere. Cue-per-line rendering produced 2 unresolvable quotes out of 12 on a 43-minute
  transcript; joining each speaker's run into one block — what the experiment did — dropped
  that to 0.
- **A dual-track transcript has more than one faithful reading, and quote resolution has to
  search all of them.** When the host says one word over a clip, that word lands inside the
  clip's sentence in time order, so a faithfully-copied quote is not contiguous in the
  flattened stream (`Jesse Deplantis said "All that you cannot do` — the host said "my" in
  the gap). The model also reads straight down the page across a speaker switch
  (`on we go. dude left here is Gene Bailey` — one word from the clip, the rest from the
  host). Both are correct copies pointing at the same second. Resolution searches the
  flattened stream and each speaker's own stream, and collapses hits by resolved time —
  uniqueness is still required, it is simply required of the right text.

### Status: shipped, opt-in, and it does reject

On the two 2026-08-16 story regions re-run through the finished implementation, every quote
resolved and both counts landed inside the budget — and both runs were still REJECTED, each
on a single chapter shorter than the enforced minimum (52 s inside a 44-minute video, 30 s
inside a 9-minute one). That is the intended behaviour and it is also the honest headline:
with spacing enforced rather than requested, this path fails on good-looking output about as
often as it succeeds. The sealed pipeline remains the default, and the surviving argument for
it is exactly the one the experiment ended on — one call is a single point of failure in a
way that ~390 independent micro-calls are not.

---

## 2026-08-22 — addendum: the embedding pipeline (Briefcase method)

A THIRD chapter path, opt-in beside the sealed pipeline and the 27B single call. It keeps
this document's law intact — no model call sees a list, a count, or the whole video — and
removes the reason the law was expensive.

**The authority for this method is not this file.** It is the portable handoff document
that describes it in full, including every constant, both prompts, the measured model
ladder and the failure modes that shaped each decision:

> `/Volumes/Callisto/Projects/Briefcase/docs/chapter-pipeline-handoff.md`

with the reference implementation on Briefcase branch `analysis-pipeline-tuning`
(`backend/src/analysis/chapter-detection.service.ts`, `phrase-matcher.ts`,
`model-utils.ts`). Anything below that disagrees with that document is this file being out
of date; change the document first.

### What it replaces, and why it is so much cheaper

The sealed method spends ~2 model calls per 45 seconds of video before it has a single
boundary: stage 1 labels every stretch, stage 2 rates every junction. Both stages exist to
answer ONE question — how different is what comes before this point from what comes after
it — and this document already records that they answer it weakly (stage 2's ratings are
individually poor; the design's power is in RANKING them, not in any single score).

A text-embedding model answers that same question in milliseconds, batched, with a
continuous score. So stages 1 and 2 become one `/api/embed` call, and the generation model
is kept for the two things embeddings cannot do: quote the sentence a subject turns on, and
say what a chapter is about.

```
1. STRETCH      code        45s stretches, grid-aligned, never splitting a caption
2. SCORE        embeddings  ONE batched /api/embed call (nomic-embed-text);
                            block cosine over 2 stretches a side; valley DEPTH
3. SELECT       code        deepest valleys first, minGap enforced, `wanted` taken
4. PLACE        LLM         one small call per selected junction: quote the turn
5. CONSOLIDATE  code        merge adjacent chapters whose centroids still match
6. SUMMARIZE    LLM         one call per chapter, from its RAW transcript + context
```

Stage 3 is stage 3 of the sealed method, unchanged — `targetSecondsFor()` is IMPORTED, not
copied, so all three chapter paths want the same number of chapters. Measured on this
machine: 91 stretches of a 67-minute podcast embedded in **1.5 seconds**, and the whole run
— boundaries, placement and every chapter summarized — took **3m14s in 16 model calls**,
against the sealed pipeline's ~390.

### The two things that make it work

**Depth, not similarity.** A monologue that drifts has low cohesion everywhere; only a real
subject change is a VALLEY. Each junction's score is its drop against the nearest higher
peak on each side, which is what makes a talky passage rank below a genuine handover.

**Summaries are written from the RAW transcript.** The handoff document's section 8 is a
law of its own, and it is the fix for a failure this document already knows: the sealed
method's own ancestor summarized chapters from its 3-6 word stretch labels — a summary of
summaries — and produced "man yells about conspiracies". Here every chapter's prompt gets
(1) the chapter's actual transcript text, (2) the video's title or filename, and (3) the
PREVIOUS chapter's summary, threaded, so chapter N knows what "back to what we discussed"
refers to and titles do not repeat.

### Every degradation is DECLARED

The handoff document prescribes graceful degradations. This app does not have those: a
degradation that is not written down is a bug. So each one is a recorded mode — logged,
counted in `stats`, and pushed into `warnings` so it reaches the job report:

| Failure | What happens | Where it is recorded |
|---|---|---|
| The embed call fails | The lexical TF-IDF scorer scores the junctions instead | `stats.scorer = 'lexical'` + a warning naming the failure and what it costs |
| A placement answer is unusable, or its quote maps nowhere | That boundary keeps its raw ±45s junction time | `stats.approxStarts`, `startApprox` on the chapter, one warning per boundary |
| A placed quote maps BACKWARDS | The boundary is dropped | A warning naming the junction (the reference implementation drops it silently; that is the one thing in the source method not reproduced) |
| A summarize answer has no title | The chapter is named from its own opening words | A warning, exactly as the sealed pipeline's stage 4 does it |
| Under 2 stretches of transcript | One chapter, zero model calls | `stats.scorer = 'none'` + a warning saying the video was too short to score |

What is NOT degraded, and throws: transport failures (Ollama unreachable, model not
installed, timeout). Those affect every remaining call rather than one answer, and
`resolveChapters` already records `chaptersSkipped` for them.

### The Ollama traps this path had to handle

All three are the handoff document's section 6, and all three were observed live on
qwen3.8:27b during the port:

- **`think: false` is not sent.** It does not disable thinking; it RELOCATES the reasoning
  into `response`, which breaks the JSON and increases tokens.
- **`format: "json"` + a thinking model puts the answer in `thinking` with `response`
  EMPTY.** This happened on nearly every call of the validation run. Handled narrowly: when
  structured output was requested and `response` is empty, the object is read from
  `thinking`, and the log says so.
- **ONE `num_ctx` for the whole run**, bucketed to 4096 — Ollama fully reloads the model on
  any change. It is sized from the largest prompt EITHER generation stage can send, so no
  call is ever clamped; above the ceiling where the KV cache still fits on the GPU it warns
  (slower, still correct) and above 32768 it refuses (a truncated prompt would summarize a
  chapter's opening and call it the chapter).

### Validation on this machine, 2026-08-22

Both runs on qwen3.8:27b with nomic-embed-text, against ground truth read independently
from the transcripts beforehand.

**67-minute four-segment compilation** (`podcast1.srt`, segment handoffs known at 14:52,
26:03 and 53:38):

- 91 stretches embedded in **1.5 s**; 90 junctions scored; 10 boundaries selected. Whole
  run, boundaries through summaries: **3m14s in 16 model calls**.
- **Every one of the 10 placement calls resolved its quote.** Zero approximate starts, zero
  warnings, zero dropped boundaries.
- Two of the three known handoffs were hit EXACTLY: 14:52 ("This is Kat Kerr, you may be
  familiar with her.") and 26:03 ("There's this Oklahoma political candidate."). The scorer
  had put candidates at 15:01 and 26:16 — within one stretch — and placement pulled both
  onto the sentence.
- The third handoff, 53:38, is **missed**, and the depth profile says why rather than
  leaving it a mystery: the junction at 53:16 (22 s early) is the 6th-deepest of 90 at
  0.317, but 51:00 (0.330) was taken first and 53:16 sits 136 s after it, inside the 216 s
  `minGap`. That is the tradeoff the handoff document names in §3.3 — "minGap suppresses
  genuinely close pairs" — showing up on the first real video, not a surprise. The content
  of that segment is not lost; it is inside the chapter that starts at 50:58.
- Consolidation merged 11 boundaries to 6 chapters at centroid similarities 0.835-0.905,
  and the chapter titles/summaries name the actual people and claims (Kat Kerr's
  prophecies, the Oklahoma school-board candidate, the denazification comparison) rather
  than describing the video generically — section 8's law doing what it is for.

**20-minute single-topic-ish video** (`starburst.srt`): 27 stretches, 5 boundaries selected,
consolidation merged 6 chapters down to **3** — the shape the depth profile of a
single-subject video should produce. Every quote resolved; zero approximate starts; 8 model
calls, 2m47s.

### Status

Opt-in, routing option `chapters-embedding` ("Embedding pipeline (Briefcase method)"), and
it is the only option in the table that needs TWO models — the generation model plus
`nomic-embed-text`. The picker names whichever one is missing before the run rather than
reporting the option installed on the strength of half its requirements; if it runs anyway
without the embedding model, the lexical scorer is declared in the warnings rather than
substituted quietly.

Implementation: `electron/services/metadata/chapter-embedding.service.ts`, prompts in
`chapter-prompts.ts` as `CHAPTER_EMBEDDING_PROMPTS` (kept separate from the sealed five and
from the single-call pair). The sealed pipeline remains the default.

(Superseded within the day — see the next addendum.)

---

## 2026-08-22 (later the same day) — addendum: the embedding pipeline is the only pipeline

Everything above this line is now HISTORY, not instructions. The sealed 14B method and the
27B single call have been **deleted from the codebase**, and the embedding pipeline is not
an option any more — it is what chaptering IS.

### What changed

- The `chapters` task is **gone from the routing table**. It is not selected, defaulted or
  asked about. Every item that reaches generation with a timestamped transcript is
  chaptered by `chapter-embedding.service.ts`; an item with no timeline (a text subject)
  records the same truthful `chaptersSkipped` it always did.
- **Deleted**: `chapter-pipeline.service.ts`'s `ChapterPipelineService` (the five stages),
  `chapter-single-call.service.ts` in full, `CHAPTER_PROMPTS` (the sealed five) and
  `CHAPTER_SINGLE_CALL_PROMPTS`. What survived the first file is its pure transcript
  machinery — the cue reader, the word stream, the cadence table, the result shape — which
  the embedding pipeline imports and which now lives in `chapter-transcript.ts`.
- **Deleted routing options**: `cogito-14b`, `qwen25-14b`, `qwen3-14b`,
  `chapters-qwen27b-single`, `chapters-embedding`.
- The models are declared in code as `CHAPTER_PIPELINE_MODELS` (`qwen3.8:27b` +
  `nomic-embed-text`). The routing modal still REPORTS whether they are installed, because
  that warning was the useful half of the picker: without the generation model there are no
  chapters at all, and without the embedding model the run declares the weaker lexical
  scorer in its warnings.

### Why the picker went

Three architectures were offered because the third had just been ported and had one day of
validation on this machine. It won on every axis that was measured — an order of magnitude
fewer calls, better boundaries, an ad break the whole-transcript approach missed entirely
— and the other two were left selectable out of caution rather than doubt.

Caution that leaves two slower, worse implementations reachable from a dropdown is not
caution. The default among the six chapter options shipped as `cogito-14b`, a model that is
not installed on this machine, and that is how chaptering silently produced nothing for a
period. A picker whose wrong answers cost an hour of a run is a trap.

### Settings migration

An existing store holds a `metadataRouting.chapters` entry naming an option that no longer
exists, and `validateRoutingSelection` throws on unknown ids — which would have failed
`metadata-routing:get`, the one screen where a user could have fixed it.

`migrateStoredRouting` (metadata-routing.ts) drops exactly the ids listed in
`REMOVED_ROUTING_TASKS` / `REMOVED_ROUTING_OPTIONS`, logs a notice per drop naming what went
and why, and the IPC handler writes the migrated object back so the notice is logged once
rather than on every read. An id this build never had still throws. Anyone removing an
option in future adds it to those maps in the same commit.

### The Ollama traps moved, they did not go

All four are now in `ollama-json.ts`, shared with the metadata task units, which moved onto
local base models on the same day. `chapter-embedding.service.ts` keeps its own POLICY (an
unusable answer costs one boundary or one chapter name, and the stage warns and carries on)
and no longer keeps its own copy of the mechanism.

### One prompt change, and it is not cosmetic

`SUMMARIZE_CHAPTER` and `SUMMARIZE_CHAPTER_TAGGED` now state a REGISTER: describe the
content in topic and noun-phrase form, and never invent a subject ("the speaker", "the
host", "the narrator", "this video", or a bare "he"). Left to itself the model wrote "The
speaker discusses mainstream alien belief, Roswell, and Trump's UAP disclosure order" — a
sentence whose subject it made up. It cannot know who is talking: on these channels the
voice in any given second is either the creator or the footage he is reacting to. This is a
register instruction, deliberately not a banned-word check on the output — pointed at the
right grammar, the phrasing does not arise, and nothing has to police it afterwards. The
same rule is in the prompt sets' `## DESCRIPTION` and `## CLIP_SUGGESTIONS` sections.

---

## 2026-08-22 (later still) — addendum: the embedding pipeline is REVERSED OUT

Everything above this line is now history. The embedding pipeline shipped in the morning and
is **deleted** by the end of the same day, and chaptering is back to the shape it had before
any of it: **one call reads the whole transcript and names the chapters**. This section is the
measurement that decided it, because a reversal with no numbers on it is a mood.

### The regression, measured

Eight videos with boundaries labelled by hand from the transcripts beforehand — five "subtle"
(a commentary video turning from one source to the next inside one subject) and three
"clear-split" (a compilation with known segment handoffs). 28 labelled boundaries. Kit
preserved at `/tmp/contentstudio-chapter-eval`.

| architecture | recall@30s | recall@60s | precision |
|---|---|---|---|
| embedding pipeline, as shipped | 9/28 (32%) | **12/28 (43%)** | 10/30 (33%) |
| embedding pipeline, best of a full parameter sweep | 12/28 (43%) | 17/28 (61%) | 13/36 (36%) |
| 27B reads the whole transcript, "report every beat" | 22/28 (79%) | 24/28 (86%) | 49/107 (46%) |
| 27B reads the whole transcript, cadence band restored | 20/28 (71%) | **24/28 (86%)** | **23/29 (79%)** |

Split by class, the restored path is 10/14 at 60 s on the subtle videos and **14 of 14 inside
30 seconds** on the clear-split ones, with zero spurious boundaries on that class — the
compilation handoffs a viewer would notice immediately are all landed to the sentence.

The sweep is the important row. Stretch length, block width, min-gap, consolidation threshold
and the wanted-count were all swept, and the best configuration in the whole space reached 61%.
**The failure is not tuning, it is the premise.** A cosine valley between two 90-second blocks
measures how much the VOCABULARY changed. A video that plays four clips of four different
people all saying the same thing about Islam has one vocabulary and four chapters, and there is
no valley to find: **nine of the eleven** boundaries the best swept configuration still missed
had no valley at the labelled second at all, and three of those are 30-90 seconds apart inside
one 9-minute video.

Reading the transcript is not a better version of that signal, it is a different signal.
"This is a new clip of a different person making the same argument" is reading comprehension,
and it is what the 43% architecture had thrown away.

### What the restoration is, exactly

The deleted 27B single call was thrown out in the first place for its RETRIEVAL — it quoted a
3-8 word phrase and matched it against a SAMPLED excerpt, and phrases landed on the wrong
minute. Its CADENCE language was never the problem. So the restored path is the old build's
cadence over the new build's retrieval:

- **The full first sentence, six words or longer**, mapped against the whole caption word
  stream with a chronological cursor. Measured across the runs above: **137 of 138 quotes
  mapped, none out of order.** A full sentence is long enough to be unique; the old 3-8 word
  phrase was not, which is why it needed rules about never bridging across gaps.
- **The runtime stated once as a plain fact** ("The video runs 42 minutes"). The transcript
  carries no timestamps — that is what makes a quote-mapped time a measurement — so a model
  that cannot see time is TOLD the runtime and given a rate.
- **A graduated cadence band.** The old build's flat "every chapter covers at least 3 to 4
  minutes" was measured first: it bought precision 46% → 79% at no cost to recall@60, but the
  four boundaries it lost were all on short videos, whose real chapters sit 30 seconds to 2.5
  minutes apart. On a short video a turn to a different source IS a chapter. So the floor
  follows the runtime — under 10 minutes / 10 to 30 / 30 and longer — and inside the rung the
  **content decides the count**. Code computes no count anywhere; `targetSecondsFor`, the
  code-side cadence table every deleted architecture used, is gone.
- **`num_predict` 8192, not 4096.** A 72-minute podcast hit the 4096 ceiling on both the first
  ask and the re-ask and contributed nothing at all. Thinking and the answer share one budget.

### What was deleted

`chapter-embedding.service.ts` in full: the stretch/score/select/consolidate machinery, the
batched `/api/embed` call, the per-junction placement stage, and the lexical TF-IDF fallback
scorer. The fallback is deleted rather than kept behind a flag — two chapter architectures in
one tree means one of them runs when something goes wrong, which is this app's cardinal rule
violated by construction.

What survived is what was always pure: the cue reader, the word stream, the quote matcher
(`findQuoteTime`, now in `chapter-transcript.ts` beside the cursor that drives it) and the
result shape. `nomic-embed-text` is still installed and still used — by key-phrase ranking,
which is where it is now declared (`KEY_PHRASE_EMBEDDING_MODEL`). It is not a chapter model
any more and is no longer reported as one.

### The architecture now

1. **CHAPTERS** — LLM, one call. Whole transcript, no timestamps, runtime stated, graduated
   band, a 50-80 character title and the verbatim first sentence per chapter.
2. **MAP** — code. Each sentence to a second, forwards only. Unmappable is **dropped and
   named**, never approximated: the quote is the only positional evidence this architecture
   produces, so there is no weaker second measurement to fall back on and an interpolated time
   would be a guess wearing a measurement's clothes.
3. **DETAIL** — LLM, one call per chapter from its raw transcript, for the 20-45 words the
   description and tags condition on.

1 + N calls, N being 3 to 8. Every chapter's title has exactly one source: the chapter call's
label, or — for the opening 0:00 chapter, which the prompt does not ask for because the opening
of a video is not a turn — the detail call's title. The detail call still writes a title on
every chapter and it is discarded wherever the chapter call already supplied one, so the two
stages can never quietly disagree.

### What this addendum does NOT claim

The four-row table above measures **boundaries**, not titles, not details, and not the
description and tags that condition on them. The graduated band is a one-line change to a body
that was measured flat; the recovery of those four short-video boundaries is its intent and
has not itself been re-measured. Implementation:
`electron/services/metadata/chapter-whole-transcript.service.ts`, prompts in
`electron/assets/prompts/shared/pipeline/chapters.yml`.
