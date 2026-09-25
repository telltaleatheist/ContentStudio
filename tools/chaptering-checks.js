/**
 * Checks for the snap chaptering service (electron/services/metadata/chaptering/, LEDGER #199, #208).
 *
 * WHAT IT COVERS, and why: every place where the service decides something from data it did
 * not write, and where a wrong answer looks like a right one.
 *
 *   - the wire keeps the letter order (a JS object would silently re-letter integer-like keys);
 *   - Viterbi reproduces segment.py (fixtures ported from Briefcase's spec and the reference);
 *   - the outline parser, the assign question and the plug statement are the measured text;
 *   - a missing label is floored under the DECLARED rule and counted; a gated answer is a
 *     SKIPPED unit, reported, never floored quietly;
 *   - ad confirm keeps a confirmed stretch and re-segments a rejected one, asking once;
 *   - the two grains (LEDGER #208): refined leaves at `chapters`; at `stories` the chunk outlines
 *     merged into ONE stream outline, every sentence asked once, one Viterbi pass;
 *   - a prose outline (chunk or merged) is refused by name, naming the call;
 *   - the ad option is read against its per-video baseline; a plug the outline named as an
 *     ordinary item is flagged when the yes/no says so; the 5:00/10:00 prior lowers the bar at
 *     `chapters` only and places nothing;
 *   - titles think at the declared budget (off is declared), a run-out ships its label, and a
 *     mic/screen transcript is titled from HOST:/CLIP: lines;
 *   - `decide_not_served` ends the run naming the server, with no chapters;
 *   - sentence units carry times from the captions;
 *   - the granularity table maps every setting to a real prompt body and a positive cost;
 *   - PARITY: Viterbi, the confirm loop and the sentence splitter reproduce segment.py and
 *     submap.py on fixtures those files' own functions wrote (docs/crucible/reference/
 *     make_fixtures.py);
 *   - every ContentStudio transcript shape is read, and a word-level one keeps word times;
 *   - a yes/no is floored like a choice, and an ad check with no evidence confirms nothing;
 *   - a chapter too long for one title call is read in parts, declared, nothing truncated.
 *
 * NO MODEL IS CALLED: a deterministic fake stands in for both transports. Run it against the
 * COMPILED main process, which is what ships:
 *
 *   npm run build:electron && npm run check:chaptering
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
const C = (name) => require(path.join(ROOT, 'services/metadata/chaptering', name + '.js'));
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
promptAssetsModule.initPromptAssets(path.join(__dirname, '..', 'electron', 'assets', 'prompts'));

const types = C('types');
const assign = C('assign');
const viterbi = C('viterbi');
const outline = C('outline');
const plugs = C('plugs');
const units = C('units');
const granularity = C('granularity');
const prompts = C('prompts');
const chunks = C('chunks');
const service = C('chaptering.service');

const assert = require('assert');
const L = (p) => Math.log(p);
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
      console.log('FAIL  ' + name + ' :: ' + (e && e.message ? e.message : e));
    }
  }
  console.log(failures ? `\n${failures} FAILED` : `\nall ${checks.length} passed`);
  process.exit(failures ? 1 : 0);
}

// ------------------------------------------------------------------- fakes

/** A choice answer in the wire's camelCased shape: `chosen` at 0.98 (a real answer sits at 0.99+), the rest sharing 0.02. */
function choiceAnswer(names, chosen, opts = {}) {
  const missing = new Set(opts.missing || []);
  const live = names.filter((n) => !missing.has(n));
  const probabilities = {};
  // `adP` / `chosenP` shape a leaning answer: the ad option (named `adName`) holds adP, the chosen chosenP, the rest share what is left.
  const chosenP = opts.chosenP ?? 0.98;
  const fixed = opts.adName && opts.adName !== chosen ? opts.adP ?? 0 : 0;
  const rest = live.length - 1 - (fixed > 0 ? 1 : 0);
  for (const n of names) {
    if (missing.has(n)) probabilities[n] = null;
    else if (n === chosen) probabilities[n] = chosenP;
    else if (fixed > 0 && n === opts.adName) probabilities[n] = fixed;
    else probabilities[n] = (1 - chosenP - fixed) / Math.max(1, rest);
  }
  return { type: 'choice', probabilities, labelMass: opts.mass ?? 0.98, missingLabels: [...missing] };
}
function yesno(p) {
  return { type: 'yesno', p, labelMass: 0.97, missingLabels: [] };
}
/** The unit index a fake reads off the quoted sentence ("Sentence 123 ..."): the fake's privilege, never the model's. */
function unitOf(instructions) {
  const m = /Sentence from the transcript above: "Sentence (\d+)/.exec(instructions);
  if (!m) throw new Error('fake decide: could not read the unit from ' + instructions.slice(0, 80));
  return Number(m[1]);
}
function isPlug(description) {
  return description.startsWith('An ad, sponsor read or self-promotion');
}

/**
 * A fake video of `n` units, 10 s each, in `sections` (each [from, to, label, subLabels?]).
 * The fake outline answers level 1 with the section labels when the prompt holds the whole
 * video, and level 2 with a section's subLabels when it holds only that section. The fake
 * assign picks the section (or sub-section) a unit falls in; `ads` = [from, to) assigned to
 * the plug item at level 1, confirmed with `adVerdict`.
 */
function fakeVideo(n, sections, opts = {}) {
  const captions = Array.from({ length: n }, (_, i) => ({
    start: i * 10,
    end: i * 10 + 10,
    text: `Sentence ${i} of the fake video says something about the topic at hand.`,
    ...(opts.speakerOf ? { speaker: opts.speakerOf(i) } : {}),
  }));
  const calls = { chat: [], decide: [] };
  const ads = opts.ads || null;
  const chat = async (prompt, o) => {
    calls.chat.push({ prompt, o });
    if (o.role === 'summarize') {
      const m = /Title chapter (\d+)/.exec(prompt);
      return { text: `Title ${m[1]}\nSummary of chapter ${m[1]}.`, finishReason: 'stop' };
    }
    if (opts.outlineAnswer) {
      const own = opts.outlineAnswer(o.what, prompt);
      if (own !== undefined) return { text: own, finishReason: 'stop' };
    }
    // The stream outline merges the chunk outlines: it answers with the section labels the
    // chunk outlines in its prompt name, in order.
    if (o.what.startsWith('stream outline')) {
      return { text: sections.filter((s) => prompt.includes(`\n${s[2]}`)).map((s) => s[2]).join('\n'), finishReason: 'stop' };
    }
    // The fake reads the level off the call's `what` line (its privilege, never the model's):
    // a level-1 chunk answers with the section labels its units fall in, a level-2 call with
    // the one section's sub-labels.
    const level = Number(/level (\d)/.exec(o.what)[1]);
    const covered = sections.filter((s) => Array.from({ length: s[1] - s[0] }, (_, k) => s[0] + k).some((i) => prompt.includes(`Sentence ${i} of`)));
    if (level === 1) return { text: covered.map((s) => s[2]).join('\n'), finishReason: 'stop' };
    const sec = covered[0];
    if (!sec || !sec[3]) return { text: 'Only one thing here', finishReason: 'stop' };
    return { text: sec[3].map((x) => x.label).join('\n'), finishReason: 'stop' };
  };
  const decide = async (req, o) => {
    calls.decide.push({ req, o });
    if (opts.decideThrows) throw opts.decideThrows;
    const answers = {};
    for (const [name, q] of Object.entries(req.questions)) {
      if (q.type === 'yesno') {
        answers[name] = yesno(opts.adVerdict ?? 0.9);
        continue;
      }
      const names = Object.keys(q.options);
      const descs = names.map((k) => q.options[k]);
      const i = unitOf(q.instructions);
      let chosen;
      const plugAt = descs.findIndex(isPlug);
      if (ads && i >= ads[0] && i < ads[1] && plugAt >= 0) chosen = names[plugAt];
      else {
        const sec = sections.find((s) => i >= s[0] && i < s[1]);
        const level1 = descs.indexOf(sec[2]);
        if (level1 >= 0) chosen = names[level1];
        else {
          const sub = sec[3].find((x) => i >= x.from && i < x.to);
          chosen = names[descs.indexOf(sub.label)];
        }
      }
      const extra = opts.perUnit ? opts.perUnit(i) : {};
      answers[name] = choiceAnswer(names, chosen, { ...extra, ...(plugAt >= 0 ? { adName: names[plugAt] } : {}) });
    }
    return { answers };
  };
  return { captions, chat, decide, calls };
}

// ------------------------------------------------------------------- wire order

check('a JS object re-letters integer-like keys, which is why option names are never numbers', () => {
  assert.deepStrictEqual(Object.keys({ 2: 'b', 1: 'a', x: 'c' }), ['1', '2', 'x']);
  assert.ok(assign.integerLike('12') && !assign.integerLike('section 12') && !assign.integerLike('s12'));
});

check('wireOptions keeps letter order for 12 items, through JSON, and refuses integer-like names by name', () => {
  const items = Array.from({ length: 12 }, (_, k) => `Item ${k + 1}`);
  const names = assign.optionNames(12);
  assert.deepStrictEqual(names, items.map((_, k) => `section ${k + 1}`));
  const wire = assign.wireOptions(items, names);
  assert.deepStrictEqual(Object.keys(wire), names);
  assert.deepStrictEqual(Object.keys(JSON.parse(JSON.stringify(wire))), names);
  assert.throws(() => assign.wireOptions(items, items.map((_, k) => String(k + 1))), /option name '1' is integer-like/);
  assert.throws(() => assign.wireOptions(['a']), /at least 2/);
  assert.throws(() => assign.wireOptions(Array.from({ length: 27 }, (_, k) => `i${k}`)), /at most 26/);
  for (let i = 0; i < 200; i++) assert.ok(!assign.integerLike(assign.questionName(i)));
});

// ------------------------------------------------------------------- viterbi

function rows(prefs, m, strong = 0.9) {
  return prefs.map((j) => Array.from({ length: m }, (_, k) => (k === j ? L(strong) : L((1 - strong) / (m - 1)))));
}

check('viterbi: [] for no units and the argmax for one', () => {
  assert.deepStrictEqual(viterbi.viterbi([], 20), []);
  assert.deepStrictEqual(viterbi.viterbi([[L(0.2), L(0.7), L(0.1)]], 20), [1]);
});
check('viterbi: with no switch cost, follows the per-unit argmax', () => {
  assert.deepStrictEqual(viterbi.viterbi(rows([0, 1, 0, 2, 2], 3), 0), [0, 1, 0, 2, 2]);
});
check('viterbi: the switch cost trades a brief excursion against two switches', () => {
  const M = [[0, -10], [0, -10], [-5, 0], [0, -10], [0, -10]];
  assert.deepStrictEqual(viterbi.viterbi(M, 2), [0, 0, 1, 0, 0]);
  assert.deepStrictEqual(viterbi.viterbi(M, 3), [0, 0, 0, 0, 0]);
  assert.deepStrictEqual(viterbi.viterbi(M, 20), [0, 0, 0, 0, 0]);
});
check('viterbi: a sustained change is worth one switch at cost 20', () => {
  const prefs = [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1, 1, 1, 1, 1, 1, 1];
  assert.deepStrictEqual(viterbi.viterbi(rows(prefs, 4, 0.97), 20), prefs);
});
check('viterbi: a theme recurs after an aside (any item may follow any other), absorbed at cost 40', () => {
  const prefs = [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 0, 0];
  const p = viterbi.viterbi(rows(prefs, 3, 0.999), 20);
  assert.deepStrictEqual(p, prefs);
  assert.deepStrictEqual(viterbi.runsOf(p, 0), [[0, 8], [16, 24]]);
  assert.deepStrictEqual(viterbi.segments(p).map((s) => s.item), [0, 2, 0]);
  assert.deepStrictEqual(viterbi.boundaries(p), [8, 16]);
  assert.ok(viterbi.viterbi(rows(prefs, 3, 0.999), 40).every((j) => j === 0));
});
check('viterbi: ties break toward the lower item, as Python max() does; ragged rows are refused', () => {
  assert.deepStrictEqual(viterbi.viterbi([[0, 0], [0, 0]], 1), [0, 0]);
  assert.throws(() => viterbi.viterbi([[0, 0], [0]], 1), /row 1/);
});

// ------------------------------------------------------------------- outline + prompts

check('parseOutline strips bullets, drops empties, dedupes case-insensitively, keeps order', () => {
  const content = '- Intro and greeting\n\n* The tax story \n• intro and greeting\n\tListener mail\t\n  -  \nThe Tax Story';
  assert.deepStrictEqual(outline.parseOutline(content), ['Intro and greeting', 'The tax story', 'Listener mail']);
  assert.deepStrictEqual(outline.parseOutline('Alpha -\r\nBeta*\r\n'), ['Alpha', 'Beta']);
});
check('parseOutline caps at 25 after dedup, removes numbering and bold, clips at 120', () => {
  const lines = Array.from({ length: 40 }, (_, i) => `Item ${i}`);
  const items = outline.parseOutline(['Item 0', ...lines].join('\n'));
  assert.strictEqual(items.length, 25);
  assert.strictEqual(items[24], 'Item 24');
  assert.deepStrictEqual(outline.parseOutline(lines.join('\n'), 3), ['Item 0', 'Item 1', 'Item 2']);
  assert.deepStrictEqual(outline.parseOutline(`1. **Opening**\n2) The 1990s recap\n${'x'.repeat(200)}`), ['Opening', 'The 1990s recap', 'x'.repeat(119) + '…']);
});
check('parseOutline: one item is an answer; no usable item is refused by name', () => {
  assert.deepStrictEqual(outline.parseOutline('Only one\nonly ONE\n'), ['Only one']);
  assert.throws(() => outline.parseOutline('  \n - \n**\n'), (e) => e instanceof types.ChapteringError && e.code === 'outline_empty');
});
check('the detailed outline body, the assign question and the plug statement are segment.py verbatim', () => {
  assert.strictEqual(
    prompts.SNAP_PROMPTS.outline('chapters', 'One.\nTwo.', 25, '1 minute'),
    'Here is a transcript of a video.\n\nOne.\nTwo.\n\nList the sections of this video in the order they happen. ' +
      'A new section starts wherever the video moves to a different subject, story, clip, ad or aside. ' +
      'Write one short, specific label per line (at most 25 lines), with no numbering and nothing else.',
  );
  assert.strictEqual(
    prompts.SNAP_PROMPTS.assign('Now to the weather.', 'That was the news.'),
    'Sentence from the transcript above: "Now to the weather."\n(The sentence just before it: "That was the news.")\nWhich section of the video is this sentence part of?',
  );
  const q = prompts.SNAP_PROMPTS.assign('a'.repeat(301), 'b'.repeat(250));
  assert.ok(q.includes(`"${'a'.repeat(299)}…"`) && q.includes(`"${'b'.repeat(199)}…"`));
  assert.strictEqual(prompts.clip('😀'.repeat(5), 3), '😀😀…');
  assert.strictEqual(prompts.SNAP_PROMPTS.START_OF_VIDEO, '(start of the video)');
  // With no promoted items, the ad item and its statement are segment.py:23 and :94-96 verbatim.
  assert.strictEqual(prompts.SNAP_PROMPTS.plugItem([]), 'An ad, sponsor read or self-promotion (Patreon, merch, a book, asking viewers to subscribe or support)');
  assert.strictEqual(
    prompts.SNAP_PROMPTS.plugConfirm(['Use code X.', 'Thanks to our sponsor.'], undefined),
    'Passage from the transcript above: "Use code X. Thanks to our sponsor."\nIn this passage the speaker is advertising or promoting something: ' +
      'a sponsor, their own Patreon, merch, a book, or asking viewers to subscribe, follow or support them.',
  );
  // With them, the channel's own plugs are named.
  const stmt = prompts.SNAP_PROMPTS.plugConfirm(['Use code X.', 'Thanks to our sponsor.'], ['the Patreon']);
  assert.ok(stmt.startsWith('Passage from the transcript above: "Use code X. Thanks to our sponsor."\nIn this passage the speaker is advertising or promoting something'));
  assert.ok(stmt.includes('(the Patreon)'));
  assert.ok(prompts.SNAP_PROMPTS.plugConfirm(['z'.repeat(800)], []).includes(`"${'z'.repeat(699)}…"`));
  assert.ok(prompts.SNAP_PROMPTS.plugConfirm(['{promoted_items} $&'], ['the Patreon']).includes('"{promoted_items} $&"'));
  assert.ok(prompts.SNAP_PROMPTS.plugItem(['the Patreon', 'the merch shop']).includes('the Patreon; the merch shop'));
  assert.ok(prompts.SNAP_PROMPTS.plugItem(['the Patreon']).startsWith('An ad, sponsor read or self-promotion'));
  // A transcript holding a $-pattern or a brace survives the fill.
  assert.ok(prompts.SNAP_PROMPTS.outline('stories', 'costs $& and {max_items}', 25, '').includes('costs $& and {max_items}'));
});
check('assignQuestions quotes the sentence and the one before, "(start of the video)" first, keyed s<i>', () => {
  const wire = assign.wireOptions(['Intro', 'Main']);
  const qs = assign.assignQuestions(['First one here.', 'Second one here.'], 0, 2, wire, prompts.SNAP_PROMPTS.START_OF_VIDEO);
  assert.deepStrictEqual(Object.keys(qs), ['s0', 's1']);
  assert.ok(qs.s0.instructions.includes('(The sentence just before it: "(start of the video)")'));
  assert.ok(qs.s1.instructions.includes('(The sentence just before it: "First one here.")'));
  assert.strictEqual(qs.s0.options, wire);
  const mid = assign.assignQuestions(['A sentence.'], 0, 1, wire, 'Earlier sentence.');
  assert.ok(mid.s0.instructions.includes('"Earlier sentence."'));
});

// ------------------------------------------------------------------- distributions

check('a full answer renormalises to a proper log distribution with nothing missing or skipped', () => {
  const names = ['section 1', 'section 2', 'section 3'];
  const d = assign.readChoiceDistribution(choiceAnswer(names, 'section 2'), names, 'q');
  assert.deepStrictEqual(d.missing, []);
  assert.strictEqual(d.skipped, false);
  const sum = d.logProbs.reduce((s, lp) => s + Math.exp(lp), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9, `sums to ${sum}`);
  assert.ok(Math.abs(d.logProbs[1] - L(0.98)) < 1e-9);
});
check('a missing label takes the declared floor (at most the smallest returned label, at least ln 1e-12) and is named', () => {
  const names = ['section 1', 'section 2', 'section 3'];
  const d = assign.readChoiceDistribution(choiceAnswer(names, 'section 1', { missing: ['section 3'], mass: 0.9 }), names, 'q');
  assert.deepStrictEqual(d.missing, ['section 3']);
  assert.strictEqual(d.skipped, false);
  assert.ok(d.logProbs[2] <= d.logProbs[1], 'the floor is at most the smallest returned label');
  assert.ok(d.logProbs[2] >= assign.LOG_FLOOR - 1e-9);
  const sum = d.logProbs.reduce((s, lp) => s + Math.exp(lp), 0);
  assert.ok(Math.abs(sum - 1) < 1e-9);
  // With almost all the mass on the letters, the floor is the shared-remainder bound, well under the smallest returned.
  const tight = assign.readChoiceDistribution(choiceAnswer(names, 'section 1', { missing: ['section 3'], mass: 0.999 }), names, 'q');
  assert.ok(tight.logProbs[2] < tight.logProbs[1] - 1);
});
check('an answer under the label-mass gate is a SKIPPED unit: flat row, no evidence, reported', () => {
  const names = ['section 1', 'section 2'];
  const d = assign.readChoiceDistribution(choiceAnswer(names, 'section 1', { mass: 0.005 }), names, 'q');
  assert.strictEqual(d.skipped, true);
  assert.deepStrictEqual(d.logProbs, [-Math.log(2), -Math.log(2)]);
});
check('an answer with every label missing, the wrong type, or absent is refused by name', () => {
  const names = ['section 1', 'section 2'];
  assert.throws(() => assign.readChoiceDistribution(choiceAnswer(names, 'section 1', { missing: names }), names, 'q'), /no option with any probability/);
  assert.throws(() => assign.readChoiceDistribution(yesno(0.5), names, 'q'), (e) => e.code === 'answer_shape');
  assert.throws(() => assign.readChoiceDistribution(undefined, names, 'q'), (e) => e.code === 'no_answer');
  assert.throws(() => assign.readYesNo(choiceAnswer(names, 'section 1'), 'q'), (e) => e.code === 'answer_shape');
});

check('a yes/no is read under the same declared floor: a one-sided answer is rebuilt from the raw mass, a gated one is no evidence', () => {
  assert.deepStrictEqual(assign.readYesNo(yesno(0.8), 'q'), { p: 0.8, floored: false, labelMass: 0.97 });
  // Report mode, No outside the top-K: the wire says p = 1.0 ("honest and useless", PHASE22 §2.2).
  // Yes holds 0.3 of the raw mass; No is floored at min(ln 0.3, ln(0.7 / (1 + 4))) = ln 0.14.
  const one = assign.readYesNo({ type: 'yesno', p: 1, labelMass: 0.3, missingLabels: ['No'] }, 'q');
  assert.ok(one.floored && Math.abs(one.p - 0.3 / (0.3 + 0.14)) < 1e-9, JSON.stringify(one));
  const noSide = assign.readYesNo({ type: 'yesno', p: 0, labelMass: 0.9, missingLabels: ['Yes'] }, 'q');
  assert.ok(noSide.floored && noSide.p < 0.03, JSON.stringify(noSide));
  assert.deepStrictEqual(assign.readYesNo({ type: 'yesno', p: 0.9, labelMass: 0.001, missingLabels: [] }, 'q'), { p: null, floored: false, labelMass: 0.001 });
});

// ------------------------------------------------------------------- plugs

function matrix(prefs, m) {
  return prefs.map((j) => Array.from({ length: m }, (_, k) => Math.log(k === j ? 0.999 : 0.001 / (m - 1))));
}
const PREFS = [0, 0, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1, 1, 1];

check('confirmPlugs keeps a confirmed ad stretch and asks about it once', async () => {
  const asked = [];
  const { path: p, verdicts } = await plugs.confirmPlugs(matrix(PREFS, 3), 2, 20, async (a, b) => {
    asked.push([a, b]);
    return 0.9;
  });
  assert.deepStrictEqual(asked, [[8, 16]]);
  assert.deepStrictEqual(verdicts, [{ start: 8, end: 16, p: 0.9, threshold: 0.5 }]);
  assert.deepStrictEqual(p, PREFS);
});
check('confirmPlugs re-runs without the ad option when a stretch is rejected, and does not mutate L', async () => {
  const M = matrix(PREFS, 3);
  for (let i = 8; i < 12; i++) M[i][0] = Math.log(0.0009);
  for (let i = 12; i < 16; i++) M[i][1] = Math.log(0.0009);
  const asked = [];
  const res = await plugs.confirmPlugs(M, 2, 20, async (a, b) => {
    asked.push([a, b]);
    return 0.2;
  });
  assert.deepStrictEqual(asked, [[8, 16]]);
  assert.ok(!res.path.includes(2));
  assert.strictEqual(res.logProbs[10][2], plugs.REJECTED);
  assert.strictEqual(M[10][2], Math.log(0.999));
  assert.strictEqual(viterbi.boundaries(res.path).length, 1);
});
check('confirmPlugs asks about a new ad run after a rejection, never the same run twice', async () => {
  const p2 = [0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 0, 0, 0, 0, 0, 0, 2, 2, 2, 2, 2, 2, 1, 1, 1, 1, 1, 1];
  const asked = [];
  const res = await plugs.confirmPlugs(matrix(p2, 3), 2, 20, async (a, b) => {
    asked.push(`${a}-${b}`);
    return a === 6 ? 0.1 : 0.95;
  });
  assert.deepStrictEqual(asked, ['6-12', '18-24']);
  assert.ok(res.path.slice(6, 12).every((j) => j === 0) && res.path.slice(18, 24).every((j) => j === 2));
});

// ------------------------------------------------------------------- units

check('sentence units: split at punctuation, times by character fraction inside a caption, caption times at the edges', () => {
  const u = units.sentenceUnits([
    { start: '00:00:00,000', end: '00:00:10,000', text: 'Hello there everyone today. We talk about the taxes now.' },
    { start: '00:00:10,000', end: '00:00:14,000', text: 'And then a final thought here.' },
  ]);
  assert.deepStrictEqual(u.map((x) => x.text), ['Hello there everyone today.', 'We talk about the taxes now.', 'And then a final thought here.']);
  assert.strictEqual(u[0].start, 0);
  assert.ok(u[0].end > 4 && u[0].end < 6, `first end ${u[0].end}`);
  assert.ok(u[1].start > 4 && u[1].start < 6, `second start ${u[1].start}`);
  assert.strictEqual(u[1].end, 10);
  assert.strictEqual(u[2].start, 10);
  assert.strictEqual(u[2].end, 14);
  assert.deepStrictEqual(u.map((x) => x.index), [0, 1, 2]);
  assert.strictEqual(units.srtSeconds('01:02:03,450'), 3723.45);
});
check('sentence units: a short sentence folds forward; a short tail stands; the fold can be disabled', () => {
  const caps = [
    { start: 0, end: 1, text: 'Okay.' },
    { start: 1, end: 2, text: 'Yeah, right.' },
    { start: 2, end: 6, text: 'So here is the actual point.' },
    { start: 6, end: 10, text: 'It has at least four words.' },
    { start: 10, end: 11, text: 'Bye now.' },
  ];
  const u = units.sentenceUnits(caps);
  assert.deepStrictEqual(u.map((x) => [x.text, x.start, x.end]), [
    ['Okay. Yeah, right. So here is the actual point.', 0, 6],
    ['It has at least four words.', 6, 10],
    ['Bye now.', 10, 11],
  ]);
  assert.strictEqual(units.sentenceUnits([{ start: 0, end: 1, text: 'Okay. Fine.' }], { minWords: 0 }).length, 2);
});
check('sentence units: a speaker change breaks a sentence; the unit carries its speaker', () => {
  const u = units.sentenceUnits([
    { start: 0, end: 4, text: 'so the host is saying this thing', speaker: 'mic' },
    { start: 4, end: 8, text: 'and the clip says something else entirely', speaker: 'screen' },
    { start: 8, end: 12, text: 'before the host comes back in.', speaker: 'mic' },
  ]);
  assert.deepStrictEqual(u.map((x) => [x.speaker, x.start, x.end]), [['mic', 0, 4], ['screen', 4, 8], ['mic', 8, 12]]);
});
check('sentence units: an unpunctuated run-on is cut at caption boundaries into ~30-word pieces; a long single caption is not', () => {
  const seg = (i) => ({ start: i * 5, end: i * 5 + 5, text: Array.from({ length: 10 }, (_, w) => `w${i}x${w}`).join(' ') });
  const caps = Array.from({ length: 10 }, (_, i) => seg(i));
  const u = units.sentenceUnits(caps);
  assert.deepStrictEqual(u.map((x) => x.text.split(' ').length), [30, 30, 40]);
  assert.deepStrictEqual(u.map((x) => [x.start, x.end]), [[0, 15], [15, 30], [30, 50]]);
  assert.strictEqual(u.map((x) => x.text).join(' '), caps.map((s) => s.text).join(' '));
  const text = Array.from({ length: 80 }, (_, w) => `w${w}`).join(' ') + '.';
  assert.deepStrictEqual(units.sentenceUnits([{ start: 0, end: 40, text }]).map((x) => x.text), [text]);
  assert.deepStrictEqual(units.sentenceUnits([{ start: 0, end: 1, text: '  ' }]), []);
});

// ------------------------------------------------------------------- chunks

check('planChunks: one chunk under the single limit, else overlapping cores that own every unit once', () => {
  assert.deepStrictEqual(chunks.planChunks(Array(10).fill(100)), [{ start: 0, end: 10, coreStart: 0, coreEnd: 10 }]);
  const plan = chunks.planChunks(Array(100).fill(100), { maxSingleTokens: 3000, maxCoreTokens: 2000, overlapTokens: 300 });
  assert.strictEqual(plan.length, 5);
  assert.strictEqual(plan[0].coreStart, 0);
  assert.strictEqual(plan[plan.length - 1].coreEnd, 100);
  for (let k = 1; k < plan.length; k++) assert.strictEqual(plan[k].coreStart, plan[k - 1].coreEnd);
  assert.ok(plan[1].start < plan[1].coreStart && plan[1].end > plan[1].coreEnd);
});

// ------------------------------------------------------------------- granularity

check('two grains (LEDGER #208): each maps to a positive switch cost and a prompt body that exists; chapters is the measured 20', () => {
  assert.deepStrictEqual([...granularity.GRANULARITIES], ['chapters', 'stories']);
  for (const g of granularity.GRANULARITIES) {
    const s = granularity.granularitySetting(g);
    assert.ok(s.switchCost > 0);
    assert.ok(prompts.SNAP_PROMPTS.outline(g, 'x', 25, '1 hour').length > 50, `${g} body`);
    assert.strictEqual(s.refine, g === 'chapters');
    // Stories merge the chunk outlines into one stream outline; chapters stitch per chunk.
    assert.strictEqual(s.mergeKey !== null, g === 'stories');
    // Owen's ad marks are a video's (5:00, 10:00), not a stream's.
    assert.strictEqual(s.adPrior, g === 'chapters');
  }
  assert.strictEqual(granularity.GRANULARITY.chapters.switchCost, 20);
  assert.strictEqual(granularity.GRANULARITY.chapters.provenance, 'measured');
  assert.ok(granularity.GRANULARITY.stories.switchCost > granularity.GRANULARITY.chapters.switchCost);
  assert.ok(prompts.SNAP_PROMPTS.outline('stories', 'x', 25, '3 hours 54 minutes').includes('runs 3 hours 54 minutes'));
  // The segment.py body is the chapters grain's, and level 2's.
  assert.strictEqual(prompts.SNAP_PROMPTS.subOutline('x', 25), prompts.SNAP_PROMPTS.outline('chapters', 'x', 25, ''));
  const merge = prompts.SNAP_PROMPTS.streamMerge('snap_outline_stories_merge', [{ clock: '0:00-40:00', items: ['AI survey', 'Meta settlement'] }, { clock: '40:00-1:20:00', items: ['Pokemon book {max_items} $&'] }], 25, '1 hour 20 minutes');
  assert.ok(merge.includes('Stretch 1 (0:00-40:00):\nAI survey\nMeta settlement') && merge.includes('Stretch 2 (40:00-1:20:00):\nPokemon book {max_items} $&'));
  assert.ok(merge.includes('at most 25 lines') && merge.includes('runs 1 hour 20 minutes'));
  // The retired names are gone, and the pipeline's per-run pick reads as a setting of the dial.
  for (const retired of ['detailed', 'broad', 'episodes']) assert.throws(() => granularity.granularitySetting(retired), /unknown chaptering granularity/);
  assert.deepStrictEqual(granularity.PIPELINE_DIAL.detailed, { granularity: 'chapters', switchCost: 20 });
  assert.deepStrictEqual(granularity.PIPELINE_DIAL.broad.granularity, 'chapters');
  assert.ok(granularity.PIPELINE_DIAL.broad.switchCost > 20);
  assert.strictEqual(granularity.PIPELINE_DIAL.stories.granularity, 'stories');
  assert.throws(() => granularity.granularitySetting('fine'), /unknown chaptering granularity "fine"/);
  assert.strictEqual(service.runtimeWords(14040), '3 hours 54 minutes');
  assert.strictEqual(service.runtimeWords(600), '10 minutes');
  assert.strictEqual(service.formatClock(3723), '1:02:03');
});

// ------------------------------------------------------------------- the service

const SECTIONS = [
  [0, 150, 'Alpha topic', [{ from: 0, to: 70, label: 'Alpha one' }, { from: 70, to: 150, label: 'Alpha two' }]],
  [150, 300, 'Beta topic', [{ from: 150, to: 240, label: 'Beta one' }, { from: 240, to: 300, label: 'Beta two' }]],
];

check('stories on one chunk: level 1 only, two chapters that tile the video, titled thinking ON at the declared budget', async () => {
  const v = fakeVideo(300, SECTIONS);
  const r = await service.chapter(v.captions, { granularity: 'stories', chat: v.chat, decide: v.decide, videoTitle: 'Fake', channelName: 'Ch' });
  assert.strictEqual(r.stats.unitCount, 300);
  assert.strictEqual(r.stats.chunkCount, 1);
  assert.strictEqual(r.stats.refinedSections, 0);
  // One chunk: its own outline is the whole video's, and no merge call is made.
  assert.strictEqual(r.stats.streamOutline, null);
  assert.ok(!v.calls.chat.some((c) => c.o.what.startsWith('stream outline')));
  assert.deepStrictEqual(r.outline, ['Alpha topic', 'Beta topic']);
  assert.deepStrictEqual(r.chapters.map((c) => [c.startSec, c.endSec, c.label, c.level, c.title, c.isAd]), [
    [0, 1500, 'Alpha topic', 1, 'Title 1', false],
    [1500, 3000, 'Beta topic', 1, 'Title 2', false],
  ]);
  assert.strictEqual(r.chapters[1].summary, 'Summary of chapter 2.');
  const summaries = v.calls.chat.filter((c) => c.o.role === 'summarize');
  assert.strictEqual(summaries.length, 2);
  assert.ok(summaries[1].prompt.includes('Previous chapter: "Summary of chapter 1."') && summaries[1].prompt.includes('titled "Title 1"'));
  // LEDGER #208: titles think, at 16,384; the outline list stays thinking-off at temperature 0.
  assert.ok(summaries.every((c) => c.o.thinking === true && c.o.maxTokens === 16384));
  assert.ok(v.calls.chat[0].o.thinking === false && v.calls.chat[0].o.temperature === 0);
  assert.strictEqual(r.stats.titleMs.length, 2);
  assert.ok(!r.stats.warnings.some((w) => w.includes('thinking OFF')));
  assert.strictEqual(r.switchCost, 45);
  assert.strictEqual(r.stats.decideCalls, Math.ceil(300 / 64));
  assert.ok(v.calls.decide.every((d) => d.req.missing === 'report'));
});

check('titles with thinking OFF are a declared setting of the run: the call says so and the warnings say so', async () => {
  const v = fakeVideo(60, [[0, 30, 'One', null], [30, 60, 'Two', null]]);
  const r = await service.chapter(v.captions, { granularity: 'chapters', chat: v.chat, decide: v.decide, titleThinking: false, titleMaxTokens: 4096 });
  const summaries = v.calls.chat.filter((c) => c.o.role === 'summarize');
  assert.ok(summaries.length === 2 && summaries.every((c) => c.o.thinking === false && c.o.maxTokens === 4096));
  assert.ok(r.stats.warnings.some((w) => w.includes('thinking OFF')));
});

check('a title that runs out its thinking budget ships with its outline label and a warning, never a block (Law 3)', async () => {
  const v = fakeVideo(60, [[0, 30, 'One', null], [30, 60, 'Two', null]]);
  const chat = async (prompt, o) => (o.role === 'summarize' && prompt.includes('Title chapter 2') ? { text: '', finishReason: 'length' } : v.chat(prompt, o));
  const r = await service.chapter(v.captions, { granularity: 'chapters', chat, decide: v.decide });
  assert.deepStrictEqual(r.chapters.map((c) => [c.label, c.title]), [['One', 'Title 1'], ['Two', '']]);
  assert.ok(r.stats.warnings.some((w) => w.includes('ran out its 16384-token budget (thinking on)')));
  assert.ok(r.stats.warnings.some((w) => w.includes('carries its outline label "Two"')));
});

check('chapters: the two-level outline refines both long sections; four leaves tile the video at level 2', async () => {
  const v = fakeVideo(300, SECTIONS);
  const r = await service.chapter(v.captions, { granularity: 'chapters', chat: v.chat, decide: v.decide, summarize: false });
  assert.strictEqual(r.stats.refinedSections, 2);
  assert.deepStrictEqual(r.chapters.map((c) => [c.startSec, c.endSec, c.label, c.level]), [
    [0, 700, 'Alpha one', 2],
    [700, 1500, 'Alpha two', 2],
    [1500, 2400, 'Beta one', 2],
    [2400, 3000, 'Beta two', 2],
  ]);
  assert.deepStrictEqual(r.outline, ['Alpha topic', 'Beta topic']);
  assert.ok(r.chapters.every((c) => c.title === '' && c.summary === ''));
  const level2 = v.calls.chat.filter((c) => c.o.role === 'outline').slice(1);
  assert.strictEqual(level2.length, 2);
  assert.ok(!level2[0].prompt.includes('Sentence 200 of') && level2[0].prompt.includes('Sentence 100 of'));
  // The section's sub-questions carry the real sentence before the section, never "(start of the video)".
  const secondSection = v.calls.decide.find((d) => d.req.questions.s0 && d.req.questions.s0.instructions.includes('Sentence 150 of'));
  assert.ok(secondSection.req.questions.s0.instructions.includes('"Sentence 149 of'));
});

check('chapters on a short video: no section is long, so level 1 is the answer', async () => {
  const v = fakeVideo(60, [[0, 30, 'One', null], [30, 60, 'Two', null]]);
  const r = await service.chapter(v.captions, { granularity: 'chapters', chat: v.chat, decide: v.decide, summarize: false });
  assert.strictEqual(r.stats.refinedSections, 0);
  assert.deepStrictEqual(r.chapters.map((c) => [c.label, c.level]), [['One', 1], ['Two', 1]]);
});

check('chapters on a long transcript: each chunk its own outline, stitched at the seams where the overlaps agree', async () => {
  const v = fakeVideo(300, SECTIONS);
  const r = await service.chapter(v.captions, {
    granularity: 'chapters', chat: v.chat, decide: v.decide, summarize: false,
    chunking: { maxSingleTokens: 2000, maxCoreTokens: 1200, overlapTokens: 200 },
  });
  assert.ok(r.stats.chunkCount > 1, `chunks ${r.stats.chunkCount}`);
  assert.strictEqual(r.stats.streamOutline, null);
  assert.ok(!v.calls.chat.some((c) => c.o.what.startsWith('stream outline')));
  assert.deepStrictEqual(r.outline, ['Alpha topic', 'Beta topic']);
  assert.strictEqual(r.chapters[0].unitRange[0], 0);
  assert.strictEqual(r.chapters[r.chapters.length - 1].unitRange[1], 300);
  assert.deepStrictEqual(r.chapters.map((c) => c.label), ['Alpha one', 'Alpha two', 'Beta one', 'Beta two']);
});

check('stories on a long transcript: the chunk outlines are MERGED into one stream outline, every sentence asked once, one pass', async () => {
  const v = fakeVideo(300, SECTIONS);
  const r = await service.chapter(v.captions, {
    granularity: 'stories', chat: v.chat, decide: v.decide, summarize: false,
    chunking: { maxSingleTokens: 2000, maxCoreTokens: 1200, overlapTokens: 200 },
  });
  assert.ok(r.stats.chunkCount > 1, `chunks ${r.stats.chunkCount}`);
  const merges = v.calls.chat.filter((c) => c.o.what.startsWith('stream outline'));
  assert.strictEqual(merges.length, 1);
  // The merge reads every chunk's own outline, in order, each under its stretch's clock.
  assert.ok(merges[0].prompt.includes('Stretch 1 (0:00-') && merges[0].prompt.includes(`Stretch ${r.stats.chunkCount} (`));
  assert.ok(merges[0].o.thinking === false && merges[0].o.temperature === 0 && merges[0].o.role === 'outline');
  assert.deepStrictEqual(r.stats.streamOutline, ['Alpha topic', 'Beta topic']);
  assert.deepStrictEqual(r.outline, ['Alpha topic', 'Beta topic']);
  // Every chunk offers the SAME options (the stream outline and the ad item)...
  const optionSets = new Set(v.calls.decide.filter((d) => d.req.questions.s0 || Object.keys(d.req.questions)[0] !== 'q').map((d) => JSON.stringify(Object.values(Object.values(d.req.questions)[0].options))));
  assert.strictEqual(optionSets.size, 1);
  // ...and only the core a chunk owns is asked: 300 questions for 300 sentences, none twice.
  const asked = v.calls.decide.flatMap((d) => Object.values(d.req.questions).filter((q) => q.type === 'choice').map((q) => unitOf(q.instructions)));
  assert.strictEqual(asked.length, 300);
  assert.strictEqual(new Set(asked).size, 300);
  assert.deepStrictEqual(r.chapters.map((c) => [c.startSec, c.endSec, c.label]), [[0, 1500, 'Alpha topic'], [1500, 3000, 'Beta topic']]);
});

check('a prose outline is refused by name, naming the chunk (Law 1); prose lines are told from labels by a declared rule', async () => {
  assert.strictEqual(outline.proseLine('The stream flows as follows:'), 'it is a lead-in ending in a colon');
  assert.strictEqual(outline.proseLine('Analysis of the transcript reveals that the host covers AI. Then he turns to Pokemon.'), 'it holds more than one sentence');
  assert.ok(/runs 31 words/.test(outline.proseLine(Array.from({ length: 31 }, (_, i) => `w${i}`).join(' '))));
  for (const label of ['Trump vs. Biden on the border', "Dr. Phil's advice to parents", 'Q&A: listener questions', 'The 1990s recap.', 'Phil Arms claims Pokemon is satanic']) {
    assert.strictEqual(outline.proseLine(label), null, label);
  }
  assert.throws(() => outline.parseOutline('Intro\nThe stream flows as follows:\nPokemon', 25, 'outline of level 1, chunk 5/5'), (e) =>
    e instanceof types.ChapteringError && e.code === 'outline_prose' && e.message.includes('chunk 5/5') && e.message.includes('The stream flows as follows:'));
  const v = fakeVideo(300, SECTIONS, {
    outlineAnswer: (what) => (what.includes('chunk 2/') ? 'Analysis of the transcript reveals that it covers Alpha. The stream flows on.' : undefined),
  });
  await assert.rejects(
    service.chapter(v.captions, { granularity: 'stories', chat: v.chat, decide: v.decide, summarize: false, chunking: { maxSingleTokens: 2000, maxCoreTokens: 1200, overlapTokens: 200 } }),
    (e) => e.code === 'outline_prose' && e.message.includes('chunk 2/'),
  );
  // The merged stream outline is held to the same rule.
  const w = fakeVideo(300, SECTIONS, { outlineAnswer: (what) => (what.startsWith('stream outline') ? 'Here is the merged outline:\nAlpha topic\nBeta topic' : undefined) });
  await assert.rejects(
    service.chapter(w.captions, { granularity: 'stories', chat: w.chat, decide: w.decide, summarize: false, chunking: { maxSingleTokens: 2000, maxCoreTokens: 1200, overlapTokens: 200 } }),
    (e) => e.code === 'outline_prose' && e.message.includes('stream outline'),
  );
});

check('ad confirm: a confirmed stretch is an isAd chapter with its verdict; a rejected one is re-segmented away', async () => {
  const yes = fakeVideo(300, SECTIONS, { ads: [100, 120], adVerdict: 0.9 });
  const r1 = await service.chapter(yes.captions, { granularity: 'stories', chat: yes.chat, decide: yes.decide, summarize: false, promotedItems: ['the Patreon'] });
  const ad = r1.chapters.find((c) => c.isAd);
  assert.ok(ad, 'an ad chapter');
  assert.deepStrictEqual(ad.unitRange, [100, 120]);
  assert.deepStrictEqual(r1.plugVerdicts, [{ start: 100, end: 120, p: 0.9, threshold: 0.5, read: 'answered', source: 'ad-option' }]);
  assert.ok(yes.calls.decide.some((d) => d.req.questions.q && d.req.questions.q.type === 'yesno' && d.req.questions.q.instructions.includes('(the Patreon)')));
  assert.ok(yes.calls.decide[0].req.questions.s0.options['section 3'].includes('the Patreon'));
  const no = fakeVideo(300, SECTIONS, { ads: [100, 120], adVerdict: 0.2 });
  const r2 = await service.chapter(no.captions, { granularity: 'stories', chat: no.chat, decide: no.decide, summarize: false });
  assert.ok(!r2.chapters.some((c) => c.isAd));
  assert.deepStrictEqual(r2.chapters.map((c) => c.label), ['Alpha topic', 'Beta topic']);
  assert.deepStrictEqual(r2.plugVerdicts.map((v) => v.p), [0.2]);
  const off = fakeVideo(300, SECTIONS, { ads: [100, 120] });
  const r3 = await service.chapter(off.captions, { granularity: 'stories', chat: off.chat, decide: off.decide, summarize: false, detectAds: false });
  assert.ok(!off.calls.decide[0].req.questions.s0.options['section 3'] && r3.plugVerdicts.length === 0);
  assert.strictEqual(r3.stats.adBaseline, null);
});

check('the ad option is read against its per-video baseline: a lean all video long stops pulling sentences to it (plan §0a)', async () => {
  // Pure: the median, capped at 0.5; the rise, renormalised; a row with no ad option untouched.
  const row = (pAd) => [Math.log(1 - pAd - 0.1), Math.log(0.1), Math.log(pAd)];
  assert.ok(Math.abs(plugs.adBaseline([0.2, 0.3, 0.4].map((p) => ({ row: row(p), plug: 2 }))) - 0.3) < 1e-9);
  assert.strictEqual(plugs.adBaseline([0.7, 0.8, 0.85].map((p) => ({ row: row(p), plug: 2 }))), 0.5);
  const lifted = plugs.baselineRow(row(0.4), 2, 0.3);
  assert.ok(Math.abs(lifted.reduce((s, x) => s + Math.exp(x), 0) - 1) < 1e-9);
  assert.ok(Math.abs(Math.exp(lifted[2]) - 0.1 / 0.7) < 1e-9, 'the ad option keeps only its rise');
  assert.ok(Math.abs(Math.exp(lifted[0]) / Math.exp(lifted[1]) - 5) < 1e-9, 'the other options keep their ratio');
  assert.deepStrictEqual(plugs.baselineRow(row(0.4), -1, 0.3), row(0.4));
  // In a run: the ad option holds 0.45 on every sentence and the true section only 0.40 on the
  // first 100. Read raw, the ad option would win those; against the baseline it is nowhere.
  const v = fakeVideo(300, SECTIONS, { perUnit: (i) => (i < 100 ? { chosenP: 0.4, adP: 0.45 } : { chosenP: 0.5, adP: 0.45 }) });
  const r = await service.chapter(v.captions, { granularity: 'stories', chat: v.chat, decide: v.decide, summarize: false });
  assert.ok(Math.abs(r.stats.adBaseline - 0.45) < 1e-9, `baseline ${r.stats.adBaseline}`);
  assert.ok(!r.chapters.some((c) => c.isAd));
  assert.deepStrictEqual(r.plugVerdicts.filter((p) => p.source === 'ad-option'), []);
  assert.deepStrictEqual(r.chapters.map((c) => c.label), ['Alpha topic', 'Beta topic']);
});

check('a plug the outline named as an ordinary item is flagged isAd when the yes/no says so, keeping its label', async () => {
  const sections = [[0, 100, 'Alpha topic', null], [100, 120, 'Promotion of the book', null], [120, 300, 'Beta topic', null]];
  // On the promotion's sentences the ad option is a close second; elsewhere it is nowhere.
  const perUnit = (i) => (i >= 100 && i < 120 ? { chosenP: 0.6, adP: 0.3 } : { chosenP: 0.97, adP: 0.004 });
  const yes = fakeVideo(300, sections, { perUnit, adVerdict: 0.8 });
  const r = await service.chapter(yes.captions, { granularity: 'stories', chat: yes.chat, decide: yes.decide, summarize: false });
  assert.deepStrictEqual(r.chapters.map((c) => [c.label, c.isAd]), [['Alpha topic', false], ['Promotion of the book', true], ['Beta topic', false]]);
  assert.deepStrictEqual(r.plugVerdicts, [{ start: 100, end: 120, p: 0.8, threshold: 0.5, read: 'answered', source: 'outline-item' }]);
  // Only the candidate was asked: one yes/no, over its own passage.
  const asks = yes.calls.decide.filter((d) => d.req.questions.q);
  assert.strictEqual(asks.length, 1);
  assert.ok(asks[0].req.questions.q.instructions.includes('Sentence 100 of') && !asks[0].req.questions.q.instructions.includes('Sentence 99 of'));
  // A no keeps it content.
  const no = fakeVideo(300, sections, { perUnit, adVerdict: 0.1 });
  const r2 = await service.chapter(no.captions, { granularity: 'stories', chat: no.chat, decide: no.decide, summarize: false });
  assert.ok(!r2.chapters.some((c) => c.isAd));
  assert.deepStrictEqual(r2.plugVerdicts.map((p) => [p.source, p.p]), [['outline-item', 0.1]]);
  // The rule itself: first or second on at least half the run's sentences.
  const at = (pAd, pTop) => ({ row: [Math.log(pTop), Math.log((1 - pTop - pAd) / 2), Math.log((1 - pTop - pAd) / 2), Math.log(pAd)], plug: 3 });
  assert.ok(plugs.isOutlineItemCandidate([at(0.3, 0.6), at(0.3, 0.6), at(0.001, 0.9)]));
  assert.ok(!plugs.isOutlineItemCandidate([at(0.3, 0.6), at(0.001, 0.9), at(0.001, 0.9)]));
  assert.ok(!plugs.isOutlineItemCandidate([]));
});

check('the ad prior (Owen: ads at about 5:00 and 10:00) lowers the bar near those marks, at chapters only, and places nothing', async () => {
  assert.strictEqual(plugs.confirmThreshold(290, 330, true), 0.25);
  assert.strictEqual(plugs.confirmThreshold(640, 660, true), 0.25);
  assert.strictEqual(plugs.confirmThreshold(1200, 1230, true), 0.5);
  assert.strictEqual(plugs.confirmThreshold(290, 330, false), 0.5);
  const sections = [[0, 50, 'One', null], [50, 100, 'Two', null]];
  // A stretch at 5:00 whose yes/no says 0.3: an ad in a video (the prior), not in a stream.
  const vid = fakeVideo(100, sections, { ads: [30, 45], adVerdict: 0.3 });
  const r1 = await service.chapter(vid.captions, { granularity: 'chapters', chat: vid.chat, decide: vid.decide, summarize: false });
  assert.deepStrictEqual(r1.plugVerdicts.map((p) => [p.start, p.end, p.p, p.threshold, p.source]), [[30, 45, 0.3, 0.25, 'ad-option']]);
  assert.ok(r1.chapters.some((c) => c.isAd && c.unitRange[0] === 30));
  const str = fakeVideo(100, sections, { ads: [30, 45], adVerdict: 0.3 });
  const r2 = await service.chapter(str.captions, { granularity: 'stories', chat: str.chat, decide: str.decide, summarize: false });
  assert.deepStrictEqual(r2.plugVerdicts.map((p) => [p.threshold, p.source]), [[0.5, 'ad-option']]);
  assert.ok(!r2.chapters.some((c) => c.isAd));
  // The same answer away from the marks is not an ad at chapters either.
  const far = fakeVideo(100, sections, { ads: [70, 85], adVerdict: 0.3 });
  const r3 = await service.chapter(far.captions, { granularity: 'chapters', chat: far.chat, decide: far.decide, summarize: false });
  assert.ok(!r3.chapters.some((c) => c.isAd) && r3.plugVerdicts[0].threshold === 0.5);
  // A stretch the OUTLINE named near 5:00 keeps the plain 0.5: the prior is for the ad item's own runs.
  const named = [[0, 28, 'One', null], [28, 40, 'Promotion of the book', null], [40, 100, 'Two', null]];
  const lean = (i) => (i >= 28 && i < 40 ? { chosenP: 0.6, adP: 0.3 } : { chosenP: 0.97, adP: 0.004 });
  const out = fakeVideo(100, named, { perUnit: lean, adVerdict: 0.35 });
  const r5 = await service.chapter(out.captions, { granularity: 'chapters', chat: out.chat, decide: out.decide, summarize: false });
  assert.deepStrictEqual(r5.plugVerdicts.map((p) => [p.start, p.p, p.threshold, p.source]), [[28, 0.35, 0.5, 'outline-item']]);
  assert.ok(!r5.chapters.some((c) => c.isAd));
  // With no stretch assigned to the ad item, the prior asks nothing.
  const none = fakeVideo(100, sections);
  const r4 = await service.chapter(none.captions, { granularity: 'chapters', chat: none.chat, decide: none.decide, summarize: false });
  assert.deepStrictEqual(r4.plugVerdicts, []);
});

check('a transcript with mic/screen speakers is titled from HOST:/CLIP: lines; a partly-resolved one is untagged and warned', async () => {
  const sections = [[0, 30, 'One', null], [30, 60, 'Two', null]];
  const tagged = fakeVideo(60, sections, { speakerOf: (i) => (i % 3 === 0 ? 'screen' : 'mic') });
  const r = await service.chapter(tagged.captions, { granularity: 'chapters', chat: tagged.chat, decide: tagged.decide });
  assert.strictEqual(r.stats.speakerTagged, true);
  const first = tagged.calls.chat.find((c) => c.o.role === 'summarize').prompt;
  assert.ok(first.includes('HOST: is the creator of this video talking') && first.includes('\nCLIP: Sentence 0 of') && first.includes('\nHOST: Sentence 1 of'));
  const partial = fakeVideo(60, sections, { speakerOf: (i) => (i < 40 ? 'mic' : 'guest') });
  const r2 = await service.chapter(partial.captions, { granularity: 'chapters', chat: partial.chat, decide: partial.decide });
  assert.strictEqual(r2.stats.speakerTagged, false);
  assert.ok(!partial.calls.chat.find((c) => c.o.role === 'summarize').prompt.includes('HOST:'));
  assert.ok(r2.stats.warnings.some((w) => w.includes('WITHOUT speaker tags')));
  // The editor's word-level file: a track's LABEL says its side (the 2026-09-23 stream's t0/t1).
  const roles = units.speakerRolesOf({
    tracks: [{ id: 't0', label: 'mic audio_processed' }, { id: 't1', label: 'screen audio_processed' }],
    words: [{ text: 'a', start: 0, end: 1, track: 't0' }, { text: 'b', start: 1, end: 2, track: 't1' }],
  });
  assert.deepStrictEqual([...roles], [['t0', 'host'], ['t1', 'clip']]);
  assert.deepStrictEqual([...units.speakerRolesOf([{ start: 0, end: 1, text: 'x', speaker: 'unsure' }, { start: 1, end: 2, text: 'y', speaker: 'host' }])], [['unsure', 'unsure'], ['host', 'host']]);
  assert.strictEqual(units.speakerRolesOf({ words: [{ text: 'a', start: 0, end: 1, track: 't0' }] }).size, 0, 'a bare track id with no label says nothing');
});

check('decide_not_served ends the run with a refusal naming the server, and no chapters', async () => {
  const err = Object.assign(new Error('mlx-lm caps top_logprobs at 11; the question has 26 labels'), { code: 'decide_not_served', server: 'crucible@owens-mac-studio' });
  const v = fakeVideo(50, [[0, 25, 'One', null], [25, 50, 'Two', null]], { decideThrows: err });
  await assert.rejects(
    service.chapter(v.captions, { granularity: 'stories', chat: v.chat, decide: v.decide }),
    (e) => e instanceof types.ChapteringError && e.code === 'decide_not_served' && e.message.includes('crucible@owens-mac-studio') && e.message.includes('top_logprobs at 11'),
  );
  // Any other transport failure passes through as itself.
  const other = fakeVideo(50, [[0, 25, 'One', null], [25, 50, 'Two', null]], { decideThrows: Object.assign(new Error('boom'), { code: 'engine_error' }) });
  await assert.rejects(service.chapter(other.captions, { granularity: 'stories', chat: other.chat, decide: other.decide }), /boom/);
});

check('a missing label is counted and a gated answer is a skipped unit, both reported, and the run completes', async () => {
  const v = fakeVideo(100, [[0, 50, 'One', null], [50, 100, 'Two', null]], {
    perUnit: (i) => (i === 10 ? { missing: ['section 2'] } : i === 20 || i === 21 ? { mass: 0.001 } : {}),
  });
  const r = await service.chapter(v.captions, { granularity: 'stories', chat: v.chat, decide: v.decide, summarize: false });
  assert.deepStrictEqual(r.stats.flooredUnits, [10]);
  assert.deepStrictEqual(r.stats.skippedUnits, [20, 21]);
  assert.deepStrictEqual(r.chapters.map((c) => c.label), ['One', 'Two']);
  // Law 8: each is said in the run's warnings, not only counted.
  assert.ok(r.stats.warnings.some((w) => w.startsWith('1 of 100 sentences had an option outside') && w.includes('sentence 10')));
  assert.ok(r.stats.warnings.some((w) => w.startsWith('2 of 100 sentences got an answer with almost no weight') && w.includes('sentence 20')));
});

check('an ad check with no evidence is not a confirmation: the stretch is chaptered without the ad item, and warned', async () => {
  const v = fakeVideo(300, SECTIONS, { ads: [100, 120] });
  const decide = v.decide;
  const gated = async (req, o) => {
    const res = await decide(req, o);
    if (res.answers.q) res.answers.q = { type: 'yesno', p: 0.99, labelMass: 0.002, missingLabels: [] };
    return res;
  };
  const r = await service.chapter(v.captions, { granularity: 'stories', chat: v.chat, decide: gated, summarize: false });
  assert.ok(!r.chapters.some((c) => c.isAd));
  assert.deepStrictEqual(r.plugVerdicts, [{ start: 100, end: 120, p: 0, threshold: 0.5, read: 'no-evidence', source: 'ad-option' }]);
  assert.ok(r.stats.warnings.some((w) => w.includes('sentences 100-120') && w.includes('not confirmed as an ad')));
});

check('an empty transcript and a cancelled run are refused by name; a switch-cost override (the dial) is carried in the result', async () => {
  const v = fakeVideo(50, [[0, 25, 'One', null], [25, 50, 'Two', null]]);
  await assert.rejects(service.chapter([], { granularity: 'stories', chat: v.chat, decide: v.decide }), (e) => e.code === 'empty_transcript');
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(service.chapter(v.captions, { granularity: 'stories', chat: v.chat, decide: v.decide, signal: ac.signal }), (e) => e.code === 'cancelled');
  const r = await service.chapter(v.captions, { granularity: 'stories', chat: v.chat, decide: v.decide, summarize: false, switchCost: 5 });
  assert.strictEqual(r.switchCost, 5);
});

// ------------------------------------------------------------------- parity with the reference
//
// tools/fixtures/chaptering/*.json are written by docs/crucible/reference/make_fixtures.py,
// which runs segment.py's and submap.py's OWN functions (lifted by their source) over seeded
// inputs. So these compare the port with what the measured code did, not with a reading of it.

const FIX = (name) => require(path.join(__dirname, 'fixtures', 'chaptering', name + '.json'));

check('parity: viterbi() and boundaries() reproduce segment.py on 43 matrices (random, tied, floored, rejected columns)', () => {
  const cases = FIX('viterbi');
  assert.ok(cases.length >= 40);
  cases.forEach((c, k) => {
    const got = viterbi.viterbi(c.L, c.cost);
    assert.deepStrictEqual(got, c.path, `case ${k} (${c.L.length}x${c.L[0].length}, cost ${c.cost})`);
    assert.deepStrictEqual(viterbi.boundaries(got), c.boundaries, `case ${k} boundaries`);
  });
});

check('parity: confirmPlugs() asks about the same stretches in the same order and ends on segment.py\'s path', async () => {
  let asked = 0;
  for (const [k, c] of FIX('plugs').entries()) {
    const table = new Map(c.asked.map(([a, b, p]) => [`${a}:${b}`, p]));
    const seq = [];
    const r = await plugs.confirmPlugs(c.L, c.plug, c.cost, async (a, b) => {
      seq.push([a, b]);
      assert.ok(table.has(`${a}:${b}`), `case ${k}: asked about ${a}-${b}, which segment.py never asked about`);
      return table.get(`${a}:${b}`);
    });
    assert.deepStrictEqual(seq, c.asked.map(([a, b]) => [a, b]), `case ${k} ask order`);
    assert.deepStrictEqual(r.path, c.path, `case ${k} path`);
    asked += seq.length;
  }
  assert.ok(asked >= 8, `the fixtures exercise the loop (${asked} asks)`);
});

check('parity: sentenceUnits() splits and times exactly as submap.py sentences() (run-on cap off, as measured)', () => {
  for (const [k, c] of FIX('sentences').entries()) {
    const got = units.sentenceUnits(c.captions, { maxWords: 0, maxSeconds: 0 });
    assert.deepStrictEqual(got.map((u) => u.text), c.sentences.map((s) => s.text), `case ${k} texts`);
    got.forEach((u, i) => assert.ok(Math.abs(Math.round(u.start * 100) / 100 - c.sentences[i].t) < 0.011, `case ${k} unit ${i}: ${u.start} vs ${c.sentences[i].t}`));
  }
});

// ------------------------------------------------------------------- transcripts

check('captionsOf reads the three ContentStudio shapes and refuses anything else by name', () => {
  const caps = [{ start: '00:00:00,000', end: '00:00:02,000', text: 'Hello there, friends.' }];
  assert.strictEqual(units.captionsOf(caps), caps);
  assert.strictEqual(units.captionsOf({ segments: caps }), caps);
  assert.strictEqual(units.captionsOf({ contentItems: [{ srtSegments: caps }] }), caps);
  assert.throws(() => units.captionsOf({ contentItems: [{}] }), /no srtSegments/);
  assert.throws(() => units.captionsOf({ transcript: 'x' }), /not a transcript this service reads.*got keys transcript/);
  // Word level: every word is a caption, interleaved tracks are put in time order, and the
  // track is the speaker, so a unit's times are its own words' and a track change splits it.
  const words = [
    { track: 't1', text: 'played', timelineStart: 3.0, timelineEnd: 3.4 },
    { track: 't0', text: 'Welcome', timelineStart: 1.0, timelineEnd: 1.3 },
    { track: 't0', text: 'back', timelineStart: 1.3, timelineEnd: 1.5 },
    { track: 't0', text: 'to', timelineStart: 1.5, timelineEnd: 1.6 },
    { track: 't0', text: 'the stream.', timelineStart: 1.6, timelineEnd: 2.2 },
    { track: 't1', text: 'This clip is', timelineStart: 2.5, timelineEnd: 3.0 },
    { track: 't1', text: '', timelineStart: 3.4, timelineEnd: 3.5 },
  ];
  const got = units.sentenceUnits(units.captionsOf({ words }), { minWords: 0 });
  assert.deepStrictEqual(got.map((u) => [u.text, u.start, u.end, u.speaker]), [
    ['Welcome back to the stream.', 1.0, 2.2, 't0'],
    ['This clip is played', 2.5, 3.4, 't1'],
  ]);
  assert.throws(() => units.captionsOf({ words: [{ text: 'x' }] }), /has no start\/end time/);
});

// ------------------------------------------------------------------- titles

check('a chapter over the title budget is read in equal parts and titled from them, declared; a short one is one call', async () => {
  const summarize = C('summarize');
  const long = Array.from({ length: 900 }, (_, i) => `Sentence ${i} is here and it says a fair few words about the story at hand today.`);
  const windows = summarize.summaryWindows(long);
  assert.ok(windows.length >= 2);
  assert.strictEqual(windows[0][0], 0);
  assert.strictEqual(windows[windows.length - 1][1], long.length);
  for (let k = 1; k < windows.length; k++) assert.strictEqual(windows[k][0], windows[k - 1][1]);
  for (const [a, b] of windows) assert.ok(long.slice(a, b).join(' ').length <= summarize.SUMMARIZE_TRANSCRIPT_TOKENS * chunks.CHARS_PER_TOKEN + 200);
  assert.deepStrictEqual(summarize.summaryWindows(['short one', 'short two']), [[0, 2]]);

  const prompts_ = [];
  const chat = async (prompt, o) => {
    prompts_.push({ prompt, o });
    const part = /part (\d+) of/.exec(prompt);
    return { text: part ? `Part title ${part[1]}\nPart summary ${part[1]}.` : 'Whole title\nWhole summary.', finishReason: 'stop' };
  };
  const warnings = [];
  const r = await summarize.summarizeChapter(
    chat,
    { number: 3, total: 5, videoTitle: 'V', previousDetail: '', previousTitles: [], units: long.map((text, i) => ({ text, start: i, end: i + 1 })), entityScaffold: '', clock: '0:00-15:00', thinking: true },
    (w) => warnings.push(w),
  );
  assert.deepStrictEqual({ ...r, callMs: r.callMs.length }, { title: 'Whole title', summary: 'Whole summary.', parts: windows.length, callMs: windows.length + 1 });
  assert.strictEqual(prompts_.length, windows.length + 1);
  assert.ok(prompts_.every((p) => p.o.role === 'summarize' && p.o.thinking === true));
  const last = prompts_[prompts_.length - 1].prompt;
  assert.ok(last.includes('PARTS:') && last.includes('Part 1 (') && last.includes('Part title 2'));
  // Every sentence is read by some call: nothing is truncated.
  for (let i = 0; i < long.length; i += 97) assert.ok(prompts_.some((p) => p.prompt.includes(`Sentence ${i} is here`)), `sentence ${i}`);
  assert.ok(warnings.some((w) => w.includes(`read in ${windows.length} parts`)));
});

check('progress is monotone, weighted by work, and ends at 1', async () => {
  const v = fakeVideo(300, SECTIONS);
  const seen = [];
  await service.chapter(v.captions, { granularity: 'chapters', chat: v.chat, decide: v.decide, onProgress: (p) => seen.push(p) });
  for (let i = 1; i < seen.length; i++) assert.ok(seen[i].fraction >= seen[i - 1].fraction - 1e-9, `step ${i}: ${seen[i - 1].fraction} -> ${seen[i].fraction}`);
  assert.strictEqual(seen[seen.length - 1].phase, 'done');
  assert.strictEqual(seen[seen.length - 1].fraction, 1);
  assert.ok(seen.some((p) => p.phase === 'refine' || p.phase === 'assign'));
});

run();
