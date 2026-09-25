#!/usr/bin/env node
/* eslint-disable no-console */
/**
 * P3's LIVE ACCEPTANCE against a real Crucible (docs/crucible/P3.md), driving the
 * compiled main-process layer the app runs: the composition root, the lanes, the
 * ledger and its sweeps. Law 7: the Mac's Crucible is open to agents (LEDGER #205);
 * the PC needs Owen's go EVERY time, so `--server` must never name it without that.
 *
 * Until transport.ts lands (P2) the app itself submits nothing to Crucible, so the
 * one step each job runs here is an `echo` job (it takes the lane and leaves the
 * card alone: nothing is loaded or evicted) and, for `hold`, a lease on whatever
 * model is already resident (a lease never loads or unloads anything). Both are
 * recorded through `crucibleStepHooks()`, exactly as transport.ts must record its own.
 *
 *   node tools/crucible-p3-live.js park  --state <dir> [--server mac]
 *       A holder (client "p3-live-holder") takes the lane with a 40 s echo job when
 *       the card is free; a ContentStudio job then PARKS on it with the holder's
 *       sentence, and starts BY ITSELF once the preflight says accepts_work.
 *
 *   node tools/crucible-p3-live.js hold  --state <dir> [--server mac]
 *       A ContentStudio job leases the resident model (when no one else holds the
 *       lease) and starts a 60 s echo job, both in the ledger, then waits to be
 *       `kill -9`ed. Relaunch the app on the same userData (or run `sweep`) after.
 *
 *   node tools/crucible-p3-live.js sweep --state <dir>     the startup sweep, alone
 *   node tools/crucible-p3-live.js check [--server mac]    any ContentStudio job or lease on the card?
 *
 * `--state` is a userData directory (a scratch one: never Owen's). An empty one is
 * given the Crucible on this computer, from its pairing file, as `mac`.
 */
const path = require('path');
const fs = require('fs');
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
  const ctx = createCrucibleContext({ stateDir: state, clipboard: () => {}, legacyClaudeKey: () => undefined });
  if (!ctx.servers.names().includes(serverName)) {
    const found = readCruciblePairingFile(processPairingFileHost());
    if (found === null) throw new Error('no Crucible pairing file on this computer');
    ctx.servers.add({ name: serverName, url: found.pairing.url, token: found.pairing.token });
    ctx.servers.select(serverName);
  }
  installLanes(ctx.lanes);
  return ctx;
}

/** The step transport.ts will be, for an echo job: submit, record at once, follow it to the end, settle. */
function echoStep(ctx, delayMs, onSubmitted = () => {}) {
  return ctx.lanes.aiCall(gpuCall('echo'), 'a P3 live echo', async () => {
    const hooks = crucibleStepHooks();
    const client = await ctx.factory.clientFor(hooks.server);
    const id = await client.submit({ type: 'echo', params: { delay_ms: delayMs }, inputs: { 'p3.txt': { inline: Buffer.from('p3') } }, clientRef: `p3-live-${hooks.jobId}` });
    hooks.submitted({ server: hooks.server, id, jobType: 'echo', model: null });
    onSubmitted(id);
    for (;;) {
      const status = await client.job(id);
      hooks.beat();
      if (['done', 'failed', 'cancelled', 'interrupted'].includes(status.status)) {
        hooks.settled(hooks.server, 'job', id);
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

async function park(a) {
  const ctx = open(a.state, a.server);
  await ctx.sweepAtStartup();
  ctx.lanes.start();
  const client = await ctx.factory.clientFor(a.server);
  const version = (await client.info()).server.version;
  say(`server "${a.server}" is Crucible ${version}`);
  let holderJob = null;
  const before = await client.activity();
  if (before.slots.accelerated.acceptsWork) {
    const holder = await holderClient(ctx, a.server);
    holderJob = await holder.submit({ type: 'echo', params: { delay_ms: 40_000 }, inputs: { 'hold.txt': { inline: Buffer.from('hold') } } });
    say(`the holder "p3-live-holder" took the lane with a 40 s echo job (${holderJob})`);
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  } else {
    say(`the card is already held: ${JSON.stringify(before.running.map((job) => `${job.client}/${job.type}`))}`);
  }
  await ctx.lanes.readAll();
  const jobId = 'p3-live-park';
  const t0 = Date.now();
  const first = await ctx.lanes.runJob({ jobId, fast: false, stage: 'chapters' }, () => echoStep(ctx, 500));
  if (first.kind !== 'parked') throw new Error(`expected a park, got ${JSON.stringify(first)}`);
  say(`PARKED on "${first.result.server}" (${first.result.code}), stage ${first.result.stage}: parked — ${first.result.holderLine}`);
  const submitsBefore = 1;
  let submits = submitsBefore;
  // The renderer's 1 s tick: ask the plan; run what it starts. Nothing else resubmits.
  for (;;) {
    const plan = await ctx.lanes.plan([{ jobId, fast: false }]);
    if (plan.start.length > 0) {
      say(`the preflight cleared it after ${Math.round((Date.now() - t0) / 1000)} s; the plan starts it on "${plan.start[0].server}"`);
      submits += 1;
      const again = await ctx.lanes.runJob({ jobId, fast: false, stage: first.result.stage }, () => echoStep(ctx, 500));
      say(`the job ran by itself: ${again.kind} (${again.kind === 'done' ? again.value : again.result.holderLine}); submissions in all: ${submits}`);
      break;
    }
    if (Date.now() - t0 > 10 * 60_000) throw new Error('still parked after 10 minutes');
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }
  ctx.stop();
  if (holderJob !== null) say(`(the holder's job ${holderJob} ended on its own)`);
  process.exit(0);
}

async function hold(a) {
  const ctx = open(a.state, a.server);
  await ctx.sweepAtStartup();
  const outcome = ctx.lanes.runJob({ jobId: 'p3-live-hold', fast: false, stage: 'chapters' }, async () => {
    await ctx.lanes.aiCall(gpuCall('lease'), 'the job lease', async () => {
      const hooks = crucibleStepHooks();
      const client = await ctx.factory.clientFor(hooks.server);
      const activity = await client.activity();
      if (activity.resident === null) { say('nothing is resident: no lease to take'); return; }
      if (activity.lease !== null) { say(`the lease is held by ${activity.lease.client}; not taking one`); return; }
      const lease = await client.lease(activity.resident.id, { act: 'generate', ttlSeconds: 300 });
      hooks.leased({ server: hooks.server, id: lease.leaseId, model: activity.resident.id });
      say(`LEASED ${activity.resident.id} as ${lease.leaseId} (ttl 300 s, recorded in the ledger)`);
    });
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
  const ours = (who) => who === 'contentstudio';
  const lease = activity.lease !== null && ours(activity.lease.client) ? activity.lease : null;
  const jobs = [...activity.running, ...activity.queued].filter((job) => ours(job.client));
  say(`server ${activity.server.name} ${activity.server.version}: lease ${activity.lease === null ? 'none' : `${activity.lease.leaseId} by ${activity.lease.client}`}; running ${JSON.stringify(activity.running.map((j) => `${j.client}/${j.type}/${j.jobId}`))}`);
  say(lease === null && jobs.length === 0 ? 'NO ContentStudio lease or job on the card' : `ContentStudio STILL HOLDS: ${JSON.stringify({ lease, jobs })}`);
  process.exit(lease === null && jobs.length === 0 ? 0 : 1);
}

const a = args();
({ park, hold, sweep, check })[a.verb]?.(a).catch((err) => { console.error(err); process.exit(1); })
  ?? (console.error('verbs: park | hold | sweep | check'), process.exit(2));
