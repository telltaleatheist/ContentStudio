#!/usr/bin/env node
/**
 * The visibility scheduler in ContentStudio (VISIBILITY-SCHEDULER-PLAN.md, phase 2). Covers the
 * client's config file (missing, malformed, a non-key, a non-https or /api address — each a
 * typed error naming the setup page; a save written mode 600, keeping the address; status
 * never carrying the key), its requests against a fake fetch (the Bearer header, the /api
 * route, the query string, runAt refused without a zone, the server's {error} verbatim, a
 * bare 401 named as a refused key, an unreachable server); "unlisted now, then public at…"
 * (the release checks before any write, the create outcome on success and refusal, the record
 * following an edited or cancelled change, the publishAt/releaseMode lock); the insert body
 * (unlisted, no publishAt), the push's status (private -> unlisted with publishAt left out,
 * unlisted untouched, public refused, schedule-only push refused); the releaseMode validator
 * and upgrade; and the renderer's pure helpers transpiled from their shipped source (badges,
 * order, late note, state views, the create/patch requests across a DST change, the range).
 * Offline: no scheduler, no YouTube, no Electron; temp folder removed at the end.
 *
 *   npm run build:electron && node tools/visibility-scheduler-checks.js
 */
process.env.TZ = 'America/Los_Angeles';
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const ts = require('typescript');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main', 'services');
const client = require(path.join(ROOT, 'scheduler/scheduler-client.js'));
const release = require(path.join(ROOT, 'publish/release-change.js'));
const push = require(path.join(ROOT, 'publish/youtube-push.js'));
const upload = require(path.join(ROOT, 'publish/youtube-upload.js'));
const types = require(path.join(ROOT, 'publish/publish-types.js'));
const fields = require(path.join(ROOT, 'publish/field-validators.js'));

/** The renderer's helpers are not part of dist/main: transpiled from their own source. */
function transpile(rel, stubs = {}) {
  const src = path.join(__dirname, '..', rel);
  const out = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: src,
  });
  const mod = { exports: {} };
  const req = (name) => (name in stubs ? stubs[name] : require(name));
  new Function('exports', 'module', 'require', out.outputText)(mod.exports, mod, req);
  return mod.exports;
}
const schedule = transpile('frontend/src/app/features/publish/publish-schedule.ts');
const schedTypes = transpile('frontend/src/app/features/scheduler/scheduler.types.ts');
const vc = transpile('frontend/src/app/features/scheduler/visibility-changes.ts', {
  '../publish/publish-schedule': schedule,
  './scheduler.types': schedTypes,
});

let failures = 0;
const pending = [];
function check(name, fn) {
  fn.label = name;
  pending.push(fn);
}
function eq(a, e, what) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what} expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function ok(v, what) { if (!v) throw new Error(`${what}: not true`); }
function throwsLike(fn, re, what) {
  try { fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${what}: threw "${e.message}", expected ${re}`); return e; }
  throw new Error(`${what}: did not throw`);
}
async function rejectsLike(fn, re, what) {
  try { await fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${what}: threw "${e.message}", expected ${re}`); return e; }
  throw new Error(`${what}: did not throw`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-scheduler-'));
const KEY = 'csk_' + 'A'.repeat(43);
const BASE = 'https://contentstudio.owenmorgan.com/scheduler';
const VIDEO = 'dQw4w9WgXcQ';
const ITEM = 'itm-abc123-0a1b2c3d';
const CHANNEL = 'UCtesttesttesttesttest00';
let dirN = 0;
function userData(content) {
  const dir = path.join(TMP, `ud${dirN++}`);
  fs.mkdirSync(dir);
  if (content !== undefined) fs.writeFileSync(path.join(dir, 'scheduler.json'), typeof content === 'string' ? content : JSON.stringify(content));
  return dir;
}

/** A fetch that records each call and answers from `answer(url, init)` -> { status, body }. */
function fakeFetch(answer) {
  const calls = [];
  const fn = async (url, init) => {
    calls.push({ url, init });
    const a = answer(url, init);
    if (a instanceof Error) throw a;
    const text = a.body === undefined ? '' : typeof a.body === 'string' ? a.body : JSON.stringify(a.body);
    return { ok: a.status >= 200 && a.status < 300, status: a.status, text: async () => text };
  };
  fn.calls = calls;
  return fn;
}

const job = (over = {}) => ({
  id: 'job-1', channelId: CHANNEL, channelTitle: 'Telltale', videoId: VIDEO, videoTitle: 'A video',
  target: 'public', runAt: '2026-11-10T18:00:00.000Z', note: '', createdAt: '2026-11-02T10:00:00.000Z',
  createdBy: 'mac', state: 'pending', nextAttemptAt: null, attempts: [], result: null, ...over,
});

// ---------------------------------------------------------------- the config file

check('config: missing, malformed, no key, a non-key, http, /api — each a typed fix-it error', () => {
  const setup = /contentstudio\.owenmorgan\.com\/scheduler\//;
  for (const [what, content, re] of [
    ['missing', undefined, /does not exist/],
    ['not JSON', '{nope', /not valid JSON/],
    ['an array', [], /must be an object/],
    ['no key', { baseUrl: BASE }, /has no deviceKey/],
    ['not a key', { baseUrl: BASE, deviceKey: 'hello world' }, /not a scheduler device key/],
    ['no address', { deviceKey: KEY }, /has no baseUrl/],
  ]) {
    const e = throwsLike(() => client.readSchedulerConfig(userData(content)), re, what);
    ok(e instanceof client.SchedulerConfigError, `${what} is a SchedulerConfigError`);
    if (what !== 'no address') ok(setup.test(e.message), `${what} names the setup page`);
  }
  throwsLike(() => client.readSchedulerConfig(userData({ baseUrl: 'http://contentstudio.owenmorgan.com/scheduler', deviceKey: KEY })), /not https/, 'http');
  throwsLike(() => client.readSchedulerConfig(userData({ baseUrl: BASE + '/api', deviceKey: KEY })), /ends in \/api/, '/api');
  eq(client.readSchedulerConfig(userData({ baseUrl: BASE + '//', deviceKey: KEY })), { baseUrl: BASE, deviceKey: KEY }, 'trailing slashes stripped');
});

check('config: a refused key is never quoted back in the error', () => {
  const bad = 'nope_secretsecret';
  const e = throwsLike(() => client.readSchedulerConfig(userData({ baseUrl: BASE, deviceKey: bad })), /not a scheduler device key/, 'bad key');
  ok(!e.message.includes(bad), 'key not in message');
});

check('save: written mode 600, address kept, status carries no key', () => {
  const custom = 'https://example.test/scheduler';
  const dir = userData({ baseUrl: custom, deviceKey: 'csk_old' });
  fs.chmodSync(path.join(dir, 'scheduler.json'), 0o644);
  const status = client.writeSchedulerKey(dir, `  ${KEY}  `);
  eq((fs.statSync(path.join(dir, 'scheduler.json')).mode & 0o777).toString(8), '600', 'mode');
  eq(JSON.parse(fs.readFileSync(path.join(dir, 'scheduler.json'), 'utf8')), { baseUrl: custom, deviceKey: KEY }, 'file');
  eq(status.configured, true, 'configured');
  ok(!JSON.stringify(status).includes(KEY), 'no key in status');
  const fresh = userData();
  eq(client.writeSchedulerKey(fresh, KEY).baseUrl, BASE, 'new file gets the scheduler address');
  throwsLike(() => client.writeSchedulerKey(fresh, ''), /has no deviceKey/, 'empty key refused');
  const none = client.schedulerStatus(userData());
  eq([none.configured, none.baseUrl, /does not exist/.test(none.reason)], [false, null, true], 'unconfigured status');
});

// ---------------------------------------------------------------- requests

check('requests: Bearer key, /api route, query string, JSON body with a zoned runAt', async () => {
  const dir = userData({ baseUrl: BASE, deviceKey: KEY });
  const f = fakeFetch((url, init) => {
    if (init.method === 'POST') return { status: 201, body: { job: job(), warnings: ['YouTube itself is set to publish this video at x'] } };
    return { status: 200, body: [job()] };
  });
  const c = new client.SchedulerClient({ userDataPath: dir, fetch: f });
  await c.listJobs({ videoId: VIDEO, state: 'pending', from: '2026-11-01T00:00:00-07:00', to: '2026-11-02T00:00:00-08:00' });
  const first = f.calls[0];
  eq(first.init.headers.Authorization, `Bearer ${KEY}`, 'auth header');
  const u = new URL(first.url);
  eq(u.origin + u.pathname, `${BASE}/api/jobs`, 'route');
  eq([u.searchParams.get('videoId'), u.searchParams.get('state'), u.searchParams.get('from'), u.searchParams.get('to')],
    [VIDEO, 'pending', '2026-11-01T00:00:00-07:00', '2026-11-02T00:00:00-08:00'], 'query');
  const out = await c.createJob({ videoId: VIDEO, target: 'public', runAt: '2026-11-10T10:00:00-08:00', note: 'Sponsor: X review' });
  eq(JSON.parse(f.calls[1].init.body), { videoId: VIDEO, target: 'public', runAt: '2026-11-10T10:00:00-08:00', note: 'Sponsor: X review' }, 'body');
  eq(f.calls[1].init.headers['Content-Type'], 'application/json', 'content type');
  eq(out.warnings.length, 1, 'warnings come back');
  await rejectsLike(() => c.createJob({ videoId: VIDEO, target: 'public', runAt: '2026-11-10T10:00', note: '' }), /explicit zone/, 'zoneless runAt');
  await rejectsLike(() => c.createJob({ videoId: VIDEO, target: 'secret', runAt: '2026-11-10T10:00:00Z', note: '' }), /public, unlisted or private/, 'bad target');
  await rejectsLike(() => c.listJobs({ from: '2026-11-10' }), /explicit zone/, 'zoneless from');
  await rejectsLike(() => c.patchJob('job-1', {}), /Nothing to change/, 'empty patch');
  eq(f.calls.length, 2, 'refused calls never sent');
});

check('requests: every route goes where the server has it', async () => {
  const dir = userData({ baseUrl: BASE, deviceKey: KEY });
  const f = fakeFetch((url, init) => ({ status: 200, body: init.method === 'DELETE' ? { job: job({ state: 'cancelled' }) } : { job: job(), warnings: [] } }));
  const c = new client.SchedulerClient({ userDataPath: dir, fetch: f });
  await c.health(); await c.channels(); await c.video(VIDEO);
  await c.patchJob('job-1', { note: 'x' });
  const cancelled = await c.cancelJob('job-1');
  eq(f.calls.map((x) => `${x.init.method} ${new URL(x.url).pathname}`), [
    'GET /scheduler/api/health', 'GET /scheduler/api/channels', `GET /scheduler/api/video/${VIDEO}`,
    'PATCH /scheduler/api/jobs/job-1', 'DELETE /scheduler/api/jobs/job-1',
  ], 'routes');
  eq(cancelled.state, 'cancelled', 'cancel returns the job');
  await rejectsLike(() => c.video('not-an-id'), /Not a YouTube video id/, 'bad video id');
});

check('errors: the server\'s {error} verbatim, a bare 401 is a refused key, unreachable says so', async () => {
  const dir = userData({ baseUrl: BASE, deviceKey: KEY });
  const say = (status, body) => new client.SchedulerClient({ userDataPath: dir, fetch: fakeFetch(() => ({ status, body })) });
  const e1 = await rejectsLike(() => say(400, { error: 'runAt must be at least one minute in the future' }).createJob({ videoId: VIDEO, target: 'public', runAt: '2026-11-10T10:00:00Z', note: '' }),
    /^runAt must be at least one minute in the future$/, 'verbatim');
  eq(e1.status, 400, 'status kept');
  await rejectsLike(() => say(401).health(), /refused the device key \(401\).*contentstudio\.owenmorgan\.com\/scheduler\//, 'bare 401');
  await rejectsLike(() => say(502, { error: 'Google said: quotaExceeded' }).channels(), /^Google said: quotaExceeded$/, '502 verbatim');
  await rejectsLike(() => say(429, '').health(), /rate-limiting/, '429');
  await rejectsLike(() => say(200, 'not json').health(), /no JSON body/, '200 without JSON');
  const down = new client.SchedulerClient({ userDataPath: dir, fetch: fakeFetch(() => Object.assign(new TypeError('fetch failed'), { cause: new Error('getaddrinfo ENOTFOUND') })) });
  const e2 = await rejectsLike(() => down.health(), /Could not reach the scheduler.*fetch failed: getaddrinfo ENOTFOUND/, 'unreachable');
  eq(e2.status, null, 'no status');
  await rejectsLike(() => new client.SchedulerClient({ userDataPath: userData(), fetch: fakeFetch(() => ({ status: 200, body: {} })) }).health(), /does not exist/, 'no file: refused before a request');
});

// ---------------------------------------------------------------- unlisted, then public

const NOW = new Date('2026-11-02T18:00:00.000Z');
function record(over = {}) {
  return {
    ...types.emptyChosenMetadata(ITEM, 'job-x'),
    chosenTitles: ['The title'],
    channelId: CHANNEL,
    videoId: VIDEO,
    releaseMode: 'unlisted-then-public',
    publishAt: '2026-11-10T10:00:00-08:00',
    ...over,
  };
}
const goodApi = (onCreate) => ({
  requireConfigured() {},
  async createJob(input) { onCreate && onCreate(input); return { job: job({ id: 'job-9', runAt: new Date(input.runAt).toISOString() }), warnings: ['w'] }; },
});

check('release: refused before any write with no time, a lapsed time, or no key', () => {
  throwsLike(() => release.requireReleaseReady(record({ publishAt: null }), goodApi(), NOW, 'uploaded'), /no time to go public.*Nothing was uploaded/, 'no time');
  throwsLike(() => release.requireReleaseReady(record({ publishAt: '2026-11-02T10:00:30-08:00' }), goodApi(), NOW, 'pushed'), /less than two minutes away/, 'too close');
  throwsLike(() => release.requireReleaseReady(record({ publishAt: '2026-11-01T10:00:00-08:00' }), goodApi(), NOW, 'pushed'), /already past/, 'past');
  const noKey = { requireConfigured() { throw new client.SchedulerConfigError('no file. Make a device key on …'); }, createJob() { throw new Error('never'); } };
  throwsLike(() => release.requireReleaseReady(record(), noKey, NOW, 'uploaded'), /visibility scheduler, which is not usable: no file/, 'no key');
  eq(release.requireReleaseReady(record(), goodApi(), NOW, 'uploaded'), '2026-11-10T10:00:00-08:00', 'ready');
});

check('release: create asks for public at the time with a note; a refusal becomes the link\'s error', async () => {
  let sent = null;
  const okOut = await release.createReleaseChange(goodApi((i) => (sent = i)), { itemId: ITEM, videoId: VIDEO, runAt: '2026-11-10T10:00:00-08:00', title: 'The title' }, NOW);
  eq(sent, { videoId: VIDEO, target: 'public', runAt: '2026-11-10T10:00:00-08:00', note: 'ContentStudio: unlisted, then public (The title)' }, 'request');
  eq([okOut.failure, okOut.link.jobId, okOut.link.error, okOut.link.warnings], [null, 'job-9', null, ['w']], 'success link');
  const refuse = { requireConfigured() {}, async createJob() { throw new client.SchedulerRequestError('no connected channel owns that video', 404); } };
  const bad = await release.createReleaseChange(refuse, { itemId: ITEM, videoId: VIDEO, runAt: '2026-11-10T10:00:00-08:00', title: null }, NOW);
  eq([bad.failure, bad.link.jobId, bad.link.error], ['no connected channel owns that video', null, 'no connected channel owns that video'], 'failure link');
  ok(/UNLISTED.*could not be created.*no connected channel owns that video.*stays unlisted/s.test(release.releaseFailureMessage(VIDEO, 'T', 'uploaded', bad.failure)), 'failure sentence');
});

check('release: the record follows its edited change, and drops it when cancelled or retargeted', () => {
  const linked = record({ releaseChange: { videoId: VIDEO, runAt: '2026-11-10T10:00:00-08:00', attemptedAt: 'x', jobId: 'job-9', error: null, warnings: [] } });
  const moved = release.releasePatchForJob(linked, job({ id: 'job-9', runAt: '2026-11-11T18:00:00.000Z' }), NOW);
  eq([moved.publishAt, moved.releaseChange.runAt], ['2026-11-11T18:00:00.000Z', '2026-11-11T18:00:00.000Z'], 'moved');
  eq(release.releasePatchForJob(linked, job({ id: 'job-9', state: 'cancelled' }), NOW), { publishAt: null, publishAtSetAt: NOW.toISOString(), releaseChange: null }, 'cancelled');
  eq(release.releasePatchForJob(linked, job({ id: 'job-9', target: 'private' }), NOW).releaseChange, null, 'retargeted');
  eq(release.releasePatchForJob(linked, job({ id: 'other' }), NOW), null, 'another change');
  eq(release.releasePatchForJob(linked, job({ id: 'job-9', state: 'done' }), NOW), null, 'done changes nothing');
});

check('release: publishAt and releaseMode are locked while the change exists', () => {
  const linked = record({ releaseChange: { videoId: VIDEO, runAt: 'T', attemptedAt: 'x', jobId: 'job-9', error: null, warnings: [] } });
  ok(/publishAt cannot be changed here.*Visibility changes/.test(release.releaseLockProblem(linked, { publishAt: null })), 'publishAt');
  ok(/releaseMode/.test(release.releaseLockProblem(linked, { releaseMode: 'youtube-schedule' })), 'releaseMode');
  eq(release.releaseLockProblem(linked, { tagsOverride: 'a' }), null, 'other fields free');
  eq(release.releaseLockProblem(record({ releaseChange: { ...linked.releaseChange, jobId: null, error: 'x' } }), { publishAt: null }), null, 'a failed create does not lock');
  eq(release.releaseLockProblem(record({ releaseChange: { ...linked.releaseChange, videoId: 'zzzzzzzzzzz' } }), { publishAt: null }), null, 'another video does not lock');
});

check('upload: an unlisted-first insert is unlisted with no publishAt; the default is unchanged', () => {
  const input = (rec) => ({ record: { ...rec, videoId: null }, resolved: { title: 'The title', description: 'Body', tags: 'a, b' }, file: { path: '/x.mov', sizeBytes: 10 }, categoryId: '22', profile: null });
  const unl = upload.planVideoInsert(input(record()));
  eq([unl.body.status.privacyStatus, 'publishAt' in unl.body.status], ['unlisted', false], 'unlisted first');
  const yt = upload.planVideoInsert(input(record({ releaseMode: 'youtube-schedule' })));
  eq([yt.body.status.privacyStatus, yt.body.status.publishAt], ['private', '2026-11-10T10:00:00-08:00'], 'youtube schedule');
});

function video(privacyStatus, over = {}) {
  return {
    id: VIDEO,
    snippet: { channelId: CHANNEL, categoryId: '22', title: 'old', description: 'old body', tags: ['a'] },
    status: { privacyStatus, embeddable: true, license: 'youtube', ...(privacyStatus === 'private' ? { publishAt: '2026-11-20T10:00:00Z' } : {}), ...over },
  };
}
const resolved = { description: 'New body', tags: 'a, b' };

check('push: private -> unlisted, whole status kept, YouTube\'s publishAt left out; change still to make', () => {
  const plan = push.planVideoUpdate({ record: record(), resolved, video: video('private'), profile: null });
  eq(plan.parts, ['snippet', 'status'], 'parts');
  eq(plan.body.status, { privacyStatus: 'unlisted', embeddable: true, license: 'youtube' }, 'status');
  eq([plan.publishAt, plan.madeUnlisted, plan.needsReleaseChange], [null, true, true], 'flags');
});

check('push: already unlisted -> status untouched; public without a change -> refused; public with one -> fine', () => {
  const unl = push.planVideoUpdate({ record: record(), resolved, video: video('unlisted'), profile: null });
  eq([unl.parts, unl.madeUnlisted, unl.needsReleaseChange], [['snippet'], false, true], 'unlisted');
  throwsLike(() => push.planVideoUpdate({ record: record(), resolved, video: video('public'), profile: null }), /already PUBLIC.*take a released video down/, 'public refused');
  const linked = record({ releaseChange: { videoId: VIDEO, runAt: 'T', attemptedAt: 'x', jobId: 'job-9', error: null, warnings: [] } });
  const pub = push.planVideoUpdate({ record: linked, resolved, video: video('public'), profile: null });
  eq([pub.parts, pub.needsReleaseChange], [['snippet'], false], 'public after release');
  const yt = push.planVideoUpdate({ record: record({ releaseMode: 'youtube-schedule' }), resolved, video: video('private'), profile: null });
  eq([yt.body.status.privacyStatus, yt.body.status.publishAt, yt.madeUnlisted], ['private', '2026-11-10T10:00:00-08:00', false], 'youtube schedule unchanged');
  throwsLike(() => push.planScheduleUpdate({ record: record(), video: video('private'), profile: null }), /no publish time.*Visibility changes/, 'schedule-only push refused');
});

check('push: the change is created after the write; a refusal is stored on the record and thrown', async () => {
  const writes = [];
  const store = {
    rec: record({ releaseMode: 'unlisted-then-public' }),
    get() { return this.rec; },
    async update(_id, _g, patch) { writes.push(Object.keys(patch)); this.rec = { ...this.rec, ...patch }; return this.rec; },
  };
  const api = { async getVideoParts() { return video('private'); }, async updateVideo() { writes.push(['YOUTUBE']); return video('unlisted'); }, async setThumbnail() {} };
  const generated = {
    jobId: 'job-x', titles: [], description: 'New body', descriptionWithoutChapters: 'New body', chapterBlock: '',
    sections: { body: 'New body', chapters: [], links: '' }, tags: 'a, b', sourceFilename: null, sourcePath: null,
    sourcePathDeclared: true, promptSet: null, sourceDurationSec: null, publishProfile: null,
  };
  const refuse = { requireConfigured() {}, async createJob() { throw new Error('this video already has a change in that minute (job-2)'); } };
  await rejectsLike(() => push.pushItemToYouTube(ITEM, { store, readGenerated: () => generated, api, scheduler: refuse, now: () => NOW }),
    /made unlisted and is UNLISTED.*already has a change in that minute/, 'thrown');
  eq(writes, [['YOUTUBE'], ['pushedAt', 'pushReceipt'], ['releaseChange']], 'order: YouTube, receipt, then the change');
  eq([store.rec.releaseChange.jobId, /in that minute/.test(store.rec.releaseChange.error)], [null, true], 'failure on the record');
  eq(store.rec.pushReceipt.updated.privacyStatus, 'unlisted', 'receipt says unlisted');
  const noKey = { requireConfigured() { throw new Error('no key'); }, async createJob() {} };
  writes.length = 0;
  await rejectsLike(() => push.pushItemToYouTube(ITEM, { store, readGenerated: () => generated, api, scheduler: noKey, now: () => NOW }), /not usable: no key/, 'no key');
  eq(writes, [], 'nothing written without a key');
});

check('fields: releaseMode takes the two names only; upgrade fills it', () => {
  const ctx = { listChannels: () => [], now: NOW };
  eq(fields.buildFieldPatch({ releaseMode: 'unlisted-then-public' }, ctx), { releaseMode: 'unlisted-then-public' }, 'valid');
  throwsLike(() => fields.buildFieldPatch({ releaseMode: 'unlisted' }, ctx), /releaseMode must be one of youtube-schedule, unlisted-then-public/, 'invalid');
  const old = { ...types.emptyChosenMetadata(ITEM, 'job-x') };
  delete old.releaseMode; delete old.releaseChange;
  const up = types.upgradeStoredMetadata(old);
  eq([up.releaseMode, up.releaseChange], ['youtube-schedule', null], 'upgraded');
});

// ---------------------------------------------------------------- the renderer's helpers

check('badges: "→ public 10:00" on its day, "→ unlisted 9 Jan" as a date; pending and failed only', () => {
  eq(vc.badgeText({ target: 'public', runAt: '2026-11-10T18:00:00.000Z' }, 'time'), '→ public 10:00', 'time form (PST)');
  eq(vc.badgeText({ target: 'unlisted', runAt: '2027-01-09T20:00:00.000Z' }, 'date'), '→ unlisted 9 Jan', 'date form');
  const byDay = vc.badgesByDay([
    job({ id: 'b', runAt: '2026-11-10T22:00:00.000Z', target: 'unlisted' }),
    job({ id: 'a', runAt: '2026-11-10T18:00:00.000Z' }),
    job({ id: 'f', state: 'failed', runAt: '2026-11-09T18:00:00.000Z', result: { before: 'unlisted', after: 'unlisted', ranAt: 'x', lateByMs: 0, clearedYouTubeSchedule: false, message: 'Google said no' } }),
    job({ id: 'd', state: 'done', runAt: '2026-11-08T18:00:00.000Z' }),
    job({ id: 'c', state: 'cancelled', runAt: '2026-11-08T18:00:00.000Z' }),
  ]);
  eq([...byDay.keys()].sort(), ['2026-11-09', '2026-11-10'], 'days');
  eq(byDay.get('2026-11-10').map((b) => b.text), ['→ public 10:00', '→ unlisted 14:00'], 'in time order');
  eq([byDay.get('2026-11-09')[0].failed, /failed: Google said no/.test(byDay.get('2026-11-09')[0].title)], [true, true], 'failed in red with reason');
  eq(vc.localDateKey('2026-11-11T07:30:00.000Z'), '2026-11-10', 'the local day, not the UTC one');
});

check('order: pending soonest first, then history most recent first', () => {
  const list = vc.sortChanges([
    job({ id: 'h1', state: 'done', runAt: '2026-11-01T00:00:00Z' }),
    job({ id: 'p2', runAt: '2026-11-12T00:00:00Z' }),
    job({ id: 'h2', state: 'failed', runAt: '2026-11-03T00:00:00Z' }),
    job({ id: 'p1', runAt: '2026-11-11T00:00:00Z' }),
  ]);
  eq(list.map((j) => j.id), ['p1', 'p2', 'h2', 'h1'], 'order');
});

check('views: done shows before → after, late past 2 min, cleared schedule; failed shows its reason', () => {
  eq([vc.lateText(119_000), vc.lateText(120_000), vc.lateText(7 * 60_000 + 10_000)], [null, null, 'ran 7 min late'], 'late');
  const done = vc.changeView(job({ state: 'done', result: { before: 'unlisted', after: 'public', ranAt: 'x', lateByMs: 12 * 60_000, clearedYouTubeSchedule: true, message: null } }));
  eq([done.tone, done.lines, done.error, done.editable], ['done', ['unlisted → public', 'ran 12 min late', 'cancelled YouTube’s own schedule'], null, false], 'done');
  const quiet = vc.changeView(job({ state: 'done', result: { before: 'public', after: 'public', ranAt: 'x', lateByMs: 30_000, clearedYouTubeSchedule: false, message: 'already public, nothing changed' } }));
  eq(quiet.lines, ['public → public', 'already public, nothing changed'], 'already');
  const failed = vc.changeView(job({ state: 'failed', attempts: [{ at: 'a', error: 'HTTP 500' }, { at: 'b', error: 'HTTP 503' }], result: null }));
  eq([failed.tone, failed.error, failed.lines], ['failed', 'HTTP 503', ['2 attempts']], 'failed from attempts');
  const retrying = vc.changeView(job({ attempts: [{ at: 'a', error: 'HTTP 500' }], nextAttemptAt: '2026-11-10T18:02:00.000Z' }));
  eq([retrying.editable, retrying.lines], [true, ['retrying at 10:02 after 1 failed attempt: HTTP 500']], 'retrying');
  eq(vc.changeView(job()).when, 'Tue 10 Nov, 10:00', 'local time');
});

check('requests: local date/time -> a zoned runAt (across the DST change); patch sends only what changed', () => {
  eq(vc.buildCreateRequest(VIDEO, { target: 'public', date: '2026-11-10', time: '10:00', note: '  Sponsor: X  ' }),
    { videoId: VIDEO, target: 'public', runAt: '2026-11-10T10:00:00-08:00', note: 'Sponsor: X' }, 'after DST ends');
  eq(vc.buildCreateRequest(VIDEO, { target: 'unlisted', date: '2026-10-30', time: '10:00', note: '' }).runAt, '2026-10-30T10:00:00-07:00', 'before DST ends');
  throwsLike(() => vc.buildCreateRequest(VIDEO, { target: '', date: '2026-11-10', time: '10:00', note: '' }), /Pick a visibility/, 'no target');
  throwsLike(() => vc.buildCreateRequest(VIDEO, { target: 'public', date: '', time: '10:00', note: '' }), /Pick a date/, 'no date');
  throwsLike(() => vc.buildCreateRequest(VIDEO, { target: 'public', date: '2027-03-14', time: '02:30', note: '' }), /does not exist/, 'spring-forward hour');
  throwsLike(() => vc.buildCreateRequest(VIDEO, { target: 'public', date: '2026-11-10', time: '10:00', note: 'x'.repeat(201) }), /keeps 200/, 'long note refused, not cut');
  const j = job({ runAt: '2026-11-10T18:00:00.000Z', note: 'n' });
  const form = vc.formFromJob(j);
  eq(form, { target: 'public', date: '2026-11-10', time: '10:00', note: 'n' }, 'form from job');
  throwsLike(() => vc.buildPatchRequest(j, form), /Nothing was changed/, 'unchanged');
  eq(vc.buildPatchRequest(j, { ...form, time: '11:30' }), { runAt: '2026-11-10T11:30:00-08:00' }, 'time only');
  eq(vc.buildPatchRequest(j, { ...form, target: 'unlisted', note: 'm' }), { target: 'unlisted', note: 'm' }, 'target and note');
});

check('range: local days first..last inclusive with explicit zones', () => {
  eq(vc.rangeForDays('2026-10-31', '2026-11-01'), { from: '2026-10-31T00:00:00-07:00', to: '2026-11-02T00:00:00-08:00' }, 'across DST');
  eq(vc.nextDayKey('2026-12-31'), '2027-01-01', 'year end');
});

(async () => {
  for (const fn of pending) {
    try {
      await fn();
      console.log('PASS  ' + fn.label);
    } catch (err) {
      failures++;
      console.log('FAIL  ' + fn.label + '\n      ' + err.message);
    }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? `\nAll ${pending.length} visibility-scheduler checks passed.` : `\n${failures} of ${pending.length} checks FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
