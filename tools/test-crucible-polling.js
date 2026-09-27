/**
 * NO PERIODIC CONTACT WITH CRUCIBLE UNLESS WORK IS QUEUED (LEDGER #234), and the queue's
 * "waiting its turn" facts, against tools/fake-crucible.js.
 *
 * Owen, 2026-09-26: "i dont think we need it polling crucible unless its waiting", then "it wont
 * poll unless something is in the queue. if nothing is in the queue, it doesnt poll. if there are
 * items in the queue, it polls". readiness.ts `needsPolling` is the one rule; these checks hold
 * the app's own wiring (context.ts) to it:
 *
 *   idle        one check at start, then no request at all however long it sits
 *   queued      a window's count above zero turns both timers on; zero turns them off
 *   parked      a job parked behind another app's work polls on the interval until it
 *               starts, then everything stops
 *   admitted    right before a job is admitted, an answer older than a few seconds is
 *               checked again (one probe), and a fresh one is not
 *   asked       the renderer's refresh (the Servers pane, Re-check) is one probe
 *
 * The intervals are shortened to tens of milliseconds; the fake counts every request.
 * Also the card holder the queue's waiting row shows: who, what, how far, and the time left
 * measured between reads, following a new holder when another app gets the card first.
 */
const { assert, crucible, fake, context, until, check, run } = require('./_crucible-keeper');

const { gpuCall, crucibleStepHooks } = crucible('lanes');
const { needsPolling } = crucible('readiness');
const { holderOf, trackHolder, timeLeft } = crucible('card-holder');

const MODEL = 'qwen3.5-9b';
const TICK_MS = 40;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** One fake server registered as `mac`, the app's loops wired with short intervals. */
async function world() {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.34', resident: MODEL });
  const made = context({ lanes: { preflightEveryMs: TICK_MS } });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  made.ctx.readiness.refreshMs = { notReady: TICK_MS, ready: TICK_MS };
  const counts = () => ({ pings: server.requestsTo('/v1/ping').length, reads: server.requestsTo('/v1/activity').length });
  const close = async () => {
    made.ctx.stop();
    await server.close();
  };
  return { ...made, server, counts, close };
}

/** The step transport.ts is: submit on the hooks' server, record the job at once, settle it. */
function loadStep(ctx) {
  return ctx.lanes.aiCall(gpuCall(MODEL), 'a keeper load', async () => {
    const hooks = crucibleStepHooks();
    const client = await ctx.factory.clientFor(hooks.server);
    const id = await client.loadModel(MODEL);
    hooks.submitted({ server: hooks.server, id, jobType: 'load-model', model: MODEL });
    hooks.settled(hooks.server, 'job', id);
    return id;
  });
}

async function started(w) {
  w.ctx.start();
  await until(() => w.ctx.readiness.current().state === 'ready');
  // Let the first derivation's own finally run.
  await sleep(10);
}

check('the rule: polls while anything is queued, lanes hold work, or a start/install runs; otherwise never', () => {
  const at = (queued, laneWork, bringingUp) => needsPolling({ queued, laneWork, bringingUp });
  assert.deepStrictEqual(
    [at(0, 0, false), at(1, 0, false), at(0, 1, false), at(0, 0, true), at(3, 2, true)],
    [false, true, true, true, true],
  );
});

check('idle: one check at start, then not one request to Crucible while nothing is queued', async () => {
  const w = await world();
  try {
    await started(w);
    const first = w.counts();
    assert.ok(first.pings >= 1, 'the start answer was a real probe');
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.preflightRunning()], [false, false]);
    await sleep(TICK_MS * 10);
    assert.deepStrictEqual(w.counts(), first, 'ten intervals idle: no probe, no activity read');
    assert.strictEqual(w.ctx.readiness.current().polling, false, 'the banner is told it is not live');
  } finally {
    await w.close();
  }
});

check('a window\'s queue count turns both timers on, and back off at zero; one window\'s zero never cancels another\'s count', async () => {
  const w = await world();
  try {
    await started(w);
    // The probe's clock runs 200 times fast, so each 40 ms tick is past the few seconds a
    // derivation's probe may be reused for, as the real 10-30 s ticks are.
    w.ctx.probes.now = () => Date.now() * 200;
    w.ctx.readiness.setQueued('window-1', 2);
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.preflightRunning()], [true, true]);
    const on = w.counts();
    await until(() => w.counts().reads >= on.reads + 3 && w.counts().pings >= on.pings + 2);
    w.ctx.readiness.setQueued('window-2', 0);
    assert.strictEqual(w.ctx.readiness.isPolling(), true, 'the editor window\'s empty queue does not stop the main window\'s');
    w.ctx.readiness.setQueued('window-1', 0);
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.preflightRunning()], [false, false]);
    await sleep(TICK_MS * 2);
    const off = w.counts();
    await sleep(TICK_MS * 8);
    assert.deepStrictEqual(w.counts(), off, 'queue empty: nothing more');
  } finally {
    await w.close();
  }
});

check('a job parked behind another app polls on the interval, shows the holder with its time left, then everything stops once it has run', async () => {
  const w = await world();
  try {
    w.server.inject({ serverBusy: { client: 'crucible-cli/1.0.43', type: 'rvc', progress: 0.4, jobId: 'job-a' } });
    await started(w);
    const parked = await w.ctx.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx));
    assert.deepStrictEqual([parked.kind, parked.result.code], ['parked', 'server_busy']);
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.preflightRunning()], [true, true], 'a parked job keeps it polling');
    const before = w.counts();
    await until(() => w.counts().reads >= before.reads + 3);
    const chip = () => w.ctx.lanes.view().lanes[0];
    await until(() => chip().holder !== null && chip().holder.id === 'job-a');
    assert.deepStrictEqual(
      [chip().holder.kind, chip().holder.client, chip().holder.what, chip().holder.progress],
      ['job', 'crucible-cli/1.0.43', 'rvc', 0.4],
    );
    assert.strictEqual(chip().holder.leftUnknown, 'measuring', 'the progress has not moved between reads: no number yet');
    // The holder finishes; the next read clears the park and the plan starts the job.
    w.server.inject({});
    await until(async () => (await w.ctx.lanes.plan([{ jobId: 'j1', fast: false }])).start.length === 1);
    const done = await w.ctx.lanes.runJob({ jobId: 'j1', fast: false, stage: parked.result.stage }, () => loadStep(w.ctx));
    assert.strictEqual(done.kind, 'done');
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.preflightRunning()], [false, false], 'nothing left waiting: no timer');
    await sleep(TICK_MS * 2);
    const after = w.counts();
    await sleep(TICK_MS * 8);
    assert.deepStrictEqual(w.counts(), after, 'after the job: not one more request');
  } finally {
    await w.close();
  }
});

check('right before admission an old answer is checked again (one probe); a fresh one is not', async () => {
  const w = await world();
  try {
    await started(w);
    // Ten seconds pass with nothing queued: the answer and the probe cache are both old.
    const shift = 10_000;
    w.ctx.readiness.now = () => Date.now() + shift;
    w.ctx.probes.now = () => Date.now() + shift;
    const before = w.counts();
    const pushedBefore = w.pushed.readiness.length;
    const first = await w.ctx.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, async () => 'ran');
    assert.strictEqual(first.kind, 'done');
    assert.strictEqual(w.counts().pings, before.pings + 1, 'one probe: readiness\'s, which the venue reused');
    assert.ok(w.pushed.readiness.length > pushedBefore, 'the fresh answer reached the banner');
    const second = await w.ctx.lanes.runJob({ jobId: 'j2', fast: false, stage: 'transcribe' }, async () => 'ran');
    assert.strictEqual(second.kind, 'done');
    assert.strictEqual(w.counts().pings, before.pings + 1, 'a second admission a moment later: no probe');
  } finally {
    await w.close();
  }
});

check('the renderer asking (the Servers pane opening, Re-check) is one probe, with the banner and the row sharing it', async () => {
  const w = await world();
  try {
    await started(w);
    const shift = 60_000;
    w.ctx.readiness.now = () => Date.now() + shift;
    w.ctx.probes.now = () => Date.now() + shift;
    const before = w.counts();
    const [view] = await Promise.all([w.ctx.readiness.refresh(), w.ctx.probes.reach('mac')]);
    assert.strictEqual(w.counts().pings, before.pings + 1);
    assert.deepStrictEqual([view.state, view.polling], ['ready', false]);
    assert.strictEqual(w.pushed.readiness.at(-1).at, view.at, 'the banner got the new time though nothing else changed');
    await sleep(TICK_MS * 5);
    assert.strictEqual(w.counts().pings, before.pings + 1, 'and nothing after it');
  } finally {
    await w.close();
  }
});

// ── the holder the waiting row shows ─────────────────────────────────────────

/** A `/v1/activity` read, as the SDK hands it, with only what holderOf reads. */
function activity({ running = [], lease = null, claim = null, streaming = null, acceptsWork = true, resident = MODEL } = {}) {
  return {
    running,
    lease,
    claim,
    streaming,
    resident: resident === null ? null : { id: resident },
    slots: { accelerated: { acceptsWork } },
  };
}
const job = (jobId, client, type, progress) => ({ jobId, client, type, model: null, progress });

check('the holder: another app\'s job, a lease, a live session, a card taking nothing; ContentStudio\'s own work is no holder', () => {
  const none = new Set();
  assert.deepStrictEqual(holderOf(activity({ running: [job('a', 'crucible-cli/1.0.43', 'rvc', 0.43)], acceptsWork: false }), none),
    { kind: 'job', client: 'crucible-cli/1.0.43', what: 'rvc', model: null, id: 'a', progress: 0.43 });
  assert.strictEqual(holderOf(activity({ running: [job('ours', 'contentstudio/1.1.0', 'asr', 0.5)], acceptsWork: false }), none), null, 'our own job is the running row');
  assert.strictEqual(holderOf(activity({ running: [job('x', null, 'asr', 0.5)], acceptsWork: false }), new Set(['x'])), null, 'a job the ledger holds is ours');
  assert.deepStrictEqual(holderOf(activity({ lease: { leaseId: 'L1', client: 'foundry', act: 'translate', kind: 'llm', since: null, expiresAt: null } }), none),
    { kind: 'lease', client: 'foundry', what: 'translate', model: MODEL, id: 'L1', progress: null });
  assert.strictEqual(holderOf(activity({ lease: { leaseId: 'L1', client: 'foundry', act: 'translate', kind: 'llm', since: null, expiresAt: null } }), new Set(['L1'])), null);
  assert.strictEqual(holderOf(activity({ claim: { heldBy: 'bookforge' }, streaming: { sessionId: 's1', client: 'bookforge/2.0' } }), none).kind, 'claim');
  assert.strictEqual(holderOf(activity({ acceptsWork: false }), none).kind, 'card');
  assert.strictEqual(holderOf(activity({}), none), null, 'a free card');
});

check('time left is measured between reads of the same hold, never guessed; a new holder starts a new measurement', () => {
  const h = (id, progress) => ({ kind: 'job', client: 'crucible-cli/1.0.43', what: 'rvc', model: null, id, progress });
  let t = trackHolder(null, h('a', 0.2), 1_000_000);
  assert.deepStrictEqual([t.holder.secondsLeft, t.holder.leftUnknown], [null, 'measuring'], 'one reading: no number');
  t = trackHolder(t.track, h('a', 0.2), 1_015_000);
  assert.deepStrictEqual([t.holder.secondsLeft, t.holder.leftUnknown], [null, 'measuring'], 'no movement yet: no number');
  t = trackHolder(t.track, h('a', 0.4), 1_060_000);
  // 0.2 in 60 s from the first reading: 0.6 left is 180 s.
  assert.deepStrictEqual([t.holder.secondsLeft, t.holder.leftUnknown], [180, null]);
  // Another app took the card first: the row follows the new job, measured from scratch.
  t = trackHolder(t.track, h('b', 0.1), 1_075_000);
  assert.deepStrictEqual([t.holder.id, t.holder.secondsLeft, t.holder.leftUnknown], ['b', null, 'measuring']);
  t = trackHolder(t.track, h('b', 0.3), 1_095_000);
  assert.deepStrictEqual([t.holder.id, t.holder.secondsLeft], ['b', 70]);
  // A lease has no progress: time left is unknown, said as such.
  const lease = trackHolder(null, { kind: 'lease', client: 'foundry', what: 'translate', model: MODEL, id: 'L1', progress: null }, 1);
  assert.deepStrictEqual([lease.holder.secondsLeft, lease.holder.leftUnknown], [null, 'no-progress']);
  assert.deepStrictEqual(trackHolder(t.track, null, 2), { track: null, holder: null }, 'the card came free');
  assert.deepStrictEqual(timeLeft({ key: 'k', firstAt: 0, firstProgress: 0.5, lastAt: 10, lastProgress: 0.4 }), { secondsLeft: null, leftUnknown: 'measuring' });
});

check('through the lanes: the chip follows the holder\'s progress and swaps to a new holder when another app gets the card first', async () => {
  const w = await world();
  try {
    const clock = { t: 5_000_000 };
    // A lanes clock the keeper drives: a context whose preflight never fires on its own.
    const made = context({ lanes: { now: () => clock.t, preflightEveryMs: 3_600_000 } });
    made.ctx.servers.add({ name: 'mac', url: w.server.url, token: w.server.token });
    const chip = () => made.ctx.lanes.view().lanes[0];
    w.server.inject({ serverBusy: { client: 'crucible-cli/1.0.43', type: 'rvc', progress: 0.2, jobId: 'job-a' } });
    await made.ctx.lanes.readAll();
    clock.t += 60_000;
    w.server.inject({ serverBusy: { client: 'crucible-cli/1.0.43', type: 'rvc', progress: 0.4, jobId: 'job-a' } });
    await made.ctx.lanes.readAll();
    assert.deepStrictEqual([chip().holder.id, chip().holder.progress, chip().holder.secondsLeft], ['job-a', 0.4, 180]);
    // job-a ends and foundry's tts gets the card before ContentStudio does.
    clock.t += 15_000;
    w.server.inject({ serverBusy: { client: 'foundry', type: 'tts', progress: 0.05, jobId: 'job-b' } });
    await made.ctx.lanes.readAll();
    assert.deepStrictEqual([chip().holder.id, chip().holder.client, chip().holder.leftUnknown], ['job-b', 'foundry', 'measuring']);
    w.server.inject({});
    clock.t += 15_000;
    await made.ctx.lanes.readAll();
    assert.strictEqual(chip().holder, null, 'the card is free: no holder, no row');
    made.ctx.stop();
  } finally {
    await w.close();
  }
});

run('crucible: polling only while work is queued (LEDGER #234)');
