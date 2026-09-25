#!/usr/bin/env node
/**
 * Calibrate the re-roll gate (P9; LEDGER #201; plan §11, §0a) on Owen's own metadata, BEFORE it is
 * wired: the rule checks over the titlecheck corpus, the title ranking over the 177 decided A/B
 * tests, and the report that sets the thresholds.
 *
 *   node tools/reroll-calibrate.js rules  --set chapters|descriptions|titles|thumbnails|pinned
 *                                         [--limit N] [--out <dir>] [--fake] [--server <url>]
 *   node tools/reroll-calibrate.js rank   [--limit N] [--out <dir>] [--fake] [--server <url>]
 *   node tools/reroll-calibrate.js report [--out <dir>]
 *
 * THE SAME CODE THE APP RUNS. Requests are built by the compiled gate (dist/main/services/metadata/
 * reroll/), answers are read under its floor, and every decision goes through the app's own door,
 * `transport.decide` (electron/crucible/transport.ts), on this process's own lanes
 * (cli-lanes.ts) — with a registry of its own in a temp directory holding one server, the local
 * Crucible (its token read from ~/.crucible/pairing), so the app's userData is never read or
 * written.
 *
 * THE CARD IS SHARED. Work goes in BATCHES: each batch takes one lease on the scorer (the 9B),
 * asks its decisions and releases it, so another agent's job waits at most one batch for the card
 * and the card is never held idle. A batch that meets a card leased by someone else waits a minute
 * and tries again (a CLI waiting its turn; logged each time), up to an hour. Ctrl-C cancels,
 * releases and exits 130 (cli-lanes.ts).
 *
 * RESUMABLE. Every answered group is appended to <out>/<set>.jsonl as it finishes, and a rerun
 * skips the groups already there.
 *
 * Needs the compiled main process: `npm run build:electron` first.
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const STUB = path.join(__dirname, '_electron-stub.js');
const resolve0 = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return resolve0.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main');
if (!fs.existsSync(path.join(ROOT, 'services/metadata/reroll/gate.js'))) {
  console.error('dist/main has no re-roll gate: run `npm run build:electron` first');
  process.exit(2);
}
const R = (name) => require(path.join(ROOT, 'services/metadata/reroll', name + '.js'));
const pa = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
pa.initPromptAssets(path.join(__dirname, '..', 'electron', 'assets', 'prompts'));
const rules = R('rules');
const checks = R('checks');
const ranking = R('ranking');
const { linkBlockIndex } = require(path.join(ROOT, 'services/metadata/description-composer.js'));

const FIX = path.join(__dirname, 'fixtures', 'titlecheck');
const SCORER = 'qwen3.5-9b';
/** Groups per lease: ~a few minutes of work, then the card goes back. */
const GROUPS_PER_BATCH = 12;
/** The longest list one state carries: a 55-title podcast is cut into states of at most this many. */
const MAX_UNITS_PER_STATE = 20;

// ------------------------------------------------------------------------- arguments

function parseArgs(argv) {
  const a = { cmd: argv[0], out: path.join(os.tmpdir(), 'reroll-calibration'), server: 'http://127.0.0.1:7100' };
  for (let i = 1; i < argv.length; i++) {
    const k = argv[i];
    const val = () => {
      if (i + 1 >= argv.length) throw new Error(`${k} needs a value`);
      return argv[++i];
    };
    if (k === '--set') a.set = val();
    else if (k === '--limit') a.limit = Number(val());
    else if (k === '--out') a.out = val();
    else if (k === '--fake') a.fake = true;
    else if (k === '--only-labelled') a.onlyLabelled = true;
    else if (k === '--rules') a.rules = val().split(',');
    else if (k === '--server') a.server = val();
    else throw new Error(`unknown flag ${k}`);
  }
  if (!['rules', 'rank', 'report'].includes(a.cmd)) throw new Error('say rules, rank or report');
  if (a.cmd === 'rules' && !['chapters', 'descriptions', 'titles', 'thumbnails', 'pinned'].includes(a.set)) {
    throw new Error('--set is chapters, descriptions, titles, thumbnails or pinned');
  }
  return a;
}

const readJsonl = (file) => fs.readFileSync(file, 'utf8').split('\n').filter((l) => l.trim()).map((l) => JSON.parse(l));

// ------------------------------------------------------------------------- the channel of a row

const CHANNEL_SETS = {
  'Owen Morgan (Telltale)': 'youtube-telltale',
  "Owen's Fireside Chat": 'youtube-fireside',
  'Owen Unfiltered': 'youtube-unfiltered',
};
function factsFor(channelName, promptSet) {
  const id = promptSet || CHANNEL_SETS[channelName] || 'youtube-telltale';
  const ch = pa.promptAssets().channel(id);
  return { id, facts: rules.channelFacts(ch.name, ch.brandTerms) };
}

// ------------------------------------------------------------------------- the groups

/** Every group: one state's worth of units of one field, with a stable key for resuming. */
function groupsFor(set) {
  const groups = [];
  if (set === 'chapters') {
    const byKey = new Map();
    for (const r of readJsonl(path.join(FIX, 'chapters.jsonl'))) {
      // A scrub's output and an operator's edit are their own lists: they never stood beside the text they replaced.
      const kind = r.flagged_by.includes('scrub_output') ? 'scrub_output' : r.flagged_by.includes('owen_edited_to') ? 'owen_edited_to' : 'run';
      const key = `${r.source_file || r.video}|${kind}`;
      if (!byKey.has(key)) byKey.set(key, []);
      byKey.get(key).push(r);
    }
    for (const [key, rows] of byKey) {
      for (let k = 0; k < rows.length; k += MAX_UNITS_PER_STATE) {
        const part = rows.slice(k, k + MAX_UNITS_PER_STATE);
        groups.push({ key: `${key}|${k}`, field: 'chapters', channel: part[0].channel, units: part.map((r) => r.text), rows: part, stateText: (u) => u.join('\n') });
      }
    }
  } else if (set === 'descriptions') {
    readJsonl(path.join(FIX, 'descriptions.jsonl')).forEach((r, i) => {
      const at = linkBlockIndex(r.text);
      const prose = (at === -1 ? r.text : r.text.slice(0, at)).trim();
      const split = rules.splitSentences(prose);
      if (split.sentences.length === 0) return;
      groups.push({ key: `d${i}|${r.field}`, field: 'description', channel: r.channel, units: split.sentences.map((s) => s.trim()), rows: [r], stateText: () => prose, text: r.text });
    });
  } else if (set === 'titles') {
    readJsonl(path.join(FIX, 'titles.jsonl')).forEach((r, i) => {
      groups.push({ key: `t${i}|${r.source_file}`, field: 'titles', channel: r.channel, units: r.candidates, rows: [r], stateText: (u) => u.join('\n') });
    });
  } else {
    // Thumbnail text and pinned comments are not in the corpus: read them from the job records, read-only.
    const dir = '/Volumes/Callisto/ContentStudio/.contentstudio/metadata';
    const key = set === 'thumbnails' ? 'thumbnail_text' : 'pinned_comment';
    for (const f of fs.readdirSync(dir).filter((n) => n.endsWith('.json')).sort()) {
      let job;
      try {
        job = JSON.parse(fs.readFileSync(path.join(dir, f), 'utf8'));
      } catch {
        continue;
      }
      (job.items || []).forEach((it, i) => {
        const list = Array.isArray(it[key]) ? it[key].filter((t) => typeof t === 'string' && t.trim()) : [];
        if (list.length < 2) return;
        groups.push({ key: `${f}|${i}`, field: key, promptSet: it._prompt_set, units: list.map((t) => t.replace(/\s+/g, ' ').trim()), rows: [{ source_file: f, video: it._title }], stateText: (u) => u.join('\n') });
      });
    }
  }
  return groups;
}

/**
 * The order groups are asked in: every group holding a hand-labelled item first (so a --limit run
 * always covers the labels), then the rest in a fixed-seed shuffle (so a --limit run is a random
 * sample, and the same one every time).
 */
function sampleOrder(groups) {
  const labelled = new Set(readJsonl(path.join(FIX, 'labels.jsonl')).map((l) => l.text));
  let seed = 20260925;
  const rand = () => ((seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648);
  const keyed = groups.map((g) => ({ g, first: (g.units.some((u) => labelled.has(u)) || g.rows.some((r) => r.text !== undefined && labelled.has(r.text)) || (g.text !== undefined && labelled.has(g.text))) ? 0 : 1, r: rand() }));
  keyed.sort((a, b) => a.first - b.first || a.r - b.r);
  return keyed.map((k) => k.g);
}

// ------------------------------------------------------------------------- the transport

function readToken() {
  if (process.env.CRUCIBLE_TOKEN) return process.env.CRUCIBLE_TOKEN;
  const text = fs.readFileSync(path.join(os.homedir(), '.crucible', 'pairing'), 'utf8').trim();
  const hash = text.indexOf('#');
  if (hash < 0) throw new Error('~/.crucible/pairing holds no token after a "#"');
  return text.slice(hash + 1).trim();
}

/** A deterministic stand-in: P(yes) from a hash of the question, so the pipeline runs with no server. */
function fakeDecide() {
  const h = (s) => [...s].reduce((a, c) => (a * 31 + c.charCodeAt(0)) >>> 0, 7) / 4294967296;
  return async (request) => {
    const answers = {};
    for (const [name, q] of Object.entries(request.questions)) {
      if (q.type === 'yesno') answers[name] = { type: 'yesno', p: h(q.instructions), labelMass: 0.97, missingLabels: [] };
      else {
        const names = Object.keys(q.options);
        const raw = names.map((n) => h(q.options[n]) + 0.01);
        const z = raw.reduce((a, b) => a + b, 0);
        answers[name] = { type: 'choice', probabilities: Object.fromEntries(names.map((n, k) => [n, raw[k] / z])), labelMass: 0.95, missingLabels: [] };
      }
    }
    return { answers };
  };
}

async function liveLanes(serverUrl, log) {
  const stateDir = fs.mkdtempSync(path.join(os.tmpdir(), 'reroll-calibrate-'));
  const { openCliLanes } = require(path.join(ROOT, 'crucible/cli-lanes.js'));
  const cli = openCliLanes({ stateDir, tool: 'reroll-calibrate', say: (l) => log(`[crucible] ${l}`) });
  cli.context.servers.add({ name: 'mac', url: serverUrl, token: readToken() });
  const { queueAITask, gpuCall } = require(path.join(ROOT, 'services/queue-manager.service.js'));
  const transport = cli.context.transport;
  /** One lease for the batch: `work(decide)` asks every decision of the batch under it, then it is released. */
  const batch = async (what, work) => {
    const started = Date.now();
    for (;;) {
      try {
        return await queueAITask(gpuCall(SCORER), `reroll-cal-${Date.now()}`, what, () =>
          transport.withJobLease('mac', SCORER, (job) =>
            work(async (request, o) => transport.decide({ model: SCORER, state: request.state, questions: request.questions, missing: 'report', job, signal: cli.signal, what: o.what, trace: null })),
          { what, act: 'decide', loadContext: 8192, signal: cli.signal }),
        );
      } catch (err) {
        const code = err && err.code;
        // The card is shared: a busy card, or a model another client swapped out from under a
        // lease we were running under (engine_unreachable, model_not_resident, lease_lost), waits
        // its turn. The batch is re-run from its first unanswered group (runRules skips the rest).
        const WAIT = ['busy', 'leased', 'server_busy', 'engine_in_use', 'unreachable', 'engine_unreachable', 'model_not_resident', 'lease_lost'];
        // Node's fetch gives up on a response whose headers take over 300 s (undici's
        // headersTimeout): on a card other agents are queueing work on, a decide can wait that long.
        const busy = (err && err.name === 'TimeoutError') || WAIT.includes(code) || (err && err.cause && WAIT.includes(err.cause.code)) || (err && WAIT.includes(err.serverCode));
        if (!busy || Date.now() - started > 3_600_000) throw err;
        log(`the card is taken or its model went away (${err.message.slice(0, 160)}); this batch waits a minute and asks again`);
        await new Promise((r) => setTimeout(r, 60_000));
      }
    }
  };
  return { batch, close: () => cli.close(), stateDir };
}

// ------------------------------------------------------------------------- rules

async function runRules(args, log) {
  // --rules a,b: ask only these rules (for iterating on one statement's wording). The compiled
  // table is narrowed in THIS process only; the app's is untouched.
  if (args.rules) for (const f of Object.keys(rules.FIELD_RULES)) rules.FIELD_RULES[f] = rules.FIELD_RULES[f].filter((r) => args.rules.includes(r));
  const outFile = path.join(args.out, `${args.set}.jsonl`);
  fs.mkdirSync(args.out, { recursive: true });
  const done = new Set(fs.existsSync(outFile) ? readJsonl(outFile).map((r) => r.key) : []);
  let groups = sampleOrder(groupsFor(args.set)).filter((g) => !done.has(g.key));
  // --only-labelled: just the groups holding a hand-labelled item, and in a list only the labelled
  // units are asked (the state still shows the whole list, as in production). For iterating on a
  // statement's wording against the labels without paying for the whole corpus.
  const labelled = new Set(readJsonl(path.join(FIX, 'labels.jsonl')).map((l) => l.text));
  if (args.onlyLabelled) {
    groups = groups.filter((g) => g.units.some((u) => labelled.has(u)) || (g.text !== undefined && labelled.has(g.text)));
    for (const g of groups) if (g.field !== 'description') g.which = g.units.map((u, i) => (labelled.has(u) ? i : -1)).filter((i) => i >= 0);
  }
  if (args.limit) groups = groups.slice(0, args.limit);
  log(`${args.set}: ${groups.length} group(s) to ask (${done.size} already in ${outFile})`);
  const lanes = args.fake ? { batch: async (_w, work) => work(fakeDecide()), close: async () => undefined } : await liveLanes(args.server, log);
  const t0 = Date.now();
  let questions = 0;
  try {
    for (let b = 0; b < groups.length; b += GROUPS_PER_BATCH) {
      const slice = groups.slice(b, b + GROUPS_PER_BATCH);
      await lanes.batch(`re-roll calibration: ${args.set} ${b + 1}-${b + slice.length} of ${groups.length}`, async (decide) => {
        for (const g of slice) {
          if (done.has(g.key)) continue;
          const { id, facts } = factsFor(g.channel, g.promptSet);
          const asked = await checks.askRules(g.field, g.stateText(g.units), g.units, facts, decide, { what: `calibration ${g.key}`, ...(g.which ? { which: g.which } : {}) });
          const units = g.units.map((text, i) => ({ text, readings: asked.raw.get(i) })).filter((u) => u.readings);
          questions += asked.calls.reduce((n, c) => n + Object.keys(c.request.questions).length, 0);
          done.add(g.key);
          fs.appendFileSync(outFile, JSON.stringify({ key: g.key, field: g.field, promptSet: id, rows: g.rows.map((r) => ({ ...r, text: undefined })), units, ms: asked.calls.reduce((n, c) => n + c.ms, 0) }) + '\n');
        }
      });
      const s = (Date.now() - t0) / 1000;
      log(`${Math.min(b + GROUPS_PER_BATCH, groups.length)}/${groups.length} groups, ${questions} questions, ${s.toFixed(0)} s (${(s / Math.max(1, questions)).toFixed(3)} s/question)`);
    }
  } finally {
    await lanes.close();
  }
}

// ------------------------------------------------------------------------- rank

async function runRank(args, log) {
  const outFile = path.join(args.out, 'rank.jsonl');
  fs.mkdirSync(args.out, { recursive: true });
  const done = new Set(fs.existsSync(outFile) ? readJsonl(outFile).map((r) => r.video_id) : []);
  let tests = readJsonl(path.join(FIX, 'ab.jsonl')).filter((t) => !done.has(t.video_id));
  if (args.limit) tests = tests.slice(0, args.limit);
  log(`rank: ${tests.length} A/B test(s) to ask`);
  const lanes = args.fake ? { batch: async (_w, work) => work(fakeDecide()), close: async () => undefined } : await liveLanes(args.server, log);
  try {
    for (let b = 0; b < tests.length; b += 25) {
      const slice = tests.slice(b, b + 25);
      await lanes.batch(`re-roll calibration: ranking ${b + 1}-${b + slice.length}`, async (decide) => {
        for (const t of slice) {
          if (done.has(t.video_id)) continue;
          const titles = t.variants.map((v) => v.title);
          // A test whose variants share a title cannot be ranked (the ranker refuses a list with a
          // title twice); it is recorded as skipped, with why, and counted out of the rate.
          if (new Set(titles.map((x) => x.replace(/\s+/g, ' ').trim())).size !== titles.length) {
            done.add(t.video_id);
            fs.appendFileSync(outFile, JSON.stringify({ video_id: t.video_id, channel: t.channel, skipped: 'two variants carry the same title', variants: t.variants }) + '\n');
            log(`rank: ${t.video_id} skipped, two variants carry the same title`);
            continue;
          }
          const { facts } = factsFor(t.channel);
          const r = await ranking.rankTitles(titles, facts.channel, decide, `calibration rank ${t.video_id}`);
          done.add(t.video_id);
          fs.appendFileSync(outFile, JSON.stringify({ video_id: t.video_id, channel: t.channel, winner: t.winner, variants: t.variants, order: r.order, answers: r.answers, skippedRotations: r.skippedRotations }) + '\n');
        }
      });
      log(`${Math.min(b + 25, tests.length)}/${tests.length} tests`);
    }
  } finally {
    await lanes.close();
  }
}

// ------------------------------------------------------------------------- report

function quantiles(xs) {
  if (xs.length === 0) return 'n=0';
  const s = [...xs].sort((a, b) => a - b);
  const q = (f) => s[Math.min(s.length - 1, Math.floor(f * s.length))].toFixed(3);
  return `n=${s.length} p10 ${q(0.1)} p25 ${q(0.25)} p50 ${q(0.5)} p75 ${q(0.75)} p90 ${q(0.9)} p99 ${q(0.99)}`;
}

function histogram(xs) {
  const bins = new Array(10).fill(0);
  for (const x of xs) bins[Math.min(9, Math.floor(x * 10))]++;
  return bins.map((n, i) => `${(i / 10).toFixed(1)}:${n}`).join(' ');
}

function report(args) {
  const lines = [];
  const say = (l = '') => {
    lines.push(l);
    console.log(l);
  };
  const labels = readJsonl(path.join(FIX, 'labels.jsonl'));
  const sets = ['chapters', 'descriptions', 'titles', 'thumbnails', 'pinned'].filter((s) => fs.existsSync(path.join(args.out, `${s}.jsonl`)));
  const byText = new Map();
  for (const set of sets) {
    const recs = readJsonl(path.join(args.out, `${set}.jsonl`));
    say(`\n## ${set}: ${recs.length} groups`);
    const perRule = {};
    let ms = 0;
    let q = 0;
    for (const rec of recs) {
      ms += rec.ms;
      for (const u of rec.units) {
        q += u.readings.length;
        for (const r of u.readings) (perRule[r.rule] = perRule[r.rule] || []).push(r.pYes === null ? NaN : r.pYes);
        if (set === 'chapters') byText.set(`chapters|${u.text}`, { units: [u], rec });
      }
      if (set === 'descriptions') byText.set(`descriptions|${rec.key}`, { units: rec.units, rec });
    }
    say(`questions ${q}, decide time ${(ms / 1000).toFixed(0)} s (${(ms / Math.max(1, q)).toFixed(0)} ms/question)`);
    for (const [rule, xs] of Object.entries(perRule)) {
      const ok = xs.filter((x) => !Number.isNaN(x));
      say(`  ${rule.padEnd(22)} P(yes) ${quantiles(ok)} | no-evidence ${xs.length - ok.length}`);
      say(`  ${''.padEnd(22)} hist ${histogram(ok)}`);
    }
  }
  // Agreement against the hand labels: a unit (chapter) or an item (description: any sentence) fails a rule when P(yes) >= t.
  const descRecs = fs.existsSync(path.join(args.out, 'descriptions.jsonl')) ? readJsonl(path.join(args.out, 'descriptions.jsonl')) : [];
  const findDesc = (label) => descRecs.find((r) => r.rows[0] && r.rows[0].video === label.video && r.field === 'description' && r.key.endsWith(`|${label.field}`) && sameDesc(r, label));
  const descSets = readJsonl(path.join(FIX, 'descriptions.jsonl'));
  const sameDesc = (rec, label) => {
    const i = Number(rec.key.slice(1, rec.key.indexOf('|')));
    return descSets[i] && descSets[i].text === label.text;
  };
  const labelled = labels.map((l) => {
    let units = null;
    if (l.set === 'chapters') {
      const hit = byText.get(`chapters|${l.text}`);
      units = hit ? hit.units : null;
    } else {
      const rec = findDesc(l);
      units = rec ? rec.units : null;
    }
    return { l, units };
  }).filter((x) => x.units);
  say(`\n## agreement with the hand labels (${labelled.length} of ${labels.length} labelled items scored)`);
  const ruleSets = { chapters: ['creator', 'narrates', 'sentence', 'nonsense'], descriptions: ['creator', 'first_person', 'narrates', 'nonsense'] };
  for (const set of ['chapters', 'descriptions']) {
    const xs = labelled.filter((x) => x.l.set === set);
    for (const rule of ruleSets[set]) {
      const rows = xs.map((x) => ({ truth: x.l.violates.includes(rule), p: Math.max(...x.units.map((u) => (u.readings.find((r) => r.rule === rule) || {}).pYes ?? 0)) }));
      const pos = rows.filter((r) => r.truth).map((r) => r.p);
      const neg = rows.filter((r) => !r.truth).map((r) => r.p);
      let best = null;
      for (const t of [0.1, 0.2, 0.3, 0.4, 0.5, 0.6, 0.7, 0.8, 0.9]) {
        const tp = pos.filter((p) => p >= t).length;
        const tn = neg.filter((p) => p < t).length;
        const acc = (tp + tn) / rows.length;
        const line = `t=${t.toFixed(1)} agree ${(acc * 100).toFixed(0)}% (caught ${tp}/${pos.length}, false alarms ${neg.length - tn}/${neg.length})`;
        if (!best || acc > best.acc) best = { acc, t, line };
        if (t === 0.5) say(`  ${set} ${rule.padEnd(14)} ${line}`);
      }
      say(`  ${''.padEnd(set.length)} ${''.padEnd(14)} best ${best.line}`);
      say(`  ${''.padEnd(set.length)} ${''.padEnd(14)} P(yes) on violators: ${pos.map((p) => p.toFixed(2)).join(' ') || '-'} | on clean: ${quantiles(neg)}`);
    }
    // The gate's own verdict: an item fails when ANY rule's P(yes) >= 0.5.
    const agree = xs.filter((x) => {
      const truth = x.l.violates.some((r) => ruleSets[set].includes(r));
      const pred = x.units.some((u) => u.readings.some((r) => ruleSets[set].includes(r.rule) && (r.pYes ?? 0) >= 0.5));
      return truth === pred;
    }).length;
    say(`  ${set} pass/fail at 0.5 on every rule: ${agree}/${xs.length} agree`);
  }
  // Ranking.
  const rankFile = path.join(args.out, 'rank.jsonl');
  if (fs.existsSync(rankFile)) {
    const all = readJsonl(rankFile);
    const recs = all.filter((r) => !r.skipped);
    if (all.length > recs.length) say(`  (${all.length - recs.length} test(s) skipped: ${all.filter((r) => r.skipped).map((r) => `${r.video_id} ${r.skipped}`).join('; ')})`);
    let pairs = 0;
    let won = 0;
    let top1 = 0;
    let chanceTop1 = 0;
    const margins = [];
    for (const r of recs) {
      const score = new Map(r.order.map((o) => [o.title, o.relative]));
      const w = score.get(r.winner);
      if (w === undefined) continue;
      for (const v of r.variants) {
        if (v.title === r.winner) continue;
        pairs++;
        const l = score.get(v.title);
        if (w > l) won++;
        margins.push(w - l);
      }
      if (r.order[0].title === r.winner) top1++;
      chanceTop1 += 1 / r.variants.length;
    }
    const rate = won / pairs;
    const z = (won - pairs / 2) / Math.sqrt(pairs / 4);
    say(`\n## title ranking over ${recs.length} decided A/B tests`);
    say(`  winner ranked above a loser in ${won}/${pairs} pairs = ${(rate * 100).toFixed(1)}% (chance 50%; z = ${z.toFixed(2)})`);
    say(`  winner ranked first in ${top1}/${recs.length} = ${((top1 / recs.length) * 100).toFixed(1)}% (chance ${((chanceTop1 / recs.length) * 100).toFixed(1)}%)`);
    say(`  margin (winner relative - loser relative): mean ${(margins.reduce((a, b) => a + b, 0) / margins.length).toFixed(3)}, ${quantiles(margins)}`);
  }
  fs.writeFileSync(path.join(args.out, 'report.txt'), lines.join('\n') + '\n');
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
  if (args.cmd === 'rules') await runRules(args, log);
  else if (args.cmd === 'rank') await runRank(args, log);
  else report(args);
}

main().then(() => process.exit(0), (e) => {
  console.error(`reroll-calibrate: ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
