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
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: null, style, outStem: path.join(scratch, 'plain') });
    assert(r.ok, JSON.stringify(r));
    const meta = tv.measureThumbnailFile(r.path);
    assert(meta.width === OUTPUT_WIDTH && meta.height === OUTPUT_HEIGHT, `${meta.width}x${meta.height}`);
    assert(meta.bytes <= tv.MAX_THUMBNAIL_BYTES, `${meta.bytes} bytes`);
    assert(r.notes.some((n) => /no face/.test(n)), r.notes.join(' | '));
  });

  await check('a phrase renders with the text kept clear of the reaction and logo slots', async () => {
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: 'maybe tomorrow', style, outStem: path.join(scratch, 'tomorrow') });
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
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: 'the rapture keeps failing every single year since nineteen eighty eight', style, outStem: stem });
    assert(!r.ok && /too long/.test(r.reason) && /Pick a shorter option/.test(r.reason), JSON.stringify(r));
    assert(!fs.existsSync(`${stem}.png`) && !fs.existsSync(`${stem}.jpg`), 'a file was written');
  });

  if (fs.existsSync(REFERENCE_FRAME)) {
    await check('the reference frame: Apple Vision finds her face, the text avoids it, and the render passes the door (evidence render)', async () => {
      const r = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: 'DON\'T STAND UNDER A ROOF', style, outStem: path.join(outDir, 'rapture - A (claim) - DON\'T STAND UNDER A ROOF') });
      assert(r.ok, JSON.stringify(r));
      assert(r.faces.length >= 1, 'no face found');
      const face = layout.paddedFace(r.faces[0], OUTPUT_WIDTH, OUTPUT_HEIGHT);
      const b = r.plan.block;
      const e = 0.01;
      assert(!(b.x < face.x + face.w - e && face.x < b.x + b.w - e && b.y < face.y + face.h - e && face.y < b.y + b.h - e), 'the letters overlap the face');
      tv.validateThumbnailFile(r.path);
      console.log(`       wrote ${r.path} (${(r.bytes / 1024).toFixed(0)} KB ${r.format}; letters ${r.plan.capPx.toFixed(0)} px tall on ${r.plan.lines.length} line(s))`);
      const none = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: null, style, outStem: path.join(outDir, 'rapture - C (no text)') });
      assert(none.ok, JSON.stringify(none));
      const tomorrow = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: 'MAYBE TOMORROW', style, outStem: path.join(outDir, 'rapture - B (stakes) - MAYBE TOMORROW') });
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
