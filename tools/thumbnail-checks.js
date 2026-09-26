/**
 * Thumbnail bounds checks — the PURE half (2026-09-26).
 *
 * What it proves, against the compiled main process:
 *
 *   1. `judgeThumbnail` names each of YouTube's bounds an image breaks (bytes, minimum,
 *      maximum) as a refusal, and keeps the two non-fatal notes (under recommended, off
 *      16:9) as warnings — an image inside every bound has no refusals.
 *   2. `fitScaleFor` / `fittedSizeFor` keep the shape and move only the size: too big shrinks
 *      into 1280x720, too small grows to clear 640x360, inside is untouched, and a shape that
 *      cannot satisfy both throws naming both numbers (the fix is a crop, which is Owen's).
 *   3. `fittedThumbnailPath` writes beside the original as `<stem> (2).<ext>` and never chains
 *      a ` (2) (2)`.
 *   4. The proposal candidates include BOTH fitted spellings after the original, so a rescan
 *      finds an earlier copy before re-encoding the master.
 *   5. `measureThumbnailFile` reads dimensions out of a PNG header, and `validateThumbnailFile`
 *      (the strict door) throws for an out-of-bounds image while saying the app fits it at the
 *      attach/upload doors.
 *
 * The Electron half — actually writing a fitted copy with nativeImage — is
 * tools/thumbnail-fit-smoke.js, run under the electron binary. Both are `npm run check:thumbnail`.
 *
 *   npm run build:electron && node tools/thumbnail-checks.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};

const ROOT = path.join(__dirname, '..', 'dist', 'main');
const tv = require(path.join(ROOT, 'services/publish/thumbnail-validate.js'));

let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    console.log(`  FAIL ${name}\n       ${err && err.message ? err.message : err}`);
    process.exitCode = 1;
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}
function throws(fn, pattern, what) {
  let threw = null;
  try { fn(); } catch (err) { threw = err; }
  if (!threw) throw new Error(`${what}: did not throw`);
  if (!pattern.test(threw.message)) throw new Error(`${what}: threw "${threw.message}", expected /${pattern.source}/`);
}

const MiB = 1024 * 1024;
const meta = (width, height, bytes = 500_000, mime = 'image/png') => ({ bytes, width, height, mime });

console.log('judgeThumbnail');
check('1200x675 at 500 KB: no refusals, one warning (under recommended)', () => {
  const j = tv.judgeThumbnail(meta(1200, 675), 'T');
  eq(j.refusals, [], 'refusals');
  eq(j.warnings.length, 1, 'warnings');
  if (!/recommended/.test(j.warnings[0])) throw new Error(j.warnings[0]);
});
check('1280x720 at 1.9 MiB: nothing to say', () => {
  const j = tv.judgeThumbnail(meta(1280, 720, Math.floor(1.9 * MiB)), 'T');
  eq(j.refusals, [], 'refusals');
  eq(j.warnings, [], 'warnings');
});
check('over 2 MiB is a refusal naming the bytes', () => {
  const j = tv.judgeThumbnail(meta(1280, 720, 2 * MiB + 1), 'T');
  eq(j.refusals.length, 1, 'refusals');
  if (!/2097153 bytes/.test(j.refusals[0])) throw new Error(j.refusals[0]);
});
check('under 640x360 is a refusal, and NOT also an under-recommended warning', () => {
  const j = tv.judgeThumbnail(meta(320, 180), 'T');
  eq(j.refusals.length, 1, 'refusals');
  if (!/minimum is 640x360/.test(j.refusals[0])) throw new Error(j.refusals[0]);
  eq(j.warnings, [], 'warnings');
});
check('over 1280x720 is a refusal naming the frame', () => {
  const j = tv.judgeThumbnail(meta(1920, 1080), 'T');
  eq(j.refusals.length, 1, 'refusals');
  if (!/1280x720/.test(j.refusals[0])) throw new Error(j.refusals[0]);
});
check('a 4K PNG over the limit breaks two bounds, both named', () => {
  const j = tv.judgeThumbnail(meta(3840, 2160, 9 * MiB), 'T');
  eq(j.refusals.length, 2, 'refusals');
});
check('off 16:9 is a warning, not a refusal', () => {
  // Any off-16:9 image inside the 1280x720 frame is also under the recommended size on
  // one side, so it carries both warnings and no refusal.
  const j = tv.judgeThumbnail(meta(960, 720), 'T');
  eq(j.refusals, [], 'refusals');
  eq(j.warnings.length, 2, 'warnings');
  if (!j.warnings.some((w) => /off 16:9/.test(w))) throw new Error(j.warnings.join(' | '));
});

console.log('fitScaleFor / fittedSizeFor');
check('inside the bounds: scale 1, size unchanged', () => {
  eq(tv.fitScaleFor(1200, 675), 1, 'scale');
  eq(tv.fittedSizeFor(1200, 675), { width: 1200, height: 675 }, 'size');
  eq(tv.fittedSizeFor(640, 360), { width: 640, height: 360 }, 'floor is inside');
  eq(tv.fittedSizeFor(1280, 720), { width: 1280, height: 720 }, 'ceiling is inside');
});
check('1920x1080 shrinks to exactly 1280x720', () => {
  eq(tv.fittedSizeFor(1920, 1080), { width: 1280, height: 720 }, 'size');
});
check('3840x2160 shrinks to exactly 1280x720', () => {
  eq(tv.fittedSizeFor(3840, 2160), { width: 1280, height: 720 }, 'size');
});
check('a wide 2000x800 strip shrinks by width, keeping its shape', () => {
  eq(tv.fittedSizeFor(2000, 800), { width: 1280, height: 512 }, 'size');
});
check('a tall 1000x1000 square shrinks by height', () => {
  eq(tv.fittedSizeFor(1000, 1000), { width: 720, height: 720 }, 'size');
});
check('320x180 grows to exactly 640x360', () => {
  eq(tv.fittedSizeFor(320, 180), { width: 640, height: 360 }, 'size');
});
check('600x400 grows by width only as far as the floor needs', () => {
  eq(tv.fittedSizeFor(600, 400), { width: 640, height: 427 }, 'size');
});
check('a 300x1000 portrait cannot fit without a crop, and says both numbers', () => {
  throws(() => tv.fitScaleFor(300, 1000), /cannot fit YouTube's bounds without cropping.*Crop it/, 'portrait');
});
check('a 5000x900 strip cannot fit without a crop', () => {
  throws(() => tv.fitScaleFor(5000, 900), /cannot fit YouTube's bounds without cropping/, 'strip');
});
check('non-integer or zero dimensions are refused', () => {
  throws(() => tv.fitScaleFor(0, 720), /positive integers/, 'zero');
  throws(() => tv.fitScaleFor(1280.5, 720), /positive integers/, 'fraction');
});

console.log('fittedThumbnailPath');
check('writes beside the original as <stem> (2).<ext>', () => {
  eq(tv.fittedThumbnailPath('/w/thumbnails/1 - duffy.png', '.png'), '/w/thumbnails/1 - duffy (2).png', 'png');
  eq(tv.fittedThumbnailPath('/w/thumbnails/1 - duffy.png', '.jpg'), '/w/thumbnails/1 - duffy (2).jpg', 'jpg');
  eq(tv.fittedThumbnailPath('/w/thumbnails/1 - duffy.jpeg', '.png'), '/w/thumbnails/1 - duffy (2).png', 'from jpeg');
});
check('a master that is itself a (2) copy does not chain', () => {
  eq(tv.fittedThumbnailPath('/w/thumbnails/1 - duffy (2).png', '.jpg'), '/w/thumbnails/1 - duffy (2).jpg', 'no (2) (2)');
});

console.log('deriveProposedThumbnailPaths');
check('both fitted spellings follow the originals, before the slot candidate', () => {
  const c = tv.deriveProposedThumbnailPaths('/v/2026-09-21/complete/1 - duffy.mov').map((x) => x.path);
  const dir = '/v/2026-09-21/thumbnails';
  const iPng2 = c.indexOf(`${dir}/1 - duffy (2).png`);
  const iJpg2 = c.indexOf(`${dir}/1 - duffy (2).jpg`);
  const iOrig = c.indexOf(`${dir}/1 - duffy.png`);
  const iSlot = c.indexOf(`${dir}/1 - youtube-thumbnail.png`);
  if (iOrig < 0 || iPng2 < 0 || iJpg2 < 0 || iSlot < 0) throw new Error(`missing candidates: ${c.join(', ')}`);
  if (!(iOrig < iPng2 && iPng2 < iJpg2 && iJpg2 < iSlot)) throw new Error(`wrong order: ${c.join(', ')}`);
});

console.log('measureThumbnailFile / validateThumbnailFile on a synthetic PNG header');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-thumb-checks-'));
function syntheticPng(file, width, height, padTo) {
  // Signature + an IHDR chunk with the given size; the rest is padding. Enough for the
  // header reader, which is all the pure half reads. Not decodable, and not meant to be.
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const ihdr = Buffer.alloc(25);
  ihdr.writeUInt32BE(13, 0);
  ihdr.write('IHDR', 4, 'ascii');
  ihdr.writeUInt32BE(width, 8);
  ihdr.writeUInt32BE(height, 12);
  const body = Buffer.concat([sig, ihdr]);
  const out = padTo > body.length ? Buffer.concat([body, Buffer.alloc(padTo - body.length)]) : body;
  fs.writeFileSync(file, out);
  return file;
}
check('measure reads 1200x675 out of the header', () => {
  const f = syntheticPng(path.join(tmp, 'a.png'), 1200, 675, 4096);
  eq(tv.measureThumbnailFile(f), { bytes: 4096, width: 1200, height: 675, mime: 'image/png' }, 'meta');
});
check('validate passes an in-bounds file and warns it is under recommended', () => {
  const f = syntheticPng(path.join(tmp, 'b.png'), 1200, 675, 4096);
  const v = tv.validateThumbnailFile(f);
  eq(v.warnings.length, 1, 'warnings');
});
check('validate refuses an oversized file and says the attach/upload doors fit it', () => {
  const f = syntheticPng(path.join(tmp, 'c.png'), 3840, 2160, 3 * MiB);
  throws(() => tv.validateThumbnailFile(f), /fits such a file into YouTube's bounds/, 'oversize');
});
check('inspect returns the refusals of a too-small file without throwing', () => {
  const f = syntheticPng(path.join(tmp, 'd.png'), 320, 180, 4096);
  const i = tv.inspectThumbnailFile(f);
  eq(i.refusals.length, 1, 'refusals');
  eq(i.meta.width, 320, 'width');
});
check('a file with a lying extension is refused, not fitted', () => {
  const f = syntheticPng(path.join(tmp, 'e.jpg'), 1280, 720, 4096);
  throws(() => tv.inspectThumbnailFile(f), /image\/png file with a \.jpg extension/, 'lying ext');
});
fs.rmSync(tmp, { recursive: true, force: true });

console.log(`\n${passed} passed${process.exitCode ? ', with failures' : ''}`);
