#!/usr/bin/env node
/**
 * Extension 0.3.0, the shelf's Visibility section: the pure half of it
 * (extension/src/scheduler/scheduler-format.ts, transpiled and run as shipped). Covers:
 * runAt from the form's local date + time carries the offset in force on THAT date (summer
 * and winter, west and east of UTC, a half-hour zone), round-trips to the same instant, and
 * matches the server's runAt pattern; a time the clocks skip and a time they repeat are
 * refused, never moved; bad dates/times are refused by name; the edit form's inputs from an
 * ISO; the "ran N min late" threshold (over 2 min only); each state's row text (pending,
 * retrying, done before -> after with lateness and "cancelled YouTube’s own schedule",
 * failed with the server's message, cancelled, a done/failed change with no result said
 * out loud); pending soonest-first and history newest-first; the pending badge; the
 * YouTube-schedule warning shown before saving. Offline: no Chrome, no scheduler.
 *
 *   node tools/visibility-format-checks.js
 */
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

function transpile(rel) {
  const src = path.join(__dirname, '..', rel);
  const out = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: src,
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', out.outputText)(mod.exports, mod, require);
  return mod.exports;
}
const f = transpile('extension/src/scheduler/scheduler-format.ts');

let failures = 0;
function eq(a, e, what) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
function check(name, fn) {
  try {
    fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}
/** Run `fn` with the process in time zone `tz` (Node re-reads TZ when it is assigned). */
function inZone(tz, fn) {
  const before = process.env.TZ;
  process.env.TZ = tz;
  try {
    return fn();
  } finally {
    if (before === undefined) delete process.env.TZ;
    else process.env.TZ = before;
  }
}
/** The server's own runAt pattern (server/visibility-scheduler/src/rules.ts parseRunAt). */
const SERVER_RUN_AT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;

check('the zone switch itself works (or every zone check below is testing one zone)', () => {
  const a = inZone('Europe/London', () => new Date(2026, 6, 1, 12).getTimezoneOffset());
  const b = inZone('America/New_York', () => new Date(2026, 6, 1, 12).getTimezoneOffset());
  eq([a, b], [-60, 240], 'offsets');
});

check('runAt carries the offset in force on that date: London summer +01:00, winter +00:00', () => {
  inZone('Europe/London', () => {
    eq(f.runAtFromLocal('2026-07-01', '10:00'), { ok: true, iso: '2026-07-01T10:00:00+01:00' }, 'summer');
    eq(f.runAtFromLocal('2026-12-01', '10:00'), { ok: true, iso: '2026-12-01T10:00:00+00:00' }, 'winter');
  });
});

check('west, east and half-hour zones: New York -05:00, Tokyo +09:00, Kolkata +05:30, Newfoundland -03:30', () => {
  eq(inZone('America/New_York', () => f.runAtFromLocal('2026-11-02', '09:30')), { ok: true, iso: '2026-11-02T09:30:00-05:00' }, 'NY');
  eq(inZone('Asia/Tokyo', () => f.runAtFromLocal('2026-11-02', '23:59')), { ok: true, iso: '2026-11-02T23:59:00+09:00' }, 'Tokyo');
  eq(inZone('Asia/Kolkata', () => f.runAtFromLocal('2026-01-15', '00:00')), { ok: true, iso: '2026-01-15T00:00:00+05:30' }, 'Kolkata');
  eq(inZone('America/St_Johns', () => f.runAtFromLocal('2026-12-24', '18:45')), { ok: true, iso: '2026-12-24T18:45:00-03:30' }, "St John's");
});

check('the ISO names the instant typed, and the server would accept it', () => {
  const iso = inZone('America/Los_Angeles', () => f.runAtFromLocal('2026-08-10', '14:05')).iso;
  eq(new Date(iso).toISOString(), '2026-08-10T21:05:00.000Z', 'instant');
  if (!SERVER_RUN_AT.test(iso)) throw new Error(`server pattern refuses ${iso}`);
});

check('a time the clocks skip is refused, not moved an hour', () => {
  const r = inZone('Europe/London', () => f.runAtFromLocal('2026-03-29', '01:30'));
  eq(r.ok, false, 'ok');
  if (!/does not exist on 2026-03-29/.test(r.error)) throw new Error(r.error);
  eq(inZone('Europe/London', () => f.runAtFromLocal('2026-03-29', '02:00')).ok, true, 'just after the gap');
  eq(inZone('America/New_York', () => f.runAtFromLocal('2026-03-08', '02:30')).ok, false, 'NY gap');
});

check('a time the clocks repeat is refused (it names two instants); either side of the hour is fine', () => {
  const r = inZone('Europe/London', () => f.runAtFromLocal('2026-10-25', '01:30'));
  eq(r.ok, false, 'ok');
  if (!/happens twice on 2026-10-25/.test(r.error)) throw new Error(r.error);
  eq(inZone('Europe/London', () => f.runAtFromLocal('2026-10-25', '00:59')), { ok: true, iso: '2026-10-25T00:59:00+01:00' }, 'before');
  eq(inZone('Europe/London', () => f.runAtFromLocal('2026-10-25', '02:00')), { ok: true, iso: '2026-10-25T02:00:00+00:00' }, 'after');
  eq(inZone('America/New_York', () => f.runAtFromLocal('2026-11-01', '01:15')).ok, false, 'NY repeat');
});

check('bad dates and times are refused by name', () => {
  const err = (d, t) => inZone('UTC', () => f.runAtFromLocal(d, t)).error;
  eq(err('', '10:00'), 'Pick a date.', 'no date');
  eq(err('2026-11-02', ''), 'Pick a time.', 'no time');
  eq(err('2026-02-30', '10:00'), '2026-02-30 is not a real date.', 'Feb 30');
  eq(err('2026-13-01', '10:00'), '2026-13-01 is not a real date.', 'month 13');
  eq(err('2026-11-02', '24:00'), '24:00 is not a real time.', '24:00');
  eq(err('02/11/2026', '10:00'), '"02/11/2026" is not a date (YYYY-MM-DD).', 'format');
  eq(err('2026-11-02', '9:30'), '"9:30" is not a time (HH:MM).', 'one-digit hour');
});

check("the edit form's inputs from a change's runAt, in local time", () => {
  eq(inZone('Europe/London', () => f.localInputsOf('2026-07-01T09:00:00.000Z')), { date: '2026-07-01', time: '10:00' }, 'London');
  eq(inZone('America/New_York', () => f.localInputsOf('2026-07-01T03:00:00.000Z')), { date: '2026-06-30', time: '23:00' }, 'NY crosses midnight');
  let threw = false;
  try { f.localInputsOf('nope'); } catch { threw = true; }
  eq(threw, true, 'unreadable throws');
});

check('"ran N min late" only past two minutes', () => {
  eq(f.lateNote(0), null, '0');
  eq(f.lateNote(120000), null, 'exactly 2 min');
  eq(f.lateNote(120001), 'ran 2 min late', 'just over');
  eq(f.lateNote(17 * 60000), 'ran 17 min late', '17');
});

const job = (over) => ({
  id: 'j1', channelId: 'UC1', channelTitle: 'Unfiltered', videoId: 'abcdefghijk', videoTitle: 'V',
  target: 'public', runAt: '2026-11-04T10:00:00.000Z', note: '', createdAt: '2026-11-02T10:00:00.000Z',
  createdBy: 'mac', state: 'pending', nextAttemptAt: null, attempts: [], result: null, ...over,
});
const when = (iso) => `<${iso}>`;
const res = (over) => ({ before: 'unlisted', after: 'public', ranAt: '2026-11-04T10:00:20.000Z', lateByMs: 20000, clearedYouTubeSchedule: false, message: null, ...over });

check('row text: pending, and pending waiting out a retry (amber, with the attempt and next try)', () => {
  eq(f.describeJob(job({}), when), { tone: 'pending', headline: '→ Public', details: [] }, 'pending');
  eq(
    f.describeJob(job({ attempts: [{ at: 'x', error: 'HTTP 503' }], nextAttemptAt: '2026-11-04T10:02:00.000Z' }), when),
    { tone: 'retrying', headline: '→ Public', details: ['attempt 1 failed: HTTP 503', 'trying again at <2026-11-04T10:02:00.000Z>'] },
    'retrying',
  );
});

check('row text: done is before → after, with lateness and the cleared YouTube schedule when they happened', () => {
  eq(f.describeJob(job({ state: 'done', result: res({}) }), when), { tone: 'done', headline: 'Unlisted → Public', details: [] }, 'plain');
  eq(
    f.describeJob(job({ state: 'done', result: res({ lateByMs: 6 * 60000, clearedYouTubeSchedule: true }) }), when).details,
    ['ran 6 min late', 'cancelled YouTube’s own schedule'],
    'late + cleared',
  );
  eq(
    f.describeJob(job({ state: 'done', result: res({ before: 'public', after: 'public', message: 'already public, nothing changed' }) }), when),
    { tone: 'done', headline: 'Public → Public', details: ['already public, nothing changed'] },
    'nothing to do',
  );
});

check("row text: failed carries the server's message; cancelled says so", () => {
  eq(
    f.describeJob(job({ state: 'failed', result: res({ after: 'unlisted', message: 'The request is not authorized' }) }), when),
    { tone: 'failed', headline: '→ Public failed', details: ['The request is not authorized'] },
    'failed',
  );
  eq(f.describeJob(job({ state: 'cancelled', target: 'unlisted' }), when), { tone: 'cancelled', headline: '→ Unlisted cancelled', details: [] }, 'cancelled');
});

check('a done or failed change with no result is said out loud in red, never drawn as fine', () => {
  eq(f.describeJob(job({ state: 'done' }), when).tone, 'failed', 'done/no result');
  eq(f.describeJob(job({ state: 'failed' }), when).details, ['The scheduler reports this change as failed but sent no message for it.'], 'failed/no result');
});

check('pending soonest first; history newest first; the badge counts pending only', () => {
  const jobs = [
    job({ id: 'a', state: 'done', runAt: '2026-11-01T10:00:00Z', result: res({}) }),
    job({ id: 'b', runAt: '2026-11-09T10:00:00Z' }),
    job({ id: 'c', state: 'failed', runAt: '2026-11-03T10:00:00Z', result: res({ message: 'x' }) }),
    job({ id: 'd', runAt: '2026-11-05T10:00:00Z' }),
    job({ id: 'e', state: 'cancelled', runAt: '2026-11-02T10:00:00Z' }),
  ];
  const { pending, history } = f.splitJobs(jobs);
  eq(pending.map((j) => j.id), ['d', 'b'], 'pending');
  eq(history.map((j) => j.id), ['c', 'e', 'a'], 'history');
  eq(f.pendingBadge(jobs), '2 pending', 'badge');
  eq(f.pendingBadge([jobs[0]]), null, 'no badge');
});

check("YouTube's own schedule is warned about before saving, for a change to anything", () => {
  eq(f.scheduleClashWarning('2026-11-05T17:00:00Z', 'public', when), 'YouTube itself is set to publish this video at <2026-11-05T17:00:00Z>; this change will cancel that schedule when it runs.', 'public');
  eq(f.scheduleClashWarning('2026-11-05T17:00:00Z', 'unlisted', when) !== null, true, 'unlisted');
  eq(f.scheduleClashWarning('2026-11-05T17:00:00Z', 'private', when) !== null, true, 'private');
  eq(f.scheduleClashWarning(null, 'public', when), null, 'no schedule');
  eq(f.scheduleClashWarning('2026-11-05T17:00:00Z', null, when), null, 'no target yet');
});

check('visibility labels; an unknown status from YouTube is shown as it came', () => {
  eq(['public', 'unlisted', 'private', 'scheduled?'].map(f.visibilityLabel), ['Public', 'Unlisted', 'Private', 'scheduled?'], 'labels');
});

console.log(failures ? `\n${failures} FAILED` : '\nall passed');
process.exitCode = failures ? 1 : 0;
