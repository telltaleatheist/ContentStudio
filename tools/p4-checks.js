/**
 * `npm run check:p4`: the pure half of P4 (docs/crucible/P4.md), against the COMPILED main process.
 *
 *   1. The field input policy (chapter-digest.ts): per item kind, under both policies, and the
 *      chapterless over-ceiling item that still fails naming BOTH facts.
 *   2. The one sizing rule (context-check.ts loadContextFor, LEDGER #209): the 8,192 boundaries,
 *      the margin, and that a call sized by it never fails the door's own check on that window.
 *   3. Each call site's budget and the step it asks for on a sample prompt (the before/after table
 *      in P4.md is these numbers).
 *   4. The 16,384 assertion (context-assertion.ts): what counts, what is named, that it blocks nothing.
 *
 * The fake-driven half (what each call site actually sends, the capability question before a
 * load) is tools/test-crucible-p4.js, run by check:crucible.
 *
 *   npm run build:electron && npm run check:p4
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
const req = (p) => require(path.join(ROOT, p));
const digest = req('services/metadata/chapter-digest.js');
const cc = req('crucible/context-check.js');
const tasks = req('services/metadata/metadata-tasks.js');
const rewrite = req('services/metadata/rewrite-pass.js');
const reroll = req('services/metadata/reroll/reroll.service.js');
const summarize = req('services/metadata/chaptering/summarize.js');
const assertion = req('services/metadata/context-assertion.js');
const promptAssetsModule = req('services/metadata/prompt-assets.js');
promptAssetsModule.initPromptAssets(path.join(__dirname, '..', 'electron', 'assets', 'prompts'));

let failures = 0;
let passes = 0;
function check(name, fn) {
  try {
    fn();
    passes++;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name} :: ${error.message}`);
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const e = JSON.stringify(expected);
  if (a !== e) throw new Error(`${what}: expected ${e}, got ${a}`);
}
function has(haystack, needle, what) {
  if (!String(haystack).includes(needle)) throw new Error(`${what}: "${needle}" is not in "${String(haystack).slice(0, 300)}"`);
}
function throwsWith(fn, needles, what) {
  let thrown = null;
  try { fn(); } catch (e) { thrown = e; }
  if (!thrown) throw new Error(`${what}: it did not throw`);
  for (const n of needles) has(thrown.message, n, what);
}

const words = (n) => 'The sheriff read the contract into the record again. '.repeat(Math.ceil(n / 52)).slice(0, n);
const CHAPTERS = [
  { timestamp: '0:00', title: 'The contract, read aloud', detail: 'The sheriff reads the work-release contract into the record.' },
  { timestamp: '4:12', title: 'Fox News reframes it', detail: 'A panel calls it rehabilitation; the host names the 13th Amendment exception.' },
  { timestamp: '11:40', title: 'The budget', detail: '' },
];
const LOCAL_MAX = 90000;

// ── 1. the field input policy ────────────────────────────────────────────────

check('raw (the default): a chaptered item under the ceiling reads its transcript, byte for byte, declaring nothing', () => {
  const t = words(50000);
  const d = digest.resolveFieldContent({ transcript: t, sourceLabel: 'a.mov', ceiling: 'local', chapters: CHAPTERS, policy: 'raw' });
  eq([d.mode, d.policy, d.content === t, d.declaration], ['raw-transcript', 'raw', true, ''], 'raw chaptered');
});

check('digest: a chaptered item under the ceiling reads its chapter digest, and says so with both sizes', () => {
  const t = words(50000);
  const d = digest.resolveFieldContent({ transcript: t, sourceLabel: 'a.mov', ceiling: 'local', chapters: CHAPTERS, policy: 'digest' });
  eq([d.mode, d.policy], ['chapter-digest', 'digest'], 'digest chaptered');
  eq(d.content, digest.renderChapterDigest(CHAPTERS), 'the content is renderChapterDigest');
  has(d.declaration, 'field input policy "digest"', 'names the policy');
  has(d.declaration, '50000-char transcript', 'names the transcript it replaced');
  has(d.declaration, `3 chapters, ${d.content.length} chars`, 'sizes the digest');
});

check('both policies: a chaptered item OVER the ceiling reads the digest (the rule that was always there)', () => {
  const t = words(LOCAL_MAX + 1000);
  for (const policy of ['raw', 'digest']) {
    const d = digest.resolveFieldContent({ transcript: t, sourceLabel: 'long.mov', ceiling: 'local', chapters: CHAPTERS, policy });
    eq(d.mode, 'chapter-digest', `${policy} over the ceiling`);
    has(d.declaration, `over the ${LOCAL_MAX}-char local direct-pass ceiling`, `${policy}: names the ceiling`);
  }
});

check('both policies: a chapterless item under the ceiling keeps its raw transcript; digest says why', () => {
  const t = words(20000);
  const raw = digest.resolveFieldContent({ transcript: t, sourceLabel: 'typed.txt', ceiling: 'local', chapters: [], policy: 'raw' });
  eq([raw.mode, raw.content === t, raw.declaration], ['raw-transcript', true, ''], 'raw chapterless');
  const dig = digest.resolveFieldContent({ transcript: t, sourceLabel: 'typed.txt', ceiling: 'local', chapters: [], policy: 'digest' });
  eq([dig.mode, dig.content === t, dig.policy], ['raw-transcript', true, 'digest'], 'digest chapterless');
  has(dig.declaration, 'has no chapter list', 'the digest policy says the item had no digest to read');
});

check('both policies: a chapterless item OVER the ceiling still fails, naming both facts', () => {
  for (const policy of ['raw', 'digest']) {
    throwsWith(
      () => digest.resolveFieldContent({ transcript: words(LOCAL_MAX + 5), sourceLabel: 'stream.mov', ceiling: 'local', chapters: [], policy }),
      ['stream.mov', `${LOCAL_MAX + 5} characters`, `over the ${LOCAL_MAX}-character local direct-pass ceiling`, 'no chapter list', 'Nothing was summarized or truncated'],
      `${policy}: chapterless over the ceiling`
    );
  }
});

check('the policy is stated per run: absent is the declared default, a known value is named, anything else refused', () => {
  const absent = digest.resolveFieldInputPolicy(undefined, 'the keeper');
  eq(absent.policy, 'raw', 'absent means raw');
  has(absent.line, 'the declared default', 'and says it was the default');
  eq(digest.DEFAULT_FIELD_INPUT_POLICY, 'raw', 'the default does not move before Owen\'s verdict (plan 7.4)');
  const dig = digest.resolveFieldInputPolicy('digest', 'the keeper');
  eq(dig.policy, 'digest', 'digest');
  has(dig.line, 'stated by the keeper', 'names who stated it');
  throwsWith(() => digest.resolveFieldInputPolicy('summary', 'the keeper'), ['unknown field input policy "summary"', 'raw or digest'], 'an unknown policy');
  throwsWith(() => digest.resolveFieldContent({ transcript: 'x', sourceLabel: 'a', ceiling: 'local', chapters: [], policy: undefined }),
    ['field input policy undefined'], 'resolveFieldContent never assumes a policy');
});

// ── 2. the one sizing rule ───────────────────────────────────────────────────

check('loadContextFor: the smallest 8,192 step holding prompt + budget + the 512 margin', () => {
  eq([cc.LOAD_CONTEXT_STEP, cc.LOAD_CONTEXT_MARGIN], [8192, 512], 'the step and the margin');
  // need = ceil(chars / 3.5) + budget + 512
  eq(cc.loadContextFor(0, 0), 8192, 'nothing still loads one step');
  eq(cc.loadContextFor(0, 8192 - 512), 8192, 'exactly one step');
  eq(cc.loadContextFor(0, 8192 - 511), 16384, 'one token over');
  eq(cc.loadContextFor(7, 8192 - 514), 8192, '2 prompt tokens, exactly one step');
  eq(cc.loadContextFor(8, 8192 - 514), 16384, '3 prompt tokens (ceil), one over');
  eq(cc.loadContextFor(3.5 * (16384 - 512 - 2048), 2048), 16384, 'exactly two steps');
  eq(cc.loadContextFor(3.5 * (16384 - 512 - 2048) + 1, 2048), 24576, 'one character over two steps');
  eq(cc.loadContextFor(3.5 * 900, 16384), 24576, 'a thinking call on a short prompt');
  throwsWith(() => cc.loadContextFor(-1, 10), ['loadContextFor was given'], 'a negative prompt');
  throwsWith(() => cc.loadContextFor(10, 1.5), ['loadContextFor was given'], 'a fractional budget');
});

check('a call sized by loadContextFor never fails the door\'s own check on the window it asked for', () => {
  for (let chars = 0; chars <= 200000; chars += 997) {
    for (const budget of [0, 1024, 2048, 4096, 8192, 16384]) {
      const loaded = cc.loadContextFor(chars, budget);
      cc.checkBeforeSending({ model: 'm', server: 's', what: 'w', promptChars: chars, maxTokens: budget, loaded: { tokens: loaded, source: 'load_context' } });
      if (loaded > cc.LOAD_CONTEXT_STEP) {
        // ...and it is the SMALLEST: one step down would not hold it with the margin.
        const need = cc.estimateTokens(chars) + budget + cc.LOAD_CONTEXT_MARGIN;
        if (need <= loaded - cc.LOAD_CONTEXT_STEP) throw new Error(`${chars} chars + ${budget} asked ${loaded}, one step too many`);
      }
    }
  }
});

check('the door\'s over_context names the call, the estimate, the budget and the loaded context', () => {
  throwsWith(() => cc.checkBeforeSending({ model: 'qwen3.8-27b-4bit', server: 'mac', what: 'the titles call for a.mov', promptChars: 35000, maxTokens: 2048, loaded: { tokens: 8192, source: 'load_context' } }),
    ['the titles call for a.mov', 'needs ~12048 tokens', '~10000 of prompt', '2048-token output budget', 'loaded with 8192 (load context)', 'Nothing was sent'], 'over_context');
});

// ── 3. each call site's budget and step on a sample prompt ───────────────────

check('each call site\'s budget, and the step it asks for on a 12,000-character (~3,429-token) prompt', () => {
  const sample = 12000;
  const sites = {
    'field call (titles, thumbnail, pinned, tags) + more titles': [tasks.LOCAL_FIELD_NUM_PREDICT, 2048, 8192],
    'rewrite pass (scrub, Soften), thinking on': [rewrite.REWRITE_NUM_PREDICT, 16384, 24576],
    're-roll revise, thinking on': [reroll.REVISE_NUM_PREDICT, 8192, 16384],
    'snap chapter title, thinking on': [summarize.TITLE_MAX_TOKENS, 16384, 24576],
    'decide (snap, re-roll scorer)': [cc.DECIDE_QUESTION_TOKENS, 1024, 8192],
  };
  for (const [site, [actual, budget, step]] of Object.entries(sites)) {
    eq(actual, budget, `${site}: its budget`);
    eq(cc.loadContextFor(sample, budget), step, `${site}: its step`);
  }
});

// ── 4. the 16,384 assertion ──────────────────────────────────────────────────

const call = (what, chars, maxTokens, extra = {}) => ({ what, model: 'qwen3.8-27b-4bit', chars, server: 'mac', maxTokens, act: 'generate', ...extra });

check('the assertion passes an item whose every local call loads at 16,384 or less, naming the largest', () => {
  const r = assertion.contextAssertion([
    call('titles', 20000, 2048), call('description', 30000, 4096),
    call('decide chunk', 40000, 0, { act: 'decide' }), call('cloud', 900000, 16000, { model: 'anthropic/claude-sonnet-5' }),
    { what: 'claude', model: 'claude-cli:sonnet', chars: 900000, server: 'claude -p' },
  ]);
  eq([r.stats.fits, r.stats.localCalls, r.stats.over.length], [true, 3, 0], 'fits, three local calls');
  eq(r.stats.largest.what, 'description', 'the largest is named (8,572 + 4,096)');
  has(r.line, 'all 3 measured local call(s) fit', 'the line');
});

check('the assertion names every call over 16,384 and blocks nothing', () => {
  const r = assertion.contextAssertion([call('titles', 20000, 2048), call('chapter title 2', 3000, 16384), call('scrub: description', 2000, 16384)]);
  eq([r.stats.fits, r.stats.over.map((o) => [o.what, o.step])], [false, [['chapter title 2', 24576], ['scrub: description', 24576]]], 'the two over');
  has(r.line, '2 of 3 measured local call(s) need more than 16384', 'the line');
  has(r.line, 'Stated, not enforced', 'and says it is a statement');
});

check('a trace entry with no budget (before P4) is counted as unmeasured, never guessed', () => {
  const r = assertion.contextAssertion([{ what: 'old', model: 'qwen3.8-27b-4bit', chars: 100, server: 'mac' }, call('titles', 100, 2048)]);
  eq([r.stats.unmeasured, r.stats.fits], [1, false], 'one unmeasured, so not a pass');
  has(r.line, '1 recorded no budget and are not measured', 'said');
});

console.log('');
console.log(failures === 0 ? `ALL PASS (${passes})` : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
