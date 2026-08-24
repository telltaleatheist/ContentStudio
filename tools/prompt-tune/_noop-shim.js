// No-op stand-ins for electron/electron-log so dist modules load outside Electron.
const noop = () => {};
module.exports = {
  info: noop, warn: noop, error: noop, debug: noop,
  app: { getPath: () => '/tmp', isPackaged: false, getAppPath: () => process.cwd() },
  default: { info: noop, warn: noop, error: noop, debug: noop },
};
