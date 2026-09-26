/**
 * P4 against the fake (docs/crucible/P4.md): what each local call site ASKS the server for, and
 * the capability question a load asks before it reserves the card.
 *
 * What is held:
 *  - each call site states its own budget and asks for the smallest 8,192 step that holds its own
 *    prompt (context-check.ts loadContextFor, LEDGER #209): the description at 4,096, a rewrite
 *    pass (the scrub, Soften) at 16,384 with a 24,576 load, the compilation summarizer at 4,096;
 *  - a job's second, larger call grows the load ONCE, and a later smaller call does not shrink it;
 *  - before a load, `GET /v1/capability?class=generate&context_tokens=<the load>&concurrency=1` is
 *    asked; a size the host cannot serve fails `over_context` with the SERVER's sentence (its
 *    `context_over_limit`, or its ceiling row), and nothing is loaded or evicted;
 *  - a server that predates the sized query (act analysis) is not asked, and says so.
 *
 * No GPU, no model, no network beyond 127.0.0.1.
 */
const path = require('path');
const { assert, fake, context, rejection, check, run, logged, crucible, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
const ASSETS_DIR = path.join(REPO, 'electron', 'assets');

const { installCrucibleTransport } = crucible('transport');
const { installLanes, routeOfModelId } = crucible('lanes');
const { loadContextFor } = crucible('context-check');

const MODEL = 'qwen3.8-27b-4bit';
const MODELS = [
  { id: MODEL, paramsB: 27, installed: true, contextDefault: 98304 },
  { id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384 },
];

async function withDoor(options, fn) {
  const server = await fake.startFakeCrucible({ version: '1.0.34', models: MODELS, ...options });
  const made = context({ leaseTimings: { heartbeatMs: 40, releaseGraceMs: 20, requestTimeoutMs: 500 } });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  try {
    await fn(server, made.ctx);
  } finally {
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
  }
}

const loads = (server) => server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b && b.type === 'load-model');
const chatBodies = (server) => server.requestsTo('/v1/openai/chat/completions', 'POST').map((q) => q.body);

function manager(extra = {}) {
  const { AIManagerService } = services('metadata/ai-manager.service.js');
  return new AIManagerService({ promptSetsDir: ASSETS_DIR, transcriptCeiling: 'local', ...extra });
}

function localOption() {
  const routing = services('metadata/metadata-routing.js');
  return routing.METADATA_ROUTING_OPTIONS['qwen38-27b'];
}

// ── the call sites ───────────────────────────────────────────────────────────

check('the description asks 4,096 and its own step; a rewrite pass asks 16,384 and loads at 24,576, growing the job\'s load once', () => withDoor({}, async (server) => {
  const { DescriptionUnit } = services('metadata/description-unit.js');
  const { JobModelLifecycle } = services('metadata/model-lifecycle.js');
  const rewrite = services('metadata/rewrite-pass.js');
  const local = localOption();
  const lifecycle = new JobModelLifecycle('the p4 keeper job');
  // As the generator builds it: the manager's calls run under the job's leases, so the scrub,
  // which states no job of its own, grows the job's load rather than loading beside it.
  const ai = manager({ jobLeases: lifecycle.leases });

  // The description's own call (thinking off, answer-sized): a ~2,000-token prompt.
  const unit = new DescriptionUnit(ai, local, lifecycle);
  const prompt = 'x'.repeat(7000);
  await unit.askPlain(prompt, 'primary description', { sourceLabel: 'keeper.mp4' });
  // A thinking-on rewrite in the SAME job: its 16,384 budget needs a bigger window, so the load grows once.
  const plan = { field: 'description', shape: 'prose', count: null, text: 'x', labelKey: 'description', apply: () => undefined };
  const pass = { id: 'scrub', name: 'Scrub', promptFile: 'scrub.yml', dataBlockKeys: [], callWhat: () => 'scrub: description', readWhat: () => 'x', nameInError: () => 'x' };
  await rewrite.askToRewrite(pass, plan, local, { aiManager: ai }, 'keeper.mp4', 'Rewrite this.');
  // And the description again: smaller than the window now loaded, so no reload.
  await unit.askPlain(prompt, 'option 2 description', { sourceLabel: 'keeper.mp4' });
  await lifecycle.releaseAll();

  const bodies = chatBodies(server);
  assert.deepStrictEqual(bodies.map((b) => b.max_tokens), [4096, rewrite.REWRITE_NUM_PREDICT, 4096]);
  assert.strictEqual(rewrite.REWRITE_NUM_PREDICT, 16384, 'the rewrite passes take the thinking title\'s budget (#214)');
  assert.deepStrictEqual(bodies.map((b) => b.chat_template_kwargs.enable_thinking), [false, true, false]);
  const traced = ai.promptTrace.map((e) => [e.maxTokens, e.loadContext]);
  assert.deepStrictEqual(traced, [[4096, 8192], [16384, 24576], [4096, 8192]], 'each call asked for its own step');
  // One job: the description loaded the model at 8,192, the rewrite grew it once to 24,576, and
  // the last description ran on the larger window (no shrink, no floor asked for).
  assert.deepStrictEqual(loads(server).map((b) => [b.model, b.params.context]), [[MODEL, 8192], [MODEL, 24576]]);
}));

check('a job that grows its window reloads once and never shrinks it back', () => withDoor({}, async (server, ctx) => {
  const job = ctx.transport.job('the grow keeper');
  const ask = (chars, maxTokens, what) => ctx.lanes.aiCall(routeOfModelId(MODEL), what, () => ctx.transport.chat({
    model: MODEL, prompt: 'y'.repeat(chars), act: 'generate', thinking: false, maxTokens,
    loadContext: loadContextFor(chars, maxTokens), job, what, trace: null,
  }));
  await ask(3500, 2048, 'a field call');          // 8,192
  await ask(3500, 16384, 'a thinking call');      // 24,576: grows once
  await ask(3500, 2048, 'another field call');    // fits the loaded window: no reload
  await job.releaseAll();
  assert.deepStrictEqual(loads(server).map((b) => b.params.context), [8192, 24576]);
  assert.ok(logged.some((l) => /reloading it at 24576/.test(l.text)), 'the growth is said');
}));

check('the compilation summarizer asks 4,096 and its own step on a local model', () => withDoor({}, async (server) => {
  const ai = manager({ summarizationModel: MODEL });
  ai.loadPrompts();
  await ai.summarizeTranscript('word '.repeat(3000), 'keeper.mp4', { forceCondense: true }).catch(() => undefined);
  const bodies = chatBodies(server);
  assert.ok(bodies.length >= 1, 'the summarizer reached the door');
  assert.ok(bodies.every((b) => b.max_tokens === 4096));
  const entry = ai.promptTrace.find((e) => /summarization/.test(e.what));
  assert.strictEqual(entry.loadContext, loadContextFor(entry.chars, 4096));
}));

// ── the capability question before a load ────────────────────────────────────

check('before a load, the server is asked whether the model fits at the size, one request in flight', () => withDoor({}, async (server, ctx) => {
  const job = ctx.transport.job('the capability keeper');
  await ctx.lanes.aiCall(routeOfModelId(MODEL), 'fits', () => ctx.transport.chat({
    model: MODEL, prompt: 'z'.repeat(3500), act: 'generate', thinking: true, maxTokens: 16384,
    loadContext: 24576, job, what: 'a thinking title', trace: null,
  }));
  await job.releaseAll();
  const asked = server.requestsTo('/v1/capability', 'GET').map((q) => q.query);
  assert.ok(asked.includes('?class=generate&context_tokens=24576&concurrency=1'), `the sized question was asked: ${JSON.stringify(asked)}`);
  // Asked BEFORE the load reserved the card.
  const capAt = server.requestsTo('/v1/capability', 'GET').find((q) => q.query === '?class=generate&context_tokens=24576&concurrency=1').at;
  const loadAt = server.requestsTo('/v1/jobs', 'POST').find((q) => q.body && q.body.type === 'load-model').at;
  assert.ok(capAt <= loadAt, 'the capability question comes before the load');
  assert.ok(logged.some((l) => /can serve qwen3\.8-27b-4bit at 24576 tokens, one request in flight/.test(l.text)), 'the fit is said');
  assert.deepStrictEqual(loads(server).map((b) => b.params.context), [24576]);
}));

check('a size over every ceiling fails over_context with the server\'s own sentence, and nothing is loaded', () => withDoor({ contextCeilings: { [MODEL]: 16384, 'qwen3.5-9b': 16384 } }, async (server, ctx) => {
  const job = ctx.transport.job('the no-fit keeper');
  const err = await rejection(ctx.lanes.aiCall(routeOfModelId(MODEL), 'no fit', () => ctx.transport.chat({
    model: MODEL, prompt: 'z'.repeat(3500), act: 'generate', thinking: true, maxTokens: 16384,
    loadContext: 24576, job, what: 'a thinking title', trace: null,
  })));
  await job.releaseAll();
  assert.strictEqual(err.code, 'over_context', err.message);
  assert.ok(/24576 tokens is over every ceiling/.test(err.message), `the server's sentence: ${err.message}`);
  assert.ok(/Nothing was loaded and nothing was evicted/.test(err.message));
  assert.strictEqual(loads(server).length, 0, 'no load was submitted');
}));

check('a model whose own ceiling row is under the size fails the same way, naming the ceiling', () => withDoor({ contextCeilings: { [MODEL]: 16384 } }, async (server, ctx) => {
  const job = ctx.transport.job('the row keeper');
  const err = await rejection(ctx.lanes.aiCall(routeOfModelId(MODEL), 'row', () => ctx.transport.chat({
    model: MODEL, prompt: 'z'.repeat(3500), act: 'generate', thinking: true, maxTokens: 16384,
    loadContext: 24576, job, what: 'a thinking title', trace: null,
  })));
  await job.releaseAll();
  assert.strictEqual(err.code, 'over_context', err.message);
  assert.ok(/serves qwen3\.8-27b-4bit at most 16384 tokens at one request in flight/.test(err.message), err.message);
  assert.ok(/bound by served/.test(err.message), err.message);
  assert.strictEqual(loads(server).length, 0);
}));

check('a server from before the sized query is not asked, and says so; its load still runs', () => withDoor({ legacyActs: true }, async (server, ctx) => {
  const job = ctx.transport.job('the legacy keeper');
  await ctx.lanes.aiCall(routeOfModelId(MODEL), 'legacy', () => ctx.transport.chat({
    model: MODEL, prompt: 'z'.repeat(3500), act: 'generate', thinking: false, maxTokens: 2048,
    loadContext: 8192, job, what: 'a field call', trace: null,
  }));
  await job.releaseAll();
  assert.ok(logged.some((l) => /predates the sized capability query/.test(l.text)));
  assert.deepStrictEqual(loads(server).map((b) => b.params.context), [8192]);
}));

run('P4 low context against the fake');
