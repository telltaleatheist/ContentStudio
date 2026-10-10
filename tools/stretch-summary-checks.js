#!/usr/bin/env node
/**
 * The stretch summary (LEDGER #288): the cut, the prompt, the calls, and what reads it.
 * Pure: no model, no server. Runs against dist/ and the repo's own prompt tree.
 */
const path = require('path');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};

const ROOT = path.join(__dirname, '..', 'dist', 'main');
const ASSETS_DIR = path.join(__dirname, '..', 'electron', 'assets');
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
promptAssetsModule.initPromptAssets(path.join(ASSETS_DIR, 'prompts'));
const S = require(path.join(ROOT, 'services/metadata/stretch-summary.js'));
const aiManagerModule = require(path.join(ROOT, 'services/metadata/ai-manager.service.js'));
const routing = require(path.join(ROOT, 'services/metadata/metadata-routing.js'));
const thumbPrompts = require(path.join(ROOT, 'services/thumbnails/prompts.js'));

let failures = 0;
const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (error) {
      failures++;
      console.log(`FAIL  ${name} :: ${error.message}`);
    }
  })());
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual), e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what} expected ${e}, got ${a}`);
}
function has(text, needle, what) { if (!text.includes(needle)) throw new Error(`${what}: missing ${JSON.stringify(needle)}`); }
function hasNot(text, needle, what) { if (text.includes(needle)) throw new Error(`${what}: should not contain ${JSON.stringify(needle)}`); }

const srt = (t) => {
  const h = Math.floor(t / 3600), m = Math.floor((t % 3600) / 60), s = Math.floor(t % 60);
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')},000`;
};
/** One caption every 5 s for `seconds`, text naming its own time. */
function captions(seconds, speaker) {
  const out = [];
  for (let t = 0; t < seconds; t += 5) out.push({ index: out.length + 1, start: srt(t), end: srt(t + 5), text: `said at ${t}`, ...(speaker ? { speaker, speakerLabel: speaker } : {}) });
  return out;
}

check('the cut: ~5-minute stretches, never across a section, every caption in exactly one', () => {
  const segs = captions(2822);
  const plain = S.stretchesOf(segs, 2822);
  eq(plain.length, 9, 'a 47-minute video with no sections, in stretches:');
  const cut = S.stretchesOf(segs, 2822, [489, 2764]);
  eq(cut.map((x) => S.clockOf(x.start)), ['0:00', '4:04', '8:09', '12:53', '17:37', '22:22', '27:06', '31:50', '36:35', '41:19', '46:04'],
    'u4\'s sections (0:00, 8:09, 46:04): the 38-minute one in 8 parts, the 58 s one alone:');
  for (const boundary of [489, 2764]) {
    if (cut.some((x) => x.start < boundary && x.end > boundary)) throw new Error(`a stretch crosses the section at ${boundary} s`);
  }
  eq(cut.reduce((n, x) => n + x.segments.length, 0), segs.length, 'captions, each in one stretch:');
  const late = [...segs, { index: 999, start: srt(2830), end: srt(2831), text: 'past the stated end' }];
  if (!S.stretchesOf(late, 2822).at(-1).segments.some((s) => s.index === 999)) throw new Error('a caption past the stated length was dropped');
  eq(S.clockSeconds('8:09'), 489, 'a chapter timestamp:');
  eq(S.clockSeconds('1:02:03'), 3723, 'past an hour:');
});

check('the prompt: every slot filled, the speaker labels explained only when they are there, a $ kept', () => {
  const [stretch] = S.stretchesOf(captions(300), 300);
  const p = S.stretchPrompt(stretch, 2822);
  has(p, '0:00 to 5:00 of a 47:02 video', 'the stretch and the video');
  has(p, 'said at 295', 'its transcript');
  hasNot(p, 'HOST is the host', 'no label sentence on an untagged stretch');
  if (/\{[a-z_]+\}/.test(p)) throw new Error('an unfilled slot: ' + p.match(/\{[a-z_]+\}/)[0]);
  const mixed = captions(300, 'HOST').map((c, i) => (i % 3 === 0 ? { ...c, speaker: 'CLIP', speakerLabel: 'CLIP' } : c));
  const [tagged] = S.stretchesOf(mixed, 300);
  has(S.stretchPrompt(tagged, 300), 'HOST is the host, CLIP is a clip he plays', 'the label sentence on a tagged stretch');
  const dollars = [{ index: 1, start: srt(0), end: srt(5), text: 'he wants $1,000 and $& more' }];
  has(S.stretchPrompt(S.stretchesOf(dollars, 5)[0], 5), 'he wants $1,000 and $& more', 'a $ in the transcript');
});

check('the calls: one per stretch in order on the routed option, its model recorded; an empty answer fails naming the stretch', async () => {
  const sent = [];
  const ai = { runPlainRequest: async (prompt, model, what, shape) => { sent.push({ what, model, shape }); return `  paragraph ${sent.length}\n  continued `; } };
  const option = { kind: 'local', id: 'qwen35-9b', label: '9B', model: 'qwen3.5-9b' };
  const summary = await S.summarizeStretches({ aiManager: ai, option, segments: captions(900), durationSec: 900, sectionStarts: [], sourceLabel: 'v.mov' });
  eq(summary.paragraphs.map((p) => p.text), ['paragraph 1 continued', 'paragraph 2 continued', 'paragraph 3 continued'], 'paragraphs, whitespace folded:');
  eq(summary.model, 'qwen3.5-9b', 'the model:');
  eq(sent.map((c) => c.what.replace(/.*, /, '')), ['0:00-5:00 (1 of 3)', '5:00-10:00 (2 of 3)', '10:00-15:00 (3 of 3)'], 'in order:');
  if (!(sent[0].shape.maxTokens > 0) || sent[0].shape.thinking !== false) throw new Error('a local call states its output budget, thinking off');
  const empty = { runPlainRequest: async () => '   ' };
  let threw = null;
  try { await S.summarizeStretches({ aiManager: empty, option, segments: captions(600), durationSec: 600, sectionStarts: [], sourceLabel: 'v.mov' }); } catch (e) { threw = e; }
  if (!threw || !/0:00-5:00 \(1 of 2\) came back empty/.test(threw.message)) throw new Error('an empty paragraph was not refused by name: ' + (threw && threw.message));
});

check('the routing: a Summary row, the 9B by default, in its own group so it is never planned as a field', () => {
  const row = routing.METADATA_ROUTING_TASKS.find((t) => t.id === 'summary');
  if (!row) throw new Error('no summary row');
  eq([row.defaultOptionId, row.group, row.modal], ['qwen35-9b', 'passes', true], 'default, group, shown:');
  if (routing.metadataRunTasks().some((t) => t.id === 'summary')) throw new Error('the summary row is planned as a field unit');
  if (!row.options.includes('qwen38-27b') || !row.options.includes('claude-cli')) throw new Error('the 27B and claude -p are offered');
  // The cleanup (LEDGER #294): its own row, the 27B or claude -p, never planned as a field; the scrub reads it.
  const cleanup = routing.METADATA_ROUTING_TASKS.find((t) => t.id === 'cleanup');
  eq([cleanup.options, cleanup.defaultOptionId, cleanup.group], [['claude-cli', 'qwen38-27b'], 'claude-cli', 'passes'], 'the cleanup row, claude -p by default:');
  if (routing.metadataRunTasks().some((t) => t.id === 'cleanup')) throw new Error('the cleanup row is planned as a field unit');
  eq(require(path.join(ROOT, 'services/metadata/scrub.js')).SCRUB_ROUTING_TASK, 'cleanup', 'the scrub reads the cleanup row:');
});

const SUMMARY = { stretchSeconds: 300, model: 'qwen3.5-9b', speakerTagged: false, paragraphs: [{ start: 0, text: 'Metaxas claims the German church failed to stand.' }, { start: 489, text: 'The host says Hindenburg was never chancellor.' }] };

check('the fields: titles, thumbnail text and the pinned comment read the summary in place of the transcript; the description does not', () => {
  const manager = new aiManagerModule.AIManagerService({ transcriptCeiling: 'local', promptSet: 'youtube-telltale', promptSetsDir: ASSETS_DIR });
  manager.loadPrompts();
  const TRANSCRIPT = 'THE WHOLE TRANSCRIPT '.repeat(50);
  const ctx = (stretchSummary) => ({
    content: TRANSCRIPT, contentMode: 'raw-transcript', sourceLabel: 'u4 - metaxas.mov',
    chapterSubjects: ['Metaxas rebutted'], chapterDetails: ['The chapter detail.'],
    digestChapters: [{ timestamp: '0:00', title: 'Metaxas rebutted', detail: 'The chapter detail.' }],
    stretchSummary, videoTitle: 'u4 - metaxas', promptSetName: 'youtube-telltale',
    entities: [], phrases: [], contentText: TRANSCRIPT, contentSpeakerTagged: false, generated: { titles: ['a title'] }, warn: () => {},
  });
  // Only the fields this set defines: no shipped channel lists thumbnail_text any more (the
  // thumbnail words replaced it), so it is checked wherever a set still carries it.
  const available = manager.promptSetSectionKeys();
  const fields = aiManagerModule.SUMMARY_READING_FIELDS.filter((f) => available.has(f.toUpperCase()));
  if (!fields.includes('titles') || !fields.includes('pinned_comment')) throw new Error(`telltale should define titles and pinned_comment: ${fields}`);
  for (const field of fields) {
    const spec = { field, model: 'anthropic/claude-sonnet-5', insights: false, inputFields: field === 'thumbnail_text' ? ['titles'] : [] };
    const p = manager.buildMetadataFieldPrompt(spec, ctx(SUMMARY));
    has(p, 'one paragraph for every five minutes of it', `${field}: the summary block`);
    has(p, '2. 8:09\n   The host says Hindenburg was never chancellor.', `${field}: its paragraphs, timed`);
    hasNot(p, 'THE WHOLE TRANSCRIPT', `${field}: no transcript`);
    hasNot(p, 'The chapter detail.', `${field}: no chapter list beside it`);
    eq((p.match(/=== WHAT THIS VIDEO ACTUALLY COVERS ===/g) || []).length, 1, `${field}: the coverage stated once:`);
  }
  const titlesNone = manager.buildMetadataFieldPrompt({ field: 'titles', model: 'anthropic/claude-sonnet-5', insights: false, inputFields: [] }, ctx(null));
  has(titlesNone, 'What follows is the video in chapter form', 'with no summary, titles read the chapter list as before');
  const titlesOld = manager.buildMetadataFieldPrompt({ field: 'titles', model: 'anthropic/claude-sonnet-5', insights: false, inputFields: [] }, { ...ctx(null), stretchSummary: undefined });
  has(titlesOld, 'What follows is the video in chapter form', 'a context built without the field (an older caller) reads as none');
});

check('the description reads the summary under its own label, never as "the transcript, in full", and with no speaker-tag block', () => {
  const { DescriptionUnit } = require(path.join(ROOT, 'services/metadata/description-unit.js'));
  const { JobModelLifecycle } = require(path.join(ROOT, 'services/metadata/model-lifecycle.js'));
  const manager = new aiManagerModule.AIManagerService({ transcriptCeiling: 'local', promptSet: 'youtube-telltale', promptSetsDir: ASSETS_DIR });
  manager.loadPrompts();
  const unit = new DescriptionUnit(manager, { kind: 'cloud', id: 'sonnet5', label: 'Sonnet', model: 'anthropic/claude-sonnet-5' }, new JobModelLifecycle('the summary checks'));
  const TRANSCRIPT = 'HOST THE WHOLE TRANSCRIPT '.repeat(40);
  const base = {
    content: TRANSCRIPT, contentMode: 'raw-transcript', sourceLabel: 'u4 - metaxas.mov',
    chapterSubjects: ['Metaxas rebutted'], chapterDetails: ['The chapter detail.'], digestChapters: [],
    videoTitle: 'u4 - metaxas', promptSetName: 'youtube-telltale', entities: [], phrases: [], contentText: TRANSCRIPT,
    contentSpeakerTagged: true, generated: {}, warn: () => {},
  };
  const withSummary = unit.describePrompt({ ...base, stretchSummary: SUMMARY });
  has(withSummary, 'The video, summarized in order', 'the summary label');
  has(withSummary, 'The host says Hindenburg was never chancellor.', 'its paragraphs');
  hasNot(withSummary, 'The transcript of the video, in full', 'no transcript label');
  hasNot(withSummary, 'THE WHOLE TRANSCRIPT', 'no transcript');
  hasNot(withSummary, 'The transcript is tagged by speaker', 'no speaker-tag block over prose');
  const without = unit.describePrompt({ ...base, stretchSummary: null });
  has(without, 'The transcript of the video, in full', 'an item with no summary keeps the transcript');
  has(without, 'The transcript is tagged by speaker', 'and its tag block');
});

check('the thumbnail words read the summary when there is one, the transcript otherwise', () => {
  const base = { channel: 'Owen Unfiltered', creator: 'owen morgan', title: 'metaxas thinks hindenburg was chancellor', transcript: ['[0:01] the transcript line'] };
  const withSummary = thumbPrompts.buildWordsPrompt({ ...base, summary: S.summaryParagraphs(SUMMARY) });
  has(withSummary, 'Below is a summary of a video', 'the summary source');
  has(withSummary, 'The host says Hindenburg was never chancellor.', 'its paragraphs');
  hasNot(withSummary, 'the transcript line', 'no transcript beside it');
  const without = thumbPrompts.buildWordsPrompt(base);
  has(without, 'The transcript, one line per caption', 'the transcript source');
  has(without, 'the transcript line', 'its lines');
  for (const p of [withSummary, without]) if (/\{[a-z_]+\}/.test(p)) throw new Error('an unfilled slot');
});

check('a stored summary is read back as it was written, and a malformed one is refused', () => {
  eq(S.storedStretchSummary(JSON.parse(JSON.stringify(SUMMARY))), SUMMARY, 'round trip:');
  eq(S.storedStretchSummary(undefined), null, 'a report without one:');
  let threw = false;
  try { S.storedStretchSummary({ paragraphs: [{ start: 0, text: '' }] }); } catch { threw = true; }
  if (!threw) throw new Error('an empty paragraph was accepted');
});

Promise.all(pending).then(() => {
  console.log('');
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
