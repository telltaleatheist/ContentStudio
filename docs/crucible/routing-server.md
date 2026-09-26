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
