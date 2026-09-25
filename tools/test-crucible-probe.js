/**
 * THE PROBE: five failures told apart, and what a server that answers says.
 *
 * Ported from Briefcase's backend/test/crucible/probe.spec.ts, with the fifth
 * outcome plan section 4 names: the probe's own 3 s clock (`timeout`), apart
 * from nothing listening (`unreachable`), because "asleep" and "wrong address"
 * have different fixes. Every server is the fake on an ephemeral port, a port
 * nobody listens on, or an HTML page that is not a Crucible.
 */
const { assert, crucible, fake, context, check, run } = require('./_crucible-keeper');

const { compareVersions, reachOf, PROBE_CACHE_MS, PROBE_TIMEOUT_MS, busyLineOf } = crucible('probe');

async function withFake(options, fn) {
  const server = await fake.startFakeCrucible(options);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

check('ok: a Crucible that accepts the token answers with its version, backend and facts, ready', () => withFake(
  { name: 'crucible@keeper-mac', version: '1.0.34', backend: 'mlx-darwin' },
  async (server) => {
    const { ctx } = context();
    ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
    const answer = await ctx.probes.test('mac');
    assert.strictEqual(answer.reach, 'ready');
    assert.strictEqual(answer.probe.outcome, 'ok');
    const facts = answer.probe.facts;
    assert.deepStrictEqual(
      [facts.serverName, facts.version, facts.apiVersion, facts.backend, facts.busyLine, facts.needsUpdate, facts.engineUrl, facts.activityUnread, facts.capabilitiesUnread],
      ['crucible@keeper-mac', '1.0.34', 1, 'mlx-darwin', null, false, null, null, null],
    );
    // What ContentStudio reads off the capability record: 1.0.24's classes are there, so the act is `generate`.
    assert.deepStrictEqual(facts.capabilities.map((c) => c.capability).sort(), ['analysis', 'asr', 'decide', 'generate']);
    assert.strictEqual(facts.generationAct, 'generate');
    // ping unauthenticated; info with the token, the API header, and the app's name.
    const ping = server.requestsTo('/v1/ping')[0];
    assert.strictEqual(ping.headers['authorization'], undefined);
    const info = server.requestsTo('/v1/info')[0];
    assert.strictEqual(info.headers['authorization'], `Bearer ${server.token}`);
    assert.strictEqual(info.headers['x-crucible-api'], '1');
    assert.strictEqual(info.headers['x-crucible-client'], 'contentstudio');
    assert.ok(!JSON.stringify(answer).includes(server.token));
  },
));

check('a server from before 1.0.24 is detected by its capability rows, never its version: act `analysis`', () => withFake(
  { legacyActs: true, version: '1.0.34' },
  async (server) => {
    const { ctx } = context();
    ctx.servers.add({ name: 'old-acts', url: server.url, token: server.token });
    const answer = await ctx.probes.test('old-acts');
    assert.strictEqual(answer.probe.facts.generationAct, 'analysis');
  },
));

check('outcome 1, bad token: a Crucible that refuses the token is wrong_token, not unreachable, and the token is not echoed', () => withFake({}, async (server) => {
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: server.url, token: 'not-the-token-0000' });
  const answer = await ctx.probes.test('mac');
  assert.strictEqual(answer.reach, 'bad_token');
  assert.strictEqual(answer.probe.outcome, 'wrong_token');
  assert.ok(!JSON.stringify(answer).includes('not-the-token-0000'));
}));

check('outcome 2, nothing there: a port nobody listens on is unreachable', async () => {
  const { ctx } = context();
  ctx.servers.add({ name: 'gone', url: await fake.unusedLoopbackUrl(), token: 'tok-gone-0000' });
  const answer = await ctx.probes.test('gone');
  assert.strictEqual(answer.reach, 'unreachable');
  assert.strictEqual(answer.probe.outcome, 'unreachable');
});

check('outcome 3, not a Crucible: something answered, and it is a router page', async () => {
  const router = await fake.startNotCrucible();
  try {
    const { ctx } = context();
    ctx.servers.add({ name: 'router', url: router.url, token: 'tok-router-0000' });
    const answer = await ctx.probes.test('router');
    assert.strictEqual(answer.reach, 'not_crucible');
    assert.strictEqual(answer.probe.outcome, 'not_a_crucible');
  } finally {
    await router.close();
  }
});

check('outcome 4, another API version: version_mismatch', () => withFake({}, async (server) => {
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  server.inject({ apiVersion2: true });
  const answer = await ctx.probes.test('mac');
  assert.strictEqual(answer.reach, 'version_mismatch');
  assert.strictEqual(answer.probe.outcome, 'version_mismatch');
}));

check('outcome 5, the clock: a machine that answers nothing is `timeout` within the 3 s probe clock, not a hang', () => withFake({}, async (server) => {
  const { ctx } = context();
  ctx.servers.add({ name: 'asleep', url: server.url, token: server.token });
  server.inject({ stallMs: 60_000 });
  const started = Date.now();
  const answer = await ctx.probes.test('asleep');
  const took = Date.now() - started;
  assert.strictEqual(answer.probe.outcome, 'timeout');
  assert.strictEqual(answer.reach, 'timeout');
  assert.match(answer.probe.message, /did not answer within 3 s/);
  assert.ok(took >= PROBE_TIMEOUT_MS - 100 && took < PROBE_TIMEOUT_MS * 2, `took ${took} ms`);
}));

check('busy: a held lane is ok, with the holder\'s sentence', () => withFake({}, async (server) => {
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  server.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.62 } });
  const answer = await ctx.probes.test('mac');
  assert.strictEqual(answer.reach, 'busy');
  assert.strictEqual(answer.probe.facts.busyLine, 'busy: bookforge, tts 62% done');
}));

check('an engine claim by anyone but ContentStudio is busy; our own, or none, is not', () => {
  const activity = (claim, acceptsWork = true) => ({
    running: [], queued: [], claim: claim === null ? null : { heldBy: claim }, resident: null,
    slots: { accelerated: { acceptsWork } },
  });
  assert.strictEqual(busyLineOf(activity('the settlement clearing the card')), 'busy: the card is held by the settlement clearing the card');
  assert.strictEqual(busyLineOf(activity('contentstudio crucible-client/1.0.34')), null);
  assert.strictEqual(busyLineOf(activity(null)), null);
  assert.strictEqual(busyLineOf(activity(null, false)), 'busy: the GPU is not accepting work right now');
});

check('an unreadable activity is SAID, never read as a free card', () => withFake({}, async (server) => {
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  server.faults.refuse = [{ match: { path: '/v1/activity' }, status: 500, code: 'internal_error', message: 'boom' }];
  const answer = await ctx.probes.test('mac');
  assert.strictEqual(answer.probe.outcome, 'ok');
  assert.strictEqual(answer.probe.facts.busyLine, null);
  assert.match(answer.probe.facts.activityUnread, /boom|internal_error/);
}));

check('undecided capabilities are said, and the act is left null for the caller that needs it to refuse by name', () => withFake({}, async (server) => {
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  server.faults.refuse = [{ match: { path: '/v1/capability' }, status: 503, code: 'capability_undecided', message: 'run crucible capability --write' }];
  const facts = (await ctx.probes.test('mac')).probe.facts;
  assert.strictEqual(facts.capabilities, null);
  assert.strictEqual(facts.generationAct, null);
  assert.match(facts.capabilitiesUnread, /has not decided its capabilities yet/);
}));

check('marks a server older than MIN_CRUCIBLE as needing an update; an unstated version is not old', () => withFake({ version: '1.0.9' }, async (server) => {
  const { ctx } = context();
  ctx.servers.add({ name: 'old', url: server.url, token: server.token });
  assert.strictEqual((await ctx.probes.test('old')).probe.facts.needsUpdate, true);
  assert.ok(compareVersions('1.0.23', '1.0.9') > 0);
  assert.strictEqual(compareVersions('1.0.23', '1.0.23'), 0);
  assert.ok(compareVersions('0.9.99', '1.0.0') < 0);
}));

check('a leaner server (1.0.25\'s nullable fields left out) still probes ok, with the gaps as nulls', () => withFake(
  { omit: fake.INFORMATIONAL_FIELDS },
  async (server) => {
    const { ctx } = context();
    ctx.servers.add({ name: 'lean', url: server.url, token: server.token });
    const answer = await ctx.probes.test('lean');
    assert.strictEqual(answer.probe.outcome, 'ok');
    assert.strictEqual(answer.probe.facts.version, null);
    assert.strictEqual(answer.probe.facts.backend, null);
    assert.strictEqual(answer.probe.facts.needsUpdate, false);
  },
));

check('an unknown name is a named refusal answered, not thrown', async () => {
  const { ctx } = context();
  const answer = await ctx.probes.test('ghost');
  assert.strictEqual(answer.probe.outcome, 'refused');
  assert.strictEqual(reachOf(answer.probe), 'refused');
});

check('reach() answers from a 15 s cache; test() always asks again; a registry change drops the cache', () => withFake({}, async (server) => {
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  let now = 1_000_000;
  ctx.probes.now = () => now;
  await ctx.probes.reach('mac');
  await ctx.probes.reach('mac');
  assert.strictEqual(server.requestsTo('/v1/ping').length, 1);
  now += PROBE_CACHE_MS + 1;
  await ctx.probes.reach('mac');
  assert.strictEqual(server.requestsTo('/v1/ping').length, 2);
  await ctx.probes.test('mac');
  assert.strictEqual(server.requestsTo('/v1/ping').length, 3);
  ctx.servers.setPaused('mac', true);
  await ctx.probes.reach('mac');
  assert.strictEqual(server.requestsTo('/v1/ping').length, 4);
}));

check('probing unregistered credentials (a pasted code) answers the same outcomes and caches nothing', () => withFake({}, async (server) => {
  const { ctx } = context();
  assert.strictEqual((await ctx.probes.probeCredentials(server.url, server.token)).outcome, 'ok');
  assert.strictEqual((await ctx.probes.probeCredentials(server.url, 'wrong-0000')).outcome, 'wrong_token');
  assert.strictEqual((await ctx.probes.probeCredentials(await fake.unusedLoopbackUrl(), 't')).outcome, 'unreachable');
}));

run('crucible: the probe\'s five outcomes');
