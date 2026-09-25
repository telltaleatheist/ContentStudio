/**
 * THE ONE DOOR (plan 6.1, P2's tests in plan 16): every ContentStudio model call
 * through electron/crucible/transport.ts, driven against tools/fake-crucible.js.
 *
 * What is held, each a thing that would otherwise be found on a real run:
 *  - the captured BODY of each plan 6.3 row, sent by the real call site: `thinking`
 *    always stated; NO temperature/top_p/top_k in any `anthropic/` body;
 *    `max_tokens` 16000 to Anthropic (LEDGER #187); the act header;
 *  - `409 model_not_resident` makes the model resident again ONCE and resends;
 *  - `upstream_unconfigured` is a clear, named error;
 *  - a 429 passes through as a 429, never retried here;
 *  - a prompt over the loaded context throws BEFORE anything is sent;
 *  - a cancel aborts the fetch and gives the lease back;
 *  - a reply without `finish_reason` is refused, and `length` is a hard failure;
 *  - the act is `generate` where the server lists it and `analysis` (said once) where not;
 *  - a heartbeat answered `unknown_lease` fails the job's next call, loudly;
 *  - decide carries its act and its model, and a server without the door refuses by name.
 *
 * No GPU, no model, no network beyond 127.0.0.1, and no paid call anywhere.
 */
const path = require('path');
const { assert, fake, context, rejection, until, check, run, logged, crucible, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
const ASSETS_DIR = path.join(REPO, 'electron', 'assets');

const { installCrucibleTransport, ANTHROPIC_MAX_TOKENS } = crucible('transport');
const { CrucibleCallError } = crucible('errors');

const KEY = 'sk-ant-api03-keeper-key-abcdefghijklmnop-WXYZ';
const MODELS = [
  { id: 'qwen3.8-27b-4bit', paramsB: 27, installed: true, contextDefault: 98304 },
  { id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384 },
];

/** A registered, selected fake at 1.0.34 with the transport installed process-wide. */
async function withDoor(options, fn) {
  const server = await fake.startFakeCrucible({ version: '1.0.34', models: MODELS, upstreams: { anthropic: { key: KEY } }, ...options });
  const made = context({ leaseTimings: { heartbeatMs: 40, releaseGraceMs: 20, requestTimeoutMs: 500 } });
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  installCrucibleTransport(made.ctx.transport);
  try {
    await fn(server, made.ctx);
  } finally {
    installCrucibleTransport(null);
    await server.close();
  }
}

function manager(extra = {}) {
  const { AIManagerService } = services('metadata/ai-manager.service.js');
  return new AIManagerService({ promptSetsDir: ASSETS_DIR, transcriptCeiling: 'local', ...extra });
}

const chats = (server) => server.requestsTo('/v1/openai/chat/completions', 'POST');
const actOf = (request) => request.headers['x-crucible-act'];

/** The cloud body rule, asserted on every `anthropic/` body this file sees. */
function assertCloudBody(body, what) {
  for (const key of ['temperature', 'top_p', 'top_k']) {
    assert.ok(!(key in body), `${what}: ${key} crossed to Anthropic (LEDGER #194)`);
  }
  assert.strictEqual(body.max_tokens, ANTHROPIC_MAX_TOKENS, `${what}: max_tokens`);
  assert.strictEqual(typeof body.chat_template_kwargs?.enable_thinking, 'boolean', `${what}: thinking is stated`);
}

// ── the bodies, per plan 6.3 row, from the real call sites ──────────────────

check('6.3 rows, local: each call site states thinking, its budget and the act, and nothing samples but stage 1', () => withDoor({}, async (server) => {
  const moreTitles = services('metadata/more-titles.js');
  const rewrite = services('metadata/rewrite-pass.js');
  const tasks = services('metadata/metadata-tasks.js');
  const { JobModelLifecycle } = services('metadata/model-lifecycle.js');
  const { WholeTranscriptChapterService } = services('metadata/chapter-whole-transcript.service.js');
  const routing = services('metadata/metadata-routing.js');
  const local = routing.METADATA_ROUTING_OPTIONS['qwen38-27b'];
  const ai = manager();

  const lifecycle = new JobModelLifecycle('the keeper job');
  // titles (LocalFieldUnit, thinking off, 8192)
  ai.buildMetadataFieldPrompt = () => 'Write ten titles.';
  const budget = new tasks.ModelRunContextBudget(local.model, lifecycle);
  const titles = new tasks.LocalFieldUnit(ai, { field: 'titles', model: local.model, insights: false, inputFields: [] }, local, budget, lifecycle);
  await titles.generate({ sourceLabel: 'keeper.mp4', promptSetName: 'youtube-telltale', warn: () => {} });
  // chapter detail (thinking ON) and a stage-1 consensus sample (thinking off, temperature 0.7)
  const chapterer = new WholeTranscriptChapterService({ model: local.model, trace: ai.promptTrace, lifecycle, grain: 'broad' });
  chapterer.numCtx = 16384;
  await chapterer.ask('detail', 'Name this chapter.', 'chapter 1', 60_000, { thinking: true });
  await chapterer.ask('chapters', 'List the turns.', 'stage 1', 60_000, { thinking: false, temperature: 0.7 });
  await lifecycle.releaseAll();
  // more titles (thinking off), scrub/Soften (thinking on): one-call jobs
  await moreTitles.askForMoreTitles({ prompt: 'the titles prompt', sourceLabel: 'keeper.mp4' }, ['A title'], local, { aiManager: ai }).catch(() => undefined);
  const plan = { field: 'titles', shape: 'prose', count: null, text: 'x', labelKey: 'titles' };
  const pass = { id: 'soften', name: 'Soften', promptFile: 'soften.yml', dataBlockKeys: [], callWhat: () => 'softening titles', readWhat: () => 'x', nameInError: () => 'x' };
  await rewrite.askToRewrite(pass, plan, local, { aiManager: ai }, 'keeper.mp4', 'Rewrite this.');

  const bodies = chats(server).map((r) => ({ body: r.body, act: actOf(r) }));
  const thinking = bodies.map((b) => b.body.chat_template_kwargs?.enable_thinking);
  assert.deepStrictEqual(thinking, [false, true, false, false, true], 'titles, detail, stage 1, more titles, soften');
  assert.deepStrictEqual(bodies.map((b) => b.body.max_tokens), [8192, 8192, 8192, 8192, 8192]);
  assert.deepStrictEqual(bodies.map((b) => b.act), ['generate', 'generate', 'generate', 'generate', 'generate']);
  assert.deepStrictEqual(bodies.map((b) => 'temperature' in b.body), [false, false, true, false, false], 'only the consensus sample samples (LEDGER #159)');
  assert.strictEqual(bodies[2].body.temperature, 0.7);
  // Every call recorded itself with the server that ran it (Law 8).
  assert.ok(ai.promptTrace.length >= 5 && ai.promptTrace.every((entry) => entry.server === 'mac'), JSON.stringify(ai.promptTrace.map((e) => e.server)));
}));

check('6.3 rows, cloud: no sampling to Anthropic, max_tokens 16000, thinking stated, the plain/JSON system turn', () => withDoor({}, async (server) => {
  const routing = services('metadata/metadata-routing.js');
  const tasks = services('metadata/metadata-tasks.js');
  const sonnet = routing.METADATA_ROUTING_OPTIONS.sonnet5;
  const ai = manager({ promptSet: 'youtube-telltale' });
  ai.loadPrompts();
  ai.buildMetadataFieldPrompt = () => 'Write ten titles.';
  await new tasks.CloudFieldUnit(ai, { field: 'titles', model: sonnet.model, insights: false, inputFields: [] })
    .generate({ sourceLabel: 'keeper.mp4', promptSetName: 'youtube-telltale', warn: () => {} });
  // The compilation package: the one JSON caller left.
  await ai.runMetadataRequest('Package this compilation.', sonnet.model).catch(() => undefined);
  // The summarizer's cloud chunk.
  const cloudSummary = manager({ summarizationModel: sonnet.model, transcriptCeiling: 'cloud' });
  await cloudSummary.summarizeTranscript('word '.repeat(300), 'keeper.mp4', { forceCondense: true }).catch(() => undefined);

  const sent = chats(server);
  assert.ok(sent.length >= 3);
  for (const request of sent) {
    assert.strictEqual(request.body.model, 'anthropic/claude-sonnet-5');
    assertCloudBody(request.body, request.body.messages[1]?.content.slice(0, 30));
    assert.strictEqual(actOf(request), 'generate');
    assert.strictEqual(request.body.messages[0].role, 'system', 'the cloud contract rides in the system turn');
    assert.ok(!('response_format' in request.body), 'no json_object to Anthropic (it would be dropped); the JSON contract is the system turn');
  }
  assert.match(sent[1].body.messages[0].content, /output ONLY valid JSON/, 'the package carries the JSON system turn');
  // Nothing leased for an upstream: it is never resident (PHASE15 3.4).
  assert.strictEqual(server.leases.taken.length, 0);
}));

check('the compilation package on a LOCAL model asks for json_object, thinking off, 4096', () => withDoor({}, async (server) => {
  const ai = manager();
  await ai.runMetadataRequest('Package this compilation.', 'qwen3.8-27b-4bit').catch(() => undefined);
  const body = chats(server)[0].body;
  assert.deepStrictEqual(body.response_format, { type: 'json_object' });
  assert.strictEqual(body.chat_template_kwargs.enable_thinking, false);
  assert.strictEqual(body.max_tokens, 4096);
}));

check('a sampling parameter to a cloud upstream, a wrong Anthropic ceiling, or a stale prefix is refused before sending', () => withDoor({}, async (server, ctx) => {
  const base = { prompt: 'x', act: 'generate', thinking: false, what: 'the keeper call', trace: null };
  assert.strictEqual((await rejection(ctx.transport.chat({ ...base, model: 'anthropic/claude-sonnet-5', maxTokens: 16000, temperature: 0.7 }))).code, 'sampling_to_cloud');
  assert.strictEqual((await rejection(ctx.transport.chat({ ...base, model: 'anthropic/claude-sonnet-5', maxTokens: 4096 }))).code, 'invalid_model');
  for (const stale of ['ollama:qwen3.8:27b', 'claude:claude-sonnet-5', 'openai:gpt-4o', 'claude-cli:opus']) {
    assert.strictEqual((await rejection(ctx.transport.chat({ ...base, model: stale, maxTokens: 100 }))).code, 'invalid_model', stale);
  }
  assert.strictEqual(chats(server).length, 0);
}));

// ── the refusals ─────────────────────────────────────────────────────────────

check('409 model_not_resident: the model is made resident again ONCE and the chat resent', () => withDoor({}, async (server, ctx) => {
  await ctx.transport.withJobLease('mac', 'qwen3.8-27b-4bit', async (job) => {
    // Someone else's load evicts our model mid-job.
    server.setResident('qwen3.5-9b');
    const answer = await ctx.transport.chat({
      model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, job, what: 'the keeper call', trace: null,
    });
    assert.strictEqual(answer.finishReason, 'stop');
  }, { what: 'the keeper job' });
  assert.strictEqual(chats(server).length, 2, 'one refused send and one resend, never more');
  const loads = server.jobs.filter((j) => j.type === 'load-model' && j.model === 'qwen3.8-27b-4bit');
  assert.strictEqual(loads.length, 2, 'the job load and the ONE re-ensure');
  assert.strictEqual(server.openLease(), null, 'the job gave its lease back');
}));

check('a second model_not_resident is not chased: the call fails by name', () => withDoor({}, async (server, ctx) => {
  server.faults.refuse = [{ match: { path: '/v1/openai/chat/completions' }, status: 409, code: 'model_not_resident', times: 2 }];
  const err = await rejection(ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null,
  }));
  assert.strictEqual(err.serverCode, 'model_not_resident');
  assert.strictEqual(chats(server).length, 2);
}));

check('upstream_unconfigured is a clear error naming the server and where the key goes', () => withDoor({ upstreams: {} }, async (_server, ctx) => {
  const err = await rejection(ctx.transport.chat({
    model: 'anthropic/claude-sonnet-5', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 16000, what: 'the keeper call', trace: null,
  }));
  assert.ok(err instanceof CrucibleCallError);
  assert.strictEqual(err.code, 'upstream_unconfigured');
  assert.match(err.message, /"mac" has no anthropic key/);
  assert.match(err.message, /Settings › Crucible Servers › mac › Keys/);
}));

check('a 429 passes through as a 429 with the server\'s code, sent once and never retried here', () => withDoor({}, async (server, ctx) => {
  server.faults.refuse = [{ match: { path: '/v1/openai/chat/completions' }, status: 429, code: 'rate_limited', message: 'slow down', retryAfter: 5 }];
  const err = await rejection(ctx.transport.chat({
    model: 'anthropic/claude-sonnet-5', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 16000, what: 'the keeper call', trace: null,
  }));
  assert.strictEqual(err.status, 429);
  assert.strictEqual(err.serverCode, 'rate_limited');
  assert.strictEqual(chats(server).length, 1);
}));

check('over the loaded context: throws BEFORE sending, naming the model, the server and both numbers', () => withDoor(
  { models: [{ id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384, maxModelLen: 16384 }] },
  async (server, ctx) => {
    const err = await rejection(ctx.transport.chat({
      model: 'qwen3.5-9b', prompt: 'word '.repeat(20000), act: 'generate', thinking: false, maxTokens: 8192, what: 'the keeper call', trace: null,
    }));
    assert.strictEqual(err.code, 'over_context');
    assert.match(err.message, /qwen3\.5-9b on "mac" is loaded with 16384/);
    assert.match(err.message, /needs ~\d+ tokens/);
    assert.strictEqual(chats(server).length, 0, 'nothing was sent');
    assert.strictEqual(server.openLease(), null, 'the one-call lease was given back');
  },
));

check('a load context the call itself does not fit is refused before any load', () => withDoor({}, async (server, ctx) => {
  const err = await rejection(ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'word '.repeat(20000), act: 'generate', thinking: false, maxTokens: 8192, loadContext: 8192, what: 'the keeper call', trace: null,
  }));
  assert.strictEqual(err.code, 'over_context');
  assert.strictEqual(server.jobs.length, 0, 'nothing loaded');
}));

check('the job loads the model at its stated context (LEDGER #111), and that is the window it is checked against', () => withDoor({}, async (server, ctx) => {
  await ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, loadContext: 24576, what: 'the keeper call', trace: null,
  });
  const load = server.jobs.find((j) => j.type === 'load-model');
  assert.strictEqual(load.params.context, 24576);
  assert.deepStrictEqual(load.params.lease, { act: 'generate', ttl_seconds: 120 }, 'the lease is taken on the load, ttl 120 s');
}));

check('cancel aborts the open fetch and gives the lease back', () => withDoor({}, async (server, ctx) => {
  server.inject({ chatDelayMs: 5_000 });
  const controller = new AbortController();
  const pending = ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, signal: controller.signal, what: 'the keeper call', trace: null,
  });
  await until(() => chats(server).length === 1);
  const started = Date.now();
  controller.abort();
  const err = await rejection(pending);
  assert.strictEqual(err.name, 'JobCancelledError');
  assert.ok(Date.now() - started < 2_000, 'the fetch was aborted, not waited out');
  assert.strictEqual(server.openLease(), null, 'the lease was released');
  assert.strictEqual(server.leases.released.length, 1);
}));

check('a reply without finish_reason is REFUSED (never read as stop), and finish_reason length is a hard failure', () => withDoor(
  { chatReplies: { 'qwen3.8-27b-4bit': (body) => (body.max_tokens === 111 ? { content: 'half an', finishReason: 'length' } : { content: 'x', finishReason: null }) } },
  async (_server, ctx) => {
    const base = { model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, what: 'the keeper call', trace: null };
    assert.strictEqual((await rejection(ctx.transport.chat({ ...base, maxTokens: 100 }))).code, 'protocol_error');
    const cut = await rejection(ctx.transport.chat({ ...base, maxTokens: 111 }));
    assert.strictEqual(cut.code, 'truncated');
    assert.match(cut.message, /cut off at its 111-token ceiling/);
  },
));

check('the act: `generate` where the server lists it, `analysis` on a pre-1.0.24 server, said ONCE per server', () => withDoor(
  { legacyActs: true },
  async (server, ctx) => {
    const base = { model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null };
    await ctx.transport.chat(base);
    await ctx.transport.chat(base);
    assert.deepStrictEqual(chats(server).map(actOf), ['analysis', 'analysis']);
    assert.deepStrictEqual(server.leases.taken.map((l) => l.act), ['analysis', 'analysis'], 'the lease names the same act');
    const said = logged.filter((l) => l.text.includes('predates 1.0.24; sending act analysis'));
    assert.strictEqual(said.length, 1, 'one line per server per session (Law 8)');
  },
));

check('a heartbeat answered unknown_lease fails the job\'s next call, and the job, loudly', () => withDoor({}, async (server, ctx) => {
  const err = await rejection(ctx.transport.withJobLease('mac', 'qwen3.8-27b-4bit', async (job) => {
    server.expireLease();
    await until(() => job.held().some((h) => h.lost !== null));
    await ctx.transport.chat({
      model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, job, what: 'the keeper call', trace: null,
    });
  }, { what: 'the keeper job' }));
  assert.strictEqual(err.code, 'lease_lost');
  assert.match(err.message, /unknown_lease/);
  assert.strictEqual(chats(server).length, 0, 'nothing was sent unprotected');
}));

check('a job holds ONE lease per model and heartbeats it; switching models hands the first back', () => withDoor({}, async (server, ctx) => {
  const job = ctx.transport.job('the keeper job');
  const call = (model) => ctx.transport.chat({ model, prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, job, what: 'the keeper call', trace: null });
  await call('qwen3.8-27b-4bit');
  await call('qwen3.8-27b-4bit');
  await until(() => server.requestsTo('/v1/leases/').some((r) => r.path.endsWith('/heartbeat')));
  assert.strictEqual(server.leases.taken.length, 1, 'two calls, one lease');
  await call('qwen3.5-9b');
  assert.strictEqual(server.leases.taken.length, 2);
  assert.strictEqual(server.leases.released.length, 1, 'the 27B was handed back before the 9B was loaded');
  assert.deepStrictEqual(await job.releaseAll(), []);
  assert.strictEqual(server.openLease(), null);
}));

check('another client\'s lease pinning OUR model: the call runs under it, said, and takes none of its own', () => withDoor({}, async (server, ctx) => {
  server.leaseAsOther('qwen3.8-27b-4bit', 'bookforge');
  const answer = await ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null,
  });
  assert.strictEqual(answer.server, 'mac');
  assert.ok(logged.some((l) => /running under their lease/.test(l.text)));
}));

check('another client\'s lease on a DIFFERENT model: busy with the holder\'s sentence, nothing loaded over it', () => withDoor({}, async (server, ctx) => {
  server.leaseAsOther('qwen3.5-9b', 'bookforge');
  const err = await rejection(ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null,
  }));
  assert.strictEqual(err.code, 'busy');
  assert.match(err.busyLine, /bookforge/);
  assert.strictEqual(chats(server).length, 0);
}));

check('a paused or older server takes no work, by name', () => withDoor({}, async (_server, ctx) => {
  ctx.servers.setPaused('mac', true);
  const base = { model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null };
  assert.strictEqual((await rejection(ctx.transport.chat(base))).code, 'paused');
}).then(() => withDoor({ version: '1.0.24' }, async (_server, ctx) => {
  const base = { model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null };
  assert.strictEqual((await rejection(ctx.transport.chat(base))).code, 'needs_update');
})));

// ── decide ───────────────────────────────────────────────────────────────────

check('decide: act `decide`, the named model, the report mode; a server without the door refuses by name', () => withDoor({}, async (server, ctx) => {
  const answer = await ctx.transport.decide({
    model: 'qwen3.5-9b',
    state: 'The host talks about the budget vote.',
    questions: { topic: { type: 'choice', instructions: 'Which item?', options: { budget: 'the budget', mayor: 'the mayor' } } },
    missing: 'report',
    what: 'assign sentence 1',
    trace: null,
  });
  assert.ok(answer.answers.topic);
  const sent = server.requestsTo('/v1/decide', 'POST')[0];
  assert.strictEqual(actOf(sent), 'decide');
  assert.strictEqual(sent.body.model, 'qwen3.5-9b');
  assert.strictEqual(sent.body.missing, 'report');
  assert.strictEqual(server.leases.taken[0].act, 'decide');
}).then(() => withDoor({ legacyActs: true }, async (_server, ctx) => {
  const err = await rejection(ctx.transport.decide({
    model: 'qwen3.5-9b', state: 'x', questions: { q: { type: 'yesno', instructions: 'Is it?' } }, what: 'assign', trace: null,
  }));
  assert.strictEqual(err.code, 'decide_not_served');
})));

// ── what the routing dialog lists ────────────────────────────────────────────

check('the routing dialog lists only what the selected server offers, Claude only with its key, and a stored choice it cannot run with the server\'s sentence', () => withDoor(
  {
    upstreams: {},
    catalog: [
      { kind: 'model', id: 'qwen3.8-27b-4bit', name: '27B', jobType: 'llm', installed: true, expectedBytes: null },
      { kind: 'model', id: 'qwen3.5-9b', name: '9B', jobType: 'llm', installed: false, expectedBytes: null },
    ],
    models: [...MODELS, { id: 'qwen3.5-4b', paramsB: 4, installed: false, backendSupported: false }],
  },
  async (_server, ctx) => {
    const { catalogInventory } = crucible('catalog');
    const routing = services('metadata/metadata-routing.js');
    const inventory = await catalogInventory(ctx.factory, 'mac');
    assert.strictEqual(inventory.anthropicConfigured, false);
    const view = routing.buildRoutingView({ titles: 'sonnet5', description: 'qwen35-4b' }, inventory);
    const ids = (task) => view.tasks.find((t) => t.id === task).options.map((o) => `${o.id}:${o.availability}`);
    // Titles: the 27B (installed), claude -p (outside), and the STORED Sonnet shown with the reason.
    assert.deepStrictEqual(ids('titles'), ['qwen38-27b:installed', 'sonnet5:not-here', 'claude-cli:outside', 'claude-cli-sonnet:outside']);
    assert.match(view.tasks.find((t) => t.id === 'titles').options[1].availabilityNote, /has no Anthropic key/);
    // Description: the 9B is pullable (listed, flagged); the stored 4B is not here, with the server's reason.
    assert.deepStrictEqual(ids('description'), ['qwen38-27b:installed', 'qwen35-9b:pullable', 'qwen35-4b:not-here', 'claude-cli:outside', 'claude-cli-sonnet:outside']);
    assert.strictEqual(view.server.name, 'mac');
  },
));

// The AI queue's watchdog (queue-manager.service.ts) is a plain setInterval that holds any
// process that loaded AIManagerService open; this keeper exits on its own verdict instead.
run('crucible: the one door (transport, lease, act, catalog)').then(() => process.exit(process.exitCode ?? 0));
