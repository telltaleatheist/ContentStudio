# Prompt learnings

**The rule going forward: the prompt files carry zero comments.** Every `#` line in
`electron/assets/prompts/**` was a YAML comment — js-yaml discards it, no model ever read it,
and the operator now edits those files directly in the app's Instructions page, where a comment
is just text in the way. So the files say only what the model reads, and what we learned about
why each line is there lives here.

Adding a line to a prompt? Record what failed without it here, with the measurement. Removing
one? Say so here too — a line that came back with evidence (chapters' response-as-content rule,
LEDGER #172) is worth as much as one that left.

This document is distilled from the comments as they stood at the strip, plus the ledger
entries they cite. It is not a verbatim dump; the raw text is in git history at the commit
before "The prompt files say only what the model reads".

---

## Part 1 — The laws the whole tree obeys

### One directory holds every model-facing string, and nothing falls back

Every word this app sends a model lives under `electron/assets/prompts/`. The code that used to
hold these strings as constants (`system-prompts.ts`, `chapter-prompts.ts`) keeps only the
assembly. A missing file, key or channel **throws naming both** — there is no built-in
substitute for any prompt. (LEDGER #128.)

The reason is measured, not aesthetic. `ai-manager.service.ts` used to fall back to *"You are a
helpful assistant that summarizes video transcripts"* when the summarization file was missing.
That produced a summary with none of the ammunition the downstream calls need and **no sign
anything had gone wrong**. A fallback prompt produces output that looks generated and was
written to no brief.

### Positive form only

No block states a wrong form, shows a bad example, or names the thing it is steering away from.
A model shown a wrong form reproduces it, and attaching the word "never" to it does not change
that. Proven twice over on this tree:

- The compilation framing used to carry a WRONG/CORRECT title example pair and a five-line
  "WRONG (do not do this)" description sample. Both are gone; the same rules state cleanly as
  what to do. (LEDGER #131.)
- 2026-08-24: a stage-3 chapter title came back as *"narrator says…"*. The first fix — "the
  video's own commentary needs no attribution" — produced titles **about the commentary**.
  Naming the thing you are steering away from invites it. The working fix was the
  response-as-content rule restated positively: a response stretch is titled by the claim and
  the verdict. (LEDGER #172.)

Two grandfathered exceptions, both in `editorial-core.yml`: the AI-tells list and the
clickbait-filler list. Those are banned **phrases**, not banned register — a model shown "delve"
does not learn to write like a video essay, it learns which word to leave out.

### The minimal-prompt method

One load-bearing instruction beats a taxonomy. A line survives only if something fails without
it. Established on titles (LEDGER #168) and chapters (#169–#170, #172), and it works in both
directions: lines are cut, the result is measured, and a line that measures as necessary comes
back.

### Plain text, not JSON (law 12, operator's ruling 2026-08-24)

No JSON for generation calls unless absolutely necessary. The one survivor is the **compilation**
call, whose answer is genuinely structured — every field of the channel in one object. Its
per-field OUTPUT FORMAT blocks name each call's plain shape instead.

### The count is the model's; counts anchor and rates get ignored

Code counts nothing. Every deleted chapter architecture computed a target count from a cadence
table and handed it over, which is what put a boundary in the middle of a subject on a video
with four real ones.

But **a model anchors on counts, not rates**. "One every 2 to 4 minutes" measured as ignored —
25 chapters at 1:40 spacing on the 41-minute *dont be a sucker* run — while the stories grain's
count table held its band on every fixture. Broad's band is now graduated counts (4-7 / 6-10 /
10-14 by runtime); re-measured on the same transcript it gave 14 chapters at ~3-minute spacing
with both ads still isolated to the second. (LEDGER #172.)

### Placeholders are filled in ONE pass, with function replacers

Never chained `.replace` — a chain rescans inserted text, so a transcript containing `{pools}`
would be substituted into. Function replacers because transcript text routinely contains
`$`-patterns (`$&`, `$'`, `` $` ``) that a plain string replacement expands and corrupts. An
unfilled brace survives visibly rather than being silently blanked. (LEDGER #135.)

### A rule the call cannot follow is worse than no rule

An unfollowable line teaches a model that some of this prompt is decoration. This is why the
self-check is assembled per call, why `{brand_terms}` and `{promoted_items}` are filled with the
channel's real data, and why the speaker-tag block is omitted on an untagged transcript.

---

## Part 2 — Channels (`channels/*.yml`)

### They are pure data

Nothing in a channel file tells a model *how* to write. It says what the channel **is**, which
fields it publishes, and what code appends. Every instruction comes from `shared/`. That
separation is the layout's whole point: a new channel is one file and nothing else. `id` is the
stored prompt-set id, unchanged from the ymls these replaced, so existing settings stores and
every historical job JSON keep resolving.

### The `fields:` list is a statement, not a config

It is what the old prompt sets said by which `##` sections they happened to contain. A field
absent from the list is not generated, not routed, not assembled, and the run's log says so —
which is how the Spreaker podcast set has never had thumbnails without that looking like a
section gone missing. Order is the emission order. (LEDGER #133.)

Per channel: **Spreaker** publishes exactly three fields (no thumbnail, no hashtags rendering
above a title, no pinned comment, no Shorts feed). **Shorts** publishes no `thumbnail_text` at
all — a Short has no thumbnail — and is the one channel with `spoken_keywords`.

### `brand_terms` vs `channel_tags` — the "O. Morgan" finding

These are two different lists and conflating them broke tags twice.

- **`channel_tags`** are appended verbatim by code after the model has answered.
- **`brand_terms`** are the search surfaces a viewer actually types, named *inside* the TAGS
  instruction through the `{brand_terms}` slot.

The old flat prompt sets carried the list inline in every channel's `## TAGS` section —
*"channel brand terms (owen morgan, telltale, telltale atheist)"* — and every tag list the
operator has shipped contains those terms because of it. Genericised on the move to shared
fields to a bare *"channel brand terms"*, the line became **unfollowable**: nothing else in the
tags call names the channel. The model either omitted them (harness run 1) or **invented a
creator name — "O. Morgan"** (production run `job-1787440820706-wk0cej99g`).

So they are channel data now, and a channel whose section asks for the slot and declares no
terms **throws**, exactly as `{title_format}` does. Shipping the literal brace, or quietly
blanking the line back to its unfollowable form, is what that throw replaced. `check:pure`
asserts the real terms reach the assembled telltale section and that Shorts does not inherit
telltale's list.

### `promoted_items` — the exclusion that names what it excludes

The creator's own promotions: things advertised *inside* the videos that are not part of any
video's subject. Filled into the `{promoted_items}` slots in the description, titles and tags
instructions and into the chapter prompts, where the rules say what goes where — a stretch of
video that **is** one of these is a plug chapter (labelled as such; code excludes it from the
published list), and none of them appears in a title, a description sentence, a tag, or a
content chapter's label.

**Add future sponsorships and promotions to this list** — the prompts read it, so an entry there
is all it takes.

One caution recorded 2026-08-24 (LEDGER #171): `{promoted_items}` carries `owenmorgan.com` into
every stage-3 chapter call on **every** transport, which is a second name-leak path independent
of `claude -p` memory. Both stage-3 bodies therefore state that the list exists to recognize ads
and that every person named comes from the transcript.

### Unfiltered's title format

Unfiltered posts one long stream split into independent hour-long parts, and its titles carry a
structural tail that deliberately runs **longer** than any normal character cap. That is why the
length rule in `titles.yml` is a `{title_format}` slot rather than a fixed line. The pipe tail is
exempt from the one-unbroken-claim guidance for the same reason: it is structure, not a colon
construction. The one editorial block that genuinely differs for the channel is title
philosophy — a stream title promises a conversation to settle into, not a six-minute payoff.

---

## Part 3 — The editorial core (`shared/editorial-core.yml`)

One copy of material that used to be duplicated, near-identically, across five per-channel
prompt sets. Model-facing text lives under `blocks` in emission order; the per-channel
differences that are **real** live under `variants`, keyed by the `editorial_variant` a channel
declares. A key present in a variant replaces that block; the literal string `omit` drops the
block for that variant. (LEDGER #130.)

Two consolidations made it shorter than any one set it replaced:

- The two emotion taxonomies ("EMOTIONAL TRIGGERS THAT WORK" and "TARGET EMOTIONS BY CONTENT
  TYPE") were near-duplicates — the same five reactions, once as a list and once as a
  content-type mapping. They are one block now, each trigger carrying the content types it
  leads on.
- *"Do not write ten rephrasings of one title"* was stated four times across the sets. It is
  stated **once**, in `fields/titles.yml` where the titles are actually asked for, plus one
  terse line in that field's self-check.

**The default variant lost four blocks** after the operator's read-through of the assembled
titles prompt (2026-08-24): the illustration notice (its referent, the in-core title examples,
left with title_philosophy), input awareness, the internal-analysis step (adaptive thinking does
this natively now), and the title philosophy — whose load-bearing prosecutor line moved up into
reframing. Unfiltered, shorts and spreaker keep their own variants.

Variant rationales on record: **Unfiltered** — only what a title is promising changes.
**Shorts** — a different product on the same platform: a one-second thumb-stop, a 40-character
title, no thumbnail, a funnel back to the long-form video. **Spreaker** — no thumbnail and no
feed, so the title and the first 120 characters of the description *are* the entire pitch, and
episodes stay searchable for years.

`{channel_focus}` is the one slot a channel fills here, and it is data, not instructions.

---

## Part 4 — Field instructions (`shared/fields/*.yml`)

### `titles.yml` — the house exemplar for the minimal form

Rewritten to the minimal form on the night of 2026-08-24 (operator-directed; **LEDGER #168**).
The 20-bullet version — framing taxonomy, swap test, front-load rules, anchor quotas — measured
**worse** than the ten-line version on the same model and transcript. The operator's diagnosis
was that the important instruction was drowned out, and five harness arms (opus ×3 register
variants, opus subject-input, qwen 27B) confirmed it.

The core is **"find the underlying argument and sell that"**; everything else in the block is
either a channel law or a parse contract. The full history of the old block, including the nine
defects fixed in the 2026-08-22 consolidation, is in git history and the ledger.

The shorts and spreaker overrides are **different jobs** and still carry their older long-form
blocks — not yet re-measured against a minimal form.

`{titles_count}` and `{title_format}` are channel data slots. `default_title_format` exists as a
slot rather than a fixed line because of Unfiltered (above).

### `tags.yml` — the separator, the exemplar, and the register

Read by exactly two paths. On the **chaptered** path tags are assembled in code from the entity
and key-phrase pools with no model call at all, so this section is stripped out of every group's
instructions. It is sent to a model on the **text-subject** path (no chapters, therefore no
pools measured against a chapter list) and on the **compilation** call, and it is what declares
that the channel publishes tags at all.

**The separator.** Nothing in the section originally said the tags are comma-separated. The only
place that said so was the OUTPUT FORMAT's type annotation, `"tags": "comma-separated string"` —
a description of the value rather than a demonstration of it. Survivable while the whole
metadata object was written in one Sonnet call; not survivable once tags became their own call
on a 9B. Measured on qwen3.5:9b through the harness, three runs on one fixture: **two of three**
came back as a single space-joined run-on —

> `Marcus Wray private jet fundraising televangelist cult prosperity gospel demonically
> influenced trolls high-control church scams Marcus Wray fourth jet allegations`

— which the comma split reads as one 160-character tag, indistinguishable downstream from a real
one. The one production channel that came back correct (`job-1787440820706-wk0cej99g`,
podcast-spreaker) was the one variant whose text happened to contain the words
"comma-separated".

**What the fix is not:** splitting the answer on whitespace. The information needed to split it
is not in the answer — "prosperity gospel scam" is one tag and whitespace makes it three — so a
whitespace split does not recover the tags, it invents different ones, against the rule that
multi-word phrases are the point. The prompt states the separator, **shows** it, and the run
refuses a list that came back without one (`tags-hashtags.ts` `unusableTagList`, asserted in
`check:pure`).

**The exemplar names its slots** rather than showing a real tag list, and that too was measured.
Shown a real shipped list (`"ken paxton,texas ten commandments law,sb10,…"`), qwen3.5:9b answered
a video about a televangelist's private jet with *"sb10 ten commandments law"* and *"texas
prosperity gospel"* among the tags. The editorial core's "all examples are ILLUSTRATION ONLY"
line sits at the top of the prompt and the exemplar sits at the bottom, next to the answer. A
slot-named exemplar shows the commas exactly as well and has no content to lift.

**The brand terms** — see Part 2; that finding is a tags finding first.

**The register (2026-08-25 minimal rewrite).** The section was rewritten in the `titles.yml`
minimal style: eight lines. The ordering core is the contract the retired tags adapter was
trained on, which is the most compact correct statement of the job we have —

> the most specific two-to-four-word phrase for the main subject first, then the named people,
> organizations and events it covers, then the broad category terms it belongs to. Accurate and
> boring beats clever — tags are a labelling job, not a hook.

Kept because measured or structural: the `{brand_terms}` line naming the terms outright, the
`{promoted_items}` exclusion in positive form, the slot-named comma exemplar, the 500-character
budget, and the misspelling line (misspelling coverage is the one tag use YouTube officially
endorses). Dropped as narration: "Prioritize specific multi-word phrases over single broad
terms" (the ordering line says it), the three-sentence elaboration of the comma rule (the
exemplar plus the OUTPUT FORMAT block say it twice already), and Spreaker's note that Apple and
Spotify ignore RSS keywords. Spreaker's *"No creator or channel name"* became the positive
"every tag names the episode's subject". Before/after on the *3 - islam* fixture through
`claude -p --model sonnet`: both arms returned clean comma lines; the new one led with the
subject phrase and stopped emitting the labelled artifact `"andrew womack misspelling"` that the
old bullet produced.

There is **no `{tags_count}` slot** — no channel declares a tags count, so the range is written
into the instruction text (8-12 default, 5-8 shorts, 8-15 spreaker). Adding a slot would mean
adding `counts.tags` to every channel that publishes tags, and `fieldSection` throws on an
unfilled count slot.

### `hashtags.yml`

Hashtags are **derived in code** on every routed path (`tags-hashtags.ts`: the entity and
key-phrase pools, camel-cased, deduped against the published title), so this section is stripped
out of every group's instructions. It survives because it declares that the channel renders
hashtags at all, and because the compilation call still reads it.

### `description.yml`

**Who reads it.** Everything that writes a description, which since 2026-08-22 includes the
routed path again: the description unit's plain-text call takes this block whole as its
`{rules}`, and the compilation call has always read it in full. It also declares that the
channel publishes a description at all.

**Withholding the rules was measured wrong.** They used to be kept from the description calls on
the argument that fifteen editorial bullets over-specify a small schema-constrained model. The
one production run that happened under that arrangement wrote a 324-word synopsis of the
narrator with no second paragraph and no CTA — on a prompt that reaches Sonnet and Opus
unchanged. A call given no brief writes to no brief.

**The attribution addendum (2026-08-23).** The register bullet has always said the true thing
about a reaction channel — *"Who is talking changes shot to shot — sometimes it is this channel,
sometimes it is the footage being reacted to"* — and until speaker tagging existed that was all
it could say, because nothing told the model **which**. The model's own answer was to make the
speaker never the subject of a sentence, which dodges the problem rather than solving it: a
description that names nobody cannot misattribute, and also cannot say who was right. Where the
transcript is tagged, an addendum is appended that lifts the dodge for the one thing the tags
settle — the description may say who said something, because the transcript says.

It is a **separate key** rather than a line inside `instructions` for the reason every
conditional in this tree is one: `instructions` is also read whole by the compilation call,
which has no transcript at all, and telling that call to read tags it was never shown would be a
rule about nothing.

**`body_words` is data, per variant.** The number in the prompt and the number
`description-unit.ts` warns against are one number. It measures the **body** only — the hook is
its own call under its own character cap — and a body outside the range is a declared warning on
a paragraph that still publishes, never a truncation. Per variant because the variants are
different documents: a YouTube description is **one** paragraph (operator-directed 2026-08-23;
the below-the-fold second paragraph is gone and the code-appended chapter list is what sits under
the prose), a Spreaker episode note is 150-250 words by its own rule, and a Shorts description is
two or three sentences nobody reads. One shared number would have made the warning wrong on two
channels out of three.

### `self-check.yml`

**Why it is split.** The self-check used to be one verbatim block riding with whichever group
held the titles. That was right when everything was one call and wrong the moment fields were
routed apart: a titles-only group was being told *"thumbnail options don't repeat core words from
the top 3 titles"* about thumbnail text it would never see — an instruction it cannot follow,
and therefore one that teaches it only that some of this prompt is noise. (LEDGER #129.)

Now the `global` lines ride with every group that carries the self-check, and each field
contributes its own lines from its own file (`self_check`, plus `self_check_with` for lines that
need a second field in the same group). Nothing is trimmed by pattern-matching — a line is only
ever emitted where the group can actually perform it.

**"ASCII characters only" was wrong** and is gone. It banned "Beyoncé" and "Muñoz" along with the
emoji it was aimed at. Diacritics in a real name are the correct spelling of that name; the line
now says what it means.

### `thumbnail-text.yml`

Byte-identical across every channel that publishes a thumbnail, so it lives here once. Shorts and
Spreaker publish no thumbnail and simply do not list the field.

The cross-field half of its check rides only with a call that can **see** the titles — which,
under one call per field, means the call handed them as input data. Where nothing writes titles
this run, neither model can see the other's answer and the line is left out rather than sent
unfollowable. The check is about **angle coverage, not word overlap**: the human picks the final
title+thumbnail pairing, so the model's job is a diverse option set, not dedup against titles
that may never ship (2026-08-22, supersedes the old no-repeat rule).

### `pinned-comment.yml` and `spoken-keywords.yml`

The pinned comment is identical across the long-form YouTube channels; Shorts uses it as the
funnel CTA back to the full video, which is a different job and carries its own override. First
person is the register of the pinned comment **only** — see the description finding below.

Spoken keywords are the words that must be **said aloud** in a Short for YouTube's own transcript
index to find it. Only the shorts channel publishes the field; no routing task owns it, so it
rides with whichever group absorbs the sections no unit claimed.

---

## Part 5 — The pipeline (`shared/pipeline/*.yml`)

### `chapters.yml` — the laws these bodies encode

- **The model never emits a timestamp.** It quotes a verbatim sentence and code maps that quote
  to a time against the caption word stream (`chapter-transcript.ts`). An invented timestamp is a
  guess; a mapped quote is a measurement. The verbatim-quote contract is the llm-beats
  measurement: 137 of 138 quotes mapped.
- **The count is the model's** (see Part 1).
- **Stage 1 sees the whole transcript** — that is the point of it (CHAPTERING.md's 2026-08-22
  reversal). `summarize_chapter` still sees **one** chapter, because describing a chapter is a
  different question from finding one, and it reads that chapter's **raw** transcript, never an
  intermediate label, plus two pieces of real context: the video title and the previous chapter's
  summary.
- **Positive form only.** These bodies state the style wanted and show correct examples. The
  register failure they replaced (*"The speaker debunks …"*, *"A YouTuber critiques …"*) is caught
  in **code** afterwards by `chapter-title-quality.ts` — a declared warning, never a rewrite.
- **Real names in examples carry a stated risk.** A prompt example naming a real person leaks
  into outputs about a *different* unnamed person of the same archetype, deterministically, at
  temperature 0. The 2026-08-24 minimal rewrite (**LEDGER #169**) removed the Gene Bailey register
  examples along with the topic-form spec they anchored — five harness arms showed the stage-3
  bodies stayed concrete without them. The few examples left ("God's People", "this is the
  pastor") are the operator's own promo and attribution anchors. The managed risk stands because
  the grounding check tests every proper noun in a returned title against that chapter's own
  transcript, so a leaked example name is **detected and reported** rather than shipping
  unnoticed.

**Three grains since 2026-08-24 night** (operator's design; **LEDGER #170**): the operator picks
what is being detected and the model decides the count inside that grain's band.

| grain | what it detects | validation |
| --- | --- | --- |
| `whole_transcript_detailed` (default) | a standalone video's internal turns — the next clip on the same story, the article's next claim | duffy: 10 chapters, ads isolated, no slivers |
| `whole_transcript_broad` | the same subject in larger pieces | duffy: 7 — a clean coarsening |
| `whole_transcript_stories` | compilations (weekly podcast merges, streams): a run of separate stories | f1/f3/u1/u2 against the production baseline — counts in band, every ad isolated two-sided, boundaries on the same turns |

All three are **minimal bodies**, cut from the 600-word 2026-08-22 body the same night the titles
prompt went minimal, and re-measured piece by piece: the bare six-line form **overcounted 2-4×**
on every fixture until the size band returned, and the size band alone **swallowed ad chapters**
until the promo exception returned. Each surviving line is there because an arm without it
failed. The graduated stories band is the restoration-v2 measurement.

Surviving in every grain: no timestamps; the count is the model's inside the operator's grain;
**the opening chapter needs no entry** (the mapper synthesizes 0:00, and an emitted first line
would double it); the answer is lines, not JSON.

On a transcript too long for one call the code sends the selected body over a **rolling window**,
each window told its own runtime. Nothing in these bodies knows about that — and per LEDGER #173
that is exactly why windowing multiplied counts, which is why the cloud window is now 7,000
words: every video in the operator's batch runs as one call.

**Stage 3 owns the title** (2026-08-24). Stage 1 stopped producing labels when its answer became
bare quote lines, so every chapter — the 0:00 one included — is named by the call that reads the
chapter's own transcript. The answer is plain text: title on the first line, summary after it.
`{entity_scaffold}` is the proper nouns extracted from **this** chapter's slice, per-chapter and
never whole-video — a whole-video list invites the name from chapter 2 into the title of
chapter 5.

**The tagged variant, and the third tag.** ContentStudio's imported AutoCutStudio transcripts
carry a HOST/CLIP side per caption, and since 2026-08-23 so does a Whisper run with a voice
enrollment configured. Untagged, a summarizer cannot tell the host's verdict from the claim being
played and **inverts attribution**. The tagged body runs only when every caption resolves to a
side — and "resolves" includes `UNSURE`, which the voice tagger produces for a caption straddling
a cut (whisper.cpp does not break captions on speaker changes). Measured on the calibration
transcript: **18 captions in 297 (6%)** come out UNSURE, and every one of them, read back, has an
audible speaker change inside it. So the prompt states what an UNSURE line is rather than leaving
the model to infer it from an unexplained third label, and what it states is the one thing that
is true of those lines: **the words were said, and nobody in particular said them.** Attributing
them to whichever side is adjacent would be a guess printed as a fact — the failure the whole
prompt exists to stop.

### `description.yml` (pipeline)

**One call writes the whole description** (2026-08-24). Hook and body used to be two
schema-constrained calls; they are now one plain-text answer in the shape the composer publishes
— opening line, blank line, body — which removes both the JSON failure surface (the `"…"`
whole-body bail-out, the close-quote runaway) and a call per candidate.

**The subject of every sentence comes from inside the video.** Two corrections landed here:

- 2026-08-22: both calls' register lines carried a leftover negated clause naming the wrong
  subjects, against the positive-form law. Restated positively — the doer in every sentence is a
  person, claim or event on screen.
- 2026-08-23: the first cut of that fix framed the description as the creator's own words, first
  person where the creator's actions came up. A measured run produced *"I debunk its bullshit"*,
  *"I also dismantle"* — and the operator rejected the "I" as firmly as "the speaker". The
  description is a **summary of the content**: the page making the claim, the argument under
  examination, the evidence that undoes it. First person remains the register of the pinned
  comment only.

**What the calls carry.** `{channel}` is the channel's real name and its own focus paragraph — it
replaced the stored prompt-set **slug** (`youtube-telltale`), which named the channel to a model
in the one form that carries nothing. `{rules}` is the channel's `## DESCRIPTION` section, the
same block the compilation call reads.

**`{coverage}`** is one of two labelled blocks: the chapter list where the pipeline produced one,
the text subject where the item has none. Both say the same thing about what the model is working
from and differ only in what that is.

**`{transcript}`** is the video's own words, and it **supersedes** the summaries-only input these
calls used to run on. It is rendered *beside* the chapter list, never instead of it — the chapter
list is a measurement of what the video spends its time on, which a transcript does not tell you.
It is empty on a chapterless item (the coverage block already **is** the only description of the
video that exists) and empty again on an item over the direct-pass ceiling, where the content is
the **chapter digest** and `{coverage}` already carries that list. Nothing summarized is ever
rendered under this heading: a condensation printed under *"The transcript of the video, in full"*
would tell the model it has quotes it does not have — precisely the failure the blind summarizer
this replaced used to cause.

**`{speaker_tags}` (2026-08-23)** explains that transcript when it is tagged and is empty when it
is not. The chapter prompts had a tagged variant for as long as AutoCutStudio imports carried
track attribution; these calls never did, and the omission produced the failure that motivated the
whole speaker-tagging feature. The operator's own example, from a shipped description: *"Fox News
frames the 13th Amendment's prisoner exception as…"* — when the person who raised the 13th
Amendment, and who explained the prisoner exception, was the **host**. The transcript is two
people's words in one stream, and a call with no way to tell them apart attributed at random,
handing the host's argument to the people he was arguing with roughly half the time.

It is a **block** rather than a second copy of each prompt — where `chapters.yml` duplicates
`summarize_chapter` into `summarize_chapter_tagged` because the tags change how the whole answer
is composed, here they change one thing (who a sentence may be attributed to), and the slot
mechanism the file already uses for `{coverage}` and `{transcript}` says exactly this kind of
thing conditionally. Its own rules are positive form: every line says what to attribute where,
and the last one — attribution comes from the tag, so a sentence about who said something is
reading the tag, and the tag on an UNSURE line says nobody — is stated as an instruction to
follow rather than a mistake to avoid.

### `insights.yml` — the guidelines distiller

**Why the call exists** (operator, 2026-08-24): the CHANNEL PERFORMANCE DATA block used to ride
into every insight-carrying generation call whole — ~6k characters of *other* videos' literal
titles and stats. That stretches the generation call's context and, worse, **seeds it with
unrelated subjects**, which is the same leak the chapter examples are nameless for. So the raw
evidence goes to this one call, which writes the transferable lessons, and only the lessons ride
along in generation.

**Subject-free is the contract**: pattern-level lessons with no topic, name, or recognizable
phrasing from any example title, in positive form. Each line says what to do, grounded in what won
or lost. The distilled lines are **cached per channel** (`guidelines.json` beside
`insights.json`) and keyed to a hash of this call's exact input, so the call runs only when the
evidence actually changed — a cache hit is the overwhelmingly common path.

### `summarization.yml`

The output of this stage becomes the `{subject}` input to every downstream call, so it must
**preserve ammunition** — verbatim quotes, specific claims, names — not smooth it away like a
generic summary would. Folded in unchanged from the old `electron/assets/summarization_prompts.yml`.
The fallback that used to stand behind it is the cautionary tale in Part 1.

`source_context` is appended when the caller knows the source filename, and its leading blank
lines are part of the string because code renders it.

### `system.yml`

These blocks used to be string constants in `system-prompts.ts`. They live here for the reason
everything else does: one directory holds every word this app sends a model. Placeholders use the
`{name}` convention and are filled with **function replacers**, because transcript text routinely
contains `$`-patterns that a plain string replacement would expand and corrupt.

- **`TASK_PLAIN`** is prepended to every plain-text field request (law 12); each field's OUTPUT
  FORMAT block names that call's plain shape.
- **The compilation preamble** is prepended to the one whole-metadata JSON call left in the app —
  a mode the operator selects, and the one answer structured enough to need JSON. Its old second
  line, "Use ASCII characters only", is gone for the reason given under `self-check.yml`.
- **The compilation framing** lost its WRONG/CORRECT example pair (LEDGER #131).
- **`chapter_subjects_context`** is the measured table of contents, prepended to `{subject}`
  whenever the chapter pipeline produced one.
- **`chapter_digest`** is what the content slot carries on an item over the direct-pass ceiling.
  Over that ceiling the pipeline used to run a blind chunk summarizer whose own log line admitted
  the cost (*"verbatim quotes and phrasing do not survive that step"*). The operator's ruling on
  2026-08-23: *"I don't want summaries. We should try to pass the whole thing in. If we're using
  summaries instead then it should be in the form of chapters being passed in."* The chapter list
  is a condensation the pipeline has already paid for and that was written the right way round —
  each chapter's paragraph comes from that chapter's **own** raw transcript, one call per chapter,
  so the specifics in it are the video's words rather than a paraphrase of a paraphrase. It
  **replaces** `chapter_subjects_context` on that path rather than sitting beside it: both render
  the same table of contents, and printing it twice would tell the model the video has twice as
  much in it as it does.
- **`chapter_digest_by_choice`** is the same body under a different first sentence, for a call
  that reads chapters **by choice** rather than because the transcript was too long — "this
  video's transcript is longer than one call can read" would be false there. Titles condition on
  the digest whenever chapters exist: measured 2026-08-24, titles from chapters matched titles
  from the transcript on every hard check and pulled sharper specifics from the details, at a
  third less prompt.
- **`TASK_TITLES_INPUT`** renders the titles this run already wrote as **input data** for a later
  call. One call used to write titles and thumbnail text together, which is what made "the
  thumbnail must not repeat a core word from the top 3 titles" followable. Now every field is its
  own call, titles run first, and their answer is put in front of the thumbnail call. The rule is
  unchanged; what changed is that the model **reads** the titles rather than having happened to
  write them. `TASK_TITLES_INPUT_PENDING` is the "Show prompt" preview form, which says in as many
  words that nothing has run yet — it is never sent.

---

## Part 6 — Historical: the trained adapters (removed 2026-08-25)

`shared/pipeline/adapters.yml` is gone with the adapters themselves (LEDGER #177, superseding
#134). Recorded here because one of its strings is still load-bearing as **register**, and because
the reasoning generalizes.

Those system prompts were **not instructions in the editable sense**. They were half of a
fine-tuned model's input distribution: every example in the training set paired one of those
strings with a user turn in an exact shape, and a LoRA conditioned that tightly degrades on a
reworded system prompt in ways that **do not look like failure** — it keeps answering, just
off-brief. Editing them was a retraining decision, not a prompt-tuning decision. They lived in the
prompt directory anyway, because one home per model-facing string beats the accidental protection
of hiding them in a `.ts` file.

Other contract details, for the record: `wire_task` mapped the ContentStudio field name to the
trained token (`titles` → `title`, because the adapter wrote one title per call) — the field name
and the trained token are not the same string and must not be conflated. The user turn conditioned
on the **short** subject lines only, never the `detail` prose the group calls get, because that is
all the adapters ever saw. `format` was always `normal`: the training data also carried a
livestream format, but ContentStudio has no flag distinguishing the two and guessing would have
been inventing an input. The CTR tier line rode on titles rows only (all 7,497 of them);
description and tags rows had none, so the slot rendered empty there.

**The tags contract survives as the register the current tags prompt targets:**

> You write YouTube tags for independent commentary channels covering religion, politics and the
> far right. Given the list of subjects a video covers, write 5 to 7 comma-separated tags: the
> most specific two-to-four-word phrase for the main subject first, then the named people,
> organizations and events it covers, then the broad category terms it belongs to. Accurate and
> boring beats clever - tags are a labelling job, not a hook. No channel names and no creator
> names - those are appended separately.

Note the last clause, and note that it is now **wrong for the prompted path**: `channel_tags` are
still appended by code, but `brand_terms` are asked for in the prompt on purpose (Part 2).

One piece of adapter-era code was **kept deliberately** on the excision, against the brief's own
suspicion: the tag-budget tail-drop in `appendChannelTags`. Its comment blamed the tags adapter,
but the behaviour is YouTube's 500-character limit on the whole list whoever wrote it, and it runs
on every tags answer, local and cloud alike.

---

## Part 7 — Operational notes for editing these files

- **The app reads an installed copy.** The prompt tree is installed into the userData
  `prompt_sets` directory at startup; a repo edit is invisible to the running app until it
  restarts. The metadata test CLI prints the divergence (LEDGER #92) and takes `--assets`.
- **Changing a bundled file changes its hash**, so the next app start updates the untouched
  userData copy automatically. A file the operator has hand-edited through the Instructions page
  keeps its version and the update is **withheld with a notice** — that is the correct behaviour,
  and it is why an app edit deliberately does not re-stamp provenance (LEDGER #176).
- **Two gates on a save from the Instructions page**: text that does not parse is refused with the
  parser's line and column and nothing is written; text that parses but the loader rejects is
  written, rejected, and **rolled back** to the bytes held in memory.
- **`npm run check:pure` asserts on prompt content.** The tags assertions in particular guard the
  brand terms reaching each channel's assembled section, the comma exemplar being **shown** in
  every variant, and the run-on refusal. Assertions are rewritten to guard a change, never
  weakened around it.
- **`claude -p` is hermetic**: every spawn runs in an empty directory, because it loads project
  memory from its cwd and this repo's memory names the operator throughout — which surfaced as
  invented narrators in 3 of 24 chapter titles (LEDGER #171). The same applies to any ad-hoc arm
  you run by hand: run it from a throwaway empty cwd, never the repo.
