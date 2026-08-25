# Prompt-tuning harness

The loop that tests the production prompts against Haiku, Sonnet, and Opus **without
billing the API** — model calls run as Claude Code subagents. First cycle ran 2026-08-23
(24 arms, zero factual failures; it caught the register judge contradicting the rules'
own closing-sentence requirement, fixed in 0ef1ce8). LEDGER.md §1 names this the current
focus.

## The loop

**1. Build the current prompts** (no model calls, no API):

    npm run build:electron        # the builder loads the compiled prompt assets
    node tools/prompt-tune/build-prompts.js [--grain detailed|broad|stories]

For each corpus video this emits, under `tools/prompt-tune/out/prompts/`:
`<key>--chapters-stage1.txt` (answer: one verbatim opening sentence per line; stage 1 has
three grain bodies since 2026-08-24, so `--grain` names the one this cycle tests — `detailed`
by default, as in the app — and the manifest records which),
`<key>--description-candidate.txt` (answer: hook, blank line, body — one call per candidate
since the 2026-08-24 plain-text refactor), `<key>--titles-group-STALE.txt`, plus
`<key>--REFERENCE.json` (the real production run's outputs, for comparison).

The trick that keeps it honest: the *inputs* (rendered transcript, chapter coverage,
pools, the recorded hook) are extracted from a real run's `_prompt_trace`, and the
*templates and rules* are re-assembled from `electron/assets/prompts/` as it exists right
now, through the production loader (`fieldSection`, `CHAPTER_PROMPTS`). Edit a prompt
asset, re-run the builder, and the emitted prompt is exactly what the app would send
after a restart. The titles prompt is the one exception — it is the traced prompt as-is
(its assembly spans metadata-tasks; refreshing it is follow-up work), hence `-STALE`.

**2. Fan out** (a Claude Code session procedure, not a script — that is what keeps it
off the API bill): for each prompt file × each model (haiku, sonnet, opus), launch a
subagent with model override and this instruction shape:

> You are simulating one raw Anthropic API call. Read <prompt file> — its entire contents
> are the user prompt you received. Produce the completion exactly as it demands (plain
> text in the prompt's stated shape). No tools besides Read/Write, no commentary, no
> fences. Write the raw completion to
> tools/prompt-tune/out/outputs/<key>--<stage>--<model>.json and reply: done

Local models use the same prompt files directly:
`ollama run qwen3.8:27b < out/prompts/<file>` (ask the operator first — GPU rule).

**3. Score:**

    python3 tools/prompt-tune/score.py

Hard checks per stage: chapter boundary quotes must map verbatim into the transcript
(plain lines now — no labels; stage 2 owns every title), quote length, example-name
leaks; the description candidate's hook length and terminal punctuation, body word
range, narrator subjects, promo mentions, links; titles count, sentence case, and the
A/B losing traits (colons, questions, digits). Then eyeball the outputs against
`--REFERENCE.json` — the hard checks catch what is *wrong*, not what is *flat*.

**4. Tune → repeat.** A weak spot on Haiku is the canary: a prompt that holds on Haiku
is robust, and it measures how close the local-model aspiration is (LEDGER §1, standing
constraints).

## Corpus

`corpus.json` — entries point at real job JSONs (under the output directory's
`.contentstudio/metadata/`) whose items carry `_prompt_trace`. To add a video: run it
once through the app on any cloud routing, then add `{key, job}` here. Prefer videos
with verified ground truth (names checked against sources) — see
`/Volumes/Callisto/ContentStudio/f2 - braeden sorbo/model-comparison-2026-08-23.md` for
the method.

## Files

- `build-prompts.js` — extract-and-refill builder (`_noop-shim.js` lets the dist modules
  load outside Electron)
- `score.py` — the hard checks and grid
- `corpus.json` — operator-edited corpus
- `out/` — gitignored; prompts and model outputs per cycle
