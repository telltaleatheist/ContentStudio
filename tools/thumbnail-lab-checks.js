/**
 * Keeper: the thumbnail modules the metadata run and the reports page's Thumbnails window share
 * (built for the Thumbnails test tab on 2026-09-28; the tab was retired in phase 2 the same day,
 * and its tab-only checks went with it). The Node half of `npm run check:thumbnail-lab`.
 *
 * What it pins, against the COMPILED main process (no Crucible, no card):
 *
 *   - FRAME FILTERING: the difference hash finds a held frame and keeps the sharper copy; a
 *     motion-blurred frame falls under the run's median rule; thinning spreads across the range.
 *   - SAMPLING: real ffmpeg passes over a synthetic 16:9 test video give one frame a second INSIDE
 *     the stretches asked for (never between them), both JPEG sizes on disk, and a non-16:9 video
 *     is refused naming its size.
 *   - THE STORY SOURCE (2026-09-28): regions minus cuts, the timeline mapped piece by piece through
 *     the segment table, master to screen recording by the alignment's offset and drift, cut to the
 *     recording's length; frames come only from the story's stretches of the screen recording; an
 *     untrusted alignment, a missing or split screen recording and a renamed story are refused by
 *     name. The real 2026-09-24 session is read (never written) as a fixture reference.
 *   - SCENES (2026-09-28): kept frames group by how they look across the whole story (alternating
 *     clips rejoin their scene, a speaker moving inside a clip does not split it, a scene of two
 *     frames stays its own); the nearest-neighbour chain gives the same groups as merging the
 *     closest pair; every sampled frame counts toward a scene's time on screen.
 *   - THE GRID (2026-09-29, Owen picks frames 1, 2 and 3 himself; the vision model's frame scoring,
 *     its ranking and its checks were removed): each scene offers at most two frames (one when on
 *     screen under SHORT_SCENE_SECONDS), the sharpest of each half of its time on screen, all in
 *     time order.
 *   - TEXT: the words prompt fills every slot from thumbnails.yml; the plain-text answer parses into
 *     the three kinds with decoration stripped and off-brief options warned about, never dropped.
 *   - THE TEXT ALWAYS FITS (phase 2, Owen 2026-09-28): the text box runs from the left margin to
 *     where the reaction photo begins and from the top margin to the bottom margin; one or two
 *     lines, shrunk to fit, never refused and never cut; off the padded faces and the logo when a
 *     face-free space holds the words at the 7% floor, else in the whole box at the floor or smaller
 *     where they cover the least of a face, said in the note.
 *   - TEXT SIZE (2026-09-29, Owen: "make the text slightly smaller"): the words are drawn at the
 *     look's `textScale` (85% by default) of the size chosen, so the largest letters are 17% of the
 *     height instead of 20% and every fitted size is 15% smaller; the off-the-faces decision is
 *     made at the full size. A look saved before (no textScale, no border, the retired vignette)
 *     is read with the new defaults and a line saying so.
 *   - the logo is fitted in its space with its aspect kept and the words avoid its drawn bounds;
 *     the reaction photos and logo are copied into the app's library (ThumbnailLook: add,
 *     duplicate refused then replaced, remove, the one-click copy offer from the old folder
 *     setting, originals untouched) on a CONTENTSTUDIO_USER_DATA scratch folder; the border overlay
 *     (2026-09-29) is kept the same way (one PNG, a refused file leaves the kept one); small
 *     interleaved fragments of one moving shot fold into one scene. (The tone and photo ranking, its
 *     notes and the top-3 draw were removed 2026-09-29 with their checks: Owen picks his photos
 *     himself; the frame scoring went the same day: he picks the frames too.)
 *
 * The rendering half (Apple Vision faces, real fonts, file limits) is
 * tools/thumbnail-lab-render-smoke.js under the electron binary.
 *
 *   npm run build:electron && node tools/thumbnail-lab-checks.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { assert, rejection, check, run, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
services('metadata/prompt-assets.js').initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));
const metrics = services('thumbnails/frame-metrics.js');
const scenes = services('thumbnails/frame-scenes.js');
const layout = require(path.join(DIST, 'shared', 'thumbnail-layout.js'));
const prompts = services('thumbnails/prompts.js');
const sampler = services('thumbnails/frame-sampler.js');

const FFMPEG = path.join(REPO, 'node_modules', '@ffmpeg-installer', `${process.platform}-${process.arch}`, 'ffmpeg');
const FFPROBE = path.join(REPO, 'node_modules', '@ffprobe-installer', `${process.platform}-${process.arch}`, 'ffprobe');

// ── helpers ─────────────────────────────────────────────────────────────────

const W = 160, H = 90;
/** A grey test frame: a bright square at (x, y) on a dark field, with a little seeded texture. */
function frame(x, y, seed = 1) {
  const g = new Uint8Array(W * H);
  let s = seed;
  for (let i = 0; i < g.length; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    g[i] = 30 + (s % 20);
  }
  for (let yy = y; yy < y + 30; yy++) for (let xx = x; xx < x + 40; xx++) g[yy * W + xx] = 220;
  return g;
}
/** A box blur, to make a motion-blurred copy. */
function blur(g, r) {
  const out = new Uint8Array(g.length);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let sum = 0, n = 0;
    for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
      const yy = Math.min(H - 1, Math.max(0, y + dy)), xx = Math.min(W - 1, Math.max(0, x + dx));
      sum += g[yy * W + xx]; n++;
    }
    out[y * W + x] = sum / n;
  }
  return out;
}
function measure(index, g) {
  return { index, t: index, hash: metrics.differenceHash(g, W, H), sharpness: metrics.laplacianVariance(g, W, H) };
}
/** Impact-like metrics at REFERENCE_SIZE: 0.5 em per letter, a 0.25 em space, caps at 0.8 em. */
function metricsFor(phrase) {
  const words = layout.phraseWords(phrase);
  return { words, wordWidths: words.map((w) => w.length * 50), spaceWidth: 25, capHeight: 80 };
}
function overlaps(a, b, e = 0.01) {
  return a.x < b.x + b.w - e && b.x < a.x + a.w - e && a.y < b.y + b.h - e && b.y < a.y + a.h - e;
}

// ── frame filtering ─────────────────────────────────────────────────────────

check('filtering: a held frame is one picture (the sharper copy stays), a moved one is not, a blurred one goes', () => {
  const a = frame(20, 20, 1);
  const aAgain = frame(20, 20, 2); // same picture, different sensor noise
  const moved = frame(100, 50, 3);
  const smeared = blur(frame(60, 30, 4), 3);
  const frames = [measure(0, a), measure(1, aAgain), measure(2, moved), measure(3, smeared), measure(4, frame(40, 40, 5))];
  assert.ok(metrics.hammingDistance(frames[0].hash, frames[1].hash) <= metrics.DUPLICATE_MAX_BITS, 'the held pair hash alike');
  assert.ok(metrics.hammingDistance(frames[0].hash, frames[2].hash) > metrics.DUPLICATE_MAX_BITS, 'a moved square hashes apart');
  const r = metrics.filterFrames(frames);
  const kept = r.kept.map((f) => f.index);
  assert.ok(!kept.includes(3), `the blurred frame is dropped (kept ${kept})`);
  assert.deepStrictEqual(r.dropped.find((d) => d.index === 3).reason, 'blurry');
  assert.ok(kept.includes(2) && kept.includes(4), 'distinct frames stay');
  const pair = [0, 1].filter((i) => kept.includes(i));
  assert.strictEqual(pair.length, 1, 'one of the held pair stays');
  const winner = pair[0];
  assert.ok(frames[winner].sharpness >= frames[1 - winner].sharpness, 'the sharper copy is the one kept');
  assert.strictEqual(r.dropped.find((d) => d.index === 1 - winner).reason, 'repeat');
});

check('filtering: thinning keeps the cap and spreads it across the range, sharpest per stretch', () => {
  const frames = Array.from({ length: 300 }, (_, i) => ({ t: 100 + i, sharpness: (i * 37) % 101 }));
  const thin = metrics.thinAcrossRange(frames, 100, 400, 30);
  assert.strictEqual(thin.length, 30);
  for (let b = 0; b < 30; b++) {
    const stretch = frames.filter((f) => f.t >= 100 + b * 10 && f.t < 110 + b * 10);
    assert.strictEqual(thin[b].sharpness, Math.max(...stretch.map((f) => f.sharpness)));
  }
  assert.strictEqual(metrics.thinAcrossRange(frames.slice(0, 10), 100, 400, 30).length, 10, 'under the cap, nothing is thinned');
  // Stretches with nothing kept (a desktop stretch, a held shot) do not leave the cap short: the
  // stretches that have frames give a second round.
  const gappy = frames.filter((f) => f.t < 160 || f.t >= 340);
  const filled = metrics.thinAcrossRange(gappy, 100, 400, 30);
  assert.strictEqual(filled.length, 30, `the cap is filled (${filled.length})`);
  for (let i = 1; i < filled.length; i++) assert.ok(filled[i].t > filled[i - 1].t, 'time order');
});

// ── scenes ─────────────────────────────────────────────────────────────────

/** A 16x9 colour signature: a background painter, then an optional speaker block of cells. */
function sig(background, speaker = null, noiseSeed = 1) {
  const out = new Uint8Array(scenes.SIG_BYTES);
  let s = noiseSeed;
  for (let y = 0; y < scenes.SIG_ROWS; y++) for (let x = 0; x < scenes.SIG_COLS; x++) {
    const c = background(x, y);
    for (let k = 0; k < 3; k++) {
      s = (s * 1103515245 + 12345) & 0x7fffffff;
      out[(y * scenes.SIG_COLS + x) * 3 + k] = Math.max(0, Math.min(255, c[k] + (s % 11) - 5));
    }
  }
  if (speaker) {
    for (let y = speaker.y; y < speaker.y + 5; y++) for (let x = speaker.x; x < speaker.x + 3; x++) {
      out.set(speaker.colour, (y * scenes.SIG_COLS + x) * 3);
    }
  }
  return out;
}
// Clip A: a studio (navy left, red right) with a host who moves around; clip B: a garden (green
// over grey) with a different host; clip C: a white document page on dark grey, two frames only.
const studio = (x) => (x < 8 ? [30, 40, 110] : [150, 30, 30]);
const garden = (x, y) => (y < 5 ? [40, 140, 50] : [120, 120, 120]);
const page = (x) => (x >= 5 && x < 11 ? [235, 235, 235] : [40, 40, 40]);
const skin = [210, 160, 130];

check('scenes: alternating clips rejoin their scene, a moving speaker does not split one, a two-frame scene stays its own', () => {
  const kept = [];
  let t = 0;
  const add = (colour, scene) => { kept.push({ index: kept.length, t: t++, colour, sharpness: 10, scene }); };
  // A B A B C A: the host in A walks from the left edge to the right; B's host shifts a little.
  for (let round = 0; round < 3; round++) {
    for (let k = 0; k < 6; k++) add(sig(studio, { x: (round * 6 + k) % 13, y: 2, colour: skin }, 10 + t), 'A');
    if (round < 2) for (let k = 0; k < 4; k++) add(sig(garden, { x: 6 + (k % 2), y: 3, colour: [90, 60, 50] }, 50 + t), 'B');
    if (round === 1) for (let k = 0; k < 2; k++) add(sig(page, null, 90 + t), 'C');
  }
  const sampled = kept.map((f) => ({ index: f.index, colour: f.colour }));
  // A dropped repeat of the page, sampled but not kept, counts toward the page's time on screen.
  sampled.push({ index: 999, colour: sig(page, null, 7) });
  const got = scenes.groupScenes(kept, sampled, 1);
  assert.strictEqual(got.length, 3, `three scenes (got ${got.map((s) => s.frames.map((f) => f.scene).join('')).join(' | ')})`);
  assert.deepStrictEqual(got.map((s) => [...new Set(s.frames.map((f) => f.scene))]), [['A'], ['B'], ['C']], 'each scene is one clip, numbered by first appearance');
  assert.deepStrictEqual(got.map((s) => s.frames.length), [18, 8, 2]);
  assert.deepStrictEqual(got.map((s) => s.seconds), [18, 8, 3], 'screen time counts the sampled repeat');
  const moved = scenes.signatureDistance(sig(studio, { x: 0, y: 2, colour: skin }), sig(studio, { x: 12, y: 2, colour: skin }));
  assert.ok(moved < scenes.SCENE_JOIN_FRACTION, `the host crossing the frame changes ${moved.toFixed(2)} of the cells`);
  assert.ok(scenes.signatureDistance(sig(studio), sig(garden)) > scenes.SCENE_JOIN_FRACTION, 'two clips differ in most cells');
  assert.throws(() => scenes.signatureDistance(new Uint8Array(3), sig(studio)), /signature is 432 bytes/);
});

check('scenes: the nearest-neighbour chain gives the same groups as merging the closest pair until none is close enough', () => {
  const backgrounds = [studio, garden, page, (x, y) => [(x * 15) % 255, (y * 25) % 255, 90], () => [200, 190, 60]];
  let seed = 3;
  const rand = () => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed / 0x7fffffff; };
  const sigs = [];
  for (let i = 0; i < 70; i++) {
    const bg = backgrounds[Math.floor(rand() * backgrounds.length)];
    sigs.push(sig(bg, rand() < 0.7 ? { x: Math.floor(rand() * 13), y: Math.floor(rand() * 4), colour: [Math.floor(rand() * 255), 120, 90] } : null, i + 1));
  }
  const naive = (join) => {
    let clusters = sigs.map((_, i) => [i]);
    const d = (a, b) => scenes.signatureDistance(sigs[a], sigs[b]);
    const avg = (A, B) => { let sum = 0; for (const a of A) for (const b of B) sum += d(a, b); return sum / (A.length * B.length); };
    for (;;) {
      let best = Infinity, bi = -1, bj = -1;
      for (let i = 0; i < clusters.length; i++) for (let j = i + 1; j < clusters.length; j++) { const v = avg(clusters[i], clusters[j]); if (v < best) { best = v; bi = i; bj = j; } }
      if (bi < 0 || best > join) break;
      clusters[bi] = clusters[bi].concat(clusters[bj]).sort((a, b) => a - b);
      clusters.splice(bj, 1);
    }
    return clusters.sort((a, b) => a[0] - b[0]);
  };
  for (const join of [0.2, 0.4, scenes.SCENE_JOIN_FRACTION, 0.8]) {
    assert.deepStrictEqual(scenes.averageLinkageGroups(sigs, join), naive(join), `the groups at a cut of ${join}`);
  }
  assert.deepStrictEqual(scenes.averageLinkageGroups([sigs[0]]), [[0]], 'one frame is one scene');
  assert.throws(() => scenes.averageLinkageGroups([]), /no frames to group/);
});

check('grid: each scene offers at most two frames, one when on screen under SHORT_SCENE_SECONDS, never more than it kept', () => {
  assert.strictEqual(scenes.GRID_PER_SCENE, 2);
  assert.strictEqual(scenes.gridQuota({ size: 200, seconds: 400 }), 2);
  assert.strictEqual(scenes.gridQuota({ size: 20, seconds: scenes.SHORT_SCENE_SECONDS - 1 }), 1, 'a short scene offers one');
  assert.strictEqual(scenes.gridQuota({ size: 20, seconds: scenes.SHORT_SCENE_SECONDS }), 2);
  assert.strictEqual(scenes.gridQuota({ size: 1, seconds: 400 }), 1, 'a scene that kept one frame offers it');
  assert.throws(() => scenes.gridQuota({ size: 0, seconds: 10 }), /offers nothing/);
});

check('grid: the sharpest of each half of a scene\'s time on screen (both visits of a scene the story returns to), in time order; no frame of another scene', () => {
  const mk = (t, sharpness) => ({ t, sharpness });
  // Scene 1: visited at 0-19 and again at 500-519; the sharpest of each visit is 7 and 511.
  const one = [...Array.from({ length: 20 }, (_, i) => mk(i, i === 7 ? 90 : 10)), ...Array.from({ length: 20 }, (_, i) => mk(500 + i, i === 11 ? 80 : 20))];
  // Scene 2: on screen 5 s, so one frame: its sharpest.
  const two = [mk(100, 5), mk(101, 50), mk(102, 5), mk(103, 5), mk(104, 5)];
  // Scene 3: 30 s in one stretch; the sharpest of each half.
  const three = Array.from({ length: 30 }, (_, i) => mk(200 + i, i === 3 ? 70 : i === 25 ? 60 : i === 4 ? 65 : 1));
  const list = [
    { number: 1, frames: one, sampled: 40, seconds: 40 },
    { number: 2, frames: two, sampled: 5, seconds: 5 },
    { number: 3, frames: three, sampled: 30, seconds: 30 },
  ];
  const grid = scenes.gridFrames(list);
  assert.deepStrictEqual(grid.map((f) => f.t), [7, 101, 203, 225, 511], 'the sharpest of each half, spread apart; in time order');
  assert.ok(!grid.some((f) => f.t === 204), 'the second sharpest of scene 3 sits in the same half as its sharpest, so it is not taken');
  assert.throws(() => scenes.gridFrames([{ number: 9, frames: [], sampled: 0, seconds: 0 }]), /scene 9 has no kept frames/);
});

check('grid: look-alikes are dropped across the whole grid, the sharper kept, in time order', () => {
  const sig = (fill, changed = 0) => {
    const s = new Uint8Array(scenes.SIG_BYTES).fill(fill);
    for (let c = 0; c < changed; c++) s.fill(fill + 100, c * 3, c * 3 + 3);
    return s;
  };
  const cells = scenes.SIG_COLS * scenes.SIG_ROWS;
  const under = Math.floor(cells * scenes.DISTINCT_MIN_FRACTION); // 36 of 144: not more than the bar, a look-alike
  const frames = [
    { t: 1, sharpness: 10, colour: sig(20) },
    { t: 2, sharpness: 40, colour: sig(20, under) }, // looks like t=1 and is sharper: it stays, t=1 goes
    { t: 3, sharpness: 5, colour: sig(20, under + 1) }, // differs from t=2 in 1 cell: a look-alike of it
    { t: 4, sharpness: 5, colour: sig(150) }, // another shot
  ];
  assert.strictEqual(scenes.DISTINCT_MIN_FRACTION, 0.25);
  assert.deepStrictEqual(scenes.distinctFrames(frames).map((f) => f.t), [2, 4]);
  const apart = [{ t: 9, sharpness: 1, colour: sig(20) }, { t: 5, sharpness: 2, colour: sig(20, under + 1) }];
  assert.deepStrictEqual(scenes.distinctFrames(apart).map((f) => f.t), [5, 9], 'more than the bar apart: both stay, in time order');
});

// ── sampling (real ffmpeg, synthetic video) ─────────────────────────────────

check('sampling: one frame a second inside the stretches only, both JPEG sizes written, times in the source video', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-sample-'));
  try {
    const video = path.join(dir, 'test.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=10:duration=70', '-pix_fmt', 'yuv420p', video]);
    // Two stretches 5 s apart share one pass; the third, 40 s on, gets its own.
    const spans = [{ start: 5, end: 10 }, { start: 15, end: 20 }, { start: 60, end: 64 }];
    assert.deepStrictEqual(sampler.passesFor(spans).map((p) => [p.start, p.end, p.spans.length]), [[5, 20, 2], [60, 64, 1]]);
    const outDir = path.join(dir, 'frames');
    const out = await sampler.sampleFrames({ ffmpeg: FFMPEG, ffprobe: FFPROBE, video, spans, outDir });
    assert.strictEqual(out.every, 1);
    assert.strictEqual(out.seconds, 14);
    assert.ok(out.frames.length >= 13 && out.frames.length <= 15, `${out.frames.length} frames for 14 s`);
    assert.strictEqual(out.frames[0].t, 5);
    assert.ok(out.frames.every((f) => spans.some((s) => f.t >= s.start && f.t < s.end)), `a frame outside the stretches: ${out.frames.map((f) => f.t).join(', ')}`);
    assert.ok(out.frames.some((f) => f.t >= 60), 'the far stretch was sampled');
    assert.strictEqual(new Set(out.frames.map((f) => f.index)).size, out.frames.length, 'every frame has its own number');
    assert.ok(out.frames.every((f) => fs.existsSync(f.large) && fs.existsSync(f.small) && f.sharpness > 0));
    assert.ok(out.frames.every((f) => f.colour instanceof Uint8Array && f.colour.length === scenes.SIG_BYTES), 'every frame carries its 16x9 colour signature (the second pipe)');
    assert.ok(out.frames.some((f) => f.colour.some((v) => v > 200)) && out.frames.some((f) => f.colour.some((v) => v < 60)), 'the signature holds the test pattern\'s colours, not zeros');
    assert.strictEqual(fs.readdirSync(outDir).length, out.frames.length * 2, 'the frames decoded between two stretches are not left on disk');
    const odd = path.join(dir, 'square.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x640:rate=25:duration=3', '-pix_fmt', 'yuv420p', odd]);
    const err = await rejection(sampler.sampleFrames({ ffmpeg: FFMPEG, ffprobe: FFPROBE, video: odd, spans: null, outDir: path.join(dir, 'odd') }));
    assert.ok(/640x640, not 16:9/.test(err.message), err.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('sampling: the rate is one a second up to the cap, and bad stretches are refused by name', () => {
  assert.deepStrictEqual(sampler.samplingFor(1349), { count: 1349, every: 1 });
  const long = sampler.samplingFor(7200);
  assert.strictEqual(long.count, sampler.MAX_SAMPLES);
  assert.strictEqual(long.every, 4);
  assert.deepStrictEqual(sampler.resolveSpans(null, 100), [{ start: 0, end: 100 }]);
  assert.deepStrictEqual(sampler.resolveSpans([{ start: 10, end: 100.3 }], 100), [{ start: 10, end: 100 }], 'a container\'s rounding at the end is cut to the video');
  assert.throws(() => sampler.resolveSpans([{ start: 0, end: 4000 }], 1800), /after the video ends/);
  assert.throws(() => sampler.resolveSpans([{ start: -1, end: 5 }], 1800), /before the video begins/);
  assert.throws(() => sampler.resolveSpans([{ start: 10, end: 20 }, { start: 15, end: 30 }], 1800), /overlap or are out of order/);
  assert.throws(() => sampler.resolveSpans([{ start: 10, end: 11 }], 1800), /too little to sample/);
});

check('scenes: small pieces of one moving shot that interleave in time fold into one scene; two short clips one after another, and big scenes, do not', () => {
  // Sky footage from a moving camera: three small groups whose frames alternate inside one stretch.
  const skyA = (x, y) => (y < 3 ? [150, 180, 220] : [40, 90, 40]);
  const skyB = (x, y) => (y < 3 ? [150, 180, 220] : [200, 120, 60]);
  const skyC = (x, y) => (y < 3 ? [150, 180, 220] : [100, 40, 120]);
  const frames = [];
  const add = (colour, t) => frames.push({ t, colour });
  [0, 3, 6, 9].forEach((t, k) => add(sig(skyA, null, 100 + k), 100 + t));
  [1, 4, 7].forEach((t, k) => add(sig(skyB, null, 200 + k), 100 + t));
  [2, 5, 8].forEach((t, k) => add(sig(skyC, null, 300 + k), 100 + t));
  // Two different short clips back to back (no interleaving, 4 s apart): never folded.
  [0, 1, 2].forEach((t, k) => add(sig(garden, null, 400 + k), 200 + t));
  [6, 7, 8].forEach((t, k) => add(sig(page, null, 500 + k), 200 + t));
  // A big scene interleaving with the sky: never folded (big scenes never fold).
  for (let k = 0; k < 12; k++) add(sig(skyA, { x: 3, y: 2, colour: skin }, 600 + k), 100.5 + k * 0.7);
  const groups = [[0, 1, 2, 3], [4, 5, 6], [7, 8, 9], [10, 11, 12], [13, 14, 15], Array.from({ length: 12 }, (_, k) => 16 + k)];
  const d = (a, b) => { let s = 0; for (const i of groups[a]) for (const j of groups[b]) s += scenes.signatureDistance(frames[i].colour, frames[j].colour); return s / (groups[a].length * groups[b].length); };
  assert.ok(d(0, 1) > scenes.SCENE_JOIN_FRACTION && d(0, 1) <= scenes.FRAGMENT_JOIN_FRACTION, `the sky pieces are apart at the scene cut, close at the fold bar (${d(0, 1).toFixed(2)})`);
  const folded = scenes.foldFragments(groups, frames, 1);
  assert.deepStrictEqual(folded.map((g) => g.length), [10, 3, 3, 12], `the three sky pieces are one scene (${JSON.stringify(folded)})`);
  assert.deepStrictEqual(folded[0], [0, 1, 2, 3, 4, 5, 6, 7, 8, 9]);
  // The same pieces far apart in time stay apart.
  const apart = frames.map((f, i) => ({ ...f, t: i < 4 ? f.t : f.t + (i < 7 ? 500 : 900) }));
  assert.strictEqual(scenes.foldFragments(groups.slice(0, 3), apart, 1).length, 3, 'pieces far apart in time are not folded');
});

// ── text ────────────────────────────────────────────────────────────────────

check('words: the prompt fills every slot from thumbnails.yml and asks for the three kinds by name', () => {
  const p = prompts.buildWordsPrompt({ channel: 'Fireside', creator: 'owen morgan, telltale', title: 'the rapture is a yearly scam', transcript: ['[0:05] She says $1 is a sign.'] });
  assert.ok(!/\{[a-z_]+\}/.test(p), 'no unfilled slot');
  assert.ok(p.includes('[0:05] She says $1 is a sign.'), 'a $ in the transcript is kept as written');
  assert.ok(p.includes('the rapture is a yearly scam') && /CLAIM/.test(p) && /STAKES/.test(p) && /REACTION/.test(p));
  assert.ok(p.includes(`${prompts.OPTIONS_PER_KIND} of each`));
  assert.strictEqual(prompts.transcriptLine(3723.4, '  two   spaces '), '[1:02:03] two spaces');
});

check('words: the plain answer parses into three kinds; decoration stripped, off-brief options kept with a warning', () => {
  const answer = [
    'Here are your options:',
    '**CLAIM**',
    '1. Don\'t stand under a roof',
    '- "CHECK FOR BALLS OF LIGHT"',
    '',
    'STAKES:',
    'MAYBE TOMORROW',
    'EVERY YEAR SINCE NINETEEN EIGHTY EIGHT AGAIN',
    '',
    '## Reaction',
    'SHE\'S SERIOUS',
    'SHE\'S SERIOUS',
  ].join('\n');
  const r = prompts.parseThumbnailWords(answer, 'a keeper answer');
  assert.deepStrictEqual(r.claim, ['DON\'T STAND UNDER A ROOF', 'CHECK FOR BALLS OF LIGHT']);
  assert.deepStrictEqual(r.stakes, ['MAYBE TOMORROW', 'EVERY YEAR SINCE NINETEEN EIGHTY EIGHT AGAIN']);
  assert.deepStrictEqual(r.reaction, ['SHE\'S SERIOUS']);
  assert.ok(r.warnings.some((w) => /before the first kind/.test(w)), 'the preamble is named');
  assert.ok(r.warnings.some((w) => /is 7 words/.test(w)), 'a long option is warned about, and kept');
  assert.throws(() => prompts.parseThumbnailWords('I cannot help with that.', 'x'), /no options under CLAIM, STAKES or REACTION/);
});

// ── face-safe box and fitting ───────────────────────────────────────────────

const STYLE = layout.validateStyle(layout.DEFAULT_STYLE);
const FW = 1280, FH = 720;

/** The text box for the default look with no photo drawn: left margin to the reaction space, top to bottom margin. */
const BOX = layout.textBox(STYLE, FW, FH, null);
function insideBox(r, box = BOX) {
  return r.x >= box.x - 1e-6 && r.y >= box.y - 1e-6 && r.x + r.w <= box.x + box.w + 1e-6 && r.y + r.h <= box.y + box.h + 1e-6;
}

check('layout: the text box runs from the left margin to where the reaction photo begins, and from the top margin to the bottom; the text stays in it, off the padded face, bottom-left, 1-2 lines', () => {
  const m = layout.MARGIN_FRACTION * FH;
  assert.deepStrictEqual([BOX.x, BOX.y, BOX.x + BOX.w, BOX.y + BOX.h].map((v) => Number(v.toFixed(3))),
    [m, m, layout.slotRect(STYLE.reactionSlot, FW, FH).x, FH - m].map((v) => Number(v.toFixed(3))));
  const face = { x: 515, y: 164, w: 236, h: 236 }; // the rapture frame's face, in output pixels
  const r = layout.planText(metricsFor('DON\'T STAND UNDER A ROOF'), [face], STYLE, FW, FH);
  const p = r.plan;
  assert.deepStrictEqual([p.placement, r.note], ['clear', null]);
  assert.ok(insideBox(p.patch), `inside the text box (${JSON.stringify(p.patch)})`);
  assert.ok(!overlaps(p.patch, layout.paddedFace(face, FW, FH)), 'patch clear of the face');
  assert.ok(!overlaps(p.patch, layout.slotRect(STYLE.reactionSlot, FW, FH)), 'patch clear of the reaction space');
  assert.ok(p.capPx >= STYLE.minCapFraction * STYLE.textScale * FH - 1e-6 && p.capPx <= STYLE.maxCapFraction * STYLE.textScale * FH + 1e-6, `cap ${p.capPx}`);
  assert.ok(p.lines.length >= 1 && p.lines.length <= 2);
  assert.ok(p.lines.every((l) => Math.abs(l.x - p.lines[0].x) < 1e-9), 'left-aligned');
  assert.ok(Math.abs(p.patch.y + p.patch.h - (FH - m)) < 0.5 && p.patch.x - m < 1, `bottom-left (patch at ${JSON.stringify(p.patch)})`);
});

check('layout: two faces side by side (a split screen) are both avoided', () => {
  const faces = [{ x: 150, y: 120, w: 200, h: 200 }, { x: 560, y: 110, w: 210, h: 210 }];
  const r = layout.planText(metricsFor('SHE\'S SERIOUS'), faces, STYLE, FW, FH);
  assert.strictEqual(r.plan.placement, 'clear');
  for (const f of faces) assert.ok(!overlaps(r.plan.patch, layout.paddedFace(f, FW, FH)));
  assert.ok(insideBox(r.plan.patch));
});

check('layout: a short phrase is fitted large (up to the ceiling, at the text size), and shrinks as the space shrinks', () => {
  const open = layout.planText(metricsFor('MAYBE TOMORROW'), [], STYLE, FW, FH);
  assert.ok(Math.abs(open.plan.capPx - STYLE.maxCapFraction * STYLE.textScale * FH) < 1e-6, `with room, the ceiling at the text size (${open.plan.capPx})`);
  const tight = layout.planText(metricsFor('MAYBE TOMORROW'), [{ x: 420, y: 80, w: 300, h: 300 }], STYLE, FW, FH);
  assert.ok(tight.plan.capPx < open.plan.capPx && tight.plan.capPx >= STYLE.minCapFraction * STYLE.textScale * FH - 1e-6);
  assert.strictEqual(tight.plan.placement, 'clear');
});

check('text size: 15% smaller by default (the largest letters 17% of the height, a width-limited phrase 85% of its fit), 100% gives the old size, the place chosen at full size; adjustable 50-100%', () => {
  assert.strictEqual(layout.DEFAULT_STYLE.textScale, 0.85);
  assert.strictEqual(layout.DEFAULT_STYLE.maxCapFraction, 0.2);
  const full = { ...STYLE, textScale: 1 };
  const short = metricsFor('MAYBE TOMORROW');
  const now = layout.planText(short, [], STYLE, FW, FH).plan;
  const before = layout.planText(short, [], full, FW, FH).plan;
  assert.ok(Math.abs(before.capPx - 0.2 * FH) < 1e-6 && Math.abs(now.capPx - 0.17 * FH) < 1e-6, `ceiling 20% -> 17% (${before.capPx} -> ${now.capPx})`);
  const long = metricsFor('THE RAPTURE IS HERE AND SHE MEANS IT');
  const a = layout.planText(long, [], STYLE, FW, FH).plan;
  const b = layout.planText(long, [], full, FW, FH).plan;
  assert.ok(b.capPx < 0.2 * FH - 1, 'the long phrase is limited by the width, not the ceiling');
  assert.ok(Math.abs(a.capPx / b.capPx - 0.85) < 1e-6, `the typical size is 85% of the fit (${a.capPx} vs ${b.capPx})`);
  assert.deepStrictEqual(a.lines.map((l) => l.text), b.lines.map((l) => l.text), 'the same lines, smaller');
  assert.deepStrictEqual([a.space, a.placement], [b.space, b.placement], 'the same place, chosen at full size');
  assert.ok(a.lines.length <= 2 && insideBox(a.patch), 'one or two lines, inside the box');
  assert.throws(() => layout.validateStyle({ ...layout.DEFAULT_STYLE, textScale: 1.2 }), /text size/);
  assert.throws(() => layout.validateStyle({ ...layout.DEFAULT_STYLE, textScale: undefined }), /text size/);
});

check('the saved look: one saved before 2026-09-29 (no text size, no border, the retired dark edges) is read with the new defaults and a line saying so; a current one says nothing', () => {
  const old = { ...layout.DEFAULT_STYLE, vignette: true, vignetteStrength: 0.6, maxCapFraction: 0.2 };
  delete old.textScale;
  delete old.border;
  const read = layout.readStoredStyle(old);
  assert.deepStrictEqual([read.style.textScale, read.style.border, 'vignette' in read.style], [0.85, true, false]);
  assert.ok(/85% of the largest that fits/.test(read.line) && /border is drawn/.test(read.line) && /"dark edges" setting is gone/.test(read.line), read.line);
  assert.deepStrictEqual(layout.readStoredStyle(layout.DEFAULT_STYLE), { style: layout.DEFAULT_STYLE, line: null });
  assert.throws(() => layout.readStoredStyle({ ...old, fill: 'orange' }), /letter colour/, 'anything else wrong is still refused');
});

check('layout: words no face-free space holds at the 7% floor are still drawn: in the whole box, no bigger than the floor, shrunk until they fit, covering the least of a face, said; never refused, never cut, never three lines', () => {
  assert.strictEqual(layout.MAX_LINES, 2);
  assert.deepStrictEqual(layout.splits(['A', 'B', 'C', 'D']).map((l) => l.length).sort().join(''), '1222', 'every split into one or two lines, in order');
  const face = { x: 300, y: 100, w: 380, h: 420 };
  const phrase = 'THE RAPTURE HAS FAILED EVERY SINGLE YEAR SINCE NINETEEN EIGHTY EIGHT AND IT WILL AGAIN';
  const r = layout.planText(metricsFor(phrase), [face], STYLE, FW, FH);
  assert.strictEqual(r.plan.placement, 'over-faces');
  assert.ok(/^No space in the text box clear of the faces holds these words at 51 px/.test(r.note) && /drawn \d+ px tall at the (top|bottom) of the box/.test(r.note), r.note);
  assert.ok(r.plan.capPx <= 0.07 * FH + 1e-6 && r.plan.capPx > 0, `at most the floor (${r.plan.capPx})`);
  assert.ok(r.plan.lines.length <= 2, 'one or two lines');
  assert.strictEqual(r.plan.lines.map((l) => l.text).join(' '), phrase, 'every word, none cut');
  assert.ok(insideBox(r.plan.patch), 'inside the text box');
  // A face that fills the whole box: still drawn, still in the box.
  const whole = layout.planText(metricsFor('SHE MEANS IT'), [{ x: 0, y: 0, w: 1000, h: 720 }], STYLE, FW, FH);
  assert.ok(whole.plan.placement === 'over-faces' && insideBox(whole.plan.patch) && whole.note !== null);
  // The side the words go on covers less of the face: a face low in the box sends them to the top.
  const low = layout.planText(metricsFor(phrase), [{ x: 100, y: 330, w: 600, h: 330 }], STYLE, FW, FH);
  assert.ok(/at the top of the box/.test(low.note), low.note);
  assert.throws(() => layout.validateStyle({ ...layout.DEFAULT_STYLE, fill: 'orange' }), /letter colour.*#RRGGBB/);
  assert.throws(() => layout.validateStyle({ ...layout.DEFAULT_STYLE, reactionSlot: { x: 0.8, y: 0.5, w: 0.4, h: 0.4 } }), /runs off the picture/);
  assert.throws(() => layout.textBox({ ...STYLE, reactionSlot: { x: 0, y: 0.5, w: 0.3, h: 0.4 } }, FW, FH, null), /leaves no room for words/);
});

check('layout: "TAKE YOUR CLOTHES OFF" between two faces is drawn whole on one or two lines, clear of the faces when the floor allows', () => {
  assert.strictEqual(layout.DEFAULT_STYLE.minCapFraction, 0.07);
  const faces = [{ x: 250, y: 200, w: 208, h: 560 }, { x: 510, y: 200, w: 208, h: 560 }];
  const r = layout.planText(metricsFor('TAKE YOUR CLOTHES OFF'), faces, STYLE, FW, FH);
  assert.ok(r.plan.lines.length <= 2);
  assert.deepStrictEqual(r.plan.lines.map((l) => l.text).join(' '), 'TAKE YOUR CLOTHES OFF', 'every word, none cut');
  assert.ok(insideBox(r.plan.patch));
  if (r.plan.placement === 'clear') for (const f of faces) assert.ok(!overlaps(r.plan.patch, layout.paddedFace(f, FW, FH)), 'clear of each face');
  else assert.ok(r.note !== null, 'over a face only with the note');
  const open = layout.planText(metricsFor('MAYBE TOMORROW'), [], STYLE, FW, FH);
  assert.ok(open.plan.lines.length <= 2 && Math.abs(open.plan.capPx - STYLE.maxCapFraction * STYLE.textScale * FH) < 1e-6, JSON.stringify(open.plan.lines));
});

// ── reaction photos: trim and placement ─────────────────────────────────────

const trim = services('thumbnails/photo-trim.js');

check('photos: the trim keeps the person (and what touches it) and drops stray specks along the edge', () => {
  const w = 200, h = 120;
  const alpha = new Uint8Array(w * h);
  const fill = (x0, y0, x1, y1, a) => { for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) alpha[y * w + x] = a; };
  fill(60, 20, 140, 120, 255); // the person, down to the bottom edge
  fill(140, 60, 180, 70, 255); // a microphone arm touching the person
  fill(20, 114, 40, 120, 255); // a speck along the bottom edge (selfie horrified.png's bars)
  fill(185, 116, 195, 120, 255); // another
  fill(57, 20, 60, 120, 60); // a soft, partly transparent edge beside the person
  const r = trim.trimToPerson(alpha, w, h, 'a keeper photo');
  assert.strictEqual(r.droppedGroups, 2);
  assert.strictEqual(r.droppedPixels, 20 * 6 + 10 * 4);
  assert.deepStrictEqual(r.box, { x: 57, y: 17, w: 183 - 57, h: 120 - 17 }, JSON.stringify(r.box));
  assert.strictEqual(r.keep[118 * w + 30], 0, 'the speck is cleared');
  assert.strictEqual(r.keep[65 * w + 170], 1, 'the attached arm is kept');
  assert.strictEqual(r.keep[50 * w + 58], 1, 'the soft edge is kept');
  assert.throws(() => trim.trimToPerson(new Uint8Array(w * h), w, h, 'an empty photo'), /an empty photo has no opaque content/);
  assert.strictEqual(trim.photoName('selfie oh please.png'), 'oh please');
  assert.strictEqual(trim.photoName('laugh.PNG'), 'laugh');
});

check('photos: fitted into the reaction space, right side anchored, running off the bottom; the text avoids the photo, not the whole space', () => {
  const style = { ...STYLE, reactionBleed: 0.1, reactionOutlinePx: 10 };
  const slot = layout.slotRect(style.reactionSlot, FW, FH);
  // A tall photo: height limits it.
  const tall = layout.placeReaction(600, 1000, style, FW, FH);
  assert.ok(Math.abs(tall.x + tall.w - (slot.x + slot.w)) < 1e-6, 'right side on the space\'s right edge');
  assert.ok(Math.abs(tall.y + tall.h * 0.9 - FH) < 1e-6, 'a tenth of it below the bottom edge');
  assert.ok(Math.abs(tall.y - slot.y) < 1e-6 && tall.w < slot.w, 'as tall as the space allows');
  assert.ok(Math.abs(tall.outlinePx - 10 * FH / 1080) < 1e-9, 'the outline scales from 1080p');
  assert.ok(tall.avoid.x <= tall.x - tall.outlinePx + 1e-9 && tall.avoid.y + tall.avoid.h === FH, 'the avoided box holds the outline and reaches the bottom');
  // A wide photo: width limits it; its top sits lower than the space's top.
  const wide = layout.placeReaction(1600, 600, style, FW, FH);
  assert.ok(Math.abs(wide.w - slot.w) < 1e-6 && wide.y > slot.y);
  // The text box ends where the drawn photo begins: a narrow photo leaves the box wider.
  const narrow = layout.placeReaction(200, 1000, style, FW, FH);
  const face = { x: 515, y: 164, w: 236, h: 236 };
  const phrase = metricsFor('EVERY YEAR SINCE 1988 AGAIN');
  const withSpace = layout.planText(phrase, [face], style, FW, FH, null);
  const withPhoto = layout.planText(phrase, [face], style, FW, FH, narrow.avoid);
  assert.ok(Math.abs(withPhoto.plan.box.x + withPhoto.plan.box.w - narrow.avoid.x) < 1e-6, 'the box ends at the photo\'s drawn left edge');
  assert.ok(withPhoto.plan.box.w > withSpace.plan.box.w, 'wider than the whole reaction space allows');
  assert.ok(!overlaps(withPhoto.plan.patch, narrow.avoid), 'the text clears the photo');
  assert.throws(() => layout.validateStyle({ ...layout.DEFAULT_STYLE, reactionOutlinePx: 99 }), /photo outline/);
});

// ── the card editor's layout (2026-09-29): one composeThumbnail for the render and the preview ──

check('card edits: with none, composeThumbnail is the old arithmetic step for step (faces scaled, photo and logo in their spaces, planText); a moved frame moves the faces with it; words go in Owen\'s box at the largest size it holds; a moved photo is avoided anywhere; the automatic place round-trips into a box at the same size; bad edits are refused by name', () => {
  const frameSize = { width: 1920, height: 1080 };
  const faces = [{ x: 772, y: 246, w: 354, h: 354 }];
  const phrase = metricsFor('DON\'T STAND UNDER A ROOF');
  const photo = { width: 606, height: 883 };
  const logoSize = { width: 400, height: 400 };
  // No edit: exactly what renderer.ts computed before the editor.
  const none = layout.composeThumbnail({ width: FW, height: FH, frameSize, faces, style: STYLE, adjust: null, metrics: phrase, photo, logo: logoSize });
  const scale = FW / frameSize.width;
  const facesOut = faces.map((f) => ({ x: f.x * scale, y: f.y * scale, w: f.w * scale, h: f.h * scale }));
  const reaction = layout.placeReaction(photo.width, photo.height, STYLE, FW, FH);
  const logo = layout.placeLogo(logoSize.width, logoSize.height, STYLE, FW, FH);
  const old = layout.planText(phrase, facesOut, STYLE, FW, FH, reaction.avoid, logo);
  assert.deepStrictEqual([none.frame, none.faces, none.reaction, none.logo, none.plan, none.note], [null, facesOut, reaction, logo, old.plan, old.note], 'no edit: the old layout');
  assert.deepStrictEqual(layout.composeThumbnail({ width: FW, height: FH, frameSize, faces, style: STYLE, adjust: {}, metrics: phrase, photo, logo: logoSize }), none, 'an empty edit is no edit');
  assert.ok(layout.noAdjust(null) && layout.noAdjust({}) && !layout.noAdjust({ photo: { cx: 0.5, cy: 0.5, h: 0.4 } }));
  // The frame zoomed 2x on its top-left quarter: drawn at twice the size, the face moves and grows with it.
  const zoomed = layout.composeThumbnail({ width: FW, height: FH, frameSize, faces, style: STYLE, adjust: { frame: { x: -0.5, y: -0.5, scale: 2 } }, metrics: phrase, photo: null, logo: null });
  assert.deepStrictEqual(zoomed.frame, { x: -640, y: -360, w: 2560, h: 1440 });
  const f0 = zoomed.faces[0];
  assert.ok(Math.abs(f0.x - (-640 + 772 * 2560 / 1920)) < 1e-9 && Math.abs(f0.w - 354 * 2560 / 1920) < 1e-9, JSON.stringify(f0));
  const off = layout.composeThumbnail({ width: FW, height: FH, frameSize, faces, style: STYLE, adjust: { frame: { x: 0.9, y: 0.9, scale: 0.3 } }, metrics: null, photo: null, logo: null });
  assert.deepStrictEqual(off.faces, [], 'a face moved off the picture is not avoided');
  // Words in his own box: inside it, against its top-left, larger than the automatic place when the box is larger; faces ignored.
  const box = { x: 0.05, y: 0.1, w: 0.6, h: 0.5 };
  const mine = layout.composeThumbnail({ width: FW, height: FH, frameSize, faces, style: STYLE, adjust: { text: box }, metrics: phrase, photo: null, logo: null });
  const px = { x: box.x * FW, y: box.y * FH, w: box.w * FW, h: box.h * FH };
  assert.ok(insideBox(mine.plan.patch, px), `inside his box: ${JSON.stringify(mine.plan.patch)}`);
  assert.ok(Math.abs(mine.plan.patch.x - px.x) < 1e-6 && Math.abs(mine.plan.patch.y - px.y) < 1e-6, 'against its top-left corner');
  assert.ok(Math.abs(mine.plan.patch.w - px.w) < 1e-6 || Math.abs(mine.plan.patch.h - px.h) < 1e-6, 'as large as the box holds');
  assert.ok(mine.plan.size > none.plan.size && mine.note === null);
  // The automatic place turned into a box (the editor's first touch) draws the same size and lines.
  const asBox = layout.textBoxOf(none.plan, FW, FH);
  const same = layout.composeThumbnail({ width: FW, height: FH, frameSize, faces, style: STYLE, adjust: { text: asBox }, metrics: phrase, photo, logo: logoSize });
  assert.ok(Math.abs(same.plan.size - none.plan.size) < 1e-6 && same.plan.lines.map((l) => l.text).join('|') === none.plan.lines.map((l) => l.text).join('|'), `same size and lines (${same.plan.size} vs ${none.plan.size})`);
  assert.ok(same.plan.lines.every((l, i) => Math.abs(l.x - none.plan.lines[i].x) < 1e-6 && Math.abs(l.y - none.plan.lines[i].y) < 1e-6), 'and the same place');
  // The photo moved to the left: centred where he put it, its own shape, and the automatic words keep clear of it.
  const moved = layout.composeThumbnail({ width: FW, height: FH, frameSize, faces: [], style: STYLE, adjust: { photo: { cx: 0.2, cy: 0.6, h: 0.5 } }, metrics: phrase, photo, logo: null });
  const r = moved.reaction;
  assert.ok(Math.abs(r.h - 360) < 1e-9 && Math.abs(r.w - 360 * 606 / 883) < 1e-9 && Math.abs(r.x + r.w / 2 - 256) < 1e-9 && Math.abs(r.y + r.h / 2 - 432) < 1e-9, JSON.stringify(r));
  assert.ok(!overlaps(moved.plan.patch, r.avoid), 'the words clear the moved photo');
  assert.ok(moved.plan.patch.x + moved.plan.patch.w > layout.slotRect(STYLE.reactionSlot, FW, FH).x, 'and may use the space the photo left');
  // Edits are refused by name, never clamped.
  assert.deepStrictEqual(layout.validateAdjust({ frame: { x: -0.5, y: 0, scale: 2 }, text: box, photo: { cx: 0.2, cy: 0.6, h: 0.5 } }, 'k'), { frame: { x: -0.5, y: 0, scale: 2 }, text: box, photo: { cx: 0.2, cy: 0.6, h: 0.5 } });
  for (const [bad, re] of [
    [{ frame: { x: 0, y: 0, scale: 9 } }, /frame's zoom is 9/],
    [{ frame: { x: 0.99, y: 0, scale: 1 } }, /frame's left edge is 0.99/],
    [{ text: { x: 0.8, y: 0, w: 0.5, h: 0.2 } }, /text box left edge is 0.8/],
    [{ photo: { cx: 0.5, cy: 0.5, h: 0 } }, /photo's height is 0/],
    [{ photo: { cx: 0.5, cy: 0.5 } }, /photo's height is undefined/],
    [{ zoom: 2 }, /"zoom", which this build does not know/],
    [null, /must be an object/],
  ]) assert.throws(() => layout.validateAdjust(bad, 'Card 2'), (e) => /^Card 2: /.test(e.message) && re.test(e.message), JSON.stringify(bad));
});

// ── the story source: regions minus cuts, the segment table, the alignment (2026-09-28) ──────────

const timelineMap = require(path.join(DIST, 'shared', 'master-timeline-map.js'));
const storySource = services('thumbnails/story-source.js');
const { ThumbnailLook } = services('thumbnails/look.js');
const link = services('metadata/editor-transcript-link.js');

const MASTER = '/sessions/2026-01-05/2026-01-05 master.mp4';
/** A timeline with removed air: 0-10 plays master 0-10, 10-30 plays 15-35, 30-60 plays 40-70, 60-100 plays 80-120. */
function syntheticManifest(masterFile = MASTER) {
  const video = [[0, 0, 10], [10, 15, 20], [30, 40, 30], [60, 80, 40]].map(([timelineStart, sourceStart, duration]) => ({ trackId: 'video', timelineStart, sourceStart, duration, file: masterFile }));
  return {
    frameSeconds: 0.1,
    timelineDuration: 100,
    segments: [...video, { trackId: 'audio-0', timelineStart: 0, sourceStart: 3, duration: 100, file: '/sessions/mic audio_processed.wav' }],
  };
}
const REGIONS = [{ start: 5, end: 45 }, { start: 70, end: 80 }];
const CUTS = [{ startFrame: 200, endFrame: 250 }];
const round = (spans) => spans.map((s) => [Number(s.start.toFixed(6)), Number(s.end.toFixed(6))]);

check('story source: regions minus cuts (half-open frames x the frame length), on the timeline', () => {
  assert.deepStrictEqual(round(storySource.keptTimeline(REGIONS, CUTS, 0.1)), [[5, 20], [25, 45], [70, 80]]);
  assert.deepStrictEqual(round(storySource.keptTimeline([{ start: 0, end: 10 }], [{ startFrame: 0, endFrame: 100 }], 0.1)), [], 'a story wholly cut keeps nothing');
  assert.deepStrictEqual(round(storySource.keptTimeline([{ start: 0, end: 4 }, { start: 3, end: 6 }], [], 0.1)), [[0, 6]], 'overlapping regions merge');
});

check('story source: a timeline range maps through the segment table piece by piece, the removed air left out', () => {
  const facts = storySource.manifestFacts(syntheticManifest(), 'x_compounds.zip');
  assert.strictEqual(facts.segments.length, 4, 'the picture segments only');
  const pieces = timelineMap.timelineRangeToMaster(facts.segments, 8, 32);
  assert.deepStrictEqual(pieces.map((p) => [p.timelineStart, p.masterStart, p.duration]), [[8, 8, 2], [10, 15, 20], [30, 40, 2]]);
  assert.strictEqual(timelineMap.masterToSource({ offsetSeconds: 2, rate: 0.5 }, 12), 5, 'master 12 s is the source\'s 5 s: (12 - 2) x 0.5');
  assert.throws(() => storySource.manifestFacts({ ...syntheticManifest(), segments: [...syntheticManifest().segments, { trackId: 'video', timelineStart: 100, sourceStart: 0, duration: 5, file: '/other.mp4' }] }, 'x_compounds.zip'), /from 2 files/);
});

check('story source: the plan, with drift, cut to the screen recording\'s length, the seconds outside it said', () => {
  const plan = storySource.planStory({
    regions: REGIONS, cuts: CUTS, manifest: storySource.manifestFacts(syntheticManifest(), 'x'),
    placement: { offsetSeconds: 2, rate: 0.5 }, screenDuration: 45,
  });
  assert.deepStrictEqual(round(plan.master), [[5, 10], [15, 25], [30, 35], [40, 55], [90, 100]]);
  assert.deepStrictEqual(round(plan.screen), [[1.5, 4], [6.5, 11.5], [14, 16.5], [19, 26.5], [44, 45]]);
  assert.strictEqual(Number(plan.outsideSeconds.toFixed(6)), 4, 'master 92-100 maps past the recording\'s 45 s');
  assert.strictEqual(plan.unmappedSeconds, 0);
  const past = storySource.planStory({
    regions: [{ start: 90, end: 110 }], cuts: [], manifest: storySource.manifestFacts(syntheticManifest(), 'x'),
    placement: { offsetSeconds: 0, rate: 1 }, screenDuration: 500,
  });
  assert.strictEqual(Number(past.unmappedSeconds.toFixed(6)), 10, 'a story running past the timeline\'s end says so');
});

check('story source: the screen alignment is read, and an untrusted, missing or doubled one is refused by name', () => {
  const entry = { kind: 'video', type: 'screen', offsetSeconds: 0.0907, driftFactor: null, method: 'picture-scene-change', confidence: 1, trusted: true };
  const record = (sources) => ({ schemaVersion: 1, masterVideo: MASTER, sources });
  const a = storySource.screenAlignment(record([{ kind: 'audio', type: 'screen', offsetSeconds: 0.18, trusted: true }, entry]), 'a.json');
  assert.deepStrictEqual(storySource.placementOf(a), { offsetSeconds: 0.0907, rate: 1 }, 'no drift factor recorded: the master\'s rate, declared in the run\'s lines');
  assert.deepStrictEqual(storySource.placementOf(storySource.screenAlignment(record([{ ...entry, driftFactor: 0.99997 }]), 'a.json')), { offsetSeconds: 0.0907, rate: 0.99997 });
  assert.throws(() => storySource.screenAlignment(record([{ ...entry, trusted: false }]), 'a.json'), /marked untrusted/);
  assert.throws(() => storySource.screenAlignment(record([{ ...entry, trusted: undefined }]), 'a.json'), /not marked trusted/);
  assert.throws(() => storySource.screenAlignment(record([entry, entry]), 'a.json'), /2 screen recording alignments/);
  assert.throws(() => storySource.screenAlignment(record([{ kind: 'video', type: 'cam1', offsetSeconds: 0.08, trusted: true }]), 'a.json'), /no alignment for a screen recording/);
});

/** A synthetic week: one editor session with three stories, a screen recording, an alignment. */
function syntheticWeek(root, { screenSeconds = 60 } = {}) {
  const week = path.join(root, '2026-01-04');
  const project = path.join(week, 'files', '2026-01-05');
  fs.mkdirSync(path.join(project, '2026-01-05_stories_transcripts'), { recursive: true });
  fs.mkdirSync(path.join(week, 'complete'), { recursive: true });
  const stories = [
    { id: 'story-1', number: 1, title: 'u1 - prophecy', regions: [{ start: 0, end: 5 }] },
    { id: 'story-7', number: 2, title: 'f1 - the rapture', regions: REGIONS },
    { id: 'story-8', number: 3, title: 'f3 - never exported', regions: [{ start: 45, end: 70 }] },
  ];
  fs.writeFileSync(path.join(project, '2026-01-05_edits.json'), JSON.stringify({ schemaVersion: 1, session: '2026-01-05', cuts: CUTS, stories }));
  for (const [n, slug] of [[1, 'u1-prophecy'], [2, 'f1-the-rapture']]) {
    fs.writeFileSync(path.join(project, '2026-01-05_stories_transcripts', `0${n}-${slug}.json`), JSON.stringify({
      formatVersion: 1, sourceSession: '2026-01-05', story: { number: n, slug }, durationSeconds: 40, words: [{ text: 'a', start: 0, end: 1 }],
    }));
  }
  fs.writeFileSync(path.join(project, '2026-01-05_compounds.zip'), '');
  const master = path.join(project, '2026-01-05 master.mp4');
  const alignment = { schemaVersion: 1, masterVideo: master, sources: [{ kind: 'video', type: 'screen', offsetSeconds: 2, driftFactor: null, method: 'picture-scene-change', confidence: 1, trusted: true }] };
  fs.writeFileSync(path.join(project, '2026-01-05_alignment.json'), JSON.stringify(alignment));
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=320x180:rate=5:duration=${screenSeconds}`, '-pix_fmt', 'yuv420p', path.join(project, '2026-01-05 screen capture.mp4')]);
  return { week, project, master, alignment, source: path.join(week, 'complete', 'f2 - the rapture.mov') };
}

/** The story's link, as the metadata run or the Inputs page makes it: the transcript-link module's own ref. */
function storyRef(w, number, slug) {
  const candidate = link.listProjectStories(w.project).candidates.find((c) => c.storyNumber === number && c.storySlug === slug);
  assert.ok(candidate, `story ${number} "${slug}" is in the synthetic session`);
  return link.refFromCandidate(candidate, 'manual');
}
const sourceDeps = (w, manifests = []) => ({
  manifest: async (zipPath) => { manifests.push(zipPath); return syntheticManifest(w.master); },
  duration: async (video) => (await sampler.probeVideo(FFPROBE, video)).duration,
});

check('story source: frames come only from the story\'s stretches of the screen recording (its session\'s manifest, the alignment\'s offset), cut to the recording\'s length, said', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-story-'));
  try {
    const w = syntheticWeek(root);
    const manifests = [];
    const src = await storySource.resolveStorySource(storyRef(w, 2, 'f1-the-rapture'), sourceDeps(w, manifests));
    assert.deepStrictEqual(manifests, [path.join(w.project, '2026-01-05_compounds.zip')], 'the manifest is the session zip\'s');
    assert.ok(src.screenFile.endsWith('2026-01-05 screen capture.mp4'), src.screenFile);
    // Master stretches 5-10, 15-25, 30-35, 40-55, 90-100 at offset +2 s: 3-8, 13-23, 28-33, 38-53, and 88-98 lies past the 60 s recording.
    const spans = [[3, 8], [13, 23], [28, 33], [38, 53]];
    const sampled = await sampler.sampleFrames({ ffmpeg: FFMPEG, ffprobe: FFPROBE, video: src.screenFile, spans: src.plan.screen, outDir: path.join(root, 'frames') });
    assert.ok(sampled.frames.length >= 30, `${sampled.frames.length} frames sampled`);
    assert.ok(sampled.frames.every((f) => spans.some(([a, b]) => f.t >= a - 1e-6 && f.t < b)), `frames outside the story: ${sampled.frames.map((f) => f.t).join(', ')}`);
    assert.ok(src.lines[0].startsWith('Story "f1 - the rapture" (story 2 of session 2026-01-05)') && src.lines[0].includes('5 stretches'), src.lines[0]);
    assert.ok(src.lines.some((l) => /records no drift factor/.test(l)), 'the rate with no drift factor is declared');
    assert.ok(src.lines.some((l) => /^10\.0 s of the story fall outside the screen recording/.test(l)), src.lines.join(' | '));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('story source: an untrusted alignment, a missing or split screen recording, and a renamed story are each refused by name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-refuse-'));
  try {
    const w = syntheticWeek(root, { screenSeconds: 3 });
    const ref = storyRef(w, 2, 'f1-the-rapture');
    const find = async () => (await rejection(storySource.resolveStorySource(ref, sourceDeps(w)))).message;
    const alignmentFile = path.join(w.project, '2026-01-05_alignment.json');

    fs.writeFileSync(alignmentFile, JSON.stringify({ ...w.alignment, sources: [{ ...w.alignment.sources[0], trusted: false, confidence: 0.4 }] }));
    assert.ok(/marked untrusted \(picture-scene-change, confidence 0\.40\)/.test(await find()));
    fs.rmSync(alignmentFile);
    assert.ok(/alignment record \(2026-01-05_alignment\.json\) is not on disk/.test(await find()));
    fs.writeFileSync(alignmentFile, JSON.stringify(w.alignment));

    const screen = path.join(w.project, '2026-01-05 screen capture.mp4');
    fs.copyFileSync(screen, path.join(w.project, '2026-01-05 screen capture 2.mp4'));
    assert.ok(/is in parts \(2026-01-05 screen capture\.mp4, 2026-01-05 screen capture 2\.mp4\)/.test(await find()));
    fs.rmSync(path.join(w.project, '2026-01-05 screen capture 2.mp4'));
    fs.renameSync(screen, path.join(w.project, 'elsewhere.mp4'));
    assert.ok(/There is no screen recording \("2026-01-05 screen capture\.mp4"\)/.test(await find()));
    fs.renameSync(path.join(w.project, 'elsewhere.mp4'), screen);

    const editsFile = path.join(w.project, '2026-01-05_edits.json');
    const edits = JSON.parse(fs.readFileSync(editsFile, 'utf8'));
    edits.stories[1].title = 'f1 - rapture, recut';
    fs.writeFileSync(editsFile, JSON.stringify(edits));
    assert.ok(/no story #2 "f1-the-rapture" any more \(story #2 is now "f1 - rapture, recut"\)/.test(await find()));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The real 2026-09-24 session, READ ONLY, as a fixture reference: "f1 - the rapture" through the
// editor's own manifest builder, the edits and the alignment exactly as they are on Callisto.
const REAL_PROJECT = '/Volumes/Callisto/Movies/FCPX/2026-09-20/files/2026-09-24';
check('story source, real fixture: "f1 - the rapture" of 2026-09-24 maps to 126 stretches of the screen recording (read only)', async () => {
  if (!fs.existsSync(path.join(REAL_PROJECT, '2026-09-24_edits.json'))) {
    console.log(`      (not run: ${REAL_PROJECT} is not on disk)`);
    return;
  }
  const out = execFileSync('python3', [path.join(REPO, 'editor-backend', 'cli', 'editor_manifest.py'), '--zip', path.join(REAL_PROJECT, '2026-09-24_compounds.zip')], { cwd: path.join(REPO, 'editor-backend'), stdio: ['ignore', 'pipe', 'ignore'], maxBuffer: 64 * 1024 * 1024 }).toString();
  const manifest = JSON.parse(out.trim().split('\n').pop()).manifest;
  const src = await storySource.resolveStorySource(
    { projectFolder: REAL_PROJECT, storyNumber: 6, storySlug: 'f1-the-rapture' },
    { manifest: async () => manifest, duration: async (video) => (await sampler.probeVideo(FFPROBE, video)).duration },
  );
  assert.deepStrictEqual(round(src.plan.timeline).map((s) => s.map((v) => Number(v.toFixed(4)))), [[546.3458, 1295.9965]], 'region 546.3458-1295.9965, no cut inside it');
  assert.strictEqual(src.plan.master.length, 126);
  assert.strictEqual(Number(storySource.totalSeconds(src.plan.master).toFixed(3)), 749.651, 'every kept timeline second, and no removed air');
  assert.deepStrictEqual([src.plan.master[0].start, src.plan.master[125].end].map((v) => Number(v.toFixed(4))), [614.7475, 1488.4221]);
  assert.ok(src.plan.screen.every((s, i) => Math.abs(s.start - (src.plan.master[i].start - 0.0906985)) < 1e-6), 'screen time = master time - the screen offset (0.0907 s)');
  assert.ok(src.screenFile.endsWith('2026-09-24 screen capture.mp4'));
});

// ── the logo and the library (2026-09-28) ──

const library = services('thumbnails/photo-library.js');
const { resolveUserDataPath } = require(path.join(DIST, 'user-data-path.js'));
/** A PNG file's first bytes (the library checks the signature, not the pixels). */
const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a keeper photo')]);

/** userData as a development run gets it: CONTENTSTUDIO_USER_DATA, never Owen's folder. */
function scratchUserData(root) {
  const choice = resolveUserDataPath({ env: { CONTENTSTUDIO_USER_DATA: path.join(root, 'userData') }, isPackaged: false, appData: '/nowhere' });
  assert.strictEqual(choice.source, 'env');
  return choice.path;
}

check('logo: fitted inside its space with its aspect kept, against the top and right edges, whole pixels; the text avoids its drawn bounds', () => {
  const style = layout.validateStyle(layout.DEFAULT_STYLE);
  const slot = layout.slotRect(style.logoSlot, 1280, 720);
  assert.ok(Math.abs(slot.w / 1280 - 0.052) < 0.002 && Math.abs(slot.x + slot.w - 1280 * 0.974) < 1.5, `the default space matches the hand-made badge (${JSON.stringify(slot)})`);
  const round = layout.placeLogo(2000, 2000, style, 1280, 720);
  assert.strictEqual(round.w, round.h, 'a round badge stays round');
  const wide = layout.placeLogo(400, 100, style, 1280, 720);
  for (const r of [round, wide]) {
    assert.ok(Number.isInteger(r.x) && Number.isInteger(r.y) && Number.isInteger(r.w) && Number.isInteger(r.h), JSON.stringify(r));
    assert.ok(r.x >= slot.x - 0.5 && r.y >= slot.y - 0.5 && r.x + r.w <= slot.x + slot.w + 0.5 && r.y + r.h <= slot.y + slot.h + 0.5, `inside the space: ${JSON.stringify(r)}`);
    assert.ok(Math.abs(r.x + r.w - (slot.x + slot.w)) <= 1 && Math.abs(r.y - slot.y) <= 0.5, 'top and right anchored');
  }
  assert.ok(Math.abs(wide.w / wide.h - 4) <= 4 / wide.h, `aspect kept (${wide.w}x${wide.h})`);
  // A tall logo space reaching into the text box: with the logo drawn small at its top, words may use the space below it.
  const tall = { ...style, logoSlot: { x: 0.55, y: 0.03, w: 0.37, h: 0.9 }, reactionSlot: { x: 0.95, y: 0.9, w: 0.04, h: 0.05 } };
  const logo = layout.placeLogo(400, 100, tall, 1280, 720);
  const m = metricsFor('BIG WORDS');
  const withLogo = layout.planText(m, [], tall, 1280, 720, null, logo);
  const withSlot = layout.planText(m, [], tall, 1280, 720, null, null);
  assert.ok(withLogo.plan.placement === 'clear' && withSlot.plan.placement === 'clear');
  assert.ok(!overlaps(withLogo.plan.patch, logo), 'the words clear the drawn logo');
  assert.ok(withLogo.plan.size >= withSlot.plan.size, 'the words may use the space the logo does not cover');
});

// ── the library (ThumbnailLook) and the border (2026-09-28, 2026-09-29) ─────────

check('library: photos are copied into <userData>/thumbnail-lab/reaction-photos (CONTENTSTUDIO_USER_DATA); a name already there is refused, then replaced on request; remove; the originals untouched', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-library-'));
  try {
    const userData = scratchUserData(root);
    const lab = new ThumbnailLook({ store: { get: () => undefined, set: () => {} }, userDataPath: userData });
    const src = path.join(root, 'Downloads', 'selfies');
    fs.mkdirSync(src, { recursive: true });
    for (const n of ['selfie laugh.png', 'selfie oh please.png', 'notes.txt']) fs.writeFileSync(path.join(src, n), n.endsWith('.png') ? PNG_BYTES : 'x');
    const before = fs.readdirSync(src).map((n) => [n, fs.statSync(path.join(src, n)).mtimeMs]);
    assert.deepStrictEqual(lab.photos().photos, [], 'an empty library');
    assert.strictEqual(lab.photos().folder, path.join(userData, 'thumbnail-lab', 'reaction-photos'));
    // A folder adds its PNGs; a single file adds itself.
    const one = lab.addPhotos([src], false);
    assert.deepStrictEqual([one.added.sort(), one.already], [['laugh', 'oh please'], []]);
    assert.deepStrictEqual(fs.readdirSync(library.photosDir(userData)).sort(), ['laugh.png', 'oh please.png'], 'stored by name');
    const extra = path.join(root, 'eww.png');
    fs.writeFileSync(extra, PNG_BYTES);
    assert.deepStrictEqual(lab.addPhotos([extra], false).added, ['eww']);
    // A duplicate name: nothing of the batch copied, the names returned for Owen to confirm.
    const newer = path.join(root, 'newer');
    fs.mkdirSync(newer);
    fs.writeFileSync(path.join(newer, 'laugh.png'), Buffer.concat([PNG_BYTES, Buffer.from(' v2')]));
    fs.writeFileSync(path.join(newer, 'ooh.png'), PNG_BYTES);
    const dup = lab.addPhotos([newer], false);
    assert.deepStrictEqual([dup.added, dup.already], [[], ['laugh']], 'refused plainly, naming it');
    assert.ok(!fs.existsSync(path.join(library.photosDir(userData), 'ooh.png')), 'nothing of a refused batch is copied');
    const replaced = lab.addPhotos([newer], true);
    assert.deepStrictEqual([replaced.added, replaced.replaced], [['ooh'], ['laugh']]);
    assert.ok(fs.readFileSync(path.join(library.photosDir(userData), 'laugh.png')).toString().endsWith(' v2'), 'replaced with the new file');
    // Two files of one batch under one name, and a file that is not a PNG, are refused by name.
    fs.writeFileSync(path.join(root, 'selfie ooh.png'), PNG_BYTES);
    assert.throws(() => lab.addPhotos([path.join(newer, 'ooh.png'), path.join(root, 'selfie ooh.png')], true), /would both be the photo "ooh"/);
    const fake = path.join(root, 'fake.png');
    fs.writeFileSync(fake, 'not a picture');
    assert.throws(() => lab.addPhotos([fake], false), /not a PNG picture/);
    // Remove takes only the app's copy. (Photo notes went 2026-09-29 with the ranking that read them.)
    assert.strictEqual(typeof lab.setPhotoNote, 'undefined', 'no photo notes any more');
    lab.removePhoto('eww');
    assert.ok(!fs.existsSync(path.join(library.photosDir(userData), 'eww.png')) && fs.existsSync(extra), 'the app copy goes, the original stays');
    assert.throws(() => lab.removePhoto('eww'), /no reaction photo "eww"/);
    assert.deepStrictEqual(fs.readdirSync(src).map((n) => [n, fs.statSync(path.join(src, n)).mtimeMs]), before, 'the originals are only read');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('library: an old folder or logo setting is OFFERED for copying (never copied on its own), one click copies it, originals untouched; the offer ends once the library holds them', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-migrate-'));
  try {
    const userData = scratchUserData(root);
    const old = path.join(root, 'Downloads', 'selfies');
    fs.mkdirSync(old, { recursive: true });
    for (const n of ['selfie laugh.png', 'selfie are you kidding me.png']) fs.writeFileSync(path.join(old, n), PNG_BYTES);
    const logoFile = path.join(root, 'final logos', 'logo-xl-blue-fixed-2mb.png');
    fs.mkdirSync(path.dirname(logoFile), { recursive: true });
    fs.writeFileSync(logoFile, PNG_BYTES);
    const settings = { 'thumbnailLab.reactionFolder': old, 'thumbnailLab.logo': logoFile };
    const lab = new ThumbnailLook({ store: { get: (k) => settings[k], set: (k, v) => { settings[k] = v; } }, userDataPath: userData });
    const offered = lab.photos();
    assert.deepStrictEqual([offered.photos.length, offered.offer], [0, { from: old, count: 2 }], 'offered, not copied');
    const photosOffer = () => library.photoCopyOffer(userData, old);
    assert.ok(!fs.existsSync(library.photosDir(userData)), 'nothing copied by looking');
    assert.deepStrictEqual(library.logoCopyOffer(userData, logoFile), { from: logoFile }, 'the old logo is offered');
    assert.strictEqual(lab.logoFile(), null, 'and not copied by looking');
    const copied = lab.copyOldPhotos();
    assert.deepStrictEqual(copied.added.sort(), ['are you kidding me', 'laugh']);
    assert.deepStrictEqual(fs.readdirSync(old).sort(), ['selfie are you kidding me.png', 'selfie laugh.png'], 'originals where they were');
    assert.strictEqual(photosOffer(), null, 'the offer ends once the library holds photos');
    assert.deepStrictEqual(library.libraryPhotos(userData).map((p) => p.name), ['are you kidding me', 'laugh']);
    assert.throws(() => lab.copyOldPhotos(), /nothing to copy/);
    assert.deepStrictEqual(settings['thumbnailLab.reactionFolder'], old, 'the old setting is left as it was');
    // The logo copy (its picture check is logo.ts under Electron; here a stand-in check).
    const kept = library.setLibraryLogo(userData, logoFile, () => {});
    assert.strictEqual(kept, path.join(userData, 'thumbnail-lab', 'logo', 'logo-xl-blue-fixed-2mb.png'));
    assert.ok(fs.existsSync(logoFile), 'the original logo stays');
    assert.strictEqual(library.logoCopyOffer(userData, logoFile), null, 'no offer once the app holds a logo');
    assert.throws(() => library.setLibraryLogo(userData, path.join(root, 'nope.png'), () => {}), /not there/);
    assert.throws(() => library.setLibraryLogo(userData, logoFile, () => { throw new Error('could not be read as an image'); }), /could not be read/);
    assert.strictEqual(library.libraryLogo(userData), kept, 'a refused logo leaves the kept one');
    // A gone folder offers nothing.
    assert.strictEqual(library.photoCopyOffer(path.join(root, 'fresh'), path.join(root, 'gone')), null);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('border: one PNG kept in <userData>/thumbnail-lab/border (CONTENTSTUDIO_USER_DATA), replacing the one kept; a missing, non-PNG or unreadable file is refused naming it and the kept border stays; the original only read', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-border-'));
  try {
    const userData = scratchUserData(root);
    assert.strictEqual(library.libraryBorder(userData), null, 'none kept: none drawn');
    const src = path.join(root, 'Downloads', 'thumbnail-border.png');
    fs.mkdirSync(path.dirname(src), { recursive: true });
    fs.writeFileSync(src, PNG_BYTES);
    const before = fs.statSync(src).mtimeMs;
    const kept = library.setLibraryBorder(userData, src, () => {});
    assert.strictEqual(kept, path.join(userData, 'thumbnail-lab', 'border', 'thumbnail-border.png'));
    assert.strictEqual(library.libraryBorder(userData), kept);
    assert.strictEqual(fs.statSync(src).mtimeMs, before, 'the original only read');
    assert.throws(() => library.setLibraryBorder(userData, path.join(root, 'nope.png'), () => {}), /The border file is not there: .*nope\.png/);
    const jpeg = path.join(root, 'border.jpg');
    fs.writeFileSync(jpeg, Buffer.from([0xff, 0xd8, 0xff, 0x00]));
    assert.throws(() => library.setLibraryBorder(userData, jpeg, () => {}), /must be a PNG picture with a transparent middle: .*border\.jpg/);
    assert.throws(() => library.setLibraryBorder(userData, src, () => { throw new Error('The border file is 1000x1000, not 16:9'); }), /not 16:9/);
    assert.strictEqual(library.libraryBorder(userData), kept, 'a refused border leaves the kept one');
    const second = path.join(root, 'border two.png');
    fs.writeFileSync(second, PNG_BYTES);
    library.setLibraryBorder(userData, second, () => {});
    assert.deepStrictEqual(fs.readdirSync(library.borderDir(userData)), ['border two.png'], 'the one kept is replaced');
    // The default look draws it; the look's switch turns it off.
    assert.strictEqual(layout.DEFAULT_STYLE.border, true);
    assert.strictEqual('vignette' in layout.DEFAULT_STYLE, false, 'the procedural vignette is gone');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

run('thumbnail modules: frame filters, sampling, scenes and the grid, the story source, words, the text always fits, text size, logo, library, border');
