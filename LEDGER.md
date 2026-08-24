# ContentStudio — Ledger

**What this is.** The project's memory, in one place: what we're building, the rules we've
adopted, what we tried, what worked, what failed and *why*. Sessions read this before
touching anything; decisions and reversals get appended here when they happen. The
codebase's long WHY-comments remain the local law at each call site — this file is the map
that tells you those comments exist and what they add up to.

**Maintenance rule.** Append-only per event, dated. An entry is one decision or measurement
with its outcome and where the evidence lives. When a decision here is reversed, the old
entry is not deleted — it gets a "superseded by" pointer. If this file and a code comment
disagree, the newer one wins and the older one gets corrected.

---

## 1. Goals

*(Confirmed and corrected by Owen, 2026-08-23.)*

### The two classes of metadata field

- **Pick-fields** — titles, thumbnail text, pinned comments. Success = enough good
  options to choose from; individual weak candidates are expected and fine. Anything the
  operator would otherwise EDIT should instead become a multi-option field.
- **Ship-fields** — description, chapters, tags, hashtags. Success = publishable exactly
  as generated. An edit to a ship-field is a pipeline defect, not a workflow step.

### G1 — Video in, publishable metadata out. THE core goal.
A finished export (`<date>/complete/<name>.mov`) goes through the pipeline and produces
metadata meeting the per-field bars below. Owen's job is picking among candidates on the
pick-fields and eyeballing the ship-fields — never correcting.
**Definition of done:** consecutive real videos across all three channels where every
ship-field goes out untouched and every pick-field offers enough.
**Not the goal:** blocking output on quality checks (Law 3 — deliver, warn, curate).

#### Per-field success bars (Owen-confirmed 2026-08-23)

**Description — ship-field.** The primary is publishable untouched nearly every run; the
two alternates exist for taste, never repair. One paragraph, 4-6 sentences (chapter list
+ links appended by code below it, never duplicated in prose). Subject-first in every
clause — the subject is a person/claim/event from inside the video; the speaker never;
no first person. Factually exact: names spelled right, claims attributed to who said
them (HOST vs CLIP), nothing invented. No promoted items in any sentence. Sentence 1
stands alone as the search snippet (phrase in first 60 chars, hook inside 157). Voice:
the channel's own — confident, direct, slightly pissed; shipped-exemplar register, not
essay register.

**Titles — pick-field.** Ten candidates, genuinely distinct angles (swap test). The real
bar: Owen can always find his 3 for the A/B test without rewording any; a great run has
5-6 contenders. Every candidate SAFE to ship: facts keep their relationships (no
welding), complete thoughts, sentence case, ≤70 chars with hook in first 45, no promoted
items. A/B evidence governs shape (no colons/questions/digits while those lose); shape
guidance changes only via the A/B record (Law 5). Boring is acceptable; wrong is not —
inclusion bar is truthfulness, not brilliance.

**Chapters — ship-field.** The published list goes out untouched. Boundaries where the
video actually turns; timestamps exact (quote-mapped, never guessed); 0:00 start; ≥3
chapters or the item says why not. Labels in subject-first topic form naming the span's
specific people/claims, names spelled right, no narrator framing. Plug segments detected
and excluded; passing promo mentions never leak into content labels.

**Tags — ship-field** (code-assembled on chaptered items). Owen never looks at them
twice. 8-12, comma-separated, every tag something the video actually says, brand terms
present, plausible subject-name misspellings, no promoted items, no pool junk.

**Hashtags — ship-field** (code-derived). Up to 3, each readable in one glance as a real
topic. Fewer beats invented.

**Thumbnail text — pick-field.** At least one option per run Owen would put on the
thumbnail he makes BY HAND (thumbnails are manual; no thumbnail A/B). Ten options, 2-4
words, diverse angles across the video's strongest facts — coverage over polish.

**Pinned comments — pick-field.** One of three postable as written. First person — the
ONE field in Owen's own voice. References something specific from this video, factually
grounded, ends in something that provokes replies.

### G2 — One-action publish, with the calendar as a first-class deliverable.
A **global calendar** showing (a) everything complete but not yet uploaded and (b)
everything uploaded/filled and scheduled to release. Schedule suggestions come from
what is already booked plus the open/available days (release slots: Telltale Sun/Thu
1PM; Fireside daily 1PM, 2PM Sun/Thu; Unfiltered daily 4PM). Once an item is fully
ready, **one Upload action** moves it to YouTube, fills all metadata, sets the
thumbnail, and schedules it. Channel comes from the prompt set picked at generation;
thumbnail auto-attached from the sibling `thumbnails/` folder (manual override);
monetization always on. API path now (browser-uploaded videos), `videos.insert` when
the audit approves; extension for what the API cannot do.
**Fill-anywhere (Owen, 2026-08-23):** any report he picks must be fillable into
whatever Studio metadata page he is on — match or no match, including a fresh
livestream filled from a text-subject report. The filename match is a default
suggestion, never a gate.
Spreaker is a secondary destination, unproven.

### G3 — The feedback loop: titles only.
Analytics (API + Studio extension) and A/B results flow back into generation as
bounded, provenance-carrying evidence blocks. **A/B is titles only** — Owen runs it
consistently; thumbnails are hand-made and not tested. Title-writing guidance changes
only through A/B results (Law 5).

### G4 — The editor is FROZEN.
"Perfect the way it is. No need to change anything right now." Known open items
(packaging, livestream flag, story-reorder bug, ACS round-trip) stay parked unless one
bites. This project is about getting metadata right.

### The current focus (Owen, 2026-08-23): prompt tuning via the subagent harness.
Send the exact production prompts through Haiku, Sonnet, and Opus subagents (stand-ins
for the billed API), find where the smaller models crack, tune the prompt, re-run.
Haiku is the canary: a prompt that holds on Haiku is robust — and it measures how close
the local-model aspiration is.

### Standing constraints
- **Local models are the destination, cloud is the bridge.** Owen intends a battery of
  local tests to tune prompts until chapters and descriptions can run locally (local
  titles are already close). Until the tests say so: cloud for the writing surfaces,
  local/code for the mechanical ones.
- Cost and latency secondary to correctness ("it can take as long as it needs. i just
  need usable results").
- The operator curates; the system never withholds output.
- Design posture: one operator, one Mac Studio, wide display, keyboard-fluent — density
  and fewer gestures over whitespace and discoverability.
- The calendar's one question: "what is going out, on which channel, when — and what
  have I not scheduled?"

---


## 2. Laws

Standing rules with their origin. These override convenience every time.

| # | Law | Origin |
|---|-----|--------|
| 1 | **No fallbacks.** A fallback is an unexpected code path in production — a deliberately programmed bug. Fail loudly, name what's missing. Deliberate alternates are fine only as *declared, logged modes*. | Owen, 2026-07-26 |
| 2 | **All prompts live in `electron/assets/prompts/`.** Code assembles, never authors. Owen never searches the codebase to change a prompt. Tunable lexicons are data files in the tree. | PR #52; re-affirmed 2026-08-22 |
| 3 | **Deliver output; the operator curates.** No blocking quality gates, and NO RE-ASKS (2026-08-24: "i dont think we should be re-asking. let it fail... the fact that it's re-asking is a programmed in bug" — the u2 audit measured 8 re-asks in one run, every one a wasted duplicate call). Checks WARN on the kept answer, never refuse, never ask twice; an unusable answer fails loudly and the fix goes to the source. | Owen, 2026-08-19; re-asks removed 2026-08-24 |
| 4 | **Positive form only in prompts.** State the wanted form with correct examples; a model shown a wrong form reproduces it. Wrong-register text appears only as the input of a revision call. | prompt tree, 2026-08-22 |
| 5 | **Title-writing guidance changes only via A/B tests.** Analysis-step and mechanics changes are fine; phrasing/selection bullets are not. | Owen, 2026-08-23 |
| 6 | **Chapters: the model never emits a timestamp.** It quotes a verbatim sentence; code maps the quote to a time. The chapter *count* is the model's, from content — never computed in code. | CHAPTERING.md; chapter service |
| 7 | **Never launch local model runs unprompted.** The GPU is often in use for editing. Ask first. | Owen, 2026-08-22 |
| 8 | **Every automatic decision is declared** — logged, counted in run stats, pushed into warnings. Silent recovery is Law 1's violation in disguise. | pipeline-wide |
| 9 | **Before/after with explanations for prompt and config changes.** Owen wants to understand changes to his creative tooling, not just receive them. | Owen, 2026-07-08 |
| 10 | **Cross-layer contracts are types, not prose.** A message-substring contract between two files killed a whole chapter run when one message was reworded (2026-08-23). If two subsystems must agree, encode it (typed errors, shared constants, schemas). | 2026-08-23 |
| 11 | **Prose contracts get read at wiring time.** Every bug on 2026-08-23 happened at a seam where a documented assumption (queue single-slot, grammar-JSON vs free-JSON, sentence-case grounding) wasn't read before connecting new code to it. | 2026-08-23 retrospective |
| 12 | **Plain text unless JSON is absolutely necessary.** Generation calls answer in the shape the answer has — lines, a paragraph, hook/blank/body. JSON string literals were where a whole failure class lived (close-quote runaway, `"..."` bodies, the repair ladder); measured same night: 27B bodies 2/5 usable under JSON, 5/5 plain. JSON survives only for genuinely structured multi-field answers (compilation package, episode splitter), each justified in a code comment. | Owen, 2026-08-24 |

---

## 3. The Ledger

Status marks: ✅ in force · ❌ dead (with cause of death) · ⚠️ open/uncertain.

### Transcription
- ❌ **Whisper `base` for everything** (app default through 2026-08-23). Garbled every
  proper noun ("Kofi Asare"→"Kufi Asari", "Forgiato"→dropped, "Tasia"→"Tasiah"); garbles
  flowed into descriptions, chapters, and the code-assembled tag pools. No downstream model
  can reliably repair them. → superseded by **large-v3-turbo** (catalog entry + allowlist,
  2026-08-23). Evidence: 10-way comparison at
  `/Volumes/Callisto/ContentStudio/f2 - braeden sorbo/model-comparison-2026-08-23.md`.
- ✅ **Saved-transcript reuse** (PR #66): sidecar under `.contentstudio/transcripts/`
  records the model that ran; reuse is by source identity. *Gotcha:* a sidecar transcribed
  by `base` keeps poisoning runs after the default improves — delete the sidecar to force
  re-transcription.
- ✅ **Chapters, not summaries, over the ceiling** (2026-08-23, operator-directed). The
  per-item path no longer summarizes: an over-ceiling transcript's field calls read the
  chapter digest (list + per-chapter detail), declared in the run's warnings; an
  over-ceiling item with no chapters FAILS naming both facts. Summarization survives in
  compilation mode only. See Part II-A #149-154.
- ✅ **Speaker voice tagging** HOST/CLIP/UNSURE (PR #64/#65): ECAPA/TitaNet verification
  against Owen's enrolled voiceprint; 100% agreement on 253 unambiguous captions; TitaNet
  was the *only* model of four candidates with a usable threshold gap (HOST≥0.65,
  CLIP≤0.45). Fixed the measured attribution failure ("Fox News frames…" when it was the
  HOST talking). ❌ WhisperX rejected (blind clustering, replaces whisper.cpp). Whisper
  itself cannot diarize — verification-against-enrollment is the approach.

### Chapters (five architectures; four dead)
- ❌ **Sealed 5-stage 14B pipeline** — ~390 one-question calls a video. Too slow,
  stall-prone.
- ❌ **27B single call with code-computed count** — the cadence table handed the model a
  target count, which turned rhetorical pauses into boundaries. Also PR #32's experimental
  single-call variant: 2/2 smoke rejections on gap variance.
- ❌ **Whole-transcript JSON call (fourth architecture)** — one call, (label, first_sentence)
  pairs as JSON, quote→timestamp mapping, per-chapter JSON detail calls, THE TITLE RULE
  arbitrating two title sources. The mapping and cadence design were RIGHT and survive; what
  killed it was the container (close-quote runaways, `"..."` details, schema/repair machinery)
  and the two-source title fight (the 0:00 quote-title bug, 2026-08-24). Superseded same day
  by the plain-text architecture below.
- ✅ **Plain-text rolling-window architecture (fifth, 2026-08-24, merge 9dcbf93)** — stage 1:
  verbatim opening sentences one per line over a ROLLING WINDOW (window = what fits on cue
  boundaries; next window starts at the last mapped boundary so no seam cuts a subject;
  degenerate no-progress case advances to window end with a loud warning; one window ≡ the old
  single call). Stage 2 names EVERY chapter (title line + detail lines) including 0:00 — THE
  TITLE RULE is retired. Quote mapping, cadence bands, promo partition, judges, deliver-and-
  curate all unchanged. Description became one call per candidate (hook / blank line / body).
- ❌ **Embedding pipeline** (nomic-embed-text cosine valleys, 2026-08-22, deleted same
  week) — 43% boundary recall at 32% precision; best full-sweep config 61%. Cause of
  death: the premise — a reaction video playing four clips about one topic has one
  vocabulary and four chapters; there is no valley. Boundary-finding is reading
  comprehension.
- ✅ **Whole-transcript call + quote mapping + per-chapter detail** (current): one call
  reads everything and names boundaries by quoting each chapter's first sentence verbatim;
  code maps quotes to seconds (86% recall @60s, 79% precision; every clear-split boundary
  within 30s); one small detail call per chapter. Unmappable quote = chapter dropped and
  named, never interpolated. Title rule: stage-1's label wins; the detail call titles only
  the 0:00 chapter.
- ✅ **Promo chapters**: found and labeled as plugs by the model, excluded from the
  published list by code (`promo-chapters.ts`). The `promoted_items` channel list
  (2026-08-23) names the plugs to every prompt; passing mentions stay out of content labels.
- ⚠️ **Graduated cadence band** is authored, not measured (the v2 eval run was killed at
  7/8 videos). If short videos get 1–2 chapters, the band language in `chapters.yml` is the
  first suspect. Eval kit: `/tmp/contentstudio-chapter-eval` (one-line import fix needed).
- ⚠️ **Named prompt examples leak**: on a long transcript the 27B returned two example
  titles verbatim as chapters of an unrelated video (caught by quote-mapping, but the run
  failed on the 3-chapter floor). Stage-1 examples now carry no person names — keep it
  that way.

### Description
- ❌ **Withholding the channel rules from the hook/body calls** ("over-specifies a small
  model") — the one production run under that arrangement wrote a 324-word narrator
  synopsis with no CTA. Rules restored (PR #59): a call given no brief writes to no brief.
- ❌ **First-person register** ("I debunk", "We examine") — operator-rejected twice.
  ✅ Subject-first topic form: the subject of every clause is a person, claim or event from
  inside the video; the speaker is never the subject. First person lives in pinned comments
  only. Canonical examples in `fields/description.yml` (incl. Owen's own: "Islam has become
  the new target of the far right").
- ❌ **headline-14b description adapter** — form good, attribution blind (conditioned on
  subject lines only), base model generations behind. Scrapped.
- ✅ **Gold exemplar + 3-candidate options** (PR #65): operator's own 12.25%-CTR
  description as form-only exemplar; primary greedy + two sampled candidates (hook 0.7,
  body 0.2 — 0.7 bodies gave 2/6 usable).
- ✅ **Register judge is clause-level with a targeted revision call** — a blind re-ask of a
  failed body failed twice in a row (same prompt, same dice); handing the model its own
  draft plus the flagged clauses converts a re-roll into an edit.

### Titles
- ✅ **Failure taxonomy** (Owen's review of the Katie Souza run, 27B): fact-welding (true
  facts welded to wrong nouns — "Sells $2M Alien Grift"), fragment-stacking, clipped
  thoughts/noun-piles. Countered with one-connected-thought / facts-keep-relationships /
  complete-the-thought / read-aloud bullets (PR #58).
- ✅ **Sentence case is stated law** (2026-08-23): no case rule existed; the 27B inferred
  sentence case from examples, Sonnet defaulted to Title Case — which turned the grounding
  checker's capitalized-bigram heuristic into a false-positive machine ("Doesn't Exist"
  flagged as an invented name) and triggered quality-destroying blind re-asks.
- ✅ **Grounding check** (`groundViewerTitle`): flags adjacent capitalized words absent
  from the inputs; one re-ask then a declared warning. Never blocks (Law 3).
- ✅ **Unfiltered pipe tail is deterministic** — the AI writes the hook only; subject and
  part number come from the filename. ⚠️ Code-side tail appending still not built.
- ⚠️ **Titles-quality changes are A/B-gated** (Law 5) — the taxonomy bullets above predate
  the rule; future phrasing changes need the loop (G3).

### Tags & hashtags
- ✅ **Code-assembled from entity/key-phrase pools on chaptered items** — no model writes
  them (a model invents plausible tags the video never says = YouTube spam signal;
  `occursIn` is the test). Model-written only on chapterless items.
- ❌ Genericized "channel brand terms" line — model invented "O. Morgan". ✅ `brand_terms`
  as channel data filled into the instruction.
- ⚠️ Pool quality is transcript quality: whisper-base fed junk ("Thou", "Neither") into
  live tags. Better transcription fixes tags for free; a promoted-items pool filter is a
  possible hardening (not built).

### Models & routing
- ✅ **Per-field routing (2026-08-24, merge 9ab608f)** — the PR #55 writing-model slot is
  dissolved: titles, description, chapters, thumbnail text, pinned comment and clip
  suggestions each carry their own model choice in the modal ("small models are default...
  but the big models that determine things like titles — i should be able to set those to
  whatever"). Haiku 4.5 joined the cloud options. Chapters offers capable rungs only (no
  9B — half the measured 2026-08-23 failure stack). The summarizer follows the chapters
  field. The store was never slot-shaped, so migration is one write-down: an agreeing
  ex-slot projection becomes a stored `chapters` entry. Tags/hashtags/speaker/key-phrase
  assignments untouched.
- ✅ **One call per field** (PR #55): the grouped JSON call dropped a key 1/6 runs and bled
  voice across fields. Titles run first; thumbnail call sees the ten titles.
- ✅ **One "writing model" choice** (2026-08-22 modal; description joined the slot
  2026-08-23): description + titles + thumbnail + pinned + clips move together; chapters
  follow the slot (`resolveChapterModelOption`). Tags stay code/small-local.
- ❌ **qwen3.5:9b for descriptions** (registry default until 2026-08-23) — invented claims
  ("serial rapist"), broke register, leaked prompt text. ❌ **qwen 27B/35B/72B for
  descriptions/chapters** — all failed the 10-way comparison on proper nouns and
  attribution (27B reproduced the shipped garbles verbatim; 35B inverted claims in the
  hook; 72B called the one undisputed fact false). ✅ **Sonnet 5 publishable, Opus 5
  publishable even from a garbled transcript** (recovered "Forgiato Blow"/"Kofi Asare"
  from world knowledge). The lesson: local ≤72B cannot hold proper nouns through a
  paraphrase or keep two speakers' claims apart; no prompt fixes that.
- ❌ **headline 14B adapters** (titles/desc/tags LoRAs) — removed from routing (PR #49),
  generations behind. 32B titles shim remains store-edit-only. ⚠️ 27B titles adapter
  (r16, DeltaNet layers) trained but never integrated.
- ✅ **Cloud JSON via structured outputs** (2026-08-23): free-form cloud answers arrived
  with raw newlines, trailing commas, unterminated strings — three repair rounds until
  `output_config.format` eliminated the class. Local stays schema-less by measurement
  (grammar-constraining the decode destroys chapter judgment; cloud thinks *before* the
  constrained answer, so the schema is safe there).
- ✅ **Cloud calls must not hold the single AI-queue slot** (it's Ollama OOM protection;
  `makeRequest` takes the slot itself — nesting deadlocks; measured on the first cloud
  chapter run).
- ✅ **Per-item prompt trace** (`_prompt_trace`, 2026-08-23): every cloud prompt stored on
  the item, viewable in the report — "what did the model actually read" is answerable
  after the fact.

### Publish & analytics (condensed; full history in PUBLISH-PIPELINE-PLAN.md and memory)
- ✅ Analytics hybrid: API (retention) + Studio extension (impressions/CTR — not in the
  public API); cross-source merge; insights block injected into generation for mapped
  channels. Verified live on all three channels.
- ✅ A/B constraints (researched, expensive to re-derive): native Test & Compare supports
  3 title variants, no API exists for it, Studio automation is ToS-barred, private videos
  ineligible, `videos.update` replaces the whole part. Safety gate: private + `publishAt`
  = scheduled finished work, never overwrite.
- ✅ Item identity (PRs #33/#34): `item_id` minted at write; the shared-txt-folder
  `rm -rf` data-loss bug fixed.
- ✅ Two-source generation split (PR #40): content fields from the ad-free editor
  transcript; chapters/clips from the final export's own transcript (final .mov drifts up
  to ~57s / −23% from editor timelines — trimming-dominated, Q1 still open with Owen).
- ⚠️ YouTube API audit submitted 2026-08-21; `videos.insert` gated until approval. Hybrid
  (browser upload + API metadata) works now.
- ⚠️ In flight 2026-08-23: publish auto-config (channel from prompt set, monetization
  always on, thumbnail auto-discovery from `complete/`↔`thumbnails/` + manual override,
  thumbnail applied on both push paths) — Opus agent, worktree.

### Process (what the 2026-08-23 retrospective established)
- The project's failures cluster at **seams between subsystems built on different days**,
  not in any one subsystem. The morning's investigation mode (fixed corpus, ground truth
  web-verified, model × transcript grid) found three stacked root causes in an hour; the
  afternoon's patch mode shipped four self-inflicted bugs. Prefer investigation mode.
- **The operator is currently the regression suite.** Every change ships to Owen's next
  real 20-minute run. The agreed fix: a regression harness — the real pipeline
  (`scripts/generate-metadata-cli.js`) against 4–5 fixed transcripts with verified ground
  truth (Kofi Asare, Tasia Fortune, Forgiato Blow…), hard assertions (names, attribution,
  register, case, no promos), diffed against approved outputs before anything ships.
  ⚠️ Not yet built — next infrastructure priority after this ledger.
- **One working tree per session.** Two sessions shared this checkout on 2026-08-23 and
  collided twice (commits landing on the wrong branch). Worktree isolation is the rule.

---

## 4. Stale docs & the cleanup worklist

The deprecated-cleanup pass (approved in principle 2026-08-23) starts here. Found by the
2026-08-23 harvest:

| Target | Problem | Action |
|---|---|---|
| `PROJECT_OVERVIEW.md`, `README.md`, `QUICKSTART.md`, `SETUP_STATUS.md` | Unmodified since 2025-10-30; describe a pre-Angular app called "LaunchPad" ("NO frameworks like React/Angular/Vue" against a live Angular 20 app). Already declared non-authoritative in PUBLISH-PIPELINE-PLAN.md. | Rewrite PROJECT_OVERVIEW (was Phase 0b task 7, never done); delete or gut the other three. |
| `BUNDLING.md`, `ASAR-LAYOUT.md`, `SCRIPTS-SUMMARY.md`, `scripts/README.md` | Describe a Python-venv bundling world; reference five scripts that no longer exist; ASAR-LAYOUT claims "status: CORRECT". Stale and, unlike the group above, not flagged anywhere. | Rewrite or delete. |
| `extension/README.md` | Says the collector is an unbuilt scaffold and documents a Bearer token; the collector shipped 2026-07-22 and there is no auth by design. | Rewrite. |
| `AB-TEST-PLAN.md` §4/§8 | Calls the A/B loop "a fully-designed empty socket / never written"; PR #13 closed the loop (157 decided tests on disk). The correction lives only in TITLE-EVIDENCE-PLAN.md. | Add the correction in place. |
| `ingest-server` token | Generated and displayed but no endpoint enforces it — vestigial by its own comment. | Remove token + cosmetic display. |
| `episode-splitter.service.ts` | `detectEpisodeBoundaries`/`balanceEpisodeDurations` carry unused optional-bounds params from a dead iteration. | Strip. |
| Historical comments in code | The WHY-comments are the source this ledger was harvested from. Once an entry lives here, the in-code narration of *dead* history (deleted architectures, superseded defaults) can be trimmed to a one-line pointer at this file — the laws and live contracts stay in place. | Per-file pass, after Owen approves scope. |

## 5. Open questions awaiting Owen
- Goals section above: correct and rank it.
- Q1 (drift): in the −21%/−23% trimmed stories, was the cut material off-topic? (Decides
  whether content-field generation from editor transcripts is safe at that drift.)
- Story-reorder `sequence` dropped end-to-end (editor export) — fix changes output, needs
  its own pass.
- Chapter cadence band: measure it (the eval kit exists) or keep authoring by feel?
- 9B quirks left by design: 27-word body (warned), space-joined chapterless tags —
  prompt-vs-parser decision pending. (May be moot now that descriptions are cloud-routed.)
- Possessive-narrator phrasing ("The host's own family…") passes the register judge —
  should it be caught?
- Deprecated-code sweep (the cleanup this ledger precedes): approve scope.

---

# Part II — The full harvested record (2026-08-23)

Everything below was harvested from the codebase's own decision comments, the plan docs,
and CHAPTERING.md on 2026-08-23. It is the raw material Part I distills. Source pointers
are file:line as of main @ cb58fee. When code moves, the pointer rots but the entry
stands; correct pointers opportunistically.

## II-A. Metadata pipeline (chapters, transcription, speaker tagging, description, titles, tags, routing, prompts, identity)

### Chapters

**1. The sealed 5-stage 14B pipeline (label → rate → select → place → summarize → consolidate)** — ~390 one-question model calls per video; no call ever sees a list, a count, or the whole video. Sealed 2026-08-02 after a 2:10:46 livestream graded against the creator's own 7-story list — all 7 stories found in order; 13 chapters vs ideal ~11. Cost: 12 min ≈ 40 calls/~2 min; 2h10 ≈ 390 calls/~25 min. **Deleted 2026-08-22**; its pure machinery survives as `chapter-transcript.ts`. [CHAPTERING.md:1-9, :76-80, :330-350]

**2. "A 14B cannot select K items from a list of N."** Whole-transcript chaptering, windowed lists, merge lists, delete-the-dividers, pick-the-headings — all five sank on the same failure: the model returns a prefix and stops. Superseded for chapters (a 14B result that did not reproduce at 27B), but its corollary survives. [CHAPTERING.md:27-44]

**3. The surviving corollary: the model NEVER emits a timestamp.** It quotes a verbatim sentence; code maps the quote to a second. "An invented timestamp is a guess. A mapped quote is a measurement." In force across every architecture. [CHAPTERING.md:44-50; chapter-transcript.ts:18-21; chapters.yml:5-7]

**4. Temperature 0 / `format: json` always.** The same config scored 0.50 then 0.00 on consecutive runs at temp > 0 — single-video results above temp 0 are not measurements. [CHAPTERING.md:51-52]

**5. Worked examples leak.** A prompt example naming a real person surfaced in outputs about a different unnamed person of the same archetype — "Kenneth Copeland" appeared in 3 of 2,828 outputs, deterministically, at temp 0. Shipped prompts de-leaked 2026-08-16. [CHAPTERING.md:53-56, :88-91]

**6. Prompts that demand what the input lacks get fabrications.** "Alex Jones" appeared in four labels of a stream that never mentions him (unnamed screaming right-wing voice). Every naming prompt needs an explicit no-name branch; outputs proper-noun-checked against their span. [CHAPTERING.md:57-62]

**7. 14B was the model floor.** A full run on qwen2.5:3b produced mega-chapters (one 32-minute chapter swallowing three stories). Small models fail toward *missed boundaries*, which the user cannot fix by joining. Historical. [CHAPTERING.md:66-72]

**8. RANK the junction rating, never threshold it.** Individual ratings are weak (AUC ~0.55) but ranking doubles end-to-end F1. Law: judge any selector end-to-end. Historical. [CHAPTERING.md:164-167]

**9. "The turn, not the arrival."** A prompt that rejected "the sentence that merely hints at what is coming" placed boundaries 11.8s late on average — the hint IS where a human puts the mark. Validated placement: 64% within 5s, 77% within 10s, mean bias +0.8s. [CHAPTERING.md:179-184, :224-226, :347]

**10. Consolidation asks about EVERY adjacent pair.** A gated version merged 1 pair of the 8 needed; wide eligibility took 21 chapters → 13. Law: over-splits are user-fixable in one click; under-splits are not — fear those. Historical. [CHAPTERING.md:320-328]

**11. Summary-of-summaries is dead.** Summarizing the 3-6 word stretch LABELS produced "man yells about conspiracies" mush. Replaced by the standing law: summaries are written from the RAW transcript. [CHAPTERING.md:84-86, :523-529; chapters.yml:17-18]

**12. Always report the no-model baseline.** Uniform spacing alone scores F1 0.141 @15s; a change that cannot beat the dumb baseline by a wide margin is noise. [CHAPTERING.md:348-350]

**13. The 27B single-call measurement (2026-08-21).** qwen3.8:27b Q4_K_M over four videos 8.8min–2h08: no prefix behaviour at any length up to 24,831 prompt tokens; final-chapter coverage 89/97/99/100%; on the 2h08 master 5/5 stories in order, worst offset +54s, one call at 174 seconds vs ~390 calls/~25 min; zero fabricated names; whole-video context even REPAIRED whisper garble (`Occupy to early 1913 KJV` → Luke 19:13). This is the measurement the 2026-08-22 reversal restored. [CHAPTERING.md:371-395]

**14. What did NOT survive: unconstrained cadence.** Same model, temp 0: 1.1 min/chapter at 8.8 min, 0.36 at 32 min (88 "chapters", median gap 18s), 16.0 at 2h08 — a 44× spread with no relation to content. Four tokens of cosmetic punctuation moved a count from 8 to 13. Later fixed by stating cadence as a *rate* in the prompt body. [CHAPTERING.md:397-405]

**15. A count budget derived any other way is obeyed literally into the wrong answer.** Given `ceil(M/15)..ceil(M/5)`, the model returned exactly 2 chapters for an 8.8-minute video and collapsed five separately-clipped people into one. Now superseded entirely by "the count is the model's." [CHAPTERING.md:416-420]

**16. The opt-in 27B single call rejected on good-looking output.** Both re-run story regions resolved every quote and landed inside budget, and both were still REJECTED, each on one chapter shorter than the enforced minimum. "With spacing enforced rather than requested, this path fails on good-looking output about as often as it succeeds." Deleted 2026-08-22. [CHAPTERING.md:458-467]

**17. Render one line per SPEAKER RUN, not per caption cue.** Cue-per-line produced 2 unresolvable quotes of 12 on a 43-minute transcript; speaker-run blocks dropped that to 0. [CHAPTERING.md:441-447]

**18. A dual-track transcript has more than one faithful reading.** A faithfully-copied quote is not contiguous in the flattened stream when the host talks over a clip; resolution searches the flattened stream AND each speaker's own stream. [CHAPTERING.md:448-456]

**19. The embedding pipeline (Briefcase method), adopted 2026-08-22 morning.** One batched `/api/embed` call (nomic-embed-text): 91 stretches of a 67-min podcast embedded in 1.5s; whole run 3m14s in 16 calls vs ~390; two of three known handoffs hit exactly. **Deleted the same day** — see 21. [CHAPTERING.md:471-609]

**20. Why the chapter PICKER went.** Three architectures behind a dropdown wasn't caution: the default among the six options shipped as `cogito-14b`, a model not installed on this machine — which is how chaptering silently produced nothing for a period. "A picker whose wrong answers cost an hour of a run is a trap." Chapters are not a routed task. [CHAPTERING.md:640-650; metadata-routing.ts:96-114]

**21. ⭐ THE REVERSAL (2026-08-22): embedding out, whole-transcript restored.** Eight videos, 28 hand-labelled boundaries, kit at /tmp/contentstudio-chapter-eval:

| architecture | recall@30s | recall@60s | precision |
|---|---|---|---|
| embedding, as shipped | 9/28 (32%) | 12/28 (43%) | 10/30 (33%) |
| embedding, best of full sweep | 12/28 (43%) | 17/28 (61%) | 13/36 (36%) |
| 27B whole transcript, "every beat" | 22/28 (79%) | 24/28 (86%) | 49/107 (46%) |
| 27B whole transcript + cadence band | 20/28 (71%) | **24/28 (86%)** | **23/29 (79%)** |

Diagnosis: the failure is the premise, not the tuning — a cosine valley measures VOCABULARY change; four clips of four people saying the same thing about Islam is one vocabulary and four chapters. Nine of the eleven boundaries the best sweep missed had no valley at the labelled second at all. In force; embedding pipeline deleted in full. [CHAPTERING.md:685-722; chapter-whole-transcript.service.ts:4-21]

**22. Retrieval: the full first sentence, six words or longer.** The deleted single call was thrown out for its RETRIEVAL (3-8 word phrase against a SAMPLED excerpt landed on the wrong minute), not its cadence. 137 of 138 quotes mapped, none out of order. [CHAPTERING.md:729-733; chapter-transcript.ts:344-350]

**23. The graduated cadence band.** The flat "3 to 4 minutes minimum" bought precision 46%→79% at no recall cost — but the four boundaries it lost were all on short videos whose real chapters sit 30s–2.5min apart. Floor follows the runtime; content decides the count inside the rung. Caveat: the band has not itself been re-measured. [CHAPTERING.md:737-743, :778-785; chapters.yml:51-55]

**24. `num_predict` 4096 → 8192.** A 72-minute podcast hit the 4096 ceiling on first ask AND re-ask and produced NOTHING — thinking and the answer share one budget. [CHAPTERING.md:744-746]

**25. The code-side cadence table (`targetSecondsFor`) is gone.** THE COUNT IS THE MODEL'S. "Every deleted architecture computed a target count in code and handed it over, and that is what put a boundary in the middle of a subject." Only the rung *name* is computed, for reporting. [chapters.yml:8-13; chapter-transcript.ts:23-26]

**26. NO SECOND PATH.** The lexical TF-IDF fallback scorer is deleted, not flagged: "Two chapter architectures in one tree means one of them runs when something goes wrong." [chapter-whole-transcript.service.ts:43-46]

**27. An unmappable quote is DROPPED and named, never approximated.** There is no weaker second measurement; "an interpolated time would be a confident wrong answer wearing a measurement's clothes." Reverses the 2026-08-16 `startApprox` soft-failure. [chapter-whole-transcript.service.ts:56-63]

**28. THE TITLE RULE.** Each chapter's title has exactly ONE source — stage 1's label, or the detail call's title only for a chapter stage 1 did not label (normally the 0:00 opening). The detail call's title is otherwise DISCARDED. [chapter-whole-transcript.service.ts:78-93; chapters.yml:113-119]

**29. ~~A re-ask is a different SAMPLE~~ OVERTURNED 2026-08-24: there are no re-asks.** All re-ask machinery (stage-1 second ask, detail title re-ask, description second attempt / body revision / option redraw) was removed as programmed-in fallbacks the operator never chose. Judge faults warn on the kept answer; unusable answers throw. The half that survives: a revision-style prompt must never quote the rejected answer back — moot while nothing is asked twice, binding if anything ever is again.

**30. No JSON schema on local chapter calls; schema on the cloud transport.** Grammar-constraining the decode measurably destroys the local chapter judgment (reasoning shares the constrained token stream); cloud models think BEFORE the constrained answer. Added after the 2026-08-23 runs. [chapter-whole-transcript.service.ts:130-138]

**31. Unusable-answer vs transport told apart by TYPE, never message text.** A substring match misread one truncated answer as transport (2026-08-23) and failed the whole chapter run. `CloudAnswerUnusableError` is the contract. [ai-manager.service.ts:198-208]

**32. Quote matcher strategy 4 — the one deviation from the reference.** The reference's `includes` with no length floor let "The submarine fleet departed Reykjavik before dawn" score 4 of 5 against "we have a lot to get through today" on the word "a" alone. Containment now needs a substantive word on both sides. [chapter-transcript.ts:422-432]

**33. Stage-1 examples lost their names (2026-08-23).** On a 20k-token transcript (KV spilled), the 27b returned two operator-supplied example titles VERBATIM as chapters of an unrelated video; quote-mapping dropped them but the run failed the 3-chapter floor. Examples replaced with nameless ones — the file's law: replace examples, never add a ban list. [chapters.yml:69-76]

**34. Stage-3 keeps real names in examples WITH the risk stated** — operator-directed verbatim; the grounding check is what makes a leak detected rather than shipped. [chapters.yml:23-30]

**35. Entity scaffold: 8 proper nouns, per-chapter, never whole-video** — longer lists become checklists; whole-video invites chapter 2's name into chapter 5's title. [chapter-whole-transcript.service.ts:197-202]

**162. The channel is answered at generation (operator, 2026-08-24: "we pick the channel from the very beginning when i pick the prompt... that should be green").** The list index resolves every row's prompt set through the channel registry (memoized per set; an ambiguous registry lands in `problems` naming the set instead of failing the index) and carries `promptSetChannelId/Name` at the ENTRY level — the rows that need it most have no record yet. The channel dot, the channel filter and the filter chips all read stored-channel-first-then-prompt-set, so they can never disagree; the open item's meter shows a suggestion as SET ("routed from the prompt set picked at generation; recorded with the first save") instead of amber "suggested only". Nothing is auto-persisted by rendering: the record still gets its channelId from the existing auto-route on the first save, and a stored channel always wins. [publish-ipc.ts; metadata-reports.ts]

**163. Unlinked video is hollow, not amber.** "No YouTube video linked" on a fresh item is a fact about where the browser-side upload stands, not a fault the reports page can act on — every item starts there. List dot and meter tick are now `unset`; the meter's disagreement check still ambers LINK the moment it is the one thing refusing the dispatch button, so READY never lies. [metadata-reports.ts]

**164. The 1200x675 thumbnails are the FILES, measured twice.** Operator believes the template exports 1920x1080 "without exception"; every thumbnail on Callisto measured 1200x675 on 2026-08-21 (28 files) and again 2026-08-24 (including the newest, `2026-08-23/thumbnails/1 - duffy.png`). 1200/1920 = 62.5% — the signature of an export-preset resize. The validator reads PNG headers and never re-encodes (its own law); the warning is correct and stays. The fix is in the export template, not the app. Recorded so the warning is not re-diagnosed as an app bug. [thumbnail-validate.ts:34-50]

**36. Promo chapters: classified in CODE (regex over name+detail), excluded not discarded, timestamps never rebased.** "A classifier that lives in a prompt cannot be read, tested or corrected without retraining the thing it lives in." A cold-open plug means the list genuinely doesn't start at 0:00 — warned, never moved. [promo-chapters.ts:1-36, :133-135]

**37. Chapter model = a projection of the writing-model slot (2026-08-23)** — chapter labels are the description's inputs; the model trusted with one is trusted with the other. Falls back to the declared constant when the slot disagrees. [metadata-routing.ts:406-419]

**38. The cloud chapter path must NOT hold the AI queue slot** — nesting `queueAITask` around `makeRequest` deadlocks the 1-slot pool; measured on the first cloud chapter run. [metadata-generator.service.ts:1313-1318]

**155. The closing stretch gets a positive-form rule of its own (2026-08-24).** u2's outro came back "The closing prayer and the creator's final reaction" — a reaction segment named by its speaker. Both stage-3 bodies now state that the closing stretch is a chapter of content like the rest, titled by the thing it closes on and the verdict passed on it, with two worked examples in the Gene Bailey register. Measured on Sonnet arms against u2's outro slice (exact rendered production prompt): v1 of the rule left the narrator noun in 2 of 3 titles; the verdict-form restatement got 3 of 3 titles free of narrator nouns (one still warned, correctly, for sentence form). Old prompt: 0 of 2 clean. [shared/pipeline/chapters.yml]

**161. The sliver-chapter defect and its two-sided fix (2026-08-24, measured on "3 - islam").** The first real run after the restart produced an 11-second chapter — "EW Jackson and questions about his standing amid problems" — an introduction a mid-video Patreon plug cut off from the clip it introduced, and the vague label was stage 3 faithfully describing nothing. Reproduced 3/3 on Sonnet arms of the exact stage-1 prompt. Prompt fix (v4 after a measured regression): a floor ("a chapter is a stretch, never a sliver: half a minute at the fastest cadence"), connective tissue belongs to a neighbouring chapter, and the promotion paragraph now asks for BOTH sides — the plug's first sentence and the first sentence of the content that resumes, "whether it takes up a new subject or picks the interrupted one back up" (the operator plugs mid-chapter too). Measured: sliver 0/3 baseline clean → 3/4 v4; promo bounded both sides 2/3 → 4/4; f3's legitimate 26-second promo chapter survives. THE v3 LESSON, worth the entry on its own: a "this is Dave is NOT a reported sentence" example — negative form, against the file's own law — collapsed output quality in one step (meta-commentary, 0:00 entries, MORE intro sentences reported). The residual 1-in-4 sliver is warned in CODE (promo-chapters.ts, after the promo match so short plugs are exempt), kept as written, never merged. [shared/pipeline/chapters.yml; promo-chapters.ts]

### Chapter-title quality (measure + warn, never a filter — re-asks removed 2026-08-24)

**39. POSITIVE FORM ONLY (operator's ruling, 2026-08-22).** Prompts state the wanted style with correct examples; the register vocabulary lists exist so CODE can recognise failure afterwards — none of that vocabulary may appear in a prompt. Tree-wide. [chapter-title-quality.ts:23-27 et al.]

**40. Two independent title checks** — the run that motivated the register check was entity-rich and still narrated ("The speaker debunks Gene Bailey's misreading…"), so the check cannot be a search for "the speaker". [chapter-title-quality.ts:1-33]

**41. Possessives in BOTH apostrophe characters** — the ASCII-only check turned "The panel's debate" (curly apostrophe) into "panels" and flagged the target register as the failure. [chapter-title-quality.ts:111-117]

**42. The preposition exemption** ("debate over", "report on") — without it the detector flagged the operator's own worked example of the CORRECT register. [chapter-title-quality.ts:120-126]

**43. The invented-narrator premise is now conditional — and nothing was changed.** The first tagged run got attribution right ("the host traces the 13th Amendment's prisoner exception") and the judge flagged that exact clause as an invented narrator. Deliberately unchanged: a warning on a paragraph that publishes harms nothing; narrowing needs its own measurement. [chapter-title-quality.ts:59-77]

**44. `groundViewerTitle` split from `groundTitle`.** YouTube titles Title Case every word, so the chapter extractor returned "Buy", "Zero Accountability", "Critics Demons" as names — 7 of 10 titles ungrounded in a run where ONE was. Fix: two or more ADJACENT capitalized words the inputs do not contain. [chapter-title-quality.ts:310-341]

**45. The gerund-opener exemption** — "Debunking the AI-generated…" was reported ungrounded as the "name" "Debunking the AI-generated". [chapter-title-quality.ts:289-296]

**46. `describerClauses` is the INVERSE shape of `narratesAnActor`.** The old check flagged the target register on the verb alone while real failures sat in clauses the first-clause plumbing never read. Now: every clause of every sentence, describer SUBJECTS only, verbs not consulted. [chapter-title-quality.ts:222-239]

**47. The three-number title metric** (generic / entities-per-title / narrated) — kept independent because the motivating run scored well on entities and badly on register; a combined score hides exactly that. Baseline: 1/7 generic, ~1.6 entities/title, 3/7 narrated. [chapter-title-quality.ts:392-402]

**156. `narratesAnActor` reads the WHOLE title (2026-08-24).** The first-clause-only read passed "The closing prayer and the creator's final reaction" and "..., and the host's closing reaction to the sermon" — the exact possessive-narrator form the list's own header names as a failure — so the operator's belief that the judge warned on outro narrators was false. Two widenings, both restricted to the INVENTED-NARRATOR family because "the pastor's mongrel slur" in a later clause is target register: a possessive invented narrator flags wherever it stands ("followed by the host's..." has no clause break before the narrator), and an invented narrator at a later clause's subject position flags. The wider actor-noun/pronoun/narration-verb patterns stay first-clause-only — run per clause they misread trailing noun phrases ("the witchcraft claim" became subject-plus-verb). 20-case regression + all 31 cached fixture titles: the one bad u2 title flags, zero false positives. [chapter-title-quality.ts:155-190]

**157. The clause-final bare-form exemption** — 'claim' is in NARRATION_VERBS, so "The bridge contract claim, rebutted" (the operator's own worked example in the prompt bodies) was flagged as actor-verb from the day the check existed. A finite verb after a singular subject carries -s ("the host reacts"); a clause-final bare form is a head noun. [chapter-title-quality.ts pattern-2 exemptions]

### Transcription

**48. Saved transcripts + staleness stamp.** Reuse is the OPERATOR'S CHOICE, never a default; a record whose size/mtime disagrees is REFUSED — silently applying it would generate metadata for a video nobody transcribed. [saved-transcript.service.ts:1-24]

**49. mtime rounded to whole milliseconds** — APFS, SMB and network volumes report different sub-ms tails for the same unchanged file. [saved-transcript.service.ts:46-56]

**50. v2 records refuse v1** — a v1 record's untagged segments are indistinguishable from "tagged, all UNSURE". Cost stated: one re-transcription of anything saved before the build. [saved-transcript.service.ts:37-42]

**51. Reuse never silently re-transcribes** — a missing/mismatched record fails the item by name; re-transcribing would silently cost an hour the operator declined and hide that the video isn't the one he transcribed. [saved-transcript.service.ts:315-322]

**52. Tagging-on over an untagged record fails; tagging-off over a tagged record doesn't** — the audio the tagger needs was deleted at the end of the run that wrote the record. [input-handler.service.ts:536-548]

**53. Whisper exit 0 with a segment-less SRT is NOT success** — silent/music-only/failed-extraction audio; empty content would let generation fabricate from nothing. [whisper.service.ts:238-241]

**54. Tagging runs INSIDE `transcribe`, before the temp dir is deleted** — the 16kHz WAV the tagger needs is the audio whisper.cpp just read. [whisper.service.ts:129-134]

**55. `durationSec` is reported, not re-measured** — the probe already ran; null stays a stated absence. [whisper.service.ts:268-273]

**56. ONE renderer of attributed transcript text** (2026-08-23) — two joiners would render tagged segments flat on one path and screenplay on the other. [transcript-import.service.ts:427-433]

**57. Raw transcript direct-pass replaced summarize-by-default (2026-08-22).** Summarization fires only when the transcript genuinely cannot fit or compilation forces it — "every locally generated title was written from a summary of the video rather than from the video." Ceilings: cloud 60k chars; local 90k (derived from ctx budget). [ai-manager.service.ts:25-41] — *"when it cannot fit" superseded by #149 (2026-08-23): chapter digest, never a summary. Cloud ceiling now 400k.*

**58. `directPassScope` exists because `provider` became a legacy setting** — an all-local run under a cloud `provider` was condensing 62k-char transcripts that fit the local window raw. [ai-manager.service.ts:75-84]

**59. The summarizer model is DECLARED, not routed/from Settings** — a user who had ever configured a cloud model was silently paying that provider to read every transcript on an otherwise all-local run. [metadata-routing.ts:115-129]

**60. No built-in substitute for summarization prompts** — the "helpful assistant" fallback produced a summary with none of the ammunition and no sign anything went wrong; now throws naming file and key. [summarization.yml:10-13]

**149. ⭐ Chapters, not summaries, when the transcript cannot fit (2026-08-23).** Operator's directive, verbatim: *"I don't want summaries. We should try to pass the whole thing in. If we're using summaries instead then it should be in the form of chapters being passed in."* Supersedes #57's "summarize when it cannot fit" with **"chapter digest when it cannot fit."** On the per-item metadata path `summarizeTranscript` no longer fires at all; over the ceiling every field call reads the CHAPTER DIGEST — the published chapter list with each chapter's timestamp, title and detail paragraph. The digest is a condensation the run has already paid for and one written the right way round: each detail comes from ITS OWN chapter's raw transcript (one call per chapter, #11's law), where the blind chunk summarizer sliced at a fixed character count and admitted the cost in its own log line ("verbatim quotes and phrasing do not survive that step"). Two condensations, one free and structurally better, and the pipeline was paying for the worse one. [chapter-digest.ts:1-38]

**150. It is a DECLARED mode, not a degradation.** The run logs and warns *"the transcript is X chars, over the N-char <ceiling> direct-pass ceiling, so the content fields read the chapter digest (M chapters, K chars); verbatim phrasing is preserved inside each chapter's own detail"* — a statement of a mode this pipeline has, pushed into the run's warnings where the operator reads it after the fact (Law 8). The raw path declares nothing, deliberately: a line on every item saying the transcript passed through unchanged would bury the one item where it did not. [metadata-generator.service.ts:840-862]

**151. Over the ceiling with NO chapters FAILS, loudly, naming both facts.** Either fact alone is ordinary — chapterless items are routine (text subject, untimed transcript), over-ceiling items are routine (a six-hour livestream) — but the pair has no condensation anybody agreed to, and truncating or quietly re-summarizing is Law 1's deliberate bug. The error names the character count, the ceiling it is over, the absent chapter list, and what it did *not* do instead. [chapter-digest.ts:121-130]

**152. `contentMode` is a FIELD on the run context, not something inferred from length** (Law 10). Two readers must agree: the subject block drops the separate chapter table of contents when the content already IS one (printing it twice tells a model the video has twice as much in it), and the description's `{transcript}` slot goes EMPTY — the coverage block IS the content on that path, exactly as on a chapterless item. Nothing condensed is ever rendered under the heading "The transcript of the video, in full". [metadata-tasks.ts:147-166; ai-manager.service.ts:1124-1141; description-unit.ts:866-882]

**153. Compilation is the ONE surviving summarizer consumer.** Decided from the code, not by preference: compilation joins every item's output into a single combined prompt, so items must be short by construction (`forceCondense`, never size-dependent), and it runs no chapter pipeline — N items have N chapter lists, which is not one video's table of contents. `summarizeTranscript` and SUMMARIZATION_MODEL therefore stay, scoped and documented to that mode. The summarizer also stopped counting against the two-local-model budget on the per-item path: the digest is assembled in code and loads nothing. [metadata-routing.ts:115-143; ai-manager.service.ts:695-720]

**154. Verified without a model.** `npm run check:digest` (tools/chapter-digest-smoke.js) runs the dist build against a synthetic transcript: under-ceiling → raw transcript byte-for-byte; over-ceiling with chapters → digest content plus the declaration, and the assembled field prompt states what the video covers exactly once; over-ceiling without chapters → the loud failure. No transport stub was needed — no model is reached, which is itself the point.

### Speaker tagging (2026-08-23)

**61. The failure the feature exists for:** "Fox News frames the 13th Amendment's prisoner exception as…" — when the HOST brought it up. A flat two-voice stream attributes at random; roughly half the time the host's argument goes to the people he's arguing with. [speaker-tagging.service.ts:4-9]

**62. The embedding-model bake-off — four candidates, one survivor.** Gap between worst agreed-host and best agreed-footage caption: nemo_en_titanet_small **+0.386**; campplus −0.021; wespeaker CAM++ −0.426; wespeaker res34 −0.164. Three of four do not separate this material at all. [speaker-embedding.ts:14-26]

**63. Thresholds calibrated, not guessed** — HOST≥0.65 kept; CLIP moved 0.35→0.45 because a real footage caption scores 0.354. Margins 0.090/0.096. [speaker-embedding.ts:51-72]

**64. UNSURE is a real answer** — 18 of 297 captions (6%), every one an audible mid-caption speaker change. The chapter tagging gate counts UNSURE as "resolves to a side" — else the 6% throws away the tags on the 94%. [speaker-tagging.service.ts:19-24]

**65. Captions under ~0.5s are UNSURE** — happens zero times in the ground truth; counted separately. [speaker-embedding.ts:76-85]

**66. Python/speechbrain prototype replaced by sherpa-onnx** — a venv is not something a packaged Electron app can depend on. [speaker-embedding.ts:9-12]

**67. Two invisible traps:** `extractor.compute(stream)` defaults to an EXTERNAL ArrayBuffer that Electron's V8 refuses (works in plain node — a node-side test proves nothing; cost an hour); `dlopen` can't read from asar → `asarUnpack` must name the sherpa packages. [speaker-embedding.ts:28-37]

**68. Hand-rolled RIFF reader that REFUSES rather than resamples** — 44.1kHz scored against a 16kHz enrollment "would produce numbers that look like similarities and are not." [speaker-embedding.ts:105-110]

**69. No fallbacks on either side of the switch** — unenrolled = declared untagged mode; enrolled + anything wrong = the item FAILS naming the cause. [speaker-tagging.service.ts:26-32]

**70. Cost stated so it's not a consideration:** ~16s CPU for a 30-minute video. [speaker-tagging.service.ts:34-36]

**71. Everything that COUNTS WORDS reads the transcript without its labels** — leaving them in put "CLIP Debbie Wasserman Schultz" and "UNSURE Refugee Center" at the top of the entity pool. [metadata-generator.service.ts:940-948]

### Description

**72. ⭐ Withholding the channel rules — measured and reversed (2026-08-22).** The hook/body calls carried no channel identity and no rules ("over-specifies a small model"); the ONE production run under that arrangement wrote a 324-word synopsis of the NARRATOR with no CTA. Decisive: the same prompts reach Sonnet and Opus unchanged — "a call given no brief writes to no brief." [description-unit.ts:45-70; pipeline/description.yml:20-34]

**73. The transcript SUPERSEDES the summaries-only input** (operator, 2026-08-22): "a description written from a précis of the video reads like one." Chapter block stays beside it as the measured table of contents. [description-unit.ts:26-36]

**74. Schema `maxLength` removed — it TRUNCATES THE DECODE.** qwen3.5:9b and 4b both returned exactly 150 characters ending mid-word ("… — Flashpoint's 202"). Schema constrains SHAPE; caps are enforced in code as declared warnings. [description-unit.ts:119-126]

**75. Prompt asks 140, code enforces 150** — asked for "at most 150" a model writes 150 and stops mid-clause; asked for 140 it finishes the sentence. [description-unit.ts:129-134]

**76. Body word range is channel DATA** — one shared number would be wrong on two channels of three (YouTube ¶ / Spreaker 150-250 / Shorts 2-3 sentences). A 27b wrote 353 words against the instruction; it's a code-checked TARGET, never truncation. [description-unit.ts:137-152]

**77. YouTube descriptions are ONE paragraph** (operator-directed 2026-08-23); the code-appended chapter list is what sits below. [fields/description.yml]

**78. Three descriptions; variety confined to the HOOK.** Sampling the body at 0.7: 2 usable of 6 (two were the token "…", two stopped mid-clause). Primary at 0.2: 3 of 3. A 250-word schema answer on a model that reasons inside the same num_predict has no slack for hot decoding. [description-unit.ts:72-98, :184-217]

**79. The option drop rules, all observed:** "…" as a whole body (twice); mid-sentence stop inside the length range (three times); "…" as the hook (HOOK_MIN_WORDS now guards the primary too). Register never drops an option — "taste is exactly what the operator is there for." [description-unit.ts:231-247]

**80. A failed EXTRA drops with a warning — the one stated exception to no-fallbacks** — a missing OPTION is visible (the warning names it, the primary is right there); failing the item would throw away a correct description to punish a missing choice. [description-unit.ts:92-98]

**81. Register faults get a REVISION, not a blind re-ask** — measured twice: a blind re-ask failed the judge twice in a row; handing the model its own draft + flagged clauses converts a re-roll into an edit. [pipeline/description.yml:123-135]

**82. First person tried and rejected (2026-08-23)** — "I debunk its bullshit" — rejected as firmly as "the speaker". First person is the pinned comment's register only. [pipeline/description.yml:13-18]

**83. Speaker tags reach the description as a BLOCK, not duplicated prompts** — they change one thing (who a sentence may be attributed to); chapters duplicate because tags change the whole composition there. The old "never name the speaker" dodge is lifted where tags exist: "a description that names nobody cannot misattribute, and also cannot say who was right." [pipeline/description.yml:63-68]

**84. The description composer became the ONE implementation** — the composed description lived only in the reports page, so the extension filled Studio with the RAW description: no chapters, no hashtags. `LINK_BLOCK_MARKERS` order is load-bearing. [description-composer.ts:7-12, :76-88]

**85. Description default 9b → 27b → slot (2026-08-23)** — the 9B default shipped misattributed claims and invented facts ("serial rapist") where the slot's cloud options were publishable (the 10-way comparison). [metadata-routing.ts:299-301]

### Titles

**86. NINE DEFECTS fixed entering the shared titles file** — question-title contradiction (gone), dead 45-char floor (70 ceiling + hook-in-45), "Name names. Always." (nuanced), frozen A/B citations (live runtime block instead), "[bracketed tag]" folklore (gone), ASCII rule banning "Beyoncé" (now bans emoji/smart punctuation only), author-notes shipped to the model (gone), stale claims about the search phrase driving other fields (reworded), grounding moved to CODE. [fields/titles.yml:8-36]

**87. The ASCII rule fixed in three places** — diacritics in a real name are the correct spelling of that name. [system.yml:14-16; self-check.yml:20-21]

**88. Titles run FIRST — a contract.** The thumbnail call takes the ten titles as INPUT DATA; that's what keeps the cross-field rule followable at one call per field. [metadata-tasks.ts:118-132]

**89. Title grounding: measure, re-ask ONCE, KEEP with a declared warning** (operator's standing rule: deliver, curate). The re-ask now re-runs the titles call only — under grouping it regenerated three other fields as collateral. "Nothing to check against is not a pass." [metadata-tasks.ts:1905-1932]

**90. Titles adapter sampled at 0.7; description/tags adapters greedy** — six candidates need six different bets; a metadata run returning a different description each time cannot be reviewed. [metadata-tasks.ts:980-987]

**91. The adapter `target:` CTR-tier line was dropped in the port and put back** — all 7,497 title training rows carry it; dropping it put every titles call OFF the trained distribution. [metadata-tasks.ts:940-945]

**92. The invented-name guard was REMOVED (2026-08-19)** at the user's direction after false positives on real references. [metadata-tasks.ts:1183-1185]

**93. Thumbnail/title check changed from no-repeat to angle coverage (2026-08-22)** — the human picks the final pairing; the model's job is a diverse option set. [fields/thumbnail-text.yml:23-28]

### Tags & hashtags

**94. Code-owned on the chaptered path** — (1) a sort and a budget, not judgment; (2) YouTube reads an absent-from-content tag as a SPAM SIGNAL, and a model writing from a summary invents plausible ones nothing downstream can detect. `occursIn` is the test. [tags-hashtags.ts:1-25]

**95. ⭐ THE SEPARATOR.** qwen3.5:9b returned one space-joined run-on 2 of 3 runs — a 160-char "tag". The one channel that came back correct is the variant whose text happens to contain "comma-separated." The fix is NOT splitting on whitespace ("prosperity gospel scam" is one tag); the prompt states AND shows the separator; `unusableTagList` refuses. [fields/tags.yml:11-29; tags-hashtags.ts:312-347]

**96. The tags exemplar names its SLOTS, not a real list** — shown a real shipped list, 9b answered a televangelist-jet video with "sb10 ten commandments law". [fields/tags.yml:31-36]

**97. Brand terms became channel DATA** — genericised, the model omits them or invents one ("O. Morgan"). `brand_terms` (model works them in) vs `channel_tags` (code appends verbatim) — distinct on purpose. [fields/tags.yml:38-46]

**98. Key phrases earn tag slots only as PHRASES** — one-word candidates are bare frequent words ("believes", "saying"); rank 30 on a spoken transcript is "book titled". The budget goes unspent rather than filled with noise. [tags-hashtags.ts:89-98]

**99. Category terms from the TOP of the ranking** — the tail-is-most-general theory was tried and reversed: the tail is "lies told". [metadata-tasks.ts:2060-2065]

**100. The apostrophe survives tag cleaning** — stripping it turned "nazi germany god's" into a phrase the video never says; a real tag lost to its own cleaning. [tags-hashtags.ts:136-142]

**101. Hashtags are word-bounded** — "#GodAndRyanWalters" and "#ISorryNoIM" shipped before the bound; under three available it returns what it has. [tags-hashtags.ts:248-250]

**102. Misspellings from a static rules table, not a model call** — the mistakes a listener makes typing a name they've only HEARD. [tags-hashtags.ts:163-176]

**103. `unusableTagList` THROWS where the title check warns** — a comma-less tag list has no version that ships, so there is nothing for a warning to declare. 80 chars = no longer a tag (longest real one: 31). [metadata-tasks.ts:2008-2024]

**104. The entity stoplist is deliberately short, each omission measured** — "and" glued names ("God and Ryan Walters"); "in/on/at/to/for" did too ("Hitler in Atheist"); only "of"/"the" survive; capitalized ordinary words don't glue ("Whenever Trump"); contractions cut at the apostrophe ("You're I'm" was reaching the entity list). [entity-extraction.ts:61-113]

**105. No BERT-class NER** — no 100M-param dependency for "did this string occur in the transcript". Cost stated: precision. [entity-extraction.ts:13-18]

**106. Uncased transcripts disable the scaffold and grounding — DECLARED, not lowered** — "no entities in this chapter" and "no capital letters in this transcript" are different facts with the same symptom. [entity-extraction.ts:20-24]

**107. Key-phrase ranking degrades to FREQUENCY and declares it** — the mode goes into warnings; only the top 200 candidates are embedded. [key-phrases.ts:15-19]

### Routing & models

**108. ⭐ ONE CALL PER FIELD — measured.** The 4-field group call dropped a key 1 of 6 runs (no metadata at all); the older 7-field call wrote a title in thumbnail voice (`FOURTH JET`). Grouping's cross-field coherence preserved by ORDERING + INPUT DATA. [metadata-tasks.ts:4-22; prompt-artifacts/README.md]

**109. Single-key schemas constrain SHAPE only** — `maxLength` truncates the decode; `minItems` pads a list rather than thinking of another angle. [metadata-tasks.ts:311-324]

**110. NO UNIT RELEASES A MODEL** — per-stage unloads re-streamed ~17GB into unified memory between stages and froze the machine; a stage DECLARES residency, the JOB releases once. [model-lifecycle.ts:1-29]

**111. ONE num_ctx per model per run + a job-level ratchet** — any change forces a full reload; growth is legitimate, shrinkage never is. [metadata-tasks.ts:48-53; ollama-json.ts:26-29]

**112. THE FOUR OLLAMA TRAPS:** `/api/generate` never `/api/chat` (reasoning lands in `message.thinking`, content empty); never send `think` (false RELOCATES reasoning into `response`); `format:"json"` sometimes puts the object in `thinking` (observed nearly every call of the validation run); one num_ctx per run, REFUSES over truncating. Plus: `done_reason:"length"` is a hard failure. [ollama-json.ts:12-35]

**113. Seed is the caller's choice; no default** — pinned seed makes a measurement repeatable and a regeneration pointless. [ollama-json.ts:193-195]

**114. Writing is not measuring** — chapters at temp 0 (measurement); field calls at 0.7 (writing) — at 0 the model writes the same title for every video whose subjects rhyme. [metadata-tasks.ts:516-522]

**115. TWO LOCAL MODELS IS THE BUDGET — declared, never blocked** (operator's instruction); embedding model excluded (274MB loads beside, not instead). [metadata-tasks.ts:41-46]

**116. headline-14b adapters removed because their base was deleted** — "an option naming a model that cannot run is a job that fails an hour in." [metadata-routing.ts:151-159]

**117. The 27B colon-title caveat is a property of the PROMPT** — generic brief: 47% colon titles (colons lose 20-to-5 in the A/B record); real head-to-heads in the prompt: 0%. A larger model amplifies whatever the prompt teaches, in both directions. [metadata-routing.ts:178-194]

**118. The /api/chat thinking trap, probed with this app's exact options** — 74 chars of response, 566 of thinking; anyone moving to /api/chat must add a think flag or every local field silently becomes an empty string. [metadata-routing.ts:196-207]

**119. qwen3.5:4b offered on description/tags only, never default** — measured floor for schema-constrained mechanical work (10/10 placement, ~1.2s); 2b fails instruction-following even constrained. [metadata-routing.ts:161-176]

**120. The writing-model slot: ONE choice, and chapters follow it** — the operator's real decision is "local 27B or a Claude model", not "which model writes pinned comments". A disagreeing store renders CUSTOM, never rewritten. Tags stay out. [metadata-routing.ts:359-387]

**121. Removed routing ids are RECORDED, not guessed at the read site** — validation throwing on the store's own contents lands on the one screen where the user could fix it. Anything not in the removal map still throws. [metadata-routing.ts:446-459]

**122. The legacy whole-metadata path is deleted; only COMPILATION survives** — items used to reach it because they had no chapters, generated by whatever Settings named, ignoring the routing table, with nothing in the report saying so. [ai-manager.service.ts:901-915]

**123. Cloud structured outputs (2026-08-23); the "end with }" nudge removed** — the nudge was itself implicated in Sonnet dropping the closing quote to make the answer literally end with "}". Constraining the OUTPUT does not constrain the REASONING. [ai-manager.service.ts:1332-1344]

**124. JSON extraction by brace depth, never regex** — first-{-to-last-} broke both directions; and the 200-char error snippet made two cloud failures diagnosis-by-guesswork, so the WHOLE answer logs now. [ai-manager.service.ts:1366-1371]

**125. No sampling parameters ANYWHERE — provider defaults for every model, local and cloud** (operator's ruling 2026-08-24: "i dont really want to mess with core model settings... i would rather switch models"). History, same day: the rule began as cloud-only with a false premise ("newer models reject them" — the API docs checked 2026-08-24 do NOT deprecate temperature; true only of newer OpenAI models and of Claude with extended thinking on); cloud temperature threading was built when temp-1.0 default was identified as the close-quote-runaway trigger (prose-token .” beats JSON-token ." at a string's end; the schema grammar masks end-of-message; brace spam to the ceiling), then reverted the same night by this ruling and extended to the local path — chapters' temp-0/seed-0 measurement design, description's 0.4/0.2/0.7, field calls' 0.7, and the adapters' evaluated decodings all superseded. The runaway is held instead by the ASCII-quote system rule on schema calls plus the netting (stop_sequences ['}}}}}'], max_tokens 4000, truncation recovery). Superseded measurement under re-test at defaults: option bodies at 0.7 gave "..." (2 usable of 6). At default sampling a re-ask is naturally a second sample, so the seed juggling went with the temperatures. [ai-manager.service.ts, ollama-json.ts, chapter-whole-transcript.service.ts, description-unit.ts, metadata-tasks.ts]

**126. `channel_tags` append closes the hole the tags adapter opens** — its trained prompt says channel/creator names are appended separately; without the append a local tag list never names the channel. YouTube counts 500 chars over the joined list; multi-word tags cost two extra (quoted). [ai-manager.service.ts:1494-1520]

**127. The prompt trace exists because the operator has the output and nothing else** — cloud calls + legacy paths; local per-field calls are covered by "Show prompt". [ai-manager.service.ts:206-220]

**159. `claude-cli` is a first-class routing option on every modal row (operator, 2026-08-24).** "make it so i can pick claude -p (which will always route to sonnet)" — the option is `{ kind: 'cloud', model: 'claude-cli:sonnet' }`, always Sonnet by declared meaning (a model picker inside a transport picker would be two decisions wearing one id). `makeRequest` gains a `claude-cli:` branch → `makeClaudeCliRequest`: spawns `claude -p --model sonnet --system-prompt <plain|json system>` on the operator's subscription; `ensureProviderReady` needs no key for it. NO API fallback — a spawn failure (ENOENT names the GUI-launch PATH problem), nonzero exit, or the 10-minute kill (parity with the SDK's request timeout; an unbounded spawn would hold the 1-slot queue forever) all throw loudly, because falling back would silently bill the key the option exists to protect. Zero frontend changes — the modal renders the backend view's label. Verified end-to-end: `--route thumbnail_text=claude-cli` through the real pipeline, and `buildRoutingView` lists it on all seven rows. Supersedes nothing; the CLI's blanket `--claude-cli` flag (#158) remains for swapping ALL claude calls in a test run without touching routing. [metadata-routing.ts; ai-manager.service.ts]

### Prompt architecture (other)

**128. ONE directory holds every model-facing string; nothing falls back** — a missing file/key/channel THROWS naming both. "A fallback prompt produces output that looks generated and was written to no brief." [prompt-assets.ts:4-14]

**129. The self-check split, per group then per field** — a titles-only call was being told about thumbnail text it would never see; "unfollowable lines teach a model that some of this prompt is decoration." `alsoAvailable` keeps cross-field lines alive under one call per field. [fields/self-check.yml:3-13]

**130. Two consolidations into editorial-core** — the two near-duplicate emotion taxonomies became one; "don't write ten rephrasings" stated once instead of four times. Two grandfathered POSITIVE-FORM exceptions: the AI-tells and clickbait-filler lists (banned PHRASES, not banned register). [editorial-core.yml:8-22]

**131. The compilation framing lost its WRONG/CORRECT example pair** — a model shown a wrong form reproduces it. [system.yml:24-26]

**132. `absorbUnownedSections` is gone** — channels are pure data checked against the registry; anything unclaimed is named in a warning, not appended to somebody else's prompt. [metadata-tasks.ts:1516-1523]

**133. The `fields` list is a statement, not a config** — an absent field is not generated, not routed, not assembled, and the log says so. [channels/telltale.yml:3-6]

**134. Adapter system prompts: editing them is a RETRAINING decision** — a tightly-conditioned LoRA degrades on a reworded system prompt in ways that don't look like failure. Moved into the prompt directory anyway: one home per model-facing string beats accidental protection. [pipeline/adapters.yml:3-14]

**135. ONE PASS over the whole template, never chained `.replace`** — chains rescan inserted text (a transcript containing "{pools}" would be substituted into); function replacers because transcripts contain `$&`. An unfilled brace survives visibly rather than being silently blanked. [description-unit.ts:782-787]

### Reports, identity & linking

**136. `item_id` replaced positional identity** — position changes when a sibling is deleted and nothing validates it at any boundary; minted once, crypto not Math.random (a duplicate silently merges two items' publish selections). [item-identity.ts:1-13]

**137. `source_filename` reads the item's own `source_path`** — the array-position inference was already wrong for 16 of 111 live reports. [generated-index.ts:38-41]

**138. The report migration: lazy, never guesses, reports** — a startup migration with Callisto unmounted would report "0 files migrated", read as "done". Selection files deliberately not migrated before their readers — invisible data loss dressed as progress. [report-migration.ts:5-25]

**139. `deleteJob(jobId)` was removed before it ever ran** — it would have rm -rf'd a txt folder shared by seven jobs. [output-handler.service.ts:651-656]

**140. `initializeJob` no longer mints a jobId** — the unreachable mint would have produced an orphan the day it ran. [output-handler.service.ts:141-149]

**141. Report reading moved out of the renderer** — the page JSON-parsed all 111 job files on every mount; now cached per file by mtime, no TTL. [report-index.ts:9-25]

**142. The editor-transcript link DECIDES NOTHING** — 75% hint rate over all 40 live exports; auto-linking would be wrong ~1 in 4. The operator confirms every link; ambiguous never pre-selected. [editor-transcript-link.ts:12-14]

**143. Drift is surfaced, warned, never used to refuse** — measured −10s to −220s (−23%), dominated by FCPX TRIMMING; re-measured at generation time because the export can be re-rendered between linking and queueing. [editor-transcript-link.ts:614-616]

**144. A link changes where content FIELDS get words; never what the timeline is measured from** — Whisper runs on the FINAL EXPORT on both branches; editor `srtSegments` would move every chapter by the drift. [input-handler.service.ts:444-448]

**145. Episode splitter: an honest imbalance beats fabricated even splits** — redistributing evenly leaves titles/descriptions attached to time ranges they no longer describe. [episode-splitter.service.ts:703-712]

**146. Compilation content-origin mismatch throws BEFORE the first model call** — finding out after N summarizations costs the operator the run. [metadata-generator.service.ts:497-500]

**147. `_is_compilation` is written on BOTH branches** — true-or-absent made "not a compilation" and "written by a build that didn't record it" the same value. [metadata-generator.service.ts:616-619]

**148. `chaptersSkipped` is written onto the ITEM** — warnings die with the response; the report is read long after. [metadata-generator.service.ts:632-636]

## II-B. Publish, analytics/A-B, editor, extension, build

### Publish — plan level

**1. The API is the primary publish path; the extension fills only what the API cannot** (monetization, A/B titles, Studio-only fields) and remains the path for legacy videos. Extension fills stay operator-clicked — no Studio automation, on ToS grounds. [PUBLISH-PIPELINE-PLAN.md "Decisions settled" #1; AB-TEST-PLAN.md §1]

**2. YouTube API audit filed at the START of Phase 0** (weeks of lead time); until granted, `videos.insert` is deliberately absent from the pusher — API-uploaded videos would be locked private. Still pending. [youtube-push.ts:9-16]

**3. `videos.update` REPLACES the whole submitted part** — a naive title-only update wipes description, tags, categoryId. The pusher reads current snippet/status and hands unchanged fields back as the same object, so there is no field list to fall out of date. [youtube-push.ts:17-27]

**4. Quota model corrected mid-plan** — an early draft's "1600 units/upload from the shared pool (~6/day)" is WITHDRAWN; `videos.insert` has its own 100/day bucket at 1 unit; `videos.update` 50, `thumbnails.set` 50 from the shared 10k. Stated explicitly so it isn't re-derived. [PUBLISH-PIPELINE-PLAN.md Phase 3]

**5. `videos.update` push dropped from v1, later partially revived** for metadata-onto-existing-video (never upload). [AB-TEST-PLAN.md §6 item 4]

**6. Rotation A/B engine deferred** — API-legal but time-confounded on fast-decaying content; only worth it for back-catalog. Schema already supports it. [AB-TEST-PLAN.md §5]

**7. Spreaker is a per-project "publish as podcast" flag, not a fourth channel** — one account, one show, pulls from all three channels. `isPodcast` is a strict boolean, never absent. [PUBLISH-PIPELINE-PLAN.md #5]

**8. Archive deletes are NOT plain FIFO** — they insert ahead of pending syncs and never interrupt the running job; the real constraint is exclusion against the RUNNING transfer. Verified live 2026-08-21 (14/14): a delete asked mid-sync of an unrelated week waited 23.2s then ran, rather than refusing. [PUBLISH-PIPELINE-PLAN.md Phase 0a]

**9. The negative control is the result worth keeping longest** — the guard a careless reading produces (`jobsUnder(destination)`) found 0 where the correct one (`syncsWritingUnder`) found 1: a guard that never fires. Recorded as method. [Phase 0a]

**10. Five traps in the archive queue** — head-of-pending ≠ index 0; dedupe by localPath alone swallows a delete; resurrection by a pending same-path sync; the `archive-gone` branch would drop deferreds unsettled; and the reentrancy deadlock found only in implementation (a queued delete calling public `check()` waits for a slot it already holds — no error, no timeout, no log). Fixed by `runExclusive` handing the body a queue-bypassing `check`. [Phase 0a traps 1-5]

**11. Phase 0b damage scan: prevention, not repair** — 109 job files scanned read-only, ZERO splice damage; one-job-per-input is deliberate so the positional-key family was dormant *by construction* — but the backend's individual branch already loops `addItemToJob`, so one plausible refactor would have activated every corruption mode at once. [Phase 0b]

**12. `itemIndex` → minted `item_id`; alternatives rejected on the record** — hardened positional (every new consumer a new corruption site), source-path hash (text subjects have no path; archive-sync moves files), content hash (collides), UUIDv4 (not time-sortable), SQLite (report-file portability is load-bearing). `source_key` retained as the regeneration HINT. [ITEM-ID-PLAN.md §5]

**13. Eight named live defects behind the item-id work** — incl. P2 live data loss: name-derived `txt_folder` shared by 2-7 jobs ("4 - satanism": 7), history-delete rm -rf'ing siblings' output. Acceptance test: delete one of two reports sharing a folder, assert the sibling's .txt survives — "fails under today's delete-job-history, which is the point." [ITEM-ID-PLAN.md §2-6]

**14. `publishAt` enforcement deferred to the API call site by design** — Phase 1 stores intent + `publishAtSetAt` provenance; thumbnail slot renumbering hit 13/40 live exports ⇒ always preview + confirm; 44 null channelIds seeded lazily, no guessing migration. [PHASE-1-2-SPEC.md §4]

**15. The transcript-drift finding reshaped Phase 2's premise** — drift measured −36.9s/−35.0s/+42.5s/−125.2s(−21.3%)/−10.3s/−220.3s(−23.4%): chapters from the editor transcript are impossible (two-source design confirmed), and drift is FCPX trimming, not "~57s of ads". Surface at link time, warn past ±10%, never auto-refuse. [PHASE-1-2-SPEC.md §3.0]

**16. Editor-story linking is a HINT, never an auto-link** — 76% hint rate (17 exact/13 label/1 ambiguous/10 none over 40 exports); auto-linking wrong ~1 in 4. Owen revised 2026-08-22: linking OPTIONAL, nothing pre-selected. The PR-4 acceptance test is that the finder returns exactly 17/13/1/10. [PHASE-1-2-SPEC.md §3]

**17. No-link is a DECLARED MODE** (`final-only-declared` / `-default` / `-unlinkable`); a declared link whose file is missing FAILS the run rather than quietly running final-only. [PHASE-1-2-SPEC.md §3]

**18. Phase 4 redesign measurements** — a report is 3.5-4.75 screens tall with the A/B slate buried at position 2; `channelId` null on ALL 44 live selections (unrouted is the majority state); renderer JSON-parses all 111 files per mount. Status: mockups only. [PHASE-4-DESIGN.md §0]

**19. Phase 4 explicit cuts, listed so they are not re-derived** — drag-to-reschedule (a drop carries a date, `publishAt` is an instant: "two clicks with a visible time beats one drag with an invisible one"), week view (earns nothing at 1-2 uploads/day), bulk reschedule, iCal, capacity targets, analytics overlay. [PHASE-4-DESIGN.md §2.4-3]

**20. Vocabulary correction** — the brief's `pushedAt` field does not exist; design uses the real fields. [PHASE-4-DESIGN.md §0]

### Publish — code level

**21. Selections stored per ITEM, not per job** (changed once); kept out of the job JSON so raw generator output stays pristine. An unreadable selection is NAMED, never counted away — it would look like an item nobody opened and the next write would overwrite hand-curated A/B choices. [publish-store.service.ts:7-29]

**22. `itemIndex` REFUSED, never translated** — old-shape requests get a 400 naming the minimum extension version; "a translation would be a guess about which item the operator meant." [ingest-server.service.ts:79-95]

**23. The validator table moved out of publish-ipc into its own module** — carry-forward became a second writer, and a second writer with its own idea of a valid channelId is how a value nobody would accept over IPC lands on a record. What it replaced would have accepted `isPodcast: "false"` (truthy) — the `_is_compilation` bug in a new place. [field-validators.ts:1-50]

**24. Channel routing never defaults to Telltale** — one match → channel; zero → null with a reason; two+ → THROW (a channels.json contradiction; picking either would make it invisible forever). [channel-routing.ts:15-26]

**25. Thumbnail hard floor set to YouTube's real number** — all 28 live thumbnails measured 1200×675; the spec's "≥1280×720 hard" would have refused every one for a rule YouTube doesn't have. Floor 640×360; 1200×675 passes with a warning. [thumbnail-validate.ts:33-50]

**26. No image library — read the header** — a thumbnail check is not worth a native dependency; both accepted formats put dimensions in the header. [thumbnail-validate.ts:19-25]

**27. Validators never fix, and re-run at use time** — "the fix is Owen re-exporting"; the path points at an external volume, so "it validated when I picked it" says nothing about now. [thumbnail-validate.ts:8-18; audio-validate.ts:9-24]

**28. Spreaker limits pinned from the help centre** (300MB — the API guide states none); OAuth2 only, `basic` scope only; nothing retries (429 may mean IP blacklisting). [spreaker-push.ts:26-50]

**29. Spreaker push is a CREATE, not an UPDATE** — pushing twice publishes a SECOND episode; `spreakerEpisodeId` present = refuse. [spreaker-push.ts:9-23]

**30. Video matcher: the draft filter became a LABEL** — a draft cannot be A/B tested, so the published case matters most; duration is a verification guard, not the key. [video-matcher.ts:10-21]

**31. Report resolution: recency beats picked titles** — a pick left on an older report used to drag the shelf backwards in time; reports linked to another video were dropped silently for years (the count now travels in the reason). [publish-bridge.ts:329-345]

**32. Carry-forward: what does NOT carry, with reasons** — refuses `publishAt` (about one upload), `videoId` (would aim the next push at a video this run never produced), `chosenTitles` (index a different run's list), `pushedAt`/receipt (would claim a push that never happened). "PARTIAL IS A STATED OUTCOME, NOT A FALLBACK." [carry-forward.ts:1-45]

**33. Selection migration never deletes** — unresolvable files MOVED to `selections/orphaned/` intact: "'we could not work out which item this belongs to' is a thing to say, not a thing to tidy away." [selection-migration.ts:1-31]

**34. `publishAt` must carry an explicit offset** — a bare local string is refused; the earlier behaviour silently stored the wrong hour across DST. [publish-types.ts:73-78]

**35. `filled` is deliberately NOT `published`** — filling puts text in the form; the operator presses Save. [publish-bridge.ts:487]

### Analytics / A-B

**36. "The A/B loop is an empty socket" was WRONG and corrected on the record** — PR #13 (2026-07-26) closed the loop end-to-end; 157 decided tests verified on disk. AB-TEST-PLAN.md's contrary text is stale and knowingly so. [TITLE-EVIDENCE-PLAN.md §3a]

**37. `liftPct` is POINTS, not a ratio** — `(+X% lift)` overstated ~3× at the stored values, in the one text whose job is teaching the model which titles win. Now `+8.6 pts watch-time share`, source lines pinned "so it does not get 'simplified' back." [TITLE-EVIDENCE-PLAN.md §3b]

**38. The 41% isWinner-vs-argmax disagreement was an ARTIFACT, twice corrected** — the store shows 0 of 157 disagreements; the exporter emits rows for UNDECIDED tests with winnerIndex defaulted to 0. Correct filter: `testOutcome == 'winner'`. Export holds 141 decided vs the store's 157, sets not nested — whether a backfill is needed at all is OPEN, pending a videoId set-difference nobody has run. [TITLE-EVIDENCE-PLAN.md §3b/3c]

**39. Three losing title traits, isolation-tested on 1,087 variants** — colon lost-alone 20/won-alone 5; question 15/2; digit 13/2. Naming a person is table stakes (90% of winners AND 91% of losers). Length decides nothing in the tested range. Reproduced across two export generations. [TITLE-EVIDENCE-PLAN.md §2]

**40. Measured effect of real head-to-heads in the prompt** — generic brief: 58% colon rate, 75% any losing trait; +521 curated titles: 17%/42%; +115 A/B head-to-heads: **0%/25%**. "Invisible by eye — the zero-shot titles look the most polished of any arm." [TITLE-EVIDENCE-PLAN.md §2]

**41. The length cap is untested by the A/B record, not refuted** — kept for mobile truncation; never sold as a performance rule. [§2]

**42. Two live prompts were instructing the losing shapes** — "Numbers and one [bracketed tag]…" and a QUOTA requiring one question-format title per batch (the shape that loses 15-to-2). "Fixing these three lines is probably worth more than the whole rules-derivation build." [§8]

**43. Fine-tuning tried and lost** — 9.4h QLoRA on qwen3.8:27b overfit inside the first 40% of one epoch (15/15 dialect cells agreeing); 9,721 rows but only 3,363 distinct titles ≈ 41k tokens against a 262k window — "there was nothing to compress." And training cannot curate: a prompt carries winners AND losers. [§7]

**44. Aggregate rules shipped as a TS port deliberately identical to the Python** — change one and the numbers stop reconciling; `\p{Nd}` not `\d` (Python's is Unicode-aware). Bands: STRONG ≥15 isolated losses AND ≥3:1; WEAK ≥8 AND ≥2:1; below → an observation, never a rule. [ab-title-rules.ts:11-95]

**45. The empty case is a NORMAL state, stated in words** — no single channel produces a strong rule (~272 tested videos per strong rule pooled); silence reads to a model as "nothing to avoid." Never substitute generic SEO advice. [§3d; ab-title-rules.ts:283-291]

**46. Never state a null result as an instruction — measured** — an arm told "length decided nothing" emitted a 101-character title, longer than any variant ever tested. Null findings render as observed ranges. [§4]

**47. Two traps that cost real time** — thinking models return empty content at tight budgets (`done_reason:"length"` with `content:''`); models preamble, so validate 15-110 chars and strip list numbering (a surviving "1. " also trips the digit check). [§4]

**48. The CSV format already drifted — read by column NAME** — 32 columns became 31 between generations; a positional reader would have kept producing plausible rules from the wrong column. [§4]

**49. CSV is NOT a transport into ContentStudio** — `POST /analytics/ab-tests` is live; the combined-CSV exporter serves a different consumer (the shipped web tool). Standing request: fail if a channel vanishes between exports. [§5]

**50. The exemplar block replaced an unbounded per-test dump** — ≤3 rules and 10 exemplars whatever the store size; insights written before the field existed THROW rather than shipping a prompt with no title evidence. [insights-prompt.ts:64-77]

**51. `removeAbTests` — an absence that was a defect** — the collector cannot retract; silence reads as "no news" to an upsert store, so a withdrawn learning kept feeding the generator. Callers must re-distil or the removal "would look done and change nothing the model sees." [analytics-store.service.ts:480-495]

**52. Ingest server: 127.0.0.1 only; CSRF = reject http(s) Origins; the bearer token is vestigial** (generated, displayed, enforced by no endpoint). Port collision records an error state, never picks another port. [ingest-server.service.ts:14-30]

**53. Analytics windows and floors** — 180-day insights window (stale feed impressions confound lifetime CTR); MIN_PACKAGING_IMPRESSIONS 1000 (below it CTR is meaningless and must never be an example to emulate); first-week snapshot 168h±48h; nulls excluded, never 0. [distillation.service.ts:12-40]

**54. `selectedArm` ≠ `winnerArm`** — conflating them invented winners for 22 of Telltale's tests (YouTube defaults undecided to arm 1). [AB-TEST-PLAN.md §8]

### Editor (port + services)

**55. Cardinal rules of the port: no fallbacks; port, don't rewrite** — ACS behavior is the spec wherever the doc is silent, comments and error messages included. [EDITOR-PORT-PLAN.md]

**56. The resolver chain that ended in a guess was DELETED** — ACS's "return the bare name and hope it's on PATH", the hardcoded conda path, the hardcoded /Applications bundle path: all gone. managed → repo layout → THROW naming the exact path. "An ffmpeg that is not the one this pipeline was built against fails later, somewhere unrelated, with a worse message." [binary-resolver.ts:10-22]

**57. `webSecurity: false` — editor window ONLY** — DOM media points at file:// which is cross-origin from both dev http and packaged file pages; the main window keeps the default. [editor-window.ts:22-29]

**58. Editor window deliberately NOT a child window** — a parented BrowserWindow on macOS cannot be dragged to a separate display (DisplayLink virtual monitors included). [editor-window.ts:12-19]

**59. Archive sync: two deliberate omissions** — NO `--delete` (the user deletes local copies once archived; a mirror would erase the only surviving copy) and NO `--checksum` (reading 140GB on both sides to prove what timestamps already say). [archive-sync.ts:11-22]

**60. rsync, not copy** — a day folder is ~140GB that never changes after ingest. [archive-sync.ts:4-9]

**61. The sealed chapter-splitter method's laws** (2026-08-02, kept in the editor's story-splitting) — never emit a timestamp; temp 0 + format:json (0.50 → 0.00 on consecutive runs otherwise); invented neutral-domain names in examples (real names LEAK deterministically at temp 0); RANK ratings, never threshold (AUC ~0.55 alone, ranking doubles F1); over-segment then consolidate (over-splits are one click, under-splits unfixable); prompt bodies verbatim from the tested harness — "tested artifacts, not suggestions. Do not 'tidy' their wording." [chapter-splitter.ts:1-46]

**62. HOST/CLIP tagging in splitter stage 4, driven by a named failure** — audition3 showed attribution INVERTED on "racist flight attendant" (the host calling the PASSENGER racist). [chapter-splitter.ts:56-64]

**63. Ollama-only is a deliberate first step** — models already pulled locally; 127.0.0.1 over `localhost` (Windows reliability), the variant retried once "as a courtesy, never as a silent mask." [ollama-service.ts:4-14]

**64. Asset hosting moved repos without changing identity** — same artifacts, same sha256s: "identity is the checksum, not the URL." [asset-catalog.ts:17-22]

**65. editor-backend slimmed 2026-08-17** — non-arm64 and the bundled CPython removed; recovery path documented. [EDITOR-PORT-PLAN.md]

**66. One resolver per subsystem, not one shared resolver** — "beats one shared resolver with divergent semantics." [EDITOR-PORT-PLAN.md]

**67. Channel-name collisions resolved by namespacing (`editor:*`), no reuse-with-different-shape**; `sendToRenderer` targeting `getAllWindows()[0]` flagged as must-fix before a second window. [EDITOR-PORT-PLAN.md]

**68. Alignment audio never returns a fabricated envelope** — non-zero exit rejects with stderr tail; silent/empty rejects by name. "Project doctrine." [alignment-audio-service.ts:7-13]

**69. `shared-paths.ts` portable by design** — Node built-ins only; per-machine, not synced; Windows uses Local not Roaming. [shared-paths.ts:1-21]

**160. The editor transcribes on whisper large-v3-turbo (operator, 2026-08-24).** The heavier-model swap the base catalog entry's comment always promised. `whisper-large-v3-turbo` is the required catalog entry (sha256/bytes computed from the actual 2026-08-24 download, 1,624,555,275 bytes); `whisper-base` demoted to optional and kept so older installs still resolve. `getWhisperModelPath` prefers BOTH turbo rungs (managed, then bundled) over every base rung — a machine with managed base installed and a bundled turbo must run turbo or the swap never lands — and the transitional chain below stays, logged with the sidecar's model provenance. Verified before the entry was written: the bundled Metal whisper-cli loads turbo and transcribed a 4-second test clip verbatim in ~1.2s; the model is installed in the managed dir AND the dev-checkout models dir on this machine, so neither dev runs nor the setup screen re-download. Cost accepted: turbo is ~5x slower than base and 11x its size; transcription quality is the priority now. [asset-catalog.ts; binary-resolver.ts]

### Extension

**70. Recon was done on the wrong page — three live bugs, one root cause** — the standalone edit page differs from the upload wizard (different A/B dialog host, nav chips polluting `ytcp-chip`, paid promotion as a checkbox). "Any future recon must be done in the wizard." [AB-TEST-PLAN.md §3]

**71. `ytcp-chip` MUST be scoped to `#tags-container`** — 21 visible chips = 5 nav + 16 tags; an unscoped selector grabs "Videos", which has no delete icon — "exactly how the first live run failed." [AB-TEST-PLAN.md §3]

**72. The Studio DOM exposes the original filename the API withholds** — "the single most valuable finding": matching is an exact filename join, not fuzzy title similarity. [page.ts:1-7]

**73. ALL localhost traffic goes through the service worker** — a content-script fetch carries the page's Origin, which the CSRF whitelist rejects; "that rejection is correct and must not be relaxed." [publish-messages.ts:1-14]

**74. Content script stays in the ISOLATED world** — DOM nodes are shared; the one thing needing page globals is asked of the worker. [publish-content.ts:11-16]

**75. Two distinct write mechanics** — contenteditable needs `execCommand('insertText')`; the tags `<input>` needs the native value setter + Enter. Verified live: one write took the chip count 16 → 18. Tags REPLACE requires clearing the 16 channel-default chips first. [dom.ts:1-18]

**76. Selector policy: stable attributes over visible text** — SCREAMING_SNAKE radio names, `#delete-icon` not localized aria-labels; A/B variant slots located BY POSITION (aria-label is localized English, confirmation only). [fillers.ts:12-18]

**77. The nav strip re-pointed to Studio's own list** — tying it to the app made it go dark when the app closed and let collector coverage decide which videos the operator could reach. [nav-source.ts:1-17]

**78. The nav message is NOT a PublishMessage** — it never leaves the browser; it carries no videoId "an id in the message would be an invitation to trust it over the tab." [nav-messages.ts:1-20]

**79. The nav strip is NOT mounted in the upload wizard** — a hard navigation would drop half-entered unsaved state. [page.ts:30-40]

**80. Monetization is the extension's job because the API cannot do it** — no `monetizationDetails` write exists for a single-channel creator. NOT verified against live Studio (stated in-file); every miss returns a reason that dumps what it actually found; a half-understood radio group REFUSES. (2026-08-23: monetization is now always-on; the three-valued store type became literal `true`.) [monetization.ts:1-38]

**81. Fill actions are a registry** — monetization (0.2.1) was one entry plus its `surface` field; title/A-B fills LAST because its modal covers the rest of the form; every filler verifies its own write. [fillers.ts:1-18]

**82. The shelf is persistent, not a per-video prompt** — always mounted, never auto-fills; "that human review step is what keeps this 'assisted data entry by the account owner' rather than automation." [shelf.ts:1-18]

**83. Shelf and nav-strip prefs get separate storage keys** — collapsed for different reasons; `chrome.storage.local` not session ("a placement choice that resets on every restart is not a preference"). [nav-strip-prefs.ts, shelf-prefs.ts]

**84. Collector: record-and-continue isolation, no fallbacks** — channel-list failure stops the cycle (never collects against a stale list); per-channel failures recorded and skipped; columns matched by `.metric.type` never index; the injected function closes over nothing so it can be pasted into a live console. [background.ts:15-18; collector.ts:1-35]

**85. Outbox: no retries-with-degradation** — a failed push stays queued as-is; removed only after a successful POST. [outbox.ts:1-6]

**86. Brand/non-primary channels 403 without the delegation ALSO in headers** (`X-YouTube-Delegation-Context`, `X-Goog-AuthUser`, clientName 62) — corrected by live end-to-end test. [STUDIO-COLLECTOR-SPEC.md]

**87. Settings deliberately minimal** — port only; the channel list is pulled live from the app, shown read-only. [settings.ts:1-12]

**88. `resultState` wire format** — `CREATOR_EXPERIMENT_RESULT_STATE_*`; batches of 50 ids (100 → HTTP 400). [catalogue.ts:11-22]

**89. The A/B exporter's operational lessons** — skip-back-catalogue off by default (1,383 of 1,561 videos would lack titles); tab bounced through a blank page every 20 videos to reclaim renderer memory; channels scanned sequentially (request rate triggers throttling); Shorts labelled by `contentType`, never duration (one channel has 33 long-form videos under three minutes). [ab-test-exporter/README.md]

### Build / infra

**90. `dist-build` is a real directory again** — the symlink workaround existed for exFAT xattr corruption (AppleDouble files breaking ASAR integrity and signing); the volume is APFS as of Aug 2026. [prepare-build-output.js:1-13]

**91. Two Electron shims, on purpose** — the real-userData shim answers with real paths (for scripts that run the real pipeline); the /tmp stub is for pure-function checks. It hard-fails on non-darwin. [scripts/_electron-shim-real-userdata.js]

**92. `generate-metadata-cli` drives the app's own entry points** — nothing reimplemented; three loud overrides incl. `--assets` (the app reads a startup-installed COPY of the prompt tree — repo edits are invisible until restart; the CLI prints the divergence) and a transcript cache (Whisper deletes its SRT the moment it parses it). [scripts/generate-metadata-cli.js:1-25]

**93. `validate-speaker-tagging.js` uses production code, not a copy** — "a validation harness with its own second implementation validates the harness." [scripts/validate-speaker-tagging.js]

**94. whisper.cpp over Python Whisper for bundling** — no Python, no VC++ runtime, prebuilt binaries, no build tools. [scripts/download-whisper-cpp.js]

**95. Per-field generation measured live 2026-08-22** — six calls, two model loads; num_ctx pinned per model per run. Prompt sizes on record: legacy single call 22,063 chars → three-call 36,378 → per-field 73,516. [prompt-artifacts/PERFIELD-timings.md]

**96. `prompt-harness/variants/` deleted** — a variant is now a copy of the prompt tree. [prompt-harness/README.md]

**158. `--claude-cli`: the test CLI's fourth loud override (operator, 2026-08-24: "until we get this right, set it to claude -p so I'm not burning through API use on tests; just sonnet for now").** Every Claude call in a CLI test run goes through `claude -p --model sonnet` — the Claude Code subscription, never the metered key — via ONE patch point (everything cloud funnels through `AIManagerService.makeClaudeRequest`; the chapter service's `cloudPlain` IS `runPlainRequest`). Always sonnet whatever the routing named; `initializeClaude`'s billed connection test is skipped; a failed spawn throws with stderr. A transport swap for tests, not a fallback. Verified end-to-end on f3 thumbnail-text. [scripts/generate-metadata-cli.js]

### Doc hygiene (staleness is itself a recorded state — see Part I §4 for the worklist)

**97.** `PROJECT_OVERVIEW.md` / `README.md` / `QUICKSTART.md` / `SETUP_STATUS.md`: unmodified since 2025-10-30, describe the pre-Angular "LaunchPad" app; declared non-authoritative; the rewrite is an unfinished Phase 0b task.
**98.** `BUNDLING.md` / `ASAR-LAYOUT.md` / `SCRIPTS-SUMMARY.md` / `scripts/README.md`: describe a Python-venv bundling world, reference five deleted scripts; stale and NOT flagged anywhere.
**99.** `extension/README.md` says the collector is an unbuilt scaffold with Bearer-token auth; both false since 2026-07-22.
**100.** `AB-TEST-PLAN.md` §4/§8 still calls the A/B loop "never written"; superseded by PR #13, correction lives only in TITLE-EVIDENCE-PLAN.md.
**101.** `TITLE-EVIDENCE-PLAN.md`'s first draft targeted the WRONG REPO (a year-old Python app at ~/Projects/ContentStudio) — discarded on the record, along with per-variant CTR as a goal (YouTube decides on watch time; `impressionsCtrPct` is video-level).
**102.** Intake discipline recorded: "taking another agent's file into the repo unread is how a stale premise becomes a repo fact."
