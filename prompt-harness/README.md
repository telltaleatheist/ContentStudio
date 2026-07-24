# Prompt Harness

A fast, free rig for iterating on the metadata-generation **prompt wording**.

Instead of running the whole Electron app against a paid cloud model every time you
tweak a prompt, this sends a fixed test transcript + sample analytics data through
the **real** `AIManagerService` (so the assembled prompt is byte-identical to
production) to a **local** Ollama model — by default `cogito:32b`. You get titles
back in seconds, for free, and can A/B prompt variants side by side.

`cogito:32b` is **not** the final model. It's a cheap stand-in for rapid iteration.
Once a variant wins here, port its wording into the real prompt sets
(`electron/assets/youtube-*.yml` and `~/Library/Application Support/contentstudio/prompt_sets/`),
then confirm the win on the actual cloud model in the app.

## Prerequisites

```bash
npm run build:electron        # once, and after any change under electron/
ollama pull cogito:32b        # once (or use --model with a model you have)
```
Ollama must be running (`http://localhost:11434`).

## Run

```bash
node prompt-harness/run.js                    # all variants, cogito:32b, 1 run each
node prompt-harness/run.js --runs 3           # 3 runs per variant (check consistency)
node prompt-harness/run.js --variant baseline # one variant only
node prompt-harness/run.js --model ollama:cogito:14b   # smaller/faster while iterating
node prompt-harness/run.js --no-insights      # test without the analytics block
node prompt-harness/run.js --help
```

Titles print side by side; the full metadata (every field, every run) is saved to
`prompt-harness/out/run-<timestamp>.json`.

## How to iterate on a prompt

1. Copy a variant: `cp prompt-harness/variants/baseline.yml prompt-harness/variants/my-idea.yml`
2. Edit `my-idea.yml` (same schema as any real prompt set: `name`, `editorial_prompt`,
   `instructions_prompt`, `description_links`).
3. `node prompt-harness/run.js` and compare `my-idea` against `baseline`.
4. Keep the wording that produces more accurate titles; discard the rest.

## What's in the box

- `fixtures/transcript.example.txt` — a short test transcript built with deliberate
  **traps**: a jet-grift quote that belongs to the preacher (not the host), and a
  sarcastic line. A faithful prompt attributes the quote correctly and doesn't turn the
  sarcasm into a sincere claim; a shallow one misattributes or takes the mockery
  literally. This is the exact failure mode that made Sonnet's titles catchy-but-wrong.
- `fixtures/insights.example.txt` — sample `CHANNEL PERFORMANCE DATA` block, byte-format
  identical to what the live analytics loop injects.

> **Fixtures:** the harness reads `fixtures/transcript.txt` / `fixtures/insights.txt` if
> present, else the committed `*.example.txt`. Drop your **own** transcript or real channel
> analytics into the plain `.txt` names to test against real content — those are gitignored,
> so private data never lands in the repo.
- `variants/baseline.yml` — an exact copy of the current `youtube-telltale.yml` prompt.
- `variants/general-fidelity.yml` — baseline + one **general** fidelity principle
  (faithful to *who said what and what they meant*, not just the facts). A candidate fix
  for the misattribution problem, written as a general rule rather than a list of specific
  patches. Evaluate it here; keep or discard.

## Notes

- The harness calls `generateMetadata()` directly with the transcript as-is (no
  summarizer), which mirrors the **short-video** production path. Keep test transcripts
  short so you're testing the titling prompt, not the summarizer.
- Ollama temperature is fixed at 0.7 (same as production). Use `--runs N` to see how much
  a variant's output varies run to run.
- `out/` is gitignored.
