import { Injectable } from '@angular/core';

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
      cancelJob: (jobId: string) => Promise<{ success: boolean; error?: string }>;

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
    };
  }
}

@Injectable({
  providedIn: 'root'
})
export class ElectronService {
  private ipcRenderer: typeof window.launchpad | null = null;

  constructor() {
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
    jobId?: string;
    jobName?: string;
    chapterFlags?: { [path: string]: boolean };
  }): Promise<any> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.generateMetadata(params);
  }

  async cancelJob(jobId: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.cancelJob(jobId);
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
}
