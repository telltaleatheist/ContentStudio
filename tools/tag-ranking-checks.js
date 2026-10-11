#!/usr/bin/env node
/**
 * Tag ranking (LEDGER #296): the pools reranked against the title and summary, below-threshold
 * candidates dropped, near-duplicates folded by embedding. Pure: a fake rerank and embed.
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
require(path.join(ROOT, 'services/metadata/prompt-assets.js')).initPromptAssets(path.join(__dirname, '..', 'electron', 'assets', 'prompts'));
const R = require(path.join(ROOT, 'services/metadata/tag-ranking.js'));

let failures = 0;
const pending = [];
function check(name, fn) {
  pending.push((async () => {
    try { await fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name} :: ${e.message}`); }
  })());
}
function eq(a, e, what) { if (JSON.stringify(a) !== JSON.stringify(e)) throw new Error(`${what} expected ${JSON.stringify(e)}, got ${JSON.stringify(a)}`); }

const SUMMARY = { stretchSeconds: 300, model: 'qwen3.5-9b', speakerTagged: false, paragraphs: [
  { start: 0, text: 'Eric Metaxas claims the German Church failed to stand against Hitler. The host cites the Deutsche Christen.' },
  { start: 300, text: 'Metaxas calls Dietrich Bonhoeffer a prophet; the host says Bonhoeffer never claimed it.' },
] };
const CONTENT = 'Eric Metaxas wrote it. The German Church and Hitler. Deutsche Christen. Dietrich Bonhoeffer was no prophet. Romans. stand against. christian nationalism and christian nationalist.';

function fakeAi(scores, vectors) {
  const calls = [];
  return {
    calls,
    rerank: async (model, query, documents, instruction, what) => {
      calls.push({ kind: 'rerank', model, query, documents, instruction });
      return { scores: documents.map((d) => scores[d] ?? 0.1), model, instruction, server: 'mac', ms: 12 };
    },
    embed: async (model, inputs, inputType, what) => {
      calls.push({ kind: 'embed', model, inputs, inputType });
      return { vectors: inputs.map((t) => vectors[t] ?? [1, 0, 0]), model, fingerprint: 'fp', server: 'mac', ms: 5 };
    },
  };
}

check('the fixed roles: the 8B reranker and embedder, named once', () => {
  eq([R.TAG_RERANK_MODEL, R.TAG_EMBED_MODEL], ['qwen3-reranker-8b', 'qwen3-embedding-8b'], 'models:');
});

check('candidates are reranked against the title and summary, dropped below the bar, and come out most relevant first', async () => {
  const ai = fakeAi(
    { 'Eric Metaxas': 0.98, 'Dietrich Bonhoeffer': 0.95, 'Deutsche Christen': 0.7, Romans: 0.2, 'stand against': 0.1, 'christian nationalism': 0.6 },
    { 'Eric Metaxas': [1, 0, 0], 'Dietrich Bonhoeffer': [0, 1, 0], 'Deutsche Christen': [0, 0, 1], 'christian nationalism': [0.7, 0.7, 0] },
  );
  const out = await R.rankTagPools({
    aiManager: ai, entities: ['Romans', 'Eric Metaxas', 'Dietrich Bonhoeffer'], phrases: ['stand against', 'christian nationalism'],
    title: 'metaxas rewrote bonhoeffer', summary: SUMMARY, contentText: CONTENT, sourceLabel: 'u4.mov',
  });
  const rr = ai.calls.find((c) => c.kind === 'rerank');
  if (!rr.query.startsWith('Title: metaxas rewrote bonhoeffer\n\n1. 0:00')) throw new Error('the query is not the title and the summary: ' + rr.query.slice(0, 80));
  if (!rr.documents.includes('Deutsche Christen')) throw new Error('the summary\'s own grounded names did not join the candidates');
  eq(out.entities.slice(0, 2), ['Eric Metaxas', 'Dietrich Bonhoeffer'], 'names, most relevant first:');
  if (out.entities.includes('Romans')) throw new Error('a name below the bar was kept');
  if (out.phrases.includes('stand against')) throw new Error('a phrase below the bar was kept');
  if (!out.phrases.includes('christian nationalism')) throw new Error('a relevant phrase was dropped');
  const em = ai.calls.find((c) => c.kind === 'embed');
  if (em.inputs.some((t) => t === 'Romans' || t === 'stand against')) throw new Error('below-bar candidates were embedded');
});

check('a near-duplicate folds into the better-ranked one', async () => {
  const ai = fakeAi(
    { 'christian nationalism': 0.9, 'christian nationalist': 0.8 },
    { 'christian nationalism': [1, 0, 0], 'christian nationalist': [0.99, 0.141, 0] },
  );
  const out = await R.rankTagPools({
    aiManager: ai, entities: [], phrases: ['christian nationalist', 'christian nationalism'],
    title: 't', summary: { ...SUMMARY, paragraphs: [{ start: 0, text: 'nothing named' }] }, contentText: CONTENT, sourceLabel: 'v.mov',
  });
  eq(out.phrases, ['christian nationalism'], 'the better-ranked twin stays:');
  eq(out.ranked.find((c) => c.text === 'christian nationalist').sameAs, 'christian nationalism', 'and the other names it:');
});

check('nothing grounded: no calls, nothing to rank', async () => {
  const ai = fakeAi({}, {});
  const out = await R.rankTagPools({ aiManager: ai, entities: [], phrases: [], title: 't', summary: { ...SUMMARY, paragraphs: [{ start: 0, text: 'x' }] }, contentText: 'x', sourceLabel: 'v' });
  eq([out.entities, out.phrases, ai.calls.length], [[], [], 0], 'empty:');
});

check('cosine', () => {
  eq(Math.round(R.cosine([1, 0], [0, 1]) * 100), 0, 'orthogonal:');
  eq(Math.round(R.cosine([1, 1], [2, 2]) * 100), 100, 'parallel:');
  let threw = false; try { R.cosine([1], [1, 2]); } catch { threw = true; }
  if (!threw) throw new Error('vectors of different lengths compared');
});

Promise.all(pending).then(() => {
  console.log('');
  console.log(failures === 0 ? 'ALL PASS' : `${failures} FAILED`);
  process.exit(failures === 0 ? 0 : 1);
});
