/**
 * THE IN-FLIGHT LEDGER AND ITS SWEEPS (plan section 13.4): written the moment
 * the server admits a job or a lease, read back by the startup sweep that GPU
 * admission waits for, by the quit sweep under its deadline, by a dropped
 * stream's per-server sweep; and never touching a card another client is on.
 */
const fs = require('fs');
const http = require('http');
const { assert, crucible, fake, context, tempDir, check, run } = require('./_crucible-keeper');

const { InFlightLedger } = crucible('in-flight-ledger');
const { sweepCrucibleInFlight } = crucible('in-flight-sweep');
const { gpuCall, crucibleStepHooks } = crucible('lanes');

const MODEL = 'qwen3.5-9b';

async function oneServer(options = {}) {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.34', resident: MODEL, ...options });
  const made = context(options.dir === undefined ? {} : { dir: options.dir });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  return { server, ...made };
}

check('the ledger row is on disk the moment the server admits the job: before the step\'s next await', async () => {
  const { server, ctx } = await oneServer();
  try {
    let onDiskAtOnce = null;
    await ctx.lanes.aiCall(gpuCall(MODEL), 'a keeper load', async () => {
      const hooks = crucibleStepHooks();
      const client = await ctx.factory.clientFor(hooks.server);
      const id = await client.loadModel(MODEL);
      hooks.submitted({ server: hooks.server, id, jobType: 'load-model', model: MODEL });
      // Synchronously, with no await between: a kill here must still find the row.
      onDiskAtOnce = JSON.parse(fs.readFileSync(ctx.ledger.file, 'utf8')).rows;
    });
    assert.deepStrictEqual(onDiskAtOnce.map((row) => [row.server, row.kind, row.id, row.jobType, row.model]), [['mac', 'job', 'job-1', 'load-model', MODEL]]);
    assert.ok(Date.parse(onDiskAtOnce[0].at) > 0);
  } finally {
    ctx.lanes.stop();
    await server.close();
  }
});

check('a killed run\'s lease is released by the next start\'s sweep, and GPU admission waits for that sweep', async () => {
  const dir = tempDir();
  const { server, ctx } = await oneServer({ dir });
  try {
    // The killed run: it leased the resident model and recorded it, then nothing (kill -9).
    const client = await ctx.factory.clientFor('mac');
    const lease = await client.lease(MODEL, { act: 'generate', ttlSeconds: 120 });
    ctx.ledger.record({ server: 'mac', kind: 'lease', id: lease.leaseId, jobType: 'lease', model: MODEL, jobId: 'job-killed' });

    // The relaunch: a fresh context over the same userData.
    const relaunch = context({ dir }).ctx;
    const order = [];
    const originalRelease = relaunch.factory.clientFor.bind(relaunch.factory);
    relaunch.factory.clientFor = async (name, opts) => {
      const c = await originalRelease(name, opts);
      const release = c.release.bind(c);
      c.release = async (id) => { order.push(`release ${id}`); return release(id); };
      return c;
    };
    const swept = relaunch.sweepAtStartup();
    const admitted = relaunch.lanes.runJob({ jobId: 'job-new', fast: false, stage: 'transcribe' }, async () => { order.push('job-new ran'); });
    const report = await swept;
    const outcome = await admitted;
    assert.strictEqual(outcome.kind, 'done');
    assert.deepStrictEqual(order, [`release ${lease.leaseId}`, 'job-new ran'], 'the sweep finished before the job was admitted');
    assert.deepStrictEqual(report.rows.map((row) => row.outcome), ['released']);
    assert.strictEqual(server.openLease(), null);
    assert.deepStrictEqual(relaunch.ledger.read(), []);
    relaunch.lanes.stop();
  } finally {
    ctx.lanes.stop();
    await server.close();
  }
});

check('the startup sweep gates admission even when it is slow: nothing is admitted until it settles', async () => {
  const { server, ctx } = await oneServer();
  try {
    let open;
    ctx.lanes.setAdmissionGate(new Promise((resolve) => { open = resolve; }));
    let ran = false;
    const job = ctx.lanes.runJob({ jobId: 'j', fast: false, stage: 'transcribe' }, async () => { ran = true; });
    const plan = ctx.lanes.plan([{ jobId: 'k', fast: false }]);
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.strictEqual(ran, false, 'not admitted while the sweep runs');
    open();
    await job;
    assert.strictEqual(ran, true);
    assert.deepStrictEqual((await plan).waiting.length + (await plan).start.length, 1);
  } finally {
    ctx.lanes.stop();
    await server.close();
  }
});

check('another client\'s lease is never unloaded: our job row names the resident model, and the card stays', async () => {
  const { server, ctx } = await oneServer();
  try {
    server.leaseAsOther(MODEL, 'foundry');
    ctx.ledger.record({ server: 'mac', kind: 'job', id: 'job-gone', jobType: 'load-model', model: MODEL, jobId: 'j' });
    const report = await sweepCrucibleInFlight({ ledger: ctx.ledger, clientFor: (name) => ctx.factory.clientFor(name) }, { reason: 'keeper', deadlineMs: 5_000 });
    assert.strictEqual(server.requestsTo('/v1/jobs', 'POST').filter((r) => r.body && r.body.type === 'unload-model').length, 0, 'no unload was asked for');
    assert.deepStrictEqual(report.servers.map((s) => s.unloaded), [null]);
    assert.match(report.servers[0].note, /lease held by foundry/);
    assert.strictEqual(server.resident(), MODEL);
    assert.notStrictEqual(server.openLease(), null, 'foundry\'s lease is untouched');
  } finally {
    ctx.lanes.stop();
    await server.close();
  }
});

check('a card ContentStudio alone loaded, with nothing else on it, IS unloaded by the sweep', async () => {
  const { server, ctx } = await oneServer();
  try {
    ctx.ledger.record({ server: 'mac', kind: 'job', id: 'job-gone', jobType: 'load-model', model: MODEL, jobId: 'j' });
    const report = await sweepCrucibleInFlight({ ledger: ctx.ledger, clientFor: (name) => ctx.factory.clientFor(name) }, { reason: 'keeper', deadlineMs: 5_000 });
    assert.deepStrictEqual(report.servers.map((s) => s.unloaded), [MODEL]);
  } finally {
    ctx.lanes.stop();
    await server.close();
  }
});

check('the quit deadline holds against a server that never answers, and its rows stay for the next start', async () => {
  // Something that accepts the connection and then says nothing, ever.
  const sockets = new Set();
  const mute = http.createServer(() => {});
  mute.on('connection', (socket) => { sockets.add(socket); });
  await new Promise((resolve) => mute.listen(0, '127.0.0.1', resolve));
  const { ctx } = context();
  try {
    ctx.servers.add({ name: 'asleep', url: `http://127.0.0.1:${mute.address().port}`, token: 'a-token-that-does-not-matter-1234' });
    ctx.ledger.record({ server: 'asleep', kind: 'lease', id: 'lease-9', jobType: 'lease', model: MODEL, jobId: 'j' });
    const started = Date.now();
    const report = await ctx.lanes.quit((deadlineMs) => sweepCrucibleInFlight(
      { ledger: ctx.ledger, clientFor: (name) => ctx.factory.clientFor(name) },
      { reason: 'quit', deadlineMs },
    ), 600, 100);
    const took = Date.now() - started;
    assert.ok(took < 1_500, `quit took ${took} ms against a 600 ms deadline`);
    assert.strictEqual(report.timedOut, true);
    assert.deepStrictEqual(ctx.ledger.read().map((row) => row.id), ['lease-9'], 'the unanswered row is kept for the next start');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => mute.close(resolve));
  }
});

check('quit aborts the running job, waits for it to release its own lease, then sweeps what is left', async () => {
  const { server, ctx } = await oneServer();
  try {
    let leaseId = null;
    const running = ctx.lanes.runJob({ jobId: 'running', fast: false, stage: 'fields' }, async (runInfo) => {
      await ctx.lanes.aiCall(gpuCall(MODEL), 'the job lease', async () => {
        const hooks = crucibleStepHooks();
        const client = await ctx.factory.clientFor(hooks.server);
        const lease = await client.lease(MODEL, { act: 'generate', ttlSeconds: 120 });
        leaseId = lease.leaseId;
        hooks.leased({ server: hooks.server, id: lease.leaseId, model: MODEL });
      });
      await new Promise((resolve) => runInfo.controller.signal.addEventListener('abort', resolve));
      // transport.ts's finally: release its own lease.
      const client = await ctx.factory.clientFor('mac');
      await client.release(leaseId);
      ctx.ledger.settle('mac', 'lease', leaseId);
      return 'released itself';
    });
    while (leaseId === null) await new Promise((resolve) => setTimeout(resolve, 5));
    const report = await ctx.lanes.quit((deadlineMs) => sweepCrucibleInFlight(
      { ledger: ctx.ledger, clientFor: (name) => ctx.factory.clientFor(name) }, { reason: 'quit', deadlineMs },
    ), 5_000, 2_000);
    assert.strictEqual((await running).value, 'released itself');
    assert.deepStrictEqual(server.leases.released, [leaseId], 'released once, by the run itself');
    assert.deepStrictEqual(report.rows, [], 'nothing was left for the sweep');
    await assert.rejects(ctx.lanes.runJob({ jobId: 'after', fast: false, stage: 'fields' }, async () => 1), /quitting/);
  } finally {
    await server.close();
  }
});

check('a dropped stream sweeps that server only', async () => {
  const { server, ctx } = await oneServer();
  const other = await fake.startFakeCrucible({ name: 'crucible@pc', version: '1.0.34', resident: MODEL });
  try {
    ctx.servers.add({ name: 'pc', url: other.url, token: other.token });
    const macLease = await (await ctx.factory.clientFor('mac')).lease(MODEL, { act: 'generate', ttlSeconds: 120 });
    const pcLease = await (await ctx.factory.clientFor('pc')).lease(MODEL, { act: 'generate', ttlSeconds: 120 });
    ctx.ledger.record({ server: 'mac', kind: 'lease', id: macLease.leaseId, jobType: 'lease', model: MODEL, jobId: 'a' });
    ctx.ledger.record({ server: 'pc', kind: 'lease', id: pcLease.leaseId, jobType: 'lease', model: MODEL, jobId: 'b' });
    await ctx.lanes.aiCall(gpuCall(MODEL), 'an asr stream', async () => {
      const hooks = crucibleStepHooks();
      await hooks.streamDropped('mac', 'the SSE socket closed with no terminal event');
    });
    assert.deepStrictEqual(ctx.ledger.read().map((row) => row.server), ['pc']);
    assert.strictEqual(server.openLease(), null);
    assert.notStrictEqual(other.openLease(), null);
  } finally {
    ctx.lanes.stop();
    await server.close();
    await other.close();
  }
});

check('a ledger that does not parse is read as empty, loudly', () => {
  const dir = tempDir();
  const warned = [];
  const ledger = InFlightLedger.inDir(dir, (line) => warned.push(line));
  fs.writeFileSync(ledger.file, '{ not json');
  assert.deepStrictEqual(ledger.read(), []);
  assert.match(warned[0], /does not parse/);
});

run('crucible: the in-flight ledger and its sweeps');
