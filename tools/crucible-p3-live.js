#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * P3's LIVE ACCEPTANCE against a real Crucible (docs/crucible/P3.md), driving the
 * compiled main-process layer the app runs: the composition root, the lanes, the
 * ledger and its sweeps. Law 7: the Mac's Crucible is open to agents (LEDGER #205);
 * the PC needs Owen's go EVERY time, so `--server` must never name it without that.
 *
 * The one step each job runs here is an `echo` job (it takes the lane and leaves the
 * card alone: nothing is loaded or evicted), sent inside the job's Crucible 1.0.76
 * QUEUE SESSION (`crucibleStepHooks().session`, LEDGER #255) and recorded through the
 * hooks, exactly as transport.ts records its own.
 *
 *   node tools/crucible-p3-live.js line  --state <dir> [--server mac]
 *       A holder (client "p3-live-holder") opens a queue session and runs a 40 s echo
 *       job in it; a ContentStudio job's session then WAITS IN THE SERVER'S LINE (its
 *       place on the lane chip) and runs BY ITSELF once the holder's session closes.
 *
 *   node tools/crucible-p3-live.js hold  --state <dir> [--server mac]
 *       A ContentStudio job opens its queue session and starts a 60 s echo job in it,
 *       both in the ledger, then waits to be `kill -9`ed. Relaunch the app on the same
 *       userData (or run `sweep`) after: the sweep cancels the job and ends the session.
 *
 *   node tools/crucible-p3-live.js sweep --state <dir>     the startup sweep, alone
 *   node tools/crucible-p3-live.js check [--server mac]    any ContentStudio session or job on the server?
 *
 * `--state` is a userData directory (a scratch one: never Owen's). An empty one is
 * given the Crucible on this computer, from its pairing file, as `mac`.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');

const STUB = path.join(__dirname, '_electron-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-log') return require.resolve(STUB);
  return originalResolve.call(this, request, ...rest);
};
const DIST = path.join(__dirname, '..', 'dist', 'main', 'crucible');
const { createCrucibleContext } = require(path.join(DIST, 'context.js'));
const { installLanes, gpuCall, crucibleStepHooks } = require(path.join(DIST, 'lanes.js'));
const { readCruciblePairingFile, processPairingFileHost } = require(path.join(DIST, 'pairing-file.js'));
const { clientNameFor } = require(path.join(DIST, 'client-factory.js'));
const { CrucibleClient } = require('@crucible/client');

const stamp = () => new Date().toISOString().slice(11, 19);
const say = (line) => console.log(`${stamp()}  ${line}`);

function args() {
  const argv = process.argv.slice(2);
  const out = { verb: argv[0], state: null, server: 'mac' };
  for (let i = 1; i < argv.length; i += 1) {
    if (argv[i] === '--state') out.state = path.resolve(argv[++i]);
    else if (argv[i] === '--server') out.server = argv[++i];
    else throw new Error(`unknown option ${argv[i]}`);
  }
  if (/pc/i.test(out.server)) throw new Error('Law 7: the PC needs Owen\'s go every time. This harness does not send it work.');
  return out;
}

function open(state, serverName) {
  fs.mkdirSync(state, { recursive: true });
  const ctx = createCrucibleContext({
    stateDir: state, clipboard: () => {}, legacyClaudeKey: () => undefined, routingServer: () => null,
    push: { inLine: (jobId, server, position) => say(position === null ? `${jobId}: its session is open on "${server}"` : `${jobId}: in "${server}"'s line, ${position.position} of ${position.of}`) },
  });
  if (!ctx.servers.names().includes(serverName)) {
    const found = readCruciblePairingFile(processPairingFileHost());
    if (found === null) throw new Error('no Crucible pairing file on this computer');
    ctx.servers.add({ name: serverName, url: found.pairing.url, token: found.pairing.token });
    ctx.servers.select(serverName);
  }
  installLanes(ctx.lanes);
  return ctx;
}

/** The step transport.ts is, for an echo job: inside the job's session, submit, record at once, follow it to the end, settle. */
function echoStep(ctx, delayMs, onSubmitted = () => {}) {
  return ctx.lanes.aiCall(gpuCall('echo'), 'a P3 live echo', async () => {
    const hooks = crucibleStepHooks();
    const held = await hooks.session({ act: 'generate', what: 'a P3 live echo' });
    const client = held.card.session;
    const id = await client.submit({ type: 'echo', params: { delay_ms: delayMs }, inputs: { 'p3.txt': { inline: Buffer.from('p3') } }, clientRef: `p3-live-${hooks.jobId}` });
    hooks.submitted({ server: hooks.server, id, jobType: 'echo', model: null });
    onSubmitted(id);
    for (;;) {
      const status = await client.job(id);
      hooks.beat();
      if (['done', 'failed', 'cancelled', 'interrupted', 'removed'].includes(status.status)) {
        hooks.settled(hooks.server, 'job', id);
        await held.release();
        return status.status;
      }
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  });
}

async function holderClient(ctx, serverName) {
  const entry = ctx.servers.getWithToken(serverName);
  return new CrucibleClient({ url: entry.url, token: entry.token, clientName: 'p3-live-holder' });
}

async function line(a) {
  const ctx = open(a.state, a.server);
  await ctx.sweepAtStartup();
  ctx.lanes.start();
  const client = await ctx.factory.clientFor(a.server);
  const version = (await client.info()).server.version;
  say(`server "${a.server}" is Crucible ${version}`);
  const holder = await holderClient(ctx, a.server);
  const held = await holder.session({ act: 'generate', idleS: 60 });
  const holderJob = await held.submit({ type: 'echo', params: { delay_ms: 40_000 }, inputs: { 'hold.txt': { inline: Buffer.from('hold') } } });
  say(`the holder "p3-live-holder" opened session ${held.id} and runs a 40 s echo job in it (${holderJob})`);
  // The holder lets go once its job is done, as an app would.
  void (async () => {
    for (;;) {
      const status = await held.job(holderJob);
      if (['done', 'failed', 'cancelled', 'interrupted', 'removed'].includes(status.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 1_000));
    }
    await held.close();
    say(`the holder closed its session ${held.id}`);
  })();
  const t0 = Date.now();
  const outcome = await ctx.lanes.runJob({ jobId: 'p3-live-line', fast: false, stage: 'chapters' }, () => echoStep(ctx, 500));
  say(`the job ran by itself after ${Math.round((Date.now() - t0) / 1000)} s in the line: ${outcome.kind} (${outcome.kind === 'done' ? outcome.value : outcome.result.holderLine})`);
  ctx.stop();
  process.exit(0);
}

async function hold(a) {
  const ctx = open(a.state, a.server);
  await ctx.sweepAtStartup();
  const outcome = ctx.lanes.runJob({ jobId: 'p3-live-hold', fast: false, stage: 'chapters' }, async () => {
    await echoStep(ctx, 60_000, (id) => say(`SUBMITTED echo job ${id} (60 s, recorded in the ledger); pid ${process.pid} — kill -9 it now`));
  });
  await outcome;
}

async function sweep(a) {
  const ctx = open(a.state, a.server);
  const report = await ctx.sweepAtStartup();
  for (const row of report.rows) say(`${row.entry.kind} ${row.entry.id} on "${row.entry.server}": ${row.outcome} (${row.detail})`);
  say(`kept for the next start: ${report.kept.length}; timed out: ${report.timedOut}`);
  process.exit(0);
}

async function check(a) {
  const found = readCruciblePairingFile(processPairingFileHost());
  const client = new CrucibleClient({ url: found.pairing.url, token: found.pairing.token, clientName: 'p3-live-check' });
  const activity = await client.activity();
  // This install's own client name (client-factory.ts): another install's ContentStudio is another app.
  const name = clientNameFor(os.hostname());
  const ours = (who) => who === name;
  const session = activity.session !== null && ours(activity.session.client) ? activity.session : null;
  const jobs = [...activity.running, ...activity.queued].filter((job) => ours(job.client));
  say(`server ${activity.server.name} ${activity.server.version}: session ${activity.session === null ? 'none' : `${activity.session.sessionId} (${activity.session.status}) by ${activity.session.client}`}; running ${JSON.stringify(activity.running.map((j) => `${j.client}/${j.type}/${j.jobId}`))}`);
  say(session === null && jobs.length === 0 ? `NO ContentStudio (${name}) session or job on the server` : `ContentStudio STILL HOLDS: ${JSON.stringify({ session, jobs })}`);
  process.exit(session === null && jobs.length === 0 ? 0 : 1);
}

const a = args();
({ line, hold, sweep, check })[a.verb]?.(a).catch((err) => { console.error(err); process.exit(1); })
  ?? (console.error('verbs: line | hold | sweep | check'), process.exit(2));
