/**
 * Thumbnail fitting smoke — the ELECTRON half (2026-09-26).
 *
 * The pure checks (tools/thumbnail-checks.js) prove the arithmetic; this proves the copies:
 * real PNGs are made with nativeImage, written to a scratch "week" on disk, and pushed
 * through `fitThumbnailFile` and `findUsableThumbnail` exactly as the attach and upload
 * doors do. It runs under the electron binary because nativeImage needs the runtime:
 *
 *   npm run build:electron && npx electron tools/thumbnail-fit-smoke.js
 *
 * No window, no app data, no network. Everything it writes is under a mkdtemp folder that
 * is removed at the end.
 */
const { app, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', 'dist', 'main');
const tv = require(path.join(ROOT, 'services/publish/thumbnail-validate.js'));
const MiB = 1024 * 1024;

let passed = 0;
let failed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err && err.message ? err.message : err}`);
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

/** A PNG of the given size: flat colour (tiny) or noise (incompressible, ~3 bytes/pixel). */
function writePng(file, width, height, noise) {
  const bitmap = Buffer.alloc(width * height * 4);
  if (noise) {
    for (let i = 0; i < bitmap.length; i += 4) {
      bitmap[i] = Math.floor(Math.random() * 256);
      bitmap[i + 1] = Math.floor(Math.random() * 256);
      bitmap[i + 2] = Math.floor(Math.random() * 256);
      bitmap[i + 3] = 255;
    }
  } else {
    for (let i = 0; i < bitmap.length; i += 4) {
      bitmap[i] = 40; bitmap[i + 1] = 90; bitmap[i + 2] = 200; bitmap[i + 3] = 255;
    }
  }
  const image = nativeImage.createFromBitmap(bitmap, { width, height });
  fs.writeFileSync(file, image.toPNG());
  return file;
}

function run() {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-thumb-fit-'));
  const week = path.join(tmp, '2026-09-21');
  const complete = path.join(week, 'complete');
  const thumbs = path.join(week, 'thumbnails');
  fs.mkdirSync(complete, { recursive: true });
  fs.mkdirSync(thumbs, { recursive: true });

  console.log('fitThumbnailFile');
  check('an in-bounds 1200x675 PNG is used as it is: same path, no copy, no note', () => {
    const f = writePng(path.join(thumbs, 'flat.png'), 1200, 675, false);
    const r = tv.fitThumbnailFile(f);
    eq(r.path, f, 'path');
    eq(r.note, '', 'note');
    eq([r.meta.width, r.meta.height], [1200, 675], 'size');
    eq(fs.existsSync(path.join(thumbs, 'flat (2).png')), false, 'no copy written');
  });
  check('a 4K noise PNG (over 2 MiB, over the frame) becomes a 1280x720 copy inside the bounds', () => {
    const f = writePng(path.join(thumbs, 'big.png'), 3840, 2160, true);
    const before = fs.statSync(f).size;
    if (before <= 2 * MiB) throw new Error(`fixture is only ${before} bytes; expected an oversized PNG`);
    const r = tv.fitThumbnailFile(f);
    if (r.path === f) throw new Error('the master was returned instead of a copy');
    eq(path.basename(r.path).startsWith('big (2).'), true, 'named beside the master');
    eq([r.meta.width, r.meta.height], [1280, 720], 'fitted size');
    if (r.meta.bytes > 2 * MiB) throw new Error(`copy is ${r.meta.bytes} bytes, over the limit`);
    if (!/reduced from 3840x2160 to 1280x720/.test(r.note)) throw new Error(`note: ${r.note}`);
    eq(fs.statSync(f).size, before, 'the master is untouched');
    eq(tv.validateThumbnailFile(r.path).warnings, [], 'the copy is clean at the strict door');
  });
  check('a 1920x1080 flat PNG (well under 2 MiB) is still fitted into the frame, as PNG', () => {
    const f = writePng(path.join(thumbs, 'hd.png'), 1920, 1080, false);
    const r = tv.fitThumbnailFile(f);
    eq(path.basename(r.path), 'hd (2).png', 'png copy');
    eq([r.meta.width, r.meta.height, r.meta.mime], [1280, 720, 'image/png'], 'fitted');
    if (/re-encoded/.test(r.note)) throw new Error(`a PNG that fit as PNG should not say re-encoded: ${r.note}`);
  });
  check('a 320x180 PNG is enlarged to 640x360 and warns it is under recommended', () => {
    const f = writePng(path.join(thumbs, 'tiny.png'), 320, 180, false);
    const r = tv.fitThumbnailFile(f);
    eq(path.basename(r.path), 'tiny (2).png', 'copy');
    eq([r.meta.width, r.meta.height], [640, 360], 'fitted');
    if (!/enlarged from 320x180 to 640x360/.test(r.note)) throw new Error(`note: ${r.note}`);
    eq(r.warnings.length, 1, 'under-recommended warning survives');
  });
  check('a 1280x720 noise PNG over 2 MiB keeps its size and falls to JPEG', () => {
    const f = writePng(path.join(thumbs, 'noise.png'), 1280, 720, true);
    const before = fs.statSync(f).size;
    if (before <= 2 * MiB) throw new Error(`fixture is only ${before} bytes; expected an oversized PNG`);
    const r = tv.fitThumbnailFile(f);
    eq(path.basename(r.path), 'noise (2).jpg', 'jpeg copy');
    eq([r.meta.width, r.meta.height, r.meta.mime], [1280, 720, 'image/jpeg'], 'fitted');
    if (r.meta.bytes > 2 * MiB) throw new Error(`copy is ${r.meta.bytes} bytes, over the limit`);
    if (!/re-encoded as JPEG at quality 95/.test(r.note)) throw new Error(`note: ${r.note}`);
  });
  check('a 300x1000 portrait is refused with the crop message; nothing is written', () => {
    const f = writePng(path.join(thumbs, 'portrait.png'), 300, 1000, false);
    throws(() => tv.fitThumbnailFile(f), /cannot fit YouTube's bounds without cropping/, 'portrait');
    eq(fs.existsSync(path.join(thumbs, 'portrait (2).png')), false, 'no copy');
  });
  check('a (2) master is fitted to a sibling, never a (2) (2)', () => {
    const f = writePng(path.join(thumbs, 'again (2).png'), 1920, 1080, false);
    const r = tv.fitThumbnailFile(f);
    eq(path.basename(r.path), 'again (2).png', 'overwrites its own name: the fitted copy of a copy is the copy');
    eq([r.meta.width, r.meta.height], [1280, 720], 'fitted');
  });

  console.log('findUsableThumbnail');
  check('an oversized export is attached as its fitted copy, and the next lookup reuses the copy', () => {
    const source = path.join(complete, '1 - duffy.mov');
    fs.writeFileSync(source, 'not a video');
    writePng(path.join(thumbs, '1 - duffy.png'), 1920, 1080, false);
    const first = tv.findUsableThumbnail(source);
    if (!first.ok) throw new Error(first.detail);
    eq(path.basename(first.pick.path), '1 - duffy (2).png', 'copy attached');
    eq(first.pick.match, 'basename', 'match kept');
    if (!first.pick.note) throw new Error('no note on the first pass');
    const written = fs.statSync(first.pick.path).mtimeMs;
    const second = tv.findUsableThumbnail(source);
    if (!second.ok) throw new Error(second.detail);
    eq(path.basename(second.pick.path), '1 - duffy (2).png', 'copy found');
    eq(second.pick.note, '', 'found, not re-made');
    eq(fs.statSync(second.pick.path).mtimeMs, written, 'the copy was not rewritten');
  });
  check('an in-bounds export wins over a stale fitted copy beside it', () => {
    const source = path.join(complete, '2 - kofi.mov');
    fs.writeFileSync(source, 'not a video');
    writePng(path.join(thumbs, '2 - kofi.png'), 1200, 675, false);
    writePng(path.join(thumbs, '2 - kofi (2).png'), 1280, 720, false);
    const r = tv.findUsableThumbnail(source);
    if (!r.ok) throw new Error(r.detail);
    eq(path.basename(r.pick.path), '2 - kofi.png', 'the master, first in candidate order');
  });
  check('a portrait export is refused with the reason, not silently skipped', () => {
    const source = path.join(complete, '3 - tall.mov');
    fs.writeFileSync(source, 'not a video');
    writePng(path.join(thumbs, '3 - tall.png'), 300, 1000, false);
    const r = tv.findUsableThumbnail(source);
    eq(r.ok, false, 'ok');
    eq(r.bucket, 'refused', 'bucket');
    if (!/cropping/.test(r.detail)) throw new Error(r.detail);
  });

  fs.rmSync(tmp, { recursive: true, force: true });
  console.log(`\n${passed} passed, ${failed} failed`);
  return failed === 0 ? 0 : 1;
}

app.whenReady().then(() => {
  if (app.dock) app.dock.hide();
  let code = 1;
  try {
    code = run();
  } catch (err) {
    console.error(err && err.stack ? err.stack : err);
  }
  app.exit(code);
});
