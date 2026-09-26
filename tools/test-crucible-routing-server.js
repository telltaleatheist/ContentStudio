/**
 * THE ROUTING'S SERVER (LEDGER #222; Owen, 2026-09-26: "we can pick which crucible server we
 * use (wsl or mac) in model routing"), against tools/fake-crucible.js.
 *
 * The model routing stores `server`; venue-decision.ts is the one place it takes effect: a
 * fast-pinned job goes to the fast server, else to the routing's server, else to the selected
 * one. What is held here:
 *
 *   - routing names the second server: the job is admitted there, its load-model lands there
 *     and nowhere else, and the admission line's `because` says the routing's server;
 *   - routing unset: the selected server, exactly as before the key existed;
 *   - the fast pin wins over a routing server;
 *   - a routing server that is paused parks the job with the paused sentence and never moves it;
 *   - a routing naming a server since forgotten is dropped (store rewritten, one line) and the
 *     job goes to the selected server;
 *   - inside the job, transcription's venue and an upstream call's server are that same server.
 *
 * The routing is read the way main.ts reads it (`readStoredRoutingServer` over a store), with a
 * map standing in for electron-store. Nothing here talks to a real Crucible.
 */
const path = require('path');
const { assert, crucible, fake, context, check, run, logged, REPO } = require('./_crucible-keeper');

const { gpuCall, crucibleStepHooks, currentJobVenue } = crucible('lanes');
const { upstreamServerFor } = crucible('venue-decision');
const routing = require(path.join(REPO, 'dist', 'main', 'services', 'metadata', 'metadata-routing.js'));

const MODEL = 'qwen3.5-9b';

/** Two fake servers, `mac` (selected) and `pc`, with the routing read from a map-backed store. */
async function world(stored) {
  const mac = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.34', resident: MODEL });
  const pc = await fake.startFakeCrucible({ name: 'crucible@pc', version: '1.0.34', backend: 'cuda-linux', resident: MODEL });
  const data = { metadataRouting: stored };
  const store = { get: (key) => data[key], set: (key, value) => { data[key] = value; } };
  const { ctx } = context({
    lanes: { now: () => 1_000_000, preflightEveryMs: 3_600_000 },
    routingServer: (registered) => routing.readStoredRoutingServer(store, registered),
  });
  ctx.servers.add({ name: 'mac', url: mac.url, token: mac.token });
  ctx.servers.add({ name: 'pc', url: pc.url, token: pc.token });
  ctx.servers.select('mac');
  const close = async () => {
    ctx.lanes.stop();
    await mac.close();
    await pc.close();
  };
  return { ctx, lanes: ctx.lanes, mac, pc, data, close };
}

/** What transport.ts does for a local call: submit on the hooks' server, record it, settle it. */
function loadStep(ctx, lanes) {
  return lanes.aiCall(gpuCall(MODEL), 'a keeper load', async () => {
    const hooks = crucibleStepHooks();
    const client = await ctx.factory.clientFor(hooks.server);
    const id = await client.loadModel(MODEL);
    hooks.submitted({ server: hooks.server, id, jobType: 'load-model', model: MODEL });
    hooks.settled(hooks.server, 'job', id);
    return { server: hooks.server, id };
  });
}

const loadsOn = (server) => server.requestsTo('/v1/jobs', 'POST').length;
const admissionLine = (jobId) => {
  const line = logged.filter((entry) => entry.text.includes(`${jobId} admitted to`)).pop();
  return line === undefined ? null : line.text;
};

check('routing names the second server: the job is admitted there, its load-model lands there, and the log says why', async () => {
  const w = await world({ titles: 'qwen38-27b', server: 'pc' });
  try {
    const plan = await w.lanes.plan([{ jobId: 'r1', fast: false }]);
    assert.deepStrictEqual(plan.start, [{ jobId: 'r1', server: 'pc' }], 'the plan reserves the routing server\'s lane');
    const outcome = await w.lanes.runJob({ jobId: 'r1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.deepStrictEqual([outcome.kind, outcome.server, outcome.value.server], ['done', 'pc', 'pc']);
    assert.strictEqual(loadsOn(w.pc), 1, 'the load-model landed on pc');
    assert.strictEqual(loadsOn(w.mac), 0, 'the selected server was never asked');
    assert.strictEqual(admissionLine('r1'), '[crucible] r1 admitted to "pc" (the routing\'s server), from transcribe');
  } finally {
    await w.close();
  }
});

check('inside that job, transcription and an upstream call go to the same server: a job never spans servers', async () => {
  const w = await world({ server: 'pc' });
  try {
    const seen = await w.lanes.runJob({ jobId: 'r2', fast: false, stage: 'transcribe' }, async () => {
      const asr = w.ctx.asrVenue();
      const cloud = await w.lanes.aiCall({ lane: 'cloud', model: 'anthropic/claude-sonnet-5' }, 'a keeper cloud step', async () =>
        upstreamServerFor(crucibleStepHooks().routingServer, w.ctx.servers));
      return { job: currentJobVenue().server, asr: asr.server, cloud };
    });
    assert.deepStrictEqual(seen.value, { job: 'pc', asr: 'pc', cloud: 'pc' });
    // Outside a job an upstream call still goes to the selected server, as before.
    assert.strictEqual(upstreamServerFor(null, w.ctx.servers), 'mac');
  } finally {
    await w.close();
  }
});

check('routing unset: the selected server, exactly as before the key existed', async () => {
  const w = await world({ titles: 'qwen38-27b' });
  try {
    const outcome = await w.lanes.runJob({ jobId: 'r3', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.deepStrictEqual([outcome.kind, outcome.server], ['done', 'mac']);
    assert.strictEqual(loadsOn(w.mac), 1);
    assert.strictEqual(loadsOn(w.pc), 0);
    assert.strictEqual(admissionLine('r3'), '[crucible] r3 admitted to "mac" (the selected server), from transcribe');
    const noStore = await world(undefined);
    try {
      const plan = await noStore.lanes.plan([{ jobId: 'r3b', fast: false }]);
      assert.deepStrictEqual(plan.start, [{ jobId: 'r3b', server: 'mac' }], 'no stored routing at all: the selected server');
    } finally {
      await noStore.close();
    }
  } finally {
    await w.close();
  }
});

check('the fast pin wins over a routing server', async () => {
  const w = await world({ server: 'pc' });
  try {
    w.ctx.servers.setFast('mac');
    const outcome = await w.lanes.runJob({ jobId: 'r4', fast: true, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.deepStrictEqual([outcome.kind, outcome.server], ['done', 'mac']);
    assert.strictEqual(loadsOn(w.pc), 0, 'the routing server was not asked for a pinned item');
    assert.strictEqual(admissionLine('r4'), '[crucible] r4 admitted to "mac" (the fast pin), from transcribe');
  } finally {
    await w.close();
  }
});

check('a paused routing server parks the job with the paused sentence and never moves it to the selected one', async () => {
  const w = await world({ server: 'pc' });
  try {
    w.ctx.servers.setPaused('pc', true);
    const outcome = await w.lanes.runJob({ jobId: 'r5', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(outcome.kind, 'parked');
    assert.strictEqual(outcome.result.server, 'pc');
    assert.strictEqual(outcome.result.code, 'paused');
    assert.match(outcome.result.holderLine, /pc is paused, work waits/);
    const plan = await w.lanes.plan([{ jobId: 'r5', fast: false }]);
    assert.deepStrictEqual(plan.start, [], 'nothing starts on the idle selected server');
    assert.strictEqual(plan.waiting[0].server, 'pc');
    assert.strictEqual(loadsOn(w.mac) + loadsOn(w.pc), 0);
  } finally {
    await w.close();
  }
});

check('a routing naming a forgotten server is dropped with one line, the store rewritten, and the job goes to the selected server', async () => {
  const w = await world({ titles: 'opus5', server: 'pc' });
  try {
    w.ctx.servers.remove('pc');
    const before = logged.length;
    const outcome = await w.lanes.runJob({ jobId: 'r6', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.deepStrictEqual([outcome.kind, outcome.server], ['done', 'mac']);
    assert.strictEqual(admissionLine('r6'), '[crucible] r6 admitted to "mac" (the selected server), from transcribe');
    const drops = logged.slice(before).filter((entry) => entry.text.includes('dropped metadataRouting.server = "pc"'));
    assert.strictEqual(drops.length, 1, 'said once');
    assert.strictEqual(drops[0].level, 'warn');
    assert.deepStrictEqual(w.data.metadataRouting, { titles: 'opus5' }, 'the server is gone from the store; the fields stay');
    // A second job reads the rewritten store: nothing more to say.
    await w.lanes.runJob({ jobId: 'r6b', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(logged.slice(before).filter((entry) => entry.text.includes('dropped metadataRouting.server')).length, 1);
  } finally {
    await w.close();
  }
});

check('changing the routing server moves a parked job that has not started, as a Select would', async () => {
  const w = await world({ server: 'pc' });
  try {
    w.ctx.servers.setPaused('pc', true);
    const parked = await w.lanes.runJob({ jobId: 'r7', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(parked.kind, 'parked');
    delete w.data.metadataRouting.server;
    const plan = await w.lanes.plan([{ jobId: 'r7', fast: false }]);
    assert.deepStrictEqual(plan.start, [{ jobId: 'r7', server: 'mac' }], 'the user chose: it goes where the routing now says');
  } finally {
    await w.close();
  }
});

run('THE ROUTING\'S SERVER (LEDGER #222): the job runs where the routing says, the pin still wins, nothing moves by itself');
