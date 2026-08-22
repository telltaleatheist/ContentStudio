/**
 * Stands in for `electron` and `electron-log` so a compiled main-process module can be
 * require()d by plain Node.
 *
 * The modules under test are pure, but they sit in files that log, and `electron-log`
 * refuses to load outside an Electron app. Nothing here is used by the app itself.
 */
const noop = () => {};
const log = {
  info: (...a) => console.log('[log.info]', ...a),
  warn: (...a) => console.log('[log.warn]', ...a),
  error: (...a) => console.log('[log.error]', ...a),
  debug: noop,
  verbose: noop,
  transports: { file: {}, console: {} },
};
module.exports = log;
module.exports.default = log;
module.exports.app = { getPath: () => '/tmp', isPackaged: false };
