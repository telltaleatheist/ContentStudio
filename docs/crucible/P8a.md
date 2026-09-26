# P8a — chaptering at a chosen granularity, on snap (the pure service)

LEDGER #199, #205; CRUCIBLE-MIGRATION-PLAN.md §10, §16 P8. Built 2026-09-25 on branch
`worktree-agent-ac757e98b47e20b43` off `crucible` (a7c21a2). Nothing is wired into the pipeline
yet: that is P8b.

## What exists

`electron/services/metadata/chaptering/`, one entry point:

```ts
chapter(transcript, { granularity: 'detailed' | 'broad' | 'stories' | 'episodes', chat, decide,
                      promotedItems?, channelName?, videoTitle?, summarize?, titleThinking?,
                      detectAds?, switchCost?, countTokens?, signal?, onProgress?, diagnostics? })
  → { chapters: {number, startSec, endSec, unitRange, label, level, title, summary, isAd}[],
      outline, plugVerdicts, units, switchCost, stats, diagnostics? }
```

| file | what it does | source |
|---|---|---|
| `units.ts` | captions → sentence units, times by character fraction inside a caption (Law 6); `captionsOf` reads captions, `segments`, `contentItems[0].srtSegments` and the editor's word-level file (every word a caption, the track its speaker) | submap.py `sentences()`; Briefcase units.ts (speaker split, run-on cap) |
| `chunks.ts` | a transcript over ~12k tokens is cut into ≤9k-token cores with 1.5k of overlap each side; seams stitched | Briefcase chunks.ts |
| `outline.ts` | the outline call (the 9B, thinking off, temperature 0, ≤25 lines, deduped) | segment.py `outline()` |
| `assign.ts` | one decide `choice` per sentence quoting it and the one before; option names `section 1..n`; the declared floor for a label outside the top letters | segment.py `assign()`; Briefcase crucible-decide.ts |
| `viterbi.ts` | any-order items, flat switch cost | segment.py `viterbi()` |
| `plugs.ts` | ad runs confirmed by a yes/no, rejected runs re-segmented without the ad item | segment.py `confirm_plugs()` |
| `chapters.ts` | runs → chapters (first at 0:00), the level-2 children tiling a parent | Briefcase segmenter.ts / chapter-tree.ts |
| `summarize.ts` | `summarize_chapter` on the capable model (the 27B); a chapter over 6k tokens is read in parts and titled by `summarize_chapter_parts` | chapter-whole-transcript.service.ts |
| `granularity.ts` | the dial (below) | plan §0 #19 |
| `chaptering.service.ts` | the orchestration, progress weighted by work | — |

Transports are injected (`types.ts` `ChatFn`, `DecideFn`); nothing imports `electron/crucible/`.
Prompts are the `snap_*` keys and `summarize_chapter_parts` in
`electron/assets/prompts/shared/pipeline/chapters.yml`; PROMPT-LEARNINGS.md Part 5 says what each is.

## The granularity dial (Law 6 as amended)

The outline's items are the model's. How finely they are KEPT is the switch cost: Viterbi pays
it, in nats, each time the item changes between one sentence and the next, so a higher cost
keeps fewer, longer runs. The setting turns three things and nothing else:

| granularity | switch cost | outline body | level 2 | provenance |
|---|---|---|---|---|
| `detailed` | 20 | `snap_outline_detailed` (segment.py verbatim) | yes: a long section (>120 sentences or >15 min, ≥24 sentences) gets its own outline at cost 20 | measured, YTSeg F1@±1 0.72 |
| `broad` | 30 | `snap_outline_broad` | no | default, unmeasured |
| `stories` | 30 | `snap_outline_stories` | no | default, unmeasured |
| `episodes` | 45 | `snap_outline_episodes` (told the stretch's runtime) | no | default, unmeasured |

On a long transcript every level-1 chunk writes its own outline (≤25 items), so the options stay
≤26 letters and every state ≤12k tokens; the chunks are stitched where their overlaps agree.
No count is derived from duration anywhere.

## Checks

`npm run check:chaptering` (plain Node over the compiled main process; 42 checks). Beyond the
predecessor's: parity with segment.py/submap.py on fixtures their own functions wrote
(`docs/crucible/reference/make_fixtures.py` → `tools/fixtures/chaptering/`): 43 Viterbi matrices,
24 confirm-loop cases, 4 sentence cases including a real whisper slice. All match exactly.

## Harness

`tools/chaptering-run.js <transcript> --granularity <g> --fake|--live [--channel <id>]
[--title-thinking on|off] [--no-summarize] [--out x.json]`. Live: raw HTTP to Crucible, the
role's model loaded with a leased `load-model` job at 16,384 tokens, heartbeaten, released
before the other role's model loads; models, classes and version checked by name first.

## Live acceptance (Mac Crucible, owens-mac-studio)

Models: outline + decide `qwen3.5-9b` (bf16), titles `qwen3.8-27b-4bit`, both loaded at 16,384.
Both leases were released by the harness and the card cleared itself each time (Crucible's
unload ruling); `/v1/activity` showed nothing resident afterwards.

### 1 — Sean Duffy (10:08, whisper base, `youtube-telltale`), `detailed` — Crucible 1.0.34

| | |
|---|---|
| wall | 2,362 s: outline 6.8 s, assign 113 s (145 sentences, 0.78 s each), ad check 0.9 s, titles 2,228 s |
| sentences / chapters | 145 / 9 (one chunk, nothing refined: the video is under the level-2 threshold) |
| titles | thinking ON (the service default): 5 answered in 37–183 s; **4 ran out their 8,192 tokens after ~410 s each** and carry their outline label, warned |

```
 0:00  Sean Duffy's reality TV show and his daughter's Harvard attempt
 0:24  (untitled)  <- Critique of the "faith vs. information" argument
 3:22  (untitled)  <- Closing thoughts on the situation as a cult
 4:32  Promotion of God's People and a remarkable young girl
 5:03  (untitled)  <- Critique of the "faith vs. information" argument
 6:39  Trump's Harvard funding war and the free speech question
 7:37  (untitled)  <- Critique of conservative education environments
 8:22  Paloma's Harvard worry and the propaganda accusation
 9:10  The cult verdict and a Patreon plug
```

The production pipeline's list for the same video: 0:00 Harvard block, 4:32 book promo, 5:03
Harvard fear / Trump, 9:24 cult. Snap finds the 4:32 promo and the 5:03 turn to the second
before, and splits the two long stretches further.

**The ad item leans, as plan §0a warned.** Diagnostics (`--out`) show the ad option as the most
probable option for 40 of 145 sentences with the channel's promoted items named in it (median
P 0.16), and 72 of 145 with segment.py's verbatim item on a rerun (median P 0.39; the first
Viterbi pass put the whole video on "ad"). The yes/no rejected both spans (p 0.35, 0.03), so
the chapters come out right, but the real book promo was chaptered under the outline's own
"Promotion of the book" item and is NOT flagged `isAd`.

### 2 — the 2026-09-23 stream (3 h 26 min of timeline, word-level, mic t0 + screen t1), `youtube-unfiltered` — Crucible 1.0.35

1,990 sentence units from 30,422 words (word times, track = speaker). 5 chunks of ≤12k tokens
(token counts measured on the 9B), 2,596 sentence questions with the overlaps. Titles with
thinking OFF (declared). Owen's own record of this stream is `2026-09-23_edits.json`: five
stories (u1 AI 3:44–1:25:08, u2 Pokémon ch 9 1:25:18–1:44:43, u3 Pokémon ch 10 1:44:43–2:42:09,
f1 empathy 2:42:09–2:56:08, u4 Flashpoint 2:56:13–3:26:36) and one cut, 1:53:15–2:16:08.

#### `stories` (switch cost 30)

| | |
|---|---|
| wall | 3,408 s (57 min): outline 126 s (5 calls), assign 2,683 s (43 decisions, 1.03 s per question), ad 1.9 s, titles 525 s (31 chapters, ~12 s each, thinking off) |
| sentences / chapters | 1,990 / 31 |
| declared | 18 sentences floored (label outside the top letters); 1 chapter (28:15–1:05:16) titled from 2 parts; 4 titles came back without a summary; 1 ad span (5:56) rejected, p 0.01 |

```
    0:00  Gene Bailey hosts Flashpoint with Pastor Hank Kuhneman and Ryan Helfenbein
    3:10  Survey on AI versus pastors, and the Freedom Center's defense of biblical values
    7:28  Troy Miller on Meta's $18 billion settlement and corporate fiduciary duty
   28:15  Ryan Helfenbein warns AI's false empathy risks spiritual ruin for teens
 1:05:16  Survey shows 60% prefer AI for Bible questions, but only 7% trust it over pastors
 1:07:01  Pastors caution against forsaking fellowship for AI, citing flawed human data
 1:08:52  Host demonstrates AI's improved accuracy on genocide and Bonhoeffer, yet argues it remains inadequate for deep research
 1:15:38  Host argues AI cannot surpass God's image, citing a Singaporean scientist on mimicry
 1:23:34  Phil Arms' book claims Pokemon is a satanic assault on children
 1:27:03  Phil Arms compares Pokemon to Russian roulette and misattributes Digimon to Pokemon creators
 1:53:14  Boeing gifts Samaritan's Purse DC-8 to Liberty University aviation program
 1:54:52  Ryan argues Trump is calling chicken on Iran by delaying a deal until after the midterms
 1:58:33  Gene predicts midterms will trigger divine acceleration and cites Rubio on Iran's lunatic clerics
 2:01:24  FPTN launches new website and reports 35,000 letters for the midterms
 2:04:21  Trump and Zelensky meet on Ukraine war as Rubio proposes energy ceasefire
 2:08:18  Dutch and Pastor Hank pray for global realignment and the God factor
 2:13:36  Trump's 2026 economic revival and the God factor
 2:16:07  Phil Arms claims Pokemon and D&D train children in demonic violence and murder
 2:41:23  Charlie Kirk's claim that empathy is toxic and evil, rebutted
 2:45:28  Caller's defense of empathy for Renee Good and Alex Preddy, rebutted
 2:50:26  Ben Palmer's kindergarten teacher hotline and the streamer's verdict on MAGA evil
 2:54:32  Mormon cosmology and the Flashpoint video on cursed spirits
 2:56:34  Boeing gifts Samaritan's Purse DC-8 to Liberty University
 2:59:56  Trump's Iran deal timing and the midterms, with Ryan and Hank's verdicts
 3:06:15  Elijah's fire on the prophets of Baal as proof Hank Kunneman is a prophet
 3:08:40  Trump as prophetic figure in the Red Sea reset of the leftist agenda
 3:09:33  Iran's clerics lack self-awareness, making nuclear weapons a catastrophic threat
 3:11:30  FPTN News website launch and the rightnowamerica.org letter campaign
 3:15:05  Trump and Zelensky meet to end the war as Rubio proposes an energy ceasefire
 3:18:39  Trump blamed for gas price spike despite Biden-era reserves and Russian refinery strikes
 3:22:17  The God factor, global realignment, and the coming liberty to the earth
```

Against Owen's record (nearest snap boundary to each of his): u1 start 3:44 → 3:10 (34 s);
u1 end / u2 start 1:25:08–1:25:18 → 1:23:34 (~100 s); u2 end / u3 start 1:44:43 → none (both
sides are Phil Arms' Pokémon book, one chapter to the next: 512 s to the nearest); **the cut
1:53:15–2:16:08 → 1:53:14 and 2:16:07, to the second** (the host said "I'll be right back" and a
Flashpoint broadcast played on the screen track; snap chaptered it as six Flashpoint stories);
u3 end / f1 start 2:42:09 → 2:41:23 (46 s); f1 end / u4 start 2:56:08–2:56:13 → 2:56:34 (21 s).
Five of Owen's seven edges are within 60 s.

#### `episodes` (switch cost 45)

| | |
|---|---|
| wall | 3,062 s (51 min): outline 106 s, assign 2,415 s (42 decisions, 0.93 s per question), titles 469 s (27 chapters, thinking off) |
| sentences / chapters | 1,990 / 27 |
| declared | 1 chapter (1:23:34–1:53:14) titled from 2 parts; no sentence floored; no ad span |

```
    0:00  Gene Bailey hosts Flashpoint with Pastor Hank Kuhneman and Ryan Helfenbein
    3:10  Survey shows 7% trust AI bots over pastors, prompting a warning against replacing fellowship
    6:30  Troy Miller warns parents cannot outsource child safety to Meta
   18:28  Tobacco executives' congressional perjury parallels Meta's deceptive design
   28:23  Musk fine-tuned Grok to identify as Hitler, proving AI bias is engineered
   44:53  Catholic Church AI priest removed after granting invalid absolution
 1:04:57  Survey shows 60% prefer AI accuracy over pastors, but only 7% trust it
 1:08:52  Claude's nuanced genocide answers and Bonhoeffer correction show AI's improved but limited depth
 1:15:38  Imago Dei prevents AI from surpassing God's creation
 1:23:34  Phil Arms' book claims Pokemon is a satanic assault on children
 1:53:14  Boeing gifts Samaritan's Purse DC-8 to Liberty University aviation program
 1:54:52  Trump calls chicken on Iran over midterms; Rubio condemns lunatic clerics
 2:01:24  FPTN launches new website and reports 35,000 letters for midterm campaign
 2:04:21  Trump and Zelensky meet as Rubio proposes energy ceasefire
 2:08:25  Pastor Hank prays for global realignment and the God factor
 2:13:36  Phil Armstrong's 1998 book claims Pokemon and Harry Potter train children in demonism and murder.
 2:31:46  Armstrong argues Christian parents must brainwash children to counter Pokemon
 2:41:18  Evans' Napoleon book and the German church's fatal mistakes
 2:42:21  Renee Good and Alex Preddy deaths spark empathy debate
 2:54:32  Mormon cosmology: Elohim, celestial sex, and the heavenly council
 2:56:19  Boeing gifts Samaritan's Purse DC-8 to Liberty University
 2:59:56  Trump's Iran deal timing and the Strait of Hormuz hegemony claim
 3:06:15  Hank Kunneman's prophetic claim: Elijah, the Red Sea, and Trump
 3:09:36  Marco Rubio's lunatic clerics claim and the Iran nuclear threat
 3:11:36  FPTN website launch and the rightnowamerica.org letter campaign
 3:15:01  Trump and Zelensky meet as Rubio proposes energy ceasefire
 3:24:17  The God factor, global realignment, and the promise of liberty
```

Against Owen's record: u1 start 33 s; u1 end ~100 s; u2/u3 seam 512 s (not found); cut start
0 s, cut end 151 s; u3 end / f1 start 13 s; f1 end / u4 start 6–11 s. Five of seven edges
within 60 s, and the three episode seams it finds are tighter than at `stories`.

**`episodes` does not yet produce episodes.** 27 chapters where Owen made 5 (plus the cut).
Two causes, both visible in the run:

1. **Each chunk writes its own outline** (≈40 min of stream per chunk), and the 9B lists 7–13
   "episodes" per chunk whatever the body says, so the count is bounded below by the chunks, and
   switch cost 45 does not merge neighbours that are genuinely different sub-topics. An
   `episodes` grain needs a level ABOVE the chunks (an outline of the chunk outlines, or an
   outline over a condensed whole), which the plan's §10.2 "level 1 is broad" assumed would fit
   one state and on a 3.4 h stream does not.
2. **Chunk 5's outline ignored the plain-lines instruction** and answered in prose ("Analysis of
   the transcript reveals that…", "The stream flows as follows:"); the parser keeps every
   non-empty line, so prose sentences became options. Measured once; the outline parse has no
   shape check today (segment.py had none either).

Both runs: the 9B loaded at 16,384 in 7–8 s, the 27B in 6–7 s; the harness released each lease
at the phase end and the card cleared (Crucible's unload ruling), except once (stories' 27B),
which the harness unloaded itself since it had loaded it. `/v1/activity` afterwards: nothing
resident, no lease.

## Deviations from the plan

- **Transcript shapes.** The acceptance transcript for `detailed` came from
  `/Volumes/Callisto/ContentStudio/.contentstudio/cli-cache/` (the metadata test CLI's cache,
  whose entries carry the production chapter lists), not `~/Library/Application Support/
  contentstudio/`, which holds no job transcripts on this Mac.
- **Title thinking on the stream runs was OFF**, as a declared setting (`--title-thinking off`;
  the service logs it and puts it in the run's warnings). With it on, one 10-minute video took
  37 minutes of titles and lost 4 of 9; the stream's runs would have taken hours.
- **Long chapters are titled from parts** (`summarize_chapter_parts`, a new prompt): the plan
  did not say how a 90-minute episode gets a title under the ~16k call ceiling.
- **The ad option's text** is segment.py's verbatim for a channel with no promoted items, and
  names the channel's items otherwise (plan §10.2 step 2). Both lean (above).
- **`missingLabels`**: a label outside the top letters is floored under the declared rule
  (plan §0a, N7) and the sentence is listed in `stats.flooredUnits` and warned; a sentence whose
  answer has almost no weight on any letter is listed in `stats.skippedUnits` (no evidence;
  the switch cost places it). §16's "recorded as skipped (until N7)" predates N7.
- **Key prefixing**: the option names are segment.py's own `section 1..n` (Crucible shows the
  model `A. section 1: <label>`, so the name is part of the measured prompt) and question names
  `s<i>`; neither is integer-like, and an integer-like name is refused by name rather than
  prefixed.

## Open questions for Owen

1. **Titles: thinking on or off?** On the Mac's 27B-4bit, thinking-on titles took 37–412 s and
   4 of 9 ran out their 8,192 tokens with no answer; thinking-off titles took ~12 s each and all
   answered (8 of 58 came back without a summary line). The service keeps ON as its default until
   you rule.
2. **Episodes needs a level above the chunks** (see above). Proposed for P8b: an outline written
   over the chunk outlines (a few hundred tokens), used as the options for every chunk, so the
   whole stream is assigned against ONE list and Viterbi runs once over all of it.
3. **The ad option leans** (§0a's trap, measured on Duffy: 40–72 of 145 sentences). The yes/no
   catches it every time, but real plugs arrive as outline items ("Promotion of the book") and
   are not flagged `isAd`. Options: score the ad column against its own per-video median before
   Viterbi (Briefcase's flag fix), or put the ad option first rather than last and measure again.
4. **An outline answered in prose** was taken line by line as options. Should a non-list answer
   fail loudly (Law 1), or be read under a declared rule?
5. **Speaker tags in titles.** The stream's tracks are mic = host and screen = clip;
   `summarize_chapter_tagged` could get HOST/CLIP lines from them. Not wired: P8b's call.
