#!/usr/bin/env node
/**
 * Score a transcript's captions against an enrolled voice and report how the HOST / CLIP /
 * UNSURE calls come out — the measurement the thresholds in speaker-embedding.ts were set from,
 * runnable again on new material.
 *
 * IT USES THE PRODUCTION CODE, not a copy of it. Everything below the argument parsing goes
 * through the compiled `dist/main/services/metadata/speaker-embedding.js`, so a change to the
 * model, the WAV reader, the normalisation or the thresholds shows up here immediately. A
 * validation harness with its own second implementation validates the harness.
 *
 *   npm run build:electron
 *   node scripts/validate-speaker-tagging.js \
 *     --model      utilities/models/nemo_en_titanet_small.onnx \
 *     --enrollment owen-enroll.wav \
 *     --audio      video.wav \
 *     --segments   transcript.json \
 *     [--truth ground-truth.json]
 *
 * `--audio` and `--enrollment` are 16 kHz mono 16-bit WAVs, which is what ffmpeg's
 * `extractAudio` produces and therefore what the pipeline itself scores. Convert with:
 *   ffmpeg -i input -vn -acodec pcm_s16le -ar 16000 -ac 1 out.wav
 *
 * `--segments` is a JSON array of `{ start, end, text }` in SRT time format, or any JSON object
 * with an `srtSegments` array somewhere in it (a saved-transcript record works as-is).
 *
 * `--truth`, when given, is a JSON array of `[start, similarity, text]` from an independently
 * scored run. It turns the report into an AGREEMENT test: the captions the reference scored
 * unambiguously — at or above 0.7, at or below 0.2 — must come out HOST and CLIP here. Those are
 * the calls a wrong answer is visible in; the middle of a reference distribution is where the
 * genuinely mixed captions live and neither run is authoritative about them.
 */

const fs = require('fs');
const path = require('path');

const REPO = path.resolve(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'main', 'services', 'metadata', 'speaker-embedding.js');

function fail(message) {
  console.error(`\n${message}\n`);
  process.exit(1);
}

const args = {};
for (let i = 2; i < process.argv.length; i += 2) {
  const key = process.argv[i];
  if (!key.startsWith('--')) fail(`Unexpected argument "${key}"`);
  args[key.slice(2)] = process.argv[i + 1];
}
for (const required of ['model', 'enrollment', 'audio', 'segments']) {
  if (!args[required]) fail(`Missing --${required}. See the comment at the top of this file.`);
}
if (!fs.existsSync(DIST)) {
  fail(`${DIST} is not built. Run \`npm run build:electron\` first — this script deliberately has ` +
       `no implementation of its own.`);
}

const { SpeakerEmbeddingModel, readPcm16Mono, cosineSimilarity, verdictFor,
        HOST_SIMILARITY, CLIP_SIMILARITY, MIN_SCOREABLE_SECONDS, EMBEDDING_SAMPLE_RATE } = require(DIST);

/** Find the segment array wherever the caller's JSON keeps it. */
function readSegments(file) {
  const parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (Array.isArray(parsed) && parsed.length > 0 && typeof parsed[0].start === 'string') return parsed;
  const found = [];
  const walk = (node) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.srtSegments)) found.push(node.srtSegments);
    for (const value of Object.values(node)) {
      if (Array.isArray(value)) value.forEach(walk); else walk(value);
    }
  };
  walk(parsed);
  if (found.length !== 1) {
    fail(`${file} holds ${found.length} srtSegments arrays; pass a file with exactly one, or a ` +
         `plain array of {start,end,text}.`);
  }
  return found[0];
}

const toSeconds = (srt) => {
  const parts = srt.split(/[:,]/).map(Number);
  return parts[0] * 3600 + parts[1] * 60 + parts[2] + parts[3] / 1000;
};

const segments = readSegments(args.segments);
const model = new SpeakerEmbeddingModel(args.model);
const reference = model.embed(readPcm16Mono(args.enrollment));
const samples = readPcm16Mono(args.audio);

console.log(`model ${path.basename(args.model)} (${model.dim}-dim), ${segments.length} captions, ` +
            `${(samples.length / EMBEDDING_SAMPLE_RATE / 60).toFixed(1)} minutes of audio`);
console.log(`thresholds: HOST >= ${HOST_SIMILARITY}, CLIP <= ${CLIP_SIMILARITY}\n`);

const started = Date.now();
const scored = segments.map((segment) => {
  const startSec = toSeconds(segment.start);
  const endSec = toSeconds(segment.end);
  if (!(endSec - startSec >= MIN_SCOREABLE_SECONDS)) {
    return { start: segment.start, similarity: null, verdict: 'unsure', text: segment.text };
  }
  const slice = samples.subarray(
    Math.floor(startSec * EMBEDDING_SAMPLE_RATE), Math.floor(endSec * EMBEDDING_SAMPLE_RATE));
  const similarity = cosineSimilarity(reference, model.embed(slice));
  return { start: segment.start, similarity, verdict: verdictFor(similarity), text: segment.text };
});
const elapsed = (Date.now() - started) / 1000;

const count = (verdict) => scored.filter((row) => row.verdict === verdict).length;
const tooShort = scored.filter((row) => row.similarity === null).length;
console.log(`${count('host')} HOST, ${count('clip')} CLIP, ${count('unsure')} UNSURE ` +
            `(${tooShort} of those too short to score) in ${elapsed.toFixed(1)}s`);

if (!args.truth) process.exit(0);

const truth = JSON.parse(fs.readFileSync(args.truth, 'utf8'));
if (truth.length !== scored.length) {
  fail(`The ground truth has ${truth.length} entries and the transcript has ${scored.length}. ` +
       `They have to be the same captions in the same order.`);
}

const unambiguous = { host: [], clip: [] };
scored.forEach((row, i) => {
  const reference = truth[i][1];
  if (typeof reference !== 'number') return;
  if (reference >= 0.7) unambiguous.host.push(row);
  else if (reference <= 0.2) unambiguous.clip.push(row);
});

let disagreements = 0;
let deferred = 0;
for (const [expected, rows] of Object.entries(unambiguous)) {
  const agreed = rows.filter((row) => row.verdict === expected).length;
  const unsure = rows.filter((row) => row.verdict === 'unsure').length;
  const wrong = rows.length - agreed - unsure;
  disagreements += wrong;
  deferred += unsure;
  const scores = rows.filter((r) => r.similarity !== null).map((r) => r.similarity);
  console.log(`\nunambiguous ${expected.toUpperCase()} in the reference: ${rows.length} captions, ` +
              `scored ${Math.min(...scores).toFixed(3)}–${Math.max(...scores).toFixed(3)} here`);
  console.log(`  agreed ${agreed}, deferred to UNSURE ${unsure}, CALLED THE OTHER SIDE ${wrong}`);
  for (const row of rows.filter((r) => r.verdict !== expected)) {
    console.log(`    ${row.start} ${row.similarity === null ? 'unscored' : row.similarity.toFixed(3)} ` +
                `-> ${row.verdict.toUpperCase()}  ${row.text.trim().slice(0, 70)}`);
  }
}

console.log(`\n${disagreements === 0 && deferred === 0 ? 'AGREEMENT: 100%' : 'AGREEMENT: incomplete'} ` +
            `over ${unambiguous.host.length + unambiguous.clip.length} unambiguous captions ` +
            `(${disagreements} inverted, ${deferred} deferred to UNSURE)`);
process.exit(disagreements === 0 ? 0 : 1);
