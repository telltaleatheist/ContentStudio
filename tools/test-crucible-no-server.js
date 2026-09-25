/**
 * NO CRUCIBLE AT ALL: the Crucible layer boots, answers and stays quiet when
 * there is no server, or a stopped one (plan section 0a: "if crucible is down,
 * [the app] is down... the user just cant take any actions that would require
 * crucible", and everything else works).
 *
 * Briefcase keeps a whole "no Crucible" suite that boots its Nest services with
 * no server; ContentStudio's main process has no such container, so this boots
 * the one thing main.ts adds for Crucible (the composition root, started as
 * main.ts starts it) against a pairing file whose server is not listening, and
 * drives every `crucible:*` IPC channel through a recording ipcMain. What is
 * held: nothing throws across the boundary (every answer is the {success}
 * envelope), no answer carries a token, the background loops settle, the
 * registry is not written, and there is not one unhandled rejection.
 *
 * The live half (the real app launched with Crucible out of reach) is recorded
 * in docs/crucible/P1.md.
 */
const path = require('path');
const { assert, crucible, fake, pairingHost, pairingLineFor, context, until, check, run } = require('./_crucible-keeper');

// A recording ipcMain on the electron stub, so crucible-ipc.ts registers into a map.
const handlers = new Map();
const electronStub = require(path.join(__dirname, '_electron-stub.js'));
electronStub.ipcMain = { handle: (channel, fn) => handlers.set(channel, fn) };

const TOKEN = 'stopped-server-token-abcdefghijklmnopqrstuv-4321';

/** Invoke one channel as the renderer would, with Electron's event argument. */
async function invoke(channel, ...args) {
  const fn = handlers.get(channel);
  assert.ok(fn, `${channel} is registered`);
  return fn({}, ...args);
}

check('with a stopped local Crucible: boot starts the loops, they settle, readiness offers Start, and nothing is written', async () => {
  const stopped = await fake.unusedLoopbackUrl();
  const { ctx, pushed, scripted } = context({
    pairingHost: pairingHost(pairingLineFor('crucible@owens-mac-studio', stopped, TOKEN)),
    discovered: () => ({ present: true, serverName: 'crucible@owens-mac-studio', url: stopped, tokenMasked: '****4321', file: '/x/pairing', registeredAs: null }),
  });
  scripted.state.status = { state: 'stopped', detail: 'launchd: not running', url: stopped, name: 'crucible@owens-mac-studio' };
  ctx.autoConnect.retryDelaysMs = [20];
  ctx.start();
  await ctx.autoConnect.whenIdle();
  await until(() => pushed.readiness.length > 0);
  const view = ctx.readiness.current();
  assert.deepStrictEqual([view.state, view.action], ['unreachable', 'start']);
  assert.strictEqual(ctx.servers.exists(), false);
  ctx.stop();
});

check('with nothing installed and nothing registered: readiness offers Install, and the AI gate refuses by name', async () => {
  const { ctx, pushed } = context();
  ctx.start();
  await ctx.autoConnect.whenIdle();
  await until(() => pushed.readiness.length > 0);
  assert.strictEqual(ctx.readiness.current().state, 'not-installed');
  assert.throws(() => ctx.readiness.assertCanQueue('Metadata'), (err) => err.code === 'crucible_required');
  ctx.stop();
});

check('every crucible:* channel answers the envelope with no server there, and none carries a token', async () => {
  const stopped = await fake.unusedLoopbackUrl();
  const { ctx } = context({ pairingHost: pairingHost(pairingLineFor('crucible@owens-mac-studio', stopped, TOKEN)) });
  // A registered server that is down, as after a restart with Crucible stopped.
  ctx.servers.add({ name: 'mac', url: stopped, token: TOKEN });
  handlers.clear();
  crucible('crucible-ipc').setupCrucibleIpc(ctx);

  const calls = [
    ['crucible:servers'],
    ['crucible:probe', 'mac'],
    ['crucible:test', 'mac'],
    ['crucible:add', { connectCode: pairingLineFor('crucible@owens-pc', stopped, TOKEN) }],
    ['crucible:add', { discovered: true }],
    ['crucible:add', null],
    ['crucible:select', 'mac'],
    ['crucible:set-fast', 'mac'],
    ['crucible:set-fast', null],
    ['crucible:set-paused', 'mac', true],
    ['crucible:set-paused', 'mac', 'yes'],
    ['crucible:set-paused', 'mac', false],
    ['crucible:pair-start', { address: stopped }],
    ['crucible:pair-poll', 'no-such-request'],
    ['crucible:pair-cancel', 'no-such-request'],
    ['crucible:connect-code-read', 'not a code'],
    ['crucible:connect-code-copy', 'mac'],
    ['crucible:connect-codes-local'],
    ['crucible:connect-code-copy-local', 'http://10.0.0.1:7100'],
    ['crucible:settings-get', 'mac'],
    ['crucible:settings-put', 'mac', { upstreams: { anthropic: { key: 'sk-ant-never-sent-9999' } } }],
    ['crucible:upstream-test', 'mac', 'anthropic', { key: 'sk-ant-never-sent-9999' }],
    ['crucible:copy-my-key', 'mac'],
    ['crucible:setup'],
    ['crucible:install-status'],
    ['crucible:local-presence'],
    ['crucible:readiness'],
    ['crucible:readiness-refresh'],
    ['crucible:readiness-decline'],
    ['crucible:remove', 'mac'],
    ['crucible:remove', 'mac'],
  ];
  for (const [channel, ...args] of calls) {
    const answer = await invoke(channel, ...args);
    assert.ok(answer && typeof answer.success === 'boolean', `${channel} answered ${JSON.stringify(answer)}`);
    if (!answer.success) {
      assert.strictEqual(typeof answer.code, 'string', `${channel} refused without a code`);
      assert.strictEqual(typeof answer.error, 'string', `${channel} refused without a sentence`);
    }
    const text = JSON.stringify(answer);
    assert.ok(!text.includes(TOKEN), `${channel} leaked the token`);
    assert.ok(!text.includes('sk-ant-never-sent-9999'), `${channel} echoed a key`);
  }
  // The channels whose answer is a fact about a down server say so by code.
  assert.strictEqual((await invoke('crucible:add', { connectCode: pairingLineFor('crucible@owens-pc', stopped, TOKEN) })).code, 'probe_failed');
  assert.strictEqual((await invoke('crucible:set-paused', 'mac', 'yes')).code, 'invalid_choice');
  assert.strictEqual((await invoke('crucible:set-paused', 'mac', true)).code, 'unknown_server');
  ctx.stop();
});

check('every channel main.ts\'s preload exposes is registered, and no other', () => {
  const fs = require('fs');
  const preload = fs.readFileSync(path.join(__dirname, '..', 'electron', 'preload.ts'), 'utf8');
  const exposed = new Set([...preload.matchAll(/ipcRenderer\.invoke\('(crucible:[a-z-]+)'/g)].map((m) => m[1]));
  const registered = new Set(handlers.keys());
  assert.deepStrictEqual([...exposed].sort(), [...registered].sort());
});

run('crucible: no server at all');
