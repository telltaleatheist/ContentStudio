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
  createPromptSet: (promptSet: any) => ipcRenderer.invoke('create-prompt-set', promptSet),
  updatePromptSet: (id: string, promptSet: any) => ipcRenderer.invoke('update-prompt-set', id, promptSet),
  deletePromptSet: (id: string) => ipcRenderer.invoke('delete-prompt-set', id),

  // File operations
  selectFiles: () => ipcRenderer.invoke('select-files'),
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  selectOutputDirectory: () => ipcRenderer.invoke('select-output-directory'),
  isDirectory: (filePath: string) => ipcRenderer.invoke('is-directory', filePath),
  readDirectory: (dirPath: string) => ipcRenderer.invoke('read-directory', dirPath),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  deleteDirectory: (dirPath: string) => ipcRenderer.invoke('delete-directory', dirPath),
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
  publishGetSelections: (jobId: string) => ipcRenderer.invoke('publish-get-selections', jobId),
  // titles order is meaningful: index 0 becomes the main title AND A/B variant 1
  publishSetTitles: (jobId: string, itemIndex: number, titles: string[]) =>
    ipcRenderer.invoke('publish-set-titles', jobId, itemIndex, titles),
  // pass null for a field to clear the override and fall back to the generated value
  publishSetFields: (
    jobId: string,
    itemIndex: number,
    fields: { descriptionOverride?: string | null; tagsOverride?: string | null; channelId?: string | null }
  ) => ipcRenderer.invoke('publish-set-fields', jobId, itemIndex, fields),
  publishGetResolved: (jobId: string, itemIndex: number) =>
    ipcRenderer.invoke('publish-get-resolved', jobId, itemIndex),
  publishListActionable: () => ipcRenderer.invoke('publish-list-actionable'),
  publishClear: (jobId: string, itemIndex: number) =>
    ipcRenderer.invoke('publish-clear', jobId, itemIndex),

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
