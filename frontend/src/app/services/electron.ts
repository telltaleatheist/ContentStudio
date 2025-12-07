import { Injectable } from '@angular/core';

// Declare window.launchpad interface for TypeScript
declare global {
  interface Window {
    launchpad: {
      // Settings
      getSettings: () => Promise<any>;
      updateSettings: (settings: any) => Promise<any>;

      // Prompt Sets
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

      // External URLs
      openExternal: (url: string) => Promise<{ success: boolean; error?: string }>;
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

  async openExternal(url: string): Promise<{ success: boolean; error?: string }> {
    if (!this.ipcRenderer) {
      // Fallback to window.open for non-Electron environments
      window.open(url, '_blank');
      return { success: true };
    }
    return await this.ipcRenderer.openExternal(url);
  }
}