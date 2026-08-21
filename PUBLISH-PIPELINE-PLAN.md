# Publish Pipeline Plan

Status: **approved** (operator signed off 2026-08-21) · Written 2026-08-21 by cs-advisor-mac with operator (Owen), from read-only scouting by contentstudio-mac-2 and contentstudio-mac-3 (switchboard channel `content-studio-fix`).

## Which docs are authoritative

`PROJECT_OVERVIEW.md`, `README.md`, `QUICKSTART.md`, and `SETUP_STATUS.md` are unmodified since the initial commit (2025-10-30) and describe a pre-Angular app called "LaunchPad" that no longer exists. **Do not build against them.** Current: this doc, `AB-TEST-PLAN.md`, `CHAPTERING.md`, `EDITOR-PORT-PLAN.md`, and the code itself. Refreshing `PROJECT_OVERVIEW.md` is a task in Phase 0.

## Team structure

- **contentstudio-mac-2 — implementation lead.** Keeps the main checkout at `/Volumes/Callisto/Projects/ContentStudio`. Only writer to that tree.
- **contentstudio-mac-3 — collaboration/advisory + reviews.** Relocates to a `git worktree` before doing anything else (own offer, seq 4). Reads freely; writes only in its worktree.
- **cs-advisor-mac — advisory.** Holds long-term project context and reviews designs.

Workflow: branch + PR to `main`, as this repo already does. The lead posts **important design decisions and genuine forks in the road** to the channel for feedback before committing to them — sparingly; routine progress does not get posted. When unsure of the best solution, ask the channel. No ack-only messages.

## Decisions already settled (do not re-litigate)

1. **API is the primary publish path for new videos**; the browser extension fills only what the API cannot set (monetization, A/B test titles, Studio-only fields) and remains the path for already-uploaded/legacy videos. Extension fills stay operator-clicked — no Studio automation (ToS).
2. **YouTube API audit**: operator approved applying. File it at the **start** of work (weeks of lead time). Until it is granted, API-uploaded videos may be locked private — verify with a throwaway test upload before trusting scheduled publishing.
3. **OAuth**: the existing grant already carries the full read-write `youtube` scope for all three channels (`youtube-auth.service.ts:43`). Tokens stored on the Mac: approved.
4. **Delete-during-sync**: deletes queue behind syncs instead of refusing (details in Phase 0a).
5. **Spreaker**: one account, one podcast — its own unit, not tied to a channel. Mostly Fireside content but pulls from all channels ⇒ model as a per-project **"publish as podcast" flag**, independent of channel routing.
6. **Channel routing**: the prompt set the operator picks per video determines the target channel (Unfiltered / Owen Morgan / Fireside Chat).
7. **No-fallbacks rule applies throughout**: no silent fallbacks, fail loudly. Several existing violations are scheduled for removal below.

## Phase 0a — archive delete/sync fix (the reported bug)

Symptom: deleting an archive week while a sync ran threw a guard error wrapped in Electron's `Error invoking remote method` prefix; deletes show no progress and no success feedback.

Verified mechanics: the local delete's own guard is already correctly path-scoped (`editor-ipc.ts:2131-2140`); what globalizes the refusal is `ArchiveSync.check()`'s single shared process slot (`archive-sync.ts:723-725`, reason at :721-722) — a process-slot limitation, not data safety. The remote delete's blanket `sync.busy` guard (`editor-ipc.ts:1981`) IS data safety (rsync `--inplace` into the archive vs. `rm` from it).

Work:
1. Make the dry-run check and the delete **first-class queued jobs in the existing ArchiveSync queue**, so they serialize with syncs. The local path-specific guard then works as written; unrelated-week deletes no longer refuse.
2. **Keep** the remote delete's blanket guard, and keep all guards as fail-loud backstops.
3. **Progress is mandatory, not cosmetic**: a queued delete silent for minutes of SMB walking reads as a hang. Emit progress events (`deleteArchiveTree` already counts `filesRemoved` internally, `editor-ipc.ts:180`); reuse the queue's `archive:progress`/`archive:complete` plumbing; show queued/running/done state in the sidebar row.
4. Surface completion: the handlers already return `{deleted, removedProjects, …}` — stop discarding it (`archive.service.ts:510-516`); show an inline summary or toast (the editor window currently has no toast surface — add one or use the inline row).
5. Strip the `Error invoking remote method '…':` prefix from IPC rejections in the adapter (only `model-routing-dialog.ts:275-280` does this today).
6. Disable the delete ✕ with a tooltip when the action would genuinely refuse (remote delete during sync).

### Phase 0a settled design (channel seqs 20-23, approved by advisor seq 22)

**Ordering — deletes are NOT plain FIFO.** Putting deletes on the tail of the queue would
replace an immediate loud refusal with a silent wait behind a whole week batch (one job per
day plus the week, each a multi-thousand-file SMB walk) — hours, not minutes. That is a
regression, not a fix. Deletes and their dry-run checks **insert ahead of pending syncs and
never interrupt the running job**; syncs keep FIFO among themselves. This is safe because the
real hazard is rsync writing INTO the archive while `rm` runs against it, and only ONE rsync
ever runs (`current` is a single reservation) — pending jobs touch nothing. Exclusion against
the RUNNING transfer is therefore the true constraint, which makes the remote delete's blanket
`sync.busy` guard over-broad even for the remote case.

**Same-path is a semantic conflict, not a timing one.** Deleting week X while a sync of week X
is pending would let the delete succeed and the pending push then resurrect it — the exact
failure class this plan exists to remove, arriving by a new route. Keep the local handler's
path-scoped guard (`editor-ipc.ts:2131-2140`, running + pending at-or-under the target) and
give the REMOTE delete the same path-scoped guard in place of its blanket `sync.busy`.
Same-path deletes refuse loudly until the operator cancels the pending sync; unrelated-path
deletes wait for at most the in-flight transfer.

**Request-response over a fire-and-forget queue.** `enqueue()` reports outcomes through
`emitComplete` events and nothing awaits a result, but `check()` and both delete handlers are
awaited by their IPC handlers and must return a value or throw. So `QueueJob` grows an **op
discriminant** (`sync` | `check` | `delete-local` | `delete-remote`) and a **deferred result
channel**, and `drain()`/`executeJob` dispatch on it instead of always spawning an rsync push.
Correlation ids over events were considered and rejected as worse.

**Four traps in the existing invariants** (found by contentstudio-mac-3, seq 21 — all four are
"the queue was built for one operation type and grows a second"):

1. *Head of the pending list is not index 0.* `drain()` reads `this.queue[0]`, awaits it, and
   only then `shift()`s, so the running job sits at index 0 for its whole life. A naive
   `unshift` puts the delete underneath it and the next `shift()` silently eats the delete
   instead of the finished sync. Move the running job out of the array rather than writing
   that arithmetic at a call site.
2. *Dedupe is by `localPath` alone* (`enqueue` :460-470), so a delete of a path with a queued
   sync would be silently swallowed and reported as accepted-with-no-id. The key must become
   (`localPath`, `op`), and the "ignored rather than added twice" comment needs rewriting —
   for deletes, ignoring is not honest behaviour.
3. *Resurrection*, as above — addressed by the path-scoped guards.
4. *The `archive-gone` branch bypasses `runJob`* (`drain()` :507-520 splices the queue and
   reports dropped jobs straight through `emitComplete`). Deferred promises dropped there
   would never settle, hanging an awaiting IPC handler forever — worse than today's wrapped
   rejection, and invisible. That branch must settle every deferred it drops.

5. *The reentrancy deadlock* (found in implementation, not review). Both delete handlers
   re-verify with a dry run before removing anything. Once the delete is itself a queued job,
   a call to the public `check()` waits for a slot the delete is ALREADY HOLDING — a permanent
   deadlock with no error, no timeout, and nothing in a log: the operator sees a button that
   never comes back, which is indistinguishable from the bug being fixed. `runExclusive` hands
   its body a context whose `check` runs the dry run directly, bypassing the queue; the public
   `check()` is a thin wrapper around the same private routine. Not avoidable by care — it
   falls out of making a request-response operation reentrant into the queue that serializes it.

**`killCheck` arbitration goes away.** Once `check()` is queued it can no longer overlap a
transfer, so the "a real transfer always wins" arbitration (`archive-sync.ts:717-719`, :545)
is dead weight; keep `killCheck` for cancellation only and remove the arbitration path in the
same diff, relocating the explanatory comment to the queue so the file does not explain a
mechanism it no longer has.

**Latent invariant to comment, not to fix** (seq 23): the path-scoped guard is complete only
because both delete handlers are week-granular, so every queued job is at-or-under the target.
A day-level delete added later would make `isAtOrUnder(day, pendingWeek)` false and the pending
week sync would push the day back. Name the invariant in a comment while Phase 0a is in that
code.

**Verified live** (2026-08-21, fixture weeks against real rsync and the real SMB share;
14/14). The two that were unknowable statically: a delete of week X asked for 2.5 s into an
unrelated 2 GB sync of week Y **waited 23.2 s and then ran** rather than refusing — the
reported bug — with `sync.transferring` asserted false from inside the body, so the
serialization is real and not merely apparent; and the delete's re-verification through
`ctx.check` **completed**, which is the deadlock in trap 5 not happening.

The result worth keeping longest is a NEGATIVE control. With a sync of X queued,
`syncsWritingUnder(destinationFor(X))` found it (1) while `jobsUnder(destinationFor(X))`
found nothing (0) — so the source-side guard, which is what a careless reading of "refuse
same-path syncs" produces, would have been a guard that never fires. A test that only shows
the code doing what it does is worth much less than one that shows the alternative failing.

Not covered by that run, and still owed: the IPC handlers' own guards, the entire renderer
half, the remote delete's destructive path (`deleteArchiveTree`, the leftovers case, the SSH
fallback), and any real contention for the mount.

## Phase 0b — publish-selection integrity + metadata delete hygiene

The strongest scouting find: **deleting one item from a multi-item report silently corrupts publish state three ways** — `deleteReport` (`metadata-reports.ts:502`) splices `jobData.items`/`txt_files` and renumbers its own rows (:549-570), but:
1. `selections/<jobId>.json` is keyed by `itemIndex` and is never renumbered — every A/B choice above the deleted index re-points to the wrong item. Click order IS variant order; variant 1 is YouTube's inconclusive-test fallback.
2. `original_inputs`/`input_types` are NOT spliced, so their length disagrees with `items` forever — `sourceFilenameOf` (`generated-index.ts:41-47`) then returns `null` for EVERY item in the job, and `video-matcher.ts:115` downgrades the whole job to manual video picking, silently and permanently.
3. The damage was thought undetectable (that `null` is identical to a healthy compilation job's) but is not: `_is_compilation: true` is written at generation time (`metadata-generator.service.ts:398`) and survives — `generated-index.ts` just never reads it. Caveat: the flag is absent-not-false on individual items, so any gate must test `=== true`.

Root cause, named by both scouts: `itemIndex` is a positional key doing the job of a durable identity across four stores that compact independently (`items`, `txt_files`, `original_inputs`/`input_types`, `selections/<jobId>.json`).

Work:
1. **SETTLED at plan level**: give items a stable per-item id minted at generation time and key selections (and any future consumer — calendar, uploader) by it. This makes all three corruption modes structurally impossible instead of each needing its own renumbering pass. Includes a migration for existing positionally-keyed reports/selections. Post the schema design to the channel before building it.
1b. **Damage scan: DONE** (2026-08-21, contentstudio-mac-3, operator-approved read-only scan of the configured output dir + selections store): **zero splice damage**. 109 job files, none multi-item (98×1, 11×0/failed), 0 out-of-range or orphaned selections; all 16 length mismatches explained (5 genuine compilations, 11 failed jobs). The stable-id change in (1) is therefore **prevention, not repair** — still worth doing before the calendar/uploader add consumers of itemIndex, but it gates nothing.
1c. Hardening that falls out of the scan: write `_is_compilation` explicitly on BOTH generation branches (today: true or absent); have `sourceFilenameOf` read it instead of inferring from array lengths. Also: `deleteReport`'s `txt_files` splice (`metadata-reports.ts:535`) is dead — no job file on disk has that key; remove it.
1d. **SETTLED** (seq 15): one-job-per-input is deliberate (`inputs.ts:541-545`, individual mode calls `addJob` once per input with a one-element array; compilation mode yields one item). A multi-item job file is unreachable from the current UI, so the positional-key family is dormant **by construction** — but the backend's individual branch already loops `addItemToJob` per item, exercised by nothing, so one plausible refactor (batching individual mode into a single job file) would activate every corruption mode at once. That is why (1) is in the plan as prevention.
2. Wire `clearJob` (`publish-store.service.ts:225`, currently zero call sites) into job deletion so selections are not orphaned.
3. Reconcile the three independent delete paths (queue = sessionStorage only, `job-queue.ts:97`; history = disk only, `history.ts:127`; reports = direct FS from renderer): one delete should leave no store stale.
4. Kill the four silent-swallow sites: `prompts.ts:184-196` (success:false ignored), `history.ts:132-141` (clear-all silent no-op), `metadata-reports.ts:511` and `:545→:578` (failures warned, success reported anyway).
5. Delete dead code `saveJobMetadata` (`output-handler.service.ts:202`) rather than fixing it.
6. No-fallbacks cleanup: make `jobId` required (drop `params.jobId || 'metadata-job'` at `ipc-handlers.ts:905` and the optional-with-mint signatures); remove the silent `loadReportsLegacy` fallback (`metadata-reports.ts:271-275`) and the `job_id || filename` fallback (~:296) — fail loudly instead.
7. Refresh `PROJECT_OVERVIEW.md` to describe the actual app (Electron + Angular 20 + Python subprocess; editor window; publish feature; extension).

## Phase 1 — data model

Extend `ChosenMetadata` / project records with: target channel (derived from chosen prompt set, overridable), scheduled release date/time (`publishAt`), linked thumbnail image file, "publish as podcast" flag, linked transcript reference. Notes: `features/publish/` already exists as the single seam (five-state `PublishStatus`, per-item store, generic `publishSetFields` IPC) — scheduling is a new field + status transition, **not** a new subsystem. Thumbnail is greenfield as image work (all current "thumbnail" code is the text field).

## Phase 2 — transcript reuse

Whisper runs once per video. Persist held transcripts to disk (`heldTranscripts` map in `ipc-handlers.ts` is in-memory only — does not survive restart) and link transcripts to editor stories/projects so title/metadata generation reuses them. Trimmed/cleaned stories drifting from original timestamps is acceptable for generation purposes.

## Phase 3 — YouTube API uploader

- Upload video (`videos.insert`, resumable), set title/description/tags/category/playlist, `thumbnails.set`, `selfDeclaredMadeForKids`, privacy `private` + `publishAt` for scheduling. Per-channel via the existing three OAuth grants.
- "Upload to YouTube" button attaches in the metadata-report detail pane (where `publish.clear()` is already wired, `html:140`).
- **Quota** (verified against Google docs 2026-08-21; matches `AB-TEST-PLAN.md:75-78`): `videos.insert` has its OWN bucket, 100 calls/day at 1 unit per call — upload volume is a non-issue at this scale. `videos.update` = 50 and `thumbnails.set` = 50 units from the shared 10,000/day pool. (An earlier draft of this plan said 1600 units per upload against the shared pool, ~6 uploads/day; that was the superseded model and is withdrawn.)
- **CONSTRAINT — `videos.update` REPLACES the whole submitted part.** Omitted mutable fields are CLEARED, and a `snippet` update requires `snippet.title` + `snippet.categoryId`. Every metadata write to an existing video must be read-modify-write. Build the API client that way from the first call — a naive `videos.update` carrying only a title wipes the description and tags off a live video.
- **Audit gate** — until Google grants the audit, test uploads may be locked private; verify before relying on scheduling. The existing `youtube-api.service.ts` client is read-only today (all call sites GET) — upload is new code but auth is done.

## Phase 4 — metadata report redesign + calendar

Rework `metadata-reports` UI with the `frontend-design` skill. The **calendar** lives here: shows each video's scheduled date per channel; scheduling a video on a date sets its `publishAt`. Note: `status.publishAt` is settable only while a video is **private and never-published** — the calendar must distinguish re-schedulable rows (private + `publishAt`) from published ones and must not offer scheduling on the latter. If A/B testing turns out to be unavailable on scheduled-private videos (operator is checking whether Studio renders the control), the calendar also needs an **A/B-pending** state for videos awaiting their publish time. Respect the Phase 0b identity fix. Data-loading note for the redesign: `loadReports` re-reads and re-parses every job JSON in the renderer on every mount/refresh — fix while in there (cache or move to main process).

## Phase 5 — browser-extension fill-ins

Monetization status and any Studio-only fields become new entries in the extension's fillers registry (`extension/src/publish/fillers.ts` — designed for exactly this: "one new entry rather than surgery on the panel"). Operator-clicked, never automated.

## Phase 6 — Spreaker podcast upload

New integration: Spreaker API (OAuth2, episode upload endpoint), single account/show. Projects flagged "publish as podcast" get an upload action. Metadata from the existing `podcast-spreaker.yml` prompt set.

## Ordering

0a → 0b → 1 → 2 → 3 → 4 → 5 → 6, except: **file the YouTube audit application during Phase 0** (lead time), and 2 can run parallel to 3 if useful. Each phase lands as its own PR(s) with before/after review.
