#!/usr/bin/env node
/**
 * Channel days: the per-channel per-day series behind the Analytics page's Home feed card.
 * Covers validateChannelDay (a good row passes, a bad one lists every failing field), the
 * extension's Studio -> ChannelDay mapping run against canned Studio responses (SUBSCRIBER ->
 * browse, an unknown enum folded into `other` AND named in otherSources, a missing source row
 * -> 0 views / null impressions, new+returning 0,0 with views -> null, a missing column -> a
 * named failure), the store's upsert by day, POST /analytics/days on a real localhost server,
 * and the week-on-week arithmetic the card shows. Offline: no Studio, no Electron, temp folder
 * removed at the end.
 *
 *   npm run build:electron && node tools/channel-days-checks.js
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
const ROOT = path.join(__dirname, '..', 'dist', 'main');
const storeModule = require(path.join(ROOT, 'services/analytics/analytics-store.service.js'));
const { IngestServerService } = require(path.join(ROOT, 'services/analytics/ingest-server.service.js'));
const { validateChannelDay, AnalyticsStoreService } = storeModule;

/**
 * The extension collector and the frontend helper are not part of dist/main, so each is
 * transpiled from its own shipped source — a mirror could drift, this cannot. The collector's
 * runtime imports (catalogue, collection-state) are stubbed: nothing at module load touches
 * them, and the injected function under test closes over nothing by design.
 */
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
const compare = transpile('frontend/src/app/components/analytics/channel-days-compare.ts');

let failures = 0;
const pending = [];
function check(name, fn) {
  pending.push(fn);
  pending[pending.length - 1].label = name;
}
function eq(a, e, what) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what} expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function near(a, e, what) { if (a === null || Math.abs(a - e) > 1e-9) throw new Error(`${what} expected ${e}, got ${a}`); }

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-channel-days-'));
const CHANNEL = 'UCtesttesttesttesttest00';

const src = (impressions, impressionsCtr, views) => ({ impressions, impressionsCtr, views });
function goodDay(day, extra = {}) {
  return {
    schemaVersion: 1, channelId: CHANNEL, day, capturedAt: '2026-10-21T12:00:00.000Z', source: 'studio-extension',
    impressions: 1000, impressionsCtr: 5, views: 200, watchHours: 10,
    newViewers: 50, returningViewers: 100, subsNetChange: 3,
    bySource: {
      browse: src(600, 6, 100), suggested: src(300, 4, 50), search: src(null, null, 0), channel: src(null, null, 0),
      playlist: src(null, null, 0), direct: src(null, null, 0), external: src(null, null, 10),
      notification: src(null, null, 0), shorts: src(null, null, 0), endScreen: src(null, null, 0), other: src(10, 100, 10),
    },
    otherSources: ['HASHTAGS'],
    ...extra,
  };
}

// ---------------------------------------------------------------- validation

check('validateChannelDay accepts a good row', () => {
  eq(validateChannelDay(goodDay('2026-10-18')), [], 'reasons');
  eq(validateChannelDay(goodDay('2026-10-18', { newViewers: null, returningViewers: null, subsNetChange: null })), [], 'null cohort reasons');
});

check('validateChannelDay lists every bad field, not just the first', () => {
  const bad = goodDay('2026-10-18', {
    schemaVersion: 3, day: '2026-10-18T00:00', views: null, newViewers: 'many', capturedAt: 'yesterday',
  });
  bad.bySource = { ...bad.bySource, browse: { impressions: 0, impressionsCtr: null } };
  bad.otherSources = [''];
  const reasons = validateChannelDay(bad);
  const want = ['schemaVersion', 'day must', 'capturedAt', 'views must', 'newViewers', 'bySource.browse', 'otherSources'];
  for (const w of want) if (!reasons.some((r) => r.includes(w))) throw new Error(`no reason mentions "${w}": ${JSON.stringify(reasons)}`);
  eq(reasons.length, want.length, 'reason count');
});

// ---------------------------------------------------------------- the collector's mapping

/** A Studio resultTable: dims as {type, holder, values}, metrics as {type, holder, values}. */
function table(dims, metrics) {
  return {
    results: [{ key: 'TABLE_QUERY', value: { resultTable: {
      dimensionColumns: dims.map((d) => ({ dimension: { type: d.type }, [d.holder]: { values: d.values } })),
      metricColumns: metrics.map((m) => ({
        metric: { type: m.type }, [m.holder]: { values: m.values },
        ...(m.undef ? { undefinedValueIndices: m.undef, columnAnomalies: { ids: [] } } : {}),
      })),
    } } }],
  };
}

const PER_DAY = (omit) => table(
  [{ type: 'DAY', holder: 'dateIds', values: [20261020, 20261018, 20261019] }],
  [
    // Deliberately NOT in request order: columns are matched by type, never index.
    { type: 'SUBSCRIBERS_NET_CHANGE', holder: 'counts', values: [0, 3, -1] },
    { type: 'EXTERNAL_VIEWS', holder: 'counts', values: [0, 200, 150] },
    { type: 'VIDEO_THUMBNAIL_IMPRESSIONS', holder: 'counts', values: [40, 1000, 900] },
    { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', holder: 'percentages', values: [0, 5, 4.5] },
    { type: 'EXTERNAL_WATCH_TIME', holder: 'milliseconds', values: [0, 36000000, 7200000] },
    { type: 'NEW_VIEWERS', holder: 'counts', values: [0, 50, 0] },
    { type: 'RETURNING_VIEWERS', holder: 'counts', values: [0, 100, 0] },
    // 0.2.11 columns (their own checks are in tools/engaged-views-checks.js).
    { type: 'ENGAGED_VIEWS', holder: 'counts', values: [0, 120, 90] },
    { type: 'TOTAL_ESTIMATED_EARNINGS', holder: 'earnings', values: [0, 2500, 1800] },
    { type: 'CPM', holder: 'earnings', values: [0, 9000, 8000], undef: [0] },
    { type: 'RATINGS_LIKES', holder: 'counts', values: [0, 10, 8] },
    { type: 'COMMENTS', holder: 'counts', values: [0, 2, 1] },
    { type: 'SHARINGS', holder: 'counts', values: [0, 1, 0] },
    { type: 'SUBSCRIBERS_GAINED', holder: 'counts', values: [0, 4, 1] },
    { type: 'SUBSCRIBERS_LOST', holder: 'counts', values: [0, 1, 2] },
  ].filter((m) => m.type !== omit),
);

const PER_LOCATION = table(
  [
    { type: 'DAY', holder: 'dateIds', values: [20261018, 20261019] },
    { type: 'PLAYBACK_LOCATION_TYPE', holder: 'enumValues', values: ['BROWSE', 'WATCH'] },
  ],
  [
    { type: 'EXTERNAL_VIEWS', holder: 'counts', values: [150, 150] },
    { type: 'ENGAGED_VIEWS', holder: 'counts', values: [70, 90] },
    { type: 'EXTERNAL_WATCH_TIME', holder: 'milliseconds', values: [3600000, 7200000] },
  ],
);

const ROWS = [
  // day, source, impressions, ctr, views
  [20261018, 'SUBSCRIBER', 600, 6, 100],
  [20261018, 'YT_RELATED', 300, 4, 50],
  [20261018, 'EXT_URL', null, null, 10],
  [20261018, 'HASHTAGS', null, null, 5],
  [20261018, 'YT_OTHER_PAGE', 10, null, 3],
  [20261018, 'BRAND_NEW_SOURCE', null, null, 2],
  [20261019, 'SUBSCRIBER', 500, 5, 90],
  [20261019, 'YT_SEARCH', 200, 10, 60],
];
const PER_SOURCE = table(
  [
    { type: 'DAY', holder: 'dateIds', values: ROWS.map((r) => r[0]) },
    { type: 'TRAFFIC_SOURCE_TYPE', holder: 'enumValues', values: ROWS.map((r) => r[1]) },
  ],
  [
    { type: 'VIDEO_THUMBNAIL_IMPRESSIONS', holder: 'counts', values: ROWS.map((r) => r[2]) },
    { type: 'VIDEO_THUMBNAIL_IMPRESSIONS_VTR', holder: 'percentages', values: ROWS.map((r) => r[3]) },
    { type: 'EXTERNAL_VIEWS', holder: 'counts', values: ROWS.map((r) => r[4]) },
  ],
);

/** Run the injected function against a fake Studio page; returns { result, requests }. */
async function runCollector({ perDay = PER_DAY(), perSource = PER_SOURCE, perLocation = PER_LOCATION } = {}) {
  const requests = [];
  const saved = { window: global.window, document: global.document, fetch: global.fetch };
  global.window = { ytcfg: { get: (k) => ({
    INNERTUBE_CONTEXT: { client: { clientVersion: '1.20261020.00.00', visitorData: 'v' } },
    CHANNEL_ID: CHANNEL,
    INNERTUBE_CONTEXT_SERIALIZED_DELEGATION_CONTEXT: 'deleg',
    SESSION_INDEX: 1,
  })[k] } };
  global.document = { cookie: 'SAPISID=abc123' };
  global.fetch = async (url, init) => {
    const body = JSON.parse(init.body);
    requests.push({ url, headers: init.headers, query: body.nodes[0].value.query });
    const dims = body.nodes[0].value.query.dimensions.map((d) => d.type).join(',');
    const data = dims === 'DAY' ? perDay : dims === 'DAY,TRAFFIC_SOURCE_TYPE' ? perSource : perLocation;
    return { status: 200, ok: true, json: async () => data };
  };
  try {
    const result = await collector.collectChannelDaysInPage(CHANNEL, { windowDays: 35 });
    return { result, requests };
  } finally {
    Object.assign(global, saved);
  }
}

check('the requests: DAY, DAY x TRAFFIC_SOURCE_TYPE, DAY x PLAYBACK_LOCATION_TYPE, the asked window ending tomorrow', async () => {
  const { result, requests } = await runCollector();
  eq(result.ok, true, 'ok');
  eq(requests.length, 3, 'request count');
  eq(requests[2].query.dimensions, [{ type: 'DAY' }, { type: 'PLAYBACK_LOCATION_TYPE' }], 'q3 dims');
  eq(requests[0].query.dimensions, [{ type: 'DAY' }], 'q1 dims');
  eq(requests[1].query.dimensions, [{ type: 'DAY' }, { type: 'TRAFFIC_SOURCE_TYPE' }], 'q2 dims');
  eq(requests[0].query.restricts, [{ dimension: { type: 'USER' }, inValues: [CHANNEL] }], 'restrict');
  eq(requests[0].headers['X-YouTube-Delegation-Context'], 'deleg', 'delegation header');
  const id = (d) => d.getFullYear() * 10000 + (d.getMonth() + 1) * 100 + d.getDate();
  const now = new Date();
  eq(requests[0].query.timeRange.dateIdRange, {
    inclusiveStart: id(new Date(now.getFullYear(), now.getMonth(), now.getDate() - 34)),
    exclusiveEnd: id(new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1)),
  }, 'window');
});

check('Studio -> ChannelDay: SUBSCRIBER is browse, unknown enums fold into other and are named', async () => {
  const { result } = await runCollector();
  eq(result.days.map((d) => d.day), ['2026-10-18', '2026-10-19', '2026-10-20'], 'ascending days');
  const d18 = result.days[0];
  eq(d18.bySource.browse, { impressions: 600, impressionsCtr: 6, views: 100 }, 'browse');
  eq(d18.bySource.suggested, { impressions: 300, impressionsCtr: 4, views: 50 }, 'suggested');
  eq(d18.bySource.external, { impressions: null, impressionsCtr: null, views: 10 }, 'external without impressions');
  // other = HASHTAGS(5, no impr) + YT_OTHER_PAGE(3, 10 impr) + BRAND_NEW_SOURCE(2, no impr)
  eq(d18.bySource.other.views, 10, 'other views summed');
  eq(d18.bySource.other.impressions, 10, 'other impressions summed over the rows that have them');
  near(d18.bySource.other.impressionsCtr, 100, 'other ctr = views / impressions');
  eq(d18.otherSources, ['BRAND_NEW_SOURCE', 'HASHTAGS', 'YT_OTHER_PAGE'], 'otherSources sorted');
  eq(d18.watchHours, 10, 'watch ms -> hours');
  eq([d18.newViewers, d18.returningViewers, d18.subsNetChange], [50, 100, 3], 'cohorts kept');
});

check('a source with no row that day is 0 views and null impressions; other with none is empty', async () => {
  const { result } = await runCollector();
  const d18 = result.days[0];
  eq(d18.bySource.search, { impressions: null, impressionsCtr: null, views: 0 }, 'search on 18th');
  const d19 = result.days[1];
  eq(d19.bySource.search, { impressions: 200, impressionsCtr: 10, views: 60 }, 'search on 19th');
  eq(d19.bySource.other, { impressions: null, impressionsCtr: null, views: 0 }, 'other on 19th');
  eq(d19.otherSources, [], 'no other names on 19th');
  eq(result.days[2].bySource.browse, { impressions: null, impressionsCtr: null, views: 0 }, 'a day with no source rows');
});

check('new/returning 0,0 with views is "not computed yet" (null); 0,0 with no views stays 0', async () => {
  const { result } = await runCollector();
  eq([result.days[1].newViewers, result.days[1].returningViewers], [null, null], '19th: views 150, cohorts 0/0');
  eq([result.days[2].newViewers, result.days[2].returningViewers], [0, 0], '20th: no views at all');
});

check('undefinedValueIndices: an undefined CPM is null, never $0; an undefined required value fails', async () => {
  const { result } = await runCollector();
  eq(result.days.map((d) => d.cpm), [9, 8, null], 'cpm by day, ascending (the 20th is undefined)');
  const undefViews = table([{ type: 'DAY', holder: 'dateIds', values: [20261018] }], PER_DAY().results[0].value.resultTable.metricColumns.map((c) => {
    const type = c.metric.type;
    const holder = Object.keys(c).find((k) => k !== 'metric' && k !== 'undefinedValueIndices' && k !== 'columnAnomalies');
    return { type, holder, values: [c[holder].values[1]], undef: type === 'EXTERNAL_WATCH_TIME' ? [0] : undefined };
  }));
  const bad = (await runCollector({ perDay: undefViews })).result;
  eq([bad.ok, bad.code], [false, 'MISSING_VALUE'], 'undefined watch time');
});

check('every row the collector emits passes the ingest validator', async () => {
  const { result } = await runCollector();
  for (const d of result.days) eq(validateChannelDay(d), [], `reasons for ${d.day}`);
});

check('a missing required column is a named failure, never a guessed value', async () => {
  const { result } = await runCollector({ perDay: PER_DAY('NEW_VIEWERS') });
  eq(result.ok, false, 'ok');
  eq(result.code, 'MISSING_COLUMN', 'code');
  if (!result.message.includes('NEW_VIEWERS')) throw new Error(`message does not name the column: ${result.message}`);
  const noEnum = JSON.parse(JSON.stringify(PER_SOURCE));
  noEnum.results[0].value.resultTable.dimensionColumns[1].strings = noEnum.results[0].value.resultTable.dimensionColumns[1].enumValues;
  delete noEnum.results[0].value.resultTable.dimensionColumns[1].enumValues;
  const second = await runCollector({ perSource: noEnum });
  eq(second.result.code, 'MISSING_COLUMN', 'enumValues holder missing');
});

check('a source row for a day the per-day answer lacks is refused', async () => {
  const stray = JSON.parse(JSON.stringify(PER_SOURCE));
  stray.results[0].value.resultTable.dimensionColumns[0].dateIds.values[0] = 20261001;
  const { result } = await runCollector({ perSource: stray });
  eq(result.ok, false, 'ok');
  eq(result.code, 'MISSING_VALUE', 'code');
});

// ---------------------------------------------------------------- store

check('upsert replaces same-day rows, keeps the rest, and stays sorted by day', async () => {
  const store = new AnalyticsStoreService(path.join(TMP, 'store'));
  eq(store.loadChannelDays(CHANNEL), [], 'empty before');
  eq(await store.upsertChannelDays([goodDay('2026-10-19'), goodDay('2026-10-17')]), 2, 'first write');
  const revised = goodDay('2026-10-19', { newViewers: 70, returningViewers: 80, capturedAt: '2026-10-22T12:00:00.000Z' });
  eq(await store.upsertChannelDays([revised, goodDay('2026-10-18'), goodDay('2026-10-20')]), 3, 'second write');
  const stored = store.loadChannelDays(CHANNEL);
  eq(stored.map((d) => d.day), ['2026-10-17', '2026-10-18', '2026-10-19', '2026-10-20'], 'days');
  eq([stored[2].newViewers, stored[2].capturedAt], [70, '2026-10-22T12:00:00.000Z'], 'the 19th was replaced');
});

check('upsert is all-or-nothing: one bad row writes nothing', async () => {
  const store = new AnalyticsStoreService(path.join(TMP, 'store-bad'));
  let threw = null;
  try { await store.upsertChannelDays([goodDay('2026-10-18'), goodDay('2026-10-19', { views: -0 / 0 })]); } catch (e) { threw = e; }
  if (!threw || threw.name !== 'ChannelDayValidationError') throw new Error(`expected ChannelDayValidationError, got ${threw && threw.name}`);
  eq(store.loadChannelDays(CHANNEL), [], 'nothing written');
});

// ---------------------------------------------------------------- endpoint

function post(port, pathName, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ host: '127.0.0.1', port, path: pathName, method: 'POST', headers: { 'Content-Type': 'application/json' } }, (res) => {
      let text = '';
      res.on('data', (c) => (text += c));
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(text) }));
    });
    req.on('error', reject);
    req.end(payload);
  });
}

check('POST /analytics/days upserts, answers 400 with details on a bad row, and never re-distills', async () => {
  const store = new AnalyticsStoreService(path.join(TMP, 'store-http'));
  let distills = 0;
  const server = new IngestServerService(store, 0, { runDistillation: async () => { distills++; } });
  await server.start();
  try {
    const port = server.server.address().port;
    const ok = await post(port, '/analytics/days', { days: [goodDay('2026-10-18')] });
    eq(ok, { status: 200, body: { accepted: 1 } }, 'accepted');
    const bad = await post(port, '/analytics/days', { days: [goodDay('2026-10-19', { day: '19 Oct' })] });
    eq([bad.status, bad.body.error], [400, 'ChannelDayValidationError'], 'rejected');
    if (!bad.body.details.some((d) => d.includes('day must'))) throw new Error(`details: ${JSON.stringify(bad.body.details)}`);
    const shape = await post(port, '/analytics/days', { snapshots: [] });
    eq(shape.status, 400, 'wrong body shape');
    eq(store.loadChannelDays(CHANNEL).map((d) => d.day), ['2026-10-18'], 'stored');
    await new Promise((r) => setTimeout(r, 50));
    eq(distills, 0, 're-distillations');
  } finally {
    await server.stop();
  }
});

// ---------------------------------------------------------------- week on week

const TODAY = '2026-10-21';
function cmpDay(day, { views, browseViews, browseImpr, impressions, ctr }) {
  return {
    day, impressions, impressionsCtr: ctr, views, newViewers: null, subsNetChange: 0,
    bySource: { browse: src(browseImpr, null, browseViews), suggested: src(null, null, 0), search: src(null, null, 0) },
  };
}
function fortnight(overrides = {}) {
  const days = [];
  for (let i = 1; i <= 14; i++) {
    const day = compare.shiftDay(TODAY, i);
    const last = i <= 7;
    days.push(cmpDay(day, last
      ? { views: 150, browseViews: 90, browseImpr: 1200, impressions: 2000, ctr: 4 }
      : { views: 100, browseViews: 50, browseImpr: 1000, impressions: 2000, ctr: 5 }));
  }
  // Today: partial, and huge, so including it would be obvious.
  days.push(cmpDay(TODAY, { views: 99999, browseViews: 99999, browseImpr: 99999, impressions: 99999, ctr: 50 }));
  for (const [day, patch] of Object.entries(overrides)) Object.assign(days.find((d) => d.day === day), patch);
  return days;
}

check('7-vs-7: today excluded, sums and relative changes', () => {
  const r = compare.compareSevenDays(fortnight(), TODAY);
  eq(r.kind, 'ok', 'kind');
  eq([r.lastFrom, r.lastTo, r.priorFrom, r.priorTo], ['2026-10-14', '2026-10-20', '2026-10-07', '2026-10-13'], 'windows');
  eq([r.last.views, r.prior.views], [1050, 700], 'views');
  eq([r.last.browseViews, r.prior.browseViews], [630, 350], 'browse views');
  eq([r.last.browseImpressions, r.prior.browseImpressions], [8400, 7000], 'browse impressions');
  near(r.last.ctr, 4, 'last ctr'); near(r.prior.ctr, 5, 'prior ctr');
  near(r.change.views, 50, 'views change'); near(r.change.browseViews, 80, 'browse views change');
  near(r.change.browseImpressions, 20, 'browse impressions change'); near(r.change.ctr, -20, 'ctr change');
});

check('7-vs-7: CTR is impression-weighted', () => {
  const r = compare.compareSevenDays(fortnight({ '2026-10-20': { impressions: 14000, impressionsCtr: 1 } }), TODAY);
  // 6 days x 2000 @ 4% + 14000 @ 1% = 480 + 140 clicks over 26000 impressions
  near(r.last.ctr, (620 / 26000) * 100, 'weighted ctr');
});

check('7-vs-7: a null in a window makes that sum unknown, not smaller', () => {
  const r = compare.compareSevenDays(fortnight({ '2026-10-15': { bySource: { browse: src(null, null, 90), suggested: src(null, null, 0), search: src(null, null, 0) } } }), TODAY);
  eq([r.last.browseImpressions, r.change.browseImpressions], [null, null], 'browse impressions');
  eq(r.last.browseViews, 630, 'browse views unaffected');
});

check('7-vs-7: fewer than 14 full days says how many are there', () => {
  const days = fortnight().filter((d) => d.day !== '2026-10-09');
  eq(compare.compareSevenDays(days, TODAY), { kind: 'insufficient', available: 13, needed: 14 }, 'one missing');
  eq(compare.compareSevenDays([cmpDay(TODAY, { views: 1, browseViews: 1, browseImpr: 1, impressions: 1, ctr: 1 })], TODAY),
    { kind: 'insufficient', available: 0, needed: 14 }, 'only today');
});

check('7-vs-7: a prior of zero gives no percentage', () => {
  eq(compare.pctChange(10, 0), null, 'zero prior');
  eq(compare.pctChange(null, 5), null, 'null last');
});

check('table rows: newest first, today flagged, browse share', () => {
  const rows = compare.dayTableRows(fortnight(), TODAY, 14);
  eq(rows.length, 14, 'limit');
  eq([rows[0].day, rows[0].partial, rows[1].day, rows[1].partial], [TODAY, true, '2026-10-20', false], 'order');
  near(rows[1].browseShare, 60, 'browse share');
  eq(compare.dayTableRows([cmpDay('2026-10-01', { views: 0, browseViews: 0, browseImpr: null, impressions: null, ctr: null })], TODAY, 14)[0].browseShare, null, 'no views -> null share');
});

check('shiftDay crosses month and DST boundaries by calendar day', () => {
  eq(compare.shiftDay('2026-11-01', 1), '2026-10-31', 'month');
  eq(compare.shiftDay('2026-11-02', 1), '2026-11-01', 'US DST end');
  eq(compare.shiftDay('2026-03-09', 1), '2026-03-08', 'US DST start');
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
  console.log(failures === 0 ? `\nAll ${pending.length} channel-days checks passed.` : `\n${failures} of ${pending.length} checks FAILED.`);
  process.exit(failures === 0 ? 0 : 1);
})();
