/**
 * Pure-function checks for the routing migration and the chapters-in-description flag.
 *
 * WHAT IT COVERS, and why these things and not others: all of them are places where the app
 * DECIDES SOMETHING ON THE USER'S BEHALF from data it did not write. The routing migration
 * reads a store that an upgrade invalidated; the description resolver decides what a push
 * actually sends; the chapter quote mapper decides what second a viewer lands on. Each has a
 * wrong answer that looks exactly like a right one — a routing silently reset, a chapter block
 * silently dropped, a chapter marker half a minute off — so each is asserted rather than
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
const chapters = require(path.join(ROOT, 'services/metadata/chapter-transcript.js'));
const tagsHashtags = require(path.join(ROOT, 'services/metadata/tags-hashtags.js'));
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
const tasks = require(path.join(ROOT, 'services/metadata/metadata-tasks.js'));
const aiManager = require(path.join(ROOT, 'services/metadata/ai-manager.service.js'));
const lifecycleModule = require(path.join(ROOT, 'services/metadata/model-lifecycle.js'));

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
  eq(resolved.description, 'qwen38-27b', 'the 27B default as of 2026-08-23 (the 9B shipped misattributed claims)');
  eq(resolved.tags, 'qwen35-9b');
  eq(resolved.titles, 'qwen38-27b', 'the shipped default, which is local as of the consolidation build');
  eq(resolved.thumbnail_text, 'opus5', 'the one legal choice is KEPT');
  // chapters is a routed task AGAIN (per-field build, 2026-08-24); the stored cogito-14b
  // was dropped as a removed option, so it resolves to the shipped default.
  eq(resolved.chapters, 'qwen38-27b', 'chapters resolve to the shipped default after the drop');
});

check('an embedding-chapters store migrates too', () => {
  const m = routing.migrateStoredRouting({ chapters: 'chapters-embedding', tags: 'qwen38-27b' });
  eq(m.changed, true);
  eq(m.selections, { tags: 'qwen38-27b' });
});

/**
 * THE SLOT'S LAST ACT. Chapters used to follow the writing-model slot's agreement without a
 * stored entry. A store from that era whose ex-slot fields agreed on a CLOUD option must
 * keep chaptering on that model — written down by migration as the chapters entry it always
 * effectively was — while local agreement (= the chapters default) and disagreement (= the old
 * local-constant path, also the default) write nothing.
 *
 * FOUR VOTERS, NOT FIVE, since clip_suggestions was retired (2026-08-25). A slot-era store set
 * all five to one value, so the four that remain agree exactly when the five did — which is why
 * dropping the fifth changes no answer this test asserts.
 */
check('a slot-era cloud store keeps its chapters on the cloud model it was projecting', () => {
  const cloudSlot = {
    titles: 'sonnet5', description: 'sonnet5', thumbnail_text: 'sonnet5',
    pinned_comment: 'sonnet5',
  };
  const m = routing.migrateStoredRouting(cloudSlot);
  eq(m.changed, true, 'the projection write-down is a recorded migration');
  eq(m.selections.chapters, 'sonnet5', 'chapters follow the agreement they always followed');
  eq(routing.resolveMetadataRouting(m.selections).chapters, 'sonnet5');

  // A stored chapters entry is the user's own and is never overwritten by the projection.
  const handSet = routing.migrateStoredRouting({ ...cloudSlot, chapters: 'opus5' });
  eq(handSet.selections.chapters, 'opus5', 'a hand-set chapters entry wins over the projection');

  // Disagreement projected to the local constant, which IS the chapters default: no entry.
  const disagreeing = routing.migrateStoredRouting({ ...cloudSlot, titles: 'qwen38-27b' });
  eq('chapters' in disagreeing.selections, false, 'no entry when the old projection fell to the constant');
  eq(disagreeing.changed, false);

  // All-local agreement equals the shipped default: writing an entry would add state for nothing.
  const localSlot = routing.migrateStoredRouting({ titles: 'qwen38-27b' });
  eq('chapters' in localSlot.selections, false);
  eq(localSlot.changed, false);
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
 * THE WHOLE POINT OF THIS ONE: every default is local, and the big fields are all the SAME
 * local model, which is what keeps titles + thumbnail + pinned on one resident model whose
 * cross-field self-check can actually be followed. A default that drifted back to the cloud
 * would cost money silently.
 */
check('the shipped defaults are all local, and the big fields share one model', () => {
  const resolved = routing.resolveMetadataRouting(undefined);
  eq(routing.describeRouting(resolved),
    'titles=qwen3.8:27b, description=qwen3.8:27b, chapters=qwen3.8:27b, tags=qwen3.5:9b, ' +
    'thumbnail_text=qwen3.8:27b, pinned_comment=qwen3.8:27b');
  for (const task of Object.keys(resolved)) {
    const option = routing.METADATA_ROUTING_OPTIONS[resolved[task]];
    if (option.kind !== 'local') throw new Error(task + ' defaults to a ' + option.kind + ' model');
  }
  const big = routing.METADATA_ROUTING_TASKS.filter((t) => t.modal).map((t) => resolved[t.id]);
  if (new Set(big).size !== 1) {
    throw new Error('the big fields default to ' + new Set(big).size + ' models; one model is the shipped state');
  }
});

/**
 * PER-FIELD ROUTING (2026-08-24). The modal is a field→model table: five big fields, each
 * settable to anything its task offers — every big field offers the 27B and all three cloud
 * rungs (Sonnet, Opus, Haiku). Tags are NOT a row ("if we use 9b for something then leave
 * it") and stay a stored-entry-only setting. Chapters are a routed task again, capable rungs
 * only — the 9B on chapters was half the measured 2026-08-23 failure stack.
 */
check('the modal is per-field: five big rows, tags row-less, cloud rungs everywhere', () => {
  const modal = routing.METADATA_ROUTING_TASKS.filter((t) => t.modal).map((t) => t.id);
  eq(modal.join(','), 'titles,description,chapters,thumbnail_text,pinned_comment');
  const tags = routing.METADATA_ROUTING_TASKS.find((t) => t.id === 'tags');
  eq(tags.modal, false, 'tags stay out of the modal');
  for (const task of routing.METADATA_ROUTING_TASKS.filter((t) => t.modal)) {
    for (const rung of ['qwen38-27b', 'sonnet5', 'opus5', 'haiku45']) {
      if (!task.options.includes(rung)) {
        throw new Error(task.id + ' does not offer ' + rung + '; every big field offers every big rung');
      }
    }
  }
  const chapters = routing.METADATA_ROUTING_TASKS.find((t) => t.id === 'chapters');
  eq(chapters.options.join(','), 'qwen38-27b,sonnet5,opus5,haiku45,claude-cli,claude-cli-sonnet', 'chapters offer the capable rungs plus the subscription rungs');
});

check('chapter resolution reads the chapters entry, and the view carries the modal flags', () => {
  // The four call sites (both chapter runs, the two-model budget, the compilation
  // summarizer) all go through resolveChapterModelOption; it is now a plain table read.
  const cloud = routing.resolveMetadataRouting({ chapters: 'haiku45' });
  eq(routing.resolveChapterModelOption(cloud).model, 'claude:claude-haiku-4-5');
  const stock = routing.resolveMetadataRouting(undefined);
  eq(routing.resolveChapterModelOption(stock).model, 'qwen3.8:27b');

  const inventory = { host: 'http://localhost:11434', reachable: false, models: [] };
  const view = routing.buildRoutingView({ titles: 'opus5' }, inventory);
  eq(view.slots, undefined, 'the slot payload is gone');
  eq(view.tasks.find((t) => t.id === 'titles').selectedOptionId, 'opus5',
    'a hand-set entry survives in the payload the modal saves back whole');
  eq(view.tasks.find((t) => t.id === 'chapters').modal, true);
  eq(view.tasks.find((t) => t.id === 'tags').modal, false);
});

/**
 * THE ADAPTERS ARE GONE (2026-08-25), AND A STORE THAT STILL NAMES ONE MUST SAY SO.
 *
 * `headline-titles-32b` was a real, working, selectable option the day before this build: its
 * base model was fine and its MLX shim still runs. That is exactly why it may not vanish
 * quietly — an operator whose titles were on the adapter has to be TOLD the field moved, not
 * discover it by reading a description that came out in a different voice. So it migrates with
 * a recorded notice naming the decision, and the raw store still refuses to resolve.
 *
 * `clip_suggestions` is the same event one level up: a whole TASK removed, dropped by the same
 * machinery, from REMOVED_ROUTING_TASKS instead of REMOVED_ROUTING_OPTIONS.
 */
check('a retired adapter and the retired clips task both migrate loudly, never silently', () => {
  let threw = false;
  try { routing.resolveMetadataRouting({ titles: 'headline-titles-32b' }); } catch { threw = true; }
  if (!threw) throw new Error('the raw store should still refuse an option this build removed');

  const m = routing.migrateStoredRouting({ titles: 'headline-titles-32b', clip_suggestions: 'opus5' });
  eq(m.changed, true, 'both drops are recorded migrations');
  eq(m.selections, {}, 'neither entry survives');
  eq(m.notices.length, 2, 'one notice per dropped entry');
  if (!m.notices.some((n) => /retired 2026-08-25/.test(n) && /titles/.test(n))) {
    throw new Error('the adapter drop must name the decision and the date:\n' + m.notices.join('\n'));
  }
  if (!m.notices.some((n) => /clip_suggestions/.test(n))) {
    throw new Error('the retired clips task must be named in its own notice:\n' + m.notices.join('\n'));
  }
  // Retired for a DECISION, not an outage — the reason must not send anyone server-hunting.
  const adapterNotice = m.notices.find((n) => /titles/.test(n));
  if (!/operator decision/.test(adapterNotice)) {
    throw new Error('the adapter notice must say it was a decision, not a failure: ' + adapterNotice);
  }

  // And nothing anywhere still offers it.
  if (routing.METADATA_ROUTING_OPTIONS['headline-titles-32b']) {
    throw new Error('the retired adapter is still a known option');
  }
  for (const task of routing.METADATA_ROUTING_TASKS) {
    if (task.id === 'clip_suggestions') throw new Error('the clips task is still in the table');
    for (const id of task.options) {
      if (/^headline-/.test(id)) throw new Error(task.id + ' still offers the adapter ' + id);
    }
  }
  // Every local option is a plain Ollama model now: no per-option host, no shape to pick.
  for (const [id, option] of Object.entries(routing.METADATA_ROUTING_OPTIONS)) {
    if (option.promptStyle !== undefined) throw new Error(id + ' still declares a promptStyle');
    if (option.host !== undefined) throw new Error(id + ' still declares its own host');
    if (option.startCommand !== undefined) throw new Error(id + ' still declares a server to spawn');
  }
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
  if (!titlesOnly.includes('hook inside the first 45')) {
    throw new Error('the titles group lost its own title check:\n' + titlesOnly);
  }

  const both = assets.selfCheckBlock(telltale, ['titles', 'thumbnail_text']);
  if (!/covers angles the titles above don't lead with/.test(both)) {
    throw new Error('a group holding BOTH fields lost the cross-field check:\n' + both);
  }

  const thumbOnly = assets.selfCheckBlock(telltale, ['thumbnail_text']);
  if (/top 3 titles|titles above/.test(thumbOnly)) {
    throw new Error('a thumbnail call was told to compare against titles it can neither write nor read:\n' + thumbOnly);
  }

  // ONE CALL PER FIELD makes this the shipped case: the thumbnail call writes only the
  // thumbnail text, and the titles reach it as INPUT DATA. The cross-field line has to come
  // back, or splitting the calls would have silently deleted the rule that ties them together.
  const thumbWithTitlesGiven = assets.selfCheckBlock(telltale, ['thumbnail_text'], ['titles']);
  if (!/covers angles the titles above don't lead with/.test(thumbWithTitlesGiven)) {
    throw new Error('a thumbnail call HANDED the titles lost the cross-field check:\n' + thumbWithTitlesGiven);
  }
  if (/hook inside the first 45/.test(thumbWithTitlesGiven)) {
    throw new Error('a field supplied as INPUT contributed its own check lines:\n' + thumbWithTitlesGiven);
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

  if (!titles.includes('50 to 70 characters')) throw new Error('the 50-70 length law is missing');
  if (!editorial.includes('accused of')) throw new Error('the attributed-claim legal example is missing');
  if (!/accented letters in real names/i.test(selfCheck)) {
    throw new Error('the self-check no longer allows diacritics in real names');
  }

  // The minimal rewrite's core (LEDGER #168): the argument instruction is present, and the
  // swap-test scaffolding it replaced is gone from the shared block (overrides keep their own).
  if (!titles.includes('underlying argument')) {
    throw new Error('the underlying-argument instruction — the core of the minimal rewrite — is missing');
  }
  const swapMentions = (all.match(/swap test/gi) || []).length;
  if (swapMentions !== 0) {
    throw new Error(`the swap test appears ${swapMentions} times in the shared assembly; the minimal rewrite removed it`);
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
    ['Marcus Wray Wants A Fourth Jet', 'Kenneth Copeland Wants A Fourth Jet'],
    transcript
  );
  eq(faults.length, 1, 'exactly one title is ungrounded');
  eq(faults[0].title, 'Kenneth Copeland Wants A Fourth Jet');
  if (!faults[0].invented.join(' ').includes('Kenneth Copeland')) {
    throw new Error('the invented name was not named: ' + JSON.stringify(faults[0]));
  }
});

/**
 * THE FALSE-POSITIVE STORM THIS REPLACED, kept as a regression because it is the reason the
 * viewer-facing check exists separately from the chapter one.
 *
 * These are real titles from this build's harness run against the 27b. Under the chapter-title
 * extractor, Title Case made "Buy", "Zero Accountability", "Critics Demons" and "Preachers
 * Need" all look like invented names, and seven of ten titles came back ungrounded — which
 * would have buried the ONE title in that run that really did make something up.
 */
check('Title Case does not turn ordinary words into invented names', () => {
  const fixture = path.join(__dirname, '..', 'prompt-harness', 'fixtures', 'transcript.example.txt');
  const transcript = require('fs').readFileSync(fixture, 'utf8');
  const clean = [
    'Marcus Wray Says God Told Him To Buy A Fourth Private Jet',
    'The Preacher Who Called His Critics Demons For Questioning A Jet',
    "Preachers Need A Tail Number. Faith Doesn't. Marcus Wray Proves It",
    'He Blamed Satan For People Asking Why A Preacher Needs Twelve Seats',
    'Wray: Questioning The Jet Means Satan Is Using You',
  ];
  const faults = tasks.ungroundedTitles(clean, transcript);
  if (faults.length > 0) throw new Error('false positives: ' + JSON.stringify(faults));

  // And the one from the same run that really did invent something: the transcript says the
  // aircraft seats twelve, and there is no fourteenth of anything in it.
  const real = tasks.ungroundedTitles(
    ['Marcus Wray Told His Congregation God Wants A Fourteenth Seat'], transcript);
  eq(real.length, 1, 'the genuine hallucination is still caught');
  eq(real[0].invented, ['Fourteenth Seat']);
});

/**
 * The check reports a CLAIM BUILT FROM WORDS THE VIDEO NEVER SAID as readily as an invented
 * name, and that is the intended reading rather than a leak in the test.
 *
 * Without a lexicon you cannot tell "Kenneth Copeland" from "Zero Accountability": both are two
 * adjacent capitalized words the inputs do not contain. For a channel whose brief opens by
 * naming its libel exposure, both are worth the same look — so the warning names the phrase and
 * says the video's own words do not contain it, rather than claiming it is a name.
 */
check('a phrase built from words the video never said is reported too', () => {
  const fixture = path.join(__dirname, '..', 'prompt-harness', 'fixtures', 'transcript.example.txt');
  const transcript = require('fs').readFileSync(fixture, 'utf8');
  const faults = tasks.ungroundedTitles(
    ['Four Private Jets. One Bible Verse. Zero Accountability. Marcus Wray.'], transcript);
  eq(faults.length, 1);
  eq(faults[0].invented, ['Zero Accountability'], 'the transcript says neither word');
});

/**
 * THE FALSE POSITIVE THIS MUST NOT HAVE. The prompts ask for possessive form on purpose
 * ("Gene Bailey's misreading of Luke 19:13"), so a check that flagged the target register as
 * invented would fire on almost every correct title.
 */
check('possessive and split-spelled names are NOT false-positived', () => {
  const transcript =
    'Gene Bailey read Luke 19:13 and quoted D. L. Moody, then brought up the prayer of Jabez. ' +
    'He misread the verse as a call to occupy territory until Christ returns.';
  eq(tasks.ungroundedTitles(
    ["Gene Bailey's Misreading Of Luke 19:13 And His Call To Occupy Territory"], transcript), [],
    'the possessive form the prompts ask for is the target register, not a fault');
  eq(tasks.ungroundedTitles(
    ["Gene Bailey's Use Of Jabez And D.L. Moody To Justify A Takeover"], transcript), [],
    'a name the transcript spells apart ("D. L. Moody") still grounds its title spelling');

  // A name from somewhere else entirely, in the same shape, IS caught.
  const faults = tasks.ungroundedTitles(
    ["Kenneth Copeland's Use Of Jabez To Justify A Takeover"], transcript);
  eq(faults.length, 1, 'the leaked name is caught even in possessive form');
  if (!faults[0].invented.join(' ').includes('Kenneth Copeland')) {
    throw new Error('the invented name was not named: ' + JSON.stringify(faults[0]));
  }
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

// ------------------------------------------------------- one call per field
//
// The run planner is asserted through a STUB AIManagerService rather than a real one: what is
// under test is which calls get planned for which kind of item, in what order, and that is pure
// decision-making over the routing table and the channel's field list.

function stubManager(channelId) {
  const channel = assets.channel(channelId);
  const sections = channel.fields.map((f) => tasks.METADATA_FIELD_SECTIONS[f].section);
  return { promptSetSectionKeys: () => new Set(sections) };
}

function plan(channelId, options) {
  const o = options || {};
  return tasks.planMetadataUnits({
    routing: routing.resolveMetadataRouting(o.routing),
    defaultHost: 'http://localhost:11434',
    aiManager: stubManager(channelId),
    hasInsights: Boolean(o.hasInsights),
    hasChapters: Boolean(o.hasChapters),
    alsoLoads: o.alsoLoads || [],
    lifecycle: o.lifecycle || new lifecycleModule.JobModelLifecycle(),
  });
}

check('an item WITHOUT chapters plans the same routed units, not a legacy single call', () => {
  const p = plan('youtube-telltale', { hasChapters: false });

  const written = new Set();
  for (const unit of p.units) for (const f of unit.fields) written.add(f);

  for (const field of ['titles', 'thumbnail_text', 'pinned_comment',
                       'description', 'description_hook', 'tags']) {
    if (!written.has(field)) throw new Error(field + ' is not written by any unit on a chapterless item');
  }
  // clip_suggestions was retired 2026-08-25: no channel declares it, no field file defines
  // it, and no unit may plan one. Planned anyway would be the legacy absorb-everything
  // behaviour coming back on a field that no longer exists at all.
  if (written.has('clip_suggestions')) {
    throw new Error('clip_suggestions planned for a field this build removed');
  }
  eq(p.assembleTags, false, 'tags come from a model when there is no chapter list to measure pools against');
  eq(p.assembleHashtags, true, 'hashtags are still derived in code');
});

check('an item WITH chapters keeps its code-assembled tags', () => {
  const p = plan('youtube-telltale', { hasChapters: true });

  const written = new Set();
  for (const unit of p.units) for (const f of unit.fields) written.add(f);
  if (written.has('tags')) throw new Error('a model was planned for tags on a chaptered item');
  eq(p.assembleTags, true, 'assembled from the pools instead');
});

/**
 * THE SPACE-JOINED TAG LIST, refused.
 *
 * Measured on qwen3.5:9b through the prompt harness: two runs in three answered the tags call
 * with every tag in it and no comma anywhere, which the comma split reads as ONE tag and which
 * shipped with nothing declared. The prompt now states and shows the separator; this asserts
 * that an answer ignoring it is still caught, because the prompt is the thing most likely to be
 * edited next.
 */
check('a tag list that came back without its commas is refused, not re-split on spaces', () => {
  const runOn =
    'Marcus Wray private jet fundraising televangelist cult prosperity gospel demonically ' +
    'influenced trolls high-control church scams Marcus Wray fourth jet allegations';
  const fault = tagsHashtags.unusableTagList(runOn);
  if (!fault) throw new Error('a 160-character run-on passed as a tag list');
  if (!/run-on|comma/.test(fault)) throw new Error('the reason does not name the missing commas: ' + fault);

  // The real shape passes, multi-word tags and all — the check must not be a length opinion.
  const real =
    'ken paxton,texas ten commandments law,sb10,ten commandments in schools,stone v graham,' +
    'separation of church and state,owen morgan,telltale atheist';
  eq(tagsHashtags.unusableTagList(real), undefined, 'a real shipped tag list is usable');

  // A short answer is thin, not broken: a count opinion belongs to the prompt.
  eq(tagsHashtags.unusableTagList('kent christmas,kat kerr'), undefined, 'two real tags are usable');
  eq(tagsHashtags.unusableTagList('christian nationalism'), undefined, 'one real tag is usable');

  // Nothing at all is a failure with a reason, not a silent empty list.
  if (!tagsHashtags.unusableTagList('')) throw new Error('an empty tags value passed');
  if (!tagsHashtags.unusableTagList(undefined)) throw new Error('a missing tags value passed');
});

/**
 * THE BRAND TERMS reach the TAGS instruction as the channel's own, or the assembly throws.
 *
 * The line said "channel brand terms" with nothing after it for the whole per-field wave, which
 * is a rule naming information the call does not carry: the tags call names the channel nowhere
 * else. Harness runs left the brand terms out entirely and one production run invented
 * "O. Morgan".
 */
check('the TAGS section names the channel\'s real brand terms, per channel', () => {
  const telltale = assets.fieldSection(assets.channel('youtube-telltale'), 'tags');
  for (const term of ['owen morgan', 'telltale atheist']) {
    if (!telltale.includes(term)) throw new Error('the telltale TAGS section does not name "' + term + '"');
  }
  if (/\{brand_terms\}/.test(telltale)) throw new Error('the {brand_terms} slot shipped unfilled');

  // Shorts takes its own shorter list, so the shared instruction is not one channel's terms.
  const shorts = assets.fieldSection(assets.channel('youtube-shorts'), 'tags');
  if (shorts.includes('telltale atheist')) throw new Error('shorts took telltale\'s brand terms');

  // Every channel that publishes tags assembles its section at all — a channel that asks for
  // the slot and declares no terms must throw rather than ship the brace.
  for (const id of assets.channelIds()) {
    const channel = assets.channel(id);
    if (!channel.fields.includes('tags')) continue;
    const text = assets.fieldSection(channel, 'tags');
    if (/\{[a-z_]+\}/.test(text)) throw new Error('channel "' + id + '" ships an unfilled slot in its TAGS section');
  }
});

/**
 * THE ORDERING CORE, in every variant.
 *
 * The 2026-08-25 minimal rewrite (LEDGER #178) rests on one instruction: most specific phrase
 * first, then the named people/organizations/events, then the broad category terms — in the
 * register the retired tags adapter was trained on ("a labelling job, not a hook"). It is the
 * line the taxonomy around it was cut in favour of, so it is asserted rather than trusted to a
 * later edit, the same way the exemplar below is.
 */
check('every tags variant states the specificity ordering, in the labelling register', () => {
  for (const id of assets.channelIds()) {
    const channel = assets.channel(id);
    if (!channel.fields.includes('tags')) continue;
    const text = assets.fieldSection(channel, 'tags');
    if (!/most specific two-to-four-word phrase/.test(text)) {
      throw new Error('channel "' + id + '" TAGS section does not open the list on the most specific phrase');
    }
    if (!/broad category terms/.test(text)) {
      throw new Error('channel "' + id + '" TAGS section never says the broad terms come last');
    }
    if (!/labelling job, not a hook/.test(text)) {
      throw new Error('channel "' + id + '" TAGS section lost the labelling register');
    }
  }
});

/**
 * THE SEPARATOR IS SHOWN, not only named, in every variant of the section.
 *
 * The OUTPUT FORMAT's `"tags": "comma-separated string"` is a type annotation and was the only
 * place a comma was ever mentioned; it did not survive the move to a 9B. An exemplar in the
 * demanded form is what the fix rests on, so it is asserted rather than trusted to a later edit.
 */
check('every channel that publishes tags is SHOWN the comma-separated form', () => {
  for (const id of assets.channelIds()) {
    const channel = assets.channel(id);
    if (!channel.fields.includes('tags')) continue;
    const text = assets.fieldSection(channel, 'tags');
    const exemplar = text.match(/"[^"\n]*,[^"\n]*"/);
    if (!exemplar) throw new Error('channel "' + id + '" is told the tag shape but never shown it');
    if (exemplar[0].split(',').length < 4) {
      throw new Error('channel "' + id + '" exemplar is too short to read as a list: ' + exemplar[0]);
    }
  }
});

/**
 * THE SHAPE CHANGE ITSELF. Every field is its own call and every call names exactly one key.
 *
 * This is the property the whole branch exists for, and it is asserted on the PLAN rather than
 * only on the routing table: a grouping bug would leave the table correct and quietly put four
 * fields back in one JSON object — which is the shape that dropped a key in 1 of 6 measured runs
 * (prompt-artifacts/README.md) and wrote `FOURTH JET` as a title in the seven-field era.
 */
check('every field gets its OWN call, and each call names exactly one key', () => {
  const p = plan('youtube-telltale', { hasChapters: true, hasInsights: true });
  for (const unit of p.units) {
    // The description is the one deliberate pair: a hook and a body, two calls, two keys, one
    // unit — schema-constrained separately (description-unit.ts).
    if (unit.fields.includes('description')) {
      eq([...unit.fields].sort().join(','), 'description,description_hook,description_options',
        'the description unit writes the hook, the body, and the additive options — nothing else');
      continue;
    }
    eq(unit.fields.length, 1, 'unit "' + unit.label + '" carries more than one field');
  }
  // One separate call per DECLARED packaging field — telltale declares all three that remain
  // since clips were retired, and a channel's fields list is a statement (LEDGER II-A #133).
  const packaging = p.units.filter((u) =>
    ['titles', 'thumbnail_text', 'pinned_comment'].some((f) => u.fields.includes(f)));
  eq(packaging.length, 3, 'each declared packaging field is its own call');
});

/**
 * THE ORDERING CONTRACT. Titles first, because the thumbnail call is handed them as input data
 * — that is what replaced the coherence a shared call used to buy. And units on one model run
 * consecutively, because Ollama reloads a model that has been evicted in between.
 */
check('titles run first, and the thumbnail call declares them as its input', () => {
  const p = plan('youtube-telltale', { hasChapters: true });
  eq(p.units[0].fields[0], 'titles', 'the first unit is the titles call');

  const thumb = p.units.find((u) => u.fields.includes('thumbnail_text'));
  if (!thumb.inputFields.includes('titles')) {
    throw new Error('the thumbnail call does not read the titles, so its cross-field rule is unfollowable');
  }
  // Every input a unit declares must be WRITTEN by an earlier unit. A plan that fails this
  // throws halfway through a real job, with the model already loaded.
  const writtenSoFar = new Set();
  for (const unit of p.units) {
    for (const input of unit.inputFields) {
      if (!writtenSoFar.has(input)) {
        throw new Error(unit.label + ' reads "' + input + '", which nothing before it writes');
      }
    }
    for (const f of unit.fields) writtenSoFar.add(f);
  }
});

check('calls on the same model run consecutively, so each model loads once', () => {
  const p = plan('youtube-telltale', { hasChapters: false });
  const labels = p.units.map((u) => u.label);
  // The label ends in the model, which is what the ordering groups on.
  const modelOf = (label) => label.replace(/^.*\((local|cloud) /, '').replace(/\).*$/, '');
  const seen = [];
  for (const label of labels) {
    const model = modelOf(label);
    if (seen[seen.length - 1] !== model) {
      if (seen.includes(model)) {
        throw new Error('model ' + model + ' is loaded, evicted and loaded again: ' + labels.join(' -> '));
      }
      seen.push(model);
    }
  }
});

/**
 * THE TITLES BLOCK the thumbnail call reads, and what it does when it is not there.
 *
 * Three cases, and the third is the one that matters: an absent input is a PLANNING BUG, so it
 * throws rather than sending a call that silently lost half its brief.
 */
check('the titles reach the thumbnail call as input data, or the call refuses', () => {
  const spec = { field: 'thumbnail_text', model: 'qwen3.8:27b', insights: false, inputFields: ['titles'] };
  const ctx = { sourceLabel: 'x.mp4', generated: { titles: ['Alpha One', 'Beta Two'] } };

  const block = tasks.buildInputDataBlock(spec, ctx);
  if (!block.includes('Alpha One') || !block.includes('Beta Two')) {
    throw new Error('the titles are not in the block the thumbnail call reads:\n' + block);
  }
  if (!/1\. Alpha One/.test(block)) throw new Error('the titles are not numbered, so "top 3" means nothing');

  // The "Show prompt" preview, assembled before anything has run.
  const pending = tasks.buildInputDataBlock(spec, { sourceLabel: 'x.mp4', generated: {} }, { pending: true });
  if (!/titles call runs first/.test(pending)) {
    throw new Error('the preview does not say where the titles come from:\n' + pending);
  }

  let threw = false;
  try {
    tasks.buildInputDataBlock(spec, { sourceLabel: 'x.mp4', generated: {} });
  } catch (e) {
    threw = /needs the titles/.test(e.message);
  }
  if (!threw) throw new Error('a thumbnail call with no titles behind it did not refuse');

  // A call that reads nothing renders nothing — no empty heading, no placeholder.
  eq(tasks.buildInputDataBlock({ ...spec, inputFields: [] }, ctx), '', 'a call with no inputs renders no block');
});

/**
 * ONE num_ctx PER MODEL PER RUN (ollama-json trap 4).
 *
 * Ollama fully reloads a model on any num_ctx change, so two calls on one model that sized
 * themselves independently would reload a 17GB model in the middle of an item. The largest
 * prompt wins and everybody shares it.
 */
check('two calls on one model share ONE num_ctx, sized by the larger', () => {
  const budget = new tasks.ModelRunContextBudget('qwen3.8:27b', new lifecycleModule.JobModelLifecycle());
  budget.register('titles', () => 9000);
  budget.register('pinned_comment', () => 4000);

  const ctx = { sourceLabel: 'x.mp4' };
  const first = budget.resolve(ctx);
  const second = budget.resolve(ctx);
  eq(first, second, 'the second call re-sized the window and would have reloaded the model');

  const expected = tasks.runNumCtx({
    model: 'qwen3.8:27b', needs: [9000, 4000], max: tasks.LOCAL_FIELD_CTX_MAX, what: 'the check',
  });
  eq(first, expected, 'the shared window is not the one the largest prompt needs');
  if (first < 9000) throw new Error('the shared window is smaller than the largest prompt: ' + first);
  // Bucketed to 4096 so two items whose transcripts differ slightly land on the same value.
  eq(first % 4096, 0, 'the window is not on a 4096 bucket, so near-identical items reload the model');
});

/**
 * THE num_ctx RATCHET (model-lifecycle.ts).
 *
 * The unloads are gone, so a model stays resident across a job's stages — and a later stage that
 * sizes a SMALLER window reloads it anyway, for nothing. The floor is per job and per model, it
 * never shrinks, and it never pushes a call past the ceiling its own stage refuses at.
 */
check('a stage never sizes below a window this job already made resident', () => {
  const life = new lifecycleModule.JobModelLifecycle();
  eq(life.contextFloor('qwen3.8:27b', 40960), 0, 'a model nothing has loaded is claimed to have a floor');

  life.recordContext('qwen3.8:27b', 24576);
  eq(life.contextFloor('qwen3.8:27b', 40960), 24576, 'the resident window is not the floor for the next call');
  eq(life.contextFloor('qwen3.5:9b', 40960), 0, 'one model\'s window became another model\'s floor');

  // Growth is a legitimate reload; the floor keeps the larger value from then on.
  life.recordContext('qwen3.8:27b', 32768);
  eq(life.contextFloor('qwen3.8:27b', 40960), 32768, 'a grown window did not raise the floor');
  life.recordContext('qwen3.8:27b', 8192);
  eq(life.contextFloor('qwen3.8:27b', 40960), 32768, 'a smaller later call lowered the floor');
});

check('the ratchet never pushes a call past its own stage ceiling', () => {
  const life = new lifecycleModule.JobModelLifecycle();
  life.recordContext('qwen3.8:27b', 40960);
  // The chapter pipeline refuses above 32768; a floor it cannot ask for would turn into that
  // refusal, so it is clamped and that stage reloads the model instead.
  eq(life.contextFloor('qwen3.8:27b', 32768), 32768, 'the floor was allowed past the caller\'s ceiling');
  eq(lifecycleModule.contextFloor(undefined, 32768), 0);
  eq(lifecycleModule.contextFloor(4096, 32768), 4096);
});

check('a second item sizes to the window the first one left resident', () => {
  const life = new lifecycleModule.JobModelLifecycle();
  const first = new tasks.ModelRunContextBudget('qwen3.8:27b', life);
  first.register('titles', () => 9000);
  const firstCtx = first.resolve({ sourceLabel: 'long.mp4' });

  // A shorter transcript: its own sizing is smaller, and pinning it would reload the model to
  // make the window smaller than the one already loaded.
  const second = new tasks.ModelRunContextBudget('qwen3.8:27b', life);
  second.register('titles', () => 2000);
  eq(second.resolve({ sourceLabel: 'short.mp4' }), firstCtx, 'item 2 shrank the window and reloaded the model');
});

check('no metadata unit can release a model — the job does that, once', () => {
  const p = plan('youtube-telltale', { hasChapters: true });
  for (const unit of p.units) {
    if (typeof unit.unload === 'function') {
      throw new Error(`unit "${unit.label}" still unloads its own model when it finishes`);
    }
  }
});

check('a prompt too big for any window this app will ask for is REFUSED, not truncated', () => {
  let message = '';
  try {
    tasks.runNumCtx({ model: 'qwen3.8:27b', needs: [200000], max: tasks.LOCAL_FIELD_CTX_MAX, what: 'a huge call' });
  } catch (e) {
    message = e.message;
  }
  if (!/above the \d+ ceiling/.test(message)) {
    throw new Error('an oversized prompt did not refuse: ' + (message || 'it returned a number'));
  }
});

/**
 * THE TWO-LLM BUDGET. One call per field makes a five-model run trivially easy to configure, and
 * every extra model is a multi-GB load that evicts the last one. The roster counts what the run
 * ACTUALLY loads — the field calls and the chapter pipeline — and says so.
 *
 * THE SUMMARIZER USED TO BE A THIRD ENTRY HERE and this check used to supply it. It is gone from
 * the per-item path as of 2026-08-23: an over-ceiling item reads the chapter digest, which is
 * assembled in code from a list the chapter model already wrote and loads nothing
 * (chapter-digest.ts). Supplying it here would assert a load the shipped run no longer makes.
 */
check('the shipped defaults stay inside the two-model budget, chapters included', () => {
  const p = plan('youtube-telltale', {
    hasChapters: true,
    alsoLoads: [{ model: routing.CHAPTER_PIPELINE_MODELS.generation, what: 'chapters' }],
  });
  if (p.roster.models.length > 2) throw new Error('the shipped run loads ' + p.roster.summary);
  eq(p.roster.overBudget, false, 'the shipped defaults are over their own budget');
  eq(p.warnings.length, 0, 'the shipped defaults declared a warning: ' + p.warnings.join('; '));
  if (!p.roster.byModel['qwen3.8:27b'].includes('chapters')) {
    throw new Error('the chapter pipeline is not counted against the budget it spends');
  }
});

check('the embedding model does not count against the budget', () => {
  const roster = tasks.buildModelRoster([
    { model: 'qwen3.8:27b', what: 'titles' },
    { model: 'nomic-embed-text', what: 'key phrases' },
  ], [routing.KEY_PHRASE_EMBEDDING_MODEL]);
  eq(roster.models.length, 1, '274MB of embeddings was counted as a resident LLM');
});

check('a third model is a DECLARED warning naming the fields, and never a refusal', () => {
  // The operator's own routing choice: the description on the 4b and the pinned comment on the
  // 9B, while the other three packaging fields stay on the 27B. Three models, all chosen
  // deliberately, none of them a mistake — which is exactly why this warns instead of refusing.
  const p = plan('youtube-telltale', {
    hasChapters: true,
    routing: { description: 'qwen35-4b', pinned_comment: 'qwen35-9b' },
    alsoLoads: [{ model: routing.CHAPTER_PIPELINE_MODELS.generation, what: 'chapters' }],
  });
  eq(p.roster.models.length, 3, 'expected three models, got ' + p.roster.summary);
  eq(p.roster.overBudget, true, 'three models did not register as over budget');
  eq(p.warnings.length, 1, 'the run did not declare exactly one warning');
  if (!/qwen3\.5:4b \(description\)/.test(p.warnings[0])) {
    throw new Error('the warning does not name the field responsible:\n' + p.warnings[0]);
  }
  // Not blocked: the plan still runs, with every field it was asked for.
  if (p.units.length === 0) throw new Error('the run was blocked instead of warned');
});

/**
 * THE RAW TRANSCRIPT. The local path used to condense EVERY transcript, which meant every
 * locally generated title was written from a précis of the video rather than the video.
 */
check('a local transcript passes through raw right up to the ceiling', () => {
  eq(aiManager.directPassesRaw({ chars: 89000, ceiling: 'local' }), true, '89k should reach the model raw');
  eq(aiManager.directPassesRaw({ chars: 91000, ceiling: 'local' }), false, '91k does not fit and must condense');
  eq(aiManager.DIRECT_PASS_MAX_CHARS.local, 90000, 'the local ceiling moved');
});

check('compilation still condenses whatever the length', () => {
  eq(aiManager.directPassesRaw({ chars: 1000, ceiling: 'local', forceCondense: true }), false,
    'forceCondense is the compilation contract and it is not size-dependent');
  eq(aiManager.directPassesRaw({ chars: 1000, ceiling: 'cloud', forceCondense: true }), false,
    'and it is not transport-dependent either');
});

/**
 * The cloud ceiling moved 60k -> 400k on 2026-08-23 (d173f66) and these two checks were left
 * asserting the old number, so they went red the moment the change landed. Restated against the
 * number this commit ships: 400k is ~110k tokens into a 1M-token window, which is the whole
 * point — on a cloud-routed run essentially nothing is over the ceiling any more.
 */
check('the cloud ceiling is the raised one', () => {
  eq(aiManager.DIRECT_PASS_MAX_CHARS.cloud, 400000, 'the cloud ceiling moved');
  eq(aiManager.directPassesRaw({ chars: 399000, ceiling: 'cloud' }), true, 'under the cloud ceiling');
  eq(aiManager.directPassesRaw({ chars: 401000, ceiling: 'cloud' }), false, 'over the cloud ceiling');
});

/**
 * THE CEILING FOLLOWS THE ROUTING, NOT THE SETTINGS PROVIDER. The 2026-08-22 live run
 * that motivated this: an all-local roster under a cloud Settings provider condensed a
 * 62k transcript that fit the local window raw.
 */
check('an all-local routing earns the local ceiling whatever the Settings provider says', () => {
  const routed = routing.resolveMetadataRouting({});
  const allLocal = Object.entries(routed)
    .every(([taskId, optionId]) => routing.routingOption(taskId, optionId).kind === 'local');
  eq(allLocal, true, 'the shipped defaults are the all-local roster');
  eq(aiManager.directPassesRaw({ chars: 62299, ceiling: allLocal ? 'local' : 'cloud' }), true,
    'the podcast 1.mov transcript reaches the model raw');
});

check('one cloud field lifts the whole run to the cloud ceiling', () => {
  const routed = routing.resolveMetadataRouting({ titles: 'sonnet5' });
  const allLocal = Object.entries(routed)
    .every(([taskId, optionId]) => routing.routingOption(taskId, optionId).kind === 'local');
  eq(allLocal, false, 'sonnet5 titles make the run partly cloud');
  // The direction reversed with the 400k raise: routing one field to the cloud used to DROP the
  // run to a 60k cost guard, and now lifts it to a 400k window. Same rule, opposite consequence.
  eq(aiManager.directPassesRaw({ chars: 62299, ceiling: allLocal ? 'local' : 'cloud' }), true,
    '62k is well under the cloud ceiling');
  eq(aiManager.directPassesRaw({ chars: 62299, ceiling: 'local' }), true,
    'and it fits the local window too, which is why the podcast run reads it raw either way');
});

check('a podcast plans no thumbnail unit at all', () => {
  const p = plan('podcast-spreaker', { hasChapters: true });
  const written = new Set();
  for (const unit of p.units) for (const f of unit.fields) written.add(f);
  if (written.has('thumbnail_text')) throw new Error('the podcast was routed a thumbnail');
  eq(p.assembleHashtags, false, 'and it renders no hashtags either');
});

/**
 * A field the CHANNEL publishes that no routing selection owns. Shorts is the only one, and
 * `spoken_keywords` is the only field: it used to ride inside whichever group absorbed unclaimed
 * sections, and under one call per field it gets its own call on the titles model.
 */
check('an unrouted published field gets its own call rather than riding in someone else\'s', () => {
  const p = plan('youtube-shorts', { hasChapters: true });
  const spoken = p.units.filter((u) => u.fields.includes('spoken_keywords'));
  eq(spoken.length, 1, 'spoken_keywords is written by ' + spoken.length + ' calls');
  eq(spoken[0].fields.length, 1, 'it was absorbed into another call instead of getting its own');
  const titles = p.units.find((u) => u.fields.includes('titles'));
  if (!spoken[0].label.includes(titles.label.replace(/^titles /, ''))) {
    throw new Error('it did not land on the titles model: ' + spoken[0].label + ' vs ' + titles.label);
  }
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


// ---------------------------------------------------------------- chapters
/**
 * THE CHAPTER QUOTE MAPPER. The model never emits a timestamp: it quotes the sentence each
 * chapter opens on, and this code measures that quote against the caption word stream. Every
 * failure mode here is invisible in the output — a chapter list built from a mis-measured quote
 * reads exactly like one built from a good one, and the only symptom is a viewer clicking a
 * marker and landing in the middle of the previous subject.
 *
 * The rule being asserted is the CURSOR: each quote is searched only in the cues after the one
 * that placed the previous chapter. It is what stops a sentence the speaker says twice from
 * pulling a late chapter back to minute two, and what makes "this quote is not in the
 * transcript" a droppable fact rather than a confident wrong number.
 */
const cue = (startSec, text) => {
  const stamp = (s) => {
    const h = String(Math.floor(s / 3600)).padStart(2, '0');
    const m = String(Math.floor((s % 3600) / 60)).padStart(2, '0');
    const sec = String(Math.floor(s % 60)).padStart(2, '0');
    return `${h}:${m}:${sec},000`;
  };
  return { start: stamp(startSec), end: stamp(startSec + 4), text };
};

const CHAPTER_CUES = chapters.buildCues([
  cue(0, 'Welcome back to the show everybody, it is good to see you all again.'),
  cue(5, 'Today we are going to look at three separate clips about the same claim.'),
  cue(120, 'Anyway, let us talk about the eggs and what happened to them.'),
  cue(125, 'The article says her eggs were stolen from the incubator overnight.'),
  cue(300, 'Welcome back to the show everybody, it is good to see you all again.'),
  cue(305, 'That was the second clip, and here is what the pastor said about it.'),
]);

check('a chapter quote measures to the second the sentence was said', () => {
  const mapped = chapters.mapChapterQuotes(
    [{ label: 'the eggs article', quote: 'Anyway, let us talk about the eggs and what happened to them.' }],
    CHAPTER_CUES,
  );
  eq(mapped.length, 1);
  eq(mapped[0].status, 'mapped');
  eq(mapped[0].time, 120, 'the quote did not measure to its own cue');
});

check('a sentence the speaker says twice resolves FORWARD, never back', () => {
  // "Welcome back to the show everybody" is at 0s and again at 300s. Claimed as the opening of
  // the chapter AFTER the one at 120s, it can only mean the second one.
  const mapped = chapters.mapChapterQuotes(
    [
      { label: 'the eggs article', quote: 'Anyway, let us talk about the eggs and what happened to them.' },
      { label: 'the second clip', quote: 'Welcome back to the show everybody, it is good to see you all again.' },
    ],
    CHAPTER_CUES,
  );
  eq(mapped.map((m) => m.status), ['mapped', 'mapped']);
  eq(mapped[1].time, 300, 'a repeated sentence was measured against the wrong occurrence');
  if (!(mapped[1].time > mapped[0].time)) throw new Error('the chapters came back out of order');
});

check('a quote that is only BEHIND the cursor is dropped as out-of-order, with its real time named', () => {
  const mapped = chapters.mapChapterQuotes(
    [
      { label: 'the second clip', quote: 'That was the second clip, and here is what the pastor said about it.' },
      { label: 'the eggs article', quote: 'Anyway, let us talk about the eggs and what happened to them.' },
    ],
    CHAPTER_CUES,
  );
  eq(mapped[1].status, 'out-of-order');
  eq(mapped[1].time, null, 'an out-of-order quote was given a time anyway');
  eq(mapped[1].wholeVideoTime, 120, 'the warning cannot say where the sentence actually is');
});

check('a quote that is nowhere in the transcript is unmapped, and nothing is interpolated', () => {
  const mapped = chapters.mapChapterQuotes(
    [{ label: 'invented', quote: 'The submarine fleet departed Reykjavik long before dawn on Tuesday.' }],
    CHAPTER_CUES,
  );
  eq(mapped[0].status, 'unmapped');
  eq(mapped[0].time, null);
  eq(mapped[0].wholeVideoTime, null, 'a sentence that is not in the video was located anyway');
});

/**
 * THE CADENCE BAND. Code states the runtime and names the rung; the model applies the rate and
 * decides the count. These assert the two inputs it is given, not the answer it gives back.
 */
check('the runtime is stated in the words the band language uses', () => {
  eq(chapters.runtimePhrase(0), '0 minutes');
  eq(chapters.runtimePhrase(564.8), '9 minutes', 'seconds were not rounded to whole minutes');
  eq(chapters.runtimePhrase(3600), '1 hour');
  eq(chapters.runtimePhrase(4332.76), '1 hour 12 minutes');
  eq(chapters.runtimePhrase(2 * 3600 + 30 * 60), '2 hours 30 minutes');
});

check('the cadence rung is the one the prompt body states for that runtime', () => {
  eq(chapters.cadenceBandFor(9 * 60 + 59), 'under-10-minutes');
  eq(chapters.cadenceBandFor(10 * 60), '10-to-30-minutes');
  eq(chapters.cadenceBandFor(29 * 60 + 59), '10-to-30-minutes');
  eq(chapters.cadenceBandFor(30 * 60), '30-minutes-and-longer');
  eq(chapters.cadenceBandFor(4 * 3600), '30-minutes-and-longer');
});

check('all three chapter grains ship, each with the band and quote contract (LEDGER #170)', () => {
  // The stories grain keeps the graduated three-rung band (restoration-v2 measurement);
  // detailed and broad carry their own single band lines, validated 2026-08-24 night.
  const stories = assets.pipeline('chapters.yml', 'whole_transcript_stories');
  for (const rung of ['under 10 minutes:', '10 to 30 minutes:', '30 minutes and longer:']) {
    if (!stories.includes(rung)) throw new Error(`the stories grain has no "${rung}" rung`);
  }
  const bands = {
    detailed: 'usually has 5 to 10',
    // Broad moved to a graduated count table 2026-08-24 night: the rate phrasing measured
    // as ignored (25 chapters at 1:40 spacing on a 41-minute video); counts anchor.
    // Rebanded 2026-08-25 after a live 41-minute run returned 17 against a 10-to-14 band,
    // then again the same night on the operator's ask for more aggressive merging: the
    // band is stated as a budget with a lower-half bias, and the model's habit of landing
    // at ceiling-plus-ads is priced into where the ceiling sits.
    broad: 'usually 7 to 10, each covering 4 to 6 minutes',
  };
  for (const [grain, band] of Object.entries(bands)) {
    const body = assets.pipeline('chapters.yml', `whole_transcript_${grain}`);
    if (!body.includes(band)) throw new Error(`the ${grain} grain lost its band ("${band}")`);
  }
  for (const grain of ['detailed', 'broad', 'stories']) {
    const body = assets.pipeline('chapters.yml', `whole_transcript_${grain}`);
    for (const ph of ['{duration}', '{transcript}', '{promoted_items}']) {
      if (!body.includes(ph)) throw new Error(`the ${grain} grain lost its ${ph} placeholder`);
    }
    // The answer is PLAIN LINES since 2026-08-24 (no-JSON ruling): one verbatim opening
    // sentence per line is the whole contract, so every grain must demand the exact copy
    // the quote mapper measures, keep the ad exception, and never ask for JSON.
    if (!body.includes('FIRST sentence') || !body.includes('EXACTLY as it appears')) {
      throw new Error(`the ${grain} grain no longer asks for the verbatim sentence the time is measured from`);
    }
    if (!body.includes('ONE copied sentence per line')) {
      throw new Error(`the ${grain} grain no longer states the one-sentence-per-line answer shape`);
    }
    if (!body.includes('its own chapter however short it runs')) {
      throw new Error(`the ${grain} grain lost the ad exception (the size band alone swallows ad chapters — measured)`);
    }
    if (body.includes('"first_sentence"') || body.includes('"label"')) {
      throw new Error(`the ${grain} grain still asks for the deleted JSON chapter shape`);
    }
  }
  for (const gone of ['place_boundary', 'whole_transcript_chapters']) {
    let threw = false;
    try { assets.pipeline('chapters.yml', gone); } catch { threw = true; }
    if (!threw) throw new Error(`the deleted "${gone}" prompt is still shipping`);
  }
});

// ------------------------------------------------------- which set of a video publishes
//
// A video can have several generated metadata sets — a re-run, a softening pass — joined by
// source_key, and exactly ONE of them is the one the calendar draws, the push sends and the
// extension fills. Which one that is, for every source that predates the feature, is decided
// by a rule reading records the app did not write: precisely the class of decision this file
// exists to assert. The wrong answer here does not look wrong — a chip simply stops being
// drawn, and the operator finds out by missing an upload.
const primary = require(path.join(ROOT, 'services/publish/primary-migration.js'));

/** A selection record with only the fields the rule reads. Everything else is its default. */
function rec(fields) {
  return {
    chosenTitles: [], titleEdits: {}, chapterEdits: {}, chapterDrops: [],
    descriptionOverride: null, linksOverride: null, tagsOverride: null,
    publishAt: null, videoId: null, filledAt: null, pushedAt: null, uploadReceipt: null,
    spreakerEpisodeId: null, spreakerPushedAt: null, isPodcast: false,
    ...fields,
  };
}
/** Newest first, exactly as the index hands them over. */
const cands = (...pairs) => pairs.map(([itemId, createdAt]) => ({ itemId, createdAt }));
function decide(candidates, byItem) {
  return primary.decidePrimary('a source', candidates, (id) =>
    primary.publishProgressOf(byItem[id] === undefined ? null : byItem[id])
  );
}

check('the LINKED set wins over a newer one that was only ever generated', () => {
  // The live shape of six of the seventeen multi-set sources on the operator's machine:
  // the YouTube link sits on an OLDER sibling than the newest run. "Newest wins" would have
  // taken every one of them off the calendar and out of the extension's reach.
  const d = decide(cands(['itm-new-aaaaaaaa', '2026-08-24T00:00:00Z'], ['itm-old-bbbbbbbb', '2026-08-11T00:00:00Z']), {
    'itm-old-bbbbbbbb': rec({ videoId: 'Z2ItN8vWbGo', filledAt: '2026-08-13T01:30:22.860Z' }),
  });
  eq(d.itemId, 'itm-old-bbbbbbbb', 'the linked set must stay the one that publishes:');
  eq(d.tiedWith, [], 'a clear winner ties with nobody:');
});

check('a SCHEDULED set outranks a newer softened one that nobody has acted on', () => {
  // The live softening case exactly: the softened set is the newest row, the original holds
  // the calendar date. Promoting the newcomer would have silently dropped the schedule.
  const d = decide(cands(['itm-soft-aaaaaaa', '2026-08-25T22:39:04.865Z'], ['itm-orig-bbbbbbb', '2026-08-25T19:53:28.209Z']), {
    'itm-soft-aaaaaaa': rec({}),
    'itm-orig-bbbbbbb': rec({ chosenTitles: ['a', 'b', 'c'], publishAt: '2026-08-30T13:00:00-04:00' }),
  });
  eq(d.itemId, 'itm-orig-bbbbbbb', 'the scheduled set must keep its date:');
});

check('the pipeline order is strict: pushed > linked > scheduled > titles > edits > nothing', () => {
  const ranks = [
    [rec({ pushedAt: '2026-08-01T00:00:00Z' }), 5],
    [rec({ uploadReceipt: { videoId: 'x' } }), 5],
    [rec({ videoId: 'abc' }), 4],
    [rec({ filledAt: '2026-08-01T00:00:00Z' }), 4],
    [rec({ publishAt: '2026-08-30T13:00:00-04:00' }), 3],
    [rec({ chosenTitles: ['one'] }), 2],
    [rec({ descriptionOverride: 'edited' }), 1],
    [rec({ isPodcast: true }), 1],
    [rec({}), 0],
    [null, 0],
  ];
  for (const [record, rank] of ranks) {
    eq(primary.publishProgressOf(record).rank, rank, `progress of ${JSON.stringify(record && Object.keys(record).filter((k) => record[k] && k !== 'chosenTitles' && k !== 'titleEdits'))}:`);
  }
  // Both of these are written by the AUTOMATIC pass on the first save of every record, so
  // every sibling of every source carries them. Reading either as evidence would rank the
  // whole group level and hand the decision to the date.
  eq(primary.publishProgressOf(rec({ channelId: 'UCgIi12E', thumbnailPath: '/x.png' })).rank, 0,
    'a channel and a thumbnail are auto-filled and distinguish nothing:');
});

check('sets level at the front are broken by DATE, and the losers are named', () => {
  const d = decide(cands(['itm-newer-aaaaaa', '2026-08-23T01:11:15.101Z'], ['itm-older-bbbbbb', '2026-08-19T19:49:48.357Z']), {
    'itm-newer-aaaaaa': rec({ chosenTitles: ['a', 'b', 'c'] }),
    'itm-older-bbbbbb': rec({ chosenTitles: ['a', 'b', 'c'] }),
  });
  eq(d.itemId, 'itm-newer-aaaaaa', 'the newer of two equals:');
  eq(d.tiedWith, ['itm-older-bbbbbb'], 'a tie is REPORTED, never quietly resolved:');
});

check('when nothing has been acted on, the newest wins — which is the row the list headed', () => {
  const d = decide(cands(['itm-c-cccccccc', '2026-08-24T20:11:46.627Z'], ['itm-b-bbbbbbbb', '2026-08-23T19:55:28.909Z'], ['itm-a-aaaaaaaa', '2026-08-23T02:54:47.545Z']), {});
  eq(d.itemId, 'itm-c-cccccccc', 'the newest of three untouched sets:');
});

check('the order the index happens to be in cannot change the answer', () => {
  const byItem = {
    'itm-old-bbbbbbbb': rec({ videoId: 'Z2ItN8vWbGo' }),
    'itm-new-aaaaaaaa': rec({ chosenTitles: ['a'] }),
  };
  const forwards = decide(cands(['itm-new-aaaaaaaa', '2026-08-24T00:00:00Z'], ['itm-old-bbbbbbbb', '2026-08-11T00:00:00Z']), byItem);
  const backwards = decide(cands(['itm-old-bbbbbbbb', '2026-08-11T00:00:00Z'], ['itm-new-aaaaaaaa', '2026-08-24T00:00:00Z']), byItem);
  eq(forwards.itemId, backwards.itemId, 'a readdir order must not decide what publishes:');
});

check('a source with no sets THROWS rather than answering', () => {
  let threw = false;
  try { decide([], {}); } catch { threw = true; }
  if (!threw) throw new Error('decidePrimary answered for a source with no items');
});

console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
process.exit(failures === 0 ? 0 : 1);
