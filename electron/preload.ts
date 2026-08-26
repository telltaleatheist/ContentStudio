import { contextBridge, ipcRenderer, webUtils } from 'electron';

/**
 * LaunchPad Preload Script
 * Exposes safe IPC methods to the renderer process
 */

// API exposed to renderer
const api = {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings: any) => ipcRenderer.invoke('update-settings', settings),
  getStartupReadiness: () => ipcRenderer.invoke('get-startup-readiness'),

  // Downloadable transcription components
  listComponents: () => ipcRenderer.invoke('components:list'),
  installComponent: (id: string) => ipcRenderer.invoke('components:install', id),
  cancelComponentInstall: (id: string) => ipcRenderer.invoke('components:cancel', id),
  uninstallComponent: (id: string) => ipcRenderer.invoke('components:uninstall', id),
  onComponentProgress: (callback: (progress: any) => void) => {
    const listener = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('component-progress', listener);
    return () => ipcRenderer.removeListener('component-progress', listener);
  },

  // Per-task model routing (the settings modal's whole contract)
  getMetadataRouting: () => ipcRenderer.invoke('metadata-routing:get'),
  setMetadataRouting: (selections: Record<string, string>) =>
    ipcRenderer.invoke('metadata-routing:set', selections),

  // Prompt Sets (Metadata)
  getPromptSetsPath: () => ipcRenderer.invoke('get-prompt-sets-path'),
  listPromptSets: () => ipcRenderer.invoke('list-prompt-sets'),
  getPromptSet: (id: string) => ipcRenderer.invoke('get-prompt-set', id),

  // Instructions — the prompt tree's files, one at a time, as raw YAML. The assembled
  // per-channel view above is a join of several of them and stays read-only.
  listInstructionFiles: () => ipcRenderer.invoke('instructions:list'),
  readInstructionFile: (relPath: string) => ipcRenderer.invoke('instructions:read', relPath),
  writeInstructionFile: (relPath: string, content: string) =>
    ipcRenderer.invoke('instructions:write', relPath, content),
  revertInstructionFile: (relPath: string) => ipcRenderer.invoke('instructions:revert', relPath),
  // Bundled prompt updates the main process refused to apply over local edits, computed
  // at startup. Pull-only (nothing is listening when it is computed) and delivered once;
  // null means nothing was withheld.
  takePendingPromptAssetNotice: () => ipcRenderer.invoke('prompt-assets:take-pending-notice'),

  // File operations
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectEnrollmentAudio: () => ipcRenderer.invoke('select-enrollment-audio'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectOutputDirectory: () => ipcRenderer.invoke('select-output-directory'),
  isDirectory: (filePath: string) => ipcRenderer.invoke('is-directory', filePath),
  readDirectory: (dirPath: string) => ipcRenderer.invoke('read-directory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  showInFolder: (filePath: string) => ipcRenderer.invoke('show-in-folder', filePath),
  checkDirectory: (dirPath: string) => ipcRenderer.invoke('check-directory', dirPath),

  // Transcript import (AutoCutStudio)
  importTranscript: () => ipcRenderer.invoke('import-transcript'),
  analyzeTranscriptSplit: (filePath: string) =>
    ipcRenderer.invoke('analyze-transcript-split', { filePath }),
  commitTranscriptSplit: (filePath: string, cuts: Array<{ startSeconds: number; endSeconds: number; title?: string }>) =>
    ipcRenderer.invoke('commit-transcript-split', { filePath, cuts }),

  // Metadata generation
  generateMetadata: (params: any) => ipcRenderer.invoke('generate-metadata', params),
  // Does this video already have a reusable saved Whisper transcript? Drives the
  // "Use saved transcript" checkbox, which only exists for videos that answer yes.
  hasSavedTranscript: (videoPath: string) => ipcRenderer.invoke('has-saved-transcript', videoPath),
  cancelJob: (jobId: string) => ipcRenderer.invoke('cancel-job', jobId),

  // "Show prompt" flow: send-to-AI / discard a held (already-transcribed) prompt
  sendHeldPrompt: (jobId: string) => ipcRenderer.invoke('send-held-prompt', { jobId }),
  discardHeldPrompt: (jobId: string) => ipcRenderer.invoke('discard-held-prompt', { jobId }),

  // Progress updates
  onProgress: (callback: (progress: any) => void) => {
    const listener = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('generation-progress', listener);
    return () => ipcRenderer.removeListener('generation-progress', listener);
  },

  // Logging
  log: (level: string, ...args: any[]) => {
    ipcRenderer.send('log', level, ...args);
  },

  // Platform info
  getPlatform: () => process.platform,

  // App info
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  getAppPath: () => ipcRenderer.invoke('get-app-path'),

  // Reports (generated metadata items)
  //
  // No paths cross this boundary: the renderer names an item, the main process decides
  // which files that means. `deleteDirectory` — an unbounded recursive delete the reports
  // page used to drive — was removed with the handler behind it.
  ensureReportsMigrated: () => ipcRenderer.invoke('reports-ensure-migrated'),
  // Ten more titles for one already-generated item, on a model the operator picks from the
  // titles task's own option list. The main process replays the run's stored titles prompt
  // and appends what comes back to the item's titles array — the .txt is left alone.
  generateMoreTitles: (jobId: string, itemId: string, optionId: string) =>
    ipcRenderer.invoke('titles:generate-more', jobId, itemId, optionId),
  // Soften one already-generated item for monetization, on a model the operator picks. Every
  // text field is rewritten milder and the result is written as a NEW item under the same
  // source_key — a sibling set, exactly like a regeneration. The original is not touched.
  softenItem: (jobId: string, itemId: string, optionId: string) =>
    ipcRenderer.invoke('metadata:soften-item', jobId, itemId, optionId),
  deleteReportItem: (jobId: string, itemId: string) =>
    ipcRenderer.invoke('reports-delete-item', jobId, itemId),

  // Job history
  getJobHistory: () => ipcRenderer.invoke('get-job-history'),
  deleteJobHistory: (jobId: string) => ipcRenderer.invoke('delete-job-history', jobId),
  openFolder: (folderPath: string) => ipcRenderer.invoke('open-folder', folderPath),

  // File writing
  writeTextFile: (filePath: string, content: string) => ipcRenderer.invoke('write-text-file', filePath, content),

  // Log export
  saveLogs: (frontendLogs: string) => ipcRenderer.invoke('save-logs', frontendLogs),

  // AI Setup
  checkOllama: () => ipcRenderer.invoke('check-ollama'),
  getApiKeys: () => ipcRenderer.invoke('get-api-keys'),
  saveApiKey: (provider: string, apiKey: string) => ipcRenderer.invoke('save-api-key', provider, apiKey),
  getAvailableModels: (provider: 'ollama' | 'openai' | 'claude', apiKey?: string, host?: string) =>
    ipcRenderer.invoke('get-available-models', provider, apiKey, host),

  // External URLs
  openExternal: (url: string) => ipcRenderer.invoke('open-external', url),

  // Analytics (performance feedback loop)
  analyticsListChannels: () => ipcRenderer.invoke('analytics-list-channels'),
  analyticsAddChannel: (entry: any) => ipcRenderer.invoke('analytics-add-channel', entry),
  analyticsUpdateChannel: (channelId: string, entry: any) => ipcRenderer.invoke('analytics-update-channel', channelId, entry),
  analyticsDeleteChannel: (channelId: string) => ipcRenderer.invoke('analytics-delete-channel', channelId),
  analyticsGetIngestInfo: () => ipcRenderer.invoke('analytics-get-ingest-info'),
  analyticsGetSummary: () => ipcRenderer.invoke('analytics-get-summary'),
  analyticsRunDistillation: () => ipcRenderer.invoke('analytics-run-distillation'),
  analyticsGetInsights: () => ipcRenderer.invoke('analytics-get-insights'),
  analyticsSeedFakeData: () => ipcRenderer.invoke('analytics-seed-fake-data'),

  // YouTube (OAuth + API collector)
  youtubeConnectChannel: () => ipcRenderer.invoke('youtube-connect-channel'),
  youtubeDisconnectChannel: (channelId: string) => ipcRenderer.invoke('youtube-disconnect-channel', channelId),
  youtubeListConnections: () => ipcRenderer.invoke('youtube-list-connections'),
  youtubeCollectNow: (channelId?: string) => ipcRenderer.invoke('youtube-collect-now', channelId),
  youtubeGetCollectorState: () => ipcRenderer.invoke('youtube-get-collector-state'),

  // Publish (chosen titles / A-B test setup)
  // Every channel names ONE item, by its permanent id. The (jobId, itemIndex) pair these
  // used to take was not an identity: the index moved whenever a sibling was deleted.
  // Every generated item joined to its publish record, in one call. What the reports list
  // and the publish calendar both read; it replaced the renderer's per-mount scan of the
  // whole metadata directory.
  publishListIndex: () => ipcRenderer.invoke('publish-list-index'),
  publishListScheduled: () => ipcRenderer.invoke('publish-list-scheduled'),
  publishGetSelection: (itemId: string) => ipcRenderer.invoke('publish-get-selection', itemId),
  // titles order is meaningful: index 0 becomes the main title AND A/B variant 1
  publishSetTitles: (itemId: string, titles: string[]) =>
    ipcRenderer.invoke('publish-set-titles', itemId, titles),
  // Every field goes through a per-field validator in the main process; an unknown field
  // name is refused rather than ignored. null clears a field where null is legal.
  publishSetFields: (
    itemId: string,
    fields: {
      descriptionOverride?: string | null;
      tagsOverride?: string | null;
      channelId?: string | null;
      publishAt?: string | null;
      isPodcast?: boolean;
      // ONLY true. Monetization is on for every video and stopped being a per-item choice
      // on 2026-08-23; the main process refuses false and null by name. Left on the type
      // as documentation of that refusal rather than removed, so a caller that still tries
      // is a compile error here instead of a rejection there.
      monetize?: true;
    }
  ) => ipcRenderer.invoke('publish-set-fields', itemId, fields),
  publishGetResolved: (itemId: string) => ipcRenderer.invoke('publish-get-resolved', itemId),
  publishListActionable: () => ipcRenderer.invoke('publish-list-actionable'),
  // Promote ONE metadata set to be the definitive one for its source. A video can have
  // several sets (a re-run, a softening pass) joined by source_key; this says which of them
  // the calendar draws, the push sends and the extension fills. Nothing is copied between
  // sets — it changes which one the app reads, not what any of them holds.
  publishSetPrimary: (itemId: string) => ipcRenderer.invoke('publish-set-primary', itemId),
  publishClear: (itemId: string) => ipcRenderer.invoke('publish-clear', itemId),
  // Thumbnails. Their own channels because a thumbnail is a FILE: it is validated against
  // the bytes on disk (magic + extension agreement, ≤2 MiB, ≥1280x720), the measurements
  // are stored with the path, and a non-16:9 image comes back with a warning attached.
  // Pass null to clear.
  publishSetThumbnail: (itemId: string, absPath: string | null) =>
    ipcRenderer.invoke('publish-set-thumbnail', itemId, absPath),
  // Read-only. Returns null when there is nothing to offer, which is now the common case
  // because an image named after the export has already been attached automatically —
  // what still reaches here is the legacy slot-only spelling, which needs an eye on it.
  publishProposeThumbnail: (itemId: string) =>
    ipcRenderer.invoke('publish-propose-thumbnail', itemId),
  // The native picker, filtered to the three extensions the validator accepts. Returns the
  // path (or null for cancel) and stores NOTHING — the path goes back through
  // publish-set-thumbnail, the one door a thumbnail is validated and written through,
  // which is also where a drag-and-drop lands.
  publishChooseThumbnail: () => ipcRenderer.invoke('publish-choose-thumbnail'),
  // Downscaled in the MAIN process (nativeImage) so the preview never needs a file://
  // read from the renderer — webSecurity stays on. `absPath` names a file that is NOT
  // the stored one, which is how a proposal is previewed before it is confirmed; omit it
  // for the item's own thumbnail.
  publishReadThumbnail: (itemId: string, maxPx: number, absPath?: string | null) =>
    ipcRenderer.invoke('publish-read-thumbnail', itemId, maxPx, absPath ?? null),
  // "Look again", for a thumbnail made AFTER the run. Comes back with the automatic pass's
  // own three buckets — applied / skipped / refused, each a whole sentence — so the panel
  // can say what it found or why it found nothing. The click authorizes replacing an
  // automatically attached path; a hand-picked thumbnail (including a hand-cleared one) is
  // reported as skipped and never touched.
  publishRescanThumbnail: (itemId: string) =>
    ipcRenderer.invoke('publish-rescan-thumbnail', itemId),
  // The LIST form of publishReadThumbnail: one round trip for a whole page of rows instead
  // of one per row. Rows come back in the order asked for, and a row that cannot be shown
  // carries its own `fault` sentence rather than emptying the strip.
  publishThumbStrip: (itemIds: string[], maxPx: number) =>
    ipcRenderer.invoke('publish-thumb-strip', itemIds, maxPx),
  // The record catching up with reality: the operator uploaded this one himself. `true`
  // marks the record published; `false` takes a hand-applied mark back, and what the
  // record returns to is decided in the main process from what the record holds.
  publishMarkPublished: (itemId: string, published: boolean) =>
    ipcRenderer.invoke('publish-mark-published', itemId, published),
  // Answers only. Seeding channelId from the answer is the panel's decision, not this
  // call's side effect.
  publishResolveChannel: (promptSet: string) =>
    ipcRenderer.invoke('publish-resolve-channel', promptSet),
  // Carry-forward on regenerate. `find` ANSWERS — was this video generated before, and
  // does that run carry channel / thumbnail / podcast / transcript state? null is the
  // ordinary answer. `apply` is the only half that writes, it happens on a click and
  // never on a load, and it comes back with a per-field receipt: every one of the four
  // fields either applied, skipped (nothing to carry, or the target already has a value —
  // a carry never overwrites), or refused with the reason it did not validate NOW.
  publishFindCarryForward: (itemId: string) =>
    ipcRenderer.invoke('publish-find-carry-forward', itemId),
  publishApplyCarryForward: (itemId: string, fromItemId: string) =>
    ipcRenderer.invoke('publish-apply-carry-forward', itemId, fromItemId),

  // ==================== TRANSCRIPT LINK (Phase 2) ====================
  // Which editor story is this final export? These are ANSWERS — none of them links
  // anything. The operator confirms every link on the Inputs page, because over the 40
  // live exports the hint rate is 75% and a silent auto-link would be wrong ~1 in 4.
  // Read-only, no side effects: safe to call for every video item as it lands.
  transcriptFindCandidates: (videoPath: string) =>
    ipcRenderer.invoke('transcript-find-candidates', videoPath),
  // ffprobes the .mov. Costs a second or two on a network volume — call it per candidate,
  // not per keystroke.
  transcriptProbeDrift: (videoPath: string, ref: unknown) =>
    ipcRenderer.invoke('transcript-probe-drift', videoPath, ref),
  // Three-state: ok / missing / changed. `changed` exists so a re-exported session can
  // never be reused as though nothing happened.
  transcriptResolveRef: (ref: unknown) =>
    ipcRenderer.invoke('transcript-resolve-ref', ref),
  // The picker's progressive scope: {kind:'week'} | {kind:'registered-projects'} |
  // {kind:'project'}. One channel, because they differ only in which folders are read.
  transcriptListStories: (scope: unknown) =>
    ipcRenderer.invoke('transcript-list-stories', scope),
  // "Export it now" — the ONLY one of these that writes. Runs the editor's own
  // story-transcript export for a project, headlessly, from its saved edit state.
  transcriptExportStories: (projectFolder: string) =>
    ipcRenderer.invoke('transcript-export-stories', projectFolder),
  // ==================== END TRANSCRIPT LINK ====================

  // Push the item's chosen metadata onto its LINKED video: title (chosenTitles[0]),
  // description, tags, plus the schedule and thumbnail when the record has them. The main
  // process reads the video's current snippet/status first and hands them back with only
  // those fields replaced — videos.update replaces a whole part, so anything less would
  // clear what it did not mention. Uploads nothing and creates nothing; a video must
  // already be linked. Failures (auth, quota, "this video is public and cannot be
  // scheduled") come back as text, verbatim.
  publishPushYouTube: (itemId: string) => ipcRenderer.invoke('publish-push-youtube', itemId),
  publishPushSchedule: (itemId: string) => ipcRenderer.invoke('publish-push-schedule', itemId),
  publishUploadYouTube: (itemId: string) => ipcRenderer.invoke('publish-upload-youtube', itemId),
  publishUploadCancel: (itemId: string) => ipcRenderer.invoke('publish-upload-cancel', itemId),
  onPublishUploadProgress: (callback: (p: { itemId: string; sentBytes: number; totalBytes: number }) => void) => {
    const listener = (_event: any, p: any) => callback(p);
    ipcRenderer.on('publish-upload-progress', listener);
    return () => ipcRenderer.removeListener('publish-upload-progress', listener);
  },

  // Spreaker (Phase 6). One account, one show, and the item's `isPodcast` flag is what
  // says an item belongs on it.
  //
  // Episode audio has its own channels for the same reason a thumbnail does: it is a FILE
  // (exists, an extension Spreaker accepts, ≤300 MB, and ffprobe finds a real audio
  // stream), so the path is only half the value. `propose` ANSWERS — where the sibling
  // export would be, `podcast 1.mp3` beside `podcast 1.mov` — and null is the ordinary
  // reply. `inspect` re-measures the file already chosen, because a duration and a size
  // are facts about a moment and the only honest one is now. Neither writes anything.
  publishProposeAudio: (itemId: string) => ipcRenderer.invoke('publish-propose-audio', itemId),
  publishInspectAudio: (itemId: string) => ipcRenderer.invoke('publish-inspect-audio', itemId),
  publishSetAudio: (itemId: string, absPath: string | null) =>
    ipcRenderer.invoke('publish-set-audio', itemId, absPath),
  // The upload. Unlike the YouTube push this CREATES: afterwards there is an episode in a
  // public podcast feed that did not exist before, published as soon as Spreaker finishes
  // encoding unless the item carries a schedule (which is sent as auto_published_at, UTC).
  // Refuses before sending anything when the item is not a podcast, has no chosen title,
  // has no audio, has audio that no longer validates, has ALREADY been uploaded, or when
  // Spreaker is not configured. Failures come back verbatim.
  publishPushSpreaker: (itemId: string) => ipcRenderer.invoke('publish-push-spreaker', itemId),
  // Drop the record of the uploaded episode so the item can be uploaded again. DELETES
  // NOTHING ON SPREAKER — it exists so the duplicate guard is not a dead end for an
  // operator who removed the episode on Spreaker's own site.
  publishForgetSpreakerEpisode: (itemId: string) =>
    ipcRenderer.invoke('publish-forget-spreaker-episode', itemId),

  // The Spreaker credentials themselves. `status` never carries the access token, the
  // client secret or the refresh token — only whether each is stored, the show id (public:
  // it is in every episode URL), the token's expiry and the path of the file, so "where
  // does the token go?" has an answer on screen. Omit accessToken, clientId or
  // clientSecret on save to leave the stored one alone; clearing them is its own call.
  spreakerGetStatus: () => ipcRenderer.invoke('spreaker-get-status'),
  spreakerSaveCredentials: (input: {
    showId: string;
    showName?: string | null;
    accessToken?: string;
    clientId?: string;
    clientSecret?: string;
  }) => ipcRenderer.invoke('spreaker-save-credentials', input),
  spreakerClearCredentials: () => ipcRenderer.invoke('spreaker-clear-credentials'),
  // The OAuth2 dance, the half of it that is not the browser. `authorizeUrl` on the status
  // is what the operator opens (externally — openExternal, never this window); the code he
  // copies back out of the address bar comes in here, is spent, and is never stored.
  spreakerExchangeCode: (input: { code: string }) =>
    ipcRenderer.invoke('spreaker-exchange-code', input),
  // Renew now. The same renewal happens on its own before an upload when the token is
  // within a week of expiring; this is the operator asking to watch it happen.
  spreakerRefreshToken: () => ipcRenderer.invoke('spreaker-refresh-token'),

  // ==================== EDITOR ====================
  // The ported AutoCutStudio timeline editor. Every member of the editor's `EditorHost`
  // port has a method here with the SAME NAME, except where that name is already taken by
  // a ContentStudio method above or by a ContentStudio channel. Those are prefixed
  // `editor…` and their channel is namespaced `editor:…` — the preload name is always the
  // camelCase of the channel name, so the mapping is mechanical:
  //
  //   editorSelectFile ↔ 'editor:select-file'          editorReadDirectory   ↔ 'editor:read-directory'
  //   editorSelectDirectory ↔ 'editor:select-directory' editorShowInFolder   ↔ 'editor:show-in-folder'
  //   editorCheckFileExists ↔ 'editor:check-file-exists'
  //   editorSearchFilesRecursive ↔ 'editor:search-files-recursive'
  //   editorGetAssetConfig ↔ 'editor:get-asset-config'  editorSaveAssetConfig ↔ 'editor:save-asset-config'
  //   editorCancelJob ↔ 'editor:cancel-job'            (CS owns 'cancel-job' for metadata jobs)
  //
  // Subscription methods return nothing and are torn down by the matching remove…Listeners
  // method, which does removeAllListeners on the channel — AutoCutStudio's preload
  // semantics, kept so the editor's ngOnDestroy code ports unchanged.

  // Open (or focus) the editor window. No payload = the side-nav Editor button: the
  // pending-session slot is cleared and the editor mounts on its empty state.
  openEditor: (payload?: { zipPath?: string | null }) => ipcRenderer.invoke('editor:open', payload),

  // Session seed payload (push + race-free pull) and the timeline manifest.
  getEditorPayload: () => ipcRenderer.invoke('editor:get-payload'),
  getEditorManifest: (zipPath: string) => ipcRenderer.invoke('editor:manifest', { zipPath }),
  onEditorPayload: (callback: (payload: any) => void) => {
    ipcRenderer.on('editor-payload', (_event, payload) => callback(payload));
  },
  removeEditorListeners: () => {
    ipcRenderer.removeAllListeners('editor-payload');
  },

  // Edit-state sidecar (<session>_edits.json beside the zip).
  loadEditorEdits: (payload: { zipPath: string }) => ipcRenderer.invoke('editor:load-edits', payload),
  saveEditorEdits: (payload: { zipPath: string; edits: any }) => ipcRenderer.invoke('editor:save-edits', payload),
  clearEditorSessionState: (payload: { zipPath: string }) => ipcRenderer.invoke('editor:clear-session-state', payload),

  // Export. REJECTS with the backend's verbatim message — the editor shows it as-is.
  // `sequence` and `muteMicDuringScreen` ride on the payload object, which is forwarded
  // whole, so a new field survives this hop without a change here.
  exportEditorCuts: (payload: {
    zipPath: string;
    cuts: Array<{ startFrame: number; endFrame: number }>;
    sequence?: Array<{ start: number; end: number }>;
    stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
    output?: 'fcpxml' | 'transcripts';
    muteMicDuringScreen?: boolean;
  }) => ipcRenderer.invoke('editor:export', payload),

  // Transcription (whisper.cpp, word-level). Progress/completion arrive on this window.
  transcribeSession: (payload: { zipPath: string }) => ipcRenderer.invoke('editor:transcribe', payload),
  cancelTranscription: (payload: { jobId: string }) => ipcRenderer.invoke('editor:transcribe-cancel', payload),
  loadTranscript: (payload: { zipPath: string }) => ipcRenderer.invoke('editor:transcript-load', payload),
  onTranscribeProgress: (callback: (data: any) => void) => {
    ipcRenderer.on('transcribe-progress', (_event, data) => callback(data));
  },
  onTranscribeComplete: (callback: (data: any) => void) => {
    ipcRenderer.on('transcribe-complete', (_event, data) => callback(data));
  },
  removeTranscribeListeners: () => {
    ipcRenderer.removeAllListeners('transcribe-progress');
    ipcRenderer.removeAllListeners('transcribe-complete');
  },

  // Story analysis (local Ollama LLM). `consolidate: false` says "this span is already ONE
  // story"; the default (true) lives in chapter-splitter alone and is not repeated here.
  ollamaListModels: (payload?: { host?: string }) => ipcRenderer.invoke('ollama:list-models', payload),
  analyzeStoryChapters: (payload: {
    segments: Array<{ text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }>;
    model: string;
    host?: string;
    consolidate?: boolean;
  }) => ipcRenderer.invoke('story:analyze-chapters', payload),
  suggestStoryTitle: (payload: { text: string | string[]; model: string; host?: string }) =>
    ipcRenderer.invoke('story:suggest-title', payload),
  cancelStoryAnalysis: () => ipcRenderer.invoke('story:cancel'),
  unloadStoryModel: (payload: { model: string; host?: string }) => ipcRenderer.invoke('story:unload-model', payload),
  onStoryAnalyzeProgress: (callback: (p: { phase: string; done: number; total: number }) => void) => {
    ipcRenderer.on('story:analyze-progress', (_event, p) => callback(p));
  },
  removeStoryAnalyzeProgressListener: () => {
    ipcRenderer.removeAllListeners('story:analyze-progress');
  },

  // Waveform peaks for one window of one media file. Called many times concurrently.
  alignmentExtractPeaks: (opts: { filePath: string; startSec: number; durationSec: number; buckets: number }) =>
    ipcRenderer.invoke('alignment:extract-peaks', opts),

  // Files & dialogs. Namespaced because ContentStudio owns the unprefixed channels with
  // DIFFERENT shapes — reuse-with-a-different-shape is worse than two names.
  editorSelectFile: (options?: { title?: string; filters?: any[]; properties?: any[] }) =>
    ipcRenderer.invoke('editor:select-file', options),
  editorSelectDirectory: (options?: { title?: string }) => ipcRenderer.invoke('editor:select-directory', options),
  editorReadDirectory: (dirPath: string) => ipcRenderer.invoke('editor:read-directory', dirPath),
  editorCheckFileExists: (filePath: string) => ipcRenderer.invoke('editor:check-file-exists', filePath),
  editorShowInFolder: (filePath: string) => ipcRenderer.invoke('editor:show-in-folder', filePath),
  editorSearchFilesRecursive: (options: { rootPath: string; filenames: string[]; maxDepth?: number }) =>
    ipcRenderer.invoke('editor:search-files-recursive', options),

  /**
   * Absolute path of a File from a drag-and-drop. SYNCHRONOUS — Electron 32 removed
   * `File.path`, so the renderer cannot read it itself and a drop zone written the old way
   * silently adds nothing. Returns '' when the object is not a real filesystem file.
   */
  getPathForFile: (file: File): string => {
    try {
      return webUtils.getPathForFile(file);
    } catch {
      // Not a filesystem file (a dragged selection, a browser-synthesised blob). The caller
      // reports the file by name rather than adding an item that points nowhere.
      return '';
    }
  },

  // Projects registry. A missing registry reads as empty; an unreadable one REJECTS
  // rather than resetting itself.
  readProjectsRegistry: () => ipcRenderer.invoke('projects:read-registry'),
  writeProjectsRegistry: (registry: { version: number; projects: Array<{ path: string; name: string; lastOpened: string }> }) =>
    ipcRenderer.invoke('projects:write-registry', registry),
  scanProjectFolder: (folderPath: string) => ipcRenderer.invoke('projects:scan-folder', folderPath),

  // Relink modal: the overlay PNG paths in autostudio_config.yaml.
  editorGetAssetConfig: () => ipcRenderer.invoke('editor:get-asset-config'),
  editorSaveAssetConfig: (assetPaths: any) => ipcRenderer.invoke('editor:save-asset-config', assetPaths),

  // Processing: turning a raw project folder into an editable one.
  autoDetectAudio: (masterVideoPath: string) => ipcRenderer.invoke('auto-detect-audio', masterVideoPath),
  // The downloadable environment: ffmpeg/ffprobe, the Python runtime and the Whisper model
  // (required — the editor cannot open a project without them), plus voice isolation
  // (optional, the Denoise toggle's gate). Channels are AutoCutStudio's verbatim; nothing here
  // collides with ContentStudio's own component system, which lives on `components:*`.
  // Progress arrives on 'asset-progress', sent to THIS window (the one that asked to install).
  listAssets: () => ipcRenderer.invoke('assets:list'),
  installAsset: (id: string) => ipcRenderer.invoke('assets:install', id),
  cancelAsset: (id: string) => ipcRenderer.invoke('assets:cancel', id),
  ensureRequiredAssets: () => ipcRenderer.invoke('assets:ensure-required'),
  onAssetProgress: (callback: (progress: any) => void) => {
    ipcRenderer.on('asset-progress', (_event, progress) => callback(progress));
  },
  removeAssetProgressListener: () => {
    ipcRenderer.removeAllListeners('asset-progress');
  },
  executeWorkflow: (options: any) => ipcRenderer.invoke('execute-workflow', options),
  editorCancelJob: (jobId: string) => ipcRenderer.invoke('editor:cancel-job', jobId),
  sendSkipSignal: () => ipcRenderer.invoke('send-skip-signal'),
  onWorkflowOutput: (callback: (data: any) => void) => {
    ipcRenderer.on('workflow-output', (_event, data) => callback(data));
  },
  onWorkflowComplete: (callback: (data: any) => void) => {
    ipcRenderer.on('workflow-complete', (_event, data) => callback(data));
  },
  removeWorkflowListeners: () => {
    ipcRenderer.removeAllListeners('workflow-output');
    ipcRenderer.removeAllListeners('workflow-complete');
  },

  // Editor → main-window handoff. A BATCH, one entry per upload. Both the push and the
  // pull carry the main process's whole undelivered queue; an empty array from the pull
  // means nothing was waiting, which is not an error. `chapters` travels for the saved
  // report only — never model input.
  sendSubjectsToTitles: (payload: {
    handoffs: { subjects: string[]; format?: 'normal' | 'livestream'; source?: string; chapters?: { timestamp: string; title: string }[] }[];
  }) => ipcRenderer.invoke('titles:send-subjects', payload),
  takePendingTitleSubjects: () => ipcRenderer.invoke('titles:take-pending'),
  onTitlesSubjects: (callback: (p: any[]) => void) => {
    ipcRenderer.on('titles:subjects', (_event, p) => callback(p));
  },
  removeTitlesSubjectsListener: () => {
    ipcRenderer.removeAllListeners('titles:subjects');
  },

  // Backup archive (rsync to the NAS). `archiveStatus` never mounts anything — it is the
  // cheap probe the sidebar runs on load; `archiveConnect` asks macOS to mount and then
  // reports the same shape; `archiveSync` resolves once rsync is RUNNING, with the outcome
  // arriving on 'archive:complete'. These events are broadcast to EVERY window.
  archiveStatus: () => ipcRenderer.invoke('archive:status'),
  archiveConnect: () => ipcRenderer.invoke('archive:connect'),
  archiveSync: (payload: { items: Array<{ localPath: string; kind: 'week' | 'day' }> }) =>
    ipcRenderer.invoke('archive:sync', payload),
  archiveQueue: () => ipcRenderer.invoke('archive:queue'),
  archiveCancel: (payload: { paths: string[] }) => ipcRenderer.invoke('archive:cancel', payload),
  archiveCheck: (payload: { localPath: string; kind: 'week' | 'day' }) => ipcRenderer.invoke('archive:check', payload),
  archiveDestination: (payload: { localPath: string; kind: 'week' | 'day' }) =>
    ipcRenderer.invoke('archive:destination', payload),

  // Reclaiming space, in both directions. All three REJECT with the reason — the sidebar
  // prints it on the confirm row it was clicked from, so the message is the UI.
  //   archiveListRemoteWeeks  ↔ 'archive:list-remote-weeks'   (week folders on the NAS)
  //   archiveDeleteRemoteWeek ↔ 'archive:delete-remote-week'  (removes the ARCHIVE copy)
  //   editorDeleteLocalWeek   ↔ 'editor:delete-local-week'    (removes the LOCAL copy and
  //                                                            the registry rows under it)
  archiveListRemoteWeeks: () => ipcRenderer.invoke('archive:list-remote-weeks'),
  archiveDeleteRemoteWeek: (payload: { path: string }) =>
    ipcRenderer.invoke('archive:delete-remote-week', payload),
  editorDeleteLocalWeek: (payload: { weekPath: string }) =>
    ipcRenderer.invoke('editor:delete-local-week', payload),
  onArchiveQueue: (callback: (q: any) => void) => {
    ipcRenderer.on('archive:queue', (_event, q) => callback(q));
  },
  onArchiveProgress: (callback: (p: any) => void) => {
    ipcRenderer.on('archive:progress', (_event, p) => callback(p));
  },
  onArchiveComplete: (callback: (r: any) => void) => {
    ipcRenderer.on('archive:complete', (_event, r) => callback(r));
  },
  /**
   * Deletion progress: `{ path, name, phase, filesRemoved? }`.
   *
   * Its own channel rather than a reuse of 'archive:progress', which carries rsync's percent,
   * rate and ETA. A delete has none of those — the walk discovers the tree as it goes, so
   * there is no total to be a percentage of — and filling those fields with invented numbers
   * would make a progress bar that lies. Phases plus a rising file count are what is actually
   * known: 'verifying' | 'deleting' | 'finishing-on-nas' | 'updating-registry'.
   */
  onArchiveDeleteProgress: (callback: (p: any) => void) => {
    ipcRenderer.on('archive:delete-progress', (_event, p) => callback(p));
  },
  removeArchiveListeners: () => {
    ipcRenderer.removeAllListeners('archive:progress');
    ipcRenderer.removeAllListeners('archive:complete');
    ipcRenderer.removeAllListeners('archive:queue');
    ipcRenderer.removeAllListeners('archive:delete-progress');
  }
  // ==================== END EDITOR ====================
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('launchpad', api);

// Type definitions for TypeScript support in renderer
export type LaunchPadAPI = typeof api;
