#!/usr/bin/env node
/**
 * THE SONG CHANNEL'S PURE PIECES (LEDGER #308, Little Goose Productions), checked offline against
 * the compiled main process (`npm run build:electron` first) and the repo's own prompt assets:
 *
 *   - the channel file's song keys: read, validated, and absent on every other channel;
 *   - the plan: the summary-from-lyrics call and the tags call, no titles;
 *   - the lyrics: label cues dropped, stanzas drawn, the caption SRT;
 *   - the title from the file name; the still's title layout and black-frame test;
 *   - the upload, push and schedule bodies with and without a profile; the auto title and still;
 *   - the description's code-assembled tail.
 *
 * No model, no network, no YouTube. The ffmpeg-backed parts (reading a real track, drawing a real
 * still) are not here: they need a video and were run by hand on the sample (LEDGER #308).
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main');
const ASSETS = path.join(__dirname, '..', 'electron', 'assets');
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
promptAssetsModule.initPromptAssets(path.join(ASSETS, 'prompts'));
const assets = promptAssetsModule.promptAssets();
const lyrics = require(path.join(ROOT, 'services/metadata/song-lyrics.js'));
const profileModule = require(path.join(ROOT, 'services/publish/youtube-profile.js'));
const channelProfile = require(path.join(ROOT, 'services/metadata/channel-profile.js'));
const still = require(path.join(ROOT, 'services/thumbnails/still-title.js'));
const upload = require(path.join(ROOT, 'services/publish/youtube-upload.js'));
const push = require(path.join(ROOT, 'services/publish/youtube-push.js'));
const autoConfig = require(path.join(ROOT, 'services/publish/auto-config.js'));
const publishTypes = require(path.join(ROOT, 'services/publish/publish-types.js'));
const tasks = require(path.join(ROOT, 'services/metadata/metadata-tasks.js'));
const routing = require(path.join(ROOT, 'services/metadata/metadata-routing.js'));
const lifecycleModule = require(path.join(ROOT, 'services/metadata/model-lifecycle.js'));
const songUnit = require(path.join(ROOT, 'services/metadata/song-description-unit.js'));
const { AIManagerService } = require(path.join(ROOT, 'services/metadata/ai-manager.service.js'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + ' :: ' + e.message);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what} expected ${b}, got ${a}`);
}
function throws(fn, pattern, what) {
  try {
    fn();
  } catch (e) {
    if (!pattern.test(e.message)) throw new Error(`${what}: threw "${e.message}", not ${pattern}`);
    return;
  }
  throw new Error(`${what}: did not throw`);
}

const LG = 'youtube-littlegoose';
const SAMPLE_SRT = [
  '1', '00:00:09,140 --> 00:00:13,700', 'At the Hollow Tree Inn, at the Hollow Tree Inn,', '',
  '2', '00:00:13,700 --> 00:00:17,540', "There's a door in the oak, so come on in,", '',
  '3', '00:00:18,340 --> 00:00:22,580', "There's a bed made of moss and a pillow of down,", '',
  '4', '00:00:22,980 --> 00:00:26,820', 'And the friendliest innkeeper in town.', '',
  '5', '00:00:29,860 --> 00:00:30,020', 'Verse', '',
  '6', '00:00:30,020 --> 00:00:33,620', 'In the middle of the woods stands an old, old oak', '',
  '7', '00:00:34,500 --> 00:00:37,540', 'With a hollow from the roots to the top,', '',
  '8', '00:00:39,140 --> 00:00:43,220', 'And a little round sign that says "Rooms for the Night"', '',
  '9', '00:00:43,700 --> 00:00:46,500', 'For the travelers ready to stop.', '',
  '10', '00:00:46,500 --> 00:00:51,764', 'The innkeeper there is a chipmunk', '',
  '11', '00:00:53,044 --> 00:00:56,164', 'In a tiny striped apron, so neat,', '',
].join('\r\n');

// ── the channel file ────────────────────────────────────────────────────────

check('the Little Goose channel file reads with its song keys', () => {
  const c = assets.channel(LG);
  eq(c.fields, ['description', 'tags'], 'fields:');
  eq([c.titleSource, c.chapters, c.transcriptSource, c.descriptionLyrics, c.thumbnailMode, c.captions],
    ['filename', false, 'embedded_subtitles', true, 'still_title', 'lyrics'], 'song keys:');
  eq(c.upload, { madeForKids: true, containsSyntheticMedia: true, categoryId: '10' }, 'upload:');
  eq(c.thumbnails, true, 'thumbnails:');
});

check('every other channel reads exactly as before: no song key set', () => {
  for (const id of assets.channelIds().filter((i) => i !== LG)) {
    const c = assets.channel(id);
    eq([c.titleSource, c.chapters, c.transcriptSource, c.descriptionLyrics, c.thumbnailMode, c.upload, c.captions],
      ['generated', true, 'asr', false, 'ab_pairs', null, null], `${id}:`);
    eq(channelProfile.publishProfileOf(c).upload, null, `${id} profile upload:`);
  }
  eq(channelProfile.publishProfileForPromptSet(null), null, 'no prompt set:');
  eq(channelProfile.publishProfileForPromptSet('sample-youtube'), null, 'a retired prompt set:');
});

check('a contradictory channel file is refused at load, naming the key', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-lg-assets-'));
  try {
    fs.cpSync(path.join(ASSETS, 'prompts'), path.join(tmp, 'prompts'), { recursive: true });
    const file = path.join(tmp, 'prompts', 'channels', 'littlegoose.yml');
    const shipped = fs.readFileSync(file, 'utf8');
    const load = () => promptAssetsModule.PromptAssets.load(path.join(tmp, 'prompts'));
    fs.writeFileSync(file, shipped.replace('transcript_source: embedded_subtitles', 'transcript_source: asr'));
    throws(load, /embedded lyrics.*transcript_source is asr/, 'lyrics without the track');
    fs.writeFileSync(file, shipped.replace('chapters: false', 'chapters: "no"'));
    throws(load, /"chapters" key/, 'a chapters string');
    fs.writeFileSync(file, shipped.replace('  category_id: "10"\n', ''));
    throws(load, /"upload" block/, 'an upload block missing its category');
    fs.writeFileSync(file, shipped.replace('fields:\n', 'fields:\n  - titles\n'));
    throws(load, /title_source: filename.*"titles"/, 'filename titles beside generated ones');
    fs.writeFileSync(file, shipped.replace('thumbnail_mode: still_title', 'thumbnail_mode: still'));
    throws(load, /thumbnail_mode/, 'an unknown thumbnail mode');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

check('the kids editorial prompt names nobody but the channel and keeps to the song', () => {
  const c = assets.channel(LG);
  const text = assets.editorialPrompt(c) + '\n' + assets.fieldSection(c, 'description') + '\n' + assets.fieldSection(c, 'tags');
  for (const banned of [/owen/i, /patreon/i, /telltale/i, /fireside/i, /unfiltered/i, /\bAI\b/, /debunk/i, /grifter/i, /libel/i, /\{[a-z_]+\}/]) {
    // The shared NO AI-ISMS block is a register rule (it names AI phrasing in order to ban it), kept on every channel.
    const prompt = text.replace('{subject}', '').replace(/## NO AI-ISMS[\s\S]*?(?=\n## )/, '');
    if (banned.test(prompt)) throw new Error(`the Little Goose prompt carries ${banned}`);
  }
  if (!/Little Goose Productions/.test(text)) throw new Error('the channel is never named');
  if (!/how often new songs come out/.test(text)) throw new Error('the schedule line is gone');
  if (!/how the song or the video was made/.test(text)) throw new Error('the how-it-was-made line is gone');
});

// ── the plan ────────────────────────────────────────────────────────────────

check('the plan: the summary-from-lyrics call and the tags call, and no titles', () => {
  const channel = assets.channel(LG);
  const sections = channel.fields.map((f) => tasks.METADATA_FIELD_SECTIONS[f].section);
  const aiManager = { promptSetSectionKeys: () => new Set(sections), tagStyle: () => 'youtube', loadedChannel: () => channel };
  const plan = tasks.planMetadataUnits({
    routing: routing.resolveMetadataRouting(undefined),
    models: { bind: (task, optionId) => ({ id: optionId, kind: 'cloud', model: `anthropic/${task}` }) },
    aiManager,
    hasInsights: false,
    hasChapters: false,
    alsoLoads: [],
    lifecycle: new lifecycleModule.JobModelLifecycle(),
  });
  const written = plan.units.flatMap((u) => u.fields).sort();
  eq(written, ['description', 'tags'], 'fields written:');
  if (!plan.units.some((u) => u instanceof songUnit.SongDescriptionUnit)) throw new Error('the description is not the song unit');
  eq([plan.assembleTags, plan.assembleHashtags], [false, false], 'nothing assembled in code:');
});

check('the song summary judge: two or three sentences in the word range, else named', () => {
  const ok = 'Deep in the woods, an old oak tree is home to a cozy inn run by a kind chipmunk. Toads, field mice, a woodpecker and two bats all find a snug room for the night. A gentle bedtime song for little ones.';
  eq(songUnit.judgeSongSummary(ok, [25, 75]), [], 'the approved shape:');
  const faults = songUnit.judgeSongSummary('A song.', [25, 75]);
  if (faults.length !== 2) throw new Error(`a one-sentence, 2-word summary has ${faults.length} fault(s): ${faults.join('; ')}`);
});

// ── the lyrics ──────────────────────────────────────────────────────────────

check('section labels are told from lyrics', () => {
  for (const label of ['Verse', 'verse 2', '[Chorus]', '(Bridge)', 'Pre-Chorus', 'Outro:', 'Intro', 'Refrain', 'Hook', 'Post chorus']) {
    if (!lyrics.isSectionLabel(label)) throw new Error(`"${label}" is not read as a label`);
  }
  for (const line of ['Verse by verse we sing along', 'Chorus of frogs at night,', 'Hook the moon', 'Outro']) {
    if (line === 'Outro') continue;
    if (lyrics.isSectionLabel(line)) throw new Error(`"${line}" is read as a label`);
  }
});

check('the sample track: the "Verse" cue is dropped, the stanzas are drawn, the SRT is renumbered', () => {
  const song = lyrics.songLyricsOf(lyrics.parseSrt(SAMPLE_SRT, 'sample'), 'sample');
  eq(song.dropped.map((c) => [c.text, c.start]), [['Verse', 29.86]], 'dropped:');
  eq(song.cues.length, 10, 'lyric lines:');
  eq(song.stanzas.map((s) => s.length), [4, 4, 2], 'stanzas (a sentence end breaks one, with a 0 s gap):');
  const block = lyrics.lyricsBlock(song);
  if (!block.startsWith('🎵 Lyrics\n\nAt the Hollow Tree Inn')) throw new Error('the block does not open on the heading and the first line');
  if (!block.includes('town.\n\nIn the middle')) throw new Error('no blank line between the first two stanzas');
  const srt = lyrics.lyricsSrt(song);
  if (/Verse\n/.test(srt)) throw new Error('the label reached the caption track');
  const again = lyrics.parseSrt(srt, 'roundtrip');
  eq(again.length, 10, 'the SRT reads back:');
  eq([again[4].start, again[4].text], [30.02, 'In the middle of the woods stands an old, old oak'], 'the fifth cue after the drop:');
});

check('a long gap breaks a stanza; a track of labels only is refused', () => {
  const cues = [
    { start: 0, end: 2, text: 'one little star' },
    { start: 2.5, end: 4, text: 'two little stars' },
    { start: 7, end: 9, text: 'three little stars' },
  ];
  eq(lyrics.songLyricsOf(cues, 'gap').stanzas.map((s) => s.length), [2, 1], 'stanzas:');
  throws(() => lyrics.songLyricsOf([{ start: 0, end: 1, text: 'Chorus' }], 'labels'), /no lyric line/, 'labels only');
  throws(() => lyrics.songLyricsOf([{ start: 0, end: 1, text: '' }], 'empty'), /has no text/, 'an empty cue');
});

check('the title is the song name in the file name', () => {
  eq(profileModule.songTitleFromFilename('/x/The Hollow Tree Inn - lyrics.mp4'), 'The Hollow Tree Inn', 'with the suffix:');
  eq(profileModule.songTitleFromFilename('The Hollow Tree Inn - LYRICS.mov'), 'The Hollow Tree Inn', 'any case:');
  eq(profileModule.songTitleFromFilename('The Bench Beneath the Roses.mp4'), 'The Bench Beneath the Roses', 'without one:');
  eq(profileModule.songTitleFromFilename('Lyrics of the Lark - lyrics.mp4'), 'Lyrics of the Lark', 'only the trailing suffix goes:');
  throws(() => profileModule.songTitleFromFilename(' - lyrics.mp4'), /no song name/, 'a name that is only the suffix');
});

// ── the still ───────────────────────────────────────────────────────────────

check('the still: black frames are told from dark ones; the title is fitted on one or two lines', () => {
  eq(still.isBlackFrame(new Uint8Array(100).fill(4)), true, 'black:');
  eq(still.isBlackFrame(new Uint8Array(100).fill(45)), false, 'a dark night scene:');
  const fade = new Uint8Array(100).fill(2);
  fade[0] = 255;
  eq(still.isBlackFrame(fade), true, 'black with one bright pixel:');
  if (!fs.existsSync(still.STILL_FONT_FILE)) {
    console.log('      (the font is not on this machine; the layout half is not checked)');
    return;
  }
  const metrics = still.readFontMetrics(still.STILL_FONT_FILE);
  const short = still.layoutTitle(metrics, 'The Hollow Tree Inn');
  eq([short.lines.length, short.sizePx], [1, 104], 'a short title:');
  const long = still.layoutTitle(metrics, "The Gathering in the Clearing Beneath the Old Silver Moon's Light");
  eq(long.lines.length, 2, 'a long title takes two lines:');
  for (const line of long.lines) {
    if (still.textWidthPx(metrics, line, long.sizePx) > 1152) throw new Error(`"${line}" overruns the margins`);
  }
  throws(() => still.layoutTitle(metrics, 'word '.repeat(60)), /does not fit/, 'a title too long for two lines');
  const graph = still.stillFilterGraph(short, ['/tmp/a b/line1.txt'], still.STILL_FONT_FILE);
  if (!graph.includes("fontfile='/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf'")) throw new Error('the font path is not quoted');
  if (!graph.includes('fontcolor=0xFF8C1A') || !graph.includes('bordercolor=0xFFF3DC')) throw new Error('the colours are not the banner\'s');
});

// ── publishing ──────────────────────────────────────────────────────────────

const lgProfile = channelProfile.publishProfileOf(assets.channel(LG));
const itemId = 'itm-mv1x1o7q-3bvvmyzt';
const blank = publishTypes.emptyChosenMetadata(itemId, 'job-1791604932042-v9z81ezlm');

check('the upload body: a profile sends made-for-kids, the disclosure and its category; none sends exactly as before', () => {
  const base = {
    record: { ...blank, channelId: 'UCXslUPdQ0IfR5nV7k4FLcqw', chosenTitles: ['The Hollow Tree Inn'] },
    resolved: { title: 'The Hollow Tree Inn', description: 'A song.', tags: 'bedtime song, kids songs' },
    file: { path: '/x/a.mp4', sizeBytes: 10 },
  };
  const kids = upload.planVideoInsert({ ...base, categoryId: null, profile: lgProfile });
  eq(kids.body.status, { privacyStatus: 'private', selfDeclaredMadeForKids: true, containsSyntheticMedia: true }, 'kids status:');
  eq(kids.body.snippet.categoryId, '10', 'kids category:');
  const before = upload.planVideoInsert({ ...base, categoryId: '25', profile: null });
  eq(before.body.status, { privacyStatus: 'private', selfDeclaredMadeForKids: false }, 'no profile status (no disclosure key at all):');
  eq(before.body.snippet.categoryId, '25', 'no profile category:');
  throws(() => upload.planVideoInsert({ ...base, categoryId: null, profile: null }), /No categoryId/, 'no profile, no category');
  throws(() => profileModule.requireProfileRead({}, itemId), /no publishProfile/, 'a reader that did not say');
});

const video = (status) => ({
  id: 'vid1',
  snippet: { channelId: 'UCXslUPdQ0IfR5nV7k4FLcqw', categoryId: '22', title: 'raw', description: '', tags: [] },
  status,
});
const linked = { ...blank, channelId: 'UCXslUPdQ0IfR5nV7k4FLcqw', videoId: 'vid1', chosenTitles: ['The Hollow Tree Inn'] };
const resolved = { description: 'A song.', tags: 'bedtime song' };

check('the push: a profile sends the whole status with its audience on every push, and its category', () => {
  const kids = push.planVideoUpdate({ record: linked, resolved, video: video({ privacyStatus: 'unlisted', embeddable: true }), profile: lgProfile });
  eq(kids.parts, ['snippet', 'status'], 'parts:');
  eq(kids.body.status, { privacyStatus: 'unlisted', embeddable: true, selfDeclaredMadeForKids: true, containsSyntheticMedia: true }, 'status, whole:');
  eq(kids.body.snippet.categoryId, '10', 'category:');
  const scheduled = push.planVideoUpdate({ record: { ...linked, publishAt: '2026-10-20T13:00:00Z' }, resolved, video: video({ privacyStatus: 'private' }), profile: lgProfile });
  eq(scheduled.body.status, { privacyStatus: 'private', publishAt: '2026-10-20T13:00:00Z', selfDeclaredMadeForKids: true, containsSyntheticMedia: true }, 'scheduled status:');
  const before = push.planVideoUpdate({ record: linked, resolved, video: video({ privacyStatus: 'unlisted' }), profile: null });
  eq(before.parts, ['snippet'], 'no profile, no schedule: status not sent:');
  eq(before.body.snippet.categoryId, '22', 'no profile: the video keeps its category:');
  const sched = push.planScheduleUpdate({ record: { ...linked, publishAt: '2026-10-20T13:00:00Z' }, video: video({ privacyStatus: 'private' }), profile: lgProfile });
  eq(sched.body.status.selfDeclaredMadeForKids, true, 'the schedule-only write keeps the audience:');
  const schedBefore = push.planScheduleUpdate({ record: { ...linked, publishAt: '2026-10-20T13:00:00Z' }, video: video({ privacyStatus: 'private' }), profile: null });
  eq(Object.keys(schedBefore.body.status).sort(), ['privacyStatus', 'publishAt'], 'no profile: schedule as before:');
});

check('auto-config: a filename channel gets its song name chosen; a still is attached only when nobody has decided', () => {
  const run = (record, extra) => autoConfig.autoConfigure({
    record, promptSet: LG, sourcePath: '/x/The Hollow Tree Inn - lyrics.mp4', channels: [], profile: lgProfile, stillThumbnailPath: null, ...extra,
  });
  eq(run(blank).patch.chosenTitles, ['The Hollow Tree Inn'], 'chosen:');
  eq(run({ ...blank, chosenTitles: ['My own'] }).patch.chosenTitles, undefined, 'an edited title stands:');
  const noStill = run(blank);
  if (!noStill.skipped.some((d) => d.field === 'thumbnail' && /drew no still/.test(d.detail))) throw new Error('no still is not said');
  const gone = run(blank, { stillThumbnailPath: '/x/gone.jpg' });
  if (!gone.refused.some((d) => d.field === 'thumbnail')) throw new Error('a missing still is not refused');
  const manual = run({ ...blank, thumbnailSource: 'manual', thumbnailPath: '/x/mine.png' }, { stillThumbnailPath: '/x/gone.jpg' });
  eq(manual.patch.thumbnailPath, undefined, 'a manual pick stands:');
  const telltale = autoConfig.autoConfigure({ record: blank, promptSet: 'youtube-telltale', sourcePath: '/x/a.mov', channels: [], profile: channelProfile.publishProfileForPromptSet('youtube-telltale'), stillThumbnailPath: null });
  eq(telltale.patch.chosenTitles, undefined, 'another channel\'s titles stay his to pick:');
});

check('the description tail: the lyrics block sits above the closing line, and clears per item', () => {
  const ai = new AIManagerService({ promptSetsDir: ASSETS, promptSet: LG });
  // loadPrompts is what initialize() runs; it makes no model call.
  ai.loadPrompts();
  eq(ai.descriptionLinks(), 'Subscribe to Little Goose Productions to sing with us!', 'without lyrics:');
  ai.setItemLyricsBlock('🎵 Lyrics\n\nline one\nline two');
  eq(ai.descriptionLinks(), '🎵 Lyrics\n\nline one\nline two\n\nSubscribe to Little Goose Productions to sing with us!', 'with lyrics:');
  const out = ai.finalizeMetadata({ description: 'A gentle song.', tags: 'bedtime song' });
  eq(out.description, 'A gentle song.\n\n🎵 Lyrics\n\nline one\nline two\n\nSubscribe to Little Goose Productions to sing with us!', 'the published description:');
  eq(out.tags, 'bedtime song,little goose productions', 'the channel tag:');
  ai.setItemLyricsBlock(null);
  eq(ai.descriptionLinks(), 'Subscribe to Little Goose Productions to sing with us!', 'cleared:');
  throws(() => ai.setItemLyricsBlock('  '), /empty lyrics block/, 'an empty block');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
