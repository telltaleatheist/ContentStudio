#!/usr/bin/env node
/**
 * P8b's live acceptance for the two stream paths, through the app's own code (not raw HTTP):
 *
 *   node tools/snap-live.js split   <word-level transcript.json> [--edits <edits.json>] [--out r.json]
 *   node tools/snap-live.js stories <word-level transcript.json> [--edits <edits.json>] [--out r.json]
 *                                   [--chapters <option id>] [--title-thinking on|off]
 *
 *   split    the in-queue split: transcript-import words -> wordsToSegments (what
 *            `analyze-transcript-split` reads) -> splitCandidates on the snap wiring.
 *   stories  the editor: the REAL story-ipc handlers registered against a recording ipcMain,
 *            `story:analyze-chapters` called with the segments the editor's segmentsForRegions
 *            builds (per track, sentence/gap/20-word breaks, host = mic, clip = screen), at the
 *            'stories' grain; its progress events are printed.
 *
 * Both run over the app's registry and routing, read-only, with this tool's own lanes and in-flight
 * ledger (electron/crucible/cli-lanes.ts, as scripts/generate-metadata-cli.js does); the chapters
 * row is the stored one unless --chapters names another option for this run. SIGINT/SIGTERM give
 * the leases back. `--edits` scores the result against Owen's own story edges and cut.
 *
 * Needs the compiled main process: `npm run build:electron` first.
 */
'use strict';
const fs = require('fs');
const path = require('path');
const Module = require('module');

const REPO_ROOT = path.join(__dirname, '..');
const DIST = path.join(REPO_ROOT, 'dist', 'main');
const SHIM = path.join(REPO_ROOT, 'scripts', '_electron-shim-real-userdata.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-log') return require.resolve(SHIM);
  return originalResolve.call(this, request, ...rest);
};
const shim = require(SHIM);
process.env.CONTENTSTUDIO_PROJECT_ROOT = REPO_ROOT;
const load = (rel) => require(path.join(DIST, rel));

function parseArgs(argv) {
  const a = { mode: argv[0], file: argv[1] };
  for (let i = 2; i < argv.length; i++) {
    const k = argv[i];
    if (k === '--edits') a.edits = argv[++i];
    else if (k === '--out') a.out = argv[++i];
    else if (k === '--chapters') a.chapters = argv[++i];
    else if (k === '--title-thinking') a.titleThinking = argv[++i];
    else if (k === '--decide-cache') a.decideCache = argv[++i];
    else throw new Error(`unknown flag ${k}`);
  }
  if (!['split', 'stories'].includes(a.mode) || !a.file) throw new Error('usage: snap-live.js split|stories <transcript.json> [...]');
  return a;
}

/** The editor's segmentsForRegions over the whole timeline (editor.component.ts, SEG_* constants). */
function editorSegments(transcript) {
  const labels = new Map((transcript.tracks || []).map((t) => [t.id, String(t.label || '').toLowerCase()]));
  const side = (id) => {
    const l = labels.get(id) || '';
    if (l.includes('mic')) return 'host';
    if (l.includes('screen')) return 'clip';
    throw new Error(`track ${id} is neither mic nor screen`);
  };
  const byTrack = new Map();
  for (const w of transcript.words) {
    if (!byTrack.has(w.track)) byTrack.set(w.track, []);
    byTrack.get(w.track).push(w);
  }
  const out = [];
  for (const [id, arr] of byTrack) {
    arr.sort((x, y) => x.timelineStart - y.timelineStart);
    let buf = [];
    const flush = () => {
      if (!buf.length) return;
      const text = buf.map((w) => w.text).join(' ').replace(/\s+/g, ' ').trim();
      if (text) out.push({ text, startSeconds: buf[0].timelineStart, endSeconds: buf[buf.length - 1].timelineEnd, speaker: side(id) });
      buf = [];
    };
    for (const w of arr) {
      const prev = buf[buf.length - 1];
      if (prev && (w.timelineStart - prev.timelineEnd > 2 || w.group !== prev.group)) flush();
      buf.push(w);
      if ((/[.!?]["')\]]?$/.test(w.text.trim()) && buf.length >= 4) || buf.length >= 20) flush();
    }
    flush();
  }
  return out.sort((x, y) => x.startSeconds - y.startSeconds);
}

/** Owen's edges from an editor edits file: story starts/ends and the cut's two ends, in timeline seconds. */
function owenEdges(edits, frameSeconds) {
  const edges = [];
  for (const s of edits.stories) for (const r of s.regions) edges.push({ at: r.start, what: `${s.title} start` }, { at: r.end, what: `${s.title} end` });
  for (const c of edits.cuts || []) edges.push({ at: c.startFrame * frameSeconds, what: 'cut start' }, { at: c.endFrame * frameSeconds, what: 'cut end' });
  // A seam two stories share within 15 s is one edge; the stream's first start and last end are not seams.
  edges.sort((x, y) => x.at - y.at);
  const merged = [];
  for (const e of edges) {
    const last = merged[merged.length - 1];
    if (last && e.at - last.at[last.at.length - 1] < 15) { last.at.push(e.at); last.what += ` / ${e.what}`; } else merged.push({ at: [e.at], what: e.what });
  }
  return merged.slice(0, -1);
}

function clock(s) {
  s = Math.max(0, Math.floor(s));
  const h = Math.floor(s / 3600), m = Math.floor((s % 3600) / 60), sec = s % 60;
  return h ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${m}:${String(sec).padStart(2, '0')}`;
}

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const log = (m) => process.stderr.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);
  load('services/metadata/prompt-assets.js').initPromptAssets(path.join(REPO_ROOT, 'electron', 'assets', 'prompts'));
  const { openCliLanes } = load('crucible/cli-lanes.js');
  const cli = openCliLanes({ stateDir: shim.USER_DATA, tool: 'snap-live' });
  const routing = load('services/metadata/metadata-routing.js');
  const settings = JSON.parse(fs.readFileSync(path.join(shim.USER_DATA, 'config.json'), 'utf8'));
  const stored = routing.migrateStoredRouting(settings.metadataRouting).selections;
  const selections = args.chapters ? { ...stored, chapters: args.chapters } : stored;
  const transcript = JSON.parse(fs.readFileSync(args.file, 'utf8'));
  const t0 = Date.now();
  let starts;
  let rows;
  let stories = null;
  try {
    if (args.mode === 'split') {
      const models = routing.resolveSnapChapterModels(routing.resolveMetadataRouting(selections), cli.lanes.gpuVenue());
      log(`split: outline and decide on ${models.scorer.model} on "${models.scorer.server}" (no title calls)`);
      const importer = load('services/metadata/transcript-import.service.js');
      const words = transcript.words.map((w) => ({ speaker: w.track, text: w.text, start: w.timelineStart, end: w.timelineEnd })).sort((x, y) => x.start - y.start);
      const segments = importer.wordsToSegments(words, (transcript.tracks || []).map((t) => ({ id: t.id, label: t.label })));
      const job = load('crucible/transport.js').crucibleTransport().job('snap-live split');
      try {
        const t = load('services/metadata/snap-chapters.js').snapTransports({ models, job, trace: null, laneName: 'snap-live split', signal: cli.signal });
        const decide = args.decideCache ? cachedDecide(t.decide, args.decideCache, log) : t.decide;
        let last = -1;
        const res = await load('services/metadata/transcript-split.js').splitCandidates(segments, words[words.length - 1].end, {
          chat: t.chat, decide, signal: cli.signal,
          onProgress: (p) => { const pct = Math.floor(p.fraction * 20) * 5; if (pct !== last) { last = pct; log(`progress ${pct}% (${p.phase} ${p.done}/${p.total})`); } },
        });
        rows = res.candidates.map((c) => ({ start: c.startSeconds, end: c.endSeconds, label: c.label, isAd: c.isAd }));
        stories = res.stories;
        for (const w of res.warnings) log(`warning: ${w}`);
      } finally {
        await job.releaseAll();
      }
    } else {
      const stub = require(SHIM);
      const channels = {};
      stub.ipcMain = { handle: (ch, fn) => { channels[ch] = fn; } };
      const storyIpc = load('services/editor/story-ipc.js');
      const fakeStore = { get: (key) => (key === 'metadataRouting' ? selections : settings[key]) };
      storyIpc.setupStoryAnalysisHandlers(fakeStore, { promptSetsDir: path.join(REPO_ROOT, 'electron', 'assets') });
      process.on('SIGINT', () => channels['story:cancel']());
      const segments = editorSegments(transcript);
      log(`stories: ${segments.length} editor segments; titles on ${JSON.stringify(await channels['story:routed-model']())}`);
      let last = -1;
      const event = { sender: { isDestroyed: () => false, send: (ch, p) => { const pct = Math.floor(p.fraction * 20) * 5; if (pct !== last) { last = pct; log(`${ch} ${pct}% (${p.phase} ${p.done}/${p.total})`); } } } };
      const res = await channels['story:analyze-chapters'](event, { segments });
      rows = res.chapters.map((c) => ({ start: c.startSeconds, end: c.endSeconds, label: c.label, detail: c.detail, isAd: c.isAd }));
      for (const w of res.warnings || []) log(`warning: ${w}`);
    }
  } finally {
    await cli.close();
  }
  const wallS = (Date.now() - t0) / 1000;
  console.log(`\n${args.mode} over ${args.file}: ${rows.length} pieces in ${wallS.toFixed(0)} s`);
  for (const r of rows) console.log(`${clock(r.start).padStart(8)}  ${r.label}${r.isAd ? ' [ad]' : ''}`);
  starts = rows.slice(1).map((r) => r.start);
  let scored = null;
  if (args.edits) {
    const edits = JSON.parse(fs.readFileSync(args.edits, 'utf8'));
    const edges = owenEdges(edits, transcript.frameSeconds);
    scored = edges.map((e) => {
      const d = Math.min(...e.at.flatMap((a) => starts.map((s) => Math.abs(s - a))));
      return { edge: e.what, at: e.at.map(clock).join('-'), nearest: d };
    });
    console.log(`\nagainst Owen's edges (${args.edits}):`);
    for (const s of scored) console.log(`  ${s.at.padEnd(18)} ${s.edge.padEnd(60)} nearest boundary ${s.nearest.toFixed(0)} s`);
    console.log(`  ${scored.filter((s) => s.nearest <= 60).length} of ${scored.length} within 60 s`);
  }
  if (stories) {
    console.log(`\nstories: ${stories.stretches} stretches, cadence ${(stories.targetSeconds / 60).toFixed(1)} min -> ${stories.boundaryTarget} cuts (min gap ${Math.round(stories.minGapSeconds)} s); ` +
      `junctions ${(stories.junctionMs / 1000).toFixed(0)} s, placement ${(stories.placeMs / 1000).toFixed(0)} s, consolidation ${(stories.consolidateMs / 1000).toFixed(0)} s (${stories.pairQuestions} pair questions)`);
    console.log(`selected: ${stories.selected.map((s) => `${clock(s.at)}(${s.p.toFixed(2)})->${s.placedAt === null ? 'dropped' : clock(s.placedAt)}`).join(' ')}`);
    console.log(`merges: ${stories.merges.map((m) => `${clock(m.at)}(${m.p.toFixed(2)})`).join(' ') || 'none'}`);
    console.log(`kept pairs: ${stories.finalPairs.map((p) => `${clock(p.at)}(${p.p === null ? '-' : p.p.toFixed(2)})`).join(' ')}`);
  }
  if (args.out) fs.writeFileSync(args.out, JSON.stringify({ mode: args.mode, wallS, rows, scored, stories }, null, 1));
}

/**
 * A measurement convenience (never app code): decide answers memoised in a JSON file by the request's
 * own text, so a re-run that changes only selection or consolidation re-asks only the questions that
 * changed. Every answer served from the file is counted in the log.
 */
function cachedDecide(decide, file, log) {
  const crypto = require('crypto');
  const cache = fs.existsSync(file) ? JSON.parse(fs.readFileSync(file, 'utf8')) : {};
  let hits = 0;
  let misses = 0;
  return async (request, o) => {
    const key = crypto.createHash('sha1').update(JSON.stringify(request)).digest('hex');
    if (cache[key]) {
      hits++;
      if (hits % 20 === 1) log(`decide cache: ${hits} answers from ${file}, ${misses} asked`);
      return cache[key];
    }
    misses++;
    const answer = await decide(request, o);
    cache[key] = answer;
    fs.writeFileSync(file, JSON.stringify(cache));
    return answer;
  };
}

main().catch((e) => { console.error(`snap-live: ${e && e.stack ? e.stack : e}`); process.exit(1); });
