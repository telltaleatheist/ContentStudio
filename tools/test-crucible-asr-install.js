/**
 * THE METADATA TRANSCRIBER INSTALLED THROUGH CRUCIBLE (LEDGER #281), against tools/fake-crucible.js.
 *
 * Owen, 2026-10-09: "switch to 0.6b ... for the metadata step (as opposed to editor, which should
 * keep 1.7b) ... do it through crucible, not direct download." A stocked Mac holds the 1.7B and
 * not the 0.6B. A transcription naming the 0.6B goes through the app's own door
 * (crucible-transcription.ts `transcribeOnCrucible` → the context's asr venue → asr.ts) and meets
 * Crucible's install-on-submit: `409 installing` naming a task, the task read until it ends (the
 * session touched meanwhile, the row saying so), the job submitted again and admitted.
 *
 * What is held: the offered-not-installed model is installed by the server and then run, the
 * record names the 0.6B; a failed install fails the job with the server's sentence; an install
 * past its budget fails naming the task; a model the server does not offer is refused before
 * any upload; an unofficial id (`-mlx`) is refused before anything; the editor names the 1.7B.
 */
const fs = require('fs');
const path = require('path');
const { assert, fake, context, tempDir, check, run, rejection, REPO } = require('./_crucible-keeper');

const door = require(path.join(REPO, 'dist', 'main', 'services', 'transcription', 'crucible-transcription.js'));
const editorAsr = require(path.join(REPO, 'dist', 'main', 'services', 'editor', 'editor-asr.js'));

/** A short 16 kHz mono WAV: the upload's bytes (the fake never decodes them). */
function writeWav(file) {
  const data = Buffer.alloc(16000);
  const head = Buffer.alloc(44);
  head.write('RIFF', 0, 'ascii');
  head.writeUInt32LE(36 + data.length, 4);
  head.write('WAVEfmt ', 8, 'ascii');
  head.writeUInt32LE(16, 16);
  head.writeUInt16LE(1, 20);
  head.writeUInt16LE(1, 22);
  head.writeUInt32LE(16000, 24);
  head.writeUInt32LE(32000, 28);
  head.writeUInt16LE(2, 32);
  head.writeUInt16LE(16, 34);
  head.write('data', 36, 'ascii');
  head.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([head, data]));
  return file;
}

async function world(fakeOptions = {}) {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.80', ...fake.stockedForContentStudio(), ...fakeOptions });
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  ctx.servers.select('mac');
  door.setAsrVenueResolver(ctx.asrVenue);
  const dir = tempDir('cs-asr-install-');
  const close = async () => {
    door.setAsrVenueResolver(null);
    ctx.lanes.stop();
    await ctx.sessions.closeAll('the keeper is done');
    await server.close();
  };
  return { server, ctx, dir, close };
}

const jobPosts = (server) => server.requests.filter((r) => r.method === 'POST' && r.path === '/v1/jobs');
const uploads = (server) => server.requests.filter((r) => r.method === 'POST' && r.path === '/v1/uploads');

function transcribe(w, model, extra = {}) {
  const seen = [];
  const promise = door.transcribeOnCrucible({
    audioFile: writeWav(path.join(w.dir, `${model}.wav`)),
    model,
    context: 'C',
    clientRefStem: `pipeline:keeper-${model}`,
    tag: 'keeper',
    band: { from: 10, to: 94 },
    onProgress: (_percent, message) => seen.push(message),
    installTimings: { pollMs: 15, ...(extra.budgetMs === undefined ? {} : { budgetMs: extra.budgetMs }) },
  });
  return { promise, seen };
}

check('offered but not installed: submit → 409 installing → the task is read until done (session touched) → submitted again → admitted; the record says 0.6B', async () => {
  const w = await world({ installOnSubmit: { stepMs: 40 } });
  try {
    const { promise, seen } = transcribe(w, 'qwen3-asr-0.6b');
    const outcome = await promise;
    assert.strictEqual(outcome.model, 'crucible:mac:qwen3-asr-0.6b', 'the saved transcript records the 0.6B');
    const posts = jobPosts(w.server);
    assert.deepStrictEqual(posts.map((r) => r.body.model), ['qwen3-asr-0.6b', 'qwen3-asr-0.6b'], 'refused once (installing), then admitted');
    assert.strictEqual(uploads(w.server).length, 1, 'the audio was uploaded once');
    const taskReads = w.server.requests.filter((r) => r.method === 'GET' && /^\/v1\/tasks\/task-\d+$/.test(r.path));
    assert.ok(taskReads.length >= 1, 'the install task was read');
    assert.ok(w.server.requests.some((r) => r.method === 'POST' && /\/touch$/.test(r.path)), 'the session was touched while it waited');
    assert.ok(seen.some((m) => /^Crucible on mac is installing qwen3-asr-0\.6b\.\.\. pulling the model 'qwen3-asr-0\.6b'/.test(m)), `the row said so: ${seen.join(' | ')}`);
    const posted = posts[1].body.params;
    assert.deepStrictEqual(Object.keys(posted).sort(), ['context', 'language', 'vad_filter', 'word_timestamps'], 'no quantization or other param is sent');
    assert.strictEqual(posted.word_timestamps, true, 'the aligner stays on');
  } finally {
    await w.close();
  }
});

check('an installed model is one submit: the 1.7B on a stocked Mac', async () => {
  const w = await world({ installOnSubmit: { stepMs: 40 } });
  try {
    const outcome = await transcribe(w, 'qwen3-asr-1.7b').promise;
    assert.strictEqual(outcome.model, 'crucible:mac:qwen3-asr-1.7b');
    assert.strictEqual(jobPosts(w.server).length, 1);
  } finally {
    await w.close();
  }
});

check('a failed install fails the job with the server\'s sentence (unavailable), named once', async () => {
  const w = await world({ installOnSubmit: { stepMs: 10, failWith: { code: 'install_failed', message: 'the download was cut off at 41%' } } });
  try {
    const err = await rejection(transcribe(w, 'qwen3-asr-0.6b').promise);
    assert.strictEqual(err.name, 'CrucibleAsrError');
    assert.strictEqual(err.kind, 'unavailable');
    assert.strictEqual(err.code, 'install_failed');
    assert.match(err.message, /the download was cut off at 41%/);
  } finally {
    await w.close();
  }
});

check('an install past its budget fails naming the task, never waits on silently', async () => {
  const w = await world({ installOnSubmit: { stepMs: 2_000 } });
  try {
    const err = await rejection(transcribe(w, 'qwen3-asr-0.6b', { budgetMs: 60 }).promise);
    assert.strictEqual(err.code, 'crucible_asr_install_timeout');
    assert.match(err.message, /still installing what qwen3-asr-0\.6b needs.*task task-\d+/);
  } finally {
    await w.close();
  }
});

check('a model the server does not offer is refused by name before the upload', async () => {
  const w = await world({ installOnSubmit: true, asrIds: ['qwen3-asr-1.7b', 'whisper-tiny'] });
  try {
    const err = await rejection(transcribe(w, 'qwen3-asr-0.6b').promise);
    assert.strictEqual(err.code, 'crucible_asr_unavailable');
    assert.match(err.message, /does not offer qwen3-asr-0\.6b/);
    assert.strictEqual(uploads(w.server).length, 0, 'nothing was uploaded');
  } finally {
    await w.close();
  }
});

check('an unofficial id (the -mlx port) is refused before anything is asked', async () => {
  const w = await world();
  try {
    const err = await rejection(transcribe(w, 'qwen3-asr-0.6b-mlx').promise);
    assert.strictEqual(err.code, 'crucible_asr_model_unknown');
    assert.strictEqual(w.server.requests.filter((r) => r.path !== '/v1/ping').length, 0, 'no request crossed');
  } finally {
    await w.close();
  }
});

check('the editor names the 1.7B whatever the metadata row says', async () => {
  const w = await world({ installOnSubmit: true });
  try {
    const wav = writeWav(path.join(w.dir, 'track.wav'));
    const served = await editorAsr.serveEditorAsrRequest({ type: 'asr_request', id: 1, wav, trackId: 't0', region: null }, { context: 'C', jobId: 'transcribe_1' });
    assert.strictEqual(served.model, 'crucible:mac:qwen3-asr-1.7b');
    assert.deepStrictEqual(jobPosts(w.server).map((r) => r.body.model), ['qwen3-asr-1.7b']);
  } finally {
    await w.close();
  }
});

run('metadata transcriber: install through Crucible on submit (LEDGER #281)');
