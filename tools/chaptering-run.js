#!/usr/bin/env node
/**
 * Run the snap chaptering service (electron/services/metadata/chaptering/, LEDGER #199) over one
 * ContentStudio transcript file, outside the app.
 *
 *   node tools/chaptering-run.js <transcript.json> --granularity <chapters|stories>
 *        [--fake | --live] [--server http://127.0.0.1:7100] [--token <t>]
 *        [--outline-model qwen3.5-9b] [--title-model qwen3.8-27b-4bit]
 *        [--channel youtube-unfiltered] [--video-title "..."] [--no-summarize] [--no-ads]
 *        [--title-thinking on|off] [--title-max-tokens N] [--switch-cost N] [--out result.json]
 *
 * TWO TRANSPORTS, the service's own seam (types.ts ChatFn / DecideFn):
 *
 *   --fake  deterministic, no server: the outline answers a fixed number of labels per chunk and
 *           each sentence is assigned by its position in the chunk. It exercises the whole
 *           pipeline (units, chunking, stitching, Viterbi, titles) on a real transcript's shape.
 *
 *   --live  a Crucible server over raw HTTP (no SDK yet: P8b wires the app's transport). Chat is
 *           `POST /v1/openai/chat/completions` with `X-Crucible-Act: generate`; a decision is
 *           `POST /v1/decide` with `X-Crucible-Act: decide` and `missing: "report"` (PHASE22 §2.2).
 *           The card holds ONE model, so the harness makes the role's model resident with a
 *           `load-model` job carrying a lease, heartbeats it, and on the next role releases it
 *           and unloads what IT loaded before loading the next (the service asks every outline
 *           and decision before the first title, so a run swaps once). A model someone else
 *           had resident is leased, never unloaded. Ctrl-C releases and unloads, then exits 130.
 *
 * NO SUBSTITUTION (Law 1): the outline and title models must be ids the server's /v1/models
 * lists, the `decide` and `generate` classes must be enabled in /v1/capability, and the server
 * must be 1.0.24 or newer (the decision door). Each is refused by name before any load.
 *
 * Needs the compiled main process: `npm run build:electron` first.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const https = require('https');
const Module = require('module');

const STUB = path.join(__dirname, '_electron-stub.js');
const resolve0 = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return resolve0.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main');
if (!fs.existsSync(path.join(ROOT, 'services/metadata/chaptering/chaptering.service.js'))) {
  console.error('dist/main has no chaptering service: run `npm run build:electron` first');
  process.exit(2);
}
const C = (name) => require(path.join(ROOT, 'services/metadata/chaptering', name + '.js'));
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
promptAssetsModule.initPromptAssets(path.join(__dirname, '..', 'electron', 'assets', 'prompts'));
const service = C('chaptering.service');
const units_ = C('units');
const prompts = C('prompts');

// ------------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const a = { outlineModel: 'qwen3.5-9b', titleModel: 'qwen3.8-27b-4bit', server: 'http://127.0.0.1:7100', summarize: true, ads: true };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === '--granularity') a.granularity = val();
    else if (k === '--fake') a.mode = 'fake';
    else if (k === '--live') a.mode = 'live';
    else if (k === '--server') a.server = val();
    else if (k === '--token') a.token = val();
    else if (k === '--outline-model') a.outlineModel = val();
    else if (k === '--title-model') a.titleModel = val();
    else if (k === '--channel') a.channel = val();
    else if (k === '--video-title') a.videoTitle = val();
    else if (k === '--no-summarize') a.summarize = false;
    else if (k === '--no-ads') a.ads = false;
    else if (k === '--title-thinking') {
      const v = val();
      if (v !== 'on' && v !== 'off') throw new Error('--title-thinking takes on or off');
      a.titleThinking = v === 'on';
    }
    else if (k === '--switch-cost') a.switchCost = Number(val());
    else if (k === '--title-max-tokens') a.titleMaxTokens = Number(val());
    else if (k === '--out') a.out = val();
    else if (k.startsWith('--')) throw new Error(`unknown flag ${k}`);
    else rest.push(k);
  }
  if (rest.length !== 1) throw new Error('give exactly one transcript file');
  a.transcript = rest[0];
  if (!a.granularity) throw new Error('--granularity is required (chapters or stories, LEDGER #208)');
  if (!a.mode) throw new Error('say --fake or --live');
  // The fake answers outline + assign only; the stories grain's junctions have their fake in
  // tools/chaptering-checks.js (fakeStream) and their live run in tools/snap-live.js.
  if (a.mode === 'fake' && a.granularity === 'stories') throw new Error('--fake answers the chapters grain only (LEDGER #212); stories: tools/snap-live.js');
  return a;
}

// ------------------------------------------------------------------------- the fake

/** The fake's privilege (never the model's): it knows each sentence's place in the unit list. */
function fakeTransport(units, granularity) {
  const perChunk = { chapters: 6, stories: 3 }[granularity];
  const byText = new Map();
  units.forEach((u, i) => {
    byText.set(prompts.clip(u.text, 300), i);
    if (!byText.has(u.text)) byText.set(u.text, i);
  });
  const quoted = /Sentence from the transcript above: "([\s\S]*?)"\n\(The sentence just before it/;
  const chat = async (prompt, o) => {
    if (o.role === 'summarize') {
      const m = /Title chapter ([^\n]*?) of a video/.exec(prompt);
      return { text: `Fake title for chapter ${m ? m[1] : '?'}\nA fake summary of that chapter.`, finishReason: 'stop' };
    }
    return { text: Array.from({ length: perChunk }, (_, k) => `Fake section ${k + 1}`).join('\n'), finishReason: 'stop' };
  };
  const decide = async (req) => {
    const lines = req.state.split('\n');
    const first = byText.get(lines[0]);
    const answers = {};
    for (const [name, q] of Object.entries(req.questions)) {
      if (q.type === 'yesno') {
        answers[name] = { type: 'yesno', p: 0.2, labelMass: 0.95, missingLabels: [] };
        continue;
      }
      const m = quoted.exec(q.instructions);
      const i = m ? byText.get(m[1]) : undefined;
      if (i === undefined || first === undefined) throw new Error('fake decide: a quoted sentence is not one of the units');
      const names = Object.keys(q.options).filter((n) => !q.options[n].startsWith('An ad, sponsor read'));
      const at = Math.min(names.length - 1, Math.floor(((i - first) / lines.length) * names.length));
      const probabilities = {};
      for (const n of Object.keys(q.options)) probabilities[n] = n === names[at] ? 0.9 : 0.1 / (Object.keys(q.options).length - 1);
      answers[name] = { type: 'choice', probabilities, labelMass: 0.97, missingLabels: [] };
    }
    return { answers };
  };
  return { chat, decide, close: async () => undefined, calls: () => ({}) };
}

// ------------------------------------------------------------------------- the live server

function readToken(explicit) {
  if (explicit) return explicit;
  if (process.env.CRUCIBLE_TOKEN) return process.env.CRUCIBLE_TOKEN;
  const file = path.join(os.homedir(), '.crucible', 'pairing');
  const text = fs.readFileSync(file, 'utf8').trim();
  const hash = text.indexOf('#');
  if (hash < 0) throw new Error(`${file} holds no token after a '#'`);
  return text.slice(hash + 1).trim();
}

class TransportFailure extends Error {
  constructor(status, code, message, server, details) {
    super(`${code}: ${message}`);
    this.status = status;
    this.code = code;
    this.server = server;
    this.details = details;
  }
}

/**
 * One HTTP exchange with no client-side timeout: a thinking-on title on the 27B can take
 * minutes, and fetch's 300 s header timeout would cut it off mid-answer.
 */
function request(base, token, method, route, body, headers = {}, signal) {
  const url = new URL(route, base);
  const lib = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? undefined : Buffer.from(JSON.stringify(body));
  return new Promise((resolve, reject) => {
    const req = lib.request(
      url,
      {
        method,
        headers: {
          Authorization: `Bearer ${token}`,
          'X-Crucible-Api': '1',
          'X-Crucible-Client': 'contentstudio-chaptering-run',
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
          ...headers,
        },
        signal,
      },
      (res) => {
        const chunks = [];
        res.on('data', (d) => chunks.push(d));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try {
            json = text ? JSON.parse(text) : null;
          } catch {
            /* read below */
          }
          if (res.statusCode >= 200 && res.statusCode < 300) {
            resolve({ status: res.statusCode, json, headers: res.headers });
            return;
          }
          const err = json && json.error && typeof json.error.code === 'string' ? json.error : null;
          if (!err) {
            reject(new TransportFailure(res.statusCode, 'not_a_crucible_error', `HTTP ${res.statusCode} from ${url.pathname}: ${text.slice(0, 300)}`, base));
            return;
          }
          reject(new TransportFailure(res.statusCode, err.code, err.message, base, err.details ?? null));
        });
      },
    );
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const LEASE_TTL = 120;
const HEARTBEAT_MS = 40_000;
/**
 * The 9B at 16,384 (LEDGER #196). The 27B title model at 24,576: a 6,000-token chapter window +
 * the ~1,000-token body + the 16,384 thinking budget (LEDGER #208, summarize.ts), as the app loads it.
 */
const LOAD_CONTEXT = 16384;
const TITLE_LOAD_CONTEXT = 24576;
const DECIDE_MIN_VERSION = [1, 0, 24];

function versionAtLeast(v, min) {
  const parts = String(v).split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if ((parts[i] || 0) !== min[i]) return (parts[i] || 0) > min[i];
  }
  return true;
}

async function liveTransport(args, log) {
  const base = args.server;
  const token = readToken(args.token);
  const call = (method, route, body, headers, signal) => request(base, token, method, route, body, headers, signal);

  const info = (await call('GET', '/v1/info')).json;
  const serverName = `${info.server.name} ${info.server.version} at ${base}`;
  if (!versionAtLeast(info.server.version, DECIDE_MIN_VERSION)) {
    throw new Error(`Crucible "${serverName}" has no decision door (it needs 1.0.24 or newer); chaptering on snap cannot run there`);
  }
  const models = (await call('GET', '/v1/models')).json;
  const ids = models.map((m) => m.id);
  for (const [role, id] of [['outline and decide', args.outlineModel], ['title', args.titleModel]]) {
    if (!args.summarize && role === 'title') continue;
    const row = models.find((m) => m.id === id);
    if (!row) throw new Error(`Crucible "${serverName}" offers no model "${id}" for the ${role} role; it offers ${ids.join(', ')}. Nothing is substituted.`);
    if (row.installed === false) throw new Error(`"${id}" (the ${role} model) is not downloaded on Crucible "${serverName}"`);
  }
  const capability = (await call('GET', '/v1/capability')).json;
  for (const cls of ['decide', 'generate']) {
    const row = capability.classes.find((c) => c.capability === cls);
    if (!row || !row.enabled) throw new Error(`Crucible "${serverName}" does not serve the "${cls}" class: ${row ? row.reason : 'no such row'}`);
  }
  log(`server ${serverName}; outline+decide on ${args.outlineModel}, titles on ${args.titleModel}`);

  // --- residency: one model on the card, leased while we use it -----------------------
  const held = { model: null, leaseId: null, loadedByUs: false, beat: null };
  const loadsByUs = [];
  const unloadsByUs = [];

  async function followJob(jobId) {
    for (;;) {
      const s = (await call('GET', `/v1/jobs/${encodeURIComponent(jobId)}`)).json;
      if (s.status === 'done') return s;
      if (s.status === 'failed' || s.status === 'cancelled' || s.status === 'interrupted') {
        throw new Error(`job ${jobId} (${s.type} ${s.model || ''}) ended ${s.status}: ${s.error ? `${s.error.code}: ${s.error.message}` : 'no error stated'}`);
      }
      await sleep(1000);
    }
  }

  async function release() {
    if (held.beat) clearInterval(held.beat);
    held.beat = null;
    if (held.leaseId) {
      const id = held.leaseId;
      held.leaseId = null;
      try {
        await call('DELETE', `/v1/leases/${encodeURIComponent(id)}`);
        log(`released lease ${id} on ${held.model}`);
      } catch (e) {
        log(`releasing lease ${id} failed: ${e.message}`);
      }
    }
    if (held.model && held.loadedByUs) {
      const acts = (await call('GET', '/v1/activity')).json;
      const residentId = acts.resident && (acts.resident.id || acts.resident.model);
      if (residentId === held.model && !acts.lease) {
        const job = (await call('POST', '/v1/jobs', { type: 'unload-model', model: held.model, params: {}, inputs: {} })).json.job_id;
        await followJob(job);
        unloadsByUs.push(held.model);
        log(`unloaded ${held.model} (this run loaded it)`);
      } else if (!residentId) {
        log(`${held.model} left the card when its lease was released (Crucible's unload ruling); nothing to unload`);
      }
    }
    held.model = null;
    held.loadedByUs = false;
  }

  function startHeartbeat() {
    held.beat = setInterval(() => {
      if (!held.leaseId) return;
      call('POST', `/v1/leases/${encodeURIComponent(held.leaseId)}/heartbeat`).catch((e) => log(`heartbeat failed: ${e.message}`));
    }, HEARTBEAT_MS);
    held.beat.unref();
  }

  async function ensure(model, act) {
    if (held.model === model) return;
    await release();
    const acts = (await call('GET', '/v1/activity')).json;
    if (acts.lease) throw new Error(`Crucible "${serverName}" is leased by ${acts.lease.client || 'another client'} (${acts.lease.subject || '?'}); this run waits for no one and stops here`);
    if (acts.resident && acts.resident.id === model) {
      const lease = (await call('POST', `/v1/models/${encodeURIComponent(model)}/lease`, { act, ttl_seconds: LEASE_TTL })).json;
      Object.assign(held, { model, leaseId: lease.lease_id, loadedByUs: false });
      log(`leased resident ${model} (${lease.lease_id})`);
    } else {
      const t = Date.now();
      const job = (await call('POST', '/v1/jobs', {
        type: 'load-model',
        model,
        params: { lease: { act, ttl_seconds: LEASE_TTL }, context: model === args.titleModel ? TITLE_LOAD_CONTEXT : LOAD_CONTEXT },
        inputs: {},
      })).json.job_id;
      const s = await followJob(job);
      if (!s.lease_id) throw new Error(`loading ${model} finished without the lease it asked for`);
      Object.assign(held, { model, leaseId: s.lease_id, loadedByUs: true });
      loadsByUs.push(model);
      log(`loaded ${model} at ${model === args.titleModel ? TITLE_LOAD_CONTEXT : LOAD_CONTEXT} tokens in ${((Date.now() - t) / 1000).toFixed(1)} s (lease ${s.lease_id})`);
    }
    startHeartbeat();
  }

  // --- the two calls ---------------------------------------------------------------
  const counts = { chat: 0, decide: 0, queueFullWaits: 0, chatMs: 0, decideMs: 0, titles: [] };

  /** A full chat/decision door says how long to wait: that wait is the door's design, bounded. */
  async function withQueueWait(fn) {
    for (let attempt = 1; ; attempt++) {
      try {
        return await fn();
      } catch (e) {
        if (e.code === 'chat_queue_full' && attempt <= 20) {
          counts.queueFullWaits++;
          const secs = e.details && typeof e.details.retry_after === 'number' ? e.details.retry_after : 2;
          await sleep(Math.min(60_000, Math.max(250, secs * 1000)));
          continue;
        }
        throw e;
      }
    }
  }

  const modelFor = (role) => (role === 'summarize' ? args.titleModel : args.outlineModel);

  const chat = async (prompt, o) => {
    const model = modelFor(o.role);
    await ensure(model, 'generate');
    const body = {
      model,
      messages: [{ role: 'user', content: prompt }],
      max_tokens: o.maxTokens,
      chat_template_kwargs: { enable_thinking: o.thinking },
      stream: false,
    };
    if (o.temperature !== undefined) body.temperature = o.temperature;
    const t = Date.now();
    const res = await withQueueWait(() => call('POST', '/v1/openai/chat/completions', body, { 'X-Crucible-Act': 'generate' }, o.signal));
    counts.chat++;
    counts.chatMs += Date.now() - t;
    const choice = res.json && res.json.choices && res.json.choices[0];
    if (!choice || !choice.message) throw new Error(`${o.what}: the chat answer has no choices[0].message`);
    // §0a: a missing finish_reason is refused, never read as "stop".
    if (typeof choice.finish_reason !== 'string') throw new Error(`${o.what}: the chat answer states no finish_reason`);
    // A thinking-on reply can carry its <think> block in the content (vLLM without a reasoning
    // parser, the PC): stripped, an unclosed one included (plain-call.ts stripThinking).
    const raw = typeof choice.message.content === 'string' ? choice.message.content : '';
    const text = raw.replace(/<think>[\s\S]*?<\/think>/g, '').replace(/<think>[\s\S]*$/, '').trim();
    const tokens = res.json.usage ? res.json.usage.completion_tokens : null;
    if (o.role === 'summarize') counts.titles.push({ what: o.what, ms: Date.now() - t, completionTokens: tokens, finish: choice.finish_reason, thinking: o.thinking, sampling: res.headers['x-crucible-sampling'] || null });
    log(`chat ${o.what}: ${((Date.now() - t) / 1000).toFixed(1)} s, finish ${choice.finish_reason}, ${tokens} tokens, ${text.length} chars` +
      (res.headers['x-crucible-sampling'] ? `, sampling ${res.headers['x-crucible-sampling']}` : ''));
    return { text, finishReason: choice.finish_reason };
  };

  const decide = async (req, o) => {
    await ensure(args.outlineModel, 'decide');
    const body = { model: args.outlineModel, state: req.state, questions: req.questions, missing: req.missing };
    const t = Date.now();
    const res = await withQueueWait(() => call('POST', '/v1/decide', body, { 'X-Crucible-Act': 'decide' }, o.signal));
    counts.decide++;
    counts.decideMs += Date.now() - t;
    const answers = {};
    for (const [name, a] of Object.entries(res.json.answers || {})) {
      answers[name] =
        a.type === 'yesno'
          ? { type: 'yesno', p: a.p, labelMass: a.label_mass, missingLabels: a.missing_labels }
          : { type: a.type, probabilities: a.probabilities, labelMass: a.label_mass, missingLabels: a.missing_labels };
    }
    const n = Object.keys(req.questions).length;
    log(`decide ${o.what}: ${n} question(s) in ${((Date.now() - t) / 1000).toFixed(1)} s`);
    return { answers };
  };

  /** prompt_tokens of a one-token chat holding the text, less the template's own (Briefcase's rule). */
  let templateTokens = null;
  const promptTokens = async (content) => {
    await ensure(args.outlineModel, 'generate');
    const res = await withQueueWait(() =>
      call('POST', '/v1/openai/chat/completions', {
        model: args.outlineModel,
        messages: [{ role: 'user', content }],
        max_tokens: 1,
        temperature: 0,
        chat_template_kwargs: { enable_thinking: false },
        stream: false,
      }, { 'X-Crucible-Act': 'generate' }),
    );
    const n = res.json && res.json.usage && res.json.usage.prompt_tokens;
    if (typeof n !== 'number') throw new Error('the chat answer states no usage.prompt_tokens to count tokens from');
    return n;
  };
  const countTokens = async (text) => {
    if (templateTokens === null) templateTokens = await promptTokens('');
    return Math.max(0, (await promptTokens(text)) - templateTokens);
  };

  const close = async () => {
    await release();
  };
  return { chat, decide, countTokens, close, calls: () => ({ ...counts, loadsByUs, unloadsByUs }), serverName };
}

// ------------------------------------------------------------------------- run

function clock(s) {
  return service.formatClock(s);
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
  const transcript = JSON.parse(fs.readFileSync(args.transcript, 'utf8'));
  const units = units_.sentenceUnits(units_.captionsOf(transcript));
  let channel = null;
  if (args.channel) channel = promptAssetsModule.promptAssets().channel(args.channel);
  const videoTitle = args.videoTitle || path.basename(args.transcript).replace(/(_transcript)?(\.transcript)?\.json$/, '');

  const transport = args.mode === 'fake' ? fakeTransport(units, args.granularity) : await liveTransport(args, log);
  let stopping = false;
  const ac = new AbortController();
  const onSignal = (sig, code) => async () => {
    if (stopping) return;
    stopping = true;
    log(`${sig}: cancelling, releasing the lease and unloading what this run loaded`);
    ac.abort();
    try {
      await transport.close();
    } finally {
      process.exit(code);
    }
  };
  process.on('SIGINT', onSignal('SIGINT', 130));
  process.on('SIGTERM', onSignal('SIGTERM', 143));

  log(`${units.length} sentence units from ${args.transcript}; granularity ${args.granularity}`);
  const t0 = Date.now();
  let lastPct = -1;
  let result;
  try {
    result = await service.chapterUnits(units, {
      granularity: args.granularity,
      speakerRoles: units_.speakerRolesOf(transcript),
      chat: transport.chat,
      decide: transport.decide,
      ...(transport.countTokens ? { countTokens: transport.countTokens } : {}),
      promotedItems: channel ? channel.promotedItems : undefined,
      channelName: channel ? channel.name : undefined,
      videoTitle,
      summarize: args.summarize,
      detectAds: args.ads,
      ...(args.titleThinking !== undefined ? { titleThinking: args.titleThinking } : {}),
      ...(args.switchCost !== undefined ? { switchCost: args.switchCost } : {}),
      ...(args.titleMaxTokens !== undefined ? { titleMaxTokens: args.titleMaxTokens } : {}),
      signal: ac.signal,
      diagnostics: Boolean(args.out),
      onProgress: (p) => {
        const pct = Math.floor(p.fraction * 100);
        if (pct !== lastPct && pct % 5 === 0) {
          lastPct = pct;
          log(`progress ${pct}% (${p.phase} ${p.done}/${p.total})`);
        }
      },
    });
  } finally {
    await transport.close();
  }
  const wallS = (Date.now() - t0) / 1000;

  const s = result.stats;
  console.log(`\n${args.transcript}`);
  console.log(
    `granularity ${result.granularity} (switch cost ${result.switchCost}) | ${s.unitCount} sentences | ${result.chapters.length} chapters | ` +
      `${s.chunkCount} chunk(s), ${s.refinedSections} refined | wall ${wallS.toFixed(1)} s ` +
      `(outline ${(s.outlineMs / 1000).toFixed(1)}, assign ${(s.assignMs / 1000).toFixed(1)}, ads ${(s.plugMs / 1000).toFixed(1)}, titles ${(s.summarizeMs / 1000).toFixed(1)})`,
  );
  console.log(`calls: ${s.chatCalls} chat, ${s.decideCalls} decide | floored ${s.flooredUnits.length}, skipped ${s.skippedUnits.length}`);
  console.log(`speaker-tagged titles: ${s.speakerTagged} | ad baseline: ${s.adBaseline === null ? 'none' : s.adBaseline.toFixed(3)} | title ms: ${s.titleMs.join(', ')}`);
  if (s.stories) console.log(`stories: ${s.stories.stretches} stretches, ${s.stories.selected.length} cuts placed, ${s.stories.merges.length} merges`);
  for (const c of result.chapters) {
    const tag = c.isAd ? ' [ad]' : c.level === 2 ? ' [2]' : '';
    console.log(`${clock(c.startSec).padStart(8)}  ${c.title || '(untitled)'}${tag}   <- ${c.label}`);
  }
  if (s.warnings.length) console.log(`\nwarnings:\n  ${s.warnings.join('\n  ')}`);
  if (result.plugVerdicts.length) {
    console.log(`\nad verdicts: ${result.plugVerdicts.map((v) => `${clock(result.units[v.start].start)} ${v.start}-${v.end} ${v.source} p=${v.p.toFixed(2)}/${v.threshold} ${v.read}`).join('; ')}`);
  }
  if (args.out) {
    const { units: _u, ...rest } = result;
    fs.writeFileSync(args.out, JSON.stringify({ transcript: args.transcript, mode: args.mode, wallS, calls: transport.calls(), ...rest }, null, 1));
    console.log(`\nwrote ${args.out}`);
  }
}

main().catch((e) => {
  console.error(`chaptering-run: ${e && e.message ? e.message : e}`);
  process.exit(1);
});
