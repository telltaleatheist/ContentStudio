# Moving all of ContentStudio's AI onto Crucible: the implementation plan

Written 2026-09-23 on branch `stream-marks` (`76a9d8e`), against Crucible 1.0.23 (`b95ac38`, the
release the Mac runs as a launchd service), Crucible's unreleased `origin/feat/decide-door`
(`5d3dbdf`, `docs/PHASE22-DECIDE.md`), BookForge (SDK 1.0.22 vendored) and Briefcase's plan and
code (`feat/crucible`, `feat/snap-scorer`). It is for the agents who implement it one phase at a
time. Every phase leaves the app shippable. Nothing in this plan has been run on a GPU.

Path shorthand: **CS** = `/Volumes/Callisto/Projects/ContentStudio`, **C** =
`/Volumes/Callisto/Projects/crucible`, **BF** = `/Volumes/Callisto/Projects/BookForgeApp`,
**BC** = `/Volumes/Callisto/Projects/Briefcase-worktrees/crucible`. `M/` =
`CS/electron/services/metadata/`, `E/` = `CS/electron/services/editor/`, `IPC` =
`CS/electron/ipc/ipc-handlers.ts`. Line numbers were read on 2026-09-23. They drift, so grep
for the symbol rather than trusting the number.

Read first: C `docs/INTEGRATING-AN-APP.md` (the order and the gotchas), BC
`docs/crucible-migration-plan.md` (the sibling plan this one copies its shape from), and
`CS/LEDGER.md` §2 (the laws this plan is held to). **Then §0a below**: what Briefcase learned
finishing the same migration (2026-09-24), and which facts in this plan Crucible has moved past
since it was written (1.0.23 → 1.0.32).

---

## 0. The decisions, in one table

**S** = settled by Owen (2026-09-23). **D** = a default Owen can overrule.

| # | Question | Decision | |
|---|---|---|---|
| 1 | What goes through Crucible? | **Every AI call**: the Anthropic SDK (`claude:`), `ollama:`, `openai:`, `askOllamaPlain`, the editor's `ollama-service.ts`, whisper.cpp (pipeline and editor), and editor voice isolation. There is one server per machine at `:7100`, the same as BookForge, Foundry and Briefcase. | S |
| 2 | `claude -p` | **Stays outside Crucible.** It is a test value that isn't used consistently. `claude-cli:` stays in `AIManagerService.makeRequest` (M/ai-manager.service.ts:1739), in the routing table (M/metadata-routing.ts:141,147), and in the test CLI's `--claude-cli`. It takes no GPU lane. | S |
| 3 | Cloud Claude | Cloud models become Crucible upstream ids, `anthropic/<id>`. API keys move out of `userData/api-keys.json` into Crucible server settings (`PUT /v1/settings`), and the app stops holding keys. No temperature or other sampling parameter is ever sent to a cloud upstream. `openai:` is deleted: it is reachable only through legacy Settings. | S |
| 4 | CPU-sized models | **Stay local**, because Crucible is a GPU orchestrator. TitaNet speaker tagging (sherpa-onnx, in-process) is unchanged. `nomic-embed-text` key-phrase ranking moves **off Ollama to an in-process ONNX runtime**. Its frequency fallback is removed (Law 1), and so is its silent document truncation (§12). | S |
| 5 | Voice isolation | Becomes a Crucible `denoise` job using the new `vocals` manifest, which arrives just after 1.0.24. The model runs at 44.1 kHz and ContentStudio resamples. Chunking and skipping silent chunks stay on the client, so each job is one file in and one file out (§9). | S |
| 6 | ASR | Pipeline and editor transcription both become the Crucible `asr` job: mlx-whisper on the Mac, faster-whisper on the PC. The model is **large-v3-turbo wherever a manifest exists**, which today means Mac yes and PC no (§8, §19 N4). The editor's word timings go through a **measurement gate** before cut-by-word relies on them. The job runs with `vad_filter:false` on mlx, every param stated, and the server's 900 s windows. **Superseded by LEDGER #203 (Qwen3-ASR, §8's note) and by Crucible 1.0.29's ids (§0a).** | S |
| 7 | Episode splitter | It is broken, so it is **not ported**. It is reworked as the coarsest grain of the shared chaptering service (#9). `EpisodeSplitterService.analyze()` and everything only it calls are deleted. | S |
| 8 | Editor Stories analyzer | **It is just chapters**: "broad chapters for a livestream". The same outline+assign chaptering runs at **broad** grain. `E/ollama-service.ts` and `E/chapter-splitter.ts`'s analyzer are retired. `story:suggest-title` stays as a per-chapter title call on the routed model. It is **not** a separate routing task. | S |
| 9 | Chaptering | **One service, "chaptering at a chosen granularity"**, built on snap OUTLINE + ASSIGN + Viterbi. It serves three grains: metadata chapters (`detailed`/`broad`/`stories`), editor Stories (`broad`), and episode splitting (`episodes`, the coarsest). Publishable titles and summaries still come from `summarize_chapter` on the routed model (§10). | S |
| 10 | Acts | Crucible 1.0.24 has **one** generation class, **`generate`**, for titles, description, tags, thumbnail text, pinned comment, chapter titles and summaries, the insights distiller, more-titles, scrub and Soften. Snap uses **`decide`** on `POST /v1/decide`. **Until 1.0.24 is deployed on a server, send `analysis`.** 1.0.23 refuses unknown acts (`400 unknown_act`). The act is chosen per server by reading `capability()` (§6.4). | S |
| 11 | Context | Keep it **low**. The **target is every local call under ~12–16k tokens**, prompt plus output budget. The 27B-4bit loads at **16,384 on the PC** (C `models/qwen3.8-27b-4bit.toml` cuda-linux block) and the 9B at 16,384 everywhere, and that loaded context is the real cap. After 1.0.24, the client states its real size in the capability query (`context_tokens`, `concurrency`). | S |
| 12 | Field input | Chapters run first. Titles, description, tags, thumbnail and pinned comment then read the **chapter digest** by default instead of the full transcript. The default switches **only after** an A/B on a handful of Owen's real videos (§7). | S (gate) |
| 13 | Model choice | ContentStudio's per-field routing table (M/metadata-routing.ts) **stays the source of truth**. Each option maps to one Crucible model id (§6.2). ContentStudio never writes the server's shared `localModels`. | S |
| 14 | Servers | Two: the **Mac** (local, mlx-darwin, the default) and **owens-pc** (3090 Ti, vLLM, over the tailnet, faster). The registry follows BookForge (`{name,url,token,added}`, order, Running/Paused, `newJobsWaitFor`). Each queue item has a **"fast" choice that pins it to the PC**. | S |
| 15 | Busy | A `409 server_busy` / `leased`, or a load the card cannot hold right now, **parks** the item. It never interrupts and never loops. The queue re-admits it later, or sends it to the other server when the item is not pinned (§13). With no reachable server, GPU work waits. There is no CPU fallback. **The "sends it to the other server" half conflicts with Owen's 2026-09-24 Briefcase ruling (§0a, §21 Q14).** | S |
| 16 | ASR default model | `mlx-whisper-large-v3-turbo` on the Mac. On the PC it is `faster-whisper-large-v3` until a turbo manifest exists. **Superseded:** those ids were retired in Crucible 1.0.29; the model is `qwen3-asr-1.7b` (#203, §8). | S |
| 17 | Re-roll gate | This is a later phase on snap: rule checks as yes/no questions, a re-roll of at most 3 with the failing reason passed back, the best attempt kept, and **delivered flagged, never blocked**. Title ranking is validated against Owen's 177 decided A/B tests first (§11). It conflicts with Law 3; see §21. | S (scope) |
| 18 | Outline writer | The **scorer model (qwen3.5-9b) writes the outline**, because that is the measured setup. Owen can move it to the routed chapters model instead. | D |
| 19 | Grain → switch cost | `detailed` = 20 (the measured best). `broad`/`stories` = the level-1 outline of a two-level outline. `episodes` = level-1 with a duration-aware outline prompt. The numbers are set by measurement in P8. | D |
| 20 | Where cloud calls go | To the **local (Mac) server**, which holds the migrated keys. The PC gets keys only through an explicit "copy my key to …" action. | D |
| 21 | Fields after chapters | Scrub and Soften keep their always-on / on-demand rewrite until the re-roll gate measures better (§11). | D |

---

## 0a. Lessons from Briefcase's migration (added 2026-09-24)

Briefcase finished the same move on `feat/crucible` (now on its `main`, `cb7c45d`): every AI call
through Crucible, snap chapters and flags, Qwen3-ASR transcription. What it learned that this
plan does not yet say, in the order ContentStudio will meet it. Crucible facts below were
checked in C at `v1.0.32`.

**Crucible moved while the plan waited. Re-read §1, §3.4, §8 and §19 against these:**

- **1.0.24 delivered most of §19.** The `generate` class, `/v1/decide` + SDK `decide()`, the
  mlx-lm logprob patch (`top_logprobs` 11 → 40, commit `50cfc38`), `initial_prompt` on whisper
  `asr` (N2), a turbo manifest for cuda-linux (N4), the `vocals-roformer` denoise manifest (N3's
  first half), and a **load-time context** (N5: `load-model` takes `params.context`, refused
  `context_over_limit` above the host's ceiling; the ceilings are in `capability()`'s `generate`
  row as `context_ceilings`). See §19's status notes.
- **Decide's missing labels are `missing: 'report'`, not a floor** (N7). A letter outside the
  engine's top-n comes back with a `null` probability and is named in `missingLabels`; `'refuse'`
  (the default) is the old `502 label_not_in_probs`. Viterbi's finite floor is **the client's
  declared rule** (Briefcase `backend/src/scorer/crucible-decide.ts`), not the server's.
- **The asr lineup changed (1.0.29, Owen's ruling).** It offers exactly `qwen3-asr-1.7b`,
  `qwen3-asr-0.6b` (1.0.32), `whisper-large-v3-turbo` and `whisper-tiny`, each **one id on every
  backend**, plus Mac-only MLX ports `qwen3-asr-1.7b-mlx` / `qwen3-asr-0.6b-mlx`. **Every
  backend-prefixed id is gone**: `mlx-whisper-*` and `faster-whisper-*` are refused
  `400 unknown_model` naming the ids offered, never aliased. §0 #6/#16, §3.4's subjects and §8's
  whisper text name retired ids. See §8's note.
- **1.0.25 made informational SDK fields nullable** (`T | null`): an informational field is read
  tolerantly and the code path that NEEDS it refuses by name. `promptTokens: null` means "not
  reported", never 0. `activity.chat.inFlight: null` is read as busy. `max_model_len` can be null:
  §7.2's context check must then take the load context, then the `generate` row's
  `context_ceilings`, and **refuse by name** when none is stated. Briefcase shipped a 16K guess
  here first and had to take it out (it is a Law 1 fallback).
- **1.0.26** settles a card before answering `engine_in_use`; **1.0.27** makes a dropped client
  cancel its non-streamed chat/decide. On the Mac, mlx-lm still finishes up to 2 requests it had
  accepted. Repin with `adopt-crucible-release.mjs <version>`, always naming the version.
- **The chat parser should refuse a missing `finish_reason`** rather than defaulting it to
  `stop`. §6.1's `length` rule depends on it being real.

**Servers: Owen's ruling in Briefcase conflicts with §0 #14/#15 and §13.2.** On 2026-09-24 Owen
said of Briefcase: *"if the mac is busy then it should pause and wait until it isnt busy anymore.
it should only hand the job to another server if the user switches crucible servers. it should
never randomly hand a gpu job to another server."* Briefcase replaced BookForge's ranked
`{order, disabled}` routing with **one selected server** (`{selected}`): a busy or silent server
makes work wait with the reason, a Settings switch moves work not yet started, and nothing moves
on its own. ContentStudio's explicit **fast pin** is a user choice, so it fits that rule, but
`newJobsWaitFor: 'any'` and "sends it to the other server when the item is not pinned" (§0 #15,
§13.2, P3's tests) are exactly the automatic hand-off he ruled out. Asked as §21 Q14.

**No fallbacks, and what "down" looks like.** Owen's Briefcase rulings: *"if crucible is down,
briefcase is down... the user just cant take any actions that would require crucible"*, and
*"programmatic fallbacks are okay. the problem is unexpected code paths and band aids"*. What
worked:

- One **readiness** service (ready / starting / unreachable / not-installed / not-configured),
  pushed to the renderer. Every AI control is disabled with that one reason and **one door**
  (Start / Install / Connect). Browsing, downloads, the editor's non-AI features and export never
  touch it.
- A **"no Crucible" test suite** that boots the app's services with no server at all and asserts
  every non-AI feature works (Briefcase `backend/test/no-crucible/`), so a non-AI path that
  starts depending on the AI layer fails a test, not a user.
- A **retired-component cleanup** for P10: Briefcase removes the old whisper models, llama
  runtime and NLI env once, 15 s after boot, with a dry-run script and an opt-out env var. It
  freed ~24 GB on the Mac. Do the same for the app's own whisper.cpp models and
  `voice-separator-env` (never Ollama's model store, which is Ollama's, not the app's).

**Model pickers list only what the server offers.** Owen, on seeing "(unavailable)" entries:
*"if claude isnt available then it shouldnt be listed in the model list."* Briefcase builds every
picker from one backend source: the server's models that `/v1/models` says are loadable or
resident, plus each upstream's models **only when that upstream is configured on the server**,
grouped "On this Crucible" / "Claude via Crucible". A stored choice the server cannot run is
**replaced by the server's own pick for the class** (and saved when the user next saves), never
shown as unavailable. This bears on §6.2's routing options (`qwen35-4b` and the Claude rungs):
the routing dialog should hide what the venue cannot run, not list it disabled.

**Leases on interrupt, and on quit.** Ctrl-C on a standalone tool (Briefcase's flag eval) left its
lease held until the TTL, and the card was stuck for everyone. Every CLI that takes a lease
(`generate-metadata-cli.js`, `prompt-harness/run.js`, the live smoke) needs SIGINT/SIGTERM
handlers that cancel its jobs and release its leases, then exit 130/143. On app quit, give
in-flight runs ~2 s to unwind and release their own leases **before** the ledger sweep: a lease
granted after quit began is in no ledger row the sweep could read.

**Snap, from running it on real videos.**

- **Quote the text being judged, never an index.** Owen: *"one mistake other agents have made
  was asking it to identify a sentence by ID number. we arent going to do that. we give it the
  thing it's judging."* The chunk is the primed state; the question quotes the unit (Briefcase
  flags quote a 3-sentence passage; chapters quote the sentence and the one before).
- **A multi-option softmax needs a per-video baseline.** For flags, a group of sentences almost
  always "does" some category a little, so "none" rarely won: 351 of 360 units read as hot, and
  the result was three 8-minute sections all carrying the one category the model leaned on all
  video. Fixed by scoring each option's **rise above its own median in that video** (capped at
  0.5, so a genuine whole-video theme still reads) and cutting any span over 90 s at its quietest
  boundaries. The same trap applies to §11's rule checks and to the ad option in §10.2's assign:
  measure the baseline before trusting an absolute threshold.
- **Weight the progress bar by work, not by stage.** Snap is most of a run's wall time (~15 min of
  a 28-min video's 18). Briefcase first gave it 22% of the bar, and it looked stuck.
- **A justification call puts the verdict first.** When an LLM judges and explains (Briefcase's
  flag check writes the reason each marker shows), the JSON schema orders `verdict` before
  `reason`, so the call is committed before the prose. In Briefcase's verifier, giving the model
  room to reason before answering measured worse (it talked itself out of real findings).

**Mechanics that cost time.**

- **Regenerate the module with the target release's own generator.** Run `gen-modules.py` from an
  extract of that tag (`git archive v1.0.32 | tar -x`), not from a working checkout, and check it
  with `--check`. A module naming a retired id is refused `unknown_subject`.
- **Qwen word timings need the `align` job type installed**, not only the `qwen3-aligner` weights:
  a missing env is `409 env_missing` at the submit. The module lists `align` as a job type and
  `qwen3-aligner` as a subject.
- **`capability()` and `/v1/info` answer "can this server run X"** before anything is uploaded:
  Briefcase reads the `asr` and `align` capability rows and parks with "has not downloaded
  qwen3-asr-0.6b yet" instead of uploading a video to be refused.
- **Native modules differ between Electron and the test runner** (Briefcase's `better-sqlite3`:
  `npm rebuild` for jest, `electron-rebuild` for the app). If ContentStudio's `tools/test-*` run
  under plain Node, pin which build is on disk before each.

---

## 1. Facts this plan depends on (checked in source)

**ContentStudio's job model.**

- **The pipeline queue lives in the renderer.**
  - `CS/frontend/src/app/services/job-queue.ts:40` `JobQueueService` persists jobs in `localStorage`. On reload it resets `processing` and `held` jobs to `pending` (:65-71).
  - `CS/frontend/src/app/components/inputs/inputs.ts:1181` polls every second. `processNextJob` (:1187) runs **one job at a time** (`hasProcessingJob`) and calls IPC `generate-metadata` (IPC:1493) for the whole job: transcription, chapters and fields.
  - A "Transcribe only" run takes every job to `held` (stage 1). A second Start sends the held jobs (stage 2, `send-held-prompt` IPC:1771). **This two-stage run is already stage-major grouping** (whisper resident for all of stage 1, the 27B for all of stage 2), and §13 keeps it.
- **The main-process pools** are in `CS/electron/services/queue-manager.service.ts`:
  - a main pool of 5 and an AI pool of 1 (:3-5);
  - `queueAITask` (:461) is the only helper still called (M/metadata-tasks.ts:781, M/description-unit.ts:590, M/rewrite-pass.ts:250, M/more-titles.ts:186, M/metadata-generator.service.ts:1512);
  - `queueTranscription` and `createMainTask` have no external callers.
- **The AI pool exists for Ollama OOM protection** (LEDGER #38). `makeRequest` takes the slot itself (M/ai-manager.service.ts:1723), so callers must not nest it. The chapter stage takes the slot around its whole run, on local only (M/metadata-generator.service.ts:1512, 4 h watchdog).
- **Model lifecycle.** `JobModelLifecycle` (M/model-lifecycle.ts:68) is job-scoped: stages declare residency (`holdOllamaModel`, :78), the job releases once (`releaseAll`, :109 → `unloadOllamaModels`, M/ollama-json.ts:85-95), and there is a `num_ctx` ratchet (`contextFloor`, :49, LEDGER #110-111). **This maps one-to-one onto a Crucible lease held for the job's run** (§13.3). The `num_ctx` ratchet has no Crucible equivalent: the context is the one the model was loaded with, and the client cannot set it at load (`LoadModelOptions` carries only `lease`, C `sdk/ts/src/types.ts:1549`). The ratchet is deleted.

**Local call shapes today** (all go through `askOllamaPlain`, M/plain-call.ts:107):

- **Thinking.** `think:false` goes over `/api/chat` for titles, tags, thumbnail, pinned comment (M/metadata-tasks.ts:799), description (M/description-unit.ts:603), stage-1 samples, the name scaffold, and the distiller (M/metadata-generator.service.ts:1162). Thinking is **on** (no `think` key, `/api/generate`) for chapter detail (M/chapter-whole-transcript.service.ts:1124-1132) and the scrub/Soften rewrite (M/rewrite-pass.ts:254-262).
  - Crucible's 9B manifest defaults to `thinking = false` (C `models/qwen3.5-9b.toml:91`). The 27B manifest states no default. **So every Crucible chat must state `thinking` explicitly**, or the two models behave differently for the same call.
- **Budgets.**
  - `LOCAL_FIELD_CTX_MAX 40960` / `LOCAL_FIELD_NUM_PREDICT 8192` (M/metadata-tasks.ts:487,497);
  - chapters `CTX_MAX 32768` / `NUM_PREDICT 8192` (M/chapter-whole-transcript.service.ts:150,153);
  - description `NUM_PREDICT 4096` (M/description-unit.ts:260);
  - distiller ctx 32768 / predict 2048 (M/metadata-generator.service.ts:51,1152).
- **Sampling.** No sampling parameters, except the stage-1 consensus samples: 5 at temperature 0.7, local only (M/chapter-whole-transcript.service.ts:200,602; LEDGER #159).
- **Direct-pass ceilings.** The field calls read the whole transcript up to the ceiling (M/ai-manager.service.ts:52: cloud 400k, local 90k chars) and the chapter digest above it (`resolveFieldContent`, M/chapter-digest.ts:111).

**Cloud call shape today.** `makeClaudeRequest` (M/ai-manager.service.ts:2088) sends `thinking:{type:'adaptive'}` (except Haiku 4.5) and `max_tokens` 16000/8000, with a plain or JSON system prompt.

Crucible's Anthropic translation (C `crucible/upstreams.py:547-593`):

- **drops** `chat_template_kwargs`, so adaptive thinking cannot be *requested*;
- fills `max_tokens` with **4096** when absent, so ContentStudio must send `maxTokens: 16000` itself;
- turns `response_format: json_schema` into a forced tool.

On every `initialize()`, the init pings make a billed 5-token call (M/ai-manager.service.ts:557 OpenAI, :596 Claude).

**Crucible facts** (1.0.23 plus the decide branch):

- **The chat door** needs the model resident (`409 model_not_resident`). Admission is the engine's concurrency + 1 (`503 chat_queue_full`), and SDK `chat()` drops `Retry-After`. There is one lease per server.
- **The `asr` job:**
  - params are exactly `{language, vad_filter, word_timestamps}` (`extra="forbid"`, C `crucible/jobs/asr/__init__.py:181-188`);
  - **there is no `initial_prompt`**;
  - `vad_filter:true` on mlx is a 400;
  - it windows at 900 s with 15 s overlap;
  - output is `transcript.json` segments (+ words), and a failed window fails the job.
  - Manifests: `mlx-whisper-large-v3-turbo` exists; **there is no `faster-whisper-large-v3-turbo`** (C `crucible/asr/`).
- **The `denoise` job:**
  - one file in at the model's native rate, stems out, and the separator stays resident between jobs;
  - it is **installed by the `rvc` env**, and the module generator refuses `denoise` as a job type by name (C `crucible/jobs/denoise/__init__.py:1-60`; INTEGRATING-AN-APP §3.1);
  - the only manifest today is `denoise-roformer` (hiss), and `vocals` is owed.
- **Decide** (branch only):
  - `questions`/`options` are **objects keyed by name**; `choice` takes 2–26 options;
  - the state is primed once per decision;
  - upstreams are refused;
  - mlx-lm caps `top_logprobs` at 11 (≤7 labels) until the 1.0.24 patch;
  - there is no `missing_labels: floor` (`502 label_not_in_probs`);
  - the `decide` class works at 8192 × 2;
  - it is admitted like a chat and holds no lane.
- **Loaded context.** 27B-4bit is 98,304 on mlx-darwin and **16,384 on cuda-linux**; the 9B is 16,384 on both; the 27B-8bit is 12,288. `qwen3.5-4b` exists only on the decide branch.
- **SDK surface.** It supports Node ≥ 20, CJS and ESM. ContentStudio runs Electron 30 (Node 20), and its `electron` tsconfig emits CommonJS.

---

## 2. Which process owns what

ContentStudio has no backend process. Everything below lives in the **Electron main process**
under a new `CS/electron/crucible/`, exactly where BookForge keeps it. The renderer reaches it
through IPC.

| Concern | Owner | Why |
|---|---|---|
| Registry (`<userData>/crucible-servers.json`), routing (`crucible-routing.json`), pairing, probe, engine hop | main | The same as BF. The token never leaves main, and every listing masks it. |
| Transport: chat, decide, jobs, leases | main (`electron/crucible/transport.ts`, `lease.ts`, `job.ts`) | Every AI caller is already in main. |
| Queue ordering, parking, the "fast" pin | **renderer** `JobQueueService` (ordering, the UI) + main `electron/crucible/lanes.ts` (admission per server) | The renderer already owns job order. Main owns the per-server card, because IPC one-offs (Soften, Scrub, More titles, editor denoise and transcription) must meet the same lane. |
| In-flight ledger + sweep | main | Startup sweep in `app.whenReady` (CS/electron/main.ts:156) before `setupIpcHandlers` (:248). Quit sweep in `before-quit` (:293) under a 30 s deadline, as in BF. |
| Editor Python workflows (transcribe, denoise) | **main makes the Crucible calls; Python keeps the audio work** | Python asks main through the stdout/stdin request protocol the Dugan ducking already uses (E/python-service.ts:260 `ducking_request`). The token never enters Python. |
| Key-phrase embeddings, TitaNet | main, in-process ONNX | These models are CPU-sized, by Owen's rule. |

---

## 3. What to vendor, what to port, what to rewrite

### 3.1 Vendor, byte for byte

- `CS/vendor/crucible-{client,bootstrap}-1.0.23.tgz`, with `package.json` pinned `file:vendor/...` and BF's `//crucible-*` prose keys. Both go at **one version**. Repin to 1.0.24 when it is cut (the decide SDK method arrives with it).
- `CS/tools/adopt-crucible-release.mjs`, copied from **BF** (the newer copy: `valueSpan` prose edits, reads the actual pin). Always name the version, because `--newest` reads the newest tag.
- `CS/shared/crucible/contentstudio.module.json`, generated in the Crucible repo (§3.4).
- Packaging: `@crucible/*` must be inside the asar and needs no `asarUnpack` (pure JS). Add a packaging smoke check to `tools/`.

### 3.2 Port from BookForge (`BF/electron/crucible/` → `CS/electron/crucible/`)

These are Electron-shaped already. Swap the client name to `'contentstudio'` and drop the narration specifics.

- **Registry and connection:** `servers.ts` (+ `crucibleClientFor`), `routing.ts`, `pairing-file.ts`, `discovery.ts`, `auto-connect.ts`, `connect.ts`, `connect-code.ts`, `probe.ts`, `engine-resolve.ts`, `venue-decision.ts`, `transport-failure.ts`.
- **Jobs and leases:** `job.ts` (`runCrucibleJob`), `stream-reconnect.ts`, `stream-stall.ts`, `lease.ts` (`reserveCrucibleRowLease` becomes a job lease), `in-flight-ledger.ts`, `in-flight-sweep.ts`.
- **Install and setup:** `install.ts` (`releaseToInstall`, `hostabilityOf`, `driveCrucibleInstall`), `engine-presence.ts`, `coordinate.ts`, `module-setup.ts` (`moduleForBackend`), `first-run-models.ts`, `engine-settings.ts`, `catalog.ts`.
- **Wording:** `crucible-words.ts`. All UI sentences live in one file, with holder lines of the form "busy: bookforge, tts 62% done".

**From Briefcase** (`BC/backend/src/crucible/llm/`), take the **logic, not the Nest wrapping**:

- `crucible-chat.service.ts` has venue selection, re-ensuring residency once on `model_not_resident`, reading `Retry-After` through a raw engine fetch, and a run-scoped lease via `AsyncLocalStorage`. The last of these is the shape ContentStudio's `JobModelLifecycle` becomes.
- `target.ts` holds the rule that no sampling goes to cloud.

### 3.3 Rewrite for ContentStudio

- `electron/crucible/transport.ts` is the one door every AI call takes (§6).
- `electron/crucible/lanes.ts` does per-server admission, parking, the fast pin, and model grouping (§13).
- `electron/crucible/asr.ts` converts `transcript.json` to `SRTSegment[]` and words (§8).
- `electron/crucible/denoise.ts` handles the Python request protocol (§9).
- `electron/services/metadata/chaptering/` is the snap chaptering service (§10).
- The Angular Servers pane, the doors, the routing dialog's model column and the queue row states (§14).
- `tools/fake-crucible.js` is copied from BF and gains `/v1/decide` (§17).

### 3.4 `contentstudio.module.json` (a PR to the Crucible repo, not a ContentStudio edit)

Add `C/modules/contentstudio.toml`, run `scripts/gen-modules.py`, and vendor the JSON byte for byte.

```toml
[module]
name = "contentstudio"

[[job_types]]
type = "llm"
[[job_types]]
type = "asr"
# denoise has no installer of its own: `rvc` installs its env (workerenv.JOB_TYPES_SERVED_BY_ENV)
# and a `denoise` entry is refused by name. Listing rvc pulls the rvc env for isolation. §19 N3.
[[job_types]]
type = "rvc"

[[needs]]
class = "decide"        # after 1.0.24 (snap scorer); omitted before

# SUPERSEDED (2026-09-24): the backend-prefixed whisper ids below were retired in Crucible
# 1.0.29 and a module naming them is refused `unknown_subject`. Per #203 the transcriber is
# Qwen3-ASR with its aligner: add `[[job_types]] type = "align"` above, and replace the two
# whisper subjects with `qwen3-asr-1.7b` and `qwen3-aligner` (one id each on every backend).
# Generate with the target release's own gen-modules.py (§0a).
[[subjects]]            # the transcriber, backend-scoped as bookforge.toml does it
kind = "model"
id = "mlx-whisper-large-v3-turbo"
[[subjects]]
kind = "model"
id = "faster-whisper-large-v3"        # -> faster-whisper-large-v3-turbo when it exists (§19 N4)
[[subjects]]            # the routing table's shipped local defaults (§6.2)
kind = "model"
id = "qwen3.8-27b-4bit"
[[subjects]]
kind = "model"
id = "qwen3.5-9b"
[[subjects]]
kind = "denoise"
id = "<vocals manifest id, named at its cut>"
```

`coordinate` posts it only when something is missing, strips `backends` before posting, and is
held until the first-run choices are recorded (BF `first-run-models.ts`).

---

## 4. Registry, pairing, probe, the engine hop, and the fast server

- **Rows.** `crucible-servers.json` holds `[{name,url,token,added}]`, written temp-then-rename with the token masked in every listing. `crucible-routing.json` holds `{order, disabled, newJobsWaitFor, fastServer}`. `fastServer` is ContentStudio's one addition: the name of the row that "fast" pins to, which is **owens-pc** by default.
  - *Briefcase note (2026-09-24):* after Owen's no-hand-off ruling, Briefcase's record is `{selected}`: one server all work goes to, the first added is selected, removing the selected one leaves none selected (never another picked for the user), and a pre-ruling `{order, disabled}` file reads as its first running server. If Q14 goes the same way here, the record is `{selected, fastServer}`.
- **Auto-connect.** When the registry is empty, adopt the pairing file (`~/.crucible/pairing`), after `info()` answers with its name and `apiVersion === 1`. On Owen's Mac that is the running 1.0.23 service, and the row is named `mac`.
- **The PC.** Owen adds owens-pc once, by connect code or device-code pairing (`startPairing('owens-pc:7100' over the tailnet, 'ContentStudio')`), from the Servers pane. The PC's engine may be behind the Windows tray orchestrator (`:7101`). Follow `engineOf(info)` **once**, cache it for 60 s, and never follow a chain (BF `engine-resolve.ts`).
- **Probe.** It tells apart **unreachable / not-Crucible / bad token / API mismatch / timeout** (3 s clock; a sleeping PC answers nothing). It is cached for 15 s for the lanes, and the Test button bypasses the cache.
- **Feature detection per server, never version-sniffing:**
  - `capability().classes` containing `generate` means 1.0.24 acts (§6.4);
  - `POST /v1/decide` answering anything but 404 means snap is available;
  - the catalog row for a model gives its `max_model_len` (the loaded context, §7.4).
  - `MIN_CRUCIBLE = '1.0.23'`: an older server is shown as "needs update" and gets no work.

---

## 5. Install and first-run

- **The Mac already runs Crucible 1.0.23 as a launchd service.** ContentStudio's setup face there is **adopt**. It never installs, never stops (`stopLocal` only on an explicit user action) and never uninstalls: the service is shared with BookForge, Foundry and Briefcase.
- **The one setup face**, from BF `crucible-doors`: connected / adopt / install / connect-only.
  - `hostabilityOf` is measured: Apple Silicon yes, Intel Mac no.
  - Install is **bare** (`jobTypes:['echo']`) followed by `startLocal()`, and runs only after the **never-older gate** (`latestRelease`/`compareReleases` against `info().server.version`: `install_older_than_running`, `crucible_already_latest`, with no `--force`).
  - The Windows host door is not needed: ContentStudio does not install on the PC, it pairs to it.
- **First run.** `ai-setup-wizard` (`CS/frontend/src/app/components/ai-setup-wizard/`) is replaced by the doors plus the routing dialog. The old wizard asked for provider keys and an Ollama host. The new one asks:
  1. which server(s) to use;
  2. for Claude keys, **written to the server** with `testUpstream` then `putSettings`;
  3. then runs `coordinate`.
- **Startup readiness** (`get-startup-readiness`, IPC:1111) stops probing Ollama `/api/tags` (IPC:1134) and whisper components. It reports: registry non-empty; the default server reachable; `asr` and the routed models installed on it, or pullable (`catalog()`).

---

## 6. Call-site migration

### 6.1 The one door

`electron/crucible/transport.ts` exports:

```ts
chat({ model, prompt, act, thinking, maxTokens, temperature?, responseFormat?, signal, what })
    → { text, finishReason, usage, server }
decide({ state, questions, signal, what }) → answers          // P8, act 'decide'
withJobLease(server, model, fn)                                // the job-scoped lease (§13.3)
```

It replaces both choke points:

- `AIManagerService.makeRequest` (M/ai-manager.service.ts:1700): its `claude:`, `ollama:` and `openai:` branches are deleted and **`claude-cli:` stays**;
- `askOllamaPlain` (M/plain-call.ts:107): the transport is deleted, and `stripThinking` (:45) plus the parsers (:220, :247, :283) are kept.

`runPlainRequest` (:1342) and `runMetadataRequest` (:1281) keep their signatures and route to `transport.chat`, or to claude -p.

What the door does:

- Every call is recorded in the existing `promptTrace` (:1713) along with **which server ran it** (Law 8).
- `finishReason === 'length'` is a hard failure, as `done_reason:"length"` is today (LEDGER #112).
- A prompt plus `maxTokens` above the loaded context **throws before sending**, naming the model, the server and both numbers. It is never truncated. Today's middle-truncation in `makeOllamaRequest` is deleted (Law 1).

### 6.2 Routing option → Crucible model id

The `MetadataRoutingOption` (M/metadata-routing.ts:39) gains `crucibleModel`. `kind` stays `'cloud'|'local'`.

| option (M/metadata-routing.ts) | today | Crucible id | venue |
|---|---|---|---|
| `qwen38-27b` (:213) | `qwen3.8:27b` (Ollama Q4) | `qwen3.8-27b-4bit` (Mac mlx 4-bit; PC AWQ-INT4, ctx 16,384) | GPU lane |
| `qwen35-9b` (:164) | `qwen3.5:9b` | `qwen3.5-9b` (bf16) | GPU lane |
| `qwen35-4b` (:181) | `qwen3.5:4b` | `qwen3.5-4b` (**1.0.24**; until then refused by name, never substituted) | GPU lane |
| `sonnet5` / `opus5` (:128-129) | `claude:claude-sonnet-5` / `-opus-5` | `anthropic/claude-sonnet-5` / `anthropic/claude-opus-5` | no lane |
| `haiku45` (:154) | `claude:claude-haiku-4-5` | `anthropic/claude-haiku-4-5-20251001` (the dated id `mapClaudeModelName` sends, :1899) | no lane |
| `claude-cli`, `claude-cli-sonnet` (:141,147) | `claude-cli:opus` / `:sonnet` | **unchanged, outside Crucible** | no lane |
| `SUMMARIZATION_MODEL` (:109) | `ollama:qwen3.8:27b` | `qwen3.8-27b-4bit` | GPU lane |
| `KEY_PHRASE_EMBEDDING_MODEL` (:125) | `nomic-embed-text` (Ollama) | in-process ONNX (§12) | none |

Stored routings keep their option ids, so no migration is needed. `REMOVED_ROUTING_OPTIONS` (:448) is untouched. `probeOllamaInventory` (:779) is replaced by `catalogInventory(server)` over `catalog()`/`models()`: installed, pullable, fits. Its `MetadataRoutingAvailability` gains `pullable` and `does-not-fit-here`.

### 6.3 The call-site table

The **act** column is what is sent after 1.0.24; before that, every chat sends `analysis`. The **ctx** column is prompt plus output budget, where *today* is the current ceiling and *target* is §7's. **think** is stated on every call.

| call site | field / stage | think | budget today → target | ctx today → target | temp |
|---|---|---|---|---|---|
| M/metadata-tasks.ts:697 (cloud), :786 (local) | titles, tags, thumbnail_text, pinned_comment | off | 8192 → 2048 (answer-sized; thinking is off) | 40,960 → ≤12k (digest) | — |
| M/description-unit.ts:578 / :595 | description (3 candidates) | off | 4096 → 2048 | 40,960 → ≤12k (digest) | — |
| M/chapter-whole-transcript.service.ts:1153 `ask` stage 1 (5 samples, :602) | chapter boundaries | off | 8192 | 32,768 → **retired by P8** (snap) | 0.7 local |
| same, `wholeVideoNameScaffold` :800 | name scaffold | off | 8192 → 2048 | whole video → **per ≤12k window, lists unioned** (§7.3) | — |
| same, `askDetail` :1124 | chapter title + summary (`summarize_chapter`) | **on** | 8192 | chapter-sized (~2–5k) + 8192 ≤ 16k ✓ | — |
| M/metadata-generator.service.ts:1461 `cloudPlain` | chapters on cloud | n/a | 16000 | 400k chars | never |
| M/rewrite-pass.ts:234 / :254 (scrub.ts:497, soften.ts:379; IPC `metadata:scrub-item`, `metadata:soften-item` IPC:2583) | scrub, Soften | **on** | 8192 | one field + context ≤ 12k | — |
| M/more-titles.ts:171 / :190 (IPC `titles:generate-more` IPC:2447) | more titles | off | 8192 → 2048 | ≤12k (digest) | — |
| M/metadata-generator.service.ts:1138 / :1146 | insights distiller | off | 2048 | 32,768 → ≤12k | — |
| M/metadata-generator.service.ts:454, :570 → `summarizeTranscript` (M/ai-manager.service.ts:735) | compilation condensation | off | 4096 | chunked to ≤12k per call | — |
| M/metadata-generator.service.ts:590 → `generateCompilationMetadata` (:960) | compilation package (JSON, Law 12 exception) | off | 16000 cloud / 4096 local | ≤12k | — |
| M/episode-splitter.service.ts:965 `makeAIRequest` | episodes | — | — | **deleted; reworked in P8** | — |
| E/ollama-service.ts:147 via editor-ipc.ts:935 `story:analyze-chapters` | editor Stories | — | — | **deleted; chaptering `broad` in P8** | — |
| E/ollama-service.ts:147 via editor-ipc.ts:969 `story:suggest-title` | story title | off | 2048 | one story's chapter labels | — |
| M/ai-manager.service.ts:557, :596 init pings | connection test | — | — | **deleted**: `testUpstream` in settings only, never billed per run | — |

**JSON.** The compilation package is the one surviving JSON caller.

- On local it sends `responseFormat {type:'json_object'}` with `thinking:false`. Its local schema-less status is re-measured (LEDGER "Local stays schema-less").
- On cloud it sends `json_schema`, which becomes a forced tool. Adaptive thinking cannot be requested through Crucible, and a forced tool may not combine with thinking on newer Claude models, so **measure one compilation run on `anthropic/claude-sonnet-5` in P2 before shipping** (§19 N6).

### 6.4 The act, per server

`transport.chat` reads the venue's cached `capability().classes`:

- if `generate` is present, send `generate`;
- otherwise send `analysis`, and log `"<server> predates 1.0.24; sending act analysis"` once per server per session (a declared mode, Law 8).

`decide` is sent only on a server where `/v1/decide` answered. Crucible refuses a wrong name, so a typo fails loudly. BF's `test-crucible-text-acts.js` is mirrored: a check reads C `crucible/capability.py` `CLASSES` and asserts that every act ContentStudio sends is in it.

### 6.5 Bypasses, settings and dead code

| site | action |
|---|---|
| `unloadOllamaModels` M/ollama-json.ts:85-95; `JobModelLifecycle.releaseAll` M/model-lifecycle.ts:109 | → the lease `release` in the job's `finally`. Crucible settles the card, and ContentStudio **never unloads** a model it did not load, per BF `cardHeldBy`. |
| `rankKeyPhrases` M/key-phrases.ts:67 (`/api/embed` :78) | → in-process (§12) |
| `probeOllamaInventory` M/metadata-routing.ts:779; IPC:1134, `check-ollama` IPC:3138, `get-available-models` IPC:3156, editor `ollama:list-models` editor-ipc.ts:917 | → `catalogInventory` / deleted |
| `get-api-keys` IPC:3184, `save-api-key` IPC:3206, every `api-keys.json` read (IPC:1121, 1513, 2510, 2646, 2861, 3163, 3308) | → the settings bridge (§14). The file is deleted after migration (§6.6). |
| Settings `metadataModel/aiModel/ollamaModel/metadataProvider/aiProvider` (IPC:1515-1528, episode splitter IPC:3308-3316), `ollamaHost`, CS/electron/main.ts:164 `ollamaModel:'gpt-4o'`, `aiProvider:'openai'` | deleted. The generate-metadata comment at IPC:1535-1557 already says these govern nothing but client construction. |
| `PROVIDER_DEFAULTS` M/ai-manager.service.ts:365-373 | deleted (it is a silent default model, Law 1) |
| `openai:` transport (`makeOpenAIRequest`, `initializeOpenAI`) | deleted |
| `CHAPTER_PIPELINE_MODELS` M/metadata-routing.ts:111 | deleted |
| `EpisodeSplitterService.analyze()` M/episode-splitter.service.ts:161 and callees (`detectEpisodeBoundaries` :562, `splitLongEpisode` :835, report I/O :1290) | deleted |
| `ollama-service.ts` `chat()` :228, `unloadLastUsed()` :331 | deleted with the file (P10) |
| `editor.ollamaModel.v2` (CS/frontend/src/app/components/editor/editor.component.ts:407) | deleted. Stories use the chapters routing. |
| `whisperModel` setting (default `'small'`, IPC:1093, main.ts:186) | deleted. The ASR model is per server (§8). The stale `'small'` default contradicts LEDGER Transcription (large-v3-turbo since 2026-08-23). |
| `queueAITask`, `queueTranscription`, `createMainTask` | `queueAITask` → `lanes.ts`; the other two are deleted (no callers) |

### 6.6 API keys → Crucible settings (S)

This runs once, the first time the **local** server is registered and reachable, and only if `api-keys.json` exists:

1. `GET /v1/settings`. If `anthropic` already has a key whose `keyHint` differs from ours, **stop and ask** in the Servers pane. The server is shared with the other apps.
2. `testUpstream('anthropic', {key})` → `putSettings({upstreams:{anthropic:{key}}})`.
3. `GET` again and check that `keyHint` equals the last 4 characters of the key.
4. Only then delete `api-keys.json`, and record `keysMigratedTo:'mac'` in the store.

On any failure the file stays and the attempt repeats at the next boot. Keys are **never** pushed to a remote server automatically. The OpenAI key is not migrated (`openai:` is removed); the pane says it was dropped.

---

## 7. The low-context redesign, and its A/B gate

### 7.1 Why

Owen: whole-video context fits but is significantly slower, and the 27B barely fits the 3090
Ti, where it loads at 16,384. Today every local field call carries the whole transcript up to
90k chars (~25k tokens) plus an 8192 budget, which **cannot run on the PC at all**.

### 7.2 The redesign

- **Order per item.** Chapters first. That covers stage 1 → detail today, and outline → assign → detail after P8.
- **The input switch.** `resolveFieldContent` (M/chapter-digest.ts:111) gains an input policy, `digest-default`. Titles, description, tags, thumbnail and pinned comment read `renderChapterDigest` (:99) for **every chaptered item**, not only over-ceiling ones.
  - A chapterless item keeps the raw transcript. Those are short: typed subjects, plain transcripts.
  - An over-ceiling chapterless item still fails, naming both facts (the existing rule).
- **Budgets.** Thinking-off fields get answer-sized budgets (2048); the numbers are set from P4's measured answer lengths plus 2×. The detail and rewrite calls keep 8192 because they run thinking-on.
- **The check before sending.** Every local call computes `estimateTokens(prompt) + maxTokens`, where the `estimateTokens` rule stays today's. That total must be ≤ the venue's loaded context for that model, read from `models()`/catalog `max_model_len`. Otherwise the call **throws before sending** (§6.1).
- **After 1.0.24.** The lane asks `GET /v1/capability?context_tokens=<run max>&concurrency=1` to learn whether the routed model fits the card at the run's real size. It does this **before** reserving, so a no-fit parks or goes to the other server with the server's own sentence. Exact parameter names are confirmed at the cut.

### 7.3 Calls that need a structural change to get under ~12–16k

- **Name scaffold** (M/chapter-whole-transcript.service.ts:800). It reads the whole video. It becomes one call per ≤12k-token window, with the name lists unioned and de-duplicated case-insensitively, and the result declared in the run stats.
- **Compilation condensation** (`summarizeTranscript` :735). It already chunks over the local ceiling. The chunk size drops to ≤12k per call.
- **The insights distiller.** Its input is A/B records, not a transcript. Measure its real prompt size in P4; if it is under 12k, nothing changes.
- **Snap assign** (P8). The state is a transcript chunk of ≤12k tokens, using Briefcase's `chunks.ts` defaults of 16k single / 12k core / 2k overlap, tightened to the 9B's loaded 16,384 minus the question.

### 7.4 The A/B gate: full transcript vs digest (before the default switches)

This one gate decides whether `digest-default` ships. The default ships only on Owen's verdict: "no worse" on every ship-field and "enough" on every pick-field. Until then the existing ceiling rule stays in force.

- **Corpus.** 5 of Owen's real videos across the three channels, with at least one over 60 minutes. Use the regression transcripts where they exist (Kofi Asare, Tasia Fortune, Forgiato Blow; LEDGER §3 Process).
- **Arms.** Same routing, same chapters. **A** is the raw transcript, as today. **B** is the digest. Both run on the Mac, where the whole transcript fits.
- **Scoring.** Owen, blind (arms shuffled, as in the description-quality path), against the LEDGER §1 per-field bars. Mechanical checks too: names spelled right (the verified list), `occursIn` for tags, register judge warnings, wall time per field, and prompt tokens per call.
- **Before any run.** Owen's go-ahead is required (Law 7), and the harness is `scripts/generate-metadata-cli.js` with a new `--field-input raw|digest` flag.

---

## 8. ASR

> **Superseded model choice (Owen, 2026-09-23, LEDGER #203): Qwen3-ASR-1.7B + Qwen3-ForcedAligner-0.6B, fully.** Whisper drops ums and uhs; Qwen keeps them with times precise enough to cut on. Crucible built it on branch `feat/qwen3-asr` @ e7711a8 (not cut yet; the first live run on each card needs Owen's go). The contract:
> - **Request:** `client.asr({model:'qwen3-asr-1.7b', audio, filename, language:'en', vadFilter:false, wordTimestamps:true, context})`.
> - **`context`, not `initial_prompt`:** the filler prompt (plus the filename-title seed) goes in `context`, which takes up to 1,024 tokens. `initial_prompt` is refused on Qwen, `vad_filter:true` is refused, and `auto` language is refused.
> - **Output** is whisper's transcript.json shape: words `{start,end,word,probability:null}` in absolute seconds, plus `pieces` and `redecoded`.
> - **Loop failures:** a loop that survives the re-cuts fails as `asr_decode_loop`, naming the time range. It surfaces as a failure, never a fallback.
> - **Engines:** 8 pieces at a time on the PC (vLLM), 1 on the Mac (mlx-audio).
> - Where the whisper-specific text below conflicts with this, this note wins.
>
> **As shipped, 2026-09-24 (Crucible 1.0.29-1.0.32, and what Briefcase learned running it):**
> - **Ids.** `qwen3-asr-1.7b` is one id on both backends (vLLM on the PC; since 1.0.30 Qwen's own
>   `qwen_asr` package on MPS on the Mac, 84 s per 10 min with timestamps). `qwen3-asr-0.6b` exists
>   too (1.0.32). `qwen3-asr-1.7b-mlx` / `qwen3-asr-0.6b-mlx` are Mac-only MLX ports, ~2.5x faster
>   **but they drop fillers** (9 against the official package's 24 on the same window).
>   ContentStudio keeps ums and uhs to cut on, so it wants the **official** id, not `-mlx`.
>   Briefcase, which does not, uses `qwen3-asr-0.6b-mlx` on the Mac.
> - **The aligner is a job type.** `word_timestamps:true` runs `qwen3-aligner` in the `align` worker
>   env: without that env the submit is `409 env_missing`, without the weights `409
>   model_not_installed` naming the aligner. The module lists both (§3.4). Check the `asr` and
>   `align` rows of `/v1/info` before uploading, and park with which one is missing.
> - **Language is required**, one of the aligner's eleven (en de fr es it pt ru ja ko zh yue).
>   `auto` is refused. A language outside them should be refused by name before any upload.
> - **Segments are pieces of up to 180 s**, not sentences, and the aligner's words carry **no
>   punctuation** (the segment `text` has it; "don't" may come back as `don` + `t`). An SRT built
>   from segments gives 3-minute cues. Briefcase matches the words to the punctuated text on their
>   letters and digits, character by character, gives each text token to the word holding its
>   last letter, and cuts cues at sentence punctuation (full-width 。！？ included), at the words'
>   times (BC `backend/src/crucible/asr/crucible-transcript.ts` `alignWordsToText`, with tests).
>   §8.1's `word_timestamps:false` would lose the only times finer than a piece: ask for words.
> - **Transcript shape** is whisper's keys (`model`, `revision`, `language`, `segments[{start,end,
>   text,words}]`), plus `engine`, `aligner`, `pieces`, `silent_pieces`, `redecoded`.
>   `language_probability` is always 1.0.

### 8.1 Pipeline transcription

Today `whisper.service.ts:223` → whisper-bridge `transcribe` (CS/electron/lib/bridges/whisper-bridge.ts:179 spawns `whisper-cli -osrt --prompt <filename title>`).

The new path:

1. ffmpeg extracts 16 kHz mono FLAC (the existing `ffmpeg-bridge`).
2. `upload`.
3. `submit({type:'asr', model, params:{language:'en', vad_filter:false, word_timestamps:false}, clientRef:'contentstudio:<jobId>:<item>'})`.
4. Follow with `runCrucibleJob`, mapping `progress` (`processed_s/total_s`) onto the existing `emitProgress`.
5. `transcript.json` segments → `SRTSegment[]`, the pipeline's existing currency.

`WhisperBridge`, its `DEFAULT_MODEL = 'base'` and the silent invalid-model substitute at whisper-bridge.ts:89 (a Law 1 violation) go in P10.

**The regression that must not ship silently.** whisper.cpp is seeded with the filename title (`initialPrompt`, whisper-bridge.ts:130-136, 2026-08-24 "Jake Lane" → Jake Lang). Crucible's `asr` has **no `initial_prompt`** (§19 N2). P5's acceptance measures proper nouns with and without the seed on the name corpus. **If it regresses, P5 waits for the param rather than shipping unseeded.**

- **Sidecars.** The saved-transcript sidecar (`.contentstudio/transcripts/`, PR #66) records the model as `crucible:<server>:<model id>`. Existing whisper.cpp large-v3-turbo sidecars stay reusable. `base` ones are already flagged by the ledger.
- **Speaker tagging** runs per caption. Segment granularity changes between whisper.cpp and mlx-whisper, so P5 re-runs `scripts/validate-speaker-tagging.js` on a Crucible transcript.

### 8.2 Editor transcription

Today: python-service.ts:838 → `editor-backend/cli/transcribe.py` → `run_whisper` (:685, `whisper-cli -ml 1 -sow -ojf -mc 0`) per per-source track. It runs on a VAD-compacted WAV (`compute_activity` :381, `build_compact_wav` :439), with loop recovery that re-decodes repetition regions with a fresh decoder (`_retry_loop_regions` :615).

The new shape keeps all the audio logic in Python and moves only the decode:

- `transcribe.py` emits `{"type":"asr_request","wav":…,"trackId":…,"region":[s,e]|null}` per compact WAV and per loop region.
- Main runs a Crucible `asr` job (`word_timestamps:true`, `vad_filter:false`) and answers on stdin with the words JSON path.
- `parse_whisper_json` (:302) gains a reader for Crucible's `words:[{word,start,end,probability}]`.
- `map_words`, the loop warning and the atomic sidecar write are unchanged.

### 8.3 The word-timing measurement (gate before cut-by-word relies on Crucible words)

- **Corpus.** 3 editor sessions of Owen's: one studio, one livestream, one with clips. Each track is transcribed by both engines on the **same compact WAVs**.
- **Measure:**
  - word-alignment agreement (matched tokens);
  - |Δstart| and |Δend| as median, p90 and p99;
  - the share of words off by more than 1 frame (the cut quantum);
  - the loop count;
  - wall time.
- **Pass.** p90 |Δ| within 1 frame, and no systematic bias (median |Δ| under half a frame). The numbers go to Owen, and whisper.cpp stays the editor engine until he accepts them.
- **A known difference to watch.** whisper.cpp runs `-mc 0` (no conditioning on previous text). Crucible's mlx conditioning is the server's choice. The loop count is the telltale.

---

## 9. Voice isolation → Crucible `denoise`

Today: editor-ipc.ts:1577 → `electron_workflow.py:411-500` `denoise_mic_audio` → `core/voice_separation.py`. That script cuts at silences into ~6-min chunks (`plan_cuts`), extracts each at 44.1 kHz stereo (`extract_chunk`, :97), passes silent chunks through (`is_silent`), separates each chunk in a fresh `audio-separator` subprocess from `voice-separator-env` (`separate_chunk` :103, `vocals_mel_band_roformer.ckpt`), and concatenates and resamples back to 48 kHz (`concat_resample` :139).

The new path:

- `separate_chunk` is replaced by `{"type":"separation_request","wav":<44.1k chunk>,"out":<path>}` on stdout.
- Main runs `denoise` with the **vocals manifest** (one file in, the vocal stem out) and answers on stdin.
- Planning, silence skipping, the PLAN/CHUNK progress lines (electron_workflow.py:470-490), concat and resample are unchanged.
- A chunk's upload is about 6 min × 44.1 kHz × 2 ch × 24-bit ≈ 95 MB, which is fine over the tailnet.

**Fail loud, as today** (electron_workflow.py:413-417): a failed job aborts the run, and the noisy original never ships.

**A busy lane mid-run** waits with the holder's sentence in the operation row. It never interrupts and never falls back to the local env.

The client's reason for chunking was memory in its own process, which is now the server's concern. Chunking stays anyway, for the silent-chunk skip and the one-file wire.

---

## 10. Chaptering at a chosen granularity (snap)

### 10.1 One service, three consumers

`electron/services/metadata/chaptering/chaptering.service.ts`:

```ts
chapter({ units, grain: 'detailed'|'broad'|'stories'|'episodes', promotedItems, signal, onProgress })
  → { chapters: {startUnit, endUnit, item, isAd}[], outline: string[], stats }
```

| consumer | today | grain | after |
|---|---|---|---|
| metadata chapters | `WholeTranscriptChapterService` stage 1 (M/chapter-whole-transcript.service.ts:375) | `ChapterGrain` from the queue (M/chapter-prompts.ts:26), plus `detailed`/`broad`/`stories` | the service does boundaries; `detailChapters` (:858) and `summarize_chapter` stay on the routed model |
| editor Stories | `story:analyze-chapters` → `analyzeChapters` (sealed 14B, E/chapter-splitter.ts) | `broad` | IPC keeps its name and payload; `story:suggest-title` becomes one `generate` call per story on the chapters routing |
| episode splitting | `analyze-transcript-split` (IPC:3294) → `detectChapters` (IPC:3340) | `episodes` | returns cuts in the shape `commit-transcript-split` (IPC:3363) already consumes |

### 10.2 The method (as measured, ported not re-derived)

**Model roles (Owen, 2026-09-23): "9b -> outline, outline -> snap, final chapter -> 27b -> chapter title".** The 9B writes the outline, snap on the 9B assigns the sentences, and each finished chapter goes to the 27B (the chapters routing, `summarize_chapter`) for its title and summary.

1. **Outline (9B).** One chat with `thinking:false`, temperature 0, and ≤25 short labels as plain lines. On a long video this becomes a **two-level outline**: level 1 is broad (≤25), then a sub-outline per level-1 section (≤25) over that section only. That keeps the options ≤26 and every state ≤12k tokens. `broad`/`stories` use level 1 only. `detailed` uses level 2 on long videos and level 1 on short ones.
2. **Assign.** One `decide` question per sentence (quoting the sentence itself, never its index; §0a): `choice`, "which section of the video is this sentence part of?". The options are the outline items plus one fixed **ad/sponsor/self-promotion** item, whose description names the channel's `promoted_items`. The sentence is quoted with its previous sentence. The transcript chunk is the primed `state`, with 64 questions per decide, as in Briefcase.
3. **Viterbi.** It runs over log P(item | sentence). Any item may follow any other, with a flat switch cost (20 for `detailed`) as the grain dial. Boundaries are where the item changes.
4. **Ad spans.** Each ad span is confirmed with a yes/no. A rejected span is re-segmented without the ad option. Confirmed ad spans become the promo chapters that code already excludes (M/promo-chapters.ts).
5. **Timestamps** come from the sentence units' cue times. The model never emits one (Law 6).

**Measured** on YTSeg (24 videos): F1@±1 0.72, Pk 0.21–0.23 with the count chosen automatically. The pairwise-boundary question scored 0.59–0.61 and the uniform baseline 0.25/0.44. The scorer is Qwen3.5-9B BF16; the 4B reaches ~90% accuracy at half the time; the 0.8B and 2B are not viable. Speed is ~0.65 s/sentence on the 9B.

**Open items carried into P8:**

- ad-span edges are a sentence or two too wide;
- livestreams over-split (the two-level outline is the answer to test);
- a one-hour video is ~600–900 sentences, about 7–10 min on the 9B.

### 10.3 Reuse, not re-port

The pure modules come from Briefcase `feat/snap-scorer` `backend/src/scorer/`: `chapters/segmenter.ts`, `chapters/chunks.ts`, `chapters/units.ts`, `scorer-viterbi.ts`, and the orchestration in `chapters/snap-chapter.service.ts`. The reference is `segment.py` in this session's scratchpad.

They are copied into `M/chaptering/` with a header naming the Briefcase commit, plus a `tools/check-snap-parity.js` that diffs them against Briefcase's branch when that checkout is present. A shared package is Owen's call (§21 Q4). Two adaptations:

- **Wire.** Briefcase's scorer types are arrays. Crucible's decide takes objects keyed by name, so **prefix every question and option name** (`q0…`, `o0…`), because JS reorders integer-like keys. Test that the letter order survives names `"1".."12"`.
- **Prompts.** Briefcase keeps its prompt text inline (`chapters/snap-prompts.ts`). Under **Law 2** the outline prompt, the assign instruction, the ad option text and the plug-confirm statement move to `CS/electron/assets/prompts/shared/pipeline/chapters.yml` as new keys, per grain, with zero comments. Their rationale goes in PROMPT-LEARNINGS.md.

### 10.4 What retires

- Stage 1 and its consensus sampling (LEDGER #159-160; `STAGE1_SAMPLES_LOCAL`, `voteBoundaries`).
- The cadence bands in `chapters.yml` and the rolling window.
- `E/chapter-splitter.ts`'s five-stage analyzer and its inline prompts (a Law 2 violation today, :344-:1101).
- `EpisodeSplitterService` except its pure transcript-slicing types.

**What stays:** detail calls, the name scaffold (windowed, §7.3), promo exclusion, the title judges (M/chapter-title-quality.ts), the ≥3-chapter floor warning, and deliver-and-curate.

### 10.5 Acceptance

- **Ground truth.** Owen's **own published chapter lists** (operator-approved, in the reports) on 10 videos across the channels, plus 2 livestreams for `broad`.
- **Metrics.** F1@±30 s, Pk, chapter-count ratio, ad-span edge error, and wall time against the current fifth architecture. Ship when snap is no worse on F1 and Owen accepts the livestream `broad` split.
- **On the Mac** the service needs the 1.0.24 mlx logprobs patch (26 options). Before it, decide refuses with `decide_not_served`, and the service **refuses by name**. There is no quiet fall back to stage 1 (Law 1). The chapter stage stays on the fifth architecture by a declared setting until snap passes.

---

## 11. The re-roll gate (later phase, after P8)

- **Rule checks.** Snap yes/no questions per generated title, chapter title and description:
  - refers to Owen by name;
  - says "the creator" or "speaker says";
  - narrates the commentary rather than the subject.

  The question texts live in `assets/prompts/` (Law 2, positive form in the prompt, Law 4).
- **Re-roll.** A failing item is re-generated **up to 3 times**, with the failing reason passed back in the prompt, keeping the best-scoring attempt. After 3 failures it is **delivered flagged, never blocked**. Every re-roll is declared in the run stats and warnings (Law 8).
- **Replaces, once measured:**
  - the scrub pass's always-on rewrite (M/scrub.ts; LEDGER #183), since only ~4% of chapter titles need it;
  - the warn-only regex judges in M/chapter-title-quality.ts.

  Scrub stays on-demand (IPC `metadata:scrub-item`) either way.
- **Title ranking** by relative comparison (snap `choice` over pairs). It is validated against Owen's **177 decided A/B tests** before it orders anything shown to him. It is analysis, not title-writing guidance, so Law 5 is untouched.

---

## 12. Key phrases in-process

**Today** (M/key-phrases.ts):

- The candidates are `candidateKeyPhrases(text).slice(0,200)` (:68).
- The document is **silently truncated to its first 20,000 characters** (:73; ~5k tokens, well inside nomic's 8192). So on an hour-long transcript (~60k chars) the centroid is the **first third of the video**. The tail's subjects never outrank the opening's.
- That cut is stated in a comment (:61-65) and **not declared in the run's warnings** (Law 8).
- Ollama's `/api/embed` never sees an over-limit input, because the code cuts first.
- When the model is missing or the host is down, the ranking drops to **frequency** (`mode:'frequency'`, :105-120; LEDGER #107). That is a declared degradation, but by Law 1 it is still a fallback.

**The new version:**

- **Runtime.** `nomic-embed-text-v1.5` runs in-process through `onnxruntime-node`, using the ONNX export Nomic publishes on its HF repo, with its WordPiece tokenizer. That can be via `@huggingface/transformers`' node backend, or directly with the tokenizer JSON if that dependency is unwelcome.
- **Distribution.** It is distributed like TitaNet: a `components/catalog.ts` `file` entry (~140 MB fp32, or the ~70 MB quantized export after a parity check), `asarUnpack` for the native addon (`package.json:97-101` pattern), and a `sha256`.
- **Whole-video centroid.**
  - The document is split into ≤2048-token chunks on sentence boundaries.
  - Each chunk gets the `search_document:` prefix.
  - The centroid is the length-weighted mean of the chunk vectors.
  - Candidates are embedded the same way (with `search_query:` or `search_document:`, whichever matches today's rank order better; measure it).
- **Parity.** On 10 transcripts, compare the top-30 phrases against today's Ollama ranking (Jaccard + rank correlation), and report how much the whole-video centroid changes the list. Owen sees both lists before the switch.
- **No fallback.** A missing component **fails the key-phrase step loudly**, naming the component. The frequency path and `mode:'frequency'` are deleted. On a chaptered item the tags are code-assembled from these pools, so a missing model is a setup error, not a quality mode.

---

## 13. The queue

### 13.1 Lanes

- **One GPU lane per enabled server** (`SERVER_GPU_SLOTS = 1`, BF `shared/queue/slot-sets.ts`), in `electron/crucible/lanes.ts`.
- **No lane at all** for cloud calls (`anthropic/…`) and claude -p. Today they take the 1-slot AI pool (M/ai-manager.service.ts:1723), which serialises cloud work behind local work for no reason.
- **CPU work** (ffmpeg, TitaNet, key phrases, the Python audio steps) stays off the lanes.

### 13.2 Admission and parking

| step | rule |
|---|---|
| Venue | If the item is pinned **fast**, it goes to `fastServer`. Otherwise it goes to the first enabled, reachable server in rank order (BF `venue-decision.ts`) that has the needed model installed or pullable and, after 1.0.24, fits at the run's context (§7.2). |
| Preflight | `activity().slots.accelerated.acceptsWork` is read every 15 s per enabled server. This is display and preflight, never permission. |
| Refusal | `409 server_busy` / `leased` at submit, or a load refused for free VRAM (Owen using the PC for something else), means **park**: the row gets status `parked` with the holder's sentence (`CrucibleBusy.busyLine`), the lane is released, and the next job is tried. A parked row is re-admitted when the preflight says `acceptsWork`, or, if it is not pinned and `newJobsWaitFor === 'any'`, when another enabled server can take it. It is **never** resubmitted in a loop. |
| Failure | A step fails only on misconfiguration: bad token, unknown model, upstream without a key, or a prompt over the loaded context. |

**A typed contract across IPC** (Law 10). `generate-metadata` returns `{status:'parked', server, holderLine, stage}` rather than throwing a message the renderer would have to parse. `JobQueueService` gains `status:'parked'`, `venue`, `fast: boolean`, `parkedLine`, and a persisted `resumeFrom: 'transcribe'|'chapters'|'fields'`. The saved-transcript sidecar already makes a resumed job skip ASR.

### 13.3 The job lease and model grouping

- **One lease per job per local model**, taken before the first chat and released in the job's `finally` (ttl 120 s, heartbeat 40 s). This replaces `JobModelLifecycle`. A heartbeat answered `unknown_lease` fails the stage loudly: the run is unprotected.
- **Order within a job.** ASR → snap (9B, `decide`) → detail and fields on the chapters/titles model (27B) → any field routed to another local model (for example tags on the 9B, only on chapterless items where tags are model-written). The fields are ordered by model where dependencies allow (thumbnail needs titles).
- **Stage-major runs** keep today's two-stage run: **Transcribe only** loads whisper once for the batch; **Send held** loads the 27B once. With P8, add a middle "Chapter" stage (the 9B once), in the same held-flow pattern.
- **Concurrency.** One running job **per server** (the Mac and the PC in parallel), not one globally. The first cut (P3) keeps one global, and per-server comes in P3b.

### 13.4 Ledger and sweep

- **Ledger.** `<userData>/crucible-in-flight.json` (BF `in-flight-ledger.ts`) is written synchronously right after every `submit()` and lease, as `{server, kind, id, model, jobId, lastEventId, at}`.
- **Startup.** The sweep is **awaited** in `app.whenReady` (main.ts:156) before IPC handlers accept `generate-metadata`. It cancels our jobs, releases our leases, and unloads only what we alone loaded (`cardHeldBy`).
- **Quit.** `before-quit` (main.ts:293) runs the same sweep under a 30 s deadline, after giving in-flight runs ~2 s to release their own leases (§0a: a lease granted after quit began is in no ledger row).
- **Interrupt.** Every CLI that leases (§20) cancels its jobs and releases its leases on SIGINT/SIGTERM before exiting (§0a).
- **Dropped stream.** Sweep that server.
- **Renderer.** Its reset of `processing` to `pending` on reload (job-queue.ts:65-71) already matches: a job cut off by a restart re-runs from its `resumeFrom` stage.

### 13.5 Watchdogs

- The 30-minute AI-pool watchdog and the chapter stage's 4 h cap (M/metadata-generator.service.ts:1498) become **stall** watchdogs: 10 min with no SSE event, no completed chat, and no decide answer (BF `stream-stall.ts`). The wall clock is not the measure.
- Cancel aborts the open chat/decide fetch, `cancel(jobId)` on the open ASR or denoise job, and releases the lease.

---

## 14. Settings UI and queue UI

- **Servers pane** (new, in `CS/frontend/src/app/components/settings/`):
  - registry rows with version, backend, reach, resident model and masked token;
  - Test, Running/Paused, rank (drag), Forget;
  - "Fast server" (a single select);
  - Add server (connect code / pairing), this machine's connect code, and the doors (adopt/install/start);
  - **Keys**: an Anthropic key per server (Test → Save; only `keyHint` is ever shown), plus "copy my key to <server>".
  - The OpenAI and Ollama-host fields are **removed**, and so are the API-key fields in Settings.
- **Routing dialog** (`model-routing-dialog`):
  - each option shows its Crucible id and, per server, installed / pullable (Download → a pull task) / does not fit here (the server's sentence);
  - *Briefcase note:* Owen asked that a model the server cannot run **not be listed at all** (§0a). Consider showing only installed/pullable options per venue, and replacing a stored routing the venue cannot run with the server's pick, rather than listing it disabled;
  - `claude -p` options are marked "outside Crucible";
  - the per-field grid is unchanged (M/metadata-routing.ts:275).
  - A new **Stories/Episodes** row is *not* added: they follow `chapters` (§0 #8).
- **Queue rows** (the inputs page):
  - a **Fast** toggle per row and in the add-to-queue controls;
  - the status line shows `parked — busy: bookforge, tts 62% done` in grey, not red;
  - a lanes strip shows one chip per server with state, resident model and a Running/Paused switch.
  - **The inputs page was declared off-limits in the 2026-08-31 UI campaign.** This touches it, and needs Owen's go (§21).
- **Editor:**
  - the Stories model picker is removed;
  - the Denoise toggle reads "needs a Crucible with voice isolation" from `capability()` instead of `voice-separator-env` (editor-ipc.ts:1311, editor-host.ts:594, project-setup-modal.component.ts:379).

---

## 15. Removing Ollama, whisper.cpp and voice-separator-env (P10)

These are deleted only after their replacements pass acceptance:

| what | where |
|---|---|
| Ollama transport, probes, settings | `askOllamaPlain` transport, M/ollama-json.ts (the sizing rules go too), `makeOllamaRequest`, `ollamaClient`, IPC `check-ollama`/`get-available-models`/`ollama:list-models`, E/ollama-service.ts, `setup.sh:61-73` (`ollama pull cogito:70b`), the `ollama` package.json keyword, the test CLI's "ollama serve" prerequisite (scripts/generate-metadata-cli.js:49) |
| whisper.cpp | CS/electron/lib/bridges/whisper-bridge.ts, `whisper-engine` and `whisper-*` model components (CS/electron/components/catalog.ts:27-39, :71-104), `scripts/download-whisper-cpp.js`, `download-all.sh`'s whisper steps, the editor's model resolution (E/binary-resolver.ts:236-270) and `--whisper-bin/--whisper-model` in transcribe.py |
| voice-separator-env | the E/asset-catalog.ts:123 entry (`autocut-separator-env-*` tarballs), `getVoiceSeparatorEnvDir` (E/binary-resolver.ts:401-411), `separate_chunk`/`run_audio_separator.py` |
| SDKs | `@anthropic-ai/sdk` stays **only if** claude -p needs nothing from it: the CLI's `--claude-cli` shim constructs `Anthropic` (generate-metadata-cli.js:422). Move that shim to the transport seam and drop the SDK. `openai` goes. |

A grep test (`tools/check-legacy-runtime-gone.js`) asserts that nothing imports `ollama-service`, `ollama-json`, `whisper-bridge` or `openai`, or contains `11434` or `api/generate`.

---

## 16. The phases

Every phase ends with `npm run build:all` green, `npm run check:pure` green, the new `npm run check:crucible` green, and the app launched. **Owen's go-ahead is required before any phase's live GPU acceptance run (Law 7).**

**P1: SDK, registry, probe, Servers pane, fake harness.** *Can start now.*
- **Files:** vendor + adopt script (§3.1); `electron/crucible/{servers,routing,pairing-file,discovery,auto-connect,connect,connect-code,probe,engine-resolve,crucible-words}.ts`; the IPC block; the Servers pane (read/test/pause/rank/add, and `fastServer`); `tools/fake-crucible.js`.
- **Tests:** registry atomic write + masking; pairing-file paths; auto-connect only into an empty registry; probe's five outcomes; the engine hop once; connect code round-trip; the vendored version equals the pin.
- **Done when:** on the Mac, `mac` appears within 5 s with 1.0.23/mlx-darwin; adding owens-pc by connect code works; with Crucible stopped the app boots and everything non-AI works, with no unhandled rejections.

**P2: every LLM call through Crucible (act `analysis`).** *Can start now.*
- **Files:** `electron/crucible/{transport,lease,engine-settings,catalog}.ts`; `ai-manager.service.ts` (the `claude:`/`ollama:`/`openai:` branches → transport; init pings removed; `PROVIDER_DEFAULTS` deleted); `plain-call.ts` (transport removed); metadata-tasks, description-unit, chapter-whole-transcript, rewrite-pass, more-titles and metadata-generator call sites (§6.3); `metadata-routing.ts` (`crucibleModel`, `catalogInventory`); the key migration (§6.6); the settings bridge; `model-lifecycle.ts` → lease; the per-server act selection (§6.4); `generate-metadata-cli.js` with `--server`, and `--claude-cli` re-seated on the transport seam (LEDGER #158 semantics kept).
- **Budgets and context in P2 are today's.** On the PC, calls over 16,384 **refuse** until P4.
- **Tests (fake):**
  - the captured body per row of §6.3: `thinking` always present, **no temperature/top_p/top_k in any `anthropic/` body**, `max_tokens` 16000 to anthropic, the act header;
  - `model_not_resident` → one re-ensure;
  - `upstream_unconfigured` gives a clear error;
  - 429 passes through;
  - over-context throws before sending;
  - cancel aborts the fetch and releases the lease;
  - key migration writes, checks the hint and deletes, keeps the file on failure, never writes remote, and stops on a differing existing key;
  - the act check against `capability.py`.
- **Done when:** 3 reference videos run end to end on the Mac with the default routing (27B local, Sonnet available) and the reports match today's shape. `claude -p` still works. `api-keys.json` is gone and Claude still works. One compilation runs on `anthropic/claude-sonnet-5` (§6.3 JSON).

**P3: queue admission, parking, fast, ledger and sweep.** *Can start now.*
- **Files:** `lanes.ts`, `venue-decision.ts`, `in-flight-{ledger,sweep}.ts`, `stream-{reconnect,stall}.ts`; `queue-manager.service.ts` (`queueAITask` → lanes; the dead helpers deleted); `job-queue.ts` + `inputs.ts` (`parked`, `fast`, `resumeFrom`); main.ts startup and quit sweep; the lanes strip.
- **P3b:** one running job per server.
- **Tests (fake timers):**
  - 409 → parked → re-admitted once `acceptsWork`, with no resubmit loop;
  - a fast-pinned item waits for the PC and never goes to the Mac;
  - an unpinned item goes to the other server when `newJobsWaitFor:'any'`;
  - the ledger is written before anything else;
  - the startup sweep is awaited;
  - the quit deadline holds;
  - another client's lease is never unloaded;
  - cloud calls run while the GPU lane is busy.
- **Done when:** with BookForge narrating on the Mac, a ContentStudio job parks with BookForge's sentence and starts by itself afterwards; a fast job runs on the PC, and parks when the PC's card is taken; `kill -9` mid-run and relaunch leaves no ContentStudio lease in `crucible api activity`.

**P4: low context.** *The measurement and the digest switch can start now. The capability-query sizing waits for 1.0.24.*
- **Files:** `chapter-digest.ts` input policy; the budgets (§7.2); the windowed name scaffold; the compilation chunk size; the per-call context check wired to `models()`; `generate-metadata-cli.js --field-input`.
- **Tests:** the digest policy per item kind; a chapterless over-ceiling item still fails with both facts; the window union of the name scaffold.
- **Done when:** the §7.4 A/B is recorded, Owen's verdict is in, and the default is set by that verdict. On the PC, every call of a 60-minute video fits under 16,384 (a log assertion). After 1.0.24, the lane queries `capability?context_tokens=`.

**P5: ASR on Crucible (pipeline, then editor).** *Can start now.* On the Mac it is turbo; on the PC it is large-v3 until N4.
- **Files:** `electron/crucible/asr.ts`; `whisper.service.ts` → asr; transcribe.py request protocol + word reader; python-service handling `asr_request`; sidecar model naming.
- **Tests:** `transcript.json` → SRT (overlaps, empties, over 10 h); params are exactly `{language, vad_filter:false, word_timestamps}`; progress mapping; cancel → DELETE; a failed job fails the item with the server's message; the loop-region round trip.
- **Done when:**
  - The **proper-noun check** (with vs without the seed) is recorded. If it regresses, P5 waits for N2.
  - Speaker-tagging validation passes on Crucible transcripts.
  - The **word-timing measurement (§8.3)** is recorded, and the editor switches only on Owen's acceptance.
  - Wall time is recorded, Mac and PC.

**P6: key phrases in-process.** *Can start now.* It has no Crucible dependency.
- **Files:** `key-phrases.ts` (ONNX, whole-video centroid, frequency path deleted); catalog component; `asarUnpack`.
- **Tests:** chunking and weighted mean; a missing component throws; the parity harness.
- **Done when:** the §12 parity table is shown to Owen and accepted.

**P7: voice isolation on Crucible.** *Waits for the vocals manifest (just after 1.0.24).*
- **Files:** `electron/crucible/denoise.ts`; the `separation_request` protocol in voice_separation.py and electron_workflow.py; the editor toggle reads capability.
- **Tests:** a 44.1 kHz input is asserted; stem path round trip; a failed job aborts the run; a busy lane parks with the holder line.
- **Done when:** one real session's mic tracks are isolated through Crucible, and the stem is compared by ear and by null-test against today's env output on the same chunks.

**P8: chaptering on snap.** *P8a (the pure port against the fake's `/v1/decide`) can start now. P8b (live) waits for 1.0.24 on the server that runs it; on the Mac it also needs the logprobs patch.*
- **Files:** `M/chaptering/*` (§10.3); prompts into `chapters.yml`; `transport.decide`; `metadata-generator` wiring behind a declared `chapterEngine: 'snap'|'whole-transcript'` setting; `story:analyze-chapters` / `story:suggest-title` rewired; `analyze-transcript-split` → `episodes`; the episode splitter's dead code, `chapter-splitter.ts`'s analyzer and editor model picker deleted.
- **Tests:** key prefixing keeps letter order; Viterbi fixtures ported from Briefcase; ad confirm/reject; the two-level outline; `decide_not_served` → a loud refusal naming the server; `label_not_in_probs` → the unit recorded as skipped (until N7).
- **Done when:** the §10.5 acceptance passes, on the PC first and then on the Mac. Stories and Episodes are eyeballed by Owen on one livestream each.

**P9: re-roll gate and title ranking.** *After P8.* §11. Done when the gate's pass/fail agrees with Owen on 50 hand-labelled titles and chapter titles, and title ranking agrees with the 177 decided A/B tests above chance by a margin set with Owen.

**P10: removal.** *After P5 (whisper.cpp), P7 (voice-separator-env), P8 (Ollama, since editor Stories are its last user).* §15. Done when a clean install downloads no Ollama, whisper.cpp or separator env, and the grep test is green. Add a one-time **retired-file cleanup** for existing installs (the app's own whisper models and separator env; never Ollama's store), with a dry run and an opt-out, as Briefcase did (§0a).

**Act cutover.** No separate phase. When each server reports `generate`, §6.4 starts sending it. The only follow-up is to delete the `analysis` branch once both servers run ≥ 1.0.24.

---

## 17. The test harness: `CS/tools/fake-crucible.js`

Copy BF `tools/fake-crucible.js` (`startFakeCrucible`, `leaseRoutes`, `settingsRoutes`,
`faultyJobRoutes`). It is a real `http.Server` on an ephemeral port, and it already stubs
`electron` the way `CS/tools/_electron-stub.js` does. ContentStudio adds:

- `POST /v1/decide` in the PHASE22 wire shape (objects keyed by name, `label_mass`, `decide_not_served`, `label_not_in_probs`);
- `asr` artifacts with `words`;
- a `denoise` job returning a stem;
- `capability()` rows with and without `generate`;
- `models()` rows carrying `max_model_len`.

Faults are injected with `fake.inject(...)`: `serverBusy(holder)`, `leased`, `chatQueueFull(retryAfter)`,
`modelNotResident`, `upstreamUnconfigured`, `unknownAct`, `status429`, `dropAfterBytes`,
`stallSseForMs`, `apiVersion2`. `fake.requests` records every body, so a test can assert "no
temperature to anthropic".

The keepers are `tools/test-crucible-*.js`, run by a new `npm run check:crucible`. They cover
registry, routing, pairing-file, connect-code, probe, transport, lease, lanes, in-flight-ledger,
quit-sweep, stall-clock, asr, denoise, decide-wire, acts and key-migration.

**Live checks** (by hand, with Owen's go): `tools/crucible-live-smoke.js` against `mac` and against
`owens-pc` runs ping, one tiny `anthropic/` chat, a 9B load+chat+release, a 30 s asr, and one decide.

---

## 18. Risks

| risk | what could happen | handling |
|---|---|---|
| Quality from the digest default | Titles and descriptions lose specifics the raw transcript carried | The §7.4 A/B gate. The default switches only on Owen's verdict. |
| ASR without the filename seed | Proper nouns regress ("Jake Lane") | The P5 gate. Ask for N2. No unseeded shipping on regression. |
| Editor word timings | Cuts land off by frames | The §8.3 measurement. whisper.cpp stays the editor engine until it is accepted. |
| PC context 16,384 | Local calls refused on the PC | P4 brings every call under it. Refusal is loud and names both numbers. |
| Owen's own PC GPU use | Fast jobs never start | Park with the server's sentence. The fast pin is visible, so Owen can unpin. Nothing loops. |
| Another app's lease (BookForge narrating for hours) | ContentStudio waits | By design (park with the holder). Pause or rank to route around it. Lane reservation across acts is a Crucible item (N9). |
| 1.0.23 ↔ 1.0.24 servers | Wrong act refused | Per-server detection (§6.4). |
| Decide on the Mac before the logprobs patch | Snap unavailable | Loud refusal by name. The chapter engine setting stays on whole-transcript. |
| Anthropic JSON via forced tool plus default thinking | The compilation package fails | P2 acceptance run. N6. |
| Cloud through a shared server's key | Overwriting another app's key | Hint check and ask (§6.6). |
| Upload over the tailnet (audio for ASR/denoise on the PC) | Slow start | FLAC for ASR. Denoise chunks ~95 MB. Measured in P5 and P7. |
| A crash mid-job | An orphan holds the lane | Ledger + startup sweep awaited (§13.4). |

---

## 19. What ContentStudio needs from Crucible (priority order)

1. **N1: 1.0.24, cut and deployed on both servers** (already requested):
   - the single **`generate`** class, with `GET /v1/capability?context_tokens=&concurrency=`;
   - the **decide door** and `decide` class, with SDK `decide()`;
   - the **mlx-lm logprobs patch** (26 options on the Mac).

   P4's sizing, P8b and the act cutover wait on it.
2. **N2: `initial_prompt` on `asr`** (vocabulary seeding). ContentStudio measured its value on 2026-08-24 (whisper-bridge.ts:130). It gates P5 if the proper-noun check regresses.
3. **N3: the `vocals` denoise manifest** (already requested), plus a way to install `denoise` **without the full `rvc` env**, or a ruling that the rvc env is the price. P7 waits on the manifest.
4. **N4: a `faster-whisper-large-v3-turbo` manifest** for cuda-linux, so turbo runs "wherever possible" on the PC too.
5. **N5: a client-stated load context.** `load-model` taking `context_tokens` (vLLM `--max-model-len`), or a per-server setting. Today the loaded context is the manifest's (PC 27B at 16,384, Mac 27B at 98,304), and the 1.0.24 capability query tells ContentStudio what *fits*, not what the engine is *started* with.
6. **N6: the Anthropic upstream.** Forward an explicit `thinking` (adaptive), and state how a forced-tool `json_schema` combines with it. The compilation package depends on it.
7. **N7: `missing_labels: "floor"` on decide** (shared with Briefcase A3). Viterbi needs a finite log P for every option.
8. **N8: `Retry-After` and `details` on SDK `chat()`**, so ContentStudio need not raw-fetch.
9. **N9: a lane reservation across acts** (BookForge's owed item). One job's ASR → decide → generate would then not be interleaved by another client.
10. **N10: the `contentstudio` module** (§3.4). This is ContentStudio's own PR to C `modules/`.

**Status, checked in C at `v1.0.32` (2026-09-24):**

- **N1 delivered** in 1.0.24: `generate`, `capability?context_tokens=&concurrency=`, `/v1/decide` + SDK `decide()`, and the mlx-lm patch (`top_logprobs` 40).
- **N2 delivered** for whisper (`initial_prompt`, 1.0.24). Under #203 Qwen takes `context` instead (≤1,024 tokens; `initial_prompt` is refused on Qwen), so the filename-title seed goes in `context`.
- **N3:** `vocals-roformer` shipped in 1.0.24. `denoise` is still served by the `rvc` env (`workerenv.JOB_TYPES_SERVED_BY_ENV`), so the second half is still owed or ruled.
- **N4 delivered, then superseded:** the turbo manifest landed in 1.0.24, and 1.0.29 made `whisper-large-v3-turbo` one id on both backends. Moot under #203.
- **N5 delivered** in 1.0.24: `load-model` takes `params.context`, refused `context_over_limit` above the host ceiling in `capability()`.
- **N7 answered differently:** `missing: 'report'` (null + `missingLabels`); the floor is the client's declared rule (§0a).
- **N6, N8, N9, N10:** not checked here; N10 is ContentStudio's own PR, and its subjects must use the 1.0.29 ids (§3.4).

**Not requested:** an embeddings route. CPU-sized models stay local by Owen's rule.

**Dependency on 1.0.24.**

- **Can start now:** P1, P2 (act `analysis`), P3, P4 (measurement and digest switch), P5 (Mac turbo; PC large-v3), P6, P8a.
- **Must wait:** P4's capability-query sizing, P7 (the vocals manifest right after 1.0.24), P8b, P9, P10's Ollama part.

---

## 20. Offline tooling

| tool | today | after |
|---|---|---|
| `scripts/generate-metadata-cli.js` | real pipeline; Ollama + Anthropic; `--claude-cli` patches `makeClaudeRequest` | the **real Crucible path** from the app's own registry (real-userdata shim), plus `--server <name>`, `--field-input raw\|digest`, and `--chapter-engine`. `--claude-cli` is kept and moved to the transport seam: every `anthropic/` call becomes `claude -p --model sonnet` (LEDGER #158). |
| `prompt-harness/run.js` | direct Anthropic/Ollama | drives the compiled `transport.ts` against a named server. It keeps its own `--claude-cli`, and nothing is reimplemented. |
| `tools/prompt-tune/` | builds prompts, `score.py` scores | unchanged (no model calls) |
| `scripts/validate-speaker-tagging.js` | production code | unchanged. Re-run in P5. |

---

## 21. Open questions and contradictions found

**Resolved by Owen 2026-09-23 and written into LEDGER.md:** 1 (Law 3 amended: the re-roll gate is its one declared exception), 2 (Law 6 amended to the granularity-setting wording), 3 (the 9B writes outlines and scores; the 27B writes final chapter titles and summaries; #199), 5 (the digest default replaces the old rule once its A/B passes; #196), and 6 (the editor is unfrozen for this migration; #202). LEDGER entries #193–#202 are appended in the "Crucible migration" section. **Still open:** 4 (sharing the snap TypeScript), 7 (the inputs page), and 8–13 (code fixes that phases P4–P10 carry).

1. **Law 3 (no re-asks) vs the re-roll gate (§11).** Law 3 says "NO RE-ASKS … the fact that it's re-asking is a programmed in bug". Owen's 2026-09-23 decision re-rolls up to 3 times. The proposed ledger entry scopes it as a *declared repeat-ask design*, as #159's consensus sampling was. Owen should confirm that it amends Law 3 for this gate only.
2. **Law 6's "count is the model's, never computed in code".** The outline length is the model's, but Viterbi's switch cost (a code constant, the grain dial) decides how many outline items survive as chapters. It needs an amendment: "timestamps from sentence units; items from the model; boundaries from the probabilities; the switch cost is a declared, measured constant."
3. **Chapters "capable rungs only (no 9B)"** (LEDGER Models & routing) vs the 9B writing the snap outline (§0 #18). The measured setup says 9B; the ledger rule says otherwise. Owen picks.
4. **Sharing the snap TypeScript.** Copy-with-parity-check (this plan) vs a shared package used by Briefcase and ContentStudio.
5. **LEDGER 2026-08-23: "pass the whole thing in … if summaries, then in the form of chapters".** The digest default is consistent with the second half and supersedes the first. It needs a ledger entry once the A/B passes.
6. **G4 (the editor is FROZEN)** vs retiring the Stories analyzer, and the transcribe and denoise protocol changes. Owen's 2026-09-23 instruction is the unfreeze; record it.
7. **The inputs page was off-limits** in the 2026-08-31 UI campaign, and the queue changes (§14) live there.
8. **The key-phrase document truncation** (M/key-phrases.ts:73) is an undeclared cut today (Law 8). Fixed in P6.
9. **A stale default:** `ChapterGrain`'s comment says `'detailed'` is the default (M/chapter-prompts.ts:21), but the generator defaults to `'broad'` (M/metadata-generator.service.ts:1475).
10. **Stale comments:** `LOCAL_FIELD_NUM_PREDICT`'s comment (M/metadata-tasks.ts:489-496) says `think:false` "is not an option". Every unit now sends it. It goes with the budget change in P4.
11. **Law 2 violation today:** `E/chapter-splitter.ts` authors prompts inline (:344-1101). They are deleted in P8; `story:suggest-title`'s prompt moves to `assets/prompts/`.
12. **Law 1 violations today:** whisper-bridge.ts:89 substitutes `base` for an invalid model name with a warning; `PROVIDER_DEFAULTS` supplies models silently. Both are deleted by this plan.
13. **Default whisper setting `'small'`** (main.ts:186, IPC:1093) vs the ledger's large-v3-turbo. It is moot after P5, but wrong until then.
14. **Automatic hand-off between servers** (added 2026-09-24). §0 #15, §4's `newJobsWaitFor` and §13.2 send an unpinned parked item to the other server. Owen ruled the opposite for Briefcase: *"it should never randomly hand a gpu job to another server"*; work moves only when the user switches servers. Does the same hold here, leaving the fast pin as the only way work reaches the PC?
15. **`qwen3-asr-1.7b` or its `-mlx` port on the Mac** (added 2026-09-24). The port is ~2.5x faster but keeps fewer fillers; #203 chose Qwen for its fillers. Proposed: the official id for the editor (cut-by-word) and the pipeline alike, unless Owen wants the port for pipeline-only transcripts.

---

## 22. LEDGER.md entries (APPENDED 2026-09-23 as #193–#202, with Owen's rulings folded in; LEDGER.md is authoritative, and the drafts below are kept for history)

**193. All AI moves onto Crucible; claude -p stays outside (Owen, 2026-09-23).** Every model call (the Anthropic SDK, Ollama, `askOllamaPlain`, the editor's ollama-service, whisper.cpp pipeline and editor, and voice isolation) goes through Crucible, one server per machine at :7100, the same as BookForge, Foundry and Briefcase. `claude-cli:` stays in `makeRequest`, in the routing table and in the test CLI as an outside-Crucible test transport. The routing table stays the source of model choice, each option mapped to a Crucible id. Acts: `generate` for every generation call and `decide` for snap. `analysis` is sent to a server that predates 1.0.24, detected per server. [CRUCIBLE-MIGRATION-PLAN.md §0, §6]

**194. Keys live in Crucible, not the app (Owen, 2026-09-23).** `api-keys.json` is migrated to the local server's settings (the hint is checked, then the file is deleted). Keys are never pushed to a remote server without an explicit action. `openai:` is removed. No sampling parameter is ever sent to a cloud upstream. [§6.6]

**195. Two servers, park on busy, fast is a pin (Owen, 2026-09-23).** The Mac is the default and owens-pc is "fast". A busy or leased card parks the item with the holder's sentence. It never interrupts, never loops, and never falls back to CPU. One GPU lane per server, a lease per job per model, and a ledger with a startup and quit sweep. [§13]

**196. Low context by default (Owen, 2026-09-23; gated).** Every local call targets ≤12–16k tokens. After chapters, the field calls read the chapter digest instead of the raw transcript, **once the full-vs-digest A/B on Owen's videos passes**. This supersedes the "pass the whole thing in" half of the 2026-08-23 rule. A call over the loaded context refuses before sending and is never truncated. [§7]

**197. CPU-sized models stay local (Owen, 2026-09-23).** TitaNet is unchanged. nomic-embed-text moves in-process (ONNX) with a whole-video centroid, replacing the silent 20k-char document cut. The frequency fallback is deleted (Law 1; supersedes #107). [§12]

**198. ASR on Crucible, large-v3-turbo wherever a manifest exists (Owen, 2026-09-23).** This covers the pipeline and the editor. The editor's word timings are adopted only after the whisper.cpp comparison. Unseeded transcription (no `initial_prompt`) ships only if the proper-noun check shows no regression. [§8]

**199. Chaptering at a chosen granularity on snap (Owen, 2026-09-23).** OUTLINE + ASSIGN + Viterbi (switch cost 20 measured best on YTSeg: F1@±1 0.72, Pk 0.21–0.23) replaces stage 1 of the fifth architecture once it beats it on Owen's published chapter lists. One service serves metadata chapters, editor Stories (broad: "just chapters for a livestream") and episode splitting (the coarsest). The Stories analyzer, the episode splitter's dead path and their prompts are deleted. Titles and summaries stay on `summarize_chapter`. It amends Law 6: timestamps come from sentence units, items from the model, and boundaries from probabilities under a declared switch cost. [§10]

**200. Voice isolation is a Crucible denoise job (Owen, 2026-09-23).** It uses the vocals manifest, at 44.1 kHz, one chunk per job. Chunking and silent-chunk skipping stay client-side. voice-separator-env is removed after acceptance. [§9]

**201. Re-roll gate (Owen, 2026-09-23; later phase).** Snap yes/no rule checks, at most 3 re-rolls with the reason passed back, the best attempt kept, and delivered flagged after that, never blocked. It is a declared repeat-ask design scoped to this gate, and it amends Law 3 for it alone. Title ranking is validated against the 177 decided A/B tests before use. [§11]
