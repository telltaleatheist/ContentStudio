import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';
import * as fs from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as yaml from 'js-yaml';
import { AIManagerService } from '../services/metadata/ai-manager.service';
import { MasterAnalyzerService } from '../services/metadata/master-analyzer.service';
import { EpisodeSplitterService } from '../services/metadata/episode-splitter.service';
import type { ContentItem } from '../services/metadata/input-handler.service';
import { parseTranscriptImport } from '../services/metadata/transcript-import.service';
import { AnalyticsStoreService } from '../services/analytics/analytics-store.service';
import { IngestServerService } from '../services/analytics/ingest-server.service';
import { DistillationService } from '../services/analytics/distillation.service';
import { seedFakeData } from '../services/analytics/seed-fake-data';
import { resolveInsightsBlockForPromptSet } from '../services/analytics/insights-prompt';
import type { ChannelRegistryEntry } from '../services/analytics/analytics-types';
import { YouTubeAuthService } from '../services/youtube/youtube-auth.service';
import { ApiCollectorService } from '../services/youtube/api-collector.service';

/**
 * Analytics services created in main.ts at startup and shared with the IPC layer.
 */
export interface AnalyticsServices {
  analyticsStore: AnalyticsStoreService;
  ingestServer: IngestServerService;
  youtubeAuth: YouTubeAuthService;
  apiCollector: ApiCollectorService;
}

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
 * Get the path to bundled sample prompts
 */
function getSamplePromptsDirectory(): string {
  // In production, assets are in the app.asar at electron/assets
  // In development, they're at electron/assets relative to app path
  const appPath = app.getAppPath();
  return path.join(appPath, 'electron', 'assets');
}

/**
 * Ensure prompt sets directory exists and copy sample prompts if empty
 */
function ensurePromptSetsDirectory(): void {
  const promptSetsDir = getPromptSetsDirectory();
  const isNewDirectory = !fs.existsSync(promptSetsDir);

  if (isNewDirectory) {
    fs.mkdirSync(promptSetsDir, { recursive: true });
    log.info(`Created prompt sets directory: ${promptSetsDir}`);
  }

  // Check if directory is empty (no YAML files)
  const existingPrompts = fs.existsSync(promptSetsDir)
    ? fs.readdirSync(promptSetsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];

  // Copy sample prompts if directory is empty
  if (existingPrompts.length === 0) {
    const samplePromptsDir = getSamplePromptsDirectory();

    if (fs.existsSync(samplePromptsDir)) {
      // Starter metadata prompt sets + summarization_prompts.yml (pipeline config).
      // master-*.yml files are seeded separately into master_prompt_sets.
      const sampleFiles = fs.readdirSync(samplePromptsDir).filter(f =>
        (f.endsWith('.yml') || f.endsWith('.yaml')) && !f.startsWith('master-')
      );

      for (const file of sampleFiles) {
        const srcPath = path.join(samplePromptsDir, file);
        const destPath = path.join(promptSetsDir, file);

        try {
          fs.copyFileSync(srcPath, destPath);
          log.info(`Copied sample prompt: ${file}`);
        } catch (error) {
          log.warn(`Failed to copy sample prompt ${file}:`, error);
        }
      }

      if (sampleFiles.length > 0) {
        log.info(`Installed ${sampleFiles.length} sample prompt(s) to help you get started`);
      }
    } else {
      log.info(`Sample prompts directory not found at: ${samplePromptsDir}`);
    }
  }

  // summarization_prompts.yml is pipeline config (not a user prompt set) — without
  // it, transcript summarization falls back to a generic prompt. Ensure it exists
  // even on installs whose prompt_sets directory already has prompts.
  const summarizationDest = path.join(promptSetsDir, 'summarization_prompts.yml');
  if (!fs.existsSync(summarizationDest)) {
    const summarizationSrc = path.join(getSamplePromptsDirectory(), 'summarization_prompts.yml');
    if (fs.existsSync(summarizationSrc)) {
      try {
        fs.copyFileSync(summarizationSrc, summarizationDest);
        log.info('Installed summarization_prompts.yml (pipeline config)');
      } catch (error) {
        log.warn('Failed to copy summarization_prompts.yml:', error);
      }
    }
  }
}

/**
 * Get the master prompt sets directory path (user-writable location)
 * Master prompts are stored separately from metadata prompts
 */
function getMasterPromptSetsDirectory(): string {
  const userDataPath = app.getPath('userData');
  return path.join(userDataPath, 'master_prompt_sets');
}

/**
 * Ensure master prompt sets directory exists and copy default prompts if empty
 */
function ensureMasterPromptSetsDirectory(): void {
  const masterPromptSetsDir = getMasterPromptSetsDirectory();
  const isNewDirectory = !fs.existsSync(masterPromptSetsDir);

  if (isNewDirectory) {
    fs.mkdirSync(masterPromptSetsDir, { recursive: true });
    log.info(`Created master prompt sets directory: ${masterPromptSetsDir}`);
  }

  // Check if directory is empty (no YAML files)
  const existingPrompts = fs.existsSync(masterPromptSetsDir)
    ? fs.readdirSync(masterPromptSetsDir).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'))
    : [];

  // Copy default master prompts if directory is empty
  if (existingPrompts.length === 0) {
    const samplePromptsDir = getSamplePromptsDirectory();

    if (fs.existsSync(samplePromptsDir)) {
      // Only copy master-*.yml files
      const masterFiles = fs.readdirSync(samplePromptsDir).filter(f =>
        f.startsWith('master-') && (f.endsWith('.yml') || f.endsWith('.yaml'))
      );

      for (const file of masterFiles) {
        const srcPath = path.join(samplePromptsDir, file);
        const destPath = path.join(masterPromptSetsDir, file);

        try {
          fs.copyFileSync(srcPath, destPath);
          log.info(`Copied default master prompt: ${file}`);
        } catch (error) {
          log.warn(`Failed to copy master prompt ${file}:`, error);
        }
      }

      if (masterFiles.length > 0) {
        log.info(`Installed ${masterFiles.length} default master prompt(s)`);
      }
    }
  }
}

// Track running jobs and their cancellation callbacks
const runningJobs = new Map<string, { cancel: () => void }>();

/**
 * Send an IPC message to the renderer, re-fetching the current window on every call.
 * Guards against "Object has been destroyed" crashes when the window is closed while a
 * long-running job's progress callback is still firing.
 */
function sendToRenderer(channel: string, payload: any): void {
  const win = BrowserWindow.getAllWindows()[0];
  if (win && !win.isDestroyed() && !win.webContents.isDestroyed()) {
    win.webContents.send(channel, payload);
  }
}

// ==================== TWO-PHASE PIPELINE ====================
// Phase 1: Transcription pool — up to 5 concurrent (WhisperService supports concurrent jobs)
// Phase 2: AI generation queue — 1 at a time, sequential (protects AI API rate limits)

interface PipelineJob {
  jobId: string;
  metadataParams: any;
  progressCallback: (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => void;
  contentItems?: ContentItem[];
  resolve: (value: any) => void;
  reject: (error: any) => void;
  cancelled: boolean;
}

interface AiGenerationJob {
  jobId: string;
  execute: () => Promise<any>;
  resolve: (value: any) => void;
  reject: (error: any) => void;
}

const MAX_CONCURRENT_TRANSCRIPTIONS = 5;
let activeTranscriptions = 0;
const transcriptionQueue: PipelineJob[] = [];
const aiGenerationQueue: AiGenerationJob[] = [];
let isAiGenerationRunning = false;

function enqueuePipelineJob(job: PipelineJob): void {
  const queuePosition = transcriptionQueue.length + activeTranscriptions;
  log.info(`[Pipeline] Enqueueing job: ${job.jobId} (${queuePosition} jobs ahead)`);
  transcriptionQueue.push(job);
  processTranscriptionQueue();
}

function processTranscriptionQueue(): void {
  while (activeTranscriptions < MAX_CONCURRENT_TRANSCRIPTIONS && transcriptionQueue.length > 0) {
    const job = transcriptionQueue.shift()!;

    if (job.cancelled) {
      job.resolve({ success: false, error: 'Job cancelled by user' });
      continue;
    }

    activeTranscriptions++;
    log.info(`[Pipeline] Starting transcription for job: ${job.jobId} (${activeTranscriptions} active, ${transcriptionQueue.length} queued)`);

    // Run transcription in background (don't await — allows multiple to run concurrently)
    runTranscription(job).finally(() => {
      activeTranscriptions--;
      log.info(`[Pipeline] Transcription finished for job: ${job.jobId} (${activeTranscriptions} active)`);
      processTranscriptionQueue();
    });
  }
}

async function runTranscription(job: PipelineJob): Promise<void> {
  try {
    const { WhisperService } = require('../services/metadata/whisper.service');
    const { InputHandlerService } = require('../services/metadata/input-handler.service');

    const whisperService = new WhisperService();
    const inputHandler = new InputHandlerService(whisperService, job.progressCallback);

    // Normalize inputs
    const normalizedInputs = job.metadataParams.inputs.map((input: any) => {
      if (typeof input === 'string') return input;
      if (input && typeof input === 'object' && input.path) return input.path;
      return String(input);
    });

    // Set up whisper progress forwarding
    whisperService.on('progress', (progress: any) => {
      if (job.cancelled) return;
      if (job.progressCallback && progress.videoPath) {
        const filename = progress.videoPath.split('/').pop() || progress.videoPath;
        let itemIndex: number | undefined = undefined;
        for (let i = 0; i < normalizedInputs.length; i++) {
          if (normalizedInputs[i] === progress.videoPath) {
            itemIndex = i;
            break;
          }
        }
        job.progressCallback('transcription', progress.message, progress.percent, filename, itemIndex);
      }
    });

    // Process inputs (transcription happens here). Collect per-input failures so
    // skipped items surface in result.warnings instead of silently vanishing.
    const customNotesMap = new Map(Object.entries(job.metadataParams.inputNotes || {}));
    const inputFailures: string[] = [];
    const contentItems = await inputHandler.processMultipleInputs(normalizedInputs, customNotesMap, inputFailures);

    if (job.cancelled) {
      job.resolve({ success: false, error: 'Job cancelled by user' });
      return;
    }

    if (contentItems.length === 0) {
      const errorMessage = inputFailures.length > 0
        ? `No content could be processed: ${inputFailures.join('; ')}`
        : 'No content could be processed';
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: errorMessage,
        jobId: job.jobId
      });
      job.resolve({ success: false, error: errorMessage });
      return;
    }

    // Store content items and move to AI generation queue
    job.contentItems = contentItems;

    // Send queued status if AI generation is busy
    if (isAiGenerationRunning || aiGenerationQueue.length > 0) {
      sendToRenderer('generation-progress', {
        phase: 'queued',
        message: 'Waiting for AI generation...',
        jobId: job.jobId
      });
    }

    // Enqueue AI generation for this job
    enqueueAiGenerationJob(job.jobId, async () => {
      if (job.cancelled) {
        return { success: false, error: 'Job cancelled by user' };
      }

      const { MetadataGeneratorService } = require('../services/metadata/metadata-generator.service');

      const paramsWithCallback = {
        ...job.metadataParams,
        preTranscribedContent: job.contentItems,
        inputWarnings: inputFailures,
        progressCallback: job.progressCallback,
        cancelCallback: () => job.cancelled
      };

      const jobResult = await MetadataGeneratorService.generate(paramsWithCallback);

      if (jobResult.success) {
        sendToRenderer('generation-progress', {
          phase: 'complete',
          message: 'Metadata generation complete!'
        });
      } else {
        sendToRenderer('generation-progress', {
          phase: 'error',
          message: jobResult.error || 'Unknown error'
        });
      }

      return jobResult;
    }).then(result => {
      job.resolve(result);
    }).catch(error => {
      // Generation THREW (rather than returning success:false) — emit a terminal error
      // event so progress-stream UIs don't hang on "generating".
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error),
        jobId: job.jobId
      });
      job.reject(error);
    });

  } catch (error) {
    log.error(`[Pipeline] Transcription failed for job ${job.jobId}:`, error);
    sendToRenderer('generation-progress', {
      phase: 'error',
      message: error instanceof Error ? error.message : String(error),
      jobId: job.jobId
    });
    job.resolve({ success: false, error: error instanceof Error ? error.message : String(error) });
  }
}

function enqueueAiGenerationJob(jobId: string, execute: () => Promise<any>): Promise<any> {
  return new Promise((resolve, reject) => {
    const queuePosition = aiGenerationQueue.length + (isAiGenerationRunning ? 1 : 0);
    log.info(`[AiQueue] Enqueueing AI job: ${jobId} (position ${queuePosition})`);

    aiGenerationQueue.push({ jobId, execute, resolve, reject });

    // Send queue position to frontend for non-pipeline jobs
    if (queuePosition > 0) {
      sendToRenderer('generation-progress', {
        phase: 'queued',
        message: `Queued (position ${queuePosition})`,
        jobId
      });
    }

    processAiGenerationQueue();
  });
}

async function processAiGenerationQueue(): Promise<void> {
  if (isAiGenerationRunning || aiGenerationQueue.length === 0) {
    return;
  }

  isAiGenerationRunning = true;
  const job = aiGenerationQueue.shift()!;

  log.info(`[AiQueue] Starting AI job: ${job.jobId} (${aiGenerationQueue.length} remaining)`);

  try {
    const result = await job.execute();
    job.resolve(result);
  } catch (error) {
    log.error(`[AiQueue] AI job ${job.jobId} failed:`, error);
    job.reject(error);
  } finally {
    isAiGenerationRunning = false;
    log.info(`[AiQueue] AI job ${job.jobId} completed`);
    processAiGenerationQueue();
  }
}

export function setupIpcHandlers(store: Store<any>, analytics: AnalyticsServices) {

  const { setSelectedWhisperModel } = require('../lib/bridges/runtime-paths');
  const componentManager = require('../components/component-manager');
  setSelectedWhisperModel((store as any).get('whisperModel', 'small'));

  ipcMain.handle('components:list', async () => componentManager.listStatus());
  ipcMain.handle('components:install', async (event, id: string) =>
    componentManager.install(id, (progress: any) => event.sender.send('component-progress', progress)));
  ipcMain.handle('components:cancel', async (_event, id: string) => {
    componentManager.cancel(id);
    return { success: true };
  });
  ipcMain.handle('components:uninstall', async (_event, id: string) => {
    const selected = (store as any).get('whisperModel', 'small');
    if (id === `whisper-${selected}`) {
      return { success: false, error: 'Choose and save a different default Whisper model before removing this one.' };
    }
    componentManager.uninstall(id);
    return { success: true };
  });

  ipcMain.handle('get-startup-readiness', async () => {
    const settings = (store as any).store;
    const provider = settings.metadataProvider || settings.aiProvider || 'openai';
    const model = settings.metadataModel || settings.ollamaModel || '';
    let aiReady = false;
    let aiReason = '';

    if (!model) {
      aiReason = 'No AI model is selected.';
    } else if (provider === 'openai' || provider === 'claude') {
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
      let keys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        keys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }
      const key = provider === 'openai' ? keys.openaiApiKey : keys.claudeApiKey;
      aiReady = typeof key === 'string' && key.trim().length > 0;
      if (!aiReady) aiReason = `The selected ${provider === 'openai' ? 'OpenAI' : 'Claude'} provider has no API key.`;
    } else if (provider === 'ollama') {
      const host = String(settings.ollamaHost || 'http://localhost:11434').replace(/\/$/, '');
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 4000);
      try {
        const response = await fetch(`${host}/api/tags`, { signal: controller.signal });
        if (response.ok) {
          const data = await response.json() as any;
          const models = Array.isArray(data.models) ? data.models.map((item: any) => item.name) : [];
          aiReady = models.includes(model);
          if (!aiReady) aiReason = `The selected Ollama model (${model}) is not installed.`;
        } else {
          aiReason = `Ollama returned HTTP ${response.status}.`;
        }
      } catch {
        aiReason = `Ollama is not reachable at ${host}.`;
      } finally {
        clearTimeout(timeout);
      }
    } else {
      aiReason = `Unsupported AI provider: ${provider}.`;
    }

    const whisperModel = settings.whisperModel || 'small';
    const requiredToolIds = ['ffmpeg', 'whisper-engine'];
    const selectedModelId = `whisper-${whisperModel}`;
    const componentStatuses = componentManager.listStatus();
    const missingRequiredTools = requiredToolIds.flatMap((id: string) => {
      const status = componentStatuses.find((item: any) => item.component.id === id);
      return status?.state === 'installed' ? [] : [{ id, name: status?.component?.name || id }];
    });
    const installedWhisperModels = componentStatuses
      .filter((status: any) => status.component.category === 'whisper' && status.state === 'installed')
      .map((status: any) => ({ id: status.component.id, name: status.component.name }));
    const selectedModelInstalled = installedWhisperModels.some((item: any) => item.id === selectedModelId);
    const missingComponents = [
      ...missingRequiredTools.map((item: any) => item.name),
      ...(selectedModelInstalled ? [] : [componentStatuses.find((item: any) => item.component.id === selectedModelId)?.component.name || selectedModelId]),
    ];

    return {
      ready: aiReady && missingComponents.length === 0,
      ai: { ready: aiReady, provider, model, reason: aiReason },
      transcription: {
        ready: missingComponents.length === 0,
        missingComponents,
        missingRequiredTools,
        installedWhisperModels,
        selectedModelInstalled,
      },
    };
  });

  // Ensure prompt sets directory exists
  ensurePromptSetsDirectory();

  // Get settings
  ipcMain.handle('get-settings', async () => {
    try {
      // Get all store data using electron-store API
      const settings = { ...(store as any).store };

      // Single source of truth for the default output directory. The frontend no
      // longer hardcodes a fallback, so populate it here when unset. This is NOT
      // persisted to disk — it only fills the returned object.
      // NOTE: must stay in sync with MetadataGeneratorService.getDefaultOutputPath()
      // in electron/services/metadata/metadata-generator.service.ts.
      if (!settings.outputDirectory) {
        settings.outputDirectory = path.join(os.homedir(), 'Documents', 'ContentStudio Output');
      }

      return settings;
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
      if (settings.whisperModel) setSelectedWhisperModel(settings.whisperModel);
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
        title: 'Select Files',
        properties: ['openFile', 'multiSelections']
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

  // Check directory exists and is writable (auto-creates if missing)
  ipcMain.handle('check-directory', async (_event, dirPath) => {
    try {
      const fs = require('fs').promises;
      const path = require('path');

      // Check if directory exists, create if not
      try {
        const stats = await fs.stat(dirPath);
        if (!stats.isDirectory()) {
          return { exists: false, writable: false };
        }
      } catch (error: any) {
        if (error.code === 'ENOENT') {
          // Directory doesn't exist, try to create it
          try {
            await fs.mkdir(dirPath, { recursive: true });
            log.info(`Created output directory: ${dirPath}`);
          } catch (mkdirError) {
            log.error('Failed to create directory:', mkdirError);
            return { exists: false, writable: false };
          }
        } else {
          throw error;
        }
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
      const metaProvider = settings.metadataProvider || settings.aiProvider;

      // Load API keys from api-keys.json
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
      let apiKeys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }

      // Reconstruct full model with provider prefix (e.g., "claude:claude-sonnet-4-5")
      // Settings stores provider and model separately, but AIManagerService needs prefixed format
      // Prefer newer metadataProvider/metadataModel fields over legacy aiProvider/aiModel
      const aiModel = settings.metadataModel || settings.aiModel || settings.ollamaModel;
      const aiProvider = settings.metadataProvider || settings.aiProvider || 'ollama';
      const fullModel = aiModel ? `${aiProvider}:${aiModel}` : undefined;

      // Get the API key strictly for the provider that fullModel is built from.
      // (OR-ing meta/summ providers here would pick the wrong key when they differ —
      // e.g. metadata=claude + summarization=openai must send Claude requests with the Claude key.)
      let apiKey = undefined;
      if (aiProvider === 'openai') {
        apiKey = apiKeys.openaiApiKey;
      } else if (aiProvider === 'claude') {
        apiKey = apiKeys.claudeApiKey;
      }

      log.info(`[IPC] Using AI model: ${fullModel} (provider: ${aiProvider}, model: ${aiModel})`);

      // Performance-feedback loop: when the active prompt set maps to a
      // registered analytics channel that has computed insights, append the
      // "CHANNEL PERFORMANCE DATA" block to the generation prompt. null = no
      // mapping / no insights yet — expected state, block simply omitted.
      const activePromptSet = params.promptSet || settings.promptSet || 'sample-youtube';
      const insightsBlock = resolveInsightsBlockForPromptSet(analytics.analyticsStore, activePromptSet);

      // Prepare metadata generation parameters
      const metadataParams = {
        inputs: params.inputs,
        mode: params.mode || settings.defaultMode,
        aiProvider: metaProvider, // Use metadata provider as primary
        aiModel: fullModel, // Full prefixed model (e.g., "claude:claude-sonnet-4-5")
        summarizationModel: fullModel, // Use same model for both
        metadataModel: fullModel,
        aiApiKey: apiKey,
        aiHost: settings.ollamaHost || 'http://localhost:11434',
        outputPath: params.outputPath || settings.outputDirectory,
        promptSet: activePromptSet,
        promptSetsDir: getPromptSetsDirectory(),
        jobId: params.jobId,
        jobName: params.jobName,
        chapterFlags: params.chapterFlags || {},
        inputNotes: params.inputNotes || {},
        insightsBlock: insightsBlock || undefined
      };

      const safeMetadataParams = {
        ...metadataParams,
        aiApiKey: metadataParams.aiApiKey ? '***' : undefined,
        // Summarized: the full block is several KB and would drown the log
        insightsBlock: insightsBlock ? `<CHANNEL PERFORMANCE DATA, ${insightsBlock.length} chars>` : undefined
      };
      log.info('Prepared metadata params:', JSON.stringify(safeMetadataParams, null, 2));

      // Send progress update
      sendToRenderer('generation-progress', {
        phase: 'starting',
        message: 'Initializing metadata generation...'
      });

      // Submit to two-phase pipeline (transcription pool → AI generation queue)
      const result = await new Promise<any>((resolve, reject) => {
        const progressCallback = (phase: string, message: string, percent?: number, filename?: string, itemIndex?: number) => {
          log.info(`[IPC] Progress event: phase=${phase}, message=${message}, percent=${percent}, filename=${filename}, itemIndex=${itemIndex}`);
          sendToRenderer('generation-progress', {
            phase,
            message,
            percent,
            ...(filename && { filename }),
            ...(itemIndex !== undefined && { itemIndex })
          });
        };

        const pipelineJob: PipelineJob = {
          jobId: params.jobId || 'metadata-job',
          metadataParams,
          progressCallback,
          resolve,
          reject,
          cancelled: false
        };

        // Store cancellation callback
        if (params.jobId) {
          runningJobs.set(params.jobId, {
            cancel: () => {
              pipelineJob.cancelled = true;
              log.info(`[Pipeline] Job ${params.jobId} marked as cancelled`);
              // Remove from transcription queue if still waiting
              const tIdx = transcriptionQueue.indexOf(pipelineJob);
              if (tIdx !== -1) {
                transcriptionQueue.splice(tIdx, 1);
                resolve({ success: false, error: 'Job cancelled by user' });
              }
            }
          });
        }

        enqueuePipelineJob(pipelineJob);
      });

      return result;

    } catch (error) {
      log.error('Error generating metadata:', error);
      // Terminal error event so progress-stream UIs don't hang on "generating"
      // when generation rejects rather than returning success:false.
      sendToRenderer('generation-progress', {
        phase: 'error',
        message: error instanceof Error ? error.message : String(error)
      });
      throw error;
    } finally {
      // Always release the cancel closure — on rejection too, not just success.
      if (params.jobId) {
        runningJobs.delete(params.jobId);
      }
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
        // summarization_prompts.yml is pipeline config, not a selectable prompt set
        if (file.startsWith('summarization_prompts')) {
          continue;
        }
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

  // ==================== MASTER PROMPT SETS ====================

  // List all master prompt sets
  ipcMain.handle('list-master-prompt-sets', async () => {
    try {
      ensureMasterPromptSetsDirectory();
      const masterPromptSetsDir = getMasterPromptSetsDirectory();

      const files = fs.readdirSync(masterPromptSetsDir);
      const promptSets = [];

      for (const file of files) {
        if (file.endsWith('.yml') || file.endsWith('.yaml')) {
          const filePath = path.join(masterPromptSetsDir, file);
          const content = fs.readFileSync(filePath, 'utf8');
          const parsed: any = yaml.load(content);

          promptSets.push({
            id: file.replace(/\.(yml|yaml)$/, ''),
            name: parsed.name || file,
            description: parsed.description || ''
          });
        }
      }

      return { success: true, promptSets };
    } catch (error) {
      log.error('Error listing master prompt sets:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get a specific master prompt set
  ipcMain.handle('get-master-prompt-set', async (_event, promptSetId: string) => {
    try {
      ensureMasterPromptSetsDirectory();
      const masterPromptSetsDir = getMasterPromptSetsDirectory();
      const filePath = path.join(masterPromptSetsDir, `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Master prompt set not found' };
      }

      const content = fs.readFileSync(filePath, 'utf8');
      const parsed: any = yaml.load(content);

      return {
        success: true,
        promptSet: {
          id: promptSetId,
          name: parsed.name || promptSetId,
          description: parsed.description || '',
          prompt: parsed.prompt || ''
        }
      };
    } catch (error) {
      log.error('Error getting master prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // Create a new master prompt set
  ipcMain.handle('create-master-prompt-set', async (_event, promptSet: any) => {
    try {
      ensureMasterPromptSetsDirectory();
      const masterPromptSetsDir = getMasterPromptSetsDirectory();

      // Create a safe filename from the name
      const safeId = promptSet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const filePath = path.join(masterPromptSetsDir, `${safeId}.yml`);

      // Check if already exists
      if (fs.existsSync(filePath)) {
        return { success: false, error: 'A master prompt set with this name already exists' };
      }

      // Validate that {transcript} is present in prompt
      const prompt = promptSet.prompt || '';
      if (!prompt.includes('{transcript}')) {
        return { success: false, error: 'Prompt must contain {transcript} placeholder' };
      }

      // Create the YAML content
      const yamlContent = {
        name: promptSet.name,
        description: promptSet.description || '',
        prompt: prompt
      };

      const yamlStr = yaml.dump(yamlContent, { lineWidth: -1, noRefs: true });
      fs.writeFileSync(filePath, yamlStr, 'utf8');

      log.info(`Created new master prompt set: ${safeId}`);
      return { success: true, id: safeId };
    } catch (error) {
      log.error('Error creating master prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // Update an existing master prompt set
  ipcMain.handle('update-master-prompt-set', async (_event, promptSetId: string, promptSet: any) => {
    try {
      const masterPromptSetsDir = getMasterPromptSetsDirectory();
      const filePath = path.join(masterPromptSetsDir, `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Master prompt set not found' };
      }

      // Validate that {transcript} is present in prompt
      const prompt = promptSet.prompt || '';
      if (!prompt.includes('{transcript}')) {
        return { success: false, error: 'Prompt must contain {transcript} placeholder' };
      }

      // Update the YAML content
      const yamlContent = {
        name: promptSet.name || promptSetId,
        description: promptSet.description || '',
        prompt: prompt
      };

      const yamlStr = yaml.dump(yamlContent, { lineWidth: -1, noRefs: true });
      fs.writeFileSync(filePath, yamlStr, 'utf8');

      log.info(`Updated master prompt set: ${promptSetId}`);
      return { success: true };
    } catch (error) {
      log.error('Error updating master prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete a master prompt set
  ipcMain.handle('delete-master-prompt-set', async (_event, promptSetId: string) => {
    try {
      const masterPromptSetsDir = getMasterPromptSetsDirectory();
      const filePath = path.join(masterPromptSetsDir, `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Master prompt set not found' };
      }

      fs.unlinkSync(filePath);

      log.info(`Deleted master prompt set: ${promptSetId}`);
      return { success: true };
    } catch (error) {
      log.error('Error deleting master prompt set:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== END MASTER PROMPT SETS ====================

  // Get job history
  // Returns only text/subject-input jobs from the last 4 weeks.
  // Auto-prunes older job metadata files.
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
      // Resolved timestamp per job (created_at/createdAt, or file mtime fallback).
      // Used for both pruning and sorting so invalid dates never randomize order.
      const jobDates = new Map<any, number>();
      const fourWeeksAgo = Date.now() - (4 * 7 * 24 * 60 * 60 * 1000);

      for (const file of files) {
        if (file.startsWith('job-') && file.endsWith('.json')) {
          try {
            const filePath = path.join(metadataDir, file);
            const content = fs.readFileSync(filePath, 'utf8');
            const job = JSON.parse(content);

            // Auto-prune jobs older than 4 weeks. Fall back to the file's mtime when
            // created_at/createdAt is missing or invalid (otherwise NaN < cutoff is
            // false, so stale jobs never prune and NaN sort order is random).
            let createdAt = new Date(job.created_at || job.createdAt).getTime();
            if (isNaN(createdAt)) {
              createdAt = fs.statSync(filePath).mtimeMs;
            }
            if (createdAt < fourWeeksAgo) {
              log.info(`[JobHistory] Pruning old job: ${file} (created ${new Date(createdAt).toISOString()})`);
              try {
                // Delete txt folder if it exists
                if (job.txt_folder && fs.existsSync(job.txt_folder)) {
                  fs.rmSync(job.txt_folder, { recursive: true, force: true });
                }
                fs.unlinkSync(filePath);
              } catch (deleteError) {
                log.warn(`[JobHistory] Failed to prune ${file}:`, deleteError);
              }
              continue;
            }

            // Only include text/subject-input jobs in history
            // Jobs with input_types field: check if all types are 'subject'
            // Jobs without input_types: skip (legacy jobs will age out)
            if (job.input_types && Array.isArray(job.input_types)) {
              const allSubjects = job.input_types.every((t: string) => t === 'subject');
              if (!allSubjects) {
                continue;
              }
            } else {
              // No input_types field — legacy job, skip from history display
              continue;
            }

            job.metadataPath = filePath;
            jobDates.set(job, createdAt);
            jobs.push(job);
          } catch (error) {
            log.warn(`Error reading job metadata file ${file}:`, error);
          }
        }
      }

      // Sort by creation date (newest first), using the resolved timestamps
      jobs.sort((a, b) => (jobDates.get(b) ?? 0) - (jobDates.get(a) ?? 0));

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
      const host = String((store as any).get('ollamaHost', 'http://localhost:11434')).replace(/\/$/, '');
      const response = await fetch(`${host}/api/tags`);
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

  // AI Setup - Get available models for a provider
  // Reads API keys from stored file if not provided
  ipcMain.handle('get-available-models', async (_event, provider: 'ollama' | 'openai' | 'claude', apiKey?: string, host?: string) => {
    try {
      log.info(`Getting available models for ${provider}`);

      // If no API key provided, read from stored keys file
      let key = apiKey;
      if (!key && (provider === 'openai' || provider === 'claude')) {
        const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
        if (fs.existsSync(apiKeysPath)) {
          const data = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
          if (provider === 'openai') {
            key = data.openaiApiKey;
          } else if (provider === 'claude') {
            key = data.claudeApiKey;
          }
        }
      }

      const models = await AIManagerService.getAvailableModels(provider, key, host);
      log.info(`Found ${models.length} models for ${provider}`);
      return { success: true, models };
    } catch (error) {
      log.error(`Error getting models for ${provider}:`, error);
      return { success: false, models: [], error: String(error) };
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

  // ==================== MASTER ANALYSIS ====================

  // Select master video file
  ipcMain.handle('select-master-video', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Master Video',
        filters: [
          { name: 'Video Files', extensions: ['mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v', 'wmv', 'flv'] }
        ],
        properties: ['openFile']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, videoPath: null };
      }

      return { success: true, videoPath: result.filePaths[0] };
    } catch (error) {
      log.error('Error selecting master video:', error);
      return { success: false, error: String(error) };
    }
  });

  // Analyze master video
  ipcMain.handle('analyze-master', async (_event, params: { videoPath: string; masterPromptSet?: string; jobId?: string }) => {
    let jobId: string | undefined;
    try {
      log.info('[IPC] Starting master analysis:', params.videoPath);

      const settings = (store as any).store;

      // Load API keys
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
      let apiKeys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }

      // Get AI configuration
      // Prefer newer metadataProvider/metadataModel fields over legacy aiProvider/aiModel
      const aiProvider = settings.metadataProvider || settings.aiProvider || 'ollama';
      const aiModel = settings.metadataModel || settings.aiModel || settings.ollamaModel;
      const fullModel = aiModel ? `${aiProvider}:${aiModel}` : undefined;

      // No model configured — surface a clear error rather than silently routing to a
      // local Ollama fallback (which fails confusingly on a claude/openai setup).
      if (!fullModel) {
        return { success: false, error: 'No AI model selected. Please select an AI model in Settings.' };
      }

      let apiKey = undefined;
      if (aiProvider === 'openai') {
        apiKey = apiKeys.openaiApiKey;
      } else if (aiProvider === 'claude') {
        apiKey = apiKeys.claudeApiKey;
      }

      // Create cancellation tracking
      let cancelled = false;
      jobId = params.jobId || `master-${Date.now()}`;

      const cancelCallback = () => {
        cancelled = true;
        log.info(`[IPC] Master analysis ${jobId} cancelled`);
      };

      runningJobs.set(jobId, { cancel: cancelCallback });

      // Progress callback
      const progressCallback = (phase: string, message: string, percent?: number) => {
        sendToRenderer('master-analysis-progress', {
          jobId,
          phase,
          message,
          percent
        });
      };

      // Load master prompt set
      let masterPrompt: string | undefined;
      if (params.masterPromptSet) {
        const masterPromptSetsDir = getMasterPromptSetsDirectory();
        const promptPath = path.join(masterPromptSetsDir, `${params.masterPromptSet}.yml`);
        if (fs.existsSync(promptPath)) {
          const content = fs.readFileSync(promptPath, 'utf8');
          const parsed: any = yaml.load(content);
          masterPrompt = parsed.prompt;
          log.info(`[IPC] Using master prompt set: ${params.masterPromptSet}`);
        } else {
          log.warn(`[IPC] Master prompt set not found: ${params.masterPromptSet}, using default`);
        }
      }

      // Enqueue the analysis job
      const result = await enqueueAiGenerationJob(jobId, async () => {
        const analysisResult = await MasterAnalyzerService.analyze({
          videoPath: params.videoPath,
          // Same default as get-settings / MetadataGeneratorService.getDefaultOutputPath()
          // — an unset directory must not reach saveReport as undefined.
          outputDirectory: settings.outputDirectory || path.join(os.homedir(), 'Documents', 'ContentStudio Output'),
          masterPrompt,
          aiProvider,
          aiModel: fullModel,
          aiApiKey: apiKey,
          aiHost: settings.ollamaHost || 'http://localhost:11434',
          progressCallback,
          cancelCallback: () => cancelled
        });

        return analysisResult;
      });

      return result;

    } catch (error) {
      log.error('Error in master analysis:', error);
      return { success: false, error: String(error) };
    } finally {
      // Always release the cancel closure — on rejection too, not just success.
      if (jobId) {
        runningJobs.delete(jobId);
      }
    }
  });

  // Get master report
  ipcMain.handle('get-master-report', async (_event, reportPath: string) => {
    try {
      const report = MasterAnalyzerService.loadReport(reportPath);
      if (report) {
        return { success: true, report };
      } else {
        return { success: false, error: 'Report not found' };
      }
    } catch (error) {
      log.error('Error loading master report:', error);
      return { success: false, error: String(error) };
    }
  });

  // List master reports
  ipcMain.handle('list-master-reports', async () => {
    try {
      const settings = (store as any).store;
      const outputDirectory = settings.outputDirectory;

      if (!outputDirectory) {
        return { success: true, reports: [] };
      }

      const reports = MasterAnalyzerService.listReports(outputDirectory);
      return { success: true, reports };
    } catch (error) {
      log.error('Error listing master reports:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete master report
  ipcMain.handle('delete-master-report', async (_event, reportPath: string) => {
    try {
      if (fs.existsSync(reportPath)) {
        fs.unlinkSync(reportPath);
        log.info(`Deleted master report: ${reportPath}`);
        return { success: true };
      } else {
        return { success: false, error: 'Report not found' };
      }
    } catch (error) {
      log.error('Error deleting master report:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== TRANSCRIPT IMPORT ====================

  // Pick one or more AutoCutStudio transcript JSON files, validate them, and
  // return a per-story summary the renderer turns into input items. The heavy
  // lifting (words -> segments) happens later in the pipeline via InputHandler.
  ipcMain.handle('import-transcript', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Import Transcript',
        filters: [
          { name: 'Transcript JSON', extensions: ['json'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile', 'multiSelections']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, items: [], errors: [] };
      }

      const items: any[] = [];
      const errors: string[] = [];

      for (const filePath of result.filePaths) {
        try {
          const raw = await fs.promises.readFile(filePath, 'utf-8');
          const parsed = parseTranscriptImport(raw, filePath);
          if (parsed.ok) {
            items.push({ path: filePath, ...parsed.data.summary });
          } else {
            errors.push(`${path.basename(filePath)}: ${parsed.error}`);
          }
        } catch (err) {
          errors.push(`${path.basename(filePath)}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }

      return { success: items.length > 0, items, errors };
    } catch (error) {
      log.error('Error importing transcript:', error);
      return { success: false, items: [], errors: [String(error)] };
    }
  });

  // ==================== END TRANSCRIPT IMPORT ====================

  // ==================== EPISODE SPLITTER ====================

  // Select episode audio files
  ipcMain.handle('select-episode-audio', async () => {
    try {
      const result = await dialog.showOpenDialog({
        title: 'Select Audio/Video Files',
        filters: [
          { name: 'Audio/Video Files', extensions: ['mp3', 'wav', 'aiff', 'aif', 'm4a', 'aac', 'flac', 'ogg', 'mp4', 'mov', 'mkv', 'avi', 'webm', 'm4v'] },
          { name: 'All Files', extensions: ['*'] }
        ],
        properties: ['openFile', 'multiSelections']
      });

      if (result.canceled || result.filePaths.length === 0) {
        return { success: false, filePaths: [] };
      }

      return { success: true, filePaths: result.filePaths };
    } catch (error) {
      log.error('Error selecting episode audio:', error);
      return { success: false, error: String(error) };
    }
  });

  // Analyze episodes
  ipcMain.handle('analyze-episodes', async (_event, params: { audioPaths: string[]; jobId?: string }) => {
    let jobId: string | undefined;
    try {
      log.info('[IPC] Starting episode analysis:', params.audioPaths.length, 'files');

      const settings = (store as any).store;

      // Load API keys
      const apiKeysPath = path.join(app.getPath('userData'), 'api-keys.json');
      let apiKeys: any = {};
      if (fs.existsSync(apiKeysPath)) {
        apiKeys = JSON.parse(fs.readFileSync(apiKeysPath, 'utf-8'));
      }

      // Get AI configuration
      const aiProvider = settings.metadataProvider || settings.aiProvider || 'ollama';
      const aiModel = settings.metadataModel || settings.aiModel || settings.ollamaModel;
      const fullModel = aiModel ? `${aiProvider}:${aiModel}` : undefined;

      // No model configured — surface a clear error rather than silently routing to a
      // local Ollama fallback (which fails confusingly on a claude/openai setup).
      if (!fullModel) {
        return { success: false, error: 'No AI model selected. Please select an AI model in Settings.' };
      }

      let apiKey = undefined;
      if (aiProvider === 'openai') {
        apiKey = apiKeys.openaiApiKey;
      } else if (aiProvider === 'claude') {
        apiKey = apiKeys.claudeApiKey;
      }

      // Create cancellation tracking
      let cancelled = false;
      jobId = params.jobId || `episode-${Date.now()}`;

      const cancelCallback = () => {
        cancelled = true;
        log.info(`[IPC] Episode analysis ${jobId} cancelled`);
      };

      runningJobs.set(jobId, { cancel: cancelCallback });

      // Progress callback
      const progressCallback = (phase: string, message: string, percent?: number) => {
        sendToRenderer('episode-splitter-progress', {
          jobId,
          phase,
          message,
          percent
        });
      };

      // Enqueue the analysis job
      const result = await enqueueAiGenerationJob(jobId, async () => {
        const analysisResult = await EpisodeSplitterService.analyze({
          audioPaths: params.audioPaths,
          // Same default as get-settings / MetadataGeneratorService.getDefaultOutputPath()
          // — an unset directory must not reach saveReport as undefined.
          outputDirectory: settings.outputDirectory || path.join(os.homedir(), 'Documents', 'ContentStudio Output'),
          aiProvider,
          aiModel: fullModel,
          aiApiKey: apiKey,
          aiHost: settings.ollamaHost || 'http://localhost:11434',
          jobId,
          progressCallback,
          cancelCallback: () => cancelled
        });

        return analysisResult;
      });

      return result;

    } catch (error) {
      log.error('Error in episode analysis:', error);
      return { success: false, error: String(error) };
    } finally {
      // Always release the cancel closure — on rejection too, not just success.
      if (jobId) {
        runningJobs.delete(jobId);
      }
    }
  });

  // List episode reports
  ipcMain.handle('list-episode-reports', async () => {
    try {
      const settings = (store as any).store;
      const outputDirectory = settings.outputDirectory;

      if (!outputDirectory) {
        return { success: true, reports: [] };
      }

      const reports = EpisodeSplitterService.listReports(outputDirectory);
      return { success: true, reports };
    } catch (error) {
      log.error('Error listing episode reports:', error);
      return { success: false, error: String(error) };
    }
  });

  // Get episode report
  ipcMain.handle('get-episode-report', async (_event, reportPath: string) => {
    try {
      const report = EpisodeSplitterService.loadReport(reportPath);
      if (report) {
        return { success: true, report };
      } else {
        return { success: false, error: 'Report not found' };
      }
    } catch (error) {
      log.error('Error loading episode report:', error);
      return { success: false, error: String(error) };
    }
  });

  // Delete episode report
  ipcMain.handle('delete-episode-report', async (_event, reportPath: string) => {
    try {
      if (fs.existsSync(reportPath)) {
        fs.unlinkSync(reportPath);
        log.info(`Deleted episode report: ${reportPath}`);
        return { success: true };
      } else {
        return { success: false, error: 'Report not found' };
      }
    } catch (error) {
      log.error('Error deleting episode report:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== END EPISODE SPLITTER ====================

  // ==================== ANALYTICS ====================

  const { analyticsStore, ingestServer } = analytics;
  const distillation = new DistillationService(analyticsStore);

  // Channel registry CRUD
  ipcMain.handle('analytics-list-channels', async () => {
    try {
      return { success: true, channels: analyticsStore.listChannels() };
    } catch (error) {
      log.error('Error listing analytics channels:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('analytics-add-channel', async (_event, entry: ChannelRegistryEntry) => {
    try {
      if (!entry || !entry.channelId || !entry.name) {
        return { success: false, error: 'Channel requires channelId and name' };
      }
      const channels = analyticsStore.listChannels();
      if (channels.some((c) => c.channelId === entry.channelId)) {
        return { success: false, error: `Channel ${entry.channelId} is already registered` };
      }
      channels.push({ channelId: entry.channelId, name: entry.name, promptSets: entry.promptSets || [] });
      await analyticsStore.saveChannels(channels);
      return { success: true, channels };
    } catch (error) {
      log.error('Error adding analytics channel:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('analytics-update-channel', async (_event, channelId: string, entry: ChannelRegistryEntry) => {
    try {
      const channels = analyticsStore.listChannels();
      const index = channels.findIndex((c) => c.channelId === channelId);
      if (index === -1) {
        return { success: false, error: `Channel ${channelId} is not registered` };
      }
      channels[index] = { channelId: entry.channelId, name: entry.name, promptSets: entry.promptSets || [] };
      await analyticsStore.saveChannels(channels);
      return { success: true, channels };
    } catch (error) {
      log.error('Error updating analytics channel:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('analytics-delete-channel', async (_event, channelId: string) => {
    try {
      const channels = analyticsStore.listChannels();
      const remaining = channels.filter((c) => c.channelId !== channelId);
      if (remaining.length === channels.length) {
        return { success: false, error: `Channel ${channelId} is not registered` };
      }
      await analyticsStore.saveChannels(remaining);
      return { success: true, channels: remaining };
    } catch (error) {
      log.error('Error deleting analytics channel:', error);
      return { success: false, error: String(error) };
    }
  });

  // Ingest server info: port, token, status (incl. port-conflict error state)
  ipcMain.handle('analytics-get-ingest-info', async () => {
    try {
      const status = ingestServer.getStatus();
      return {
        success: true,
        port: status.port,
        token: ingestServer.getToken(),
        running: status.running,
        error: status.error,
        lastIngestAt: status.lastIngestAt,
      };
    } catch (error) {
      log.error('Error getting ingest info:', error);
      return { success: false, error: String(error) };
    }
  });

  // Per-channel summary: video count, snapshot count, last capture time
  ipcMain.handle('analytics-get-summary', async () => {
    try {
      const channels = analyticsStore.listChannels().map((channel) => {
        const stats = analyticsStore.getSnapshotStats(channel.channelId);
        return {
          channelId: channel.channelId,
          name: channel.name,
          promptSets: channel.promptSets,
          videoCount: analyticsStore.listVideos(channel.channelId).length,
          snapshotCount: stats.snapshotCount,
          lastIngestAt: stats.lastCapturedAt,
        };
      });
      return { success: true, channels };
    } catch (error) {
      log.error('Error getting analytics summary:', error);
      return { success: false, error: String(error) };
    }
  });

  ipcMain.handle('analytics-run-distillation', async () => {
    try {
      const summary = await distillation.runDistillation();
      return { success: true, summary };
    } catch (error) {
      log.error('Error running distillation:', error);
      return { success: false, error: String(error) };
    }
  });

  // Insights: per-channel + cross-channel (null where not yet computed)
  ipcMain.handle('analytics-get-insights', async () => {
    try {
      const channels = analyticsStore.listChannels().map((channel) => ({
        channelId: channel.channelId,
        name: channel.name,
        insights: analyticsStore.loadChannelInsights(channel.channelId),
      }));
      return {
        success: true,
        channels,
        crossChannel: analyticsStore.loadCrossChannelInsights(),
      };
    } catch (error) {
      log.error('Error getting analytics insights:', error);
      return { success: false, error: String(error) };
    }
  });

  // DEV: seed plausible fake data so the whole loop can be exercised end-to-end
  ipcMain.handle('analytics-seed-fake-data', async () => {
    try {
      const summary = await seedFakeData(analyticsStore);
      return { success: true, summary };
    } catch (error) {
      log.error('Error seeding fake analytics data:', error);
      return { success: false, error: String(error) };
    }
  });

  // ==================== END ANALYTICS ====================

  // ==================== YOUTUBE (OAuth + API collector) ====================

  const { youtubeAuth, apiCollector } = analytics;

  // Kick off the interactive OAuth flow for ONE channel. Resolves with the
  // discovered {channelId, channelTitle}. On failure the NAMED error message is
  // returned verbatim so the UI can show it (missing creds, denied, timeout…).
  ipcMain.handle('youtube-connect-channel', async () => {
    try {
      const result = await youtubeAuth.connectChannel();
      return { success: true, channelId: result.channelId, channelTitle: result.channelTitle };
    } catch (error) {
      log.error('YouTube connect failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Revoke + remove a channel's tokens.
  ipcMain.handle('youtube-disconnect-channel', async (_event, channelId: string) => {
    try {
      if (!channelId) return { success: false, error: 'channelId is required' };
      await youtubeAuth.disconnect(channelId);
      return { success: true };
    } catch (error) {
      log.error('YouTube disconnect failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Connections with EVERY secret stripped (never send tokens to the renderer).
  ipcMain.handle('youtube-list-connections', async () => {
    try {
      return { success: true, connections: youtubeAuth.listConnections() };
    } catch (error) {
      log.error('YouTube list connections failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Run a collection cycle now — all connected channels, or one when channelId given.
  ipcMain.handle('youtube-collect-now', async (_event, channelId?: string) => {
    try {
      const results = await apiCollector.collectAll(channelId);
      return { success: true, results };
    } catch (error) {
      log.error('YouTube collect-now failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // Collector schedule + per-channel last-run stats.
  ipcMain.handle('youtube-get-collector-state', async () => {
    try {
      return { success: true, state: apiCollector.getState() };
    } catch (error) {
      log.error('YouTube get collector state failed:', error);
      return { success: false, error: error instanceof Error ? error.message : String(error) };
    }
  });

  // ==================== END YOUTUBE ====================

  log.info('IPC handlers registered');
}
