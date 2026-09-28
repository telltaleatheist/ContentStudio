/**
 * Thumbnails tab — the ELECTRON half of `npm run check:thumbnail-lab` (2026-09-28).
 *
 * The pure half (tools/thumbnail-lab-checks.js) proves the arithmetic; this proves the page:
 * the hidden canvas finds faces with Apple Vision (Chromium's FaceDetector), measures in a real
 * installed font, refuses a font that is not installed, draws, and the file it writes passes the
 * app's own thumbnail door (≤ 2 MiB, 1280x720). It needs the electron binary for the page:
 *
 *   npm run build:electron && npx electron tools/thumbnail-lab-render-smoke.js [outDir]
 *
 * Its inputs are synthetic (a drawn "face" is not a face Vision will find, so the face path is
 * checked on the reference frame when it is on this Mac, and skipped by name when it is not).
 * With `outDir`, the reference frame's evidence renders are kept there; without it everything
 * goes to a mkdtemp folder that is removed at the end. No window is shown, no app data is read.
 */
const { app } = require('electron');
const path = require('path');
const fs = require('fs');
const os = require('os');

const ROOT = path.join(__dirname, '..', 'dist', 'main');
const REPO = path.join(__dirname, '..');
const { ThumbnailCanvas, canvasPagePath } = require(path.join(ROOT, 'services/thumbnails/canvas-page.js'));
const { renderThumbnail, OUTPUT_WIDTH, OUTPUT_HEIGHT } = require(path.join(ROOT, 'services/thumbnails/renderer.js'));
const layout = require(path.join(ROOT, 'services/thumbnails/layout.js'));
const tv = require(path.join(ROOT, 'services/publish/thumbnail-validate.js'));
const photos = require(path.join(ROOT, 'services/thumbnails/reaction-photos.js'));

/** Owen's reaction cut-outs, when this Mac has them (read in place, never copied). */
const SELFIES = '/Users/telltale/Downloads/selfies';

/** Owen's reference frame (Amanda Grace, 1920x1080) from the text mock, when this Mac has it. */
const REFERENCE_FRAME = '/Users/telltale/Pictures/thumbnail-tests/text-mock/frame-0800.png';

let passed = 0;
let failed = 0;
const skipped = [];
async function check(name, fn) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok   ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  FAIL ${name}\n       ${err && err.stack ? err.stack : err}`);
  }
}
function assert(cond, what) {
  if (!cond) throw new Error(what);
}

app.whenReady().then(async () => {
  const keep = process.argv.slice(2).find((a) => !a.startsWith('-') && !a.endsWith('.js'));
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-'));
  const outDir = keep ? path.resolve(keep) : scratch;
  fs.mkdirSync(outDir, { recursive: true });
  const canvas = new ThumbnailCanvas(canvasPagePath(REPO));
  const style = layout.validateStyle(layout.DEFAULT_STYLE);

  // A synthetic 1920x1080 frame: a gradient with noise, so the PNG is a realistic size.
  const { nativeImage } = require('electron');
  const W = 1920, H = 1080;
  const buf = Buffer.alloc(W * H * 4);
  let seed = 7;
  for (let i = 0; i < W * H; i++) {
    seed = (seed * 1103515245 + 12345) & 0x7fffffff;
    const n = seed % 40;
    const x = i % W, y = (i / W) | 0;
    buf[i * 4] = (x * 255 / W + n) & 255; buf[i * 4 + 1] = (y * 255 / H + n) & 255; buf[i * 4 + 2] = 120 + n; buf[i * 4 + 3] = 255;
  }
  const synthetic = path.join(scratch, 'synthetic.png');
  fs.writeFileSync(synthetic, nativeImage.createFromBitmap(buf, { width: W, height: H }).toPNG());

  await check('the canvas measures Impact at the reference size (capital height and word widths)', async () => {
    const m = await canvas.measure('Impact', ['DON\'T', 'STAND'], layout.REFERENCE_SIZE);
    assert(m.capHeight > 60 && m.capHeight < 100, `cap height ${m.capHeight}`);
    assert(m.wordWidths.length === 2 && m.wordWidths.every((w) => w > 50), `widths ${m.wordWidths}`);
    assert(m.spaceWidth > 5, `space ${m.spaceWidth}`);
  });

  await check('a font this Mac does not have is refused by name, never drawn in a stand-in face', async () => {
    let threw = null;
    try { await canvas.measure('No Such Font 12345', ['HELLO'], 100); } catch (e) { threw = e; }
    assert(threw && /"No Such Font 12345" is not installed/.test(threw.message), threw ? threw.message : 'did not throw');
  });

  await check('an image-only variant renders at 1280x720 inside YouTube\'s bounds, and notes that no face was found', async () => {
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: null, style, photo: null, outStem: path.join(scratch, 'plain') });
    assert(r.ok, JSON.stringify(r));
    const meta = tv.measureThumbnailFile(r.path);
    assert(meta.width === OUTPUT_WIDTH && meta.height === OUTPUT_HEIGHT, `${meta.width}x${meta.height}`);
    assert(meta.bytes <= tv.MAX_THUMBNAIL_BYTES, `${meta.bytes} bytes`);
    assert(r.notes.some((n) => /no face/.test(n)), r.notes.join(' | '));
  });

  await check('a phrase renders with the text kept clear of the reaction and logo slots', async () => {
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: 'maybe tomorrow', style, photo: null, outStem: path.join(scratch, 'tomorrow') });
    assert(r.ok && r.plan, JSON.stringify(r));
    const slot = layout.slotRect(style.reactionSlot, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    const p = r.plan.patch;
    const e = 0.01;
    assert(!(p.x < slot.x + slot.w - e && slot.x < p.x + p.w - e && p.y < slot.y + slot.h - e && slot.y < p.y + p.h - e), 'the patch overlaps the reaction slot');
    assert(r.plan.capPx >= style.minCapFraction * OUTPUT_HEIGHT - 0.01, `cap ${r.plan.capPx}`);
    assert(r.plan.lines.every((l) => l.text === l.text.toUpperCase()), 'not capitals');
  });

  await check('a phrase too long for the space is refused in plain words and nothing is written', async () => {
    const stem = path.join(scratch, 'too-long');
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: 'the rapture keeps failing every single year since nineteen eighty eight', style, photo: null, outStem: stem });
    assert(!r.ok && /too long/.test(r.reason) && /Pick a shorter option/.test(r.reason), JSON.stringify(r));
    assert(!fs.existsSync(`${stem}.png`) && !fs.existsSync(`${stem}.jpg`), 'a file was written');
  });

  // A synthetic cut-out: a 1920x1080 transparent canvas, an opaque "person" block down to the
  // bottom edge, and a stray speck along the bottom (like selfie horrified.png's bars).
  const cutDir = path.join(scratch, 'selfies');
  fs.mkdirSync(cutDir);
  const cw = 1920, ch = 1080;
  const cut = Buffer.alloc(cw * ch * 4);
  const paint = (x0, y0, x1, y1) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) { const i = (y * cw + x) * 4; cut[i] = 40; cut[i + 1] = 60; cut[i + 2] = 200; cut[i + 3] = 255; } };
  paint(700, 200, 1300, 1080);
  paint(300, 1060, 420, 1080);
  fs.writeFileSync(path.join(cutDir, 'selfie keeper.png'), nativeImage.createFromBitmap(cut, { width: cw, height: ch }).toPNG());

  await check('a cut-out is trimmed to the person (the speck dropped), outlined in white, right side and bottom anchored', async () => {
    const list = photos.listReactionPhotos(cutDir);
    assert(list.length === 1 && list[0].name === 'keeper', JSON.stringify(list));
    const t = photos.trimmedPhoto(list[0]);
    // The person grown by EDGE_GROW (3 px) on the sides that are not the canvas's bottom edge.
    assert(t.width === 600 + 6 && t.height === 880 + 3, `trimmed to ${t.width}x${t.height}`);
    assert(t.note && /1 stray speck/.test(t.note), t.note);
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: 'maybe tomorrow', style, photo: t, outStem: path.join(scratch, 'with-photo') });
    assert(r.ok && r.reaction, JSON.stringify(r));
    const slot = layout.slotRect(style.reactionSlot, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    assert(Math.abs(r.reaction.x + r.reaction.w - (slot.x + slot.w)) < 1e-6, 'right side anchored');
    assert(r.reaction.y + r.reaction.h > OUTPUT_HEIGHT, 'runs off the bottom edge');
    const e = 0.01, p = r.plan.patch, a = r.reaction.avoid;
    assert(!(p.x < a.x + a.w - e && a.x < p.x + p.w - e && p.y < a.y + a.h - e && a.y < p.y + p.h - e), 'the text clears the photo');
    const bmp = nativeImage.createFromPath(r.path).toBitmap();
    const at = (x, y) => { const i = (Math.round(y) * OUTPUT_WIDTH + Math.round(x)) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
    const midY = r.reaction.y + r.reaction.h * 0.3;
    const ring = at(r.reaction.x - r.reaction.outlinePx / 2, midY);
    assert(ring.every((c) => c > 235), `the outline ring is white (${ring})`);
    const inside = at(r.reaction.x + r.reaction.w / 2, midY);
    assert(inside[0] > 150 && inside[2] < 90, `the photo is drawn over it (${inside})`);
  });

  await check('a missing photo folder, an empty one, and an unreadable photo are refused naming them', async () => {
    let err = null;
    try { photos.listReactionPhotos(path.join(scratch, 'nope')); } catch (e) { err = e; }
    assert(err && /folder is not there: .*nope/.test(err.message), err && err.message);
    const empty = path.join(scratch, 'empty');
    fs.mkdirSync(empty);
    err = null;
    try { photos.listReactionPhotos(empty); } catch (e) { err = e; }
    assert(err && /has no PNG photos in it/.test(err.message), err && err.message);
    const bad = path.join(scratch, 'bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'selfie broken.png'), 'not a png');
    err = null;
    try { photos.trimmedPhoto(photos.listReactionPhotos(bad)[0]); } catch (e) { err = e; }
    assert(err && /"broken" could not be read as an image: .*selfie broken\.png/.test(err.message), err && err.message);
  });

  if (fs.existsSync(REFERENCE_FRAME) && fs.existsSync(SELFIES)) {
    await check('the reference frame with Owen\'s cut-outs: A claim + "oh please", B stakes + "horrified", C no text + "laugh" (evidence renders)', async () => {
      const list = photos.listReactionPhotos(SELFIES);
      const named = (n) => { const f = list.find((p) => p.name === n); assert(f, `no "${n}" photo`); return photos.trimmedPhoto(f); };
      // The dark bars seen along the bottom of selfie horrified.png (x 505-640, 1570-1690) are fully
      // transparent in its alpha plane (checked with ffmpeg too), so they never draw: the trim
      // finds nothing separate to drop there, and the trimmed photo must not reach that far left.
      const horrified = named('horrified');
      console.log(`       horrified trimmed to ${horrified.width}x${horrified.height}; ${horrified.note ?? 'no separate specks'}`);
      for (const [stem, phrase, name] of [
        ['rapture - A (claim - DON\'T STAND UNDER A ROOF, oh please)', 'DON\'T STAND UNDER A ROOF', 'oh please'],
        ['rapture - B (stakes - MAYBE TOMORROW, horrified)', 'MAYBE TOMORROW', 'horrified'],
        ['rapture - C (no text, laugh)', null, 'laugh'],
      ]) {
        const r = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase, style, photo: named(name), outStem: path.join(outDir, stem) });
        assert(r.ok, JSON.stringify(r));
        tv.validateThumbnailFile(r.path);
        console.log(`       wrote ${r.path} (${(r.bytes / 1024).toFixed(0)} KB)${r.notes.length ? ' — ' + r.notes.join(' ') : ''}`);
      }
    });
  } else {
    skipped.push(`the cut-out evidence renders (${SELFIES} or the reference frame is not on this machine)`);
  }

  if (fs.existsSync(REFERENCE_FRAME)) {
    await check('the reference frame: Apple Vision finds her face, the text avoids it, and the render passes the door (evidence render)', async () => {
      const r = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: 'DON\'T STAND UNDER A ROOF', style, photo: null, outStem: path.join(scratch, 'rapture-a') });
      assert(r.ok, JSON.stringify(r));
      assert(r.faces.length >= 1, 'no face found');
      const face = layout.paddedFace(r.faces[0], OUTPUT_WIDTH, OUTPUT_HEIGHT);
      const b = r.plan.block;
      const e = 0.01;
      assert(!(b.x < face.x + face.w - e && face.x < b.x + b.w - e && b.y < face.y + face.h - e && face.y < b.y + b.h - e), 'the letters overlap the face');
      tv.validateThumbnailFile(r.path);
      console.log(`       wrote ${r.path} (${(r.bytes / 1024).toFixed(0)} KB ${r.format}; letters ${r.plan.capPx.toFixed(0)} px tall on ${r.plan.lines.length} line(s))`);
      const none = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: null, style, photo: null, outStem: path.join(scratch, 'rapture-c') });
      assert(none.ok, JSON.stringify(none));
      const tomorrow = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: 'MAYBE TOMORROW', style, photo: null, outStem: path.join(scratch, 'rapture-b') });
      assert(tomorrow.ok, JSON.stringify(tomorrow));
    });
  } else {
    skipped.push(`the reference-frame render (${REFERENCE_FRAME} is not on this machine)`);
  }

  canvas.close();
  fs.rmSync(scratch, { recursive: true, force: true });
  for (const s of skipped) console.log(`  skip ${s}`);
  console.log(`\nthumbnail lab (electron half): ${passed} passed, ${failed} failed`);
  app.exit(failed > 0 ? 1 : 0);
});
