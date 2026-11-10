// Name matching of a final export to its editor story (editor-transcript-link.ts storyLabel).
// Owen 2026-11-10: "2 - locke (incogni)" linked to nothing because the sponsor tag is on the
// export's name only. Run after `npm run build:electron`.
const path = require('path');
const Module = require('module');
const STUB = path.join(__dirname, '_electron-stub.js');
const orig = Module._resolveFilename;
Module._resolveFilename = function (r, ...a) {
  if (r === 'electron-log' || r === 'electron') return require.resolve(STUB);
  return orig.call(this, r, ...a);
};
const L = require(path.join(__dirname, '..', 'dist', 'main', 'services/metadata/editor-transcript-link.js'));
const label = (v) => L.normalizeForMatch(L.storyLabel(v));

let failures = 0;
function check(name, fn) {
  try { fn(); console.log(`PASS  ${name}`); } catch (e) { failures++; console.log(`FAIL  ${name} :: ${e.message}`); }
}
function same(a, b) { if (label(a) !== label(b)) throw new Error(`${JSON.stringify(a)} -> ${JSON.stringify(label(a))}, ${JSON.stringify(b)} -> ${JSON.stringify(label(b))}`); }
function differ(a, b) { if (label(a) === label(b)) throw new Error(`${JSON.stringify(a)} and ${JSON.stringify(b)} both -> ${JSON.stringify(label(a))}`); }

check('a trailing sponsor tag is ignored: "2 - locke (incogni)" is the story "2 - locke"', () => {
  same('2 - locke (incogni)', '2 - locke');
  same('f5 - bill mitchell (incogni)', 'f5 - bill mitchell');
  same('5 - sewell (incogni)', 'sewell');
});
check('only a tag at the very END is dropped; brackets earlier in the title still count', () => {
  differ('(part 2) locke', 'locke');
  differ('locke (incogni) extra', 'locke extra');
});
check('titles without a tag are unchanged', () => {
  same('u1 - to train up a child | p1', 'to train up a child p1');
  differ('2 - locke', '2 - lock');
});

console.log(failures ? `${failures} FAILED` : 'all story-label checks passed');
process.exit(failures ? 1 : 0);
