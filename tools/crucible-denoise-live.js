#!/usr/bin/env node
/**
 * P7's LIVE ACCEPTANCE (CRUCIBLE-MIGRATION-PLAN.md P7, docs/crucible/P7.md):
 * isolate the voice in a few chunks of one real mic track on THIS machine's
 * Crucible, through the app's own door (dist/main/crucible/denoise.js) over
 * the raw-fetch client (tools/crucible-raw-denoise-client.js).
 *
 *   npm run build:electron
 *   node tools/crucible-denoise-live.js --input "<mic audio.wav>" --at 1800,5400,9000 \
 *        --seconds 360 --out <dir>
 *
 * Each chunk is extracted exactly as editor-backend/core/voice_separation.py
 * extracts one (ffmpeg, 2 ch, 44.1 kHz, pcm_s24le) into <out>/chunk_<at>.wav,
 * separated into <out>/crucible_<at>.wav, and timed; <out>/crucible-live.json
 * holds what was measured. Nothing is compared here: the null test reads the
 * files afterwards (docs/crucible/P7.md says how).
 *
 * THE LOCAL CRUCIBLE ONLY. The server is the one this machine's pairing file
 * names; it refuses any other URL, because the PC's GPU needs Owen's go every
 * time (LEDGER Law 7, #205). The pass runs in one Crucible 1.0.76 queue session
 * (LEDGER #255), which waits in the server's line while another app holds it.
 * Ctrl-C cancels the job on the server and closes the session before exiting 130
 * (plan section 0a: a tool that holds the server must give it back on interrupt).
 */
'use strict';
const fs = require('fs');
const path = require('path');
const { spawnSync } = require('child_process');
const Module = require('module');

// The compiled modules log through electron-log; answer it with the keeper stub.
const STUB = path.join(__dirname, '_electron-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron-log' || request === 'electron') return require.resolve(STUB);
  return originalResolve.call(this, request, ...rest);
};

const os = require('os');
const { readPairingFile } = require('@crucible/client');
const { rawDenoiseClient, rawDenoiseSession } = require('./crucible-raw-denoise-client');
const denoise = require(path.join(__dirname, '..', 'dist', 'main', 'crucible', 'denoise.js'));

function arg(name, fallback) {
  const at = process.argv.indexOf(`--${name}`);
  if (at < 0) {
    if (fallback === undefined) throw new Error(`--${name} is required`);
    return fallback;
  }
  return process.argv[at + 1];
}

async function main() {
  const input = arg('input');
  const positions = arg('at').split(',').map(Number);
  const seconds = Number(arg('seconds', '360'));
  const out = arg('out');
  fs.mkdirSync(out, { recursive: true });

  const pairing = await readPairingFile();
  if (pairing === null) throw new Error('this machine has no Crucible pairing file');
  const host = new URL(pairing.url).hostname;
  if (host !== '127.0.0.1' && host !== 'localhost') {
    throw new Error(`the pairing file names ${pairing.url}, not this machine. This tool only runs on the local Crucible.`);
  }
  // This install's own client name, so the pass joins a session the app already holds (client-factory.ts).
  const clientName = require(path.join(__dirname, '..', 'dist', 'main', 'crucible', 'client-factory.js')).clientNameFor(os.hostname());
  const client = rawDenoiseClient({ url: pairing.url, token: pairing.token, clientName });
  const info = await client.info();
  const server = info.server.name;
  const lines = [];
  const log = (line) => { lines.push(line); console.log(`  ${line}`); };
  const activity = async () => (await fetch(`${pairing.url.replace(/\/$/, '')}/v1/activity`, {
    headers: { Authorization: `Bearer ${pairing.token}`, 'X-Crucible-Api': '1' },
  })).json();

  // MEMORY, SAMPLED: the card's used bytes (/v1/accelerator; unified memory on
  // the Mac, so everything on the machine counts) and the separator worker's
  // own resident set, read with ps. The model's share is the worker's RSS and
  // the rise in used bytes over the baseline taken before the first chunk.
  const accelerator = async () => (await fetch(`${pairing.url.replace(/\/$/, '')}/v1/accelerator`, {
    headers: { Authorization: `Bearer ${pairing.token}`, 'X-Crucible-Api': '1' },
  })).json();
  const workerRss = () => {
    const ps = spawnSync('ps', ['-axo', 'rss=,command=']);
    return String(ps.stdout).split('\n')
      .filter((l) => /jobs[/.]denoise[/.]worker|denoise\/worker\.py/.test(l))
      .reduce((sum, l) => sum + Number(l.trim().split(/\s+/)[0]) * 1024, 0);
  };
  const memory = { baselineUsedBytes: null, peakUsedBytes: 0, peakWorkerRssBytes: 0, samples: 0 };
  const sample = async () => {
    try {
      const a = await accelerator();
      memory.peakUsedBytes = Math.max(memory.peakUsedBytes, a.used_bytes ?? 0);
      memory.peakWorkerRssBytes = Math.max(memory.peakWorkerRssBytes, workerRss());
      memory.samples += 1;
    } catch { /* a missed sample is a missed sample */ }
  };

  const controller = new AbortController();
  const session = ({ onQueue, signal }) => rawDenoiseSession({ url: pairing.url, token: pairing.token, clientName, onQueue, signal });
  const isolator = new denoise.CrucibleVoiceIsolator({ server, client, session, onLog: log });
  let interrupted = false;
  const stop = (signalName) => {
    if (interrupted) return;
    interrupted = true;
    console.log(`\n${signalName}: cancelling the job and closing the queue session`);
    controller.abort();
    void isolator.dispose().finally(() => process.exit(signalName === 'SIGINT' ? 130 : 143));
  };
  process.on('SIGINT', () => stop('SIGINT'));
  process.on('SIGTERM', () => stop('SIGTERM'));

  console.log(`crucible "${server}" ${info.server.version} at ${pairing.url}`);
  const offer = await isolator.start();
  const result = {
    server, version: info.server.version, input, seconds, vramBytesDeclared: offer.vramBytes,
    startedAt: new Date().toISOString(), chunks: [], log: lines,
  };
  memory.baselineUsedBytes = (await accelerator()).used_bytes ?? null;
  result.memory = memory;
  const sampler = setInterval(() => { void sample(); }, 2_000);
  const runStart = Date.now();
  try {
    for (const at of positions) {
      const chunk = path.join(out, `chunk_${at}.wav`);
      const extract = spawnSync('ffmpeg', ['-nostdin', '-v', 'error', '-ss', String(at), '-t', String(seconds),
        '-i', input, '-ac', '2', '-ar', '44100', '-c:a', 'pcm_s24le', '-y', chunk]);
      if (extract.status !== 0) throw new Error(`ffmpeg could not extract ${at}s: ${extract.stderr}`);
      const asked = path.join(out, `crucible_${at}.wav`);
      const t0 = Date.now();
      let lastLine = '';
      const done = await isolator.separate(chunk, asked, {
        signal: controller.signal,
        onProgress: (p) => {
          const line = p.kind === 'in_line' ? `in line: ${p.position} of ${p.of}` : p.kind === 'uploading' ? 'uploading' : `${p.kind}: ${p.message}`;
          if (line !== lastLine) console.log(`    ${line}`);
          lastLine = line;
        },
      });
      const wall = (Date.now() - t0) / 1000;
      const a = await activity();
      const row = {
        at, jobId: done.jobId, wallSeconds: wall, loadSeconds: done.loadSeconds, separateSeconds: done.separateSeconds,
        residentAfter: a.resident ? `${a.resident.kind}:${a.resident.id}` : null,
        sessionAfter: a.session ? `${a.session.client}:${a.session.act}:${a.session.status}` : null,
        stem: path.basename(done.stem),
        stemFormat: denoise.readWavFormat(done.stem),
      };
      result.chunks.push(row);
      console.log(`  chunk ${at}s: ${wall.toFixed(1)} s wall, load ${done.loadSeconds} s, separate ${done.separateSeconds} s, resident ${row.residentAfter}`);
    }
  } finally {
    clearInterval(sampler);
    await isolator.dispose();
    result.wallSeconds = (Date.now() - runStart) / 1000;
    // What the card holds once the session is closed: the settle clears it.
    await new Promise((r) => setTimeout(r, 3_000));
    const after = await activity();
    result.afterClose = { resident: after.resident ? `${after.resident.kind}:${after.resident.id}` : null, session: after.session ?? null };
    fs.writeFileSync(path.join(out, 'crucible-live.json'), JSON.stringify(result, null, 2));
    console.log(`after close: resident ${result.afterClose.resident}, session ${JSON.stringify(after.session ?? null)}`);
  }
}

main().catch((err) => {
  console.error(`crucible-denoise-live: ${err.stack || err}`);
  process.exit(1);
});
