/**
 * Checks for the re-roll gate (electron/services/metadata/reroll/, P9, LEDGER #201).
 *
 * WHAT IT COVERS, and why: the gate is Law 3's one declared exception, so every property that
 * keeps it an exception — measured, bounded, never withholding — is checked here without a model.
 *
 *   - every question QUOTES the text it judges, and no question, state or option carries an index
 *     (plan §0a; Owen: "we give it the thing it's judging");
 *   - a choice takes 2..26 options, a 27-title list is declared unranked, never cut;
 *   - the floor: the gate's copy reads every answer exactly as the chaptering service's original
 *     does (the copy-with-parity rule; chaptering/ is another agent's and must not be imported);
 *   - the cap: at most 3 re-rolls, then the best-scoring attempt ships with a warning naming the
 *     rule; a stored cap above 3 is refused; a rewrite that scores worse never replaces;
 *   - an answer with no evidence passes and is declared; decide_not_served stops the gate by name;
 *     a re-roll that comes back with the wrong number of lines throws and applies nothing;
 *   - the ranking: rotations cancel a position bias, the order is best first, and the per-video
 *     baseline (relative to a fair share) sums to n;
 *   - the binding on a real-shaped item: answers go back by position, the link block never reaches
 *     a model, an untouched field stays byte-identical, and every decide, every re-roll and the
 *     ranking land in `_prompt_trace` with their answers, and in `reroll_gate` and the warnings;
 *   - the description sentence splitter round-trips all 571 corpus descriptions byte for byte;
 *   - the settings: bad values are refused by name; the gate off asks nothing and says so.
 *
 * NO MODEL IS CALLED. Run it against the COMPILED main process, which is what ships:
 *
 *   npm run build:electron && npm run check:reroll
 */
const fs = require('fs');
const path = require('path');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main');
const R = (name) => require(path.join(ROOT, 'services/metadata/reroll', name + '.js'));
const pa = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
pa.initPromptAssets(path.join(__dirname, '..', 'electron', 'assets', 'prompts'));

const rules = R('rules');
const read = R('decide-read');
const checksM = R('checks');
const ranking = R('ranking');
const gate = R('gate');
const settingsM = R('settings');
const service = R('reroll.service');
const assign = require(path.join(ROOT, 'services/metadata/chaptering/assign.js'));

const assert = require('assert');
const checks = [];
function check(name, fn) {
  checks.push({ name, fn });
}
let failures = 0;
async function run() {
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log('PASS  ' + name);
    } catch (e) {
      failures++;
      console.log('FAIL  ' + name + ' :: ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join(' | ') : e));
    }
  }
  console.log(failures ? `\n${failures} FAILED` : `\nall ${checks.length} passed`);
  process.exit(failures ? 1 : 0);
}

const FACTS = rules.channelFacts('Test Channel', ['owen morgan', 'telltale']);
// The mechanics are checked at a flat 0.5 on every rule, so they do not move when a measured
// default does (the defaults have their own check below).
const ON = settingsM.resolveRerollGateSettings({
  rerollGate: 'on',
  rerollGateTuning: { thresholds: Object.fromEntries(Object.keys(settingsM.REROLL_GATE_DEFAULTS.thresholds).map((k) => [k, 0.5])) },
});
const yes = (p, extra = {}) => ({ type: 'yesno', p, labelMass: 0.97, missingLabels: [], ...extra });

/**
 * A fake scorer: P(yes) for a rule question is `judge(rule, quotedText)`, read back out of the
 * statement the gate wrote — so the fake can only answer what the question quotes.
 */
function fakeDecide(judge, log = []) {
  return async (request, o) => {
    log.push({ request, what: o.what });
    const answers = {};
    for (const [name, q] of Object.entries(request.questions)) {
      if (q.type === 'yesno') {
        const m = /"([^"]*)"/.exec(q.instructions);
        const rule = name.slice(name.indexOf('_') + 1);
        answers[name] = yes(judge(rule, m ? m[1] : null));
      } else {
        const names = Object.keys(q.options);
        const probabilities = {};
        const raw = names.map((n) => judge('rank', q.options[n], names.indexOf(n)));
        const z = raw.reduce((a, b) => a + b, 0);
        names.forEach((n, k) => (probabilities[n] = raw[k] / z));
        answers[name] = { type: 'choice', probabilities, labelMass: 0.95, missingLabels: [] };
      }
    }
    return { answers };
  };
}

// ------------------------------------------------------------------- quoting, never indexing

check('every rule question quotes its unit, and nothing the model reads carries an index', () => {
  const units = ['Owen mocks the prophecy', 'The prophecy that never dates itself', 'Gene Bailey hosts Flashpoint'];
  const batches = rules.ruleRequests('chapters', units.join('\n'), units, FACTS);
  const all = batches.flatMap((b) => Object.entries(b.request.questions));
  assert.strictEqual(all.length, units.length * rules.FIELD_RULES.chapters.length);
  for (const [name, q] of all) {
    const unit = Number(/^u(\d+)_/.exec(name)[1]);
    assert.ok(q.instructions.includes(`"${units[unit]}"`), `${name} quotes its unit`);
    assert.ok(!/\b(line|entry|item|number|#)\s*\d/i.test(q.instructions), `${name} names no position: ${q.instructions}`);
    assert.ok(!read.integerLike(name), `${name} is not integer-like`);
  }
  const state = batches[0].request.state;
  for (const u of units) assert.ok(state.includes(u));
  assert.ok(!/^\s*\d+[.)]/m.test(state), 'the state lists the units without numbers');
  assert.ok(state.includes('owen morgan, telltale'), 'the state names the creator');
});

check('ranking options are the titles themselves, named by position, over a state with no list', () => {
  const titles = ['First title here', 'Second title here', 'Third title here'];
  const req = ranking.rankRequest(titles, 'Chan');
  assert.strictEqual(Object.keys(req.questions).length, 3, 'one rotation per title');
  for (const q of Object.values(req.questions)) {
    assert.deepStrictEqual(Object.keys(q.options), ['title 1', 'title 2', 'title 3']);
    assert.deepStrictEqual([...Object.values(q.options)].sort(), [...titles].sort());
  }
  for (const t of titles) assert.ok(!req.state.includes(t), 'the state does not carry the list (its order would bias)');
  // Every title sits in every position exactly once.
  for (const t of titles) {
    const positions = Object.values(req.questions).map((q) => Object.values(q.options).indexOf(t)).sort();
    assert.deepStrictEqual(positions, [0, 1, 2]);
  }
});

check('the re-roll prompt names the rule in positive form and carries the failing entries, one per line', () => {
  const p = rules.revisePrompt('chapters', 'creator', ['Owen mocks X', 'The host reads Y'], FACTS);
  assert.ok(p.includes('Owen mocks X\nThe host reads Y\n'));
  assert.ok(p.includes('2 of them') && p.includes('Write 2 lines'));
  assert.ok(p.includes(pa.promptAssets().pipeline('reroll.yml', 'reroll.rules.creator')));
  assert.throws(() => rules.revisePrompt('chapters', 'creator', [], FACTS), /no entries/);
});

check('Owen\'s standard (LEDGER #211) is in the rule statements, and the labels agree with it', () => {
  const creator = rules.statementFor('description', 'creator', 'Subscribe and leave a comment.', FACTS);
  assert.ok(/subscribe, comment/.test(creator) && /does not count/.test(creator), 'a call to action is not a reference to the creator');
  const narrates = rules.statementFor('chapters', 'narrates', 'The fossil-record claim, refuted', FACTS);
  assert.ok(/, refuted/.test(narrates) && /mocked line by line/.test(narrates) && /does not count/.test(narrates), '"X, refuted" is not narration');
  // The quoted unit still comes first, so the fake scorer (and the model) reads the text being judged.
  assert.ok(creator.startsWith('The sentence "Subscribe and leave a comment."'));
  const labels = fs.readFileSync(path.join(__dirname, 'fixtures', 'titlecheck', 'labels.jsonl'), 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const ruled = labels.filter((l) => l.ruled_by);
  assert.deepStrictEqual(ruled.map((l) => l.id).sort(), ['ch05', 'ch32', 'ch34', 'ch36', 'de09', 'de13']);
  for (const l of ruled) assert.ok(!l.violates.includes(l.set === 'chapters' ? 'narrates' : 'creator'), `${l.id} is clean under #211`);
  // `sentence` never gates (#211: chapter titles are "one or two sentences").
  assert.strictEqual(settingsM.REROLL_GATE_DEFAULTS.thresholds['chapters.sentence'], 0);
  assert.throws(() => rules.statementFor('titles', 'sentence', 'x', FACTS), /not asked of titles/);
});

// ------------------------------------------------------------------- at most 26

check('a choice takes 2..26 options; 27 titles are refused by the ranker and declared unranked by the gate', async () => {
  const titles = Array.from({ length: 27 }, (_, i) => `Title number ${String.fromCharCode(65 + (i % 26))}${i}`);
  assert.throws(() => ranking.rankRequest(titles, 'C'), /at most 26/);
  assert.throws(() => ranking.rankRequest(['only one'], 'C'), /at least 2/);
  assert.doesNotThrow(() => ranking.rankRequest(titles.slice(0, 26), 'C'));
  const res = await gate.runGate({
    fields: [{ field: 'titles', units: titles, stateText: (u) => u.join('\n') }],
    facts: FACTS, decide: fakeDecide(() => 0.01), revise: async () => { throw new Error('no re-roll expected'); },
    settings: ON, sourceLabel: 'item', rank: true,
  });
  assert.strictEqual(res.record.ranking, null);
  assert.ok(res.record.warnings.some((w) => w.includes('27 titles were not ranked')));
});

// ------------------------------------------------------------------- the floor, in parity

check('the floor: the gate reads every yes/no and choice answer exactly as chaptering/assign.ts does', () => {
  const yesnos = [
    yes(0.8), yes(0.2, { labelMass: 0.5 }), yes(1, { labelMass: 0.4, missingLabels: ['No'] }), yes(0, { labelMass: 0.3, missingLabels: ['Yes'] }),
    yes(0.6, { labelMass: 0.005 }), yes(1, { labelMass: 0.999, missingLabels: ['No'] }),
  ];
  for (const a of yesnos) {
    const mine = read.readYesNo(a, 'q');
    const theirs = assign.readYesNo(a, 'q');
    assert.deepStrictEqual({ p: mine.p, floored: mine.floored, labelMass: mine.labelMass }, { p: theirs.p, floored: theirs.floored, labelMass: theirs.labelMass });
  }
  const names = ['section 1', 'section 2', 'section 3'];
  const choices = [
    { type: 'choice', probabilities: { 'section 1': 0.7, 'section 2': 0.2, 'section 3': 0.1 }, labelMass: 0.9 },
    { type: 'choice', probabilities: { 'section 1': 0.8, 'section 2': 0.2, 'section 3': null }, labelMass: 0.6, missingLabels: ['section 3'] },
    { type: 'choice', probabilities: { 'section 1': 1, 'section 2': null, 'section 3': null }, labelMass: 0.3, missingLabels: ['section 2', 'section 3'] },
    { type: 'choice', probabilities: { 'section 1': 0.5, 'section 2': 0.5, 'section 3': 0 }, labelMass: 0.002 },
  ];
  for (const a of choices) {
    const mine = read.readChoice(a, names, 'q');
    const theirs = assign.readChoiceDistribution(a, names, 'q');
    assert.strictEqual(mine.skipped, theirs.skipped);
    assert.deepStrictEqual(mine.missing, theirs.missing);
    theirs.logProbs.forEach((lp, i) => assert.ok(Math.abs(Math.exp(lp) - mine.probs[i]) < 1e-12, `option ${i}: ${Math.exp(lp)} vs ${mine.probs[i]}`));
  }
  assert.throws(() => read.readYesNo(yes(0.5, { labelMass: 0.5, missingLabels: ['Yes', 'No'] }), 'q'), /neither Yes nor No/);
});

// ------------------------------------------------------------------- the cap and the ship-with-warning

check('at most three re-rolls, then the best-scoring attempt ships with a warning naming the rule', async () => {
  const sent = [];
  let n = 0;
  // Every rewrite still names the creator; the second one does it least (P(yes) 0.6 vs 0.9/0.8/0.7).
  const p = new Map([['Owen mocks X', 0.95], ['Owen jokes X', 0.9], ['Morgan mocks X', 0.6], ['the host mocks X', 0.7]]);
  const rewrites = ['Owen jokes X', 'Morgan mocks X', 'the host mocks X'];
  const res = await gate.runGate({
    fields: [{ field: 'chapters', units: ['Owen mocks X', 'A clean label'], stateText: (u) => u.join('\n') }],
    facts: FACTS,
    decide: fakeDecide((rule, text) => (rule === 'creator' ? p.get(text) ?? 0.01 : 0.01)),
    revise: async (r) => { sent.push(r); return [rewrites[n++]]; },
    settings: ON, sourceLabel: 'item', rank: false,
  });
  assert.strictEqual(sent.length, 3, 'three re-roll calls, never a fourth');
  assert.deepStrictEqual(sent.map((r) => r.attempt), [1, 2, 3]);
  assert.ok(sent.every((r) => r.rule === 'creator' && r.units.length === 1));
  assert.deepStrictEqual(res.fields.get('chapters'), ['Morgan mocks X', 'A clean label'], 'the best attempt ships, the clean unit untouched');
  const f = res.record.fields[0];
  assert.strictEqual(f.rerolls, 3);
  assert.strictEqual(f.units[0].attempts.length, 4);
  assert.strictEqual(f.units[1].attempts.length, 1);
  assert.ok(res.record.warnings.some((w) => w.includes('"Morgan mocks X" still fails creator') && w.includes('after 3 re-rolls')));
  // Round 3 was sent the best-so-far text, not the worse one round 2 produced.
  assert.strictEqual(sent[2].units[0], 'Morgan mocks X');
});

check('a rewrite that scores worse never replaces what it was asked to fix; one that passes stops the loop', async () => {
  const res = await gate.runGate({
    fields: [{ field: 'titles', units: ['Owen reacts to it', 'Fine title'], stateText: (u) => u.join('\n') }],
    facts: FACTS,
    decide: fakeDecide((rule, text) => (rule === 'creator' && text === 'Owen reacts to it' ? 0.7 : rule === 'nonsense' && text === 'garbled' ? 0.99 : text === 'A clean one' ? 0.01 : 0.02)),
    revise: (() => { let k = 0; return async () => [k++ === 0 ? 'garbled' : 'A clean one']; })(),
    settings: ON, sourceLabel: 'item', rank: false,
  });
  assert.deepStrictEqual(res.fields.get('titles'), ['A clean one', 'Fine title']);
  assert.strictEqual(res.record.fields[0].rerolls, 2);
  assert.strictEqual(res.record.warnings.length, 0);
});

check('the cap is Law 3\'s: a stored maxRerolls above 3 is refused, 0 checks without re-rolling', async () => {
  assert.throws(() => settingsM.resolveRerollGateSettings({ rerollGateTuning: { maxRerolls: 4 } }), /0 to 3/);
  const zero = settingsM.resolveRerollGateSettings({ rerollGate: 'on', rerollGateTuning: { maxRerolls: 0 } });
  const res = await gate.runGate({
    fields: [{ field: 'titles', units: ['Owen says hi', 'Other'], stateText: (u) => u.join('\n') }],
    facts: FACTS, decide: fakeDecide((rule, t) => (t === 'Owen says hi' ? 0.99 : 0.01)),
    revise: async () => { throw new Error('no re-roll at cap 0'); }, settings: zero, sourceLabel: 'item', rank: false,
  });
  assert.deepStrictEqual(res.fields.get('titles'), ['Owen says hi', 'Other']);
  assert.ok(res.record.warnings.some((w) => w.includes('after 0 re-rolls')));
});

check('an answer with no evidence passes and is declared; decide_not_served stops the gate by name', async () => {
  const res = await gate.runGate({
    fields: [{ field: 'thumbnail_text', units: ['KNEEL OR ELSE', 'HOLY THREAT'], stateText: (u) => u.join('\n') }],
    facts: FACTS,
    decide: async (req) => ({ answers: Object.fromEntries(Object.keys(req.questions).map((n) => [n, yes(0.99, { labelMass: 0.001 })])) }),
    revise: async () => { throw new Error('nothing to re-roll'); }, settings: ON, sourceLabel: 'item', rank: false,
  });
  assert.deepStrictEqual(res.fields.get('thumbnail_text'), ['KNEEL OR ELSE', 'HOLY THREAT']);
  assert.ok(res.record.fields[0].units.every((u) => u.attempts[0].readings.every((r) => r.read === 'no-evidence' && r.score === 1)));
  assert.ok(res.record.warnings.some((w) => w.includes('4 thumbnail_text rule question(s)') && w.includes('counted as passes')));
  const refused = Object.assign(new Error('mac cannot serve'), { code: 'decide_not_served' });
  await assert.rejects(
    gate.runGate({ fields: [{ field: 'titles', units: ['a b', 'c d'], stateText: (u) => u.join('\n') }], facts: FACTS, decide: async () => { throw refused; }, revise: async () => [], settings: ON, sourceLabel: 'item', rank: false }),
    (e) => e.code === 'decide_not_served' && /mac cannot serve/.test(e.message),
  );
});

check('a re-roll that comes back with the wrong number of lines throws and applies nothing', async () => {
  await assert.rejects(
    gate.runGate({
      fields: [{ field: 'chapters', units: ['Owen says A', 'Owen says B', 'Fine'], stateText: (u) => u.join('\n') }],
      facts: FACTS, decide: fakeDecide((rule, t) => (rule === 'creator' && t.startsWith('Owen') ? 0.9 : 0.01)),
      revise: async () => ['only one line'], settings: ON, sourceLabel: 'item', rank: false,
    }),
    (e) => e.code === 'answer_shape' && /sent 2 entries and got 1/.test(e.message),
  );
});

// ------------------------------------------------------------------- the ranking

check('rotations cancel a position bias: the preferred title ranks first wherever it was listed', async () => {
  const titles = ['Plain title one', 'The favourite title', 'Plain title three', 'Plain title four'];
  // The fake loves letter A (x5) and likes the favourite (x3) wherever it sits.
  const decide = fakeDecide((rule, text, position) => (position === 0 ? 5 : 1) * (text === 'The favourite title' ? 3 : 1));
  const r = await ranking.rankTitles(titles, 'C', decide, 'rank');
  assert.strictEqual(r.order[0].title, 'The favourite title');
  assert.deepStrictEqual(r.order.map((o) => o.rank), [1, 2, 3, 4]);
  assert.ok(Math.abs(r.order.reduce((a, o) => a + o.relative, 0) - titles.length) < 1e-9, 'relative scores sum to n (1.0 = a fair share)');
  assert.ok(r.order[0].relative > 1.5);
  // Ties keep the generated order.
  assert.deepStrictEqual(r.order.slice(1).map((o) => o.title), ['Plain title one', 'Plain title three', 'Plain title four']);
  // Without rotations (one question), letter A would have won.
  const one = await decide({ state: '', questions: { q: Object.values(ranking.rankRequest(titles, 'C').questions)[0] }, missing: 'report' }, { what: 'x' });
  const p = one.answers.q.probabilities;
  assert.ok(p['title 1'] > p['title 2'], 'a single ordering is biased toward A');
});

// ------------------------------------------------------------------- the binding on an item

const ROUTING = { titles: 'qwen38-27b', chapters: 'qwen38-27b', description: 'qwen38-27b', thumbnail_text: 'qwen38-27b', pinned_comment: 'qwen38-27b', tags: 'qwen35-9b' };
const LINKS = '🔥 Support the Show:\nhttps://example.com/patreon';
function realishItem() {
  return {
    _title: 'u1 - test',
    _prompt_set: 'youtube-telltale',
    _prompt_trace: [{ what: 'the titles call for item_1', model: 'm', chars: 1, at: 't', prompt: 'p' }],
    titles: ['Owen reacts to the prophecy', 'The prophecy that never dates itself'],
    thumbnail_text: ['NO DATE', 'HOLY THREAT'],
    pinned_comment: ['Has any of her prophecies come true? Tell me.', 'What did your church say?'],
    description_hook: 'Amanda Grace says Republicans must bow down.',
    description: 'The prophecy has no date. This channel breaks it down for you.  It fails by its own terms.\n\n' + LINKS,
    chapters: [
      { title: 'The prophecy', startTime: 0, detail: 'd0' },
      { title: 'The host mocks the double decree', startTime: 65, detail: 'd1' },
    ],
  };
}
const judgeItem = (rule, text) => {
  if (rule === 'creator' && /Owen|host|This channel/.test(text)) return 0.93;
  if (rule === 'narrates' && /breaks it down/.test(text)) return 0.9;
  return 0.02;
};
const FIX = new Map([
  ['Owen reacts to the prophecy', 'A prophecy with no date'],
  ['The host mocks the double decree', 'The double decree'],
  ['This channel breaks it down for you.', 'It never says what it would destroy.'],
]);

check('on an item: answers go back by position, the link block never reaches a model, untouched fields stay identical', async () => {
  const item = realishItem();
  const before = JSON.parse(JSON.stringify(item));
  const seen = [];
  const warnings = [];
  await service.rerollGateItem(item, {
    settings: ON, aiManager: { descriptionLinks: () => LINKS }, routing: ROUTING, lifecycle: null, warnings, sourceLabel: 'u1 - test',
    bind: {
      decide: fakeDecide(judgeItem, seen),
      revise: async (r) => r.units.map((u) => FIX.get(u) ?? u),
    },
  });
  for (const { request } of seen) {
    const all = request.state + JSON.stringify(request.questions);
    assert.ok(!all.includes('example.com'), 'no link block in any decision');
    assert.ok(!/\b65\b|startTime/.test(all), 'no chapter timestamp in any decision');
  }
  assert.deepStrictEqual(item.titles, ['A prophecy with no date', 'The prophecy that never dates itself']);
  assert.deepStrictEqual(item.chapters.map((c) => c.title), ['The prophecy', 'The double decree']);
  assert.deepStrictEqual(item.chapters.map((c) => [c.startTime, c.detail]), [[0, 'd0'], [65, 'd1']], 'every other chapter key untouched');
  assert.strictEqual(item.description, 'The prophecy has no date. It never says what it would destroy.  It fails by its own terms.\n\n' + LINKS, 'the sentence is spliced in, spacing and links byte-identical');
  assert.strictEqual(item.description_hook, before.description_hook);
  assert.deepStrictEqual(item.thumbnail_text, before.thumbnail_text);
  assert.deepStrictEqual(item.pinned_comment, before.pinned_comment);
});

check('on an item: every decide, re-roll and the ranking are in _prompt_trace with answers, and in reroll_gate', async () => {
  const item = realishItem();
  const warnings = [];
  await service.rerollGateItem(item, {
    settings: ON, aiManager: { descriptionLinks: () => LINKS }, routing: ROUTING,
    lifecycle: null, warnings, sourceLabel: 'u1 - test',
    bind: { decide: fakeDecide((rule, text, pos) => (rule === 'rank' ? 1 : judgeItem(rule, text))), revise: async (r) => r.units.map((u) => FIX.get(u) ?? u) },
  });
  const trace = item._prompt_trace;
  assert.strictEqual(trace[0].what, 'the titles call for item_1', 'the run\'s own entries are untouched and first');
  const decides = trace.filter((t) => /rule checks/.test(t.what));
  const rerolls = trace.filter((t) => /re-roll \d \(/.test(t.what) && !/rule checks/.test(t.what));
  const rank = trace.filter((t) => /title ranking/.test(t.what));
  assert.ok(decides.length >= 5 + 3, 'one first reading per field, and one per re-rolled field');
  assert.ok(decides.every((t) => t.model === 'qwen3.5-9b' && t.answers && Object.keys(t.answers).length > 0 && t.prompt.includes('[decide]')));
  assert.strictEqual(rerolls.length, 3);
  assert.ok(rerolls.every((t) => t.model === 'qwen3.8-27b-4bit' && Array.isArray(t.answers) && t.prompt.length === t.chars));
  assert.strictEqual(rank.length, 1);
  assert.ok(Object.keys(rank[0].answers).length === 2);
  const g = item.reroll_gate;
  assert.strictEqual(g.mode, 'on');
  assert.strictEqual(g.scorer, 'qwen3.5-9b');
  assert.deepStrictEqual(g.fields.map((f) => f.field), ['titles', 'chapters', 'description', 'thumbnail_text', 'pinned_comment']);
  assert.deepStrictEqual(g.fields.map((f) => f.rerolls), [1, 1, 1, 0, 0]);
  assert.strictEqual(g.ranking.order.length, 2);
  assert.deepStrictEqual(g.warnings, []);
  assert.deepStrictEqual(warnings, []);
});

check('on an item: a unit that still fails is a run warning and a reroll_gate warning; the gate off asks nothing', async () => {
  const item = realishItem();
  const warnings = [];
  await service.rerollGateItem(item, {
    settings: ON, aiManager: { descriptionLinks: () => LINKS }, routing: ROUTING,
    lifecycle: null, warnings, sourceLabel: 'u1 - test',
    bind: { decide: fakeDecide((rule, text) => (rule === 'rank' ? 1 : judgeItem(rule, text))), revise: async (r) => r.units },
  });
  assert.strictEqual(item.titles[0], 'Owen reacts to the prophecy', 'nothing withheld: the original ships');
  assert.ok(warnings.some((w) => w.startsWith('u1 - test: re-roll gate: titles "Owen reacts to the prophecy" still fails creator')));
  assert.strictEqual(item.reroll_gate.warnings.length, warnings.length);
  const off = realishItem();
  let asked = 0;
  await service.rerollGateItem(off, {
    settings: settingsM.resolveRerollGateSettings({ rerollGate: 'off' }), aiManager: { descriptionLinks: () => LINKS }, routing: {}, lifecycle: null, warnings: [], sourceLabel: 'x',
    bind: { decide: async () => { asked++; return { answers: {} }; }, revise: async () => [] },
  });
  assert.strictEqual(asked, 0);
  assert.strictEqual(off.reroll_gate.mode, 'off');
  assert.deepStrictEqual(off.titles, realishItem().titles);
});

check('a description whose link block is not on its end is refused, not sent', () => {
  const item = realishItem();
  item.description = 'Prose only.\n\nSome other block';
  assert.throws(() => service.fieldsOf(item, LINKS, 'x'), /description_links/);
});

// ------------------------------------------------------------------- splitter, settings

check('the sentence splitter round-trips every corpus description byte for byte', () => {
  const file = path.join(__dirname, 'fixtures', 'titlecheck', 'descriptions.jsonl');
  const rows = fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  assert.ok(rows.length > 500);
  let sentences = 0;
  for (const r of rows) {
    const parts = rules.splitSentences(r.text);
    assert.strictEqual(rules.joinSentences(parts), r.text);
    sentences += parts.sentences.length;
  }
  assert.ok(sentences > rows.length * 3, `${sentences} sentences`);
  const s = rules.splitSentences('He said "No." Then left. Dr. Who? Yes!\n\nNew para');
  assert.deepStrictEqual(s.sentences, ['He said "No."', 'Then left.', 'Dr.', 'Who?', 'Yes!', 'New para']);
});

check('settings: the declared defaults; a bad stored value is refused by name', () => {
  const d = settingsM.resolveRerollGateSettings({});
  assert.deepStrictEqual(d, settingsM.REROLL_GATE_DEFAULTS);
  assert.strictEqual(d.maxRerolls, 3);
  // The measured numbers (P9.md): sentence is asked and recorded but never gates until Owen rules.
  assert.strictEqual(d.thresholds['chapters.sentence'], 0);
  assert.strictEqual(d.thresholds['chapters.creator'], 0.3);
  assert.strictEqual(d.thresholds['description.narrates'], 0.2);
  assert.strictEqual(d.mode, 'off', 'off until the calibration is complete (P9.md)');
  for (const f of Object.keys(rules.FIELD_RULES)) for (const r of rules.FIELD_RULES[f]) assert.strictEqual(typeof d.thresholds[`${f}.${r}`], 'number');
  assert.throws(() => settingsM.resolveRerollGateSettings({ rerollGate: 'yes' }), /"on" or "off"/);
  assert.throws(() => settingsM.resolveRerollGateSettings({ rerollGateTuning: { thresholds: { 'titles.sentence': 0.5 } } }), /not a rule the gate asks/);
  assert.throws(() => settingsM.resolveRerollGateSettings({ rerollGateTuning: { thresholds: { 'titles.creator': 2 } } }), /0 to 1/);
  assert.throws(() => settingsM.resolveRerollGateSettings({ rerollGateTuning: { speed: 1 } }), /does not read/);
  const t = settingsM.resolveRerollGateSettings({ rerollGateTuning: { thresholds: { 'titles.creator': 0.3 } } });
  assert.strictEqual(t.thresholds['titles.creator'], 0.3);
  assert.strictEqual(settingsM.REROLL_GATE_DEFAULTS.thresholds['titles.creator'], d.thresholds['titles.creator'], 'the defaults are not mutated');
  assert.throws(() => rules.channelFacts('No Brand', []), /brand_terms/);
});

check('the per-video baseline subtracts a capped median, frozen from the first reading', () => {
  const s = { ...ON, baselineCap: 0.3, baselineMinUnits: 3 };
  const b = checksM.baselinesOf('titles', [{ creator: 0.4, narrates: 0.1, nonsense: 0.9 }, { creator: 0.5, narrates: 0.1, nonsense: 0.9 }, { creator: 0.6, narrates: 0.2, nonsense: 0.9 }], s);
  assert.deepStrictEqual(b, { creator: 0.3, narrates: 0.1, nonsense: 0.3 });
  const u = checksM.unitScore('titles', 't', [{ rule: 'creator', pYes: 0.6, read: 'answered', labelMass: 1 }, { rule: 'narrates', pYes: 0.05, read: 'answered', labelMass: 1 }, { rule: 'nonsense', pYes: 0.9, read: 'answered', labelMass: 1 }], b, s);
  assert.ok(Math.abs(u.readings[0].score - 0.7) < 1e-12 && u.readings[1].score === 1 && Math.abs(u.readings[2].score - 0.4) < 1e-12);
  assert.deepStrictEqual(checksM.baselinesOf('titles', [{ creator: 0.9 }, { creator: 0.9 }], s), {}, 'too few units: no baseline');
  assert.deepStrictEqual(checksM.baselinesOf('titles', [{ creator: 0.9 }, { creator: 0.9 }, { creator: 0.9 }], { ...s, baselineCap: 0 }), {}, 'cap 0: off');
});

run();
