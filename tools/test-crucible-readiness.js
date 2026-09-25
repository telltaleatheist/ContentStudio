/**
 * THE ONE READINESS SIGNAL: ready / starting / unreachable / not-installed /
 * not-configured, each with its one door, pushed to the renderer only when it
 * changes (plan section 0a).
 *
 * Ported from Briefcase's backend/test/crucible/readiness.spec.ts, over the
 * composition root with the local engine scripted (scriptedLocal: nothing is
 * installed, spawned or read off this machine's real ~/.crucible). Briefcase's
 * automatic start when queued AI work waits is P3's, so here Start is only ever
 * the explicit door. ContentStudio's additions: a paused selected server is
 * not ready (its work waits), and a corrupt routing record is answered as the
 * refusal it is rather than read as "no servers" (which would offer to install
 * a Crucible that is there).
 */
const fs = require('fs');
const path = require('path');
const { assert, crucible, fake, context, until, check, run } = require('./_crucible-keeper');

const { CrucibleRequiredError } = crucible('readiness');
const { ROUTING_FILE } = crucible('routing');

/** A context whose local engine says `status`, on a machine that is (not) hostable, with (no) Crucible here. */
function wired({ hostable = true, here = null, status = null } = {}) {
  const made = context({
    discovered: () => here ?? { present: false, code: 'no_local_config', reason: 'nothing here' },
  });
  if (!hostable) made.scripted.state.arch = 'x64';
  if (status) made.scripted.state.status = status;
  return made;
}

const DISCOVERED = (registeredAs) => ({ present: true, serverName: 'crucible@owens-mac-studio', url: 'http://127.0.0.1:7100', tokenMasked: '****abcd', file: '/x/pairing', registeredAs });

async function withFake(options, fn) {
  const server = await fake.startFakeCrucible(options);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

check('before the first derivation it answers from the registry alone, reading no network', () => {
  const { ctx } = wired();
  assert.strictEqual(ctx.readiness.current().state, 'not-configured');
  assert.strictEqual(ctx.readiness.current().reason, 'Checking for Crucible...');
  assert.strictEqual(ctx.readiness.current().action, null);
});

check('ready: the selected server answers; both gates pass', () => withFake({}, async (server) => {
  const { ctx } = wired();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  const view = await ctx.readiness.refresh();
  assert.deepStrictEqual([view.state, view.server, view.action, view.busy], ['ready', 'mac', null, null]);
  ctx.readiness.assertCanQueue('Metadata');
  ctx.readiness.assertReadyNow('Soften');
  ctx.readiness.stop();
}));

check('ready but busy: another client holding the card is said, and work still queues', () => withFake({}, async (server) => {
  server.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.4 } });
  const { ctx } = wired();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  const view = await ctx.readiness.refresh();
  assert.strictEqual(view.state, 'ready');
  assert.match(view.busy, /bookforge, tts 40% done/);
  ctx.readiness.assertCanQueue('Metadata');
  ctx.readiness.stop();
}));

check('unreachable (a remote server down): connect; queued work is accepted, an immediate call is refused', async () => {
  const { ctx } = wired();
  ctx.servers.add({ name: 'owens-pc', url: await fake.unusedLoopbackUrl(), token: 'tok-pc-0000' });
  const view = await ctx.readiness.refresh();
  assert.deepStrictEqual([view.state, view.action], ['unreachable', 'connect']);
  assert.match(view.reason, /owens-pc/);
  ctx.readiness.assertCanQueue('Metadata');
  assert.throws(() => ctx.readiness.assertReadyNow('Soften'), CrucibleRequiredError);
  ctx.readiness.stop();
});

check('unreachable, and it is the Crucible on this computer, stopped: start', async () => {
  const { ctx } = wired({ here: DISCOVERED('local'), status: { state: 'stopped', detail: 'launchd: not running', url: '', name: '' } });
  ctx.servers.add({ name: 'local', url: await fake.unusedLoopbackUrl(), token: 'tok-0000' });
  const view = await ctx.readiness.refresh();
  assert.deepStrictEqual([view.state, view.action, view.reason], ['unreachable', 'start', 'Crucible is stopped on this computer.']);
  ctx.readiness.stop();
});

check('installed here but not registered: start (which adopts it)', async () => {
  const { ctx } = wired({ here: DISCOVERED(null) });
  const view = await ctx.readiness.refresh();
  assert.deepStrictEqual([view.state, view.action], ['unreachable', 'start']);
  ctx.readiness.stop();
});

check('not installed, and this computer can host one: install; AI work is refused at the door, by name', async () => {
  const { ctx } = wired();
  const view = await ctx.readiness.refresh();
  assert.deepStrictEqual([view.state, view.action], ['not-installed', 'install']);
  assert.throws(() => ctx.readiness.assertCanQueue('Transcription'), (err) => {
    assert.ok(err instanceof CrucibleRequiredError);
    assert.strictEqual(err.code, 'crucible_required');
    assert.match(err.message, /^Transcription needs Crucible\. Crucible is not installed/);
    assert.strictEqual(err.readiness.state, 'not-installed');
    return true;
  });
  ctx.readiness.stop();
});

check('not configured: this computer cannot host one (an Intel Mac): connect, with why', async () => {
  const { ctx } = wired({ hostable: false });
  const view = await ctx.readiness.refresh();
  assert.deepStrictEqual([view.state, view.action], ['not-configured', 'connect']);
  assert.match(view.reason, /Intel processor.*Connect to a Crucible on another computer/);
  ctx.readiness.stop();
});

check('not configured: servers are registered and none is selected (the selected one was removed)', () => withFake({}, async (server) => {
  const { ctx } = wired();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  ctx.servers.add({ name: 'owens-pc', url: 'http://127.0.0.1:9', token: 'tok-pc' });
  ctx.servers.remove('mac');
  const view = await ctx.readiness.refresh();
  assert.deepStrictEqual([view.state, view.action], ['not-configured', 'connect']);
  assert.match(view.reason, /No Crucible server is selected/);
  ctx.readiness.stop();
}));

check('a paused selected server is not ready and is not probed; its work waits; Running makes it ready again', () => withFake({}, async (server) => {
  const { ctx } = wired();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  ctx.servers.setPaused('mac', true);
  const pings = server.requestsTo('/v1/ping').length;
  const paused = await ctx.readiness.refresh();
  assert.deepStrictEqual([paused.state, paused.action], ['unreachable', 'connect']);
  assert.match(paused.reason, /mac is paused/);
  assert.strictEqual(server.requestsTo('/v1/ping').length, pings);
  ctx.readiness.assertCanQueue('Metadata');
  assert.throws(() => ctx.readiness.assertReadyNow('Soften'), CrucibleRequiredError);
  ctx.servers.setPaused('mac', false);
  assert.strictEqual((await ctx.readiness.refresh()).state, 'ready');
  ctx.readiness.stop();
}));

check('a corrupt routing record is answered as its refusal, never as "no servers" (which would offer an install)', () => withFake({}, async (server) => {
  const { ctx, dir } = wired();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  fs.writeFileSync(path.join(dir, ROUTING_FILE), '{ torn');
  const view = await ctx.readiness.refresh();
  assert.deepStrictEqual([view.state, view.action], ['not-configured', 'connect']);
  assert.match(view.reason, /crucible-routing\.json is not valid JSON/);
  ctx.readiness.stop();
}));

check('starting: the explicit Start door says starting at once, then ready once the engine answers', () => withFake({}, async (server) => {
  const made = wired({ here: DISCOVERED('local'), status: { state: 'stopped', detail: 'stopped', url: '', name: '' } });
  const { ctx, scripted, pushed } = made;
  ctx.servers.add({ name: 'local', url: await fake.unusedLoopbackUrl(), token: server.token });
  await ctx.readiness.refresh();
  assert.strictEqual(ctx.readiness.current().action, 'start');
  scripted.state.startResult = async () => {
    // The engine came up; the registry now points where it answers.
    ctx.servers.remove('local');
    ctx.servers.add({ name: 'local', url: server.url, token: server.token });
    return { state: 'running', detail: 'running', url: server.url, name: 'crucible@fake' };
  };
  const answered = await ctx.readiness.startLocal();
  assert.strictEqual(answered.state, 'starting');
  assert.strictEqual(answered.progress, 'Starting Crucible on this computer...');
  await until(() => ctx.readiness.current().state === 'ready');
  assert.strictEqual(scripted.state.starts, 1);
  const states = pushed.readiness.map((v) => v.state);
  for (const state of ['unreachable', 'starting', 'ready']) assert.ok(states.includes(state), `pushed ${states.join(' → ')}`);
  ctx.readiness.stop();
}));

check('a start that fails says why, and nothing starts it again on its own', async () => {
  const { ctx, scripted } = wired({ here: DISCOVERED(null), status: { state: 'stopped', detail: 'stopped', url: '', name: '' } });
  scripted.state.startResult = async () => ({ state: 'broken', detail: 'launchctl: service not found', url: '', name: '' });
  await ctx.readiness.refresh();
  await ctx.readiness.startLocal();
  await until(() => /could not be started.*service not found/.test(ctx.readiness.current().reason));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(scripted.state.starts, 1);
  ctx.readiness.stop();
});

check('"Not now": remembered for the session, queueing is refused, an explicit Start still works', async () => {
  const { ctx, scripted } = wired({ here: DISCOVERED(null), status: { state: 'stopped', detail: 'stopped', url: '', name: '' } });
  await ctx.readiness.refresh();
  assert.strictEqual(ctx.readiness.decline().declined, true);
  assert.throws(() => ctx.readiness.assertCanQueue('Metadata'), CrucibleRequiredError);
  assert.strictEqual((await ctx.readiness.refresh()).declined, true);
  await ctx.readiness.startLocal();
  await until(() => scripted.state.starts === 1);
  await until(() => ctx.readiness.current().state !== 'starting');
  ctx.readiness.stop();
});

check('pushes only when the answer changes, and a registry change re-derives on its own', () => withFake({}, async (server) => {
  const { ctx, pushed } = wired();
  const heard = [];
  ctx.readiness.onChange((view) => heard.push(view.state));
  ctx.readiness.start();
  await until(() => pushed.readiness.length === 1);
  assert.strictEqual(pushed.readiness[0].state, 'not-installed');
  await ctx.readiness.refresh();
  assert.strictEqual(pushed.readiness.length, 1);
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  await until(() => ctx.readiness.current().state === 'ready');
  assert.deepStrictEqual(heard, ['not-installed', 'ready']);
  ctx.readiness.stop();
}));

check('the server going away turns ready into unreachable on the next derivation, and back when it returns', async () => {
  const server = await fake.startFakeCrucible({});
  const port = Number(new URL(server.url).port);
  const token = server.token;
  const { ctx } = wired();
  ctx.servers.add({ name: 'mac', url: server.url, token });
  assert.strictEqual((await ctx.readiness.refresh()).state, 'ready');
  await server.close();
  // The probe cache holds a 15 s answer; the Test button (a fresh probe) is what a person presses.
  await ctx.probes.test('mac');
  assert.strictEqual((await ctx.readiness.refresh()).state, 'unreachable');
  const back = await fake.startFakeCrucible({ port, token });
  try {
    await ctx.probes.test('mac');
    assert.strictEqual((await ctx.readiness.refresh()).state, 'ready');
  } finally {
    ctx.readiness.stop();
    await back.close();
  }
});

run('crucible: readiness transitions');
