/**
 * Keeper: the thumbnail modules the metadata run and the reports page's Thumbnails window share
 * (built for the Thumbnails test tab on 2026-09-28; the tab was retired in phase 2 the same day,
 * and its tab-only checks went with it). The Node half of `npm run check:thumbnail-lab`.
 *
 * What it pins, against the COMPILED main process and the fake Crucible (no live server, no card):
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
 *     closest pair; every sampled frame counts toward a scene's time on screen; the scoring cap is
 *     shared with a floor per scene and the rest by screen time.
 *   - RANKING: the desktop answer is the one filter, everything else ranks; the best view is one
 *     row per scene with its top frames, scenes ordered by their best frame, screen-only scenes
 *     left out and named; a frame with a missing option letter is unreadable, not guessed.
 *   - TEXT: the words prompt fills every slot from thumbnails.yml; the plain-text answer parses into
 *     the three kinds with decoration stripped and off-brief options warned about, never dropped.
 *   - THE TEXT ALWAYS FITS (phase 2, Owen 2026-09-28): the text box runs from the left margin to
 *     where the reaction photo begins and from the top margin to the bottom margin; one or two
 *     lines, shrunk to fit, never refused and never cut; off the padded faces and the logo when a
 *     face-free space holds the words at the 7% floor, else in the whole box at the floor or smaller
 *     where they cover the least of a face, said in the note.
 *   - the logo is fitted in its space with its aspect kept and the words avoid its drawn bounds;
 *     the reaction photos and logo are copied into the app's library (ThumbnailLook: add,
 *     duplicate refused then replaced, remove, the one-click copy offer from the old folder
 *     setting, originals untouched) on a CONTENTSTUDIO_USER_DATA scratch folder; a "top-ranked"
 *     photo is drawn from the top 3 with a stated seed, reproducibly, avoiding repeats; the best
 *     view shows 2 frames per scene with the rest behind "More", and small interleaved fragments of
 *     one moving shot fold into one scene.
 *   - SCORING over the real transport and lanes: one image per decide call, the five questions as
 *     ITEMS of that call (Crucible 1.0.55 decideItems; the yes/no and 1-5 shapes read back),
 *     `missing: report`, the engine's stated width; `model_text_only`, `refuse_images_not_served`
 *     and a model that is not installed each surface with the model and the server named.
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
const { assert, fake, context, rejection, check, run, crucible, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
services('metadata/prompt-assets.js').initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));
const metrics = services('thumbnails/frame-metrics.js');
const ranking = services('thumbnails/frame-ranking.js');
const scenes = services('thumbnails/frame-scenes.js');
const layout = services('thumbnails/layout.js');
const prompts = services('thumbnails/prompts.js');
const sampler = services('thumbnails/frame-sampler.js');
const scorer = services('thumbnails/frame-scorer.js');
const { installCrucibleTransport } = crucible('transport');
const { installLanes } = crucible('lanes');

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
function reading(over = {}) {
  return { pScreen: 0.05, pFace: 0.95, expression: 3, pEyesOpen: 0.9, pStrong: 0.6, ...over };
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

check('scenes: a scene on screen under SHORT_SCENE_SECONDS offers one frame, not the full floor', () => {
  const list = [
    { number: 1, size: 200, seconds: 400 },
    { number: 2, size: 20, seconds: scenes.SHORT_SCENE_SECONDS - 1 },
    { number: 3, size: 20, seconds: scenes.SHORT_SCENE_SECONDS },
  ];
  const { quota } = scenes.allocateScoring(list, 10);
  assert.strictEqual(quota.get(2), 1, `a ${scenes.SHORT_SCENE_SECONDS - 1} s scene gets one (${[...quota.values()]})`);
  assert.ok(quota.get(3) >= scenes.SCENE_FLOOR, `a ${scenes.SHORT_SCENE_SECONDS} s scene keeps the floor (${[...quota.values()]})`);
  assert.strictEqual([...quota.values()].reduce((a, b) => a + b, 0), 10);
});

check('scenes: the scoring cap is shared: a floor for every scene (all of a tiny one), the rest by screen time, the total unchanged', () => {
  const list = [
    { number: 1, size: 200, seconds: 400 },
    { number: 2, size: 80, seconds: 160 },
    { number: 3, size: 2, seconds: 2 },
    { number: 4, size: 30, seconds: 30 },
    { number: 5, size: 1, seconds: 1 },
  ];
  const { quota, short } = scenes.allocateScoring(list, 60);
  const q = list.map((s) => quota.get(s.number));
  assert.strictEqual(short, false);
  assert.strictEqual(q.reduce((a, b) => a + b, 0), 60, `the cap is used exactly (${q})`);
  assert.deepStrictEqual([q[2], q[4]], [1, 1], 'a tiny scene, on screen a second or two, sends one frame');
  assert.ok(q[0] > q[1] && q[1] > q[3] && q[3] >= scenes.SCENE_FLOOR, `longer on screen, more frames (${q})`);
  const rest = [q[0] - 3, q[1] - 3, q[3] - 3];
  assert.ok(Math.abs(rest[0] / rest[1] - 400 / 160) < 0.5, `the rest follows screen time (${rest})`);
  // Under the cap, everything is scored.
  const all = scenes.allocateScoring(list.slice(2), 60).quota;
  assert.deepStrictEqual([...all.values()], [2, 30, 1]);
  // More scenes than the floors allow: one each, longest on screen first, and the run says so.
  const many = Array.from({ length: 30 }, (_, i) => ({ number: i + 1, size: 5, seconds: 100 - i }));
  const tight = scenes.allocateScoring(many, 20);
  assert.strictEqual(tight.short, true);
  assert.deepStrictEqual([...tight.quota.values()], [...Array(20).fill(1), ...Array(10).fill(0)]);
  assert.throws(() => scenes.allocateScoring(list, 0), /not a count/);
});

check('scenes: the frames scored are each scene\'s share, spread across that scene\'s own time on screen', () => {
  const mk = (t, sharpness = 10) => ({ t, sharpness });
  const sceneList = [
    { number: 1, frames: Array.from({ length: 40 }, (_, i) => mk(i < 20 ? i : 500 + i)), sampled: 40, seconds: 40 },
    { number: 2, frames: [mk(100), mk(101)], sampled: 2, seconds: 2 },
  ];
  const picked = scenes.framesToScore(sceneList, new Map([[1, 6], [2, 2]]));
  assert.strictEqual(picked.length, 8);
  const one = picked.filter((f) => f.t < 100 || f.t >= 500);
  assert.ok(one.some((f) => f.t < 20) && one.some((f) => f.t >= 500), 'both of scene 1\'s visits are sampled');
  for (let i = 1; i < picked.length; i++) assert.ok(picked[i].t > picked[i - 1].t, 'time order');
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

// ── ranking ─────────────────────────────────────────────────────────────────

check('ranking: the desktop answer is the one filter; face, expression, eyes and "strong" rank without thresholds', () => {
  const frames = [
    { id: 'desk', t: 10, reading: reading({ pScreen: 0.8, pStrong: 1, expression: 5 }) },
    { id: 'blank', t: 20, reading: reading({ expression: 1, pStrong: 0.2 }) },
    { id: 'wild', t: 30, reading: reading({ expression: 5, pStrong: 0.9 }) },
    { id: 'noface', t: 40, reading: reading({ pFace: 0.05, expression: 5, pStrong: 0.9 }) },
    { id: 'shut', t: 50, reading: reading({ expression: 5, pStrong: 0.9, pEyesOpen: 0.05 }) },
  ];
  const r = ranking.rankFrames(frames);
  assert.deepStrictEqual(r.screens.map((f) => f.id), ['desk']);
  assert.deepStrictEqual(r.ranked.map((f) => f.id), ['wild', 'shut', 'blank', 'noface']);
  assert.ok(r.ranked.every((f) => f.score >= 0 && f.score <= 1));
});

check('ranking: the best view shows 2 frames per scene (the best, then the best clearly different one), the rest behind "More"; scenes ordered by their best frame; a screens-only scene is named', () => {
  const frames = [];
  const sceneOf = new Map();
  const sigOf = new Map();
  // Scene 1: a host who barely moves (frames 0-29), then walks across (30-39): the second shown frame
  // is the best of the walk, not the near-twin of the best. Scene 2: one excellent frame. Scene 3:
  // middling frames that all look alike and read alike (no clearly different frame: one shown).
  // Scene 4: only screens.
  for (let i = 0; i < 40; i++) {
    frames.push({ id: `a${i}`, t: i * 5, reading: reading({ expression: 4, pStrong: 0.95 - i / 100 }) });
    sceneOf.set(`a${i}`, 1);
    sigOf.set(`a${i}`, sig(studio, { x: i < 30 ? 2 : 10, y: 2, colour: skin }, 10 + i));
  }
  frames.push({ id: 'b0', t: 1000, reading: reading({ expression: 5, pStrong: 0.99 }) }); sceneOf.set('b0', 2); sigOf.set('b0', sig(garden));
  for (let i = 0; i < 6; i++) { frames.push({ id: `c${i}`, t: 2000 + i * 10, reading: reading({ expression: 2, pStrong: 0.3 }) }); sceneOf.set(`c${i}`, 3); sigOf.set(`c${i}`, sig(page, null, i + 1)); }
  for (let i = 0; i < 3; i++) { frames.push({ id: `d${i}`, t: 3000 + i, reading: reading({ pScreen: 0.9 }) }); sceneOf.set(`d${i}`, 4); sigOf.set(`d${i}`, sig(page)); }
  const { ranked, screens } = ranking.rankFrames(frames);
  assert.strictEqual(screens.length, 3);
  const { rows, empty } = scenes.sceneRows(ranked, sceneOf, [1, 2, 3, 4], sigOf);
  assert.deepStrictEqual(rows.map((r) => r.scene), [2, 1, 3], 'scenes ordered by their best frame\'s score');
  assert.deepStrictEqual(empty, [4], 'the scene of computer screens has no row, and is named');
  assert.strictEqual(scenes.SCENE_ROW_SHOWN, 2);
  const one = rows.find((r) => r.scene === 1);
  assert.deepStrictEqual(one.ids, ['a0', 'a30'], 'the best, then the best frame that looks clearly different (the walk), not its near-twin a1');
  assert.ok(scenes.signatureDistance(sigOf.get('a0'), sigOf.get('a1')) < scenes.CLEARLY_DIFFERENT_FRACTION, 'a1 is a near-twin');
  assert.strictEqual(one.more.length, 38, 'every other frame of the scene is behind "More from this scene"');
  assert.deepStrictEqual(rows.find((r) => r.scene === 3).ids, ['c0'], 'no clearly different frame: the best alone');
  assert.strictEqual(rows.find((r) => r.scene === 3).more.length, 5);
  // An expression apart counts as clearly different even where the picture barely moves.
  const faces = [
    { id: 'e0', t: 0, score: 0.9, reading: { expression: 4 } },
    { id: 'e1', t: 10, score: 0.8, reading: { expression: 3.8 } },
    { id: 'e2', t: 20, score: 0.7, reading: { expression: 2.5 } },
  ];
  const still = new Map(faces.map((f, i) => [f.id, sig(studio, { x: 2, y: 2, colour: skin }, i + 1)]));
  const r2 = scenes.sceneRows(faces, new Map(faces.map((f) => [f.id, 1])), [1], still);
  assert.deepStrictEqual(r2.rows[0].ids, ['e0', 'e2'], 'the expression reading 1.5 levels apart');
  const byId = new Map(ranked.map((f) => [f.id, f]));
  for (const row of rows) {
    const got = [...row.ids, ...row.more].map((id) => byId.get(id));
    for (const a of got) for (const b of got) if (a !== b) assert.ok(Math.abs(a.t - b.t) >= scenes.SCENE_MIN_GAP_SECONDS, `${a.id} and ${b.id} are the same moment`);
  }
  assert.ok(rows.every((r) => [...r.ids, ...r.more].every((id) => !id.startsWith('d'))), 'no rejected frame in any row');
  assert.throws(() => scenes.sceneRows(ranked, new Map(), [1], sigOf), /belongs to no scene/);
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

check('ranking: an answer with a missing option letter is unreadable and names the question; a full one reads', () => {
  const full = {
    screen: { type: 'choice', probabilities: { video: 0.9, screen: 0.1 }, missingLabels: [] },
    face: { type: 'yesno', p: 0.8, missingLabels: [] },
    expression: { type: 'score', score: 4.2, missingLabels: [] },
    eyes: { type: 'yesno', p: 0.7 },
    strong: { type: 'yesno', p: 0.6 },
  };
  assert.deepStrictEqual(ranking.readFrameAnswers(full), { pScreen: 0.1, pFace: 0.8, expression: 4.2, pEyesOpen: 0.7, pStrong: 0.6 });
  const missing = { ...full, face: { type: 'yesno', p: 1, missingLabels: ['No'] } };
  let err = null;
  try { ranking.readFrameAnswers(missing); } catch (e) { err = e; }
  assert.ok(err && err.code === 'frame_answer_unreadable' && err.question === 'face' && /did not include No/.test(err.message), err && err.message);
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

check('frames: the five questions come from thumbnails.yml, packed as five ITEMS of one call with one frame, missing: report', () => {
  const q = prompts.frameQuestions();
  assert.deepStrictEqual(Object.keys(q), [...ranking.FRAME_QUESTIONS]);
  assert.deepStrictEqual(Object.keys(q.screen.options), ['video', 'screen']);
  assert.strictEqual(q.expression.levels.length, 5);
  const body = prompts.frameDecideItems('QUJD');
  assert.deepStrictEqual(body.images, ['QUJD']);
  assert.strictEqual(body.missing, 'report');
  assert.strictEqual(body.items.length, 5, 'one item per question, in FRAME_QUESTIONS order');
  assert.deepStrictEqual(body.items[0], { text: q.screen.instructions, options: q.screen.options });
  assert.strictEqual(body.items[1].text, `Statement: ${q.face.instructions}\nIs this statement true of the image?`, 'a yes/no question is the statement the server\'s own yesno puts');
  assert.deepStrictEqual(body.items[1].options, { yes: 'Yes', no: 'No' });
  assert.deepStrictEqual(Object.entries(body.items[2].options), q.expression.levels.map((l, i) => [String(i + 1), l]), 'the expression scale as its five levels, keyed 1-5 in order');
  assert.ok(body.items.every((item) => !/\b1\.|\bQ\d/.test(item.text)), 'no numbered slots in one prompt');
});

check('frames: the items\' answers read back as the five readings (P(yes), the expression as the sum of level x p)', () => {
  const choice = (probabilities, missingLabels = []) => ({ type: 'choice', choice: '', probabilities, logprobs: {}, confidence: 0, labelMass: 1, missingLabels });
  const answers = [
    choice({ video: 0.8, screen: 0.2 }), choice({ yes: 0.9, no: 0.1 }), choice({ 1: 0, 2: 0, 3: 0.5, 4: 0.5, 5: 0 }),
    choice({ yes: 0.6, no: 0.4 }), choice({ yes: 0.3, no: 0.7 }),
  ];
  assert.deepStrictEqual(ranking.readFrameAnswers(prompts.frameAnswersOfItems(answers)), { pScreen: 0.2, pFace: 0.9, expression: 3.5, pEyesOpen: 0.6, pStrong: 0.3 });
  const noYes = [...answers];
  noYes[1] = choice({ yes: null, no: 1 }, ['yes']);
  assert.throws(() => ranking.readFrameAnswers(prompts.frameAnswersOfItems(noYes)), /"face" answer did not include yes/);
  assert.throws(() => prompts.frameAnswersOfItems(answers.slice(0, 4)), /answered 4 items; 5 were asked/);
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
  assert.ok(p.capPx >= STYLE.minCapFraction * FH - 1e-6 && p.capPx <= STYLE.maxCapFraction * FH + 1e-6, `cap ${p.capPx}`);
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

check('layout: a short phrase is fitted large (up to the ceiling), and shrinks as the space shrinks', () => {
  const open = layout.planText(metricsFor('MAYBE TOMORROW'), [], STYLE, FW, FH);
  assert.ok(Math.abs(open.plan.capPx - STYLE.maxCapFraction * FH) < 1e-6, `with room, the ceiling (${open.plan.capPx})`);
  const tight = layout.planText(metricsFor('MAYBE TOMORROW'), [{ x: 420, y: 80, w: 300, h: 300 }], STYLE, FW, FH);
  assert.ok(tight.plan.capPx < open.plan.capPx && tight.plan.capPx >= STYLE.minCapFraction * FH - 1e-6);
  assert.strictEqual(tight.plan.placement, 'clear');
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
  assert.ok(open.plan.lines.length <= 2 && Math.abs(open.plan.capPx - STYLE.maxCapFraction * FH) < 1e-6, JSON.stringify(open.plan.lines));
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

// ── scoring over the door ───────────────────────────────────────────────────

const VISION = [
  { id: 'qwen3.5-9b-vl', paramsB: 9, installed: true, contextDefault: 16384, modalities: ['text', 'image'], weightsOf: 'qwen3.5-9b' },
  { id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384, modalities: ['text'] },
  { id: 'qwen3.5-2b', paramsB: 2, installed: false, contextDefault: 16384, modalities: ['text', 'image'] },
  { id: 'qwen3.8-27b-8bit', paramsB: 27, installed: true, contextDefault: 16384, modalities: ['text'] },
];

function decideProbs(q) {
  // The frame items (all choices since 1.0.55): the screen pair, a yes/no statement, the 1-5 scale.
  if (q.labels.includes('video')) return { video: 0.9, screen: 0.1 };
  if (q.labels[0] === 'yes') return { yes: 0.8, no: 0.2 };
  if (q.labels[0] === '1') return Object.fromEntries(q.labels.map((l, i) => [l, i === 3 ? 0.7 : 0.075]));
  if (q.type === 'choice') return { video: 0.9, screen: 0.1 };
  if (q.type === 'score') return Object.fromEntries(q.labels.map((l, i) => [l, i === 3 ? 0.7 : 0.075]));
  return { Yes: 0.8, No: 0.2 };
}

async function withFake(options, fn) {
  const server = await fake.startFakeCrucible({ version: '1.0.54', models: VISION, decideProbs, ...options });
  const made = context({ leaseTimings: { heartbeatMs: 40, releaseGraceMs: 20, requestTimeoutMs: 500 } });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-score-'));
  const frames = Array.from({ length: 5 }, (_, i) => {
    const file = path.join(dir, `f${i}.jpg`);
    fs.writeFileSync(file, Buffer.from(`fake jpeg ${i}`));
    return { id: `f${i}`, t: 10 * i, image: file };
  });
  const deps = { lanes: made.ctx.lanes, transport: made.ctx.transport, clientFor: (s) => made.ctx.factory.clientFor(s) };
  try {
    await fn(server, deps, frames);
  } finally {
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

check('scoring: one image per decide call, the five questions as its items, missing: report, at the engine\'s stated width', () => withFake({ chatMaxInFlight: 3 }, async (server, deps, frames) => {
  const out = await scorer.scoreFrames({ deps, jobId: 'keeper-score', model: 'qwen3.5-9b-vl', frames });
  assert.strictEqual(out.scored.length, 5);
  assert.strictEqual(out.width, 3);
  assert.ok(/admits 3 at once/.test(out.widthBasis), out.widthBasis);
  const bodies = server.decideBodies();
  assert.strictEqual(bodies.length, 5);
  assert.ok(bodies.every((b) => b.model === 'qwen3.5-9b-vl' && b.images.length === 1 && b.missing === 'report'));
  assert.ok(bodies.every((b) => b.questions === undefined && Array.isArray(b.items) && b.items.length === 5), 'the items form: one call per frame, five items');
  assert.deepStrictEqual(bodies[0].items.map((i) => Object.keys(i.options)), [['video', 'screen'], ['yes', 'no'], ['1', '2', '3', '4', '5'], ['yes', 'no'], ['yes', 'no']]);
  assert.deepStrictEqual(bodies.map((b) => Buffer.from(b.images[0], 'base64').toString()).sort(), frames.map((_, i) => `fake jpeg ${i}`));
  const r = out.scored[0].reading;
  assert.ok(r.pScreen < 0.2 && r.pFace > 0.7 && r.expression > 3 && r.expression < 5, JSON.stringify(r));
  const loads = server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b.type === 'load-model');
  assert.deepStrictEqual(loads.map((b) => [b.model, b.params.context]), [['qwen3.5-9b-vl', scorer.FRAME_LOAD_CONTEXT]]);
}));

check('scoring: an item whose answer lacks its yes label sets that frame aside, naming the question; the rest still score', () => withFake({
  decideProbs: (q) => (q.labels[0] === 'yes' && /eyes open/.test(q.instructions) ? { no: 1 } : decideProbs(q)),
}, async (server, deps, frames) => {
  const out = await scorer.scoreFrames({ deps, jobId: 'keeper-missing', model: 'qwen3.5-9b-vl', frames: frames.slice(0, 2) });
  assert.strictEqual(out.scored.length, 0);
  assert.strictEqual(out.unreadable.length, 2);
  assert.ok(out.unreadable.every((u) => /"eyes" answer did not include yes/.test(u.reason)), out.unreadable.map((u) => u.reason).join(' | '));
}));

check('scoring: an engine that states no admission limit gets one call at a time', () => withFake({}, async (server, deps, frames) => {
  const out = await scorer.scoreFrames({ deps, jobId: 'keeper-one', model: 'qwen3.5-9b-vl', frames: frames.slice(0, 2) });
  assert.strictEqual(out.width, 1);
  assert.ok(/states no admission limit/.test(out.widthBasis));
}));

check('scoring: a text-only model is refused by Crucible, and the refusal names the model and the server', () => withFake({}, async (server, deps, frames) => {
  const err = await rejection(scorer.scoreFrames({ deps, jobId: 'keeper-text', model: 'qwen3.5-9b', frames }));
  assert.strictEqual(err.code, 'model_text_only');
  assert.ok(/qwen3\.5-9b reads text only on "mac"/.test(err.message) && /Thumbnail frames/.test(err.message), err.message);
  assert.ok(/"mac" can read pictures with: qwen3\.5-9b-vl, qwen3\.5-2b\./.test(err.message), 'the server\'s image_models are named');
  assert.strictEqual(server.decideBodies().length, 1, 'the first refusal stops the run');
}));

check('scoring: a server whose engine does not serve images says so by name (refuse_images_not_served)', () => withFake({ imagesNotServed: 'mlx-vlm returns no logprobs' }, async (server, deps, frames) => {
  const err = await rejection(scorer.scoreFrames({ deps, jobId: 'keeper-mac', model: 'qwen3.5-9b-vl', frames }));
  assert.strictEqual(err.code, 'refuse_images_not_served');
  assert.ok(/"mac" cannot show pictures to qwen3\.5-9b-vl yet/.test(err.message) && /mlx-vlm/.test(err.message), err.message);
}));

check('scoring: a model that is not installed is refused naming it and the server; nothing is substituted', () => withFake({}, async (server, deps, frames) => {
  const err = await rejection(scorer.scoreFrames({ deps, jobId: 'keeper-absent', model: 'qwen3.5-2b', frames }));
  assert.strictEqual(err.code, 'model_not_installed');
  assert.ok(/qwen3\.5-2b is not downloaded on "mac"/.test(err.message) && /nothing was substituted/.test(err.message), err.message);
  assert.strictEqual(server.decideBodies().length, 0);
}));

// ── tone and photo suggestion ───────────────────────────────────────────────

const judge = services('thumbnails/judge.js');

const PHOTOS = [
  { name: 'laugh', note: 'laughing; light topics only, never for deaths or real victims' },
  { name: 'horrified', note: 'horrified; serious topics' },
  { name: 'oh please', note: 'dismissive; for a claim that is not worth believing' },
  { name: 'ooh', note: null },
];

check('tone and photo: the lists and drafts come from thumbnails.yml; the states fill every slot', () => {
  const tones = judge.toneOptions();
  assert.deepStrictEqual(tones.slice(0, 3), ['mocking', 'absurd', 'outraged']);
  assert.strictEqual(tones.length, 10);
  const drafts = judge.draftNotes();
  assert.ok(/never for deaths or real victims/.test(drafts['uh oh laughing']) && /serious/.test(drafts['this is wrong']) && /facepalm/.test(drafts['head slap']));
  assert.deepStrictEqual(judge.legendLines(PHOTOS.slice(2)), ['oh please: dismissive; for a claim that is not worth believing', 'ooh']);
  const tone = judge.toneState({ channel: 'Fireside', creator: 'owen morgan', hook: 'A hook.', description: 'The body.\n\n🔥 Support the Show: https://x', transcript: ['[0:01] a', '[0:02] b'] });
  assert.ok(!/\{[a-z_]+\}/.test(tone) && tone.includes('The body.') && !tone.includes('Support the Show'), 'the links under the description are left out');
  const photo = judge.photoState({ channel: 'Fireside', creator: 'owen morgan', summary: 'S', tone: 'mocking', text: null, photos: PHOTOS });
  assert.ok(!/\{[a-z_]+\}/.test(photo) && /picture only/.test(photo) && photo.includes('ooh\n') === false && photo.endsWith('ooh'));
});

check('tone and photo: a ranking is most probable first, an unrated option last, nothing dropped', () => {
  const r = judge.rankingOf({ probabilities: { a: 0.2, b: null, c: 0.7, d: 0.1 } }, ['a', 'b', 'c', 'd'], 'x');
  assert.deepStrictEqual(r.map((x) => x.name), ['c', 'a', 'd', 'b']);
  assert.strictEqual(r[3].p, null);
  assert.throws(() => judge.rankingOf({ probabilities: { a: null, b: null } }, ['a', 'b'], 'The answer'), /rated none/);
});

function judgeProbs(q, state) {
  if (q.labels.includes('mocking')) return Object.fromEntries(q.labels.map((l) => [l, l === 'absurd' ? 0.55 : l === 'mocking' ? 0.3 : 0.15 / 8]));
  const serious = /DON'T STAND UNDER A ROOF/.test(state);
  const top = serious ? 'horrified' : /MAYBE TOMORROW/.test(state) ? 'oh please' : 'laugh';
  return Object.fromEntries(q.labels.map((l) => [l, l === top ? 0.6 : l === 'ooh' ? 0.25 : 0.05]));
}

check('tone and photo over the door: one job, text-only decides on the judge model, tone first, a ranking per variant', () => withFake({ decideProbs: judgeProbs }, async (server, deps) => {
  const out = await judge.judgeThumbnails({
    deps, jobId: 'keeper-judge', model: 'qwen3.5-9b',
    tone: { channel: 'Fireside', creator: 'owen morgan', hook: 'She says the rapture is here.', description: 'A rapture claim.\n\nLinks', transcript: ['[0:01] hello'] },
    photos: PHOTOS,
    variants: [{ letter: 'A', text: "DON'T STAND UNDER A ROOF" }, { letter: 'B', text: 'MAYBE TOMORROW' }, { letter: 'C', text: null }],
  });
  assert.strictEqual(out.tone[0].name, 'absurd');
  assert.ok(Math.abs(out.tone[0].p - 0.55) < 1e-6);
  assert.deepStrictEqual([out.photos.A[0].name, out.photos.B[0].name, out.photos.C[0].name], ['horrified', 'oh please', 'laugh']);
  assert.deepStrictEqual(out.photos.A.map((r) => r.name).sort(), PHOTOS.map((p) => p.name).sort(), 'every photo is ranked, none hidden');
  assert.strictEqual(out.photos.A[1].name, 'ooh');
  const bodies = server.decideBodies();
  assert.strictEqual(bodies.length, 4);
  assert.ok(bodies.every((b) => b.model === 'qwen3.5-9b' && !b.images && b.missing === 'report'));
  assert.ok(bodies.slice(1).every((b) => /The tone of the video: absurd/.test(b.state)), 'the photo states carry the tone just read');
  assert.ok(/ooh$/m.test(bodies[1].state) && /oh please: dismissive/.test(bodies[1].state), 'the legend lists every photo with its note');
  const loads = server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b.type === 'load-model');
  assert.deepStrictEqual(loads.map((b) => b.model), ['qwen3.5-9b'], 'one load, one lease');
}));

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
const draw = services('thumbnails/photo-draw.js');
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

// ── the library (ThumbnailLook) and the draw (2026-09-28) ────────────────────

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
    // Notes stay per name; remove takes only the app's copy.
    lab.setPhotoNote('eww', 'disgust');
    lab.removePhoto('eww');
    assert.ok(!fs.existsSync(path.join(library.photosDir(userData), 'eww.png')) && fs.existsSync(extra), 'the app copy goes, the original stays');
    assert.throws(() => lab.removePhoto('eww'), /no reaction photo "eww"/);
    assert.throws(() => lab.setPhotoNote('eww', 'x'), /no reaction photo "eww"/);
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

check('draw: a "top-ranked" photo is drawn from the top 3 by probability, reproducible from its seed, a repeat avoided while another remains; direct picks untouched', () => {
  const rank = (...pairs) => pairs.map(([name, p]) => ({ name, p }));
  // Owen's case: one photo tops every ranking.
  const same = rank(['are you kidding me', 0.32], ['oh please', 0.21], ['horrified', 0.15], ['laugh', 0.1]);
  const rankings = { A: same, B: same, C: same };
  const one = draw.drawPhotos(rankings, ['A', 'B', 'C'], [], 12345);
  assert.deepStrictEqual(draw.drawPhotos(rankings, ['A', 'B', 'C'], [], 12345), one, 'the same seed, the same draw');
  assert.strictEqual(new Set(Object.values(one).map((d) => d.name)).size, 3, `A, B and C differ (${Object.values(one).map((d) => d.name)})`);
  for (const d of Object.values(one)) {
    assert.ok(['are you kidding me', 'oh please', 'horrified'].includes(d.name), 'only the top 3');
    assert.deepStrictEqual(d.pool.map((r) => r.name), ['are you kidding me', 'oh please', 'horrified']);
  }
  // Over many seeds the first draw follows the renormalised probabilities.
  const counts = {};
  for (let s = 1; s <= 3000; s++) { const n = draw.drawPhotos({ A: same }, ['A'], [], s).A.name; counts[n] = (counts[n] ?? 0) + 1; }
  assert.ok(Math.abs(counts['are you kidding me'] / 3000 - 0.32 / 0.68) < 0.04, JSON.stringify(counts));
  assert.ok(Math.abs(counts['horrified'] / 3000 - 0.15 / 0.68) < 0.04, JSON.stringify(counts));
  assert.strictEqual(counts['laugh'], undefined, 'the 4th never');
  // A directly picked photo is avoided by the draw; with the whole top 3 taken, the repeat is said.
  const avoid = draw.drawPhotos({ A: same }, ['A'], ['are you kidding me', 'oh please'], 9);
  assert.deepStrictEqual([avoid.A.name, avoid.A.repeatForced, avoid.A.chance], ['horrified', false, 1]);
  const forced = draw.drawPhotos({ A: same }, ['A'], ['are you kidding me', 'oh please', 'horrified'], 9);
  assert.strictEqual(forced.A.repeatForced, true);
  assert.ok(/already on another thumbnail/.test(draw.drawLine(forced.A)));
  assert.ok(/^\S.* \(\d+%\), drawn from the top 3: are you kidding me 32%, oh please 21%, horrified 15%$/.test(draw.drawLine(one.A)), draw.drawLine(one.A));
  assert.throws(() => draw.drawPhotos(rankings, ['A'], [], 0), /whole number from 1/);
  assert.throws(() => draw.drawPhotos({ A: rank(['x', null], ['y', null]) }, ['A'], [], 3), /no probability/);
});

run('thumbnail modules: frame filters, sampling, the story source, ranking, words, the text always fits, scoring, tone and photos, logo, library, draw');
