# Prompt Harness

A fast, free rig for iterating on the metadata **prompt wording**.

Instead of running the whole Electron app against a paid cloud model every time you tweak a
prompt, this drives the **real** compiled services — `AIManagerService`, `planMetadataUnits`,
`runMetadataTasks` — against local Ollama. The prompts it prints are byte-identical to the ones
production sends, because they are assembled by the same code.

## What changed

This used to call `generateMetadata()`, which was the **legacy single whole-metadata call**, and
its "variants" were whole per-channel YAML prompt sets in `prompt-harness/variants/`. Neither
exists any more:

- every field is written by a routed **unit** (`metadata-tasks.ts`), and
- a channel is a small **data** file inside one shared prompt tree
  (`electron/assets/prompts/`).

So the harness takes an **assets root** and a **channel**, plans the same units a real run
plans, and prints the same prompts a real run sends. `prompt-harness/variants/` is gone; a
variant is now a copy of the prompt tree.

## Prerequisites

```bash
npm run build:electron        # once, and after any change under electron/
ollama pull qwen3.8:27b       # the shipped default for the packaging fields
ollama pull qwen3.5:9b        # the shipped default for the description and tags
```

Ollama must be running (`http://localhost:11434`). `--units none` needs neither model — it
assembles the prompts and sends nothing.

## Run

```bash
node prompt-harness/run.js                                  # plan, print, run every unit once
node prompt-harness/run.js --units none --prompts out.txt   # assemble only; write the prompts
node prompt-harness/run.js --units titles --runs 3          # just the packaging call, 3 times
node prompt-harness/run.js --channel youtube-unfiltered     # a different channel
node prompt-harness/run.js --no-insights                    # without the analytics block
node prompt-harness/run.js --help
```

Titles print with their character counts. The full output — every assembled prompt, every
field, every run, plus any declared warnings — is saved to `prompt-harness/out/`.

## A/B'ing a prompt change

A variant is a **directory copy** now, which is the honest shape: the thing under test might be
one field's instruction block, the shared editorial core, or a channel's own data.

```bash
cp -R electron/assets/prompts /tmp/prompts-idea
$EDITOR /tmp/prompts-idea/shared/fields/titles.yml

node prompt-harness/run.js --assets electron/assets/prompts --units titles --runs 3 \
  --out before.json --prompts before-prompt.txt
node prompt-harness/run.js --assets /tmp/prompts-idea      --units titles --runs 3 \
  --out after.json  --prompts after-prompt.txt

diff before-prompt.txt after-prompt.txt
```

Keep the wording that produces more accurate titles; discard the rest. Then port the winner
into `electron/assets/prompts/` — the app installs it into
`~/Library/Application Support/contentstudio/prompt_sets/prompts/` on next start, and refuses to
overwrite a file you have edited there.

## What's in the box

- `fixtures/transcript.example.txt` — a short test transcript built with deliberate **traps**: a
  jet-grift quote that belongs to the preacher (not the host), and a sarcastic line. A faithful
  prompt attributes the quote correctly and doesn't turn the sarcasm into a sincere claim; a
  shallow one misattributes or takes the mockery literally.
- `fixtures/insights.example.txt` — a sample `CHANNEL PERFORMANCE DATA` block, byte-format
  identical to what the live analytics loop injects.

> **Fixtures:** the harness reads `fixtures/transcript.txt` / `fixtures/insights.txt` if present,
> else the committed `*.example.txt`. Drop your **own** transcript or real channel analytics into
> the plain `.txt` names to test against real content — those are gitignored, so private data
> never lands in the repo.

## Notes

- **No chapters, deliberately.** The fixture is a raw transcript with no timings, so this
  exercises the **text-subject** path — the one that used to fall through to the legacy
  whole-metadata call and now plans routed units like everything else. That also means its tags
  are written by a model rather than assembled from pools, and the run says so.
- The **grounding check** runs here exactly as it runs in the app: any title naming a proper
  noun the inputs do not contain is reported under `ungrounded`. The harness reports it and
  moves on — it never drops or rewrites a title, and neither does production.
- Sampling matches production (temperature 0.7, no pinned seed). Use `--runs N` to see how much
  a variant varies run to run.
- `out/` is gitignored.
