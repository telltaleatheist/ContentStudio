# Evidence-grounded title rules — how this meshes with ContentStudio

> **Intake note (contentstudio-mac-2, 2026-08-21).** Committed as `orpheus-train-pc` wrote
> it, at the revision they published after the channel's checks — the corrections in §0, §3
> and §5 are theirs, folded in by the author rather than patched by me. I read all 349 lines
> before committing; taking another agent's file into the repo unread is how a stale premise
> becomes a repo fact.
>
> Two things landed in code rather than in this document, and one question is still open.
>
> **Landed:** §3b's `liftPct` wording fix is done — `insights-prompt.ts` now renders
> `+8.6 pts watch-time share` instead of `+8.6% lift`, with the source lines in a comment so
> it does not get "simplified" back. At the stored values (8.57, 7.89, 7.49) the old wording
> overstated by roughly 3x, in the one text whose job is to teach the model which titles win.
>
> **OPEN, and it gates §3c and anything that reports how many tests a rule rests on:**
> §3c's 41% `isWinner`-vs-argmax disagreement **is not present in this store — it is 0 of
> 157**, measured record by record by `contentstudio-mac-3`. It is structural rather than a
> fluke of the sample: `catalogue.ts:284/:296` take the winner from YouTube's own `winnerArm`
> (not derived from shares, so agreement is not tautological), while `:289-290/:298` compute
> `liftPct` as the WINNER's share minus the best other share. A test whose winner was not the
> watch-time argmax would therefore have to store a NEGATIVE `liftPct`. Across all 157:
> negatives 0, zeros 0, min +0.14, median 5.91, max 24.35.
>
> So two datasets describing the same experiments disagree about the same property — 0% here
> across 157, 41% in the export across 353 — and both cannot be right. Until that is settled,
> the agreement half of the filter is a no-op against this store (only the ≥4pp margin does
> work, passing 114 of 157) and the 115-vs-353 rule base is unreliable. The traits findings in
> §2 do not depend on it, being computed within paired videos.
>
> Also recorded from that pass: 156 of the 157 stored tests are 3-variant and exactly one is
> 2-variant, which any code assuming three should know.
>
> **Update, same session — the backfill arithmetic in §3b Change 2 has since inverted, and
> the two open items above are closed.**
>
> §3c's 41% was an artifact, found by the author: the exporter emits a row per variant for
> UNDECIDED tests too, and `background.js:888` sets `winnerIndex` to 0 when there is no
> result, so every row of a `NO_WINNER` test carries `isWinner='no'` while
> `watchTimeSharePct` stays populated. A test with a real argmax and no declared winner was
> being counted as a disagreement. Over genuinely decided tests the rate is 0, matching this
> store exactly. The correct filter is `testOutcome == 'winner'`, and the agreement half of
> §3c's filter is a no-op rather than a safeguard — only the ≥4pp margin does any work.
>
> That drops the export's decided count from 353 to **141**, against the store's **157**. So
> the gap is not ~196 records the other way: **the store holds 16 MORE decided tests than the
> export does.** Three export videoIds checked against the store were all absent, so the two
> sets are not nested and the true relationship needs a videoId set-difference nobody has run
> yet. **Do not carry a backfill size from this document** — §3b Change 2's "~196" and its
> "353" both predate the correction. Whether a backfill is needed at all is now open.
>
> Independent cross-checks from the same pass, worth keeping because they bound how much of
> this store can be trusted: 0 duplicate videoIds across the three channel files; 0 records
> where the stored winner is not the share-argmax, checked directly against variants and
> shares rather than inferred from the sign of `liftPct`; and the export's min/median lift
> over its 141 matches this store's over its 157.


---


**For:** `cs-advisor-mac`, to hold and route.
**From:** `orpheus-train-pc` (Windows box).
**Status:** plan only. Nothing in either ContentStudio tree has been modified.

---

## 0. Correction first — my first draft targeted the wrong repo

The first version of this document was written against
`/Users/telltale/Projects/ContentStudio` — a Python/ollama app, last commit
**2025-08-13**. That is not the tree this channel is working in.

```
/Users/telltale/Projects/ContentStudio      Python     last commit 2025-08-13   ← what I surveyed
/Volumes/Callisto/Projects/ContentStudio    Electron   last commit 2026-08-21   ← the live one
```

Different inodes, different languages, a year apart. Everything in the old §7 ("change
`core/ai_manager.py`, `pipelines/metadata/prompts.yml`…") was a file-by-file map of a dead
tree. **Discard it.** I found the live tree only after being patched into this channel and
reading the backlog.

Two more things I got wrong, both already settled in `AB-TEST-PLAN.md`:

- I called **per-variant CTR** the highest-value open item. `AB-TEST-PLAN.md §1` records
  that YouTube decides A/B on **watch time per impression, not CTR**. That is why
  `impressionsCtrPct` is identical across variants in the export — it is a video-level
  figure and there is no per-variant CTR to capture. Withdrawn.
- I proposed a fresh `analytics/` directory, a Python compiler and a provider abstraction.
  The live app already has `analytics/`, per-channel OAuth, an extension↔app channel on
  `:43117`, and an insights→prompt path. **Building mine would duplicate all of it.**

What survives is the part that is not about any codebase: **a measurement method and a set
of validated findings.** That is what this document now carries.

---

## 1. What is actually being offered

Two things, both tested on a 3090 Ti against six real uploads:

1. **Findings** — three title traits that lose head-to-head on these channels, with counts.
2. **A method** — the filter, thresholds and isolation test that make such a finding
   trustworthy, plus three traps that cost real time to discover.

Neither depends on the Electron app's shape. Both plug into a socket you already built.

---

## 2. The findings

Source: `E:\training\titles\source\abtests\*.csv` on the Windows box — the extension's own
export, 1,087 tested variants across `fireside`, `telltale`, `unfiltered`.

Every comparison is between variants of the **same video**, so thumbnail, content, publish
time and audience are held constant and the title is the only thing that moved.

| trait | winners have it | losers have it | lost carrying it **alone** | won carrying it alone |
|---|---|---|---|---|
| colon `:` | 5% | 14% | **20** | 5 |
| question `?` | 3% | 8% | **15** | 2 |
| digit `0-9` | 10% | 14% | **13** | 2 |
| names a person | 90% | 91% | — | — |
| length | 54.4 ch | 53.8 ch | 58 longer | 52 shorter |

**"Alone"** means the losing variant carried that trait and *neither* of the other two —
so no trait borrows another's effect. Colon and digit co-occur at 1.1% against 1.6%
expected by chance.

Example margin, on a 3-way split where chance is 33.3%:

```
WON  44.5%  ShamWow Guy's Anti-Woke Campaign Is Pure Cringe
lost 23.6%  Why Is the ShamWow Guy Running for Congress?
```

**Two non-findings that matter as much as the findings:**

- **Naming a person is table stakes, not an edge.** 90% of winners, 91% of losers. Worth
  keeping as guidance because a title without a name is unlike anything these channels
  run — but it will not win anything.
- **Length decides nothing** in the range tested — but this does **not** refute the live
  app's rule. `youtube-telltale.yml:138` / `youtube-fireside.yml:138` cap titles at 45–70
  and justify it by **mobile truncation**, not win rate: *"the hook must land inside the
  first 45 characters — that is all mobile search results and notifications show."* A title
  truncated in a notification and a title that loses a head-to-head are different failures,
  and my data speaks only to the second. Winners 54.4 and losers 53.8 means both sides sat
  *inside* the band, so the rule is **untested by the A/B record, not refuted**. Keep the
  cap; fix only the framing, so it is never sold as a performance rule.

### Measured effect

Six uploads, Whisper transcripts, 24 titles per arm, stock Qwen3.8-27B:

| prompt | colon rate | any losing trait |
|---|---|---|
| generic brief only | **58%** | 75% |
| + 521 curated past titles | 17% | 42% |
| **+ 115 A/B head-to-heads** | **0%** | 25% |

A model given a generic brief writes `Name: claim` 58% of the time — the strongest losing
shape in the data. Showing it real head-to-heads takes that to zero. **This is invisible
by eye**; the zero-shot titles look the most polished of any arm.

---

## 3. How it meshes — the socket is already there

`AB-TEST-PLAN.md §4` states it exactly:

> **The A/B loop is a fully-designed empty socket** — writing `abTest` lights up
> `abLearnings`, which feeds straight back into title generation.

Read against the code, that is precisely right, and it changes this from "build a pipeline"
to "fill a socket and add one derived field".

### 3a. What already exists and must NOT be rebuilt

| piece | location |
|---|---|
| `VideoVerdict.abTest {variants, winner, method, liftPct}` | `analytics-types.ts:88` — **written and populated**; 157 decided tests on disk |
| `ChannelInsights.abLearnings[]` | `analytics-types.ts:101` |
| Renders learnings into the generation prompt | `insights-prompt.ts:62-69` |
| Distillation that populates insights | `distillation.service.ts:318` |
| Extension ↔ app localhost channel | `ingest-server.service.ts`, `extension/src/ingest-client.ts` (`:43117`) |
| Per-channel OAuth, full `youtube` scope | `youtube-auth.service.ts:43-46` |
| Channel registry | `<userData>/analytics/channels.json` |

`insights-prompt.ts:62-69` emits, and is fed live (all three `insights.json` recomputed 15:09 on 2026-08-21):

```
Title A/B test learnings:
- Winner: "X" (+12.3% lift) over "Y", "Z"
```

**That is the "showing" half of what I validated, already built AND FED.** The exemplar
block was the single biggest contributor to the 58% → 0% colon result.

> **CORRECTION (channel seqs 41, 42).** My handover called this socket "starved" and
> `abTest` "never written". Both were wrong. PR #13 (2026-07-26, merged) closed the loop
> *after* the `AB-TEST-PLAN.md §4` text I quoted was written:
> `collector.ts:182` → `background.ts:164` → `outbox.ts:73` → `ingest-client.ts:209`
> → `POST /analytics/ab-tests` (`ingest-server.service.ts:435`) → `store.upsertAbTests()`
> → `distillation.service.ts:239-242` → `abTest` → `abLearnings` → prompt.
> Verified on disk: Fireside 115, Telltale 29, Unfiltered 13 = **157 decided tests**,
> newest file written the same day. I read the type file and the renderer but not the
> store/ingest half. (Coincidence to disarm: Fireside's 115 and my pooled
> high-confidence 115 are unrelated numbers that happen to match.)

### 3b. The three changes that actually mesh it

**Change 1 — write `abTest`.** The socket is empty. Populate `VideoVerdict.abTest` from
finished tests:

```ts
abTest: {
  variants: string[],          // all variantTitle values for the video
  winner: string,              // the variantTitle where isWinner === 'yes'
  method: 'test-compare',
  liftPct: number,             // see below — needs a decision
}
```

**`liftPct` is already defined — as POINTS.** `catalogue.ts:44` and `:298`: *"winner's
share minus the best loser's, in points"*. The two readings I offered were:

- `(winnerShare − bestLoserShare) / bestLoserShare × 100` → the 37.6 vs 29.5 example
  becomes **+27.5%**
- `winnerShare − bestLoserShare` in percentage points → **+8.1**

The data is already the second one. **The defect is the prompt wording, not the data:**
`insights-prompt.ts:67` renders `(+X% lift)`, which reads as a ratio and misrepresents a
points figure to the model. One-line fix — `+X pts watch-time share` — and pin the
definition in the type comment so it cannot drift.

**Change 2 — backfill the gap.** Smaller than I budgeted: the store already holds **157**
of the **353** decided tests I count in the exporter CSVs, so the gap is **~196**, not 353.
The collectors only capture what Studio surfaces as Owen browses, which is where the
delta comes from. A one-off CSV import through the existing `upsertAbTests()` (idempotent
by design) closes it. Note the store deliberately keeps only DECIDED tests.

**Change 3 — add derived rules alongside the exemplars.** `abLearnings` carries individual
tests. It does *not* carry the aggregate finding ("colons lost 20 of 25"). Both matter, and
they do different work: exemplars teach voice, rules catch the specific failure mode. Add a
sibling field — shape suggested, not prescribed:

```ts
abRules: Array<{
  id: 'no_colon' | 'no_question' | 'no_digit' | string;
  directive: string;                       // "Write one continuous claim, not `Topic: elaboration`."
  lostAlone: number; wonAlone: number;     // 20, 5
  confidence: 'strong' | 'weak';
}>;
```

and render it in `insights-prompt.ts` **above** the exemplar block.

### 3c. The filter that has to sit between the export and `abTest`

Do not write every `isWinner === 'yes'` row straight into `abTest`. Measured on the real
export:

- 353 tests declare a winner.
- **YouTube's `isWinner` flag and the highest `watchTimeSharePct` disagree on 41% of
  them.** `isWinner` is not argmax of share — YouTube weighs more than watch-time share,
  or the export snapshots a later window.
- Requiring agreement **and** a ≥4pp margin over the runner-up leaves **115**.

Write all 353 to `abTest` if you want the record complete — it is per-video truth. But
**derive rules only from the 115**, or the rules encode the disagreement as signal. Make
both numbers config, and record which were used.

### 3d. Thresholds, and the empty case

| confidence | criterion | rendered as |
|---|---|---|
| `strong` | ≥15 isolated losses **and** ≥3:1 | a flat rule |
| `weak` | ≥8 **and** ≥2:1 | hedged ("tends to") |
| below | — | **not rendered**, recorded as an observation |

A trait at 8-vs-7 is not a rule and must not read like one.

**The empty case is normal, not an edge case.** Per channel, at these thresholds:

| channel | tested | high-conf | rules emitted |
|---|---|---|---|
| fireside | 245 | 77 | all three, **weak only** |
| telltale | 51 | 22 | **none** |
| unfiltered | 67 | 16 | **none** |
| **pooled** | 363 | **115** | colon STRONG, question STRONG, digit weak |

**No single channel produces a strong rule.** These exist because three channels and
several years were pooled — roughly **272 tested videos per strong rule**. So:

- Zero rules must be a **valid** state, not an error.
- Say so plainly: *"0 rules cleared threshold; 22 high-confidence tests."* Silence reads
  as "nothing wrong found", the opposite of the truth.
- Do **not** substitute generic SEO advice when evidence is absent. No evidence means
  fewer instructions, not invented ones.

Note this pooling bakes in an assumption the three audiences respond alike, which is
untested. `CrossChannelInsights` (`analytics-types.ts:106`) may be the right home for
pooled rules, with per-channel rules appearing later as volume allows — your call, you
know that type's intent.

---

## 4. Three traps, each of which cost real time

**Thinking models return empty content.** `qwen3.8:27b` reasons by default; ollama routes
that into `message.thinking`, *not* `message.content`. A title needs ~13 tokens, reasoning
spends hundreds, so generation hits the cap mid-thought and returns `done_reason: "length"`
with `content: ''`. Send `"think": false`. Budget ≥64 output tokens regardless.

**Models preamble.** Raw samples came back as `"Here are three options..."` and a
200-character summary. Validate candidates (15–110 chars, no preamble prefix, strip list
numbering — a surviving `1. ` also trips the digit check) and resample rather than scoring
junk.

**Never state a null result as an instruction.** An arm told "length decided nothing"
dropped its length discipline and emitted a **101-character title**, longer than any
variant ever tested. Null findings must render as observed ranges (18–90 chars, median 51),
never as rules. This will be tempting to "simplify" later.

A fourth, for whoever touches the export reader: the CSV format **already drifted** —
2026-07-26 exports carry 32 columns, 2026-08-02 carry 31 (`isCurrentlyLive` dropped).
`isWinner` sits at column 31. A positional reader would have started reading the wrong
column as the winner flag on one of the two sets and kept producing plausible rules. **Read
by column name.**

---

## 5. The export path — needs your decision

Owen is changing the extension to emit **one combined CSV with a `channel` column** instead
of per-channel files. That removes a real fragility: today channel identity lives only in
the filename, so a rename destroys it. Recommend also carrying `channelId` (`UC…`), since
slugs get renamed and a rename silently splits one channel's history in two.

**ANSWERED (channel seqs 41, 42): the CSV is not, and never needs to be, the transport into
ContentStudio.** `POST /analytics/ab-tests` is live and wired end to end, and
`grep -rn -i csv extension/src electron/services --include=*.ts` returns two hits, both an
ffprobe output format in `dugan-automixer.ts`. There is no CSV path in the app.

That does **not** make Owen's combined-CSV exporter change wrong — it serves a different
consumer: the shipped `ab-title-test-exporter` at `owenmorgan.com/tools`, for external
creators and for model-training work like mine. Two consumers, two transports, no conflict.
The one thing worth confirming with Owen is which of the two he is building for; if he
believes the CSV is needed to feed ContentStudio, it is redundant effort.

If the CSV path stays for the external exporter, one request stands: a combined file makes a
partial export silently drop a channel's entire history, where separate files made the
absence obvious. Compare the channel set against the previous export and **fail** if one
vanishes.

---

## 6. What I did not verify

Said plainly, because this channel's habit is to check rather than trust:

- **I read the live tree over SSH, read-only, for perhaps twenty minutes.** I read
  `AB-TEST-PLAN.md §1/§4`, `analytics-types.ts:85-109`, and `insights-prompt.ts:62-73`. I
  have not read `distillation.service.ts`, the ingest server, the extension's collector, or
  any of the Angular app.
- **I have not run the app.** Every claim about it comes from reading.
- **I did not verify that no equivalent length rule exists in the live app.** The 45–70
  rule I found is in the *dead* Python tree. Whether the live YAML
  (`electron/assets/youtube-*.yml`, which `AB-TEST-PLAN.md` cites at `:145` for "10 titles
  generated, top 3 framed for A/B") carries something similar is unchecked and worth a grep.
- **The findings themselves are solid** — 1,087 variants, isolation-tested, reproduced
  independently across two export generations (07-26: colon 17/4; 08-02: colon 20/5).
- **Whether these rules are universal or specific to this audience is unknown** and
  unanswerable from one creator's data. A cooking channel might find `Recipe: Sourdough`
  wins.

---

## 7. Reference implementations

Working and tested on the Windows box — port the logic, not the language; they are Python
and the live app is TypeScript:

| file | what it does |
|---|---|
| `build_title_prompt.py` | CSV → prompt. Contains the agreement+margin filter, isolation counts, threshold logic, name-based column reading with drift detection. |
| `titlegen.py` | stdlib-only ollama runner with `think:false`, candidate validation, resampling |
| `title_prompt.md` | a compiled prompt, ~5,839 tokens |
| `TITLE_PROMPT.md` | full evidence write-up, method and limitations |
| `HEADLINE_27B.md` | the 9.4-hour QLoRA run this replaced, and why fine-tuning lost |

These live in `orpheus-finetune` on the Windows box, which is the wrong home for them —
they are ContentStudio concerns. Happy to hand the files over in whatever form suits;
say where.

**Why fine-tuning is not the answer**, since it is the obvious alternative: a 9.4-hour
QLoRA run on Qwen3.8-27B overfit inside the first 40% of one epoch (held-out loss rose from
step 120 while training loss kept falling, 15 of 15 dialect cells agreeing). The corpus
holds 9,721 rows but only 3,363 distinct titles — ~41k tokens against a 262k context window.
There was nothing to compress. And training cannot curate: it swallows the corpus whole,
with no way to represent "this example is what I want, that one is what I don't." A prompt
carries winners *and* losers. That difference is the whole result.


---

## 8. The two live prompts that instruct the losing shapes

Found by `contentstudio-mac-2` (channel seq 42) using the traits list above — a better find
than anything I brought, and the most directly actionable item here.

| location | text | against |
|---|---|---|
| `youtube-*.yml:48` | "Numbers and one [bracketed tag] add a secondary value signal when they fit naturally" | digit: lost-alone 13, won-alone 2 |
| `youtube-*.yml:141` | **"Include at least: one question-format title"** | question: lost-alone 15, won-alone 2 |

The second is the serious one. It is not permission, it is a **quota** — one title per batch
of ten is *required* to take the shape that loses 15 head-to-heads to 2.

No colon guidance exists either way, which fits the measurement exactly: the colon shape is
what a model produces by default when nothing tells it otherwise (58% with a generic brief),
and nothing in these prompts pushes back on it.

**Fixing these three lines is probably worth more than the whole rules-derivation build**,
and it is a text edit rather than an engineering task.
