# P8c — stories by 45-second junctions on snap; chapters | stories on the inputs page

LEDGER #212, #213 (and #214, merged in). Built 2026-09-26 on branch `p8c-stories` off `crucible`
(cb646fc; `crucible` at 6b904b0 merged in for #214).

## What shipped, per commit

| commit | what |
|---|---|
| c596a2c | `docs/crucible/reference/chapter-splitter.ts`: the 4ba2580 analyzer restored verbatim under a read-only header. Outside the build (tsconfig includes `electron/` only); never called. |
| 43756ce | **The stories grain is the 45-second junction method** (`chaptering/stories.ts`), wired in `chaptering.service.ts` by method (`granularity.ts`: `chapters` = outline, `stories` = junctions). The merged stream outline, `snap_outline_stories`, `snap_outline_stories_merge`, `streamMerge` and stream-mode assign are deleted; chapters keep outline + assign + Viterbi at 20, unchanged. New prompts `snap_story_junction`, `snap_story_place`, `snap_story_pair`, `snap_story_pair_state`. `ChapteringStats.streamOutline` became `stories` (the method's own record). `splitCandidates` returns it. The pipeline pick is `chapters | stories` (`chapterPickOf`). `tools/snap-live.js --decide-cache` and a stories print. 5 new keepers, the old stories-grain keepers moved to `chapters`. |
| d6d416a | **#213**: inputs selector `Chapters (single videos)` (default) / `Stories (podcast compilations)`; stored/queued `detailed`/`broad` migrate to `chapters` with one console line (`frontend/.../chapter-pick.ts`), and a main-process `detailed`/`broad` reads as `chapters` with one log line (`metadata-generator` `resolveChapterPick`). `story:analyze-chapters` takes no grain and always splits into stories; a story's own chapter list moved to a new channel `story:chapter-story` (a payload naming a grain is refused by name). CLI `--grain chapters|stories`. |
| 41d512d | `tools/chaptering-run.js`: prints the stories stats; refuses `--fake --granularity stories` by name (its fake answers outline + assign only). |
| 8660775 | PROMPT-LEARNINGS Part 5: the stories keys. |
| 30109df | merge of `crucible` (#214). |
| 5482ea5 | the junction statement asks for "a completely different story" (run 2, below). |
| 2e2d050 | header comment. |

### The method as built (stories.ts)

1. **Stretches**: a stretch takes every sentence unit that starts within 45 s of its first unit's start, so each ends at a sentence end.
2. **Junctions**: one yes/no per junction, quoting the tail of the stretch before and the head of the stretch after (≤1,400 chars each), asked of the chunk state that holds it (the chaptering chunks, ≤12k tokens), 64 per request, on the 9B, thinking off (decide has no thinking). Statement: *"The stretch after it starts a completely different story from the stretch before it: the stream has finished with one subject and taken up an unrelated one, the way the next video in a playlist would start."* P(yes) is ranked, never thresholded; an answer under the label-mass gate is not ranked (warned).
3. **Select**: the reference's cadence table (2.2 / 3.5 / 5.6 / 6 min) sets `max(3, round(D/cadence)) − 1` cuts, taken in rank order with a minimum gap of 0.6 × cadence against every cut chosen (0:00 seeds it), ties farthest-first. On the 3.4 h stream: 33 cuts, gap 216 s.
4. **Place**: one choice per cut over the lines of its two stretches (`line 1..n`, each quoted; trimmed to the 26 nearest the junction when longer, logged). The cut is the chosen sentence's start. No evidence: the junction's own sentence, warned.
5. **Consolidate**: every adjacent pair asked "Part B carries on the same story as part A …" with A's tail and B's head (≤5,000 tokens each) as the state. The most probable merge is applied first and its two new neighbours re-asked, while P(yes) ≥ 0.5 (the model's own letter), down to the reference's floor of 3.
6. **Titles**: unchanged: the existing 27B thinking-on `summarize_chapter` path over each final story. A split candidate (no title call) is labelled with its opening line, quoted. **The stories grain runs no ad check** (declared in the code and here): a plug inside a story is a chapter of that story's own run.

Load context: junction and pair states take 16,384; placements 8,192 (the lease grows once, never shrinks mid-job).

## Checks (final tree)

`npm run build:all` exit 0 (the inputs.scss budget warning is pre-existing). `check:pure` ALL PASS. `check:crucible` ALL PASS (20 keepers). `check:chaptering` all 54 passed (new: stories pure functions; a fake stream end to end: junction quoting, placement to the sentence, consolidation to the true stories; titles on the existing path, the floor of 3, an unplaced cut warned; the queue pick and its migration; the two-method table). `check:reroll` all 20 passed. `check:asr` ALL PASS.

**Verified live**: the split path on the 2026-09-23 stream (4 runs, below); the pipeline on Duffy (3 runs, below). **By the checks only**: the editor's two channels and the renderer (built, never launched); the inputs selector and its migration; titles over stories (the stories runs were boundaries only, as briefed).

## Live: the 2026-09-23 stream, stories, boundaries only (Mac Crucible 1.0.38, card to ourselves)

`tools/snap-live.js split … --decide-cache` (in-queue split path; 1,976 sentences, 249 stretches, 248 junctions). Owen's 7 edges, nearest boundary:

| run | change | pieces | 3:44 u1 start | 1:25:08 u1/u2 | 1:44:42 u2/u3 | 1:53:14 cut | 2:16:08 cut end | 2:42:09 u3/f1 | 2:56:07 f1/u4 | ≤60 s | wall |
|---|---|---|---|---|---|---|---|---|---|---|---|
| P8b (merged outline) | — | 12 | 2,609 | 197 | 512 | 0 | 30 | 103 | 96 | 2/7 | 1,499 s |
| P8a (per-chunk outline) | — | 31 | 34 | ~100 | 512 | 0 | 0 | 46 | 21 | 5/7 | 3,408 s |
| 1 | junction: "on a new subject" | 14 | 132 | 78 | 512 | **0** | 106 | **46** | 96 | 2/7 | 836 s |
| **2 (shipped)** | junction: "a completely different story" | 12 | 132 | 86 | 512 | **0** | 151 | **46** | **9** | **3/7** | 794 s |
| 3 | + placement "closing remarks belong to the old subject" | 13 | 166 | 86 | 512 | 0 | 151 | 46 | 9 | 3/7 | 191 s (junctions cached) |
| 4 | run 2 with the junction state = the two stretches only | 15 | 132 | 78 | 393 | 90 | 151 | 46 | 9 | 2/7 | 832 s |

Runs 3 and 4 were reverted. Run 2's stories: `0:00 "We'll be right back." · 5:56 · 1:23:42 · 1:53:14 · 2:00:20 · 2:04:21 · 2:13:36 · 2:41:23 · 2:55:59 "All right, let's watch Flashpoint." · 3:11:06 · 3:15:01 · 3:24:17`. Stage times: junctions 324 s, placement 26 s, consolidation 443 s (77 pair questions). Junction P(yes): median 0.50, p90 0.75 (run 1: 0.59 / 0.80).

What the misses are, read from the transcript and the junction probabilities (logs `scratchpad/p8c/run{1..4}.{log,json}`):
- **3:44 u1 start**: by content nothing turns there (the Flashpoint AI survey runs on and Owen starts reacting, "We need to watch this"); P(yes) 0.27 at 3:06/4:03. The 5:56 cut is a Twitch glitch the model took as a new subject.
- **1:25:08 u1/u2**: the host wraps the AI story and sets up the Pokémon book from 1:23:42 ("tell me what you think about it in the comments … i would to finish the pokemon book"); Owen's edge is where the reading starts. Run 3's placement wording did not move it.
- **1:44:42 u2/u3** (Pokémon book ch 9 → ch 10): found as a junction (1:44:28, P 0.80, placed 1:45:10, 28 s off) and then **merged** by consolidation (P(same) 0.96): both are the same book. Every snap run has missed this seam.
- **2:16:08 cut end** ("Let's continue Pokemon."): the turn sits mid-stretch, so it splits over two junctions (0.68, 0.62), and both fall inside the **216 s minimum gap** of 2:13:19 (P 0.92, a Flashpoint item change). The gap is the reference's.
- The cut 1:53:14–2:16:08 (a Flashpoint broadcast) comes out as 4 stories (its news items), and u4 (Flashpoint, 2:56–end) as 4: different stories by content.

## Live: Sean Duffy (10:08) three-way, one at a time on the card

`scripts/generate-metadata-cli.js --chapters --grain chapters --route chapters=qwen38-27b` on
`p8b 1 - sean duffy.json`, final code, the card to ourselves for each. Logs `scratchpad/p8c/duffy-{a,b,c}.log`
(A's first attempt: `duffy-snap-on.attempt1.log`). Tokens are the chat calls' own `in / out` lines; snap's
decide calls report none.

| | A: snap, titles thinking ON | B: snap, titles thinking OFF | C: whole-transcript |
|---|---|---|---|
| result | **did not finish (twice)**: see below | 7 chapters | 7 chapters |
| wall | stopped at 1,265 s (attempt 2) | **214 s** | 1,111 s |
| chat calls, tokens in / out | outline 2,234 / 98; title 1: 785 / 641; title 2 never answered | 8 calls, 10,038 / 629 | 13 calls, 22,591 / 21,312 (5 samples + name list + 7 thinking details) |
| decide calls | as B | 5 (145 sentences at 64 per call, plus ad checks) | 0 |

```
B: snap, thinking off                                              C: whole-transcript
 0:00 Sean Duffy's reality TV show and his daughter's Harvard ambitions      0:00 Sean Duffy's Harvard University veto, called cultish
 0:24 Sean Duffy claims Harvard corrupts his daughter's Catholic faith       4:32 Sean Duffy says Harvard University professionalized to take good young girls and corrupt their minds
 3:42 Host compares Duffy's Harvard ban to Jehovah's Witness cult control [ad]  5:15 Sean Duffy blocks Harvard University to impose his political beliefs
 5:21 Host argues Harvard is not far left and Duffy's ban is cult-like control 5:58 Host says only people who love Donald Trump call Harvard University far left
 7:37 Host mocks Duffy's claim that Harvard perverts students into not hunting immigrants  7:21 Host says Sean Duffy and Donald Trump lack principles, not Harvard University
 8:22 Host mocks Duffy's fear of Harvard undermining his daughter's faith     8:22 Host calls the Harvard University situation a cult and worries for Paloma
 9:25 Host calls Sean Duffy's Harvard ban a cult and asks for Patreon support [ad]  9:36 Patreon plug [ad]
```

A's boundaries are B's (the decide calls are temperature-free and identical; its title calls read `0:00-0:24`, `0:24-3:42`, …). `[ad]` = excluded by promo exclusion: B's snap ad check flagged 3:42–5:21 (the real book promo is 4:32–5:03) and 9:25–end; C's whole-transcript placed a chapter at 4:32 (the promo's start) and titled it as content, and flagged only the 9:36 Patreon plug. C dropped 3 of its candidates for an unmeasurable opening sentence (its own warning).

**Why A did not finish: the Mac's 27B engine thread dies with `RuntimeError: [metal::malloc] Resource limit (499000) exceeded`** (`~/.crucible/logs/engine-qwen3.8-27b-4bit.log`) during the thinking-on title of chapter 2 (0:24–3:42, 1,582-token prompt), both attempts (23:07 local on the retry, 22:44 on the first). The request then hangs: Crucible keeps the chat "in flight", and the app's 10-minute stall clock did not fire (the stream's frames keep beating it; a thinking title streams little else). I stopped each attempt by SIGINT after ~17-20 minutes of silence; the leases were released and the card cleared. Earlier occurrences of the same error in that log are at 21:14. This is an engine fault on the Mac (no Crucible config was changed); P8b's thinking-on run of the same video (older boundaries: 0:26–3:42) finished that chapter in 355 s / 7,084 tokens.

## Deviations

1. **`story:chapter-story`** is a new channel: #213 drops the grain from `story:analyze-chapters`, and the editor's run 2 (a story's own chapter list) still needs the chapters grain, so the channel is the grain.
2. **Stories have no ad check** (the old stream-outline path had one). Declared above.
3. **A split candidate's label** is its opening line, quoted (no outline names a story any more).
4. **The whole-transcript engine reads `chapters` as its old `detailed`** (snap's chapters grain is the old detailed at 20). It leaves in P10.
5. `tools/snap-live.js --decide-cache` memoises decide answers by request text (measurement only).
6. Law 6 says no count derived from duration; the stories grain's over-segmentation count is the reference's duration cadence, as #212 and the brief direct. Consolidation, not the count, sets how many stories stay.

## Open questions for Owen

1. Stories scored 3/7 within 60 s (P8a's per-chunk outline: 5/7). The two structural misses are the **minimum gap** (216 s on a stream blocked the 2:16 return from Flashpoint) and **consolidation merging two chapters of the same book** (u2/u3). Try a smaller gap, or finer junctions (a junction every ~22 s instead of every stretch), both departures from the reference?
2. Is a Flashpoint broadcast one story (your cut) or one per news item (what the model finds)?
3. The stories grain runs no ad check. Wanted for podcast compilations?
4. `detailed`/`broad` both became `chapters` at the measured switch cost 20 (the old `broad` was 30). Keep 20 for every single video, including hour-long Unfiltered?

5. The Mac's 27B dies (`metal::malloc Resource limit`) on a thinking-on title of Duffy's chapter 2, twice, and the call then hangs with no end. It is a Crucible/mlx-lm matter (not changed here). Should the app's stall clock count only generated tokens rather than any stream frame, knowing a thinking title's reasoning barely streams on the Mac?

## HANDOFF

**Branch** `p8c-stories` (worktree `agent-a69c4bd1f7c1cdf71`; `node_modules` and `frontend/node_modules` are symlinks to the main checkout's, untracked). Not merged to `crucible`. Card released: `/v1/activity` resident none, no lease, nothing in flight.

**Shipped:** the commits in the table at the top, plus this doc, the README index and LEDGER #215.

**Verified live:** stories on the 2026-09-23 stream through the in-queue split path (4 runs; run 2's config shipped, 3 of 7 within 60 s); the metadata pipeline's snap chapters on Duffy with titles thinking off (B) and the whole-transcript engine (C). **Not verified live:** A (snap, thinking on) never finished (engine fault above); titles over stories; the editor's `story:analyze-chapters` / `story:chapter-story` and the inputs selector (built and checked, never launched).

**Known gaps / next:**
- Stories at 3/7: the minimum gap and consolidation of same-book chapters (question 1); the u1 start is a speaker change, not a subject change, and snap reads no speaker.
- The Mac 27B malloc crash and the stall clock that a dead engine does not trip (question 5). Thinking-on Duffy (A) is owed once the engine is sound.
- SDK `decide` still on Node fetch (300 s headers timeout): did not bite in P8c (no decide was slower than ~10 s).
- `tools/chaptering-run.js --fake` answers the chapters grain only (refused by name for stories).

**Reproduce (one at a time, the card to yourself; `npm run build:electron` first):**
```sh
# stories, boundaries only (the in-queue split path); --decide-cache reuses answers between runs
node tools/snap-live.js split /Volumes/Callisto/Movies/FCPX/2026-09-20/files/2026-09-23/2026-09-23_transcript.json \
  --edits /Volumes/Callisto/Movies/FCPX/2026-09-20/files/2026-09-23/2026-09-23_edits.json --decide-cache cache.json --out r.json
# stories through the editor's handler, with titles (27B thinking on; ~5-10 min a title)
node tools/snap-live.js stories <same transcript> --edits <same edits> --chapters qwen38-27b --out c.json
# Duffy
node scripts/generate-metadata-cli.js --input "<scratchpad>/p8b/p8b 1 - sean duffy.json" --channel youtube-telltale \
  --chapters --grain chapters --route chapters=qwen38-27b --chapter-engine snap --title-thinking on   # or off; or --chapter-engine whole-transcript
# an app launch, never on the real userData:
CONTENTSTUDIO_USER_DATA=/tmp/cs-agent-userdata npm start
```
