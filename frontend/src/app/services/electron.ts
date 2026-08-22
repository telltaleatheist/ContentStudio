import { Injectable, NgZone } from '@angular/core';
import { Observable, Subject } from 'rxjs';
import type { ChosenMetadata, PublishResult, ResolvedMetadata } from '../features/publish/publish.types';
import type {
  ArchiveCheck, ArchiveDeleteProgress, ArchiveProgress, ArchiveQueue, ArchiveResult, ArchiveStatus,
  AssetComponentStatus, AssetInstallProgress, AssetInstallResult,
  AssetPaths, DeleteLocalWeekResult, DeleteRemoteWeekResult, ProjectScanResult,
  ProjectsRegistry, RemoteWeekListing, TitleHandoff
} from '../components/editor/editor-host';
import type { EditorManifest } from '../components/editor/host-data/editor-manifest';

// Re-exported for host code that talks about handoffs without importing the port directly.
// `export type` (not a bare re-export) because isolatedModules cannot tell a type from a value.
export type { TitleHandoff };

export interface StartupReadiness {
  ready: boolean;
  ai: { ready: boolean; provider: string; model: string; reason: string };
  transcription: {
    ready: boolean;
    missingComponents: string[];
    missingRequiredTools: Array<{ id: string; name: string }>;
    installedWhisperModels: Array<{ id: string; name: string }>;
    selectedModelInstalled: boolean;
  };
}

export interface ImportedTranscriptSummary {
  path: string;
  title: string;
  slug?: string;
  number?: number;
  sourceSession?: string;
  language: string;
  durationSeconds: number;
  speakers: Array<{ id: string; label: string }>;
  wordCount: number;
}

export interface ImportTranscriptResult {
  success: boolean;
  items: ImportedTranscriptSummary[];
  errors: string[];
}

// ==================== TRANSCRIPT SPLIT (split-episode feature) ====================

export interface TranscriptSplitBounds {
  targetSeconds: number;
  minSeconds: number;
  maxSeconds: number;
}

// One AI-detected chapter (contiguous subject segment tiling the transcript).
export interface TranscriptChapter {
  index: number;
  startSeconds: number;
  endSeconds: number;
  timestamp: string;
  label: string;
  verbalCue: boolean;
}

export interface AnalyzeTranscriptSplitResult {
  success: boolean;
  title?: string;
  durationSeconds?: number;
  chapters?: TranscriptChapter[];
  error?: string;
}

export interface TranscriptSplitCut {
  startSeconds: number;
  endSeconds: number;
  title?: string;
}

export interface CommitTranscriptSplitItem {
  path: string;
  displayName: string;
  startSeconds: number;
  endSeconds: number;
  durationSeconds: number;
  wordCount: number;
}

export interface CommitTranscriptSplitResult {
  success: boolean;
  items?: CommitTranscriptSplitItem[];
  error?: string;
}

// ==================== ANALYTICS (performance feedback loop) ====================

export interface AnalyticsChannel {
  channelId: string;
  name: string;
  promptSets: string[];
}

export interface AnalyticsIngestInfo {
  success: boolean;
  port?: number;
  token?: string;
  running?: boolean;
  error?: string | null;
  lastIngestAt?: string | null;
}

export interface AnalyticsChannelSummary {
  channelId: string;
  name: string;
  promptSets: string[];
  videoCount: number;
  snapshotCount: number;
  lastIngestAt: string | null;
}

export interface AnalyticsVerdictSummary {
  title: string;
  ctr: number | null;
  ctrPercentile: number | null;
  retention30s: number | null;
  views: number;
}

export interface AnalyticsChannelInsights {
  channelId: string;
  computedAt: string;
  videoCount: number;
  baselines: {
    medianCtrFirstWeek: number | null;
    medianAvgPctViewed: number | null;
    medianRetention30s: number | null;
    medianFirstWeekViews: number | null;
  };
  topPackaging: AnalyticsVerdictSummary[];
  bottomPackaging: AnalyticsVerdictSummary[];
  abLearnings: Array<{ variants: string[]; winner: string; liftPct: number }>;
  topSearchTerms: Array<{ term: string; views: number }>;
  aiBrief: string | null;
}

export interface AnalyticsCrossChannelInsights {
  computedAt: string;
  channelIds: string[];
  recentOverperformers: Array<{ channelId: string; title: string; packagingScore: number; views: number }>;
  risingSearchTerms: Array<{ term: string; views: number; trendVsPriorPeriod: number }>;
  aiBrief: string | null;
}

export interface AnalyticsInsightsResult {
  success: boolean;
  channels?: Array<{ channelId: string; name: string; insights: AnalyticsChannelInsights | null }>;
  crossChannel?: AnalyticsCrossChannelInsights | null;
  error?: string;
}

// ==================== YOUTUBE (OAuth + API collector) ====================

// A connection with every secret stripped (tokens NEVER reach the renderer).
export interface YouTubeConnection {
  channelId: string;
  channelTitle: string;
  scopes: string[];
  connectedAt: string;
  accessTokenExpiry: string;
}

export interface YouTubeChannelCollectResult {
  channelId: string;
  channelTitle: string;
  videos: number;
  snapshotsWritten: number;
  errors: string[];
  durationMs: number;
}

export interface YouTubeCollectorState {
  lastRunAt: string | null;
  lastCompactedAt: string | null;
  channels: Record<string, { lastRunAt: string | null; lastResult: YouTubeChannelCollectResult | null }>;
}

// Metadata model routing (which model generates which metadata task)
export interface MetadataRoutingOption {
  id: string;
  label: string;
}

export interface MetadataRoutingTask {
  id: string;
  label: string;
  /** Already filtered by the main process to the models valid for this task. */
  options: MetadataRoutingOption[];
  selectedOptionId: string;
}

export interface MetadataRouting {
  tasks: MetadataRoutingTask[];
}

/**
 * Bundled prompt-set files whose newer shipped version was NOT installed, because the copy
 * in userData has local edits. Reported once per app start.
 */
export interface PromptAssetNotice {
  withheld: string[];
}

// Declare window.launchpad interface for TypeScript
declare global {
  interface Window {
    launchpad: {
      // Settings
      getSettings: () => Promise<any>;
      updateSettings: (settings: any) => Promise<any>;
      getStartupReadiness: () => Promise<StartupReadiness>;
      listComponents: () => Promise<any[]>;
      installComponent: (id: string) => Promise<{ id: string; ok: boolean; error?: string }>;
      cancelComponentInstall: (id: string) => Promise<{ success: boolean }>;
      uninstallComponent: (id: string) => Promise<{ success: boolean; error?: string }>;
      onComponentProgress: (callback: (progress: any) => void) => () => void;

      // Prompt Sets (Metadata)
      listPromptSets: () => Promise<any>;
      getPromptSet: (id: string) => Promise<any>;
      createPromptSet: (promptSet: any) => Promise<any>;
      updatePromptSet: (id: string, promptSet: any) => Promise<any>;
      deletePromptSet: (id: string) => Promise<any>;
      takePendingPromptAssetNotice: () => Promise<PromptAssetNotice | null>;

      // File operations
      selectFiles: () => Promise<{ success: boolean; files: string[] }>;
      selectDirectory: () => Promise<{ success: boolean; directory: string | null }>;
      selectOutputDirectory: () => Promise<{ success: boolean; directory: string | null }>;
      isDirectory: (filePath: string) => Promise<boolean>;
      readDirectory: (dirPath: string) => Promise<{ success: boolean; directories?: any[]; files?: any[] }>;
      readFile: (filePath: string) => Promise<string>;
      deleteDirectory: (dirPath: string) => Promise<void>;
      showInFolder: (filePath: string) => Promise<void>;
      checkDirectory: (dirPath: string) => Promise<{ exists: boolean; writable: boolean }>;

      // Transcript import (AutoCutStudio)
      importTranscript: () => Promise<ImportTranscriptResult>;
      analyzeTranscriptSplit: (filePath: string) => Promise<AnalyzeTranscriptSplitResult>;
      commitTranscriptSplit: (filePath: string, cuts: TranscriptSplitCut[]) => Promise<CommitTranscriptSplitResult>;

      // Metadata generation
      generateMetadata: (params: any) => Promise<any>;
      sendHeldPrompt: (jobId: string) => Promise<any>;
      discardHeldPrompt: (jobId: string) => Promise<any>;
      cancelJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;

      // Metadata model routing (rejects with a descriptive error)
      getMetadataRouting: () => Promise<MetadataRouting>;
      setMetadataRouting: (selections: Record<string, string>) => Promise<{ success: true }>;

      // Progress updates
      onProgress: (callback: (progress: any) => void) => () => void;

      // Logging
      log: (level: string, ...args: any[]) => void;

      // Platform info
      getPlatform: () => string;

      // App info
      getAppVersion: () => Promise<string>;
      getAppPath: () => Promise<string>;

      // Job history
      getJobHistory: () => Promise<any[]>;
      deleteJobHistory: (jobId: string) => Promise<{ success: boolean; error?: string }>;
      openFolder: (folderPath: string) => Promise<{ success: boolean; error?: string }>;

      // File writing
      writeTextFile: (filePath: string, content: string) => Promise<{ success: boolean; error?: string }>;

      // Logging
      saveLogs: (frontendLogs: string) => Promise<{ success: boolean; frontendPath?: string; backendPath?: string; error?: string }>;

      // AI Setup
      checkOllama: () => Promise<{ available: boolean; models: string[] }>;
      getApiKeys: () => Promise<{ claudeApiKey?: string; openaiApiKey?: string }>;
      saveApiKey: (provider: string, apiKey: string) => Promise<{ success: boolean; error?: string }>;
      getAvailableModels: (provider: 'ollama' | 'openai' | 'claude', apiKey?: string, host?: string) => Promise<{ success: boolean; models: Array<{ id: string; name: string }>; error?: string }>;

      // External URLs
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;

      // Analytics (performance feedback loop)
      analyticsListChannels: () => Promise<{ success: boolean; channels?: AnalyticsChannel[]; error?: string }>;
      analyticsAddChannel: (entry: AnalyticsChannel) => Promise<{ success: boolean; channels?: AnalyticsChannel[]; error?: string }>;
      analyticsUpdateChannel: (channelId: string, entry: AnalyticsChannel) => Promise<{ success: boolean; channels?: AnalyticsChannel[]; error?: string }>;
      analyticsDeleteChannel: (channelId: string) => Promise<{ success: boolean; channels?: AnalyticsChannel[]; error?: string }>;
      analyticsGetIngestInfo: () => Promise<AnalyticsIngestInfo>;
      analyticsGetSummary: () => Promise<{ success: boolean; channels?: AnalyticsChannelSummary[]; error?: string }>;
      analyticsRunDistillation: () => Promise<{ success: boolean; summary?: { channels: number; videosProcessed: number; verdictsWritten: number }; error?: string }>;
      analyticsGetInsights: () => Promise<AnalyticsInsightsResult>;
      analyticsSeedFakeData: () => Promise<{ success: boolean; summary?: { channels: number; videos: number; snapshots: number; channelIds: string[] }; error?: string }>;

      // YouTube (OAuth + API collector)
      youtubeConnectChannel: () => Promise<{ success: boolean; channelId?: string; channelTitle?: string; error?: string }>;
      youtubeDisconnectChannel: (channelId: string) => Promise<{ success: boolean; error?: string }>;
      youtubeListConnections: () => Promise<{ success: boolean; connections?: YouTubeConnection[]; error?: string }>;
      youtubeCollectNow: (channelId?: string) => Promise<{ success: boolean; results?: YouTubeChannelCollectResult[]; error?: string }>;
      youtubeGetCollectorState: () => Promise<{ success: boolean; state?: YouTubeCollectorState; error?: string }>;

      // Publish (chosen titles / A-B test setup)
      publishGetSelections: (jobId: string) => Promise<PublishResult<Record<number, ChosenMetadata>>>;
      publishSetTitles: (jobId: string, itemIndex: number, titles: string[]) => Promise<PublishResult<ChosenMetadata>>;
      publishSetFields: (
        jobId: string,
        itemIndex: number,
        fields: { descriptionOverride?: string | null; tagsOverride?: string | null; channelId?: string | null }
      ) => Promise<PublishResult<ChosenMetadata>>;
      publishGetResolved: (jobId: string, itemIndex: number) => Promise<PublishResult<ResolvedMetadata>>;
      publishListActionable: () => Promise<PublishResult<ChosenMetadata[]>>;
      publishClear: (jobId: string, itemIndex: number) => Promise<PublishResult<boolean>>;

      // ==================== EDITOR ====================
      //
      // The timeline editor's whole bridge. Every name here backs one member of the
      // editor's port (frontend/src/app/components/editor/editor-host.ts) via
      // EditorHostAdapter, plus the four additions the port itself does not declare
      // (openEditor, takePendingTitleSubjects, onTitleSubjects, getPathForFile).
      //
      // Names match the EditorHost member 1:1 EXCEPT where ContentStudio already owns
      // the name for something else. Those are prefixed `editor…` and are marked below;
      // reusing a name for a different channel and a different response shape is the one
      // thing the port contract forbids outright.

      // Window
      openEditor: (payload?: { zipPath?: string }) => Promise<{ success: boolean; error?: string }>;

      // Session payload & manifest
      getEditorPayload: () => Promise<{ zipPath: string } | null>;
      onEditorPayload: (callback: (payload: { zipPath: string }) => void) => void;
      removeEditorListeners: () => void;
      getEditorManifest: (zipPath: string) => Promise<EditorManifest>;

      // Edit state (the _edits.json sidecar)
      loadEditorEdits: (payload: { zipPath: string }) => Promise<any | null>;
      saveEditorEdits: (payload: { zipPath: string; edits: any }) => Promise<{ path: string }>;
      clearEditorSessionState: (payload: { zipPath: string }) => Promise<{ removed: string[] }>;

      // Export — REJECTS with the backend's verbatim message; never an envelope.
      exportEditorCuts: (payload: {
        zipPath: string;
        cuts: Array<{ startFrame: number; endFrame: number }>;
        sequence?: Array<{ start: number; end: number }>;
        stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
        output?: 'fcpxml' | 'transcripts';
        muteMicDuringScreen?: boolean;
      }) => Promise<any>;

      // Transcription
      transcribeSession: (payload: { zipPath: string }) => Promise<{ jobId: string }>;
      cancelTranscription: (payload: { jobId: string }) => Promise<any>;
      onTranscribeProgress: (callback: (data: { jobId: string; progress: number; message: string }) => void) => void;
      onTranscribeComplete: (
        callback: (data: { jobId: string; exitCode: number; result: any; errorMessage?: string }) => void
      ) => void;
      removeTranscribeListeners: () => void;
      loadTranscript: (payload: { zipPath: string }) => Promise<any>;

      // Story analysis (local Ollama)
      ollamaListModels: (opts?: { host?: string }) =>
        Promise<{ connected: boolean; models: Array<{ id: string; name: string }> }>;
      analyzeStoryChapters: (payload: {
        segments: Array<{ text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }>;
        model: string;
        host?: string;
        consolidate?: boolean;
      }) => Promise<{ chapters: any[] }>;
      suggestStoryTitle: (payload: { text: string | string[]; model: string; host?: string }) =>
        Promise<{ title: string }>;
      cancelStoryAnalysis: () => Promise<{ stopped: boolean }>;
      unloadStoryModel: (payload: { model: string; host?: string }) => Promise<{ ok: boolean }>;
      onStoryAnalyzeProgress: (callback: (p: { phase: string; done: number; total: number }) => void) => void;
      removeStoryAnalyzeProgressListener: () => void;

      // Media
      alignmentExtractPeaks: (opts: { filePath: string; startSec: number; durationSec: number; buckets: number })
        => Promise<{ success?: boolean; min?: number[]; max?: number[]; error?: any }>;

      // Files & dialogs. All six are the editor's own namespaced channels
      // (`editor:select-file` and friends). `editorSelectDirectory` / `editorReadDirectory` /
      // `editorShowInFolder` carry the prefix because ContentStudio's own selectDirectory /
      // readDirectory / showInFolder already exist above with different channels and,
      // for selectDirectory, a different response shape.
      editorSelectFile: (options?: { title?: string; filters?: any[]; properties?: any[] })
        => Promise<{ canceled: boolean; filePaths: string[] }>;
      editorSelectDirectory: (options?: { title?: string })
        => Promise<{ canceled: boolean; filePaths: string[] }>;
      editorReadDirectory: (dirPath: string)
        => Promise<{ success: boolean; directories?: any[]; files?: any[] }>;
      editorCheckFileExists: (filePath: string) => Promise<{ exists: boolean }>;
      editorShowInFolder: (filePath: string) => Promise<any>;
      /** Synchronous — preload-side webUtils.getPathForFile, no IPC. */
      getPathForFile: (file: File) => string;

      // Asset relinking (File ▸ Relink…)
      editorGetAssetConfig: () => Promise<{ success: boolean; assetPaths?: AssetPaths; error?: string }>;
      editorSaveAssetConfig: (assetPaths: AssetPaths) => Promise<{ success: boolean; error?: string }>;
      editorSearchFilesRecursive: (opts: { rootPath: string; filenames: string[]; maxDepth?: number })
        => Promise<{ success: boolean; foundFiles?: Record<string, string>; error?: string }>;

      // Projects registry
      readProjectsRegistry: () => Promise<ProjectsRegistry>;
      writeProjectsRegistry: (registry: ProjectsRegistry) => Promise<{ success: boolean }>;
      scanProjectFolder: (folderPath: string) => Promise<ProjectScanResult>;
      /**
       * Prefixed: its channel is `editor:delete-local-week`, and the port member it backs is
       * plain `deleteLocalWeek`. Deletes the local week folder and rewrites the registry;
       * REJECTS naming the reason if its own fresh re-verification says no.
       */
      editorDeleteLocalWeek: (payload: { weekPath: string }) => Promise<DeleteLocalWeekResult>;

      // Processing (turning a raw project into an editable one)
      autoDetectAudio: (masterVideoPath: string) => Promise<{
        success: boolean;
        audioFiles?: { [key: string]: string };
        videoFiles?: { [key: string]: string };
        error?: string;
      }>;
      /**
       * The downloadable environment. `listAssets` backs both the Denoise gate and the
       * environment modal; the other five are the install surface behind File ▸ Environment…
       * Progress is sent to THIS window on 'asset-progress' by whichever install is running.
       */
      listAssets: () => Promise<{ success: boolean; components?: AssetComponentStatus[]; error?: string }>;
      installAsset: (id: string) => Promise<AssetInstallResult>;
      cancelAsset: (id: string) => Promise<{ success: boolean }>;
      ensureRequiredAssets: () =>
        Promise<{ success: boolean; ok?: boolean; failed?: string[]; error?: string }>;
      onAssetProgress: (callback: (p: AssetInstallProgress) => void) => void;
      removeAssetProgressListener: () => void;
      executeWorkflow: (options: any) => Promise<any>;
      /** Prefixed: ContentStudio's `cancelJob` above cancels a METADATA job, by id. */
      editorCancelJob: (jobId: string) => Promise<any>;
      sendSkipSignal: () => Promise<void>;
      onWorkflowOutput: (callback: (data: { jobId: string; type: string; data: string }) => void) => void;
      onWorkflowComplete: (
        callback: (data: { jobId: string; exitCode: number; result?: any; errorMessage?: string }) => void
      ) => void;
      removeWorkflowListeners: () => void;

      // Titles handoff (editor → main window)
      sendSubjectsToTitles: (payload: { handoffs: TitleHandoff[] }) => Promise<{ success: boolean }>;
      takePendingTitleSubjects: () => Promise<TitleHandoff[]>;
      onTitlesSubjects: (callback: (handoffs: TitleHandoff[]) => void) => void;
      removeTitlesSubjectsListener: () => void;

      // Backup archive
      archiveStatus: () => Promise<ArchiveStatus>;
      archiveConnect: () => Promise<ArchiveStatus>;
      archiveSync: (payload: { items: Array<{ localPath: string; kind: 'week' | 'day' }> })
        => Promise<{ ids: string[] }>;
      archiveCancel: (payload: { paths: string[] }) => Promise<{ canceled: number }>;
      archiveCheck: (payload: { localPath: string; kind: 'week' | 'day' }) => Promise<ArchiveCheck>;
      /** Week folders on the NAS. REJECTS when the archive is unreachable; never mounts it. */
      archiveListRemoteWeeks: () => Promise<RemoteWeekListing>;
      /** Removes a week from the NAS — the only copy, for a week with no local folder left. */
      archiveDeleteRemoteWeek: (payload: { path: string }) => Promise<DeleteRemoteWeekResult>;
      onArchiveQueue: (callback: (q: ArchiveQueue) => void) => void;
      onArchiveProgress: (callback: (p: ArchiveProgress) => void) => void;
      onArchiveDeleteProgress: (callback: (p: ArchiveDeleteProgress) => void) => void;
      onArchiveComplete: (callback: (r: ArchiveResult) => void) => void;
      removeArchiveListeners: () => void;
    };
  }
}

/** The bridge is absent (browser, or a preload that failed to load). Named, never guessed. */
function noBridge(what: string): Error {
  return new Error(`${what} needs the Electron bridge (window.launchpad), which is not available in this window.`);
}

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  private ipcRenderer: typeof window.launchpad | null = null;

  constructor(private ngZone: NgZone) {
    if (this.isElectron()) {
      this.ipcRenderer = window.launchpad;
    }
  }

  isElectron(): boolean {
    return !!(window && window.launchpad);
  }

  // Settings
  async getSettings(): Promise<any> {
    if (!this.ipcRenderer) return {};
    return await this.ipcRenderer.getSettings();
  }

  async updateSettings(settings: any): Promise<any> {
    if (!this.ipcRenderer) return { success: false };
    return await this.ipcRenderer.updateSettings(settings);
  }

  async getStartupReadiness(): Promise<StartupReadiness> {
    if (!this.ipcRenderer) {
      return {
        ready: true,
        ai: { ready: true, provider: 'web', model: '', reason: '' },
        transcription: {
          ready: true,
          missingComponents: [],
          missingRequiredTools: [],
          installedWhisperModels: [],
          selectedModelInstalled: true,
        },
      };
    }
    return await this.ipcRenderer.getStartupReadiness();
  }

  async listComponents(): Promise<any[]> {
    if (!this.ipcRenderer) return [];
    return await this.ipcRenderer.listComponents();
  }

  async installComponent(id: string): Promise<{ id: string; ok: boolean; error?: string }> {
    if (!this.ipcRenderer) return { id, ok: false, error: 'Electron not available' };
    return await this.ipcRenderer.installComponent(id);
  }

  async cancelComponentInstall(id: string): Promise<{ success: boolean }> {
    if (!this.ipcRenderer) return { success: false };
    return await this.ipcRenderer.cancelComponentInstall(id);
  }

  async uninstallComponent(id: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) return { success: false };
    return await this.ipcRenderer.uninstallComponent(id);
  }

  onComponentProgress(callback: (progress: any) => void): () => void {
    if (!this.ipcRenderer) return () => {};
    return this.ipcRenderer.onComponentProgress(callback);
  }

  // Prompt Sets
  async listPromptSets(): Promise<any> {
    if (!this.ipcRenderer) return { success: false, promptSets: [] };
    return await this.ipcRenderer.listPromptSets();
  }

  async getPromptSet(id: string): Promise<any> {
    if (!this.ipcRenderer) return { success: false };
    return await this.ipcRenderer.getPromptSet(id);
  }

  async createPromptSet(promptSet: any): Promise<any> {
    if (!this.ipcRenderer) return { success: false };
    return await this.ipcRenderer.createPromptSet(promptSet);
  }

  async updatePromptSet(id: string, promptSet: any): Promise<any> {
    if (!this.ipcRenderer) return { success: false };
    return await this.ipcRenderer.updatePromptSet(id, promptSet);
  }

  async deletePromptSet(id: string): Promise<any> {
    if (!this.ipcRenderer) return { success: false };
    return await this.ipcRenderer.deletePromptSet(id);
  }

  /**
   * Drain the startup report of bundled prompt-set updates that were withheld because the
   * installed file has local edits. Delivered ONCE — the main process clears it on read.
   * null = nothing withheld, and outside Electron there are no bundled assets to withhold.
   */
  async takePendingPromptAssetNotice(): Promise<PromptAssetNotice | null> {
    if (!this.ipcRenderer) return null;
    return await this.ipcRenderer.takePendingPromptAssetNotice();
  }

  // File operations
  async selectFiles(): Promise<{ success: boolean; files: string[] }> {
    if (!this.ipcRenderer) return { success: false, files: [] };
    return await this.ipcRenderer.selectFiles();
  }

  async importTranscript(): Promise<ImportTranscriptResult> {
    if (!this.ipcRenderer) return { success: false, items: [], errors: ['Electron not available'] };
    return await this.ipcRenderer.importTranscript();
  }

  async analyzeTranscriptSplit(filePath: string): Promise<AnalyzeTranscriptSplitResult> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyzeTranscriptSplit(filePath);
  }

  async commitTranscriptSplit(filePath: string, cuts: TranscriptSplitCut[]): Promise<CommitTranscriptSplitResult> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.commitTranscriptSplit(filePath, cuts);
  }

  async selectDirectory(): Promise<{ success: boolean; directory: string | null }> {
    if (!this.ipcRenderer) return { success: false, directory: null };
    return await this.ipcRenderer.selectDirectory();
  }

  async selectOutputDirectory(): Promise<{ success: boolean; directory: string | null }> {
    if (!this.ipcRenderer) return { success: false, directory: null };
    return await this.ipcRenderer.selectOutputDirectory();
  }

  async isDirectory(filePath: string): Promise<boolean> {
    if (!this.ipcRenderer) return false;
    return await this.ipcRenderer.isDirectory(filePath);
  }

  async readDirectory(dirPath: string): Promise<{ success: boolean; directories?: any[]; files?: any[] }> {
    if (!this.ipcRenderer) return { success: false };
    return await this.ipcRenderer.readDirectory(dirPath);
  }

  async readFile(filePath: string): Promise<string> {
    if (!this.ipcRenderer) return '';
    return await this.ipcRenderer.readFile(filePath);
  }

  async deleteDirectory(dirPath: string): Promise<void> {
    if (!this.ipcRenderer) return;
    return await this.ipcRenderer.deleteDirectory(dirPath);
  }

  async showInFolder(filePath: string): Promise<void> {
    if (!this.ipcRenderer) return;
    return await this.ipcRenderer.showInFolder(filePath);
  }

  async checkDirectory(dirPath: string): Promise<{ exists: boolean; writable: boolean }> {
    if (!this.ipcRenderer) return { exists: false, writable: false };
    return await this.ipcRenderer.checkDirectory(dirPath);
  }

  // Metadata generation
  async generateMetadata(params: {
    inputs: string[] | Array<{ path: string; notes?: string }>;
    promptSet: string;
    mode: string;
    /** Required: the queue row's own id. The main process refuses a request without it. */
    jobId: string;
    jobName?: string;
    chapterFlags?: { [path: string]: boolean };
    showPrompt?: boolean;
  }): Promise<any> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.generateMetadata(params);
  }

  // Run full generation reusing a transcript the backend is holding from a
  // prior showPrompt:true call (no re-transcription).
  async sendHeldPrompt(jobId: string): Promise<any> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.sendHeldPrompt(jobId);
  }

  // Free a held transcript when the user closes the prompt preview without sending.
  async discardHeldPrompt(jobId: string): Promise<any> {
    if (!this.ipcRenderer) return { success: true };
    return await this.ipcRenderer.discardHeldPrompt(jobId);
  }

  async cancelJob(jobId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.cancelJob(jobId);
  }

  // Metadata model routing — these reject rather than return a placeholder, so the
  // caller shows the real reason instead of an empty routing table.
  async getMetadataRouting(): Promise<MetadataRouting> {
    if (!this.ipcRenderer) throw new Error('Model routing needs the Electron bridge, which is not available in this window.');
    return await this.ipcRenderer.getMetadataRouting();
  }

  async setMetadataRouting(selections: Record<string, string>): Promise<{ success: true }> {
    if (!this.ipcRenderer) throw new Error('Model routing needs the Electron bridge, which is not available in this window.');
    return await this.ipcRenderer.setMetadataRouting(selections);
  }

  // Progress updates
  onProgress(callback: (progress: any) => void): () => void {
    if (!this.ipcRenderer) return () => {};
    return this.ipcRenderer.onProgress(callback);
  }

  // Logging
  log(level: string, ...args: any[]): void {
    if (!this.ipcRenderer) {
      const consoleMethod = console[level as keyof Console];
      if (typeof consoleMethod === 'function') {
        (consoleMethod as any)(...args);
      }
      return;
    }
    this.ipcRenderer.log(level, ...args);
  }

  // Platform info
  getPlatform(): string {
    if (!this.ipcRenderer) return 'web';
    return this.ipcRenderer.getPlatform();
  }

  // App info
  async getAppVersion(): Promise<string> {
    if (!this.ipcRenderer) return 'web';
    return await this.ipcRenderer.getAppVersion();
  }

  async getAppPath(): Promise<string> {
    if (!this.ipcRenderer) return '';
    return await this.ipcRenderer.getAppPath();
  }

  // Job history
  async getJobHistory(): Promise<any[]> {
    if (!this.ipcRenderer) return [];
    return await this.ipcRenderer.getJobHistory();
  }

  async deleteJobHistory(jobId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.deleteJobHistory(jobId);
  }

  async openFolder(folderPath: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.openFolder(folderPath);
  }

  async writeTextFile(filePath: string, content: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.writeTextFile(filePath, content);
  }

  async saveLogs(frontendLogs: string): Promise<{ success: boolean; frontendPath?: string; backendPath?: string; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.saveLogs(frontendLogs);
  }

  // AI Setup
  async checkOllama(): Promise<{ available: boolean; models: string[] }> {
    if (!this.ipcRenderer) return { available: false, models: [] };
    return await this.ipcRenderer.checkOllama();
  }

  async getApiKeys(): Promise<{ claudeApiKey?: string; openaiApiKey?: string }> {
    if (!this.ipcRenderer) return {};
    return await this.ipcRenderer.getApiKeys();
  }

  async saveApiKey(provider: 'claude' | 'openai', apiKey: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.saveApiKey(provider, apiKey);
  }

  async getAvailableModels(
    provider: 'ollama' | 'openai' | 'claude',
    apiKey?: string,
    host?: string
  ): Promise<{ success: boolean; models: Array<{ id: string; name: string }>; error?: string }> {
    if (!this.ipcRenderer) return { success: false, models: [], error: 'Electron not available' };
    return await this.ipcRenderer.getAvailableModels(provider, apiKey, host);
  }

  async openExternal(url: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) {
      // Fallback to window.open for non-Electron environments
      window.open(url, '_blank');
      return { success: true };
    }
    return await this.ipcRenderer.openExternal(url);
  }

  // Analytics (performance feedback loop)
  async analyticsListChannels(): Promise<{ success: boolean; channels?: AnalyticsChannel[]; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsListChannels();
  }

  async analyticsAddChannel(entry: AnalyticsChannel): Promise<{ success: boolean; channels?: AnalyticsChannel[]; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsAddChannel(entry);
  }

  async analyticsUpdateChannel(channelId: string, entry: AnalyticsChannel): Promise<{ success: boolean; channels?: AnalyticsChannel[]; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsUpdateChannel(channelId, entry);
  }

  async analyticsDeleteChannel(channelId: string): Promise<{ success: boolean; channels?: AnalyticsChannel[]; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsDeleteChannel(channelId);
  }

  async analyticsGetIngestInfo(): Promise<AnalyticsIngestInfo> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsGetIngestInfo();
  }

  async analyticsGetSummary(): Promise<{ success: boolean; channels?: AnalyticsChannelSummary[]; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsGetSummary();
  }

  async analyticsRunDistillation(): Promise<{ success: boolean; summary?: { channels: number; videosProcessed: number; verdictsWritten: number }; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsRunDistillation();
  }

  async analyticsGetInsights(): Promise<AnalyticsInsightsResult> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsGetInsights();
  }

  async analyticsSeedFakeData(): Promise<{ success: boolean; summary?: { channels: number; videos: number; snapshots: number; channelIds: string[] }; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.analyticsSeedFakeData();
  }

  // YouTube (OAuth + API collector)
  async youtubeConnectChannel(): Promise<{ success: boolean; channelId?: string; channelTitle?: string; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.youtubeConnectChannel();
  }

  async youtubeDisconnectChannel(channelId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.youtubeDisconnectChannel(channelId);
  }

  async youtubeListConnections(): Promise<{ success: boolean; connections?: YouTubeConnection[]; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.youtubeListConnections();
  }

  async youtubeCollectNow(channelId?: string): Promise<{ success: boolean; results?: YouTubeChannelCollectResult[]; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.youtubeCollectNow(channelId);
  }

  async youtubeGetCollectorState(): Promise<{ success: boolean; state?: YouTubeCollectorState; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.youtubeGetCollectorState();
  }

  // Publish (chosen titles / A-B test setup)

  async publishGetSelections(jobId: string): Promise<PublishResult<Record<number, ChosenMetadata>>> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.publishGetSelections(jobId);
  }

  /** `titles` order is meaningful: index 0 becomes the main title AND A/B variant 1. */
  async publishSetTitles(jobId: string, itemIndex: number, titles: string[]): Promise<PublishResult<ChosenMetadata>> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.publishSetTitles(jobId, itemIndex, titles);
  }

  /** Pass null for a field to clear the override and fall back to the generated value. */
  async publishSetFields(
    jobId: string,
    itemIndex: number,
    fields: { descriptionOverride?: string | null; tagsOverride?: string | null; channelId?: string | null }
  ): Promise<PublishResult<ChosenMetadata>> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.publishSetFields(jobId, itemIndex, fields);
  }

  async publishGetResolved(jobId: string, itemIndex: number): Promise<PublishResult<ResolvedMetadata>> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.publishGetResolved(jobId, itemIndex);
  }

  async publishListActionable(): Promise<PublishResult<ChosenMetadata[]>> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.publishListActionable();
  }

  async publishClear(jobId: string, itemIndex: number): Promise<PublishResult<boolean>> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.publishClear(jobId, itemIndex);
  }

  // ==================== EDITOR ====================
  //
  // The timeline editor's half of this service. EditorHostAdapter turns these into the
  // editor's port; nothing under components/editor/ reaches this class directly.
  //
  // Doctrine, and it is the opposite of the metadata half above: outside Electron these
  // THROW, naming the missing bridge. Same rule as getMetadataRouting. An editor method that
  // quietly resolved `{ success: false }` or an empty array would show the user a session with
  // no tracks, a projects list with no projects, or an export that "worked" and wrote nothing.

  private get editorBridge(): NonNullable<typeof window.launchpad> {
    if (!this.ipcRenderer) throw noBridge('The timeline editor');
    return this.ipcRenderer;
  }

  // ── Window ──────────────────────────────────────────────────────────────────

  /**
   * Open (or focus) the editor window. With a zipPath the window loads that session; with
   * none (the side-nav Editor tab) it opens on its no-session empty state and the user picks
   * a project in-window.
   */
  async openEditor(payload: { zipPath?: string } = {}): Promise<{ success: boolean; error?: string }> {
    return this.editorBridge.openEditor(payload);
  }

  // ── Session payload & manifest ──────────────────────────────────────────────

  /** (Editor window) Pull the zip path this window was opened with — null for a blank open. */
  async getEditorPayload(): Promise<{ zipPath: string } | null> {
    return this.editorBridge.getEditorPayload();
  }

  onEditorPayload(callback: (payload: { zipPath: string }) => void): void {
    this.editorBridge.onEditorPayload((p) => this.ngZone.run(() => callback(p)));
  }

  removeEditorListeners(): void {
    this.editorBridge.removeEditorListeners();
  }

  /** (Editor window) Parse the master hybrid timeline in a compounds zip into a manifest. */
  async getEditorManifest(zipPath: string): Promise<EditorManifest> {
    return this.editorBridge.getEditorManifest(zipPath);
  }

  // ── Edit state (the _edits.json sidecar) ────────────────────────────────────

  async loadEditorEdits(payload: { zipPath: string }): Promise<any | null> {
    return this.editorBridge.loadEditorEdits(payload);
  }

  async saveEditorEdits(payload: { zipPath: string; edits: any }): Promise<{ path: string }> {
    return this.editorBridge.saveEditorEdits(payload);
  }

  async clearEditorSessionState(payload: { zipPath: string }): Promise<{ removed: string[] }> {
    return this.editorBridge.clearEditorSessionState(payload);
  }

  // ── Export ──────────────────────────────────────────────────────────────────

  /**
   * Export a cut list to a revised master-hybrid FCPXML. Resolves with the backend's
   * export_result object; REJECTS with the backend's verbatim message, which the editor
   * shows as-is rather than paraphrasing.
   */
  async exportEditorCuts(payload: {
    zipPath: string;
    cuts: Array<{ startFrame: number; endFrame: number }>;
    sequence?: Array<{ start: number; end: number }>;
    stories?: Array<{ number: number; title: string; regions: Array<{ start: number; end: number }> }>;
    output?: 'fcpxml' | 'transcripts';
    muteMicDuringScreen?: boolean;
  }): Promise<any> {
    return this.editorBridge.exportEditorCuts(payload);
  }

  // ── Transcription ───────────────────────────────────────────────────────────

  async transcribeSession(payload: { zipPath: string }): Promise<{ jobId: string }> {
    return this.editorBridge.transcribeSession(payload);
  }

  async cancelTranscription(payload: { jobId: string }): Promise<any> {
    return this.editorBridge.cancelTranscription(payload);
  }

  onTranscribeProgress(callback: (data: { jobId: string; progress: number; message: string }) => void): void {
    this.editorBridge.onTranscribeProgress((d) => this.ngZone.run(() => callback(d)));
  }

  onTranscribeComplete(
    callback: (data: { jobId: string; exitCode: number; result: any; errorMessage?: string }) => void
  ): void {
    this.editorBridge.onTranscribeComplete((d) => this.ngZone.run(() => callback(d)));
  }

  removeTranscribeListeners(): void {
    this.editorBridge.removeTranscribeListeners();
  }

  async loadTranscript(payload: { zipPath: string }): Promise<any> {
    return this.editorBridge.loadTranscript(payload);
  }

  // ── Story analysis (local Ollama) ───────────────────────────────────────────

  async ollamaListModels(host?: string): Promise<{ connected: boolean; models: Array<{ id: string; name: string }> }> {
    return this.editorBridge.ollamaListModels(host ? { host } : undefined);
  }

  async analyzeStoryChapters(payload: {
    segments: Array<{ text: string; startSeconds: number; endSeconds: number; speaker: 'host' | 'clip' }>;
    model: string;
    host?: string;
    consolidate?: boolean;
  }): Promise<{ chapters: any[] }> {
    return this.editorBridge.analyzeStoryChapters(payload);
  }

  async suggestStoryTitle(payload: { text: string | string[]; model: string; host?: string }): Promise<{ title: string }> {
    return this.editorBridge.suggestStoryTitle(payload);
  }

  async cancelStoryAnalysis(): Promise<{ stopped: boolean }> {
    return this.editorBridge.cancelStoryAnalysis();
  }

  async unloadStoryModel(payload: { model: string; host?: string }): Promise<{ ok: boolean }> {
    return this.editorBridge.unloadStoryModel(payload);
  }

  onStoryAnalyzeProgress(callback: (p: { phase: string; done: number; total: number }) => void): void {
    this.editorBridge.onStoryAnalyzeProgress((p) => this.ngZone.run(() => callback(p)));
  }

  removeStoryAnalyzeProgressListener(): void {
    this.editorBridge.removeStoryAnalyzeProgressListener();
  }

  // ── Media ───────────────────────────────────────────────────────────────────

  async alignmentExtractPeaks(opts: { filePath: string; startSec: number; durationSec: number; buckets: number }):
    Promise<{ success?: boolean; min?: number[]; max?: number[]; error?: any }> {
    return this.editorBridge.alignmentExtractPeaks(opts);
  }

  // ── Files & dialogs (the editor's own namespaced channels) ──────────────────

  async selectFile(options?: { title?: string; filters?: any[]; properties?: any[] }):
    Promise<{ canceled: boolean; filePaths: string[] }> {
    return this.editorBridge.editorSelectFile(options);
  }

  /** Named apart from `selectDirectory` above, which answers `{ success, directory }`. */
  async editorSelectDirectory(options?: { title?: string }): Promise<{ canceled: boolean; filePaths: string[] }> {
    return this.editorBridge.editorSelectDirectory(options);
  }

  /** Named apart from `readDirectory` above, which rides ContentStudio's own channel. */
  async editorReadDirectory(dirPath: string): Promise<{ success: boolean; directories?: any[]; files?: any[] }> {
    return this.editorBridge.editorReadDirectory(dirPath);
  }

  async checkFileExists(filePath: string): Promise<{ exists: boolean }> {
    return this.editorBridge.editorCheckFileExists(filePath);
  }

  /** Named apart from `showInFolder` above, which rides ContentStudio's own channel. */
  async editorShowInFolder(filePath: string): Promise<any> {
    return this.editorBridge.editorShowInFolder(filePath);
  }

  /**
   * Absolute path behind a dropped File. SYNCHRONOUS — it is preload-side webUtils, not IPC.
   * Electron 32 removed `File.path`, so reading `(file as any).path` here returns undefined
   * and a drop zone built on it accepts files and adds nothing, with no error anywhere.
   */
  getPathForFile(file: File): string {
    return this.editorBridge.getPathForFile(file);
  }

  // ── Asset relinking (File ▸ Relink…) ────────────────────────────────────────

  async getAssetConfig(): Promise<{ success: boolean; assetPaths?: AssetPaths; error?: string }> {
    return this.editorBridge.editorGetAssetConfig();
  }

  async saveAssetConfig(assetPaths: AssetPaths): Promise<{ success: boolean; error?: string }> {
    return this.editorBridge.editorSaveAssetConfig(assetPaths);
  }

  async searchFilesRecursive(opts: { rootPath: string; filenames: string[]; maxDepth?: number }):
    Promise<{ success: boolean; foundFiles?: Record<string, string>; error?: string }> {
    return this.editorBridge.editorSearchFilesRecursive(opts);
  }

  // ── Projects registry ───────────────────────────────────────────────────────

  async readProjectsRegistry(): Promise<ProjectsRegistry> {
    return this.editorBridge.readProjectsRegistry();
  }

  async writeProjectsRegistry(registry: ProjectsRegistry): Promise<{ success: boolean }> {
    return this.editorBridge.writeProjectsRegistry(registry);
  }

  async scanProjectFolder(folderPath: string): Promise<ProjectScanResult> {
    return this.editorBridge.scanProjectFolder(folderPath);
  }

  /**
   * Delete the local copy of a week folder and drop every registry row under it.
   *
   * Named apart from the port member (`deleteLocalWeek`) for the same reason as
   * `editorCancelJob`: the channel is `editor:delete-local-week`, and this half of the
   * service is named after its channels. REJECTS with the main process's verbatim reason —
   * that message is what the sidebar's confirm row shows.
   */
  async editorDeleteLocalWeek(payload: { weekPath: string }): Promise<DeleteLocalWeekResult> {
    return this.editorBridge.editorDeleteLocalWeek(payload);
  }

  // ── Processing (turning a raw project into an editable one) ─────────────────

  async autoDetectAudio(masterVideoPath: string): Promise<{
    success: boolean;
    audioFiles?: { [key: string]: string };
    videoFiles?: { [key: string]: string };
    error?: string;
  }> {
    return this.editorBridge.autoDetectAudio(masterVideoPath);
  }

  /**
   * Install state of the editor backend's downloadable components. Read by the Denoise gate
   * (one component) and by the environment modal (all of them).
   */
  async listAssets(): Promise<{ success: boolean; components?: AssetComponentStatus[]; error?: string }> {
    return this.editorBridge.listAssets();
  }

  /**
   * Install one component. Resolves with the outcome rather than rejecting on a failed
   * install — `ok:false` carries the main process's verbatim reason, which the environment
   * modal prints. A missing bridge still THROWS, like every other editor method here.
   */
  async installAsset(id: string): Promise<AssetInstallResult> {
    return this.editorBridge.installAsset(id);
  }

  /** Abort an install in flight. A no-op when that component is not installing. */
  async cancelAsset(id: string): Promise<{ success: boolean }> {
    return this.editorBridge.cancelAsset(id);
  }

  /** Install every REQUIRED component that is missing. Empty `failed` is the only success. */
  async ensureRequiredAssets(): Promise<{ success: boolean; ok?: boolean; failed?: string[]; error?: string }> {
    return this.editorBridge.ensureRequiredAssets();
  }

  /** Progress ticks for whichever install is running, in this window. */
  onAssetProgress(callback: (p: AssetInstallProgress) => void): void {
    this.editorBridge.onAssetProgress((p) => this.ngZone.run(() => callback(p)));
  }

  removeAssetProgressListener(): void {
    this.editorBridge.removeAssetProgressListener();
  }

  async executeWorkflow(options: any): Promise<any> {
    return this.editorBridge.executeWorkflow(options);
  }

  /** Named apart from `cancelJob` above, which cancels a METADATA job on its own channel. */
  async editorCancelJob(jobId: string): Promise<any> {
    return this.editorBridge.editorCancelJob(jobId);
  }

  async sendSkipSignal(): Promise<void> {
    return this.editorBridge.sendSkipSignal();
  }

  /**
   * Workflow event streams, fed by the bridge listeners the first time anything subscribes.
   * Registered lazily on purpose: the main window never runs a workflow, and attaching editor
   * listeners in the constructor would make every main-window boot depend on the editor half
   * of the preload being present.
   */
  getWorkflowOutput(): Observable<{ jobId: string; type: string; data: string }> {
    this.ensureWorkflowListeners();
    return this.workflowOutput$.asObservable();
  }

  getWorkflowComplete(): Observable<{ jobId: string; exitCode: number; result?: any }> {
    this.ensureWorkflowListeners();
    return this.workflowComplete$.asObservable();
  }

  private workflowOutput$ = new Subject<{ jobId: string; type: string; data: string }>();
  private workflowComplete$ = new Subject<{ jobId: string; exitCode: number; result?: any }>();
  private workflowListenersAttached = false;

  private ensureWorkflowListeners(): void {
    if (this.workflowListenersAttached) return;
    const bridge = this.editorBridge;      // throws by name when there is no bridge
    this.workflowListenersAttached = true;
    bridge.onWorkflowOutput((d) => this.ngZone.run(() => this.workflowOutput$.next(d)));
    bridge.onWorkflowComplete((d) => this.ngZone.run(() => this.workflowComplete$.next(d)));
  }

  // ── Titles handoff (editor → main window) ───────────────────────────────────

  /**
   * (Editor window) Push each picked story to the main window's Inputs queue as its own item.
   * `chapters` rides along for the saved report only; it is never joined to `subjects`, which
   * are the only lines the titling model is shown.
   */
  async sendSubjectsToTitles(payload: { handoffs: TitleHandoff[] }): Promise<{ success: boolean }> {
    return this.editorBridge.sendSubjectsToTitles(payload);
  }

  /**
   * (Main window) Drain whatever the editor parked while this window was not listening.
   * Delivered ONCE — the main process clears the park on read. Empty array = nothing waiting.
   */
  async takePendingTitleSubjects(): Promise<TitleHandoff[]> {
    return this.editorBridge.takePendingTitleSubjects();
  }

  /** (Main window) Fires when the editor hands subjects over while this window is running. */
  onTitlesSubjects(callback: (handoffs: TitleHandoff[]) => void): void {
    this.editorBridge.onTitlesSubjects((h) => this.ngZone.run(() => callback(h)));
  }

  /** Detach the handoff listener. The main window keeps it for its whole life, so nothing
   *  calls this today; it exists because a subscription without a teardown is a leak
   *  waiting for the first caller who does need one. */
  removeTitlesSubjectsListener(): void {
    this.editorBridge.removeTitlesSubjectsListener();
  }

  // ── Backup archive ──────────────────────────────────────────────────────────

  async archiveStatus(): Promise<ArchiveStatus> {
    return this.editorBridge.archiveStatus();
  }

  async archiveConnect(): Promise<ArchiveStatus> {
    return this.editorBridge.archiveConnect();
  }

  async archiveSync(payload: { items: Array<{ localPath: string; kind: 'week' | 'day' }> }): Promise<{ ids: string[] }> {
    return this.editorBridge.archiveSync(payload);
  }

  async archiveCancel(payload: { paths: string[] }): Promise<{ canceled: number }> {
    return this.editorBridge.archiveCancel(payload);
  }

  async archiveCheck(payload: { localPath: string; kind: 'week' | 'day' }): Promise<ArchiveCheck> {
    return this.editorBridge.archiveCheck(payload);
  }

  /** Week folders on the NAS. REJECTS when it is unreachable — the caller shows no ghosts. */
  async archiveListRemoteWeeks(): Promise<RemoteWeekListing> {
    return this.editorBridge.archiveListRemoteWeeks();
  }

  /** Remove a week from the NAS. REJECTS with the main process's verbatim reason. */
  async archiveDeleteRemoteWeek(payload: { path: string }): Promise<DeleteRemoteWeekResult> {
    return this.editorBridge.archiveDeleteRemoteWeek(payload);
  }

  onArchiveQueue(callback: (q: ArchiveQueue) => void): void {
    this.editorBridge.onArchiveQueue((q) => this.ngZone.run(() => callback(q)));
  }

  onArchiveProgress(callback: (p: ArchiveProgress) => void): void {
    this.editorBridge.onArchiveProgress((p) => this.ngZone.run(() => callback(p)));
  }

  onArchiveDeleteProgress(callback: (p: ArchiveDeleteProgress) => void): void {
    this.editorBridge.onArchiveDeleteProgress((p) => this.ngZone.run(() => callback(p)));
  }

  onArchiveComplete(callback: (r: ArchiveResult) => void): void {
    this.editorBridge.onArchiveComplete((r) => this.ngZone.run(() => callback(r)));
  }

  removeArchiveListeners(): void {
    this.editorBridge.removeArchiveListeners();
  }
}
