/**
 * P5's live acceptance runs on this Mac's Crucible (docs/crucible/P5.md records the numbers).
 *
 * Drives the COMPILED app code — the same door, job, context builder and editor protocol the
 * app runs — against the paired server through tools/crucible-raw-client.js (P1's client
 * replaces it). Nothing here writes into the operator's output directory or his editor
 * sessions: every product goes under --out.
 *
 *   window    one stretch of a recording, transcribed as the pipeline would send it:
 *               --src <media> --start <s> --dur <s> --out <dir> --context bare|editor
 *               [--edits <session>_edits.json] [--channel <prompt set>]
 *             `bare` is the instruction alone (what #203 measured); `editor` adds the session's
 *             facts as editor:transcribe builds them.
 *   pipeline  one video through InputHandlerService → WhisperService (extract, context, job,
 *             captions, the saved transcript) with a scratch output dir seeded with copies of
 *             --report <job.json> (an earlier run's report):
 *               --input <video> --out <dir> [--report <job.json>]... [--channel <id>] [--job-name <s>]
 *   editor    transcribe.py over a COPY of a session's compounds zip (the sidecar lands in --out,
 *             never beside the real session), answering its asr_requests with the app's responder:
 *               --zip <zip> --out <dir> [--max-seconds N] [--channel <id>]
 *
 * Ctrl-C cancels the job in flight with a DELETE (plan §0a: a CLI that takes GPU work must
 * release it on SIGINT) and exits 130.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn, execFileSync } = require('child_process');
const Module = require('module');

const REPO_ROOT = path.join(__dirname, '..');
const SHIM = path.join(REPO_ROOT, 'scripts', '_electron-shim-real-userdata.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron' || r === 'electron-log') return require.resolve(SHIM);
  return orig.call(this, r, ...a);
};
process.env.CONTENTSTUDIO_PROJECT_ROOT = REPO_ROOT;
const DIST = path.join(REPO_ROOT, 'dist', 'main');
const door = require(path.join(DIST, 'services/transcription/crucible-transcription.js'));
const ctxMod = require(path.join(DIST, 'services/transcription/asr-context.js'));
const factsMod = require(path.join(DIST, 'services/transcription/asr-facts.js'));
const ct = require(path.join(DIST, 'services/transcription/crucible-transcript.js'));
const editorAsr = require(path.join(DIST, 'services/editor/editor-asr.js'));
const promptAssetsModule = require(path.join(DIST, 'services/metadata/prompt-assets.js'));
const { pairedVenue } = require('./crucible-raw-client');

promptAssetsModule.initPromptAssets(path.join(REPO_ROOT, 'electron', 'assets', 'prompts'));
const venue = pairedVenue();
door.setAsrVenueResolver(() => venue);

const abort = new AbortController();
let child = null;
process.on('SIGINT', () => {
  console.error('\n[acceptance] SIGINT: cancelling the Crucible job in flight');
  abort.abort();
  if (child) child.kill('SIGTERM');
  setTimeout(() => process.exit(130), 3000);
});

function args() {
  const out = { mode: process.argv[2], report: [] };
  for (let i = 3; i < process.argv.length; i++) {
    const k = process.argv[i].replace(/^--/, '');
    const v = process.argv[i + 1];
    if (k === 'report') { out.report.push(v); i++; continue; }
    // `@file` reads the value from a file (a path whose words a shell wrapper mis-reads).
    out[k.replace(/-([a-z])/g, (_, c) => c.toUpperCase())] = v && v.startsWith('@') ? fs.readFileSync(v.slice(1), 'utf8').trim() : v;
    i++;
  }
  return out;
}

function ffmpegPath() {
  const { getRuntimePaths } = require(path.join(DIST, 'lib/bridges/runtime-paths.js'));
  return getRuntimePaths().ffmpeg;
}

const FILLER = /\b(um+|uh+|ah+|er+|hmm+|mm+)\b/gi;
function fillers(text) {
  const out = {};
  for (const m of text.matchAll(FILLER)) {
    const k = m[1].toLowerCase();
    out[k] = (out[k] || 0) + 1;
  }
  return out;
}

async function windowMode(a) {
  fs.mkdirSync(a.out, { recursive: true });
  const flac = path.join(a.out, 'window.flac');
  if (!fs.existsSync(flac)) {
    execFileSync(ffmpegPath(), ['-y', '-v', 'error', '-ss', String(a.start), '-t', String(a.dur), '-i', a.src, '-vn', '-acodec', 'flac', '-ar', '16000', '-ac', '1', flac]);
  }
  const template = factsMod.asrContextTemplate();
  let facts = {};
  if (a.context === 'editor') {
    facts = factsMod.editorTrackFacts({ session: a.session || path.basename(a.src).replace(/ master\.[^.]+$/, ''), editsPath: a.edits || '/nonexistent', promptSet: a.channel || null });
  } else if (a.context === 'pipeline') {
    // The pipeline's facts for this file, with an earlier run's report copied into a scratch
    // output dir so it is found by source key exactly as the app finds it.
    const reports = path.join(path.resolve(a.out), 'reports-dir');
    fs.mkdirSync(path.join(reports, '.contentstudio', 'metadata'), { recursive: true });
    for (const r of a.report) fs.copyFileSync(r, path.join(reports, '.contentstudio', 'metadata', path.basename(r)));
    facts = factsMod.pipelineItemFacts({ videoPath: a.src, jobName: a.jobName || null, promptSet: a.channel || null, outputDir: reports, notes: null, storyTitle: null }).facts;
  } else if (a.context === 'title') {
    // The whisper.cpp seed alone: the filename title under the instruction.
    facts = { title: ctxMod.titleFromFilename(a.src) };
  }
  // `filler` is #203's measured prompt, verbatim: the baseline Owen's 19-filler run and
  // Crucible's first run (11) were made with. Acceptance only; the app's words are the asset's.
  const context = a.context === 'filler'
    ? 'Verbatim transcript of a livestream. Transcribe every disfluency exactly as spoken, including filler sounds: um, uh, ah, er, hmm, and false starts and repeated words.'
    : ctxMod.buildAsrContext(facts, template);
  fs.writeFileSync(path.join(a.out, `context-${a.context}.txt`), context);
  const t0 = Date.now();
  const outcome = await door.transcribeOnCrucible({
    audioFile: flac, context, clientRefStem: `acceptance:window:${a.context}`, tag: `window ${a.context}`,
    signal: abort.signal, band: { from: 0, to: 100 },
    onProgress: (p, m) => process.stderr.write(`\r  ${String(p).padStart(3)}% ${m.slice(0, 90).padEnd(90)}`),
  });
  process.stderr.write('\n');
  const wall = (Date.now() - t0) / 1000;
  fs.writeFileSync(path.join(a.out, `transcript-${a.context}.json`), JSON.stringify(outcome.transcript, null, 1));
  const { segments, words, transcript } = ct.transcriptToSegments(outcome.transcript);
  const text = segments.map((s) => s.text).join('\n');
  fs.writeFileSync(path.join(a.out, `captions-${a.context}.txt`), segments.map((s) => `${s.start}  ${s.text}`).join('\n'));
  const summary = {
    mode: 'window', context: a.context, contextChars: context.length, contextTokensEstimate: ctxMod.estimateTokens(context),
    server: outcome.server, serverVersion: outcome.serverVersion, jobId: outcome.jobId, model: outcome.model,
    wallSeconds: +wall.toFixed(1), jobSeconds: +outcome.wallSeconds.toFixed(1), audioSeconds: Number(a.dur),
    captions: segments.length, words: words.length, pieces: outcome.transcript.pieces, redecoded: transcript.redecoded,
    fillers: fillers(text), fillerTotal: Object.values(fillers(text)).reduce((x, y) => x + y, 0),
  };
  fs.writeFileSync(path.join(a.out, `summary-${a.context}.json`), JSON.stringify(summary, null, 2));
  console.log(JSON.stringify(summary, null, 2));
}

async function pipelineMode(a) {
  const out = path.resolve(a.out);
  fs.mkdirSync(path.join(out, '.contentstudio', 'metadata'), { recursive: true });
  for (const r of a.report) fs.copyFileSync(r, path.join(out, '.contentstudio', 'metadata', path.basename(r)));
  const { WhisperService } = require(path.join(DIST, 'services/metadata/whisper.service.js'));
  const { InputHandlerService } = require(path.join(DIST, 'services/metadata/input-handler.service.js'));
  const { resolveSpeakerTagging, SpeakerTagger } = require(path.join(DIST, 'services/metadata/speaker-tagging.service.js'));
  const { getRuntimePaths } = require(path.join(DIST, 'lib/bridges/index.js'));
  const enrollment = a.enrollment || null;
  const mode = await resolveSpeakerTagging(enrollment || undefined, getRuntimePaths().speakerModel);
  const tagger = mode.enabled ? new SpeakerTagger(mode) : undefined;
  const whisper = new WhisperService();
  let last = -1;
  whisper.on('progress', (p) => {
    if (p.percent !== last) process.stderr.write(`\r  ${String(p.percent).padStart(3)}% ${p.message.slice(0, 90).padEnd(90)}`);
    last = p.percent;
  });
  const handler = new InputHandlerService(whisper, out, { jobName: a.jobName || null, promptSet: a.channel || null }, undefined, tagger);
  const failures = [];
  const t0 = Date.now();
  const items = await handler.processMultipleInputs([a.input], new Map(), failures, new Map());
  process.stderr.write('\n');
  const wall = (Date.now() - t0) / 1000;
  if (items.length === 0) throw new Error(`the item failed: ${failures.join('; ')}`);
  const item = items[0];
  const sidecarDir = path.join(out, '.contentstudio', 'transcripts');
  const sidecar = fs.readdirSync(sidecarDir).map((f) => path.join(sidecarDir, f))[0];
  const record = JSON.parse(fs.readFileSync(sidecar, 'utf8'));
  const text = item.srtSegments.map((s) => s.text).join('\n');
  fs.writeFileSync(path.join(out, 'captions.txt'), item.srtSegments.map((s) => `${s.start}  ${s.speaker ? `[${s.speaker}] ` : ''}${s.text}`).join('\n'));
  const summary = {
    mode: 'pipeline', input: a.input, wallSeconds: +wall.toFixed(1), durationSec: item.finalDurationSec,
    captions: item.srtSegments.length, sidecar, sidecarModel: record.whisper_model, sidecarWords: (record.words || []).length,
    speakerTagging: record.speaker_tagging, fillers: fillers(text),
  };
  console.log(JSON.stringify(summary, null, 2));
}

function editorPython() {
  if (process.env.CS_EDITOR_PYTHON) return process.env.CS_EDITOR_PYTHON;
  return path.join(os.homedir(), 'Library', 'Application Support', 'OwenMorgan', 'runtime', 'autocutstudio-env', 'bin', 'python3');
}

async function editorMode(a) {
  const out = path.resolve(a.out);
  fs.mkdirSync(out, { recursive: true });
  const zip = path.join(out, path.basename(a.zip));
  fs.copyFileSync(a.zip, zip);
  let session = path.basename(a.zip, '.zip');
  if (session.endsWith('_compounds')) session = session.slice(0, -'_compounds'.length);
  const context = ctxMod.buildAsrContext(
    factsMod.editorTrackFacts({ session, editsPath: path.join(path.dirname(a.zip), `${session}_edits.json`), promptSet: a.channel || null }),
    factsMod.asrContextTemplate());
  fs.writeFileSync(path.join(out, 'context-editor.txt'), context);
  const pyArgs = [path.join(REPO_ROOT, 'editor-backend', 'cli', 'transcribe.py'), '--zip', zip, '--ffmpeg', ffmpegPath()];
  if (a.maxSeconds) pyArgs.push('--max-seconds', a.maxSeconds);
  const t0 = Date.now();
  const requests = [];
  await new Promise((resolve, reject) => {
    child = spawn(editorPython(), pyArgs, { cwd: path.join(REPO_ROOT, 'editor-backend'), stdio: ['pipe', 'pipe', 'pipe'] });
    const respond = editorAsr.createAsrResponder({
      context, jobId: 'acceptance', signal: abort.signal,
      write: (line) => { if (child.stdin.writable) child.stdin.write(line); },
      log: (line) => console.error(`  [main] ${line}`),
    });
    let buf = '';
    let result = null;
    let error = null;
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        let msg;
        try { msg = JSON.parse(line); } catch { console.error(`  [py stdout] ${line}`); continue; }
        if (msg.type === 'asr_request') requests.push({ ...msg, at: (Date.now() - t0) / 1000 });
        if (respond(msg)) continue;
        if (msg.type === 'progress') process.stderr.write(`\r  ${String(msg.progress).padStart(3)}% ${String(msg.message).slice(0, 80).padEnd(80)}`);
        if (msg.type === 'success') result = msg.result;
        if (msg.type === 'error') error = msg.message;
      }
    });
    child.stderr.on('data', (d) => { for (const l of String(d).split('\n')) if (l.trim()) console.error(`  [py] ${l}`); });
    child.on('close', (code) => {
      process.stderr.write('\n');
      if (code === 0 && result) {
        const wall = (Date.now() - t0) / 1000;
        const summary = { mode: 'editor', wallSeconds: +wall.toFixed(1), requests: requests.map((r) => ({ id: r.id, trackId: r.trackId, region: r.region })), ...result };
        fs.writeFileSync(path.join(out, 'summary-editor.json'), JSON.stringify(summary, null, 2));
        console.log(JSON.stringify(summary, null, 2));
        resolve();
      } else reject(new Error(`transcribe.py exited ${code}: ${error}`));
    });
  });
}

(async () => {
  const a = args();
  const run = { window: windowMode, pipeline: pipelineMode, editor: editorMode }[a.mode];
  if (!run) throw new Error('mode: window | pipeline | editor');
  await run(a);
})().catch((e) => {
  console.error(`\n✖ ${e && e.stack ? e.stack : e}`);
  process.exit(1);
});
