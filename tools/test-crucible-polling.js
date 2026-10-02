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
 *   queued      a window's count above zero turns readiness's timer on and the lanes' event
 *               streams (`GET /v1/events`, Crucible 1.0.76, LEDGER #255) open; zero turns both off
 *   in line     a job whose queue session waits behind another app's session keeps the stream
 *               followed, the chip shows the holder from the stream's own events (no activity
 *               polling), then everything stops once the job has run
 *   admitted    right before a job is admitted, an answer older than a few seconds is
 *               checked again (one probe), and a fresh one is not
 *   asked       the renderer's refresh (the Servers pane, Re-check) is one probe
 *
 * The intervals are shortened to tens of milliseconds; the fake counts every request. A server
 * that does not list the `events` feature is said on its chip by name and never polled instead.
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
async function world(options = {}) {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.76', resident: MODEL, ...options });
  const made = context({ lanes: { watchRetryMs: TICK_MS } });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  made.ctx.readiness.refreshMs = { notReady: TICK_MS, ready: TICK_MS };
  const counts = () => ({ pings: server.requestsTo('/v1/ping').length, reads: server.requestsTo('/v1/activity').length, streams: server.requestsTo('/v1/events').length });
  const close = async () => {
    made.ctx.stop();
    await server.close();
  };
  return { ...made, server, counts, close };
}

/** The step transport.ts is: the step's session, a submit in it, the job recorded at once and settled. */
function loadStep(ctx) {
  return ctx.lanes.aiCall(gpuCall(MODEL), 'a keeper load', async () => {
    const hooks = crucibleStepHooks();
    const hold = await hooks.session({ act: 'generate', what: 'a keeper load' });
    try {
      const id = await hold.card.session.loadModel(MODEL);
      hooks.submitted({ server: hooks.server, id, jobType: 'load-model', model: MODEL });
      hooks.settled(hooks.server, 'job', id);
      return id;
    } finally {
      await hold.release();
    }
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
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.watchRunning()], [false, false]);
    await sleep(TICK_MS * 10);
    assert.deepStrictEqual(w.counts(), first, 'ten intervals idle: no probe, no activity read, no stream');
    assert.strictEqual(first.streams, 0);
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
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.watchRunning()], [true, true]);
    const on = w.counts();
    await until(() => w.counts().streams === 1 && w.counts().pings >= on.pings + 2);
    w.ctx.readiness.setQueued('window-2', 0);
    assert.strictEqual(w.ctx.readiness.isPolling(), true, 'the editor window\'s empty queue does not stop the main window\'s');
    w.ctx.readiness.setQueued('window-1', 0);
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.watchRunning()], [false, false]);
    await sleep(TICK_MS * 2);
    const off = w.counts();
    await sleep(TICK_MS * 8);
    assert.deepStrictEqual(w.counts(), off, 'queue empty: nothing more');
  } finally {
    await w.close();
  }
});

check('a job waiting in the server\'s line keeps the stream followed, the chip shows the holder from its events (no activity polling), then everything stops once it has run', async () => {
  const w = await world();
  try {
    const holder = w.server.holdAsOther('crucible-cli/1.0.43', 'rvc');
    await started(w);
    const job = w.ctx.lanes.runJob({ jobId: 'j1', fast: false, stage: 'transcribe' }, () => loadStep(w.ctx));
    await until(() => w.pushed.inLine.length > 0);
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.watchRunning()], [true, true], 'a job in line keeps it followed');
    const chip = () => w.ctx.lanes.view().lanes[0];
    await until(() => chip().holder !== null);
    assert.deepStrictEqual([chip().holder.kind, chip().holder.client, chip().holder.what, chip().holder.leftUnknown], ['session', 'crucible-cli/1.0.43', 'rvc', 'no-progress']);
    assert.deepStrictEqual(chip().inLine, { jobId: 'j1', position: 1, of: 1 });
    const reads = w.counts().reads;
    // The holder closes: the stream says so, the job's session opens and the job runs.
    w.server.endSession(holder, 'client');
    const done = await job;
    assert.strictEqual(done.kind, 'done');
    await until(() => chip().holder === null);
    assert.strictEqual(w.counts().reads - reads <= 1, true, 'the strip followed the stream, not /v1/activity (one read at most: readiness\'s probe before admission)');
    assert.deepStrictEqual([w.ctx.readiness.isPolling(), w.ctx.lanes.watchRunning()], [false, false], 'nothing left waiting: no timer, no stream');
    await sleep(TICK_MS * 2);
    const after = w.counts();
    await sleep(TICK_MS * 8);
    assert.deepStrictEqual(w.counts(), after, 'after the job: not one more request');
  } finally {
    await w.close();
  }
});

check('a server that does not offer the event stream is said by name on its chip, and never polled in its place', async () => {
  const w = await world({ features: ['queue.jobs', 'queue.calls', 'queue.sessions'] });
  try {
    await started(w);
    w.ctx.readiness.setQueued('window-1', 1);
    const chip = () => w.ctx.lanes.view().lanes[0];
    await until(() => chip().state === 'unreachable');
    assert.match(chip().unreadReason, /does not offer the server event stream/);
    const reads = w.counts().reads;
    await sleep(TICK_MS * 6);
    assert.strictEqual(w.counts().streams, 0);
    assert.ok(w.counts().reads - reads <= 6, 'only readiness\'s own probes read activity; the strip does not poll');
    w.ctx.readiness.setQueued('window-1', 0);
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

/** What a server is doing, as the lanes strip reads it off the event stream (card-holder.ts CardView). */
function view({ running = [], session = null, resident = MODEL } = {}) {
  return { running, session, resident };
}
const job = (jobId, client, type, progress) => ({ jobId, client, type, model: null, progress });
const OURS = crucible('client-factory').CRUCIBLE_CLIENT_NAME;

check('the holder: another app\'s job, another app\'s queue session; this install\'s own work is no holder, another install\'s is', () => {
  const none = new Set();
  assert.deepStrictEqual(holderOf(view({ running: [job('a', 'crucible-cli/1.0.43', 'rvc', 0.43)] }), none),
    { kind: 'job', client: 'crucible-cli/1.0.43', what: 'rvc', model: null, id: 'a', progress: 0.43 });
  assert.strictEqual(holderOf(view({ running: [job('ours', OURS, 'asr', 0.5)] }), none), null, 'our own job is the running row');
  assert.strictEqual(holderOf(view({ running: [job('x', null, 'asr', 0.5)] }), new Set(['x'])), null, 'a job the ledger holds is ours');
  assert.deepStrictEqual(holderOf(view({ session: { id: 'ses-1', client: 'foundry', act: 'translate', model: null } }), none),
    { kind: 'session', client: 'foundry', what: 'translate', model: MODEL, id: 'ses-1', progress: null });
  assert.strictEqual(holderOf(view({ session: { id: 'ses-1', client: OURS, act: 'generate', model: null } }), none), null, 'our own session');
  assert.strictEqual(holderOf(view({ session: { id: 'ses-1', client: 'contentstudio@another-host', act: 'generate', model: null } }), none).kind, 'session', 'another install is another app');
  assert.strictEqual(holderOf(view({}), none), null, 'a free server');
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
  // A session between its items has no progress: time left is unknown, said as such.
  const session = trackHolder(null, { kind: 'session', client: 'foundry', what: 'translate', model: MODEL, id: 'ses-1', progress: null }, 1);
  assert.deepStrictEqual([session.holder.secondsLeft, session.holder.leftUnknown], [null, 'no-progress']);
  assert.deepStrictEqual(trackHolder(t.track, null, 2), { track: null, holder: null }, 'the card came free');
  assert.deepStrictEqual(timeLeft({ key: 'k', firstAt: 0, firstProgress: 0.5, lastAt: 10, lastProgress: 0.4 }), { secondsLeft: null, leftUnknown: 'measuring' });
});

check('through the lanes\' reads: the chip follows the holder\'s progress and swaps to a new holder when another app gets the card first', async () => {
  const w = await world();
  try {
    const clock = { t: 5_000_000 };
    // A lanes clock the keeper drives, and one-shot reads (no stream: nothing is queued).
    const made = context({ lanes: { now: () => clock.t } });
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
