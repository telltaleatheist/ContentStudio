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
 *   - STAGE ORDER, 27B REUSE, NO DECIDE: inside one lane job on one JobLeases (as the metadata job
 *     runs), the story and the frames ask the server nothing (CPU only since the frame scoring was
 *     removed 2026-09-29, Owen picks the frames), and the words run on the fields' 27B with no second
 *     load. No decide at all: the tone and photo ranking went the same day (Owen picks his photos).
 *     THE GRID is at most two frames a scene, in time order, the only frames on disk.
 *   - WORDS PER TITLE: one words call per pair, each carrying its own title, the pairs in the gate's
 *     ranking when it ranked the titles and as written otherwise; the pairs' default kinds are
 *     claim, stakes, reaction; no pair gets a frame (Owen picks them) and nothing is drawn, "No frame
 *     picked yet" and "No photo picked yet" on each.
 *   - NO STORY: the stages stop with the reason on the record; no model is called and nothing is
 *     written.
 *   - FAILURE SURFACED: a words model the server does not have fails the words stage with the
 *     server's refusal in plain words, on the record and as the run's warning; the render does not
 *     run; a stop (cancel) is rethrown, never recorded as a failure.
 *   - OFF: absent setup, the per-run switch, a channel that makes none and a channel file that does
 *     not say each give an "off" record with its reason; the shipped channels say true/false and none
 *     still declares THUMBNAIL TEXT OPTIONS.
 *   - STORAGE ROUND-TRIP: the record is saved on the item in its job file, read back checked, and
 *     the picks written through the one door; bad picks and another record version are refused and
 *     leave the file as it was. A record made before 2026-09-29 (the frame scoring's scores, rows
 *     and line, a stop at `scoring`) is still read.
 *
 * The reports page's Thumbnails window (report-thumbnails.ts; the card editor since 2026-09-29,
 * LEDGER #247):
 *
 *   - SAVE THUMBNAILS: every card with a frame drawn (per-card progress), the cards in order saved as
 *     the picks (Pick 1..n copies, pick 1 the file to publish); an empty card left out and the rest
 *     closing up, its pair losing its frame and its old drawing; one frame on all three; a card that
 *     cannot be drawn saves nothing and is named; bad cards refused before anything is drawn.
 *   - CARD EDITS: the frame's zoom and pan, the text box and the photo's place are handed to the
 *     renderer and stored on the pair; none stored or drawn when reset; the run's own drawings carry a
 *     stored edit; drawPair with none draws as before.
 *   - THE PREVIEW'S PIECES: a frame at full size extracted once, its faces searched once, a failed
 *     search said; photos; the look, border and logo in the view; closing gives everything back.
 *   - AN OLD OWN-IMAGE PICK still saves as it is (nothing makes a new one); REWRITE WORDS for a title
 *     (one call on one held load of the 27B, nothing drawn, the saved card and picks left as they
 *     are, the old words kept); NO STORY -> SCREENSHOTS (they become the frames; a card with no pair
 *     only holds his image); DELETE.
 *   - HIS IMAGES ADDED AS FRAMES (2026-09-29): a non-16:9 PNG cut to fill 16:9 at 1920x1080 with the
 *     grid's two JPEGs, on the record (validated), listed first, placed on a card and drawn; a
 *     missing added file refused by name and never taken from the recording; bad paths refused by
 *     name; a report with no story gets its folder; new screenshots keep them.
 *   - THE WORDS ARE KEPT (2026-09-29): New options and More options written into the record before
 *     any save, the earlier set kept, More showing the model what was written and adding none twice;
 *     closing the window mid-run neither stops the run nor gives the model back under it; a window
 *     opened meanwhile sees it running; a line on a card never disappears.
 *   - ERRORS REACH THE WINDOW; a video that is not ready is PREPARED from what it stores.
 *   - THE CARD RULES (frontend thumbnails-compose.ts, run here with the compiled shared layout): the
 *     active card, a click on and off, badges, edits following the pieces, his own image, the
 *     editor's clamps; cards saved and read back equal, unsaved changes, old picks, a clash refused.
 *   - THE WINDOW'S SHAPE: cards and Save above the trays; no pick lists, Generate, suggested words,
 *     Clear picks, logo switch or No text / No photo; a click asks the main process nothing; the
 *     preview uses the shared layout and drawing; closing asks in the window; no teal.
 *   - THE BORDER: drawPair hands the renderer the kept border when the look has it on, none when it
 *     is off or none is kept (said in the record's lines); the shared drawing's order.
 *   - THE TAB IS GONE and the removed channels with it; every channel offered has a handler.
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
  { id: 'qwen3.8-27b-8bit', paramsB: 27, installed: true, contextDefault: 32768, modalities: ['text'] },
  // Offered on the words row, and not downloaded here: the words stage's failure.
  { id: 'qwen3.5-9b', paramsB: 9, installed: false, contextDefault: 16384, modalities: ['text'] },
];
const WORDS_REPLY = 'CLAIM\nTHE RAPTURE IS HERE\nDONT STAND UNDER A ROOF\nSTAKES\nMAYBE TOMORROW\nREACTION\nSHE MEANS IT\nOH NO';

/** Since 2026-09-29 the thumbnails ask no decide at all (no frame scoring, no tone or photo ranking). */
function decideProbs(q) {
  throw new Error(`the keeper was asked a decide, and the thumbnails ask none: ${JSON.stringify(q.labels)}`);
}

const PNG_BYTES = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('a keeper photo')]);

/**
 * The world one item's thumbnails run in: the synthetic week, the photos in a scratch library, the
 * fake Crucible behind the real transport and lanes, a stand-in renderer, and a `job(fn)` that runs
 * `fn(leases)` inside one lane job holding one JobLeases, as the metadata job does.
 */
async function withWorld(options, fn) {
  // The catalog says what /v1/models says: the 8-bit 27B installed (the Mac's build), the 9B not downloaded.
  const catalog = MODELS.map((m) => ({ kind: 'model', id: m.id, name: m.id, jobType: 'llm', installed: m.installed !== false, expectedBytes: null }));
  const server = await fake.startFakeCrucible({ version: '1.0.55', models: MODELS, catalog, decideProbs, chatReplies: { 'qwen3.8-27b-8bit': () => ({ content: WORDS_REPLY, finishReason: 'stop' }) }, ...(options.fake ?? {}) });
  const made = context({ leaseTimings: { heartbeatMs: 40, releaseGraceMs: 20, requestTimeoutMs: 500 } });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  // The job's routed options resolved against this server's catalog, as the metadata job does at its start.
  const models = await services('metadata/routing-models.js').readRoutingModels('the keeper\'s metadata job', ['qwen38-27b', 'qwen35-9b']);
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'thumb-pipe-world-'));
  const w = syntheticWeek(root, options.week ?? {});
  const userData = path.join(root, 'userData');
  const photos = path.join(root, 'selfies');
  fs.mkdirSync(photos);
  for (const name of ['laugh', 'horrified', 'oh please', 'ooh']) fs.writeFileSync(path.join(photos, `selfie ${name}.png`), PNG_BYTES);
  library.addPhotos(userData, [photos], false);
  const renders = [];
  /** Set `failing.when(input)` to make the stand-in renderer refuse a drawing (a save that must stop). */
  const failing = { when: null };
  const plainCalls = [];
  const doors = { lanes: made.ctx.lanes, transport: made.ctx.transport, clientFor: (s) => made.ctx.factory.clientFor(s) };
  const setup = {
    userDataPath: userData, ffmpeg: FFMPEG, ffprobe: FFPROBE,
    manifest: async () => syntheticManifest(w.master),
    openRenderer: () => ({
      render: async (input) => {
        renders.push(input);
        if (failing.when !== null && failing.when(input)) throw new Error('the drawing page closed');
        const file = `${input.outStem}.png`;
        fs.mkdirSync(path.dirname(file), { recursive: true });
        // Each drawing's bytes name it, so a copy can be told from another drawing.
        const bytes = Buffer.concat([PNG_BYTES, Buffer.from(path.basename(input.outStem))]);
        fs.writeFileSync(file, bytes);
        return { ok: true, path: file, bytes: bytes.length, format: 'png', faces: [], plan: null, reaction: null, logo: null, notes: [] };
      },
      close: () => renders.push('closed'),
    }),
    style: require(path.join(DIST, 'shared', 'thumbnail-layout.js')).DEFAULT_STYLE, styleSaved: false, styleLine: null,
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
    leases, aiManager, routing: routing.resolveMetadataRouting(over.routing ?? {}), models, signal: controller.signal,
    cancelled: () => controller.signal.aborted, progress: () => undefined,
  });
  try {
    await fn({ failing, server, w, root, renders, plainCalls, aiManager, job, itemRun, setup, userData, models, transport: made.ctx.transport, lanes: made.ctx.lanes });
  } finally {
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
}

const FIELDS = { titles: ['Title one', 'Title two', 'Title three', 'Title four'], description_hook: 'She says the rapture is here.', description: 'A rapture claim.\n\nLinks' };

check('stages: story and frames before the chapters with no model; words and render after the fields; the 27B loaded once (the fields\'), the words on it; no decide; the grid is at most two frames a scene, in time order, the only frames on disk', () => withWorld({}, async ({ server, renders, plainCalls, aiManager, job, itemRun, root }) => {
  const rec = await job(async (leases, controller) => {
    const run = itemRun(leases, controller);
    await run.beforeChapters();
    assert.strictEqual(run.record().state, 'made', run.record().line);
    assert.deepStrictEqual(run.record().timings.map((t) => t.stage), ['story', 'frames']);
    assert.deepStrictEqual([loadsOf(server).length, server.leases.taken.length, server.decideBodies().length], [0, 0, 0], 'the story and the frames asked the server nothing');
    // The chapters and the fields, as the metadata job runs them: on the 27B, under the same leases.
    await aiManager.runPlainRequest('the titles prompt', 'qwen3.8-27b-8bit', 'titles', { thinking: false, maxTokens: 2048, loadContext: 8192, job: leases });
    const loadsBefore = loadsOf(server).length;
    await run.afterFields(FIELDS);
    assert.strictEqual(loadsOf(server).length, loadsBefore, 'the words loaded nothing: the fields\' 27B stayed');
    return run.record();
  });
  assert.strictEqual(rec.state, 'made', rec.line);
  assert.deepStrictEqual(rec.timings.map((t) => t.stage), ['story', 'frames', 'words', 'render']);
  assert.deepStrictEqual(record.THUMBNAIL_STAGES, ['story', 'frames', 'words', 'render'], 'the tone-photos and scoring stages are gone');
  assert.deepStrictEqual(record.RETIRED_STAGES, ['tone-photos', 'scoring'], 'an older record may still name them');
  assert.strictEqual(server.decideBodies().length, 0, 'no decide at all');
  assert.deepStrictEqual(loadsOf(server), ['qwen3.8-27b-8bit'], 'the 27B once, the only model of the job');
  assert.strictEqual(server.leases.taken.length, 1, 'one lease');
  assert.ok(plainCalls.every((c) => c.job !== undefined), 'every text call carried the job');
  assert.ok(rec.folder.startsWith(path.join(root, 'report', 'thumbnails', 'keeper-job-1')), rec.folder);
  // The grid: at most two frames a scene, look-alikes dropped, in time order, the only frames on disk.
  assert.ok(rec.frames.length >= 3, `${rec.frames.length} frames to pick from`);
  for (let i = 1; i < rec.frames.length; i++) assert.ok(rec.frames[i].t > rec.frames[i - 1].t, 'in time order');
  for (const sc of rec.scenes) {
    const mine = rec.frames.filter((f) => f.scene === sc.number);
    assert.strictEqual(sc.shown, mine.length, `scene ${sc.number} says how many of its frames are in the grid`);
    // None when every one looked like a frame of another scene (look-alikes dropped).
    assert.ok(mine.length <= (sc.seconds < 10 ? 1 : 2) && mine.length <= sc.kept, `scene ${sc.number}: ${mine.length} of ${sc.kept} kept, ${sc.seconds} s`);
  }
  assert.ok(rec.frames.every((f) => fs.existsSync(f.large) && fs.existsSync(f.small)), 'the candidates stay on disk');
  assert.deepStrictEqual(fs.readdirSync(path.join(rec.folder, 'frames')).length, rec.frames.length * 2, 'only the grid\'s frames are kept');
  assert.ok(rec.frames.every((f) => !('score' in f) && !('reading' in f) && !('flag' in f)) && !('scoring' in rec) && !('bestScenes' in rec), 'no score, reading, rows or scoring line is written');
  assert.ok(rec.lines.some((l) => /; \d+ to pick from \(the sharpest, at most 2 a scene; \d+ dropped as look-alikes\)\.$/.test(l)), rec.lines.join(' | '));
  assert.deepStrictEqual(renders, [], 'nothing drawn: the renderer is not even opened (no pair has a frame)');
}));

check('stages: words per title (one call each, the title in it), the gate\'s ranking first when it ranked them; kinds claim, stakes, reaction; no pair gets a frame and nothing is drawn, "no frame / no photo picked yet" on each', () => withWorld({}, async ({ plainCalls, job, itemRun, renders }) => {
  const ranked = { ...FIELDS, reroll_gate: { ranking: { order: [{ title: 'Title three' }, { title: 'Title one' }, { title: 'Title four' }, { title: 'Title two' }] } } };
  const rec = await job(async (leases, controller) => {
    const run = itemRun(leases, controller);
    await run.beforeChapters();
    await run.afterFields(ranked);
    return run.record();
  });
  assert.deepStrictEqual(rec.titles, { order: 'gate ranking', subjects: ['Title three', 'Title one', 'Title four'] });
  const wordCalls = plainCalls.filter((c) => /^thumbnail text for/.test(c.what));
  assert.strictEqual(wordCalls.length, 3, 'one words call per pair');
  wordCalls.forEach((c, i) => assert.ok(c.prompt.includes(`\n${rec.titles.subjects[i]}\n`), `call ${i + 1} carries its own title`));
  assert.ok(!wordCalls[0].prompt.includes('Title one\n') || wordCalls[0].prompt.indexOf('Title three') > 0);
  assert.deepStrictEqual(rec.pairs.map((p) => [p.pair, p.title, p.default.kind, p.default.phrase]), [
    [1, 'Title three', 'claim', 'THE RAPTURE IS HERE'], [2, 'Title one', 'stakes', 'MAYBE TOMORROW'], [3, 'Title four', 'reaction', 'SHE MEANS IT'],
  ]);
  assert.deepStrictEqual(rec.pairs[0].words.claim, ['THE RAPTURE IS HERE', 'DONT STAND UNDER A ROOF'], 'every option is kept for phase 2');
  assert.ok(rec.pairs.every((p) => p.default.frameId === null && p.default.scene === null), 'no pair has a frame: Owen picks them (no ranking chose any)');
  assert.deepStrictEqual([rec.seed, rec.tone], [null, null], 'no tone read, no draw');
  assert.ok(rec.pairs.every((p) => p.photos.length === 0 && p.default.photo === null && p.default.draw === null), 'no photo ranked or chosen by a model');
  assert.ok(rec.pairs.every((p) => p.lines.includes(pipeline.NO_FRAME_YET) && p.lines.includes(pipeline.NO_PHOTO_YET)), 'each pair says its frame and photo are not picked yet');
  assert.strictEqual(pipeline.NO_FRAME_YET, 'No frame picked yet: pick one in the Thumbnails window.');
  assert.strictEqual(pipeline.NO_PHOTO_YET, 'No photo picked yet: pick one in the Thumbnails window.');
  assert.ok(rec.pairs.every((p) => !p.default.render.ok), 'nothing drawn');
  assert.deepStrictEqual(renders, [], 'the renderer was never opened');
  assert.ok(rec.lines.includes('No border is kept in the app, so none is drawn.'), rec.lines.join(' | '));
  assert.strictEqual(rec.line, '3 title and thumbnail pairs have their words; pick the frames and photos in the Thumbnails window.');
  assert.deepStrictEqual(pipeline.pairSubjects({ titles: ['A', 'B', 'C', 'D'] }), { order: 'as written', subjects: ['A', 'B', 'C'] }, 'no ranking: the titles as written');
}));

check('stages: an item with no story stops with the reason on the record; no model is called and nothing is written', () => withWorld({}, async ({ server, plainCalls, job, itemRun, root }) => {
  const rec = await job(async (leases) => {
    // A name that finds no story, and a transcript no story of the week holds.
    const run = pipeline.ItemThumbnailRun.start({ mode: 'on', setup: {} }, {
      jobId: 'keeper-job', itemIndex: 1, sourceLabel: 'u9.mov', contentType: 'video', videoPath: path.join(root, '2026-01-04', 'complete', 'u9 - unrelated.mov'),
      operatorRef: undefined, segments: captions(words(77, 400)), reportFolder: path.join(root, 'report'), channel: assets.promptAssets().channel('youtube-fireside'),
    }, { leases, aiManager: { runPlainRequest: async () => { throw new Error('no model'); } }, routing: routing.resolveMetadataRouting({}), models: routing.RoutingModels.withoutCatalog('no model is called'), cancelled: () => false, progress: () => undefined });
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

check('stages: a failed stage is on the record and in the warning, in plain words; the later stages do not run; a stop is rethrown, not recorded', () => withWorld({}, async ({ job, itemRun, renders }) => {
  const rec = await job(async (leases, controller) => {
    const run = itemRun(leases, controller, { routing: { thumbnail_words: 'qwen35-9b' } });
    await run.beforeChapters();
    await run.afterFields(FIELDS);
    // Refused by the job's resolution, before anything is loaded: the row names a model the server does not hold.
    assert.ok(/^f2 - the rapture\.mov: The thumbnails stopped at the words stage: The Thumbnail words row is set to Qwen 3\.5 · 9B, and nothing was sent: Qwen 3\.5 · 9B is not on "mac"/.test(run.warning()), run.warning());
    return run.record();
  });
  assert.deepStrictEqual([rec.state, rec.failure.stage], ['failed', 'words']);
  assert.deepStrictEqual(rec.timings.map((t) => t.stage), ['story', 'frames', 'words']);
  assert.deepStrictEqual(renders, [], 'the render did not run');
  assert.strictEqual(record.readItemThumbnails(rec, 'keeper').failure.stage, 'words');
  // A stop: the frames stage while the run is being stopped goes up, unrecorded.
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

check('pieces: a kind with no options starts on the next kind, said; no default frame is chosen by the run any more', () => {
  assert.strictEqual(pipeline.defaultFrames, undefined, 'the ranking\'s default frames are gone');
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
      folder: path.join(job.txtFolder, 'thumbnails', 'keeper-store-job-1'), source: { video: '/v.mp4', lines: [] }, scenes: [], frames: [],
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
    // The card editor (2026-09-29): an own image names its card; two picks on one card, a card out of range and a bad edit are refused.
    const cardFour = await rejection(out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, picks: [{ kind: 'own', file: '/a', card: 4 }] })));
    assert.ok(/your own image on card 4; the cards are 1 to 3/.test(cardFour.message), cardFour.message);
    const sameCard = await rejection(out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, picks: [{ kind: 'made', pair: 2, file: '/r/2.png', wordsFor: 'T2' }, { kind: 'own', file: '/a', card: 2 }] })));
    assert.ok(/puts two picks on one card/.test(sameCard.message), sameCard.message);
    const badEdit = await rejection(out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, pairs: r.pairs.map((p) => (p.pair === 3 ? { ...p, default: { ...p.default, adjust: { frame: { x: 0, y: 0, scale: 40 } } } } : p)) })));
    assert.ok(/thumbnail 3: the frame's zoom is 40; it must be a number from 0.25 to 5/.test(badEdit.message), badEdit.message);
    assert.strictEqual(fs.readFileSync(job.jsonPath, 'utf8'), before, 'a refused write leaves the file byte for byte');
    const edited = await out.updateItemThumbnails(job.jobId, saved.itemId, (r) => ({ ...r, pairs: r.pairs.map((p) => (p.pair === 1 ? { ...p, default: { ...p.default, adjust: { frame: { x: -0.25, y: -0.25, scale: 1.5 }, photo: { cx: 0.2, cy: 0.7, h: 0.4 } } } } : p)), picks: [{ kind: 'own', file: '/mine.png', card: 3 }] }));
    assert.deepStrictEqual(record.readItemThumbnails(out.getJobMetadata(job.jobId).items[0].thumbnails, 'keeper').pairs[0].default.adjust, edited.pairs[0].default.adjust, 'a card\'s edits round-trip');
    assert.throws(() => record.readItemThumbnails({ ...rec, version: 2 }, 'keeper'), /is version 2, and this build reads version 1/);
    assert.strictEqual(record.readItemThumbnails(undefined, 'keeper'), null, 'an item from before the pipeline has none');
    // A record made before 2026-09-29 carries the frame scoring's scores, rows and line, and may have stopped AT the scoring: read, those fields ignored.
    const scored = {
      ...rec, state: 'failed', failure: { stage: 'scoring', reason: 'refused' }, line: 'The thumbnails stopped at the scoring stage: refused', pairs: [],
      scenes: [{ number: 1, seconds: 30, label: 'Scene 1', kept: 9, scored: 4 }],
      frames: [{ id: 'f1', t: 1, clock: '0:01', scene: 1, large: '/l.jpg', small: '/s.jpg', score: 0.5, reading: { pScreen: 0.1, pFace: 0.9, expression: 3, pEyesOpen: 0.9, pStrong: 0.5 }, flag: null }],
      bestScenes: [{ scene: 1, ids: ['f1'], more: [], best: 0.5 }], scoring: { server: 'mac', model: 'qwen3.5-9b-vl', line: 'Scored 1 frame' },
      timings: [{ stage: 'story', seconds: 1 }, { stage: 'frames', seconds: 1 }, { stage: 'scoring', seconds: 1 }],
    };
    assert.strictEqual(record.readItemThumbnails(scored, 'keeper').failure.stage, 'scoring', 'an older record stopped at the scoring is read');
    assert.deepStrictEqual(pipeline.resumePlan(scored, () => true), { keep: ['story'], run: ['frames', 'words', 'render'] }, 'its scored frames (up to 120, look-alikes and all) are picked again as the new grid');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// ── phase 2: the Thumbnails window (report-thumbnails.ts), the card editor since 2026-09-29 ──────

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
 * The live preview's pieces as the keeper hands them (the app's use nativeImage and the hidden
 * canvas page): what was asked is recorded; faces come from `faceTable` by file name (an Error
 * there is a face search that fails), a default face otherwise.
 */
function standInPieces(faceTable = {}) {
  const asked = { frames: [], faces: [], photos: [], closed: 0 };
  return {
    asked,
    framePicture: (file) => {
      asked.frames.push(file);
      assert.ok(fs.existsSync(file), `the preview asked for a frame that is not on disk: ${file}`);
      return { picture: `picture of ${path.basename(file)}`, width: 1920, height: 1080 };
    },
    faces: async (file) => {
      asked.faces.push(file);
      const f = faceTable[path.basename(file)];
      if (f instanceof Error) throw f;
      return f ?? [{ x: 700, y: 200, w: 300, h: 300 }];
    },
    photo: (name) => {
      asked.photos.push(name);
      return { image: `picture of ${name}`, width: 606, height: 883 };
    },
    logo: () => ({ width: 400, height: 400, at: (w, h) => `logo at ${w}x${h}` }),
    border: (file) => `border ${path.basename(file)}`,
    close: () => { asked.closed += 1; },
  };
}

/**
 * Cards as the window sends them to Save thumbnails: `spec[i]` for card i+1, null for an empty
 * card, `{ own }` for his image, else `{ frame, phrase?, kind?, wordsFor?, photo?, adjust? }` (the
 * pair's own default words when `phrase` is left out).
 */
function cardsFor(rec, spec) {
  return [1, 2, 3].map((n) => {
    const s = spec[n - 1] ?? null;
    if (s === null) return { card: n, kind: 'empty' };
    if (s.own !== undefined) return { card: n, kind: 'own', file: s.own };
    const pair = rec.pairs.find((p) => p.pair === n);
    const given = s.phrase !== undefined;
    const phrase = given ? s.phrase : pair.default.phrase;
    return {
      card: n, kind: 'made', frameId: s.frame, phrase,
      textKind: given ? (s.kind ?? null) : pair.default.kind,
      wordsFor: given ? (s.wordsFor ?? null) : (phrase === null ? null : pair.title),
      photo: s.photo ?? null, adjust: s.adjust ?? {},
    };
  });
}

const drawsOf = (world) => world.renders.filter((r) => r !== 'closed');

/**
 * The window over the world: a job in `root` (the output directory), the item's transcript saved,
 * its record from a real pipeline run (or `record`), and ReportThumbnails wired as the IPC wires it
 * (the preview's pieces stood in). A story run gives no pair a frame (Owen picks them), so unless
 * `draw` is false the three cards are then saved as Save thumbnails would save them: card n on grid
 * frame n with pair n's words. `rec` is the record after that; `runRec` the record the run wrote.
 */
async function windowOver(world, { record: given = null, noStory = false, gpuVenue = null, draw = true, faces = {} } = {}) {
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
      }, { leases, aiManager, routing: routing.resolveMetadataRouting({}), models: world.models, cancelled: () => false, progress: () => undefined });
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
  const pieces = standInPieces(faces);
  const window = new ReportThumbnails({
    store: { get: (k) => settings[k] },
    userDataPath: userData,
    ffprobe: FFPROBE,
    look: new ThumbnailLook({ store: { get: (k) => settings[k], set: (k, v) => { settings[k] = v; } }, userDataPath: userData }),
    runChoice: () => ({ mode: 'on', setup }),
    holdJob: (what) => transport.job(what),
    aiManager: () => aiManager,
    picture: (file, width) => `picture of ${path.basename(file)} at ${width}`,
    photoList: () => library.libraryPhotos(userData).map((ph) => ({ name: ph.name, preview: `picture of ${ph.name}` })),
    pieces,
    progress: (e) => progress.push(e),
    gpuVenue: gpuVenue ?? (() => world.lanes.gpuVenue()),
  });
  let drawn = rec;
  if (given === null && !noStory && draw) {
    drawn = (await window.saveCards(job.jobId, saved.itemId, cardsFor(rec, rec.pairs.map((p) => ({ frame: rec.frames[p.pair - 1].id }))))).record;
  }
  return { out, job, itemId: saved.itemId, window, rec: drawn, runRec: rec, progress, video, pieces };
}

check('window, Save thumbnails: every card with a frame drawn and the cards in order saved as the picks (Pick 1..n copies, pick 1 published); an empty card is left out and the rest close up, its pair losing its frame; one frame on all three; per-card progress; a card that cannot be drawn stops the save by name and nothing is saved; bad cards refused', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec, runRec, progress } = await windowOver(world);
  const v0 = window.view(job.jobId, itemId);
  assert.deepStrictEqual(v0.picks.map((p) => [p.n, p.pick.kind, p.pick.pair, p.pick.wordsFor]), [[1, 'made', 1, 'Title one'], [2, 'made', 2, 'Title two'], [3, 'made', 3, 'Title three']], 'card n is pick n');
  const folder = rec.folder;
  assert.deepStrictEqual(v0.picks.map((p) => p.copy), [1, 2, 3].map((n) => path.join(folder, 'picks', `Pick ${n}.png`)));
  assert.strictEqual(v0.publishFile, path.join(folder, 'picks', 'Pick 1.png'), 'pick 1 is what is published');
  assert.ok(fs.readFileSync(v0.publishFile).equals(fs.readFileSync(rec.pairs[0].default.render.file)), 'Pick 1 is card 1\'s drawing');
  assert.deepStrictEqual(rec.pairs.map((p) => [p.default.frameId, p.default.phrase, p.default.photo, p.default.adjust]), runRec.pairs.map((p, i) => [rec.frames[i].id, p.default.phrase, null, undefined]), 'each pair holds its card; no edit stored for a card with none');
  assert.ok(rec.pairs.every((p) => !p.lines.includes(pipeline.NO_FRAME_YET) && !p.lines.includes(pipeline.NO_PHOTO_YET)), 'the "not picked yet" lines go once saved');
  assert.deepStrictEqual(progress.filter((e) => e.card !== undefined).map((e) => [e.card, e.line]), [[1, 'Drawing thumbnail 1 (1 of 3)…'], [2, 'Drawing thumbnail 2 (2 of 3)…'], [3, 'Drawing thumbnail 3 (3 of 3)…']], 'each card said as it is drawn');
  assert.deepStrictEqual(window.summary(job.jobId, itemId).picks.map((p) => p.n), [1, 2, 3], 'the reports page reads the same picks');
  // Card 2 emptied: card 3 becomes Pick 2 (pick k goes with title k), pair 2 loses its frame and its drawing.
  const oldTwo = rec.pairs[1].default.render.file;
  const f = rec.frames.map((x) => x.id);
  const gap = await window.saveCards(job.jobId, itemId, cardsFor(rec, [{ frame: f[0] }, null, { frame: f[1] }]));
  assert.deepStrictEqual(gap.picks.map((p) => [p.n, p.pick.pair]), [[1, 1], [2, 3]], 'the saved cards in order: the rest close up');
  const p2 = gap.record.pairs[1];
  assert.deepStrictEqual([p2.default.frameId, p2.default.scene, p2.default.render.ok, p2.lines.includes(pipeline.NO_FRAME_YET)], [null, null, false, true], 'an empty card\'s pair has no frame again');
  assert.ok(!fs.existsSync(oldTwo), 'its old drawing is removed (no pick points at it)');
  assert.deepStrictEqual(fs.readdirSync(path.join(folder, 'picks')).sort(), ['Pick 1.png', 'Pick 2.png'], 'exactly the picks, as files');
  assert.ok(fs.readFileSync(path.join(folder, 'picks', 'Pick 2.png')).equals(fs.readFileSync(gap.record.pairs[2].default.render.file)), 'Pick 2 is card 3');
  const renders = fs.readdirSync(folder).filter((x) => /^Pair \d/.test(x));
  assert.deepStrictEqual(renders.sort(), gap.record.pairs.filter((p) => p.default.render.ok).map((p) => path.basename(p.default.render.file)).sort(), 'one current drawing per saved card in the folder');
  // The same frame on all three, the third with no words.
  const same = await window.saveCards(job.jobId, itemId, cardsFor(rec, [{ frame: f[0] }, { frame: f[0] }, { frame: f[0], phrase: null }]));
  assert.deepStrictEqual(same.record.pairs.map((p) => [p.default.frameId, p.default.phrase === null]), [[f[0], false], [f[0], false], [f[0], true]]);
  assert.deepStrictEqual(same.picks.map((p) => p.pick.pair), [1, 2, 3]);
  assert.strictEqual(drawsOf(world).pop().phrase, null, 'drawn with no words');
  // A card that cannot be drawn: nothing is saved, the drawings of this save are removed, the card named.
  const before = window.view(job.jobId, itemId);
  const filesBefore = fs.readdirSync(folder).sort();
  world.failing.when = (input) => /^Pair 2 /.test(path.basename(input.outStem));
  const failed = await rejection(window.saveCards(job.jobId, itemId, cardsFor(rec, [{ frame: f[1] }, { frame: f[1] }, { frame: f[1] }])));
  world.failing.when = null;
  assert.ok(/^Thumbnail 2 could not be drawn, so nothing was saved: the drawing page closed$/.test(failed.message), failed.message);
  const after = window.view(job.jobId, itemId);
  assert.deepStrictEqual([after.record.pairs, after.picks.map((p) => p.pick.file)], [before.record.pairs, before.picks.map((p) => p.pick.file)], 'the record and the picks as they were');
  assert.deepStrictEqual(fs.readdirSync(folder).sort(), filesBefore, 'card 1\'s drawing from the failed save is removed');
  // Refused before anything is drawn.
  const draws = drawsOf(world).length;
  const refusals = [
    [cardsFor(rec, [{ frame: f[0] }, null]).slice(0, 2), /The window sends all 3 cards; 2 came\./],
    [[{ card: 1, kind: 'empty' }, { card: 1, kind: 'empty' }, { card: 3, kind: 'empty' }], /Card 1 came twice\./],
    [cardsFor(rec, [{ frame: 'f999999' }]), /Card 1's frame "f999999" is not among this report's candidate frames\./],
    [cardsFor(rec, [{ frame: f[0], photo: 'nobody' }]), /Card 1: there is no reaction photo "nobody"/],
    [cardsFor(rec, [{ frame: f[0], phrase: null, kind: 'claim' }]), /Card 1 has no words, and names where they came from\./],
    [cardsFor(rec, [{ frame: f[0], phrase: 'x', kind: 'shout' }]), /Card 1: "shout" is not a kind of words/],
    [cardsFor(rec, [{ frame: f[0], adjust: { frame: { x: 0, y: 0, scale: 9 } } }]), /^Card 1: the frame's zoom is 9/],
    [cardsFor(rec, [{ frame: f[0], adjust: { photo: { cx: 0.5, cy: 0.5, h: 0.4 } } }]), /Card 1 places a photo and has none\./],
    [cardsFor(rec, [{ frame: f[0], phrase: null, adjust: { text: { x: 0.1, y: 0.1, w: 0.3, h: 0.2 } } }]), /Card 1 places words and has none\./],
    [[{ card: 1, kind: 'drawn' }, { card: 2, kind: 'empty' }, { card: 3, kind: 'empty' }], /Card 1 is neither a thumbnail, your own image nor empty/],
  ];
  for (const [cards, re] of refusals) {
    const e = await rejection(window.saveCards(job.jobId, itemId, cards));
    assert.ok(re.test(e.message), `${re}: ${e.message}`);
  }
  assert.strictEqual(drawsOf(world).length, draws, 'nothing drawn for a refused save');
  // Nothing on any card: the picks and their files go.
  const none = await window.saveCards(job.jobId, itemId, cardsFor(rec, [null, null, null]));
  assert.deepStrictEqual([none.picks.length, none.publishFile, fs.existsSync(path.join(folder, 'picks'))], [0, null, false], 'no picks: nothing to publish, no copies');
  assert.ok(none.record.pairs.every((p) => p.default.frameId === null && !p.default.render.ok));
}));

check('window, card edits: the frame zoom and pan, the text box and the photo\'s place are handed to the renderer and stored on the pair; saving again without them stores none and draws with none; the run\'s own drawings (screenshots) carry the stored edit; an old record renders with none', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec } = await windowOver(world, { draw: false });
  const f = rec.frames.map((x) => x.id);
  const adjust = { frame: { x: -0.5, y: -0.25, scale: 2 }, text: { x: 0.05, y: 0.08, w: 0.55, h: 0.3 }, photo: { cx: 0.2, cy: 0.7, h: 0.45 } };
  const v = await window.saveCards(job.jobId, itemId, cardsFor(rec, [{ frame: f[0], photo: 'laugh', adjust }, { frame: f[1] }, null]));
  const [d1, d2] = drawsOf(world).slice(-2);
  assert.deepStrictEqual([d1.adjust, d1.photo.name], [adjust, 'laugh'], 'card 1 drawn with its edits');
  assert.strictEqual(d2.adjust, null, 'card 2 had none: drawn exactly as before the editor');
  assert.deepStrictEqual(v.record.pairs[0].default.adjust, adjust, 'stored on the pair');
  assert.ok(!('adjust' in v.record.pairs[1].default), 'no edit, nothing stored');
  assert.deepStrictEqual(record.readItemThumbnails(v.record, 'keeper').pairs[0].default.adjust, adjust, 'read back checked');
  const again = await window.saveCards(job.jobId, itemId, cardsFor(rec, [{ frame: f[0], photo: 'laugh' }, { frame: f[1] }, null]));
  assert.strictEqual(drawsOf(world).slice(-2)[0].adjust, null);
  assert.ok(!('adjust' in again.record.pairs[0].default), 'Reset everything: the edit is gone');
  // A pair the run draws itself (a screenshots record stopped at the render) is drawn with the edit it stores.
  const shotRec = JSON.parse(JSON.stringify(again.record));
  Object.assign(shotRec, { state: 'failed', failure: { stage: 'render', reason: 'x' }, line: 'The thumbnails stopped at the render stage: x', source: { video: null, lines: [] }, picks: [] });
  shotRec.pairs = shotRec.pairs.slice(0, 2).map((p, i) => ({ ...p, default: { ...p.default, frameId: f[i], render: { ok: false, reason: 'Not drawn yet.' }, ...(i === 0 ? { adjust } : {}) } }));
  const resumed = await windowOver(world, { record: shotRec });
  const n0 = drawsOf(world).length;
  await resumed.window.finish(resumed.job.jobId, resumed.itemId);
  const runDraws = drawsOf(world).slice(n0);
  assert.deepStrictEqual(runDraws.map((d) => d.adjust), [adjust, null], 'the run draws a stored edit, and none where none is stored');
  // pipeline.drawPair with no edit hands the renderer null (every record from before the editor).
  const renderer = world.setup.openRenderer();
  await pipeline.drawPair({ renderer, ffmpeg: FFMPEG, video: rec.source.video, folder: rec.folder, frame: { id: f[0], t: rec.frames[0].t }, phrase: 'X', photo: null, logo: false, style: world.setup.style, userDataPath: world.userData, outStem: path.join(rec.folder, 'old record'), adjust: null });
  assert.strictEqual(drawsOf(world).pop().adjust, null);
}));

check('window, the live preview\'s pieces: a frame at full size (extracted once from the recording) with the faces the render will find, searched once per frame; a failed face search said, not hidden; a photo trimmed as the render trims it; the look, border and logo at its drawn size in the view; closing the window closes the face search\'s page and gives the model back', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec, pieces } = await windowOver(world, { draw: false });
  const frame = rec.frames[0];
  const full = path.join(rec.folder, 'full', `${frame.id}.png`);
  assert.ok(!fs.existsSync(full), 'not extracted yet');
  const [a, b] = await Promise.all([window.frameDetail(job.jobId, itemId, frame.id), window.frameDetail(job.jobId, itemId, frame.id)]);
  assert.ok(fs.existsSync(full), 'extracted from the screen recording');
  assert.ok(!fs.readdirSync(path.dirname(full)).some((x) => x.startsWith('.')), 'no half-written file left beside it');
  assert.deepStrictEqual([a.frameId, a.picture, a.width, a.height, a.faces, a.facesError], [frame.id, `picture of ${frame.id}.png`, 1920, 1080, [{ x: 700, y: 200, w: 300, h: 300 }], null]);
  assert.deepStrictEqual(b, a);
  await window.frameDetail(job.jobId, itemId, frame.id);
  assert.strictEqual(pieces.asked.faces.filter((x) => x === full).length, 1, 'the faces are searched once per frame');
  assert.ok(/Frame f999 is not among this report's candidate frames/.test((await rejection(window.frameDetail(job.jobId, itemId, 'f999'))).message));
  // A face search that fails: the picture still comes, and why the faces are missing.
  const failFile = path.join(rec.folder, 'full', 'f_fail.png');
  fs.copyFileSync(full, failFile);
  const withFail = { ...rec, frames: [...rec.frames, { ...frame, id: 'f_fail' }] };
  const failWin = await windowOver(world, { record: withFail, faces: { 'f_fail.png': new Error('The face detector could not run: no FaceDetector.') } });
  const fd = await failWin.window.frameDetail(failWin.job.jobId, failWin.itemId, 'f_fail');
  assert.deepStrictEqual([fd.faces, fd.facesError], [null, 'The face detector could not run: no FaceDetector.']);
  // Photos (the second window: the first one's job was replaced by it).
  assert.deepStrictEqual(failWin.window.photoDetail('laugh'), { name: 'laugh', image: 'picture of laugh', width: 606, height: 883 });
  assert.throws(() => failWin.window.photoDetail('nobody'), /There is no reaction photo "nobody" in the app's library/);
  // The view's compose: the look, the logo at its drawn size (the render's placeLogo on 1280x720), the border when kept and on.
  const layoutMod = require(path.join(DIST, 'shared', 'thumbnail-layout.js'));
  const c0 = failWin.window.view(failWin.job.jobId, failWin.itemId).compose;
  assert.deepStrictEqual([c0.ok, c0.border, c0.logo, c0.width, c0.height], [true, null, null, 1280, 720]);
  assert.ok(c0.lines.includes('No logo is kept in the app, so none is drawn.') && c0.lines.includes('No border is kept in the app, so none is drawn.'), c0.lines.join(' | '));
  const logoFile = picture(path.join(world.root, 'Downloads', 'logo.png'), '640x360');
  library.setLibraryLogo(world.userData, logoFile, () => {});
  const borderFile = path.join(world.root, 'Downloads', 'thumbnail-border.png');
  fs.writeFileSync(borderFile, PNG_BYTES);
  library.setLibraryBorder(world.userData, borderFile, () => {});
  const c1 = failWin.window.view(failWin.job.jobId, failWin.itemId).compose;
  const at = layoutMod.placeLogo(400, 400, world.setup.style, 1280, 720);
  assert.deepStrictEqual([c1.logo, c1.border], [{ image: `logo at ${at.w}x${at.h}`, width: 400, height: 400 }, 'border thumbnail-border.png']);
  // Closing.
  const closedBefore = pieces.asked.closed;
  assert.strictEqual(await window.closed(), null, 'no model was held');
  assert.strictEqual(pieces.asked.closed, closedBefore + 1, 'the face search\'s page is closed');
}));

check('window, an old own-image pick: nothing makes a new one (no choose-own, no ownImage), and a card still holding one saves it as it is where it sits (checked against YouTube\'s rules, read in place, never moved), refused when too small; a report with no story still saves it', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec } = await windowOver(world);
  const { root } = world;
  assert.strictEqual(typeof window.ownImage, 'undefined', 'no way to make a new own-image pick');
  const mine = picture(path.join(root, 'Desktop', 'my thumbnail.png'), '1280x720');
  const before = fs.readFileSync(mine);
  const v = await window.saveCards(job.jobId, itemId, cardsFor(rec, [{ own: mine }, null, { frame: rec.frames[0].id }]));
  assert.deepStrictEqual(v.picks.map((p) => [p.pick.kind, p.pick.kind === 'own' ? p.pick.card : p.pick.pair]), [['own', 1], ['made', 3]], 'his image on card 1, card 3 after it');
  assert.ok(fs.readFileSync(v.publishFile).equals(before), 'his image is pick 1, and it is what is published');
  assert.ok(fs.readFileSync(mine).equals(before) && fs.existsSync(mine), 'his file is only read');
  assert.strictEqual(v.record.pairs[0].default.frameId, rec.pairs[0].default.frameId, 'the pair under his image is left as it was');
  const small = picture(path.join(root, 'Desktop', 'tiny.png'), '320x180');
  assert.ok(/320x180/.test((await rejection(window.saveCards(job.jobId, itemId, cardsFor(rec, [{ own: small }])))).message));
  assert.ok(/must be a file on this Mac/.test((await rejection(window.saveCards(job.jobId, itemId, cardsFor(rec, [{ own: 'relative.png' }])))).message));
  // A report with no story (no pairs, no folder yet): his image is saved, in a folder made for it.
  const bare = await windowOver(world, { noStory: true });
  const only = await bare.window.saveCards(bare.job.jobId, bare.itemId, cardsFor(bare.rec, [null, { own: mine }, null]));
  assert.strictEqual(only.record.state, 'no-story');
  assert.deepStrictEqual(only.picks.map((p) => [p.n, p.pick.card]), [[1, 2]], 'Pick 1, on card 2');
  assert.ok(only.publishFile.startsWith(path.join(bare.job.txtFolder, 'thumbnails', `${bare.job.jobId}-${bare.itemId}`)), only.publishFile);
  const drawOnBare = [{ card: 1, kind: 'made', frameId: 'f1', phrase: null, textKind: null, wordsFor: null, photo: null, adjust: {} }, { card: 2, kind: 'empty' }, { card: 3, kind: 'empty' }];
  assert.ok(/There are no thumbnails to change/.test((await rejection(bare.window.saveCards(bare.job.jobId, bare.itemId, drawOnBare))).message), 'no frames to draw on a report with no story');
}));

check('window, rewrite words for a title: one words call carrying the title on ONE held load of the 27B, no decide; pair n takes the title and the new words and answers the words to put on card n; nothing is drawn and the saved card and picks are left as they are; a second action while one runs is refused; the hold is given back', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec } = await windowOver(world);
  const { server, plainCalls } = world;
  const leasesBefore = server.leases.taken.length;
  const callsBefore = plainCalls.length;
  const decidesBefore = server.decideBodies().length;
  const drawsBefore = drawsOf(world).length;
  const picksBefore = window.view(job.jobId, itemId).picks.map((p) => p.pick);
  const running = window.pairTitle(job.jobId, itemId, 2, 'Title four', 'stakes');
  const busy = await rejection(window.saveCards(job.jobId, itemId, cardsFor(rec, [null, null, null])));
  assert.ok(/^Still writing words for this report/.test(busy.message), busy.message);
  const { view: v, text } = await running;
  const words = plainCalls.slice(callsBefore);
  assert.strictEqual(words.length, 1, 'one words call');
  assert.ok(words[0].prompt.includes('\nTitle four\n'), 'carrying the new title');
  assert.ok(words[0].job !== undefined, 'under the window\'s held job');
  assert.strictEqual(server.decideBodies().length - decidesBefore, 0, 'no tone or photo question');
  assert.deepStrictEqual(server.leases.taken.slice(leasesBefore).map((l) => l.model), ['qwen3.8-27b-8bit'], 'one lease on the 27B for the words');
  assert.deepStrictEqual(text, { kind: 'stakes', phrase: 'MAYBE TOMORROW', wordsFor: 'Title four' }, 'the words for card 2, of the kind it had');
  const p2 = v.record.pairs[1];
  assert.deepStrictEqual([p2.title, p2.words.stakes.includes('MAYBE TOMORROW')], ['Title four', true]);
  assert.deepStrictEqual([v.record.earlierWords[0].title, v.record.earlierWords[0].claim], [rec.pairs[1].title, rec.pairs[1].words.claim], 'the words pair 2 had are kept as earlier options for their title');
  assert.deepStrictEqual(p2.default, rec.pairs[1].default, 'the saved card is left as it was');
  assert.strictEqual(drawsOf(world).length, drawsBefore, 'nothing drawn');
  assert.deepStrictEqual(v.picks.map((p) => p.pick), picksBefore, 'the picks as they were');
  assert.ok(/"shout" is not a kind of words/.test((await rejection(window.pairTitle(job.jobId, itemId, 2, 'Title four', 'shout'))).message));
  assert.strictEqual(window.heldModel(), 'qwen3.8-27b-8bit');
  const released = server.leases.released.length;
  assert.strictEqual(await window.releaseHold('the window closed'), 'qwen3.8-27b-8bit');
  assert.ok(server.leases.released.length > released, 'the lease went back to the server');
  assert.strictEqual(await window.releaseHold('again'), null);
}));

check('window, no story: 2 screenshots make 2 pairs for the 2 titles given (they become the frames), a non-16:9 one cut to 16:9 and said; own picks kept; a third card can only hold his image; a report whose pairs came from its story refuses screenshots', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec } = await windowOver(world, { noStory: true });
  const { root } = world;
  const { plainCalls } = world;
  const mine = picture(path.join(root, 'Desktop', 'mine.png'), '1280x720');
  await window.saveCards(job.jobId, itemId, cardsFor(rec, [{ own: mine }]));
  const wide = picture(path.join(root, 'Desktop', 'Screenshot wide.png'), '1440x900');
  const exact = picture(path.join(root, 'Desktop', 'Screenshot exact.png'), '1280x720');
  const callsBefore = plainCalls.length;
  const v = await window.useScreenshots(job.jobId, itemId, [wide, exact], ['Title two', 'Title one']);
  const r = v.record;
  assert.strictEqual(r.state, 'made', r.line);
  assert.deepStrictEqual(r.pairs.map((p) => [p.pair, p.title, p.default.frameId]), [[1, 'Title two', 'shot1'], [2, 'Title one', 'shot2']]);
  assert.deepStrictEqual(r.frames.map((x) => x.id), ['shot1', 'shot2'], 'the screenshots are the frames');
  assert.strictEqual(r.source.video, null);
  assert.ok(r.source.lines.some((l) => /Screenshot wide\.png is 1440x900, not 16:9, so its middle was cut to 16:9/.test(l)), r.source.lines.join(' | '));
  assert.ok(r.source.lines.some((l) => /Screenshot exact\.png \(1280x720\) is used whole/.test(l)), r.source.lines.join(' | '));
  assert.deepStrictEqual(plainCalls.slice(callsBefore).filter((c) => /^thumbnail text/.test(c.what)).map((c) => c.prompt.includes('\nTitle two\n') ? 2 : c.prompt.includes('\nTitle one\n') ? 1 : 0), [2, 1], 'one words call per screenshot, each with its title');
  assert.strictEqual(r.story.state, 'none', 'the story (and why there is none) is kept');
  const probe = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', path.join(r.folder, 'full', 'shot1.png')]).toString()).streams[0];
  assert.deepStrictEqual([probe.width, probe.height], [1920, 1080], 'written 16:9 at 1920x1080');
  assert.ok(r.pairs.every((p) => p.default.render.ok && fs.existsSync(p.default.render.file) && p.default.adjust === undefined));
  assert.deepStrictEqual(v.picks.map((p) => p.pick.kind), ['own'], 'his own pick stays');
  assert.strictEqual(r.line, '2 title and thumbnail pairs are ready to pick from; no photo picked yet.');
  assert.ok(r.pairs.every((p) => p.default.photo === null), 'no photo until he picks one');
  const third = await rejection(window.saveCards(job.jobId, itemId, cardsFor(r, [null, null, { frame: 'shot1', phrase: null }])));
  assert.ok(/There is no title and thumbnail pair 3 to draw card 3 into: this report has 2\./.test(third.message), third.message);
  assert.ok(/1 to 3 screenshots/.test((await rejection(window.useScreenshots(job.jobId, itemId, [wide, exact, wide, exact], ['a', 'b', 'c', 'd']))).message));
  assert.ok(/needs a title/.test((await rejection(window.useScreenshots(job.jobId, itemId, [wide], []))).message));
  await window.releaseHold('the check moves on');
  const story = await windowOver(world);
  assert.ok(/already has thumbnails from its story/.test((await rejection(story.window.useScreenshots(story.job.jobId, story.itemId, [wide], ['Title one']))).message));
}));

/** A picture's size, read by ffprobe. */
function sizeOf(file) {
  const s = JSON.parse(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'stream=width,height', '-of', 'json', file]).toString()).streams[0];
  return [s.width, s.height];
}

/** The item's record as it is on disk NOW (the job file), not as any window holds it. */
function onDisk(out, jobId) {
  return record.readItemThumbnails(out.getJobMetadata(jobId).items[0].thumbnails, 'the keeper');
}

check('window, his images as frames: a non-16:9 PNG is cut to fill 16:9 at 1920x1080 with the grid\'s 640x360 and 320x180 JPEGs, stored as an added frame (validated, listed first, seen on reopening), put on a card and drawn from its own file; a missing added file is refused by name and never taken from the recording; bad paths refused by name; a second action while it runs refused; a report with no story gets its folder, and new screenshots keep the images', () => withWorld({}, async (world) => {
  const { out, job, itemId, window, rec } = await windowOver(world, { draw: false });
  const { root } = world;
  const shot = picture(path.join(root, 'Desktop', 'Screenshot 2026-09-29 at 10.12.44.png'), '1386x756');
  const tall = picture(path.join(root, 'Desktop', 'tall.jpg'), '600x900');
  const before = fs.readFileSync(shot);
  const extractsBefore = rec.frames.length;
  const r = await window.addFrames(job.jobId, itemId, [shot, tall]);
  assert.deepStrictEqual(r.added, ['added1', 'added2'], 'new ids, in the order given');
  assert.ok(/1386x756, not 16:9, so its middle was cut to 16:9 \(the left and right edges were left out\)/.test(r.lines[0]), r.lines[0]);
  assert.ok(/600x900, not 16:9, so its middle was cut to 16:9 \(the top and bottom edges were left out\)/.test(r.lines[1]), r.lines[1]);
  const stored = onDisk(out, job.jobId);
  const added = stored.frames.filter((f) => f.origin === 'added');
  assert.deepStrictEqual(added.map((f) => [f.id, f.from, f.t, f.scene]), [['added1', path.basename(shot), 0, 0], ['added2', 'tall.jpg', 0, 0]], 'on the record, marked as his, with the file name');
  assert.strictEqual(stored.frames.length, extractsBefore + 2, 'the story\'s frames are all still there');
  assert.deepStrictEqual(sizeOf(path.join(rec.folder, 'full', 'added1.png')), [1920, 1080], 'cut to fill 16:9 and written at 1920x1080');
  assert.deepStrictEqual([sizeOf(added[0].large), sizeOf(added[0].small)], [[640, 360], [320, 180]], 'the grid\'s two JPEGs, as the sampler writes them');
  assert.ok(added.every((f) => f.large.endsWith('.jpg') && fs.existsSync(f.large) && fs.existsSync(f.small)));
  assert.ok(fs.readFileSync(shot).equals(before) && fs.existsSync(shot), 'his file is only read');
  assert.ok(stored.lines.some((l) => /^Your image added1: /.test(l)), 'the crop said on the record');
  // Reopening: the view shows them first, with their pictures.
  const again = window.view(job.jobId, itemId);
  assert.ok(again.frames.added1 && again.frames.added2, 'their small pictures are in the view');
  assert.deepStrictEqual(compose.frameList(again.record).slice(0, 2), ['added1', 'added2'], 'listed first in the Frames tray');
  assert.deepStrictEqual(compose.frameList(again.record).slice(2), [...rec.frames].sort((a, b) => a.t - b.t).map((f) => f.id), 'the story\'s frames after them, in time order');
  // The preview reads the added file itself; a card drawn on it draws that file.
  const fd = await window.frameDetail(job.jobId, itemId, 'added1');
  assert.strictEqual(fd.picture, 'picture of added1.png');
  const saved = await window.saveCards(job.jobId, itemId, cardsFor(rec, [{ frame: 'added1' }, null, null]));
  assert.strictEqual(drawsOf(world).pop().frame, path.join(rec.folder, 'full', 'added1.png'), 'drawn from his image');
  assert.deepStrictEqual([saved.record.pairs[0].default.frameId, saved.record.pairs[0].default.scene, saved.picks.length], ['added1', null, 1], 'saved as pick 1, no scene');
  assert.ok(compose.cardsFromView(saved)[0].frameId === 'added1', 'read back on its card');
  // Its file gone: refused by name; nothing is extracted from the recording at its time.
  fs.rmSync(path.join(rec.folder, 'full', 'added2.png'));
  const gone = await rejection(window.frameDetail(job.jobId, itemId, 'added2'));
  assert.ok(/^The image you added \(added2\) is not in .*full any more\. Add it again\.$/.test(gone.message), gone.message);
  assert.ok(!fs.existsSync(path.join(rec.folder, 'full', 'added2.png')), 'not taken from the screen recording');
  const goneSave = await rejection(window.saveCards(job.jobId, itemId, cardsFor(rec, [{ frame: 'added2' }, null, null])));
  assert.ok(/Thumbnail 1 could not be drawn, so nothing was saved: The image you added \(added2\)/.test(goneSave.message), goneSave.message);
  // Bad paths, by name; nothing added.
  const gif = path.join(root, 'Desktop', 'funny.gif');
  fs.writeFileSync(gif, 'GIF89a');
  const heic = path.join(root, 'Desktop', 'IMG_0001.HEIC');
  fs.writeFileSync(heic, 'heic');
  for (const [files, re] of [
    [[], /Give at least one image to add/],
    ['nope.png', /Give at least one image to add/],
    [['relative.png'], /must be a file on this Mac, got "relative\.png"/],
    [[path.join(root, 'Desktop', 'missing.png')], /missing\.png is not a file on this Mac/],
    [[path.join(root, 'Desktop')], /Desktop is not a file on this Mac/],
    [[gif], /funny\.gif is not a PNG or JPEG/],
    [[heic], /IMG_0001\.HEIC is not a PNG or JPEG/],
    [[shot, gif], /funny\.gif is not a PNG or JPEG/],
  ]) {
    assert.ok(re.test((await rejection(window.addFrames(job.jobId, itemId, files))).message), `${JSON.stringify(files)} refused as ${re}`);
  }
  assert.strictEqual(onDisk(out, job.jobId).frames.filter((f) => f.origin === 'added').length, 2, 'nothing added by a refused call');
  // An unreadable image stops the call by name, and nothing of it is left behind.
  const broken = path.join(root, 'Desktop', 'broken.png');
  fs.writeFileSync(broken, 'not a picture');
  const bad = await rejection(window.addFrames(job.jobId, itemId, [shot, broken]));
  assert.ok(/broken\.png/.test(bad.message), bad.message);
  assert.ok(!fs.existsSync(path.join(rec.folder, 'full', 'added3.png')) && !fs.existsSync(path.join(rec.folder, 'added', 'added3.jpg')), 'the first file of the refused call is not left on disk');
  // One action per item.
  world.server.inject({ chatDelayMs: 300 });
  const words = window.writeWords(job.jobId, itemId, 1, 'more');
  const busy = await rejection(window.addFrames(job.jobId, itemId, [shot]));
  assert.ok(/^Still writing words for this report/.test(busy.message), busy.message);
  await words;
  world.server.inject({});
  // A stored frame of an unknown origin, or an added one with no name, is refused on reading.
  assert.throws(() => record.readItemThumbnails({ ...stored, frames: [{ ...added[0], origin: 'pasted' }] }, 'keeper'), /holds frame added1 of an unknown origin "pasted"/);
  assert.throws(() => record.readItemThumbnails({ ...stored, frames: [{ ...added[0], from: undefined }] }, 'keeper'), /holds the added image added1 with no file name/);
  assert.throws(() => record.readItemThumbnails({ ...stored, frames: [added[0], added[0]] }, 'keeper'), /holds one frame id twice/);
  // A report with no story and no folder: the folder is made where screenshots would make it, and
  // new screenshots keep his images (listed first), the pairs drawn on the screenshots only.
  const bare = await windowOver(world, { noStory: true });
  const b1 = await bare.window.addFrames(bare.job.jobId, bare.itemId, [shot]);
  const folder = path.join(bare.job.txtFolder, 'thumbnails', `${bare.job.jobId}-${bare.itemId}`);
  assert.deepStrictEqual([b1.view.record.state, b1.view.record.folder, b1.added], ['no-story', folder, ['added1']]);
  assert.ok(fs.existsSync(path.join(folder, 'full', 'added1.png')));
  const exact = picture(path.join(root, 'Desktop', 'Screenshot exact.png'), '1280x720');
  const withShots = await bare.window.useScreenshots(bare.job.jobId, bare.itemId, [exact], ['Title one']);
  assert.deepStrictEqual(withShots.record.frames.map((f) => [f.id, f.origin ?? null]), [['shot1', null], ['added1', 'added']], 'the screenshot and his image');
  assert.deepStrictEqual(withShots.record.pairs.map((p) => p.default.frameId), ['shot1'], 'the pair is on the screenshot, not his image');
  assert.ok(fs.existsSync(path.join(folder, 'full', 'added1.png')) && fs.existsSync(path.join(folder, 'added', 'added1.jpg')), 'his image\'s files stay');
  assert.deepStrictEqual(compose.frameList(withShots.record), ['added1', 'shot1']);
  const b2 = await bare.window.addFrames(bare.job.jobId, bare.itemId, [tall]);
  assert.deepStrictEqual(b2.added, ['added2'], 'a new id, never one the record holds');
  const onShots = await bare.window.saveCards(bare.job.jobId, bare.itemId, cardsFor(withShots.record, [{ frame: 'added2', phrase: null }, null, null]));
  assert.strictEqual(onShots.record.pairs[0].default.frameId, 'added2', 'his image on the screenshot report\'s card');
  // The finish plan of a screenshots record puts pair n on screenshot n, never on his image.
  const plan = pipeline.resumePlan({ ...onShots.record, state: 'failed', failure: { stage: 'render', reason: 'x' } }, fs.existsSync);
  assert.ok(plan.keep.includes('frames'), JSON.stringify(plan));
  await bare.window.releaseHold('the check moves on');
  await window.releaseHold('the check moves on');
  // A record that is not ready refuses (it is prepared first).
  const failed = await windowOver(world, { record: { ...rec, state: 'failed', failure: { stage: 'words', reason: 'x' }, line: 'The thumbnails stopped at the words stage: x' } });
  assert.ok(/not ready yet; they are prepared first/.test((await rejection(failed.window.addFrames(failed.job.jobId, failed.itemId, [shot]))).message));
}));

check('window, the words are kept: New options and More options are in the report before any save (read from the job file); New puts a fresh set first and keeps the old one; More shows the model every line already written for the title and adds none twice; closing the window mid-run neither stops the run nor gives the model back under it, and the model goes back after; a window opened meanwhile sees it running; a line on a card never disappears', () => withWorld({
  fake: {
    chatReplies: {
      'qwen3.8-27b-8bit': (body) => {
        const prompt = JSON.stringify(body);
        if (/already written for this title/.test(prompt)) return { content: 'CLAIM\nTHE RAPTURE IS HERE\nSHE PICKED A DATE\nSTAKES\nTHE DATE CAME TWICE\nREACTION\nOH NO\nNOT AGAIN', finishReason: 'stop' };
        if (/Title one/.test(prompt) && /NEWSET/.test(process.env.KEEPER_WORDS ?? '')) return { content: 'CLAIM\nA FRESH CLAIM\nSTAKES\nA FRESH STAKE\nREACTION\nA FRESH GASP', finishReason: 'stop' };
        return { content: WORDS_REPLY, finishReason: 'stop' };
      },
    },
  },
}, async (world) => {
  const { out, job, itemId, window, rec, pieces } = await windowOver(world, { draw: false });
  const { server, plainCalls } = world;
  const pair1 = rec.pairs[0];
  // A line of pair 1 saved on card 1.
  const onCard = compose.textOptions(rec.pairs).find((o) => o.pair === 1 && o.phrase === 'DONT STAND UNDER A ROOF');
  let cards = compose.toggleFrame(compose.emptyCards(), 1, rec.frames[0].id);
  cards = compose.toggleText(cards, 1, onCard);
  await window.saveCards(job.jobId, itemId, compose.cardRequests(cards, rec.pairs));

  // NEW OPTIONS: a fresh set first, the old one kept for its title; in the job file before any save.
  process.env.KEEPER_WORDS = 'NEWSET';
  const n1 = await window.writeWords(job.jobId, itemId, 1, 'new');
  delete process.env.KEEPER_WORDS;
  const afterNew = onDisk(out, job.jobId);
  assert.deepStrictEqual(afterNew.pairs[0].words.claim, ['A FRESH CLAIM'], 'the fresh set is pair 1\'s words, in the report at once');
  assert.deepStrictEqual([afterNew.earlierWords[0].title, afterNew.earlierWords[0].claim], [pair1.title, pair1.words.claim], 'the set it had is kept, for its title');
  assert.ok(/new options for “Title one” on qwen3\.8-27b-8bit; the earlier ones are kept below them\./.test(n1.line), n1.line);
  const groups = compose.textGroups(afterNew.pairs, afterNew.earlierWords);
  const g1 = groups.find((g) => g.pair === 1);
  assert.deepStrictEqual([g1.title, g1.current.map((o) => o.phrase), g1.earlier.some((o) => o.phrase === 'DONT STAND UNDER A ROOF')], ['Title one', ['A FRESH CLAIM', 'A FRESH STAKE', 'A FRESH GASP'], true], 'the tray: the fresh set first, the old one under Earlier options');
  const all = compose.textOptions(afterNew.pairs, afterNew.earlierWords);
  assert.strictEqual(new Set(all.map((o) => o.key)).size, all.length, 'each line once');
  // The line on card 1 is still offered and still read onto the card.
  assert.ok(all.some((o) => o.key === onCard.key), 'the line on a card never disappears');
  const readBack = compose.cardsFromView(window.view(job.jobId, itemId));
  assert.deepStrictEqual([readBack[0].text.key, readBack[0].text.kind], [onCard.key, 'claim']);
  assert.deepStrictEqual(compose.unsavedCards(readBack, readBack), []);

  // MORE OPTIONS: the model is shown every line written for the title; the new lines are added, none twice.
  const callsBefore = plainCalls.length;
  const m1 = await window.writeWords(job.jobId, itemId, 1, 'more');
  const prompt = plainCalls[callsBefore].prompt;
  assert.ok(/These options were already written for this title\./.test(prompt), 'the more paragraph is in the prompt');
  for (const l of ['A FRESH CLAIM', 'DONT STAND UNDER A ROOF', 'SHE MEANS IT']) assert.ok(prompt.includes(`\n${l}\n`) || prompt.endsWith(`\n${l}`) || prompt.includes(`\n${l}\n\n`), `the prompt lists ${l}`);
  assert.ok(prompt.indexOf('already written') < prompt.indexOf('Answer in exactly this shape'), 'before the answer\'s shape');
  const afterMore = onDisk(out, job.jobId);
  assert.deepStrictEqual(afterMore.pairs[0].words.claim, ['A FRESH CLAIM', 'SHE PICKED A DATE'], 'THE RAPTURE IS HERE was written before: not added twice');
  assert.deepStrictEqual(afterMore.pairs[0].words.stakes, ['A FRESH STAKE', 'THE DATE CAME TWICE']);
  assert.deepStrictEqual(afterMore.pairs[0].words.reaction, ['A FRESH GASP', 'NOT AGAIN'], 'OH NO was written before');
  assert.strictEqual(afterMore.earlierWords.length, 1, 'More keeps the sets as they are');
  assert.ok(/^3 more options for “Title one” on qwen3\.8-27b-8bit \(2 it repeated were left out\)\.$/.test(m1.line), m1.line);
  // Once every line comes back repeated, it says so and adds nothing.
  const m2 = await window.writeWords(job.jobId, itemId, 1, 'more');
  assert.ok(/The model wrote nothing new for “Title one”: all 5 of its lines were already there\./.test(m2.line), m2.line);
  assert.ok(/Ask for "new" or "more" options/.test((await rejection(window.writeWords(job.jobId, itemId, 1, 'again'))).message));
  assert.ok(/There is no title and thumbnail pair 7/.test((await rejection(window.writeWords(job.jobId, itemId, 7, 'new'))).message));

  // CLOSING MID-RUN: the run goes on and saves; the model is given back only after it.
  await window.releaseHold('the check starts the close');
  const releasedBefore = server.leases.released.length;
  server.inject({ chatDelayMs: 400 });
  const running = window.writeWords(job.jobId, itemId, 2, 'new');
  await new Promise((resolve) => setTimeout(resolve, 150));
  assert.strictEqual(window.running(job.jobId, itemId), 'writing words', 'a window opened now sees it running');
  assert.strictEqual(window.view(job.jobId, itemId).running, 'writing words');
  const closedBefore = pieces.asked.closed;
  assert.strictEqual(await window.closed(), null, 'closing gives nothing back while the words are written');
  assert.strictEqual(pieces.asked.closed, closedBefore + 1, 'the face search\'s page goes at once');
  assert.strictEqual(server.leases.released.length, releasedBefore, 'the lease is not given back under the running request');
  assert.strictEqual(window.heldModel(), 'qwen3.8-27b-8bit');
  const done = await running;
  server.inject({});
  assert.ok(/new options for “Title two”/.test(done.line), done.line);
  assert.deepStrictEqual(onDisk(out, job.jobId).earlierWords.map((e) => e.title), [rec.pairs[1].title, 'Title one'], 'the run finished and saved after the window closed, the old set kept');
  assert.strictEqual(window.running(job.jobId, itemId), null);
  assert.ok(server.leases.released.length > releasedBefore, 'the model went back after the run');
  assert.strictEqual(window.heldModel(), null);
  // Quitting the app gives it back at once, whatever runs.
  await window.writeWords(job.jobId, itemId, 3, 'more');
  assert.strictEqual(await window.quit(), 'qwen3.8-27b-8bit');

  // The prompt without earlier lines is exactly the one without the paragraph.
  const prompts = services('thumbnails/prompts.js');
  const base = { channel: 'C', creator: 'Owen', title: 'T', transcript: ['[0:00] a line'] };
  const plain = prompts.buildWordsPrompt(base);
  assert.ok(!/already written|\{more\}/.test(plain), 'no paragraph, no slot left');
  assert.strictEqual(prompts.buildWordsPrompt({ ...base, avoid: [] }), plain);
  assert.ok(plain.includes("Example: SHE'S SERIOUS\n\nAnswer in exactly this shape"), 'the words before the shape as they were');
  const more = prompts.buildWordsPrompt({ ...base, avoid: ['ONE $1 LINE', 'ONE $1 LINE', 'TWO'] });
  assert.ok(more.includes("SHE'S SERIOUS\n\nThese options were already written for this title.") && more.includes('\nONE $1 LINE\nTWO\n\nAnswer in exactly this shape'), 'the paragraph, each line once, a $ kept as written');
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

// ── the window's card rules (frontend thumbnails-compose.ts) ──────────────────

/** The compiled shared layout, handed to the window's rules for './thumbnail-shared' (what the app's build resolves). */
const shared = { ...require(path.join(DIST, 'shared', 'thumbnail-layout.js')), ...require(path.join(DIST, 'shared', 'thumbnail-draw.js')) };

/** The window's card rules (frontend thumbnails-compose.ts), transpiled; its one runtime import is the shared layout. */
const compose = (() => {
  const ts = require('typescript');
  const src = path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-compose.ts');
  const out = ts.transpileModule(fs.readFileSync(src, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: src });
  const mod = { exports: {} };
  const req = (name) => {
    if (name === './thumbnail-shared') return shared;
    throw new Error(`thumbnails-compose.ts imports ${name} at run time; the keeper hands it only the shared layout`);
  };
  new Function('exports', 'module', 'require', out.outputText)(mod.exports, mod, req);
  return mod.exports;
})();

const loadsOf = (server) => server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b.type === 'load-model').map((b) => b.model);

/**
 * A record as Owen's first run left it (2026-09-29): stopped at the since-removed tone-photos stage
 * on an empty photo library, with its story, frames, scores and words stored and nothing drawn.
 */
function stoppedAtTonePhotos(rec) {
  const old = JSON.parse(JSON.stringify(rec));
  const reason = 'The app\'s reaction photo library has no photos, and ranking them needs at least 2. Add your reaction photos in Thumbnail look (the "Thumbnail look…" button in the Thumbnails window on the reports page, or Settings › Thumbnails).';
  Object.assign(old, { state: 'failed', failure: { stage: 'tone-photos', reason }, line: `The thumbnails stopped at the tone-photos stage: ${reason}`, tone: null, seed: null, picks: [] });
  old.timings = old.timings.filter((t) => t.stage !== 'render').concat([{ stage: 'tone-photos', seconds: 0 }]);
  for (const p of old.pairs) {
    p.photos = [];
    p.default.photo = null;
    p.default.draw = null;
    p.default.render = { ok: false, reason: 'Not drawn yet.' };
    delete p.default.adjust;
    p.lines = p.lines.filter((l) => l !== pipeline.NO_PHOTO_YET);
  }
  return old;
}

check('errors reach the window: a record stopped at a removed stage (tone-photos, scoring) is read and shown as not finished, the step unnamed; with no Crucible server preparing is blocked with the reason and refused before any model call; a failed action becomes a banner line naming it; every window call goes through the runner and every channel answers { ok, error }', () => withWorld({}, async (world) => {
  const { server, plainCalls } = world;
  const made = await windowOver(world);
  const old = stoppedAtTonePhotos(made.rec);
  assert.strictEqual(record.readItemThumbnails(old, 'keeper').failure.stage, 'tone-photos', 'an older record naming the retired stage is still read');
  const { job, itemId, window } = await windowOver(world, { record: old });
  const v = window.view(job.jobId, itemId);
  assert.deepStrictEqual([v.finish.stage, v.finish.keep, v.finish.run, v.finish.blocked], ['tone-photos', ['story', 'frames', 'words'], ['render'], null]);
  assert.ok(v.finish.reason === null && v.finish.retired === true, 'a removed stage is not named, and its old reason is not shown');
  // A card saved on it: refused in words, and those words are the banner.
  const drawErr = await rejection(window.saveCards(job.jobId, itemId, cardsFor(old, [{ frame: old.frames[0].id }, null, null])));
  assert.ok(/There are no thumbnails to change: The thumbnails stopped at the tone-photos stage/.test(drawErr.message), drawErr.message);
  // Stopped at the scoring with no Crucible server: preparing says why it cannot run, and is refused before any model call.
  const atScoring = JSON.parse(JSON.stringify(old));
  Object.assign(atScoring, { failure: { stage: 'scoring', reason: '"mac" cannot show pictures yet' }, line: 'The thumbnails stopped at the scoring stage.', scoring: null, pairs: [], titles: null });
  const noServer = await windowOver(world, { record: atScoring, gpuVenue: () => ({ server: null, reason: 'no Crucible server is selected in Settings' }) });
  const blocked = noServer.window.view(noServer.job.jobId, noServer.itemId);
  assert.deepStrictEqual([blocked.finish.stage, blocked.finish.keep, blocked.finish.run], ['scoring', ['story', 'frames'], ['words', 'render']], 'a stop at the removed scoring keeps its frames and goes on from the words');
  assert.ok(blocked.finish.reason === null && blocked.finish.retired === true, 'the refused vision model is not repeated');
  assert.strictEqual(blocked.finish.blocked, 'No Crucible server to run the models on: no Crucible server is selected in Settings');
  const before = [plainCalls.length, server.decideBodies().length, server.leases.taken.length];
  const refused = await rejection(noServer.window.finish(noServer.job.jobId, noServer.itemId));
  assert.ok(/No Crucible server/.test(refused.message), refused.message);
  assert.deepStrictEqual([plainCalls.length, server.decideBodies().length, server.leases.taken.length], before, 'refused before any model was called or leased');
  const seen = { busy: [], failed: [] };
  const runner = new compose.ActionRunner({ busy: (b) => seen.busy.push(b && b.what), failed: (line) => seen.failed.push(line) }, () => 1000);
  const [a, b] = await Promise.all([runner.run('Saving the thumbnails', async () => { throw drawErr; }), runner.run('Reading the thumbnails', async () => 'read')]);
  assert.deepStrictEqual([a, b], [null, 'read']);
  assert.deepStrictEqual(seen.failed, [`Saving the thumbnails failed: ${drawErr.message}`], 'the failure is a line naming what failed, with the main process\'s sentence');
  assert.deepStrictEqual(seen.busy, ['Saving the thumbnails', null, 'Reading the thumbnails', null], 'one action at a time, in order, the busy line cleared after each');
  assert.strictEqual(compose.clockOf(83_400), '1:23');
  // Every call the window makes goes through the runner (act() is the runner), except telling the main process it closed.
  const win = fs.readFileSync(path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-window.ts'), 'utf8');
  // waitForRun (a reopened window waiting for a step an earlier one started) polls inside the runner.
  const waitBody = win.slice(win.indexOf('private async waitForRun('), win.indexOf('\n  }\n', win.indexOf('private async waitForRun(')));
  assert.ok(/this\.runner\.run\(`Still \$\{view\.running\}[^`]*`, \(\) => this\.waitForRun\(\)\)/.test(win) && win.split('this.waitForRun()').length === 2, 'waitForRun runs only through the runner');
  const calls = win.replace(waitBody, '').split('\n').filter((l) => /this\.electron\.thumbnails[A-Z]/.test(l));
  assert.ok(calls.length >= 10, `${calls.length} calls found`);
  for (const l of calls) assert.ok(/this\.act\(|this\.runner\.run\(/.test(l) || /thumbnailsClosed/.test(l), `a window call outside the runner: ${l.trim()}`);
  // The preview's own fetches fail onto the card that asked (paint catches, the card says why).
  const win2 = win.slice(win.indexOf('private async paint('), win.indexOf('private async act('));
  assert.ok(/catch \(err\) \{\s*set\(this\.cardError, \(err as Error\)\.message\);/.test(win2), 'a preview that cannot be drawn says why on its card');
  const html = fs.readFileSync(path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-window.html'), 'utf8');
  assert.ok(/@if \(failure\(\); as f\)/.test(html) && /class="status"/.test(html) && /elapsed\(\)/.test(html), 'the sticky status shows the failure, the running step and its clock');
  assert.ok(/fin\.blocked/.test(html) && /Try again/.test(html) && !/Finish making thumbnails/.test(html) && !/again from scratch/.test(html), 'the not-ready banner says why it cannot be prepared and offers Try again; no Finish, no from scratch');
  assert.ok(/view\.finish !== null && view\.finish\.blocked === null\) await this\.prepare\(\)/.test(win), 'a video that is not ready is prepared on opening');
  assert.ok(/Click a thumbnail, then click a frame, text and photo below to put them on it\. Click one again to take it off\./.test(html), 'the one line saying what to do');
  assert.ok(/This thumbnail cannot be drawn: \{\{ e \}\}/.test(html) && /saveFailed\(\)\[n\]/.test(html), 'a card says when it cannot be drawn, and when its save failed');
  const ipc = fs.readFileSync(path.join(REPO, 'electron/services/thumbnails/thumbnails-ipc.ts'), 'utf8');
  const handlers = ipc.split(/\n\s*ipcMain\.handle\(/).slice(1);
  assert.ok(handlers.length >= 20);
  for (const h of handlers) assert.ok(/answer\(/.test(h.split(/\n\s*\/\/ /)[0]), `a thumbnails channel that does not answer { ok, error }: ${h.slice(0, 60)}`);
}));

check('finish: a record stopped at the removed tone-photos stage is prepared from what it stores (no word written, no decide, no lease), its story pairs left without the frames the old ranking gave them; made; own picks stay; a screenshots record stopped at render draws only; the plans', () => withWorld({}, async (world) => {
  const { server, plainCalls, root } = world;
  const made = await windowOver(world);
  const old = stoppedAtTonePhotos(made.rec);
  const { job, itemId, window, rec } = await windowOver(world, { record: old });
  const mine = picture(path.join(root, 'Desktop', 'mine.png'), '1280x720');
  await window.saveCards(job.jobId, itemId, cardsFor(old, [{ own: mine }, null, null]));
  const before = { plain: plainCalls.length, decides: server.decideBodies().length, loads: loadsOf(server).length, leases: server.leases.taken.length };
  const drawsBefore = world.renders.length;
  const v = await window.finish(job.jobId, itemId);
  const r = v.record;
  assert.strictEqual(r.state, 'made', r.line);
  assert.strictEqual(r.line, '3 title and thumbnail pairs have their words; pick the frames and photos in the Thumbnails window.');
  assert.deepStrictEqual(r.frames.map((f) => f.id), rec.frames.map((f) => f.id), 'the frames as stored');
  assert.deepStrictEqual(r.pairs.map((p) => p.words), rec.pairs.map((p) => p.words), 'the words as stored');
  assert.deepStrictEqual([plainCalls.length, server.decideBodies().length, loadsOf(server).length, server.leases.taken.length], [before.plain, before.decides, before.loads, before.leases], 'no model call, no load, no lease');
  assert.strictEqual(world.renders.length, drawsBefore, 'nothing drawn: no pair has a frame until Owen picks');
  assert.ok(r.pairs.every((p) => p.default.frameId === null && !p.default.render.ok && p.default.photo === null && p.lines.includes(pipeline.NO_FRAME_YET) && p.lines.includes(pipeline.NO_PHOTO_YET)), 'no frame, not drawn, no photo, said');
  assert.ok(r.lines.some((l) => l === 'Finished in the Thumbnails window after stopping at the tone-photos stage: story, frames, words kept as stored; render run.'), r.lines.join(' | '));
  assert.deepStrictEqual(r.timings.map((t) => t.stage), ['story', 'frames', 'words', 'tone-photos', 'render'], 'the stopped attempt\'s timings, then the render stage');
  assert.deepStrictEqual([v.finish, v.picks.map((p) => p.pick.kind)], [null, ['own']], 'nothing left to prepare; his own pick stays');
  assert.ok(/Nothing stopped/.test((await rejection(window.finish(job.jobId, itemId))).message));
  // A screenshots record stopped at the render: only the drawing runs, no model at all.
  const bare = await windowOver(world, { noStory: true });
  const shotA = picture(path.join(root, 'Desktop', 'Screenshot a.png'), '1280x720');
  const shotB = picture(path.join(root, 'Desktop', 'Screenshot b.png'), '1280x720');
  const fromShots = (await bare.window.useScreenshots(bare.job.jobId, bare.itemId, [shotA, shotB], ['Title one', 'Title two'])).record;
  await bare.window.releaseHold('the check moves on');
  const atRender = JSON.parse(JSON.stringify(fromShots));
  Object.assign(atRender, { state: 'failed', failure: { stage: 'render', reason: 'the canvas page closed' }, line: 'The thumbnails stopped at the render stage: the canvas page closed', picks: [] });
  for (const p of atRender.pairs) p.default.render = { ok: false, reason: 'Not drawn yet.' };
  const second = await windowOver(world, { record: atRender });
  const quiet = [plainCalls.length, server.decideBodies().length];
  const drawnOnly = await second.window.finish(second.job.jobId, second.itemId);
  assert.strictEqual(drawnOnly.record.state, 'made', drawnOnly.record.line);
  assert.deepStrictEqual(drawnOnly.record.pairs.map((p) => [p.default.frameId, p.default.render.ok]), [['shot1', true], ['shot2', true]], 'each screenshot drawn again on its own pair');
  assert.deepStrictEqual([plainCalls.length, server.decideBodies().length], quiet, 'no model call to draw');
  // The plans.
  const exists = () => true;
  assert.deepStrictEqual(pipeline.resumePlan(atRender, exists), { keep: ['story', 'frames', 'words'], run: ['render'] });
  const atWords = { ...atRender, failure: { stage: 'words', reason: 'x' }, pairs: [], titles: null };
  assert.deepStrictEqual(pipeline.resumePlan(atWords, exists), { keep: ['story', 'frames'], run: ['words', 'render'] }, 'screenshots keep their backgrounds');
  assert.deepStrictEqual(pipeline.resumePlan(fromShots, (f) => f !== fromShots.pairs[1].default.render.file).run, ['render'], 'a render file gone from disk is drawn again');
  const storyAtScoring = { ...r, state: 'failed', failure: { stage: 'scoring', reason: 'x' }, pairs: [], titles: null };
  assert.deepStrictEqual(pipeline.resumePlan(storyAtScoring, exists), { keep: ['story', 'frames'], run: ['words', 'render'] }, 'a stop at the removed scoring keeps its frames as the grid');
  assert.deepStrictEqual(pipeline.resumePlan(r, exists), { keep: ['story', 'frames', 'words', 'render'], run: [] }, 'a story record with no frame picked is complete: nothing to draw until Owen picks');
}));

check('cards: a click puts a frame, text or photo on the ACTIVE card (replacing what it had) and a second click takes it off; the same item on several cards (the tray\'s badges); a new frame starts unzoomed, a new photo keeps the place, words and photo taken off drop their edits; his own image replaces a card and a tray click brings frames back; the editor\'s edits are checked', () => {
  const c = compose;
  const text = (phrase, wordsFor = 'Title one', kind = 'claim') => ({ key: `for|${wordsFor}|${phrase}`, phrase, kind, wordsFor, pair: 1 });
  let cards = c.emptyCards();
  assert.deepStrictEqual(cards.map((x) => x.n), [1, 2, 3]);
  cards = c.toggleFrame(cards, 1, 'f1');
  cards = c.toggleText(cards, 1, text('A'));
  cards = c.togglePhoto(cards, 1, 'laugh');
  assert.deepStrictEqual([cards[0].frameId, cards[0].text.phrase, cards[0].photo, cards[1].frameId], ['f1', 'A', 'laugh', null], 'on card 1 only');
  cards = c.toggleFrame(cards, 2, 'f1');
  cards = c.toggleText(cards, 3, text('A'));
  assert.deepStrictEqual([c.cardsUsing(cards, (x) => x.frameId === 'f1'), c.cardsUsing(cards, (x) => x.text?.key === text('A').key), c.cardsUsing(cards, (x) => x.photo === 'laugh')], [[1, 2], [1, 3], [1]], 'one frame and one line on two cards');
  assert.strictEqual(c.toggleFrame(cards, 1, 'f1')[0].frameId, null, 'clicking what the card has takes it off');
  assert.strictEqual(c.toggleText(cards, 1, text('A'))[0].text, null);
  assert.strictEqual(c.togglePhoto(cards, 1, 'laugh')[0].photo, null);
  assert.strictEqual(c.toggleText(cards, 1, text('B'))[0].text.phrase, 'B', 'another line replaces it');
  // Edits follow the pieces.
  cards = c.setAdjust(cards, 1, { frame: { x: -0.2, y: -0.1, scale: 1.5 }, text: { x: 0.1, y: 0.1, w: 0.4, h: 0.2 }, photo: { cx: 0.2, cy: 0.7, h: 0.4 } });
  assert.deepStrictEqual(Object.keys(c.toggleFrame(cards, 1, 'f2')[0].adjust).sort(), ['photo', 'text'], 'a new frame starts unzoomed');
  assert.deepStrictEqual(Object.keys(c.togglePhoto(cards, 1, 'ooh')[0].adjust).sort(), ['frame', 'photo', 'text'], 'another photo keeps the place');
  assert.deepStrictEqual(Object.keys(c.togglePhoto(cards, 1, 'laugh')[0].adjust).sort(), ['frame', 'text'], 'the photo off: its place goes');
  assert.deepStrictEqual(Object.keys(c.toggleText(cards, 1, text('A'))[0].adjust).sort(), ['frame', 'photo'], 'the words off: their box goes');
  assert.deepStrictEqual(Object.keys(c.toggleText(cards, 1, text('C'))[0].adjust).sort(), ['frame', 'photo', 'text'], 'other words keep the box');
  assert.throws(() => c.setAdjust(cards, 2, { photo: { cx: 0.5, cy: 0.5, h: 0.4 } }), /Thumbnail 2 has no photo to place/);
  assert.throws(() => c.setAdjust(cards, 3, { frame: { x: 0, y: 0, scale: 1 } }), /Thumbnail 3 has no frame to zoom/);
  assert.throws(() => c.setAdjust(cards, 1, { frame: { x: 0, y: 0, scale: 50 } }), /Thumbnail 1: the frame's zoom is 50/);
  // An old own-image pick read onto card 2 (nothing makes a new one).
  assert.strictEqual(c.setOwn, undefined, 'no way to put a new own image on a card');
  const own = cards.map((x) => (x.n === 2 ? { ...c.emptyCard(2), own: { file: '/Users/owen/mine.png', picture: 'pic' } } : x));
  assert.deepStrictEqual(c.cardsUsing(own, (x) => x.frameId === 'f1'), [1], 'a card with his image uses no frame');
  const back = c.toggleFrame(own, 2, 'f3');
  assert.deepStrictEqual([back[1].own, back[1].frameId], [null, 'f3'], 'a tray click puts it back to frames');
  // An image dropped on a card: putFrame puts it there whatever the card had, never taking it off.
  const dropped = c.putFrame(cards, 1, 'added1');
  assert.deepStrictEqual([dropped[0].frameId, dropped[0].text.phrase, Object.keys(dropped[0].adjust).sort()], ['added1', cards[0].text.phrase, ['photo', 'text']], 'the frame replaced, unzoomed; words and photo kept');
  assert.strictEqual(c.putFrame(dropped, 1, 'added1')[0].frameId, 'added1', 'dropping the same frame again keeps it on');
  assert.deepStrictEqual([c.putFrame(own, 2, 'added1')[1].own, c.putFrame(own, 2, 'added1')[1].frameId], [null, 'added1'], 'an old own image gives way to the dropped frame');
  assert.deepStrictEqual(c.clearCard(cards, 1)[0], c.emptyCard(1));
  assert.throws(() => c.toggleFrame(cards, 4, 'f1'), /There is no thumbnail 4/);
  // The editor's arithmetic keeps within the limits a save accepts.
  const zoomed = c.zoomFrame({ x: 0, y: 0, scale: 1 }, 2, 0.5, 0.5);
  assert.deepStrictEqual(zoomed, { scale: 2, x: -0.5, y: -0.5 }, 'zoomed about the point under the pointer');
  assert.deepStrictEqual(c.zoomFrame(zoomed, 100, 0.5, 0.5).scale, shared.FRAME_SCALE_MAX);
  assert.deepStrictEqual(c.clampFrame({ x: 5, y: -9, scale: 1 }), { scale: 1, x: 1 - shared.FRAME_MIN_COVER, y: shared.FRAME_MIN_COVER - 1 });
  assert.deepStrictEqual(c.scaleBox({ x: 0.1, y: 0.1, w: 0.2, h: 0.2 }, 2), { w: 0.4, h: 0.4, x: 0, y: 0 });
  assert.deepStrictEqual(c.clampBox({ x: 0.9, y: 0.95, w: 0.5, h: 0.2 }), { w: 0.5, h: 0.2, x: 0.5, y: 0.8 });
  assert.deepStrictEqual(c.clampPhoto({ cx: -1, cy: 2, h: 9 }), { cx: 0, cy: 1, h: shared.PHOTO_HEIGHT_MAX });
  for (const a of [zoomed, c.clampFrame({ x: 5, y: -9, scale: 1 })]) shared.validateAdjust({ frame: a }, 'keeper');
});

check('cards saved and read back: a card with a frame is saved, his image too, a card with no frame is left out (said) and the rest close up (pick k goes with title k, chosen titles first); the cards the window sends are what the main process stores, and read back equal (nothing unsaved); a change is unsaved; old picks (an own image by position) are read where they sat; two picks on one card refused; the words\' title mismatch offered only against a chosen title', () => withWorld({}, async (world) => {
  const c = compose;
  const { job, itemId, window, rec, runRec } = await windowOver(world, { draw: false });
  const pairs = rec.pairs;
  // A report opened for the first time: the run's suggested words on frameless pairs are not a card's content.
  assert.deepStrictEqual(c.cardsFromView(window.view(job.jobId, itemId)), c.emptyCards(), 'the cards start empty');
  const options = c.textOptions(pairs);
  assert.ok(options.every((o) => o.kind !== null && typeof o.wordsFor === 'string'), 'every generated line says its kind and its title');
  const fromTitleTwo = options.find((o) => o.wordsFor === 'Title two' && o.phrase === 'MAYBE TOMORROW');
  const list = c.frameList(rec);
  assert.deepStrictEqual(list, [...rec.frames].sort((a, b) => a.t - b.t).map((f) => f.id), 'every candidate, in time order');
  assert.deepStrictEqual(c.frameList({ frames: [{ id: 'shot2', t: 0 }, { id: 'shot1', t: 0 }] }), ['shot2', 'shot1'], 'screenshots keep their own order');
  let cards = c.emptyCards();
  cards = c.toggleFrame(cards, 1, list[2]);
  cards = c.toggleText(cards, 1, fromTitleTwo);
  cards = c.togglePhoto(cards, 1, 'laugh');
  cards = c.setAdjust(cards, 1, { text: { x: 0.05, y: 0.05, w: 0.5, h: 0.3 }, photo: { cx: 0.25, cy: 0.7, h: 0.4 } });
  cards = c.toggleText(cards, 2, c.typedText(' MY OWN WORDS '));
  cards = c.togglePhoto(cards, 2, 'ooh');
  cards = c.toggleFrame(cards, 3, list[0]);
  const plans = c.planCards(cards, pairs);
  assert.deepStrictEqual(plans.map((p) => [p.n, p.saved, p.position]), [[1, 'made', 1], [2, null, null], [3, 'made', 2]], 'card 2 (no frame) left out; card 3 is pick 2');
  assert.strictEqual(plans[1].why, 'It has no frame yet, so it is left out when you save. Pick a frame for it.');
  assert.strictEqual(c.planCards(c.emptyCards(), pairs)[0].why, 'Empty: it is left out when you save.');
  assert.strictEqual(c.saveBlocked(c.emptyCards(), pairs, 0), 'Put a frame (or your own image) on at least one thumbnail first.');
  assert.strictEqual(c.saveBlocked(c.emptyCards(), pairs, 2), null, 'emptying every card of saved picks can be saved');
  assert.strictEqual(c.noPairFor(3, pairs.slice(0, 2)), 'This report has 2 title and thumbnail pairs, so thumbnail 3 can only hold your own image.');
  assert.deepStrictEqual(c.titleOf(2, ['Chosen A'], ['Title one', 'Title two']), { title: 'Title one', chosen: false }, 'his chosen titles first, then the generated ones, said which');
  assert.deepStrictEqual(c.titleOf(1, ['Chosen A'], ['Title one']), { title: 'Chosen A', chosen: true });
  assert.strictEqual(c.titleOf(null, ['Chosen A'], []), null);
  assert.strictEqual(c.wordsMismatch(cards[0], { title: 'Chosen A', chosen: true }), 'Title two', 'words written for another chosen title: offered a rewrite');
  assert.strictEqual(c.wordsMismatch(cards[0], { title: 'Title one', chosen: false }), null, 'not against a title he has not picked');
  // Saved as the window sends them, then read back.
  const requests = c.cardRequests(cards, pairs);
  assert.deepStrictEqual(requests.map((r) => r.kind), ['made', 'empty', 'made']);
  assert.deepStrictEqual(requests[0], { card: 1, kind: 'made', frameId: list[2], phrase: 'MAYBE TOMORROW', textKind: 'stakes', wordsFor: 'Title two', photo: 'laugh', adjust: cards[0].adjust });
  const v = await window.saveCards(job.jobId, itemId, requests);
  assert.deepStrictEqual(v.picks.map((p) => [p.n, p.pick.pair, p.pick.wordsFor]), [[1, 1, 'Title two'], [2, 3, 'Title three']], 'pick 1 says its words were written for title 2');
  const read = c.cardsFromView(v);
  const expected = cards.map((x) => (x.n === 2 ? c.emptyCard(2) : x));
  assert.deepStrictEqual(read.map((x, i) => c.sameCard(x, expected[i])), [true, true, true], 'read back as sent (the frameless card empty)');
  assert.deepStrictEqual(c.unsavedCards(read, read), []);
  assert.deepStrictEqual(c.unsavedCards(c.toggleFrame(read, 3, list[1]), read), [3], 'a change is unsaved on its card');
  assert.deepStrictEqual(c.unsavedCards(c.setAdjust(read, 3, { frame: { x: 0, y: 0, scale: 1.2 } }), read), [3], 'an edit is a change');
  // His own image on card 2, saved and read back on card 2.
  const withOwn = read.map((x) => (x.n === 2 ? { ...c.emptyCard(2), own: { file: picture(path.join(world.root, 'Desktop', 'own.png'), '1280x720'), picture: 'chosen picture' } } : x));
  const v2 = await window.saveCards(job.jobId, itemId, c.cardRequests(withOwn, v.record.pairs));
  assert.deepStrictEqual(v2.picks.map((p) => [p.n, p.pick.kind, p.pick.kind === 'own' ? p.pick.card : p.pick.pair]), [[1, 'made', 1], [2, 'own', 2], [3, 'made', 3]]);
  const read2 = c.cardsFromView(v2);
  assert.deepStrictEqual(c.unsavedCards(read2, withOwn), [], 'his image read back on its card (compared by file)');
  // Old picks from before the card editor: an own image with no card sat on the card of its position.
  const oldView = { record: v2.record, picks: [{ n: 1, pick: { kind: 'made', pair: 1, file: '/r1.png', wordsFor: 'Title one' }, copy: '', picture: '' }, { n: 2, pick: { kind: 'own', file: '/mine.png' }, copy: '', picture: 'p' }] };
  assert.strictEqual(c.cardsFromView(oldView)[1].own.file, '/mine.png');
  const clash = { record: v2.record, picks: [{ n: 1, pick: { kind: 'made', pair: 1, file: '/r1.png', wordsFor: 'Title one' }, copy: '', picture: '' }, { n: 2, pick: { kind: 'own', file: '/mine.png', card: 1 }, copy: '', picture: 'p' }] };
  assert.throws(() => c.cardsFromView(clash), /Pick 1 and Pick 2 \(your own image\) are both saved on thumbnail 1: the saved picks and the record disagree\./);
  const onPair = { record: v2.record, picks: [{ n: 1, pick: { kind: 'own', file: '/mine.png' }, copy: '', picture: 'p' }] };
  assert.strictEqual(c.cardsFromView(onPair)[0].own.file, '/mine.png', 'an old own pick on card 1 is his image there, whatever pair 1 was drawn with');
  assert.throws(() => c.cardsFromView({ record: runRec, picks: [{ n: 1, pick: { kind: 'made', pair: 1, file: '/x.png', wordsFor: 'Title one' }, copy: '', picture: '' }] }), /Pick 1 is thumbnail 1, which has no frame/);
}));

check('the window\'s shape: the three cards (live previews, Save thumbnails, Edit, Clear, a drop target for his images) above the trays (frames, text, photos); no pick lists, no Generate, no suggested words, no Clear picks, no logo switch, no No text / No photo; a click draws in the window and asks the main process nothing; the preview uses the shared layout and drawing; closing asks in the window; no teal', () => {
  const dir = path.join(REPO, 'frontend/src/app/components/thumbnails-window');
  const html = fs.readFileSync(path.join(dir, 'thumbnails-window.html'), 'utf8');
  const at = (re) => { const m = html.search(re); assert.ok(m >= 0, `missing ${re}`); return m; };
  const order = [at(/<h3>Your thumbnails<\/h3>/), at(/>Save thumbnails<\/button>/), at(/<h3>Frames<\/h3>/), at(/<h3>Text<\/h3>/), at(/<h3>Photos<\/h3>/)];
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'cards and Save first, then frames, text and photos');
  assert.ok(/#cardCanvas/.test(html) && /\(click\)="selectCard\(n\)"/.test(html) && /\[class\.active\]="active\(\) === n"/.test(html), 'three cards, one active, a click makes it active');
  assert.ok(/\(click\)="clickFrame\(id\)"/.test(html) && /\(click\)="clickText\(o\)"/.test(html) && /\(click\)="clickPhoto\(p\.name\)"/.test(html), 'a tray click goes on the active card');
  assert.ok(/frameCards\(id\)/.test(html) && /textCards\(o\)/.test(html) && /photoCards\(p\.name\)/.test(html) && /\[class\.mine\]="k === active\(\)"/.test(html), 'the badges say which cards use an item');
  assert.ok(/edit\(n, \$event\)/.test(html) && /clear\(n, \$event\)/.test(html) && /Rewrite words for this title/.test(html), 'per card: Edit, Clear, rewrite');
  assert.ok(!/Use my own image/.test(html) && !/useOwn\(|thumbnailsChooseOwn/.test(html + fs.readFileSync(path.join(dir, 'thumbnails-window.ts'), 'utf8')), 'no own-image button: his images are frames now');
  assert.ok(/\(drop\)="dropOnCard\(\$event, n\)"/.test(html) && /\(dragover\)="dragOver\(\$event, n\)"/.test(html), 'an image dropped on a card');
  assert.ok(/\(drop\)="dropOnTray\(\$event\)"/.test(html) && /\(click\)="chooseImages\(\)"[\s\S]*?>Add an image…<\/button>/.test(html), 'an image dropped on the Frames tray, or chosen with Add an image…');
  assert.ok(/writeWords\(g, 'new'\)[\s\S]*?>New options<\/button>/.test(html) && /writeWords\(g, 'more'\)[\s\S]*?>More options<\/button>/.test(html) && /Earlier options/.test(html), 'per title: New options, More options, the earlier ones kept');
  assert.ok(/\[disabled\]="saveWhy\(\) !== null"/.test(html) && /@if \(saveWhy\(\); as why\)/.test(html), 'Save is disabled with its reason written beside it');
  assert.ok(/Close without saving/.test(html) && /Save and close/.test(html) && /Keep editing/.test(html), 'closing with changes asks in the window');
  for (const gone of [/Generate thumbnails/, /Start from the suggested words/, /Clear picks/, />No photo</, />No text</, /type="checkbox"/, /setLogo\(/, /removeFrame\(/, /addNoPhoto\(/, /sceneLabel|Scene \d/, /Show more/, /%<\/span>/]) {
    assert.ok(!gone.test(html), `the old window's ${gone} is still there`);
  }
  const win = fs.readFileSync(path.join(dir, 'thumbnails-window.ts'), 'utf8');
  assert.ok(/this\.ref\.disableClose = true/.test(win) && /backdropClick\(\)\.subscribe\(\(\) => this\.requestClose\(\)\)/.test(win), 'the dialog does not close behind his back');
  assert.ok(!/\bconfirm\(|\balert\(|window\.confirm/.test(win + html), 'no browser dialogs');
  for (const name of ['clickFrame', 'clickText', 'clickPhoto', 'clear', 'undo', 'selectCard']) {
    const body = win.slice(win.indexOf(`${name}(`), win.indexOf('\n  }\n', win.indexOf(`${name}(`)));
    assert.ok(!/this\.electron\./.test(body), `${name} asks the main process: a click is drawn in the window`);
  }
  assert.ok(/async save\(\)[\s\S]*thumbnailsSaveCards/.test(win), 'Save thumbnails saves the cards');
  for (const gone of ['thumbnailsRenderPair', 'thumbnailsSavePicks', 'thumbnailsRemake', 'thumbnailsReleaseModel', 'planSlots', 'drawChange', 'wantedChange', 'pickRequests', 'suggestedTexts', 'selectionFromPicks', 'generateBlocked']) {
    assert.ok(!win.includes(gone), `the window still names ${gone}`);
  }
  const composeSrc = fs.readFileSync(path.join(dir, 'thumbnails-compose.ts'), 'utf8');
  for (const gone of ['planSlots', 'drawChange', 'wantedChange', 'pickRequests', 'suggestedTexts', 'selectionFromPicks', 'generateBlocked', 'addNoPhoto', 'NO_TEXT']) {
    assert.ok(!new RegExp(`\\b${gone}\\b`).test(composeSrc), `thumbnails-compose.ts still has ${gone}`);
  }
  // The preview draws with the render's own layout and drawing, through the shared module.
  const preview = fs.readFileSync(path.join(dir, 'thumbnail-preview.ts'), 'utf8');
  assert.ok(/composeThumbnail\(/.test(preview) && /paintThumbnail\(/.test(preview) && /measurePhrase\(/.test(preview) && /from '\.\/thumbnail-shared'/.test(preview), 'the preview uses the shared layout and drawing');
  assert.ok(!/fillText|strokeText|planText\(|placeReaction\(|placeLogo\(/.test(preview), 'the preview places and draws nothing of its own');
  const sharedTs = fs.readFileSync(path.join(dir, 'thumbnail-shared.ts'), 'utf8');
  assert.ok(/export \* from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/electron\/shared\/thumbnail-layout'/.test(sharedTs) && /export \* from '\.\.\/\.\.\/\.\.\/\.\.\/\.\.\/electron\/shared\/thumbnail-draw'/.test(sharedTs), 'the frontend re-exports the one shared copy');
  const page = fs.readFileSync(path.join(REPO, 'electron/services/thumbnails/canvas-page.ts'), 'utf8');
  assert.ok(/import \{ measurePhrase, paintThumbnail \} from '\.\.\/\.\.\/shared\/thumbnail-draw'/.test(page) && !/function pageDraw|function pageMeasure/.test(page), 'the render page runs the same shared functions');
  const renderer = fs.readFileSync(path.join(REPO, 'electron/services/thumbnails/renderer.ts'), 'utf8');
  assert.ok(/composeThumbnail\(/.test(renderer) && !/planText\(|placeReaction\(|placeLogo\(/.test(renderer), 'the render places with the same composeThumbnail');
  const editor = fs.readFileSync(path.join(dir, 'thumbnail-card-editor.ts'), 'utf8');
  assert.ok(/drawCard\(/.test(editor) && /\(wheel\)="wheel\(\$event\)"/.test(editor) && /type="range"/.test(editor) && /class="handle"/.test(editor) && /reset\(selected\(\)\)/.test(editor), 'the editor: the same drawing, wheel, slider, corner handle, reset');
  assert.ok(!/'logo'|'border'/.test(editor.slice(editor.indexOf('type Piece'), editor.indexOf(';', editor.indexOf('type Piece')))), 'the logo and border are not editable pieces');
  const styles = ['thumbnails-window.scss', 'thumbnail-card-editor.ts'].map((f) => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
  assert.ok(!/teal|#008080|rgb\(\s*0\s*,\s*128\s*,\s*128\s*\)/i.test(styles), 'no teal');
  assert.ok(/var\(--primary-orange\)/.test(styles), 'the app\'s orange is the accent');
});

check('the border: drawPair hands the renderer the kept border when the look has it on; none when the look has it off or none is kept; the run says which; the shared drawing draws frame, border, words, photo, logo in that order', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec } = await windowOver(world);
  const { userData, root, setup } = world;
  const borderFile = path.join(root, 'Downloads', 'thumbnail-border.png');
  fs.mkdirSync(path.dirname(borderFile), { recursive: true });
  fs.writeFileSync(borderFile, PNG_BYTES);
  const kept = library.setLibraryBorder(userData, borderFile, () => {});
  await window.saveCards(job.jobId, itemId, cardsFor(rec, [{ frame: rec.frames[0].id, phrase: null }, null, null]));
  assert.strictEqual(drawsOf(world).pop().borderFile, kept, 'the kept border, under the words');
  const off = { ...setup, style: { ...setup.style, border: false } };
  const renderer = off.openRenderer();
  const frame = rec.frames.find((f) => f.id === rec.pairs[0].default.frameId);
  await pipeline.drawPair({ renderer, ffmpeg: FFMPEG, video: rec.source.video, folder: rec.folder, frame: { id: frame.id, t: frame.t }, phrase: 'X', photo: null, logo: false, style: off.style, userDataPath: userData, outStem: path.join(rec.folder, 'border off'), adjust: null });
  assert.strictEqual(drawsOf(world).pop().borderFile, null, 'switched off in the look: none');
  fs.rmSync(library.borderDir(userData), { recursive: true });
  await pipeline.drawPair({ renderer, ffmpeg: FFMPEG, video: rec.source.video, folder: rec.folder, frame: { id: frame.id, t: frame.t }, phrase: 'X', photo: null, logo: false, style: setup.style, userDataPath: userData, outStem: path.join(rec.folder, 'no border kept'), adjust: null });
  assert.strictEqual(drawsOf(world).pop().borderFile, null, 'none kept: none');
  // The drawing order is the shared drawing's (the render page and the window's preview run it): frame, border, patch and words, photo, logo.
  const drawSrc = fs.readFileSync(path.join(REPO, 'electron/shared/thumbnail-draw.ts'), 'utf8');
  const draw = drawSrc.slice(drawSrc.indexOf('export async function paintThumbnail'));
  const idx = ['ctx.drawImage(img, 0, 0, W, H)', 'ctx.drawImage(border, 0, 0, W, H)', 'ctx.fillText(line.text', 'ctx.drawImage(photo, r.x', 'ctx.drawImage(logo, l.x'].map((s) => draw.indexOf(s));
  assert.ok(idx.every((i) => i > 0) && idx.every((i, k) => k === 0 || i > idx[k - 1]), `frame, border, words, photo, logo in that order (${idx})`);
  assert.ok(!/vignette/.test(draw), 'the procedural vignette is gone');
}));

check('the tab is gone and nothing dangles: no route, sidebar entry, component, lab service, combine or thumbs: channel; every thumbnails: channel offered has a handler and the reverse; the old draw/pick/remake channels are gone; no THUMBNAIL TEXT OPTIONS section; pick 1 is published through the publish door', () => {
  const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
  for (const gone of ['electron/services/thumbnails/lab-service.ts', 'electron/services/thumbnails/thumbnail-lab-ipc.ts', 'electron/services/thumbnails/combine.ts', 'frontend/src/app/components/thumbnails', 'electron/services/thumbnails/layout.ts']) {
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
  for (const gone of ['thumbnails:render-pair', 'thumbnails:save-picks', 'thumbnails:remake', 'thumbnails:release-model']) assert.ok(!offered.has(gone) && !handled.has(gone), `${gone} is still offered`);
  for (const now of ['thumbnails:save-cards', 'thumbnails:frame-detail', 'thumbnails:photo-detail', 'thumbnails:closed', 'thumbnails:add-frames', 'thumbnails:choose-frames', 'thumbnails:words', 'thumbnails:running']) assert.ok(offered.has(now), `${now} is not offered`);
  assert.ok(!offered.has('thumbnails:choose-own') && !handled.has('thumbnails:choose-own') && !/thumbnailsChooseOwn|ownImage\(/.test(preload + ipc + bridge), 'the own-image chooser is gone');
  assert.ok(!/thumbnailsRenderPair|thumbnailsSavePicks|thumbnailsRemake|thumbnailsReleaseModel|PairChange|PickRequest/.test(bridge), 'the bridge names no removed call');
  const report = read('electron/services/thumbnails/report-thumbnails.ts');
  assert.ok(!/renderPair\(|savePicks\(|remake\(|PairChange/.test(report), 'the main process keeps no removed action');
  assert.ok(!/again\?: \{ folder/.test(read('electron/services/thumbnails/pipeline.ts')), 'no "from scratch" path left in the run');
  const html = read('frontend/src/app/components/metadata-reports/metadata-reports.html');
  assert.ok(!/thumbnail_text|Thumbnail text/.test(html), 'no THUMBNAIL TEXT OPTIONS section on the reports page');
  assert.ok(/openThumbnails\(\)/.test(html), 'the reports page opens the Thumbnails window');
  const win = read('frontend/src/app/components/thumbnails-window/thumbnails-window.ts');
  assert.ok(/this\.publish\.setThumbnail\(view\.publishFile\)/.test(win), 'pick 1 goes through the publish record\'s one thumbnail door');
  // The model's tone and photo ranking is gone (2026-09-29): no module, no routing row, no decide in the pipeline or the window.
  for (const gone of ['electron/services/thumbnails/judge.ts', 'electron/services/thumbnails/photo-draw.ts']) assert.ok(!fs.existsSync(path.join(REPO, gone)), `${gone} is still there`);
  for (const file of ['electron/services/thumbnails/pipeline.ts', 'electron/services/thumbnails/report-thumbnails.ts']) {
    const src = read(file);
    assert.ok(!/judgeThumbnails|drawPhotos|\.decide\(|thumbnail_judge'\)/.test(src), `${file} still asks for a tone or photo decision`);
  }
  assert.ok(!/set-photo-note|thumbnailsSetPhotoNote/.test(preload + ipc + bridge), 'no photo notes channel');
  assert.ok(!/^tone:|^photo:/m.test(read('electron/assets/prompts/shared/pipeline/thumbnails.yml')), 'the tone and photo prompts are gone');
  // The frame scoring is gone (2026-09-29, Owen picks the frames): no module, no prompt, no routing row, no frames channel, no vision call.
  for (const gone of ['electron/services/thumbnails/frame-scorer.ts', 'electron/services/thumbnails/frame-ranking.ts']) assert.ok(!fs.existsSync(path.join(REPO, gone)), `${gone} is still there`);
  assert.ok(!/^frames:/m.test(read('electron/assets/prompts/shared/pipeline/thumbnails.yml')), 'the frame questions are gone');
  assert.ok(!/frameDecideItems|frameQuestions|frameAnswersOfItems/.test(read('electron/services/thumbnails/prompts.ts')), 'prompts.ts packs no frame question');
  for (const file of ['electron/services/thumbnails/pipeline.ts', 'electron/services/thumbnails/report-thumbnails.ts', 'electron/services/thumbnails/pipeline-setup.ts']) {
    const src = read(file);
    assert.ok(!/scoreFrames|decideItems|'thumbnail_frames'|from '\.\/frame-scorer'|from '\.\/frame-ranking'/.test(src), `${file} still scores frames`);
  }
  assert.ok(!/thumbnail_frames'|id: 'thumbnail_frames'/.test(read('electron/services/metadata/metadata-routing.ts').replace(/REMOVED_ROUTING_TASKS[\s\S]*?\n};/, '')), 'no thumbnail_frames row');
  assert.ok(!/'thumbnails:frames'|thumbnailsFrames\b/.test(preload + ipc + bridge), 'no frames channel (Show more is gone)');
});

run('thumbnails in the metadata run and the reports page\'s window: the story link, stage order and the grid, words per title, no story, failures, off, storage, Save thumbnails, card edits, the preview\'s pieces, own image, rewrite for a title, screenshots, delete, finish, the card rules, the window\'s shape, the border, the tab, the judge and the frame scoring gone');
