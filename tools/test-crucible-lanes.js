/**
 * THE LANES: admission, parking, the fast pin, one job per server, and cloud
 * calls beside a busy GPU lane (CRUCIBLE-MIGRATION-PLAN.md section 13, LEDGER
 * #195, #205), against tools/fake-crucible.js.
 *
 * The step every job runs here stands in for transport.ts (another phase's):
 * inside `aiCall` it reads `crucibleStepHooks()`, submits a `load-model` to the
 * server the hooks name, and records the job in the ledger the moment the
 * server admits it, exactly as docs/crucible/P3.md says transport.ts must. So
 * what is under test is this layer's contract with transport, not a copy of it.
 *
 * The preflight is driven by hand (`lanes.readAll()`), with its interval set
 * far past any keeper's run, and the lanes' clock is a counter the keeper
 * advances: nothing here waits on a real 15 s.
 */
const { assert, crucible, fake, context, check, run } = require('./_crucible-keeper');

const { gpuCall, routeOfModelId, crucibleStepHooks, CrucibleJobStalled } = crucible('lanes');

const MODEL = 'qwen3.5-9b';

/** Two fake servers, registered as `mac` (selected) and `pc` (the fast pin), with a hand-driven clock. */
async function world(options = {}) {
  const mac = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.34', resident: MODEL });
  const pc = await fake.startFakeCrucible({ name: 'crucible@pc', version: '1.0.34', backend: 'cuda-linux', resident: MODEL });
  const clock = { t: 1_000_000 };
  const { ctx, pushed, dir } = context({
    lanes: { now: () => clock.t, preflightEveryMs: 3_600_000, ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }) },
  });
  ctx.servers.add({ name: 'mac', url: mac.url, token: mac.token });
  ctx.servers.add({ name: 'pc', url: pc.url, token: pc.token });
  ctx.servers.select('mac');
  if (options.noFast !== true) ctx.servers.setFast('pc');
  const lanes = ctx.lanes;
  const tick = async (ms = 15_000) => {
    clock.t += ms;
    ctx.probes.now = () => clock.t;
    await lanes.readAll();
  };
  const close = async () => {
    lanes.stop();
    await mac.close();
    await pc.close();
  };
  return { ctx, lanes, mac, pc, clock, tick, close, pushed, dir };
}

/** The step transport.ts will be: submit on the hooks' server, record the job at once, settle it when done. */
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

const submitsTo = (server) => server.requestsTo('/v1/jobs', 'POST').length;

check('409 server_busy parks the job with the holder\'s sentence, the lane is freed, and the stage is kept', async () => {
  const w = await world();
  try {
    w.mac.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.62 } });
    const outcome = await w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'chapters' }, async (runInfo) => {
      runInfo.stage = 'fields';
      return loadStep(w.ctx, w.lanes);
    });
    assert.strictEqual(outcome.kind, 'parked');
    assert.deepStrictEqual(
      { status: outcome.result.status, server: outcome.result.server, stage: outcome.result.stage, code: outcome.result.code },
      { status: 'parked', server: 'mac', stage: 'fields', code: 'server_busy' },
    );
    assert.match(outcome.result.holderLine, /bookforge/);
    assert.match(outcome.result.holderLine, /tts/);
    assert.deepStrictEqual(w.lanes.running(), []);
    assert.strictEqual(w.lanes.view().lanes.find((lane) => lane.server === 'mac').runningJobId, null, 'the lane was released');
  } finally {
    await w.close();
  }
});

check('a parked job is re-admitted once the preflight says acceptsWork, and never resubmitted while it does not', async () => {
  const w = await world();
  try {
    w.mac.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.62 } });
    await w.tick();
    const first = await w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'chapters' }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(first.kind, 'parked');
    assert.strictEqual(submitsTo(w.mac), 1);
    // Twenty preflight passes (five minutes of the lanes' clock) with the holder still there.
    for (let i = 0; i < 20; i += 1) {
      await w.tick();
      const plan = await w.lanes.plan([{ jobId: 'j1', fast: false }]);
      assert.deepStrictEqual(plan.start, [], `pass ${i}: nothing starts while the card is held`);
      assert.strictEqual(plan.waiting[0].parked, true);
      assert.match(plan.waiting[0].line, /bookforge/);
    }
    assert.strictEqual(submitsTo(w.mac), 1, 'no resubmission while busy: not one');
    // The holder goes; the next read says accepts_work, and the plan starts it (once).
    w.mac.inject({});
    await w.tick();
    const plan = await w.lanes.plan([{ jobId: 'j1', fast: false }]);
    assert.deepStrictEqual(plan.start, [{ jobId: 'j1', server: 'mac' }]);
    const again = await w.lanes.plan([{ jobId: 'j1', fast: false }]);
    assert.deepStrictEqual(again.start, [], 'the lane is reserved for it: a second plan does not start it twice');
    const second = await w.lanes.runJob({ jobId: 'j1', fast: false, stage: first.result.stage }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(second.kind, 'done');
    assert.strictEqual(submitsTo(w.mac), 2);
  } finally {
    await w.close();
  }
});

check('a leased card parks until the lease is gone, not until accepts_work (a lease never changes it)', async () => {
  const w = await world();
  try {
    w.mac.leaseAsOther('qwen3.8-27b-4bit', 'foundry');
    const outcome = await w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'chapters' }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(outcome.kind, 'parked');
    assert.strictEqual(outcome.result.code, 'leased');
    assert.match(outcome.result.holderLine, /foundry/);
    await w.tick();
    assert.deepStrictEqual((await w.lanes.plan([{ jobId: 'j1', fast: false }])).start, [], 'accepts_work is true, the lease is not gone: it waits');
    w.mac.expireLease();
    await w.tick();
    assert.deepStrictEqual((await w.lanes.plan([{ jobId: 'j1', fast: false }])).start, [{ jobId: 'j1', server: 'mac' }]);
  } finally {
    await w.close();
  }
});

check('a fast-pinned item goes to the PC, waits for it when it is busy, and never goes to the idle Mac', async () => {
  const w = await world();
  try {
    w.pc.inject({ serverBusy: { client: 'owen', type: 'tts', progress: 0.1 } });
    const outcome = await w.lanes.runJob({ jobId: 'fast1', fast: true, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(outcome.kind, 'parked');
    assert.strictEqual(outcome.result.server, 'pc');
    for (let i = 0; i < 5; i += 1) {
      await w.tick();
      const plan = await w.lanes.plan([{ jobId: 'fast1', fast: true }]);
      assert.deepStrictEqual(plan.start, []);
      assert.strictEqual(plan.waiting[0].server, 'pc');
    }
    assert.strictEqual(submitsTo(w.mac), 0, 'the Mac was never asked, though it sat idle');
    w.pc.inject({});
    await w.tick();
    assert.deepStrictEqual((await w.lanes.plan([{ jobId: 'fast1', fast: true }])).start, [{ jobId: 'fast1', server: 'pc' }]);
    const done = await w.lanes.runJob({ jobId: 'fast1', fast: true, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.deepStrictEqual([done.kind, done.server, done.value.server], ['done', 'pc', 'pc']);
    assert.strictEqual(submitsTo(w.mac), 0);
  } finally {
    await w.close();
  }
});

check('a fast item with no fast server pinned, or with the PC paused, waits by name and still never goes to the Mac', async () => {
  const w = await world({ noFast: true });
  try {
    const unpinned = await w.lanes.runJob({ jobId: 'fast1', fast: true, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.deepStrictEqual([unpinned.kind, unpinned.result.code, unpinned.result.server], ['parked', 'no_server', null]);
    assert.match(unpinned.result.holderLine, /fast/);
    w.ctx.servers.setFast('pc');
    w.ctx.servers.setPaused('pc', true);
    const paused = await w.lanes.runJob({ jobId: 'fast1', fast: true, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.deepStrictEqual([paused.kind, paused.result.code, paused.result.server], ['parked', 'paused', 'pc']);
    assert.match(paused.result.holderLine, /paused, work waits/);
    assert.strictEqual(submitsTo(w.mac) + submitsTo(w.pc), 0);
  } finally {
    await w.close();
  }
});

check('an unpinned item stays on the selected server even when another server is idle (LEDGER #205)', async () => {
  const w = await world();
  try {
    w.mac.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.5 } });
    await w.tick();
    const outcome = await w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.deepStrictEqual([outcome.kind, outcome.result.server], ['parked', 'mac']);
    for (let i = 0; i < 5; i += 1) {
      await w.tick();
      const plan = await w.lanes.plan([{ jobId: 'j1', fast: false }]);
      assert.deepStrictEqual(plan.start, []);
      assert.strictEqual(plan.waiting[0].server, 'mac');
    }
    assert.strictEqual(submitsTo(w.pc), 0, 'the idle PC was never handed the work');
    // A switch the USER makes moves work not yet started (Briefcase's rule): that is the only move.
    w.ctx.servers.select('pc');
    assert.deepStrictEqual((await w.lanes.plan([{ jobId: 'j1', fast: false }])).start, [{ jobId: 'j1', server: 'pc' }]);
  } finally {
    await w.close();
  }
});

check('one running job per server: the Mac\'s and the PC\'s run side by side, a third waits for its own lane', async () => {
  const w = await world();
  try {
    const plan = await w.lanes.plan([
      { jobId: 'a', fast: false },
      { jobId: 'b', fast: true },
      { jobId: 'c', fast: false },
    ]);
    assert.deepStrictEqual(plan.start, [{ jobId: 'a', server: 'mac' }, { jobId: 'b', server: 'pc' }]);
    assert.deepStrictEqual(plan.waiting.map((row) => [row.jobId, row.server, row.parked]), [['c', 'mac', false]]);
    // Both run at once.
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const seen = [];
    const job = (jobId, fast) => w.lanes.runJob({ jobId, fast, stage: 'transcribe' }, async () => {
      seen.push(jobId);
      await gate;
      return loadStep(w.ctx, w.lanes);
    });
    const a = job('a', false);
    const b = job('b', true);
    const deadline = Date.now() + 2_000;
    while (seen.length < 2 && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.deepStrictEqual(seen.sort(), ['a', 'b'], 'both jobs were admitted before either finished');
    assert.deepStrictEqual(w.lanes.view().lanes.map((lane) => [lane.server, lane.state, lane.runningJobId]), [['mac', 'running', 'a'], ['pc', 'running', 'b']]);
    release();
    const [ra, rb] = await Promise.all([a, b]);
    assert.deepStrictEqual([ra.server, rb.server], ['mac', 'pc']);
    assert.deepStrictEqual((await w.lanes.plan([{ jobId: 'c', fast: false }])).start, [{ jobId: 'c', server: 'mac' }]);
  } finally {
    await w.close();
  }
});

check('cloud calls run while the GPU lane is busy; a second GPU call on the same server waits for the slot', async () => {
  const w = await world();
  try {
    let releaseGpu;
    const holding = new Promise((resolve) => { releaseGpu = resolve; });
    const order = [];
    const gpu = w.lanes.aiCall(gpuCall(MODEL), 'a long local call', async () => { order.push('gpu1 start'); await holding; order.push('gpu1 end'); return 'g1'; });
    while (!order.includes('gpu1 start')) await new Promise((resolve) => setTimeout(resolve, 5));
    const gpu2 = w.lanes.aiCall(gpuCall(MODEL), 'the next local call', async () => { order.push('gpu2 start'); return 'g2'; });
    const cloud = await w.lanes.aiCall(routeOfModelId('anthropic/claude-sonnet-5'), 'a cloud call', async () => { order.push('cloud'); return 'c'; });
    const cli = await w.lanes.aiCall(routeOfModelId('claude-cli:sonnet'), 'a claude -p call', async () => { order.push('claude -p'); return 'p'; });
    assert.deepStrictEqual([cloud, cli], ['c', 'p']);
    assert.deepStrictEqual(order, ['gpu1 start', 'cloud', 'claude -p'], 'the cloud calls ran while the slot was held; the second GPU call did not');
    releaseGpu();
    assert.deepStrictEqual(await Promise.all([gpu, gpu2]), ['g1', 'g2']);
    assert.deepStrictEqual(order, ['gpu1 start', 'cloud', 'claude -p', 'gpu1 end', 'gpu2 start']);
    assert.throws(() => routeOfModelId('ollama:qwen3.8:27b'), /names no model this app routes/);
    assert.strictEqual(routeOfModelId('qwen3.8-27b-4bit').lane, 'gpu', 'a Crucible id takes its server\'s slot');
  } finally {
    await w.close();
  }
});

check('a standalone GPU call runs on the selected server, and on a paused one it is refused by name, not queued', async () => {
  const w = await world();
  try {
    const answer = await loadStep(w.ctx, w.lanes);
    assert.strictEqual(answer.server, 'mac');
    w.ctx.servers.setPaused('mac', true);
    await assert.rejects(loadStep(w.ctx, w.lanes), (err) => err.code === 'server_paused' && /paused/.test(err.message));
  } finally {
    await w.close();
  }
});

check('a Stop on a parked row forgets its park, so it neither starts later nor counts on the chip', async () => {
  const w = await world();
  try {
    w.mac.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.5 } });
    await w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(w.lanes.view().lanes.find((lane) => lane.server === 'mac').parked, 1);
    await w.lanes.stopJob('j1', 'Removed from the queue');
    assert.strictEqual(w.lanes.parkOf('j1'), null);
    assert.strictEqual(w.lanes.view().lanes.find((lane) => lane.server === 'mac').parked, 0);
  } finally {
    await w.close();
  }
});

check('the stall clock ends a silent job: the fetch is aborted, its lease released, and the row says why', async () => {
  const w = await world({ stallMs: 150 });
  try {
    let aborted = null;
    await assert.rejects(
      w.lanes.runJob({ jobId: 'quiet', fast: false, stage: 'chapters' }, async (runInfo) => {
        await w.lanes.aiCall(gpuCall(MODEL), 'take the job lease', async () => {
          const hooks = crucibleStepHooks();
          const client = await w.ctx.factory.clientFor(hooks.server);
          const lease = await client.lease(MODEL, { act: 'generate', ttlSeconds: 120 });
          hooks.leased({ server: hooks.server, id: lease.leaseId, model: MODEL });
        });
        // Then nothing: no event, no completed call, no progress line.
        await new Promise((resolve) => runInfo.controller.signal.addEventListener('abort', () => { aborted = runInfo.controller.signal.reason; resolve(); }));
        throw new Error('the generator saw its signal abort');
      }),
      (err) => err instanceof CrucibleJobStalled && /heard nothing/.test(err.message),
    );
    assert.ok(aborted instanceof CrucibleJobStalled, 'the open fetch was aborted with the stall');
    assert.deepStrictEqual(w.mac.leases.released, ['lease-1'], 'the job\'s lease was released');
    assert.deepStrictEqual(w.ctx.ledger.read(), []);
  } finally {
    await w.close();
  }
});

run('crucible: lanes, parking and the fast pin');
