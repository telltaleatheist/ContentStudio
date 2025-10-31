import { Injectable } from '@angular/core';

// Declare window.launchpad interface for TypeScript
declare global {
  interface Window {
    launchpad: {
      // Settings
      getSettings: () => Promise<any>;
      updateSettings: (settings: any) => Promise<any>;

      // File operations
      selectFiles: () => Promise<{ success: boolean; files: string[] }>;
      selectDirectory: () => Promise<{ success: boolean; directory: string | null }>;
      selectOutputDirectory: () => Promise<{ success: boolean; directory: string | null }>;
      isDirectory: (filePath: string) => Promise<boolean>;
      readDirectory: (dirPath: string) => Promise<{ success: boolean; directories?: any[]; files?: any[] }>;
      readFile: (filePath: string) => Promise<string>;
      deleteDirectory: (dirPath: string) => Promise<void>;
      showInFolder: (filePath: string) => Promise<void>;

      // Metadata generation
      generateMetadata: (params: any) => Promise<any>;

      // Progress updates
      onProgress: (callback: (progress: any) => void) => () => void;

      // Logging
      log: (level: string, ...args: any[]) => void;

      // Platform info
      getPlatform: () => string;

      // App info
      getAppVersion: () => Promise<string>;
      getAppPath: () => Promise<string>;
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

  // Metadata generation
  async generateMetadata(params: {
    inputs: string[];
    platform: string;
    mode: string;
  }): Promise<any> {
    if (!this.ipcRenderer) return { success: false, error: 'Electron not available' };
    return await this.ipcRenderer.generateMetadata(params);
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
}