/**
 * A/B thumbnails checks (LEDGER #250, 2026-09-30): the app half of the extension's
 * "Title and thumbnail" fill, and the extension's pure decision about which test to set up.
 *
 * What it proves, offline (no app launch, no Studio, no Chrome):
 *
 *   1. publish-bridge `getAbThumbnails`: the saved picks come back in order (Pick 1..n), each
 *      through fitThumbnailFile, as base64 whose decoded bytes are the file's; no picks is an
 *      empty list; a saved pick whose file is missing, not an image, or out of order THROWS
 *      naming it (never a shorter list); an item not on disk throws.
 *   2. `getItem` carries `abThumbnails`, the count; a reader that throws fails the detail
 *      rather than reading as 0.
 *   3. The route: GET /publish/ab-thumbnails answers `{ picks }` over the real ingest server,
 *      400 without an itemId, 500 naming a missing file.
 *   4. extension/src/publish/ab-plan.ts (bundled with the extension's esbuild and run here):
 *      0 or 1 thumbnail is "Title only" (one is the video's own, said), n for n titles is
 *      "Title and thumbnail", 2-3 that differ from the titles are refused in plain words, an
 *      app too old to say is refused (never read as 0); the arrival check; the "Run a new
 *      test?" classification.
 *
 * The real reader (report-thumbnails.ts `abTestPickFiles`) is checked on a saved record in
 * tools/thumbnail-pipeline-checks.js, beside the save it reads.
 *
 *   npm run build:electron && node tools/ab-thumbnails-checks.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const http = require('http');
const Module = require('module');
const { execFileSync } = require('child_process');

const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};

const REPO = path.join(__dirname, '..');
const ROOT = path.join(REPO, 'dist', 'main');
const { PublishBridge } = require(path.join(ROOT, 'services/publish/publish-bridge.js'));
const { IngestServerService } = require(path.join(ROOT, 'services/analytics/ingest-server.service.js'));

let passed = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      passed += 1;
      console.log(`  ok   ${name}`);
    } catch (err) {
      process.exitCode = 1;
      console.log(`  FAIL ${name}\n       ${err && err.message ? err.message : err}`);
    }
  });
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}
async function throwsAsync(fn, pattern, what) {
  let threw = null;
  try { await fn(); } catch (err) { threw = err; }
  if (!threw) throw new Error(`${what}: did not throw`);
  if (!pattern.test(threw.message)) throw new Error(`${what}: threw "${threw.message}", expected /${pattern.source}/`);
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-ab-thumbs-'));

/** A PNG header of the given size, padded: enough for measureThumbnailFile (thumbnail-checks.js). */
function syntheticPng(file, width, height, padTo, seed) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  const body = Buffer.concat([sig, ihdr]);
  const pad = Buffer.alloc(padTo - body.length, seed);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.concat([body, pad]));
  return file;
}

const ITEM = 'item-ab-1';
const JOB = 'job-ab-1';
const picksDir = path.join(tmp, 'thumbnails', 'f2 - the rapture', 'picks');
const pick1 = syntheticPng(path.join(picksDir, 'Pick 1.png'), 1280, 720, 4096, 1);
const pick2 = syntheticPng(path.join(picksDir, 'Pick 2.png'), 1280, 720, 5000, 2);

/** A bridge whose reader answers `picks` (or throws `picks` when it is an Error). */
function bridgeWith(picks, { generated = true } = {}) {
  const store = { get: () => null };
  const readGenerated = (itemId) =>
    generated && itemId === ITEM
      ? { jobId: JOB, titles: ['Title one', 'Title two'], tags: '', sourceFilename: 'f2.mov', sections: { body: 'Body.', chapters: [], links: '' } }
      : null;
  const listGenerated = () => ({ items: [], unreadable: 0 });
  const calls = [];
  const readAbPicks = (itemId, jobId) => {
    calls.push([itemId, jobId]);
    if (picks instanceof Error) throw picks;
    return picks;
  };
  return { bridge: new PublishBridge(store, readGenerated, listGenerated, async () => null, readAbPicks), calls };
}

function section(title) {
  pending.push(async () => console.log(title));
}

section('publish-bridge getAbThumbnails / getItem');

check('two saved picks come back in order, fitted, as base64 of the files themselves; the reader is asked with the item\'s job', async () => {
  const { bridge, calls } = bridgeWith([{ n: 1, file: pick1 }, { n: 2, file: pick2 }]);
  const out = await bridge.getAbThumbnails(ITEM);
  eq(out.map((p) => [p.itemId, p.filename, p.mime, p.bytes]), [[ITEM, 'Pick 1.png', 'image/png', 4096], [ITEM, 'Pick 2.png', 'image/png', 5000]], 'picks');
  if (!Buffer.from(out[0].base64, 'base64').equals(fs.readFileSync(pick1))) throw new Error('Pick 1 bytes differ');
  if (!Buffer.from(out[1].base64, 'base64').equals(fs.readFileSync(pick2))) throw new Error('Pick 2 bytes differ');
  eq(calls, [[ITEM, JOB]], 'reader asked with (itemId, jobId)');
});

check('no picks saved is an empty list (a state, not a failure)', async () => {
  eq(await bridgeWith([]).bridge.getAbThumbnails(ITEM), [], 'empty');
});

check('a saved pick whose file is missing throws naming it; never a shorter list', async () => {
  const gone = path.join(picksDir, 'Pick 3.png');
  const { bridge } = bridgeWith([{ n: 1, file: pick1 }, { n: 2, file: pick2 }, { n: 3, file: gone }]);
  await throwsAsync(() => bridge.getAbThumbnails(ITEM), /^Thumbnail 3 for the A\/B test is saved but its file is missing: .*Pick 3\.png\. Open this report's Thumbnails window and press Save thumbnails again\.$/, 'missing');
});

check('a saved pick that is not an image throws naming which', async () => {
  const bad = path.join(tmp, 'bad', 'Pick 1.png');
  fs.mkdirSync(path.dirname(bad), { recursive: true });
  fs.writeFileSync(bad, 'not a picture at all');
  const { bridge } = bridgeWith([{ n: 1, file: bad }, { n: 2, file: pick2 }]);
  await throwsAsync(() => bridge.getAbThumbnails(ITEM), /^Thumbnail 1 for the A\/B test cannot be used: Thumbnail .* is not a PNG or JPEG/, 'unreadable');
});

check('picks out of order are refused, not re-sorted (the order is the pairing)', async () => {
  const { bridge } = bridgeWith([{ n: 2, file: pick2 }, { n: 1, file: pick1 }]);
  await throwsAsync(() => bridge.getAbThumbnails(ITEM), /out of order: entry 1 is Pick 2/, 'order');
});

check('an item not on disk throws', async () => {
  const { bridge } = bridgeWith([], { generated: false });
  await throwsAsync(() => bridge.getAbThumbnails(ITEM), /No generated item item-ab-1 on disk/, 'gone');
});

check('getItem carries the count; a reader that throws fails the detail instead of reading as 0', async () => {
  eq((await bridgeWith([{ n: 1, file: pick1 }, { n: 2, file: pick2 }]).bridge.getItem(ITEM)).abThumbnails, 2, 'two');
  eq((await bridgeWith([]).bridge.getItem(ITEM)).abThumbnails, 0, 'none');
  await throwsAsync(() => bridgeWith(new Error('The thumbnails record is damaged')).bridge.getItem(ITEM), /damaged/, 'damaged');
});

section('GET /publish/ab-thumbnails on the ingest server');

function get(port, url) {
  return new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port, path: url }, (res) => {
      let body = '';
      res.on('data', (c) => { body += c; });
      res.on('end', () => resolve({ status: res.statusCode, body: JSON.parse(body) }));
    }).on('error', reject);
  });
}

check('answers { picks } in order, 400 without an itemId, 500 naming a missing file', async () => {
  let picks = [{ n: 1, file: pick1 }, { n: 2, file: pick2 }];
  const store = { get: () => null };
  const bridge = new PublishBridge(store, () => ({ jobId: JOB, sections: { body: '', chapters: [], links: '' } }), () => ({ items: [], unreadable: 0 }), async () => null, () => picks);
  const port = 43900 + Math.floor(Math.random() * 90);
  const server = new IngestServerService({ getBaseDir: () => tmp }, port, {});
  server.setPublishRoutes(bridge);
  await server.start();
  try {
    const ok = await get(port, `/publish/ab-thumbnails?itemId=${ITEM}`);
    eq([ok.status, ok.body.picks.map((p) => p.filename)], [200, ['Pick 1.png', 'Pick 2.png']], 'two picks');
    picks = [];
    eq(await get(port, `/publish/ab-thumbnails?itemId=${ITEM}`), { status: 200, body: { picks: [] } }, 'none');
    eq((await get(port, '/publish/ab-thumbnails')).status, 400, 'no itemId');
    picks = [{ n: 1, file: path.join(tmp, 'nowhere.png') }];
    const gone = await get(port, `/publish/ab-thumbnails?itemId=${ITEM}`);
    if (gone.status !== 500 || !/Thumbnail 1 for the A\/B test is saved but its file is missing/.test(gone.body.error)) {
      throw new Error(`missing file: ${JSON.stringify(gone)}`);
    }
  } finally {
    await server.stop();
  }
});

section('extension ab-plan.ts (bundled with the extension\'s esbuild)');

const bundled = path.join(tmp, 'ab-plan.cjs');
execFileSync(path.join(REPO, 'extension', 'node_modules', '.bin', 'esbuild'), [
  path.join(REPO, 'extension', 'src', 'publish', 'ab-plan.ts'), '--bundle', '--platform=node', '--format=cjs', `--outfile=${bundled}`, '--log-level=warning',
]);
const plan = require(bundled);

check('no thumbnails saved: "Title only" (chip 0), every chosen title', () => {
  eq(plan.planAbTest(3, 0), { kind: 'fill', mode: 'titles', chip: 0, count: 3, savedThumbnails: 0, summary: '3 titles, no thumbnails saved' }, '3/0');
  eq(plan.planAbTest(2, 0).chip, 0, '2/0');
});

check('one saved per title: "Title and thumbnail" (chip 2), pair n = title n + Pick n', () => {
  eq(plan.planAbTest(3, 3), { kind: 'fill', mode: 'titles-and-thumbnails', chip: 2, count: 3, summary: '3 titles and 3 thumbnails' }, '3/3');
  eq(plan.planAbTest(2, 2).mode, 'titles-and-thumbnails', '2/2');
});

check('counts that differ are refused in plain words, before anything is touched', () => {
  eq(plan.planAbTest(3, 2), { kind: 'refuse', reason: "3 titles but 2 thumbnails saved — save a thumbnail for each title in ContentStudio's Thumbnails window, or drop a title" }, '3/2');
  eq(plan.planAbTest(2, 3), { kind: 'refuse', reason: "2 titles but 3 thumbnails saved — pick a title for each thumbnail, or remove a thumbnail in ContentStudio's Thumbnails window" }, '2/3');
});

check('one thumbnail saved: "Title only" too (Owen, 2026-09-30), the one image being the video\'s own and not tested, said', () => {
  eq(plan.planAbTest(3, 1), { kind: 'fill', mode: 'titles', chip: 0, count: 3, savedThumbnails: 1, summary: "3 titles; the 1 saved thumbnail is the video's own, not tested" }, '3/1');
  eq(plan.planAbTest(2, 1).mode, 'titles', '2/1');
});

check('fewer than 2 titles, an app too old to say, and a nonsense count are refused; undefined is never 0', () => {
  eq(plan.planAbTest(1, 0), { kind: 'refuse', reason: 'Pick at least 2 titles (1 chosen)' }, 'one title');
  eq(plan.planAbTest(3, undefined), { kind: 'refuse', reason: 'This ContentStudio is older than the A/B thumbnails — update the app' }, 'old app');
  eq(plan.planAbTest(3, -1).kind, 'refuse', 'negative');
  eq(plan.planAbTest(3, 1.5).kind, 'refuse', 'fraction');
});

check('the images that arrive must match the count the plan was made from', () => {
  eq(plan.checkArrivedThumbnails(3, 3), null, 'same');
  eq(plan.checkArrivedThumbnails(3, 2), 'ContentStudio had 3 thumbnails saved for the test when this page loaded and sent 2 now — reload the report in the shelf and fill again', 'fewer');
});

check('what the A/B button led to: slots are the dialog; a question with no slots is the "Run a new test?" confirm; neither is nothing yet', () => {
  eq(plan.classifyAbOpen(3, false), 'dialog', 'dialog');
  eq(plan.classifyAbOpen(3, true), 'dialog', 'slots win');
  eq(plan.classifyAbOpen(0, true), 'confirm', 'confirm');
  eq(plan.classifyAbOpen(1, false), 'nothing', 'nothing');
});

(async () => {
  for (const run of pending) await run();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
})();
