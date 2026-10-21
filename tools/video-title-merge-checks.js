#!/usr/bin/env node
/**
 * Video title history: the store's merge of a re-sent catalogue record. The extension sends
 * every catalogue video every cycle with the LIVE title, origin 'upload' and the publish
 * date as the span start; the store decides what a changed title is. Covers: a title equal
 * to the video's decided A/B winner becomes a 'test-compare' span from the decision time;
 * any other new title a 'manual-edit' span from now; an unchanged catalogue leaves
 * videos.json untouched on disk; a first-time record is stored as sent. Offline, temp
 * folder removed at the end.
 *
 *   npm run build:electron && node tools/video-title-merge-checks.js
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main');
const { AnalyticsStoreService } = require(path.join(ROOT, 'services/analytics/analytics-store.service.js'));

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-title-merge-'));
const CH = 'UCtestchannel000000000000';
const VID = 'vid00000001';
const record = (title) => ({
  videoId: VID,
  channelId: CH,
  publishedAt: '2026-10-08T17:00:00.000Z',
  durationSec: 1620,
  format: 'long',
  titleHistory: [{ title, from: '2026-10-08T17:00:00.000Z', to: null, origin: 'upload' }],
});

let failures = 0;
function eq(a, e, what) {
  if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what}: expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`);
}
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ok  ${name}`);
  } catch (err) {
    failures++;
    console.log(`FAIL  ${name}\n      ${err.message}`);
  }
}

(async () => {
  const store = new AnalyticsStoreService(TMP);
  await store.saveChannels([{ channelId: CH, name: 'Test', promptSets: [] }]);
  const file = path.join(TMP, CH, 'videos.json');

  await check('first sighting is stored as sent', async () => {
    await store.upsertVideos([record('fox news says the ark was found')]);
    const [v] = store.listVideos(CH);
    eq(v.titleHistory, record('fox news says the ark was found').titleHistory, 'history');
  });

  await check('an unchanged catalogue re-send does not rewrite the file', async () => {
    const before = fs.statSync(file).mtimeMs;
    await new Promise((r) => setTimeout(r, 20));
    await store.upsertVideos([record('fox news says the ark was found')]);
    eq(fs.statSync(file).mtimeMs, before, 'mtime');
    eq(store.listVideos(CH)[0].titleHistory.length, 1, 'span count');
  });

  await check('the decided winner arriving as the live title is a test-compare span from the decision', async () => {
    await store.upsertAbTests([{
      videoId: VID, channelId: CH, method: 'test-compare', decidedAt: '2026-10-11T16:19:53.000Z',
      variants: ['fox news says the ark was found', 'researchers claim the ark has crosses. lol'],
      winner: 'researchers claim the ark has crosses. lol', liftPct: 2.7, shares: [34.39, 37.11],
    }]);
    await store.upsertVideos([record('researchers claim the ark has crosses. lol')]);
    const h = store.listVideos(CH)[0].titleHistory;
    eq(h.length, 2, 'span count');
    eq(h[0].to, '2026-10-11T16:19:53.000Z', 'upload span closed at the decision');
    eq({ title: h[1].title, from: h[1].from, to: h[1].to, origin: h[1].origin },
      { title: 'researchers claim the ark has crosses. lol', from: '2026-10-11T16:19:53.000Z', to: null, origin: 'test-compare' }, 'winner span');
  });

  await check('any other new title is a manual-edit span from now', async () => {
    const t0 = Date.now();
    await store.upsertVideos([record('the ark rock, again')]);
    const h = store.listVideos(CH)[0].titleHistory;
    eq(h.length, 3, 'span count');
    eq(h[2].origin, 'manual-edit', 'origin');
    if (Date.parse(h[2].from) < t0 - 1000) throw new Error(`from ${h[2].from} is before the upsert`);
    eq(h[1].to, h[2].from, 'previous span closed when the edit was seen');
  });

  fs.rmSync(TMP, { recursive: true, force: true });
  if (failures > 0) {
    console.log(`\n${failures} check(s) failed`);
    process.exit(1);
  }
  console.log('\nvideo-title-merge-checks: ALL PASS');
})();
