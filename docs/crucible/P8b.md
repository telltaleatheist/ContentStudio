# P8b — snap chaptering wired into the pipeline, the editor's Stories and the in-queue split

LEDGER #199, #205, #208; CRUCIBLE-MIGRATION-PLAN.md §0 #7–#9, §0a, §10, §16 P8. Built 2026-09-25
on branch `worktree-agent-ab885627d485cedce` off `crucible` (4ba2580, with #208's 867f682 merged).

## What was built

| piece | files |
|---|---|
| two grains, `chapters` and `stories` (#208); the dial | `chaptering/granularity.ts` (`GRANULARITY`, `PIPELINE_DIAL`), `chapters.yml` (`snap_outline_chapters`, `snap_outline_stories`, `snap_outline_stories_merge`) |
| the stream-level outline | `chaptering.service.ts` `runLevel` (stream mode), `prompts.ts` `streamMerge` |
| a prose outline refused; an overflow warned | `chaptering/outline.ts` `proseLine`, `writeOutline` |
| the ad option's per-video baseline, core trimming, outline-named plugs, the 5:00/10:00 prior | `chaptering/plugs.ts` |
| thinking titles at 16,384; HOST/CLIP titles | `chaptering/summarize.ts`, `units.ts` `speakerRolesOf`, `chapter-transcript.ts` `speakerRoleOfId` |
| the wiring over the transport | `metadata/snap-chapters.ts` (`snapTransports`, `titleChat`, `toChapterPipelineResult`) |
| the scorer as a fixed role | `metadata-routing.ts` `CHAPTER_SCORER_MODEL`, `resolveSnapChapterModels`, the routing view's `scorerModel` |
| the pipeline's engine setting | `metadata-generator.service.ts` (`chapterEngine`, `chapterTitleThinking`), `ipc-handlers.ts`, `generate-metadata-cli.js` (`--chapter-engine`, `--title-thinking`) |
| Stories | `editor/story-ipc.ts` (rewritten), renderer `editor.component.ts` (grain, titles from chapters), preload/types |
| the in-queue split | `metadata/transcript-split.ts`, `ipc-handlers.ts` `analyze-transcript-split`, the dialog's progress bar |
| deleted | `editor/chapter-splitter.ts` (analyzer and inline prompts), `metadata/episode-splitter.service.ts`, `system.yml` `episode_split`, chapter-generator's sparse transcript / budget sampler / phrase matcher |
| the dev userData override | `electron/user-data-path.ts`, `main.ts`, `docs/crucible/README.md` |
| the chat door without undici's 300 s clocks | `crucible/client-factory.ts` `unclockedFetch` |
| X-Crucible-Sampling read | `transport.ts` `ChatResult.sampling`, `samplingOf` |
| decide at a stated load context | `transport.ts` `DecideRequest.loadContext` |
| keepers and harnesses | `tools/chaptering-checks.js` (51), `tools/routing-publish-checks.js` (P8b section), `tools/test-crucible-snap.js`, `tools/snap-live.js` |

## The rules, as built

**Roles (#199).** The outline and every decide question run on `CHAPTER_SCORER_MODEL`
(`qwen3.5-9b`), a fixed role in metadata-routing.ts, not a dialog row, loaded at 16,384 under the
job's lease. The titles run on the CHAPTERS row: a local 27B at 24,576 (a 6,000-token chapter
window + ~1,000 of body + the 16,384 thinking budget), or a cloud row through
`AIManagerService.runPlainRequest` (Anthropic through Crucible, or claude -p outside it). A snap run
whose scorer has no Crucible server is refused by name (`SnapScorerUnavailableError`) before any
call, whatever the chapters row is. Every local call takes its own lane step; the job's lease keeps
the model resident between them. The routing view reports the scorer beside the chapters row.

**The pipeline.** `chapterEngine: 'snap' | 'whole-transcript'` is read from the store at job time
(no store default); absent means snap, declared at one site (`generateChapters`) and logged.
Whole-transcript stays selectable until P10. The queue's per-run pick (#170: detailed / broad /
stories) is read as a setting of the dial: detailed = `chapters` at 20 (measured), broad =
`chapters` at 30, stories = `stories`. The result publishes in `ChapterPipelineResult`'s shape
(stats `engine: 'snap'` and a `snap` block), so promo exclusion, the chapter digest and the tag pools
read it unchanged; an ad arrives as a typed `isPromo` that promo exclusion honours; a chapter the
title call did not name publishes under its outline label (warned).

**Stories.** `story:analyze-chapters` takes a required `grain`: `stories` for the whole timeline
and the Split modal, `chapters` for one story's own list. Segments carry host/clip, so the titles
read HOST:/CLIP: lines. Times are rebased onto the span and back. Progress carries `fraction`
(weighted by work) and the renderer's bar reads it; Stop ends the run as a stop; the job's leases
are released however it ends. `story:suggest-title` takes the story's chapters and titles it with
`summarize_chapter_parts` (thinking on).

**The split.** `analyze-transcript-split` is the `stories` grain, boundaries only (labels are the
stream outline's items; no title call, so a cloud chapters row is never called), with a progress
bar in the dialog. The candidate menu keeps its shape (`index`, `startSeconds`, `endSeconds`,
`timestamp`, `label`, `verbalCue: false`, plus `isAd`).

**The stream-level outline (#208).** At `stories`, a transcript longer than one chunk: every chunk
writes its own outline, the 9B groups them into one list (`snap_outline_stories_merge`), every
chunk is assigned against it, only the units a chunk's core owns are asked (every sentence once:
1,976 questions on the stream where P8a asked 2,596), and one Viterbi pass covers the stream.

**Ads.** The ad option is read as its rise above its own median over the video (capped 0.5). A
confirmed ad-option run is trimmed to its core (the sentences where the ad option leads) and the
rest re-segmented. A run the outline named as an ordinary item, on which the ad option ranks first
or second for half its sentences, is asked the same yes/no in windows that each fit the 700-char
quote, and is a plug only if every window says so. The 5:00/10:00 prior (#208) lowers the bar to
P(yes) 0.25 for a stretch assigned to the ad item near those marks, at `chapters` only; it places
nothing and does not apply to outline-named candidates. Every verdict records its source, threshold,
kept core and windows.

**Thinking (#208).** Titles and summaries think, at a declared 16,384-token budget
(`titleThinking` default on; off is declared in the run's warnings). Outlines and the merge stay
thinking-off at temperature 0. A title that runs out its budget ships its outline label with a
warning. Crucible 1.0.38's `X-Crucible-Sampling` names `thinking` and `max_tokens` as `request`
(checked live and against the fake); a title call the server did not take as sent is warned.

**The dev userData override.** `CONTENTSTUDIO_USER_DATA`, honoured only when `app.isPackaged` is
false, absolute paths only, logged at boot (README.md).

## Checks (final tree)

`npm run build:all` exit 0. `check:pure` ALL PASS. `check:crucible` ALL PASS (20 keepers, new:
`test-crucible-snap.js`). `check:chaptering` all 51 passed. `check:reroll` all 19 passed.
`check:asr` ALL PASS.

## Live acceptance (Mac Crucible 1.0.38). Partial: stopped by the coordinator (card sharing, time)

### (a) Sean Duffy (10:08) through the real pipeline: ONE run, thinking on, on an earlier build

`scripts/generate-metadata-cli.js` on `p8b 1 - sean duffy.json` (a transcript-import copy of P2's
input), `--chapters --chapter-engine snap --grain detailed --route chapters=qwen38-27b`, run
2026-09-25 21:25 UTC while another agent shared the card. Code: 222709b (before core trimming,
windowed outline-item checks and #209 sizing). Logs: `scratchpad/p8b/a-snap-on-v1.log`,
`a-snap-on-v1.chapters.json`.

```
 0:00  Sean Duffy's cringy reality TV show and his daughter's Harvard bid
 0:26  Sean Duffy's Catholic Harvard fear, rebutted as Trump loyalty
 3:42  Sean Duffy's Harvard decision called a Jehovah's Witnesses-style cult   [ad, excluded]
 5:03  Sean Duffy's Paloma formation claim, reframed as Trump propaganda
 9:10  Host cannot imagine these people believe it, calls the poor girl's situation a cult   [ad, excluded]
```

- 145 sentences, one chunk, outline 13 items; ad baseline 0.388 (P8a's lean, measured); 8
  sentences floored.
- Ad verdicts: ad-option run 52-73 (3:42-5:03) p 0.71 at the prior's 0.25; outline-item "Closing
  thoughts … cult-like" 129-145 p 0.96. Both took in content (the promo is 4:32-5:03; the closing
  is a verdict and then a Patreon plug), so promo exclusion dropped 2 of 5 chapters. FIXED after
  this run (c4df161: a confirmed run keeps only its core; an outline-named plug must say yes in every
  700-char window; the prior applies to ad-option runs only). Not re-measured.
- **Titles, thinking ON at 16,384 (#208's measurement):** 38 s / 572 output tokens, 355 s / 7,084,
  270 s / 5,405, 510 s / 10,041, 431 s / 8,622. None ran out (P8a at 8,192: 4 of 9 did). Titles
  took 1,605 s of a 2,050 s chapter stage; assign 374 s (under contention). Thinking-OFF per-title
  time was not re-run: P8a measured ~12 s a title.
- The whole-transcript comparison and the thinking-off run were NOT run.

### (b) The 2026-09-23 stream at `stories`, the in-queue split path

`tools/snap-live.js split …` (wordsToSegments → splitCandidates), card to ourselves, d95f82d.
1,976 sentence questions (one per sentence), 1,499 s wall, 9B at 16,384. Stream outline (merged over
5 chunk outlines): 6 items. Ad baseline 0.028. Log `scratchpad/p8b/b-split-final.log`, result
`b-split.json`.

```
    0:00  AI as a Companion and Identity Tool
   47:13  Theological Implications of AI and Human Fellowship
 1:21:51  Christian Parenting and Brainwashing Tactics
 1:53:14  Global Realignment and the God Factor
 2:01:29  [ad] (FPTN website / letter campaign)
 2:04:21  Global Realignment and the God Factor
 2:15:37  Critique of Gaming and Immigrant Empathy
 2:31:46  Christian Parenting and Brainwashing Tactics
 2:40:26  Critique of Gaming and Immigrant Empathy
 2:54:32  Global Realignment and the God Factor
 3:11:38  [ad] (FPTN website / letter campaign, again)
 3:15:01  Global Realignment and the God Factor
```

Against Owen's edges: u1 start 3:44 → 2,609 s; u1/u2 1:25:08 → 197 s; u2/u3 1:44:42 → 512 s; cut
start 1:53:14 → **0 s**; cut end 2:16:08 → **30 s**; u3/f1 2:42:09 → 103 s; f1/u4 2:56:07 → 96 s.
**2 of 7 within 60 s**, worse than P8a's per-chunk stories run (5 of 7). 12 pieces where P8a had 31
and Owen 5 (+ the cut): the count came down, the edges got worse, and the merged outline has no
Pokémon story (u2/u3 fall under "Christian Parenting"). Owen ruled (#212): the merged outline is
dropped for stories. An earlier merge body had the 9B copy all 45 chunk items back (37 lines) and
the 25 cap drop the second half of the stream (fixed d95f82d, warned since). The grouping body is
unstable: 5-6 stories on the split's segments, 22 on the editor's (c).

### (c) Stories through the editor IPC (the real story-ipc handlers)

`tools/snap-live.js stories … --chapters qwen38-27b`. 1,953 editor sentences; stream outline 22
items; ad baseline 0.002; the outline-named "Flashpoint News Website and Letter Writing Campaign"
(sentences 1759-1821) confirmed a plug in every window (min p 0.62). Assign finished; the title phase
was STOPPED (coordinator, time: 22 stories at ~5-11 min per thinking title). Titles written before
the stop: 0:00-8:41 (5,847 output tokens), 8:41-18:27 (2,658), 18:27-24:45 (4,708), 24:45-1:23:50
part 1/3 (4,054). Boundaries past 1:23:50 were not logged (the handler returns them at the end):
**(c)'s edge score is not available; the remaining titles: not run (time).** Log
`scratchpad/p8b/c-stories.log`.

## Deviations

1. **`chapterGrain` per channel → the queue's existing per-run pick** (#170), read as a setting of
   the dial (`PIPELINE_DIAL`). #213 (after this build) collapses it to `chapters | stories`.
2. **The in-queue split is boundaries only** (labels = stream-outline items); no title call.
3. **`story:suggest-title` payload** is the story's chapters (`{name, chapters}`), titled with
   `summarize_chapter_parts`.
4. **chapter-splitter.ts was DELETED** (d409cdf). #212 (after) keeps it as the reference until the
   snap 45 s method matches it: restore with `git show 4ba2580:electron/services/editor/chapter-splitter.ts`.
5. **engineFetch no longer uses Node's fetch** (222709b): undici's 300 s body clock cut thinking
   titles on the Mac (its reasoning barely streams). Errors keep undici's shape; all keepers pass.
6. **Ad handling grew beyond the brief** (core trimming, windowed outline-item checks), from Duffy.
7. No Settings UI control for `chapterEngine` / `chapterTitleThinking`: store keys and CLI flags.

## Open questions for Owen

1. Thinking-on titles cost 4-9 minutes each on the Mac's 27B (5-10k thinking tokens); a 10-minute
   video's titles took 27 minutes. Keep 16,384, lower it, or thinking off for long runs?
2. On the PC the 27B loads at 16,384, so a thinking title (prompt + 16,384) is refused `over_context`
   there by name. Raise the PC's load, or titles thinking-off on the PC?
3. The 5:00/10:00 prior at odds 3 (P(yes) ≥ 0.25 near the marks, ad-option runs only): keep?
4. `chapterEngine` / title thinking as Settings controls, or store/CLI only?

## HANDOFF

**Branch** `worktree-agent-ab885627d485cedce` (node_modules symlinked to the main checkout's). Card
released: `/v1/activity` resident none, no lease.

**What shipped (commits, oldest first):**
- 423e8ad — two grains, stream-level merged outline, prose outline refused, ad baseline, 5:00/10:00 prior, outline-named plugs, thinking titles at 16,384, HOST/CLIP titles.
- a911c97 — `CONTENTSTUDIO_USER_DATA` dev override (`electron/user-data-path.ts`, `main.ts`, README.md).
- d409cdf — pipeline `chapterEngine`, fixed scorer role, Stories on snap, in-queue split on snap, chapter-splitter/episode-splitter deleted, keepers.
- 221311c — `tools/snap-live.js` live harness.
- 222709b — chat door without undici's clocks; outline-named plugs keep 0.5; progress weights.
- c4df161 — ad runs trimmed to their core; outline-named plugs read in windows.
- d95f82d — merge body groups items; outline overflow warned.
- 0d5a8b4 — merge of `crucible` (P9, #209-#211).
- 1f65853 — per-call load-context steps (#209).
- this doc.

**Verified live:** the pipeline snap path end to end on Duffy (one run, older build); the split path
end to end on the stream; the editor IPC path through assign and 4 titles; X-Crucible-Sampling on
1.0.38 names `thinking` and `max_tokens` as `request`. **Only by the checks:** core trimming, windowed
outline-item checks, #209 sizing, the whole-transcript engine under the switch, the claude -p titles
path, the renderer changes (built, never launched).

**Duffy comparison:** NOT run on the final code; only a-snap-on-v1 (above). Logs:
`/private/tmp/claude-501/-Volumes-Callisto-Projects-ContentStudio/0492e18e-5106-42dc-96fa-6be73f4a94b0/scratchpad/p8b/`.

**Known gaps / next:**
- #212: rebuild stories as chapter-splitter's 45 s junction method on snap (a yes/no per junction
  quoting both stretches, rank not threshold, over-segment, place at the sentence, consolidate pairs);
  drop the merged outline for stories; restore chapter-splitter.ts as the reference first.
- #213: inputs selector `chapters | stories` (detailed/broad migrate to chapters, logged); the
  editor's master-livestream split is always stories (drop `grain` from `story:analyze-chapters`).
- The Duffy three-way (snap on / snap off / whole-transcript) on the final code.
- The SDK's `decide` still uses Node's fetch: a decide slower than 300 s (seen under contention)
  dies with a Headers Timeout.
- The stories switch cost (45) is unmeasured.

**Reproduce (one at a time, the card to yourself):**
```sh
npm run build:electron
# (a)
node scripts/generate-metadata-cli.js --input "<duffy transcript-import json>" --channel youtube-telltale \
  --chapters --grain detailed --route chapters=qwen38-27b --chapter-engine snap --title-thinking on
#   (or --title-thinking off, or --chapter-engine whole-transcript)
# (b), (c)
node tools/snap-live.js split /Volumes/Callisto/Movies/FCPX/2026-09-20/files/2026-09-23/2026-09-23_transcript.json \
  --edits /Volumes/Callisto/Movies/FCPX/2026-09-20/files/2026-09-23/2026-09-23_edits.json --out b.json
node tools/snap-live.js stories <same transcript> --edits <same edits> --chapters qwen38-27b --out c.json
# an app launch, never on the real userData:
CONTENTSTUDIO_USER_DATA=/tmp/cs-agent-userdata npm start
```
The CLIs read the real registry and routing read-only, keep their own in-flight ledger, and release
their leases on Ctrl-C.
