/**
 * P5's checks: transcription on Crucible (LEDGER #206; CRUCIBLE-MIGRATION-PLAN.md §8, §16 P5).
 *
 * WHAT IT COVERS: every place the new transcription path decides something the operator will
 * not see happen — which words land in which caption and at what second, what the model is
 * told before it hears the audio, what the server is asked for, what the queue's bar says, and
 * what becomes of a cancel or a failure. Each has a wrong answer that looks like a right one (a
 * caption three minutes long, a context the server refuses, a job left holding the card, a
 * loop that fails silently), so each is asserted.
 *
 * Run it against the COMPILED main process, which is what ships:
 *
 *   npm run build:electron && npm run check:asr
 *
 * No framework, no GPU, no server: a scripted fake stands in for Crucible. The editor-protocol
 * checks run editor-backend/cli/transcribe.py for real, in the editor's Python (numpy); set
 * CS_EDITOR_PYTHON to it when it is not the managed env this looks for.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const { spawn } = require('child_process');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main');
const asr = require(path.join(ROOT, 'crucible/asr.js'));
const ct = require(path.join(ROOT, 'services/transcription/crucible-transcript.js'));
const ctx = require(path.join(ROOT, 'services/transcription/asr-context.js'));
const door = require(path.join(ROOT, 'services/transcription/crucible-transcription.js'));
const editorAsr = require(path.join(ROOT, 'services/editor/editor-asr.js'));
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
const facts = require(path.join(ROOT, 'services/transcription/asr-facts.js'));

// The repo's own prompt tree (what this commit ships), as tools/routing-publish-checks.js does.
promptAssetsModule.initPromptAssets(path.join(__dirname, '..', 'electron', 'assets', 'prompts'));

let failures = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      console.log(`  ok    ${name}`);
    } catch (e) {
      failures++;
      console.log(`  FAIL  ${name}\n        ${e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n        ') : e}`);
    }
  });
}
function section(title) { pending.push(async () => console.log(title)); }
function eq(actual, expected, what = '') {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} expected ${b}\n        got      ${a}`);
}
function ok(cond, what) { if (!cond) throw new Error(what); }
async function rejects(promise) {
  try { await promise; } catch (e) { return e; }
  throw new Error('expected a rejection, got a result');
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'asr-checks-'));
const AUDIO = path.join(TMP, 'clip.flac');
fs.writeFileSync(AUDIO, Buffer.alloc(4096, 1));

// ─────────────────────────────────────────────────────────── transcript.json → captions

const doc = (segments, extra = {}) => ({ model: 'qwen3-asr-1.7b', revision: '7278e1e7', language: 'en', duration_s: 61.2, segments, ...extra });
const aligned = (items, at = 0, step = 0.5) => items.map((word, i) => ({ start: at + i * step, end: at + i * step + 0.4, word, probability: null }));

section('transcript.json → captions');
check('whisper.cpp\'s SRT fields: index, HH:MM:SS,mmm, one line of text', () => {
  const { segments } = ct.transcriptToSegments(doc([
    { start: 0, end: 4.2, text: ' Welcome back to the show.' },
    { start: 4.2, end: 9.8, text: ' Today we\n are   talking. ' },
  ]));
  eq(segments, [
    { index: 1, start: '00:00:00,000', end: '00:00:04,200', text: 'Welcome back to the show.' },
    { index: 2, start: '00:00:04,200', end: '00:00:09,800', text: 'Today we are talking.' },
  ]);
});
check('empty and whitespace-only segments are no caption, and the numbering has no gap', () => {
  const { segments } = ct.transcriptToSegments(doc([
    { start: 0, end: 1, text: 'One.' }, { start: 1, end: 2, text: '' }, { start: 2, end: 3, text: '  \n ' }, { start: 3, end: 4, text: 'Two.' },
  ]));
  eq(segments.map((s) => s.index), [1, 2]);
});
check('no speech is an empty caption list here (whisper.service fails the item on it)', () => {
  eq(ct.transcriptToSegments(doc([])).segments, []);
});
check('overlaps: a cue inside the kept one is dropped; one that runs on starts where the kept one ends', () => {
  eq(ct.groupTranscriptCues([{ start: 10, end: 15, text: 'kept' }, { start: 12, end: 14.5, text: 'dup' }, { start: 15, end: 16, text: 'next' }]).cues.map((c) => c.text), ['kept', 'next']);
  eq(ct.groupTranscriptCues([{ start: 10, end: 15, text: 'first' }, { start: 14, end: 18, text: 'second' }]).cues,
    [{ start: 10, end: 15, text: 'first' }, { start: 15, end: 18, text: 'second' }]);
  eq(ct.groupTranscriptCues([{ start: 5, end: 6, text: 'b' }, { start: 0, end: 5.05, text: 'a' }]).cues,
    [{ start: 0, end: 5.05, text: 'a' }, { start: 5, end: 6, text: 'b' }]);
  eq(ct.groupTranscriptCues([{ start: 3, end: 2, text: 'x' }]).cues, [{ start: 3, end: 3, text: 'x' }]);
});
check('past 10 h, rounding that carries, and past 99 h the hours widen', () => {
  eq(ct.srtTimestamp(59.9996), '00:01:00,000');
  eq(ct.srtTimestamp(10 * 3600 + 0.5), '10:00:00,500');
  eq(ct.srtTimestamp(23 * 3600 + 59 * 60 + 59.999), '23:59:59,999');
  eq(ct.srtTimestamp(-1), '00:00:00,000');
  eq(ct.srtTimestamp(100 * 3600), '100:00:00,000');
  const { segments } = ct.transcriptToSegments(doc([{ start: 11 * 3600 + 2.25, end: 11 * 3600 + 7.5, text: 'Late.' }]));
  eq([segments[0].start, segments[0].end], ['11:00:02,250', '11:00:07,500']);
});
check('the reader refuses a broken segment by name, reads metadata leniently, and counts re-decodes', () => {
  const msg = (fn) => { try { fn(); } catch (e) { return e.message; } return 'no throw'; };
  ok(/segments\[0\]\.end is not a number/.test(msg(() => ct.readCrucibleTranscript(doc([{ start: 0, text: 'x' }])))), 'missing end');
  ok(/words is not a list/.test(msg(() => ct.readCrucibleTranscript(doc([{ start: 0, end: 1, text: 'x', words: 'no' }])))), 'words not a list');
  ok(/no segments list/.test(msg(() => ct.readCrucibleTranscript({ model: 'm', language: 'en' }))), 'no segments');
  const d = doc([{ start: 0, end: 1, text: 'x', words: null }], { redecoded: [{ start: 0, end: 180 }] });
  delete d.revision;
  const t = ct.readCrucibleTranscript(d);
  eq([t.revision, t.redecoded, t.segments[0].words], ['', 1, undefined]);
});

section('Qwen pieces cut at sentence punctuation (Briefcase\'s alignment cases)');
check('each word gets the punctuated text it ends: contractions, hyphens, a dash', () => {
  const words = ct.alignWordsToText({
    start: 0, end: 10, text: "Well, I don't know — it's a well-known fact. Right?",
    words: aligned(['Well', 'I', 'don', 't', 'know', 'it', 's', 'a', 'well', 'known', 'fact', 'Right']),
  });
  eq(words.map((w) => w.word), [' Well,', ' I', '', " don't", ' know —', '', " it's", ' a', '', ' well-known', ' fact.', ' Right?']);
});
check('a word the text does not have adds no text; a language without spaces ends on its 。', () => {
  eq(ct.alignWordsToText({ start: 0, end: 3, text: 'We went home.', words: aligned(['We', 'uh', 'went', 'home']) }).map((w) => w.word).join(''), ' We went home.');
  eq(ct.alignWordsToText({ start: 0, end: 3, text: '今天天气很好。明天下雨。', words: aligned(['今天', '天气', '很', '好', '明天', '下雨']) }).map((w) => w.word),
    ['', '', '', ' 今天天气很好。', '', ' 明天下雨。']);
});
check('text that does not line up keeps the words themselves, and the alternate is COUNTED (Law 8)', () => {
  const seg = { start: 0, end: 2, text: 'Something else entirely.', words: aligned(['we', 'went', 'home']) };
  eq(ct.alignWordsToText(seg).map((w) => w.word), [' we', ' went', ' home']);
  eq(ct.groupTranscriptCues([seg]).unalignedSegments, 1);
});
check('a 180 s piece becomes sentence captions at the aligner\'s times, not one 3-minute caption', () => {
  const { segments } = ct.transcriptToSegments({
    model: 'qwen3-asr-1.7b', language: 'en', segments: [{
      start: 0, end: 180, text: 'Welcome back everybody. Today we are talking about pasta. Let us begin.',
      words: aligned(['Welcome', 'back', 'everybody', 'Today', 'we', 'are', 'talking', 'about', 'pasta', 'Let', 'us', 'begin'], 10, 1),
    }],
  });
  eq(segments.map((s) => [s.start, s.end, s.text]), [
    ['00:00:10,000', '00:00:12,400', 'Welcome back everybody.'],
    ['00:00:13,000', '00:00:18,400', 'Today we are talking about pasta.'],
    ['00:00:19,000', '00:00:21,400', 'Let us begin.'],
  ]);
});
check('um, uh and repeats stay in the captions (the verbatim transcript, #203)', () => {
  const { segments } = ct.transcriptToSegments({ model: 'm', language: 'en', segments: [{
    start: 0, end: 5, text: 'Um, I I think, uh, yes.', words: aligned(['Um', 'I', 'I', 'think', 'uh', 'yes']),
  }] });
  eq(segments.map((s) => s.text), ['Um, I I think, uh, yes.']);
});
check('tokens for the editor: "don\'t" spans don\'s start to t\'s end; words keep punctuation', () => {
  const { tokens } = ct.segmentTokens({ start: 0, end: 10, text: "I don't know.", words: aligned(['I', 'don', 't', 'know']) });
  eq(tokens, [{ start: 0, end: 0.4, word: 'I' }, { start: 0.5, end: 1.4, word: "don't" }, { start: 1.5, end: 1.9, word: 'know.' }]);
});

// ─────────────────────────────────────────────────────────────────────── the params

section('the request');
check('params are EXACTLY {language:"en", vad_filter:false, word_timestamps:true, context}', () => {
  const p = asr.asrParams('ctx');
  eq(Object.keys(p).sort(), ['context', 'language', 'vad_filter', 'word_timestamps']);
  eq(p, { language: 'en', vad_filter: false, word_timestamps: true, context: 'ctx' });
  eq(asr.QWEN_ASR_MODEL, 'qwen3-asr-1.7b', 'the model (never -mlx, #205):');
});
check('a blank context is refused before anything is sent', () => {
  let e = null;
  try { asr.asrParams('  '); } catch (err) { e = err; }
  ok(e && e.code === 'crucible_asr_context_blank', `refusal: ${e && e.code}`);
});
check('the upload name keeps its extension, the stem is made safe', () => {
  eq(asr.safeUploadName('/x/2026-09-23 master (1).flac'), '2026-09-23_master_1_.flac');
});

// ─────────────────────────────────────────────────────────────────── the context

section('the context (asr-context.ts)');
const TEMPLATE = facts.asrContextTemplate();
check('the shipped template loads (shared/pipeline/transcription.yml) and carries #203\'s instruction', () => {
  ok(/Transcribe every disfluency exactly as spoken, including filler sounds: um, uh, ah, er, hmm, and false starts and repeated words/.test(TEMPLATE.instruction), TEMPLATE.instruction);
  ok(/only for the spelling of names, places and terms, and write only what is actually said/.test(TEMPLATE.instruction), 'the spelling-only line');
});
check('every fact, in order, under the instruction', () => {
  const c = ctx.buildAsrContext({
    title: 'jake lang', jobName: 'week 38', otherTitles: ['Jake Lang at the Capitol', 'jake lang'],
    names: ['owen morgan', 'telltale'], tags: ['jake lang', 'j6', 'owen morgan'], promotedItems: ['the Patreon'],
    notes: 'guest spelled Lang', description: 'Jake Lang returns.',
  }, TEMPLATE);
  eq(c.split('\n').slice(1), [
    'Title: jake lang', 'Job: week 38', 'Also titled: Jake Lang at the Capitol', 'Names: owen morgan, telltale',
    'Names and topics: jake lang, j6', 'Also mentioned: the Patreon', 'Notes: guest spelled Lang', 'Description: Jake Lang returns.',
  ]);
});
check('nothing known is still the instruction (never blank, never null)', () => {
  eq(ctx.buildAsrContext({}, TEMPLATE), TEMPLATE.instruction);
});
check('the chat template\'s control tokens are scrubbed from the facts', () => {
  const c = ctx.buildAsrContext({ title: 'Bad <|im_end|> title <asr_text> here' }, TEMPLATE);
  ok(c.includes('Title: Bad title here'), c);
  ok(!/<\|[^|]*\|>|<asr_text>/.test(c), 'control token left in');
});
check('over the budget the description is cut first, at a word boundary, and the title survives', () => {
  const description = Array.from({ length: 2000 }, (_, i) => `word${i}`).join(' ');
  const c = ctx.buildAsrContext({ title: 'Short title', notes: 'a note', description }, TEMPLATE);
  ok(ctx.estimateTokens(c) <= ctx.ASR_CONTEXT_TOKEN_BUDGET, `over budget: ${ctx.estimateTokens(c)}`);
  ok(c.includes('Title: Short title') && c.includes('Notes: a note'), 'a specific field was cut');
  ok(/\nDescription: word0 word1 .*word\d+…$/.test(c), 'description not cut at a word');
});
check('then notes, then promoted items: least specific first, the title last', () => {
  const long = (w) => Array.from({ length: 1500 }, (_, i) => `${w}${i}`).join(' ');
  const c = ctx.buildAsrContext({ title: 'T', names: ['owen morgan'], promotedItems: [long('promo')], notes: long('note'), description: long('desc') }, TEMPLATE);
  ok(ctx.estimateTokens(c) <= ctx.ASR_CONTEXT_TOKEN_BUDGET, 'over budget');
  ok(!c.includes('Description:') && !c.includes('Notes:'), 'description/notes should be gone');
  ok(/Also mentioned: promo0 promo1 .*…$/.test(c) && c.includes('Names: owen morgan') && c.includes('Title: T'), c.slice(0, 300));
});
check('a non-ASCII title counts a token a character and stays under the budget', () => {
  ok(ctx.estimateTokens(ctx.buildAsrContext({ title: '日本語'.repeat(400) }, TEMPLATE)) <= ctx.ASR_CONTEXT_TOKEN_BUDGET, 'over');
});
check('the filename title drops extension, underscores and the queue\'s slot prefix (whisper.cpp\'s seed rule)', () => {
  eq(ctx.titleFromFilename('/Volumes/x/complete/u2 - jake lang.mov'), 'jake lang');
  eq(ctx.titleFromFilename('3 - Greg_Stephens_Show.mp4'), 'Greg Stephens Show');
  eq(ctx.titleFromFilename('2026-09-23 master.mp4'), '2026-09-23 master');
});
check('an earlier run\'s titles, tags and description are found by source key', () => {
  const out = fs.mkdtempSync(path.join(TMP, 'out-'));
  const video = '/Volumes/x/complete/u2 - jake lang.mov';
  const key = require(path.join(ROOT, 'services/metadata/item-identity.js')).sourceKeyOf(video);
  fs.mkdirSync(path.join(out, '.contentstudio', 'metadata'), { recursive: true });
  fs.writeFileSync(path.join(out, '.contentstudio', 'metadata', 'old.json'), JSON.stringify({ created_at: '2026-01-01', items: [{ source_key: key, titles: ['Old'], tags: 'a,b', description: 'old' }] }));
  fs.writeFileSync(path.join(out, '.contentstudio', 'metadata', 'new.json'), JSON.stringify({ created_at: '2026-02-01', items: [{ source_key: key, titles: ['Jake Lang returns'], tags: 'jake lang, j6', description_hook: 'Hook.', description: 'Body.' }] }));
  fs.writeFileSync(path.join(out, '.contentstudio', 'metadata', 'broken.json'), '{');
  const { facts: f, prior } = facts.pipelineItemFacts({ videoPath: video, jobName: 'wk', promptSet: 'youtube-unfiltered', outputDir: out, notes: null, storyTitle: 'u2 - jake lang' });
  eq([prior.titles, prior.tags, prior.description], [['Jake Lang returns'], ['jake lang', 'j6'], 'Hook. Body.']);
  ok(f.names.includes('owen morgan') && f.promotedItems.length > 0, 'the channel\'s brand terms / promoted items');
  eq(f.title, 'jake lang');
});

// ────────────────────────────────────────────────────────────────── progress

section('progress');
check('the server\'s frames read by stage; an unknown stage is null (logged, never guessed)', () => {
  eq(asr.readProgressFrame({ fraction: 0, message: null, extra: { stage: 'decoding', processed_s: 30, total_s: 0 } }), { kind: 'decoding', processedS: 30 });
  eq(asr.readProgressFrame({ fraction: 0.5, message: 'm', extra: { stage: 'aligning', processed_s: 300, total_s: 600 } }),
    { kind: 'working', stage: 'aligning', processedS: 300, totalS: 600, message: 'm' });
  eq(asr.readProgressFrame({ fraction: 0.5, message: null, extra: { stage: 'something' } }), null);
});
check('transcribing and aligning take consecutive bands (never one ratio that runs to the end and back)', () => {
  const band = (p) => door.asrProgressToBand('mac', p, 10, 94).percent;
  eq(band({ kind: 'working', stage: 'transcribing', processedS: 0, totalS: 600, message: null }), 14);
  eq(band({ kind: 'working', stage: 'transcribing', processedS: 600, totalS: 600, message: null }), 69);
  eq(band({ kind: 'working', stage: 'aligning', processedS: 0, totalS: 600, message: null }), 69);
  eq(band({ kind: 'working', stage: 'aligning', processedS: 600, totalS: 600, message: null }), 94);
  ok(band({ kind: 'uploading', sentBytes: 50, totalBytes: 100 }) < band({ kind: 'queued', position: 1 }), 'upload under queued');
});

// ──────────────────────────────────────────────────────────── the job against a fake

/**
 * A scripted Crucible: records every call, admits one asr job, plays `script` as its events.
 * `script` items are events, or 'hang' (wait for a cancel, then play `cancelled`).
 */
function fakeClient({ info, script = [], failSubmit = null, transcript = null, loseFirstSubmitAnswer = false } = {}) {
  const calls = [];
  let cancelled = null;
  const onCancel = [];
  let admitted = null;
  let submits = 0;
  const client = {
    calls,
    async info() {
      calls.push(['info']);
      return info ?? {
        server: { version: '1.0.35' }, host: { backend: 'mlx-darwin' }, jobTypes: ['asr', 'align'],
        capabilities: [{ jobType: 'asr', models: [{ id: 'qwen3-asr-1.7b', installed: true }] }, { jobType: 'align', models: [{ id: 'qwen3-aligner', installed: true }] }],
      };
    },
    async upload(blob, { filename }) { calls.push(['upload', filename, blob.size]); return { blobId: 'blob-1' }; },
    async submit(req) {
      calls.push(['submit', JSON.parse(JSON.stringify(req))]);
      submits++;
      if (failSubmit) throw failSubmit;
      admitted = 'job-1';
      if (loseFirstSubmitAnswer && submits === 1) { const e = new Error('socket hang up'); e.name = 'CrucibleUnreachable'; throw e; }
      return admitted;
    },
    async job(id) { calls.push(['job', id]); return { clientRef: calls.find((c) => c[0] === 'submit')[1].clientRef }; },
    async activity() { calls.push(['activity']); return { running: admitted ? [{ jobId: admitted, type: 'asr' }] : [], queued: [] }; },
    async *events(id) {
      calls.push(['events', id]);
      let n = 0;
      for (const item of script) {
        if (item === 'hang') {
          await new Promise((resolve) => { if (cancelled) resolve(); else onCancel.push(resolve); });
          yield { id: ++n, event: 'cancelled', data: { status: 'cancelled' } };
          return;
        }
        yield { id: ++n, ...item };
        if (['done', 'failed', 'cancelled'].includes(item.event)) return;
      }
    },
    async artifact(id, name) { calls.push(['artifact', id, name]); return new TextEncoder().encode(JSON.stringify(transcript ?? doc([{ start: 0, end: 1, text: 'Hi.' }]))); },
    async cancel(id) { calls.push(['cancel', id]); cancelled = id; onCancel.splice(0).forEach((r) => r()); return { status: 'cancelling' }; },
  };
  return client;
}
const progressEv = (stage, processed, total) => ({ event: 'progress', data: { fraction: 0, message: null, extra: { stage, processed_s: processed, total_s: total } } });
const FAST = { doorDelaysMs: [1, 1], streamDelaysMs: [1, 1], uploadTickMs: 5 };

section('the job (asr.ts) against a scripted Crucible');
check('upload → submit (model, params exactly, one named input, a clientRef) → events → transcript.json', async () => {
  const client = fakeClient({ script: [{ event: 'queued', data: { position: 1 } }, progressEv('transcribing', 60, 120), progressEv('aligning', 120, 120), { event: 'done', data: {} }] });
  const seen = [];
  const out = await asr.runAsrJob({ venue: { server: 'mac', client }, params: asr.asrParams('C'), file: AUDIO, filename: 'clip.flac', clientRef: 'contentstudio:test:1', onProgress: (p) => seen.push(p.kind), ...FAST });
  const submit = client.calls.find((c) => c[0] === 'submit')[1];
  eq(submit, { type: 'asr', model: 'qwen3-asr-1.7b', params: { language: 'en', vad_filter: false, word_timestamps: true, context: 'C' }, inputs: { 'clip.flac': { blobId: 'blob-1' } }, clientRef: 'contentstudio:test:1' });
  eq(client.calls.map((c) => c[0]), ['upload', 'submit', 'events', 'artifact']);
  eq(out.jobId, 'job-1');
  ok(seen.includes('queued') && seen.includes('working'), `progress kinds: ${seen}`);
});
check('cancel → DELETE on the server, and the job ends cancelled (never abandoned)', async () => {
  const client = fakeClient({ script: [progressEv('transcribing', 10, 100), 'hang'] });
  const abort = new AbortController();
  const p = asr.runAsrJob({ venue: { server: 'mac', client }, params: asr.asrParams('C'), file: AUDIO, filename: 'clip.flac', clientRef: 'r', signal: abort.signal, ...FAST });
  setTimeout(() => abort.abort(), 20);
  const e = await rejects(p);
  eq([e.kind, e.jobId], ['cancelled', 'job-1']);
  ok(client.calls.some((c) => c[0] === 'cancel' && c[1] === 'job-1'), 'no DELETE was sent');
});
check('a failed job fails with the SERVER\'s code and message, loop range included', async () => {
  const message = 'the piece at 3600.0-3780.0s (1:00:00-1:03:00) still loops after re-decoding at every window in the budget (180 s, 60 s, 20 s)';
  const client = fakeClient({ script: [{ event: 'failed', data: { error: { code: 'asr_decode_loop', message } } }] });
  const e = await rejects(asr.runAsrJob({ venue: { server: 'mac', client }, params: asr.asrParams('C'), file: AUDIO, filename: 'clip.flac', clientRef: 'r', ...FAST }));
  eq([e.kind, e.code], ['failed', 'asr_decode_loop']);
  ok(e.message.includes(message), e.message);
});
check('a missing model or aligner refuses BY NAME before any upload (never whisper)', async () => {
  const noAligner = fakeClient({ info: { server: { version: '1.0.35' }, host: { backend: 'mlx-darwin' }, jobTypes: ['asr', 'align'], capabilities: [{ jobType: 'asr', models: [{ id: 'qwen3-asr-1.7b', installed: true }] }, { jobType: 'align', models: [{ id: 'qwen3-aligner', installed: false }] }] } });
  const e1 = await rejects(asr.requireAsrOffer({ server: 'mac', client: noAligner }));
  ok(e1.kind === 'unavailable' && /qwen3-aligner/.test(e1.message), e1.message);
  const onlyMlx = fakeClient({ info: { server: { version: '1.0.35' }, host: { backend: 'mlx-darwin' }, jobTypes: ['asr', 'align'], capabilities: [{ jobType: 'asr', models: [{ id: 'qwen3-asr-1.7b-mlx', installed: true }] }, { jobType: 'align', models: [{ id: 'qwen3-aligner', installed: true }] }] } });
  const e2 = await rejects(asr.requireAsrOffer({ server: 'mac', client: onlyMlx }));
  ok(/does not offer qwen3-asr-1\.7b/.test(e2.message), e2.message);
  eq([noAligner.calls.some((c) => c[0] === 'upload'), onlyMlx.calls.some((c) => c[0] === 'upload')], [false, false]);
});
check('a busy lane fails the item with the holder\'s line (P3 will park it)', async () => {
  const busy = new Error('409'); busy.name = 'CrucibleBusy'; busy.code = 'server_busy'; busy.busyLine = 'BookForge is narrating on mac (job j-9)';
  const e = await rejects(asr.runAsrJob({ venue: { server: 'mac', client: fakeClient({ failSubmit: busy }) }, params: asr.asrParams('C'), file: AUDIO, filename: 'clip.flac', clientRef: 'r', ...FAST }));
  eq(e.kind, 'busy');
  ok(e.message.includes('BookForge is narrating'), e.message);
});
check('a submit whose answer was lost is found by its clientRef, not sent twice', async () => {
  const client = fakeClient({ loseFirstSubmitAnswer: true, script: [{ event: 'done', data: {} }] });
  const out = await asr.runAsrJob({ venue: { server: 'mac', client }, params: asr.asrParams('C'), file: AUDIO, filename: 'clip.flac', clientRef: 'lost-1', ...FAST });
  eq(out.jobId, 'job-1');
  eq(client.calls.filter((c) => c[0] === 'submit').length, 1, 'submits:');
});
check('the door refuses by name when no Crucible is connected (and never runs whisper)', async () => {
  door.setAsrVenueResolver(null);
  const e = await rejects(door.transcribeOnCrucible({ audioFile: AUDIO, context: 'C', clientRefStem: 't', tag: 't', band: { from: 0, to: 100 } }));
  eq([e.kind, e.code], ['unavailable', 'crucible_not_connected']);
});
check('the door serializes this app\'s jobs per server and names the model crucible:<server>:qwen3-asr-1.7b', async () => {
  const order = [];
  let live = 0;
  const mk = (tag) => ({
    ...fakeClient({ script: [{ event: 'done', data: {} }] }),
  });
  const client = mk();
  const realSubmit = client.submit.bind(client);
  client.submit = async (req) => { live++; ok(live === 1, 'two jobs in flight on one server'); order.push(req.clientRef.split(':')[1]); return realSubmit(req); };
  const realArtifact = client.artifact.bind(client);
  client.artifact = async (...a) => { await new Promise((r) => setTimeout(r, 10)); live--; return realArtifact(...a); };
  door.setAsrVenueResolver(() => ({ server: 'mac', client }));
  const run = (n) => door.transcribeOnCrucible({ audioFile: AUDIO, context: 'C', clientRefStem: `n${n}`, tag: `n${n}`, band: { from: 0, to: 100 } });
  const outs = await Promise.all([run(1), run(2), run(3)]);
  eq(order, ['n1', 'n2', 'n3']);
  eq(outs[0].model, 'crucible:mac:qwen3-asr-1.7b');
  door.setAsrVenueResolver(null);
});

// ─────────────────────────────────────────── the editor protocol, through transcribe.py

function editorPython() {
  if (process.env.CS_EDITOR_PYTHON) return process.env.CS_EDITOR_PYTHON;
  const managed = path.join(os.homedir(), 'Library', 'Application Support', 'OwenMorgan', 'runtime', 'autocutstudio-env', 'bin', 'python3');
  if (fs.existsSync(managed)) return managed;
  throw new Error(`No editor Python to run transcribe.py with: set CS_EDITOR_PYTHON (the managed env was not at ${managed})`);
}

/** Run the driver in `mode`, answering its asr_requests with the REAL responder over `client`. */
function driveTranscribePy(mode, client) {
  return new Promise((resolve, reject) => {
    door.setAsrVenueResolver(() => ({ server: 'mac', client }));
    const child = spawn(editorPython(), [path.join(__dirname, 'asr-protocol-driver.py'), mode], { stdio: ['pipe', 'pipe', 'pipe'] });
    const requests = [];
    let result = null;
    let buf = '';
    let err = '';
    const respond = editorAsr.createAsrResponder({
      context: 'C', jobId: 'check', write: (line) => child.stdin.write(line), log: () => undefined,
    });
    child.stdout.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl).trim();
        buf = buf.slice(nl + 1);
        if (!line) continue;
        const msg = JSON.parse(line);
        if (msg.type === 'asr_request') requests.push(msg);
        if (msg.type === 'result') result = msg;
        respond(msg);
      }
    });
    child.stderr.on('data', (d) => { err += d; });
    child.on('close', (code) => {
      door.setAsrVenueResolver(null);
      if (result) resolve({ result, requests, stderr: err });
      else reject(new Error(`driver exited ${code} with no result: ${err.slice(-800)}`));
    });
  });
}

section('the editor protocol (transcribe.py ↔ editor-asr.ts)');
check('loop region round trip: region sent, words come back in slice seconds and are shifted by its start', async () => {
  // The fresh decode of the region: two clean words, in the SLICE's own seconds.
  const client = fakeClient({ script: [{ event: 'done', data: {} }], transcript: doc([{ start: 0, end: 12, text: 'We go home.', words: aligned(['We', 'go', 'home'], 4, 1) }]) });
  const { result, requests } = await driveTranscribePy('loop', client);
  if (result.error) throw new Error(result.error);
  eq(requests.length, 1, 'regions requested:');
  eq(requests[0].trackId, 't0');
  eq(requests[0].region, [7, 18.95], 'region (the run 10.0-15.95 s padded 3 s):');
  const texts = result.words.map((w) => [w.text, +w.file_start.toFixed(2)]);
  eq(texts, [['hello', 1], ['We', 11], ['go', 12], ['home.', 13], ['bye', 50]]);
  eq(result.model, 'crucible:mac:qwen3-asr-1.7b');
  ok(client.calls.find((c) => c[0] === 'submit')[1].clientRef.startsWith('contentstudio:editor:check:t0:loop:'), 'clientRef');
});
check('a failed job reaches transcribe.py as its error, the server\'s message whole', async () => {
  const client = fakeClient({ script: [{ event: 'failed', data: { error: { code: 'asr_decode_loop', message: 'the piece at 7.0-18.9s still loops' } } }] });
  const { result } = await driveTranscribePy('loop', client);
  ok(result.error && result.error.includes('asr_decode_loop') && result.error.includes('7.0-18.9s'), JSON.stringify(result));
});
check('the words reader: probability null → no prob, a number kept, a missing start refused by name', async () => {
  const { result } = await driveTranscribePy('reader', fakeClient());
  eq(result.words, [{ text: 'Hello,', file_start: 0.5, file_end: 0.9 }, { text: 'um', file_start: 1.0, file_end: 1.2, prob: 0.5 }]);
  ok(/words\[0\] has no numeric start\/end/.test(result.refused), result.refused);
  ok(/neither a 'words' list/.test(result.refusedShape), result.refusedShape);
});

(async () => {
  for (const run of pending) await run();
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
