# Editor Extraction Plan — AutoCutStudio → ContentStudio

The timeline editor moves out of AutoCutStudio (ACS) and into ContentStudio (CS) as a
second BrowserWindow opened from a new "Editor" tab in CS's left nav. ACS is left
untouched and will be retired; nothing in CS may reference the ACS checkout at runtime.
Relinking (ACS's asset-relinking page) moves INSIDE the editor as a File → Relink modal.

This document is the contract between the two implementation agents. Where it pins a
name or a shape, both sides implement exactly that. Where it is silent, ACS behavior is
the spec — port verbatim, including comments.

## Cardinal rules

- **No fallbacks.** A fallback is an unexpected code path in production, i.e. a
  deliberate bug. Fail loudly naming the specific missing thing. Never substitute
  silently. (This is the user's own standing rule.)
- Port, don't rewrite. ACS's editor code is battle-tested; keep its logic, comments,
  and error messages. Adapt only what the new host requires (paths, DI, IPC plumbing).
- Keep ACS channel/event names verbatim wherever they don't collide with an existing
  CS channel. Collisions and resolutions are listed below.
- ACS repo (read-only reference): `/Volumes/Callisto/Projects/AutoCutStudioApp`

## What already happened (done, do not redo)

- `editor-backend/` now holds APFS clones from ACS: `cli/`, `core/` (Python source,
  committed), `binaries/`, `python/`, `utilities/` (gitignored runtimes: ffmpeg,
  ffprobe, auto-editor, whisper-cli + dylibs, ggml models, portable CPython).
- `config/` now holds `autostudio_config.yaml`, `drift_corrections.json`,
  `projects.json` (projects.json gitignored — user data).
- Branch: `feat/editor-extraction`.

## Key facts from the mapping reports

**Editor frontend** (`ACS frontend/src/app/components/editor/`): fully self-contained
behind the `EditorHost` port (`editor-host.ts`, injected via `EDITOR_HOST` token).
NgModule-based, `standalone: false`, needs only CommonModule + FormsModule + rxjs.
No Material, no third-party deps, no global CSS/theme dependency (ships its own
hardcoded dark FCP palette, `:host { position: fixed; inset: 0 }` — owns the whole
viewport). Dependency closure outside the folder is exactly three files, all
dependency-free except one edge (`workflow-payload` → `types`):
`models/editor-manifest.ts`, `models/types.ts`, `services/workflow-payload.ts`.
Media playback = DOM `<video>/<audio>` pointed at `file://` URLs (needs
`webSecurity: false` or equivalent in the editor window; ACS windows allow it).
localStorage keys used: split positions, ollama model choice, `editor.recentSessions`.

**ACS window model**: `WindowService.createEditorWindow('/editor')` — single reused
secondary BrowserWindow, 1600×900 min 1200×700, deliberately NOT a child window,
loads `file://…#/editor` (ACS uses hash routing). Payload delivery is push+pull:
main parks `pendingEditorPayload`; pushes `editor-payload` on `did-finish-load`;
editor also pulls via `editor:get-payload` on mount. Blank open clears the slot.

**Backend surface** (all line refs = ACS `electron/ipc/ipc-handlers.ts` unless noted):
- Editor session/manifest: `editor:open` (:568), `editor:get-payload` (:627),
  `editor:manifest` (:633) → `PythonService.editorManifest()` → `cli/editor_manifest.py`.
- Edit state (pure Node fs): `editor:load-edits`/`editor:save-edits` (atomic
  tmp+rename)/`editor:clear-session-state` (:743-811). Sidecars live beside the zip:
  `<session>_edits.json`, `<session>_transcript.json`.
- Export: `editor:export` (:645-728, heavy payload validation) →
  `PythonService.editorExport()` → `cli/editor_export.py` (JSON on stdin).
- Transcription: `editor:transcribe`/`editor:transcribe-cancel`/`editor:transcript-load`
  (:819-905) → `PythonService.transcribe()` → `cli/transcribe.py
  --zip --whisper-bin --whisper-model --ffmpeg` (whisper.cpp, word-level, SIGTERM =
  clean cancel). Events `transcribe-progress`, `transcribe-complete` to event.sender.
- Story analysis: `ollama:list-models`, `story:analyze-chapters`, `story:suggest-title`,
  `story:cancel`, `story:unload-model`, event `story:analyze-progress` (:258-342) →
  `chapter-splitter.ts` (1165 l, deps: electron-log only) + `ollama-service.ts` (fetch,
  default 127.0.0.1:11434, unloads model in finally).
- Peaks: `alignment:extract-peaks` (:1001) → `alignment-audio-service.ts` (ffmpeg
  f32le pipe decode; PEAK_SAMPLE_RATE 8000).
- Files/dialogs: `select-file` (:1078), `select-directory` (:1099), `check-file-exists`
  (:1170), `show-in-folder` (:1148), `read-directory` (:2393), `getPathForFile` =
  preload-side `webUtils.getPathForFile` (no IPC).
- Projects: `projects:read-registry` (strict version 1, never self-heals),
  `projects:write-registry` (atomic), `projects:scan-folder` (:3335-3515). Registry
  file: `<configDir>/projects.json`.
- Processing: `auto-detect-audio` (:1245, pure regex), `assets:list` (:1039 →
  asset-manager; editor uses it ONLY for the Denoise gate = `voice-separator-env`
  installed), `execute-workflow` (:1553 → `cli/electron_workflow.py`, stdin kept open
  for Dugan ducking_request protocol → `dugan-automixer.ts`), `cancel-job`,
  `send-skip-signal` (SIGUSR1).
- Archive: `archive:status/connect/sync/cancel/check/destination`, events
  `archive:progress/complete/queue` (:154-248) → `archive-sync.ts` (rsync, one at a
  time, exit 0/23/24 = success, `stopArchiveSyncOnQuit()` MUST be called from quit).
  Store keys `archiveRoot` (default `/Volumes/iO/FCPX`), `archiveMountUrl`
  (default `smb://titan.local/iO`), read fresh on every call.
- Titles handoff: `titles:send-subjects` (:462-533) validates the whole batch before
  parking, parks in `pendingHandoffs`, pushes WHOLE queue on `titles:subjects` to main
  window, focuses it; `titles:take-pending` drains once. Chapters ride along for the
  saved report only — never model input.
- `PythonService` spawn pattern: `spawn(pythonPath, [script, ...], { env:
  binaryResolver.getPythonEnv(), cwd: resourcesPath })`, line-buffered JSON-per-line
  stdout. `getPythonEnv()` sets PYTHONUNBUFFERED, PYTHONPATH, AUTOCUT_CONFIG_DIR, PATH.
- `binary-resolver.ts` resolution chains (managed env → bundled → system). Strip the
  hardcoded conda and `/Applications/AutoCutStudio.app` fallbacks — in CS the chain is
  managed env → `editor-backend/<kind>/<platform-arch>/` → throw naming the path.
- `shared-paths.ts`: cross-app shared asset base `~/Library/Application Support/
  OwenMorgan` (env override `OWENMORGAN_SHARED_DIR`). Port it — if ACS's managed
  components (e.g. voice-separator-env) live there, CS sees them for free. Verify
  where `asset-manager.ts` actually stores installs and preserve that location.

**Relinking** (`ACS frontend/src/app/components/relinking/`): asset relinking — 16
hardcoded overlay PNGs (backgrounds/borders) persisted to `autostudio_config.yaml`
`paths.assets.*`, consumed by the Python compound generators. One external import
(ElectronService), 6 IPC calls, no Python, no shared state. 8 `alert()/confirm()`
calls to replace with inline modal state. SCSS consumes ~50 global `var(--*)` — must
be re-themed to the editor's hardcoded dark palette. `search-files-recursive`
(:1179-1242) is synchronous in main — make it async during the port.

**CS side**:
- Angular 20.3 standalone, zone-based with `eventCoalescing: true`, history routing
  (`provideRouter(routes)`, no hash), prod `baseHref: "./"`, `loadFile()` + Cmd+R
  interceptor in main.ts. `isolatedModules: true` (watch `export type`).
- Nav = hand-written `mat-nav-list` in `frontend/src/app/app.html`; shell state in
  `app.ts` (signals, console ring buffer).
- One BrowserWindow only; `sendToRenderer()` in `electron/ipc/ipc-handlers.ts:148`
  targets `getAllWindows()[0]` — MUST become window-aware before the second window.
- Preload: flat object exposed as `window.launchpad` (contextIsolation true,
  nodeIntegration false, sandbox false); typed by hand in THREE places (preload.ts,
  `frontend/src/app/services/electron.ts` declare-global, and its class methods).
- IPC precedent for a new module: `electron/services/publish/publish-ipc.ts`
  (`setupPublishIpc(...)` called from setupIpcHandlers). Error idiom for new
  handlers: result envelope `{ success: false, error }` — EXCEPT where the editor
  port contract expects a rejection; the editor expects REJECT with verbatim message
  (e.g. export). Follow the port's documented semantics per method.
- CS already has: ffmpeg/ffprobe bridges (`electron/lib/bridges/`), whisper.cpp
  (`whisper-bridge.ts` + `whisper.service.ts`), `getRuntimePaths()`, a component
  download catalog (`electron/components/catalog.ts`). The editor backend does NOT
  reuse these for its ported services (ACS services come verbatim with their own
  resolver against `editor-backend/`); CS's existing metadata pipeline keeps its own.
  One resolver per subsystem beats one shared resolver with divergent semantics.
- Queue intake: renderer `InputsStateService.addItem(item)`
  (`frontend/src/app/services/inputs-state.ts`), localStorage-persisted signal.
  Existing item types include `'text-subject'` with `textContent`.
- CS channels that ALREADY exist and collide by name if re-registered:
  `select-directory`, `read-directory`, `show-in-folder`, `select-files`. Resolution:
  the editor backend registers its own namespaced channels `editor:select-file`,
  `editor:select-directory`, `editor:read-directory`, `editor:show-in-folder`,
  `editor:check-file-exists`, `editor:search-files-recursive` with ACS's exact
  request/response shapes, and dialogs parent to
  `BrowserWindow.fromWebContents(event.sender)`. No reuse-with-different-shape.

## Target layout in CS

```
frontend/src/app/components/editor/     ← ACS editor folder, verbatim + additions:
  host-data/editor-manifest.ts          ← moved-in copy of ACS models/editor-manifest.ts
  host-data/types.ts                    ← moved-in copy of ACS models/types.ts (whole file)
  host-data/workflow-payload.ts         ← moved-in copy of ACS services/workflow-payload.ts
  relink-modal/                         ← relinking page reborn as a modal component
frontend/src/app/services/editor-host.adapter.ts   ← CS implementation of EditorHost
electron/services/editor/               ← ported ACS services:
  python-service.ts  binary-resolver.ts  alignment-audio-service.ts
  ollama-service.ts  chapter-splitter.ts  archive-sync.ts
  editor-window.ts   (ACS window-service, editor parts only)
  asset-manager.ts + asset-catalog.ts + asset-types.ts + downloader.ts (for assets:list)
  shared-paths.ts    app-config.ts (trimmed to what the ported services need)
  editor-ipc.ts      ← ALL editor channel registrations (setupEditorIpc(store))
editor-backend/{cli,core,binaries,utilities}   ← already in place
  (2026-08-17 cleanup: non-arm64 platforms and the bundled CPython clone were
   removed — the managed autocutstudio-env in the OwenMorgan shared dir is the
   active interpreter; recover a bundled runtime from the ACS repo's
   python/mac-arm64 or rebuild from editor-backend/environment.yml)
config/{autostudio_config.yaml,drift_corrections.json,projects.json}
```

Paths inside ported services change from ACS's `AppConfig.resourcesPath` world to:
- Python source root (PYTHONPATH, cwd): `<repo>/editor-backend` in dev,
  `<resources>/editor-backend` when packaged.
- `AUTOCUT_CONFIG_DIR`: `<repo>/config` in dev, `<userData>/config` packaged
  (keep the env var NAME — `core/config.py` reads it; do not touch Python).
- Binary chain: `editor-backend/binaries/<plat-arch>/`, python
  `editor-backend/python/<plat-arch>/python-runtime/bin/python3`, whisper
  `editor-backend/utilities/bin/`, models `editor-backend/utilities/models/`.

## The `window.launchpad` contract (the seam between the two agents)

Backend agent implements these in preload.ts (grouped under a `// EDITOR` banner) and
editor-ipc.ts; frontend agent consumes them from `electron.ts` (adding the
declare-global entries + ElectronService methods) and the adapter. Names and shapes:

Every `EditorHost` member (see ACS `editor-host.ts` — the file travels as-is except
where noted) maps 1:1 to a launchpad method of the SAME NAME with the same
signature, promise-returning, events via subscribe-style methods matching ACS
preload semantics (`onEditorPayload`, `removeEditorListeners`,
`onTranscribeProgress`, `onTranscribeComplete`, `removeTranscribeListeners`,
`onStoryAnalyzeProgress`, `removeStoryAnalyzeProgressListener`, `onArchiveQueue`,
`onArchiveProgress`, `onArchiveComplete`, `removeArchiveListeners`).

Additions beyond the ACS port surface:
1. `openEditor(): Promise<void>` — nav tab handler; channel `editor:open` with no
   payload (clears pending slot, opens/focuses the editor window).
2. Relink trio ON THE PORT (extend editor-host.ts, types live there):
   `getAssetConfig(): Promise<{success; assetPaths?; error?}>`,
   `saveAssetConfig(assetPaths): Promise<{success; error?}>`,
   `searchFilesRecursive(opts: {rootPath; filenames: string[]; maxDepth?}):
   Promise<{success; matches?: Record<string,string>; error?}>` — shapes verbatim
   from ACS (`electron.service.ts:754-874`), async implementation.
3. `sendSubjectsToTitles` stays on the port; backend keeps ACS validation verbatim
   (:481-516) then parks + pushes `titles:subjects` to the MAIN window + focuses it;
   `takePendingTitleSubjects()` drains once. Frontend main-window side subscribes +
   drains on init and converts each `TitleHandoff` into an `InputsStateService`
   item — study the existing `text-subject` flow and map faithfully: subjects →
   the item's subject content, `format` ('livestream') must reach the metadata
   pipeline's format flag if one exists, else FAIL LOUDLY (surface an error toast /
   reject) rather than silently degrade; `chapters` ride into the saved-report slot
   if CS has one (masterReportData or equivalent) — never model input.
4. `getPathForFile(file)` — preload-side `webUtils.getPathForFile`, synchronous.

## Editor window mechanics in CS

- New module `electron/services/editor/editor-window.ts`: port ACS
  `createEditorWindow` minus the alignment branch. webPreferences: same preload as
  main window, contextIsolation true, plus whatever CS's main window sets;
  `webSecurity: false` for `file://` media playback (packaged AND dev — dev loads
  http://localhost:4200 while media is file://; verify video plays in dev, this is
  the reason webSecurity must be off in the editor window only, never the main one).
- Dev: `loadURL('http://localhost:4200/editor')`. Packaged:
  `loadFile(indexPath, { query: { view: 'editor' } })`.
- Frontend shell: `App` component detects editor mode when `location.pathname`
  matches `/editor` OR `location.search` contains `view=editor`; in editor mode
  render a chromeless `<router-outlet>` only (no sidenav/toolbar) and on boot
  `router.navigateByUrl('/editor')` when the URL isn't already there. Route entry:
  `{ path: 'editor', component: EditorComponent }` (component from EditorModule
  exports; eager is fine for the editor window, but if trivial prefer
  `loadComponent`-compatible wiring that keeps the main window's initial bundle
  unaffected — do NOT let the editor grow the main window's initial budget;
  check angular.json budgets and raise `anyComponentStyle` to warn 40kb / error
  50kb since editor.component.scss is 30KB).
- Fix `sendToRenderer` (ipc-handlers.ts:148) to send to the MAIN window explicitly
  (module-held reference), not `getAllWindows()[0]`. Editor-targeted events
  (`transcribe-*`, `story:*` progress) go to `event.sender`; archive events
  broadcast to all windows (ACS behavior).
- Port the `stopArchiveSyncOnQuit()` hook into CS main.ts quit path.
- EDITOR_HOST provided in `app.config.ts`:
  `importProvidersFrom(EditorModule)` + `{ provide: EDITOR_HOST, useClass:
  EditorHostAdapter }`.

## Store keys (CS electron-store, defaults resolved at READ SITE per CS convention)

- `archiveRoot` → default `/Volumes/iO/FCPX`
- `archiveMountUrl` → default `smb://titan.local/iO`
Do NOT add store defaults in main.ts for these.

## Split of work

**Agent F (frontend)** owns `frontend/**`: editor folder copy + host-data moves +
import-path fixes, relink modal (port + re-theme + port additions to editor-host.ts),
File→Relink menu item in editor.component, EditorHostAdapter, electron.ts additions,
app shell chromeless mode, route, nav Editor tab (button calling
`electronService.openEditor()`, NOT a routerLink), titles-handoff intake into
InputsStateService, angular.json budget bump. Must compile: `cd frontend && npx ng
build --configuration development`.

**Agent B (backend)** owns `electron/**`, `package.json` scripts if needed, main.ts
wiring: ported services under `electron/services/editor/`, editor-ipc.ts, preload.ts
additions, editor-window.ts, sendToRenderer fix, quit hook, store keys. Must compile:
`npm run build:electron && npm run build:preload`. Must also smoke-test Python:
run `editor-backend/python/mac-arm64/python-runtime/bin/python3
editor-backend/cli/editor_manifest.py --zip <a real zip from config/projects.json
scan>` and confirm a `manifest_result` line (pick any project folder from
config/projects.json that exists and has a `*_compounds.zip`; if none exists, run
`--help` and note the gap instead of faking success).

Neither agent edits the other's files. The seam is THIS document.

## Verification (after both land)

1. `npm run build:all` clean.
2. `npm run electron:dev`: Editor tab opens the editor window on its empty state;
   project sidebar lists projects from `config/projects.json`; opening a processed
   session loads the timeline; waveforms render; transcript loads if present.
3. File → Relink opens the modal, shows 16 rows with current validity.
4. Send-to-titles pushes items into the main window's Inputs queue.
5. Scrub/drag feel — watch for eventCoalescing artifacts (if scrubbing stutters,
   wrap canvas drag handling in `NgZone.runOutsideAngular` — note, don't preempt).
