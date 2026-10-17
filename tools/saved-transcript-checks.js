#!/usr/bin/env node
/**
 * Saved transcripts beside the video (LEDGER #313): the sidecar path, the save/read round trip
 * with its stamp and name checks, the unwritable-folder refusal, and the one move of the old
 * output-directory store (the per-record decision and a whole run on a temp folder). Pure: no
 * Crucible, no app; every file lives in a temp folder removed at the end.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main');
const S = require(path.join(ROOT, 'services/metadata/saved-transcript.service.js'));
const M = require(path.join(ROOT, 'services/metadata/saved-transcript-migration.js'));
const { sourceKeyOf } = require(path.join(ROOT, 'services/metadata/item-identity.js'));

let failures = 0;
const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name} :: ${e.message}`); }
  })());
}
function eq(a, e, what) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what} expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }
function throwsLike(fn, re, what) {
  try { fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${what}: threw "${e.message}", expected ${re}`); return; }
  throw new Error(`${what}: did not throw`);
}

const TMP = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-saved-transcript-'));
const SEGMENTS = [{ index: 1, start: '00:00:00,000', end: '00:00:02,000', text: 'hello there' }];
function video(rel, bytes = 'a video') {
  const p = path.join(TMP, rel);
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, bytes);
  return p;
}
function save(videoPath) {
  return S.saveTranscript({ videoPath, segments: SEGMENTS, durationSec: 2, whisperModel: 'crucible:mac:qwen3-asr-0.6b', words: null, speakerTagging: null });
}

check('the sidecar sits beside the video, named by its whole file name', () => {
  eq(S.savedTranscriptPathFor('/v/2026-10-17/complete/u1 - x.mov'), '/v/2026-10-17/complete/.contentstudio/transcripts/u1 - x.mov.json', 'path');
  // One source key, two records: the .mov and the .mp3 of one episode no longer share a file.
  eq(sourceKeyOf('/w/complete/p 1.mov') === sourceKeyOf('/w/complete/p 1.mp3'), true, 'shared source key');
  eq(S.savedTranscriptPathFor('/w/complete/p 1.mov') !== S.savedTranscriptPathFor('/w/complete/p 1.mp3'), true, 'distinct sidecars');
});

check('a relative video path is refused by name', () => {
  throwsLike(() => S.savedTranscriptPathFor('complete/u1.mov'), /absolute video path/, 'relative');
});

check('save then inspect: the record is found beside the video and reused', () => {
  const v = video('a/complete/u1.mov');
  const reuse = save(v);
  eq(reuse.record_path, S.savedTranscriptPathFor(v), 'record_path');
  eq(fs.existsSync(reuse.record_path), true, 'written');
  const lookup = S.inspectSavedTranscript(v);
  eq(lookup.exists, true, 'exists');
  eq(S.loadSavedTranscript(v).record.segments.length, 1, 'segments');
});

check('a video changed since is refused, and the load says why by name', () => {
  const v = video('b/complete/u2.mov');
  save(v);
  fs.writeFileSync(v, 'a longer re-rendered video');
  const lookup = S.inspectSavedTranscript(v);
  eq(lookup.exists, false, 'exists');
  if (!/has changed since it was transcribed/.test(lookup.reason)) throw new Error(lookup.reason);
  throwsLike(() => S.loadSavedTranscript(v), /cannot be used: the video has changed/, 'load');
});

check('a record copied in from another file name is refused', () => {
  const a = video('c/complete/u3.mov');
  const b = video('c/complete/u4.mov');
  save(a);
  fs.mkdirSync(path.dirname(S.savedTranscriptPathFor(b)), { recursive: true });
  fs.copyFileSync(S.savedTranscriptPathFor(a), S.savedTranscriptPathFor(b));
  const lookup = S.inspectSavedTranscript(b);
  eq(lookup.exists, false, 'exists');
  if (!/not from a file named "u4.mov"/.test(lookup.reason)) throw new Error(lookup.reason);
});

check('a week moved whole carries its sidecar, and the record still reads', () => {
  const v = video('d/2026-10-01/complete/u5.mov');
  save(v);
  const moved = path.join(TMP, 'nas', '2026-10-01');
  fs.mkdirSync(path.dirname(moved), { recursive: true });
  fs.cpSync(path.join(TMP, 'd', '2026-10-01'), moved, { recursive: true, preserveTimestamps: true });
  const at = path.join(moved, 'complete', 'u5.mov');
  fs.utimesSync(at, fs.statSync(v).atime, fs.statSync(v).mtime);
  eq(S.inspectSavedTranscript(at).exists, true, 'exists after the move');
});

check('another schema is refused', () => {
  const v = video('e/complete/u6.mov');
  save(v);
  const p = S.savedTranscriptPathFor(v);
  const rec = JSON.parse(fs.readFileSync(p, 'utf-8'));
  rec.schema_version = 1;
  fs.writeFileSync(p, JSON.stringify(rec));
  const lookup = S.inspectSavedTranscript(v);
  eq(lookup.exists, false, 'exists');
  if (!/schema_version 1/.test(lookup.reason)) throw new Error(lookup.reason);
});

check('an unwritable video folder fails before transcribing, naming it, and the save fails too', () => {
  if (process.getuid && process.getuid() === 0) return; // root writes anywhere; nothing to test
  const v = video('f/complete/u7.mov');
  const dir = path.dirname(v);
  fs.chmodSync(dir, 0o555);
  try {
    throwsLike(() => S.assertSavedTranscriptWritable(v), new RegExp(`${dir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} cannot be written`), 'assert');
    throwsLike(() => save(v), /Could not save the transcript for u7.mov/, 'save');
  } finally {
    fs.chmodSync(dir, 0o755);
  }
  S.assertSavedTranscriptWritable(v); // writable again: no throw
});

// ── The one move of the old store ──────────────────────────────────────────────────────

function legacyRecord(videoPath, over = {}) {
  const st = fs.statSync(videoPath);
  return {
    schema_version: S.SAVED_TRANSCRIPT_SCHEMA_VERSION, source_key: sourceKeyOf(videoPath), source_path: videoPath,
    video: { size: st.size, mtimeMs: Math.round(st.mtimeMs) }, whisper_model: 'base', saved_at: '2026-09-01T00:00:00.000Z',
    duration_sec: 2, speaker_tagging: null, segments: SEGMENTS, ...over,
  };
}
function facts(over) {
  return { record: null, parseError: null, video: { size: 7, mtimeMs: 1000 }, videoError: null, sidecarExists: false, ...over };
}

check('the decision: a matching record moves, everything else stays with its reason', () => {
  const rec = { schema_version: S.SAVED_TRANSCRIPT_SCHEMA_VERSION, source_path: '/w/complete/u1.mov', video: { size: 7, mtimeMs: 1000 }, segments: SEGMENTS };
  eq(M.decideLegacyRecord(facts({ record: rec })), { action: 'move', videoPath: '/w/complete/u1.mov', sidecarPath: '/w/complete/.contentstudio/transcripts/u1.mov.json' }, 'move');
  const leave = (f, re, what) => {
    const d = M.decideLegacyRecord(facts(f));
    if (d.action !== 'leave' || !re.test(d.reason)) throw new Error(`${what}: ${JSON.stringify(d)}`);
  };
  leave({ parseError: 'Unexpected token' }, /cannot be read/, 'unparseable');
  leave({ record: { ...rec, schema_version: 1 } }, /schema_version 1/, 'old schema');
  leave({ record: { ...rec, source_path: 'u1.mov' } }, /no absolute video path/, 'relative source');
  leave({ record: { ...rec, segments: [] } }, /no segments/, 'empty');
  leave({ record: rec, video: null, videoError: 'ENOENT' }, /cannot be read \(ENOENT\).*nothing reads/, 'video gone');
  leave({ record: rec, video: { size: 8, mtimeMs: 1000 } }, /has changed since/, 'size moved');
  leave({ record: rec, video: { size: 7, mtimeMs: 2000 } }, /has changed since/, 'mtime moved');
  leave({ record: { ...rec, video: undefined } }, /no video stamp/, 'no stamp');
  leave({ record: rec, sidecarExists: true }, /already sits beside the video/, 'sidecar wins');
  // Sub-millisecond tails do not condemn a record (LEDGER #49).
  eq(M.decideLegacyRecord(facts({ record: rec, video: { size: 7, mtimeMs: 1000.4 } })).action, 'move', 'sub-ms tail');
});

check('a whole run: moves the matching records, leaves the rest, and keeps the old store while it holds any', async () => {
  const out = path.join(TMP, 'output');
  const store = M.legacySavedTranscriptDir(out);
  fs.mkdirSync(store, { recursive: true });
  const good = video('g/complete/u8.mov');
  const stale = video('g/complete/u9.mov');
  const gone = path.join(TMP, 'g', 'complete', 'gone.mov');
  const goodRec = legacyRecord(good);
  fs.writeFileSync(path.join(store, `${sourceKeyOf(good)}.json`), JSON.stringify(goodRec));
  fs.writeFileSync(path.join(store, `${sourceKeyOf(stale)}.json`), JSON.stringify(legacyRecord(stale, { video: { size: 1, mtimeMs: 1 } })));
  fs.writeFileSync(path.join(store, 'gone.json'), JSON.stringify({ ...goodRec, source_path: gone }));
  fs.writeFileSync(path.join(store, 'junk.json'), '{not json');

  const summary = await M.migrateLegacySavedTranscripts([out, out]);
  eq(summary, { moved: 1, left: 3 }, 'summary');
  eq(fs.existsSync(path.join(store, `${sourceKeyOf(good)}.json`)), false, 'moved record gone from the old store');
  eq(JSON.parse(fs.readFileSync(S.savedTranscriptPathFor(good), 'utf-8')), goodRec, 'sidecar is the record, byte for byte');
  eq(S.inspectSavedTranscript(good).exists, true, 'the reader accepts the moved record');
  eq(fs.readdirSync(store).sort(), ['gone.json', 'junk.json', `${sourceKeyOf(stale)}.json`].sort(), 'left untouched');
  eq(fs.existsSync(S.savedTranscriptPathFor(stale)), false, 'nothing written for the stale one');

  // A second start moves nothing more and leaves the same three.
  eq(await M.migrateLegacySavedTranscripts([out]), { moved: 0, left: 3 }, 'second start');

  // Emptied, the old store folder is removed.
  for (const n of fs.readdirSync(store)) fs.rmSync(path.join(store, n));
  fs.writeFileSync(path.join(store, 'last.json'), JSON.stringify(legacyRecord(video('h/complete/u10.mov'))));
  eq(await M.migrateLegacySavedTranscripts([out]), { moved: 1, left: 0 }, 'last record');
  eq(fs.existsSync(store), false, 'empty old store removed');
  // No old store at all: nothing to do, nothing thrown.
  eq(await M.migrateLegacySavedTranscripts([path.join(TMP, 'never')]), { moved: 0, left: 0 }, 'no store');
});

check('the move runs once: started with no record of a run it runs and marks it, and a later start does not', async () => {
  await M.savedTranscriptMigrationSettled(); // a process that never started the move does not wait
  const out = path.join(TMP, 'once');
  const store = M.legacySavedTranscriptDir(out);
  fs.mkdirSync(store, { recursive: true });
  const v = video('i/complete/u11.mov');
  fs.writeFileSync(path.join(store, 'u11.json'), JSON.stringify(legacyRecord(v)));
  let ran;
  const summary = await M.startSavedTranscriptMigration([out], { ranAt: () => ran, markRan: (at) => { ran = at; } });
  eq(summary, { moved: 1, left: 0 }, 'first start');
  if (typeof ran !== 'string') throw new Error('not marked as run');
  await M.savedTranscriptMigrationSettled();
  eq(fs.existsSync(S.savedTranscriptPathFor(v)), true, 'moved');
  // A later start (a fresh module, as a new process has) with the run recorded moves nothing.
  const file = require.resolve(path.join(ROOT, 'services/metadata/saved-transcript-migration.js'));
  delete require.cache[file];
  const later = require(file);
  const w = video('i/complete/u12.mov');
  fs.mkdirSync(store, { recursive: true }); // the first run emptied and removed it
  fs.writeFileSync(path.join(store, 'u12.json'), JSON.stringify(legacyRecord(w)));
  eq(await later.startSavedTranscriptMigration([out], { ranAt: () => ran, markRan: () => { throw new Error('marked twice'); } }), null, 'later start');
  eq(fs.existsSync(path.join(store, 'u12.json')), true, 'left alone');
});

Promise.all(pending).then(() => {
  fs.rmSync(TMP, { recursive: true, force: true });
  console.log(failures === 0 ? '\nall saved-transcript checks passed' : `\n${failures} saved-transcript check(s) FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
