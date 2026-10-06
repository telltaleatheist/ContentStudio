/**
 * ONE EDITOR PROCESSING RUN, ONE QUEUE SESSION (LEDGER #264), against tools/fake-crucible.js.
 *
 * The run as the app drives it: the editor's voice isolation (denoise.ts `crucibleVoiceIsolation`
 * over the app's Crucible context, a pass per track), our side's work after it (the rest of the
 * workflow, the renderer's bootstrap, transcribe.py's extraction), then one asr job per track
 * through the editor's own door (editor-asr.ts `serveEditorAsrRequest` → transcribeOnCrucible →
 * the context's ASR venue). Every step asks the run (run-session.ts) for its session.
 *
 * What is held: one session asked for, closed once, by its client, at the run's end; every job an
 * item of it; the separator and the transcriber each put on the card once; the session touched
 * while our side works between steps; a session the server ends is never replaced.
 */
const fs = require('fs');
const path = require('path');
const { assert, crucible, fake, context, tempDir, check, run, until, rejection, REPO } = require('./_crucible-keeper');

const { EditorRunSessions } = crucible('run-session');
const denoise = crucible('denoise');
const { CRUCIBLE_CLIENT_NAME } = crucible('client-factory');
const door = require(path.join(REPO, 'dist', 'main', 'services', 'transcription', 'crucible-transcription.js'));
const editorAsr = require(path.join(REPO, 'dist', 'main', 'services', 'editor', 'editor-asr.js'));

/** A 16-bit PCM WAV of a quiet tone at `rate`. */
function writeWav(file, { rate = 44100, seconds = 0.5, channels = 2 } = {}) {
  const frames = Math.round(rate * seconds);
  const data = Buffer.alloc(frames * channels * 2);
  for (let i = 0; i < frames; i += 1) {
    const v = Math.round(Math.sin((2 * Math.PI * 220 * i) / rate) * 8000);
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

/** One fake server registered as `mac` over the app's composition root, with the editor's two doors wired. */
async function world() {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.80', ...fake.stockedForContentStudio() });
  const { ctx } = context();
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  ctx.servers.select('mac');
  // The app's wiring: ipc-handlers.ts `crucibleVoiceIsolation(analytics.crucible)`, main.ts `setAsrVenueResolver(crucible.asrVenue)`.
  const voice = denoise.crucibleVoiceIsolation(ctx);
  door.setAsrVenueResolver(ctx.asrVenue);
  const dir = tempDir('cs-editor-run-');
  const close = async () => {
    door.setAsrVenueResolver(null);
    ctx.lanes.stop();
    await ctx.sessions.closeAll('the keeper is done');
    await server.close();
  };
  return { server, ctx, voice, dir, close };
}

/** One track's isolation pass, as editor-ipc runs it: open, the chunks, dispose on `separation_release`. */
async function isolateTrack(w, track, chunks, sessions) {
  const isolator = await w.voice.open(() => undefined, sessions);
  try {
    for (let i = 1; i <= chunks; i += 1) {
      const wav = writeWav(path.join(w.dir, `${track}-${i}.wav`));
      await isolator.separate(wav, path.join(w.dir, `${track}-${i}-out.wav`));
    }
  } finally {
    await isolator.dispose();
  }
}

/** One track's transcription, as transcribe.py's asr_request is served. */
function transcribeTrack(w, trackId, sessions, jobId = 'transcribe_1') {
  const wav = writeWav(path.join(w.dir, `${trackId}.wav`), { rate: 16000, channels: 1 });
  return editorAsr.serveEditorAsrRequest(
    { type: 'asr_request', id: 1, wav, trackId, region: null },
    { context: 'C', jobId, ...(sessions === undefined ? {} : { sessions }) },
  );
}

const ours = (server) => server.sessions.filter((row) => row.client === CRUCIBLE_CLIENT_NAME);
const sessionCloses = (server) => server.requests.filter((r) => r.method === 'DELETE' && /^\/v1\/queue\/sessions\/[^/]+$/.test(r.path));
const jobPosts = (server) => server.requests.filter((r) => r.method === 'POST' && r.path === '/v1/jobs');

check('before #264 (each step its own session): isolation and two tracks open three sessions and load the transcriber twice', async () => {
  const w = await world();
  try {
    await isolateTrack(w, 'mic1', 2);
    await transcribeTrack(w, 't0');
    await transcribeTrack(w, 't1');
    assert.strictEqual(ours(w.server).length, 3, 'a session per step');
    assert.deepStrictEqual(w.server.cardLoads, ['vocals-roformer', 'qwen3-asr-1.7b', 'qwen3-asr-1.7b'], 'the card is settled between steps');
  } finally {
    await w.close();
  }
});

check('isolation (two tracks) + our side\'s gap + transcription of two tracks: one session asked for, closed once, models loaded once, touched through the gap', async () => {
  const w = await world();
  try {
    const runs = new EditorRunSessions(w.ctx.lanes, { touchEveryMs: 10 });
    const processing = runs.startProcessing('job_1');
    assert.strictEqual(ours(w.server).length, 0, 'nothing is asked for before the run\'s first Crucible call');
    await isolateTrack(w, 'mic1', 2, processing);
    await isolateTrack(w, 'mic2', 1, processing);
    const [row] = ours(w.server);
    assert.strictEqual(row.status, 'open', 'a track\'s separation_release lets go of nothing the run holds');
    // The rest of the workflow, the bootstrap, transcribe.py's extraction: our side's work, touched.
    await until(() => row.touches >= 3);
    await runs.processingEnded(processing, path.join(w.dir, 'session_compounds.zip'), 'the workflow finished');
    assert.strictEqual(row.status, 'open', 'parked for its transcription, still held');
    const transcription = runs.startTranscription('transcribe_1', path.join(w.dir, '.', 'session_compounds.zip'));
    assert.strictEqual(transcription, processing, 'the transcription of the zip the run produced adopts the run');
    await transcribeTrack(w, 't0', transcription);
    await transcribeTrack(w, 't1', transcription);
    assert.strictEqual(row.status, 'open', 'a track\'s job lets go of nothing the run holds');
    await transcription.release('the transcription is done');
    await transcription.release('again: idempotent');

    assert.strictEqual(ours(w.server).length, 1, 'one session for the whole run');
    assert.deepStrictEqual([row.act, row.idleS], ['denoise', 900], 'asked for by the first chunk, idle 900 s');
    assert.deepStrictEqual([row.status, row.reason], ['closed', 'client'], 'closed by us at the end');
    assert.strictEqual(sessionCloses(w.server).length, 1, 'closed once');
    assert.deepStrictEqual(w.server.cardLoads, ['vocals-roformer', 'qwen3-asr-1.7b'], 'the separator and the transcriber each loaded once');
    const posts = jobPosts(w.server);
    assert.strictEqual(posts.length, 5, '3 chunks and 2 tracks');
    assert.ok(posts.every((r) => r.headers['x-crucible-session'] === row.id), 'every job is an item of the run\'s session');
    assert.strictEqual(w.ctx.sessions.openOn('mac'), null);
    assert.deepStrictEqual(w.ctx.ledger.read(), [], 'the session row left the in-flight ledger');
    const touches = row.touches;
    await new Promise((resolve) => setTimeout(resolve, 40));
    assert.strictEqual(row.touches, touches, 'no touch after the run let go');
  } finally {
    await w.close();
  }
});

check('a run with no transcription after it lets go when the workflow ends; a standalone transcription holds one session across its tracks', async () => {
  const w = await world();
  try {
    const runs = new EditorRunSessions(w.ctx.lanes, { touchEveryMs: 10 });
    const processing = runs.startProcessing('job_1');
    await isolateTrack(w, 'mic1', 1, processing);
    await runs.processingEnded(processing, null, 'nothing transcribes it next');
    assert.deepStrictEqual(ours(w.server).map((r) => [r.status, r.reason]), [['closed', 'client']]);

    const transcription = runs.startTranscription('transcribe_2', path.join(w.dir, 'x.zip'));
    assert.notStrictEqual(transcription, processing);
    await transcribeTrack(w, 't0', transcription, 'transcribe_2');
    await transcribeTrack(w, 't1', transcription, 'transcribe_2');
    await transcription.release('done');
    assert.strictEqual(ours(w.server).length, 2, 'the processing run\'s and the transcription\'s');
    assert.deepStrictEqual(w.server.cardLoads, ['vocals-roformer', 'qwen3-asr-1.7b'], 'the transcriber loaded once across both tracks');
  } finally {
    await w.close();
  }
});

check('a parked run is let go of when its transcription never starts, or a transcription of another zip starts', async () => {
  const w = await world();
  try {
    const runs = new EditorRunSessions(w.ctx.lanes, { touchEveryMs: 10, handoffMs: 30 });
    const first = runs.startProcessing('job_1');
    await isolateTrack(w, 'mic1', 1, first);
    await runs.processingEnded(first, path.join(w.dir, 'a.zip'), 'finished');
    await until(() => ours(w.server)[0].status === 'closed');
    assert.strictEqual(first.done, true, 'the hand-off deadline let go of it');

    const runs2 = new EditorRunSessions(w.ctx.lanes, { touchEveryMs: 10 });
    const second = runs2.startProcessing('job_2');
    await isolateTrack(w, 'mic1', 1, second);
    await runs2.processingEnded(second, path.join(w.dir, 'b.zip'), 'finished');
    const other = runs2.startTranscription('transcribe_3', path.join(w.dir, 'c.zip'));
    assert.notStrictEqual(other, second);
    assert.strictEqual(second.done, true, 'the parked run was let go of');
    await until(() => ours(w.server).every((r) => r.status === 'closed'));
    await other.release('nothing ran');
    assert.strictEqual(ours(w.server).length, 2, 'the other zip\'s transcription asked for nothing yet');
  } finally {
    await w.close();
  }
});

check('a session the server ends during the gap fails the next step by name (session_closed), and no new session is asked for', async () => {
  const w = await world();
  try {
    const runs = new EditorRunSessions(w.ctx.lanes, { touchEveryMs: 10 });
    const processing = runs.startProcessing('job_1');
    await isolateTrack(w, 'mic1', 1, processing);
    const [row] = ours(w.server);
    w.server.endSession(row.id, 'operator', 'ended from the bench');
    await until(() => w.ctx.sessions.openOn('mac') === null);
    await runs.processingEnded(processing, path.join(w.dir, 's.zip'), 'finished');
    const transcription = runs.startTranscription('transcribe_1', path.join(w.dir, 's.zip'));
    const err = await rejection(transcribeTrack(w, 't0', transcription));
    assert.ok(/session_closed|ended/.test(`${err.code} ${err.message}`) && /operator/.test(err.message), err.message);
    assert.strictEqual(ours(w.server).length, 1, 'nothing reopened a session to carry on');
    await transcription.release('failed');
    await assert.rejects(transcription.sessionOn('mac', { act: 'asr', what: 'late' }), /after the run let go/);
  } finally {
    await w.close();
  }
});

run('editor run: one queue session from isolation to the last track (LEDGER #264)');
