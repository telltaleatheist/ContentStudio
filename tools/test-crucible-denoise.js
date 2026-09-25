/**
 * P7: the editor's voice isolation as a Crucible `denoise` job (LEDGER #200,
 * CRUCIBLE-MIGRATION-PLAN.md section 9 and P7), against tools/fake-crucible.js.
 *
 * The door is electron/crucible/denoise.ts, driven through the raw-fetch
 * client (tools/crucible-raw-denoise-client.js) and once through the SDK's own
 * CrucibleClient, so both satisfy the injected seam. What the plan holds P7 to:
 * a 44.1 kHz input is asserted (before any upload); the stem path round trip
 * (the door alone, and voice_separation.py's whole stdin/stdout exchange with
 * main); a failed job aborts the run; a busy lane parks with the holder line;
 * cancel is a DELETE; the params exactly as documented. And the refusals by
 * name that stand in for the local env it never falls back to.
 */
const fs = require('fs');
const path = require('path');
const { spawn, spawnSync } = require('child_process');
const { assert, crucible, fake, tempDir, check, run, rejection, until, REPO } = require('./_crucible-keeper');
const { rawDenoiseClient } = require('./crucible-raw-denoise-client');
const { CrucibleClient } = require('@crucible/client');

const denoise = crucible('denoise');
const protocol = require(path.join(REPO, 'dist', 'main', 'services', 'editor', 'separation-protocol.js'));
const {
  CrucibleVoiceIsolator, VoiceIsolationRefused, VoiceIsolationFailed, VoiceIsolationCancelled,
  VOICE_ISOLATION_MODEL, readWavFormat, voiceIsolationAvailability,
} = denoise;

/** A 16-bit PCM WAV of a quiet tone: `seconds` at `rate`, with `silentFrom..silentTo` zeroed. */
function writeWav(file, { rate = 44100, seconds = 1, channels = 2, silentFrom = null, silentTo = null } = {}) {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const t = i / rate;
    const quiet = silentFrom !== null && t >= silentFrom && t < silentTo;
    const v = quiet ? 0 : Math.round(Math.sin(2 * Math.PI * 220 * t) * 8000);
    for (let c = 0; c < channels; c += 1) data.writeInt16LE(v, (i * channels + c) * 2);
  }
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVE', 8, 'ascii');
  head.write('fmt ', 12, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(channels, 22);
  head.writeUInt32LE(rate, 24);
  head.writeUInt32LE(rate * channels * 2, 28);
  head.writeUInt16LE(channels * 2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
  return file;
}

/** A fake stocked for voice isolation, and a started isolator on it. */
async function setup(options = {}) {
  const server = await fake.startFakeCrucible({ version: '1.0.34', ...fake.stockedForContentStudio(), ...options });
  const client = rawDenoiseClient({ url: server.url, token: server.token });
  const parked = [];
  const logs = [];
  let releasePark = null;
  const park = options.park ?? ((line) => {
    parked.push(line);
    return new Promise((resolve) => { releasePark = resolve; });
  });
  const isolator = new CrucibleVoiceIsolator({ server: 'crucible@fake', client, park, onLog: (l) => logs.push(l) });
  return { server, client, isolator, parked, logs, releasePark: () => releasePark?.(), dir: tempDir('cs-p7-') };
}

const jobPosts = (server) => server.requests.filter((r) => r.method === 'POST' && r.path === '/v1/jobs');

check('the params are exactly as documented: denoise, vocals-roformer, {} and one uploaded input', async () => {
  const t = await setup();
  try {
    await t.isolator.start();
    const chunk = writeWav(path.join(t.dir, 'chunk_0001.wav'));
    await t.isolator.separate(chunk, path.join(t.dir, 'out_0001.wav'));
    const [post] = jobPosts(t.server);
    assert.deepStrictEqual(Object.keys(post.body).sort(), ['client_ref', 'inputs', 'model', 'params', 'type']);
    assert.strictEqual(post.body.type, 'denoise');
    assert.strictEqual(post.body.model, 'vocals-roformer');
    assert.deepStrictEqual(post.body.params, {});
    assert.deepStrictEqual(Object.keys(post.body.inputs), ['chunk_0001.wav']);
    assert.deepStrictEqual(Object.keys(post.body.inputs['chunk_0001.wav']), ['blob_id']);
    assert.strictEqual(t.server.uploads.length, 1);
    assert.strictEqual(t.server.uploads[0].filename, 'chunk_0001.wav');
    assert.strictEqual(t.server.uploads[0].bytes, fs.statSync(chunk).size);
    // Every call names ContentStudio: it is what /v1/activity reports as the holder.
    assert.ok(t.server.requests.filter((r) => r.path !== '/v1/ping').every((r) => r.headers['x-crucible-client'] === 'contentstudio'));
  } finally {
    await t.server.close();
  }
});

check('a 44.1 kHz input is asserted: a 48 kHz chunk is refused by name and nothing is uploaded', async () => {
  const t = await setup();
  try {
    await t.isolator.start();
    const chunk = writeWav(path.join(t.dir, 'chunk_48k.wav'), { rate: 48000 });
    const err = await rejection(t.isolator.separate(chunk, path.join(t.dir, 'out.wav')));
    assert.ok(err instanceof VoiceIsolationRefused);
    assert.strictEqual(err.code, 'voice_isolation_input_not_44100');
    assert.match(err.message, /48000 Hz; vocals-roformer takes 44100 Hz/);
    assert.strictEqual(t.server.uploads.length, 0);
    assert.strictEqual(jobPosts(t.server).length, 0);
  } finally {
    await t.server.close();
  }
});

check('the stem path round trip: the stem lands at the path asked for, the same length and rate as the chunk', async () => {
  const t = await setup();
  try {
    await t.isolator.start();
    const chunk = writeWav(path.join(t.dir, 'chunk_0002.wav'), { seconds: 2 });
    const out = path.join(t.dir, 'out_0002.wav');
    const done = await t.isolator.separate(chunk, out);
    assert.strictEqual(done.stem, out);
    assert.ok(fs.existsSync(out));
    assert.ok(!fs.existsSync(`${out}.partial`));
    const a = readWavFormat(chunk);
    const b = readWavFormat(out);
    assert.strictEqual(b.sampleRate, 44100);
    assert.strictEqual(b.frames, a.frames);
    assert.strictEqual(done.loadSeconds, 1.5);
  } finally {
    await t.server.close();
  }
});

check('a failed job aborts the run with the server\'s message, and no stem is left behind', async () => {
  const t = await setup({ denoise: { failWith: { code: 'worker_failed', message: 'the separator process died: MPS out of memory' } } });
  try {
    await t.isolator.start();
    const chunk = writeWav(path.join(t.dir, 'chunk.wav'));
    const out = path.join(t.dir, 'out.wav');
    const err = await rejection(t.isolator.separate(chunk, out));
    assert.ok(err instanceof VoiceIsolationFailed);
    assert.strictEqual(err.code, 'worker_failed');
    assert.match(err.message, /the separator process died: MPS out of memory/);
    assert.ok(!fs.existsSync(out));
  } finally {
    await t.server.close();
  }
});

check('a busy lane parks with the holder line, submits nothing while parked, and asks once more when released', async () => {
  const t = await setup();
  try {
    await t.isolator.start();
    t.server.inject({ serverBusy: { client: 'bookforge', type: 'tts', progress: 0.62 } });
    const progress = [];
    const chunk = writeWav(path.join(t.dir, 'chunk.wav'));
    const pending = t.isolator.separate(chunk, path.join(t.dir, 'out.wav'), { onProgress: (p) => progress.push(p) });
    await until(() => t.parked.length === 1);
    assert.strictEqual(t.parked[0], 'busy: bookforge, tts, 62% done');
    assert.ok(progress.some((p) => p.kind === 'parked' && p.holderLine === 'busy: bookforge, tts, 62% done'));
    await new Promise((r) => setTimeout(r, 100));
    assert.strictEqual(jobPosts(t.server).length, 1, 'no second submit while parked: nothing loops');
    t.server.inject({});
    t.releasePark();
    const done = await pending;
    assert.ok(fs.existsSync(done.stem));
    assert.strictEqual(jobPosts(t.server).length, 2);
    // The blob was not re-sent: a refused submission never consumes its input.
    assert.strictEqual(t.server.uploads.length, 1);
  } finally {
    await t.server.close();
  }
});

check('a card leased to another client parks with the leased line', async () => {
  const t = await setup();
  try {
    await t.isolator.start();
    t.server.leaseAsOther('qwen3.5-9b', 'contentstudio-chaptering-run');
    const pending = t.isolator.separate(writeWav(path.join(t.dir, 'chunk.wav')), path.join(t.dir, 'out.wav'));
    await until(() => t.parked.length === 1);
    assert.match(t.parked[0], /^leased: contentstudio-chaptering-run, translate, until /);
    t.server.expireLease();
    t.releasePark();
    await pending;
  } finally {
    await t.server.close();
  }
});

check('cancel is a DELETE: an aborted run cancels its job on the server and ends cancelled', async () => {
  const t = await setup({ denoise: { holdAfterWarming: true } });
  try {
    await t.isolator.start();
    const controller = new AbortController();
    const progress = [];
    const pending = t.isolator.separate(writeWav(path.join(t.dir, 'chunk.wav')), path.join(t.dir, 'out.wav'), {
      signal: controller.signal, onProgress: (p) => progress.push(p),
    });
    await until(() => progress.some((p) => p.kind === 'warming'));
    controller.abort();
    const err = await rejection(pending);
    assert.ok(err instanceof VoiceIsolationCancelled);
    const deletes = t.server.requests.filter((r) => r.method === 'DELETE' && /^\/v1\/jobs\//.test(r.path));
    assert.strictEqual(deletes.length, 1);
    assert.strictEqual(t.server.jobs[0].status, 'cancelled');
  } finally {
    await t.server.close();
  }
});

check('a server without denoise, without the manifest, or without the weights is refused by name before any upload', async () => {
  const cases = [
    [{ installedJobTypes: ['echo', 'llm', 'asr', 'align'] }, 'voice_isolation_not_offered', /crucible install rvc/],
    [{ catalog: fake.defaultFakeCatalog().filter((r) => r.id !== 'vocals-roformer') }, 'voice_isolation_model_not_offered', /no vocals-roformer manifest \(its denoise models: denoise-roformer\)/],
    [{ catalog: fake.defaultFakeCatalog() }, 'voice_isolation_model_not_installed', /crucible denoise pull vocals-roformer/],
  ];
  for (const [options, code, message] of cases) {
    const t = await setup(options);
    try {
      const err = await rejection(t.isolator.start());
      assert.ok(err instanceof VoiceIsolationRefused, code);
      assert.strictEqual(err.code, code);
      assert.match(err.message, message);
      assert.strictEqual(t.server.uploads.length, 0);
      await assert.rejects(t.isolator.separate(writeWav(path.join(t.dir, 'c.wav')), path.join(t.dir, 'o.wav')),
        (e) => e.code === 'voice_isolation_not_started');
    } finally {
      await t.server.close();
    }
  }
});

check('a missing env is the server\'s 409 env_missing at the submit, relayed with the command that builds it', async () => {
  const t = await setup({ denoise: { envMissing: true } });
  try {
    await t.isolator.start();
    const err = await rejection(t.isolator.separate(writeWav(path.join(t.dir, 'c.wav')), path.join(t.dir, 'o.wav')));
    assert.ok(err instanceof VoiceIsolationRefused);
    assert.strictEqual(err.code, 'env_missing');
    assert.match(err.message, /HTTP 409 env_missing.*denoise shares the rvc env.*`crucible install rvc`/);
  } finally {
    await t.server.close();
  }
});

check('one lease for the pass: taken after the first chunk, heartbeated before the next, released on dispose', async () => {
  const t = await setup();
  try {
    await t.isolator.start();
    const first = await t.isolator.separate(writeWav(path.join(t.dir, 'a.wav')), path.join(t.dir, 'a_out.wav'));
    assert.deepStrictEqual(t.server.leases.taken.map((l) => [l.model, l.act, l.ttlSeconds]), [[VOICE_ISOLATION_MODEL, 'denoise', 300]]);
    const second = await t.isolator.separate(writeWav(path.join(t.dir, 'b.wav')), path.join(t.dir, 'b_out.wav'));
    assert.strictEqual(first.loadSeconds, 1.5);
    assert.strictEqual(second.loadSeconds, 0, 'the second chunk reuses the resident separator');
    assert.strictEqual(t.server.requestsTo('/v1/leases/', 'POST').length, 1, 'one heartbeat, before the second chunk');
    await t.isolator.dispose();
    await t.isolator.dispose();
    assert.deepStrictEqual(t.server.leases.released, [t.server.leases.taken[0].leaseId]);
    assert.strictEqual(t.server.openLease(), null);
  } finally {
    await t.server.close();
  }
});

check('the SDK\'s own CrucibleClient fills the same seam (the app\'s client today)', async () => {
  const server = await fake.startFakeCrucible({ version: '1.0.34', ...fake.stockedForContentStudio() });
  const dir = tempDir('cs-p7-sdk-');
  try {
    const client = new CrucibleClient({ url: server.url, token: server.token, clientName: 'contentstudio' });
    const isolator = new CrucibleVoiceIsolator({ server: 'crucible@fake', client, park: async () => { throw new Error('unexpected park'); } });
    await isolator.start();
    const done = await isolator.separate(writeWav(path.join(dir, 'c.wav')), path.join(dir, 'o.wav'));
    assert.strictEqual(readWavFormat(done.stem).sampleRate, 44100);
    await isolator.dispose();
    assert.strictEqual(server.openLease(), null);
  } finally {
    await server.close();
  }
});

check('the Denoise gate reads the server\'s capability row, with the reason on every "no"', async () => {
  const info = (installed, jobTypes = ['denoise']) => ({
    server: { name: 'x', version: '1.0.34', apiVersion: 1 }, host: {}, jobTypes,
    capabilities: [{ jobType: 'denoise', models: [{ id: 'vocals-roformer', installed, resident: false, vramBytes: 2523719636 }] }],
  });
  assert.deepStrictEqual(voiceIsolationAvailability(info(true), 'mac'), { available: true, vramBytes: 2523719636 });
  const no = voiceIsolationAvailability(info(false), 'mac');
  assert.strictEqual(no.available, false);
  assert.match(no.reason, /The Crucible on mac has not downloaded vocals-roformer yet\. `crucible denoise pull vocals-roformer` there fetches it\./);
  assert.strictEqual(voiceIsolationAvailability(info(true, ['asr']), 'mac').code, 'voice_isolation_not_offered');

  // Over the app's context: the selected server, and a named "no" when none is selected.
  const server = await fake.startFakeCrucible({ version: '1.0.34', ...fake.stockedForContentStudio() });
  try {
    const deps = denoise.crucibleVoiceIsolation({
      servers: { selected: () => 'crucible@fake' },
      factory: { clientFor: async () => rawDenoiseClient({ url: server.url, token: server.token }) },
      probes: { reach: async () => ({ probe: { outcome: 'ok', facts: { busyLine: null } } }) },
    });
    assert.deepStrictEqual(await deps.status(), { available: true, reason: 'Runs on the Crucible on crucible@fake.' });
    const none = denoise.crucibleVoiceIsolation({
      servers: { selected: () => { throw new Error('No Crucible server is selected.'); } },
      factory: { clientFor: async () => { throw new Error('unreachable'); } },
      probes: { reach: async () => { throw new Error('unreachable'); } },
    });
    assert.deepStrictEqual(await none.status(), { available: false, reason: 'Needs a Crucible with voice isolation: No Crucible server is selected.' });
  } finally {
    await server.close();
  }
});

check('the interim park re-reads the probe until the lane is free, and stops on abort', async () => {
  let reads = 0;
  const probes = { reach: async () => { reads += 1; return { probe: { outcome: 'ok', facts: { busyLine: reads < 3 ? 'busy: bookforge, tts' : null } } }; } };
  await denoise.parkOnProbe(probes, 'mac', 5)('busy: bookforge, tts');
  assert.strictEqual(reads, 3);
  const controller = new AbortController();
  const waiting = denoise.parkOnProbe({ reach: async () => ({ probe: { outcome: 'ok', facts: { busyLine: 'busy' } } }) }, 'mac', 5)('busy', controller.signal);
  setTimeout(() => controller.abort(), 20);
  await assert.rejects(waiting, /cancelled while waiting for the lane/);
});

check('the protocol answers every request: a malformed one and a missing handler are errors, never silence', async () => {
  const lines = [];
  const signal = new AbortController().signal;
  await protocol.answerSeparationRequest({ type: 'separation_request', wav: '', out: '/o', chunk: 1, chunks: 1, track: 'mic 1' }, async () => '/x', (l) => lines.push(l), signal);
  await protocol.answerSeparationRequest({ type: 'separation_request', wav: '/w', out: '/o', chunk: 1, chunks: 1, track: 'mic 1' }, undefined, (l) => lines.push(l), signal);
  await protocol.answerSeparationRequest({ type: 'separation_request', wav: '/w', out: '/o', chunk: 2, chunks: 3, track: 'mic 1' }, async () => { throw new Error('crucible "mac" could not isolate the voice'); }, (l) => lines.push(l), signal);
  await protocol.answerSeparationRequest({ type: 'separation_request', wav: '/w', out: '/o', chunk: 3, chunks: 3, track: 'mic 1' }, async (r) => r.out, (l) => lines.push(l), signal);
  assert.deepStrictEqual(lines.map((l) => JSON.parse(l)), [
    { type: 'separation_complete', error: "separation_request has no 'wav' path" },
    { type: 'separation_complete', error: 'this workflow was started without voice isolation wired to a Crucible' },
    { type: 'separation_complete', error: 'crucible "mac" could not isolate the voice' },
    { type: 'separation_complete', out: '/o' },
  ]);
  const line = protocol.separationProgress({ wav: '/w', out: '/o', chunk: 2, chunks: 4, track: 'mic 1' }, { kind: 'progress', fraction: 0.5, message: 'separating' }, 'mac');
  assert.deepStrictEqual(line, { message: 'Isolating voice on mic 1 — section 2 of 4: separating', subProgress: 37.5 });
});

check('voice_separation.py end to end: chunked in Python, each chunk a job on the fake, the stems reassembled', async () => {
  for (const tool of ['ffmpeg', 'ffprobe', 'python3']) {
    const found = spawnSync('which', [tool]);
    if (found.status !== 0) throw new Error(`${tool} is not on PATH; this check runs the real Python side`);
  }
  const t = await setup();
  try {
    // 4.8 s of tone, 4.8 s of digital silence, 3.4 s of tone at 48 kHz: forced cuts at 4.8 s and
    // 9.6 s (--target-min 0.05, --max-min 0.08) make three chunks, the middle one silent.
    const input = writeWav(path.join(t.dir, 'mic audio.wav'), { rate: 48000, seconds: 13, silentFrom: 4.8, silentTo: 9.6 });
    const output = path.join(t.dir, 'mic audio_voiceiso.wav');
    const child = spawn('python3', [path.join(REPO, 'editor-backend', 'core', 'voice_separation.py'),
      '--input', input, '--output', output, '--track', 'mic 1', '--target-min', '0.05', '--max-min', '0.08']);
    const controller = new AbortController();
    let opened = null;
    const seen = [];
    let buffer = '';
    let stderr = '';
    child.stderr.on('data', (d) => { stderr += d; });
    child.stdout.on('data', (d) => {
      buffer += d;
      let cut;
      while ((cut = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, cut).trim();
        buffer = buffer.slice(cut + 1);
        if (line === '') continue;
        const message = JSON.parse(line);
        seen.push(message.type);
        if (message.type === protocol.SEPARATION_REQUEST) {
          void protocol.answerSeparationRequest(message, async (request, signal) => {
            if (opened === null) { opened = t.isolator; await opened.start(); }
            return (await opened.separate(request.wav, request.out, { signal })).stem;
          }, (l) => child.stdin.write(l), controller.signal);
        } else if (message.type === protocol.SEPARATION_RELEASE) {
          void t.isolator.dispose();
        }
      }
    });
    const code = await new Promise((resolve) => child.on('close', resolve));
    assert.strictEqual(code, 0, stderr.slice(-800));
    assert.deepStrictEqual(seen, ['separation_request', 'separation_request', 'separation_release']);
    assert.match(stderr, /CHUNK 2\/3 \([\d.]+-[\d.]+min\) SILENT -> passthrough/);
    assert.strictEqual(jobPosts(t.server).length, 2, 'the silent chunk never became a job');
    const made = readWavFormat(output);
    assert.strictEqual(made.sampleRate, 48000);
    assert.ok(Math.abs(made.frames / 48000 - 13) < 0.05, `the output is ${made.frames / 48000} s`);
    assert.strictEqual(t.server.openLease(), null, 'the release gave the card back');
  } finally {
    await t.server.close();
  }
});

check('voice_separation.py fails loud on an error answer: non-zero exit, and no output written', async () => {
  const dir = tempDir('cs-p7-py-');
  const input = writeWav(path.join(dir, 'in.wav'), { rate: 48000, seconds: 2 });
  const output = path.join(dir, 'out.wav');
  const child = spawn('python3', [path.join(REPO, 'editor-backend', 'core', 'voice_separation.py'), '--input', input, '--output', output]);
  let stderr = '';
  child.stderr.on('data', (d) => { stderr += d; });
  child.stdout.on('data', (d) => {
    for (const line of String(d).split('\n').filter(Boolean)) {
      if (JSON.parse(line).type === 'separation_request') {
        child.stdin.write(JSON.stringify({ type: 'separation_complete', error: 'crucible "mac" could not isolate the voice in chunk_0000.wav (job 7, worker_failed): boom' }) + '\n');
      }
    }
  });
  const code = await new Promise((resolve) => child.on('close', resolve));
  assert.notStrictEqual(code, 0);
  assert.match(stderr, /ERROR: voice isolation failed on chunk_0000\.wav: crucible "mac" could not isolate the voice/);
  assert.ok(!fs.existsSync(output));
});

check('nothing reaches voice-separator-env: no code path names it outside the asset catalog', () => {
  const offenders = [];
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { if (entry.name !== 'node_modules') walk(full); continue; }
      if (!/\.(ts|py|html)$/.test(entry.name) || /\.spec\.ts$/.test(entry.name)) continue;
      const text = fs.readFileSync(full, 'utf-8');
      // Code, not prose: the id as a string literal, the payload field, the resolver, the launcher.
      if (/['"]voice-separator-env['"]|voiceSeparatorEnv|getVoiceSeparator|run_audio_separator/.test(text)) offenders.push(path.relative(REPO, full));
    }
  };
  for (const root of ['electron', 'editor-backend', path.join('frontend', 'src')]) walk(path.join(REPO, root));
  // The catalog entry is P10's to delete (plan section 15): it describes the download, it runs nothing.
  assert.deepStrictEqual(offenders.filter((f) => f !== path.join('electron', 'services', 'editor', 'asset-catalog.ts')), []);
});

run('test-crucible-denoise (P7: voice isolation on Crucible)');
