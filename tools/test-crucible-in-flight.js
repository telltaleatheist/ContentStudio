/**
 * THE IN-FLIGHT LEDGER AND ITS SWEEPS (plan section 13.4): written the moment
 * the server admits a job or opens a queue session, read back by the startup
 * sweep that GPU admission waits for, by the quit sweep under its deadline, and
 * by a dropped stream's per-server sweep. Since Crucible 1.0.76 (LEDGER #255) a
 * session row is CLOSED (`DELETE /v1/queue/sessions/{id}`), which settles the card on the
 * server, so the sweep never asks for an unload of its own.
 */
const fs = require('fs');
const http = require('http');
const { assert, crucible, fake, context, tempDir, check, run, until } = require('./_crucible-keeper');

const { InFlightLedger } = crucible('in-flight-ledger');
const { sweepCrucibleInFlight } = crucible('in-flight-sweep');
const { gpuCall, crucibleStepHooks } = crucible('lanes');

const MODEL = 'qwen3.5-9b';

async function oneServer(options = {}) {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.76', resident: MODEL, ...options });
  const made = context(options.dir === undefined ? {} : { dir: options.dir });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  return { server, ...made };
}

const sweepOf = (ctx) => (options) => sweepCrucibleInFlight({ ledger: ctx.ledger, clientFor: (name) => ctx.factory.clientFor(name) }, options);

check('the session row and the job row are on disk the moment the server answers: before the step\'s next await', async () => {
  const { server, ctx } = await oneServer();
  try {
    let onDiskAtOnce = null;
    let sessionAtOnce = null;
    await ctx.lanes.aiCall(gpuCall(MODEL), 'a keeper load', async () => {
      const hooks = crucibleStepHooks();
      const hold = await hooks.session({ act: 'generate', what: 'a keeper load' });
      sessionAtOnce = JSON.parse(fs.readFileSync(ctx.ledger.file, 'utf8')).rows;
      try {
        const id = await hold.card.session.loadModel(MODEL);
        hooks.submitted({ server: hooks.server, id, jobType: 'load-model', model: MODEL });
        // Synchronously, with no await between: a kill here must still find the row.
        onDiskAtOnce = JSON.parse(fs.readFileSync(ctx.ledger.file, 'utf8')).rows;
        hooks.settled(hooks.server, 'job', id);
      } finally {
        await hold.release();
      }
    });
    assert.deepStrictEqual(sessionAtOnce.map((row) => [row.server, row.kind, row.id, row.jobType, row.jobId]), [['mac', 'session', 'ses-1', 'session', '']]);
    assert.deepStrictEqual(onDiskAtOnce.map((row) => [row.kind, row.id, row.jobType, row.model]), [['session', 'ses-1', 'session', null], ['job', 'job-1', 'load-model', MODEL]]);
    assert.ok(Date.parse(onDiskAtOnce[0].at) > 0);
    assert.deepStrictEqual(ctx.ledger.read(), [], 'both settled: the job when it ended, the session when it closed');
    assert.strictEqual(server.openSession(), null);
  } finally {
    ctx.lanes.stop();
    await server.close();
  }
});

check('a killed run\'s open session is ended by the next start\'s sweep, and GPU admission waits for that sweep', async () => {
  const dir = tempDir();
  const { server, ctx } = await oneServer({ dir });
  try {
    // The killed run: it opened a session and recorded it, then nothing (kill -9).
    const client = await ctx.factory.clientFor('mac');
    const session = await client.session({ act: 'generate', idleS: 900 });
    ctx.ledger.record({ server: 'mac', kind: 'session', id: session.id, jobType: 'session', model: null, jobId: '' });

    // The relaunch: a fresh context over the same userData.
    const relaunch = context({ dir }).ctx;
    const order = [];
    const original = relaunch.factory.clientFor.bind(relaunch.factory);
    relaunch.factory.clientFor = async (name, opts) => {
      const c = await original(name, opts);
      const close = c.closeSession.bind(c);
      c.closeSession = async (id) => { order.push(`end ${id}`); return close(id); };
      return c;
    };
    const swept = relaunch.sweepAtStartup();
    const admitted = relaunch.lanes.runJob({ jobId: 'job-new', fast: false, stage: 'transcribe' }, async () => { order.push('job-new ran'); });
    const report = await swept;
    const outcome = await admitted;
    assert.strictEqual(outcome.kind, 'done');
    assert.deepStrictEqual(order, [`end ${session.id}`, 'job-new ran'], 'the sweep finished before the job was admitted');
    assert.deepStrictEqual(report.rows.map((row) => row.outcome), ['closed']);
    assert.strictEqual(server.openSession(), null);
    assert.strictEqual(server.sessions[0].reason, 'client', 'closed through DELETE /v1/queue/sessions/{id}');
    assert.deepStrictEqual(relaunch.ledger.read(), []);
    assert.strictEqual(server.requestsTo('/v1/jobs', 'POST').filter((r) => r.body && r.body.type === 'unload-model').length, 0, 'no unload of its own: closing settles the card');
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

check('the sweep touches only what it recorded: another app\'s open session and our gone rows are left alone, and no unload is asked for', async () => {
  const { server, ctx } = await oneServer();
  try {
    server.holdAsOther('foundry/0.9', 'translate');
    ctx.ledger.record({ server: 'mac', kind: 'job', id: 'job-gone', jobType: 'load-model', model: MODEL, jobId: 'j' });
    ctx.ledger.record({ server: 'mac', kind: 'session', id: 'ses-gone', jobType: 'session', model: null, jobId: '' });
    const report = await sweepOf(ctx)({ reason: 'keeper', deadlineMs: 5_000 });
    assert.deepStrictEqual(report.rows.map((row) => [row.entry.id, row.outcome]), [['job-gone', 'gone'], ['ses-gone', 'gone']], 'jobs first, then sessions; both already gone');
    assert.strictEqual(server.requestsTo('/v1/jobs', 'POST').filter((r) => r.body && r.body.type === 'unload-model').length, 0, 'no unload was asked for');
    assert.strictEqual(server.openSession().client, 'foundry/0.9', 'foundry\'s session is untouched');
    assert.strictEqual(server.resident(), MODEL);
    assert.deepStrictEqual(ctx.ledger.read(), []);
  } finally {
    ctx.lanes.stop();
    await server.close();
  }
});

check('a lease row an older ContentStudio left is dropped on reading, said, and nothing is sent for it', async () => {
  const dir = tempDir();
  const warned = [];
  const ledger = InFlightLedger.inDir(dir, (line) => warned.push(line));
  fs.writeFileSync(ledger.file, JSON.stringify({ rows: [
    { server: 'mac', kind: 'lease', id: 'lease-1', jobType: 'lease', model: MODEL, jobId: 'j', lastEventId: null, at: '2026-09-30T00:00:00Z' },
    { server: 'mac', kind: 'job', id: 'job-7', jobType: 'asr', model: 'qwen3-asr-1.7b', jobId: 'j', lastEventId: null, at: '2026-09-30T00:00:00Z' },
  ] }));
  assert.deepStrictEqual(ledger.read().map((row) => row.id), ['job-7']);
  assert.match(warned[0], /lease row from before Crucible 1\.0\.76/);
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
    ctx.ledger.record({ server: 'asleep', kind: 'session', id: 'ses-9', jobType: 'session', model: null, jobId: '' });
    const started = Date.now();
    const report = await ctx.lanes.quit((deadlineMs) => sweepOf(ctx)({ reason: 'quit', deadlineMs }), 600, 100);
    const took = Date.now() - started;
    assert.ok(took < 1_500, `quit took ${took} ms against a 600 ms deadline`);
    assert.strictEqual(report.timedOut, true);
    assert.deepStrictEqual(ctx.ledger.read().map((row) => row.id), ['ses-9'], 'the unanswered row is kept for the next start');
  } finally {
    for (const socket of sockets) socket.destroy();
    await new Promise((resolve) => mute.close(resolve));
  }
});

check('quit aborts the running job, which lets go of its session (closed once), closes a standalone one still held, then sweeps what is left', async () => {
  const { server, ctx } = await oneServer();
  try {
    let opened = false;
    const running = ctx.lanes.runJob({ jobId: 'running', fast: false, stage: 'fields' }, async (runInfo) => {
      await ctx.lanes.aiCall(gpuCall(MODEL), 'the job session', async () => {
        await crucibleStepHooks().session({ act: 'generate', what: 'the running job' });
        opened = true;
      });
      await new Promise((resolve) => runInfo.controller.signal.addEventListener('abort', resolve));
      return 'stopped';
    });
    await until(() => opened);
    // The editor's voice isolation, joined to the same session and never let go of.
    const editor = await ctx.sessions.use('mac', { act: 'denoise', what: 'the editor\'s voice isolation' });
    assert.strictEqual(server.sessions.length, 1, 'joined, not a second session');
    const report = await ctx.lanes.quit((deadlineMs) => sweepOf(ctx)({ reason: 'quit', deadlineMs }), 5_000, 2_000);
    assert.strictEqual((await running).value, 'stopped');
    assert.deepStrictEqual(server.sessions.map((row) => [row.status, row.reason]), [['closed', 'client']], 'closed once, by this install');
    assert.notStrictEqual(editor.card.ended, null, 'the editor\'s hold knows its session ended');
    assert.deepStrictEqual(report.rows, [], 'nothing was left for the sweep');
    await assert.rejects(ctx.lanes.runJob({ jobId: 'after', fast: false, stage: 'fields' }, async () => 1), /quitting/);
  } finally {
    await server.close();
  }
});

check('a dropped stream sweeps that server only', async () => {
  const { server, ctx } = await oneServer();
  const other = await fake.startFakeCrucible({ name: 'crucible@pc', version: '1.0.76', resident: MODEL });
  try {
    ctx.servers.add({ name: 'pc', url: other.url, token: other.token });
    const mac = await (await ctx.factory.clientFor('mac')).session({ act: 'generate' });
    const pc = await (await ctx.factory.clientFor('pc')).session({ act: 'generate' });
    ctx.ledger.record({ server: 'mac', kind: 'session', id: mac.id, jobType: 'session', model: null, jobId: '' });
    ctx.ledger.record({ server: 'pc', kind: 'session', id: pc.id, jobType: 'session', model: null, jobId: '' });
    await ctx.lanes.aiCall(gpuCall(MODEL), 'an asr stream', async () => {
      const hooks = crucibleStepHooks();
      await hooks.streamDropped('mac', 'the SSE socket closed with no terminal event');
    });
    assert.deepStrictEqual(ctx.ledger.read().map((row) => row.server), ['pc']);
    assert.strictEqual(server.openSession(), null);
    assert.notStrictEqual(other.openSession(), null);
    await pc.close();
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
