/**
 * Keeper: the thumbnails stages of the METADATA RUN (phase 1, 2026-09-28; docs/thumbnails-pipeline.md),
 * part of `npm run check:thumbnail-lab`.
 *
 * What it pins, against the COMPILED main process, real ffmpeg on a synthetic session and the fake
 * Crucible (no live server, no card, nothing of Owen's read or written):
 *
 *   - THE STORY LINK: the item's transcript matched against the week's exported story transcripts
 *     finds a clear winner; two stories matching about equally, or too few stretches found, is "no
 *     story" with the counts said; a file name that finds one story links by name (and says whether
 *     the transcript agrees); a name and a transcript that disagree link nothing and name both; a
 *     link the operator made by hand is used as it is and never replaced.
 *   - STAGE ORDER, ONE SWAP, 27B REUSE: inside one lane job on one JobLeases (as the metadata job
 *     runs), the frame scoring loads the vision model, the fields' 27B replaces it (the one swap),
 *     and the words and the tone/photo run on that same 27B with no second load and nothing given
 *     back between them.
 *   - WORDS PER TITLE: one words call per pair, each carrying its own title, the pairs in the gate's
 *     ranking when it ranked the titles and as written otherwise; the pairs' default kinds are
 *     claim, stakes, reaction; the three defaults take frames of different scenes.
 *   - NO STORY: the stages stop with the reason on the record; no model is called and nothing is
 *     written.
 *   - FAILURE SURFACED: a vision model the server does not have fails the scoring stage with the
 *     server's refusal in plain words, on the record and as the run's warning; the later stages do
 *     not run; a stop (cancel) is rethrown, never recorded as a failure.
 *   - OFF: absent setup, the per-run switch, a channel that makes none and a channel file that does
 *     not say each give an "off" record with its reason; the shipped channels say true/false and none
 *     still declares THUMBNAIL TEXT OPTIONS.
 *   - STORAGE ROUND-TRIP: the record is saved on the item in its job file, read back checked, and
 *     the picks written through the one door; bad picks and another record version are refused and
 *     leave the file as it was.
 *
 * Phase 2 (the reports page's Thumbnails window, report-thumbnails.ts, 2026-09-28):
 *
 *   - ORDERED PICKS AND PAIRING: picks are saved in click order (pick n goes with chosen title n by
 *     position); the copies `picks/Pick 1..n` are written and the file to publish is pick 1's copy;
 *     a fourth pick, one pair twice and a stale record shape are refused; with none, the copies go.
 *   - SWAPS REDRAWN AT ONCE: a changed frame, words (or "No text"), photo ("No photo", a new draw
 *     from the top 3) or logo draws a NEW file beside the old one (the old stays); a picked pair's
 *     pick follows it; a pre-phase-2 record gets `rankedFor` before its words change.
 *   - OWN IMAGE AS A PICK: Owen's file, checked against YouTube's thumbnail rules and read in place.
 *   - REWRITE WORDS FOR A TITLE: one words call carrying the new title and the tone/photo decides on
 *     ONE held load of the 27B; the pair and its pick follow; a second action on the item while one
 *     runs is refused; the hold is given back on request.
 *   - NO STORY -> SCREENSHOTS: N screenshots make N pairs, one per title given, a non-16:9 one cut to
 *     16:9 (said); own picks kept; a report whose pairs came from its story refuses them.
 *   - DELETE: deleting an item removes its thumbnails folder (and the empty thumbnails/ folder); a
 *     record naming a folder elsewhere is left and said; a whole job's cleanup removes each item's.
 *   - THE TAB IS GONE: no route, sidebar entry, component, lab service, combine or `thumbs:` channel;
 *     every `thumbnails:` channel the preload offers has a handler and the reverse; the reports page
 *     shows no THUMBNAIL TEXT OPTIONS section; the window sets pick 1 through the publish door.
 *
 *   npm run build:electron && node tools/thumbnail-pipeline-checks.js
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const { execFileSync } = require('child_process');
const { assert, fake, context, rejection, check, run, crucible, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
const assets = services('metadata/prompt-assets.js');
assets.initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));
const match = services('thumbnails/story-match.js');
const pipeline = services('thumbnails/pipeline.js');
const record = services('thumbnails/pipeline-record.js');
const library = services('thumbnails/photo-library.js');
const routing = services('metadata/metadata-routing.js');
const link = services('metadata/editor-transcript-link.js');
const { OutputHandlerService } = services('metadata/output-handler.service.js');
const { installCrucibleTransport } = crucible('transport');
const { installLanes } = crucible('lanes');

const FFMPEG = path.join(REPO, 'node_modules', '@ffmpeg-installer', `${process.platform}-${process.arch}`, 'ffmpeg');
const FFPROBE = path.join(REPO, 'node_modules', '@ffprobe-installer', `${process.platform}-${process.arch}`, 'ffprobe');

// ── a synthetic week: stories with real words ───────────────────────────────

/** Deterministic words: `count` picks from a vocabulary of made-up words, seeded. */
function words(seed, count) {
  let s = seed;
  const out = [];
  for (let i = 0; i < count; i++) {
    s = (s * 1103515245 + 12345) & 0x7fffffff;
    out.push(`w${seed}x${s % 400}`);
  }
  return out;
}

/** The item's captions: a story's words in ten-word captions, with a promo read of its own in the middle. */
function captions(storyWords) {
  const segs = [];
  const all = [...storyWords.slice(0, 200), ...'please support the channel on patreon today thank you'.split(' '), ...storyWords.slice(200)];
  for (let i = 0; i < all.length; i += 10) {
    const t = i / 2;
    const clock = (x) => `00:${String(Math.floor(x / 60)).padStart(2, '0')}:${String(Math.floor(x % 60)).padStart(2, '0')},000`;
    segs.push({ index: segs.length + 1, start: clock(t), end: clock(t + 5), text: all.slice(i, i + 10).join(' ') });
  }
  return segs;
}

const STORY_TEXT = { 1: words(11, 420), 2: words(22, 420), 3: words(33, 420) };

/** The manifest the editor would build: the timeline as four pieces of one master. */
function syntheticManifest(masterFile) {
  const video = [[0, 0, 10], [10, 15, 20], [30, 40, 30], [60, 80, 40]].map(([timelineStart, sourceStart, duration]) => ({ trackId: 'video', timelineStart, sourceStart, duration, file: masterFile }));
  return { frameSeconds: 0.1, timelineDuration: 100, segments: [...video, { trackId: 'audio-0', timelineStart: 0, sourceStart: 3, duration: 100, file: '/sessions/mic.wav' }] };
}

/**
 * One editor session: story 1 "u1 - prophecy", story 2 "f1 - the rapture", story 3 "f3 - a twin"
 * (by default its own words; `twin` gives it story 2's words), story 4 never exported.
 */
function syntheticWeek(root, { twin = false, screen = true } = {}) {
  const week = path.join(root, '2026-01-04');
  const project = path.join(week, 'files', '2026-01-05');
  fs.mkdirSync(path.join(project, '2026-01-05_stories_transcripts'), { recursive: true });
  fs.mkdirSync(path.join(week, 'complete'), { recursive: true });
  const stories = [
    { id: 's1', number: 1, title: 'u1 - prophecy', regions: [{ start: 0, end: 5 }] },
    { id: 's2', number: 2, title: 'f1 - the rapture', regions: [{ start: 5, end: 45 }, { start: 70, end: 80 }] },
    { id: 's3', number: 3, title: 'f3 - a twin', regions: [{ start: 45, end: 60 }] },
    { id: 's4', number: 4, title: 'f4 - never exported', regions: [{ start: 60, end: 70 }] },
  ];
  fs.writeFileSync(path.join(project, '2026-01-05_edits.json'), JSON.stringify({ schemaVersion: 1, session: '2026-01-05', cuts: [{ startFrame: 200, endFrame: 250 }], stories }));
  const texts = { 1: STORY_TEXT[1], 2: STORY_TEXT[2], 3: twin ? STORY_TEXT[2] : STORY_TEXT[3] };
  for (const [n, slug] of [[1, 'u1-prophecy'], [2, 'f1-the-rapture'], [3, 'f3-a-twin']]) {
    fs.writeFileSync(path.join(project, '2026-01-05_stories_transcripts', `0${n}-${slug}.json`), JSON.stringify({
      formatVersion: 1, sourceSession: '2026-01-05', story: { number: n, slug }, durationSeconds: 200,
      words: texts[n].map((text, i) => ({ text, start: i / 2, end: i / 2 + 0.4 })),
    }));
  }
  fs.writeFileSync(path.join(project, '2026-01-05_compounds.zip'), '');
  const master = path.join(project, '2026-01-05 master.mp4');
  fs.writeFileSync(path.join(project, '2026-01-05_alignment.json'), JSON.stringify({
    schemaVersion: 1, masterVideo: master,
    sources: [{ kind: 'video', type: 'screen', offsetSeconds: 2, driftFactor: null, method: 'picture-scene-change', confidence: 1, trusted: true }],
  }));
  if (screen) {
    // Three looks, twenty seconds each, so the story's stretches cross three scenes.
    execFileSync(FFMPEG, [
      '-v', 'error',
      '-f', 'lavfi', '-i', 'testsrc=size=320x180:rate=5:duration=20',
      '-f', 'lavfi', '-i', 'smptebars=size=320x180:rate=5:duration=20',
      '-f', 'lavfi', '-i', 'mandelbrot=size=320x180:rate=5:end_scale=0.01',
      '-filter_complex', '[2]trim=duration=20,setpts=PTS-STARTPTS[m];[0][1][m]concat=n=3:v=1:a=0,format=yuv420p',
      path.join(project, '2026-01-05 screen capture.mp4'),
    ]);
  }
  const exportOf = (name) => path.join(week, 'complete', `${name}.mov`);
  return { week, project, master, exportOf };
}

const textOf = (n) => captions(STORY_TEXT[n]).map((s) => s.text).join(' ');

// ── the story link ──────────────────────────────────────────────────────────

check('story link, transcript: an export whose name finds no story links to the story whose transcript it holds, the counts said', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-pipe-link-'));
  try {
    const w = syntheticWeek(root, { screen: false });
    const got = match.resolveThumbnailStory({ videoPath: w.exportOf('u9 - an unrelated name'), operatorRef: undefined, transcriptText: textOf(2) });
    assert.strictEqual(got.state, 'linked', JSON.stringify(got));
    assert.deepStrictEqual([got.method, got.ref.storyNumber, got.ref.storySlug, got.ref.via], ['transcript', 2, 'f1-the-rapture', 'transcript-match']);
    assert.ok(/^The file name matches no story\. Linked by the transcript to story 2 "f1 - the rapture"/.test(got.line), got.line);
    // Every stretch is found in its story but the one over the promo read (the ad-free story has none).
    assert.strictEqual(got.evidence.top[0].hits, got.evidence.probes - 1, JSON.stringify(got.evidence.top));
    assert.strictEqual(got.evidence.top[1].hits, 0, 'and none in the others');
    assert.deepStrictEqual(got.evidence.notSearched.map((n) => [n.number, n.why]), [[4, 'its transcript was never exported']]);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('story link, transcript: two stories that match about equally, or too little found, is "no story" with the reason; never a guess', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-pipe-amb-'));
  try {
    const w = syntheticWeek(root, { twin: true, screen: false });
    const twin = match.resolveThumbnailStory({ videoPath: w.exportOf('u9 - an unrelated name'), operatorRef: undefined, transcriptText: textOf(2) });
    assert.strictEqual(twin.state, 'none');
    assert.ok(/Two stories match the transcript about equally/.test(twin.reason) && /"f1 - the rapture"/.test(twin.reason) && /"f3 - a twin"/.test(twin.reason), twin.reason);
    const stranger = match.resolveThumbnailStory({ videoPath: w.exportOf('u9 - an unrelated name'), operatorRef: undefined, transcriptText: words(99, 400).join(' ') });
    assert.strictEqual(stranger.state, 'none');
    assert.ok(/No story matched the transcript clearly: 0 of \d+ stretches/.test(stranger.reason), stranger.reason);
    // A little of one story inside a long unrelated talk: under the bar, so no story.
    const sliver = match.matchByTranscript([...words(99, 600), ...STORY_TEXT[1].slice(0, 30)].join(' '), link.listWeekStories(w.week).candidates);
    assert.strictEqual(sliver.kind, 'none', JSON.stringify(sliver.evidence.top));
    const short = match.matchByTranscript('only a few words here', []);
    assert.ok(short.kind === 'none' && /shorter than 12 words/.test(short.reason));
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('story link, name: a file name that finds one story links by name (the transcript agreeing, said); a name and a transcript that disagree link nothing and name both', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-pipe-name-'));
  try {
    const w = syntheticWeek(root, { screen: false });
    const byLabel = match.resolveThumbnailStory({ videoPath: w.exportOf('f2 - the rapture'), operatorRef: undefined, transcriptText: textOf(2) });
    assert.deepStrictEqual([byLabel.state, byLabel.method, byLabel.ref.storyNumber, byLabel.ref.via], ['linked', 'name', 2, 'label-match']);
    assert.ok(/the same title without its slot/.test(byLabel.line) && /The transcript agrees/.test(byLabel.line), byLabel.line);
    const clash = match.resolveThumbnailStory({ videoPath: w.exportOf('u1 - prophecy'), operatorRef: undefined, transcriptText: textOf(2) });
    assert.strictEqual(clash.state, 'none');
    assert.ok(/file name points to story 1 "u1 - prophecy"/.test(clash.reason) && /transcript points to story 2 "f1 - the rapture"/.test(clash.reason), clash.reason);
    const unexported = match.resolveThumbnailStory({ videoPath: w.exportOf('f4 - never exported'), operatorRef: undefined, transcriptText: textOf(3) });
    assert.deepStrictEqual([unexported.state, unexported.method, unexported.ref.storyNumber], ['linked', 'transcript', 3]);
    assert.ok(/whose transcript was never exported/.test(unexported.line), unexported.line);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

check('story link, manual: a link the operator made on the Inputs page is used as it is, whatever the name and the transcript say', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-pipe-manual-'));
  try {
    const w = syntheticWeek(root, { screen: false });
    const story1 = link.listWeekStories(w.week).candidates.find((c) => c.storyNumber === 1);
    const ref = link.refFromCandidate(story1, 'exact-title');
    const got = match.resolveThumbnailStory({ videoPath: w.exportOf('f2 - the rapture'), operatorRef: ref, transcriptText: textOf(2) });
    assert.deepStrictEqual([got.state, got.method, got.evidence], ['linked', 'manual', null]);
    assert.strictEqual(got.ref, ref, 'the same ref object: nothing rebuilt or replaced');
    assert.ok(/^Linked by hand on the Inputs page to story 1 "u1 - prophecy"/.test(got.line), got.line);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── the stages over the fake Crucible ───────────────────────────────────────

const MODELS = [
  { id: 'qwen3.5-9b-vl', paramsB: 9, installed: true, contextDefault: 16384, modalities: ['text', 'image'], weightsOf: 'qwen3.5-9b' },
  { id: 'qwen3.8-27b-8bit', paramsB: 27, installed: true, contextDefault: 32768, modalities: ['text'] },
];
const WORDS_REPLY = 'CLAIM\nTHE RAPTURE IS HERE\nDONT STAND UNDER A ROOF\nSTAKES\nMAYBE TOMORROW\nREACTION\nSHE MEANS IT\nOH NO';

function decideProbs(q, state) {
  if (q.labels.includes('video')) return { video: 0.9, screen: 0.1 };
  if (q.labels[0] === 'yes') return { yes: 0.8, no: 0.2 };
  if (q.labels[0] === '1') return Object.fromEntries(q.labels.map((l, i) => [l, i === 3 ? 0.7 : 0.075]));
  if (q.labels.includes('mocking')) return Object.fromEntries(q.labels.map((l) => [l, l === 'absurd' ? 0.55 : 0.05]));
  // The photo question: horrified for the claim, oh please for the stakes, laugh otherwise.
  const top = /THE RAPTURE IS HERE/.test(state) ? 'horrified' : /MAYBE TOMORROW/.test(state) ? 'oh please' : 'laugh';
  return Object.fromEntries(q.labels.map((l) => [l, l === top ? 0.6 : 0.1]));
}

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a keeper photo')]);

/**
 * The world one item's thumbnails run in: the synthetic week, the photos in a scratch library, the
 * fake Crucible behind the real transport and lanes, a stand-in renderer, and a `job(fn)` that runs
 * `fn(leases)` inside one lane job holding one JobLeases, as the metadata job does.
 */
async function withWorld(options, fn) {
  const server = await fake.startFakeCrucible({ version: '1.0.55', models: MODELS, decideProbs, chatReplies: { 'qwen3.8-27b-8bit': () => ({ content: WORDS_REPLY, finishReason: 'stop' }) }, ...(options.fake ?? {}) });
  const made = context({ leaseTimings: { heartbeatMs: 40, releaseGraceMs: 20, requestTimeoutMs: 500 } });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-pipe-world-'));
  const w = syntheticWeek(root, options.week ?? {});
  const userData = path.join(root, 'userData');
  const photos = path.join(root, 'selfies');
  fs.mkdirSync(photos);
  for (const name of ['laugh', 'horrified', 'oh please', 'ooh']) fs.writeFileSync(path.join(photos, `selfie ${name}.png`), PNG_BYTES);
  library.addPhotos(userData, [photos], false);
  const renders = [];
  const plainCalls = [];
  const doors = { lanes: made.ctx.lanes, transport: made.ctx.transport, clientFor: (s) => made.ctx.factory.clientFor(s) };
  const setup = {
    userDataPath: userData, ffmpeg: FFMPEG, ffprobe: FFPROBE,
    manifest: async () => syntheticManifest(w.master),
    openRenderer: () => ({
      render: async (input) => {
        renders.push(input);
        const file = `${input.outStem}.png`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Each drawing's bytes name it, so a copy can be told from another drawing.
        const bytes = Buffer.concat([PNG_BYTES, Buffer.from(path.basename(input.outStem))]);
        fs.writeFileSync(file, bytes);
        return { ok: true, path: file, bytes: bytes.length, format: 'png', faces: [], plan: null, reaction: null, logo: null, notes: [] };
      },
      close: () => renders.push('closed'),
    }),
    style: services('thumbnails/layout.js').DEFAULT_STYLE, styleSaved: false, photoNotes: {}, newSeed: () => 7, doors,
  };
  /** AIManagerService.runPlainRequest as it reaches the door: its own GPU step, the job passed through. */
  const aiManager = {
    runPlainRequest: async (prompt, model, what, shape) => {
      plainCalls.push({ prompt, model, what, job: shape.job });
      const answer = await doors.lanes.aiCall({ lane: 'gpu', model }, what, () =>
        doors.transport.chat({ model, prompt, act: 'generate', thinking: false, maxTokens: shape.maxTokens, loadContext: shape.loadContext, job: shape.job, what, trace: null }));
      return answer.text;
    },
  };
  const job = async (body) => {
    const controller = new AbortController();
    const outcome = await made.ctx.lanes.runJob({ jobId: 'keeper-metadata-job', fast: false, stage: 'transcribe', controller }, async () => {
      const leases = made.ctx.transport.job('the keeper\'s metadata job');
      try {
        return await body(leases, controller);
      } finally {
        await leases.releaseAll();
      }
    });
    assert.strictEqual(outcome.kind, 'done', JSON.stringify(outcome));
    return outcome.value;
  };
  const itemRun = (leases, controller, over = {}) => pipeline.ItemThumbnailRun.start({ mode: 'on', setup }, {
    jobId: 'keeper-job', itemIndex: 0, sourceLabel: 'f2 - the rapture.mov', contentType: 'video',
    videoPath: w.exportOf(over.name ?? 'f2 - the rapture'), operatorRef: undefined, segments: captions(STORY_TEXT[over.story ?? 2]),
    reportFolder: over.reportFolder ?? path.join(root, 'report'), channel: assets.promptAssets().channel('youtube-fireside'),
  }, {
    leases, aiManager, routing: routing.resolveMetadataRouting(over.routing ?? {}), signal: controller.signal,
    cancelled: () => controller.signal.aborted, progress: () => undefined,
  });
  try {
    await fn({ server, w, root, renders, plainCalls, aiManager, job, itemRun, setup, userData, transport: made.ctx.transport });
  } finally {
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const FIELDS = { titles: ['Title one', 'Title two', 'Title three', 'Title four'], description_hook: 'She says the rapture is here.', description: 'A rapture claim.\n\nLinks' };

check('stages: story, frames and scoring before the chapters; words, tone/photos and render after the fields; ONE swap (vision to 27B) and the 27B not loaded again', () => withWorld({}, async ({ server, renders, plainCalls, aiManager, job, itemRun, root }) => {
  const rec = await job(async (leases, controller) => {
    const run = itemRun(leases, controller);
    await run.beforeChapters();
    assert.strictEqual(run.record().state, 'made', run.record().line);
    assert.deepStrictEqual(run.record().timings.map((t) => t.stage), ['story', 'frames', 'scoring']);
    // The chapters and the fields, as the metadata job runs them: on the 27B, under the same leases.
    await aiManager.runPlainRequest('the titles prompt', 'qwen3.8-27b-8bit', 'titles', { thinking: false, maxTokens: 2048, loadContext: 8192, job: leases });
    const loadsBefore = server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b.type === 'load-model').length;
    await run.afterFields(FIELDS);
    const loadsAfter = server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b.type === 'load-model').length;
    assert.strictEqual(loadsAfter, loadsBefore, 'the words and the tone/photo loaded nothing: the fields\' 27B stayed');
    return run.record();
  });
  assert.strictEqual(rec.state, 'made', rec.line);
  assert.deepStrictEqual(rec.timings.map((t) => t.stage), ['story', 'frames', 'scoring', 'words', 'tone-photos', 'render']);
  const loads = server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b.type === 'load-model');
  assert.deepStrictEqual(loads.map((b) => b.model), ['qwen3.5-9b-vl', 'qwen3.8-27b-8bit'], 'the vision model once, then the 27B once');
  assert.strictEqual(server.leases.taken.length, 2, 'one lease per model');
  assert.strictEqual(server.leases.released[0], server.leases.taken[0].leaseId, 'the vision lease went back before the 27B was leased');
  // Every call ran under the job's leases.
  assert.ok(plainCalls.every((c) => c.job !== undefined), 'every text call carried the job');
  assert.strictEqual(server.decideBodies().filter((b) => Array.isArray(b.images)).length, rec.frames.length, 'one decide per scored frame');
  assert.ok(rec.folder.startsWith(path.join(root, 'report', 'thumbnails', 'keeper-job-1')), rec.folder);
  assert.ok(rec.frames.every((f) => fs.existsSync(f.large) && fs.existsSync(f.small)), 'the candidates stay on disk');
  assert.deepStrictEqual(fs.readdirSync(path.join(rec.folder, 'frames')).length, rec.frames.length * 2, 'only the scored frames are kept');
  assert.strictEqual(renders[renders.length - 1], 'closed', 'the renderer is closed after the stage');
}));

check('stages: words per title (one call each, the title in it), the gate\'s ranking first when it ranked them; kinds claim, stakes, reaction; frames from different scenes; photos drawn with a stored seed', () => withWorld({}, async ({ plainCalls, job, itemRun, renders }) => {
  const ranked = { ...FIELDS, reroll_gate: { ranking: { order: [{ title: 'Title three' }, { title: 'Title one' }, { title: 'Title four' }, { title: 'Title two' }] } } };
  const rec = await job(async (leases, controller) => {
    const run = itemRun(leases, controller);
    await run.beforeChapters();
    await run.afterFields(ranked);
    return run.record();
  });
  assert.deepStrictEqual(rec.titles, { order: 'gate ranking', subjects: ['Title three', 'Title one', 'Title four'] });
  const wordCalls = plainCalls.filter((c) => /^thumbnail words for/.test(c.what));
  assert.strictEqual(wordCalls.length, 3, 'one words call per pair');
  wordCalls.forEach((c, i) => assert.ok(c.prompt.includes(`\n${rec.titles.subjects[i]}\n`), `call ${i + 1} carries its own title`));
  assert.ok(!wordCalls[0].prompt.includes('Title one\n') || wordCalls[0].prompt.indexOf('Title three') > 0);
  assert.deepStrictEqual(rec.pairs.map((p) => [p.pair, p.title, p.default.kind, p.default.phrase]), [
    [1, 'Title three', 'claim', 'THE RAPTURE IS HERE'], [2, 'Title one', 'stakes', 'MAYBE TOMORROW'], [3, 'Title four', 'reaction', 'SHE MEANS IT'],
  ]);
  assert.deepStrictEqual(rec.pairs[0].words.claim, ['THE RAPTURE IS HERE', 'DONT STAND UNDER A ROOF'], 'every option is kept for phase 2');
  const scenes = rec.pairs.map((p) => p.default.scene);
  const rows = rec.bestScenes.length;
  assert.ok(rows >= 3, `the fixture shows ${rows} scene rows`);
  assert.strictEqual(new Set(scenes).size, 3, `three different scenes (${scenes})`);
  assert.ok(rec.pairs.every((p) => rec.frames.some((f) => f.id === p.default.frameId)), 'every default frame is a scored candidate');
  assert.strictEqual(rec.seed, 7);
  assert.deepStrictEqual(rec.pairs.map((p) => p.photos.length), [4, 4, 4], 'every photo ranked for every pair');
  assert.strictEqual(new Set(rec.pairs.map((p) => p.default.photo)).size, 3, 'no photo on two defaults while another of the top 3 remains');
  assert.ok(rec.pairs.every((p) => p.default.render.ok && fs.existsSync(p.default.render.file)), 'three renders written');
  assert.deepStrictEqual(renders.filter((r) => r !== 'closed').map((r) => path.basename(r.outStem)), ['Pair 1 - Title three', 'Pair 2 - Title one', 'Pair 3 - Title four']);
  assert.strictEqual(rec.tone.ranking[0].name, 'absurd');
  assert.strictEqual(rec.line, '3 title and thumbnail pairs are ready to pick from.');
  assert.deepStrictEqual(pipeline.pairSubjects({ titles: ['A', 'B', 'C', 'D'] }), { order: 'as written', subjects: ['A', 'B', 'C'] }, 'no ranking: the titles as written');
}));

check('stages: an item with no story stops with the reason on the record; no model is called and nothing is written', () => withWorld({}, async ({ server, plainCalls, job, itemRun, root }) => {
  const rec = await job(async (leases) => {
    // A name that finds no story, and a transcript no story of the week holds.
    const run = pipeline.ItemThumbnailRun.start({ mode: 'on', setup: {} }, {
      jobId: 'keeper-job', itemIndex: 1, sourceLabel: 'u9.mov', contentType: 'video', videoPath: path.join(root, '2026-01-04', 'complete', 'u9 - unrelated.mov'),
      operatorRef: undefined, segments: captions(words(77, 400)), reportFolder: path.join(root, 'report'), channel: assets.promptAssets().channel('youtube-fireside'),
    }, { leases, aiManager: { runPlainRequest: async () => { throw new Error('no model'); } }, routing: routing.resolveMetadataRouting({}), cancelled: () => false, progress: () => undefined });
    await run.beforeChapters();
    await run.afterFields(FIELDS);
    return run.record();
  });
  assert.strictEqual(rec.state, 'no-story');
  assert.ok(/^No thumbnails: The file name matches no story\. No story matched the transcript clearly/.test(rec.line), rec.line);
  assert.strictEqual(rec.story.state, 'none');
  assert.deepStrictEqual([rec.folder, rec.pairs.length, rec.failure], [null, 0, null]);
  assert.deepStrictEqual(rec.timings.map((t) => t.stage), ['story']);
  assert.strictEqual(plainCalls.length + server.decideBodies().length, 0);
  assert.ok(!fs.existsSync(path.join(root, 'report', 'thumbnails')), 'nothing written');
  const record_ = record.readItemThumbnails(rec, 'keeper');
  assert.strictEqual(record_.state, 'no-story');
}));

check('stages: a failed stage is on the record and in the warning, in plain words; the later stages do not run; a stop is rethrown, not recorded', () => withWorld({ fake: { imagesNotServed: 'mlx-vlm returns no logprobs' } }, async ({ plainCalls, job, itemRun }) => {
  const rec = await job(async (leases, controller) => {
    const run = itemRun(leases, controller);
    await run.beforeChapters();
    await run.afterFields(FIELDS);
    assert.ok(/^f2 - the rapture\.mov: The thumbnails stopped at the scoring stage: "mac" cannot show pictures to qwen3\.5-9b-vl yet/.test(run.warning()), run.warning());
    return run.record();
  });
  assert.deepStrictEqual([rec.state, rec.failure.stage], ['failed', 'scoring']);
  assert.ok(/mlx-vlm returns no logprobs/.test(rec.failure.reason), rec.failure.reason);
  assert.deepStrictEqual(rec.timings.map((t) => t.stage), ['story', 'frames', 'scoring']);
  assert.strictEqual(plainCalls.length, 0, 'no words were written after the failure');
  assert.strictEqual(record.readItemThumbnails(rec, 'keeper').failure.stage, 'scoring');
  // A stop: the same refusal while the run is being stopped goes up, unrecorded.
  const err = await rejection(job(async (leases, controller) => {
    const run = itemRun(leases, controller);
    controller.abort(new Error('Stopped by the user'));
    await run.beforeChapters();
  }));
  assert.ok(err, 'the stop reached the job');
}));

check('off: absent setup, the per-run switch, a channel that makes none and a channel file that does not say each give an "off" record with its reason', () => {
  const item = (channel) => ({
    jobId: 'j', itemIndex: 0, sourceLabel: 'x', contentType: 'video', videoPath: '/x.mov', operatorRef: undefined, segments: [], reportFolder: '/r', channel,
  });
  const doors = { leases: null, aiManager: null, routing: {}, cancelled: () => false, progress: () => undefined };
  const fireside = assets.promptAssets().channel('youtube-fireside');
  const lines = [
    pipeline.ItemThumbnailRun.start(undefined, item(fireside), doors),
    pipeline.ItemThumbnailRun.start({ mode: 'off', reason: 'Thumbnails were switched off for this run.' }, item(fireside), doors),
    pipeline.ItemThumbnailRun.start({ mode: 'on', setup: {} }, item(assets.promptAssets().channel('youtube-shorts')), doors),
    pipeline.ItemThumbnailRun.start({ mode: 'on', setup: {} }, item({ ...fireside, thumbnails: null }), doors),
  ].map((r) => [r.record().state, r.record().line]);
  assert.ok(lines.every(([state]) => state === 'off'), JSON.stringify(lines));
  assert.ok(/without the thumbnail setup/.test(lines[0][1]) && /switched off for this run/.test(lines[1][1]) && /makes no thumbnails/.test(lines[2][1]) && /"thumbnails" key is missing/.test(lines[3][1]), JSON.stringify(lines));
  const shipped = Object.fromEntries(assets.promptAssets().channelIds().map((id) => [id, assets.promptAssets().channel(id).thumbnails]));
  assert.deepStrictEqual(shipped, { 'podcast-spreaker': false, 'youtube-fireside': true, 'youtube-shorts': false, 'youtube-telltale': true, 'youtube-unfiltered': true });
  assert.ok(assets.promptAssets().channelIds().every((id) => !assets.promptAssets().channel(id).fields.includes('thumbnail_text')), 'THUMBNAIL TEXT OPTIONS is retired from every shipped channel');
});

check('pieces: default frames take different scenes first, then second frames; a kind with no options starts on the next kind, said', () => {
  const rows = [{ scene: 4, ids: ['a', 'a2'], more: [], best: 0.9 }, { scene: 1, ids: ['b'], more: [], best: 0.8 }];
  assert.deepStrictEqual(pipeline.defaultFrames(rows), [{ id: 'a', scene: 4, repeat: false }, { id: 'b', scene: 1, repeat: false }, { id: 'a2', scene: 4, repeat: true }]);
  const d = pipeline.defaultWords({ claim: [], stakes: ['S'], reaction: ['R'] }, 'claim');
  assert.deepStrictEqual([d.kind, d.phrase], ['stakes', 'S']);
  assert.ok(/no claim words/.test(d.line));
  assert.strictEqual(pipeline.defaultWords({ claim: [], stakes: [], reaction: [] }, 'claim'), null);
  assert.throws(() => pipeline.pairSubjects({ titles: [] }), /no titles/);
});

// ── storage ─────────────────────────────────────────────────────────────────

check('storage: the record rides on the item in its job file, reads back checked, and the picks go through the one door; bad picks and another version are refused, the file untouched', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-pipe-store-'));
  try {
    const out = OutputHandlerService.forOutputDir(root);
    const job = out.initializeJob('keeper job', 'youtube-fireside', 'keeper-store-job');
    const rec = {
      version: 1, state: 'made', line: '3 title and thumbnail pairs are ready to pick from.', failure: null,
      story: { state: 'linked', method: 'transcript', ref: { kind: 'acs-story', path: '/p.json', sourceSession: 's', projectFolder: '/p', storyNumber: 2, storySlug: 'x', storyTitle: 'x', durationSeconds: 1, wordCount: 1, linkedAt: '', via: 'transcript-match' }, line: 'l', evidence: null },
      folder: path.join(job.txtFolder, 'thumbnails', 'keeper-store-job-1'), source: { video: '/v.mp4', lines: [] }, scenes: [], frames: [], bestScenes: [], scoring: null,
      titles: { order: 'as written', subjects: ['T1', 'T2', 'T3'] }, tone: null,
      pairs: [1, 2, 3].map((n) => ({ pair: n, title: `T${n}`, words: { claim: [], stakes: [], reaction: [], warnings: [], model: 'm' }, photos: [], lines: [], default: { frameId: 'f1', scene: 1, kind: 'claim', phrase: 'P', photo: 'laugh', draw: { name: 'laugh', p: 0.5, chance: 1, pool: [], repeatForced: false }, logo: false, render: { ok: true, file: `/r/${n}.png`, format: 'png', bytes: 1, notes: [] } } })),
      seed: 7, look: null, logo: null, lines: [], timings: [], picks: [],
    };
    const saved = await out.addItemToJob(job.jobId, { titles: ['T1'], _title: 'keeper', thumbnails: rec }, { source_key: null, source_path: null },
      { content_fields: 'final-export-whisper', timed_fields: 'final-export-whisper', transcript_ref: null, final_duration_sec: null, transcript_duration_sec: null, drift_sec: null, drift_pct: null, declared_at: new Date().toISOString() });
    const back = out.getJobMetadata(job.jobId).items[0];
    assert.deepStrictEqual(record.readItemThumbnails(back.thumbnails, 'keeper'), rec, 'the record round-trips unchanged');
    const picked = await out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, picks: [{ kind: 'made', pair: 2, file: '/r/2.png', wordsFor: 'T2' }, { kind: 'own', file: '/mine.png' }] }));
    assert.deepStrictEqual(picked.picks.map((p) => p.file), ['/r/2.png', '/mine.png']);
    assert.deepStrictEqual(out.getJobMetadata(job.jobId).items[0].thumbnails.picks.map((p) => p.kind), ['made', 'own'], 'the ordered picks are on disk');
    const before = fs.readFileSync(job.jsonPath, 'utf8');
    const twice = await rejection(out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, picks: [{ kind: 'own', file: '/a' }, { kind: 'own', file: '/a' }] })));
    assert.ok(/picks one file twice/.test(twice.message), twice.message);
    const pairTwice = await rejection(out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, picks: [{ kind: 'made', pair: 1, file: '/a', wordsFor: 'T1' }, { kind: 'made', pair: 1, file: '/b', wordsFor: 'T1' }] })));
    assert.ok(/picks one pair twice/.test(pairTwice.message), pairTwice.message);
    const four = await rejection(out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, picks: [1, 2, 3, 4].map((n) => ({ kind: 'own', file: `/x${n}` })) })));
    assert.ok(/at most 3/.test(four.message), four.message);
    const old = await rejection(out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, picks: [{ title: 'T1', file: '/a' }] })));
    assert.ok(/neither a pair's render nor your own image/.test(old.message), old.message);
    assert.strictEqual(fs.readFileSync(job.jsonPath, 'utf8'), before, 'a refused write leaves the file byte for byte');
    assert.throws(() => record.readItemThumbnails({ ...rec, version: 2 }, 'keeper'), /is version 2, and this build reads version 1/);
    assert.strictEqual(record.readItemThumbnails(undefined, 'keeper'), null, 'an item from before the pipeline has none');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── phase 2: the Thumbnails window (report-thumbnails.ts) ───────────────────

const { ReportThumbnails } = services('thumbnails/report-thumbnails.js');
const { ThumbnailLook } = services('thumbnails/look.js');
const { saveTranscript } = services('metadata/saved-transcript.service.js');
const { deleteJobTxtFiles } = services('metadata/output-handler.service.js');
const PROVENANCE = { content_fields: 'final-export-whisper', timed_fields: 'final-export-whisper', transcript_ref: null, final_duration_sec: null, transcript_duration_sec: null, drift_sec: null, drift_pct: null, declared_at: '2026-09-28T00:00:00.000Z' };

/** A real 16:9 image of a given size (the own-image and screenshot checks read real pictures). */
function picture(file, size) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  execFileSync(FFMPEG, ['-v', 'error', '-f', 'lavfi', '-i', `testsrc=size=${size}:rate=1:duration=1`, '-frames:v', '1', '-y', file]);
  return file;
}

/**
 * The window over the world: a job in `root` (the output directory), the item's transcript saved,
 * its record from a real pipeline run (or `record`), and ReportThumbnails wired as the IPC wires it.
 */
async function windowOver(world, { record: given = null, noStory = false } = {}) {
  const { root, w, job: inJob, itemRun, setup, userData, transport, aiManager } = world;
  const out = OutputHandlerService.forOutputDir(root);
  const job = out.initializeJob('f2 - the rapture', 'youtube-fireside', `keeper-window-${noStory ? 'nostory' : 'story'}`);
  const video = w.exportOf(noStory ? 'u9 - unrelated' : 'f2 - the rapture');
  fs.writeFileSync(video, 'a video');
  const segments = captions(noStory ? words(77, 400) : STORY_TEXT[2]);
  saveTranscript({ outputDir: root, videoPath: video, segments, durationSec: 200, whisperModel: 'keeper', words: null, speakerTagging: null });
  const rec = given ?? await inJob(async (leases, controller) => {
    const run = itemRun(leases, controller, { reportFolder: job.txtFolder, ...(noStory ? { name: 'u9 - unrelated', story: 1 } : {}) });
    if (noStory) {
      const r = pipeline.ItemThumbnailRun.start({ mode: 'on', setup }, {
        jobId: job.jobId, itemIndex: 0, sourceLabel: 'u9.mov', contentType: 'video', videoPath: video, operatorRef: undefined,
        segments, reportFolder: job.txtFolder, channel: assets.promptAssets().channel('youtube-fireside'),
      }, { leases, aiManager, routing: routing.resolveMetadataRouting({}), cancelled: () => false, progress: () => undefined });
      await r.beforeChapters();
      return r.record();
    }
    await run.beforeChapters();
    await run.afterFields(FIELDS);
    return run.record();
  });
  const saved = await out.addItemToJob(job.jobId, {
    titles: FIELDS.titles, _title: 'f2 - the rapture', _prompt_set: 'youtube-fireside', description_hook: FIELDS.description_hook, description: FIELDS.description, thumbnails: rec,
  }, { source_key: 'f2 - the rapture', source_path: video }, PROVENANCE);
  const settings = { outputDirectory: root };
  const progress = [];
  const window = new ReportThumbnails({
    store: { get: (k) => settings[k] },
    userDataPath: userData,
    ffprobe: FFPROBE,
    look: new ThumbnailLook({ store: { get: (k) => settings[k], set: (k, v) => { settings[k] = v; } }, userDataPath: userData }),
    runChoice: () => ({ mode: 'on', setup }),
    holdJob: (what) => transport.job(what),
    aiManager: () => aiManager,
    picture: (file, width) => `picture of ${path.basename(file)} at ${width}`,
    photoList: () => library.libraryPhotos(userData).map((ph) => ({ name: ph.name, preview: `picture of ${ph.name}`, note: null })),
    newSeed: () => 11,
    progress: (e) => progress.push(e.line),
  });
  return { out, job, itemId: saved.itemId, window, rec, progress, video };
}

check('window, picks: saved in click order, pick n pairs with chosen title n by position; copies Pick 1..n; the file to publish is pick 1\'s copy; a fourth pick, one pair twice and an old pick shape are refused; none removes the copies', () => withWorld({}, async (world) => {
  const { job, itemId, window } = await windowOver(world);
  const v = await window.savePicks(job.jobId, itemId, [{ kind: 'made', pair: 2 }, { kind: 'made', pair: 1 }]);
  assert.deepStrictEqual(v.picks.map((p) => [p.n, p.pick.kind, p.pick.pair, p.pick.wordsFor]), [[1, 'made', 2, 'Title two'], [2, 'made', 1, 'Title one']], 'the order clicked, each with the title its words were written for');
  const folder = v.record.folder;
  assert.deepStrictEqual(v.picks.map((p) => p.copy), [path.join(folder, 'picks', 'Pick 1.png'), path.join(folder, 'picks', 'Pick 2.png')]);
  assert.strictEqual(v.publishFile, path.join(folder, 'picks', 'Pick 1.png'), 'pick 1 is what is published');
  assert.ok(fs.readFileSync(v.publishFile).equals(fs.readFileSync(v.record.pairs[1].default.render.file)), 'Pick 1 is thumbnail 2, the first clicked');
  assert.deepStrictEqual(window.summary(job.jobId, itemId).picks.map((p) => p.n), [1, 2], 'the reports page reads the same picks');
  assert.ok(/at most 3/.test((await rejection(window.savePicks(job.jobId, itemId, [1, 2, 3].map((pair) => ({ kind: 'made', pair })).concat([{ kind: 'made', pair: 1 }])))).message));
  assert.ok(/Thumbnail 1 is picked twice/.test((await rejection(window.savePicks(job.jobId, itemId, [{ kind: 'made', pair: 1 }, { kind: 'made', pair: 1 }]))).message));
  assert.ok(/neither a pair nor your own image/.test((await rejection(window.savePicks(job.jobId, itemId, [{ title: 'Title one', file: '/x.png' }]))).message));
  const none = await window.savePicks(job.jobId, itemId, []);
  assert.deepStrictEqual([none.picks.length, none.publishFile, fs.existsSync(path.join(folder, 'picks'))], [0, null, false], 'no picks: nothing to publish, no copies');
}));

check('window, swaps: frame, words ("No text"), photo ("No photo", a new draw from the top 3) and logo are drawn at once as a NEW file beside the old; a picked pair\'s pick follows it; rankedFor is kept before the words change', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec } = await windowOver(world);
  const first = rec.pairs[0].default.render.file;
  await window.savePicks(job.jobId, itemId, [{ kind: 'made', pair: 1 }]);
  const noText = await window.renderPair(job.jobId, itemId, { pair: 1, phrase: null });
  const p1 = noText.record.pairs[0];
  assert.deepStrictEqual([p1.default.phrase, p1.default.kind], [null, null]);
  assert.strictEqual(path.basename(p1.default.render.file), 'Pair 1 - Title one (2).png', 'a new file beside the old');
  assert.ok(fs.existsSync(first), 'the old file stays (a pick or the publish record may point at it)');
  assert.strictEqual(noText.picks[0].pick.file, p1.default.render.file, 'the pick follows its pair');
  assert.ok(fs.readFileSync(noText.publishFile).equals(fs.readFileSync(p1.default.render.file)), 'Pick 1 is the new drawing');
  assert.strictEqual(world.renders.filter((r) => r !== 'closed').pop().phrase, null, 'drawn with no words');
  assert.strictEqual(p1.rankedFor, rec.pairs[0].default.phrase, 'the ranking still says which words it was made for');
  const typed = await window.renderPair(job.jobId, itemId, { pair: 1, phrase: 'my own words', kind: null });
  assert.deepStrictEqual([typed.record.pairs[0].default.phrase, typed.record.pairs[0].default.kind], ['my own words', null]);
  const noPhoto = await window.renderPair(job.jobId, itemId, { pair: 2, photo: null, logo: false });
  assert.deepStrictEqual([noPhoto.record.pairs[1].default.photo, noPhoto.record.pairs[1].default.logo], [null, false]);
  assert.strictEqual(world.renders.filter((r) => r !== 'closed').pop().photo, null, 'drawn with no photo');
  const drawn = await window.renderPair(job.jobId, itemId, { pair: 3, photo: 'draw' });
  const d3 = drawn.record.pairs[2].default;
  assert.ok(d3.draw !== null && d3.draw.pool.length <= 3 && d3.draw.pool.some((r) => r.name === d3.photo), JSON.stringify(d3.draw));
  const other = rec.frames.find((f) => f.id !== rec.pairs[0].default.frameId);
  const moved = await window.renderPair(job.jobId, itemId, { pair: 1, frameId: other.id });
  assert.deepStrictEqual([moved.record.pairs[0].default.frameId, moved.record.pairs[0].default.scene], [other.id, other.scene]);
  assert.ok(/not among this report's candidate frames/.test((await rejection(window.renderPair(job.jobId, itemId, { pair: 1, frameId: 'f999999' }))).message));
  assert.ok(/no reaction photo "nobody"/.test((await rejection(window.renderPair(job.jobId, itemId, { pair: 1, photo: 'nobody' }))).message));
  // A record from before phase 2 (no rankedFor): the first words change records what the ranking was for.
  const oldRec = JSON.parse(JSON.stringify(rec));
  for (const p of oldRec.pairs) delete p.rankedFor;
  const again = await windowOver(world, { record: oldRec });
  const changed = await again.window.renderPair(again.job.jobId, again.itemId, { pair: 2, phrase: 'OTHER WORDS', kind: 'claim' });
  assert.strictEqual(changed.record.pairs[1].rankedFor, rec.pairs[1].default.phrase);
}));

check('window, own image: Owen\'s file is a pick (checked against YouTube\'s rules, read in place, never moved); a too-small image is refused by the thumbnail door', () => withWorld({}, async (world) => {
  const { job, itemId, window } = await windowOver(world);
  const { root } = world;
  const mine = picture(path.join(root, 'Desktop', 'my thumbnail.png'), '1280x720');
  const before = fs.readFileSync(mine);
  const v = await window.savePicks(job.jobId, itemId, [{ kind: 'own', file: mine }, { kind: 'made', pair: 3 }]);
  assert.deepStrictEqual(v.picks.map((p) => p.pick.kind), ['own', 'made']);
  assert.ok(fs.readFileSync(v.publishFile).equals(before), 'his image is pick 1, and it is what is published');
  assert.ok(fs.readFileSync(mine).equals(before) && fs.existsSync(mine), 'his file is only read');
  const small = picture(path.join(root, 'Desktop', 'tiny.png'), '320x180');
  const err = await rejection(window.savePicks(job.jobId, itemId, [{ kind: 'own', file: small }]));
  assert.ok(/320x180/.test(err.message), err.message);
  // The only pick, on a report with no story (no folder yet): the picks get one.
  const bare = await windowOver(world, { noStory: true });
  const only = await bare.window.savePicks(bare.job.jobId, bare.itemId, [{ kind: 'own', file: mine }]);
  assert.strictEqual(only.record.state, 'no-story');
  assert.ok(only.publishFile.startsWith(path.join(bare.job.txtFolder, 'thumbnails', `${bare.job.jobId}-${bare.itemId}`)), only.publishFile);
}));

check('window, rewrite words for a title: one words call carrying the title and the tone/photo decides on ONE held load of the 27B; the pair and its pick follow; a second action while one runs is refused; the hold is given back', () => withWorld({}, async (world) => {
  const { job, itemId, window } = await windowOver(world);
  const { server, plainCalls } = world;
  await window.savePicks(job.jobId, itemId, [{ kind: 'made', pair: 2 }]);
  const leasesBefore = server.leases.taken.length;
  const callsBefore = plainCalls.length;
  const decidesBefore = server.decideBodies().length;
  const running = window.pairTitle(job.jobId, itemId, 2, 'Title four');
  const busy = await rejection(window.renderPair(job.jobId, itemId, { pair: 1, phrase: null }));
  assert.ok(/^Still writing words for this report/.test(busy.message), busy.message);
  const v = await running;
  const words = plainCalls.slice(callsBefore);
  assert.strictEqual(words.length, 1, 'one words call');
  assert.ok(words[0].prompt.includes('\nTitle four\n'), 'carrying the new title');
  assert.ok(words[0].job !== undefined, 'under the window\'s held job');
  assert.strictEqual(server.decideBodies().length - decidesBefore, 2, 'the tone and one photo question');
  // The fake keeps a model in memory after its lease goes back, so a reload shows as a second lease.
  const leases = server.leases.taken.slice(leasesBefore);
  assert.deepStrictEqual(leases.map((l) => l.model), ['qwen3.8-27b-8bit'], 'one lease on the 27B for the words and the photos (no reload between them)');
  const p2 = v.record.pairs[1];
  assert.deepStrictEqual([p2.title, p2.default.kind, p2.default.phrase, p2.rankedFor], ['Title four', 'stakes', 'MAYBE TOMORROW', 'MAYBE TOMORROW']);
  assert.deepStrictEqual([v.picks[0].pick.pair, v.picks[0].pick.wordsFor, v.picks[0].pick.file], [2, 'Title four', p2.default.render.file], 'the pick follows, now written for its title');
  assert.strictEqual(window.heldModel(), 'qwen3.8-27b-8bit');
  const released = server.leases.released.length;
  assert.strictEqual(await window.releaseHold('the window closed'), 'qwen3.8-27b-8bit');
  assert.ok(server.leases.released.length > released, 'the lease went back to the server');
  assert.strictEqual(await window.releaseHold('again'), null);
}));

check('window, no story: 2 screenshots make 2 pairs for the 2 titles given, a non-16:9 one cut to 16:9 and said; own picks kept; a report whose pairs came from its story refuses screenshots', () => withWorld({}, async (world) => {
  const { job, itemId, window } = await windowOver(world, { noStory: true });
  const { root } = world;
  const { plainCalls } = world;
  const mine = picture(path.join(root, 'Desktop', 'mine.png'), '1280x720');
  await window.savePicks(job.jobId, itemId, [{ kind: 'own', file: mine }]);
  const wide = picture(path.join(root, 'Desktop', 'Screenshot wide.png'), '1440x900');
  const exact = picture(path.join(root, 'Desktop', 'Screenshot exact.png'), '1280x720');
  const callsBefore = plainCalls.length;
  const v = await window.useScreenshots(job.jobId, itemId, [wide, exact], ['Title two', 'Title one']);
  const r = v.record;
  assert.strictEqual(r.state, 'made', r.line);
  assert.deepStrictEqual(r.pairs.map((p) => [p.pair, p.title, p.default.frameId]), [[1, 'Title two', 'shot1'], [2, 'Title one', 'shot2']]);
  assert.strictEqual(r.source.video, null);
  assert.ok(r.source.lines.some((l) => /Screenshot wide\.png is 1440x900, not 16:9, so its middle was cut to 16:9/.test(l)), r.source.lines.join(' | '));
  assert.ok(r.source.lines.some((l) => /Screenshot exact\.png \(1280x720\) is used whole/.test(l)), r.source.lines.join(' | '));
  assert.deepStrictEqual(plainCalls.slice(callsBefore).filter((c) => /^thumbnail words/.test(c.what)).map((c) => c.prompt.includes('\nTitle two\n') ? 2 : c.prompt.includes('\nTitle one\n') ? 1 : 0), [2, 1], 'one words call per screenshot, each with its title');
  assert.strictEqual(r.story.state, 'none', 'the story (and why there is none) is kept');
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', path.join(r.folder, 'full', 'shot1.png')]).toString()).streams[0];
  assert.deepStrictEqual([probe.width, probe.height], [1920, 1080], 'written 16:9 at 1920x1080');
  assert.ok(r.pairs.every((p) => p.default.render.ok && fs.existsSync(p.default.render.file)));
  assert.deepStrictEqual(v.picks.map((p) => p.pick.kind), ['own'], 'his own pick stays');
  assert.strictEqual(r.line, '2 title and thumbnail pairs are ready to pick from.');
  assert.ok(/1 to 3 screenshots/.test((await rejection(window.useScreenshots(job.jobId, itemId, [wide, exact, wide, exact], ['a', 'b', 'c', 'd']))).message));
  assert.ok(/needs a title/.test((await rejection(window.useScreenshots(job.jobId, itemId, [wide], []))).message));
  await window.releaseHold('the check moves on');
  const story = await windowOver(world);
  assert.ok(/already has thumbnails from its story/.test((await rejection(story.window.useScreenshots(story.job.jobId, story.itemId, [wide], ['Title one']))).message));
}));

check('delete: deleting an item removes its thumbnails folder (and the empty thumbnails/ folder); a folder named elsewhere is left and said; a whole job\'s cleanup removes each item\'s folder', () => withWorld({}, async (world) => {
  const { out, job, itemId, rec } = await windowOver(world);
  const parent = path.join(job.txtFolder, 'thumbnails');
  assert.ok(fs.existsSync(rec.folder) && path.dirname(rec.folder) === parent, rec.folder);
  const receipt = await out.deleteItem(job.jobId, itemId, { removeSelection: async () => ({ removed: false }) });
  assert.strictEqual(receipt.thumbnailsFolderRemoved, rec.folder);
  assert.ok(!fs.existsSync(rec.folder) && !fs.existsSync(parent), 'the folder, and the emptied thumbnails/ folder, are gone');
  // A record naming a folder outside the report's thumbnails folder is never removed.
  const elsewhere = path.join(world.root, 'Movies', 'keep me');
  fs.mkdirSync(elsewhere, { recursive: true });
  const odd = await windowOver(world, { record: { ...rec, folder: elsewhere, picks: [] } });
  const r2 = await odd.out.deleteItem(odd.job.jobId, odd.itemId, { removeSelection: async () => ({ removed: false }) });
  assert.strictEqual(r2.thumbnailsFolderRemoved, null);
  assert.ok(/is not in this report's thumbnails folder/.test(r2.thumbnailsReason) && fs.existsSync(elsewhere), r2.thumbnailsReason);
  // The whole-job cleanup (history delete, the four-week prune).
  const kept = path.join(world.root, 'job-thumbs', 'thumbnails', 'j-1');
  fs.mkdirSync(kept, { recursive: true });
  const cleanup = deleteJobTxtFiles({ txt_folder: path.join(world.root, 'job-thumbs'), items: [{ txt_path: '', thumbnails: { folder: kept } }, { txt_path: '' }] });
  assert.strictEqual(cleanup.thumbnailFolders, 1);
  assert.ok(!fs.existsSync(kept));
}));

check('the tab is gone and nothing dangles: no route, sidebar entry, component, lab service, combine or thumbs: channel; every thumbnails: channel offered has a handler and the reverse; no THUMBNAIL TEXT OPTIONS section; pick 1 is published through the publish door', () => {
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
  for (const gone of ['electron/services/thumbnails/lab-service.ts', 'electron/services/thumbnails/thumbnail-lab-ipc.ts', 'electron/services/thumbnails/combine.ts', 'frontend/src/app/components/thumbnails']) {
    assert.ok(!fs.existsSync(path.join(REPO, gone)), `${gone} is still there`);
  }
  assert.ok(!/path: 'thumbnails'/.test(read('frontend/src/app/app.routes.ts')), 'the route is gone');
  assert.ok(!/routerLink="\/thumbnails"/.test(read('frontend/src/app/app.html')), 'the sidebar entry is gone');
  const main = read('electron/main.ts');
  assert.ok(/setupThumbnailsIpc\(/.test(main) && !/setupThumbnailLabIpc/.test(main));
  const preload = read('electron/preload.ts');
  const ipc = read('electron/services/thumbnails/thumbnails-ipc.ts');
  const bridge = read('frontend/src/app/services/electron.ts');
  assert.ok(!/'thumbs:/.test(preload) && !/'thumbs:/.test(ipc) && !/thumbs[A-Z]/.test(bridge), 'no thumbs: channel anywhere');
  const offered = new Set([...preload.matchAll(/ipcRenderer\.(?:invoke|on)\('(thumbnails:[a-z-]+)'/g)].map((m) => m[1]));
  const handled = new Set([...ipc.matchAll(/ipcMain\.handle\('(thumbnails:[a-z-]+)'/g)].map((m) => m[1]));
  handled.add('thumbnails:progress'); // pushed by main, listened to by the preload
  assert.deepStrictEqual([...offered].sort(), [...handled].sort(), 'the preload and the handlers name the same channels');
  const html = read('frontend/src/app/components/metadata-reports/metadata-reports.html');
  assert.ok(!/thumbnail_text|Thumbnail text/.test(html), 'no THUMBNAIL TEXT OPTIONS section on the reports page');
  assert.ok(/openThumbnails\(\)/.test(html), 'the reports page opens the Thumbnails window');
  const win = read('frontend/src/app/components/thumbnails-window/thumbnails-window.ts');
  assert.ok(/this\.publish\.setThumbnail\(view\.publishFile\)/.test(win), 'pick 1 goes through the publish record\'s one thumbnail door');
});

run('thumbnails in the metadata run and the reports page\'s window: the story link, stage order and one swap, words per title, no story, failures, off, storage, ordered picks, swaps, own image, rewrite for a title, screenshots, delete, the tab gone');
