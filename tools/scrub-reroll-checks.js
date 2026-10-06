/**
 * Offline checks for LEDGER #223: a scrub failure never discards the item, and the reports
 * page's per-section re-roll buttons.
 *
 * WHAT IT PROVES, against the COMPILED main process (run by `npm run check:pure`, after
 * `npm run build:electron`), with a stand-in for the model door and nothing live:
 *
 *   the scrub   — the incident (26 chapter titles, 27 lines back): chapters stay as generated,
 *                 the description is still cleaned up, the pass returns the item, and the item
 *                 records the failure in plain words; a field that cannot be planned is a
 *                 failed field, not a failed item; a cancel still stops the pass; a partial
 *                 re-run carries the other sections' warnings forward and a clean one clears.
 *   the re-roll — the prompt for a finished item is the run's own stored prompt (system turn
 *                 taken off), sent on the routed model; the answer replaces the section and the
 *                 previous version is kept; "put back" swaps and never loses a version; the
 *                 chapter chain is re-pointed at the new titles; tags and hashtags are rebuilt
 *                 from the new chapter list by the run's own assembly.
 *
 * No test framework, on purpose: one line per check, like the other check scripts.
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const ROOT = path.join(__dirname, '..', 'dist', 'main');
const promptAssetsModule = require(path.join(ROOT, 'services/metadata/prompt-assets.js'));
promptAssetsModule.initPromptAssets(path.join(__dirname, '..', 'electron', 'assets', 'prompts'));
const scrub = require(path.join(ROOT, 'services/metadata/scrub.js'));
const reroll = require(path.join(ROOT, 'services/metadata/section-reroll.js'));
const summarize = require(path.join(ROOT, 'services/metadata/chaptering/summarize.js'));
const tagsHashtags = require(path.join(ROOT, 'services/metadata/tags-hashtags.js'));
const identity = require(path.join(ROOT, 'services/metadata/item-identity.js'));
const cancellation = require(path.join(ROOT, 'services/metadata/cancellation.js'));
const { OutputHandlerService } = require(path.join(ROOT, 'services/metadata/output-handler.service.js'));

let failures = 0;
const tmpDirs = [];
function tmpOutputDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-223-'));
  tmpDirs.push(dir);
  return dir;
}
async function check(name, fn) {
  try {
    await fn();
    console.log('PASS  ' + name);
  } catch (e) {
    failures++;
    console.log('FAIL  ' + name + '\n      ' + (e && e.stack ? e.stack.split('\n').slice(0, 3).join('\n      ') : e));
  }
}
function eq(actual, expected, what) {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what || ''} expected ${b}, got ${a}`);
}
function ok(value, what) {
  if (!value) throw new Error(what || 'expected a true value');
}

const LINKS = 'Support: https://example.com/a\nMore: https://example.com/b';
const CLOUD = { kind: 'cloud', label: 'Opus', model: 'claude-cli:opus', crucibleId: null };

/** A stand-in AIManagerService: records every call and answers by what it was asked. */
function fakeManager(answer) {
  const calls = [];
  return {
    calls,
    promptTrace: [],
    descriptionLinks: () => LINKS,
    channelTags: () => ['Telltale'],
    async runPlainRequest(prompt, model, what, shape) {
      calls.push({ prompt, model, what, shape });
      this.promptTrace.push({ what, model, chars: prompt.length, at: 'now', prompt });
      return answer(prompt, what);
    },
  };
}

function incidentItem() {
  const chapters = Array.from({ length: 26 }, (_, i) => ({
    timestamp: `${i}:00`,
    endTimestamp: `${i + 1}:00`,
    title: `The speaker explains point ${i + 1}`,
    sequence: i,
  }));
  return {
    item_id: 'item-incident',
    _title: 'incident video',
    description_hook: 'The host takes apart the claim.',
    description: `The narrator says the claim is false and shows why.\n\n${LINKS}`,
    chapters,
    _prompt_trace: [],
  };
}

(async () => {
  // ------------------------------------------------------------------ the scrub (task 1)

  await check('the incident: 27 lines for 26 chapter titles leaves chapters as generated, cleans the description, returns the item, records the failure', async () => {
    const item = incidentItem();
    const before = item.chapters.map((c) => c.title);
    const ai = fakeManager((prompt, what) => {
      if (what.startsWith('scrub: chapter titles')) {
        return Array.from({ length: 27 }, (_, i) => `Point ${i + 1} explained`).join('\n');
      }
      if (what.startsWith('scrub: description hook')) return 'The claim falls apart.';
      return 'The claim is false, and here is why.';
    });
    const result = await scrub.scrubGeneratedItem(item, { option: CLOUD, transport: { aiManager: ai }, origin: 'post-generation' });
    eq(item.chapters.map((c) => c.title), before, 'chapters untouched:');
    eq(item.description, `The claim is false, and here is why.\n\n${LINKS}`, 'description cleaned, links kept:');
    eq(item.description_hook, 'The claim falls apart.', 'hook cleaned:');
    eq(result.failed.map((f) => [f.item_key, f.reason]), [['chapters', 'Chapter titles were not cleaned up: the model returned 27 lines for 26 titles.']], 'the failure:');
    eq(item.scrubbed.failed.length, 1, 'recorded on the item:');
    ok(/Sent:\n  1\. The speaker explains point 1/.test(item.scrubbed.failed[0].detail) && /Returned:\n  1\. Point 1 explained/.test(item.scrubbed.failed[0].detail), 'the numbered Sent/Returned diagnostic is kept in the detail');
    eq(Object.keys(item.scrubbed.fields).sort(), ['description', 'description_hook'], 'only applied fields are in the receipt:');
    eq(result.changed.sort(), ['description', 'description_hook'], 'changed:');
    eq(item._prompt_trace.length, 3, 'every call sent is on the trace, the failed one included:');
  });

  await check('a field that cannot be planned is a failed field, not a failed item (a description with no link block at generation time)', async () => {
    const item = incidentItem();
    item.description = 'The narrator says the claim is false.';
    const ai = fakeManager((prompt, what) =>
      what.startsWith('scrub: chapter titles') ? Array.from({ length: 26 }, (_, i) => `Point ${i + 1}`).join('\n') : 'Clean.'
    );
    const result = await scrub.scrubGeneratedItem(item, { option: CLOUD, transport: { aiManager: ai }, origin: 'post-generation' });
    eq(item.description, 'The narrator says the claim is false.', 'description as generated:');
    eq(item.chapters[25].title, 'Point 26', 'chapters cleaned:');
    eq(result.failed.map((f) => f.item_key), ['description'], 'recorded:');
    ok(/^The description was not cleaned up: /.test(result.failed[0].reason), result.failed[0].reason);
  });

  await check('the plans go out together (LEDGER #270); answered last-first, the failures, the trace and the item keep plan order', async () => {
    const item = incidentItem();
    let flying = 0;
    let peak = 0;
    const order = ['scrub: description hook', 'scrub: description', 'scrub: chapter titles'];
    const ai = fakeManager(async (prompt, what) => {
      flying += 1;
      peak = Math.max(peak, flying);
      // The first plan answers last.
      const k = order.findIndex((o) => what.startsWith(o + ' ') || what.startsWith(o + ' ('));
      await new Promise((r) => setTimeout(r, 40 - 15 * k));
      flying -= 1;
      if (what.startsWith('scrub: chapter titles')) return Array.from({ length: 25 }, (_, i) => `Point ${i + 1}`).join('\n');
      if (what.startsWith('scrub: description hook')) return 'one\ntwo\nthree';
      return 'The claim is false, and here is why.';
    });
    const result = await scrub.scrubGeneratedItem(item, { option: CLOUD, transport: { aiManager: ai }, origin: 'post-generation' });
    eq(peak, 3, 'the three plans were in flight together:');
    eq(item._prompt_trace.map((t) => t.what.split(' for ')[0]), ['scrub: description hook (post-generation)', 'scrub: description (post-generation)', 'scrub: chapter titles (post-generation)'], 'the trace in plan order:');
    eq(result.failed.map((f) => f.item_key), ['description_hook', 'chapters'], 'the failures in plan order:');
    eq(item.description, `The claim is false, and here is why.\n\n${LINKS}`, 'the plan that answered applied:');
  });

  await check('a cancelled call still stops the pass', async () => {
    const item = incidentItem();
    const ai = fakeManager(() => {
      throw new cancellation.JobCancelledError('in the test');
    });
    let threw = null;
    try {
      await scrub.scrubGeneratedItem(item, { option: CLOUD, transport: { aiManager: ai }, origin: 'post-generation' });
    } catch (e) {
      threw = e;
    }
    ok(threw instanceof cancellation.JobCancelledError, 'expected the cancel to propagate');
  });

  await check('"clean up again" on one section sends only that section, and a clean run clears its warning while carrying the others', async () => {
    const tmp = tmpOutputDir();
    const handler = OutputHandlerService.forOutputDir(tmp);
    const itemId = identity.mintItemId();
    const item = { ...incidentItem(), item_id: itemId };
    item.scrubbed = {
      model: 'm', at: 't', fields: {}, skipped: [],
      failed: [
        { field: 'chapter titles', item_key: 'chapters', reason: 'Chapter titles were not cleaned up: x.', detail: 'x' },
        { field: 'description', item_key: 'description', reason: 'The description was not cleaned up: y.', detail: 'y' },
      ],
    };
    fs.writeFileSync(path.join(tmp, '.contentstudio', 'metadata', 'job-1.json'), JSON.stringify({ job_id: 'job-1', items: [item] }));
    const working = structuredClone(item);
    working._prompt_trace = [];
    const ai = fakeManager((prompt, what) => Array.from({ length: 26 }, (_, i) => `Point ${i + 1}`).join('\n'));
    await scrub.scrubGeneratedItem(working, { option: CLOUD, transport: { aiManager: ai }, origin: 'operator request', only: ['chapters'] });
    eq(ai.calls.map((c) => c.what.split(' for ')[0]), ['scrub: chapter titles (operator request)'], 'only the chapters call:');
    const receipt = await handler.applyScrubToItem('job-1', itemId, {
      record: working.scrubbed,
      trace: working._prompt_trace,
      chapterTitles: working.chapters.map((c) => c.title),
      only: ['chapters'],
    });
    eq(receipt.failed.map((f) => f.item_key), ['description'], 'the description warning is carried, the chapters one cleared:');
    const onDisk = handler.getJobMetadata('job-1').items[0];
    eq([onDisk.chapters[0].title, onDisk.scrubbed.failed.length, onDisk.scrubbed_earlier.length], ['Point 1', 1, 1], 'on disk:');
  });

  // ------------------------------------------------------------------ the re-roll (task 2)

  const SYSTEM = 'PLAIN SYSTEM TURN';

  await check('a finished item\'s re-roll prompt is the run\'s own stored prompt: last entry wins, the system turn is taken off, re-roll entries are not briefs', async () => {
    const item = {
      _prompt_trace: [
        { what: 'the thumbnail_text call for vid', model: 'old-model', prompt: 'FIRST BRIEF' },
        { what: 'the thumbnail_text call for vid', model: 'anthropic/claude-sonnet-5', prompt: `${SYSTEM}\n\nTHE BRIEF` },
        { what: 're-roll button: thumbnail text for vid (operator request)', model: 'x', prompt: 'NOT A BRIEF' },
        { what: 'the description primary description for vid', model: 'claude-cli:opus', prompt: 'DESCRIPTION BRIEF' },
      ],
    };
    const thumb = reroll.findStoredFieldCall(item, 'thumbnail_text', SYSTEM);
    eq([thumb.prompt, thumb.systemTurnRemoved, thumb.sourceLabel], ['THE BRIEF', true, 'vid'], 'thumbnail:');
    eq(reroll.findStoredFieldCall(item, 'description', SYSTEM).prompt, 'DESCRIPTION BRIEF', 'description:');
    eq(reroll.findStoredFieldCall(item, 'pinned_comment', SYSTEM), null, 'no brief is null:');
  });

  await check('a field re-roll sends that prompt verbatim on the routed model, and the description keeps the item\'s link block', async () => {
    const ai = fakeManager(() => 'A new opening sentence that stands alone. Then the body continues with the details of the video.');
    const stored = { prompt: 'DESCRIPTION BRIEF', model: 'old', sourceLabel: 'vid', systemTurnRemoved: false };
    const routed = { kind: 'local', label: '27B', model: 'qwen3.8-27b-4bit', crucibleId: 'qwen3.8-27b-4bit' };
    const { next } = await reroll.rerollFieldText('description', stored, routed, ai, { linkSuffix: `\n\n${LINKS}`, expectedCount: null });
    eq([ai.calls[0].prompt, ai.calls[0].model, ai.calls[0].shape.thinking, ai.calls[0].shape.maxTokens], ['DESCRIPTION BRIEF', 'qwen3.8-27b-4bit', false, 2048], 'the call:');
    eq(next, { description: `Then the body continues with the details of the video.\n\n${LINKS}`, description_hook: 'A new opening sentence that stands alone.' }, 'the version:');
    const lines = reroll.readFieldRerollAnswer('pinned_comment', 'one\ntwo', 'w', 'm', { linkSuffix: '', expectedCount: 3 });
    eq([lines.next, lines.notes.length], [['one', 'two'], 1], 'a short list is kept whole, with a note:');
  });

  await check('applying a re-roll keeps the previous version; put back swaps and never loses one', async () => {
    const item = { thumbnail_text: ['OLD ONE', 'OLD TWO'] };
    reroll.recordReplacement(item, 'thumbnail_text', ['NEW ONE'], { at: 't1', kind: 're-roll', model: 'm', notes: [] });
    eq(item.thumbnail_text, ['NEW ONE'], 'replaced:');
    eq(item.reroll_history.thumbnail_text.map((e) => e.previous), [['OLD ONE', 'OLD TWO']], 'kept:');
    reroll.putBackPrevious(item, 'thumbnail_text', 't2');
    eq([item.thumbnail_text, item.reroll_history.thumbnail_text.map((e) => e.previous)], [['OLD ONE', 'OLD TWO'], [['NEW ONE']]], 'put back swaps:');
    reroll.putBackPrevious(item, 'thumbnail_text', 't3');
    eq(item.thumbnail_text, ['NEW ONE'], 'twice returns:');
  });

  await check('the write refuses a section that moved while the re-roll was out, and writes nothing', async () => {
    const tmp = tmpOutputDir();
    const handler = OutputHandlerService.forOutputDir(tmp);
    const itemId = identity.mintItemId();
    const file = path.join(tmp, '.contentstudio', 'metadata', 'job-2.json');
    fs.writeFileSync(file, JSON.stringify({ job_id: 'job-2', items: [{ item_id: itemId, pinned_comment: ['on disk'] }] }));
    const bytes = fs.readFileSync(file, 'utf-8');
    let threw = null;
    try {
      await handler.applyRerollToItem('job-2', itemId, { field: 'pinned_comment', expected: ['read earlier'], next: ['new'], model: 'm', at: 't', notes: [], trace: [] });
    } catch (e) {
      threw = e;
    }
    ok(threw && /changed while the re-roll was out/.test(threw.message), threw && threw.message);
    eq(fs.readFileSync(file, 'utf-8') === bytes, true, 'byte-identical:');
    const receipt = await handler.applyRerollToItem('job-2', itemId, { field: 'pinned_comment', expected: ['on disk'], next: ['new'], model: 'm', at: 't', notes: ['n'], trace: [{ what: 'w', model: 'm', chars: 1, at: 't', prompt: 'p' }] });
    const onDisk = handler.getJobMetadata('job-2').items[0];
    eq([onDisk.pinned_comment, onDisk.reroll_history.pinned_comment[0].previous, receipt.kept, onDisk._prompt_trace.length], [['new'], ['on disk'], 1, 1], 'written:');
  });

  // Chapters: three published chapters and one excluded plug between the first two.
  function chapterItem() {
    const context = (detail, titles) => summarize.contextLines('youtube-telltale', detail, titles);
    const prompt = (n, ctx) => `Title chapter ${n} of a video transcript.\nVideo: vid\n${ctx}Transcript:\nwords ${n}`;
    return {
      _title: 'vid',
      titles: ['A title about nothing'],
      chapters: [
        { timestamp: '0:00', endTimestamp: '4:00', title: 'Old one', detail: 'Old detail one', sequence: 0 },
        { timestamp: '4:30', endTimestamp: '9:00', title: 'Old three', detail: 'Old detail three', sequence: 2 },
        { timestamp: '9:00', endTimestamp: '12:00', title: 'Old four', detail: 'Old detail four', sequence: 3 },
      ],
      excludedChapters: [{ timestamp: '4:00', endTimestamp: '4:30', title: 'Patreon plug', detail: 'A plug', isPromo: true }],
      tags: 'old tag',
      hashtags: '#Old',
      _prompt_trace: [
        { what: 'chapter 1/4 (0:00-4:00)', model: 'q', prompt: prompt(1, context('', [])) },
        { what: 'chapter 2/4 (4:00-4:30)', model: 'q', prompt: prompt(2, context('Old detail one', ['Old one'])) },
        { what: 'chapter 3/4 (4:30-9:00) part 1/2 (4:30-6:00)', model: 'q', prompt: 'A PART' },
        { what: 'chapter 3/4 (4:30-9:00) from its 2 parts', model: 'q', prompt: prompt(3, context('A plug', ['Old one', 'Patreon plug'])) },
        { what: 'chapter 4/4 (9:00-12:00)', model: 'q', prompt: prompt(4, context('Old detail three', ['Old one', 'Patreon plug', 'Old three'])) },
      ],
    };
  }

  await check('chapter re-roll: same boundaries, the plug is context and not re-titled, each prompt is re-pointed at the titles just written', async () => {
    const item = chapterItem();
    const calls = reroll.findStoredChapterCalls(item, SYSTEM);
    eq(calls.map((c) => [c.number, c.parts]), [[1, null], [2, null], [3, 2], [4, null]], 'the recorded calls (a part is not one):');
    const { steps } = reroll.planChapterReroll(item, calls);
    eq(steps.map((s) => s.publishedIndex), [0, null, 1, 2], 'matched by time:');
    let n = 0;
    const ai = fakeManager(() => {
      n++;
      return `New title ${n}\nNew summary ${n}.`;
    });
    const result = await reroll.rerollChapterTitles(item, steps, CLOUD, ai, { sourceLabel: 'vid', thinking: true });
    eq([result.titles, result.rerolled, ai.calls.length], [['New title 1', 'New title 2', 'New title 3'], 3, 3], 'the titles:');
    ok(ai.calls[1].prompt.includes('Previous chapter: "A plug"') && ai.calls[1].prompt.includes('"New title 1", "Patreon plug"'), 'chapter 3 reads the plug and the NEW chapter 1:\n' + ai.calls[1].prompt);
    ok(ai.calls[2].prompt.includes('Previous chapter: "New summary 2."') && !ai.calls[2].prompt.includes('Old three'), 'chapter 4 reads the new chapter 3:\n' + ai.calls[2].prompt);
    eq(ai.calls.every((c) => c.shape.thinking === true && c.model === CLOUD.model), true, 'on the routed chapters model, thinking on:');
  });

  await check('chapter re-roll: an unreadable chapter keeps its title and is named; nothing usable writes nothing', async () => {
    const item = chapterItem();
    const { steps } = reroll.planChapterReroll(item, reroll.findStoredChapterCalls(item, SYSTEM));
    const partial = await reroll.rerollChapterTitles(item, steps, CLOUD, fakeManager((p) => (p.includes('chapter 3') ? '' : 'Fresh\nFresh summary.')), { sourceLabel: 'vid', thinking: true });
    eq(partial.titles, ['Fresh', 'Old three', 'Fresh'], 'kept:');
    ok(partial.notes.some((note) => /Chapter at 4:30-9:00 kept its title/.test(note)), partial.notes.join(' | '));
    let threw = null;
    try {
      await reroll.rerollChapterTitles(item, steps, CLOUD, fakeManager(() => ''), { sourceLabel: 'vid', thinking: true });
    } catch (e) {
      threw = e;
    }
    ok(threw && /nothing was changed/.test(threw.message), threw && threw.message);
  });

  await check('a report with no recorded chapter prompts is refused in plain words', async () => {
    let threw = null;
    try {
      reroll.planChapterReroll({ chapters: [{ timestamp: '0:00', endTimestamp: '1:00', title: 'x' }] }, []);
    } catch (e) {
      threw = e;
    }
    ok(threw && /Regenerate the item/.test(threw.message), threw && threw.message);
  });

  await check('after a chapter re-roll the tags and hashtags are rebuilt from the NEW chapter list, by the run\'s own assembly', async () => {
    const contentText = 'HOST: Gene Bailey said the prosperity gospel is true. CLIP: Kenneth Copeland agreed about the prosperity gospel.';
    const item = {
      _title: 'vid',
      titles: ['A title about nothing'],
      chapters: [{ timestamp: '0:00', endTimestamp: '1:00', title: 'Old words nobody said', detail: '' }],
    };
    const before = reroll.rederiveTagFields(item, contentText, ['tags', 'hashtags'], 'Telltale');
    reroll.applySnapshot(item, 'chapters', { titles: ['Gene Bailey and the prosperity gospel'], details: ['Kenneth Copeland agrees.'], tags: before.tags ?? null, hashtags: before.hashtags ?? null });
    const after = reroll.rederiveTagFields(item, contentText, ['tags', 'hashtags'], 'Telltale');
    ok(!/gene bailey/i.test(before.tags || ''), 'the old list has no Gene Bailey: ' + before.tags);
    ok(/gene bailey/i.test(after.tags) && /Kenneth Copeland/.test(after.tags), 'the new list carries the new names: ' + after.tags);
    const pools = tagsHashtags.chapterPools({
      subjects: ['Gene Bailey and the prosperity gospel'],
      details: ['Kenneth Copeland agrees.'],
      contentText: 'Gene Bailey said the prosperity gospel is true. Kenneth Copeland agreed about the prosperity gospel.',
      entityLimit: tagsHashtags.ENTITY_POOL_SIZE,
      phraseLimit: tagsHashtags.PHRASE_POOL_SIZE,
    });
    const run = tagsHashtags.codeOwnedTagFields({ ...pools, contentText: 'Gene Bailey said the prosperity gospel is true. Kenneth Copeland agreed about the prosperity gospel.', firstTitle: 'A title about nothing', videoTitle: 'vid', brandTag: 'Telltale', assembleTags: true, assembleHashtags: true });
    eq(after, { tags: run.tags, hashtags: run.hashtags }, 'identical to the run\'s assembly over the same list:');
    eq(reroll.rederiveTagFields(item, contentText, ['titles'], 'Telltale'), {}, 'a channel that publishes neither gets neither:');
  });

  for (const dir of tmpDirs) fs.rmSync(dir, { recursive: true, force: true });
  console.log(failures === 0 ? '\nALL PASS' : `\n${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
})();
