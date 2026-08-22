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
const entities = require(path.join(ROOT, 'services/metadata/entity-extraction.js'));
const quality = require(path.join(ROOT, 'services/metadata/chapter-title-quality.js'));
const tagsHashtags = require(path.join(ROOT, 'services/metadata/tags-hashtags.js'));
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
const tasks = require(path.join(ROOT, 'services/metadata/metadata-tasks.js'));

/**
 * The prompt assets are read from the REPO'S OWN electron/assets/prompts, not from userData.
 *
 * That is deliberate: these checks assert what THIS COMMIT ships. Pointing them at the
 * installed copy would make them pass or fail on the state of one developer's machine, which
 * is the opposite of what a pre-merge check is for.
 */
const ASSETS_ROOT = path.join(__dirname, '..', 'electron', 'assets', 'prompts');
promptAssetsModule.initPromptAssets(ASSETS_ROOT);
const assets = promptAssetsModule.promptAssets();

/**
 * The release-cadence rules live in the RENDERER, which has no dist/main to require, so
 * they are transpiled straight from their own source here rather than mirrored into a
 * second copy of the arithmetic. A mirror is a rule you can change in one place and still
 * pass in the other; this cannot drift, because it IS the shipped file.
 */
const slots = (() => {
  const fs = require('fs');
  const ts = require('typescript');
  const src = path.join(
    __dirname,
    '..',
    'frontend/src/app/features/publish/publish-slots.ts',
  );
  const out = ts.transpileModule(fs.readFileSync(src, 'utf8'), {
    compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
    fileName: src,
  });
  const mod = { exports: {} };
  new Function('exports', 'module', 'require', out.outputText)(mod.exports, mod, require);
  return mod.exports;
})();

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
  eq(resolved.titles, 'qwen38-27b', 'the shipped default, which is local as of the consolidation build');
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

/**
 * THE WHOLE POINT OF THIS ONE: every default is local, and four of them are the SAME local
 * model, which is what makes titles + thumbnail + pinned + clips one call whose self-check can
 * actually be followed. A default that drifted back to the cloud would cost money silently.
 */
check('the shipped defaults are all local, and the packaging four share one model', () => {
  const resolved = routing.resolveMetadataRouting(undefined);
  eq(routing.describeRouting(resolved),
    'titles=qwen3.8:27b, description=qwen3.5:9b, tags=qwen3.5:9b, ' +
    'thumbnail_text=qwen3.8:27b, pinned_comment=qwen3.8:27b, clip_suggestions=qwen3.8:27b');
  for (const task of Object.keys(resolved)) {
    const option = routing.METADATA_ROUTING_OPTIONS[resolved[task]];
    if (option.kind !== 'local') throw new Error(task + ' defaults to a ' + option.kind + ' model');
  }
  const packaging = ['titles', 'thumbnail_text', 'pinned_comment', 'clip_suggestions']
    .map((t) => resolved[t]);
  if (new Set(packaging).size !== 1) {
    throw new Error('the packaging fields are on ' + new Set(packaging).size + ' models, so they are not one call');
  }
});

/** Summarization is DECLARED, not taken from a Settings field that might name a cloud model. */
check('summarization is declared, and declared local', () => {
  if (!routing.SUMMARIZATION_MODEL) throw new Error('SUMMARIZATION_MODEL is not exported');
  if (!routing.SUMMARIZATION_MODEL.startsWith('ollama:')) {
    throw new Error('summarization defaults to ' + routing.SUMMARIZATION_MODEL + ', which is not local');
  }
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

// The `now: () => new Date()` this used to pass was a latent bug in THIS FILE, not in the
// validator: FieldContext.now is a Date, and the publishAt validator calls ctx.now.toISOString().
// It never fired because the only field asserted here does not read the clock. Fixed in passing.
check('publish-set-fields accepts the flag and refuses anything but a boolean', () => {
  eq(validators.buildFieldPatch({ chaptersInDescription: false }, { listChannels: () => [], now: new Date() }),
     { chaptersInDescription: false });
  let threw = false;
  try {
    validators.buildFieldPatch({ chaptersInDescription: 'no' }, { listChannels: () => [], now: new Date() });
  } catch { threw = true; }
  if (!threw) throw new Error('a string should be refused, not coerced');
});

// ------------------------------------------- generation quality (metadata spec §4, §6.1-6.3)
//
// These are the surfaces the description/tags/hashtags build made CODE-OWNED. They belong
// here for the same reason the two above do: each decides something on the user's behalf and
// has a wrong answer that looks exactly like a right one — an entity that was never in the
// transcript, a tag list quietly cut mid-tag, a chapter title whose subject the model invented.

const CHAPTER_TRANSCRIPT =
  'Gene Bailey opens the broadcast talking about Christian nationalist action. ' +
  'He reads from Luke 19:13 and tells the audience to occupy territory. ' +
  'Later Gene Bailey brings up Jabez, D.L. Moody and Isaiah to justify a political takeover.';

check('the entity extractor reads names out of a cased transcript and skips sentence openers', () => {
  const found = entities.topEntities(CHAPTER_TRANSCRIPT, 8);
  for (const name of ['Gene Bailey', 'Jabez', 'Isaiah']) {
    if (!found.some((f) => f.includes(name.split(' ')[0]))) throw new Error(name + ' was not extracted');
  }
  // "He" and "Later" open sentences and are ordinary words: position explains them.
  if (found.some((f) => /^(He|Later)$/.test(f))) throw new Error('a sentence opener was returned as an entity');
  // Sub-names fold into the longer name rather than spending a slot each.
  if (found.filter((f) => /Bailey/.test(f)).length !== 1) throw new Error('Gene / Bailey / Gene Bailey were not folded');
});

check('an uncased transcript is REPORTED as unreadable, not silently mined', () => {
  const cased = entities.transcriptCasing(CHAPTER_TRANSCRIPT);
  if (!cased.usable) throw new Error('a normal Whisper transcript should be usable: ' + cased.reason);
  const uncased = entities.transcriptCasing(CHAPTER_TRANSCRIPT.toLowerCase());
  if (uncased.usable) throw new Error('an all-lowercase transcript must not be called usable');
  if (!uncased.reason) throw new Error('the refusal must say why');
  eq(entities.topEntities(CHAPTER_TRANSCRIPT.toLowerCase(), 8), []);
});

check('grounding catches a name the chapter never said, and passes one it did', () => {
  const good = quality.groundTitle("Gene Bailey's misreading of Luke 19:13", CHAPTER_TRANSCRIPT);
  eq(good.grounded, true, 'a title built from the transcript is grounded');
  const leaked = quality.groundTitle("Kent Christmas's death-angel prophecy", CHAPTER_TRANSCRIPT);
  eq(leaked.grounded, false, 'a name from outside the chapter is ungrounded');
  if (!leaked.ungrounded.join(' ').includes('Kent')) throw new Error('the ungrounded name is not named');
});

check("the operator's four real titles: three narrate an actor, his corrections do not", () => {
  const failed = [
    "A YouTuber critiques Gene Bailey's chapter on Christian nationalist action and the David and Goliath framing",
    "The speaker debunks Gene Bailey's misreading of Luke 19:13 and his call to occupy territory",
    "The speaker dismantles Gene Bailey's use of Jabez, D.L. Moody, and Isaiah to justify Christian political takeover",
    "The speaker reacts to Gene Bailey's end-times and gender identity claims",
  ];
  for (const title of failed) {
    if (!quality.narratesAnActor(title).narrated) throw new Error('missed a narrated title: ' + title);
  }
  const corrected = [
    "Gene Bailey's chapter on Christian nationalist action and the David and Goliath framing",
    "Debunking Gene Bailey's misreading of Luke 19:13 and his call to occupy territory",
    "Gene Bailey's use of Jabez, D.L. Moody, and Isaiah to justify Christian political takeover",
  ];
  for (const title of corrected) {
    if (quality.narratesAnActor(title).narrated) throw new Error('flagged a correct title: ' + title);
  }
  // Briefcase's alignment case: a REAL person as subject still narrates in verb form.
  if (!quality.narratesAnActor('Pastor Brad Wells shares his prayer ministry').narrated) {
    throw new Error('narration-verb form was missed');
  }
  if (quality.narratesAnActor("Pastor Brad Wells's prayer ministry").narrated) {
    throw new Error('the topic form of the same chapter was flagged');
  }
});

check('a POSSESSIVE actor is the target register, not the failure (both apostrophes)', () => {
  // Briefcase's regression set, verbatim. Their detector matched the actor-noun boundary inside
  // the possessive and flagged the very form the operator asked for.
  const clean = [
    "The panel's debate over whether the ceasefire holds",
    "The panel’s debate over whether the ceasefire holds", // typographic apostrophe
    "Pastor Brad Wells's account of his 11-year prayer ministry",
    "Pastor Brad Wells’s account of his 11-year prayer ministry",
  ];
  for (const title of clean) {
    if (quality.narratesAnActor(title).narrated) throw new Error('flagged the target register: ' + title);
  }
  const narrated = ['The panel debates whether the ceasefire holds', 'Pastor Brad Wells shares his ministry'];
  for (const title of narrated) {
    if (!quality.narratesAnActor(title).narrated) throw new Error('missed a narrated title: ' + title);
  }
  // The exemption stops at the INVENTED-NARRATOR family. A real run put "the speaker's book on
  // Christian nationalism" in a chapter title, which is possessive AND still an invented actor.
  for (const title of ["The speaker's book on Christian nationalism", 'The speaker’s book on Christian nationalism',
                       "The video's take on Roswell"]) {
    if (!quality.narratesAnActor(title).narrated) throw new Error('a possessive invented actor passed: ' + title);
  }
});

check('a noun that doubles as a verb is not a narration verb', () => {
  // The operator's own target form for a panel video. "Debate" leads the clause as a NOUN.
  for (const body of [
    "Debate about Trump's refusal to extend the Iran ceasefire MOU and rising tensions in the Strait of Hormuz",
    "Paul Petit's report on the 29-state lawsuit against Meta",
    'Discussion of mainstream alien belief, Roswell, and the UAP disclosure order',
  ]) {
    if (quality.narratesAnActor(body).narrated) throw new Error('flagged the target register: ' + body);
  }
  // ...but the same word with a subject in front of it still is one.
  if (!quality.narratesAnActor("The episode examines Kent Christmas's prophecies").narrated) {
    throw new Error('an actor subject with a verb was missed');
  }
});

check('the metric counts specificity and register independently', () => {
  const m = quality.scoreChapterTitles([
    "The speaker debunks Gene Bailey's misreading of Luke 19:13", // entity-rich, NARRATED
    'Man yells about conspiracies',                               // the spec's own generic example,
                                                                  // which fails BOTH dimensions
    "Gene Bailey's use of Jabez and D.L. Moody",                  // clean on both
  ]);
  eq(m.titles, 3);
  eq(m.genericTitles, 1, 'generic count');
  eq(m.narratedTitles, 2, 'narrated count');
  if (m.properNounsPerTitle <= 0) throw new Error('proper nouns were not counted');
  // The whole point of three numbers: the narrated one is NOT the generic one.
  if (m.perTitle[0].generic) throw new Error('an entity-rich narrated title was scored generic');
});

check('tags: spec order, nothing absent from the content, budget stops rather than truncates', () => {
  const a = tagsHashtags.assembleTags({
    primaryPhrase: 'christian nationalist action',
    entities: ['Gene Bailey', 'D.L. Moody'],
    keyPhrases: ['occupy territory', 'political takeover'],
    categories: ['news'],
    contentText: CHAPTER_TRANSCRIPT,
  });
  eq(a.tags[0], 'christian nationalist action', 'the exact primary phrase leads');
  eq(a.tags[1], 'Gene Bailey', 'entities come before key phrases');
  if (a.tags.includes('news')) throw new Error('a single generic word was published as a tag');
  if (a.cost > tagsHashtags.GENERATED_TAG_BUDGET_CHARS) throw new Error('over budget');

  const absent = tagsHashtags.assembleTags({
    primaryPhrase: 'Kent Christmas death angel',
    entities: [], keyPhrases: [], categories: [], contentText: CHAPTER_TRANSCRIPT,
  });
  eq(absent.tags, [], 'a phrase the content never contains is not published');
  eq(absent.notInContent, ['Kent Christmas death angel'], 'and it is RECORDED, not silently dropped');

  // Budget: many long real phrases, every one of them present in the content.
  const long = 'gene bailey christian nationalist action luke occupy territory jabez moody isaiah takeover ';
  const filler = [];
  for (let i = 0; i < 40; i++) filler.push('christian nationalist action luke occupy territory jabez');
  const capped = tagsHashtags.assembleTags({
    primaryPhrase: 'christian nationalist action',
    entities: [], keyPhrases: filler.concat(['gene bailey', 'occupy territory', 'jabez moody isaiah']),
    categories: [], contentText: long.repeat(3) + ' gene bailey occupy territory jabez moody isaiah',
  });
  if (capped.cost > tagsHashtags.GENERATED_TAG_BUDGET_CHARS) throw new Error('budget exceeded');
  for (const tag of capped.tags) {
    if (tag.endsWith(' ') || tag.length < 3) throw new Error('a tag looks truncated: "' + tag + '"');
  }
});

check('hashtags: 3-5, camel-cased, deduped against the title', () => {
  const tags = tagsHashtags.buildHashtags({
    entities: ['Gene Bailey', 'D.L. Moody'],
    keyPhrases: ['christian nationalist action', 'occupy territory'],
    title: 'Gene Bailey tells his audience to occupy territory',
    brandTag: 'Telltale Unfiltered',
  });
  if (tags.length < 3 || tags.length > 5) throw new Error('got ' + tags.length + ' hashtags: ' + tags.join(' '));
  for (const tag of tags) {
    if (!/^#[A-Za-z0-9]+$/.test(tag)) throw new Error('not a camel-cased hashtag: ' + tag);
  }
  // "occupy territory" is entirely inside the title, so it adds nothing above the title.
  if (tags.includes('#OccupyTerritory')) throw new Error('a hashtag repeating the title was kept');
  eq(tagsHashtags.camelCaseHashtag('christian nationalist action'), 'ChristianNationalistAction');
});

// ------------------------------------------------- the composer's TWO orders
//
// The hook is what selects the order, and its absence is a real historical read: every report
// on disk was written before the hook existed and must compose exactly as it always did.

const HOOKED = { ...ITEM, description_hook: 'Gene Bailey tells his audience to occupy territory.' };

check('an item WITH a hook composes hook / chapters / body / hashtags', () => {
  const out = composer.composeDescription(HOOKED, { includeChapters: true });
  if (!out.startsWith('Gene Bailey tells')) throw new Error('the hook is not first');
  const hookAt = out.indexOf('Gene Bailey tells');
  const chaptersAt = out.indexOf('0:00 - Opening');
  const bodyAt = out.indexOf('Body paragraph one.');
  const hashAt = out.indexOf('#One #Two');
  if (!(hookAt < chaptersAt && chaptersAt < bodyAt && bodyAt < hashAt)) {
    throw new Error('order is wrong: ' + JSON.stringify({ hookAt, chaptersAt, bodyAt, hashAt }));
  }
});

check('with the chapter block switched off the hook still leads and the block is gone', () => {
  const out = composer.composeDescription(HOOKED, { includeChapters: false });
  if (!out.startsWith('Gene Bailey tells')) throw new Error('the hook is not first');
  if (out.includes('0:00 - Opening')) throw new Error('chapters leaked into the WITHOUT form');
  if (!out.includes('Body paragraph one.')) throw new Error('body lost');
});

check('an item WITHOUT a hook composes byte-for-byte as it always did', () => {
  // The same two assertions the pre-existing checks make, restated against the historical
  // shape explicitly: this is the regression that would break every report on disk.
  eq(composer.composeDescription(ITEM, { includeChapters: true }),
     composer.composeDescription({ ...ITEM, description_hook: undefined }, { includeChapters: true }));
  if (!composer.composeDescription(ITEM, { includeChapters: true }).startsWith('0:00 - Opening')) {
    throw new Error('a hookless item must still start with its chapter block');
  }
});

// ------------------------------------------------- routing: the A/B option
check('the 4b is offered on description and tags, and the defaults did NOT move', () => {
  const table = Object.fromEntries(routing.METADATA_ROUTING_TASKS.map((t) => [t.id, t]));
  if (!routing.METADATA_ROUTING_OPTIONS['qwen35-4b']) throw new Error('qwen35-4b is not an option');
  eq(routing.METADATA_ROUTING_OPTIONS['qwen35-4b'].model, 'qwen3.5:4b');
  for (const id of ['description', 'tags']) {
    if (!table[id].options.includes('qwen35-4b')) throw new Error('qwen35-4b is not offered for ' + id);
    eq(table[id].defaultOptionId, 'qwen35-9b', id + ' default');
  }
  for (const id of ['titles', 'thumbnail_text', 'pinned_comment', 'clip_suggestions']) {
    if (table[id].options.includes('qwen35-4b')) throw new Error('qwen35-4b leaked onto ' + id);
  }
});

// ------------------------------------------------- release cadences (publish-slots.ts)
//
// Wall-clock rules, so every date below is built with the local-time constructor and
// every expectation is read back the same way. `slotKeyOf` is the comparison — an epoch
// millisecond would make these assertions true only in one time zone.

const slotKey = slots.slotKeyOf;
const NONE = new Set();

check('a channel name names its cadence, and an unknown one names none', () => {
  eq(slots.cadenceKeyFor('Owen Morgan (Telltale)'), 'telltale');
  eq(slots.cadenceKeyFor("Owen's Fireside Chat"), 'fireside');
  eq(slots.cadenceKeyFor('Owen Unfiltered'), 'unfiltered');
  eq(slots.cadenceKeyFor('TELLTALE'), 'telltale', 'matching is case-insensitive');
  eq(slots.cadenceKeyFor('Some Other Channel'), null, 'no cadence is invented');
  eq(slots.cadenceKeyFor(null), null);
});

check('Telltale releases only on Sundays and Thursdays at 13:00', () => {
  // Sat 22 Aug 2026, 09:00 local.
  const from = new Date(2026, 7, 22, 9, 0);
  const next = slots.slotsAfter('telltale', from, 21).slice(0, 4).map(slotKey);
  eq(next, [
    '2026-08-23T13:00', // Sunday
    '2026-08-27T13:00', // Thursday
    '2026-08-30T13:00',
    '2026-09-03T13:00',
  ]);
});

check('Unfiltered releases every day at 16:00', () => {
  const from = new Date(2026, 7, 22, 9, 0);
  const next = slots.slotsAfter('unfiltered', from, 7).slice(0, 3).map(slotKey);
  eq(next, ['2026-08-22T16:00', '2026-08-23T16:00', '2026-08-24T16:00']);
});

check('Fireside moves to 14:00 on Sundays and Thursdays so it clears the main channel', () => {
  const from = new Date(2026, 7, 21, 9, 0); // Friday
  const next = slots.slotsAfter('fireside', from, 7).slice(0, 7).map(slotKey);
  eq(next, [
    '2026-08-21T13:00', // Fri
    '2026-08-22T13:00', // Sat
    '2026-08-23T14:00', // Sun — after Telltale's 13:00
    '2026-08-24T13:00', // Mon
    '2026-08-25T13:00', // Tue
    '2026-08-26T13:00', // Wed
    '2026-08-27T14:00', // Thu — after Telltale's 13:00
  ]);
  // The whole point of the rule: neither of those two ever equals a Telltale slot.
  const telltale = new Set(slots.slotsAfter('telltale', from, 21).map(slotKey));
  for (const at of slots.slotsAfter('fireside', from, 21)) {
    if (telltale.has(slotKey(at))) throw new Error('Fireside collided with the main channel at ' + slotKey(at));
  }
});

check('a slot exactly now is passed over — "next" means strictly after', () => {
  const from = new Date(2026, 7, 23, 13, 0); // Sunday 13:00 on the nose
  eq(slotKey(slots.nextOpenSlot('telltale', from, NONE)), '2026-08-27T13:00');
});

check('the next OPEN slot skips the ones another item on that channel already holds', () => {
  const from = new Date(2026, 7, 22, 9, 0);
  const taken = new Set(['2026-08-23T13:00', '2026-08-27T13:00']);
  eq(slotKey(slots.nextOpenSlot('telltale', from, taken)), '2026-08-30T13:00');
});

check('every slot taken inside the horizon is reported as none, never as a busy one', () => {
  const from = new Date(2026, 7, 22, 9, 0);
  const all = new Set(slots.slotsAfter('telltale', from, 30).map(slotKey));
  eq(slots.nextOpenSlot('telltale', from, all, 30), null);
});

check('a collision is reported, and a cadence slot is told from a hand-typed time', () => {
  const taken = new Set(['2026-08-23T13:00']);
  if (!slots.collidesWith(new Date(2026, 7, 23, 13, 0), taken)) throw new Error('collision missed');
  if (slots.collidesWith(new Date(2026, 7, 23, 13, 30), taken)) throw new Error('half past is not the slot');
  if (!slots.isCadenceSlot('telltale', new Date(2026, 7, 23, 13, 0))) throw new Error('Sunday 13:00 is a Telltale slot');
  if (slots.isCadenceSlot('telltale', new Date(2026, 7, 24, 13, 0))) throw new Error('Monday is not');
});

check('an unknown cadence key throws rather than answering for some other channel', () => {
  let threw = false;
  try { slots.slotsAfter('nightly', new Date(2026, 7, 22, 9, 0), 7); } catch { threw = true; }
  if (!threw) throw new Error('an unknown cadence should be refused, not guessed at');
});

check('a horizon that cannot hold a day is refused rather than silently returning nothing', () => {
  let threw = false;
  try { slots.slotsAfter('telltale', new Date(2026, 7, 22, 9, 0), 0); } catch { threw = true; }
  if (!threw) throw new Error('a zero-day horizon should be refused');
});

// ------------------------------------------------------- the prompt assets
//
// These assert the CONTRACT of the one prompt directory: every channel assembles, nothing is
// silently substituted when a key is missing, and the two defects the consolidation was for —
// an unfollowable self-check and an ungrounded title — are actually caught.

check('every shipped channel assembles an editorial prompt and a full instruction set', () => {
  const ids = assets.channelIds();
  if (ids.length < 5) throw new Error('expected the five shipped channels, got ' + ids.join(', '));
  for (const id of ids) {
    const channel = assets.channel(id);
    const editorial = assets.editorialPrompt(channel);
    if (!editorial.includes('{subject}')) {
      throw new Error(id + ': the editorial prompt has no {subject} slot left for the content');
    }
    if (editorial.includes('{channel_focus}')) {
      throw new Error(id + ': {channel_focus} was never filled');
    }
    for (const field of channel.fields) {
      const section = assets.fieldSection(channel, field);
      const leftover = section.match(/\{[a-z_]+\}/);
      if (leftover) throw new Error(id + '/' + field + ': unfilled slot ' + leftover[0]);
    }
  }
});

/**
 * NO FALLBACKS, tested rather than asserted in a comment. A prompt this app cannot find must
 * stop the run naming the file and the key — never resolve to a built-in stand-in, because a
 * stand-in prompt produces output that looks generated and was written to no brief.
 */
check('a missing prompt key throws naming the file and the key', () => {
  let message = '';
  try {
    assets.pipeline('system.yml', 'no_such_prompt');
  } catch (e) {
    message = e.message;
  }
  if (!message) throw new Error('a missing key resolved to something instead of throwing');
  if (!message.includes('system.yml')) throw new Error('the error does not name the file: ' + message);
  if (!message.includes('no_such_prompt')) throw new Error('the error does not name the key: ' + message);

  let fileMessage = '';
  try {
    assets.pipeline('not-a-file.yml', 'json_system');
  } catch (e) {
    fileMessage = e.message;
  }
  if (!fileMessage.includes('not-a-file.yml')) throw new Error('a missing FILE did not name itself: ' + fileMessage);
});

check('an unknown channel throws and names the ones that exist', () => {
  let message = '';
  try { assets.channel('youtube-nonexistent'); } catch (e) { message = e.message; }
  if (!message.includes('youtube-telltale')) throw new Error('the error does not list the real channels: ' + message);
});

/**
 * THE SELF-CHECK DEFECT. Before this build the whole self-check rode with whichever group held
 * the titles, so a titles-only group was told "thumbnail options don't repeat core words from
 * the top 3 titles" about thumbnail text it would never write. Assembled per group, that line
 * appears only where BOTH fields are in the same call — which, on the shipped routing, is
 * always.
 */
check('the self-check is assembled per group and never asks for a field the group lacks', () => {
  const telltale = assets.channel('youtube-telltale');

  const titlesOnly = assets.selfCheckBlock(telltale, ['titles']);
  if (/[Tt]humbnail/.test(titlesOnly)) {
    throw new Error('a titles-only group was handed a thumbnail check:\n' + titlesOnly);
  }
  if (!titlesOnly.includes('hook inside the first 45 characters')) {
    throw new Error('the titles group lost its own title check:\n' + titlesOnly);
  }

  const both = assets.selfCheckBlock(telltale, ['titles', 'thumbnail_text']);
  if (!/[Tt]humbnail options don't repeat core words/.test(both)) {
    throw new Error('a group holding BOTH fields lost the cross-field check:\n' + both);
  }

  const thumbOnly = assets.selfCheckBlock(telltale, ['thumbnail_text']);
  if (/top 3 titles/.test(thumbOnly)) {
    throw new Error('a thumbnail-only group was told to compare against titles it did not write:\n' + thumbOnly);
  }

  // The global lines ride with every group, whatever it holds.
  for (const block of [titlesOnly, both, thumbOnly]) {
    if (!block.includes('NO AI-ISMS')) throw new Error('a group lost the global self-check lines');
  }
});

/**
 * THE NINE TITLE DEFECTS, asserted where they can be: the frozen A/B numbers, the dead length
 * floor, the ASCII ban and the author-note are all absences, and an absence is exactly the kind
 * of thing that comes back without a test.
 */
check('the titles prompt carries none of the nine defects it was rewritten to remove', () => {
  const telltale = assets.channel('youtube-telltale');
  const titles = assets.fieldSection(telltale, 'titles');
  const editorial = assets.editorialPrompt(telltale);
  const selfCheck = assets.selfCheckBlock(telltale, telltale.fields);
  const all = [titles, editorial, selfCheck].join('\n');

  const banned = [
    ['25 of 31', 'a frozen A/B count'],
    ['14 of 17', 'a frozen A/B count'],
    ['underperformed in our A/B', 'a frozen A/B claim'],
    ['45-70 characters', 'the dead length floor'],
    ['bracketed tag', 'the unevidenced bracket suggestion'],
    ['ASCII characters only', 'the diacritic-banning self-check line'],
    ['Do not require question-format', 'a note to the prompt author'],
    ['Name names. Always.', 'the absolute that contradicted the lead-with-the-deed rule'],
    ["drives the description's first sentence and the tags", 'a claim about fields this call no longer writes'],
    ['Did X really', 'the question-format legal example the A/B evidence contradicts'],
  ];
  for (const [needle, why] of banned) {
    if (all.includes(needle)) throw new Error(`"${needle}" is still in the prompt (${why})`);
  }

  if (!titles.includes('70 characters is the ceiling')) throw new Error('the 70-character ceiling is missing');
  if (!editorial.includes('accused of')) throw new Error('the attributed-claim legal example is missing');
  if (!/accented letters in real names/i.test(selfCheck)) {
    throw new Error('the self-check no longer allows diacritics in real names');
  }

  // Stated ONCE where the titles are asked for, not four times across the set.
  const swapMentions = (all.match(/swap test/gi) || []).length;
  if (swapMentions !== 2) {
    throw new Error(`the "no rephrasings" rule appears ${swapMentions} times; it should be the rule plus one check`);
  }
});

check("unfiltered's pipe-tail title format replaces the shared length line, and only there", () => {
  const unfiltered = assets.fieldSection(assets.channel('youtube-unfiltered'), 'titles');
  if (!unfiltered.includes('| [subject] | p[N]')) throw new Error('the multi-part convention is gone');
  if (unfiltered.includes('70 characters is the ceiling')) {
    throw new Error('unfiltered kept a ceiling its own convention deliberately exceeds');
  }
  const telltale = assets.fieldSection(assets.channel('youtube-telltale'), 'titles');
  if (telltale.includes('| [subject] |')) throw new Error("unfiltered's format leaked into a normal channel");
});

check('a channel that publishes no thumbnails says so by its field list', () => {
  const spreaker = assets.channel('podcast-spreaker');
  if (spreaker.fields.includes('thumbnail_text')) throw new Error('the podcast grew a thumbnail');
  if (spreaker.fields.includes('clip_suggestions')) throw new Error('the podcast grew clip suggestions');
  eq(spreaker.fields, ['titles', 'description', 'tags'], 'the three fields a podcast publishes');
});

// ------------------------------------------------------- the grounding check
//
// Every proper noun a generated title asserts has to be somewhere in the inputs. The check
// NEVER blocks — it triggers one re-ask and then a declared warning — so what is asserted here
// is that it FIRES on an invented name and stays quiet on a real one, including the possessive
// form the prompts explicitly ask for.

check('a title naming something the transcript never mentions is reported ungrounded', () => {
  const transcript = 'Marcus Wray told his congregation that God wants a fourth private jet.';
  const faults = tasks.ungroundedTitles(
    ['Marcus Wray wants a fourth jet', 'Kenneth Copeland wants a fourth jet'],
    transcript
  );
  eq(faults.length, 1, 'exactly one title is ungrounded');
  eq(faults[0].title, 'Kenneth Copeland wants a fourth jet');
  if (!faults[0].invented.join(' ').includes('Kenneth Copeland')) {
    throw new Error('the invented name was not named: ' + JSON.stringify(faults[0]));
  }
});

/**
 * THE FALSE POSITIVE THIS MUST NOT HAVE. The prompts ask for possessive form on purpose
 * ("Gene Bailey's misreading of Luke 19:13"), so a check that flagged the target register as
 * invented would fire on almost every correct title.
 */
check('possessive and split-spelling names are NOT false-positived', () => {
  const transcript =
    'Gene Bailey read Luke 19:13 and quoted D. L. Moody, then brought up the prayer of Jabez.';
  const faults = tasks.ungroundedTitles(
    [
      "Gene Bailey's misreading of Luke 19:13 and his call to occupy territory",
      "Gene Bailey's use of Jabez, D.L. Moody, and Isaiah to justify a takeover",
    ],
    transcript
  );
  // "Isaiah" is genuinely absent, so the second title IS ungrounded — but for that reason
  // alone, and the possessives and the split-spelled "D.L. Moody" must not contribute.
  eq(faults.length, 1, 'only the title with a genuinely absent name');
  eq(faults[0].invented, ['Isaiah'], 'and only that name');
});

check('nothing to check against is not silently a pass', () => {
  eq(tasks.ungroundedTitles(['Anything at all'], ''), [], 'no corpus, no verdict');
  eq(tasks.ungroundedTitles(undefined, 'a transcript'), [], 'a unit that returned no titles');
});

check('the grounding corpus is everything the model was actually given', () => {
  const text = tasks.titleGroundingText({
    content: 'SUMMARY TEXT',
    contentText: 'FULL TRANSCRIPT',
    videoTitle: 'THE VIDEO TITLE',
    sourceLabel: 'source-file.mp4',
    chapterSubjects: ['CHAPTER ONE'],
    chapterDetails: ['CHAPTER ONE DETAIL'],
  });
  for (const part of ['SUMMARY TEXT', 'FULL TRANSCRIPT', 'THE VIDEO TITLE', 'source-file.mp4',
                      'CHAPTER ONE', 'CHAPTER ONE DETAIL']) {
    if (!text.includes(part)) throw new Error('the corpus is missing ' + part);
  }
});

// ------------------------------------------------------- the legacy path is gone
//
// The run planner is asserted through a STUB AIManagerService rather than a real one: what is
// under test is which units get planned for which kind of item, and that is pure decision-making
// over the routing table and the channel's field list.

function stubManager(channelId) {
  const channel = assets.channel(channelId);
  const sections = channel.fields.map((f) => tasks.METADATA_FIELD_SECTIONS[f].section);
  return { promptSetSectionKeys: () => new Set(sections) };
}

check('an item WITHOUT chapters plans the same routed units, not a legacy single call', () => {
  const resolved = routing.resolveMetadataRouting(undefined);
  const plan = tasks.planMetadataUnits(resolved, 'http://localhost:11434',
    stubManager('youtube-telltale'), false, /* hasChapters */ false);

  const written = new Set();
  for (const unit of plan.units) for (const f of unit.fields) written.add(f);

  for (const field of ['titles', 'thumbnail_text', 'pinned_comment', 'clip_suggestions',
                       'description', 'description_hook', 'tags']) {
    if (!written.has(field)) throw new Error(field + ' is not written by any unit on a chapterless item');
  }
  eq(plan.assembleTags, false, 'tags come from a model when there is no chapter list to measure pools against');
  eq(plan.assembleHashtags, true, 'hashtags are still derived in code');
});

check('an item WITH chapters keeps its code-assembled tags', () => {
  const resolved = routing.resolveMetadataRouting(undefined);
  const plan = tasks.planMetadataUnits(resolved, 'http://localhost:11434',
    stubManager('youtube-telltale'), false, /* hasChapters */ true);

  const written = new Set();
  for (const unit of plan.units) for (const f of unit.fields) written.add(f);
  if (written.has('tags')) throw new Error('a model was planned for tags on a chaptered item');
  eq(plan.assembleTags, true, 'assembled from the pools instead');
});

/**
 * The four packaging fields default to ONE model, so they are ONE call. This is the property
 * that makes the cross-field self-check followable, and it is worth asserting on the PLAN and
 * not only on the routing table — a grouping bug would leave the table correct and the calls
 * split.
 */
check('the shipped defaults plan ONE packaging call, not four', () => {
  const plan = tasks.planMetadataUnits(routing.resolveMetadataRouting(undefined),
    'http://localhost:11434', stubManager('youtube-telltale'), true, true);
  const packaging = plan.units.filter((u) => u.fields.includes('titles'));
  eq(packaging.length, 1, 'exactly one unit writes titles');
  for (const field of ['thumbnail_text', 'pinned_comment', 'clip_suggestions']) {
    if (!packaging[0].fields.includes(field)) {
      throw new Error(field + ' is in a different call from the titles it has to be coherent with');
    }
  }
});

check('a podcast plans no thumbnail or clip unit at all', () => {
  const plan = tasks.planMetadataUnits(routing.resolveMetadataRouting(undefined),
    'http://localhost:11434', stubManager('podcast-spreaker'), false, true);
  const written = new Set();
  for (const unit of plan.units) for (const f of unit.fields) written.add(f);
  if (written.has('thumbnail_text')) throw new Error('the podcast was routed a thumbnail');
  if (written.has('clip_suggestions')) throw new Error('the podcast was routed clip suggestions');
  eq(plan.assembleHashtags, false, 'and it renders no hashtags either');
});

// ------------------------------------------------------- the userData migration
//
// Simulated against a temp directory rather than the real one: the question is whether an
// install carrying the OLD flat prompt sets ends up with the new tree, and whether a
// hand-edited old set is left alone and announced rather than moved.

check('a userData dir holding the old flat prompt sets migrates to the new tree', () => {
  const fs = require('fs');
  const os = require('os');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-prompt-migration-'));
  const promptSets = path.join(tmp, 'prompt_sets');
  fs.mkdirSync(promptSets);

  // An install as it looked before this build: five channel sets, one summarization file, and
  // a .bak the operator made himself.
  const legacy = ['youtube-telltale.yml', 'youtube-fireside.yml', 'youtube-unfiltered.yml',
                  'youtube-shorts.yml', 'podcast-spreaker.yml', 'summarization_prompts.yml'];
  const crypto = require('crypto');
  const provenance = { version: 1, files: {} };
  for (const file of legacy) {
    const body = 'name: ' + file + '\neditorial_prompt: |-\n  old\n';
    fs.writeFileSync(path.join(promptSets, file), body);
    provenance.files[file] = {
      shippedHash: crypto.createHash('sha256').update(body).digest('hex'),
      updatedAt: new Date().toISOString(),
    };
  }
  fs.writeFileSync(path.join(promptSets, 'youtube-telltale.yml.bak-2026-08-02'), 'a backup of my own');

  // The operator edited one of them after we installed it, so its hash no longer matches.
  fs.appendFileSync(path.join(promptSets, 'youtube-fireside.yml'), '\n# my own edit\n');

  // --- what ensurePromptSetsDirectory does, applied here to the temp dir ---
  const installRecursively = (src, destRoot, prefix = '') => {
    for (const entry of fs.readdirSync(path.join(src, prefix), { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) installRecursively(src, destRoot, rel);
      else if (/\.ya?ml$/.test(entry.name)) {
        const dest = path.join(destRoot, 'prompts', rel);
        fs.mkdirSync(path.dirname(dest), { recursive: true });
        fs.copyFileSync(path.join(ASSETS_ROOT, rel), dest);
      }
    }
  };
  installRecursively(ASSETS_ROOT, promptSets);

  const archive = path.join(promptSets, 'superseded');
  const keptForEdits = [];
  for (const file of legacy) {
    const filePath = path.join(promptSets, file);
    const hash = crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
    if (provenance.files[file].shippedHash === hash) {
      fs.mkdirSync(archive, { recursive: true });
      fs.renameSync(filePath, path.join(archive, file));
    } else {
      keptForEdits.push(file);
    }
  }
  // --- end of the simulated migration ---

  eq(keptForEdits, ['youtube-fireside.yml'], 'the ONE file with local edits is kept and announced');
  if (fs.existsSync(path.join(promptSets, 'youtube-telltale.yml'))) {
    throw new Error('an untouched superseded set was left in place to look live');
  }
  if (!fs.existsSync(path.join(archive, 'youtube-telltale.yml'))) {
    throw new Error('an untouched superseded set was deleted rather than archived');
  }
  if (!fs.existsSync(path.join(promptSets, 'youtube-fireside.yml'))) {
    throw new Error("the operator's edited file was moved out from under him");
  }
  if (!fs.existsSync(path.join(promptSets, 'youtube-telltale.yml.bak-2026-08-02'))) {
    throw new Error('a .bak file was touched; those are the operator\'s');
  }

  // The migrated install is a working one: load the assets straight out of it.
  const migrated = promptAssetsModule.PromptAssets.load(path.join(promptSets, 'prompts'));
  if (!migrated.hasChannel('youtube-telltale')) throw new Error('the migrated tree has no channels');
  if (!migrated.pipeline('summarization.yml', 'youtube.system').includes('evidence-extraction')) {
    throw new Error('the summarization prompt did not survive the fold-in');
  }

  fs.rmSync(tmp, { recursive: true, force: true });
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
