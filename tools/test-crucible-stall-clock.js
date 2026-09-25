/**
 * THE STALL CLOCK ON FAKE TIMERS (plan section 13.5): ten minutes of SILENCE
 * ends a job; ten minutes of WORK does not. The global timer functions are
 * replaced by a hand-driven clock for these checks, so the real window
 * (CRUCIBLE_STALL_MS, ten minutes) is what is tested, in no time at all.
 */
const { assert, crucible, check, run } = require('./_crucible-keeper');

const { CRUCIBLE_STALL_MS, JobStallClock, withStreamStallClock, CrucibleStreamWentQuiet } = crucible('stream-stall');
const { QUIT_SWEEP_DEADLINE_MS, QUIT_UNWIND_MS } = crucible('in-flight-sweep');
const { PREFLIGHT_EVERY_MS } = crucible('lanes');

/** A clock: setTimeout/clearTimeout that fire only when `advance` passes their instant. */
function fakeTimers() {
  const real = { setTimeout: global.setTimeout, clearTimeout: global.clearTimeout };
  let now = 0;
  let nextId = 1;
  const timers = new Map();
  global.setTimeout = (fn, ms) => {
    const id = nextId++;
    timers.set(id, { at: now + Math.max(0, ms ?? 0), fn });
    return { id, unref() { return this; }, ref() { return this; } };
  };
  global.clearTimeout = (handle) => { if (handle && typeof handle === 'object') timers.delete(handle.id); };
  return {
    now: () => now,
    advance(ms) {
      const until = now + ms;
      for (;;) {
        const due = [...timers.entries()].filter(([, t]) => t.at <= until).sort((a, b) => a[1].at - b[1].at)[0];
        if (due === undefined) break;
        timers.delete(due[0]);
        now = due[1].at;
        due[1].fn();
      }
      now = until;
    },
    restore() { global.setTimeout = real.setTimeout; global.clearTimeout = real.clearTimeout; },
  };
}

const MIN = 60_000;

check('the windows are the plan\'s: 10 min of silence, a 15 s preflight, a 30 s quit with a 2 s unwind', () => {
  assert.strictEqual(CRUCIBLE_STALL_MS, 10 * MIN);
  assert.strictEqual(PREFLIGHT_EVERY_MS, 15_000);
  assert.strictEqual(QUIT_SWEEP_DEADLINE_MS, 30_000);
  assert.strictEqual(QUIT_UNWIND_MS, 2_000);
});

check('a job that keeps working for an hour never stalls: every sign of life resets the clock', () => {
  const clock = fakeTimers();
  try {
    const fired = [];
    const stall = new JobStallClock('job-long', (sentence) => fired.push(sentence), undefined, clock.now);
    stall.start();
    for (let minute = 0; minute < 60; minute += 5) {
      clock.advance(5 * MIN);
      stall.beat();
    }
    assert.deepStrictEqual(fired, [], 'sixty minutes of wall time, a beat every five: no stall');
    stall.stop();
  } finally {
    clock.restore();
  }
});

check('ten minutes of silence fires it, exactly once, at the tenth minute and not before', () => {
  const clock = fakeTimers();
  try {
    const fired = [];
    const stall = new JobStallClock('job-quiet', (sentence) => fired.push({ at: clock.now(), sentence }), undefined, clock.now);
    stall.start();
    clock.advance(3 * MIN);
    stall.beat();
    clock.advance(10 * MIN - 1);
    assert.deepStrictEqual(fired, [], 'one millisecond short of ten silent minutes');
    clock.advance(1);
    assert.strictEqual(fired.length, 1);
    assert.strictEqual(fired[0].at, 13 * MIN);
    assert.match(fired[0].sentence, /job-quiet heard nothing from its server for 10 minutes/);
    stall.beat();
    clock.advance(60 * MIN);
    assert.strictEqual(fired.length, 1, 'never twice, and a late beat does not re-arm it');
    assert.strictEqual(stall.hasFired, true);
  } finally {
    clock.restore();
  }
});

check('a stopped clock never fires', () => {
  const clock = fakeTimers();
  try {
    let fired = false;
    const stall = new JobStallClock('job-done', () => { fired = true; }, undefined, clock.now);
    stall.start();
    stall.stop();
    clock.advance(60 * MIN);
    assert.strictEqual(fired, false);
  } finally {
    clock.restore();
  }
});

check('a stream loop: frames keep it alive past ten minutes; ten silent minutes cancel it and throw crucible_went_quiet', async () => {
  const clock = fakeTimers();
  try {
    let cancels = 0;
    let beat = null;
    let finish = null;
    const loop = withStreamStallClock({
      server: 'mac',
      jobId: 'job-7',
      onStall: () => { cancels += 1; },
      consume: (b) => { beat = b; return new Promise((resolve) => { finish = resolve; }); },
    });
    const outcome = loop.then(() => 'ended', (err) => err);
    for (let i = 0; i < 6; i += 1) {
      clock.advance(4 * MIN);
      beat();
    }
    await Promise.resolve();
    clock.advance(10 * MIN);
    // Let the stall's continuation run, then the grace timers.
    for (let i = 0; i < 5; i += 1) { await Promise.resolve(); clock.advance(20_000); }
    const err = await outcome;
    assert.ok(err instanceof CrucibleStreamWentQuiet, `expected a stall, got ${err}`);
    assert.strictEqual(err.code, 'crucible_went_quiet');
    assert.strictEqual(cancels, 1, 'the job was cancelled, not abandoned');
    finish();
  } finally {
    clock.restore();
  }
});

run('crucible: the stall clock');
