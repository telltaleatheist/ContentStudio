#!/usr/bin/env node
// Checks for the stray-um rule (frontend/src/app/components/editor/model/stray-fillers.ts,
// LEDGER #238). The module is pure, so it is transpiled and loaded here directly.
'use strict';
const fs = require('fs');
const path = require('path');
const ts = require('typescript');

const file = path.join(__dirname, '..', 'frontend/src/app/components/editor/model/stray-fillers.ts');
const js = ts.transpileModule(fs.readFileSync(file, 'utf8'), {
  compilerOptions: { module: ts.ModuleKind.CommonJS, target: ts.ScriptTarget.ES2020 },
}).outputText;
const mod = { exports: {} };
new Function('module', 'exports', js)(mod, mod.exports);
const { findStrayFillers, isFiller } = mod.exports;

let passed = 0, failed = 0;
function check(name, ok, detail) {
  if (ok) { passed++; console.log(`ok   ${name}`); }
  else { failed++; console.log(`FAIL ${name}${detail !== undefined ? ` — ${JSON.stringify(detail)}` : ''}`); }
}

// A mic track of pieces laid end to end on the timeline. `jump` true = the recording skips
// before this piece (a cut); false = it carries on from the previous piece (connected).
function track(pieces) {
  let t = 0, src = 0;
  return pieces.map(([dur, jump]) => {
    if (jump) src += 5;               // auto-editor removed 5 s of silence here
    const seg = { timelineStart: t, duration: dur, sourceStart: src };
    t += dur; src += dur;
    return seg;
  });
}
const w = (track, text, s, e) => ({ track, text, timelineStart: s, timelineEnd: e });
const never = [];   // no cuts of Owen's

// Pieces: [0,2) [2,3) [3,5)   — the middle one is cut on both sides.
const three = track([[2, false], [1, true], [2, true]]);
const talk = [w('t0', 'hello', 0.2, 1.5), w('t0', 'again', 3.5, 4.5)];

let r = findStrayFillers(three, 't0', [...talk, w('t0', 'Um,', 2.2, 2.7)], never);
check('a lone "Um," in a piece cut on both sides is found, the whole piece', r.length === 1 && r[0].start === 2 && r[0].end === 3, r);

r = findStrayFillers(three, 't0', [...talk, w('t0', 'uh', 2.2, 2.7)], never);
check('"uh" counts too', r.length === 1, r);

r = findStrayFillers(three, 't0', [...talk, w('t0', 'um', 2.1, 2.4), w('t0', 'so', 2.5, 2.9)], never);
check('an um with another word in its piece is left', r.length === 0, r);

r = findStrayFillers(three, 't0', [...talk, w('t0', 'um', 2.1, 2.4), w('t1', 'breaking', 2.3, 2.9)], never);
check('an um with screen-audio speech under it is left', r.length === 0, r);

r = findStrayFillers(three, 't0', [...talk, w('t1', 'um', 2.2, 2.7)], never);
check('an um on another track (not this mic) is left', r.length === 0, r);

const joinedLeft = track([[2, false], [1, false], [2, true]]);
r = findStrayFillers(joinedLeft, 't0', [...talk, w('t0', 'um', 2.2, 2.7)], never);
check('an um whose piece carries on from the one before (no cut on the left) is left', r.length === 0, r);

const joinedRight = track([[2, false], [1, true], [2, false]]);
r = findStrayFillers(joinedRight, 't0', [...talk, w('t0', 'um', 2.2, 2.7)], never);
check('an um whose piece carries on into the next (no cut on the right) is left', r.length === 0, r);

r = findStrayFillers(track([[1, false], [2, true]]), 't0', [w('t0', 'um', 0.2, 0.6), w('t0', 'hi', 1.2, 1.5)], never);
check('the first piece of the timeline is left (nothing on its left to be a cut)', r.length === 0, r);

r = findStrayFillers(three, 't0', [...talk, w('t0', 'um', 1.9, 2.4)], never);
check('an um whose aligned time spills a little past the cut still belongs to its piece (aligner slop)', r.length === 1 && r[0].start === 2, r);

r = findStrayFillers(three, 't0', [...talk, w('t0', 'um', 2.2, 2.7)], [{ start: 2, end: 3 }]);
check('a piece already cut is not offered again', r.length === 0, r);

// After his edits (2026-09-30): one long piece [0,5) "period. um. yeah", his cuts take out
// "period." and "yeah": the um now plays alone, a cut on each side, and is found.
const one = track([[1, false], [5, true], [1, true]]);
const said = [w('t0', 'hi', 0.2, 0.8), w('t0', 'Period.', 1.2, 1.9), w('t0', 'Um.', 2.3, 2.7), w('t0', 'Yeah,', 3.1, 3.6), w('t0', 'bye', 6.2, 6.6)];
r = findStrayFillers(one, 't0', said, never);
check('an um inside a longer piece is not stray before his cuts', r.length === 0, r);
r = findStrayFillers(one, 't0', said, [{ start: 1, end: 2.1 }, { start: 2.9, end: 6 }]);
check('his cuts isolate it: found, just the part that plays', r.length === 1 && Math.abs(r[0].start - 2.1) < 1e-9 && Math.abs(r[0].end - 2.9) < 1e-9, r);
r = findStrayFillers(one, 't0', said, [{ start: 1, end: 1.88 }, { start: 2.9, end: 6 }]);
check('a sliver of the word before (20 ms of "Period.") left by a hand cut does not count as speech', r.length === 1, r);
r = findStrayFillers(one, 't0', said, [{ start: 1, end: 1.6 }, { start: 2.9, end: 6 }]);
check('a real part of the word before (0.3 s of "Period.") does', r.length === 0, r);

r = findStrayFillers(three, 't0', [...talk, w('t0', 'umbrella', 2.2, 2.7)], never);
check('"umbrella" is a word, not a filler', r.length === 0, r);

r = findStrayFillers(three, 't0', talk, never);
check('a piece with no words at all is not a filler (nothing is inferred)', r.length === 0, r);

check('isFiller: um, Um., umm, uh, Uhh, uhm', ['um', 'Um.', 'umm', 'uh', 'Uhh', 'uhm'].every(isFiller));
check('isFiller: not uh-huh, hmm, mm, u, a', !['uh-huh', 'hmm', 'mm', 'u', 'a'].some(isFiller));

// Unsorted input gives the same answer as sorted.
r = findStrayFillers([three[2], three[0], three[1]], 't0', [w('t0', 'um', 2.2, 2.7), ...talk.reverse()], never);
check('pieces and words in any order', r.length === 1 && r[0].start === 2, r);

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
