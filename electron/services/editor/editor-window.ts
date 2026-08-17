// electron/services/editor/editor-window.ts
import { BrowserWindow } from 'electron';
import * as log from 'electron-log';
import * as path from 'path';

/**
 * The timeline editor's own BrowserWindow.
 *
 * Ported from AutoCutStudio's WindowService.createEditorWindow, minus the alignment
 * wizard branch (the wizard does not travel; only the editor does). The behaviour that
 * matters and is kept verbatim:
 *
 *   - ONE editor window, reused. A second open() focuses the existing window rather than
 *     opening another; whatever session it holds stays loaded.
 *   - Deliberately NOT a child of the main window. On macOS a BrowserWindow with a
 *     `parent` is an attached child that is pinned to the parent and cannot be dragged
 *     onto a separate display — DisplayLink virtual monitors in particular. The editor is
 *     a standalone tool window the user moves to a second monitor, so it must be top-level
 *     and independently movable.
 *   - 1600×900, min 1200×700 — a timeline needs the room.
 *
 * What is NEW here, and only here: `webSecurity: false`. The editor plays the session's
 * source media by pointing DOM <video>/<audio> at `file://` URLs. In a packaged build the
 * page itself is file:// and in dev it is http://localhost:4200, and in BOTH cases the
 * media is file:// — so the fetch is cross-origin and is blocked with webSecurity on. This
 * is set for the EDITOR WINDOW ONLY; the main window keeps webSecurity at its default.
 */

let editorWindow: BrowserWindow | null = null;

/** Dev mode is decided exactly as main.ts decides it — one signal, no second opinion. */
function isDevelopment(): boolean {
  return process.env.NODE_ENV === 'development';
}

/**
 * The preload bundle, resolved from this compiled file's location
 * (`dist/main/services/editor/`) to `dist/preload/preload.js`. This is the SAME preload
 * the main window loads (main.ts: `path.join(__dirname, '..', 'preload', 'preload.js')`
 * from `dist/main/`) — the editor renderer talks to the identical `window.launchpad`.
 */
function preloadPath(): string {
  return path.join(__dirname, '..', '..', '..', 'preload', 'preload.js');
}

/**
 * The built Angular index, resolved the same way main.ts resolves it (repo root is four
 * levels up from `dist/main/services/editor/`, as it is two levels up from `dist/main/`).
 */
function frontendIndexPath(): string {
  return path.join(__dirname, '..', '..', '..', '..', 'frontend', 'dist', 'frontend', 'browser', 'index.html');
}

/**
 * Open (or focus) the editor window and return it.
 *
 * Dev loads `http://localhost:4200/editor`; packaged loads the built index with
 * `?view=editor`, because ContentStudio uses history routing and `loadFile` cannot carry
 * a path — the app shell reads `view=editor` and routes itself.
 */
export function createEditorWindow(): BrowserWindow {
  if (editorWindow && !editorWindow.isDestroyed()) {
    // Reuse the single editor window — focus and return it, never open a second one.
    if (editorWindow.isMinimized()) editorWindow.restore();
    editorWindow.focus();
    return editorWindow;
  }

  editorWindow = new BrowserWindow({
    width: 1600,
    height: 900,
    minWidth: 1200,
    minHeight: 700,
    title: 'Timeline Editor',
    backgroundColor: '#1e1e1e',
    autoHideMenuBar: true,
    webPreferences: {
      preload: preloadPath(),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // See the file comment: file:// media playback from an http:// (dev) or file://
      // (packaged) document. EDITOR WINDOW ONLY.
      webSecurity: false
    }
  });

  if (isDevelopment()) {
    const url = 'http://localhost:4200/editor';
    log.info(`Loading editor window from: ${url}`);
    editorWindow.loadURL(url);
  } else {
    const indexPath = frontendIndexPath();
    log.info(`Loading editor window from: ${indexPath} (view=editor)`);
    editorWindow.loadFile(indexPath, { query: { view: 'editor' } });
  }

  editorWindow.on('closed', () => {
    editorWindow = null;
  });

  return editorWindow;
}

/** The editor window if one is open, else null. */
export function getEditorWindow(): BrowserWindow | null {
  return editorWindow && !editorWindow.isDestroyed() ? editorWindow : null;
}
