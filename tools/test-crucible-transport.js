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
 *  - a cancel aborts the fetch and closes the call's queue session;
 *  - a reply without `finish_reason` is refused, and `length` is a hard failure;
 *  - the act is `generate` where the server lists it and `analysis` (said once) where not;
 *  - a queue session the server ends fails the job's next call by name, and nothing reopens one
 *    (Crucible 1.0.76, LEDGER #255); every local item carries `X-Crucible-Session`;
 *  - decide carries its act and its model, and a server without the door refuses by name;
 *  - (P3's contract) a call runs on its lane's server, in the session its lane hands it, writes
 *    every load to the in-flight ledger and settles it, and beats the stall clock on a streamed
 *    answer; another app's session refusing a session-less call is `busy` by name.
 *
 * Every call runs inside a lane step (`lanes.aiCall`), as it does in the app.
 *
 * No GPU, no model, no network beyond 127.0.0.1, and no paid call anywhere.
 */
const path = require('path');
const { assert, fake, context, rejection, until, check, run, logged, crucible, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
const ASSETS_DIR = path.join(REPO, 'electron', 'assets');

const { installCrucibleTransport, ANTHROPIC_MAX_TOKENS, CrucibleTransport } = crucible('transport');
const { CrucibleCallError } = crucible('errors');
const { installLanes, gpuCall, routeOfModelId } = crucible('lanes');

const KEY = 'sk-ant-api03-keeper-key-abcdefghijklmnop-WXYZ';
const MODELS = [
  { id: 'qwen3.8-27b-4bit', paramsB: 27, installed: true, contextDefault: 98304 },
  { id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384 },
];

/** A registered, selected fake at 1.0.34 with the transport installed process-wide. */
async function withDoor(options, fn) {
  const server = await fake.startFakeCrucible({ version: '1.0.34', models: MODELS, upstreams: { anthropic: { key: KEY } }, ...options });
  const made = context();
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

/** Run `fn` as one lane step for `model`, as queueAITask does in the app. */
function onLane(ctx, model, fn) {
  return ctx.lanes.aiCall(routeOfModelId(model), 'the keeper step', fn);
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

/** The server's catalog as its models say: what a job's routed options are resolved against. */
const catalogOf = (models) => models.map((m) => ({ kind: 'model', id: m.id, name: m.id, jobType: 'llm', installed: m.installed !== false, expectedBytes: null }));

check('6.3 rows, local: each call site states thinking, its budget and the act, and nothing samples but stage 1', () => withDoor({ catalog: catalogOf(MODELS) }, async (server, ctx_) => {
  const moreTitles = services('metadata/more-titles.js');
  const rewrite = services('metadata/rewrite-pass.js');
  const tasks = services('metadata/metadata-tasks.js');
  const { JobModelLifecycle } = services('metadata/model-lifecycle.js');
  const { WholeTranscriptChapterService } = services('metadata/chapter-whole-transcript.service.js');
  // The 27B row bound as a job binds it: read from this server's own catalog (the 4-bit build).
  const { readRoutingModels } = services('metadata/routing-models.js');
  const local = (await readRoutingModels('the keeper job', ['qwen38-27b'])).bind('titles', 'qwen38-27b');
  assert.strictEqual(local.model, 'qwen3.8-27b-4bit');
  const ai = manager();

  const lifecycle = new JobModelLifecycle('the keeper job');
  // titles (LocalFieldUnit, thinking off, 2048 since P4)
  ai.buildMetadataFieldPrompt = () => 'Write ten titles.';
  const titles = new tasks.LocalFieldUnit(ai, { field: 'titles', model: local.model, insights: false, inputFields: [] }, local, lifecycle);
  await titles.generate({ sourceLabel: 'keeper.mp4', promptSetName: 'youtube-telltale', warn: () => {} });
  // chapter detail (thinking ON) and a stage-1 consensus sample (thinking off, temperature 0.7)
  const chapterer = new WholeTranscriptChapterService({ model: local.model, trace: ai.promptTrace, lifecycle, grain: 'broad' });
  // The chapter stage holds its lane for its whole run, as the generator's queueAITask does.
  await ctx_.lanes.aiCall(gpuCall(local.model), 'the chapter stage', async () => {
    await chapterer.ask('detail', 'Name this chapter.', 'chapter 1', 60_000, { thinking: true });
    await chapterer.ask('chapters', 'List the turns.', 'stage 1', 60_000, { thinking: false, temperature: 0.7 });
  });
  await lifecycle.releaseAll();
  // more titles (thinking off), scrub/Soften (thinking on): one-call jobs
  await moreTitles.askForMoreTitles({ prompt: 'the titles prompt', sourceLabel: 'keeper.mp4' }, ['A title'], local, { aiManager: ai }).catch(() => undefined);
  const plan = { field: 'titles', shape: 'prose', count: null, text: 'x', labelKey: 'titles' };
  const pass = { id: 'soften', name: 'Soften', promptFile: 'soften.yml', dataBlockKeys: [], callWhat: () => 'softening titles', readWhat: () => 'x', nameInError: () => 'x' };
  await rewrite.askToRewrite(pass, plan, local, { aiManager: ai }, 'keeper.mp4', 'Rewrite this.');

  const bodies = chats(server).map((r) => ({ body: r.body, act: actOf(r) }));
  assert.ok(bodies.every((b) => b.body.model === 'qwen3.8-27b-4bit'), 'every call sends the resolved build, on the wire');
  assert.ok(bodies.every((b) => b.body.stream === true), 'every chat is streamed, so the stall clock hears it (P3)');
  const thinking = bodies.map((b) => b.body.chat_template_kwargs?.enable_thinking);
  assert.deepStrictEqual(thinking, [false, true, false, false, true], 'titles, detail, stage 1, more titles, soften');
  // P4: thinking-off field calls answer-sized (2048), the chapter calls and the whole-transcript
  // engine keep 8192, a thinking-on rewrite takes the thinking title's 16384 (LEDGER #209, #214).
  assert.deepStrictEqual(bodies.map((b) => b.body.max_tokens), [2048, 8192, 8192, 2048, 16384]);
  // Every call was traced with its budget and the load it asked for, the smallest 8,192 step that
  // holds it (context-check.ts loadContextFor): the context assertion reads these (P4).
  const traced = ai.promptTrace.filter((e) => e.act === 'generate');
  assert.ok(traced.length >= 5 && traced.every((e) => typeof e.maxTokens === 'number' && e.loadContext % 8192 === 0), JSON.stringify(traced.map((e) => [e.what, e.maxTokens, e.loadContext])));
  assert.deepStrictEqual(traced.map((e) => e.loadContext), [8192, 16384, 16384, 8192, 24576], 'each call asks for its own step');
  assert.deepStrictEqual(bodies.map((b) => b.act), ['generate', 'generate', 'generate', 'generate', 'generate']);
  assert.deepStrictEqual(bodies.map((b) => 'temperature' in b.body), [false, false, true, false, false], 'only the consensus sample samples (LEDGER #159)');
  assert.strictEqual(bodies[2].body.temperature, 0.7);
  // Every call recorded itself with the server that ran it (Law 8).
  assert.ok(ai.promptTrace.length >= 5 && ai.promptTrace.every((entry) => entry.server === 'mac'), JSON.stringify(ai.promptTrace.map((e) => e.server)));
}));

check('6.3 rows, cloud: no sampling to Anthropic, max_tokens 16000, thinking stated, the plain/JSON system turn', () => withDoor({}, async (server) => {
  const routing = services('metadata/metadata-routing.js');
  const tasks = services('metadata/metadata-tasks.js');
  const sonnet = routing.RoutingModels.withoutCatalog('the keeper routes no local model').bind('titles', 'sonnet5');
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
  // No session for an upstream: it takes no lane and is never resident (PHASE15 3.4).
  assert.strictEqual(server.sessions.length, 0);
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
  const cloud = (request) => onLane(ctx, 'anthropic/claude-sonnet-5', () => ctx.transport.chat(request));
  assert.strictEqual((await rejection(cloud({ ...base, model: 'anthropic/claude-sonnet-5', maxTokens: 16000, temperature: 0.7 }))).code, 'sampling_to_cloud');
  assert.strictEqual((await rejection(cloud({ ...base, model: 'anthropic/claude-sonnet-5', maxTokens: 4096 }))).code, 'invalid_model');
  for (const stale of ['ollama:qwen3.8:27b', 'claude:claude-sonnet-5', 'openai:gpt-4o', 'claude-cli:opus']) {
    assert.strictEqual((await rejection(cloud({ ...base, model: stale, maxTokens: 100 }))).code, 'invalid_model', stale);
  }
  assert.strictEqual(chats(server).length, 0);
}));

// ── the refusals ─────────────────────────────────────────────────────────────

check('409 model_not_resident: the model is made resident again ONCE and the chat resent', () => withDoor({}, async (server, ctx) => {
  await onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.withJobSession('mac', 'qwen3.8-27b-4bit', async (job) => {
    // Another item of the session (a transcription, the editor's title) loaded something else.
    server.setResident('qwen3.5-9b');
    const answer = await ctx.transport.chat({
      model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, job, what: 'the keeper call', trace: null,
    });
    assert.strictEqual(answer.finishReason, 'stop');
  }, { what: 'the keeper job' }));
  assert.strictEqual(chats(server).length, 2, 'one refused send and one resend, never more');
  const loads = server.jobs.filter((j) => j.type === 'load-model' && j.model === 'qwen3.8-27b-4bit');
  assert.strictEqual(loads.length, 2, 'the job load and the ONE re-ensure');
  assert.strictEqual(server.openSession(), null, 'the job closed its session');
  assert.strictEqual(server.sessions.length, 1, 'the re-ensure ran inside the same session');
}));

check('a second model_not_resident is not chased: the call fails by name', () => withDoor({}, async (server, ctx) => {
  server.faults.refuse = [{ match: { path: '/v1/openai/chat/completions' }, status: 409, code: 'model_not_resident', times: 2 }];
  const err = await rejection(onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null,
  })));
  assert.strictEqual(err.serverCode, 'model_not_resident');
  assert.strictEqual(chats(server).length, 2);
}));

check('upstream_unconfigured is a clear error naming the server and where the key goes', () => withDoor({ upstreams: {} }, async (_server, ctx) => {
  const err = await rejection(onLane(ctx, 'anthropic/claude-sonnet-5', () => ctx.transport.chat({
    model: 'anthropic/claude-sonnet-5', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 16000, what: 'the keeper call', trace: null,
  })));
  assert.ok(err instanceof CrucibleCallError);
  assert.strictEqual(err.code, 'upstream_unconfigured');
  assert.match(err.message, /"mac" has no anthropic key/);
  assert.match(err.message, /Settings › Crucible Servers › mac › Keys/);
}));

check('a 429 passes through as a 429 with the server\'s code, sent once and never retried here', () => withDoor({}, async (server, ctx) => {
  server.faults.refuse = [{ match: { path: '/v1/openai/chat/completions' }, status: 429, code: 'rate_limited', message: 'slow down', retryAfter: 5 }];
  const err = await rejection(onLane(ctx, 'anthropic/claude-sonnet-5', () => ctx.transport.chat({
    model: 'anthropic/claude-sonnet-5', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 16000, what: 'the keeper call', trace: null,
  })));
  assert.strictEqual(err.status, 429);
  assert.strictEqual(err.serverCode, 'rate_limited');
  assert.strictEqual(chats(server).length, 1);
}));

check('over the loaded context: throws BEFORE sending, naming the model, the server and both numbers', () => withDoor(
  { models: [{ id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384, maxModelLen: 16384 }] },
  async (server, ctx) => {
    const err = await rejection(onLane(ctx, 'qwen3.5-9b', () => ctx.transport.chat({
      model: 'qwen3.5-9b', prompt: 'word '.repeat(20000), act: 'generate', thinking: false, maxTokens: 8192, what: 'the keeper call', trace: null,
    })));
    assert.strictEqual(err.code, 'over_context');
    assert.match(err.message, /qwen3\.5-9b on "mac" is loaded with 16384/);
    assert.match(err.message, /needs ~\d+ tokens/);
    assert.strictEqual(chats(server).length, 0, 'nothing was sent');
    assert.strictEqual(server.openSession(), null, 'the one-call session was closed');
  },
));

check('a load context the call itself does not fit is refused before any load', () => withDoor({}, async (server, ctx) => {
  const err = await rejection(onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'word '.repeat(20000), act: 'generate', thinking: false, maxTokens: 8192, loadContext: 8192, what: 'the keeper call', trace: null,
  })));
  assert.strictEqual(err.code, 'over_context');
  assert.strictEqual(server.jobs.length, 0, 'nothing loaded');
}));

check('the job loads the model at its stated context (LEDGER #111), and that is the window it is checked against', () => withDoor({}, async (server, ctx) => {
  await onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, loadContext: 24576, what: 'the keeper call', trace: null,
  }));
  const load = server.jobs.find((j) => j.type === 'load-model');
  assert.strictEqual(load.params.context, 24576);
  assert.ok(!('lease' in load.params), 'no lease: leases are gone (1.0.76)');
  const submit = server.requestsTo('/v1/jobs', 'POST')[0];
  assert.strictEqual(submit.headers['x-crucible-session'], server.sessions[0].id, 'the load is an item of the call\'s session');
  assert.ok(!('queue' in submit.body), 'a session\'s helper sends no queue (its items go ahead of the line)');
}));

check('cancel aborts the open fetch and closes the call\'s session', () => withDoor({}, async (server, ctx) => {
  server.inject({ chatDelayMs: 5_000 });
  const controller = new AbortController();
  const pending = onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, signal: controller.signal, what: 'the keeper call', trace: null,
  }));
  await until(() => chats(server).length === 1);
  const started = Date.now();
  controller.abort();
  const err = await rejection(pending);
  assert.strictEqual(err.name, 'JobCancelledError');
  assert.ok(Date.now() - started < 2_000, 'the fetch was aborted, not waited out');
  assert.strictEqual(server.openSession(), null, 'the session was closed');
  assert.deepStrictEqual(server.sessions.map((row) => row.reason), ['client']);
}));

check('a reply without finish_reason is REFUSED (never read as stop), and finish_reason length is a hard failure', () => withDoor(
  { chatReplies: { 'qwen3.8-27b-4bit': (body) => (body.max_tokens === 111 ? { content: 'half an', finishReason: 'length' } : body.max_tokens === 112 ? { content: 'x', noDone: true } : { content: 'x', finishReason: null }) } },
  async (_server, ctx) => {
    const base = { model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, what: 'the keeper call', trace: null };
    const call = (request) => onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.chat(request));
    assert.strictEqual((await rejection(call({ ...base, maxTokens: 100 }))).code, 'protocol_error');
    assert.strictEqual((await rejection(call({ ...base, maxTokens: 112 }))).code, 'unreachable', 'a stream with no [DONE] is truncated, not whole');
    const cut = await rejection(call({ ...base, maxTokens: 111 }));
    assert.strictEqual(cut.code, 'truncated');
    assert.match(cut.message, /cut off at its 111-token ceiling/);
  },
));

check('the act: `generate` where the server lists it, `analysis` on a pre-1.0.24 server, said ONCE per server', () => withDoor(
  { legacyActs: true },
  async (server, ctx) => {
    const base = { model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null };
    await onLane(ctx, base.model, () => ctx.transport.chat(base));
    await onLane(ctx, base.model, () => ctx.transport.chat(base));
    assert.deepStrictEqual(chats(server).map(actOf), ['analysis', 'analysis']);
    assert.deepStrictEqual(server.sessions.map((row) => row.act), ['analysis', 'analysis'], 'the session names the same act');
    const said = logged.filter((l) => l.text.includes('predates 1.0.24; sending act analysis'));
    assert.strictEqual(said.length, 1, 'one line per server per session (Law 8)');
  },
));

check('a session the server ends fails the job\'s next call by name, and nothing is sent outside it or reopened', () => withDoor({}, async (server, ctx) => {
  const err = await rejection(onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.withJobSession('mac', 'qwen3.8-27b-4bit', async (job) => {
    server.endSession(server.sessions[0].id, 'operator', 'ended from the desktop Queue');
    await until(() => ctx.sessions.openOn('mac') === null);
    await ctx.transport.chat({
      model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, job, what: 'the keeper call', trace: null,
    });
  }, { what: 'the keeper job' })));
  assert.strictEqual(err.code, 'session_closed');
  assert.match(err.message, /operator/);
  assert.strictEqual(chats(server).length, 0, 'nothing was sent outside the session');
  assert.strictEqual(server.sessions.length, 1, 'no new session was opened to carry on');
}));

check('a chat whose session the server closed mid-flight is refused session_closed on the wire, and named', () => withDoor({}, async (server, ctx) => {
  // The SDK's own follow of the session has not heard yet: the server's refusal of the item is what says it.
  server.faults.refuse = [{ match: { path: '/v1/openai/chat/completions' }, status: 409, code: 'session_closed', message: 'queue session ended (idle)', details: { session_id: 'ses-x', reason: 'idle' } }];
  const err = await rejection(onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null,
  })));
  assert.strictEqual(err.code, 'session_closed');
  assert.match(err.message, /idle/);
}));

check('a job holds ONE session per server: two models trade the card inside it, every item names it, and it closes at the end', () => withDoor({}, async (server, ctx) => {
  const job = ctx.transport.job('the keeper job');
  const call = (model) => onLane(ctx, model, () => ctx.transport.chat({ model, prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, job, what: 'the keeper call', trace: null }));
  await call('qwen3.8-27b-4bit');
  await call('qwen3.8-27b-4bit');
  await call('qwen3.5-9b');
  assert.strictEqual(server.sessions.length, 1, 'three calls, two models, one session');
  assert.deepStrictEqual(server.jobs.filter((j) => j.type === 'load-model').map((j) => j.model), ['qwen3.8-27b-4bit', 'qwen3.5-9b']);
  const id = server.sessions[0].id;
  assert.ok([...chats(server), ...server.requestsTo('/v1/jobs', 'POST')].every((r) => r.headers['x-crucible-session'] === id));
  assert.strictEqual(server.sessions[0].idleS, 900, 'idle_s 900 on every session (LEDGER #255)');
  await job.releaseAll();
  assert.strictEqual(server.openSession(), null);
  assert.deepStrictEqual(ctx.ledger.read(), [], 'the session row left the ledger');
}));

check('another app\'s session holds the server: a standalone local call waits in the line, and runs once it closes', () => withDoor({}, async (server, ctx) => {
  const holder = server.holdAsOther('bookforge/1.0', 'translate');
  const pending = onLane(ctx, 'qwen3.8-27b-4bit', () => ctx.transport.chat({
    model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null,
  }));
  await until(() => server.sessions.length === 2 && server.sessions[1].status === 'queued');
  assert.strictEqual(chats(server).length + server.jobs.length, 0, 'nothing was sent while it waited');
  server.endSession(holder, 'client');
  const answer = await pending;
  assert.strictEqual(answer.server, 'mac');
}));

check('an upstream chat to a server another app\'s session holds is refused by name (busy, the holder\'s sentence), never retried', () => withDoor({}, async (server, ctx) => {
  server.holdAsOther('bookforge/1.0', 'translate');
  const err = await rejection(onLane(ctx, 'anthropic/claude-sonnet-5', () => ctx.transport.chat({
    model: 'anthropic/claude-sonnet-5', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 16000, what: 'the keeper call', trace: null,
  })));
  assert.strictEqual(err.code, 'busy');
  assert.strictEqual(err.serverCode, 'session_open');
  assert.match(err.busyLine, /bookforge/);
  assert.strictEqual(chats(server).length, 1, 'sent once');
}));

check('a paused or older server takes no work, by name', () => withDoor({}, async (_server, ctx) => {
  ctx.servers.setPaused('mac', true);
  const base = { model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null };
  // The lane refuses a standalone GPU call on a paused server before the door is reached.
  assert.strictEqual((await rejection(onLane(ctx, base.model, () => ctx.transport.chat(base)))).code, 'server_paused');
}).then(() => withDoor({ version: '1.0.24' }, async (_server, ctx) => {
  const base = { model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null };
  assert.strictEqual((await rejection(onLane(ctx, base.model, () => ctx.transport.chat(base)))).code, 'needs_update');
})));

check('P3\'s contract: the load is in the ledger before the next await and settled at the end, in the session the lane hands it; the answer beats', () => withDoor({}, async (server, ctx) => {
  const said = [];
  const transport = new CrucibleTransport({
    servers: ctx.servers, factory: ctx.factory, probes: ctx.probes,
    hooks: () => ({
      lane: 'gpu', server: 'mac', jobId: 'job-1', signal: null,
      session: (request) => { said.push(`session ${request.act}`); return ctx.sessions.use('mac', request); },
      submitted: (row) => said.push(`submitted ${row.jobType} ${row.model}`),
      settled: (_at, kind) => said.push(`settled ${kind}`),
      streamed: () => { if (said[said.length - 1] !== 'streamed') said.push('streamed'); },
      beat: () => { if (said[said.length - 1] !== 'beat') said.push('beat'); },
      streamDropped: async () => ({ rows: [], kept: [], timedOut: false }),
    }),
  });
  await transport.chat({ model: 'qwen3.8-27b-4bit', prompt: 'hello', act: 'generate', thinking: false, maxTokens: 100, what: 'the keeper call', trace: null });
  assert.deepStrictEqual(said, [
    'session generate', 'submitted load-model qwen3.8-27b-4bit', 'streamed', 'settled job', 'beat',
  ]);
  assert.strictEqual(server.openSession(), null, 'the one-call session closed');
}));

check('a GPU call runs on its lane\'s server and nowhere else, and a lane-less local call is refused by name', () => withDoor({}, async (_server, ctx) => {
  const lane = (server) => new CrucibleTransport({
    servers: ctx.servers, factory: ctx.factory, probes: ctx.probes,
    hooks: () => ({ lane: 'cloud', server, jobId: '', signal: null, session: async () => { throw new Error('no session for a cloud step'); }, submitted() {}, settled() {}, streamed() {}, beat() {}, async streamDropped() { return { rows: [], kept: [], timedOut: false }; } }),
  });
  const err = await rejection(lane(null).chat({ model: 'qwen3.8-27b-4bit', prompt: 'x', act: 'generate', thinking: false, maxTokens: 10, what: 'the keeper call', trace: null }));
  assert.match(err.message, /runs on its server's lane/);
  // Outside any lane, the lanes' own refusal: nothing admitted it.
  assert.match((await rejection(ctx.transport.chat({ model: 'qwen3.8-27b-4bit', prompt: 'x', act: 'generate', thinking: false, maxTokens: 10, what: 'the keeper call', trace: null }))).message, /outside queueAITask/);
}));

// ── decide ───────────────────────────────────────────────────────────────────

check('decide: act `decide`, the named model, the report mode; a server without the door refuses by name', () => withDoor({}, async (server, ctx) => {
  const answer = await onLane(ctx, 'qwen3.5-9b', () => ctx.transport.decide({
    model: 'qwen3.5-9b',
    state: 'The host talks about the budget vote.',
    questions: { topic: { type: 'choice', instructions: 'Which item?', options: { budget: 'the budget', mayor: 'the mayor' } } },
    missing: 'report',
    what: 'assign sentence 1',
    trace: null,
  }));
  assert.ok(answer.answers.topic);
  const sent = server.requestsTo('/v1/decide', 'POST')[0];
  assert.strictEqual(actOf(sent), 'decide');
  assert.strictEqual(sent.body.model, 'qwen3.5-9b');
  assert.strictEqual(sent.body.missing, 'report');
  assert.strictEqual(server.sessions[0].act, 'decide');
  assert.strictEqual(sent.headers['x-crucible-session'], server.sessions[0].id, 'the decision is an item of the session');
}).then(() => withDoor({ legacyActs: true }, async (_server, ctx) => {
  const err = await rejection(onLane(ctx, 'qwen3.5-9b', () => ctx.transport.decide({
    model: 'qwen3.5-9b', state: 'x', questions: { q: { type: 'yesno', instructions: 'Is it?' } }, what: 'assign', trace: null,
  })));
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
    const view = routing.buildRoutingView({ titles: 'sonnet5', description: 'qwen35-4b' }, inventory, { routingServer: null, selectedServer: 'mac' });
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
run('crucible: the one door (transport, session, act, catalog)').then(() => process.exit(process.exitCode ?? 0));
