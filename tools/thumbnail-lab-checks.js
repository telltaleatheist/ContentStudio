/**
 * Keeper: the Thumbnails tab (2026-09-28), the Node half of `npm run check:thumbnail-lab`.
 *
 * What it pins, against the COMPILED main process and the fake Crucible (no live server, no card):
 *
 *   - FRAME FILTERING: the difference hash finds a held frame and keeps the sharper copy; a
 *     motion-blurred frame falls under the run's median rule; thinning spreads across the range.
 *   - SAMPLING: a real ffmpeg pass over a synthetic 16:9 test video gives one frame a second, both
 *     JPEG sizes on disk, and a non-16:9 video is refused naming its size.
 *   - RANKING: the desktop answer is the one filter, everything else ranks; the ~20 best come from
 *     every section of the range; a frame with a missing option letter is unreadable, not guessed.
 *   - TEXT: the words prompt fills every slot from thumbnails.yml; the plain-text answer parses into
 *     the three kinds with decoration stripped and off-brief options warned about, never dropped.
 *   - FACE-SAFE BOX: the text never touches a padded face or a reserved slot, sits bottom-left
 *     when it can, fits by shrinking, and a phrase that cannot keep the letter floor is REFUSED
 *     (never shrunk below it, never truncated).
 *   - SCORING over the real transport and lanes: one image per decide call, the five questions,
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
});

// ── sampling (real ffmpeg, synthetic video) ─────────────────────────────────

check('sampling: one frame a second across the range, both JPEG sizes written, times in the source video', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-lab-sample-'));
  try {
    const video = path.join(dir, 'test.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=1280x720:rate=25:duration=20', '-pix_fmt', 'yuv420p', video]);
    const out = await sampler.sampleFrames({ ffmpeg: FFMPEG, ffprobe: FFPROBE, video, start: 5, end: 15, outDir: path.join(dir, 'frames') });
    assert.strictEqual(out.every, 1);
    assert.ok(out.frames.length >= 9 && out.frames.length <= 11, `${out.frames.length} frames for 10 s`);
    assert.strictEqual(out.frames[0].t, 5);
    assert.ok(out.frames.every((f) => fs.existsSync(f.large) && fs.existsSync(f.small) && f.sharpness > 0));
    const odd = path.join(dir, 'square.mp4');
    execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', 'testsrc=size=640x640:rate=25:duration=3', '-pix_fmt', 'yuv420p', odd]);
    const err = await rejection(sampler.sampleFrames({ ffmpeg: FFMPEG, ffprobe: FFPROBE, video: odd, start: null, end: null, outDir: path.join(dir, 'odd') }));
    assert.ok(/640x640, not 16:9/.test(err.message), err.message);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

check('sampling: times read as 07:31 / 1:07:31, a long range is thinned to the cap, a bad range is refused', () => {
  assert.strictEqual(sampler.parseClock('07:31', 'start'), 451);
  assert.strictEqual(sampler.parseClock('1:07:31', 'end'), 4051);
  assert.strictEqual(sampler.parseClock('', 'start'), null);
  assert.throws(() => sampler.parseClock('7m31', 'start'), /not a time/);
  assert.deepStrictEqual(sampler.samplingFor(451, 1800), { count: 1349, every: 1 });
  const long = sampler.samplingFor(0, 7200);
  assert.strictEqual(long.count, sampler.MAX_SAMPLES);
  assert.strictEqual(long.every, 4);
  assert.throws(() => sampler.resolveRange(0, 4000, 1800), /after the video ends/);
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
  const r = ranking.rankFrames(frames, 0, 60);
  assert.deepStrictEqual(r.screens.map((f) => f.id), ['desk']);
  assert.deepStrictEqual(r.ranked.map((f) => f.id), ['wild', 'shut', 'blank', 'noface']);
  assert.ok(r.ranked.every((f) => f.score >= 0 && f.score <= 1));
});

check('ranking: the ~20 best come from every section, never two picks within 4 s', () => {
  const frames = [];
  for (let i = 0; i < 400; i++) {
    // The first eighth of the range scores highest; a naive top-20 would all come from there.
    const early = i < 50;
    frames.push({ id: `f${i}`, t: i, reading: reading({ expression: early ? 5 : 2 + (i % 3), pStrong: early ? 0.99 : 0.3 + (i % 7) / 10 }) });
  }
  const { ranked } = ranking.rankFrames(frames, 0, 400);
  const best = ranking.pickDiverse(ranked, 20);
  assert.strictEqual(best.length, 20);
  const sections = new Set(best.map((f) => f.section));
  assert.strictEqual(sections.size, ranking.DIVERSITY_SECTIONS, `sections used: ${[...sections]}`);
  const times = best.map((f) => f.t).sort((a, b) => a - b);
  for (let i = 1; i < times.length; i++) assert.ok(times[i] - times[i - 1] >= ranking.MIN_PICK_GAP_SECONDS, `${times[i - 1]} and ${times[i]} are too close`);
  for (let i = 1; i < best.length; i++) assert.ok(best[i - 1].score >= best[i].score, 'best first');
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

check('frames: the five questions come from thumbnails.yml; one frame per request body, missing: report', () => {
  const q = prompts.frameQuestions();
  assert.deepStrictEqual(Object.keys(q), [...ranking.FRAME_QUESTIONS]);
  assert.deepStrictEqual(Object.keys(q.screen.options), ['video', 'screen']);
  assert.strictEqual(q.expression.levels.length, 5);
  const body = prompts.frameDecideBody('QUJD');
  assert.deepStrictEqual(body.images, ['QUJD']);
  assert.strictEqual(body.missing, 'report');
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

// ── scoring over the door ───────────────────────────────────────────────────

const VISION = [
  { id: 'qwen3.5-9b-vl', paramsB: 9, installed: true, contextDefault: 16384, modalities: ['text', 'image'], weightsOf: 'qwen3.5-9b' },
  { id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384, modalities: ['text'] },
  { id: 'qwen3.5-2b', paramsB: 2, installed: false, contextDefault: 16384, modalities: ['text', 'image'] },
];

function decideProbs(q) {
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

check('scoring: one image per decide call, the five questions, missing: report, at the engine\'s stated width', () => withFake({ chatMaxInFlight: 3 }, async (server, deps, frames) => {
  const out = await scorer.scoreFrames({ deps, jobId: 'keeper-score', model: 'qwen3.5-9b-vl', frames });
  assert.strictEqual(out.scored.length, 5);
  assert.strictEqual(out.width, 3);
  assert.ok(/admits 3 at once/.test(out.widthBasis), out.widthBasis);
  const bodies = server.decideBodies();
  assert.strictEqual(bodies.length, 5);
  assert.ok(bodies.every((b) => b.model === 'qwen3.5-9b-vl' && b.images.length === 1 && b.missing === 'report'));
  assert.deepStrictEqual(Object.keys(bodies[0].questions), [...ranking.FRAME_QUESTIONS]);
  assert.deepStrictEqual(bodies.map((b) => Buffer.from(b.images[0], 'base64').toString()).sort(), frames.map((_, i) => `fake jpeg ${i}`));
  const r = out.scored[0].reading;
  assert.ok(r.pScreen < 0.2 && r.pFace > 0.7 && r.expression > 3 && r.expression < 5, JSON.stringify(r));
  const loads = server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b.type === 'load-model');
  assert.deepStrictEqual(loads.map((b) => [b.model, b.params.context]), [['qwen3.5-9b-vl', scorer.FRAME_LOAD_CONTEXT]]);
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

run('thumbnails tab: frame filters, sampling, ranking, words, face-safe layout, scoring over the door');
