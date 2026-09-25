/**
 * Keeper: snap chaptering over the REAL transport and lanes, against the fake Crucible (P8b).
 *
 * What it pins, each a place where the wiring could be wrong while the pure service is right:
 *
 *   - the outline and every decide question go to the fixed scorer (qwen3.5-9b), loaded at the
 *     smallest step that holds them (8,192 for this short video; LEDGER #209, snap-chapters.ts
 *     loadContextFor), the outline thinking-off at temperature 0;
 *   - the titles go to the chapters row (the 27B), loaded at 24,576 to hold a 16,384 thinking
 *     budget (LEDGER #208), thinking ON, and X-Crucible-Sampling says the server took both the
 *     call's `thinking` and its `max_tokens` as sent ("request"; the Crucible agent's check);
 *   - a title that runs out its budget (`finish_reason: length`) ships its outline label with a
 *     warning, never a failed run (Law 3);
 *   - one job's leases carry the whole run: the 9B, then the 27B, both released at the end;
 *   - a server with no decide door refuses the run by name (decide_not_served).
 *
 * Run it against the COMPILED main process: `npm run build:electron && node tools/test-crucible-snap.js`.
 */
const path = require('path');
const { assert, fake, context, rejection, check, run, crucible, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
services('metadata/prompt-assets.js').initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));

const { installCrucibleTransport } = crucible('transport');
const { installLanes } = crucible('lanes');
const snap = services('metadata/snap-chapters.js');
const routing = services('metadata/metadata-routing.js');
const service = services('metadata/chaptering/chaptering.service.js');

const MODELS = [
  { id: 'qwen3.8-27b-4bit', paramsB: 27, installed: true, contextDefault: 98304 },
  { id: 'qwen3.5-9b', paramsB: 9, installed: true, contextDefault: 16384 },
];

/** A short two-subject video: the fake outline names both, the fake decide assigns by keyword. */
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
  if (body.model === 'qwen3.5-9b') return { content: 'Budget vote\nMayor walks out', finishReason: 'stop' };
  const prompt = body.messages[body.messages.length - 1].content;
  if (/Title chapter 2/.test(prompt)) return { content: '', finishReason: 'length' };
  return { content: 'The council budget vote\nThe council voted on the budget.', finishReason: 'stop' };
}

async function withSnap(options, fn) {
  const server = await fake.startFakeCrucible({ version: '1.0.34', models: MODELS, decideProbs, chatReplies: { '*': chatReply }, ...options });
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

function transportsOn(ctx, chaptersOption) {
  const resolved = routing.resolveMetadataRouting({ chapters: chaptersOption });
  const models = routing.resolveSnapChapterModels(resolved, ctx.lanes.gpuVenue());
  const job = ctx.transport.job('the keeper snap run');
  const warned = [];
  return { models, job, warned, t: snap.snapTransports({ models, job, trace: [], laneName: 'keeper', warn: (w) => warned.push(w) }) };
}

check('the outline and decide run on the 9B at 8,192 (all a short video needs); the titles on the chapters row at 24,576, thinking on, taken as sent', () => withSnap({}, async (server, ctx) => {
  const { models, job, t } = transportsOn(ctx, 'qwen38-27b');
  assert.deepStrictEqual(models.scorer, { model: 'qwen3.5-9b', server: 'mac' });
  const r = await service.chapter(CAPTIONS, { granularity: 'chapters', chat: t.chat, decide: t.decide });
  await job.releaseAll();

  const decides = server.decideBodies();
  assert.ok(decides.length >= 1 && decides.every((b) => b.model === 'qwen3.5-9b' && b.missing === 'report'));
  const loads = server.requestsTo('/v1/jobs', 'POST').map((q) => q.body).filter((b) => b.type === 'load-model');
  assert.deepStrictEqual(loads.map((b) => [b.model, b.params.context]), [['qwen3.5-9b', 8192], ['qwen3.8-27b-4bit', 24576]]);
  // The step rule itself: a stream chunk's ~12k-token state takes 16,384; a thinking title 24,576.
  assert.strictEqual(snap.loadContextFor(3.5 * 12000, snap.DECIDE_QUESTION_TOKENS), 16384);
  assert.strictEqual(snap.loadContextFor(3.5 * 2000, 1000), 8192);
  assert.strictEqual(snap.loadContextFor(3.5 * 6000, 16384), 24576);

  const chats = server.requestsTo('/v1/openai/chat/completions', 'POST').map((q) => q.body);
  const outline = chats.filter((b) => b.model === 'qwen3.5-9b');
  const titles = chats.filter((b) => b.model === 'qwen3.8-27b-4bit');
  assert.ok(outline.length === 1 && outline[0].chat_template_kwargs.enable_thinking === false && outline[0].temperature === 0);
  assert.strictEqual(titles.length, 2);
  assert.ok(titles.every((b) => b.chat_template_kwargs.enable_thinking === true && b.max_tokens === 16384 && !('temperature' in b)));

  // The chapters: two, times from sentence units (the fake assigns by the quoted pair, so the
  // first mayor sentence, quoted after a budget one, stays with the budget); the one whose title
  // ran out carries its label.
  assert.deepStrictEqual(r.chapters.map((c) => [c.startSec, c.label, c.title]), [[0, 'Budget vote', 'The council budget vote'], [210, 'Mayor walks out', '']]);
  assert.ok(r.stats.warnings.some((w) => w.includes('ran out its 16384-token budget (thinking on)')));
  assert.strictEqual(r.stats.titleMs.length, 2);
  const published = snap.toChapterPipelineResult(r, true);
  assert.deepStrictEqual(published.chapters.map((c) => c.title), ['The council budget vote', 'Mayor walks out']);
  assert.strictEqual(published.stats.engine, 'snap');
  assert.strictEqual(published.stats.snap.titleThinking, true);
}));

check('X-Crucible-Sampling is read off every chat: thinking and max_tokens came from the request', () => withSnap({}, async (server, ctx) => {
  const answer = await ctx.lanes.aiCall({ lane: 'gpu', model: 'qwen3.8-27b-4bit' }, 'keeper', () =>
    ctx.transport.chat({ model: 'qwen3.8-27b-4bit', prompt: 'x', act: 'generate', thinking: true, maxTokens: 16384, loadContext: 24576, what: 'a title', trace: null }));
  assert.strictEqual(answer.sampling.thinking, 'request');
  assert.strictEqual(answer.sampling.max_tokens, 'request');
  const { samplingOf } = crucible('transport');
  assert.deepStrictEqual(samplingOf('{"max_tokens":"request","thinking":{"source":"manifest"}}'), { max_tokens: 'request', thinking: 'manifest' });
  assert.strictEqual(samplingOf(null), null);
  assert.strictEqual(samplingOf('not json'), null);
}));

check('a server that serves no decide door refuses the snap run by name; nothing is chaptered another way', () => withSnap({ disabledClasses: { decide: 'mlx-lm caps top_logprobs at 11' } }, async (server, ctx) => {
  const { job, t } = transportsOn(ctx, 'qwen38-27b');
  const err = await rejection(service.chapter(CAPTIONS, { granularity: 'chapters', chat: t.chat, decide: t.decide }));
  await job.releaseAll();
  assert.strictEqual(err.code, 'decide_not_served');
  assert.ok(/"mac"/.test(err.message) && /nothing falls back/.test(err.message), err.message);
  assert.strictEqual(server.decideBodies().length, 0);
}));

run('crucible: snap chaptering over the door (the 9B scorer, the titles row, thinking and its budget)');
