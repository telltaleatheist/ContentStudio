import { contextBridge, ipcRenderer } from 'electron';

/**
 * LaunchPad Preload Script
 * Exposes safe IPC methods to the renderer process
 */

// API exposed to renderer
const api = {
  // Settings
  getSettings: () => ipcRenderer.invoke('get-settings'),
  updateSettings: (settings: any) => ipcRenderer.invoke('update-settings', settings),

  // Prompt Sets
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

  // Metadata generation
  generateMetadata: (params: any) => ipcRenderer.invoke('generate-metadata', params),

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
  getAppPath: () => ipcRenderer.invoke('get-app-path')
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('launchpad', api);

// Type definitions for TypeScript support in renderer
export type LaunchPadAPI = typeof api;
