/**
 * `npm run check:crucible`: every Crucible keeper, each in its own process.
 *
 * One process per keeper because each one starts fake servers, arms process-wide
 * hooks (the unhandled-rejection watch, a recording ipcMain) and patches module
 * resolution; a keeper that left something behind must not be able to pass or
 * fail the next one. The list is read from tools/ (`test-crucible-*.js`) rather
 * than typed here, so a new keeper cannot be written and forgotten; an empty
 * list is a broken checkout, not a pass.
 *
 * Run it against the COMPILED main process, as check:pure is run:
 *
 *   npm run build:electron && npm run check:crucible
 */
const { spawnSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const keepers = fs.readdirSync(__dirname).filter((file) => /^test-crucible-.*\.js$/.test(file)).sort();
if (keepers.length === 0) {
  console.error('check:crucible: no tools/test-crucible-*.js found. A run that checks nothing is a broken checkout, not a pass.');
  process.exit(1);
}

const failed = [];
for (const keeper of keepers) {
  const result = spawnSync(process.execPath, [path.join(__dirname, keeper)], { stdio: 'inherit' });
  if (result.status !== 0) failed.push(`${keeper} (exit ${result.status ?? result.signal})`);
}

console.log('');
if (failed.length === 0) {
  console.log(`check:crucible: ALL PASS (${keepers.length} keepers)`);
} else {
  console.log(`check:crucible: ${failed.length} of ${keepers.length} keepers FAILED: ${failed.join(', ')}`);
  process.exitCode = 1;
}
