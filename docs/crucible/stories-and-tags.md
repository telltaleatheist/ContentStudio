# Stories on the chapters routing; tags without nomic

Two of Owen's rulings of 2026-09-25 (LEDGER #205), built ahead of the phases that would
otherwise have carried them (P8 for the Stories analyzer, P6 for key phrases). Both follow
#204: the routing table is the only thing that picks a model.

## 1. The editor's Stories analyzer runs on the chapters routing

**Before.** `story:analyze-chapters` and `story:suggest-title` ran on a model picked in the
editor window, from a dropdown of whatever Ollama had pulled (`ollama:list-models`), saved in
localStorage as `editor.ollamaModel.v2`, defaulting to `cogito:14b`. They went through
`ollama-service.ts`, a client of their own. It was the one model call in the app that the
routing table did not choose. Owen: "it should never call something i didnt expect it to call".

**Now.**

- The model is the **chapters** row of Settings → Routing. It is resolved on every call the
  same way `analyze-transcript-split` resolves it: `migrateStoredRouting` →
  `resolveMetadataRouting` → `resolveChapterModelOption` → `routedModelString`
  (`electron/services/editor/story-routing.ts`).
- Every call goes through `AIManagerService.runPlainRequest`. The manager is built the way
  `titles:generate-more` builds it, without `initialize()`, with the keys from
  `api-keys.json` and the prompt-sets directory. A `claude-cli:` selection goes to
  `claude -p`, and a local selection goes to Ollama through the same client and the same
  single-slot AI queue as a generation run.
- A stored selection this build cannot honour, or a malformed `metadataRouting`, is refused by
  name before any call. An absent store resolves to the shipped chapters default, as it does
  for every generation run (main.ts deliberately declares no store default).
- Progress events, Stop (it aborts the in-flight call and kills the `claude -p` child) and
  unload-on-finish all stay. The unload happens only for a local model; `claude -p` leaves
  nothing to release. `story:unload-model` no longer takes a payload: the main process
  remembers which local model the titling loop loaded.
- The picker, its refresh button, `ollama:list-models`, `ollama-service.ts` and the
  `editor.ollamaModel.v2` key are gone. Where the picker sat, a read-only line reads
  "Stories run on <label>, from Settings → Routing". If the routing cannot be resolved, it
  shows the refusal instead.
- The handlers live in `electron/services/editor/story-ipc.ts`, not in `editor-ipc.ts`, which
  imports the app entry and so cannot be loaded by the plain-Node checks.

**What it costs, chosen knowingly.** `chapter-splitter.ts` is many small calls: about 40 for a
12-minute video and about 390 for a 2-hour stream. On `claude -p`, each one is a separate
process launch. Owen chose this until P8 replaces the analyzer with snap chaptering at broad
grain. The splitter's pipeline and prompts are unchanged; only the transport changed.

**What the transport does not carry.** The splitter's per-call temperature 0,
`format: "json"`, `num_predict` and `num_ctx` are not forwarded, because `runPlainRequest`
sends provider defaults like every other routed call. Its parser reads the first JSON object
out of a plain answer either way. On a local route, `makeOllamaRequest` loads at a fixed
32768-token context. That equals the splitter's own ceiling, so no call gets less context
than before. The transport middle-truncates any prompt over about 98k characters, while the
splitter allows a chapter up to about 125k. A local story prompt over the transport's limit
is therefore refused by name (`StoryPromptTooLongError`). The refusal travels as the abort
signal's reason, because the splitter's `askJson` would otherwise turn it into "use the
opening words".

## 2. `nomic-embed-text` is removed, and tag pools come from the chapter list

**Before.** Both tag pools were measured from the transcript. Names came from `topEntities`.
Phrases were transcript n-grams ranked by embedding similarity on `nomic-embed-text` (one
Ollama `/api/embed` call per item), with a frequency ranking when the model was missing. The
top single words of that ranking became "category" tags.

**Now.**

- `key-phrases.ts`, `candidateKeyPhrases`, `KEY_PHRASE_EMBEDDING_MODEL`, the roster exclusion
  and the routing view's `keyPhraseModel` / `keyPhraseAvailability` are deleted. So is the
  dialog's "not installed, ranked by frequency" note.
- **A chaptered item** reads both pools off its chapter list (`tags-hashtags.ts`
  `chapterPools`):
  - The pools are the proper-noun runs and the two-to-four-word runs of content words in each
    chapter's title and detail.
  - Each entry is kept only if the transcript says it (`occursIn`; spec §6.2, since YouTube
    reads a tag the video never says as spam).
  - Where a shorter form sits inside a longer one, only the longer is kept.
  - The pools stay in chapter order, which is the order the list already carries. Nothing
    counts or scores.
  - The primary phrase is the first phrase of the first chapter.
  - Category terms are no longer offered. Picking a "broad" word by position would be a
    made-up ranking under the old name.
  - When the chapter list shares nothing with the transcript, the tags are empty and the
    run's warnings say so.
- **A chapterless item** keeps its names measured from the transcript and has no phrase pool.
  Its tags are written by the Tags routing row, which has been a visible row since #204. It
  gets no frequency list in place of the phrases (Law 1).
- The same pools feed the description's "Names:" / "Phrases:" lines and the hashtags. Because
  of that, a chaptered item's description now sees chapter-derived names instead of
  transcript-frequency names.

**On real items** (read-only, the five 2026-09-20 items, comparing shipped tags with the new
pools):

- **Gone:** junk such as "Nazi Germany God", "Morgan.com God", "he's talking" and "lies told".
- **New and on topic:** "trump's spiritual advisor", "venezuela oil", "systemic racism" and
  "seven supernatural blessings".
- **New noise:** "Former", "October", "be set free", "left side" and "looked away".
- On an 11-chapter podcast, the tags come mostly from the early chapters, because the order
  is chapter order and the 400-character budget runs out first.

## Checks

`npm run check:pure` (tools/routing-publish-checks.js) now covers the following:

- **Stories handlers.** It registers the real handlers against a recording `ipcMain`, with
  `runPlainRequest` replaced by a recorder. It asserts:
  - a claude -p selection;
  - a local selection, including the unload;
  - an absent store;
  - a refusal on an unknown or malformed routing, with no call made;
  - a stop mid-analysis;
  - the refusal of a local prompt that is too long.
- **Tag pools.** It asserts:
  - the chapter-derived pools, in order and grounded;
  - the tags a chaptered item publishes;
  - the declared empty pool;
  - the chapterless item's empty phrase pool;
  - that `KEY_PHRASE_EMBEDDING_MODEL` and the view fields are gone.
