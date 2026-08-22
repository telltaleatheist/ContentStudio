# Per-field run: what each call costs, and what came back

A LIVE run of the shipped pipeline against local Ollama on the Mac Studio, 2026-08-22, on the
commit that makes metadata generation **one model call per field**.

Driven by `prompt-harness/run.js` — which drives the real compiled services
(`AIManagerService`, `planMetadataUnits`, the units' own `generate`), so the bytes sent are the
bytes production sends.

```
node prompt-harness/run.js --runs 1   # process A
node prompt-harness/run.js --runs 2   # process B
```

| | |
| --- | --- |
| channel | `youtube-telltale` |
| assets | `electron/assets/prompts` (this commit's, not the installed copy) |
| fixture | `prompt-harness/fixtures/transcript.example.txt`, 1,083 chars, **direct-passed raw** |
| routing | the shipped defaults, `resolveMetadataRouting(undefined)` |
| chapters | none — the TEXT-SUBJECT path, so the tags are written by a model rather than assembled |

Plan, as logged:

```
titles → thumbnail_text → pinned_comment → clip_suggestions   (qwen3.8:27b)
tags → description hook + body                                (qwen3.5:9b)
hashtags                                                      (code, no call)
```

Two models, `overBudget: false`. Titles first, because the thumbnail call is handed them.

## One num_ctx per model per run

```
"qwen3.8:27b": num_ctx pinned at 16384 for this whole run, shared by 4 call(s) —
  titles 12708t, thumbnail_text 12717t, pinned_comment 11747t, clip_suggestions 11923t
"qwen3.5:9b":  num_ctx pinned at 12288 for this whole run, shared by 2 call(s) —
  tags 11765t, description 4839t
```

Each pin is the largest call on that model, bucketed. Six calls, two model loads.

## Per-call timings

One row per field call. A1 is process A's only run; B1 and B2 are process B's two runs, so B1
pays the 27B's cold load and B2 does not.

| call | model | A1 | B1 | B2 |
| --- | --- | ---: | ---: | ---: |
| `titles` | qwen3.8:27b | 47.2s | 43.8s | 49.2s |
| `thumbnail_text` | qwen3.8:27b | 24.2s | 25.0s | 25.6s |
| `pinned_comment` | qwen3.8:27b | 15.1s | 15.5s | 19.8s |
| `clip_suggestions` | qwen3.8:27b | 21.2s | 14.2s | 19.3s |
| `tags` | qwen3.5:9b | 10.4s | 9.7s | 11.4s |
| `description` hook + body | qwen3.5:9b | 5.2s | 8.2s | 7.8s |
| **total** | | **123.3s** | **116.4s** | **133.1s** |

Three things the table says.

**The titles call is half the run and it is not the model load.** B2 ran with the 27B already
resident and still cost 49.2s — the slowest of the three. Titles are simply the biggest ask:
ten distinct angles, and the only call carrying the CHANNEL PERFORMANCE DATA block.

**Residence works.** Four consecutive 27B calls, then two consecutive 9B calls. The second 27B
call (`thumbnail_text`) lands at 24-26s in all three runs with no reload spike, and the second
9B call is the cheapest in the run. Nothing evicts anything.

**Six calls cost about two minutes.** The grouped call this replaces ran 76-83s for four
fields (`AFTER-titles.json`). Per-field is roughly 50% more wall clock for six fields written
in their own voice, one pinned context each.

## What came back

Full outputs: **`PERFIELD-samples.json`**. Assembled prompts: **`PERFIELD-assembled-prompts.txt`**
(73,516 chars over six prompts — 15,906 for titles down to 4,997 for the description).

### The cross-field rule is delivered, and partly obeyed

The thumbnail call receives the ten titles as input data and carries
`Thumbnail options don't repeat core words from the top 3 titles given above`. Measured against
what came back:

| run | options reusing a top-3 core word | which |
| --- | --- | --- |
| A1 | 4 / 10 | FOURTH JET, ROB GOD?, DEMON TROLLS, YOUR MONEY |
| B1 | 4 / 10 | FOURTH JET, ROBBING GOD, SATAN'S TROLL, JET TAIL |
| B2 | 3 / 10 | FOURTH JET, ROBBING GOD, DEMON TROLL |

So the mechanism works — the titles reach the call, and 6-7 of 10 options are genuinely
different words — but the 27B leads with `FOURTH JET` every single time regardless. **This is a
prompt-wording question for review, not a plumbing failure.** Before this branch the rule could
not even be checked, because one call wrote both fields from one draft.

### A declared degradation, declared exactly once

Run A1:

```
! the description body was asked for twice and both times it ran to 27 words against the
  150-300 word body; it is kept exactly as the model wrote it and nothing was reworded
```

B1 and B2 produced full-length bodies with no warning. So the short body is the 9B missing, not
the prompt being wrong — and the run reported it, kept the model's words, and padded nothing.
That is the no-fallbacks rule doing its job on a live run.

### Title grounding fires on real things

`ungroundedTitles` flagged `Twelve-Seat Plane` (A1 — transcript says "seats twelve"),
`Zero Accountability` (B1) and three fragments in B2. All reported, all kept.

## Two things to know before reading the samples

**`hashtags` reads `undefined` in every run.** Hashtags and chaptered tags are assembled inside
`runMetadataTasks()`, and the harness calls each unit's `generate` directly so it can time them
separately. That is a harness limitation, not a pipeline result; `tools/routing-publish-checks.js`
covers the code-owned fields.

**Model-written tags came back unseparated in 2 of 3 runs.** A1 returned proper
comma-separated tags; B1 and B2 returned one space-joined string
(`"Marcus Wray fourth jet televangelist hypocrisy prosperity gospel scam ..."`). This is the
**non-chaptered** path only — a real item with chapters has its tags assembled in code from the
entity and key-phrase pools and never asks a model at all. Flagged here for review rather than
patched, since the fix is a prompt or a parser decision.

**The fixture is short.** 1,083 characters exercises the direct-pass path but not its ceiling.
The 89k-passes / 91k-condenses thresholds are asserted in `tools/routing-publish-checks.js`.
