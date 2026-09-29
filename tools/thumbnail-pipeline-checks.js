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
 * Phase 2 (the reports page's Thumbnails window, report-thumbnails.ts, 2026-09-28):
 *
 *   - ORDERED PICKS AND PAIRING: picks are saved in click order (pick n goes with chosen title n by
 *     position); the copies `picks/Pick 1..n` are written and the file to publish is pick 1's copy;
 *     a fourth pick, one pair twice and a stale record shape are refused; with none, the copies go.
 *   - SWAPS DRAWN: a changed frame, words (or "No text"), photo (a name from the library, or none)
 *     or logo draws a NEW file beside the old one (the old one removed once no pick points at it);
 *     a picked pair's pick follows it; the retired 'draw' is refused as a photo name.
 *   - OWN IMAGE AS A PICK: Owen's file, checked against YouTube's thumbnail rules and read in place.
 *   - REWRITE WORDS FOR A TITLE: one words call carrying the new title on ONE held load of the 27B,
 *     no decide; the pair keeps its photo; the pair and its pick follow; a second action on the item
 *     while one runs is refused; the hold is given back on request.
 *   - NO STORY -> SCREENSHOTS: N screenshots make N pairs, one per title given, a non-16:9 one cut to
 *     16:9 (said); own picks kept; a report whose pairs came from its story refuses them.
 *   - DELETE: deleting an item removes its thumbnails folder (and the empty thumbnails/ folder); a
 *     record naming a folder elsewhere is left and said; a whole job's cleanup removes each item's.
 *   - THE TAB IS GONE: no route, sidebar entry, component, lab service, combine or `thumbs:` channel;
 *     every `thumbnails:` channel the preload offers has a handler and the reverse; the reports page
 *     shows no THUMBNAIL TEXT OPTIONS section; the window sets pick 1 through the publish door.
 *
 * The window rebuilt as one flow (2026-09-29, LEDGER #242):
 *
 *   - ERRORS REACH THE WINDOW: with no Crucible server the view blocks Finish with the reason and
 *     Finish is refused before any model call; a record stopped at a removed stage (tone-photos,
 *     Owen's first run; scoring) says that step is gone; the window's one runner turns a failure into
 *     a banner line naming it; every window call goes through the runner and every channel answers
 *     { ok, error }.
 *   - FINISH RESUMES ONLY THE MISSING STAGES: no word written again; a record stopped at tone-photos
 *     is finished with no model call and no lease, its story pairs left without the frames the old
 *     ranking gave them; a screenshots record stopped at render draws only; the plans for a stop at
 *     the removed scoring (its frames kept as the grid) and for screenshots. FROM SCRATCH runs every
 *     stage on one job, the 27B its only model.
 *
 * The window's second rebuild (2026-09-29, Owen: "let me click 1->2->3 ... the thumbnail text should
 * be a list i pick ... just show a list of possible images ... the 'generate thumbnails' button
 * should be at the bottom"):
 *
 *   - PICKING: frames (one flat list in time order, every candidate; at most two per scene), texts
 *     and photos each in click order (out and close up; a fourth refused); "No photo" can be
 *     picked more than once and taken out on its badge; thumbnail n = frame n + text n + photo n;
 *     Generate thumbnails is disabled with its reason until a frame and a text are picked; it draws
 *     every ready place (`drawChange`) and each then shows what was picked; the picks are the places
 *     in order and read back on reopening; his own image takes a place; a story pair with no frame
 *     is drawn only once its frame is picked; "Start from the suggested words" fills the texts only.
 *   - THE WINDOW'S SHAPE: frames, text (a list), photos (one row, no percentages), then Generate
 *     thumbnails, then the results; no scene labels; nothing drawn on a click.
 *   - THE BORDER: drawPair hands the renderer the kept border when the look has it on, none when it
 *     is off or none is kept (said in the record's lines).
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
    style: services('thumbnails/layout.js').DEFAULT_STYLE, styleSaved: false, styleLine: null,
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
    await fn({ server, w, root, renders, plainCalls, aiManager, job, itemRun, setup, userData, transport: made.ctx.transport, lanes: made.ctx.lanes });
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
  const wordCalls = plainCalls.filter((c) => /^thumbnail words for/.test(c.what));
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

check('stages: a failed stage is on the record and in the warning, in plain words; the later stages do not run; a stop is rethrown, not recorded', () => withWorld({}, async ({ job, itemRun, renders }) => {
  const rec = await job(async (leases, controller) => {
    const run = itemRun(leases, controller, { routing: { thumbnail_words: 'qwen35-9b' } });
    await run.beforeChapters();
    await run.afterFields(FIELDS);
    assert.ok(/^f2 - the rapture\.mov: The thumbnails stopped at the words stage: .*qwen3\.5-9b is not downloaded on "mac"/.test(run.warning()), run.warning());
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
    assert.strictEqual(fs.readFileSync(job.jsonPath, 'utf8'), before, 'a refused write leaves the file byte for byte');
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
 * A story run gives no pair a frame (Owen picks them), so unless `draw` is false the three pairs are
 * then drawn as Generate thumbnails would draw them: pair n on grid frame n. `rec` is the record
 * after that; `runRec` the record the run wrote.
 */
async function windowOver(world, { record: given = null, noStory = false, gpuVenue = null, draw = true } = {}) {
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
    photoList: () => library.libraryPhotos(userData).map((ph) => ({ name: ph.name, preview: `picture of ${ph.name}` })),
    progress: (e) => progress.push(e.line),
    gpuVenue: gpuVenue ?? (() => world.lanes.gpuVenue()),
  });
  let drawn = rec;
  if (given === null && !noStory && draw) {
    for (const p of rec.pairs) await window.renderPair(job.jobId, saved.itemId, { pair: p.pair, frameId: rec.frames[p.pair - 1].id });
    drawn = window.view(job.jobId, saved.itemId).record;
  }
  return { out, job, itemId: saved.itemId, window, rec: drawn, runRec: rec, progress, video };
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

check('window, swaps: frame, words ("No text"), a photo by name (or none) and logo are drawn as a NEW file beside the old; a picked pair\'s pick follows it; the retired draw is refused', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec } = await windowOver(world);
  const first = rec.pairs[0].default.render.file;
  await window.savePicks(job.jobId, itemId, [{ kind: 'made', pair: 1 }]);
  const noText = await window.renderPair(job.jobId, itemId, { pair: 1, phrase: null });
  const p1 = noText.record.pairs[0];
  assert.deepStrictEqual([p1.default.phrase, p1.default.kind], [null, null]);
  assert.strictEqual(path.basename(p1.default.render.file), 'Pair 1 - Title one (3).png', 'a new file beside the old (the first drawing was (2))');
  assert.ok(!fs.existsSync(first), 'the old file is removed once no pick points at it (the published file is the pick\'s copy)');
  assert.strictEqual(noText.picks[0].pick.file, p1.default.render.file, 'the pick follows its pair');
  assert.ok(fs.readFileSync(noText.publishFile).equals(fs.readFileSync(p1.default.render.file)), 'Pick 1 is the new drawing');
  assert.strictEqual(world.renders.filter((r) => r !== 'closed').pop().phrase, null, 'drawn with no words');
  const typed = await window.renderPair(job.jobId, itemId, { pair: 1, phrase: 'my own words', kind: null });
  assert.deepStrictEqual([typed.record.pairs[0].default.phrase, typed.record.pairs[0].default.kind], ['my own words', null]);
  const photo = await window.renderPair(job.jobId, itemId, { pair: 3, photo: 'laugh' });
  const d3 = photo.record.pairs[2];
  assert.deepStrictEqual([d3.default.photo, d3.default.draw, d3.lines.includes(pipeline.NO_PHOTO_YET)], ['laugh', null, false], 'his photo, no draw, and the "no photo yet" line gone');
  assert.deepStrictEqual(world.renders.filter((r) => r !== 'closed').pop().photo.name, 'laugh', 'drawn with his photo');
  const noPhoto = await window.renderPair(job.jobId, itemId, { pair: 3, photo: null, logo: false });
  assert.deepStrictEqual([noPhoto.record.pairs[2].default.photo, noPhoto.record.pairs[2].default.logo], [null, false]);
  assert.strictEqual(world.renders.filter((r) => r !== 'closed').pop().photo, null, 'drawn with no photo');
  assert.ok(/no reaction photo "draw"/.test((await rejection(window.renderPair(job.jobId, itemId, { pair: 2, photo: 'draw' }))).message), 'the model\'s draw is gone');
  const other = rec.frames.find((f) => f.id !== rec.pairs[0].default.frameId);
  const moved = await window.renderPair(job.jobId, itemId, { pair: 1, frameId: other.id });
  assert.deepStrictEqual([moved.record.pairs[0].default.frameId, moved.record.pairs[0].default.scene], [other.id, other.scene]);
  assert.ok(/not among this report's candidate frames/.test((await rejection(window.renderPair(job.jobId, itemId, { pair: 1, frameId: 'f999999' }))).message));
  assert.ok(/no reaction photo "nobody"/.test((await rejection(window.renderPair(job.jobId, itemId, { pair: 1, photo: 'nobody' }))).message));
  // A story pair with no frame yet is drawn only with its frame picked: refused by name otherwise, and rewrite is refused before any model call.
  const bare = await windowOver(world, { draw: false });
  const calls = world.plainCalls.length;
  assert.ok(/Thumbnail 2 has no frame yet: pick its frame in the grid above/.test((await rejection(bare.window.renderPair(bare.job.jobId, bare.itemId, { pair: 2, phrase: null }))).message));
  assert.ok(/Thumbnail 2 has no frame yet/.test((await rejection(bare.window.pairTitle(bare.job.jobId, bare.itemId, 2, 'Title four'))).message));
  assert.strictEqual(world.plainCalls.length, calls, 'no words were written for a pair with no frame');
  const picked = await bare.window.renderPair(bare.job.jobId, bare.itemId, { pair: 2, frameId: bare.rec.frames[0].id });
  const p2 = picked.record.pairs[1];
  assert.deepStrictEqual([p2.default.frameId, p2.default.scene, p2.default.render.ok, p2.lines.includes(pipeline.NO_FRAME_YET), p2.lines.includes(pipeline.NO_PHOTO_YET)],
    [bare.rec.frames[0].id, bare.rec.frames[0].scene, true, false, true], 'drawn on his frame; the "no frame" line gone, the "no photo" line kept');
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

check('window, rewrite words for a title: one words call carrying the title on ONE held load of the 27B, no decide; the pair keeps its photo; the pair and its pick follow; a second action while one runs is refused; the hold is given back', () => withWorld({}, async (world) => {
  const { job, itemId, window } = await windowOver(world);
  const { server, plainCalls } = world;
  await window.renderPair(job.jobId, itemId, { pair: 2, photo: 'oh please' });
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
  assert.strictEqual(server.decideBodies().length - decidesBefore, 0, 'no tone or photo question');
  // The fake keeps a model in memory after its lease goes back, so a reload shows as a second lease.
  const leases = server.leases.taken.slice(leasesBefore);
  assert.deepStrictEqual(leases.map((l) => l.model), ['qwen3.8-27b-8bit'], 'one lease on the 27B for the words');
  const p2 = v.record.pairs[1];
  assert.deepStrictEqual([p2.title, p2.default.kind, p2.default.phrase, p2.default.photo, p2.photos.length], ['Title four', 'stakes', 'MAYBE TOMORROW', 'oh please', 0], 'his photo is kept');
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
  assert.strictEqual(r.line, '2 title and thumbnail pairs are ready to pick from; no photo picked yet.');
  assert.ok(r.pairs.every((p) => p.default.photo === null), 'no photo until he picks one');
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

// ── 2026-09-29: the window rebuilt as one flow (frames, text, photos, thumbnails) ──

/** The window's picking rules (frontend thumbnails-compose.ts), transpiled: it has only type imports. */
const compose = (() => {
  const ts = require('typescript');
  const src = path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-compose.ts');
  const out = ts.transpileModule(fs.readFileSync(src, 'utf8'), { compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 }, fileName: src });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', out.outputText)(mod.exports, mod, require);
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
    p.lines = p.lines.filter((l) => l !== pipeline.NO_PHOTO_YET);
  }
  return old;
}

check('errors reach the window: a record stopped at a removed stage (tone-photos, scoring) is read and shown as not finished, the step unnamed; with no Crucible server Finish is blocked with the reason and refused before any model call; a failed action becomes a banner line naming it; every window call goes through the runner and every channel answers { ok, error }', () => withWorld({}, async (world) => {
  const { server, plainCalls } = world;
  const made = await windowOver(world);
  const old = stoppedAtTonePhotos(made.rec);
  assert.strictEqual(record.readItemThumbnails(old, 'keeper').failure.stage, 'tone-photos', 'an older record naming the retired stage is still read');
  const { job, itemId, window } = await windowOver(world, { record: old });
  const v = window.view(job.jobId, itemId);
  assert.deepStrictEqual([v.finish.stage, v.finish.keep, v.finish.run, v.finish.blocked], ['tone-photos', ['story', 'frames', 'words'], ['render'], null]);
  assert.ok(v.finish.reason === null && v.finish.retired === true, 'a removed stage is not named, and its old reason is not shown');
  // The draw Owen's clicks sent (the phase-2 log line): refused in words, and those words are the banner.
  const drawErr = await rejection(window.renderPair(job.jobId, itemId, { pair: 1, phrase: null }));
  assert.ok(/There are no thumbnails to change: The thumbnails stopped at the tone-photos stage/.test(drawErr.message), drawErr.message);
  // Stopped at the scoring with no Crucible server: Finish says why it cannot run, and is refused before any model call.
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
  const [a, b] = await Promise.all([runner.run('Drawing thumbnail 1', async () => { throw drawErr; }), runner.run('Saving your picks', async () => 'saved')]);
  assert.deepStrictEqual([a, b], [null, 'saved']);
  assert.deepStrictEqual(seen.failed, [`Drawing thumbnail 1 failed: ${drawErr.message}`], 'the failure is a line naming what failed, with the main process\'s sentence');
  assert.deepStrictEqual(seen.busy, ['Drawing thumbnail 1', null, 'Saving your picks', null], 'one action at a time, in order, the busy line cleared after each');
  assert.strictEqual(compose.clockOf(83_400), '1:23');
  // Every call the window makes goes through the runner (act() is the runner), except giving the model back as it closes.
  const win = fs.readFileSync(path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-window.ts'), 'utf8');
  const calls = win.split('\n').filter((l) => /this\.electron\.thumbnails[A-Z]/.test(l));
  assert.ok(calls.length >= 10, `${calls.length} calls found`);
  for (const l of calls) assert.ok(/this\.act\(|this\.runner\.run\(/.test(l) || /thumbnailsReleaseModel/.test(l), `a window call outside the runner: ${l.trim()}`);
  const html = fs.readFileSync(path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-window.html'), 'utf8');
  assert.ok(/@if \(failure\(\); as f\)/.test(html) && /class="status"/.test(html) && /elapsed\(\)/.test(html), 'the sticky status shows the failure, the running step and its clock');
  assert.ok(/fin\.blocked/.test(html) && /Try again/.test(html) && !/Finish making thumbnails/.test(html) && !/again from scratch/.test(html), 'the not-ready banner says why it cannot be prepared and offers Try again; no Finish, no from scratch');
  assert.ok(/view\.finish !== null && view\.finish\.blocked === null\) await this\.prepare\(\)/.test(win), 'a video that is not ready is prepared on opening');
  assert.ok(/Pick frames, text and photos in the order 1, 2, 3, then press Generate thumbnails at the bottom\./.test(html), 'the one line saying what to do');
  const ipc = fs.readFileSync(path.join(REPO, 'electron/services/thumbnails/thumbnails-ipc.ts'), 'utf8');
  const handlers = ipc.split(/\n\s*ipcMain\.handle\(/).slice(1);
  assert.ok(handlers.length >= 20);
  for (const h of handlers) assert.ok(/answer\(/.test(h.split(/\n\s*\/\/ /)[0]), `a thumbnails channel that does not answer { ok, error }: ${h.slice(0, 60)}`);
}));

check('finish: a record stopped at the removed tone-photos stage is finished from what it stores (no word written, no decide, no lease), its story pairs left without the frames the old ranking gave them; made; own picks stay; a screenshots record stopped at render draws only; the plans', () => withWorld({}, async (world) => {
  const { server, plainCalls, root } = world;
  const made = await windowOver(world);
  const old = stoppedAtTonePhotos(made.rec);
  const { job, itemId, window, rec } = await windowOver(world, { record: old });
  const mine = picture(path.join(root, 'Desktop', 'mine.png'), '1280x720');
  await window.savePicks(job.jobId, itemId, [{ kind: 'own', file: mine }]);
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
  assert.deepStrictEqual([v.finish, v.picks.map((p) => p.pick.kind)], [null, ['own']], 'nothing left to finish; his own pick stays');
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

check('from scratch: every thumbnail stage runs again for the item (the frames sampled, the words written, no decide), on one held job given back after; own picks stay, pair picks go', () => withWorld({}, async (world) => {
  const { server, plainCalls, root } = world;
  const { job, itemId, window, rec } = await windowOver(world);
  const mine = picture(path.join(root, 'Desktop', 'mine.png'), '1280x720');
  await window.savePicks(job.jobId, itemId, [{ kind: 'made', pair: 1 }, { kind: 'own', file: mine }]);
  const before = { plain: plainCalls.length, decides: server.decideBodies().length, leases: server.leases.taken.length };
  const v = await window.remake(job.jobId, itemId);
  assert.strictEqual(v.record.state, 'made', v.record.line);
  assert.strictEqual(v.record.folder, rec.folder, 'into the same folder');
  assert.ok(v.record.lines.includes('Made again from scratch in the Thumbnails window.') && v.record.lines.some((l) => /were removed to make them again from scratch/.test(l)), v.record.lines.join(' | '));
  assert.strictEqual(server.decideBodies().length - before.decides, 0, 'no frame is scored: no decide');
  assert.ok(v.record.frames.length >= 3 && v.record.pairs.every((p) => p.default.frameId === null), 'a fresh grid; the pairs wait for his frame picks');
  assert.strictEqual(plainCalls.length - before.plain, 3, 'the words written again, one call per title');
  const taken = server.leases.taken.slice(before.leases);
  assert.deepStrictEqual(taken.map((l) => l.model), ['qwen3.8-27b-8bit'], 'the 27B, the job\'s only model');
  assert.ok(taken.every((l) => server.leases.released.includes(l.leaseId)), 'given back');
  assert.deepStrictEqual(v.picks.map((p) => p.pick.kind), ['own']);
}));

check('picking: frames (one flat list in time order, every candidate), texts and photos in click order (out and close up; a fourth refused); "No photo" twice, taken out on its badge; Generate is gated until a frame and a text are picked; it draws each place as picked; the picks are the places in order; reopening reads them back; his own image takes a place', () => withWorld({}, async (world) => {
  const c = compose;
  const id = (x) => x;
  let t = c.togglePick([], 'a', id, 'frames');
  t = c.togglePick(t.list, 'b', id, 'frames');
  t = c.togglePick(t.list, 'c', id, 'frames');
  assert.deepStrictEqual(t.list, ['a', 'b', 'c']);
  const fourth = c.togglePick(t.list, 'd', id, 'frames');
  assert.deepStrictEqual([fourth.list, /^Up to 3 frames can be picked\. Click a picked one to take it out first\.$/.test(fourth.refused)], [['a', 'b', 'c'], true]);
  assert.deepStrictEqual(c.togglePick(t.list, 'a', id, 'frames').list, ['b', 'c'], 'out, and the rest close up');
  assert.deepStrictEqual(c.togglePick(['b', 'c'], 'a', id, 'frames').list, ['b', 'c', 'a'], 'back in, last');
  assert.throws(() => c.typedText('   '), /Type the words first/);

  // PHOTOS: one row, clicked 1, 2, 3; "No photo" can be picked twice and each is taken out on its badge.
  let ph = c.addNoPhoto([]).list;
  ph = c.togglePhoto(ph, 'laugh').list;
  ph = c.addNoPhoto(ph).list;
  assert.deepStrictEqual(ph.map((p) => p.name), [null, 'laugh', null]);
  assert.deepStrictEqual([c.photoNumbers(ph, null), c.photoNumbers(ph, 'laugh')], [[1, 3], [2]]);
  assert.ok(/^Up to 3 photos can be picked/.test(c.togglePhoto(ph, 'ooh').refused) && /^Up to 3 photos can be picked/.test(c.addNoPhoto(ph).refused), 'a fourth refused');
  assert.deepStrictEqual(c.togglePhoto(ph, 'laugh').list.map((p) => p.name), [null, null], 'laugh out, the rest close up');
  assert.deepStrictEqual(c.removePhotoAt(ph, 0).map((p) => p.name), ['laugh', null], 'the first No photo out on its badge');

  const { job, itemId, window, rec, runRec } = await windowOver(world);
  // FRAMES: one flat list, no scenes: every candidate (at most two a scene), in time order.
  const list = c.frameList(rec);
  const byT = [...rec.frames].sort((a, b) => a.t - b.t);
  assert.deepStrictEqual(list, byT.map((f) => f.id), 'every candidate, in time order');
  assert.strictEqual(new Set(list).size, list.length, 'no frame twice');
  assert.deepStrictEqual(c.frameList({ frames: [{ id: 'shot2', t: 0 }, { id: 'shot1', t: 0 }] }), ['shot2', 'shot1'], 'screenshots keep their own order');
  assert.deepStrictEqual(c.frameList(null), []);
  // The run's pairs have no frame: every place differs until Generate, and "Start from the suggested words" fills the texts only.
  assert.ok(runRec.pairs.every((p) => p.default.frameId === null));
  const suggested = c.suggestedTexts(runRec.pairs);
  assert.deepStrictEqual(suggested.map((t) => [t.phrase, t.kind, t.wordsFor]), runRec.pairs.map((p) => [p.default.phrase, p.default.kind, p.title]), 'pair n\'s default words as text n');
  const undrawn = c.planSlots({ pairs: runRec.pairs, frames: [list[0]], texts: suggested, photos: [], own: {} });
  assert.deepStrictEqual(undrawn.map((s) => [s.frameId, s.missing]), [[list[0], null], [null, 'Pick frame 2 above.'], [null, 'Pick frame 3 above.']], 'a place is drawn only once its frame is picked');
  assert.deepStrictEqual(c.wantedChange(undrawn[0], runRec.pairs, false).frameId, list[0], 'the picked frame is what Generate sends');
  assert.throws(() => c.selectionFromPicks([{ n: 1, pick: { kind: 'made', pair: 1, file: '/x.png', wordsFor: 'Title one' }, copy: '', picture: '' }], runRec.pairs), /Pick 1 is thumbnail 1, which has no frame/);
  const options = c.textOptions(rec.pairs);
  assert.ok(options.every((o) => o.kind !== null && typeof o.wordsFor === 'string'), 'every generated line says its kind and its title');
  const fromTitleTwo = options.find((o) => o.wordsFor === 'Title two' && o.phrase === 'MAYBE TOMORROW');
  const frames = [list[2], list[0], list[1]];
  const texts = [fromTitleTwo, c.NO_TEXT, c.typedText(' MY OWN WORDS ')];
  const photos = c.togglePhoto(c.addNoPhoto([]).list, 'laugh').list;
  const plan = (pairs, over = {}) => c.planSlots({ pairs, frames, texts, photos, own: {}, ...over });

  // GENERATE is gated: nothing picked, or a frame with no text, says what to pick; a record that cannot be drawn says why.
  const nothing = c.planSlots({ pairs: rec.pairs, frames: [], texts: [], photos: [], own: {} });
  assert.strictEqual(c.generateBlocked(nothing, null), 'Pick at least one frame and one line of text (or “No text”) above.');
  assert.strictEqual(c.generateBlocked(c.planSlots({ pairs: rec.pairs, frames: [frames[0]], texts: [], photos: [], own: {} }), null), 'Pick at least one frame and one line of text (or “No text”) above.');
  assert.strictEqual(c.generateBlocked(c.planSlots({ pairs: rec.pairs, frames: [frames[0]], texts: [c.NO_TEXT], photos: [], own: {} }), null), null, 'one frame and No text is enough');
  assert.strictEqual(c.generateBlocked(nothing, 'The thumbnails stopped.'), 'The thumbnails stopped.');
  assert.strictEqual(c.generateBlocked(c.planSlots({ pairs: rec.pairs, frames: [], texts: [], photos: [], own: { 1: '/mine.png' } }), 'The thumbnails stopped.'), null, 'his own image can still be saved');

  const slots = plan(rec.pairs);
  assert.deepStrictEqual(slots.map((s) => [s.n, s.frameId, s.text.key, s.photo, s.photoPicked, s.missing]), [
    [1, frames[0], fromTitleTwo.key, null, true, null], [2, frames[1], 'none', 'laugh', true, null], [3, frames[2], 'typed|MY OWN WORDS', null, false, null],
  ], 'photo n goes on thumbnail n; thumbnail 3 has no photo picked');
  assert.ok(slots.every((s) => c.wantedChange(s, rec.pairs, false) !== null), 'nothing is drawn by picking: every card still differs until Generate');
  // Generate: every ready place drawn as picked.
  let view = window.view(job.jobId, itemId);
  for (const s of slots.filter(c.ready)) view = await window.renderPair(job.jobId, itemId, c.drawChange(s, false));
  const pairs = view.record.pairs;
  const drawn = plan(pairs);
  assert.deepStrictEqual(drawn.map((s) => c.wantedChange(s, pairs, false)), [null, null, null], 'each thumbnail shows what was picked');
  assert.deepStrictEqual(pairs.map((p) => [p.default.frameId, p.default.phrase, p.default.wordsFor ?? null, p.default.photo, p.default.draw]),
    [[frames[0], 'MAYBE TOMORROW', 'Title two', null, null], [frames[1], null, null, 'laugh', null], [frames[2], 'MY OWN WORDS', null, null, null]]);
  const requests = c.pickRequests(drawn, pairs, false);
  assert.deepStrictEqual(requests, [{ kind: 'made', pair: 1 }, { kind: 'made', pair: 2 }, { kind: 'made', pair: 3 }], 'the places in order');
  const saved = await window.savePicks(job.jobId, itemId, requests);
  assert.ok(c.samePicks(requests, saved.picks));
  assert.deepStrictEqual(saved.picks.map((p) => [p.n, p.pick.pair, p.pick.wordsFor]), [[1, 1, 'Title two'], [2, 2, 'Title two'], [3, 3, 'Title three']], 'pick 1 says its words were written for title 2');
  assert.strictEqual(saved.publishFile, path.join(saved.record.folder, 'picks', 'Pick 1.png'), 'thumbnail 1 is what is published');
  const reopened = c.selectionFromPicks(saved.picks, saved.record.pairs);
  assert.deepStrictEqual([reopened.frames, reopened.texts.map((x) => x.key), reopened.photos.map((p) => p.name)], [frames, texts.map((x) => x.key), [null, 'laugh']], 'reopening reads the same picks back (a trailing No photo is the same as none)');
  // A changed pick after Generate: the card says so (not drawn until Generate again).
  const changedText = c.planSlots({ pairs, frames, texts: [c.NO_TEXT, texts[1], texts[2]].slice(0, 3), photos, own: {} });
  assert.ok(c.wantedChange(changedText[0], pairs, false) !== null && c.pickRequests(changedText, pairs, false) === null, 'a changed pick is not saved until drawn');
  // Unpick frame 1: the rest close up; thumbnail 3 now misses its frame.
  const fewer = c.planSlots({ pairs, frames: c.togglePick(frames, frames[0], id, 'frames').list, texts, photos, own: {} });
  assert.deepStrictEqual(fewer.map((s) => s.frameId), [frames[1], frames[2], null]);
  assert.strictEqual(fewer[2].missing, 'Pick frame 3 above.');
  assert.throws(() => c.drawChange(fewer[2], false), /Thumbnail 3 cannot be drawn: Pick frame 3 above\./);
  // His own image in place 2: the frames, texts and photos fill places 1 and 3.
  const withOwn = c.planSlots({ pairs, frames, texts, photos, own: { 2: '/Users/owen/Desktop/mine.png' } });
  assert.deepStrictEqual(withOwn.map((s) => [s.n, s.own, s.frameId, s.pickIndex, s.photo]), [[1, null, frames[0], 0, null], [2, '/Users/owen/Desktop/mine.png', null, null, null], [3, null, frames[1], 1, 'laugh']]);
  // The replaced renders went: one current render per pair is left in the folder.
  const renders = fs.readdirSync(saved.record.folder).filter((f) => /^Pair \d/.test(f));
  assert.deepStrictEqual(renders.sort(), pairs.map((p) => path.basename(p.default.render.file)).sort(), renders.join(', '));
}));

check('the window\'s shape: frames (one flat list, no scene labels), text as a list, photos in one row with No photo and no percentages, then Generate thumbnails, then the results; nothing drawn on a click', () => {
  const html = fs.readFileSync(path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-window.html'), 'utf8');
  const at = (re) => { const m = html.search(re); assert.ok(m >= 0, `missing ${re}`); return m; };
  const order = [at(/<span class="step">1<\/span> Frames/), at(/<span class="step">2<\/span> Text/), at(/<span class="step">3<\/span> Photos/), at(/>Generate thumbnails<\/button>/), at(/<h3>Your thumbnails<\/h3>/)];
  assert.deepStrictEqual([...order].sort((a, b) => a - b), order, 'frames, text, photos, Generate, then the results');
  assert.ok(/\[disabled\]="generateWhy\(\) !== null"/.test(html) && /@if \(generateWhy\(\); as why\)/.test(html), 'Generate is disabled with its reason written beside it');
  assert.ok(!/sceneLabel|Scene \d|scene-label/.test(html), 'no scene labels');
  assert.ok(!/Show more|toggleShowMore/.test(html), 'no Show more: every candidate is in the grid');
  assert.ok(/in time order: the sharpest of each shot/.test(html) && /Start from the suggested words/.test(html), 'the grid says what it is; the suggestion is the words only');
  assert.ok(!/percent\(|%<\/span>|\bpct\b/.test(html), 'no percentages');
  assert.ok(/No photo/.test(html) && /removeNoPhoto\(k\)/.test(html), 'No photo, taken out on its badge');
  const scss = fs.readFileSync(path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-window.scss'), 'utf8');
  assert.ok(/\.texts \{ display: flex; flex-direction: column;/.test(scss), 'the text is a vertical list');
  const win = fs.readFileSync(path.join(REPO, 'frontend/src/app/components/thumbnails-window/thumbnails-window.ts'), 'utf8');
  const changed = win.slice(win.indexOf('private changed(): void {'), win.indexOf('async generate(): Promise<void> {'));
  assert.ok(!/renderPair|savePicks|sync\(/.test(changed), 'a change to the picks draws nothing and saves nothing');
  assert.ok(/async generate\(\)[\s\S]*thumbnailsRenderPair[\s\S]*thumbnailsSavePicks/.test(win), 'Generate draws, then saves the picks');
});

check('the border: drawPair hands the renderer the kept border when the look has it on; none when the look has it off or none is kept; the run says which', () => withWorld({}, async (world) => {
  const { job, itemId, window, rec } = await windowOver(world);
  const { userData, root, setup } = world;
  const borderFile = path.join(root, 'Downloads', 'thumbnail-border.png');
  fs.mkdirSync(path.dirname(borderFile), { recursive: true });
  fs.writeFileSync(borderFile, PNG_BYTES);
  const kept = library.setLibraryBorder(userData, borderFile, () => {});
  await window.renderPair(job.jobId, itemId, { pair: 1, phrase: null });
  assert.strictEqual(world.renders.filter((r) => r !== 'closed').pop().borderFile, kept, 'the kept border, under the words');
  const off = { ...setup, style: { ...setup.style, border: false } };
  const renderer = off.openRenderer();
  const frame = rec.frames.find((f) => f.id === rec.pairs[0].default.frameId);
  await pipeline.drawPair({ renderer, ffmpeg: FFMPEG, video: rec.source.video, folder: rec.folder, frame: { id: frame.id, t: frame.t }, phrase: 'X', photo: null, logo: false, style: off.style, userDataPath: userData, outStem: path.join(rec.folder, 'border off') });
  assert.strictEqual(world.renders.filter((r) => r !== 'closed').pop().borderFile, null, 'switched off in the look: none');
  fs.rmSync(library.borderDir(userData), { recursive: true });
  await pipeline.drawPair({ renderer, ffmpeg: FFMPEG, video: rec.source.video, folder: rec.folder, frame: { id: frame.id, t: frame.t }, phrase: 'X', photo: null, logo: false, style: setup.style, userDataPath: userData, outStem: path.join(rec.folder, 'no border kept') });
  assert.strictEqual(world.renders.filter((r) => r !== 'closed').pop().borderFile, null, 'none kept: none');
  // The drawing order is the page's: frame, border, patch and words, photo, logo.
  const page = fs.readFileSync(path.join(REPO, 'electron/services/thumbnails/canvas-page.ts'), 'utf8');
  const draw = page.slice(page.indexOf('async function pageDraw'), page.indexOf('// ── in the main process'));
  const idx = ['ctx.drawImage(img, 0, 0, W, H)', 'ctx.drawImage(border, 0, 0, W, H)', 'ctx.fillText(line.text', 'ctx.drawImage(photo, r.x', 'ctx.drawImage(logo, l.x'].map((s) => draw.indexOf(s));
  assert.ok(idx.every((i) => i > 0) && idx.every((i, k) => k === 0 || i > idx[k - 1]), `frame, border, words, photo, logo in that order (${idx})`);
  assert.ok(!/vignette/.test(draw), 'the procedural vignette is gone');
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
  assert.ok(!/'thumbnails:frames'|thumbnailsFrames/.test(preload + ipc + bridge), 'no frames channel (Show more is gone)');
});

run('thumbnails in the metadata run and the reports page\'s window: the story link, stage order and the grid, words per title, no story, failures, off, storage, ordered picks, swaps, own image, rewrite for a title, screenshots, delete, finish, picking and Generate, the window\'s shape, the border, the tab, the judge and the frame scoring gone');
