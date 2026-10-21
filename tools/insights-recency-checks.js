#!/usr/bin/env node
/**
 * Recent evidence in the distiller's input (2026-10-21). The render is dated ("as of"
 * computedAt), lists every long/live upload of the last 90 days newest first (capped at 40,
 * the cut stated), and every decided A/B test of the same window newest first; old
 * insights.json without `recentUploads` is refused, not defaulted; and none of it reaches the
 * compact block generation carries. Offline: a duck-typed in-memory store, nothing on disk.
 *
 *   npm run build:electron && node tools/insights-recency-checks.js
 */
const path = require('path');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main', 'services', 'analytics');
const { DistillationService } = require(path.join(ROOT, 'distillation.service.js'));
const { buildInsightsBlock } = require(path.join(ROOT, 'insights-prompt.js'));
const { renderRecentAbTests } = require(path.join(ROOT, 'ab-title-rules.js'));
const guidelines = require(path.join(ROOT, 'insights-guidelines.js'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`ok   ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL ${name}\n     ${error.message}`);
  }
}
function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function throwsLike(fn, re, what) {
  try { fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${what}: threw "${e.message}", expected ${re}`); return; }
  throw new Error(`${what}: did not throw`);
}

const DAY = 24 * 60 * 60 * 1000;
const NOW = Date.now();
const iso = (ms) => new Date(ms).toISOString();
const CH = 'UCrecencyrecencyrecency0';

// 45 long uploads 1..45 days old, a live 2.5 days old, a short 3 days old (excluded), and a
// long 100 days old (outside the window). v001 has a first-week capture with a CTR; v002 has
// one without (so it reads lifetime).
const videos = [];
const verdicts = [];
function addVideo(id, ageDays, format, extra = {}) {
  const publishedAt = iso(NOW - ageDays * DAY);
  videos.push({ videoId: id, channelId: CH, publishedAt, durationSec: 1500, format, titleHistory: [] });
  verdicts.push({
    videoId: id, channelId: CH, publishedAt, titles: [`title ${id}`],
    firstWeek: extra.firstWeek ?? null,
    firstSevenDays: extra.firstSevenDays ?? null,
    lifetime: { impressions: 50000, ctr: 4 + ageDays / 100, views: 1000 * ageDays, watchHours: 1, subsGained: null, engagedViews: 400 * ageDays },
    ctrPercentile: 50, retentionPercentile: null, packagingScore: 50 + (ageDays % 7), outcome: 'typical',
    abTest: null, topSearchTerms: [],
  });
}
for (let d = 1; d <= 45; d++) {
  const id = `v${String(d).padStart(3, '0')}`;
  const extra = d === 1
    ? {
        firstWeek: { impressions: 9000, ctr: 6.1, views: 800, avgPctViewed: 33.3, retention30s: 70, dominantSource: 'browse' },
        firstSevenDays: { firstDay: '2026-10-01', views: 800, engagedViews: 350, impressions: 9000, ctr: 6.1, avgPctViewed: 33.3 },
      }
    : d === 2
      ? { firstWeek: { impressions: null, ctr: null, views: 0, avgPctViewed: null, retention30s: null, dominantSource: 'unknown' } }
      : {};
  addVideo(id, d, 'long', extra);
}
addVideo('live01', 2.5, 'live');
addVideo('short01', 3, 'short');
addVideo('old100', 100, 'long');

const snapshots = [
  // Lifetime avg % viewed comes from the latest snapshot that captured it.
  { videoId: 'v003', capturedAt: iso(NOW - 2 * DAY), avgPctViewed: 40.0, topSearchTerms: null },
  { videoId: 'v003', capturedAt: iso(NOW - 1 * DAY), avgPctViewed: 41.5, topSearchTerms: null },
  { videoId: 'v003', capturedAt: iso(NOW - 0.5 * DAY), avgPctViewed: null, topSearchTerms: null },
];

function abRecord(videoId, ageDays, winner, losers, lift) {
  return {
    videoId, channelId: CH, method: 'test-compare', decidedAt: iso(NOW - ageDays * DAY),
    variants: [winner, ...losers.map((l) => l[0])], winner,
    shares: [50 + lift / 2, ...losers.map((l) => l[1])], liftPct: lift,
  };
}
const abTests = [
  abRecord('ab-old', 200, 'Old Title Case Winner', [['old loser', 30]], 20),
  abRecord('ab-91', 91, 'just outside window', [['loser 91', 40]], 5),
  abRecord('ab-30', 30, 'thirty days winner', [['low share', 10], ['the runner up', 35]], 12.34),
  abRecord('ab-5', 5, 'five days winner', [['five loser', 45]], 3),
  abRecord('ab-89', 89, 'eighty nine winner', [['eighty nine loser', 44]], 7),
  abRecord('ab-future', -1, 'decided after computedAt', [['later loser', 40]], 9),
];

const fakeStore = {
  loadVerdicts: () => verdicts,
  listVideos: () => videos,
  *iterateSnapshots() { for (const s of snapshots) yield s; },
  loadAbTests: () => abTests,
  listChannels: () => [{ channelId: CH, name: 'Recency Test', promptSets: ['recency-set'] }],
  loadChannelGuidelines: () => null,
  saveChannelGuidelines: async () => { throw new Error('nothing may be saved in these checks'); },
};

const insights = new DistillationService(fakeStore).computeChannelInsights(CH);

check('recent uploads: last 90 days, long + live only, newest first', () => {
  const ids = insights.recentUploads.map((s) => s.title.replace('title ', ''));
  eq(ids.length, 46, 'count (45 long + 1 live; short and 100-day excluded):');
  eq(ids.slice(0, 4), ['v001', 'v002', 'live01', 'v003'], 'newest first:');
  eq(ids.includes('short01') || ids.includes('old100'), false, 'short / out-of-window present:');
  const times = insights.recentUploads.map((s) => Date.parse(s.publishedAt));
  eq(times.every((t, i) => i === 0 || times[i - 1] >= t), true, 'sorted newest first:');
});

check('recent uploads: first-week basis only with the first seven days collected; lifetime avg % viewed from snapshots', () => {
  const byId = Object.fromEntries(insights.recentUploads.map((s) => [s.title.replace('title ', ''), s]));
  eq([byId.v001.basis, byId.v001.ctr, byId.v001.avgPctViewed, byId.v001.views, byId.v001.engagedViews, byId.v001.retention30s],
    ['first-week', 6.1, 33.3, 800, 350, 70], 'v001:');
  eq([byId.v002.basis, byId.v002.views, byId.v002.engagedViews], ['lifetime', 2000, 800], 'v002 (a first-week snapshot but no seven-day record):');
  eq([byId.v003.basis, byId.v003.avgPctViewed], ['lifetime', 41.5], 'v003 latest non-null:');
  eq(byId.v004.avgPctViewed, null, 'v004 never captured:');
});

const block = buildInsightsBlock(insights, null, abTests);
const lines = block.split('\n');

check('render: first line is dated as of computedAt', () => {
  eq(lines[0], `CHANNEL PERFORMANCE DATA (as of ${insights.computedAt.slice(0, 10)})`, 'first line:');
});

check('render: recent uploads capped at 40, newest kept, cut stated', () => {
  const start = lines.indexOf('Recent uploads (last 90 days, newest first):');
  if (start < 0) throw new Error('no Recent uploads heading');
  const body = [];
  for (let i = start + 1; lines[i] && lines[i].startsWith('- '); i++) body.push(lines[i]);
  eq(body.length, 40, 'listed lines:');
  eq(body[0].startsWith('- "title v001" — published '), true, 'first line is the newest:');
  eq(/CTR 6\.1% \(p50\), avg % viewed 33\.3%, 350 engaged views \(first 7 days\)$/.test(body[0]), true, `first-week line "${body[0]}":`);
  eq(/\(lifetime\)$/.test(body[1]), true, 'lifetime line says so:');
  eq(body.some((l) => l.includes('"title v045"') || l.includes('"title v044"')), false, 'oldest two cut:');
  eq(lines[start + 41], '(6 older upload(s) from the window not shown; the newest 40 are listed.)', 'cut line:');
});

check('render: recent uploads sit after the packaging sections and before the A/B block', () => {
  const recent = lines.indexOf('Recent uploads (last 90 days, newest first):');
  const recentAb = lines.indexOf('Recent decided A/B tests (last 90 days, newest first):');
  const worst = lines.indexOf('Worst-performing titles (avoid these patterns):');
  const ab = lines.findIndex((l) => l.startsWith('TITLE A/B EVIDENCE'));
  eq(worst < recent && recent < recentAb && recentAb < ab, true, `order worst ${worst} < recent ${recent} < recentAb ${recentAb} < ab ${ab}:`);
});

check('render: top/bottom packaging lines carry their publish date', () => {
  const top = lines.indexOf('Top-performing titles (best packaging):');
  eq(/^- "title v\d+" — published \d{4}-\d{2}-\d{2}, CTR /.test(lines[top + 1]), true, `"${lines[top + 1]}":`);
});

check('recent A/B tests: window, newest first, runner-up, rounding; past asOf excluded', () => {
  const text = renderRecentAbTests(abTests, { channelId: CH, asOf: new Date(insights.computedAt), windowDays: 90 });
  const d = (ageDays) => iso(NOW - ageDays * DAY).slice(0, 10);
  eq(text.split('\n'), [
    'Recent decided A/B tests (last 90 days, newest first):',
    `- ${d(5)}: "five days winner" (+3 pts) beat "five loser"`,
    `- ${d(30)}: "thirty days winner" (+12.3 pts) beat "the runner up"`,
    `- ${d(89)}: "eighty nine winner" (+7 pts) beat "eighty nine loser"`,
  ], 'render:');
  eq(block.includes(text), true, 'the same section is in the full render:');
});

check('recent A/B tests: an empty window is stated in words', () => {
  const text = renderRecentAbTests([abTests[0]], { channelId: CH, asOf: new Date(NOW), windowDays: 90 });
  eq(text.split('\n')[1], 'None: no A/B title test was decided in the last 90 days.', 'empty:');
});

check('recent A/B tests: a record from another channel is refused by id', () => {
  throwsLike(
    () => renderRecentAbTests([{ ...abTests[3], channelId: 'UCother' }], { channelId: CH, asOf: new Date(NOW), windowDays: 90 }),
    /ab-tests record ab-5 .*channelId UCother/,
    'foreign record'
  );
});

check('insights without recentUploads throw, naming the re-run', () => {
  const old = { ...insights };
  delete old.recentUploads;
  throwsLike(() => buildInsightsBlock(old, null, abTests), /before recent-upload tracking .*re-run distillation/, 'old insights');
});

check('generation is unchanged: the compact block carries none of the recent sections', () => {
  const prepared = guidelines.prepareChannelInsightsFromData(fakeStore, { channelId: CH, name: 'Recency Test' }, insights, null, false);
  eq(prepared.rawBlock, block, 'prepared raw block is the full render:');
  const compact = guidelines.buildCompactInsightsBlock(prepared, ['- a lesson']);
  for (const marker of ['Recent uploads', 'Recent decided A/B', 'title v0', 'five days winner']) {
    eq(compact.includes(marker), false, `compact block contains "${marker}":`);
  }
  eq(compact.split('\n')[0], 'CHANNEL PERFORMANCE DATA', 'compact first line:');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
