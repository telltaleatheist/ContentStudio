#!/usr/bin/env node
/**
 * The updated video (LEDGER #316): a re-render published in place of the video a report was made
 * from. Covers the set/clear round trip on a real store, the upload sending the re-render (its
 * path, its size, its name and length for the duplicate check) with the report's file absent,
 * the chapter block left out while set and back after clearing, the refusals (a missing or
 * re-rendered file, an item already on YouTube, an edited description with chapter lines), and
 * the episode audio following the re-render. Offline: fake YouTube, temp folder removed at the end.
 *
 *   npm run build:electron && node tools/updated-video-checks.js
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
const U = require(path.join(ROOT, 'services/publish/updated-video.js'));
const types = require(path.join(ROOT, 'services/publish/publish-types.js'));
const { PublishStoreService, resolveChosenMetadata } = require(path.join(ROOT, 'services/publish/publish-store.service.js'));
const upload = require(path.join(ROOT, 'services/publish/youtube-upload.js'));

let failures = 0;
const pending = [];
function check(name, fn) {
  pending.push(fn);
  pending[pending.length - 1].label = name;
}
function eq(a, e, what) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what} expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
async function rejectsLike(fn, re, what) {
  try { await fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${what}: threw "${e.message}", expected ${re}`); return e.message; }
  throw new Error(`${what}: did not throw`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-updated-video-'));
const ITEM = 'itm-abc123-0a1b2c3d';
const CHANNEL = 'UCtesttesttesttesttest00';
const ORIGINAL = path.join(TMP, 'week/complete/f1 - kent christmas.mov'); // never created: not needed
const RENDER = path.join(TMP, 'week/complete/f1 - kent christmas ads.mov');
fs.mkdirSync(path.dirname(RENDER), { recursive: true });
fs.writeFileSync(RENDER, Buffer.alloc(4096, 1));

const noAuto = () => ({ patch: {}, applied: [], refused: [], skipped: [] });
const storeDir = path.join(TMP, 'publish');
let store = new PublishStoreService(storeDir, noAuto);

const SECTIONS = {
  body: 'The body.',
  chapters: [
    { key: '0:00 - Intro', timestamp: '0:00', title: 'Intro' },
    { key: '4:58 - Patreon plug', timestamp: '4:58', title: 'Patreon plug' },
  ],
  links: 'Links here',
};
const generated = {
  jobId: 'job-1',
  titles: ['A title'],
  description: '', descriptionWithoutChapters: '', chapterBlock: '',
  sections: SECTIONS,
  tags: 'one, two',
  sourceFilename: path.basename(ORIGINAL),
  sourcePath: ORIGINAL,
  sourcePathDeclared: true,
  promptSet: null,
  sourceDurationSec: null,
  publishProfile: null,
};
const choose = (record, extra = {}) => U.chooseUpdatedVideo({
  itemId: ITEM, record, originalPath: ORIGINAL, filePath: RENDER, stat: upload.statOnDisk,
  probeDurationSec: async () => 3725.5, now: new Date('2026-10-18T12:00:00Z'), ...extra,
});

function fakeApi(log) {
  return {
    insertVideo: async (channelId, filePath, body) => { log.push({ channelId, filePath, body }); return { videoId: 'NEWVID' }; },
    setThumbnail: async () => { throw new Error('no thumbnail expected'); },
    getLatestCategoryId: async () => '22',
    requireCaptionScope: () => {},
    insertCaption: async () => { throw new Error('no captions expected'); },
  };
}
const uploadDeps = (log, uploads = []) => ({
  store, readGenerated: () => generated, api: fakeApi(log), listRecentUploads: async () => uploads,
  now: () => new Date('2026-10-18T13:00:00Z'),
});

check('set then clear: the record keeps the re-render across a restart, then forgets it', async () => {
  await store.update(ITEM, generated, { chosenTitles: ['A title'], channelId: CHANNEL, chapterEdits: { '4:58 - Patreon plug': 'Support' }, chapterDrops: [] });
  const updatedVideo = await choose(store.get(ITEM));
  eq(updatedVideo, { path: RENDER, bytes: 4096, mtimeMs: fs.statSync(RENDER).mtimeMs, durationSec: 3725.5, setAt: '2026-10-18T12:00:00.000Z', replacesPath: ORIGINAL }, 'chosen');
  await store.update(ITEM, generated, { updatedVideo });
  store = new PublishStoreService(storeDir, noAuto); // a restart
  eq(store.get(ITEM).updatedVideo, updatedVideo, 'after restart');
  eq(store.get(ITEM).chapterEdits, { '4:58 - Patreon plug': 'Support' }, 'chapter edits kept');
  await store.update(ITEM, generated, { updatedVideo: null });
  eq(store.get(ITEM).updatedVideo, null, 'cleared');
  // An old record without the field reads as null (one-way upgrade, nothing guessed).
  const legacy = { ...types.emptyChosenMetadata(ITEM, 'job-1') };
  delete legacy.updatedVideo;
  eq(types.upgradeStoredMetadata(legacy).updatedVideo, null, 'legacy');
});

check('the description has no chapter block while set, and gets it back exactly after clearing', async () => {
  const before = resolveChosenMetadata(store.get(ITEM), generated).description;
  eq(before, 'The body.\n\n0:00 - Intro\n4:58 - Support\n\nLinks here', 'before');
  await store.update(ITEM, generated, { updatedVideo: await choose(store.get(ITEM)) });
  const resolved = resolveChosenMetadata(store.get(ITEM), generated);
  eq(resolved.description, 'The body.\n\nLinks here', 'while set');
  eq([resolved.sourceFilename, resolved.sourceDurationSec], [path.basename(RENDER), 3725.5], 'matched by the re-render');
  await store.update(ITEM, generated, { updatedVideo: null });
  eq(resolveChosenMetadata(store.get(ITEM), generated).description, before, 'after clearing');
});

check('the upload sends the re-render (path and size), with the report\'s own file not on disk', async () => {
  await store.update(ITEM, generated, { updatedVideo: await choose(store.get(ITEM)) });
  const log = [];
  const outcome = await upload.uploadItemToYouTube(ITEM, uploadDeps(log));
  eq(log.length, 1, 'one insert');
  eq(log[0].filePath, RENDER, 'file sent');
  eq(outcome.receipt.file, { path: RENDER, bytes: 4096 }, 'receipt file');
  eq(/\d:\d\d - /.test(log[0].body.snippet.description), false, 'no chapter lines sent');
  // Reset for the cases below: the upload linked it.
  await store.update(ITEM, generated, { videoId: null, status: 'ready', uploadReceipt: null, pushedAt: null });
});

check('the duplicate check goes by the re-render\'s name and length', async () => {
  const entry = (durationSec) => ({ videoId: 'OLD', title: 'f1   kent christmas ads', publishedAt: '2026-10-17T00:00:00Z', durationSec, privacyStatus: 'private', uploadStatus: 'processed', publishAt: null, descriptionLength: 0, tagCount: 0, categoryId: '22' });
  await rejectsLike(() => upload.uploadItemToYouTube(ITEM, uploadDeps([], [entry(3725)])), /already on this channel.*same name, same\s+duration/s, 'same cut');
  const log = [];
  await upload.uploadItemToYouTube(ITEM, uploadDeps(log, [entry(1800)]));
  eq(log.length, 1, 'a different length is a re-export and goes');
  await store.update(ITEM, generated, { videoId: null, status: 'ready', uploadReceipt: null, pushedAt: null });
});

check('a re-render changed since it was chosen, or gone, refuses the upload by name', async () => {
  fs.appendFileSync(RENDER, 'more');
  await rejectsLike(() => upload.uploadItemToYouTube(ITEM, uploadDeps([])), /has changed since it was chosen.*choose it again with Update video/s, 'changed');
  eq(U.describeUpdatedVideo(ITEM, store.get(ITEM).updatedVideo, upload.statOnDisk).problem !== null, true, 'the row says so');
  fs.renameSync(RENDER, RENDER + '.moved');
  await rejectsLike(() => upload.uploadItemToYouTube(ITEM, uploadDeps([])), /updated video is not on disk/, 'gone');
  fs.renameSync(RENDER + '.moved', RENDER);
  await store.update(ITEM, generated, { updatedVideo: await choose(store.get(ITEM)) });
});

check('setting one on an item already on YouTube is refused; clearing is always allowed', async () => {
  const linked = { ...store.get(ITEM), videoId: 'LIVEVID' };
  await rejectsLike(() => choose(linked), /already on YouTube as video LIVEVID.*Mark it unpublished first, then upload the new render/s, 'linked');
  await rejectsLike(() => choose(store.get(ITEM), { filePath: ORIGINAL }), /is the video this report was made from/, 'same file');
  await rejectsLike(() => choose(store.get(ITEM), { filePath: path.join(TMP, 'x.mp3') }), /not a video file/, 'audio');
  await rejectsLike(() => choose(store.get(ITEM), { probeDurationSec: async () => NaN }), /could not be read/, 'no length');
  await store.update(ITEM, generated, { videoId: 'LIVEVID' });
  await store.update(ITEM, generated, { updatedVideo: null });
  eq(store.get(ITEM).updatedVideo, null, 'cleared on a linked item');
  await store.update(ITEM, generated, { videoId: null, status: 'ready' });
  await store.update(ITEM, generated, { updatedVideo: await choose(store.get(ITEM)) });
});

check('an edited description with chapter lines refuses while set; without them it goes', async () => {
  await store.update(ITEM, generated, { descriptionOverride: 'My own words.\n0:00 Intro\n12:34 - The rest' });
  const msg = await rejectsLike(() => upload.uploadItemToYouTube(ITEM, uploadDeps([])), /edited description has 2 chapter lines/, 'override with chapters');
  if (!/"0:00 Intro"/.test(msg) || !/Revert it/.test(msg)) throw new Error(`message does not name the lines and the fix: ${msg}`);
  eq(U.updatedVideoDescriptionProblem({ ...store.get(ITEM), updatedVideo: null }), null, 'no updated video: no refusal');
  eq(U.chapterLinesIn('At 10:30 we spoke.\nPrice 4:58pm\n1:02:03 - Deep'), ['1:02:03 - Deep'], 'only lines that start with a time');
  await store.update(ITEM, generated, { descriptionOverride: 'My own words, at 4:58 in passing.' });
  const log = [];
  await upload.uploadItemToYouTube(ITEM, uploadDeps(log));
  eq(log[0].body.snippet.description, 'My own words, at 4:58 in passing.\n\nLinks here', 'override without chapter lines');
});

check('the episode audio follows the re-render', async () => {
  const updatedVideo = store.get(ITEM).updatedVideo;
  const oldMp3 = ORIGINAL.replace(/\.mov$/, '.mp3');
  if (!/belongs to the original video/.test(U.updatedVideoAudioProblem({ updatedVideo, spreakerAudioPath: oldMp3 }) || '')) throw new Error('old audio not refused');
  eq(U.updatedVideoAudioProblem({ updatedVideo, spreakerAudioPath: RENDER.replace(/\.mov$/, '.mp3') }), null, 'new audio');
  eq(U.audioProposalSource({ updatedVideo }, ORIGINAL), RENDER, 'offered beside the re-render');
  eq(U.audioProposalSource({ updatedVideo: null }, ORIGINAL), ORIGINAL, 'offered beside the original');
});

(async () => {
  for (const fn of pending) {
    try { await fn(); console.log(`PASS  ${fn.label}`); } catch (e) { failures++; console.log(`FAIL  ${fn.label} :: ${e.message}`); }
  }
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures ? `\n${failures} failed` : `\nall ${pending.length} passed`);
  process.exit(failures ? 1 : 0);
})();
