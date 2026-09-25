/**
 * THE PAIRING FILE: where the Crucible on this computer leaves its connect code,
 * and the offer row the Servers pane draws from it.
 *
 * Ported from Briefcase's backend/test/crucible/pairing-file.spec.ts. The path
 * rule is the SDK's (the three names come from @crucible/client), executed
 * synchronously here; the check at the end holds the two to the same answer on
 * this machine. Absence is null, never an error; everything else is refused by
 * its own code, and no refusal carries the token.
 */
const path = require('path');
const { assert, crucible, pairingHost, pairingLineFor, check, run } = require('./_crucible-keeper');

const { CruciblePairingFileError, cruciblePairingFilePath, readCruciblePairingFile } = crucible('pairing-file');
const { discoveredRow } = crucible('discovery');

const TOKEN = 's3cret-t0ken_abcdefghijklmnopqrstuvwxyz-9876';

function host(platform, env, files = {}) {
  return { platform, env, homedir: platform === 'win32' ? 'C:\\Users\\owen' : '/Users/owen', readFile: (f) => files[f] ?? null };
}

check('is ~/.crucible/pairing on macOS and Linux', () => {
  assert.strictEqual(cruciblePairingFilePath(host('darwin', {})), '/Users/owen/.crucible/pairing');
  assert.strictEqual(cruciblePairingFilePath(host('linux', {})), '/Users/owen/.crucible/pairing');
});

check('is %LOCALAPPDATA%\\Crucible\\pairing on Windows, and refuses when LOCALAPPDATA is unset', () => {
  assert.strictEqual(
    cruciblePairingFilePath(host('win32', { LOCALAPPDATA: 'C:\\Users\\owen\\AppData\\Local' })),
    'C:\\Users\\owen\\AppData\\Local\\Crucible\\pairing',
  );
  assert.throws(() => cruciblePairingFilePath(host('win32', {})), (err) => err.code === 'no_local_app_data');
});

check('honours $CRUCIBLE_HOME on every platform', () => {
  assert.strictEqual(cruciblePairingFilePath(host('darwin', { CRUCIBLE_HOME: '/opt/crucible' })), '/opt/crucible/pairing');
  assert.strictEqual(cruciblePairingFilePath(host('linux', { CRUCIBLE_HOME: '/srv/c' })), '/srv/c/pairing');
  assert.strictEqual(cruciblePairingFilePath(host('win32', { CRUCIBLE_HOME: 'D:\\crucible' })), 'D:\\crucible\\pairing');
});

check('agrees with the SDK\'s own async rule on this machine', async () => {
  const { cruciblePairingPath } = require('@crucible/client');
  const home = path.join('/tmp', 'crucible-home-keeper');
  const ours = cruciblePairingFilePath({ platform: process.platform, env: { CRUCIBLE_HOME: home }, homedir: '/unused', readFile: () => null });
  const saved = process.env.CRUCIBLE_HOME;
  process.env.CRUCIBLE_HOME = home;
  try {
    assert.strictEqual(await cruciblePairingPath(), ours);
  } finally {
    if (saved === undefined) delete process.env.CRUCIBLE_HOME;
    else process.env.CRUCIBLE_HOME = saved;
  }
});

check('answers null when there is no file: no engine here is a fact, not an error', () => {
  assert.strictEqual(readCruciblePairingFile(host('darwin', {})), null);
});

check('parses the one connect code, percent-encoded name and all', () => {
  const file = '/Users/owen/.crucible/pairing';
  const line = pairingLineFor('crucible@owens-mac-studio', 'http://127.0.0.1:7100', TOKEN);
  assert.deepStrictEqual(readCruciblePairingFile(host('darwin', {}, { [file]: line })), {
    file,
    pairing: { name: 'crucible@owens-mac-studio', url: 'http://127.0.0.1:7100', token: TOKEN },
  });
});

check('refuses an empty file, a multi-line file and a line that is not a connect code, by name, without the token', () => {
  const file = '/Users/owen/.crucible/pairing';
  const cases = [
    ['\n\n', 'pairing_file_empty'],
    [`${pairingLineFor('a', 'http://127.0.0.1:7100', TOKEN)}${pairingLineFor('b', 'http://127.0.0.1:7101', TOKEN)}`, 'pairing_file_multiline'],
    [`crucible://127.0.0.1:7100/#${TOKEN}\n`, 'pairing_file_invalid'],
  ];
  for (const [text, code] of cases) {
    assert.throws(() => readCruciblePairingFile(host('darwin', {}, { [file]: text })), (err) => {
      assert.ok(err instanceof CruciblePairingFileError);
      assert.strictEqual(err.code, code);
      assert.ok(!err.message.includes(TOKEN), `${code} leaks the token`);
      return true;
    });
  }
});

check('discovery offers the Crucible here with the token masked, and says when it is already registered', () => {
  const line = pairingLineFor('crucible@owens-mac-studio', 'http://127.0.0.1:7100', TOKEN);
  const open = discoveredRow([], pairingHost(line));
  assert.deepStrictEqual(
    { present: open.present, serverName: open.serverName, url: open.url, tokenMasked: open.tokenMasked, registeredAs: open.registeredAs },
    { present: true, serverName: 'crucible@owens-mac-studio', url: 'http://127.0.0.1:7100', tokenMasked: '****9876', registeredAs: null },
  );
  assert.ok(!JSON.stringify(open).includes(TOKEN));
  assert.strictEqual(discoveredRow([{ name: 'mac', url: 'http://127.0.0.1:7100/' }], pairingHost(line)).registeredAs, 'mac');
});

check('discovery names why there is nothing to offer', () => {
  assert.strictEqual(discoveredRow([], pairingHost(null)).code, 'no_local_config');
  assert.strictEqual(discoveredRow([], pairingHost('garbage\n')).code, 'pairing_file_invalid');
});

run('crucible: the pairing file');
