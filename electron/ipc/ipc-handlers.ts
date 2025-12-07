import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * IPC Handlers
 * Handles communication between renderer and main process
 */

/**
 * Get the prompt sets directory path (user-writable location)
 * All prompts are stored in userData/prompt_sets for both dev and production
 */
function getPromptSetsDirectory(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'prompt_sets');
}

/**
 * Ensure prompt sets directory exists
 */
function ensurePromptSetsDirectory(): void {
  const promptSetsDir = getPromptSetsDirectory();

  if (!fs.existsSync(promptSetsDir)) {
    fs.mkdirSync(promptSetsDir, { recursive: true });
    log.info(`Created prompt sets directory: ${promptSetsDir}`);
  }
}

// Track running jobs and their cancellation callbacks
const runningJobs = new Map<string, { cancel: () => void }>();

// AI Job Queue - ensures only ONE AI job runs at a time
// Transcription can happen in parallel (up to 5), but AI operations (summarize/generate) must be sequential
interface QueuedJob {
  jobId: string;
  execute: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

const aiJobQueue: QueuedJob[] = [];
let isAiJobRunning = false;

async function processAiJobQueue() {
  if (isAiJobRunning || aiJobQueue.length === 0) {
    return;
  }

  isAiJobRunning = true;
  const job = aiJobQueue.shift();

  if (job) {
    log.info(`[JobQueue] Starting AI job: ${job.jobId} (${aiJobQueue.length} jobs remaining in queue)`);
    try {
      const result = await job.execute();
      job.resolve(result);
    } catch (error) {
      log.error(`[JobQueue] AI job ${job.jobId} failed:`, error);
      job.reject(error);
    } finally {
      isAiJobRunning = false;
      log.info(`[JobQueue] AI job ${job.jobId} completed`);
      // Process next job in queue
      processAiJobQueue();
    }
  }
}

function enqueueAiJob(jobId: string, execute: () => Promise<any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const queuePosition = aiJobQueue.length + (isAiJobRunning ? 1 : 0);
    log.info(`[JobQueue] Enqueueing AI job: ${jobId} (position ${queuePosition} in queue)`);

    aiJobQueue.push({ jobId, execute, resolve, reject });

    // Send queue position to frontend
    const mainWindow = BrowserWindow.getAllWindows()[0];
    if (mainWindow && queuePosition > 0) {
      mainWindow.webContents.send('generation-progress', {
        phase: 'queued',
        message: `Queued (position ${queuePosition})`,
        jobId
      });
    }

    processAiJobQueue();
  });
}

export function setupIpcHandlers(store: Store<any>) {

  // Ensure prompt sets directory exists
  ensurePromptSetsDirectory();

  // Get settings
  ipcMain.handle('get-settings', async () => {
    try {
      // Get all store data using electron-store API
      return (store as any).store;
    } catch (error) {
      log.error('Error getting settings:', error);
      throw error;
    }
  });

  // Update settings
  ipcMain.handle('update-settings', async (_event, settings) => {
    try {
      Object.keys(settings).forEach(key => {
        (store as any).set(key, settings[key]);
      });
      return { success: true };
    } catch (error) {
      log.error('Error updating settings:', error);
      throw error;
    }
  });

  // Select files or directories
  ipcMain.handle('select-files', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Files or Directories',
        properties: ['openFile', 'openDirectory', 'multiSelections'],
        filters: [
          { name: 'All Supported Files', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'm4v', 'txt', 'yml', 'yaml'] },
          { name: 'Video Files', extensions: ['mp4', 'avi', 'mov', 'mkv', 'webm', 'm4v'] },
          { name: 'Text Files', extensions: ['txt'] },
          { name: 'YAML Files', extensions: ['yml', 'yaml'] },
          { name: 'All Files', extensions: ['*'] }
        ]
      });

      if (result.canceled) {
        return { success: false, files: [] };
      }

      return { success: true, files: result.filePaths };
    } catch (error) {
      log.error('Error selecting files:', error);
      throw error;
    }
  });

  // Select directory
  ipcMain.handle('select-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Directory',
        properties: ['openDirectory']
      });

      if (result.canceled) {
        return { success: false, directory: null };
      }

      return { success: true, directory: result.filePaths[0] };
    } catch (error) {
      log.error('Error selecting directory:', error);
      throw error;
    }
  });

  // Select output directory
  ipcMain.handle('select-output-directory', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Output Directory',
        properties: ['openDirectory', 'createDirectory']
      });

      if (result.canceled) {
        return { success: false, directory: null };
      }

      return { success: true, directory: result.filePaths[0] };
    } catch (error) {
      log.error('Error selecting output directory:', error);
      throw error;
    }
  });

  // Check if path is a directory
  ipcMain.handle('is-directory', async (_event, filePath) => {
    try {
      const stats = await fs.promises.stat(filePath);
      return stats.isDirectory();
    } catch (error) {
      log.error('Error checking if path is directory:', error);
      return false;
    }
  });

  // Read directory (list subdirectories and files)
  ipcMain.handle('read-directory', async (_event, dirPath) => {
    try {
      const entries = await fs.promises.readdir(dirPath, { withFileTypes: true });

      const directories = [];
      const files = [];

      for (const entry of entries) {
        const fullPath = `${dirPath}/${entry.name}`;
        const stats = await fs.promises.stat(fullPath);

        if (entry.isDirectory()) {
          directories.push({
            name: entry.name,
            path: fullPath,
            mtime: stats.mtime,
            size: stats.size
          });
        } else if (entry.isFile()) {
          files.push({
            name: entry.name,
            path: fullPath,
            mtime: stats.mtime,
            size: stats.size
          });
        }
      }

      return { success: true, directories, files };
    } catch (error) {
      log.error('Error reading directory:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Read file content
  ipcMain.handle('read-file', async (_event, filePath) => {
    try {
      const content = await fs.promises.readFile(filePath, 'utf-8');
      return content;
    } catch (error) {
      log.error('Error reading file:', error);
      throw error;
    }
  });

  // Delete directory
  ipcMain.handle('delete-directory', async (_event, dirPath) => {
    try {
      await fs.promises.rm(dirPath, { recursive: true, force: true });
      return { success: true };
    } catch (error) {
      log.error('Error deleting directory:', error);
      throw error;
    }
  });

  // Show in folder
  ipcMain.handle('show-in-folder', async (_event, filePath) => {
    try {
      const { shell } = require('electron');
      shell.showItemInFolder(filePath);
      return { success: true };
    } catch (error) {
      log.error('Error showing in folder:', error);
      throw error;
    }
  });

  // Check directory exists and is writable
  ipcMain.handle('check-directory', async (_event, dirPath) => {
    try {
      const fs = require('fs').promises;
      const path = require('path');

      // Check if directory exists
      try {
        const stats = await fs.stat(dirPath);
        if (!stats.isDirectory()) {
          return { exists: false, writable: false };
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          return { exists: false, writable: false };
        }
        throw error;
      }

      // Check if directory is writable by trying to create a temp file
      try {
        const testFile = path.join(dirPath, `.write-test-${Date.now()}`);
        await fs.writeFile(testFile, 'test');
        await fs.unlink(testFile);
        return { exists: true, writable: true };
      } catch (error) {
        return { exists: true, writable: false };
      }
    } catch (error) {
      log.error('Error checking directory:', error);
      return { exists: false, writable: false };
    }
  });

  // Cancel job
  ipcMain.handle('cancel-job', async (_event, jobId: string) => {
    try {
      log.info(`[IPC] Cancelling job: ${jobId}`);

      const job = runningJobs.get(jobId);
      if (job) {
        job.cancel();
        runningJobs.delete(jobId);
        return { success: true };
      } else {
        return { success: false, error: 'Job not found or already completed' };
      }
    } catch (error) {
      log.error('Error cancelling job:', error);
      return { success: false, error: (error as Error).message };
    }
  });

  // Generate metadata
  ipcMain.handle('generate-metadata', async (_event, params) => {
    try {
      log.info('Starting metadata generation with params:', JSON.stringify(params, null, 2));

      // Get settings using electron-store API
      const settings = (store as any).store;

      // Determine AI provider from settings
      // Try new separate provider fields first, fall back to legacy aiProvider field
      const summProvider = settings.summarizationProvider || settings.aiProvider;
      const metaProvider = settings.metadataProvider || settings.aiProvider;

      // Load API keys from api-keys.json
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
      let apiKeys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }

      // Get API key based on metadata provider (metadata generation usually more important)
      let apiKey = undefined;
      if (metaProvider === 'openai' || summProvider === 'openai') {
        apiKey = apiKeys.openaiApiKey;
      } else if (metaProvider === 'claude' || summProvider === 'claude') {
        apiKey = apiKeys.claudeApiKey;
      }

      // Prepare metadata generation parameters
      const metadataParams = {
        inputs: params.inputs,
        mode: params.mode || settings.defaultMode,
        aiProvider: metaProvider, // Use metadata provider as primary
        aiModel: settings.ollamaModel, // Legacy single model (backward compatibility)
        summarizationModel: settings.summarizationModel,
        metadataModel: settings.metadataModel,
        aiApiKey: apiKey,
        aiHost: settings.ollamaHost || 'http://localhost:11434',
        outputPath: params.outputPath || settings.outputDirectory,
        promptSet: params.promptSet || settings.promptSet || 'youtube-telltale',
        promptSetsDir: getPromptSetsDirectory(),
        jobId: params.jobId,
        jobName: params.jobName,
        chapterFlags: params.chapterFlags || {},
        inputNotes: params.inputNotes || {}
      };

      log.info('Prepared metadata params:', JSON.stringify(metadataParams, null, 2));

      // Send progress update
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.webContents.send('generation-progress', {
          phase: 'starting',
          message: 'Initializing metadata generation...'
        });
      }

      // Enqueue the AI job to ensure only one runs at a time
      const result = await enqueueAiJob(params.jobId || 'metadata-job', async () => {
        // Generate metadata using TypeScript service (no Python needed!)
        const { MetadataGeneratorService } = require('../services/metadata/metadata-generator.service');

        // Create cancellation callback
        let cancelled = false;
        const cancelCallback = () => {
          cancelled = true;
          log.info(`[IPC] Job ${params.jobId} cancelled`);
        };

        // Store the cancellation callback
        if (params.jobId) {
          runningJobs.set(params.jobId, { cancel: cancelCallback });
        }

        // Add progress callback to forward events to frontend
        const paramsWithCallback = {
          ...metadataParams,
          progressCallback: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => {
            log.info(`[IPC] Progress event: phase=${phase}, message=${message}, percent=${percent}, filename=${filename}, itemIndex=${itemIndex}`);
            if (mainWindow) {
              mainWindow.webContents.send('generation-progress', {
                phase,
                message,
                percent,
                ...(filename && { filename }), // Include filename if provided
                ...(itemIndex !== undefined && { itemIndex }) // Include itemIndex if provided
              });
            }
          },
          cancelCallback: () => cancelled
        };

        const jobResult = await MetadataGeneratorService.generate(paramsWithCallback);

        // Remove from running jobs
        if (params.jobId) {
          runningJobs.delete(params.jobId);
        }

        if (mainWindow) {
          if (jobResult.success) {
            mainWindow.webContents.send('generation-progress', {
              phase: 'complete',
              message: 'Metadata generation complete!'
            });
          } else {
            mainWindow.webContents.send('generation-progress', {
              phase: 'error',
              message: jobResult.error || 'Unknown error'
            });
          }
        }

        return jobResult;
      });

      return result;

    } catch (error) {
      log.error('Error generating metadata:', error);
      throw error;
    }
  });

  // Get app version
  ipcMain.handle('get-app-version', () => {
    return app.getVersion();
  });

  // Get app path
  ipcMain.handle('get-app-path', () => {
    return app.getAppPath();
  });

  // Logging from renderer
  ipcMain.on('log', (_event, level, ...args) => {
    switch (level) {
      case 'info':
        log.info(...args);
        break;
      case 'warn':
        log.warn(...args);
        break;
      case 'error':
        log.error(...args);
        break;
      default:
        log.debug(...args);
    }
  });

  // Get prompt sets directory path
  ipcMain.handle('get-prompt-sets-path', async () => {
    const promptSetsDir = getPromptSetsDirectory();
    return { success: true, path: promptSetsDir };
  });

  // List all prompt sets
  ipcMain.handle('list-prompt-sets', async () => {
    try {
      const promptSetsDir = getPromptSetsDirectory();

      // Ensure directory exists (creates if missing)
      if (!fs.existsSync(promptSetsDir)) {
        fs.mkdirSync(promptSetsDir, { recursive: true });
        log.info(`Created prompt sets directory: ${promptSetsDir}`);
      }

      const files = fs.readdirSync(promptSetsDir);
      const promptSets = [];

      for (const file of files) {
        if (file.endsWith('.yml') || file.endsWith('.yaml')) {
          const filePath = path.join(promptSetsDir, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const parsed: any = yaml.load(content);

          promptSets.push({
            id: file.replace(/\.(yml|yaml)$/, ''),
            name: parsed.name || file,
            platform: parsed.platform || 'youtube', // Default to youtube for backward compat
            instructions_prompt: parsed.instructions_prompt || parsed.generation_instructions || ''
          });
        }
      }

      return { success: true, promptSets };
    } catch (error) {
      log.error('Error listing prompt sets:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get a specific prompt set
  ipcMain.handle('get-prompt-set', async (_event, promptSetId: string) => {
    try {
      const promptSetsDir = getPromptSetsDirectory();
      const filePath = path.join(promptSetsDir, `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Prompt set not found' };
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const parsed: any = yaml.load(content);

      return {
        success: true,
        promptSet: {
          id: promptSetId,
          name: parsed.name || promptSetId,
          editorial_prompt: parsed.editorial_prompt || parsed.editorial_guidelines || '',
          instructions_prompt: parsed.instructions_prompt || parsed.generation_instructions || '',
          description_links: parsed.description_links || ''
        }
      };
    } catch (error) {
      log.error('Error getting prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // Create a new prompt set
  ipcMain.handle('create-prompt-set', async (_event, promptSet: any) => {
    try {
      const promptSetsDir = getPromptSetsDirectory();

      // Create a safe filename from the name
      const safeId = promptSet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const filePath = path.join(promptSetsDir, `${safeId}.yml`);

      // Check if already exists
      if (fs.existsSync(filePath)) {
        return { success: false, error: 'A prompt set with this name already exists' };
      }

      // Auto-append {subject} to editorial_prompt if not present
      let editorialPrompt = promptSet.editorial_prompt || '';
      if (!editorialPrompt.includes('{subject}')) {
        editorialPrompt = editorialPrompt + '\n\n{subject}';
      }

      // Create the YAML content
      const yamlContent = {
        name: promptSet.name,
        editorial_prompt: editorialPrompt,
        instructions_prompt: promptSet.instructions_prompt || '',
        description_links: promptSet.description_links || ''
      };

      const yamlStr = yaml.dump(yamlContent, { lineWidth: -1, noRefs: true });
      fs.writeFileSync(filePath, yamlStr, 'utf8');

      log.info(`Created new prompt set: ${safeId}`);
      return { success: true, id: safeId };
    } catch (error) {
      log.error('Error creating prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // Update an existing prompt set
  ipcMain.handle('update-prompt-set', async (_event, promptSetId: string, promptSet: any) => {
    try {
      const promptSetsDir = getPromptSetsDirectory();
      const filePath = path.join(promptSetsDir, `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Prompt set not found' };
      }

      // Validate that {subject} is present in editorial_prompt
      const editorialPrompt = promptSet.editorial_prompt || '';
      if (!editorialPrompt.includes('{subject}')) {
        return { success: false, error: 'Editorial prompt must contain {subject} placeholder' };
      }

      // Read existing file
      const content = fs.readFileSync(filePath, 'utf8');
      const existingData: any = yaml.load(content) || {};

      // Update the fields
      existingData.name = promptSet.name || existingData.name;
      existingData.editorial_prompt = editorialPrompt;
      existingData.instructions_prompt = promptSet.instructions_prompt || '';
      existingData.description_links = promptSet.description_links || '';

      // Remove old fields if they exist
      delete existingData.platform;
      delete existingData.editorial_guidelines;
      delete existingData.generation_instructions;

      // Write back
      const yamlStr = yaml.dump(existingData, { lineWidth: -1, noRefs: true });
      fs.writeFileSync(filePath, yamlStr, 'utf8');

      log.info(`Updated prompt set: ${promptSetId}`);
      return { success: true };
    } catch (error) {
      log.error('Error updating prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete a prompt set
  ipcMain.handle('delete-prompt-set', async (_event, promptSetId: string) => {
    try {
      const promptSetsDir = getPromptSetsDirectory();
      const filePath = path.join(promptSetsDir, `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Prompt set not found' };
      }

      fs.unlinkSync(filePath);

      log.info(`Deleted prompt set: ${promptSetId}`);
      return { success: true };
    } catch (error) {
      log.error('Error deleting prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get job history
  ipcMain.handle('get-job-history', async () => {
    try {
      const settings = (store as any).store;
      const outputDirectory = settings.outputDirectory;

      if (!outputDirectory) {
        return [];
      }

      const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');

      if (!fs.existsSync(metadataDir)) {
        return [];
      }

      const files = fs.readdirSync(metadataDir);
      const jobs = [];

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          try {
            const filePath = path.join(metadataDir, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const job = JSON.parse(content);
            job.metadataPath = filePath;
            jobs.push(job);
          } catch (error) {
            log.warn(`Error reading job metadata file ${file}:`, error);
          }
        }
      }

      // Sort by creation date (newest first)
      jobs.sort((a, b) => {
        const dateA = new Date(a.createdAt).getTime();
        const dateB = new Date(b.createdAt).getTime();
        return dateB - dateA;
      });

      return jobs;
    } catch (error) {
      log.error('Error getting job history:', error);
      return [];
    }
  });

  // Delete job history entry
  ipcMain.handle('delete-job-history', async (_event, jobId: string) => {
    try {
      const settings = (store as any).store;
      const outputDirectory = settings.outputDirectory;

      if (!outputDirectory) {
        return { success: false, error: 'No output directory configured' };
      }

      const metadataDir = path.join(outputDirectory, '.contentstudio', 'metadata');

      if (!fs.existsSync(metadataDir)) {
        return { success: false, error: 'Metadata directory not found' };
      }

      const files = fs.readdirSync(metadataDir);

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          const filePath = path.join(metadataDir, file);

          try {
            const content = fs.readFileSync(filePath, 'utf8');
            const job = JSON.parse(content);

            // Check both job.id and job.job_id for compatibility
            if (job.id === jobId || job.job_id === jobId) {
              // Delete the txt folder if it exists
              if (job.txt_folder && fs.existsSync(job.txt_folder)) {
                try {
                  fs.rmSync(job.txt_folder, { recursive: true, force: true });
                  log.info(`Deleted txt folder: ${job.txt_folder}`);
                } catch (error) {
                  log.warn(`Could not delete txt folder: ${job.txt_folder}`, error);
                }
              }

              // Delete the JSON metadata file
              fs.unlinkSync(filePath);
              log.info(`Deleted job history entry: ${jobId}`);
              return { success: true };
            }
          } catch (parseError) {
            log.warn(`Could not parse job file ${file}:`, parseError);
            continue;
          }
        }
      }

      return { success: false, error: 'Job not found' };
    } catch (error) {
      log.error('Error deleting job history:', error);
      return { success: false, error: String(error) };
    }
  });

  // Open folder in file explorer
  ipcMain.handle('open-folder', async (_event, folderPath: string) => {
    try {
      const { shell } = require('electron');
      await shell.openPath(folderPath);
      return { success: true };
    } catch (error) {
      log.error('Error opening folder:', error);
      return { success: false, error: String(error) };
    }
  });

  // Write text file
  ipcMain.handle('write-text-file', async (_event, filePath: string, content: string) => {
    try {
      await fs.promises.writeFile(filePath, content, 'utf-8');
      log.info(`Wrote text file: ${filePath}`);
      return { success: true };
    } catch (error) {
      log.error('Error writing text file:', error);
      return { success: false, error: String(error) };
    }
  });


  // Save logs
  ipcMain.handle('save-logs', async (_event, frontendLogs: string) => {
    try {
      const logsDir = path.join(app.getPath('userData'), 'logs');

      // Create logs directory if it doesn't exist
      if (!fs.existsSync(logsDir)) {
        fs.mkdirSync(logsDir, { recursive: true });
      }

      const timestamp = new Date().toISOString().replace(/[:.]/g, '-');

      // Save frontend logs
      const frontendPath = path.join(logsDir, `frontend-${timestamp}.log`);
      fs.writeFileSync(frontendPath, frontendLogs, 'utf-8');

      // Get backend logs from electron-log
      const backendPath = path.join(logsDir, `backend-${timestamp}.log`);
      const backendLogPath = log.transports.file.getFile().path;

      // Copy electron-log file to the logs directory
      if (fs.existsSync(backendLogPath)) {
        fs.copyFileSync(backendLogPath, backendPath);
      } else {
        fs.writeFileSync(backendPath, '(No backend logs available)', 'utf-8');
      }

      log.info(`Logs exported - Frontend: ${frontendPath}, Backend: ${backendPath}`);

      return {
        success: true,
        frontendPath,
        backendPath
      };
    } catch (error) {
      log.error('Error saving logs:', error);
      return { success: false, error: String(error) };
    }
  });

  // AI Setup - Check Ollama availability and get models
  ipcMain.handle('check-ollama', async () => {
    try {
      const response = await fetch('http://localhost:11434/api/tags');
      if (!response.ok) {
        return { available: false, models: [] };
      }
      const data = await response.json() as any;
      const models = data.models ? data.models.map((m: any) => m.name) : [];
      return { available: true, models };
    } catch (error) {
      log.info('Ollama not available:', error);
      return { available: false, models: [] };
    }
  });

  // AI Setup - Get API keys
  ipcMain.handle('get-api-keys', async () => {
    try {
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');

      if (!fs.existsSync(apiKeysPath)) {
        return { claudeApiKey: undefined, openaiApiKey: undefined };
      }

      const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));

      // Return masked keys for security (frontend just needs to know if they exist)
      return {
        claudeApiKey: data.claudeApiKey ? '***' : undefined,
        openaiApiKey: data.openaiApiKey ? '***' : undefined
      };
    } catch (error) {
      log.error('Error getting API keys:', error);
      return { claudeApiKey: undefined, openaiApiKey: undefined };
    }
  });

  // AI Setup - Save API key
  ipcMain.handle('save-api-key', async (event, provider: string, apiKey: string) => {
    try {
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');

      let existingKeys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        existingKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }

      // Update the appropriate key
      if (provider === 'claude') {
        existingKeys.claudeApiKey = apiKey;
      } else if (provider === 'openai') {
        existingKeys.openaiApiKey = apiKey;
      } else {
        return { success: false, error: 'Invalid provider' };
      }

      // Save to file
      fs.writeFileSync(apiKeysPath, JSON.stringify(existingKeys, null, 2), 'utf-8');

      log.info(`API key saved for ${provider}`);
      return { success: true };
    } catch (error) {
      log.error('Error saving API key:', error);
      return { success: false, error: String(error) };
    }
  });

  // Open external URL
  ipcMain.handle('open-external', async (_event, url: string) => {
    try {
      const { shell } = require('electron');
      await shell.openExternal(url);
      log.info(`Opened external URL: ${url}`);
      return { success: true };
    } catch (error) {
      log.error('Error opening external URL:', error);
      return { success: false, error: String(error) };
    }
  });

  log.info('IPC handlers registered');
}
