# The routing's server: picking the Crucible server in Model routing (LEDGER #222)

Owen, 2026-09-26: "we can pick which crucible server we use (wsl or mac) in model routing."

Before this, the model routing dialog chose a MODEL for each field. The SERVER a job ran on
was chosen in Settings › Crucible Servers (the selected server, #205), and the per-item Fast
pin sent an item to the fast server instead (#195). Now the routing can name a server too.

## What was built

**Stored with the routing.** `metadataRouting.server` is a registered server's name, kept
beside the field selections (`ROUTING_SERVER_KEY` in `electron/services/metadata/metadata-routing.ts`).
Unset means the server Settings has selected, so a routing saved before this key existed
changes nothing.

- Saved through `metadata-routing:set`: `validateRoutingSelections(selections, registered)`
  refuses a name the registry does not have, naming it and the registry (Law 1).
- Read at venue time: `readStoredRoutingServer(store, registered)`. If the server has been
  forgotten in Settings since the routing was saved, it is dropped back to unset. The store
  is rewritten without it (the fields stay) and one warn line is logged:
  `dropped metadataRouting.server = "pc": that Crucible server is no longer registered ...`.
  `migrateStoredRouting(stored, registered)` does the same for the dialog's read.
- `resolveMetadataRouting` resolves models only and skips the `server` entry.
- `describeRouting(routing, server)` ends `, server=<name>` or `, server=(the selected server)`.

**One rule, one place.** In `electron/crucible/venue-decision.ts`, `intendedVenue(fast, host)`
returns `{server, because}`:

1. pinned fast → the fast server (`the fast pin`);
2. otherwise the routing names a server → that server (`the routing's server`);
3. otherwise → the selected server (`the selected server`).

`intendedServer` and `decideVenue` both go through it. `VenueHost` gained `routingServer()`.
`lanes.ts` passes it in through `LanesDeps.routingServer` and decides nothing about it. The
lanes get it from `createCrucibleContext({ routingServer })`, which is required: main.ts reads
the store, and a CLI or keeper passes `() => null`. `runJob` reads the routing server once per
admission. A paused or unreachable routing server PARKS the job with the existing sentences,
exactly as the selected server does. Nothing moves to another server by itself.
`plan()` treats a changed routing server the way it treats a changed Select: a parked job
that has not started goes where the routing now says.

**The log says it.** `[crucible] <job> admitted to "pc" (the routing's server), from transcribe`.
The job's routing line (`[IPC] Metadata routing for this job: ...`) names the server too.

**A job never spans servers.** Transcription reads the job's venue through `currentJobVenue()`
(`asr-venue.ts`, unchanged), so it follows automatically. So do chapters, scrub, gate and the
field calls, which all run on the lane. An UPSTREAM (cloud) call takes no lane. Inside a job it
now goes to `upstreamServerFor(routingServer, servers)`: the routing server the job was
admitted with, else the selected server. The step hooks carry `routingServer` for this. With
no routing server, this is exactly what happened before (plan §0 #20). The Fast pin does not
move cloud calls.

**Not metadata jobs, left as they were.**
- The editor's transcription (no queue job, so the selected server through `asr-venue.ts`).
- The episode splitter (`analyze-transcript-split`, `gpuVenue()` outside a job → selected).
- Standalone model calls outside a job: the editor's story title, and the reports page's
  "more titles" and "soften". These use `lanes.standaloneServer` → selected.

**The metadata CLI.** `scripts/generate-metadata-cli.js --server <name>` is now the CLI's
spelling of the routing's server, for that run only. The CLI calls `intendedVenue(false, ...)`
with `routingServer = --server ?? the stored routing's server` (judged against the registry;
if the stored server was forgotten, a `ROUTING:` line is printed and the store is left for the
app to rewrite). It hands the result to `openCliLanes({ server })`, the existing override,
only when the answer is not the selected server. The banner says why:
`crucible: pc (the routing's server)`.

**The dialog.** `model-routing-dialog` has a "Runs on" row above the field rows. The first
choice is "The selected server (<name>)". After it come the registered servers, from the
`crucible:servers` view the Settings pane draws. Each one shows its reach word from the pane's
own probe (at most 15 s old), or "Paused". Picking a server calls
`metadata-routing:get({server, selections})`. Main validates that preview exactly like a save
and judges the on-screen selections against that server's catalog. Nothing is written, and
the field selections are never changed by the pick. The options are always judged against
the server the jobs would run on: the routing's server, else the selected one.

**Settings stays the registry.** Add, test, pause, forget, keys, Fast and Select are
unchanged. `crucible:servers` carries `routingServer`. When it is set, the pane shows one
line under "Server ContentStudio uses": *Model routing sends metadata jobs to "pc", which
overrides this selection for them (a Fast item still goes to the fast server).*

## Checks

- `tools/test-crucible-routing-server.js` (in `check:crucible`) runs against the fake with
  two servers:
  - A routing that names the second server gets its plan, admission and load-model there,
    and the admission line matches exactly.
  - Transcription, the job venue and an upstream call inside that job all land on that server.
  - With routing unset, the job goes to the selected server.
  - The Fast pin wins over a routing server.
  - A paused routing server parks the job and never moves it.
  - A forgotten routing server is dropped once, the store is rewritten, and the job goes to
    the selected server.
  - Changing the routing server moves a parked job.
- `tools/routing-publish-checks.js` (`check:pure`) covers:
  - save validation (refused by name);
  - model resolution that ignores `server`;
  - migration drops (and carrying the entry through for model-only readers);
  - `readStoredRoutingServer` saying its line once;
  - the view's `runsOn`.

## HANDOFF

- **Not live-tested.** Only the build, the checks and the fake Crucible have run this. Owen
  does the testing.
- **Standalone calls stay on the selected server.** These are "more titles" and "soften" on
  the reports page, and the editor's story title. The reports page's pickers list options
  judged against the routing's server (they read the same `metadata-routing:get` payload), so
  with a routing server set, what they list and where they run can differ. If Owen wants these
  calls to follow the routing server, the place to change is `lanes.standaloneServer` /
  `gpuVenue()`. It needs his ruling, because the story title is an editor call.
- **Cloud calls inside a job follow the routing server.** A routing server without an
  Anthropic key refuses a cloud-routed field by name, as the selected server would. The
  dialog already says "has no Anthropic key" for that server.
- The CLI does not rewrite the store when it drops a forgotten routing server. The app does
  that on its next read.
- No LEDGER entry other than #222 was edited.

# Models, not quants: the job's server picks the build (2026-09-29)

Owen, 2026-09-29, after the dialog said "qwen3.8-27b-8bit.toml has no cuda-linux block ... Pick a
model this server offers" for a routing whose "Runs on" was the PC's WSL Crucible: "crucible's job
is to select the model quant that works for the system we're using. wsl uses 4 bit, mac uses 8
bit. it doenst need to tell the user that." And: "theres only one quant available on mac, one
available on pc. we can retrieve the quant by listing the available model on each crucible
server. content studio shouldnt request a model that isnt available on a crucible server."

## The option table names models

`METADATA_ROUTING_OPTIONS` rows are `MetadataRoutingOptionDef`: `kind`, `label` (never a bit
width), `crucibleIds` (a FIXED, reviewed list of the Crucible ids the option stands for) and
`cliModel` (the `claude -p` rungs only). No row carries a model id a caller could send.

| Option | Label | Candidate Crucible ids |
|---|---|---|
| `qwen38-27b` | Qwen 3.8 · 27B | `qwen3.8-27b-8bit`, `qwen3.8-27b-4bit` |
| `qwen35-9b` | Qwen 3.5 · 9B | `qwen3.5-9b` |
| `qwen35-4b` | Qwen 3.5 · 4B | `qwen3.5-4b` |
| `sonnet5` / `opus5` / `haiku45` | Claude … | their one `anthropic/` id |
| `claude-cli` / `claude-cli-sonnet` | claude -p … | none (`claude-cli:opus` / `claude-cli:sonnet`) |

`qwen38-27b` keeps the old 4-bit option's id, so a stored `qwen38-27b` keeps its row and now
resolves per server. The old 8-bit option `qwen38-27b-8bit` is gone from the table and listed in
`MERGED_ROUTING_OPTIONS`: `migrateStoredRouting` rewrites a stored one to `qwen38-27b` with one
logged line (`rewrote metadataRouting.<task> = "qwen38-27b-8bit" as "qwen38-27b": ...`), and the
dialog's read writes the store back so the line is said once. The modal's strict save still
refuses the old id. `SUMMARIZATION_MODEL` (a quant id) became `SUMMARIZATION_OPTION = 'qwen38-27b'`.

## Resolution: one function, the dialog and every run

`resolveLocalOption(option, inventory)` reads the candidates against one server's catalog
(`catalog.ts` `inventoryOf`: a catalog row is backend-supported; `installed` says whether its
weights are there). A candidate is runnable when it is installed there.

- exactly one runnable: that id is what the option means on this server;
- none: the option is not on that server, `pullable` when a candidate could be downloaded there,
  else `not-here`. The sentence is plain: `Qwen 3.8 · 27B is not on "wsl".`;
- more than one: `ambiguous`, refused by name (`"mac" holds more than one build of Qwen 3.8 · 27B
  (qwen3.8-27b-8bit, qwen3.8-27b-4bit), and ContentStudio does not pick between them.`). Owen
  says each server holds exactly one; if that changes, he decides;
- the catalog could not be read: `unknown`, with the reason (never `not-here`).

The server's own "not supported" sentence (the manifest's missing backend block) is never shown.

**The dialog** (`buildRoutingView` → `optionAvailability`) judges every option this way against
the server the routing's jobs run on. A resolved option shows `installed` and its view's `model`
is the build it runs as; nothing is said about quants. The row note for a chosen option the server
cannot run is "<note> <row> won't run until you pick a model this server offers." A new
availability value, `ambiguous`, is flagged "more than one build on <server>".

**A run** binds through `RoutingModels` (metadata-routing.ts), built ONCE at the start of each
job from the job's server's catalog (`routing-models.ts` `readRoutingModels`: the server is
`lanes.gpuVenue()`, the admitted job's venue inside a job, else the routing's server / the
selected one; the catalog is read with `lanes.inventoryFor`). It is cached for the job and every
routed option is bound from it: `models.bind(task, optionId)` returns a `MetadataRoutingOption`
whose `model` / `crucibleModel` is the resolved id. A refusal is `RoutedModelUnavailableError`
(`routed_model_not_here` / `routed_model_ambiguous` / `routed_model_unknown`), thrown when the job
uses the option, before anything is loaded or sent:
`The Thumbnail words row is set to Qwen 3.8 · 27B, and nothing was sent: Qwen 3.8 · 27B is not on
"wsl". Nothing was substituted; pick a model this server offers in Model routing.`
Each local option is logged once per job: `[MetadataRouting] the metadata job <id>: Qwen 3.8 ·
27B → qwen3.8-27b-4bit on "wsl"`. A job whose options are all cloud or `claude -p` reads no
catalog. Upstream (Claude) options bind to their one id without the catalog (their key is the
upstream server's, which the transport checks), `claude -p` to its CLI string.

Where the binding happens (every place a routed option becomes the id sent to Crucible):

- the metadata job (`MetadataGeneratorService.generate` sets `params.routingModels` at its start):
  field units and the description (`planMetadataUnits`), chapters (snap titles and
  whole-transcript), the scrub, the re-roll gate's re-rolls, the guidelines distiller, the
  compilation package and summarizer (now resolved inside the job), and the thumbnail words
  (`ThumbnailJobDoors.models`);
- the reports page: re-roll a field (and its cleanup), 10 more titles, soften, the cleanup
  button, and the Thumbnails window's words / prepare / screenshots (`report-thumbnails.ts`);
- the editor: stories analysis, story titles and the routed-model line (`story-ipc.ts`);
- the in-queue split binds nothing: it writes no titles (`resolveSnapBoundaryModels`), so a
  chapters model its server lacks cannot refuse it.

The fixed roles `CHAPTER_SCORER_MODEL` and `REROLL_SCORER_MODEL` (`qwen3.5-9b`, one id on every
backend) are unchanged.

## Checks

- `tools/routing-publish-checks.js` (`check:pure`): the 27B option and its candidates, no label
  naming a quant; the Mac-like catalog binds the 8-bit and WSL-like the 4-bit, logged once per
  option; none runnable refused by name in the run and shown plainly in the dialog (pullable and
  unreadable catalogs too); two runnable refused by name (`ambiguous`, dialog and run); the dialog
  for WSL shows the 27B installed with no "cuda-linux" sentence anywhere; the 8-bit migration
  rewritten, logged, read clean the second time.
- `tools/test-crucible-snap.js`: over the real transport and lanes against the fake, the job's
  resolution read from the fake's own catalog; a Mac-like server loads and sends
  `qwen3.8-27b-8bit` and never the 4-bit; a server with no build refuses the chapters row by name
  with no job submitted and no chat sent.
- `tools/test-crucible-transport.js`: the local call sites bound from the fake's catalog; every
  chat body on the wire carries the resolved id.
- `tools/thumbnail-pipeline-checks.js`: the words bound from the fake's catalog; a row whose model
  the server lacks stops the words stage with the resolution's sentence.
- `tools/test-crucible-acts.js`, `tools/test-crucible-p4.js`, `tools/reroll-checks.js` updated to
  the option shape.
