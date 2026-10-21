#!/usr/bin/env node
/**
 * Engaged views, earnings and the long per-day series (extension 0.2.11, 2026-10-21). From
 * 2026-08-27 YouTube counts inline Home-feed autoplay previews as views; ENGAGED_VIEWS leaves
 * them out. Covers: the per-video collector's v2 snapshot (columns matched by type, the value
 * holder read whatever its name, money /1000, CPM {} -> null, a missing column or an
 * ambiguous holder -> a named failure); the per-day v2 row with its PLAYBACK_LOCATION_TYPE
 * split; the v1/v2 validators and the upsert rule (v1 never replaces v2); the outbox keeping
 * one channel-days entry per channel and carrying days the newer fetch lacks; the payload
 * size of a 400-day window for three channels; snapshot ages from the catalogue; first-week
 * planning, the page query and the join; POST /analytics/first-weeks; lifetime engaged views
 * (v2, before 2026-08-27, otherwise null — never a ratio); verdicts, baselines and the render
 * saying which measure its numbers are; the Analytics card's engaged/earnings arithmetic and
 * weekly rows. Offline: no Studio, no Electron, temp folder removed at the end.
 *
 *   npm run build:electron && node tools/engaged-views-checks.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const Module = require('module');
const ts = require('typescript');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main', 'services', 'analytics');
const { validateSnapshot, validateChannelDay, validateVideoFirstWeek, AnalyticsStoreService } = require(path.join(ROOT, 'analytics-store.service.js'));
const { IngestServerService } = require(path.join(ROOT, 'ingest-server.service.js'));
const { DistillationService, lifetimeEngagedViews } = require(path.join(ROOT, 'distillation.service.js'));
const { buildInsightsBlock } = require(path.join(ROOT, 'insights-prompt.js'));

/** Transpile a shipped source file (extension / frontend) so the check runs that exact code. */
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
const collector = transpile('extension/src/collector.ts', { './catalogue': {}, './collection-state': {} });
const pushed = [];
const outbox = transpile('extension/src/outbox.ts', {
  './ingest-client': {
    IngestError: class IngestError extends Error {},
    pushAbTests: async () => {}, pushChannelDays: async (d) => pushed.push(d), pushFirstWeeks: async () => {},
    pushSnapshots: async () => {}, pushVideos: async () => {},
  },
});
const compare = transpile('frontend/src/app/components/analytics/channel-days-compare.ts');

const pending = [];
function check(name, fn) { fn.label = name; pending.push(fn); }
function eq(a, e, what) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what} expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function near(a, e, what) { if (a === null || a === undefined || Math.abs(a - e) > 1e-9) throw new Error(`${what} expected ${e}, got ${a}`); }
function includes(text, needle, what) { if (!text.includes(needle)) throw new Error(`${what}: "${needle}" not in ${JSON.stringify(text.slice(0, 300))}`); }
async function throwsLike(fn, re, what) {
  try { await fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${what}: threw "${e.message}", expected ${re}`); return; }
  throw new Error(`${what}: did not throw`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-engaged-'));
const CH = 'UCengagedengagedengaged0';

// ---------------------------------------------------------------- a fake Studio page

function table(dims, metrics) {
  return {
    results: [{ key: 'TABLE_QUERY', value: { resultTable: {
      dimensionColumns: dims.map((d) => ({ dimension: { type: d.type }, [d.holder]: { values: d.values } })),
      metricColumns: metrics.map((m) => (m.raw ? { metric: { type: m.type }, ...m.raw } : { metric: { type: m.type }, [m.holder]: { values: m.values } })),
    } } }],
  };
}

/** Run an injected page function against canned answers keyed by the request's dimensions. */
async function inPage(fn, args, answer) {
  const requests = [];
  const saved = { window: global.window, document: global.document, fetch: global.fetch };
  global.window = { ytcfg: { get: (k) => ({
    INNERTUBE_CONTEXT: { client: { clientVersion: '1.20261020.00.00', visitorData: 'v' } },
    CHANNEL_ID: CH,
    INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT: 'deleg',
    SESSION_INDEX: 0,
  })[k] } };
  global.document = { cookie: 'SAPISID=abc123' };
  global.fetch = async (url, init) => {
    const query = JSON.parse(init.body).nodes[0].value.query;
    requests.push(query);
    return { status: 200, ok: true, json: async () => answer(query) };
  };
  try {
    return { result: await fn(...args), requests };
  } finally {
    Object.assign(global, saved);
  }
}

// Per-video lifetime: three videos, columns deliberately out of request order, the new
// metrics in holders named whatever (the parser must not care), CPM {} where no ads ran.
function perVideo({ omit = null, cpm = null, engaged = null } = {}) {
  const metrics = [
    { type: 'CPM', holder: 'doubles', values: [16501, {}, 4000] },
    { type: 'EXTERNAL_VIEWS', holder: 'counts', values: [1000, 50, 10] },
    { type: 'ENGAGED_VIEWS', holder: 'counts', values: [400, 50, 10] },
    { type: 'VIDEO_THUMBNAIL_IMPRESSIONS', holder: 'counts', values: [20000, 900, 100] },
    { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', holder: 'percentages', values: [5, 4, 3] },
    { type: 'EXTERNAL_WATCH_TIME', holder: 'milliseconds', values: [36000000, 3600000, 0] },
    { type: 'AVERAGE_WATCH_PERCENTAGE', holder: 'percentages', values: [40, 30, 20] },
    { type: 'TOTAL_ESTIMATED_EARNINGS', holder: 'milliUsd', values: [1000110, 0, 120] },
    { type: 'RATINGS_LIKES', holder: 'counts', values: [30, 2, 0] },
    { type: 'COMMENTS', holder: 'counts', values: [5, 0, 0] },
    { type: 'SHARINGS', holder: 'counts', values: [3, 0, 0] },
    { type: 'SUBSCRIBERS_GAINED', holder: 'counts', values: [7, 1, 0] },
    { type: 'SUBSCRIBERS_LOST', holder: 'counts', values: [2, 0, 1] },
  ].filter((m) => m.type !== omit);
  if (cpm) metrics[0] = { type: 'CPM', raw: cpm };
  if (engaged) metrics[2] = { type: 'ENGAGED_VIEWS', raw: engaged };
  return table([{ type: 'VIDEO', holder: 'strings', values: ['vidA', 'vidB', 'vidC'] }], metrics);
}
const runVideos = (opts) => inPage(collector.collectStudioAnalyticsInPage, [CH, { pageSize: 10000 }], () => perVideo(opts));

check('per-video: a v2 snapshot with engaged views, USD money, CPM {} -> null, filled engagement counts', async () => {
  const { result, requests } = await runVideos();
  eq(result.ok, true, 'ok');
  const types = requests[0].metrics.map((m) => m.type);
  for (const t of ['ENGAGED_VIEWS', 'TOTAL_ESTIMATED_EARNINGS', 'CPM', 'RATINGS_LIKES', 'COMMENTS', 'SHARINGS', 'SUBSCRIBERS_GAINED', 'SUBSCRIBERS_LOST']) {
    if (!types.includes(t)) throw new Error(`request lacks ${t}`);
  }
  const [a, b] = result.snapshots;
  eq([a.schemaVersion, a.views, a.engagedViews], [2, 1000, 400], 'vidA views');
  near(a.estimatedEarnings, 1000.11, 'earnings USD'); near(a.cpm, 16.501, 'CPM USD');
  eq([a.likes, a.comments, a.shares, a.subsGained, a.subsLost], [30, 5, 3, 7, 2], 'engagement');
  eq([b.cpm, b.estimatedEarnings], [null, 0], 'vidB: no ads -> CPM null, earnings a real 0');
  for (const s of result.snapshots) eq(validateSnapshot(s), [], `validator on ${s.videoId}`);
});

check('per-video: CPM with no value array at all is null for every row', async () => {
  const { result } = await runVideos({ cpm: { doubles: {} } });
  eq(result.snapshots.map((s) => s.cpm), [null, null, null], 'cpm');
});

check('per-video: a missing ENGAGED_VIEWS column or two value arrays is a named failure', async () => {
  const missing = (await runVideos({ omit: 'ENGAGED_VIEWS' })).result;
  eq([missing.ok, missing.code], [false, 'MISSING_COLUMN'], 'missing');
  includes(missing.message, 'ENGAGED_VIEWS', 'message names the column');
  const two = (await runVideos({ engaged: { counts: { values: [1, 2, 3] }, doubles: { values: [1, 2, 3] } } })).result;
  eq([two.ok, two.code], [false, 'MISSING_COLUMN'], 'ambiguous');
  includes(two.message, 'several value arrays', 'message');
  const blank = (await runVideos({ engaged: { counts: { values: [1, {}, 3] } } })).result;
  eq([blank.ok, blank.code], [false, 'MISSING_VALUE'], 'a row without engaged views');
});

// ---------------------------------------------------------------- per-day v2

const DAY_IDS = [20261018, 20261019];
function perDay() {
  return table([{ type: 'DAY', holder: 'dateIds', values: DAY_IDS }], [
    { type: 'VIDEO_THUMBNAIL_IMPRESSIONS', holder: 'counts', values: [1000, 900] },
    { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', holder: 'percentages', values: [5, 4] },
    { type: 'EXTERNAL_VIEWS', holder: 'counts', values: [5500, 300] },
    { type: 'EXTERNAL_WATCH_TIME', holder: 'milliseconds', values: [36000000, 7200000] },
    { type: 'NEW_VIEWERS', holder: 'counts', values: [50, 40] },
    { type: 'RETURNING_VIEWERS', holder: 'counts', values: [100, 90] },
    { type: 'SUBSCRIBERS_NET_CHANGE', holder: 'counts', values: [3, -1] },
    { type: 'ENGAGED_VIEWS', holder: 'counts', values: [900, 280] },
    { type: 'TOTAL_ESTIMATED_EARNINGS', holder: 'doubles', values: [12340, 5000] },
    { type: 'CPM', holder: 'doubles', values: [9000, {}] },
    { type: 'RATINGS_LIKES', holder: 'counts', values: [10, 8] },
    { type: 'COMMENTS', holder: 'counts', values: [2, 1] },
    { type: 'SHARINGS', holder: 'counts', values: [1, 0] },
    { type: 'SUBSCRIBERS_GAINED', holder: 'counts', values: [4, 1] },
    { type: 'SUBSCRIBERS_LOST', holder: 'counts', values: [1, 2] },
  ]);
}
const SOURCE_EMPTY = table(
  [{ type: 'DAY', holder: 'dateIds', values: [] }, { type: 'TRAFFIC_SOURCE_TYPE', holder: 'enumValues', values: [] }],
  [{ type: 'VIDEO_THUMBNAIL_IMPRESSIONS', holder: 'counts', values: [] }, { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', holder: 'percentages', values: [] }, { type: 'EXTERNAL_VIEWS', holder: 'counts', values: [] }],
);
const LOC_ROWS = [
  // day, location, views, engaged, watch ms
  [20261018, 'BROWSE', 5276, 713, 3600000],
  [20261018, 'WATCH', 200, 170, 30000000],
  [20261018, 'SEARCH', 14, 10, 360000],
  [20261018, 'EXTERNAL_APP', 10, 7, 0],
  [20261019, 'WATCH', 300, 280, 7200000],
];
function perLocation(rows = LOC_ROWS, holder = 'enumValues') {
  return table(
    [{ type: 'DAY', holder: 'dateIds', values: rows.map((r) => r[0]) }, { type: 'PLAYBACK_LOCATION_TYPE', holder, values: rows.map((r) => r[1]) }],
    [
      { type: 'EXTERNAL_VIEWS', holder: 'counts', values: rows.map((r) => r[2]) },
      { type: 'ENGAGED_VIEWS', holder: 'counts', values: rows.map((r) => r[3]) },
      { type: 'EXTERNAL_WATCH_TIME', holder: 'milliseconds', values: rows.map((r) => r[4]) },
    ],
  );
}
const runDays = (loc = perLocation()) => inPage(collector.collectChannelDaysInPage, [CH, { windowDays: 400 }], (q) => {
  const dims = q.dimensions.map((d) => d.type).join(',');
  return dims === 'DAY' ? perDay() : dims === 'DAY,TRAFFIC_SOURCE_TYPE' ? SOURCE_EMPTY : loc;
});

check('per-day: v2 rows with engaged views, USD, engagement, and the window is 400 days at a 10,000-row page', async () => {
  const { result, requests } = await runDays();
  eq(result.ok, true, 'ok');
  eq(requests.map((q) => q.limit.pageSize), [10000, 10000, 10000], 'page size');
  const id = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const now = new Date();
  eq(requests[0].timeRange.dateIdRange.inclusiveStart, id(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 399)), 'window start');
  const [d18, d19] = result.days;
  eq([d18.schemaVersion, d18.views, d18.engagedViews], [2, 5500, 900], '18th');
  near(d18.estimatedEarnings, 12.34, 'earnings'); near(d18.cpm, 9, 'cpm');
  eq([d19.cpm, d19.subsGained, d19.subsLost, d19.likes], [null, 1, 2, 8], '19th');
  for (const d of result.days) eq(validateChannelDay(d), [], `validator ${d.day}`);
});

check('per-day: playback locations — BROWSE/WATCH kept, others folded into other and named, no row -> zeros', async () => {
  const { result } = await runDays();
  const [d18, d19] = result.days;
  eq(d18.byLocation.browse, { views: 5276, engagedViews: 713, watchHours: 1 }, 'browse');
  eq([d18.byLocation.other.views, d18.byLocation.other.engagedViews], [24, 17], 'other summed');
  near(d18.byLocation.other.watchHours, 0.1, 'other hours');
  eq(d18.otherLocations, ['EXTERNAL_APP', 'SEARCH'], 'other names');
  eq(d19.byLocation.browse, { views: 0, engagedViews: 0, watchHours: 0 }, 'no BROWSE row on the 19th');
  eq(d19.otherLocations, [], 'nothing folded on the 19th');
});

check('per-day: the location enum is read from whatever its one holder is; a stray day or duplicate is refused', async () => {
  eq((await runDays(perLocation(LOC_ROWS, 'strings'))).result.ok, true, 'strings holder');
  const stray = (await runDays(perLocation([[20261001, 'BROWSE', 1, 1, 0]]))).result;
  eq([stray.ok, stray.code], [false, 'MISSING_VALUE'], 'stray day');
  const dup = (await runDays(perLocation([[20261018, 'BROWSE', 1, 1, 0], [20261018, 'BROWSE', 1, 1, 0]]))).result;
  eq([dup.ok, dup.code], [false, 'MISSING_VALUE'], 'duplicate');
});

// ---------------------------------------------------------------- validators + store rule

function v1Day(day, extra = {}) {
  const src = { impressions: null, impressionsCtr: null, views: 0 };
  const bySource = {};
  for (const k of ['browse', 'suggested', 'search', 'channel', 'playlist', 'direct', 'external', 'notification', 'shorts', 'endScreen', 'other']) bySource[k] = { ...src };
  return {
    schemaVersion: 1, channelId: CH, day, capturedAt: '2026-10-21T12:00:00.000Z', source: 'studio-extension',
    impressions: 1000, impressionsCtr: 5, views: 200, watchHours: 10, newViewers: 50, returningViewers: 100, subsNetChange: 3,
    bySource, otherSources: [], ...extra,
  };
}
function v2Day(day, extra = {}) {
  const loc = { views: 0, engagedViews: 0, watchHours: 0 };
  return {
    ...v1Day(day), schemaVersion: 2, engagedViews: 90, estimatedEarnings: 1.5, cpm: null,
    likes: 1, comments: 0, shares: 0, subsGained: 2, subsLost: 0,
    byLocation: { browse: { ...loc }, watch: { ...loc }, shortsFeed: { ...loc }, channel: { ...loc }, embedded: { ...loc }, other: { ...loc } },
    otherLocations: [], ...extra,
  };
}

check('validators: v1 and v2 days and snapshots each checked to their own shape', () => {
  eq(validateChannelDay(v1Day('2026-10-18')), [], 'v1 day');
  eq(validateChannelDay(v2Day('2026-10-18')), [], 'v2 day');
  const noEngaged = v2Day('2026-10-18'); delete noEngaged.engagedViews;
  if (!validateChannelDay(noEngaged).some((r) => r.includes('engagedViews'))) throw new Error('v2 without engagedViews accepted');
  const badLoc = v2Day('2026-10-18'); badLoc.byLocation.watch = { views: 1 };
  if (!validateChannelDay(badLoc).some((r) => r.includes('byLocation.watch'))) throw new Error('bad location accepted');
  if (!validateChannelDay(v1Day('2026-10-18', { engagedViews: 5 })).some((r) => r.includes('schemaVersion 2 field'))) throw new Error('mislabeled v1 day accepted');
  const snap = { schemaVersion: 1, videoId: 'x', channelId: CH, capturedAt: '2026-10-21T00:00:00Z', source: 'studio-extension', videoAgeHours: 5,
    impressions: null, impressionsCtr: null, views: 1, watchHours: 0, avgViewDurationSec: null, avgPctViewed: null, retention: null,
    trafficShare: null, ctrBySource: null, topSearchTerms: null, subsGained: null, likes: null, comments: null, shares: null };
  eq(validateSnapshot(snap), [], 'v1 snapshot');
  if (!validateSnapshot({ ...snap, schemaVersion: 2 }).some((r) => r.includes('engagedViews'))) throw new Error('v2 snapshot without engagedViews accepted');
  if (!validateSnapshot({ ...snap, cpm: 1 }).some((r) => r.includes('schemaVersion 2 field'))) throw new Error('mislabeled v1 snapshot accepted');
});

check('store: a v2 day replaces a v1; a v1 never replaces a v2; other v1 days stay v1', async () => {
  const store = new AnalyticsStoreService(path.join(TMP, 'store-days'));
  await store.upsertChannelDays([v1Day('2026-10-17'), v1Day('2026-10-18')]);
  eq(await store.upsertChannelDays([v2Day('2026-10-18')]), 1, 'v2 written');
  eq(await store.upsertChannelDays([v1Day('2026-10-18', { views: 1 })]), 0, 'v1 over v2 not written');
  eq(store.loadChannelDays(CH).map((d) => [d.day, d.schemaVersion, d.views]), [['2026-10-17', 1, 200], ['2026-10-18', 2, 200]], 'stored');
});

// ---------------------------------------------------------------- outbox

function installChrome() {
  const data = {};
  global.chrome = { storage: { local: {
    get: async (key) => (key in data ? { [key]: JSON.parse(JSON.stringify(data[key])) } : {}),
    set: async (obj) => { for (const [k, v] of Object.entries(obj)) data[k] = JSON.parse(JSON.stringify(v)); },
  } } };
  return data;
}

check('outbox: one channel-days entry per channel; days the newer fetch lacks are carried, others replaced', async () => {
  installChrome();
  const other = 'UCotherotherotherother00';
  await outbox.enqueueChannelDays([v2Day('2026-10-01'), v2Day('2026-10-02', { views: 1 })]);
  await outbox.enqueueChannelDays([{ ...v2Day('2026-10-01'), channelId: other }]);
  await outbox.enqueueChannelDays([v2Day('2026-10-02', { views: 2 }), v2Day('2026-10-03')]);
  const entries = await outbox.getOutbox();
  eq(entries.map((e) => [e.kind, e.days.map((d) => `${d.channelId === CH ? 'me' : 'other'}:${d.day}`)]), [
    ['channel-days', ['other:2026-10-01']],
    ['channel-days', ['me:2026-10-01', 'me:2026-10-02', 'me:2026-10-03']],
  ], 'entries');
  eq(entries[1].days.find((d) => d.day === '2026-10-02').views, 2, 'the newer fetch of a day wins');
  delete global.chrome;
});

check('payload: a 400-day v2 window for three channels fits the 10 MB chrome.storage.local quota with room', () => {
  // Realistic magnitudes: 6-digit views, long float watch hours and CTRs, every source and location present.
  const big = (day, ch) => {
    const d = v2Day(day, { channelId: ch, capturedAt: '2026-10-21T16:03:05.347Z', views: 123456, engagedViews: 54321,
      watchHours: 12345.678901234567, impressions: 2345678, impressionsCtr: 5.123456789, estimatedEarnings: 1234.567, cpm: 16.501,
      likes: 1234, comments: 123, shares: 45, subsGained: 678, subsLost: 90, otherSources: ['HASHTAGS', 'YT_OTHER_PAGE'], otherLocations: ['SEARCH', 'YT_OTHER'] });
    for (const k of Object.keys(d.bySource)) d.bySource[k] = { impressions: 1234567, impressionsCtr: 4.987654321, views: 12345 };
    for (const k of Object.keys(d.byLocation)) d.byLocation[k] = { views: 12345, engagedViews: 6789, watchHours: 1234.5678901234567 };
    return d;
  };
  const days = [];
  for (const ch of ['UCa', 'UCb', 'UCc']) for (let i = 0; i < 400; i++) days.push(big(compare.shiftDay('2026-10-21', i), ch));
  const bytes = Buffer.byteLength(JSON.stringify(days));
  console.log(`      (3 channels x 400 days, v2: ${(bytes / 1e6).toFixed(2)} MB; one row ${Buffer.byteLength(JSON.stringify(days[0]))} B)`);
  if (bytes > 3e6) throw new Error(`${bytes} bytes is more than the 3 MB budget for the days in the outbox`);
});

// ---------------------------------------------------------------- ages + first weeks

const cat = (videoId, publishedAt, extra = {}) => ({ videoId, title: videoId, publishedAt, durationSec: 600, privacy: 'PUBLIC', isLive: false, isShort: false, thumbnailUrl: null, ...extra });

check('snapshot ages come from the catalogue; a video without a publish date keeps -1; a bad date throws', async () => {
  const snaps = [{ videoId: 'a', capturedAt: '2026-10-21T12:00:00.000Z', videoAgeHours: -1 }, { videoId: 'b', capturedAt: '2026-10-21T12:00:00.000Z', videoAgeHours: -1 }];
  const aged = collector.withVideoAges(snaps, [cat('a', '2026-10-14T12:00:00.000Z'), cat('b', '')], CH);
  eq(aged.map((s) => s.videoAgeHours), [168, -1], 'ages');
  await throwsLike(() => collector.withVideoAges(snaps, [cat('a', 'soon')], CH), /cannot age/, 'bad date');
});

check('first weeks: long/live only, closed + settled, within the lookback, not sent; one window per local day, newest first, capped', () => {
  const now = new Date(2026, 9, 21, 15, 0);   // 2026-10-21 local
  const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h).toISOString();
  const catalogue = [
    cat('due1', at(2026, 10, 11)), cat('due2', at(2026, 10, 11, 20)),   // 7 + 3 days before today exactly
    cat('live', at(2026, 10, 5), { isLive: true }),
    cat('short', at(2026, 10, 5), { isShort: true }),
    cat('fresh', at(2026, 10, 12)),                                       // closes, but not settled
    cat('sent', at(2026, 10, 1)),
    cat('old', at(2026, 4, 3)),                                           // 201 days: outside the 200-day lookback
    cat('edge', at(2026, 4, 4)),                                          // exactly 200 days
    cat('unpublished', ''),
  ];
  const plan = collector.planFirstWeeks(catalogue, { sent: '2026-10-12T00:00:00Z' }, now, { lookbackDays: 200, settleDays: 3, maxWindows: 10 });
  eq(plan.map((w) => [w.firstDay, w.lastDay, w.startDateId, w.endDateId, w.videos.map((v) => v.videoId)]), [
    ['2026-10-11', '2026-10-17', 20261011, 20261018, ['due1', 'due2']],
    ['2026-10-05', '2026-10-11', 20261005, 20261012, ['live']],
    ['2026-04-04', '2026-04-10', 20260404, 20260411, ['edge']],
  ], 'plan');
  eq(collector.planFirstWeeks(catalogue, {}, now, { lookbackDays: 200, settleDays: 3, maxWindows: 2 }).map((w) => w.firstDay), ['2026-10-11', '2026-10-05'], 'capped, newest first');
  let threw = false;
  try { collector.planFirstWeeks([cat('bad', 'not a date')], {}, now, { lookbackDays: 200, settleDays: 3, maxWindows: 2 }); } catch { threw = true; }
  eq(threw, true, 'an unreadable publish date throws');
});

check('first weeks: one VIDEO query per window over exactly its seven days; only the wanted videos; no row -> zeros', async () => {
  const windows = [{ startDateId: 20261011, endDateId: 20261018, videoIds: ['due1', 'due2'] }];
  const { result, requests } = await inPage(collector.collectFirstWeeksInPage, [CH, { windows }], () => table(
    [{ type: 'VIDEO', holder: 'strings', values: ['other', 'due1'] }],
    [
      { type: 'AVERAGE_WATCH_PERCENTAGE', holder: 'percentages', values: [10, 35] },
      { type: 'EXTERNAL_VIEWS', holder: 'counts', values: [999, 800] },
      { type: 'ENGAGED_VIEWS', holder: 'counts', values: [999, 350] },
      { type: 'EXTERNAL_WATCH_TIME', holder: 'milliseconds', values: [0, 7200000] },
      { type: 'VIDEO_THUMBNAIL_IMPRESSIONS', holder: 'counts', values: [1, 9000] },
      { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', holder: 'percentages', values: [1, 6.1] },
    ],
  ));
  eq(result.ok, true, 'ok');
  eq([requests.length, requests[0].dimensions, requests[0].timeRange.dateIdRange, requests[0].restricts],
    [1, [{ type: 'VIDEO' }], { inclusiveStart: 20261011, exclusiveEnd: 20261018 }, [{ dimension: { type: 'USER' }, inValues: [CH] }]], 'request');
  eq(Object.keys(result.windows[0].rows), ['due1'], 'only wanted rows');
  const plan = [{ firstDay: '2026-10-11', lastDay: '2026-10-17', startDateId: 20261011, endDateId: 20261018,
    videos: [{ videoId: 'due1', publishedAt: '2026-10-11T16:00:00.000Z' }, { videoId: 'due2', publishedAt: '2026-10-11T20:00:00.000Z' }] }];
  const records = collector.toFirstWeeks(plan, result.windows, CH, '2026-10-21T12:00:00.000Z');
  eq(records.map((r) => [r.videoId, r.views, r.engagedViews, r.watchHours, r.impressionsCtr, r.avgPctViewed]),
    [['due1', 800, 350, 2, 6.1, 35], ['due2', 0, 0, 0, null, null]], 'records');
  for (const r of records) eq(validateVideoFirstWeek(r), [], `validator ${r.videoId}`);
  await throwsLike(() => collector.toFirstWeeks(plan, [], CH, 'x'), /no window starting 2026-10-11/, 'missing window');
});

check('POST /analytics/first-weeks upserts by video, refuses a bad record with details, and re-distills', async () => {
  const store = new AnalyticsStoreService(path.join(TMP, 'store-fw'));
  let distills = 0;
  const server = new IngestServerService(store, 0, { runDistillation: async () => { distills++; } });
  await server.start();
  const rec = { schemaVersion: 1, videoId: 'v1', channelId: CH, publishedAt: '2026-10-01T12:00:00Z', firstDay: '2026-10-01', lastDay: '2026-10-07',
    capturedAt: '2026-10-21T00:00:00Z', source: 'studio-extension', views: 10, engagedViews: 5, watchHours: 1, impressions: null, impressionsCtr: null, avgPctViewed: null };
  const post = (body) => new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port: server.server.address().port, path: '/analytics/first-weeks', method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let text = ''; res.on('data', (c) => (text += c)); res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject); req.end(JSON.stringify(body));
  });
  try {
    eq(await post({ firstWeeks: [rec] }), { status: 200, body: { accepted: 1 } }, 'accepted');
    const bad = await post({ firstWeeks: [{ ...rec, lastDay: '2026-10-09' }] });
    eq([bad.status, bad.body.error], [400, 'VideoFirstWeekValidationError'], 'refused');
    includes(bad.body.details.join(' '), 'firstDay + 6', 'details');
    eq(store.loadFirstWeeks(CH).map((r) => r.videoId), ['v1'], 'stored');
    await new Promise((r) => setTimeout(r, 4300));
    eq(distills, 1, 're-distillations');
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------- distillation + render

const snapAt = (capturedAt, views, extra = {}) => ({ schemaVersion: 1, capturedAt, views, ...extra });

check('lifetime engaged views: latest v2; else views of a snapshot from before 2026-08-27; else null (never a ratio)', () => {
  eq(lifetimeEngagedViews([snapAt('2026-08-01T00:00:00Z', 100), snapAt('2026-10-21T00:00:00Z', 900, { schemaVersion: 2, engagedViews: 300 })]), 300, 'v2');
  eq(lifetimeEngagedViews([snapAt('2026-08-01T00:00:00Z', 100), snapAt('2026-08-26T23:59:59Z', 120)]), 120, 'before the change');
  eq(lifetimeEngagedViews([snapAt('2026-08-01T00:00:00Z', 100), snapAt('2026-08-27T00:00:00Z', 400)]), null, 'gap snapshot is latest');
  eq(lifetimeEngagedViews([]), null, 'none');
});

check('verdicts, baselines and the render: first-week engaged views from the seven-day record, measure stated, gaps said', () => {
  const NOW = Date.now();
  const iso = (ms) => new Date(ms).toISOString();
  const DAY = 86_400_000;
  const videos = [
    { videoId: 'a', channelId: CH, publishedAt: iso(NOW - 20 * DAY), durationSec: 900, format: 'long', titleHistory: [{ title: 'Alpha', from: iso(NOW - 20 * DAY), to: null, origin: 'upload' }] },
    { videoId: 'b', channelId: CH, publishedAt: iso(NOW - 40 * DAY), durationSec: 900, format: 'long', titleHistory: [{ title: 'Bravo', from: iso(NOW - 40 * DAY), to: null, origin: 'upload' }] },
    { videoId: 'c', channelId: CH, publishedAt: iso(NOW - 4 * DAY), durationSec: 900, format: 'long', titleHistory: [{ title: 'Charlie', from: iso(NOW - 4 * DAY), to: null, origin: 'upload' }] },
  ];
  const base = { channelId: CH, source: 'studio-extension', videoAgeHours: -1, impressions: 5000, impressionsCtr: 5, watchHours: 1, avgViewDurationSec: null,
    avgPctViewed: 40, retention: null, trafficShare: null, ctrBySource: null, topSearchTerms: null, subsGained: null, likes: null, comments: null, shares: null };
  const snapshots = [
    { ...base, schemaVersion: 2, videoId: 'a', capturedAt: iso(NOW), views: 9000, engagedViews: 3000, estimatedEarnings: 10, cpm: 12, subsLost: 0 },
    { ...base, schemaVersion: 1, videoId: 'b', capturedAt: iso(NOW - DAY), views: 7000 },
    { ...base, schemaVersion: 2, videoId: 'c', capturedAt: iso(NOW), views: 500, engagedViews: 200, estimatedEarnings: null, cpm: null, subsLost: null },
  ];
  const firstWeeks = [
    { videoId: 'a', firstDay: '2026-10-01', views: 5000, engagedViews: 1500, impressions: 40000, impressionsCtr: 6, avgPctViewed: 38 },
    { videoId: 'b', firstDay: '2026-09-11', views: 2500, engagedViews: 900, impressions: 30000, impressionsCtr: 4, avgPctViewed: 33 },
  ];
  let verdicts = [];
  const store = {
    listVideos: () => videos, loadVerdicts: () => verdicts, loadAbTests: () => [], loadFirstWeeks: () => firstWeeks,
    *iterateSnapshots() { for (const s of snapshots) yield s; },
    listChannels: () => [{ channelId: CH, name: 'Engaged', promptSets: [] }],
  };
  const service = new DistillationService(store);
  verdicts = service.computeVerdicts(CH);
  const byId = Object.fromEntries(verdicts.map((v) => [v.videoId, v]));
  eq([byId.a.lifetime.engagedViews, byId.b.lifetime.engagedViews, byId.c.lifetime.engagedViews], [3000, null, 200], 'lifetime engaged');
  eq([byId.a.firstSevenDays.engagedViews, byId.b.firstSevenDays.ctr, byId.c.firstSevenDays], [1500, 4, null], 'first seven days');
  const insights = service.computeChannelInsights(CH);
  eq(insights.baselines.medianFirstWeekEngagedViews, 1200, 'median first-7-day engaged views');
  const recent = Object.fromEntries(insights.recentUploads.map((s) => [s.title, s]));
  eq([recent.Alpha.basis, recent.Alpha.engagedViews, recent.Alpha.ctr], ['first-week', 1500, 6], 'Alpha');
  eq([recent.Charlie.basis, recent.Charlie.engagedViews], ['lifetime', 200], 'Charlie (first week not closed)');
  const block = buildInsightsBlock(insights, { computedAt: iso(NOW), channelIds: [CH], risingSearchTerms: [], aiBrief: null,
    recentOverperformers: [{ channelId: CH, title: 'Bravo', packagingScore: 90, views: 7000, engagedViews: null }] }, []);
  includes(block, 'Every view count below is ENGAGED views', 'measure line');
  includes(block, 'engaged views in the first 7 days 1,200', 'baselines');
  includes(block, '"Alpha" — published', 'recent line');
  includes(block, '1,500 engaged views (first 7 days)', 'first-week engaged');
  includes(block, '200 engaged views (lifetime)', 'lifetime engaged');
  includes(block, '"Bravo" — packaging score 90, engaged views not measured (lifetime)', 'a gap is said');
  if (/\b9,000 views\b|\b7,000 views\b/.test(block)) throw new Error('raw views rendered as a comparison number');
});

check('stale insights or verdicts from before engaged views throw, naming the re-run', async () => {
  const stale = { channelId: CH, computedAt: new Date().toISOString(), videoCount: 0, recentUploads: [], topPackaging: [], bottomPackaging: [],
    baselines: { medianCtrFirstWeek: null, medianAvgPctViewed: null, medianRetention30s: null, medianFirstWeekViews: null },
    abTitleRules: { channelId: CH, channelName: 'x', derivedAt: new Date().toISOString(), decidedTests: 0, earliestDecidedAt: null, latestDecidedAt: null, rules: [], observations: [], exemplars: [] },
    topSearchTerms: [], aiBrief: null };
  await throwsLike(() => buildInsightsBlock(stale, null, []), /before engaged views; re-run distillation/, 'insights');
  const store = { loadVerdicts: () => [{ videoId: 'old', lifetime: { views: 1 } }], listVideos: () => [], listChannels: () => [] };
  await throwsLike(() => new DistillationService(store).computeChannelInsights(CH), /predates engaged views/, 'verdicts');
});

// ---------------------------------------------------------------- the Analytics card

check('card: engaged views, earnings and revenue per 1,000 engaged over 7-vs-7; a v1 day makes them n/a', () => {
  const TODAY = '2026-10-21';
  const mk = (day, v2, engaged, earnings) => ({
    day, schemaVersion: v2 ? 2 : 1, impressions: 100, impressionsCtr: 5, views: 1000, newViewers: null, subsNetChange: 0,
    bySource: { browse: { impressions: 10, impressionsCtr: 1, views: 500 }, suggested: { impressions: null, impressionsCtr: null, views: 0 }, search: { impressions: null, impressionsCtr: null, views: 0 } },
    ...(v2 ? { engagedViews: engaged, estimatedEarnings: earnings, byLocation: { browse: { views: 1, engagedViews: 1 } } } : {}),
  });
  const days = [];
  for (let i = 1; i <= 14; i++) days.push(mk(compare.shiftDay(TODAY, i), true, i <= 7 ? 500 : 400, i <= 7 ? 5 : 2));
  const r = compare.compareSevenDays(days, TODAY);
  eq([r.last.engagedViews, r.prior.engagedViews, r.last.earnings, r.prior.earnings], [3500, 2800, 35, 14], 'sums');
  near(r.last.revenuePerThousandEngaged, 10, 'rpm last'); near(r.prior.revenuePerThousandEngaged, 5, 'rpm prior');
  near(r.change.engagedViews, 25, 'engaged change'); near(r.change.revenuePerThousandEngaged, 100, 'rpm change');
  days[10] = mk(days[10].day, false);
  const mixed = compare.compareSevenDays(days, TODAY);
  eq([mixed.prior.engagedViews, mixed.prior.earnings, mixed.prior.revenuePerThousandEngaged, mixed.change.engagedViews], [null, null, null, null], 'a v1 day in the window');
  eq(compare.dayTableRows(days, TODAY, 14).find((row) => row.day === days[10].day).engagedViews, null, 'v1 table row');
});

check('card: weekly rows end yesterday, newest first; a week missing a day has no totals and says how many it has', () => {
  const TODAY = '2026-10-21';
  const days = [];
  for (let i = 1; i <= 20; i++) {
    days.push({ day: compare.shiftDay(TODAY, i), schemaVersion: 2, impressions: null, impressionsCtr: null, views: 100, newViewers: null, subsNetChange: null,
      bySource: { browse: { impressions: null, impressionsCtr: null, views: 60 }, suggested: { impressions: null, impressionsCtr: null, views: 0 }, search: { impressions: null, impressionsCtr: null, views: 0 } },
      engagedViews: 40, estimatedEarnings: 0.4, byLocation: { browse: { views: 50, engagedViews: 10 } } });
  }
  const weeks = compare.weeklyRows(days, TODAY, 3);
  eq(weeks.map((w) => [w.from, w.to, w.daysStored, w.views, w.engagedViews, w.browseViews]), [
    ['2026-10-14', '2026-10-20', 7, 700, 280, 420],
    ['2026-10-07', '2026-10-13', 7, 700, 280, 420],
    ['2026-09-30', '2026-10-06', 6, null, null, null],
  ], 'weeks');
  near(weeks[0].earnings, 2.8, 'earnings'); near(weeks[0].revenuePerThousandEngaged, 10, 'rpm');
});

(async () => {
  let failures = 0;
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
  console.log(failures === 0 ? `\nAll ${pending.length} engaged-views checks passed.` : `\n${failures} of ${pending.length} checks FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
