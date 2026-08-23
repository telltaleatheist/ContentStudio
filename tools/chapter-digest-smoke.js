/**
 * Smoke test for the CHAPTER DIGEST mode (2026-08-23).
 *
 * WHAT IT PROVES, and why these three things:
 *
 *   1. Under the ceiling, the transcript reaches the field calls BYTE FOR BYTE. That is the
 *      whole 2026-08-22 direct-pass promise, and the change being tested here is a change to
 *      the OTHER branch — so the thing most worth asserting is that this branch is untouched.
 *   2. Over the ceiling WITH chapters, the content is the chapter digest, the run declares it
 *      in the words the operator will read, and no model is asked anything to produce it.
 *   3. Over the ceiling WITHOUT chapters, it FAILS LOUDLY naming BOTH facts. Either fact alone
 *      is ordinary; the pair has no answer, and the answer this replaced (a blind summary
 *      nobody chose) is exactly what Law 1 calls a deliberate bug.
 *
 * Plus the two prompt seams the mode is only correct at: the field prompt must not print the
 * chapter table of contents twice, and the description's `{transcript}` slot must be EMPTY —
 * nothing condensed is ever rendered under a heading that calls it the transcript.
 *
 * NO MODEL IS CALLED. Not stubbed at the transport — not reached: the digest is assembled in
 * code out of a chapter list the pipeline already produced, which is the point of it. The one
 * network-shaped object here is an AIManagerService, constructed and asked only to assemble
 * prompts (`initialize()` is never called, so no provider client is ever built).
 *
 * Run it against the COMPILED main process, which is what ships:
 *
 *   npm run build:electron && node tools/chapter-digest-smoke.js
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
const digest = require(path.join(ROOT, 'services/metadata/chapter-digest.js'));
const aiManagerModule = require(path.join(ROOT, 'services/metadata/ai-manager.service.js'));
const descriptionUnit = require(path.join(ROOT, 'services/metadata/description-unit.js'));
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));

// The repo's OWN prompts, not the installed copy: this asserts what THIS COMMIT ships.
const ASSETS_DIR = path.join(__dirname, '..', 'electron', 'assets');
promptAssetsModule.initPromptAssets(path.join(ASSETS_DIR, 'prompts'));

let failures = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures++;
    console.log(`FAIL  ${name} :: ${error.message}`);
  }
}
function eq(actual, expected, what) {
  if (actual !== expected) throw new Error(`${what} expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
}
function has(haystack, needle, what) {
  if (!haystack.includes(needle)) throw new Error(`${what}: "${needle}" is not there`);
}
function hasNot(haystack, needle, what) {
  if (haystack.includes(needle)) throw new Error(`${what}: "${needle}" should not be there`);
}
function countOf(haystack, needle) {
  return haystack.split(needle).length - 1;
}

// ---------------------------------------------------------------------------
// The fixture: a synthetic transcript, and a chapter list of the shape the
// whole-transcript pipeline produces (timestamp, 4-8 word title, 20-45 word detail).
// ---------------------------------------------------------------------------

/** Deterministic filler with real sentence shape, so char counts are the only variable. */
function transcriptOf(chars) {
  const paragraph =
    'HOST: The Louisiana sheriff told the committee that the work-release program pays the parish ' +
    'four dollars an hour and pays the man doing the work nothing at all. CLIP: That is not slavery, ' +
    'that is rehabilitation, and the numbers speak for themselves here. HOST: The numbers do speak. ' +
    'Eighteen thousand hours last year, and not one dollar of it went to the people who worked them. ';
  let out = '';
  while (out.length < chars) out += paragraph;
  return out.slice(0, chars);
}

const CHAPTERS = [
  {
    timestamp: '0:00',
    title: 'The work-release contract, read aloud',
    detail:
      'The sheriff reads the parish work-release contract into the record: four dollars an hour to ' +
      'the parish, nothing to the man doing the work, eighteen thousand hours logged last year.',
  },
  {
    timestamp: '4:12',
    title: 'Fox News reframes the prisoner exception',
    detail:
      'A Fox panel calls the arrangement rehabilitation rather than unpaid labour, and the host walks ' +
      'through the 13th Amendment prisoner exception the panel never names.',
  },
  {
    timestamp: '11:40',
    title: 'What the parish budget actually shows',
    // No detail: the detail call could not describe this chapter. A declared degradation of the
    // chapter pipeline, and the digest must carry the chapter anyway.
  },
];

// ---------------------------------------------------------------------------
// 1 — under the ceiling: byte for byte
// ---------------------------------------------------------------------------

check('under the ceiling the transcript reaches the field calls byte for byte', () => {
  const transcript = transcriptOf(80000); // under local 90k and far under cloud 400k
  for (const ceiling of ['local', 'cloud']) {
    const decision = digest.resolveFieldContent({
      transcript, sourceLabel: 'podcast 1.mov', ceiling, chapters: CHAPTERS,
    });
    eq(decision.mode, 'raw-transcript', `${ceiling}: the mode`);
    eq(decision.content === transcript, true, `${ceiling}: the content is the transcript object itself`);
    eq(decision.content.length, transcript.length, `${ceiling}: the length`);
    eq(decision.declaration, '', `${ceiling}: the raw path declares nothing`);
  }
});

check('having chapters does not condense an item that fits', () => {
  const transcript = transcriptOf(90000); // exactly AT the local ceiling
  const decision = digest.resolveFieldContent({
    transcript, sourceLabel: 'at-the-line.mov', ceiling: 'local', chapters: CHAPTERS,
  });
  eq(decision.mode, 'raw-transcript', 'at the ceiling is under it');
  eq(decision.content, transcript, 'unchanged');
});

// ---------------------------------------------------------------------------
// 2 — over the ceiling with chapters: the digest, declared
// ---------------------------------------------------------------------------

const OVER = transcriptOf(140000); // over local 90k, under cloud 400k
const overDecision = digest.resolveFieldContent({
  transcript: OVER, sourceLabel: 'six-hour-stream.mov', ceiling: 'local', chapters: CHAPTERS,
});

check('over the ceiling with chapters, the content IS the chapter digest', () => {
  eq(overDecision.mode, 'chapter-digest', 'the mode');
  for (const chapter of CHAPTERS) {
    has(overDecision.content, chapter.timestamp, 'the digest carries every timestamp');
    has(overDecision.content, chapter.title, 'the digest carries every title');
    if (chapter.detail) has(overDecision.content, chapter.detail, 'the digest carries every detail');
  }
  // The chapter whose detail call came back empty is still in the list. Dropping it would take
  // a span of the video out of the digest to punish a missing sentence.
  has(overDecision.content, '3. 11:40 - What the parish budget actually shows', 'the detail-less chapter');
  if (overDecision.content.length >= OVER.length) throw new Error('the digest is not smaller than the transcript');
});

check('the digest is assembled from an ASSET, not a string in the code', () => {
  const asset = promptAssetsModule.promptAssets().pipeline('system.yml', 'chapter_digest');
  has(asset, '{chapterList}', 'the asset has the slot');
  has(overDecision.content, 'there is no fuller transcript below', 'the asset prose reached the content');
  hasNot(overDecision.content, '{chapterList}', 'the slot was filled');
});

check('the mode is DECLARED in the words the operator reads', () => {
  const d = overDecision.declaration;
  has(d, 'six-hour-stream.mov', 'names the item');
  has(d, `${OVER.length} chars`, 'names the measurement');
  has(d, '90000-char local direct-pass ceiling', 'names the ceiling it is over');
  has(d, 'the content fields read the chapter digest', 'names what they read instead');
  has(d, `${CHAPTERS.length} chapters`, 'counts the chapters');
  has(d, `${overDecision.content.length} chars`, 'sizes the digest');
  has(d, 'verbatim phrasing is preserved inside', 'states what survives');
  // A statement, not an apology: nothing in it says the run did something regrettable.
  for (const word of ['sorry', 'unfortunately', 'fell back', 'fallback']) {
    hasNot(d.toLowerCase(), word, 'the declaration is a statement');
  }
});

check('the same item is raw on a cloud-routed run — the ceiling is the whole difference', () => {
  const cloud = digest.resolveFieldContent({
    transcript: OVER, sourceLabel: 'six-hour-stream.mov', ceiling: 'cloud', chapters: CHAPTERS,
  });
  eq(cloud.mode, 'raw-transcript', '140k is well under the 400k cloud ceiling');
  eq(cloud.content, OVER, 'and passes through untouched');
});

// ---------------------------------------------------------------------------
// 3 — over the ceiling with no chapters: loud failure naming BOTH facts
// ---------------------------------------------------------------------------

check('over the ceiling with NO chapters fails loudly, naming both facts', () => {
  let thrown;
  try {
    digest.resolveFieldContent({
      transcript: transcriptOf(500000), // over the cloud ceiling too
      sourceLabel: 'chapterless-podcast.mov',
      ceiling: 'cloud',
      chapters: [],
    });
  } catch (error) {
    thrown = error;
  }
  if (!thrown) throw new Error('it did not throw; something condensed the item silently');
  const m = thrown.message;
  has(m, 'chapterless-podcast.mov', 'names the item');
  has(m, '500000 characters', 'FACT ONE: how long it is');
  has(m, '400000-character cloud direct-pass ceiling', 'FACT ONE: what it is over');
  has(m, 'no chapter list', 'FACT TWO: it has no chapters');
  has(m, 'Nothing was summarized or truncated for you', 'says what it did NOT do instead');
});

check('neither fact alone fails an item', () => {
  digest.resolveFieldContent({
    transcript: transcriptOf(500000), sourceLabel: 'a.mov', ceiling: 'cloud', chapters: CHAPTERS,
  });
  digest.resolveFieldContent({
    transcript: transcriptOf(2000), sourceLabel: 'b.mov', ceiling: 'local', chapters: [],
  });
});

// ---------------------------------------------------------------------------
// 4 — the two prompt seams
// ---------------------------------------------------------------------------

/** A run context of the shape metadata-generator builds, in whichever content mode. */
function ctxFor(decision) {
  return {
    content: decision.content,
    contentMode: decision.mode,
    sourceLabel: 'six-hour-stream.mov',
    chapterSubjects: CHAPTERS.map((c) => c.title),
    chapterDetails: CHAPTERS.map((c) => c.detail || ''),
    videoTitle: 'The parish that rents out its prisoners',
    promptSetName: 'youtube-telltale',
    entities: ['Louisiana', 'Fox News'],
    keyPhrases: ['work release', 'prisoner exception'],
    contentText: OVER,
    contentSpeakerTagged: true,
    generated: {},
    warn: () => {},
  };
}

const rawDecision = digest.resolveFieldContent({
  transcript: transcriptOf(50000), sourceLabel: 'six-hour-stream.mov', ceiling: 'local', chapters: CHAPTERS,
});

// Constructed, never initialized: `loadPrompts` is all the prompt assembly needs, and
// `initialize()` is what would build a provider client and touch the network.
const manager = new aiManagerModule.AIManagerService({
  provider: 'ollama',
  transcriptCeiling: 'local',
  promptSet: 'youtube-telltale',
  promptSetsDir: ASSETS_DIR,
});
manager.loadPrompts();

const TITLES_SPEC = { field: 'titles', model: 'claude:sonnet', insights: false, inputFields: [] };

check('the field prompt states what the video covers ONCE, not twice', () => {
  const digestPrompt = manager.buildMetadataFieldPrompt(TITLES_SPEC, ctxFor(overDecision));
  eq(countOf(digestPrompt, '=== WHAT THIS VIDEO ACTUALLY COVERS ==='), 1,
    'the digest is the table of contents; the separate chapter block would be a second copy');
  eq(countOf(digestPrompt, CHAPTERS[0].detail), 1, 'and each chapter detail appears once');
  has(digestPrompt, '0:00', 'the digest keeps the timestamps the chapter block never had');

  // The raw path is unchanged: the chapter block, and the transcript beside it.
  const rawPrompt = manager.buildMetadataFieldPrompt(TITLES_SPEC, ctxFor(rawDecision));
  eq(countOf(rawPrompt, '=== WHAT THIS VIDEO ACTUALLY COVERS ==='), 1, 'the chapter block, once');
  has(rawPrompt, rawDecision.content, 'and the whole raw transcript');
});

check("the description's transcript slot is EMPTY on the digest path", () => {
  const unit = new descriptionUnit.DescriptionUnit(
    manager, { kind: 'cloud', id: 'sonnet5', label: 'Sonnet', model: 'claude:sonnet' }, 'http://localhost:11434',
    undefined, { holdOllamaModel: () => {} });

  const digestPrompt = unit.describePrompt(ctxFor(overDecision));
  hasNot(digestPrompt, 'The transcript of the video, in full', 'no condensation is labelled as the transcript');
  has(digestPrompt, 'What the video covers, chapter by chapter', 'the coverage block IS the content here');
  has(digestPrompt, CHAPTERS[1].detail, 'and it carries the chapter details');

  const rawPrompt = unit.describePrompt(ctxFor(rawDecision));
  has(rawPrompt, 'The transcript of the video, in full', 'the raw path still renders the transcript');
  has(rawPrompt, rawDecision.content, 'in full');
});

console.log('');
console.log(failures === 0 ? 'ALL CHECKS PASSED' : `${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
