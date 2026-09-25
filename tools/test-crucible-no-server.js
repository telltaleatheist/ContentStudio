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
 * P3 adds the queue's layer: the lanes, the ledger and both sweeps boot and
 * settle with no server, a queued job parks by name rather than hanging or
 * failing, a cloud call still runs and a local one is refused by name, and the
 * non-AI services' import graphs never reach Crucible or the AI pipeline.
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
    ['crucible:lanes'],
    ['crucible:queue-plan', [{ jobId: 'j1', fast: false }, { jobId: 'j2', fast: true }]],
    ['crucible:queue-plan', 'not a list'],
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

// ── P3: the queue's layer with no server ────────────────────────────────────

check('the lanes, the ledger and both sweeps boot and settle with no server at all', async () => {
  const { ctx } = context();
  const started = Date.now();
  const swept = await ctx.sweepAtStartup();
  assert.deepStrictEqual([swept.rows.length, swept.timedOut], [0, false], 'an empty ledger sweeps nothing, at once');
  ctx.start();
  await ctx.lanes.readAll();
  assert.deepStrictEqual(ctx.lanes.view().lanes, [], 'no servers, no chips');
  const quit = await ctx.quit();
  assert.deepStrictEqual([quit.rows.length, quit.timedOut], [0, false]);
  assert.ok(Date.now() - started < 3_000, 'nothing waited on a Crucible');
  ctx.stop();
});

check('with no server, a queued job PARKS by name (never hangs, never fails), and a queue plan says why', async () => {
  const { ctx } = context();
  await ctx.sweepAtStartup();
  const outcome = await ctx.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, async () => { throw new Error('must not run'); });
  assert.deepStrictEqual([outcome.kind, outcome.result.code, outcome.result.server], ['parked', 'no_server', null]);
  assert.match(outcome.result.holderLine, /No Crucible server is connected/);
  const plan = await ctx.lanes.plan([{ jobId: 'j1', fast: false }, { jobId: 'j2', fast: true }]);
  assert.deepStrictEqual(plan.start, []);
  assert.deepStrictEqual(plan.waiting.map((row) => [row.jobId, row.parked]), [['j1', true], ['j2', true]]);
  ctx.stop();
});

check('with a registered server that is down, its chip says so and a job waits for it by name', async () => {
  const stopped = await fake.unusedLoopbackUrl();
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: stopped, token: TOKEN });
  await ctx.sweepAtStartup();
  await ctx.lanes.readAll();
  const chip = ctx.lanes.view().lanes[0];
  assert.deepStrictEqual([chip.server, chip.state], ['mac', 'unreachable']);
  const outcome = await ctx.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, async () => { throw new Error('must not run'); });
  assert.deepStrictEqual([outcome.kind, outcome.result.code, outcome.result.server], ['parked', 'unreachable', 'mac']);
  ctx.stop();
});

check('queueAITask with no server: a cloud call runs; a local call is refused by name, never queued forever', async () => {
  const { ctx } = context();
  const lanes = crucible('lanes');
  const queue = require(path.join(__dirname, '..', 'dist', 'main', 'services', 'queue-manager.service.js'));
  lanes.installLanes(null);
  assert.strictEqual(await queue.queueAITask(queue.routeOfModelId('claude-cli:sonnet'), 'c1', 'a claude -p call', async () => 'ran'), 'ran', 'no lanes installed: a cloud call needs none');
  await assert.rejects(queue.queueAITask(queue.gpuCall('qwen3.5-9b'), 'g0', 'a local call', async () => 'never'), /No Crucible lanes are installed/);
  lanes.installLanes(ctx.lanes);
  assert.strictEqual(await queue.queueAITask(queue.routeOfModelId('claude:claude-sonnet-5'), 'c2', 'a cloud call', async () => 'ran'), 'ran');
  await assert.rejects(queue.queueAITask(queue.gpuCall('qwen3.5-9b'), 'g1', 'a local call', async () => 'never'), (err) => err.code === 'no_selected_server');
  lanes.installLanes(null);
  ctx.stop();
});

/**
 * The non-AI services' import graphs never reach the Crucible layer, the lanes' door or the AI
 * pipeline, so no future edit can make browsing, publishing, analytics or the editor wait on a
 * Crucible by accident (Briefcase's no-Crucible suite, statically; plan section 0a).
 */
check('the non-AI services never import Crucible, the lanes or the AI pipeline, and load with no server', () => {
  const fs = require('fs');
  const DIST = path.join(__dirname, '..', 'dist', 'main');
  const requiresOf = (file) => {
    const text = fs.readFileSync(file, 'utf8');
    const found = [];
    for (const m of text.matchAll(/require\("(\.[^"]+)"\)/g)) {
      const base = path.resolve(path.dirname(file), m[1]);
      if (fs.existsSync(`${base}.js`)) found.push(`${base}.js`);
      else if (fs.existsSync(path.join(base, 'index.js'))) found.push(path.join(base, 'index.js'));
    }
    return found;
  };
  const graph = (entry) => {
    const seen = new Set();
    const stack = [entry];
    while (stack.length > 0) {
      const file = stack.pop();
      if (seen.has(file)) continue;
      seen.add(file);
      stack.push(...requiresOf(file));
    }
    return seen;
  };
  const forbidden = (file) => file.includes(`${path.sep}crucible${path.sep}`)
    || file.endsWith('queue-manager.service.js') || file.endsWith('ai-manager.service.js') || file.endsWith('metadata-generator.service.js');
  const nonAi = [
    'services/publish/publish-store.service.js',
    'services/analytics/analytics-store.service.js',
    'services/spreaker/spreaker-config.service.js',
    'services/youtube/youtube-auth.service.js',
    'services/youtube/youtube-api.service.js',
    'services/metadata/saved-transcript.service.js',
    'services/editor/archive-sync.js',
    'services/editor/asset-manager.js',
  ];
  for (const entry of nonAi) {
    const reached = [...graph(path.join(DIST, entry))].filter(forbidden).map((file) => path.relative(DIST, file));
    assert.deepStrictEqual(reached, [], `${entry} reaches ${reached.join(', ')}`);
    require(path.join(DIST, entry));
  }
  // And one of them does real work with no Crucible anywhere: the analytics store on an empty directory.
  const { AnalyticsStoreService } = require(path.join(DIST, 'services/analytics/analytics-store.service.js'));
  const store = new AnalyticsStoreService(require('./_crucible-keeper').tempDir());
  assert.ok(Array.isArray(store.listChannels()));
});

run('crucible: no server at all');
