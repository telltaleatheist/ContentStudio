import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as log from 'electron-log';
import Store from 'electron-store';
import { PythonService } from './services/python-service';
import { setupIpcHandlers } from './ipc/ipc-handlers';

/**
 * LaunchPad - Main Electron Process
 * AI-powered metadata generation for YouTube and Spreaker
 */

// Configure logging
log.transports.console.level = 'info';
log.transports.file.level = 'debug';

// Initialize electron-store for settings (outputDirectory will be set after app is ready)
let store: Store<any>;

let mainWindow: BrowserWindow | null = null;
let pythonService: PythonService | null = null;

// Note: Single instance lock would go here but causes issues with app.requestSingleInstanceLock
// being called before app is ready. Skipping for now.

function createMainWindow() {
  // Icon path - works in both development and production
  const iconPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, '..', '..', 'assets', 'icon.png')
    : path.join(process.resourcesPath, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    backgroundColor: '#ffffff',
    title: 'ContentStudio',
    icon: iconPath,
    webPreferences: {
      preload: path.join(__dirname, '..', 'preload', 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    },
    show: false
  });

  // Load the frontend
  // In development, load from Angular dev server
  if (process.env.NODE_ENV === 'development') {
    mainWindow.loadURL('http://localhost:4200');
  } else {
    // In production, load from built Angular files
    const frontendPath = path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser', 'index.html');
    mainWindow.loadFile(frontendPath);
  }

  // Show window when ready
  mainWindow.once('ready-to-show', () => {
    mainWindow?.show();
    log.info('Main window shown');
  });

  // Open DevTools in development (disabled by default, use Cmd+Option+I to open)
  // if (process.env.NODE_ENV === 'development') {
  //   mainWindow.webContents.openDevTools();
  // }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  try {
    log.info('ContentStudio starting...');

    // Initialize electron-store after app is ready
    store = new Store<any>({
      defaults: {
        aiProvider: 'ollama',
        ollamaModel: 'cogito:70b',
        ollamaHost: 'http://localhost:11434',
        openaiApiKey: '',
        claudeApiKey: '',
        defaultPlatform: 'youtube',
        defaultMode: 'individual',
        outputDirectory: path.join(app.getPath('documents'), 'ContentStudio Output')
      }
    });

    // Initialize Python service
    pythonService = new PythonService(store);
    const pythonReady = await pythonService.initialize();

    if (!pythonReady) {
      log.error('Failed to initialize Python service');
      // Continue anyway - show error in UI
    }

    // Set up IPC handlers
    setupIpcHandlers(store, pythonService);

    // Create main window
    createMainWindow();

    // macOS-specific behavior
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) {
        createMainWindow();
      }
    });

  } catch (error) {
    log.error('Error during application initialization:', error);
    app.quit();
  }
});

// Quit when all windows are closed, except on macOS
app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

// Cleanup before quitting
app.on('before-quit', () => {
  log.info('Application is quitting...');
  if (pythonService) {
    pythonService.cleanup();
  }
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
});

export { mainWindow, store, pythonService };
