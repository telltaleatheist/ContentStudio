import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';
import { PythonService } from '../services/python-service';
import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';

/**
 * IPC Handlers
 * Handles communication between renderer and main process
 */

export function setupIpcHandlers(store: Store<any>, pythonService: PythonService | null) {

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

  // Generate metadata
  ipcMain.handle('generate-metadata', async (_event, params) => {
    try {
      if (!pythonService) {
        throw new Error('Python service not initialized');
      }

      log.info('Starting metadata generation with params:', params);

      // Get settings using electron-store API
      const settings = (store as any).store;

      // Prepare metadata generation parameters
      const metadataParams = {
        inputs: params.inputs,
        platform: params.platform || settings.defaultPlatform,
        mode: params.mode || settings.defaultMode,
        aiProvider: settings.aiProvider,
        aiModel: settings.aiProvider === 'ollama' ? settings.ollamaModel : undefined,
        aiApiKey: settings.aiProvider === 'openai' ? settings.openaiApiKey :
                  settings.aiProvider === 'claude' ? settings.claudeApiKey : undefined,
        aiHost: settings.aiProvider === 'ollama' ? settings.ollamaHost : undefined,
        outputPath: params.outputPath || settings.outputDirectory,
        promptSet: params.promptSet || settings.promptSet || 'youtube-telltale'
      };

      // Send progress update
      const mainWindow = BrowserWindow.getAllWindows()[0];
      if (mainWindow) {
        mainWindow.webContents.send('generation-progress', {
          phase: 'starting',
          message: 'Initializing metadata generation...'
        });
      }

      // Generate metadata
      const result = await pythonService.generateMetadata(metadataParams);

      if (mainWindow) {
        if (result.success) {
          mainWindow.webContents.send('generation-progress', {
            phase: 'complete',
            message: 'Metadata generation complete!'
          });
        } else {
          mainWindow.webContents.send('generation-progress', {
            phase: 'error',
            message: result.error || 'Unknown error'
          });
        }
      }

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

  // List all prompt sets
  ipcMain.handle('list-prompt-sets', async () => {
    try {
      const promptSetsDir = path.join(app.getAppPath(), 'python', 'prompts', 'prompt_sets');

      if (!fs.existsSync(promptSetsDir)) {
        return { success: false, error: 'Prompt sets directory not found' };
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
            platform: parsed.platform || 'youtube'
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
      const promptSetsDir = path.join(app.getAppPath(), 'python', 'prompts', 'prompt_sets');
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
          platform: parsed.platform || 'youtube',
          editorial_guidelines: parsed.editorial_guidelines || '',
          generation_instructions: parsed.generation_instructions || '',
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
      const promptSetsDir = path.join(app.getAppPath(), 'python', 'prompts', 'prompt_sets');

      // Create a safe filename from the name
      const safeId = promptSet.name.toLowerCase().replace(/[^a-z0-9]+/g, '-');
      const filePath = path.join(promptSetsDir, `${safeId}.yml`);

      // Check if already exists
      if (fs.existsSync(filePath)) {
        return { success: false, error: 'A prompt set with this name already exists' };
      }

      // Create the YAML content
      const yamlContent = {
        name: promptSet.name,
        platform: promptSet.platform || 'youtube',
        editorial_guidelines: promptSet.editorial_guidelines || '',
        generation_instructions: promptSet.generation_instructions || '',
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
      const promptSetsDir = path.join(app.getAppPath(), 'python', 'prompts', 'prompt_sets');
      const filePath = path.join(promptSetsDir, `${promptSetId}.yml`);

      if (!fs.existsSync(filePath)) {
        return { success: false, error: 'Prompt set not found' };
      }

      // Read existing file
      const content = fs.readFileSync(filePath, 'utf8');
      const existingData: any = yaml.load(content) || {};

      // Update the fields
      existingData.name = promptSet.name || existingData.name;
      existingData.platform = promptSet.platform || existingData.platform;
      existingData.editorial_guidelines = promptSet.editorial_guidelines || '';
      existingData.generation_instructions = promptSet.generation_instructions || '';
      existingData.description_links = promptSet.description_links || '';

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
      const promptSetsDir = path.join(app.getAppPath(), 'python', 'prompts', 'prompt_sets');
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

  log.info('IPC handlers registered');
}
