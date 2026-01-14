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

  // Prompt Sets (Metadata)
  getPromptSetsPath: () => ipcRenderer.invoke('get-prompt-sets-path'),
  listPromptSets: () => ipcRenderer.invoke('list-prompt-sets'),
  getPromptSet: (id: string) => ipcRenderer.invoke('get-prompt-set', id),
  createPromptSet: (promptSet: any) => ipcRenderer.invoke('create-prompt-set', promptSet),
  updatePromptSet: (id: string, promptSet: any) => ipcRenderer.invoke('update-prompt-set', id, promptSet),
  deletePromptSet: (id: string) => ipcRenderer.invoke('delete-prompt-set', id),

  // Master Prompt Sets (Analysis)
  listMasterPromptSets: () => ipcRenderer.invoke('list-master-prompt-sets'),
  getMasterPromptSet: (id: string) => ipcRenderer.invoke('get-master-prompt-set', id),
  createMasterPromptSet: (promptSet: any) => ipcRenderer.invoke('create-master-prompt-set', promptSet),
  updateMasterPromptSet: (id: string, promptSet: any) => ipcRenderer.invoke('update-master-prompt-set', id, promptSet),
  deleteMasterPromptSet: (id: string) => ipcRenderer.invoke('delete-master-prompt-set', id),

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

  // Metadata generation
  generateMetadata: (params: any) => ipcRenderer.invoke('generate-metadata', params),
  cancelJob: (jobId: string) => ipcRenderer.invoke('cancel-job', jobId),

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

  // Master Analysis
  selectMasterVideo: () => ipcRenderer.invoke('select-master-video'),
  analyzeMaster: (params: { videoPath: string; masterPromptSet?: string; jobId?: string }) =>
    ipcRenderer.invoke('analyze-master', params),
  getMasterReport: (reportPath: string) => ipcRenderer.invoke('get-master-report', reportPath),
  listMasterReports: () => ipcRenderer.invoke('list-master-reports'),
  deleteMasterReport: (reportPath: string) => ipcRenderer.invoke('delete-master-report', reportPath),
  onMasterAnalysisProgress: (callback: (progress: any) => void) => {
    const listener = (_event: any, progress: any) => callback(progress);
    ipcRenderer.on('master-analysis-progress', listener);
    return () => ipcRenderer.removeListener('master-analysis-progress', listener);
  }
};

// Expose the API to the renderer process
contextBridge.exposeInMainWorld('launchpad', api);

// Type definitions for TypeScript support in renderer
export type LaunchPadAPI = typeof api;
