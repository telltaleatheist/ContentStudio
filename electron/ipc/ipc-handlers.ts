import { ipcMain, dialog, app, BrowserWindow } from 'electron';
import Store from 'electron-store';
import * as log from 'electron-log';
import { PythonService } from '../services/python-service';
import * as fs from 'fs';

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
        outputPath: params.outputPath || settings.outputDirectory
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

  log.info('IPC handlers registered');
}
