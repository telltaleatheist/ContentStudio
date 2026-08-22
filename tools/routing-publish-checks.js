/**
 * Pure-function checks for the routing migration and the chapters-in-description flag.
 *
 * WHAT IT COVERS, and why these two things and not others: both are places where the app
 * DECIDES SOMETHING ON THE USER'S BEHALF from data it did not write. The routing migration
 * reads a store that an upgrade invalidated; the description resolver decides what a push
 * actually sends. Both have a wrong answer that looks exactly like a right one — a routing
 * silently reset, a chapter block silently dropped — so both are asserted rather than
 * eyeballed.
 *
 * Run it against the COMPILED main process, which is what ships:
 *
 *   npm run build:electron && npm run check:pure
 *
 * No test framework, on purpose: this runs one build output and prints one line per check.
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
const routing = require(path.join(ROOT, 'services/metadata/metadata-routing.js'));
const store = require(path.join(ROOT, 'services/publish/publish-store.service.js'));
const types = require(path.join(ROOT, 'services/publish/publish-types.js'));
const composer = require(path.join(ROOT, 'services/metadata/description-composer.js'));
const validators = require(path.join(ROOT, 'services/publish/field-validators.js'));

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
const eq = (a, b, m) => {
  const A = JSON.stringify(a), B = JSON.stringify(b);
  if (A !== B) throw new Error(`${m || ''} expected ${B}, got ${A}`);
};

// ---------------------------------------------------------------- migration
check('a real pre-upgrade store migrates instead of throwing', () => {
  const stored = {
    chapters: 'cogito-14b',
    description: 'headline-desc-14b',
    tags: 'headline-tags-14b',
    titles: 'headline-titles-14b',
    thumbnail_text: 'opus5',
  };
  // the old reader would have thrown on the very first key
  let threw = false;
  try { routing.resolveMetadataRouting(stored); } catch { threw = true; }
  if (!threw) throw new Error('resolveMetadataRouting should still refuse the raw stored object');

  const m = routing.migrateStoredRouting(stored);
  eq(m.changed, true, 'changed');
  eq(m.notices.length, 4, 'notice count');
  eq(m.selections, { thumbnail_text: 'opus5' }, 'survivors');
  const resolved = routing.resolveMetadataRouting(m.selections);
  eq(resolved.description, 'qwen35-9b');
  eq(resolved.tags, 'qwen35-9b');
  eq(resolved.titles, 'sonnet5');
  eq(resolved.thumbnail_text, 'opus5', 'the one legal choice is KEPT');
  eq('chapters' in resolved, false, 'chapters is no longer a task');
});

check('an embedding-chapters store migrates too', () => {
  const m = routing.migrateStoredRouting({ chapters: 'chapters-embedding', tags: 'qwen38-27b' });
  eq(m.changed, true);
  eq(m.selections, { tags: 'qwen38-27b' });
});

check('an id this build never had still THROWS', () => {
  let threw = false;
  try { routing.migrateStoredRouting({ tags: 'llama-9000' }); } catch { threw = true; }
  if (!threw) throw new Error('unknown option should throw, not migrate');
});

check('an empty / absent store is not a migration', () => {
  eq(routing.migrateStoredRouting(undefined).changed, false);
  eq(routing.migrateStoredRouting({}).changed, false);
});

check('the shipped defaults are the new table', () => {
  eq(routing.describeRouting(routing.resolveMetadataRouting(undefined)),
    'titles=claude:claude-sonnet-5, description=qwen3.5:9b, tags=qwen3.5:9b, ' +
    'thumbnail_text=qwen3.8:27b, pinned_comment=qwen3.5:9b, clip_suggestions=qwen3.8:27b');
});

check('every removed option id is really gone from the table', () => {
  for (const id of ['cogito-14b', 'qwen25-14b', 'qwen3-14b', 'headline-desc-14b',
                    'headline-tags-14b', 'headline-titles-14b',
                    'chapters-qwen27b-single', 'chapters-embedding']) {
    if (routing.METADATA_ROUTING_OPTIONS[id]) throw new Error(id + ' is still an option');
  }
  if (!routing.METADATA_ROUTING_OPTIONS['headline-titles-32b']) throw new Error('32B titles was dropped');
});

// ------------------------------------------------- chapters in the description
const ITEM = {
  description: 'Body paragraph one.\n\nBody paragraph two.',
  hashtags: '#One #Two',
  chapters: [
    { timestamp: '0:00', title: 'Opening' },
    { timestamp: '4:12', title: 'Roswell' },
    { timestamp: '9:30', title: 'The order' },
  ],
  tags: 'a, b',
};

check('composeChapterBlock renders the lines and nothing else', () => {
  eq(composer.composeChapterBlock(ITEM), '0:00 - Opening\n4:12 - Roswell\n9:30 - The order');
  eq(composer.composeChapterBlock({ description: 'x' }), '');
});

check('composeDescription honours includeChapters both ways', () => {
  const withCh = composer.composeDescription(ITEM, { includeChapters: true });
  const without = composer.composeDescription(ITEM, { includeChapters: false });
  if (!withCh.startsWith('0:00 - Opening')) throw new Error('chapters missing from the WITH form');
  if (without.includes('0:00 - Opening')) throw new Error('chapters leaked into the WITHOUT form');
  if (!without.startsWith('Body paragraph one.')) throw new Error('body lost');
  if (!without.includes('#One #Two')) throw new Error('hashtags lost');
});

function generated() {
  return {
    jobId: 'job-1',
    titles: ['T1', 'T2'],
    description: composer.composeDescription(ITEM, { includeChapters: true }),
    descriptionWithoutChapters: composer.composeDescription(ITEM, { includeChapters: false }),
    chapterBlock: composer.composeChapterBlock(ITEM),
    tags: 'a, b',
  };
}

check('a NEW record publishes chapters', () => {
  const rec = types.emptyChosenMetadata('itm-abc123-defghij0', 'job-1');
  eq(rec.chaptersInDescription, true);
  const r = store.resolveChosenMetadata(rec, generated());
  if (!r.description.startsWith('0:00 - Opening')) throw new Error('chapters missing');
});

check('switching the flag off drops the block from what gets pushed', () => {
  const rec = { ...types.emptyChosenMetadata('itm-abc123-defghij0', 'job-1'), chaptersInDescription: false };
  const r = store.resolveChosenMetadata(rec, generated());
  if (r.description.includes('0:00 - Opening')) throw new Error('chapters still there');
  if (!r.description.startsWith('Body paragraph one.')) throw new Error('body lost');
});

check('a record written before the flag existed still publishes chapters', () => {
  const legacy = { ...types.emptyChosenMetadata('itm-abc123-defghij0', 'job-1') };
  delete legacy.chaptersInDescription;
  const upgraded = types.upgradeStoredMetadata(legacy);
  eq(upgraded.chaptersInDescription, true);
});

check('an override still wins over both forms', () => {
  const rec = { ...types.emptyChosenMetadata('itm-abc123-defghij0', 'job-1'),
                descriptionOverride: 'hand written', chaptersInDescription: false };
  eq(store.resolveChosenMetadata(rec, generated()).description, 'hand written');
});

check('publish-set-fields accepts the flag and refuses anything but a boolean', () => {
  eq(validators.buildFieldPatch({ chaptersInDescription: false }, { listChannels: () => [], now: () => new Date() }),
     { chaptersInDescription: false });
  let threw = false;
  try {
    validators.buildFieldPatch({ chaptersInDescription: 'no' }, { listChannels: () => [], now: () => new Date() });
  } catch { threw = true; }
  if (!threw) throw new Error('a string should be refused, not coerced');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
