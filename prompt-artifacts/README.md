# Before / after: the assembled prompts

These are the ACTUAL BYTES sent to a model, before and after this branch, for one channel
(`youtube-telltale`) against one fixture (`prompt-harness/fixtures/transcript.example.txt` — a
short televangelist clip with a deliberate misattribution trap and a sarcastic line). They are
committed rather than gitignored so the change can be read line by line in the PR.

| file | what it is |
| --- | --- |
| `BEFORE-assembled-prompt.txt` | main's LEGACY whole-metadata prompt: every field in one call, 22,063 chars |
| `AFTER-assembled-prompts.txt` | this branch's THREE unit prompts, banner-labelled, 36,378 chars total |
| `BEFORE-titles.json` | main's legacy call on `qwen3.8:27b`, 3 runs |
| `BEFORE-titles-same-transport.json` | main's prompt through THIS branch's transport, 3 runs (isolates prompt from transport) |
| `AFTER-titles.json` | this branch's packaging call on `qwen3.8:27b`, 3 runs |

Regenerate either side with `prompt-harness/run.js` — see that directory's README.

## What the shape change is

BEFORE: one call, one model, thirteen editorial sections plus **seven** field sections, one
OUTPUT FORMAT naming seven keys, one self-check written for all of them.

AFTER: three calls.

| unit | model | asks for | size |
| --- | --- | --- | --- |
| description hook + body | qwen3.5:9b | 2 schema-constrained calls | 4,986 |
| titles + thumbnail_text + pinned_comment + clip_suggestions | qwen3.8:27b | 4 keys, one JSON object | 19,252 |
| tags | qwen3.5:9b | 1 key | 12,110 |
| hashtags | *(no model)* | derived in code from the entity and key-phrase pools | — |

The packaging call is the one to read. It is 2,811 characters SHORTER than the old
whole-metadata prompt while carrying the same editorial brief, because it no longer carries the
rules for three fields it does not write.

## Section-level diff, packaging call vs. BEFORE

Removed from the editorial half:

- `## EMOTIONAL TRIGGERS THAT WORK` and `## TARGET EMOTIONS BY CONTENT TYPE` — two
  near-duplicate taxonomies of the same five reactions, one as a list and one as a
  content-type mapping. Now **one** block, `## WHAT MAKES SOMEONE CLICK`, where each trigger
  carries the content types it leads on.

Removed from the field half (this call does not write these, so their rules are not sent):

- `## DESCRIPTION` — DescriptionUnit's own two prompts
- `## TAGS` — its own call on this item; assembled in code on a chaptered one
- `## HASHTAGS` — derived in code, no call at all
- `## CHAPTERS` — an instruction telling the model not to write chapters, sent to a call that
  was never going to be asked for them

`## OUTPUT FORMAT` names four keys instead of seven. `## FINAL SELF-CHECK` is assembled from the
four fields this call actually writes.

## Line-level diff, `## TITLES`

| before | after | why |
| --- | --- | --- |
| `Avoid "Name: claim" colon constructions — colon titles lost 25 of 31 isolated A/B head-to-heads.` | `Write the title as one unbroken claim; prefer that to a `Topic: elaboration` construction.` | the count was a frozen snapshot; the runtime CHANNEL PERFORMANCE DATA block derives the same trait from live data, with provenance and a strong/weak band |
| `Include at least: one simple declarative title and one short punchy title (4-6 words). Do not require question-format titles — they lost 14 of 17 isolated A/B head-to-heads.` | `Include at least one simple declarative title and one short punchy title (4-6 words).` | same frozen-count problem, plus "Do not require…" is a note to the prompt's AUTHOR that was shipping to the model |
| `Length: 45-70 characters.` | `Length: 70 characters is the ceiling.` | the 45 floor contradicted the required 4-6 word title in the very next bullet |
| `Generate 10 options that represent genuinely DIFFERENT ANGLES, not rephrasings of one angle` | `Generate 10 options that represent genuinely DIFFERENT ANGLES. Apply the swap test as you go: if two of your titles could be exchanged and nobody would notice, one of them is redundant — replace it with a new angle rather than a new wording.` | the same rule was stated four times across the set; stated once, here, where the titles are asked for |
| `Do NOT default to the subject's own terminology as the primary hook` | `Front-load the subject name OR the plain-language reframe in the first 3-5 words. Where the subject's own terminology belongs in the title at all, it follows the reframe.` | folded into the positive rule beside it |

In `## TITLE PHILOSOPHY`:

| before | after |
| --- | --- |
| `Name names. Always. Their audience becomes your audience…` | `Name the people involved. Their audience becomes your audience… Where the name itself would mean nothing to a stranger, the DEED leads and the name follows.` |
| `One [bracketed tag] can add a secondary value signal when it fits naturally — never force it. Digits in titles have underperformed in our A/B tests; use a number only when it is itself the hook.` | *(removed)* — the bracket suggestion was unevidenced folklore, and the digit trait is derived at runtime |

In `## LEGAL AND POLICY LINES`:

| before | after |
| --- | --- |
| `Frame allegations as attributed claims or questions: "accused of," "Did X really...?"` | `An unproven allegation or an unconfirmed event is written as an ATTRIBUTED CLAIM in every field — "accused of," "faces allegations that," "according to the lawsuit."` |

The question example was telling the model to write the exact form the runtime A/B block tells
it to avoid.

In `## BEFORE YOU WRITE ANYTHING`:

| before | after |
| --- | --- |
| `PRIMARY SEARCH PHRASE: … This phrase drives the description's first sentence and the tags.` | `PRIMARY SEARCH PHRASE: … A title carrying those words is a title search can find.` |

Neither the description nor the tags are written by this call.

In `## FINAL SELF-CHECK`:

| before | after |
| --- | --- |
| `Output is one valid JSON object with exactly the keys specified, ASCII characters only` | `…in plain text: no emoji and no smart quotes or dashes, though accented letters in real names are correct and stay` |

"ASCII characters only" banned "Beyoncé" and "Muñoz" as collateral on a rule aimed at emoji.

The same fix is in the JSON system preamble, which carried its own `Use ASCII characters only.`

## What the runs show

Read `AFTER-titles.json` beside `BEFORE-titles-same-transport.json`. Four things are worth
knowing before you do.

**1. The legacy call cannot finish on the local 27b, as shipped.** `BEFORE-titles.json` is 3/3
timeouts at its own 300-second Ollama ceiling. That is a TRANSPORT result, not a prompt result —
and it is why `BEFORE-titles-same-transport.json` exists: the same bytes, sent through the
routed group's transport (600s, `num_predict` 8192, `ollama-json`'s thinking-field handling),
so the only thing differing from the AFTER run is the wording.

Given that transport, the old prompt does finish, and its titles are decent. The timings:

| | run 1 | run 2 | run 3 |
| --- | --- | --- | --- |
| BEFORE prompt, same transport (7 fields) | 105.3s | 63.5s | 116.0s |
| AFTER packaging call (4 fields) | 76.1s | 83.0s | 76.6s |

Two things the old prompt did that the new one did not, both visible in the JSON:

- run 3's tenth "title" is **`FOURTH JET`** — ten characters, all caps. That is thumbnail-text
  register, produced by a call that was writing the thumbnail options in the same object.
- run 2's tenth is `Marcus Wray's Jet Sermon in Ten Words` (37 chars), which describes the
  video rather than the subject.

Neither shape appears in any AFTER run. That is the argument for the split stated as evidence
rather than as theory: a call asked for seven fields at once writes some of them in another
field's voice.

**2. Four fields in one JSON object is at the edge of this model.** Across six AFTER runs, one
returned three of the four keys it was asked for. The unit REFUSED that answer rather than
publishing a package with no clip suggestions, named the missing key, and said what to do about
it. Splitting the group is a routing change the operator makes in the dialog; nothing in code
decides it quietly.

**3. The grounding check caught a real hallucination and, separately, a real prompt leak.**

- `Marcus Wray Told His Congregation God Wants A Fourteenth Seat`, against a transcript that
  says the jet seats **twelve**. Reported, kept, declared.
- `The Cult That Rebranded Itself As A Church` — which is a title **copied verbatim out of the
  CHANNEL PERFORMANCE DATA block's own exemplar list**. The block says "emulate the framing
  patterns of overperformers"; the model took a whole title instead. Nothing before this branch
  would have noticed.

**4. The check got much quieter, which is what makes it readable.** Same fixture, same model,
before and after the Title-Case fix in `groundViewerTitle`:

| | flags per run |
| --- | --- |
| chapter-title extractor (`groundTitle`) | 5-8 of 10 titles, almost all of them words like "Buy", "Called", "Zero Accountability" |
| viewer-title rule (`groundViewerTitle`) | 1-2 of 10 titles |
