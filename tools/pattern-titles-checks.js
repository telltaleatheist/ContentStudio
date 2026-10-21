#!/usr/bin/env node
/**
 * The tested-pattern titles (2026-10-21; electron/services/metadata/pattern-titles.ts). Five more
 * titles per long-form item, one in each pattern distilled from the channel's own A/B tests and
 * recent uploads, beside the ten. Offline: no model is called, nothing is written to disk.
 *
 *   1. THE TEN-TITLE PROMPT IS BYTE-FOR-BYTE UNCHANGED. Every channel that writes titles, in every
 *      content form the titles call reads, with and without the insights block, is assembled from
 *      this build and compared with the copy written from commit ea53529's compiled dist (the commit
 *      before; tools/fixtures/titles-prompt-golden/, fixture in tools/fixtures/titles-prompt-fixture.js).
 *   2. The pattern section: the patterns in order, the ten's rules text shared verbatim, the titles
 *      call's own shared prefix, no insights block, model text placed verbatim, refused on a channel
 *      whose titles have their own rules.
 *   3. The pattern distiller: its prompt, its strict reader, and the cache (own sourceHash beside
 *      the lessons; an old guidelines.json without patterns is STALE, never empty; dry runs get the
 *      placeholder; one re-ask then a loud throw; a malformed stored record throws).
 *   4. The call: one line per pattern or a throw naming model and counts; stored as {pattern, how,
 *      title}; traced under its own name, which the ten-more replay does not mistake for the titles call.
 *   5. The plan: right after the titles on the titles option, only when the channel opts in AND the
 *      run resolved patterns; shorts / podcast / no evidence / no titles plan none.
 *
 *   npm run build:electron && node tools/pattern-titles-checks.js
 */
const path = require('path');
const fs = require('fs');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
// The stub logs through console.log; these checks print only their own verdicts.
const realLog = console.log.bind(console);
console.log = (...args) => {
  if (typeof args[0] === 'string' && (args[0].startsWith('[log.') || args[0].startsWith('['))) return;
  realLog(...args);
};

const DIST = path.join(__dirname, '..', 'dist', 'main');
const ASSETS = path.join(__dirname, '..', 'electron', 'assets');
const fixture = require(path.join(__dirname, 'fixtures', 'titles-prompt-fixture.js'));
const promptAssetsModule = require(path.join(DIST, 'services/metadata/prompt-assets.js'));
promptAssetsModule.initPromptAssets(path.join(ASSETS, 'prompts'));
const assets = promptAssetsModule.promptAssets();
const aiManagerModule = require(path.join(DIST, 'services/metadata/ai-manager.service.js'));
const tasks = require(path.join(DIST, 'services/metadata/metadata-tasks.js'));
const patternTitles = require(path.join(DIST, 'services/metadata/pattern-titles.js'));
const moreTitles = require(path.join(DIST, 'services/metadata/more-titles.js'));
const routing = require(path.join(DIST, 'services/metadata/metadata-routing.js'));
const lifecycleModule = require(path.join(DIST, 'services/metadata/model-lifecycle.js'));
const guidelines = require(path.join(DIST, 'services/analytics/insights-guidelines.js'));

let failures = 0;
const pending = [];
function check(name, fn) {
  pending.push(async () => {
    try {
      await fn();
      realLog(`ok   ${name}`);
    } catch (error) {
      failures++;
      realLog(`FAIL ${name}\n     ${error.message}`);
    }
  });
}
function eq(actual, expected, what) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}
function has(haystack, needle, what) {
  if (!haystack.includes(needle)) throw new Error(`${what}: "${needle.slice(0, 120)}" is not there`);
}
function hasNot(haystack, needle, what) {
  if (haystack.includes(needle)) throw new Error(`${what}: "${needle.slice(0, 120)}" should not be there`);
}
async function throwsLike(fn, re, what) {
  try { await fn(); } catch (e) { if (!re.test(e.message)) throw new Error(`${what}: threw "${e.message}", expected ${re}`); return; }
  throw new Error(`${what}: did not throw`);
}

const PATTERNS = [
  { name: 'claim in quotes', how: "lead with the subject's own claim in quotes, then the flat verdict on it" },
  { name: 'dry punchline ending', how: 'state what happened plainly in two short sentences and end on a deadpan consequence' },
  { name: 'named group acting', how: 'open with the group the audience recognizes doing the concrete odd thing, present tense' },
  { name: 'quiet reveal', how: 'say what someone just did that they did not want noticed, as news happening now' },
  { name: 'spoken verdict', how: 'say the whole argument as one blunt sentence you would say to a friend' },
];
const RESOLVED = { kind: 'patterns', patterns: PATTERNS, sourceHash: 'h' };

function manager(promptSet) {
  const m = new aiManagerModule.AIManagerService({ transcriptCeiling: 'cloud', promptSet, promptSetsDir: ASSETS });
  m.loadPrompts();
  return m;
}

// ---------------------------------------------------------------- 1. the ten, unchanged

check('the ten-title prompt is byte-for-byte the pre-change prompt (every channel, form, insights on/off)', () => {
  const prompts = fixture.assembleTitlesPrompts(DIST, ASSETS);
  const goldenDir = path.join(__dirname, 'fixtures', 'titles-prompt-golden');
  const goldens = fs.readdirSync(goldenDir).filter((f) => f.endsWith('.txt'));
  eq(Object.keys(prompts).length, goldens.length, 'assembled prompts vs golden copies:');
  eq(Object.keys(prompts).length, 30, 'five title-writing channels x three forms x insights on/off:');
  for (const [key, prompt] of Object.entries(prompts)) {
    const golden = fs.readFileSync(path.join(goldenDir, key.replace(/\//g, '__') + '.txt'), 'utf8');
    if (golden !== prompt) {
      let at = 0;
      while (at < golden.length && golden[at] === prompt[at]) at++;
      throw new Error(`${key} differs from its pre-change copy at character ${at}: "${prompt.slice(at, at + 80)}"`);
    }
  }
});

check('the ten-title section carries the shared rules, filled, with no slot left', () => {
  const section = assets.fieldSection(assets.channel('youtube-telltale'), 'titles');
  hasNot(section, '{title_rules}', 'ten-title section');
  has(section, '- Find the underlying argument behind this video and sell that.', 'the rules');
  has(section, '- Length: 50 to 70 characters', 'the title format');
});

// ---------------------------------------------------------------- 2. the pattern section

check('the pattern prompt: the titles call\'s own prefix, the patterns in order, the shared rules verbatim, no insights block', () => {
  for (const id of ['youtube-telltale', 'youtube-fireside', 'youtube-unfiltered']) {
    const m = manager(id);
    m.setInsightsBlock(fixture.INSIGHTS_BLOCK);
    for (const form of ['summary', 'digest', 'raw']) {
      const ctx = fixture.ctx(id, form);
      const titles = m.buildMetadataFieldPromptParts({ field: 'titles', model: 'x', insights: true, inputFields: [] }, ctx);
      const parts = m.buildPatternTitlesPromptParts(ctx, RESOLVED);
      eq(parts.shared, titles.shared, `${id}/${form} shared prefix equals the titles call's:`);
      eq(parts.prompt.startsWith(parts.shared), true, `${id}/${form} prompt starts with its prefix:`);
      hasNot(parts.prompt, 'CHANNEL PERFORMANCE DATA', `${id}/${form} insights block`);
      const at = PATTERNS.map((p, i) => parts.prompt.indexOf(`  ${i + 1}. ${p.name}: ${p.how}`));
      eq(at.every((x, i) => x > 0 && (i === 0 || x > at[i - 1])), true, `${id}/${form} patterns listed in order:`);
      const tenSection = assets.fieldSection(assets.channel(id), 'titles');
      const rules = tenSection.slice(tenSection.indexOf('- Find the underlying argument'), tenSection.indexOf('- The top 3 titles'));
      has(parts.prompt, rules.trim(), `${id}/${form} the ten's rules, verbatim`);
      eq(/\{[a-z_]+\}/.test(parts.prompt.slice(parts.shared.length)), false, `${id}/${form} an unfilled slot:`);
      has(parts.prompt, 'Generate 5 youtube titles, one in each of the 5 patterns below', `${id}/${form} count`);
      has(parts.prompt, '## OUTPUT FORMAT', `${id}/${form} output format`);
      has(parts.prompt, "- Exactly 5 titles, one per pattern, in the patterns' order", `${id}/${form} self-check`);
      hasNot(parts.prompt, 'Top 3: genuinely different angles', `${id}/${form} the ten's A/B self-check line`);
    }
  }
});

check('model-written pattern text reaches the prompt verbatim (braces and $ are not slots)', () => {
  const odd = PATTERNS.map((p, i) => (i === 0 ? { name: 'braces and dollars', how: 'keep {titles_count} and $& and $1 as written here' } : p));
  const parts = manager('youtube-telltale').buildPatternTitlesPromptParts(fixture.ctx('youtube-telltale', 'digest'), { kind: 'patterns', patterns: odd, sourceHash: 'h' });
  has(parts.prompt, '  1. braces and dollars: keep {titles_count} and $& and $1 as written here', 'verbatim');
});

check('the pattern section is refused on a channel whose titles have their own rules (shorts, podcast)', async () => {
  for (const id of ['youtube-shorts', 'podcast-spreaker']) {
    await throwsLike(() => assets.patternTitlesSection(assets.channel(id), 'x', 5), /has its own titles rules/, id);
  }
});

check('the dry-run placeholder stands where the patterns go', () => {
  const parts = manager('youtube-telltale').buildPatternTitlesPromptParts(
    fixture.ctx('youtube-telltale', 'digest'), { kind: 'placeholder', text: guidelines.PATTERNS_PLACEHOLDER });
  has(parts.prompt, `  ${guidelines.PATTERNS_PLACEHOLDER}`, 'placeholder line');
  has(parts.prompt, 'Generate 5 youtube titles', 'count still stated');
});

check('the prompt files carry zero comments', () => {
  for (const rel of ['shared/fields/titles.yml', 'shared/pipeline/insights.yml']) {
    const text = fs.readFileSync(path.join(ASSETS, 'prompts', rel), 'utf8');
    const comment = text.split('\n').find((l) => /^\s*#(?!#)/.test(l));
    eq(comment, undefined, `${rel} comment line:`);
  }
});

check('channel opt-in: Telltale, Fireside, Unfiltered yes; shorts, podcast, Little Goose no', () => {
  const on = assets.channelIds().filter((id) => assets.channel(id).patternTitles);
  eq(on, ['youtube-fireside', 'youtube-telltale', 'youtube-unfiltered'], 'opted in:');
});

// ---------------------------------------------------------------- 3. the distiller + cache

function prepared(cached, overrides = {}) {
  const saved = [];
  return {
    saved,
    p: {
      channelId: 'UCx', channelName: 'Fixture Channel', rawBlock: 'CHANNEL PERFORMANCE DATA (as of 2026-10-21)\n- evidence line',
      sourceHash: 'current-hash', cached, forceRefresh: false, videoCount: 3, baselinesLine: 'Channel baselines: x',
      abRulesBlock: 'TITLE A/B EVIDENCE: none.', save: async (g) => { saved.push(JSON.parse(JSON.stringify(g))); },
      ...overrides,
    },
  };
}
const LESSONS = { generatedAt: '2026-10-20T00:00:00Z', model: 'claude-cli:opus', sourceHash: 'current-hash', lines: ['- a lesson'] };
const GOOD_ANSWER = PATTERNS.map((p, i) => (i % 2 === 0 ? `- ${p.name}: ${p.how}` : `${i + 1}. ${p.name}: ${p.how}`)).join('\n');
function distiller(answers) {
  const calls = [];
  return { calls, opts: (dryRun) => ({ dryRun, model: 'claude-cli:opus', distill: async (prompt, what) => { calls.push({ prompt, what }); return answers[calls.length - 1] ?? null; } }) };
}

check('the pattern distiller prompt: the same evidence render, the count filled, the lessons prompt untouched', () => {
  const { p } = prepared(LESSONS);
  const prompt = guidelines.patternDistillerPromptFor(p);
  has(prompt, p.rawBlock, 'evidence');
  has(prompt, 'Name the 5 title patterns', 'count');
  eq(/\{[a-z_]+\}/.test(prompt.replace(p.rawBlock, '')), false, 'unfilled slot:');
  // The lessons prompt is the text it was at ea53529, byte for byte (its answer keeps its "- " shape).
  const yaml = require('js-yaml');
  const file = yaml.load(fs.readFileSync(path.join(ASSETS, 'prompts', 'shared', 'pipeline', 'insights.yml'), 'utf8'));
  eq(require('crypto').createHash('sha256').update(file.guidelines_distiller).digest('hex'),
    '83552074f552de2b68ea134cbd94ffd2c888bea3336a65ac160d07edd5349ae9', 'guidelines_distiller sha256:');
});

check('the pattern reader: numbering and bullets tolerated; everything else strict', async () => {
  eq(guidelines.parseTitlePatterns(GOOD_ANSWER, 'x'), PATTERNS, 'parsed:');
  const lines = GOOD_ANSWER.split('\n');
  await throwsLike(() => guidelines.parseTitlePatterns(lines.slice(0, 4).join('\n'), 'x'), /4 line\(s\) where exactly 5/, 'four');
  await throwsLike(() => guidelines.parseTitlePatterns([...lines, 'sixth thing: one more pattern line here'].join('\n'), 'x'), /6 line\(s\)/, 'six');
  await throwsLike(() => guidelines.parseTitlePatterns([...lines.slice(0, 4), 'no colon in this line at all'].join('\n'), 'x'), /line 5 is not "name: how/, 'colon');
  await throwsLike(() => guidelines.parseTitlePatterns([...lines.slice(0, 4), 'verdict: say the whole argument bluntly'].join('\n'), 'x'), /1 word\(s\)/, 'one-word name');
  await throwsLike(() => guidelines.parseTitlePatterns([...lines.slice(0, 4), 'one two three four five six: say it bluntly now please'].join('\n'), 'x'), /6 word\(s\)/, 'six-word name');
  await throwsLike(() => guidelines.parseTitlePatterns([...lines.slice(0, 4), 'Claim In Quotes: a second pattern with the same name'].join('\n'), 'x'), /same pattern twice/, 'duplicate');
  await throwsLike(() => guidelines.parseTitlePatterns([...lines.slice(0, 4), 'spoken verdict: be blunt'].join('\n'), 'x'), /too little/, 'thin how');
});

check('an old guidelines.json without patterns is STALE: a dry run shows the placeholder and calls nothing', async () => {
  const { p, saved } = prepared({ ...LESSONS });
  const d = distiller([GOOD_ANSWER]);
  const r = await guidelines.resolveTitlePatterns(p, d.opts(true));
  eq(r, { kind: 'placeholder', text: guidelines.PATTERNS_PLACEHOLDER }, 'resolved:');
  eq([d.calls.length, saved.length], [0, 0], 'calls, saves:');
});

check('an old guidelines.json without patterns is STALE: a real run distills once and saves beside the lessons', async () => {
  const { p, saved } = prepared({ ...LESSONS });
  const d = distiller([GOOD_ANSWER]);
  const r = await guidelines.resolveTitlePatterns(p, d.opts(false));
  eq([r.kind, r.patterns, r.sourceHash], ['patterns', PATTERNS, 'current-hash'], 'resolved:');
  eq(d.calls.length, 1, 'calls:');
  eq(saved.length, 1, 'saves:');
  eq([saved[0].lines, saved[0].sourceHash, saved[0].model], [LESSONS.lines, LESSONS.sourceHash, LESSONS.model], 'lessons kept:');
  eq([saved[0].patterns.sourceHash, saved[0].patterns.patterns, saved[0].patterns.model], ['current-hash', PATTERNS, 'claude-cli:opus'], 'patterns record:');
  eq(p.cached.patterns.patterns, PATTERNS, 'in-memory cache current:');
});

check('a fresh patterns record is a cache hit (no call); a moved hash or a forced refresh distills', async () => {
  const record = { generatedAt: 't', model: 'm', sourceHash: 'current-hash', patterns: PATTERNS };
  const hit = prepared({ ...LESSONS, patterns: record });
  const d1 = distiller([]);
  eq((await guidelines.resolveTitlePatterns(hit.p, d1.opts(false))).patterns, PATTERNS, 'hit:');
  eq([d1.calls.length, hit.saved.length], [0, 0], 'hit calls/saves:');
  const moved = prepared({ ...LESSONS, patterns: { ...record, sourceHash: 'older-hash' } });
  const d2 = distiller([GOOD_ANSWER]);
  await guidelines.resolveTitlePatterns(moved.p, d2.opts(false));
  eq(d2.calls.length, 1, 'moved calls:');
  const forced = prepared({ ...LESSONS, patterns: record }, { forceRefresh: true });
  const d3 = distiller([GOOD_ANSWER]);
  await guidelines.resolveTitlePatterns(forced.p, d3.opts(false));
  eq(d3.calls.length, 1, 'forced calls:');
});

check('one re-ask, then a loud throw; nothing is saved from two bad answers', async () => {
  const ok = prepared({ ...LESSONS });
  const d1 = distiller(['only one line: that is not five patterns', GOOD_ANSWER]);
  eq((await guidelines.resolveTitlePatterns(ok.p, d1.opts(false))).patterns, PATTERNS, 'second answer kept:');
  eq(d1.calls.map((c) => c.what.endsWith('second attempt')), [false, true], 'second ask named:');
  const bad = prepared({ ...LESSONS });
  const d2 = distiller(['nope', null]);
  await throwsLike(() => guidelines.resolveTitlePatterns(bad.p, d2.opts(false)), /could not be distilled: both asks/, 'two bad');
  eq([d2.calls.length, bad.saved.length], [2, 0], 'calls, saves:');
});

check('a malformed stored patterns record throws by name, and is never read as stale', async () => {
  const broken = prepared({ ...LESSONS, patterns: { generatedAt: 't', model: 'm', sourceHash: 'current-hash', patterns: PATTERNS.slice(0, 3) } });
  const d = distiller([GOOD_ANSWER]);
  await throwsLike(() => guidelines.resolveTitlePatterns(broken.p, d.opts(false)), /hold 3 pattern\(s\), not 5; delete the "patterns" key/, 'three');
  eq(d.calls.length, 0, 'calls:');
});

check('patterns before lessons is an ordering fault, said by name', async () => {
  const { p } = prepared(null);
  await throwsLike(() => guidelines.resolveTitlePatterns(p, distiller([GOOD_ANSWER]).opts(false)), /ordering fault/, 'cached null');
});

check('re-distilled lessons keep the stored patterns; then the patterns re-distill on their own hash', async () => {
  const record = { generatedAt: 't', model: 'm', sourceHash: 'older-hash', patterns: PATTERNS };
  const { p, saved } = prepared({ ...LESSONS, sourceHash: 'older-hash', patterns: record });
  await guidelines.resolveGuidelinesBlock(p, { dryRun: false, model: 'claude-cli:opus', distill: async () => '- lesson one\n- lesson two\n- lesson three' });
  eq([saved[0].lines.length, saved[0].sourceHash, saved[0].patterns], [3, 'current-hash', record], 'lessons save keeps patterns:');
  await guidelines.resolveTitlePatterns(p, distiller([GOOD_ANSWER]).opts(false));
  eq([saved[1].lines.length, saved[1].patterns.sourceHash], [3, 'current-hash'], 'patterns save keeps new lessons:');
});

// ---------------------------------------------------------------- 4. the call

const FIVE = ['they "pray away" the debt. the bank said no', 'the church sold the jet. now he wants a bigger one',
  'megachurch donors fund a pastor\'s third mansion', 'the pastor quietly deleted the sermon about money',
  'a pastor says god wants him rich and his flock pays'];

check('the answer: one line per pattern, paired by position; any other count throws naming model and counts', async () => {
  const read = patternTitles.readPatternTitles(FIVE.map((t, i) => `${i + 1}. ${t}`).join('\n'), PATTERNS, 'anthropic/m', 'v.mov');
  eq(read, FIVE.map((t, i) => ({ pattern: PATTERNS[i].name, how: PATTERNS[i].how, title: t })), 'paired:');
  await throwsLike(() => patternTitles.readPatternTitles(FIVE.slice(0, 4).join('\n'), PATTERNS, 'anthropic/m', 'v.mov'),
    /on anthropic\/m for v\.mov returned 4 line\(s\) for 5 patterns/, 'four');
  await throwsLike(() => patternTitles.readPatternTitles([...FIVE, 'six'].join('\n'), PATTERNS, 'anthropic/m', 'v.mov'), /returned 6 line\(s\)/, 'six');
});

check('the unit: one call on its option, stored with pattern names, traced under its own name; grounding warns only', async () => {
  const m = manager('youtube-telltale');
  const sent = [];
  m.runPlainRequest = async (prompt, model, what, shape) => {
    sent.push({ prompt, model, what, shape });
    return [...FIVE.slice(0, 4), 'Zorblax Industries quietly funds the pastor'].join('\n');
  };
  const unit = new patternTitles.PatternTitlesUnit(m, { id: 'o', kind: 'cloud', model: 'claude-cli:fable', label: 'Fable' }, new lifecycleModule.JobModelLifecycle('checks'), RESOLVED);
  const warnings = [];
  const ctx = { ...fixture.ctx('youtube-telltale', 'digest'), warn: (w) => warnings.push(w) };
  const out = await unit.generate(ctx);
  eq(sent.length, 1, 'calls:');
  eq([sent[0].model, sent[0].shape], ['claude-cli:fable', { thinking: false }], 'model and shape:');
  eq(sent[0].what, `${patternTitles.PATTERN_TITLES_TRACE_PREFIX}fixture-video.mov`, 'trace name:');
  eq(sent[0].what.startsWith(moreTitles.TITLES_TRACE_PREFIX), false, 'mistakable for the titles call:');
  eq(out.pattern_titles.map((p) => p.pattern), PATTERNS.map((p) => p.name), 'pattern names:');
  eq(Object.keys(out), ['pattern_titles'], 'writes only pattern_titles:');
  eq(warnings.length, 1, 'one grounding warning:');
  has(warnings[0], 'Zorblax', 'names the invented phrase');
  eq(unit.fields, ['pattern_titles'], 'unit fields:');
  eq(unit.localModel, undefined, 'a cloud unit takes no lane:');
});

check('the ten-more replay still finds the titles call when the pattern call follows it in the trace', () => {
  const item = { _prompt_trace: [
    { what: 'the titles call for v.mov', model: 'claude-cli:fable', chars: 5, at: 't', prompt: 'TEN PROMPT' },
    { what: `${patternTitles.PATTERN_TITLES_TRACE_PREFIX}v.mov`, model: 'claude-cli:fable', chars: 7, at: 't', prompt: 'PATTERN PROMPT' },
  ] };
  eq(moreTitles.findStoredTitlesCall(item).prompt, 'TEN PROMPT', 'replayed prompt:');
});

check('a unit given the placeholder refuses to run', async () => {
  const unit = new patternTitles.PatternTitlesUnit(manager('youtube-telltale'), { id: 'o', kind: 'cloud', model: 'x', label: 'x' },
    new lifecycleModule.JobModelLifecycle('checks'), { kind: 'placeholder', text: 'p' });
  await throwsLike(() => unit.generate(fixture.ctx('youtube-telltale', 'digest')), /dry-run placeholder/, 'placeholder');
});

check('soften: the tested-pattern titles go out as lines under the titles label and come back by position, names kept', () => {
  const soften = require(path.join(DIST, 'services/metadata/soften.js'));
  const stored = FIVE.map((t, i) => ({ pattern: PATTERNS[i].name, how: PATTERNS[i].how, title: t }));
  const source = { item_id: 'i1', titles: ['a title'], pattern_titles: stored };
  const target = structuredClone(source);
  const { plans } = soften.planSoftening(source, target);
  const plan = plans.find((p) => p.field === 'tested-pattern titles');
  eq([plan.labelKey, plan.shape, plan.count, plan.text], ['titles', 'lines', 5, FIVE.join('\n')], 'plan:');
  plan.apply(FIVE.map((t) => `milder ${t}`), target);
  eq(target.pattern_titles.map((p) => [p.pattern, p.title]), stored.map((p) => [p.pattern, `milder ${p.title}`]), 'applied:');
  const old = soften.planSoftening({ item_id: 'i2', titles: ['a title'] }, {});
  eq(old.skipped.some((s) => s.field === 'tested-pattern titles'), true, 'an older item says it has none:');
});

// ---------------------------------------------------------------- 5. the plan

function plan(channelId, titlePatterns, extra = {}) {
  const channel = assets.channel(channelId);
  const fields = extra.fields || channel.fields;
  const sections = fields.map((f) => tasks.METADATA_FIELD_SECTIONS[f].section);
  const aiManager = { promptSetSectionKeys: () => new Set(sections), tagStyle: () => channel.tagStyle, loadedChannel: () => channel };
  return tasks.planMetadataUnits({
    routing: routing.resolveMetadataRouting(undefined),
    models: { bind: (task, optionId) => ({ id: optionId, kind: 'cloud', model: `anthropic/${task}`, label: task }) },
    aiManager,
    hasInsights: titlePatterns !== null,
    hasChapters: true,
    alsoLoads: [],
    lifecycle: new lifecycleModule.JobModelLifecycle('checks'),
    titlePatterns,
  });
}

check('plan: an opted-in channel with patterns gets the unit right after the titles, on the titles option', () => {
  for (const id of ['youtube-telltale', 'youtube-fireside', 'youtube-unfiltered']) {
    const p = plan(id, RESOLVED);
    eq(p.units.slice(0, 2).map((u) => u.fields), [['titles'], ['pattern_titles']], `${id} first two units:`);
    has(p.units[1].label, '(cloud anthropic/titles)', `${id} on the titles option`);
    eq(p.units.filter((u) => u.fields.includes('pattern_titles')).length, 1, `${id} exactly one:`);
  }
});

check('plan: no unit without patterns, on a channel that does not opt in, or when nothing writes titles', () => {
  const none = (p) => p.units.filter((u) => u.fields.includes('pattern_titles')).length;
  eq(none(plan('youtube-telltale', null)), 0, 'no evidence:');
  eq(none(plan('youtube-shorts', RESOLVED)), 0, 'shorts:');
  eq(none(plan('podcast-spreaker', RESOLVED)), 0, 'podcast:');
  eq(none(plan('youtube-littlegoose', RESOLVED)), 0, 'little goose:');
  eq(none(plan('youtube-telltale', RESOLVED, { fields: ['description', 'tags', 'hashtags', 'pinned_comment'] })), 0, 'no titles:');
});

check('plan: titlePatterns must be stated (null for none), never left out', async () => {
  const channel = assets.channel('youtube-telltale');
  await throwsLike(() => tasks.planMetadataUnits({
    routing: routing.resolveMetadataRouting(undefined),
    models: { bind: (task, optionId) => ({ id: optionId, kind: 'cloud', model: `anthropic/${task}` }) },
    aiManager: { promptSetSectionKeys: () => new Set(['TITLES']), tagStyle: () => 'youtube', loadedChannel: () => channel },
    hasInsights: false, hasChapters: true, alsoLoads: [], lifecycle: new lifecycleModule.JobModelLifecycle('checks'),
  }), /was not told this run's tested patterns/, 'missing');
});

(async () => {
  for (const run of pending) await run();
  realLog(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
