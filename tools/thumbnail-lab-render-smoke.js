/**
 * The thumbnail renderer: the ELECTRON half of `npm run check:thumbnail-lab` (2026-09-28; built
 * for the Thumbnails test tab, which phase 2 retired: the metadata run and the reports page's
 * Thumbnails window draw with it now).
 *
 * The pure half (tools/thumbnail-lab-checks.js) proves the arithmetic; this proves the page:
 * the hidden canvas finds faces with Apple Vision (Chromium's FaceDetector), measures in a real
 * installed font, refuses a font that is not installed, draws, and the file it writes passes the
 * app's own thumbnail door (≤ 2 MiB, 1280x720). Words are always drawn (phase 2): a phrase no
 * face-free space holds is drawn smaller in the text box, never refused. It needs the electron
 * binary for the page:
 *
 *   npm run build:electron && npx electron tools/thumbnail-lab-render-smoke.js [outDir]
 *
 * The logo (2026-09-28): a synthetic wide logo with a transparent margin is cut to its visible
 * pixels, fitted in its space with its aspect kept, drawn exactly there (and nowhere else in the
 * space), and a missing or unreadable logo file is refused naming it.
 *
 * The library (2026-09-28): a real PNG cut-out and logo are copied into a scratch userData's
 * `thumbnail-lab/` (never Owen's), read back from there by ThumbnailLook (look.ts), and an
 * unreadable logo is refused before anything is copied. "TAKE YOUR CLOTHES OFF" is rendered on the
 * reference frame on one or two lines (evidence render).
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
const logos = require(path.join(ROOT, 'services/thumbnails/logo.js'));
const library = require(path.join(ROOT, 'services/thumbnails/photo-library.js'));
const { photoName } = require(path.join(ROOT, 'services/thumbnails/photo-trim.js'));
const { ThumbnailLook } = require(path.join(ROOT, 'services/thumbnails/look.js'));
require(path.join(ROOT, 'services/metadata/prompt-assets.js')).initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));

/** The PNG photos of a folder by name, read in place (Owen's own folder is only ever read here). */
function listIn(folder) {
  return fs.readdirSync(folder).filter((f) => /\.png$/i.test(f) && !f.startsWith('.')).map((f) => ({ name: photoName(f), file: path.join(folder, f) }));
}

/** Owen's logo (a 2000x2000 round badge with alpha), when this Mac has it (read in place). */
const LOGO = '/Volumes/Callisto/youtube data/Misc/final logos/deprecated/logo-xl-blue-fixed-2mb.png';

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
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: null, style, photo: null, logo: null, outStem: path.join(scratch, 'plain') });
    assert(r.ok, JSON.stringify(r));
    const meta = tv.measureThumbnailFile(r.path);
    assert(meta.width === OUTPUT_WIDTH && meta.height === OUTPUT_HEIGHT, `${meta.width}x${meta.height}`);
    assert(meta.bytes <= tv.MAX_THUMBNAIL_BYTES, `${meta.bytes} bytes`);
    assert(r.notes.some((n) => /no face/.test(n)), r.notes.join(' | '));
  });

  await check('a phrase renders with the text kept clear of the reaction and logo slots', async () => {
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: 'maybe tomorrow', style, photo: null, logo: null, outStem: path.join(scratch, 'tomorrow') });
    assert(r.ok && r.plan, JSON.stringify(r));
    const slot = layout.slotRect(style.reactionSlot, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    const p = r.plan.patch;
    const e = 0.01;
    assert(!(p.x < slot.x + slot.w - e && slot.x < p.x + p.w - e && p.y < slot.y + slot.h - e && slot.y < p.y + p.h - e), 'the patch overlaps the reaction slot');
    assert(r.plan.capPx >= style.minCapFraction * OUTPUT_HEIGHT - 0.01, `cap ${r.plan.capPx}`);
    assert(r.plan.lines.every((l) => l.text === l.text.toUpperCase()), 'not capitals');
  });

  await check('a phrase too long for the space at the floor is still drawn: every word, one or two lines, inside the text box, and the file passes the door', async () => {
    const stem = path.join(scratch, 'too-long');
    const phrase = 'the rapture keeps failing every single year since nineteen eighty eight';
    const tight = { ...style, reactionSlot: { x: 0.3, y: 0.2, w: 0.68, h: 0.78 } };
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase, style: tight, photo: null, logo: null, outStem: stem });
    assert(r.ok && r.plan, JSON.stringify(r));
    assert(r.plan.lines.length <= 2 && r.plan.lines.map((l) => l.text).join(' ') === phrase.toUpperCase(), JSON.stringify(r.plan.lines));
    const box = r.plan.box, p = r.plan.patch;
    assert(p.x >= box.x - 0.01 && p.x + p.w <= box.x + box.w + 0.01 && p.y >= box.y - 0.01 && p.y + p.h <= box.y + box.h + 0.01, `the patch leaves the text box: ${JSON.stringify(p)} in ${JSON.stringify(box)}`);
    assert(fs.existsSync(`${stem}.png`) || fs.existsSync(`${stem}.jpg`), 'no file was written');
    tv.validateThumbnailFile(r.path);
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
    const list = listIn(cutDir);
    assert(list.length === 1 && list[0].name === 'keeper', JSON.stringify(list));
    const t = photos.trimmedPhoto(list[0]);
    // The person grown by EDGE_GROW (3 px) on the sides that are not the canvas's bottom edge.
    assert(t.width === 600 + 6 && t.height === 880 + 3, `trimmed to ${t.width}x${t.height}`);
    assert(t.note && /1 stray speck/.test(t.note), t.note);
    const r = await renderThumbnail({ canvas, frame: synthetic, phrase: 'maybe tomorrow', style, photo: t, logo: null, outStem: path.join(scratch, 'with-photo') });
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

  // A synthetic logo: 600x300, a solid red 400x100 bar (4:1) inside a transparent margin.
  const lw = 600, lh = 300;
  const lbuf = Buffer.alloc(lw * lh * 4);
  for (let y = 100; y < 200; y++) for (let x = 100; x < 500; x++) { const i = (y * lw + x) * 4; lbuf[i] = 0; lbuf[i + 1] = 0; lbuf[i + 2] = 255; lbuf[i + 3] = 255; }
  const logoFile = path.join(scratch, 'logo.png');
  fs.writeFileSync(logoFile, nativeImage.createFromBitmap(lbuf, { width: lw, height: lh }).toPNG());

  await check('the logo is cut to its visible pixels, fitted in its space with its aspect kept, top-right, and drawn only there', async () => {
    const logo = logos.readLogo(logoFile);
    assert(logo.width === 400 && logo.height === 100 && logo.fileWidth === 600, `visible ${logo.width}x${logo.height} of ${logo.fileWidth}x${logo.fileHeight}`);
    const r = await renderThumbnail({
      canvas, frame: synthetic, phrase: 'maybe tomorrow', style, photo: null, outStem: path.join(scratch, 'with-logo'),
      logo: { width: logo.width, height: logo.height, at: (w, h) => logos.logoAt(logo, w, h) },
    });
    assert(r.ok && r.logo, JSON.stringify(r));
    const slot = layout.slotRect(style.logoSlot, OUTPUT_WIDTH, OUTPUT_HEIGHT);
    const L = r.logo;
    assert(Math.abs(L.w / L.h - 4) <= 4 / L.h, `aspect kept: ${L.w}x${L.h}`);
    assert(L.x >= slot.x - 0.5 && L.x + L.w <= slot.x + slot.w + 0.5 && L.y >= slot.y - 0.5 && L.y + L.h <= slot.y + slot.h + 0.5, `inside the space: ${JSON.stringify(L)} in ${JSON.stringify(slot)}`);
    const bmp = nativeImage.createFromPath(r.path).toBitmap();
    const at = (x, y) => { const i = (Math.round(y) * OUTPUT_WIDTH + Math.round(x)) * 4; return [bmp[i + 2], bmp[i + 1], bmp[i]]; };
    const mid = at(L.x + L.w / 2, L.y + L.h / 2);
    assert(mid[0] > 230 && mid[1] < 30 && mid[2] < 30, `the logo is drawn at its place (${mid})`);
    const below = at(L.x + L.w / 2, Math.min(slot.y + slot.h - 1, L.y + L.h + 4));
    assert(!(below[0] > 200 && below[1] < 40 && below[2] < 40), `nothing red below the logo inside its space (${below})`);
    const p = r.plan.patch, e = 0.01;
    assert(!(p.x < L.x + L.w - e && L.x < p.x + p.w - e && p.y < L.y + L.h - e && L.y < p.y + p.h - e), 'the words clear the logo');
  });

  await check('the metadata run\'s renderer (pipeline-electron.ts): the photo trimmed and the logo cut as the tab does, drawn on its own canvas page, closed after', async () => {
    const { electronThumbnailRenderer } = require(path.join(ROOT, 'services/thumbnails/pipeline-electron.js'));
    const renderer = electronThumbnailRenderer(REPO);
    try {
      const cut = listIn(cutDir)[0];
      const r = await renderer.render({ frame: synthetic, phrase: 'maybe tomorrow', style, photo: { name: cut.name, file: cut.file }, logoFile, outStem: path.join(scratch, 'pipeline-pair') });
      assert(r.ok && r.reaction && r.logo, JSON.stringify(r));
      const meta = tv.measureThumbnailFile(r.path);
      assert(meta.width === OUTPUT_WIDTH && meta.height === OUTPUT_HEIGHT && meta.bytes <= tv.MAX_THUMBNAIL_BYTES, JSON.stringify(meta));
      const none = await renderer.render({ frame: synthetic, phrase: 'maybe tomorrow', style, photo: { name: cut.name, file: cut.file }, logoFile: null, outStem: path.join(scratch, 'pipeline-pair-no-logo') });
      assert(none.ok && none.logo === null, 'no logo file: none drawn');
    } finally {
      renderer.close();
    }
  });

  await check('a missing or unreadable logo file is refused naming it', async () => {
    let err = null;
    try { logos.readLogo(path.join(scratch, 'no-logo.png')); } catch (e) { err = e; }
    assert(err && /The logo file is not there: .*no-logo\.png/.test(err.message), err && err.message);
    fs.writeFileSync(path.join(scratch, 'bad-logo.png'), 'not a png');
    err = null;
    try { logos.readLogo(path.join(scratch, 'bad-logo.png')); } catch (e) { err = e; }
    assert(err && /could not be read as an image .*bad-logo\.png/.test(err.message), err && err.message);
  });

  await check('an unreadable photo is refused naming it', async () => {
    const bad = path.join(scratch, 'bad');
    fs.mkdirSync(bad);
    fs.writeFileSync(path.join(bad, 'selfie broken.png'), 'not a png');
    let err = null;
    try { photos.trimmedPhoto(listIn(bad)[0]); } catch (e) { err = e; }
    assert(err && /"broken" could not be read as an image: .*selfie broken\.png/.test(err.message), err && err.message);
  });

  await check('the library: a cut-out and a logo are copied into <userData>/thumbnail-lab (a scratch userData) and read from there; an unreadable logo is refused before anything is copied', async () => {
    const userData = path.join(scratch, 'userData');
    const lab = new ThumbnailLook({ store: { get: () => undefined, set: () => {} }, userDataPath: userData });
    const added = lab.addPhotos([cutDir], false);
    assert(added.added.join() === 'keeper', JSON.stringify(added));
    const shown = lab.photos();
    assert(shown.photos.length === 1 && shown.photos[0].name === 'keeper' && shown.photos[0].preview.startsWith('data:image/png'), JSON.stringify(shown).slice(0, 200));
    assert(shown.folder === path.join(userData, 'thumbnail-lab', 'reaction-photos'), shown.folder);
    let err = null;
    fs.writeFileSync(path.join(scratch, 'bad-logo.png'), 'not a png');
    try { lab.setLogo(path.join(scratch, 'bad-logo.png')); } catch (e) { err = e; }
    assert(err && /not a PNG or JPEG|must be a PNG or JPEG/.test(err.message), err && err.message);
    const set = lab.setLogo(logoFile);
    assert(set.logo && set.logo.width === 600 && set.logo.file === path.join(userData, 'thumbnail-lab', 'logo', 'logo.png'), JSON.stringify(set));
    assert(fs.existsSync(logoFile), 'the chosen logo stays where it was');
  });

  if (fs.existsSync(REFERENCE_FRAME) && fs.existsSync(SELFIES)) {
    await check('the reference frame with Owen\'s cut-outs: A claim + "oh please", B stakes + "horrified", C no text + "laugh" (evidence renders)', async () => {
      const list = listIn(SELFIES);
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
        const r = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase, style, photo: named(name), logo: null, outStem: path.join(outDir, stem) });
        assert(r.ok, JSON.stringify(r));
        tv.validateThumbnailFile(r.path);
        console.log(`       wrote ${r.path} (${(r.bytes / 1024).toFixed(0)} KB)${r.notes.length ? ' — ' + r.notes.join(' ') : ''}`);
      }
    });
  } else {
    skipped.push(`the cut-out evidence renders (${SELFIES} or the reference frame is not on this machine)`);
  }

  if (fs.existsSync(REFERENCE_FRAME) && fs.existsSync(SELFIES) && fs.existsSync(LOGO)) {
    await check('the reference frame as the run\'s three defaults: the top claim, stakes and reaction, each pair\'s top-ranked photo (a stubbed ranking) and Owen\'s logo (evidence renders)', async () => {
      const variants = [
        { letter: 'A', text: { kind: 'claim', phrase: 'DON\'T STAND UNDER A ROOF' } },
        { letter: 'B', text: { kind: 'stakes', phrase: 'MAYBE TOMORROW' } },
        { letter: 'C', text: { kind: 'reaction', phrase: 'THE RAPTURE IS HERE' } },
      ];
      // The judge's ranking, stubbed locally (no Crucible): what the tone/photo step would hand back per pair.
      const stub = { A: ['horrified', 'oh please'], B: ['oh please', 'laugh'], C: ['laugh', 'oh wow'] };
      const list = listIn(SELFIES);
      const logo = logos.readLogo(LOGO);
      for (const v of variants) {
        const name = stub[v.letter][0];
        const file = list.find((p) => p.name === name);
        assert(file, `no "${name}" photo`);
        const r = await renderThumbnail({
          canvas, frame: REFERENCE_FRAME, phrase: v.text.phrase, style, photo: photos.trimmedPhoto(file),
          logo: { width: logo.width, height: logo.height, at: (w, h) => logos.logoAt(logo, w, h) },
          outStem: path.join(outDir, `rapture - ${v.letter} (${v.text.kind} - ${v.text.phrase.replace(/'/g, '')}, ${name}, logo)`),
        });
        assert(r.ok && r.reaction && r.logo, JSON.stringify(r));
        tv.validateThumbnailFile(r.path);
        console.log(`       wrote ${r.path} (${(r.bytes / 1024).toFixed(0)} KB ${r.format}; logo ${r.logo.w}x${r.logo.h} at ${r.logo.x},${r.logo.y})`);
      }
    });
  } else {
    skipped.push(`the logo evidence renders (the reference frame, ${SELFIES} or ${LOGO} is not on this machine)`);
  }

  if (fs.existsSync(REFERENCE_FRAME)) {
    await check('"TAKE YOUR CLOTHES OFF" on the reference frame is drawn whole on one or two lines, clear of the face when the 7% floor allows (evidence render)', async () => {
      assert(style.minCapFraction === 0.07, `floor ${style.minCapFraction}`);
      const r = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: 'TAKE YOUR CLOTHES OFF', style, photo: null, logo: null, outStem: path.join(outDir, 'take your clothes off') });
      assert(r.ok, JSON.stringify(r));
      assert(r.plan.lines.length <= 2 && r.plan.lines.map((l) => l.text).join(' ') === 'TAKE YOUR CLOTHES OFF', JSON.stringify(r.plan.lines));
      if (r.plan.placement === 'clear') for (const f of r.faces) {
        const face = layout.paddedFace(f, OUTPUT_WIDTH, OUTPUT_HEIGHT), b = r.plan.patch, e = 0.01;
        assert(!(b.x < face.x + face.w - e && face.x < b.x + b.w - e && b.y < face.y + face.h - e && face.y < b.y + b.h - e), 'the words overlap a face');
      }
      tv.validateThumbnailFile(r.path);
      console.log(`       wrote ${r.path} (letters ${r.plan.capPx.toFixed(0)} px on ${r.plan.lines.length} line(s): ${r.plan.lines.map((l) => l.text).join(' / ')})`);
      // Squeezed by a reaction space as wide as Owen's frame left: drawn anyway, smaller, and said.
      const tight = { ...style, reactionSlot: { x: 0.36, y: 0.3, w: 0.62, h: 0.68 } };
      const now = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: 'TAKE YOUR CLOTHES OFF', style: tight, photo: null, logo: null, outStem: path.join(outDir, 'take your clothes off - tight space') });
      console.log(`       tight space: drawn at ${now.plan.capPx.toFixed(0)} px on ${now.plan.lines.length} line(s) (${now.plan.placement})${now.notes.length ? ' - ' + now.notes.join(' ') : ''}`);
      assert(now.ok && now.plan.lines.length <= 2, JSON.stringify(now.plan.lines));
    });

    await check('the reference frame: Apple Vision finds her face, the text avoids it, and the render passes the door (evidence render)', async () => {
      const r = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: 'DON\'T STAND UNDER A ROOF', style, photo: null, logo: null, outStem: path.join(scratch, 'rapture-a') });
      assert(r.ok, JSON.stringify(r));
      assert(r.faces.length >= 1, 'no face found');
      const face = layout.paddedFace(r.faces[0], OUTPUT_WIDTH, OUTPUT_HEIGHT);
      const b = r.plan.block;
      const e = 0.01;
      assert(!(b.x < face.x + face.w - e && face.x < b.x + b.w - e && b.y < face.y + face.h - e && face.y < b.y + b.h - e), 'the letters overlap the face');
      tv.validateThumbnailFile(r.path);
      console.log(`       wrote ${r.path} (${(r.bytes / 1024).toFixed(0)} KB ${r.format}; letters ${r.plan.capPx.toFixed(0)} px tall on ${r.plan.lines.length} line(s))`);
      const none = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: null, style, photo: null, logo: null, outStem: path.join(scratch, 'rapture-c') });
      assert(none.ok, JSON.stringify(none));
      const tomorrow = await renderThumbnail({ canvas, frame: REFERENCE_FRAME, phrase: 'MAYBE TOMORROW', style, photo: null, logo: null, outStem: path.join(scratch, 'rapture-b') });
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
