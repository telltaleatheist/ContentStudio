/**
 * THE WIRE IS ONE TYPE ON BOTH SIDES OF IPC (LEDGER Law 10).
 *
 * electron/crucible/wire.ts is what main sends; frontend/src/app/features/
 * crucible/crucible.types.ts is the renderer's copy, because the renderer is a
 * separate compilation unit and cannot import from electron/. Everything below
 * each file's opening comment must be the same bytes, so the contract cannot
 * drift into two prose descriptions of one message.
 *
 *   node tools/test-crucible-wire-mirror.js           check
 *   node tools/test-crucible-wire-mirror.js --write   copy wire.ts's body into the mirror
 *
 * The --write mode exists so the one legitimate edit (change wire.ts, then
 * mirror it) is one command; any other edit to the mirror fails the check.
 */
const fs = require('fs');
const path = require('path');
const { assert, check, run, REPO } = require('./_crucible-keeper');

const WIRE = path.join(REPO, 'electron', 'crucible', 'wire.ts');
const MIRROR = path.join(REPO, 'frontend', 'src', 'app', 'features', 'crucible', 'crucible.types.ts');

/** The file split after its first comment block: [header, body]. */
function split(file) {
  const text = fs.readFileSync(file, 'utf8');
  const end = text.indexOf('*/\n');
  if (!text.startsWith('/**') || end < 0) throw new Error(`${path.relative(REPO, file)} does not open with its header comment`);
  return [text.slice(0, end + 3), text.slice(end + 3)];
}

if (process.argv.includes('--write')) {
  const [, body] = split(WIRE);
  const [header] = split(MIRROR);
  fs.writeFileSync(MIRROR, header + body);
  console.log(`wrote ${path.relative(REPO, MIRROR)} from ${path.relative(REPO, WIRE)}`);
} else {
  check('crucible.types.ts is wire.ts below its header, byte for byte', () => {
    const [, wire] = split(WIRE);
    const [, mirror] = split(MIRROR);
    assert.ok(wire === mirror, 'the mirror has drifted: change wire.ts, then run `node tools/test-crucible-wire-mirror.js --write`');
  });

  check('the wire imports nothing: it is types only, so the renderer can carry it', () => {
    const [, wire] = split(WIRE);
    assert.ok(!/^import /m.test(wire));
  });

  run('crucible: the wire mirror');
}
