#!/usr/bin/env node
/**
 * KEEPER: the shared prefix (LEDGER #289). A local call that states the prefix it shares with the
 * other calls about its video sends that prefix as the system message and the rest as the user
 * message, so Crucible's mlx-lm prompt cache (saved at the end of the system messages) reuses the
 * prefill; a second call with the same prefix is not sent while the first is still prefilling; a
 * different prefix, or no prefix, never waits. The trace records the whole prompt, unchanged.
 */
const path = require('path');
const { assert, fake, context, check, run, crucible, until, REPO } = require('./_crucible-keeper');

const DIST = path.join(REPO, 'dist', 'main');
const services = (name) => require(path.join(DIST, 'services', name));
services('metadata/prompt-assets.js').initPromptAssets(path.join(REPO, 'electron', 'assets', 'prompts'));

const { installCrucibleTransport } = crucible('transport');
const { installLanes } = crucible('lanes');
const { JobModelLifecycle } = services('metadata/model-lifecycle.js');
const { AIManagerService } = services('metadata/ai-manager.service.js');

const BIG = 'qwen3.8-27b-4bit';
const MODELS = [{ id: BIG, paramsB: 27, installed: true, contextDefault: 98304 }];
const VIDEO = 'PLAIN CONTRACT\n\n=== WHAT THIS VIDEO ACTUALLY COVERS ===\nThe council voted on the budget.\n===';

async function world() {
  const held = [];
  const server = await fake.startFakeCrucible({
    name: 'crucible@mac', version: '1.0.80', models: MODELS,
    chatReplies: { '*': () => ({ content: 'an answer', finishReason: 'stop' }) },
    holdAnswer: (kind, body) => new Promise((resolve) => held.push({ body, resolve })),
  });
  const made = context();
  made.ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  made.ctx.servers.select('mac');
  installCrucibleTransport(made.ctx.transport);
  installLanes(made.ctx.lanes);
  const close = async () => {
    for (const h of held.splice(0)) h.resolve();
    made.ctx.lanes.stop();
    await made.ctx.sessions.closeAll('the keeper is done');
    installCrucibleTransport(null);
    installLanes(null);
    await server.close();
  };
  return { ctx: made.ctx, held, close };
}

async function asJob(w, jobId, work) {
  await w.ctx.lanes.plan([{ jobId, fast: false }]);
  const controller = new AbortController();
  return w.ctx.lanes.runJob({ jobId, fast: false, stage: 'fields', controller }, () => work(controller));
}

function manager(lifecycle, controller) {
  const ai = new AIManagerService({ promptSetsDir: path.join(REPO, 'electron', 'assets'), promptSet: 'youtube-telltale', transcriptCeiling: 'local', jobSessions: lifecycle.sessions, abortSignal: controller.signal });
  ai.loadPrompts();
  return ai;
}
const shape = (lifecycle, sharedPrefix) => ({ thinking: false, maxTokens: 256, loadContext: 8192, job: lifecycle.sessions, ...(sharedPrefix === undefined ? {} : { sharedPrefix }) });

check('the prefix is the system message and the rest the user message; the trace keeps the whole prompt', async () => {
  const w = await world();
  try {
    const lifecycle = new JobModelLifecycle('the prefix keeper');
    let ai;
    let answer;
    const done = asJob(w, 'job-prefix-1', async (controller) => {
      ai = manager(lifecycle, controller);
      answer = await ai.runPlainRequest(`${VIDEO}\n\n## TITLES\nWrite ten.`, BIG, 'the titles call', shape(lifecycle, VIDEO));
    });
    await until(() => w.held.length === 1, 'the call reaches the server');
    const messages = w.held[0].body.messages;
    assert.deepStrictEqual(messages.map((m) => m.role), ['system', 'user']);
    assert.strictEqual(messages[0].content, VIDEO);
    assert.strictEqual(messages[1].content, '## TITLES\nWrite ten.', 'the rest, its leading blank line off');
    w.held.shift().resolve();
    await done;
    assert.strictEqual(answer, 'an answer');
    assert.strictEqual(ai.promptTrace.at(-1).prompt, `${VIDEO}\n\n## TITLES\nWrite ten.`, 'traced whole');
  } finally {
    await w.close();
  }
});

check('a second call with the same prefix is not sent while the first prefills; another prefix, or none, goes at once', async () => {
  const w = await world();
  try {
    const lifecycle = new JobModelLifecycle('the prefix keeper');
    let answers;
    const done = asJob(w, 'job-prefix-2', async (controller) => {
      const ai = manager(lifecycle, controller);
      answers = await Promise.all([
        ai.runPlainRequest(`${VIDEO}\n\nFIRST`, BIG, 'the titles call', shape(lifecycle, VIDEO)),
        ai.runPlainRequest(`${VIDEO}\n\nSECOND`, BIG, 'the pinned comment call', shape(lifecycle, VIDEO)),
        ai.runPlainRequest('OTHER VIDEO\n\nTHIRD', BIG, 'another video', shape(lifecycle, 'OTHER VIDEO')),
        ai.runPlainRequest('NO PREFIX', BIG, 'a plain call', shape(lifecycle, undefined)),
      ]);
    });
    await until(() => w.held.length === 3, 'the first, the other prefix and the plain call reach the server');
    await new Promise((r) => setTimeout(r, 150));
    const last = (h) => String(h.body.messages.at(-1).content);
    assert.deepStrictEqual(w.held.map(last).sort(), ['FIRST', 'NO PREFIX', 'THIRD'], 'the second waits');
    w.held.splice(w.held.findIndex((h) => last(h) === 'FIRST'), 1)[0].resolve();
    await until(() => w.held.some((h) => last(h) === 'SECOND'), 'the second goes once the first has answered');
    for (const h of w.held.splice(0)) h.resolve();
    await done;
    assert.deepStrictEqual(answers, ['an answer', 'an answer', 'an answer', 'an answer']);
  } finally {
    await w.close();
  }
});

check('a prefix the prompt does not start with is refused before anything is sent', async () => {
  const w = await world();
  try {
    const lifecycle = new JobModelLifecycle('the prefix keeper');
    let error = null;
    await asJob(w, 'job-prefix-3', async (controller) => {
      const ai = manager(lifecycle, controller);
      try { await ai.runPlainRequest('SOMETHING ELSE', BIG, 'a wrong prefix', shape(lifecycle, VIDEO)); } catch (e) { error = e; }
    }).catch(() => undefined);
    assert.ok(error && /shared prefix is not the start of its prompt/.test(error.message), String(error && error.message));
    assert.strictEqual(w.held.length, 0, 'nothing reached the server');
  } finally {
    await w.close();
  }
});

run('shared prefix');
