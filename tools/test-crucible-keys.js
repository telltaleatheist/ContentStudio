/**
 * KEYS LIVE ON THE SERVER (LEDGER #194): the Servers pane's Anthropic key per
 * server (Test, then Save, and only the server's `keyHint` ever shown), and the
 * ONE move of the old api-keys.json into the Crucible on this computer (plan 6.6).
 *
 * Ported from the parts of Briefcase's settings-bridge.spec.ts and
 * key-copy.spec.ts that P1 carried, with P1's "copy my key" checks replaced by
 * the migration's five cases (plan 16, P2's tests): it writes, checks the hint
 * and deletes the file; it keeps the file on failure; it never writes to a
 * remote server; it stops and asks on a differing key already there (and does
 * what the pane answers); and the same key already there is not written again.
 */
const fs = require('fs');
const path = require('path');
const { assert, fake, context, pairingHost, pairingLineFor, rejection, tempDir, until, check, run } = require('./_crucible-keeper');

const KEY = 'sk-ant-api03-keeper-key-abcdefghijklmnop-WXYZ';
const OTHER = 'sk-ant-api03-someone-elses-key-qrstuvw-1111';

async function withServer(options, fn) {
  const server = await fake.startFakeCrucible(options);
  try {
    const made = context();
    made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
    await fn(server, made.ctx);
  } finally {
    await server.close();
  }
}

check('a server\'s settings are read with the hint only; an unconfigured Anthropic card says so', () => withServer({}, async (_server, ctx) => {
  const view = await ctx.settings.get('mac');
  assert.deepStrictEqual(view.upstreams.anthropic, { configured: false, keyHint: null });
}));

check('Test, then Save: the key is tested on the server, written, and read back as its hint alone', () => withServer({}, async (server, ctx) => {
  const tested = await ctx.settings.testUpstream('mac', 'anthropic', { key: KEY });
  assert.strictEqual(tested.ok, true);
  const saved = await ctx.settings.put('mac', { upstreams: { anthropic: { key: KEY } } });
  assert.strictEqual(saved.upstreams.anthropic.configured, true);
  assert.ok(saved.upstreams.anthropic.keyHint.endsWith('WXYZ'), saved.upstreams.anthropic.keyHint);
  assert.ok(!JSON.stringify(saved).includes(KEY));
  assert.deepStrictEqual(server.settingsPuts, [{ upstreams: { anthropic: { key: KEY } } }]);
}));

check('the pane may change upstream keys and URLs only: anything else is refused, not dropped', () => withServer({}, async (server, ctx) => {
  for (const patch of [{ routes: { analysis: 'anthropic/claude-sonnet-5' } }, { localModels: {} }, { upstreams: { gemini: { key: 'x' } } }, 'nope', null]) {
    const err = await rejection(ctx.settings.put('mac', patch));
    assert.strictEqual(err.code, 'invalid_settings', JSON.stringify(patch));
  }
  assert.strictEqual(server.settingsPuts.length, 0);
  assert.strictEqual((await rejection(ctx.settings.testUpstream('mac', 'gemini', {}))).code, 'invalid_settings');
}));

check('the app holds no key: there is no copy-my-key door on the bridge any more', () => withServer({}, async (_server, ctx) => {
  assert.strictEqual(typeof ctx.settings.copyClaudeKeyTo, 'undefined');
}));

// ── the move of api-keys.json (plan 6.6) ────────────────────────────────────

/**
 * A fake that IS "the Crucible on this computer": the pairing file names its
 * address, so once it is registered as `mac` it is the local server. The old
 * file is written into a temp userData with `keys`.
 */
async function withLocal(options, keys, fn) {
  const server = await fake.startFakeCrucible(options);
  const dir = tempDir();
  const file = path.join(dir, 'api-keys.json');
  if (keys !== null) fs.writeFileSync(file, JSON.stringify(keys, null, 2));
  const recorded = { value: null };
  try {
    const made = context({
      dir,
      pairingHost: pairingHost(pairingLineFor('crucible@local', server.url, server.token)),
      legacyKeys: { file, record: { get: () => recorded.value, set: (name) => { recorded.value = name; } } },
    });
    await fn({ server, ctx: made.ctx, file, recorded });
  } finally {
    await server.close();
  }
}

check('migration 1: writes the key to the local server, confirms its hint, deletes the file, records where', () => withLocal(
  {}, { claudeApiKey: KEY, openaiApiKey: 'sk-openai-dropped' },
  async ({ server, ctx, file, recorded }) => {
    ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
    const outcome = await ctx.keys.migrate();
    assert.strictEqual(outcome.status, 'migrated', outcome.message);
    assert.ok(outcome.keyHint.endsWith('WXYZ'));
    assert.strictEqual(outcome.openaiDropped, true, 'the OpenAI key is dropped and said so');
    assert.deepStrictEqual(server.settingsPuts, [{ upstreams: { anthropic: { key: KEY } } }], 'the Claude key only, once');
    assert.strictEqual(server.requestsTo('/v1/settings/upstreams/anthropic/test', 'POST').length, 1, 'tested before it was written');
    assert.strictEqual(fs.existsSync(file), false, 'the file is gone');
    assert.strictEqual(recorded.value, 'mac');
    assert.ok(!JSON.stringify(outcome).includes(KEY), 'no key in the outcome');
    // The next start finds nothing to move.
    assert.strictEqual((await ctx.keys.migrate()).status, 'nothing');
  },
));

check('migration 2: a failure keeps the file and records nothing, so the next start tries again', () => withLocal(
  { faults: { refuse: [{ match: { method: 'PUT', path: '/v1/settings' }, status: 500, code: 'settings_write_failed', times: 1 }] } },
  { claudeApiKey: KEY },
  async ({ server, ctx, file, recorded }) => {
    ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
    const outcome = await ctx.keys.migrate();
    assert.strictEqual(outcome.status, 'failed');
    assert.match(outcome.message, /api-keys\.json is kept/);
    assert.strictEqual(fs.existsSync(file), true);
    assert.strictEqual(recorded.value, null);
    // The fault was one-shot: the retry the next start makes goes through.
    assert.strictEqual((await ctx.keys.migrate()).status, 'migrated');
    assert.strictEqual(fs.existsSync(file), false);
  },
));

check('migration 3: never writes to a remote server; the file waits for this computer\'s Crucible', () => withLocal(
  {}, { claudeApiKey: KEY },
  async ({ ctx, file, recorded }) => {
    const remote = await fake.startFakeCrucible({ name: 'owens-pc' });
    try {
      ctx.servers.add({ name: 'owens-pc', url: remote.url, token: remote.token });
      const outcome = await ctx.keys.migrate();
      assert.strictEqual(outcome.status, 'waiting');
      assert.strictEqual(remote.requestsTo('/v1/settings', 'PUT').length, 0, 'nothing written to the remote server');
      assert.strictEqual(remote.requestsTo('/v1/settings/upstreams', 'POST').length, 0, 'the key was not even tested there');
      assert.strictEqual(fs.existsSync(file), true);
      assert.strictEqual(recorded.value, null);
    } finally {
      await remote.close();
    }
  },
));

check('migration 4: a DIFFERENT key already on the server stops and asks; "keep" retires the file, "replace" writes ours', () => withLocal(
  { upstreams: { anthropic: { key: OTHER } } }, { claudeApiKey: KEY },
  async ({ server, ctx, file, recorded }) => {
    ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
    const asked = await ctx.keys.migrate();
    assert.strictEqual(asked.status, 'differing_key');
    assert.ok(asked.keyHint.endsWith('1111'), 'the server\'s own hint, so the pane can show whose key is there');
    assert.strictEqual(server.settingsPuts.length, 0, 'never overwritten on its own');
    assert.strictEqual(fs.existsSync(file), true);
    assert.deepStrictEqual(ctx.keys.last(), asked, 'the pane reads the question back');
    const kept = await ctx.keys.migrate('keep');
    assert.strictEqual(kept.status, 'migrated');
    assert.strictEqual(server.settingsPuts.length, 0, '"keep" writes nothing');
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(recorded.value, 'mac');
  },
).then(() => withLocal(
  { upstreams: { anthropic: { key: OTHER } } }, { claudeApiKey: KEY },
  async ({ server, ctx, file }) => {
    ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
    assert.strictEqual((await ctx.keys.migrate()).status, 'differing_key');
    const replaced = await ctx.keys.migrate('replace');
    assert.strictEqual(replaced.status, 'migrated', replaced.message);
    assert.ok(replaced.keyHint.endsWith('WXYZ'));
    assert.deepStrictEqual(server.settingsPuts, [{ upstreams: { anthropic: { key: KEY } } }]);
    assert.strictEqual(fs.existsSync(file), false);
  },
)));

check('migration 5: the same key already on the server is not written again; the file is retired', () => withLocal(
  { upstreams: { anthropic: { key: KEY } } }, { claudeApiKey: KEY },
  async ({ server, ctx, file, recorded }) => {
    ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
    const outcome = await ctx.keys.migrate();
    assert.strictEqual(outcome.status, 'migrated');
    assert.strictEqual(server.settingsPuts.length, 0);
    assert.strictEqual(server.requestsTo('/v1/settings/upstreams', 'POST').length, 0, 'nothing to test either');
    assert.strictEqual(fs.existsSync(file), false);
    assert.strictEqual(recorded.value, 'mac');
  },
));

check('the move runs by itself when this computer\'s Crucible is added (no press needed), and only then', () => withLocal(
  {}, { claudeApiKey: KEY },
  async ({ server, ctx, file }) => {
    ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
    await until(() => !fs.existsSync(file));
    assert.strictEqual(ctx.keys.last().status, 'migrated');
  },
));

check('nothing is pushed to any server without a key file: adding one sends no settings at all', () => withServer({}, async (server) => {
  assert.strictEqual(server.requestsTo('/v1/settings', 'PUT').length, 0);
}));

run('crucible: keys live on the server');
