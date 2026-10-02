/**
 * THE LANES: admission, the job's queue session, the server's line, the fast pin, one job per
 * server, and cloud calls beside a busy GPU lane (CRUCIBLE-MIGRATION-PLAN.md section 13, LEDGER
 * #195, #205, #255), against tools/fake-crucible.js.
 *
 * The step every job runs here stands in for transport.ts: inside `aiCall` it reads
 * `crucibleStepHooks()`, holds the step's queue session (`hooks.session`, the lane job's own),
 * submits a `load-model` in it and records the job in the ledger the moment the server admits it,
 * exactly as docs/crucible/P3.md says transport.ts must. So what is under test is this layer's
 * contract with transport, not a copy of it.
 *
 * Since Crucible 1.0.76 another app on a server is not a park: the job's session waits in the
 * server's own line, and the chip and the job's row say where it stands. The strip is read by
 * hand (`lanes.readAll()`); the lanes' clock is a counter the keeper advances.
 */
const { assert, crucible, fake, context, check, run, until } = require('./_crucible-keeper');

const { gpuCall, routeOfModelId, crucibleStepHooks, CrucibleJobStalled, JOB_SESSION_MAX_WAIT_S } = crucible('lanes');
const { CRUCIBLE_CLIENT_NAME } = crucible('client-factory');

const MODEL = 'qwen3.5-9b';

/** Two fake servers, registered as `mac` (selected) and `pc` (the fast pin), with a hand-driven clock. */
async function world(options = {}) {
  const mac = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.76', resident: MODEL });
  const pc = await fake.startFakeCrucible({ name: 'crucible@pc', version: '1.0.76', backend: 'cuda-linux', resident: MODEL });
  const clock = { t: 1_000_000 };
  const { ctx, pushed, dir } = context({
    lanes: {
      now: () => clock.t,
      ...(options.stallMs === undefined ? {} : { stallMs: options.stallMs }),
      ...(options.touchEveryMs === undefined ? {} : { touchEveryMs: options.touchEveryMs }),
    },
  });
  ctx.servers.add({ name: 'mac', url: mac.url, token: mac.token });
  ctx.servers.add({ name: 'pc', url: pc.url, token: pc.token });
  ctx.servers.select('mac');
  if (options.noFast !== true) ctx.servers.setFast('pc');
  const lanes = ctx.lanes;
  const close = async () => {
    lanes.stop();
    await ctx.sessions.closeAll('the keeper is done');
    await mac.close();
    await pc.close();
  };
  return { ctx, lanes, mac, pc, clock, close, pushed, dir };
}

/** The step transport.ts is: the step's session, a submit in it, the job recorded at once and settled when done. */
function loadStep(ctx, lanes, what = 'a keeper load') {
  return lanes.aiCall(gpuCall(MODEL), what, async () => {
    const hooks = crucibleStepHooks();
    const hold = await hooks.session({ act: 'generate', what, ...(hooks.signal === null ? {} : { signal: hooks.signal }) });
    try {
      const id = await hold.card.session.loadModel(MODEL);
      hooks.submitted({ server: hooks.server, id, jobType: 'load-model', model: MODEL });
      hooks.settled(hooks.server, 'job', id);
      return { server: hooks.server, id, session: hold.card.id };
    } finally {
      await hold.release();
    }
  });
}

const submitsTo = (server) => server.requestsTo('/v1/jobs', 'POST').length;
const sessionAsks = (server) => server.requestsTo('/v1/queue/sessions', 'POST').length;
const ours = (server) => server.sessions.filter((row) => row.client === CRUCIBLE_CLIENT_NAME);

check('another app\'s session holds the server: the job\'s session waits in its line, the chip and the row say where, and it runs when the holder closes', async () => {
  const w = await world();
  try {
    const holder = w.mac.holdAsOther('bookforge/1.0', 'translate');
    const outcome = w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    await until(() => w.pushed.inLine.length > 0);
    assert.deepStrictEqual(w.pushed.inLine[0], { jobId: 'j1', server: 'mac', position: { position: 1, of: 1 } });
    await w.lanes.readAll();
    const chip = w.lanes.view().lanes.find((lane) => lane.server === 'mac');
    assert.deepStrictEqual([chip.state, chip.runningJobId, chip.inLine], ['running', 'j1', { jobId: 'j1', position: 1, of: 1 }]);
    assert.deepStrictEqual([chip.holder.kind, chip.holder.client, chip.holder.what], ['session', 'bookforge/1.0', 'translate'], 'what it waits behind');
    assert.strictEqual(submitsTo(w.mac), 0, 'nothing was sent while the server was another app\'s');
    w.mac.endSession(holder, 'client', 'bookforge is done');
    const done = await outcome;
    assert.deepStrictEqual([done.kind, done.server], ['done', 'mac']);
    assert.strictEqual(w.pushed.inLine.at(-1).position, null, 'the row is told it is no longer waiting');
    assert.strictEqual(w.lanes.view().lanes.find((lane) => lane.server === 'mac').inLine, null);
  } finally {
    await w.close();
  }
});

check('one session per job per server: opened by its first GPU work (idle 900 s, a day in line), joined by a standalone call, closed when the job ends', async () => {
  const w = await world();
  try {
    let opened;
    const sessionOpen = new Promise((resolve) => { opened = resolve; });
    let release;
    const gate = new Promise((resolve) => { release = resolve; });
    const job = w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, async () => {
      const first = await loadStep(w.ctx, w.lanes, 'the job\'s first call');
      opened();
      await gate;
      const second = await loadStep(w.ctx, w.lanes, 'the job\'s second call');
      return [first, second];
    });
    await sessionOpen;
    // The editor's story title, made OUTSIDE the job (no lane run in its async context) while the
    // job's session is open: it joins that session, never asks for a second one (which would
    // queue behind the first), and letting go of it does not close the job's.
    const standalone = await loadStep(w.ctx, w.lanes, 'a standalone title');
    assert.strictEqual(ours(w.mac)[0].status, 'open', 'the standalone call let go; the job still holds the session');
    release();
    const outcome = await job;
    assert.strictEqual(outcome.kind, 'done');
    assert.strictEqual(sessionAsks(w.mac), 1, 'one session for the whole job, the standalone call included');
    const [row] = ours(w.mac);
    assert.deepStrictEqual([row.idleS, row.maxWaitS, row.act], [900, JOB_SESSION_MAX_WAIT_S, 'generate']);
    assert.deepStrictEqual([...new Set([...outcome.value.map((v) => v.session), standalone.session])], [row.id]);
    assert.deepStrictEqual([row.status, row.reason], ['closed', 'client'], 'closed when the job ended');
    assert.ok(w.mac.requestsTo('/v1/jobs', 'POST').every((r) => r.headers['x-crucible-session'] === row.id), 'every item names the session');
    assert.deepStrictEqual(w.ctx.ledger.read(), [], 'the session row left the ledger when it closed');
  } finally {
    await w.close();
  }
});

check('a session the server ends under a job fails its next call by name (session_closed, the reason), and no new session is opened', async () => {
  const w = await world();
  try {
    await assert.rejects(
      w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, async () => {
        await loadStep(w.ctx, w.lanes);
        const [row] = ours(w.mac);
        w.mac.endSession(row.id, 'idle', 'nothing arrived for 900 s');
        await until(() => w.ctx.sessions.openOn('mac') === null);
        return loadStep(w.ctx, w.lanes);
      }),
      (err) => err.code === 'session_closed' && /idle/.test(err.message),
    );
    assert.strictEqual(sessionAsks(w.mac), 1, 'nothing reopened a session to carry on');
    assert.strictEqual(submitsTo(w.mac), 1, 'the call after the end was never sent');
  } finally {
    await w.close();
  }
});

check('a cloud call inside a job touches the job\'s open session while it runs (work on this side is not activity on the server\'s)', async () => {
  const w = await world({ touchEveryMs: 20 });
  try {
    await w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, async () => {
      await loadStep(w.ctx, w.lanes);
      await w.lanes.aiCall(routeOfModelId('claude-cli:sonnet'), 'a claude -p field', () => new Promise((resolve) => setTimeout(resolve, 120)));
    });
    const [row] = ours(w.mac);
    assert.ok(row.touches >= 3, `touched at the start and every 20 ms (${row.touches})`);
    const after = row.touches;
    await new Promise((resolve) => setTimeout(resolve, 80));
    assert.strictEqual(row.touches, after, 'no touch once the cloud call ended');
  } finally {
    await w.close();
  }
});

check('a Stop while the job waits in the server\'s line takes it out of the line, and nothing runs', async () => {
  const w = await world();
  try {
    w.mac.holdAsOther('bookforge/1.0', 'translate');
    const outcome = w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    await until(() => w.pushed.inLine.length > 0);
    await w.lanes.stopJob('j1', 'Stopped by the user');
    await assert.rejects(outcome);
    const [row] = ours(w.mac);
    await until(() => row.status === 'closed');
    assert.strictEqual(row.reason, 'client', 'it left the line');
    assert.strictEqual(submitsTo(w.mac), 0);
    assert.deepStrictEqual(w.lanes.running(), []);
  } finally {
    await w.close();
  }
});

check('a fast-pinned item goes to the PC and waits in the PC\'s line, never going to the idle Mac', async () => {
  const w = await world();
  try {
    const holder = w.pc.holdAsOther('owen-tts/1.0', 'tts');
    const outcome = w.lanes.runJob({ jobId: 'fast1', fast: true, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    await until(() => w.pushed.inLine.length > 0);
    assert.strictEqual(w.pushed.inLine[0].server, 'pc');
    assert.strictEqual(submitsTo(w.mac) + sessionAsks(w.mac), 0, 'the Mac was never asked, though it sat idle');
    w.pc.endSession(holder, 'client');
    const done = await outcome;
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

check('an unpinned item stays on the selected server, in its line, even when another server is idle (LEDGER #205)', async () => {
  const w = await world();
  try {
    const holder = w.mac.holdAsOther('bookforge/1.0', 'translate');
    const outcome = w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    await until(() => w.pushed.inLine.length > 0);
    assert.strictEqual(submitsTo(w.pc) + sessionAsks(w.pc), 0, 'the idle PC was never handed the work');
    w.mac.endSession(holder, 'client');
    assert.strictEqual((await outcome).server, 'mac');
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
    await until(() => seen.length === 2, 2_000);
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

check('a standalone GPU call runs on the selected server in a session of its own (closed after), and on a paused one it is refused by name', async () => {
  const w = await world();
  try {
    const answer = await loadStep(w.ctx, w.lanes);
    assert.strictEqual(answer.server, 'mac');
    const [row] = ours(w.mac);
    assert.deepStrictEqual([row.status, row.reason], ['closed', 'client']);
    w.ctx.servers.setPaused('mac', true);
    await assert.rejects(loadStep(w.ctx, w.lanes), (err) => err.code === 'server_paused' && /paused/.test(err.message));
  } finally {
    await w.close();
  }
});

check('a Stop on a parked row forgets its park, so it neither starts later nor counts on the chip', async () => {
  const w = await world();
  try {
    w.ctx.servers.setPaused('mac', true);
    await w.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx, w.lanes));
    assert.strictEqual(w.lanes.view().lanes.find((lane) => lane.server === 'mac').parked, 1);
    await w.lanes.stopJob('j1', 'Removed from the queue');
    assert.strictEqual(w.lanes.parkOf('j1'), null);
    assert.strictEqual(w.lanes.view().lanes.find((lane) => lane.server === 'mac').parked, 0);
  } finally {
    await w.close();
  }
});

check('the stall clock ends a silent job: the fetch is aborted, its session closed, and the row says why', async () => {
  const w = await world({ stallMs: 150 });
  try {
    let aborted = null;
    await assert.rejects(
      w.lanes.runJob({ jobId: 'quiet', fast: false, stage: 'chapters' }, async (runInfo) => {
        await w.lanes.aiCall(gpuCall(MODEL), 'open the job session', async () => {
          await crucibleStepHooks().session({ act: 'generate', what: 'the quiet job' });
        });
        // Then nothing: no event, no completed call, no progress line.
        await new Promise((resolve) => runInfo.controller.signal.addEventListener('abort', () => { aborted = runInfo.controller.signal.reason; resolve(); }));
        throw new Error('the generator saw its signal abort');
      }),
      (err) => err instanceof CrucibleJobStalled && /heard nothing/.test(err.message),
    );
    assert.ok(aborted instanceof CrucibleJobStalled, 'the open fetch was aborted with the stall');
    const [row] = ours(w.mac);
    assert.deepStrictEqual([row.status, row.reason], ['closed', 'client'], 'the job\'s session was closed');
    assert.deepStrictEqual(w.ctx.ledger.read(), []);
  } finally {
    await w.close();
  }
});

run('crucible: lanes, the job\'s queue session and the fast pin');
