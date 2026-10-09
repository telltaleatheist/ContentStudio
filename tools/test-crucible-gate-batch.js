/**
 * THE RE-ROLL GATE INSIDE A STAGE-MAJOR BATCH (LEDGER #266, #270, #279), over the REAL gate
 * (reroll.service.ts `rerollGateItem` -> gate.ts `runGate`), the real AI manager, lanes, sessions,
 * transport and fan-out, against tools/fake-crucible.js. Only `claude -p` is a stand-in: the AI
 * manager's `makeClaudeCliRequest` is replaced on the instance, so its call still goes through the
 * real cloud route of the lane (`queueAITask`), and nothing is spawned.
 *
 * WHAT WAS SEEN LIVE (2026-10-09 17:56, a batch of 4 on crucible@owens-mac-studio): every member
 * went into `gate-check-0` at once; the first fanned out its decide calls, took the call turn and
 * finished its gate; the next got a few decide calls answered; then nothing was sent again, and
 * three jobs sat 'between' at gate-check-0 with no call in flight, no waiter and no timer until
 * Crucible ended the idle session. Each job here is the metadata pipeline's gate as
 * metadata-generator.service.ts wires it: a `fields` stage with one 27B field call, the gate with
 * `phase` mapped to the batch's gate stages, then `finish`. Every job must settle within a few
 * seconds; one that does not fails the check naming where every member stood.
 *
 * Run it against the COMPILED main process: `npm run build:electron && node tools/test-crucible-gate-batch.js`.
 */
const path = require('path');
const { assert, fake, context, check, run, crucible, logged } = require('./_crucible-keeper');

const REPO = path.join(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
services('metadata/prompt-assets.js').initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));

const { installCrucibleTransport } = crucible('transport');
const { installLanes, enterJobStage } = crucible('lanes');
const { gateStage } = crucible('batch');
const { loadContextFor } = crucible('context-check');
const gateService = services('metadata/reroll/reroll.service.js');
const settingsM = services('metadata/reroll/settings.js');
const { RoutingModels } = services('metadata/metadata-routing.js');
const { JobModelLifecycle } = services('metadata/model-lifecycle.js');
const { AIManagerService } = services('metadata/ai-manager.service.js');

const NINE = 'qwen3.5-9b';
const BIG = 'qwen3.8-27b-8bit';
const MODELS = [
  { id: BIG, paramsB: 27, installed: true, contextDefault: 98304 },
  { id: NINE, paramsB: 9, installed: true, contextDefault: 16384 },
];
const INVENTORY = {
  server: 'mac', reachable: true, anthropicConfigured: false,
  models: { [BIG]: { offer: 'installed', reason: null }, [NINE]: { offer: 'installed', reason: null } },
};
/** Owen's routing on 2026-10-09: titles on claude -p Fable, every other field on the 27B. */
const ROUTING = { titles: 'claude-cli-fable', chapters: 'qwen38-27b', description: 'qwen38-27b', thumbnail_text: 'qwen38-27b', pinned_comment: 'qwen38-27b', tags: 'qwen38-27b' };
const SETTINGS = settingsM.resolveRerollGateSettings({ rerollGate: 'on' });

/**
 * The scorer: a unit whose text carries WEAK fails every rule it is asked (but the call-to-action
 * question, a waiver, which reads No); everything else passes. The ranking's options get distinct
 * weights so the order is defined.
 */
function decideProbs(q) {
  if (q.type === 'yesno') return /WEAK/.test(q.instructions) && !/_cta$/.test(q.name) ? { Yes: 0.95, No: 0.05 } : { Yes: 0.02, No: 0.98 };
  return Object.fromEntries(q.labels.map((l, i) => [l, (q.labels.length - i) / 10]));
}

/** A rewrite: the units the re-roll prompt ends with (every one of them failed), WEAK taken out. */
function rewrite(prompt) {
  return prompt.trim().split('\n').filter((l) => /WEAK/.test(l)).map((l) => l.replace(/WEAK ?/g, 'fixed ')).join('\n');
}

function chatReply(body) {
  const prompt = String(body.messages[body.messages.length - 1].content);
  if (/^FIELD/.test(prompt)) return { content: 'A field answer', finishReason: 'stop' };
  return { content: rewrite(prompt), finishReason: 'stop' };
}

async function world(options = {}) {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.80', models: MODELS, decideProbs, chatReplies: { '*': chatReply }, ...(options.fake ?? {}) });
  const made = context(options.lanes === undefined ? {} : { lanes: options.lanes });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  made.ctx.servers.select('mac');
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  const close = async () => {
    made.ctx.lanes.stop();
    await made.ctx.sessions.closeAll('the keeper is done');
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
  };
  return { server, ctx: made.ctx, pushed: made.pushed, close };
}

/** One generated item as the gate reads it; `weak` lists the fields given a failing unit. */
function itemFor(jobId, links, weak) {
  const w = (field, text) => (weak.includes(field) ? `WEAK ${text}` : text);
  return {
    _title: jobId,
    _prompt_set: 'youtube-telltale',
    _prompt_trace: [],
    titles: [w('titles', `The council budget vote ${jobId}`), 'The mayor walks out', 'A night of budget debate', 'Why the vote stalled'],
    chapters: [
      { title: w('chapters', 'The budget vote'), startTime: 0 },
      { title: 'The walkout', startTime: 60 },
      { title: 'What comes next', startTime: 120 },
    ],
    description_hook: 'The council fought over the budget all night.',
    description: `The council voted on the budget after a long debate. ${w('description', 'The mayor then walked out of the meeting.')} Nobody knows what comes next.` + (links === '' ? '' : `\n\n${links}`),
    thumbnail_text: ['BUDGET VOTE', 'WALKOUT'],
    pinned_comment: ['Would you have voted for it?'],
  };
}

/**
 * One job's fields-to-finish, as metadata-generator.service.ts runs it in a batch: the `fields`
 * stage (one 27B field call), the gate with `phase` on the batch's gate stages, then `finish`.
 */
function gateJob(w, jobId, options = {}) {
  const out = { cli: [], item: null, warnings: [] };
  out.work = async (run) => {
    const lifecycle = new JobModelLifecycle(`the gate keeper job ${jobId}`);
    const ai = new AIManagerService({ promptSetsDir: path.join(REPO, 'electron', 'assets'), promptSet: 'youtube-telltale', transcriptCeiling: 'local', jobSessions: lifecycle.sessions, abortSignal: run.controller.signal });
    ai.loadPrompts();
    // `claude -p`'s stand-in: the real cloud route through the lane, no spawn.
    ai.makeClaudeCliRequest = async (prompt, model) => {
      out.cli.push(model);
      await new Promise((r) => setTimeout(r, 15));
      return rewrite(prompt);
    };
    try {
      await enterJobStage('fields', [{ model: BIG, tokens: 24576, why: `${jobId}'s field call` }]);
      const field = `FIELD for ${jobId}`;
      await ai.runPlainRequest(field, BIG, `${jobId}'s field call`, { thinking: false, maxTokens: 2048, loadContext: loadContextFor(field.length, 2048) });
      const item = itemFor(jobId, ai.descriptionLinks(), options.weak ?? []);
      out.item = item;
      await gateService.rerollGateItem(item, {
        settings: SETTINGS,
        aiManager: ai,
        routing: ROUTING,
        models: RoutingModels.on(INVENTORY, () => undefined),
        lifecycle,
        warnings: out.warnings,
        sourceLabel: jobId,
        signal: run.controller.signal,
        phase: async (phase) => {
          await enterJobStage(gateStage(phase));
          if (options.onPhase) await options.onPhase(phase);
        },
      });
      await enterJobStage('finish');
      return item;
    } finally {
      await lifecycle.releaseAll();
    }
  };
  return out;
}

/** Plan the rows as one batch and start every one at once, as the inputs page does. */
async function startBatch(w, jobs) {
  const ids = Object.keys(jobs);
  const plan = await w.ctx.lanes.plan(ids.map((jobId) => ({ jobId, fast: false })));
  assert.deepStrictEqual(plan.start.map((s) => s.batch?.of), ids.map(() => ids.length), 'one batch of all of them');
  const controllers = {};
  const outcomes = {};
  for (const { jobId } of plan.start) {
    controllers[jobId] = new AbortController();
    outcomes[jobId] = w.ctx.lanes.runJob({ jobId, fast: false, stage: 'fields', controller: controllers[jobId] }, (r) => jobs[jobId].work(r))
      .then((o) => ({ ok: o }), (err) => ({ err }));
  }
  return { controllers, outcomes };
}

/** Every outcome within `ms`, or a failure naming who never settled and where every member stood. */
async function settledWithin(w, outcomes, ms = 8000) {
  const ids = Object.keys(outcomes);
  const done = {};
  for (const id of ids) void outcomes[id].then((o) => { done[id] = o; });
  const deadline = Date.now() + ms;
  while (Object.keys(done).length < ids.length) {
    if (Date.now() > deadline) {
      const stuck = ids.filter((id) => done[id] === undefined);
      throw new Error(`HUNG: ${stuck.join(', ')} never settled within ${ms} ms; the batch: ${JSON.stringify(w.ctx.lanes.batchViews())}`);
    }
    await new Promise((r) => setTimeout(r, 10));
  }
  return done;
}

const decidesOf = (item) => item._prompt_trace.filter((t) => t.act === 'decide').length;

check('(a) four jobs, every check passes: each job\'s gate decides fan out under the call turn, and every job settles', async () => {
  const w = await world();
  try {
    const jobs = { f1: gateJob(w, 'f1'), f2: gateJob(w, 'f2'), f3: gateJob(w, 'f3'), f4: gateJob(w, 'f4') };
    const q = await startBatch(w, jobs);
    const done = await settledWithin(w, q.outcomes);
    for (const id of Object.keys(jobs)) assert.ok(done[id].ok?.kind === 'done', `${id} finished (${done[id].err?.message ?? ''})`);
    for (const id of Object.keys(jobs)) {
      assert.ok(decidesOf(jobs[id].item) >= 6, `${id} asked every field's checks and the ranking (${decidesOf(jobs[id].item)})`);
      assert.strictEqual(jobs[id].item.reroll_gate.mode, 'on');
      assert.ok(jobs[id].item.reroll_gate.ranking, `${id}'s titles were ranked`);
    }
    assert.ok(Object.keys(jobs).every((id) => logged.some((l) => l.text.startsWith(`[RerollGate] ${id}: `))), 'every job logged its gate summary');
    // The live run's shape: the session asked the width question for 2, 3, 4 decides in flight at 8192.
    assert.ok(logged.some((l) => /can serve qwen3\.5-9b with [2-9] requests of 8192 tokens in flight/.test(l.text)), 'a job\'s decide calls were in flight together');
    assert.deepStrictEqual(w.server.loadsUnderAnswers, []);
    assert.deepStrictEqual(w.ctx.lanes.batchViews(), [], 'the batch is gone');
  } finally {
    await w.close();
  }
});

check('(b) units fail check-0: revise-1 runs on the 27B and on the claude -p stand-in, check-1 passes them, and every job settles', async () => {
  const w = await world();
  try {
    const weak = ['titles', 'chapters', 'description'];
    const jobs = { f1: gateJob(w, 'f1', { weak }), f2: gateJob(w, 'f2', { weak }), f3: gateJob(w, 'f3', { weak }), f4: gateJob(w, 'f4', { weak }) };
    const q = await startBatch(w, jobs);
    const done = await settledWithin(w, q.outcomes);
    for (const id of Object.keys(jobs)) {
      assert.ok(done[id].ok?.kind === 'done', `${id} finished (${done[id].err?.message ?? ''})`);
      const item = jobs[id].item;
      assert.deepStrictEqual(item.reroll_gate.fields.map((f) => [f.field, f.rerolls]), [['titles', 1], ['chapters', 1], ['description', 1], ['thumbnail_text', 0], ['pinned_comment', 0]]);
      assert.ok(!/WEAK/.test(JSON.stringify([item.titles, item.chapters, item.description])), `${id}'s weak units were rewritten`);
      assert.deepStrictEqual(jobs[id].cli, ['fable'], `${id}'s titles rewrite went to the claude -p stand-in`);
    }
    assert.deepStrictEqual(w.server.loadsUnderAnswers, []);
  } finally {
    await w.close();
  }
});

check('(c) mixed, the live shape: the first job needs no rewrite and reaches finish, the other three need rewrites; every job settles', async () => {
  const w = await world();
  try {
    const weak = ['chapters', 'description', 'titles'];
    const jobs = { f2: gateJob(w, 'f2'), f1: gateJob(w, 'f1', { weak }), f3: gateJob(w, 'f3', { weak: ['description'] }), f4: gateJob(w, 'f4', { weak }) };
    const q = await startBatch(w, jobs);
    const done = await settledWithin(w, q.outcomes);
    for (const id of Object.keys(jobs)) assert.ok(done[id].ok?.kind === 'done', `${id} finished (${done[id].err?.message ?? ''})`);
    assert.deepStrictEqual(jobs.f2.item.reroll_gate.fields.map((f) => f.rerolls), [0, 0, 0, 0, 0]);
    assert.deepStrictEqual(jobs.f3.item.reroll_gate.fields.map((f) => f.rerolls), [0, 0, 1, 0, 0]);
    // A wait line that clears is replaced by what the job does now: no row keeps an old "ahead of it".
    assert.ok(w.pushed.batchWait.some((x) => x.jobId === 'f2' && /^Next: writing thumbnail words and saving\. Waiting because/.test(x.line)), 'f2 waited at finish, said');
    for (const id of Object.keys(jobs)) {
      const last = w.pushed.batchWait.filter((x) => x.jobId === id).at(-1);
      assert.ok(last !== undefined && /^Now: /.test(last.line), `${id}'s row ends on what it did, not a wait: ${JSON.stringify(last)}`);
    }
    assert.ok(w.pushed.batchWait.every((x) => x.line !== null), 'the row is never sent an empty line');
  } finally {
    await w.close();
  }
});

check('(d) a Stop on one job mid-gate (in its rewrites) ends that job only; the others settle', async () => {
  const w = await world();
  try {
    let stop;
    const weak = ['description', 'chapters'];
    const jobs = {
      f1: gateJob(w, 'f1', { weak }),
      f2: gateJob(w, 'f2', { weak, onPhase: async (phase) => { if (phase === 'revise-1') await stop(); } }),
      f3: gateJob(w, 'f3', { weak }),
      f4: gateJob(w, 'f4'),
    };
    const q = await startBatch(w, jobs);
    stop = async () => {
      q.controllers.f2.abort(new Error('Stopped by the user'));
      await w.ctx.lanes.stopJob('f2', 'Stopped by the user');
    };
    const done = await settledWithin(w, q.outcomes);
    assert.ok(done.f2.err && /Stopped by the user|cancel/i.test(done.f2.err.message), `f2 stopped (${done.f2.err?.message ?? 'it finished'})`);
    for (const id of ['f1', 'f3', 'f4']) assert.ok(done[id].ok?.kind === 'done', `${id} finished (${done[id].err?.message ?? ''})`);
  } finally {
    await w.close();
  }
});

check('the turnstile: a member\'s local calls sent together while another holds the call turn ALL go when its turn comes (none is lost)', async () => {
  const { StageBatch } = crucible('batch');
  const b = new StageBatch('b', 'mac', ['a', 'c']);
  b.arrive('a'); b.arrive('c');
  await Promise.all([b.enter('a', 'fields'), b.enter('c', 'fields')]);
  const aDone = await b.takeCall('a', 'm');
  let went = 0;
  const cCalls = [1, 2, 3].map(() => b.takeCall('c', 'm').then((done) => { went += 1; return done; }));
  await new Promise((r) => setImmediate(r));
  assert.strictEqual(went, 0, 'c waits for the turn');
  aDone();
  const dones = await Promise.race([Promise.all(cCalls), new Promise((_, reject) => setTimeout(() => reject(new Error(`HUNG: ${went} of c's 3 calls got the turn`)), 500))]);
  assert.strictEqual(went, 3, 'all three of c\'s calls went');
  for (const d of dones) d();
  assert.strictEqual(b.end('a'), false);
  assert.strictEqual(b.end('c'), true);
});

check('the pending-work watch, live: a member whose decide never answers is named in the log and on its row (job, stage, steps); once it moves, its row gets its batch line back', async () => {
  let release;
  const held = new Promise((r) => { release = r; });
  const w = await world({
    lanes: { pendingStallMs: 300, pendingCheckEveryMs: 20 },
    // f3's titles checks hang until the check lets them go.
    fake: { holdAnswer: (kind, body) => (kind === 'decide' && /budget vote f3/.test(String(body.state)) ? held : undefined) },
  });
  try {
    const jobs = { f1: gateJob(w, 'f1'), f2: gateJob(w, 'f2'), f3: gateJob(w, 'f3') };
    const q = await startBatch(w, jobs);
    const deadline = Date.now() + 5000;
    let stall;
    while (!(stall = logged.find((l) => l.level === 'warn' && /^\[crucible\] f3 at gate-check-0: Nothing has moved for \d+ s/.test(l.text)))) {
      if (Date.now() > deadline) throw new Error(`f3's stall was never named: ${JSON.stringify(w.ctx.lanes.batchViews())}`);
      await new Promise((r) => setTimeout(r, 10));
    }
    assert.ok(/the re-roll gate's check-0 gate|the gate's check-0 of titles/.test(stall.text) && /the decide re-roll gate: titles rule checks for f3/.test(stall.text), stall.text);
    assert.ok(w.pushed.batchWait.some((x) => x.jobId === 'f3' && /^Nothing has moved for/.test(x.line)), 'the same line on f3\'s row');
    assert.ok(!logged.some((l) => l.level === 'warn' && /^\[crucible\] f[12] .*Nothing has moved/.test(l.text)), 'f1 and f2 wait on the batch, and are not named');
    assert.ok(w.ctx.lanes.pendingOf('f3').some((s) => /the local call .* on qwen3\.5-9b/.test(s.label)));
    release();
    const done = await settledWithin(w, q.outcomes);
    for (const id of Object.keys(jobs)) assert.ok(done[id].ok?.kind === 'done', `${id} finished (${done[id].err?.message ?? ''})`);
    const f3 = w.pushed.batchWait.filter((x) => x.jobId === 'f3');
    const after = f3.slice(f3.findIndex((x) => /^Nothing has moved/.test(x.line)) + 1);
    assert.ok(after.length > 0 && /^(Now|Next): /.test(after[0].line), `f3's row got its batch line back: ${JSON.stringify(after[0])}`);
    assert.deepStrictEqual(w.ctx.lanes.pendingOf('f3'), [], 'nothing left registered');
  } finally {
    release();
    await w.close();
  }
});

check('the pending-work watch: a step pending past the limit is named once, with its job, stage and age; ended steps are forgotten', async () => {
  const watch = crucible('pending-work');
  const said = [];
  const registry = new watch.PendingWork({ limitMs: 50, everyMs: 10, onStall: (stall) => said.push(stall) });
  try {
    const end = registry.start('j1', 'decide: titles rule checks');
    const quick = registry.start('j2', 'revise: description');
    quick();
    registry.setStage('j1', 'gate-check-0');
    await new Promise((r) => setTimeout(r, 120));
    assert.strictEqual(said.length, 1, `named once: ${JSON.stringify(said)}`);
    assert.strictEqual(said[0].jobId, 'j1');
    assert.strictEqual(said[0].stage, 'gate-check-0');
    assert.ok(/decide: titles rule checks/.test(said[0].line) && /\d+ s/.test(said[0].line), said[0].line);
    end();
    assert.deepStrictEqual(registry.pendingOf('j1'), []);
    registry.forget('j1');
  } finally {
    registry.stop();
  }
});

run('crucible: the re-roll gate inside a stage-major batch');
