/**
 * STAGE-MAJOR BATCHES (electron/crucible/batch.ts, LEDGER #266) over the REAL lanes, sessions,
 * transport, asr door and snap chaptering, against tools/fake-crucible.js.
 *
 * Each job here is the metadata pipeline's GPU skeleton, built from the modules the pipeline calls:
 * the asr job (asr.ts `runAsrJob` through the context's asr venue), `finishJobStage()`, the
 * `chapters` gate stating the scorer's need (stage-needs.ts), snap's boundaries on the 9B
 * (`summarize: false`), the `fields` gate stating the writing model's needs, the titles
 * (chaptering/titles.ts) and one long field call on the 27B. What is under test is the batch: that
 * three jobs on one server share ONE queue session and load each model ONCE, at the batch's largest
 * context; that a failure or a Stop ends one job and the others finish; that a row added while a
 * batch runs waits for the next; and that one job alone runs as before.
 *
 * Run it against the COMPILED main process: `npm run build:electron && node tools/test-crucible-batch.js`.
 */
const fs = require('fs');
const path = require('path');
const { assert, fake, context, check, run, crucible, until, tempDir, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
services('metadata/prompt-assets.js').initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));

const { installCrucibleTransport } = crucible('transport');
const { installLanes, enterJobStage, finishJobStage, jobBatch, routeOfModelId } = crucible('lanes');
const { loadContextFor } = crucible('context-check');
const asr = crucible('asr');
const snap = services('metadata/snap-chapters.js');
const routing = services('metadata/metadata-routing.js');
const service = services('metadata/chaptering/chaptering.service.js');
const titles = services('metadata/chaptering/titles.js');
const units = services('metadata/chaptering/units.js');
const needs = services('metadata/stage-needs.js');
const { readRoutingModels } = services('metadata/routing-models.js');

const NINE = 'qwen3.5-9b';
const BIG = 'qwen3.8-27b-4bit';
const ASR = 'qwen3-asr-1.7b';
const MODELS = [
  { id: BIG, paramsB: 27, installed: true, contextDefault: 98304 },
  { id: NINE, paramsB: 9, installed: true, contextDefault: 16384 },
];
const CATALOG = [
  ...MODELS.map((m) => ({ kind: 'model', id: m.id, name: m.id, jobType: 'llm', installed: true, expectedBytes: null })),
  { kind: 'model', id: ASR, name: 'Qwen3-ASR 1.7B', jobType: 'asr', installed: true, expectedBytes: null },
  { kind: 'model', id: 'qwen3-aligner', name: 'Qwen3 aligner', jobType: 'align', installed: true, expectedBytes: null },
];

/** A short two-subject video (snap's keeper's), the same for every job. */
const CAPTIONS = Array.from({ length: 40 }, (_, i) => ({
  start: i * 10,
  end: i * 10 + 10,
  text: i < 20 ? `The council budget vote number ${i} went on for a long while tonight.` : `Then the mayor walked out of meeting number ${i} in a huff.`,
}));

function decideProbs(q) {
  if (q.type === 'yesno') return { Yes: 0.1, No: 0.9 };
  const budget = /budget/.test(q.instructions);
  return Object.fromEntries(q.labels.map((l, i) => [l, i === (budget ? 0 : 1) ? 0.95 : 0.05 / (q.labels.length - 1)]));
}

function chatReply(body) {
  if (body.model === NINE) return { content: 'Budget vote\nMayor walks out', finishReason: 'stop' };
  const prompt = body.messages[body.messages.length - 1].content;
  if (/^FIELD/.test(prompt)) return { content: 'A field answer', finishReason: 'stop' };
  return { content: 'The council budget vote\nThe council voted on the budget.', finishReason: 'stop' };
}

/** The field call's prompt for a job whose content is `chars` long. */
const fieldPrompt = (chars) => `FIELD ${'y'.repeat(chars)}`;
/** Job 3's content: a field call that needs 32,768 where a thinking title needs 24,576. */
const LONG = 87_500;

async function world() {
  const server = await fake.startFakeCrucible({
    name: 'crucible@mac', version: '1.0.80', models: MODELS, catalog: CATALOG, installedJobTypes: ['echo', 'llm', 'asr', 'align'],
    decideProbs, chatReplies: { '*': chatReply }, asr: { stepMs: 2, decodeFrames: 1, transcribeFrames: 1 },
  });
  const made = context();
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  made.ctx.servers.select('mac');
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  const resolved = routing.resolveMetadataRouting({ chapters: 'qwen38-27b' });
  const bound = await readRoutingModels('the batch keeper', [resolved.chapters]);
  const audio = path.join(tempDir('cs-batch-audio-'), 'clip.flac');
  fs.writeFileSync(audio, Buffer.alloc(2048, 7));
  const close = async () => {
    made.ctx.lanes.stop();
    await made.ctx.sessions.closeAll('the keeper is done');
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
  };
  return { server, ctx: made.ctx, pushed: made.pushed, resolved, bound, audio, close };
}

/**
 * One job's GPU skeleton, in pipeline order. `hooks` lets a check hold a stage or fail one:
 * `inChapters(jobId)` runs inside the chapters turn, `contentChars` sizes the field call.
 */
function pipeline(w, jobId, hooks = {}) {
  const stages = [];
  return {
    stages,
    work: async () => {
      stages.push(['transcribe', jobBatch()?.id ?? null]);
      const venue = w.ctx.asrVenue();
      const held = await venue.session({});
      await asr.runAsrJob({
        venue, inSession: async () => held.client, params: asr.asrParams('a keeper video'), file: w.audio, filename: 'clip.flac',
        clientRef: `contentstudio:keeper:${jobId}:${Math.random().toString(36).slice(2)}`, doorDelaysMs: [], streamDelaysMs: [], uploadTickMs: 1000,
      });
      await held.release();
      finishJobStage();

      const models = routing.resolveSnapChapterModels(w.resolved, w.ctx.lanes.gpuVenue(), w.bound);
      const job = w.ctx.transport.job(`the keeper job ${jobId}`);
      const t = snap.snapTransports({ models, job, trace: [], laneName: `keeper-${jobId}` });
      const sentenceUnits = units.sentenceUnits(units.captionsOf(CAPTIONS));
      await enterJobStage('chapters', [needs.scorerNeed(sentenceUnits, NINE, 'outline', jobId)]);
      stages.push(['chapters']);
      if (hooks.inChapters) await hooks.inChapters(jobId);
      const boundaries = await service.chapter(CAPTIONS, { granularity: 'chapters', chat: t.chat, decide: t.decide, summarize: false });

      const chars = hooks.contentChars ?? 2_000;
      await enterJobStage('fields', [
        needs.titleNeed(boundaries, BIG, { videoTitle: 'Keeper', label: jobId }),
        { model: BIG, tokens: loadContextFor(fieldPrompt(chars).length, 2048), why: `${jobId}'s field call` },
      ]);
      stages.push(['fields']);
      const titled = await titles.titleChapters(boundaries, { chat: t.chat, videoTitle: 'Keeper', speakerRoles: units.speakerRolesOf(CAPTIONS) });
      await w.ctx.lanes.aiCall(routeOfModelId(BIG), `${jobId} field`, () => w.ctx.transport.chat({
        model: BIG, prompt: fieldPrompt(chars), act: 'generate', thinking: false, maxTokens: 2048,
        loadContext: loadContextFor(fieldPrompt(chars).length, 2048), job, what: `${jobId}'s field call`, trace: null,
      }));
      await job.releaseAll();
      return titled.chapters.map((c) => c.title);
    },
  };
}

const ours = (server) => server.sessions.filter((row) => row.status !== undefined && /^contentstudio/.test(row.client ?? ''));
const loadsOf = (server) => server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b && b.type === 'load-model').map((b) => [b.model, b.params?.context ?? null]);

/** Plan the rows, then start every `start` row at once, as the inputs page does. */
async function startQueue(w, jobIds, pipelines) {
  const plan = await w.ctx.lanes.plan(jobIds.map((jobId) => ({ jobId, fast: false })));
  const controllers = {};
  const outcomes = {};
  for (const start of plan.start) {
    controllers[start.jobId] = new AbortController();
    outcomes[start.jobId] = w.ctx.lanes.runJob(
      { jobId: start.jobId, fast: false, stage: 'transcribe', controller: controllers[start.jobId] },
      () => pipelines[start.jobId].work(),
    ).then((o) => ({ ok: o }), (err) => ({ err }));
  }
  return { plan, controllers, outcomes };
}

check('three jobs on one server are ONE batch: one session, each model loaded once (the 27B at the batch\'s largest need), every job\'s stage before anyone\'s next', async () => {
  const w = await world();
  try {
    const p = { j1: pipeline(w, 'j1'), j2: pipeline(w, 'j2'), j3: pipeline(w, 'j3', { contentChars: LONG }) };
    const q = await startQueue(w, ['j1', 'j2', 'j3'], p);
    assert.deepStrictEqual(q.plan.start.map((s) => [s.jobId, s.server, s.batch?.position, s.batch?.of]), [['j1', 'mac', 1, 3], ['j2', 'mac', 2, 3], ['j3', 'mac', 3, 3]]);
    const results = await Promise.all(['j1', 'j2', 'j3'].map((id) => q.outcomes[id]));
    for (const r of results) assert.ok(r.ok && r.ok.kind === 'done', `every job finished (${r.err?.message ?? ''})`);
    assert.deepStrictEqual(results[0].ok.value, ['The council budget vote', 'The council budget vote']);

    assert.strictEqual(w.server.requestsTo('/v1/queue/sessions', 'POST').length, 1, 'one queue session for the whole batch');
    assert.deepStrictEqual(w.server.cardLoads, [ASR, NINE, BIG], 'the card took the asr model, the 9B and the 27B once each, for three jobs');
    assert.deepStrictEqual(loadsOf(w.server), [[NINE, 8192], [BIG, 32768]], 'the 9B once, then the 27B once, at the largest need any job stated (j3\'s field call)');
    const [row] = ours(w.server);
    assert.deepStrictEqual([row.status, row.reason], ['closed', 'client'], 'closed when the last job ended');
    assert.deepStrictEqual(w.ctx.ledger.read(), []);

    // Stage-major: every asr job before the first decide, every decide before the first 27B chat.
    const order = w.server.requests.map((r) => (r.path === '/v1/jobs' && r.method === 'POST' ? r.body?.type : r.path === '/v1/decide' ? 'decide' : r.path.startsWith('/v1/openai/chat') ? r.body?.model : null)).filter(Boolean);
    const last = (x) => order.lastIndexOf(x);
    const first = (x) => order.indexOf(x);
    assert.strictEqual(order.filter((x) => x === 'asr').length, 3);
    assert.ok(last('asr') < first('decide'), 'all three transcriptions before the first decide');
    assert.ok(last('decide') < first(BIG) && last(NINE) < first(BIG), 'every 9B call before the first 27B call');
    assert.ok(p.j1.stages.length === 3 && p.j1.stages[0][1] === q.plan.start[0].batch.id);
    // The rows were told they waited for the batch's next stage.
    assert.ok(w.pushed.batchWait.some((x) => x.jobId === 'j2' && /Waiting (for the batch's|its turn for) /.test(x.line ?? '')), JSON.stringify(w.pushed.batchWait.slice(0, 4)));
    assert.deepStrictEqual(w.ctx.lanes.batchViews(), [], 'the batch is gone');
    assert.strictEqual(w.ctx.lanes.view().lanes[0].runningJobId, null, 'the lane is free');
  } finally {
    await w.close();
  }
});

check('a failure in one job ends that job only: the batch carries on, still one session and each model once', async () => {
  const w = await world();
  try {
    const p = {
      j1: pipeline(w, 'j1'),
      j2: pipeline(w, 'j2', { inChapters: async () => { throw new Error('j2 broke in its chapters stage'); } }),
      j3: pipeline(w, 'j3'),
    };
    const q = await startQueue(w, ['j1', 'j2', 'j3'], p);
    const [r1, r2, r3] = await Promise.all(['j1', 'j2', 'j3'].map((id) => q.outcomes[id]));
    assert.ok(r2.err && /j2 broke/.test(r2.err.message), 'j2 failed by its own words');
    assert.ok(r1.ok?.kind === 'done' && r3.ok?.kind === 'done', 'j1 and j3 finished');
    assert.strictEqual(w.server.requestsTo('/v1/queue/sessions', 'POST').length, 1);
    assert.deepStrictEqual(w.server.cardLoads, [ASR, NINE, BIG]);
    assert.deepStrictEqual(loadsOf(w.server), [[NINE, 8192], [BIG, 24576]]);
    assert.deepStrictEqual(p.j2.stages.map((s) => s[0]), ['transcribe', 'chapters'], 'j2 never reached fields');
  } finally {
    await w.close();
  }
});

check('a Stop on one job while it waits at a stage gate stops that job only; the others finish', async () => {
  const w = await world();
  try {
    let release;
    const holding = new Promise((resolve) => { release = resolve; });
    let j1InChapters;
    const j1Reached = new Promise((resolve) => { j1InChapters = resolve; });
    const p = {
      j1: pipeline(w, 'j1', { inChapters: async () => { j1InChapters(); await holding; } }),
      j2: pipeline(w, 'j2'),
      j3: pipeline(w, 'j3'),
    };
    const q = await startQueue(w, ['j1', 'j2', 'j3'], p);
    await j1Reached;
    // j1 holds the chapters turn; j2 waits at the chapters gate for it.
    await until(() => w.ctx.lanes.batchViews()[0]?.members.find((m) => m.jobId === 'j2')?.state === 'waiting');
    q.controllers.j2.abort(new Error('Stopped by the user'));
    await w.ctx.lanes.stopJob('j2', 'Stopped by the user');
    const r2 = await q.outcomes.j2;
    assert.ok(r2.err && /Stopped by the user/.test(r2.err.message), `j2 stopped (${r2.err?.message})`);
    release();
    const [r1, r3] = await Promise.all([q.outcomes.j1, q.outcomes.j3]);
    assert.ok(r1.ok?.kind === 'done' && r3.ok?.kind === 'done');
    assert.deepStrictEqual(p.j2.stages.map((s) => s[0]), ['transcribe'], 'j2 did no chapter work');
    assert.strictEqual(w.server.decideBodies().length > 0, true);
    assert.strictEqual(w.server.requestsTo('/v1/queue/sessions', 'POST').length, 1);
    assert.deepStrictEqual(loadsOf(w.server), [[NINE, 8192], [BIG, 24576]]);
  } finally {
    await w.close();
  }
});

check('a row added while a batch runs waits for the next batch; one row alone runs as before (no batch, no gates)', async () => {
  const w = await world();
  try {
    let release;
    const holding = new Promise((resolve) => { release = resolve; });
    const p = { j1: pipeline(w, 'j1', { inChapters: () => holding }), j2: pipeline(w, 'j2'), j4: pipeline(w, 'j4') };
    const q = await startQueue(w, ['j1', 'j2'], p);
    const later = await w.ctx.lanes.plan([{ jobId: 'j4', fast: false }]);
    assert.deepStrictEqual(later.start, []);
    assert.deepStrictEqual([later.waiting[0].jobId, later.waiting[0].batchOf, later.waiting[0].parked], ['j4', 2, false]);
    assert.ok(/starts with the next batch/.test(later.waiting[0].line));
    release();
    await Promise.all([q.outcomes.j1, q.outcomes.j2]);
    // Alone: no batch on the plan, and the stage gates only record the stage.
    const alone = await startQueue(w, ['j4'], p);
    assert.deepStrictEqual(alone.plan.start, [{ jobId: 'j4', server: 'mac' }]);
    const r4 = await alone.outcomes.j4;
    assert.ok(r4.ok?.kind === 'done');
    assert.deepStrictEqual(p.j4.stages[0], ['transcribe', null], 'not in a batch');
    assert.strictEqual(w.server.requestsTo('/v1/queue/sessions', 'POST').length, 2, 'the batch\'s session, then the single job\'s');
  } finally {
    await w.close();
  }
});

check('a batch takes at most MAX_BATCH (4) jobs in queue order; the rest wait for the next batch, said', async () => {
  const w = await world();
  try {
    const ids = ['j1', 'j2', 'j3', 'j4', 'j5', 'j6'];
    const plan = await w.ctx.lanes.plan(ids.map((jobId) => ({ jobId, fast: false })));
    assert.deepStrictEqual(plan.start.map((s) => [s.jobId, s.batch.position, s.batch.of]), [['j1', 1, 4], ['j2', 2, 4], ['j3', 3, 4], ['j4', 4, 4]]);
    assert.deepStrictEqual(plan.waiting.map((r) => [r.jobId, r.batchOf, r.parked]), [['j5', 4, false], ['j6', 4, false]]);
    assert.ok(plan.waiting.every((r) => /starts with the next batch/.test(r.line)));
  } finally {
    await w.close();
  }
});

check('the turnstile: a stage opens only when every member is past the one before; a held job that starts at fields waits for it', () => {
  const { StageBatch } = crucible('batch');
  const opened = [];
  const b = new StageBatch('b', 'mac', ['a', 'b', 'c'], { onStageOpen: (stage, floors) => opened.push([stage, [...floors.values()].map((f) => f.tokens)]) });
  const got = [];
  const enter = (id, stage, tokens) => b.enter(id, stage, { needs: tokens ? [{ model: 'm', tokens, why: id }] : [] }).then(() => got.push(`${id}:${stage}`));
  return (async () => {
    b.arrive('a'); b.arrive('b'); b.arrive('c');
    void enter('c', 'fields', 16384);       // a held job: starts at fields
    await enter('a', 'transcribe');
    void enter('b', 'transcribe');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(got, ['a:transcribe'], 'one turn at a time');
    void enter('a', 'chapters', 8192);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(got, ['a:transcribe', 'b:transcribe'], 'a gave its turn; chapters is not open while b transcribes');
    void enter('b', 'chapters', 16384);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(got.slice(2), ['a:chapters']);
    assert.deepStrictEqual(opened.find((o) => o[0] === 'chapters'), ['chapters', [16384]], 'the floor is the largest need stated at the gate');
    void enter('a', 'fields', 24576);
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(got.slice(3), ['b:chapters']);
    assert.strictEqual(b.end('b'), false, 'b fails; the batch goes on');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(got.slice(4), ['a:fields'], 'fields opens once b is gone; plan order');
    assert.deepStrictEqual(opened.at(-1), ['fields', [24576]]);
    b.finishTurn('a');
    await new Promise((r) => setImmediate(r));
    assert.deepStrictEqual(got.slice(5), ['c:fields']);
    assert.strictEqual(b.end('a'), false);
    assert.strictEqual(b.end('c'), true, 'empty');
  })();
});

run('crucible: stage-major batches (one session, each model once)');
