/**
 * Stands in for `electron` / `electron-log` when the compiled main process is driven from
 * plain Node (scripts/generate-metadata-cli.js).
 *
 * DIFFERENT FROM tools/_electron-stub.js ON PURPOSE. That one answers `app.getPath()` with
 * `/tmp`, which is right for a pure-function check and wrong here: this script runs the REAL
 * pipeline, which reads the operator's components, analytics store and settings out of the
 * real userData directory. Every value below is the value Electron itself would return on
 * this machine — nothing here is a substitute behaviour, only the same numbers without an
 * Electron runtime to ask.
 */
const path = require('path');
const os = require('os');

const APP_NAME = 'contentstudio';
const HOME = os.homedir();
// Exactly what Electron's `app.getPath('userData')` returns on macOS for this app.
const USER_DATA = path.join(HOME, 'Library', 'Application Support', APP_NAME);
const REPO_ROOT = path.join(__dirname, '..');

if (process.platform !== 'darwin') {
  throw new Error(
    `This shim hard-codes the macOS userData location (${USER_DATA}); it is running on ` +
      `${process.platform}, where Electron would answer somewhere else.`
  );
}

const PATHS = {
  home: HOME,
  appData: path.join(HOME, 'Library', 'Application Support'),
  userData: USER_DATA,
  sessionData: USER_DATA,
  temp: os.tmpdir(),
  downloads: path.join(HOME, 'Downloads'),
  documents: path.join(HOME, 'Documents'),
  desktop: path.join(HOME, 'Desktop'),
  logs: path.join(HOME, 'Library', 'Logs', APP_NAME),
  exe: process.execPath,
  module: process.execPath,
};

const app = {
  isPackaged: false,
  name: APP_NAME,
  getName: () => APP_NAME,
  getVersion: () => require(path.join(REPO_ROOT, 'package.json')).version,
  getAppPath: () => REPO_ROOT,
  getPath: (name) => {
    const value = PATHS[name];
    if (!value) {
      throw new Error(`electron shim: app.getPath("${name}") is not one this shim knows`);
    }
    return value;
  },
  on: () => {},
  whenReady: () => Promise.resolve(),
};

/**
 * Registration only. Nothing in this process has a renderer, so a handler registered here is
 * never invoked — this exists so a module that registers IPC at import time can be imported,
 * not so any IPC can happen.
 */
const ipcMain = {
  handle: () => {},
  handleOnce: () => {},
  on: () => {},
  once: () => {},
  removeHandler: () => {},
  removeAllListeners: () => {},
};

const log = {
  info: (...a) => console.error('[log.info]', ...a),
  warn: (...a) => console.error('[log.warn]', ...a),
  error: (...a) => console.error('[log.error]', ...a),
  debug: () => {},
  verbose: () => {},
  silly: () => {},
  log: (...a) => console.error('[log]', ...a),
  transports: { file: {}, console: {} },
  scope: () => log,
};

// electron-log is imported as `import * as log from 'electron-log'` (so the module object
// itself is the logger) and elsewhere as a default import; both shapes point at the same one.
module.exports = log;
module.exports.default = log;
module.exports.app = app;
module.exports.ipcMain = ipcMain;
module.exports.shell = { openPath: () => Promise.resolve(''), openExternal: () => Promise.resolve() };
module.exports.dialog = {};
module.exports.BrowserWindow = { getAllWindows: () => [] };
module.exports.USER_DATA = USER_DATA;
module.exports.REPO_ROOT = REPO_ROOT;
