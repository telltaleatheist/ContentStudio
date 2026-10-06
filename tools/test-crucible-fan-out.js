/**
 * ONE JOB'S INDEPENDENT CALLS GO OUT TOGETHER (LEDGER #270), over the REAL lanes, sessions,
 * transport, AI manager and field units, against tools/fake-crucible.js.
 *
 * What is held:
 *  - a metadata job's independent field calls are IN FLIGHT TOGETHER on the server (titles and the
 *    description on the 27B, the tags on a cloud model), a call that reads another field's answer
 *    (the thumbnail text reads the titles) waits for it and is sent the kept titles, and another
 *    local model's calls (the 9B's pinned comment) wait until the 27B's have all ended: each model
 *    loads once, and nothing is ever loaded under an answer being written;
 *  - the outputs keep the one-at-a-time order whatever order the server answers in: the merged
 *    fields, the warnings and the prompt trace are in plan order;
 *  - Stop aborts every call of the job in flight (the server sees each one hang up);
 *  - a failed field fails the item with its own error once its siblings have settled; a field that
 *    reads it is never sent, and neither is a later model's;
 *  - the slot: a job's calls on one model share it up to the cap, its call on another model waits,
 *    a standalone call waits for the job's calls in flight and nothing of the job jumps it;
 *  - the session: a call that needs the load grown waits for the calls in flight to finish (no load
 *    under an answer); a fan-out's expectation loads once at its largest size; and the width
 *    question: where the server says the card does not hold one more request of that size, the
 *    call waits for one in flight to finish.
 *
 * Run it against the COMPILED main process: `npm run build:electron && node tools/test-crucible-fan-out.js`.
 */
const path = require('path');
const { assert, fake, context, check, run, crucible, until, logged, rejection, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
services('metadata/prompt-assets.js').initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));

const { installCrucibleTransport } = crucible('transport');
const { installLanes, routeOfModelId } = crucible('lanes');
const { loadContextFor } = crucible('context-check');
const { JOB_CALLS_PER_SERVER } = crucible('fan-out');
const tasks = services('metadata/metadata-tasks.js');
const { DescriptionUnit } = services('metadata/description-unit.js');
const { JobModelLifecycle } = services('metadata/model-lifecycle.js');
const { AIManagerService } = services('metadata/ai-manager.service.js');

const BIG = 'qwen3.8-27b-4bit';
const NINE = 'qwen3.5-9b';
const CLOUD = 'anthropic/claude-sonnet-5';
const MODELS = [
  { id: BIG, paramsB: 27, installed: true, contextDefault: 98304 },
  { id: NINE, paramsB: 9, installed: true, contextDefault: 16384 },
];
const CONTENT = 'The council budget vote went on for a long while tonight. Then the mayor walked out of the meeting.';

/** The fake's answer to each call, by what its prompt asks (the keeper's stub prompts open "FIELD <field>"). */
function chatReply(body) {
  const prompt = body.messages[body.messages.length - 1].content;
  const field = /^FIELD (\w+)/.exec(prompt)?.[1] ?? 'description';
  switch (field) {
    case 'titles': return { content: 'The council budget vote\nThe mayor walked out', finishReason: replies.titlesFinish };
    case 'thumbnail_text': return { content: 'BUDGET VOTE\nWALKOUT', finishReason: 'stop' };
    case 'pinned_comment': return { content: 'What would you have voted?', finishReason: 'stop' };
    case 'tags': return { content: 'council budget, budget vote, mayor', finishReason: 'stop' };
    default: return { content: 'The council voted on the budget after a long night of debate. The mayor then walked out of the meeting.', finishReason: 'stop' };
  }
}
const replies = { titlesFinish: 'stop' };

/** Held answers: every local and cloud answer waits here until the check releases it. */
function holder() {
  const held = [];
  return {
    held,
    hold: (kind, body) => new Promise((resolve) => {
      const messages = body.messages;
      const prompt = Array.isArray(messages) ? String(messages[messages.length - 1].content) : String(body.state ?? '');
      held.push({ kind, model: body.model, prompt, field: /^FIELD (\w+)/.exec(prompt)?.[1] ?? (kind === 'chat' ? 'description' : 'decide'), resolve });
    }),
    /** Let the held answer for `field` go (it must be held now). */
    release(field) {
      const i = held.findIndex((h) => h.field === field);
      if (i < 0) throw new Error(`nothing for ${field} is held (held: ${held.map((h) => h.field).join(', ')})`);
      const [h] = held.splice(i, 1);
      h.resolve();
    },
    releaseAll() {
      for (const h of held.splice(0)) h.resolve();
    },
  };
}

async function world(options = {}) {
  const h = holder();
  const server = await fake.startFakeCrucible({
    name: 'crucible@mac', version: '1.0.80', models: MODELS, upstreams: { anthropic: { key: 'sk-keeper' } },
    chatReplies: { '*': chatReply }, holdAnswer: options.hold === false ? undefined : h.hold, ...(options.fake ?? {}),
  });
  const made = context();
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  made.ctx.servers.select('mac');
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  const close = async () => {
    h.releaseAll();
    made.ctx.lanes.stop();
    await made.ctx.sessions.closeAll('the keeper is done');
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
  };
  return { server, ctx: made.ctx, h, close };
}

/** Run `work` as one admitted queue job, as the queue page does. */
async function asJob(w, jobId, work) {
  const plan = await w.ctx.lanes.plan([{ jobId, fast: false }]);
  assert.deepStrictEqual(plan.start.map((s) => s.jobId), [jobId]);
  const controller = new AbortController();
  const outcome = w.ctx.lanes.runJob({ jobId, fast: false, stage: 'fields', controller }, () => work(controller)).then((o) => ({ ok: o }), (err) => ({ err }));
  return { controller, outcome };
}

const local = (model) => ({ id: model === BIG ? 'qwen38-27b' : 'qwen35-9b', kind: 'local', model, label: model });

/**
 * One item's field run, as metadata-generator builds it: the real units over a manager whose field
 * prompt is a stub ("FIELD <field>", plus the titles it reads when it reads them), in the plan's
 * order (grouped by model, titles first): 27B titles, thumbnail text, description; 9B pinned
 * comment; the cloud tags.
 */
function fieldRun(controller) {
  const lifecycle = new JobModelLifecycle('the fan-out keeper job');
  const ai = new AIManagerService({ promptSetsDir: path.join(REPO, 'electron', 'assets'), promptSet: 'youtube-telltale', transcriptCeiling: 'local', jobSessions: lifecycle.sessions, abortSignal: controller.signal });
  ai.loadPrompts();
  ai.buildMetadataFieldPrompt = (spec, ctx) => {
    if (!spec.inputFields.includes('titles')) return `FIELD ${spec.field} for ${ctx.sourceLabel}`;
    const titles = ctx.generated.titles;
    if (!Array.isArray(titles) || titles.length === 0) throw new Error(`the ${spec.field} call needs the titles, and there are none`);
    return `FIELD ${spec.field} reading the titles: ${titles.join(' | ')}`;
  };
  const spec = (field, model, inputFields = []) => ({ field, model, insights: false, inputFields });
  const units = [
    new tasks.LocalFieldUnit(ai, spec('titles', BIG), local(BIG), lifecycle),
    new tasks.LocalFieldUnit(ai, spec('thumbnail_text', BIG, ['titles']), local(BIG), lifecycle),
    new DescriptionUnit(ai, local(BIG), lifecycle),
    new tasks.LocalFieldUnit(ai, spec('pinned_comment', NINE), local(NINE), lifecycle),
    new tasks.CloudFieldUnit(ai, spec('tags', CLOUD)),
  ];
  const warnings = [];
  const ctx = {
    content: CONTENT, contentMode: 'raw', sourceLabel: 'keeper.mov', chapterSubjects: ['Budget vote', 'Walkout'], chapterDetails: ['The vote.', 'The walkout.'],
    digestChapters: [], videoTitle: 'The council budget vote', promptSetName: 'youtube-telltale', entities: ['Council'], phrases: ['budget vote'],
    contentText: CONTENT, contentSpeakerTagged: false, generated: {}, warn: (m) => warnings.push(m),
  };
  const plan = { units, assembleTags: false, assembleHashtags: false, roster: { models: [], summary: '', overBudget: false }, warnings: [], summary: '' };
  return {
    ai, lifecycle, warnings,
    go: async () => {
      try {
        return await tasks.runMetadataTasks(ai, { plan, ctx });
      } finally {
        await lifecycle.releaseAll();
      }
    },
  };
}

const loadsOf = (server) => server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b && b.type === 'load-model').map((b) => [b.model, b.params?.context ?? null]);
const inFlight = (server) => server.answering().map((a) => (a.model === CLOUD ? 'tags' : /^FIELD (\w+)/.exec(a.tag)?.[1] ?? 'description')).sort();

check('one job\'s independent fields are in flight together; the field that reads the titles waits for them; the 9B waits for the 27B; outputs keep the plan\'s order', async () => {
  const w = await world();
  try {
    let item;
    const job = await asJob(w, 'j1', async (controller) => { item = fieldRun(controller); return item.go(); });
    // The titles and the description on the 27B, and the cloud tags: all three at once.
    await until(() => inFlight(w.server).length === 3);
    assert.deepStrictEqual(inFlight(w.server), ['description', 'tags', 'titles'], 'titles, description and tags in flight together');
    assert.strictEqual(w.server.peakAnswering(BIG), 2, 'two 27B calls in flight on the server at once');
    assert.ok(w.ctx.lanes.sendingOn('mac') === 2, `the job's two 27B calls share the slot (sending: ${w.ctx.lanes.sendingOn('mac')})`);
    assert.ok(!w.h.held.some((x) => x.field === 'thumbnail_text' || x.field === 'pinned_comment'), 'the thumbnail text waits for the titles; the 9B waits for the 27B');

    // Answered out of plan order: the tags, then the description, then the titles.
    w.h.release('tags');
    w.h.release('description');
    await until(() => inFlight(w.server).length === 1);
    assert.deepStrictEqual(inFlight(w.server), ['titles']);
    w.h.release('titles');
    // The thumbnail text goes once the titles are kept, and reads them.
    await until(() => w.h.held.some((x) => x.field === 'thumbnail_text'));
    assert.ok(/reading the titles: The council budget vote \| The mayor walked out/.test(w.h.held.find((x) => x.field === 'thumbnail_text').prompt));
    assert.ok(!w.h.held.some((x) => x.field === 'pinned_comment'), 'the 9B still waits: a 27B call is in flight');
    w.h.release('thumbnail_text');
    await until(() => w.h.held.some((x) => x.field === 'pinned_comment'));
    w.h.release('pinned_comment');

    const { ok, err } = await job.outcome;
    assert.ok(ok && ok.kind === 'done', `the job finished (${err?.message ?? ''})`);
    const result = ok.value;
    // The merged fields in plan order: titles, thumbnail text, description (hook, body), pinned, tags.
    assert.deepStrictEqual(Object.keys(result).filter((k) => ['titles', 'thumbnail_text', 'description_hook', 'description', 'pinned_comment', 'tags'].includes(k)),
      ['titles', 'thumbnail_text', 'description_hook', 'description', 'pinned_comment', 'tags']);
    assert.deepStrictEqual(result.titles, ['The council budget vote', 'The mayor walked out']);
    // The trace in plan order, whatever order the answers came in.
    const traced = item.ai.promptTrace.map((e) => (/^the (\w+) call/.exec(e.what)?.[1] ?? (/description/.test(e.what) ? 'description' : e.what)));
    assert.deepStrictEqual(traced, ['titles', 'thumbnail_text', 'description', 'pinned_comment', 'tags'], JSON.stringify(item.ai.promptTrace.map((e) => e.what)));
    // The warnings in plan order (the titles' count, the description's length, the pinned comment's
    // count), though the description was answered before the titles.
    const order = item.warnings.map((m) => (/the (\w+) call on/.exec(m)?.[1] ?? (/description/.test(m) ? 'description' : m)));
    assert.deepStrictEqual(order, ['titles', 'description', 'pinned_comment'], JSON.stringify(item.warnings));

    // Each model loaded once, and never under an answer.
    assert.deepStrictEqual(w.server.cardLoads, [BIG, NINE], 'the 27B once, then the 9B once');
    assert.deepStrictEqual(w.server.loadsUnderAnswers, [], 'no load while an answer was being written');
    assert.strictEqual(w.server.requestsTo('/v1/queue/sessions', 'POST').length, 1, 'one queue session');
    assert.deepStrictEqual(w.server.answering(), [], 'nothing left in flight');
  } finally {
    await w.close();
  }
});

check('Stop aborts every call of the job in flight: the server sees each one hang up, and the job ends cancelled', async () => {
  const w = await world();
  try {
    const job = await asJob(w, 'j2', async (controller) => fieldRun(controller).go());
    await until(() => inFlight(w.server).length === 3);
    job.controller.abort(new Error('Stopped by the user'));
    await w.ctx.lanes.stopJob('j2', 'Stopped by the user');
    const { err } = await job.outcome;
    assert.ok(err, 'the job did not finish');
    await until(() => w.server.answering().length === 0);
    const aborted = w.server.answerLog.filter((e) => e.event === 'aborted').map((e) => (e.model === CLOUD ? 'tags' : /^FIELD (\w+)/.exec(e.tag)?.[1] ?? 'description')).sort();
    assert.deepStrictEqual(aborted, ['description', 'tags', 'titles'], 'all three in-flight calls were hung up on');
    assert.strictEqual(w.server.answerLog.filter((e) => e.event === 'end').length, 0, 'none of them ran to its end');
    assert.ok(!w.server.chatBodies().some((b) => /^FIELD (thumbnail_text|pinned_comment)/.test(b.messages.at(-1).content)), 'nothing after them was sent');
  } finally {
    await w.close();
  }
});

check('a failed field fails the item with its own error once its siblings settle; what reads it, and the next model, are never sent', async () => {
  const w = await world();
  replies.titlesFinish = 'length';
  try {
    const job = await asJob(w, 'j3', async (controller) => fieldRun(controller).go());
    await until(() => inFlight(w.server).length === 3);
    w.h.release('titles');
    // The siblings are still in flight: the item has not failed yet.
    await until(() => inFlight(w.server).length === 2);
    let settled = false;
    void job.outcome.then(() => { settled = true; });
    await new Promise((r) => setTimeout(r, 30));
    assert.strictEqual(settled, false, 'the job waits for the calls it sent');
    w.h.release('description');
    w.h.release('tags');
    const { err } = await job.outcome;
    assert.ok(err && err.code === 'truncated' && /titles/.test(err.message), `the titles' own error: ${err?.message}`);
    const sent = w.server.chatBodies().map((b) => /^FIELD (\w+)/.exec(b.messages.at(-1).content)?.[1] ?? 'description').sort();
    assert.deepStrictEqual(sent, ['description', 'tags', 'titles'], 'the thumbnail text (reads the titles) and the 9B pinned comment were never sent');
    assert.deepStrictEqual(w.server.answering(), []);
  } finally {
    replies.titlesFinish = 'stop';
    await w.close();
  }
});

check('the slot: a job\'s calls on one model share it up to the cap; its call on another model waits; a standalone call waits for them and nothing of the job jumps it', async () => {
  const w = await world({ hold: false });
  try {
    const gates = [];
    const held = (label, order) => () => new Promise((resolve) => { gates.push({ label, resolve: () => { order.push(label); resolve(label); } }); });
    const open = (label) => { const i = gates.findIndex((g) => g.label === label); const [g] = gates.splice(i, 1); g.resolve(); };
    const order = [];
    let standaloneAsked;
    const askStandalone = new Promise((resolve) => { standaloneAsked = resolve; });
    let standaloneQueued;
    const queued = new Promise((resolve) => { standaloneQueued = resolve; });
    const job = await asJob(w, 'j4', async () => {
      const a = [1, 2, 3].map((n) => w.ctx.lanes.aiCall(routeOfModelId(BIG), `a${n}`, held(`a${n}`, order)));
      await until(() => gates.length === 3);
      assert.strictEqual(w.ctx.lanes.sendingOn('mac'), 3, 'three calls of the job on one model at once');
      const b = w.ctx.lanes.aiCall(routeOfModelId(NINE), 'b', held('b', order));
      standaloneAsked();
      await queued;
      const a4 = w.ctx.lanes.aiCall(routeOfModelId(BIG), 'a4', held('a4', order));
      await new Promise((r) => setTimeout(r, 20));
      assert.deepStrictEqual(gates.map((g) => g.label).sort(), ['a1', 'a2', 'a3'], 'the 9B call, the standalone call and a4 all wait');
      open('a1'); open('a2'); open('a3');
      await until(() => gates.length === 1);
      assert.deepStrictEqual(gates.map((g) => g.label), ['b'], 'the job\'s 9B call next, alone');
      open('b');
      await until(() => gates.length === 1 && gates[0].label === 'standalone');
      open('standalone');
      await until(() => gates.length === 1 && gates[0].label === 'a4');
      open('a4');
      await Promise.all([...a, b, a4]);
      return true;
    });
    // Outside the job's async context: a standalone call (the editor's title), asked while the job's calls run.
    await askStandalone;
    const standalone = w.ctx.lanes.aiCall(routeOfModelId(BIG), 'standalone', held('standalone', order));
    await new Promise((r) => setTimeout(r, 20));
    standaloneQueued();
    const { ok, err } = await job.outcome;
    assert.ok(ok, err?.message);
    await standalone;
    assert.deepStrictEqual(order, ['a1', 'a2', 'a3', 'b', 'standalone', 'a4'], 'first come, first served between owners');
    assert.strictEqual(JOB_CALLS_PER_SERVER, 16, 'the engine width');
  } finally {
    await w.close();
  }
});

/** One local call of a job, sized to load at `tokens`. */
function sizedCall(w, job, tokens, what) {
  const chars = Math.floor((tokens - 2048 - 1024) * 3.5) - 200;
  assert.strictEqual(loadContextFor(chars, 2048), tokens, `a ${chars}-char prompt loads at ${tokens}`);
  return w.ctx.lanes.aiCall(routeOfModelId(BIG), what, () => w.ctx.transport.chat({
    model: BIG, prompt: `FIELD ${what} ${'y'.repeat(chars)}`, act: 'generate', thinking: false, maxTokens: 2048,
    loadContext: tokens, job, what, trace: null,
  }));
}

check('a call that needs the load grown waits for the calls in flight to finish (no load under an answer); an expectation loads once at the largest size', async () => {
  const w = await world();
  try {
    const job = await asJob(w, 'j5', async () => {
      const sessions = w.ctx.transport.job('the grow keeper');
      const small = sizedCall(w, sessions, 8192, 'small');
      await until(() => w.h.held.length === 1);
      const large = sizedCall(w, sessions, 16384, 'large');
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(w.h.held.length, 1, 'the larger call waits: growing the load would cut the first answer off');
      assert.deepStrictEqual(loadsOf(w.server), [[BIG, 8192]]);
      w.h.release('small');
      await until(() => w.h.held.length === 1 && /large/.test(w.h.held[0].prompt));
      w.h.release('large');
      await Promise.all([small, large]);

      // Told first that both are coming (JobSessions.expect): one load, at the larger size, both at once.
      const expected = w.ctx.transport.job('the expecting keeper');
      const release = expected.expect(BIG, 24576, 2, 'two field calls');
      const one = sizedCall(w, expected, 8192, 'first');
      const two = sizedCall(w, expected, 24576, 'second');
      await until(() => w.h.held.length === 2);
      w.h.releaseAll();
      await Promise.all([one, two]);
      release();
      await sessions.releaseAll();
      await expected.releaseAll();
      return true;
    });
    const { ok, err } = await job.outcome;
    assert.ok(ok, err?.message);
    assert.deepStrictEqual(loadsOf(w.server), [[BIG, 8192], [BIG, 16384], [BIG, 24576]], 'grown once after the small answer ended; the expectation loaded once at 24,576');
    assert.deepStrictEqual(w.server.loadsUnderAnswers, []);
    assert.ok(logged.some((l) => /waits for the 1 call\(s\) in flight/.test(l.text)), 'the wait is said');
  } finally {
    await w.close();
  }
});

check('the width question: where the card does not hold one more request of that size, the call waits for one in flight to finish', async () => {
  // The card's arithmetic: 40,000 tokens of KV at one in flight, shared by however many are asked.
  const w = await world({ fake: { contextCeilings: { [BIG]: (c) => Math.floor(40000 / c) } } });
  try {
    const job = await asJob(w, 'j6', async () => {
      const sessions = w.ctx.transport.job('the width keeper');
      const calls = ['w1', 'w2', 'w3'].map((label) => sizedCall(w, sessions, 16384, label));
      await until(() => w.h.held.length === 2);
      await new Promise((r) => setTimeout(r, 30));
      assert.strictEqual(w.h.held.length, 2, 'two of 16,384 fit beside each other (20,000 each); a third would not (13,333)');
      w.h.release('w1');
      await until(() => w.h.held.some((x) => /^FIELD w3/.test(x.prompt)));
      w.h.releaseAll();
      await until(() => w.h.held.length === 0 && w.server.answering().length === 0);
      await Promise.all(calls);
      await sessions.releaseAll();
      return true;
    });
    const { ok, err } = await job.outcome;
    assert.ok(ok, err?.message);
    const asked = w.server.requestsTo('/v1/capability', 'GET').map((q) => q.query);
    assert.ok(asked.includes('?class=generate&context_tokens=16384&concurrency=2'), JSON.stringify(asked));
    assert.ok(asked.includes('?class=generate&context_tokens=16384&concurrency=3'), JSON.stringify(asked));
    assert.strictEqual(w.server.peakAnswering(BIG), 2);
    assert.ok(logged.some((l) => /waits for one of the 2 in flight on qwen3\.8-27b-4bit to finish/.test(l.text)), 'the narrowing is said');
  } finally {
    await w.close();
  }
});

run('crucible: one job\'s independent calls go out together (LEDGER #270)');
