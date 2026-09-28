/**
 * Keeper: the Thumbnails tab (2026-09-28), the Node half of `npm run check:thumbnail-lab`.
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
 *     recording's length; an unlinked report gets the picker and never a name match, the pick is
 *     saved as the selection record's transcriptRef, frames come only from the story's stretches,
 *     and an untrusted alignment, a missing or split screen recording and a renamed story are
 *     refused by name. The real 2026-09-24 session is read (never written) as a fixture reference.
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
 *   - FACE-SAFE BOX: the text never touches a padded face or a reserved slot, sits bottom-left
 *     when it can, fits by shrinking, and a phrase that cannot keep the letter floor is REFUSED
 *     (never shrunk below it, never truncated).
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
  assert.deepStrictEqual([q[2], q[4]], [2, 1], 'a tiny scene sends all it has');
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

check('ranking: the best view is one row per scene, its top frames (never two within 4 s), scenes ordered by their best frame; a screens-only scene is named', () => {
  const frames = [];
  const sceneOf = new Map();
  // Scene 1: many good frames; scene 2: one excellent frame; scene 3: middling; scene 4: only screens.
  for (let i = 0; i < 40; i++) { frames.push({ id: `a${i}`, t: i, reading: reading({ expression: 4, pStrong: 0.5 + (i % 5) / 20 }) }); sceneOf.set(`a${i}`, 1); }
  frames.push({ id: 'b0', t: 100, reading: reading({ expression: 5, pStrong: 0.99 }) }); sceneOf.set('b0', 2);
  for (let i = 0; i < 6; i++) { frames.push({ id: `c${i}`, t: 200 + i * 10, reading: reading({ expression: 2, pStrong: 0.3 }) }); sceneOf.set(`c${i}`, 3); }
  for (let i = 0; i < 3; i++) { frames.push({ id: `d${i}`, t: 300 + i, reading: reading({ pScreen: 0.9 }) }); sceneOf.set(`d${i}`, 4); }
  const { ranked, screens } = ranking.rankFrames(frames);
  assert.strictEqual(screens.length, 3);
  const { rows, empty } = scenes.sceneRows(ranked, sceneOf, [1, 2, 3, 4]);
  assert.deepStrictEqual(rows.map((r) => r.scene), [2, 1, 3], 'scenes ordered by their best frame\'s score');
  assert.deepStrictEqual(empty, [4], 'the scene of computer screens has no row, and is named');
  assert.deepStrictEqual(rows.map((r) => r.ids.length), [1, scenes.SCENE_ROW_FRAMES, scenes.SCENE_ROW_FRAMES]);
  const byId = new Map(ranked.map((f) => [f.id, f]));
  for (const row of rows) {
    const got = row.ids.map((id) => byId.get(id));
    for (let k = 1; k < got.length; k++) assert.ok(got[k - 1].score >= got[k].score, 'best first within a row');
    for (const a of got) for (const b of got) if (a !== b) assert.ok(Math.abs(a.t - b.t) >= scenes.SCENE_MIN_GAP_SECONDS, `${a.id} and ${b.id} are the same moment`);
    assert.strictEqual(row.best, got[0].score);
  }
  assert.ok(rows.every((r) => r.ids.every((id) => !id.startsWith('d'))), 'no rejected frame in any row');
  assert.throws(() => scenes.sceneRows(ranked, new Map(), [1]), /belongs to no scene/);
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

check('layout: the text avoids the padded face and both reserved slots, bottom-left, letters at or above the floor', () => {
  const face = { x: 515, y: 164, w: 236, h: 236 }; // the rapture frame's face, in output pixels
  const r = layout.planText(metricsFor('DON\'T STAND UNDER A ROOF'), [face], STYLE, FW, FH);
  assert.ok(r.ok, r.reason);
  const p = r.plan;
  assert.ok(!overlaps(p.patch, layout.paddedFace(face, FW, FH)), 'patch clear of the face');
  assert.ok(!overlaps(p.patch, layout.slotRect(STYLE.reactionSlot, FW, FH)), 'patch clear of the reaction slot');
  assert.ok(!overlaps(p.patch, layout.slotRect(STYLE.logoSlot, FW, FH)), 'patch clear of the logo slot');
  assert.ok(p.capPx >= STYLE.minCapFraction * FH - 1e-6 && p.capPx <= STYLE.maxCapFraction * FH + 1e-6, `cap ${p.capPx}`);
  assert.ok(p.lines.length <= 2);
  assert.ok(p.lines.every((l) => Math.abs(l.x - p.lines[0].x) < 1e-9), 'left-aligned');
  const m = layout.MARGIN_FRACTION * FH;
  assert.ok(Math.abs(p.patch.y + p.patch.h - (FH - m)) < 0.5 && p.patch.x - m < 1, `bottom-left (patch at ${JSON.stringify(p.patch)})`);
  assert.ok(p.patch.x >= m - 1e-6 && p.patch.x + p.patch.w <= FW - m + 1e-6 && p.patch.y >= m - 1e-6, 'inside the margins');
});

check('layout: two faces side by side (a split screen) are both avoided', () => {
  const faces = [{ x: 150, y: 120, w: 200, h: 200 }, { x: 760, y: 110, w: 210, h: 210 }];
  const r = layout.planText(metricsFor('SHE\'S SERIOUS'), faces, STYLE, FW, FH);
  assert.ok(r.ok, r.reason);
  for (const f of faces) assert.ok(!overlaps(r.plan.patch, layout.paddedFace(f, FW, FH)));
});

check('layout: a short phrase is fitted large (up to the ceiling), and shrinks as the space shrinks', () => {
  const open = layout.planText(metricsFor('MAYBE TOMORROW'), [], STYLE, FW, FH);
  assert.ok(open.ok);
  assert.ok(Math.abs(open.plan.capPx - STYLE.maxCapFraction * FH) < 1e-6, `with room, the ceiling (${open.plan.capPx})`);
  const tight = layout.planText(metricsFor('MAYBE TOMORROW'), [{ x: 420, y: 80, w: 300, h: 300 }], STYLE, FW, FH);
  assert.ok(tight.ok);
  assert.ok(tight.plan.capPx < open.plan.capPx && tight.plan.capPx >= STYLE.minCapFraction * FH - 1e-6);
});

check('layout: a phrase that cannot keep the letter floor is refused in plain words, never shrunk or cut', () => {
  const face = { x: 400, y: 100, w: 380, h: 420 };
  const r = layout.planText(metricsFor('THE RAPTURE HAS FAILED EVERY SINGLE YEAR'), [face], STYLE, FW, FH);
  assert.strictEqual(r.ok, false);
  assert.ok(/too long for the space beside the faces/.test(r.reason) && /smallest allowed is 87 px \(12%/.test(r.reason) && /Pick a shorter option/.test(r.reason), r.reason);
  assert.throws(() => layout.validateStyle({ ...layout.DEFAULT_STYLE, fill: 'orange' }), /letter colour.*#RRGGBB/);
  assert.throws(() => layout.validateStyle({ ...layout.DEFAULT_STYLE, reactionSlot: { x: 0.8, y: 0.5, w: 0.4, h: 0.4 } }), /runs off the picture/);
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
  // With a narrow photo the text may use the space the photo does not cover.
  const narrow = layout.placeReaction(200, 1000, style, FW, FH);
  const face = { x: 515, y: 164, w: 236, h: 236 };
  const phrase = metricsFor('EVERY YEAR SINCE 1988 AGAIN');
  const withSpace = layout.planText(phrase, [face], style, FW, FH, null);
  const withPhoto = layout.planText(phrase, [face], style, FW, FH, narrow.avoid);
  assert.strictEqual(withSpace.ok, false, 'with the whole space kept clear it is too long');
  assert.ok(withPhoto.ok, 'with only the narrow photo to avoid it fits');
  assert.ok(!overlaps(withPhoto.plan.patch, narrow.avoid), 'the text clears the photo');
  assert.ok(withPhoto.plan.space.x + withPhoto.plan.space.w > slot.x, 'by reaching into the space the photo leaves free');
  assert.throws(() => layout.validateStyle({ ...layout.DEFAULT_STYLE, reactionOutlinePx: 99 }), /photo outline/);
});

// ── scoring over the door ───────────────────────────────────────────────────

const VISION = [
  { id: 'qwen3.5-9b-vl', paramsB: 9, installed: true, contextDefault: 16384, modalities: ['text', 'image'], weightsOf: 'qwen3.5-9b' },
  { id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384, modalities: ['text'] },
  { id: 'qwen3.5-2b', paramsB: 2, installed: false, contextDefault: 16384, modalities: ['text', 'image'] },
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
const combine = services('thumbnails/combine.js');

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

// ── auto-combine ────────────────────────────────────────────────────────────

const FAV = {
  frames: ['f1', 'f2', 'f3', 'f4'],
  texts: [{ phrase: 'CLAIM ONE', kind: 'claim' }, { phrase: 'STAKES ONE', kind: 'stakes' }],
  photos: ['laugh', 'oh please'],
};

check('combine, best package: every piece varies; short lists repeat from their start; photos follow the suggestion', () => {
  const r = combine.combine(FAV, { mode: 'best' });
  assert.ok(r.ok);
  assert.deepStrictEqual(r.variants.map((v) => [v.letter, v.frameId, v.text.phrase, v.photo]), [
    ['A', 'f1', 'CLAIM ONE', 'laugh'], ['B', 'f2', 'STAKES ONE', 'oh please'], ['C', 'f3', 'CLAIM ONE', 'laugh'],
  ]);
  const rank = { A: ['horrified', 'oh please', 'laugh'], B: ['laugh', 'horrified', 'oh please'], C: ['horrified', 'ooh', 'laugh', 'oh please'] };
  const ranked = combine.combine(FAV, { mode: 'best' }, rank);
  assert.deepStrictEqual(ranked.variants.map((v) => v.photo), ['oh please', 'laugh', 'laugh'], 'each variant takes its highest-ranked favourite');
  const noFav = combine.combine({ ...FAV, photos: [] }, { mode: 'best' }, rank);
  assert.deepStrictEqual(noFav.variants.map((v) => v.photo), ['horrified', 'laugh', 'horrified'], 'with no favourite photo, the top-ranked one');
  const bare = combine.combine({ frames: ['f1'], texts: [], photos: [] }, { mode: 'best' });
  assert.ok(bare.variants.every((v) => v.frameId === 'f1' && v.text.phrase === null && v.photo === null), 'no starred words means picture only');
  assert.deepStrictEqual(combine.combine({ frames: [], texts: [], photos: [] }, { mode: 'best' }), { ok: false, reason: 'Star at least one frame first.' });
});

check('combine, test one thing: two pieces held, the chosen one varies; fewer than two favourites of it is said plainly', () => {
  const text = combine.combine(FAV, { mode: 'test', vary: 'text' });
  assert.deepStrictEqual(text.variants.map((v) => [v.frameId, v.text.phrase, v.photo]), [['f1', 'CLAIM ONE', 'laugh'], ['f1', 'STAKES ONE', 'laugh']], 'two favourites make two variants');
  const frame = combine.combine(FAV, { mode: 'test', vary: 'frame' });
  assert.deepStrictEqual(frame.variants.map((v) => [v.frameId, v.text.phrase, v.photo]), [['f1', 'CLAIM ONE', 'laugh'], ['f2', 'CLAIM ONE', 'laugh'], ['f3', 'CLAIM ONE', 'laugh']]);
  const photo = combine.combine(FAV, { mode: 'test', vary: 'photo' }, { A: ['oh please', 'laugh'] });
  assert.deepStrictEqual(photo.variants.map((v) => [v.frameId, v.text.phrase, v.photo]), [['f1', 'CLAIM ONE', 'oh please'], ['f1', 'CLAIM ONE', 'laugh']], 'photos in the suggestion\'s order');
  assert.deepStrictEqual(combine.combine({ ...FAV, photos: ['laugh'] }, { mode: 'test', vary: 'photo' }), { ok: false, reason: 'To test photos, star at least two photos.' });
});

// ── the story source: regions minus cuts, the segment table, the alignment (2026-09-28) ──────────

const timelineMap = require(path.join(DIST, 'shared', 'master-timeline-map.js'));
const storySource = services('thumbnails/story-source.js');
const { ThumbnailLab } = services('thumbnails/lab-service.js');

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

/** The lab over fakes: a stand-in item list, an in-memory selection store, the synthetic manifest. */
function labOver(root, w, { runStoryRef = undefined } = {}) {
  const records = new Map();
  const updates = [];
  const publishStore = {
    get: (itemId) => records.get(itemId) ?? null,
    update: async (itemId, seed, patch) => {
      updates.push({ itemId, seed, patch });
      const next = { itemId, jobId: seed.jobId, transcriptRef: seed.transcriptRef ?? null, ...(records.get(itemId) ?? {}), ...patch };
      records.set(itemId, next);
      return next;
    },
  };
  const manifests = [];
  const lab = new ThumbnailLab({
    store: { get: () => undefined, set: () => { throw new Error('the story path writes no settings'); } },
    userDataPath: path.join(root, 'userData'),
    ffmpeg: FFMPEG,
    ffprobe: FFPROBE,
    canvas: () => { throw new Error('no canvas here'); },
    scorer: () => { throw new Error('no scorer here'); },
    aiManager: () => { throw new Error('no model here'); },
    publishStore,
    manifest: async (zipPath) => { manifests.push(zipPath); return syntheticManifest(w.master); },
    progress: () => {},
  });
  const item = {
    jobId: 'job-1', itemId: 'itm-1', title: 'f2 - the rapture', createdAt: '', sourcePath: w.source, titles: ['A title'], promptSet: null,
    hasTranscript: true, reportFolder: null, hook: '', description: '', runStoryRef, problem: null,
  };
  lab.listItems = () => [item];
  return { lab, records, updates, manifests };
}

check('story link: an unlinked report gets the picker (never a name match); the pick is saved as its link; frames come only from the story\'s stretches of the screen recording', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-story-'));
  try {
    const w = syntheticWeek(root);
    const { lab, records, updates, manifests } = labOver(root, w);
    const state = lab.storyState('job-1', 'itm-1');
    assert.strictEqual(state.link, null, 'the report "f2 - the rapture" is NOT linked to the story "f1 - the rapture" by its name');
    assert.deepStrictEqual(state.choices.map((c) => [c.session, c.number, c.title, c.why === null]), [
      ['2026-01-05', 1, 'u1 - prophecy', true], ['2026-01-05', 2, 'f1 - the rapture', true], ['2026-01-05', 3, 'f3 - never exported', false],
    ]);
    assert.ok(/never been exported/.test(state.choices[2].why), state.choices[2].why);
    assert.ok(state.searched.includes(path.join(w.week, 'files')), state.searched);
    assert.ok(/not linked to an editor story yet/.test((await rejection(lab.findFrames({ jobId: 'job-1', itemId: 'itm-1' }))).message));
    assert.ok(/cannot link "f3 - never exported"/.test((await rejection(lab.linkStory('job-1', 'itm-1', w.project, 3, 'f3-never-exported'))).message));
    assert.strictEqual(updates.length, 0, 'a refused link writes nothing');

    const linked = await lab.linkStory('job-1', 'itm-1', w.project, 2, 'f1-the-rapture');
    assert.strictEqual(updates.length, 1);
    assert.strictEqual(updates[0].seed.jobId, 'job-1');
    assert.deepStrictEqual([updates[0].patch.transcriptRef.kind, updates[0].patch.transcriptRef.via, updates[0].patch.transcriptRef.storyNumber, updates[0].patch.transcriptRef.projectFolder],
      ['acs-story', 'manual', 2, w.project], 'the link is the transcript-link module\'s own ref, on the selection record');
    assert.deepStrictEqual([linked.link.storyTitle, linked.link.from], ['f1 - the rapture', 'saved']);

    const run = await lab.findFrames({ jobId: 'job-1', itemId: 'itm-1' });
    assert.deepStrictEqual(manifests, [path.join(w.project, '2026-01-05_compounds.zip')], 'the manifest is the session zip\'s');
    assert.ok(run.video.endsWith('2026-01-05 screen capture.mp4'), run.video);
    // Master stretches 5-10, 15-25, 30-35, 40-55, 90-100 at offset +2 s: 3-8, 13-23, 28-33, 38-53, and 88-98 lies past the 60 s recording.
    const spans = [[3, 8], [13, 23], [28, 33], [38, 53]];
    const sampledLine = run.lines.find((l) => l.startsWith('Sampled '));
    assert.ok(/^Sampled (3[3-7]) frames across those stretches \(00:35 of the screen recording/.test(sampledLine), sampledLine);
    assert.ok(run.frames.length >= 3, `${run.frames.length} frames kept after the repeat filter`);
    assert.ok(run.frames.every((f) => spans.some(([a, b]) => f.t >= a - 1e-6 && f.t < b)), `frames outside the story: ${run.frames.map((f) => f.t).join(', ')}`);
    assert.ok(run.scenes.length >= 1 && run.frames.every((f) => run.scenes.some((s) => s.number === f.scene)), 'every kept frame is in a scene');
    assert.strictEqual(run.scenes.reduce((sum, s) => sum + s.kept, 0), run.frames.length);
    assert.ok(run.scenes.every((s) => /^Scene \d+ · \d+:\d{2} on screen$/.test(s.label)), run.scenes.map((s) => s.label).join(' | '));
    assert.ok(run.lines.some((l) => /^The kept frames look like \d+ different scenes?/.test(l)), run.lines.join(' | '));
    assert.strictEqual(run.bestScenes, null, 'nothing is ranked before scoring');
    assert.ok(run.lines[0].startsWith('Story "f1 - the rapture" (story 2 of session 2026-01-05)') && run.lines[0].includes('5 stretches'), run.lines[0]);
    assert.ok(run.lines.some((l) => /records no drift factor/.test(l)), 'the rate with no drift factor is declared');
    assert.ok(run.lines.some((l) => /^10\.0 s of the story fall outside the screen recording/.test(l)), run.lines.join(' | '));
    assert.ok(records.get('itm-1').transcriptRef.storySlug === 'f1-the-rapture');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('story link: the run\'s story seeds the link until a record exists; a record\'s cleared link stays cleared', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-seed-'));
  try {
    const w = syntheticWeek(root, { screenSeconds: 3 });
    const ref = { kind: 'acs-story', path: path.join(w.project, '2026-01-05_stories_transcripts', '02-f1-the-rapture.json'), sourceSession: '2026-01-05', projectFolder: w.project, storyNumber: 2, storySlug: 'f1-the-rapture', storyTitle: 'f1 - the rapture', durationSeconds: 40, wordCount: 1, linkedAt: '', via: 'exact-title' };
    const { lab, records } = labOver(root, w, { runStoryRef: ref });
    assert.deepStrictEqual([lab.storyState('job-1', 'itm-1').link.storyTitle, lab.storyState('job-1', 'itm-1').link.from], ['f1 - the rapture', 'run']);
    records.set('itm-1', { itemId: 'itm-1', jobId: 'job-1', transcriptRef: null });
    assert.strictEqual(lab.storyState('job-1', 'itm-1').link, null, 'the operator\'s record wins over the run\'s seed');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('story link: an untrusted alignment, a missing or split screen recording, and a renamed story are each refused by name', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-refuse-'));
  try {
    const w = syntheticWeek(root, { screenSeconds: 3 });
    const { lab } = labOver(root, w);
    await lab.linkStory('job-1', 'itm-1', w.project, 2, 'f1-the-rapture');
    const find = async () => (await rejection(lab.findFrames({ jobId: 'job-1', itemId: 'itm-1' }))).message;
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

run('thumbnails tab: frame filters, sampling, the story source and link, ranking, words, face-safe layout, scoring, tone and photos, combine');
