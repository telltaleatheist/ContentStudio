/**
 * The cross-job shrink against the fake (LEDGER #220, #209): a model left resident by an earlier
 * job at a larger context than the next job needs is reloaded at the smaller one.
 *
 * What is held:
 *  - job A loads the 27B at 24,576 and releases; job B, which needs only 8,192, reloads it at
 *    8,192 rather than running in the larger window, and the log calls the reload by its name;
 *  - another client's lease is never disturbed: when the resident model is leased by someone else,
 *    job B runs under their lease at their window, no reload, and the log says so;
 *  - within ONE job the window still only grows (test-crucible-p4.js holds that side).
 *
 * No GPU, no model, no network beyond 127.0.0.1.
 */
const { CrucibleClient } = require('@crucible/client');
const { assert, fake, context, check, run, logged, crucible } = require('./_crucible-keeper');

const { installCrucibleTransport } = crucible('transport');
const { installLanes, routeOfModelId } = crucible('lanes');
const { loadContextFor } = crucible('context-check');

const MODEL = 'qwen3.8-27b-4bit';
const MODELS = [{ id: MODEL, paramsB: 27, installed: true, contextDefault: 98304 }];

async function withDoor(options, fn) {
  const server = await fake.startFakeCrucible({ version: '1.0.34', models: MODELS, ...options });
  const made = context({ leaseTimings: { heartbeatMs: 40, releaseGraceMs: 20, requestTimeoutMs: 500 } });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  try {
    await fn(server, made.ctx);
  } finally {
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
  }
}

const loads = (server) => server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b && b.type === 'load-model');

function asker(ctx, job) {
  return (chars, maxTokens, what) => ctx.lanes.aiCall(routeOfModelId(MODEL), what, () => ctx.transport.chat({
    model: MODEL, prompt: 'y'.repeat(chars), act: 'generate', thinking: false, maxTokens,
    loadContext: loadContextFor(chars, maxTokens), job, what, trace: null,
  }));
}

check('a model left resident at 24,576 by one job is reloaded at 8,192 for the next job that needs only that', () => withDoor({}, async (server, ctx) => {
  const jobA = ctx.transport.job('job A (thinking)');
  await asker(ctx, jobA)(3500, 16384, 'a thinking call');   // loads at 24,576
  await jobA.releaseAll();

  const jobB = ctx.transport.job('job B (fields)');
  await asker(ctx, jobB)(3500, 2048, 'a field call');        // needs 8,192: reload smaller
  await asker(ctx, jobB)(3500, 2048, 'another field call');  // same job, same window: no reload
  await jobB.releaseAll();

  assert.deepStrictEqual(loads(server).map((b) => b.params.context), [24576, 8192], 'two loads: the big one, then the shrink');
  assert.ok(logged.some((l) => /needs only 8192; reloading it at 8192/.test(l.text)), 'the shrink is said by name');
  const leaseRows = server.requests.filter((r) => r.method === 'POST' && /lease/.test(r.path) && !/release/.test(r.path));
  assert.ok(leaseRows.length >= 1, `the shrink proved the card was free by taking a lease first (${server.requests.map((r) => r.path).join(', ')})`);
}));

check('a resident model leased by another client is not reloaded smaller; the job runs under their lease and says so', () => withDoor({}, async (server, ctx) => {
  const jobA = ctx.transport.job('job A (thinking)');
  await asker(ctx, jobA)(3500, 16384, 'a thinking call');   // loads at 24,576
  await jobA.releaseAll();

  // Another app takes the card, on the same model.
  const other = new CrucibleClient({ url: server.url, token: server.token, clientName: 'bookforge' });
  const theirs = await other.lease(MODEL, { act: 'generate', ttlSeconds: 60 });
  try {
    const jobB = ctx.transport.job('job B (fields)');
    await asker(ctx, jobB)(3500, 2048, 'a field call');
    await jobB.releaseAll();
    assert.deepStrictEqual(loads(server).map((b) => b.params.context), [24576], 'no reload while the card is theirs');
    assert.ok(logged.some((l) => /leased by .*not reloaded smaller/.test(l.text)), 'the skipped shrink is said');
  } finally {
    await other.release(theirs.leaseId).catch(() => undefined);
  }
}));

run();
