/**
 * KEYS LIVE ON THE SERVER (LEDGER #194): the Servers pane's Anthropic key per
 * server (Test, then Save, and only the server's `keyHint` ever shown), and the
 * explicit "copy my key to <server>".
 *
 * Ported from the parts of Briefcase's settings-bridge.spec.ts and
 * key-copy.spec.ts that P1 carries. What is held: a key goes in and never comes
 * back out (answers carry the hint only); the patch the pane may send is
 * upstream keys and URLs and nothing else; a key is copied to a server only by
 * the explicit call, confirmed by that server's own hint, and a DIFFERENT key
 * already there is left alone and said so, never overwritten.
 */
const { assert, fake, context, rejection, check, run } = require('./_crucible-keeper');

const KEY = 'sk-ant-api03-keeper-key-abcdefghijklmnop-WXYZ';
const OTHER = 'sk-ant-api03-someone-elses-key-qrstuvw-1111';

async function withServer(options, fn, legacyClaudeKey = () => KEY) {
  const server = await fake.startFakeCrucible(options);
  try {
    const made = context({ legacyClaudeKey });
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

check('copy my key: written to the named server and confirmed by its own hint; the app\'s file is left for P2', () => withServer({}, async (server, ctx) => {
  const outcome = await ctx.settings.copyClaudeKeyTo('mac');
  assert.deepStrictEqual(outcome, { server: 'mac', copied: true, alreadyThere: false, skipped: null });
  assert.strictEqual(server.settingsPuts.length, 1);
  // A second press finds it there and writes nothing.
  assert.deepStrictEqual(await ctx.settings.copyClaudeKeyTo('mac'), { server: 'mac', copied: false, alreadyThere: true, skipped: null });
  assert.strictEqual(server.settingsPuts.length, 1);
}));

check('copy my key never overwrites a different key already on the server; it says so', () => withServer({ upstreams: { anthropic: { key: OTHER } } }, async (server, ctx) => {
  const outcome = await ctx.settings.copyClaudeKeyTo('mac');
  assert.strictEqual(outcome.copied, false);
  assert.match(outcome.skipped, /already has a different Claude key/);
  assert.ok(!outcome.skipped.includes(OTHER));
  assert.strictEqual(server.settingsPuts.length, 0);
}));

check('copy my key refuses by name when the app has no key of its own, or the server is not one of ours', () => withServer({}, async (server, ctx) => {
  assert.strictEqual((await rejection(ctx.settings.copyClaudeKeyTo('ghost'))).code, 'unknown_server');
  assert.strictEqual(server.settingsPuts.length, 0);
}, () => undefined).then(() => withServer({}, async (_server, ctx) => {
  assert.strictEqual((await rejection(ctx.settings.copyClaudeKeyTo('mac'))).code, 'nothing_to_copy');
}, () => undefined)));

check('nothing is pushed to any server without the explicit call: adding one sends no settings at all', () => withServer({}, async (server) => {
  assert.strictEqual(server.requestsTo('/v1/settings', 'PUT').length, 0);
}));

run('crucible: keys live on the server');
