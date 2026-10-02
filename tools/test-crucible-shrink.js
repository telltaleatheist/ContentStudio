/**
 * The cross-job shrink against the fake (LEDGER #220, #209): a model already resident at a larger
 * context than the job needs is reloaded at the smaller one.
 *
 * What is held:
 *  - a model resident at 24,576 when the job's queue session opens (another app left it, or it
 *    was loaded outside a session) is reloaded at 8,192 for a job that needs only that, and the log
 *    calls the reload by its name; within the job the window then stays;
 *  - closing a job's session settles the card (Crucible 1.0.76, LEDGER #255), so the next job loads
 *    at its own size from an empty card: no shrink is needed between two of our jobs;
 *  - within ONE job the window still only grows (test-crucible-p4.js holds that side).
 *
 * No GPU, no model, no network beyond 127.0.0.1.
 */
const { assert, fake, context, check, run, logged, crucible } = require('./_crucible-keeper');

const { installCrucibleTransport } = crucible('transport');
const { installLanes, routeOfModelId } = crucible('lanes');
const { loadContextFor } = crucible('context-check');

const MODEL = 'qwen3.8-27b-4bit';
const MODELS = [{ id: MODEL, paramsB: 27, installed: true, contextDefault: 98304 }];

async function withDoor(options, fn) {
  const server = await fake.startFakeCrucible({ version: '1.0.76', models: MODELS, ...options });
  const made = context();
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

check('a model resident at 24,576 when the job\'s session opens is reloaded at 8,192 for a job that needs only that; within the job it stays', () => withDoor({}, async (server, ctx) => {
  server.setResident(MODEL, 24576);
  const job = ctx.transport.job('job B (fields)');
  await asker(ctx, job)(3500, 2048, 'a field call');        // needs 8,192: reload smaller
  await asker(ctx, job)(3500, 2048, 'another field call');  // same job, same window: no reload
  await job.releaseAll();
  assert.deepStrictEqual(loads(server).map((b) => b.params.context), [8192], 'one load: the shrink');
  assert.ok(logged.some((l) => /needs only 8192; reloading it at 8192/.test(l.text)), 'the shrink is said by name');
  assert.strictEqual(server.sessions.length, 1, 'the reload ran inside the job\'s session');
}));

check('closing a job\'s session settles the card, so the next job loads at its own size from an empty card', () => withDoor({}, async (server, ctx) => {
  const jobA = ctx.transport.job('job A (thinking)');
  await asker(ctx, jobA)(3500, 16384, 'a thinking call');   // loads at 24,576
  await jobA.releaseAll();
  assert.strictEqual(server.resident(), null, 'the server settled the card when the session closed');
  const before = logged.length;
  const jobB = ctx.transport.job('job B (fields)');
  await asker(ctx, jobB)(3500, 2048, 'a field call');
  await jobB.releaseAll();
  assert.deepStrictEqual(loads(server).map((b) => b.params.context), [24576, 8192]);
  assert.ok(!logged.slice(before).some((l) => /reloading it at/.test(l.text)), 'a fresh load, not a reload');
}));

run('crucible: the cross-job shrink, inside queue sessions');
