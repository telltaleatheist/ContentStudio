/**
 * THE ENGINE HOP: an orchestrator address is followed to its engine ONCE, with
 * the same token, cached 60 s, and a chain is refused (plan section 4; crucible
 * docs/PHASE17-ORCHESTRATOR.md section 6: the PC's engine may sit behind the
 * Windows tray on :7101).
 *
 * Two fakes play the pair: one with `role: 'orchestrator'` naming the other as
 * its engine. What is held: work (activity, capability) goes to the engine and
 * never to the orchestrator; the hop is asked once and then cached; an
 * orchestrator whose "engine" is itself an orchestrator is refused by name
 * rather than followed; one that manages no engine is refused by name.
 */
const { assert, crucible, fake, context, check, run } = require('./_crucible-keeper');

const { EngineResolver, RESOLVE_TTL_MS } = crucible('engine-resolve');
const { CrucibleClientFactory } = crucible('client-factory');

check('follows an orchestrator to its engine once, with the same token; work is read from the engine', async () => {
  const engine = await fake.startFakeCrucible({ name: 'crucible@owens-pc', backend: 'cuda-linux' });
  const orchestrator = await fake.startFakeCrucible({ role: 'orchestrator', token: engine.token, engine: { url: engine.url, name: 'crucible@owens-pc', backend: 'cuda-linux' } });
  try {
    const { ctx } = context();
    ctx.servers.add({ name: 'owens-pc', url: orchestrator.url, token: engine.token });
    const answer = await ctx.probes.test('owens-pc');
    assert.strictEqual(answer.probe.outcome, 'ok');
    assert.strictEqual(answer.probe.facts.backend, 'cuda-linux');
    assert.strictEqual(answer.probe.facts.engineUrl, engine.url);
    assert.strictEqual(engine.requestsTo('/v1/activity').length, 1);
    assert.strictEqual(orchestrator.requestsTo('/v1/activity').length, 0);
    assert.strictEqual(engine.requestsTo('/v1/info')[0].headers['authorization'], `Bearer ${engine.token}`);
  } finally {
    await orchestrator.close();
    await engine.close();
  }
});

check('the hop is cached 60 s per name: a second client costs no second hop, and after the TTL it is asked again', async () => {
  const engine = await fake.startFakeCrucible({});
  const orchestrator = await fake.startFakeCrucible({ role: 'orchestrator', token: engine.token, engine: { url: engine.url } });
  try {
    const { ctx } = context();
    ctx.servers.add({ name: 'pc', url: orchestrator.url, token: engine.token });
    let now = 5_000_000;
    const resolver = new EngineResolver((url, token, options) => ctx.factory.clientForCredentials(url, token, options), () => now);
    const entry = ctx.servers.getWithToken('pc');
    const first = await resolver.resolve(entry);
    await resolver.resolve(entry);
    assert.strictEqual(first.url, engine.url);
    assert.strictEqual(orchestrator.requestsTo('/v1/info').length, 1);
    now += RESOLVE_TTL_MS + 1;
    await resolver.resolve(entry);
    assert.strictEqual(orchestrator.requestsTo('/v1/info').length, 2);
  } finally {
    await orchestrator.close();
    await engine.close();
  }
});

check('concurrent resolutions of one name share one request', async () => {
  const engine = await fake.startFakeCrucible({});
  const orchestrator = await fake.startFakeCrucible({ role: 'orchestrator', token: engine.token, engine: { url: engine.url } });
  try {
    const { ctx } = context();
    ctx.servers.add({ name: 'pc', url: orchestrator.url, token: engine.token });
    await Promise.all([ctx.factory.resolve('pc'), ctx.factory.resolve('pc'), ctx.factory.resolve('pc')]);
    assert.strictEqual(orchestrator.requestsTo('/v1/info').length, 1);
  } finally {
    await orchestrator.close();
    await engine.close();
  }
});

check('an engine address needs no hop: one info, no second server asked', async () => {
  const engine = await fake.startFakeCrucible({});
  try {
    const { ctx } = context();
    ctx.servers.add({ name: 'mac', url: engine.url, token: engine.token });
    const resolved = await ctx.factory.resolve('mac');
    assert.strictEqual(resolved.url, engine.url);
    assert.strictEqual(resolved.through, null);
  } finally {
    await engine.close();
  }
});

check('never follows a chain: an "engine" that is itself an orchestrator is refused by name', async () => {
  const deepest = await fake.startFakeCrucible({});
  const middle = await fake.startFakeCrucible({ role: 'orchestrator', token: deepest.token, engine: { url: deepest.url } });
  const front = await fake.startFakeCrucible({ role: 'orchestrator', token: deepest.token, engine: { url: middle.url } });
  try {
    const { ctx } = context();
    ctx.servers.add({ name: 'chain', url: front.url, token: deepest.token });
    const answer = await ctx.probes.test('chain');
    assert.strictEqual(answer.probe.outcome, 'refused');
    assert.match(answer.probe.message, /crucible_orchestrator_chain/);
    // One hop was taken and no more: the deepest server was never asked.
    assert.strictEqual(deepest.requests.length, 0);
  } finally {
    await front.close();
    await middle.close();
    await deepest.close();
  }
});

check('refuses an orchestrator that manages no engine, by name', async () => {
  const orchestrator = await fake.startFakeCrucible({ role: 'orchestrator', engine: null });
  try {
    const { ctx } = context();
    ctx.servers.add({ name: 'pc', url: orchestrator.url, token: orchestrator.token });
    const answer = await ctx.probes.test('pc');
    assert.strictEqual(answer.probe.outcome, 'refused');
    assert.match(answer.probe.message, /crucible_orchestrator_has_no_engine/);
  } finally {
    await orchestrator.close();
  }
});

check('a registry change forgets the cached hop for that name', async () => {
  const engine = await fake.startFakeCrucible({});
  const orchestrator = await fake.startFakeCrucible({ role: 'orchestrator', token: engine.token, engine: { url: engine.url } });
  try {
    const { ctx } = context();
    ctx.servers.add({ name: 'pc', url: orchestrator.url, token: engine.token });
    await ctx.factory.resolve('pc');
    ctx.servers.remove('pc');
    ctx.servers.add({ name: 'pc', url: orchestrator.url, token: engine.token });
    await ctx.factory.resolve('pc');
    assert.strictEqual(orchestrator.requestsTo('/v1/info').length, 2);
  } finally {
    await orchestrator.close();
    await engine.close();
  }
});

check('every client in the main process is built in client-factory.ts, named contentstudio', () => {
  const fs = require('fs');
  const path = require('path');
  const dir = path.join(__dirname, '..', 'electron', 'crucible');
  const builders = fs.readdirSync(dir).filter((file) => file.endsWith('.ts'))
    .filter((file) => /new CrucibleClient\(/.test(fs.readFileSync(path.join(dir, file), 'utf8')));
  assert.deepStrictEqual(builders, ['client-factory.ts']);
  assert.strictEqual(crucible('client-factory').CRUCIBLE_CLIENT_NAME, 'contentstudio');
  assert.ok(CrucibleClientFactory);
});

run('crucible: the engine hop, once');
