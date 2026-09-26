#!/usr/bin/env node
/**
 * Dry run of P10's one-time retired-component cleanup (electron/retired-components.ts): lists
 * what the app WOULD remove on this machine, with sizes, and what it would leave alone. It
 * removes nothing, writes nothing and creates no directory. Needs `npm run build:electron`.
 *
 *   node tools/retire-dry-run.js [--user-data <dir>] [--shared <dir> | --no-shared]
 *
 * The defaults are the app's own: userData is `<appData>/contentstudio` (user-data-path.ts;
 * CONTENTSTUDIO_USER_DATA is honoured as a development run honours it), and the shared dir is
 * the editor asset manager's OwenMorgan location (shared-paths.ts, OWENMORGAN_SHARED_DIR
 * honoured), computed here without creating it.
 */
const os = require('os');
const path = require('path');
const fs = require('fs');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'retired-components.js');
if (!fs.existsSync(DIST)) {
  console.error(`${DIST} is missing: run npm run build:electron first`);
  process.exit(1);
}
const R = require(DIST);

function appData() {
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support');
  if (process.platform === 'win32') return process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming');
  return process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config');
}

function sharedDir() {
  const override = (process.env.OWENMORGAN_SHARED_DIR || '').trim();
  if (override) return override;
  if (process.platform === 'darwin') return path.join(os.homedir(), 'Library', 'Application Support', 'OwenMorgan');
  if (process.platform === 'win32') return path.join(process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local'), 'OwenMorgan');
  return path.join(process.env.XDG_DATA_HOME || path.join(os.homedir(), '.local', 'share'), 'OwenMorgan');
}

const argv = process.argv.slice(2);
const value = (flag) => {
  const i = argv.indexOf(flag);
  if (i < 0) return undefined;
  if (!argv[i + 1]) { console.error(`${flag} needs a directory`); process.exit(2); }
  return path.resolve(argv[i + 1]);
};
const userData = value('--user-data') || (process.env.CONTENTSTUDIO_USER_DATA || '').trim() || path.join(appData(), 'contentstudio');
const shared = argv.includes('--no-shared') ? null : (value('--shared') || sharedDir());

(async () => {
  const roots = { userData, sharedDir: shared !== null && fs.existsSync(shared) ? shared : null };
  console.log(`userData:   ${roots.userData}`);
  console.log(`shared dir: ${roots.sharedDir ?? '(none)'}`);
  const plan = await R.planRetirement(roots);
  for (const line of R.describePlan(plan)) console.log(line);
  console.log(`Nothing was removed. The app runs this once, 15 s after boot, unless the store key ` +
    `${R.KEEP_RETIRED_STORE_KEY} is true; it records completion under ${R.RETIRED_STORE_KEY}.${R.RETIREMENT_ID}.`);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
