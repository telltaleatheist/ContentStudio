# Stable Item IDs + Reports-Delete-Through-IPC — Design (awaiting approval)

Drafted 2026-08-21 by an Opus design agent from a read-only scan of the codebase and the
live data (111 report files in /Volumes/Callisto/ContentStudio/.contentstudio/metadata,
44 selection files in userData/publish/selections). Status: PROPOSED — not yet built.

## 1. Current state

Report files: `<outputDirectory>/.contentstudio/metadata/<jobId>.json`. Keys on disk:
`job_id, job_name, prompt_set, created_at, status, txt_folder, items[], original_inputs[],
input_types[]`. There is NO item id, NO per-item txt path, and NO `txt_files` key on any
file on disk. Text output goes to `<outputDirectory>/<cleanJobName>/<sanitized title>.txt`
(output-handler.service.ts:140-143), and that path is returned once and never persisted.
Publish selections: `userData/publish/selections/<jobId>.json` keyed by stringified
itemIndex (publish-store.service.ts:87-133); all 44 live files key only `"0"`.

Identity today:
- Job: `job-<epochMs>-<9 base36>` minted in the RENDERER (job-queue.ts:78); validated end
  to end everywhere it crosses IPC.
- Item: positional index into `items[]` — minted nowhere, validated nowhere, and used as
  the join key across four independently-compacting arrays (`items`, `original_inputs`,
  `input_types`, selections map). 16 of 111 live files already violate the
  `original_inputs.length === items.length` invariant that generated-index.ts:40-46
  depends on (5 compilations, 11 zero-item failed jobs).

Deletion today is three unrelated paths:
- A. Reports page (metadata-reports.ts:558-656): the RENDERER does the filesystem surgery
  over generic channels — `delete-directory` (fs.rm recursive+force), then a renderer-side
  read-modify-write of the job JSON that bypasses OutputHandlerService's serializing
  writeQueue, then an in-memory renumber. Never touches selections, `original_inputs`,
  or `txt_folder`.
- B. History page → `delete-job-history` (ipc-handlers.ts:1479-1594): main-owned, clears
  selections, rm -rfs `job.txt_folder`, unlinks the JSON.
- C. Queue → sessionStorage only.

## 2. Problems (each with the user action that triggers it)

- **P1 — Every Reports-page deletion orphans its text file, always.** `txtFilePath` is
  populated only from `jobData.txt_files[index]`, which exists on zero files — so the
  branch never runs and the .txt survives forever.
- **P2 — DATA LOSS, LIVE: deleting one report can destroy another report's text output.**
  `txt_folder` derives from the job name, so every regeneration of the same source shares
  one folder — 7 live folders are shared by 2–7 jobs (`4 - satanism`: 7 jobs). History-page
  delete rm -rfs the whole folder, deleting the other jobs' text output with it.
- **P3 — A failed JSON write leaves the UI silently showing the wrong item's metadata**:
  the in-memory renumber runs even when the disk write failed.
- **P4 — Deleting a mid-job item re-points every publish selection above it** (selections
  are index-keyed and never renumbered). Dormant today (all live jobs have ≤1 item);
  goes live the moment jobs get a second item or a second index consumer (calendar,
  uploader).
- **P5 — Reports-page delete never clears selections**: chosen titles/overrides/videoId
  survive pointing at a dead item, and are served to the extension.
- **P6 — Regeneration produces a stranger**: same source regenerated up to 7× in live
  data, each run a new jobId — nothing connects run 7 to run 1, so Phase-1 state
  (schedule, thumbnail, channel, podcast flag) would be lost on every regenerate.
- **P7 — The renderer holds an unbounded recursive-delete primitive** (`delete-directory`,
  any path, force:true — "already gone" reports success).
- **P8 — Reports-page delete splices `items[]` but not `original_inputs`/`input_types`**,
  permanently breaking filename-based draft matching for the whole job.

## 3. Proposed schema — two identifiers, two questions

Publish-pipeline state splits cleanly: per-RUN state (chosen A/B titles, desc/tag
overrides — meaningless outside this run's title list) vs per-VIDEO state (publishAt,
thumbnail, podcast flag, transcript link, channel, videoId — must survive regeneration).
One id cannot serve both without silent wrong data.

### 3.1 `item_id` — primary key
- Format `itm-<epochMs base36>-<8 base36>` (filename-safe, passes the existing
  `^[A-Za-z0-9._-]+$` guard, time-sortable, matches the job-id convention).
- Minted in the MAIN process in `OutputHandlerService.writeItemToJob` — the single,
  already-serialized point where an item first exists on disk.
- Stored on the item in the report file (not a sidecar). Written alongside it in the same
  operation: `txt_path` (absolute path of the .txt actually written — closes P1/P2) and
  `source_key` (below). Job file gains `schema_version: 2`.
- Guarantees: unique, immutable, position/filename/title/job-independent, validated at
  every IPC boundary, NOT content-derived.

### 3.2 `source_key` — the regeneration join
- Recorded at generation time (never derived on read): file inputs →
  `normalizeForMatch(basename)` (the same normalization video-matcher already uses);
  text subjects → explicit null. `source_path` recorded too, for display.
- A HINT driving an explicit operator action, never an implicit join: on opening an item
  whose source_key matches an earlier item carrying pipeline state, the UI offers
  "carry that forward?" — one click, logged. No silent inheritance.

### 3.3 Publish state moves to `userData/publish/selections/items/<itemId>.json`
One file per item; `jobId` demoted to a display back-reference; Phase-1 fields
(publishAt, thumbnailPath, isPodcast, transcriptRef, channelId) live on the same record.
Delete is one unlink; renumbering becomes impossible to express.

### 3.4 Migration — retro-fit once, idempotently, loudly (no dual-path readers, ever)
- Runs lazily on the first successful read of the reports directory (NOT at boot —
  outputDirectory is an external volume; an unmounted Callisto must not produce
  "0 reports migrated").
- Per file: skip if schema_version >= 2; mint missing item_ids; resolve txt_path by
  matching sanitized `_title` against `txt_folder` (record null when no unambiguous
  match — a stated fact, never a guess); derive source_key only when the arrays align,
  else null. Write tmp + rename.
- Selections: `<jobId>.json` key k → `items/<itemId>.json`; unresolvable files are MOVED
  to `selections/orphaned/`, not deleted, and counted.
- Emits an operator-visible receipt; any failed file is named and reported unreadable.
- After migration, readers REQUIRE item_id; absence = corrupt file, reported as such.
- Live data makes this deterministic: 100×1-item files, 11×0-item, zero multi-item; all
  44 selection files key "0"; zero orphans.

## 4. Reports-delete-through-IPC

One channel, one main-process transaction, one receipt:
`reports-delete-item(jobId, itemId) → DeleteReceipt` (throws on failure). No paths cross
the IPC boundary as inputs. Implemented as `OutputHandlerService.deleteItem` on the same
writeQueue as item writes.

Ordering & failure semantics:
1. Resolve — missing job or item throws (no force, no "already gone is success"; this is
   deliberately different from delete-job-history's bulk `alreadyGone`).
2. Unlink `item.txt_path`; legacy items with no recorded path → receipt says
   `txtDeleted: false, txtReason: 'no path recorded'`. NEVER delete `txt_folder` (P2).
3. Report file atomically: splice item + aligned `original_inputs`/`input_types` entries
   (when aligned; else leave and say so). tmp + rename. Empty job → unlink the job file,
   and remove txt_folder only if empty after step 2.
4. Unlink the item's selection file; failure throws, naming the leftover path.
5. Receipt: `{ jobId, itemId, jobFileDeleted, txtDeleted, txtReason?, selectionDeleted,
   txtFolderRemoved }`.

Renderer: `deleteReport` becomes one call + `loadReports()` (re-read from disk); the
renderer-side JSON surgery and in-memory renumber are deleted (kills P3).
`delete-directory` loses its only caller and is removed (kills P7). `delete-job-history`
is corrected in the same PR: per-item txt_path unlinks instead of rm -rf on the shared
txt_folder (kills P2), item-keyed selection clearing.

## 5. Alternatives rejected

- Harden (jobId, itemIndex) with lockstep renumbering: every new consumer is a new silent
  corruption site; cannot express P6 at all.
- Source-path hash as the single id: text subjects have no path; 7 regenerations collapse
  to one identity; archive-sync moves files and silently changes the id. Kept only as the
  source_key hint.
- Content hash: collides on identical output; changes on edit — not immutable.
- UUIDv4: correct but not time-sortable or eye-attributable; repo convention already
  chose ts+rand.
- SQLite: real transactions, out of scope — the report file's portability is load-bearing
  for the index reader and the extension.

## 6. Implementation order

- **PR A — identity + migration + delete** (self-contained; publish wire untouched):
  new `item-identity.ts` (mintItemId/isItemId/sourceKeyOf/SCHEMA_VERSION); output-handler
  mints + records txt_path/source_key; generator passes source fields (and writes
  `_is_compilation` explicitly on both branches); `report-migration.ts` (lazy, receipted);
  `OutputHandlerService.deleteItem`; register `reports-delete-item`; remove
  `delete-directory`; fix `delete-job-history` (P2); frontend `deleteReport` rewrite.
- **PR B — repoint publish to item_id** (mechanical, wide): selections/items store,
  publish-types/ipc/bridge/video-matcher/ingest-server + extension client on itemId; an
  itemIndex-shaped request is rejected naming the required extension version, not
  translated.
- **PR C — Phase 1 fields** on ChosenMetadata + the source_key carry-forward prompt.

Verification that matters: with two report files sharing a txt_folder (live shape:
`4 - satanism`, 7 jobs), delete one item and assert the sibling's .txt still exists —
fails under today's delete-job-history, which is the point.
