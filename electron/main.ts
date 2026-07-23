import { app, BrowserWindow, ipcMain } from 'electron';
import * as path from 'path';
import * as log from 'electron-log';
import Store from 'electron-store';
import { setupIpcHandlers } from './ipc/ipc-handlers';
import { AnalyticsStoreService } from './services/analytics/analytics-store.service';
import { IngestServerService, DEFAULT_INGEST_PORT } from './services/analytics/ingest-server.service';
import { DistillationService } from './services/analytics/distillation.service';
import { YouTubeAuthService } from './services/youtube/youtube-auth.service';
import { YouTubeApiService } from './services/youtube/youtube-api.service';
import { ApiCollectorService } from './services/youtube/api-collector.service';

/**
 * ContentStudio - Main Electron Process
 * AI-powered metadata generation for YouTube and Spreaker
 * Pure TypeScript implementation - no Python dependencies!
 */

// Configure logging with rotation
log.transports.console.level = 'info';
log.transports.file.level = 'debug';

// Log rotation settings
log.transports.file.maxSize = 5 * 1024 * 1024; // 5 MB max file size
log.transports.file.format = '[{y}-{m}-{d} {h}:{i}:{s}.{ms}] [{level}] {text}';

// Keep only the most recent log file (delete old backups on start)
log.transports.file.archiveLog = (oldLogFile) => {
  // Delete old log files on startup to save space
  const fs = require('fs');
  try {
    if (fs.existsSync(oldLogFile)) {
      fs.unlinkSync(oldLogFile);
      log.info(`Deleted old log file: ${oldLogFile}`);
    }
  } catch (error) {
    log.warn(`Failed to delete old log: ${error}`);
  }
};

// Initialize electron-store for settings (outputDirectory will be set after app is ready)
let store: Store<any>;

let mainWindow: BrowserWindow | null = null;

// Held so the scheduled collector loop can be stopped on quit.
let apiCollector: ApiCollectorService | null = null;

// Note: Single instance lock would go here but causes issues with app.requestSingleInstanceLock
// being called before app is ready. Skipping for now.

function createMainWindow() {
  // Icon path - works in both development and production
  const iconPath = process.env.NODE_ENV === 'development'
    ? path.join(__dirname, '..', '..', 'assets', 'icon.png')
    : path.join(process.resourcesPath, 'assets', 'icon.png');

  mainWindow = new BrowserWindow({
    width: 1400,
    height: 1000,
    minWidth: 1000,
    minHeight: 800,
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
    // In production, load from built Angular files (Angular 17+ outputs to browser/ subfolder)
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

  // Handle reload in production - always reload index.html to handle Angular routing
  if (process.env.NODE_ENV !== 'development') {
    mainWindow.webContents.on('before-input-event', (event, input) => {
      if (input.type === 'keyDown' && (input.key === 'r' || input.key === 'R') && (input.meta || input.control)) {
        event.preventDefault();
        const frontendPath = path.join(__dirname, '..', '..', 'frontend', 'dist', 'frontend', 'browser', 'index.html');
        mainWindow?.loadFile(frontendPath);
      }
    });
  }

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
        aiProvider: 'openai',
        ollamaModel: 'gpt-4o', // Used for all providers (OpenAI, Claude, and Ollama)
        ollamaHost: 'http://localhost:11434',
        openaiApiKey: '',
        claudeApiKey: '',
        defaultPlatform: 'youtube',
        defaultMode: 'individual',
        outputDirectory: path.join(app.getPath('documents'), 'ContentStudio Output'),
        whisperModel: 'small',
        analyticsIngestPort: DEFAULT_INGEST_PORT
      }
    });

    // Analytics feedback loop: rolling snapshot store + localhost ingest server.
    // If the port is taken the server records an error state (surfaced via the
    // analytics-get-ingest-info IPC) instead of silently picking another port.
    const analyticsStore = new AnalyticsStoreService(path.join(app.getPath('userData'), 'analytics'));
    // Shared distillation service: the ingest server uses it to re-distill (debounced)
    // whenever the extension pushes new snapshots, and the API collector reuses it too.
    const distillation = new DistillationService(analyticsStore);
    const ingestServer = new IngestServerService(
      analyticsStore,
      (store as any).get('analyticsIngestPort') || DEFAULT_INGEST_PORT,
      distillation
    );
    await ingestServer.start();

    // YouTube OAuth + API-side analytics collector. Tokens live under userData;
    // the collector self-schedules (startup catch-up + every 6h while open) and
    // isolates per-channel failures. compactOldSnapshots() is scheduled here too.
    const userDataPath = app.getPath('userData');
    const youtubeAuth = new YouTubeAuthService(userDataPath, analyticsStore);
    const youtubeApi = new YouTubeApiService(youtubeAuth);
    apiCollector = new ApiCollectorService(
      analyticsStore,
      youtubeAuth,
      youtubeApi,
      distillation,
      analyticsStore.getBaseDir()
    );

    // Set up IPC handlers
    setupIpcHandlers(store, { analyticsStore, ingestServer, youtubeAuth, apiCollector });

    // Collection is manual (user clicks "Refresh data" on the Analytics page).
    // At startup we only clear stale per-channel errors from a prior session.
    apiCollector.clearStaleErrors();

    // Recompute verdicts/insights once from whatever snapshots are already on disk,
    // so the Analytics page reflects the latest data (and any distillation logic
    // changes) on launch — no API calls, fire-and-forget.
    void distillation.runDistillation().catch((err) => {
      log.error('Startup distillation failed:', err);
    });

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
});

// Handle uncaught exceptions
process.on('uncaughtException', (error) => {
  log.error('Uncaught exception:', error);
});

process.on('unhandledRejection', (reason, promise) => {
  log.error('Unhandled rejection at:', promise, 'reason:', reason);
});

export { mainWindow, store };
