/**
 * EVERY ACT CONTENTSTUDIO SENDS IS A CLASS THE PINNED CRUCIBLE KNOWS (plan 6.4).
 *
 * Crucible refuses an act name it does not know (`400 unknown_act`,
 * crucible/inflight.py), so a typo in electron/crucible/acts.ts would be a
 * refused run. This reads crucible's OWN `capability.py` class list at the
 * pinned release, rather than trusting this repo's memory of it, the way
 * BookForge's test-crucible-text-acts.js does, and the way P1 read the tag for
 * the module generator (the tag's tree, never a working checkout that may have
 * moved on).
 *
 * Where the tag is read from, in order:
 *   1. CRUCIBLE_CAPABILITY_PY, a path to that file extracted from the release
 *      (`git archive v<pin> | tar -x`, or the GitHub tarball of the tag);
 *   2. `git show v<pin>:crucible/capabilityclasses.py` in the sibling crucible checkout
 *      (../crucible, where every app on this machine keeps it).
 * The class table moved from crucible/capability.py to crucible/capabilityclasses.py by 1.0.55
 * (the SDK repin of 2026-09-28); this reads the file at the pinned release, which is the new one.
 * With neither, the check FAILS naming both: an act list that was never checked
 * is not a pass.
 */
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');
const { assert, crucible, check, run, REPO } = require('./_crucible-keeper');

async function pinnedVersion() {
  const adopt = await import(pathToFileURL(path.join(REPO, 'tools', 'adopt-crucible-release.mjs')).href);
  return adopt.pinnedVersion(JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')));
}

/** Where the pinned release declares its capability classes (moved from crucible/capability.py by 1.0.55). */
const CLASS_TABLE = 'crucible/capabilityclasses.py';

function capabilityAtTag(version) {
  const extracted = process.env.CRUCIBLE_CAPABILITY_PY;
  if (extracted) return { source: extracted, text: fs.readFileSync(extracted, 'utf8') };
  // The repo root this worktree belongs to (a worktree lives under <repo>/.claude/worktrees/),
  // and crucible beside it.
  const root = REPO.split(`${path.sep}.claude${path.sep}worktrees${path.sep}`)[0];
  const checkout = path.join(path.dirname(root), 'crucible');
  try {
    const text = execFileSync('git', ['-C', checkout, 'show', `v${version}:${CLASS_TABLE}`], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { source: `${checkout} at v${version}`, text };
  } catch (err) {
    throw new Error(
      `${CLASS_TABLE} at v${version} could not be read: no CRUCIBLE_CAPABILITY_PY, and ` +
        `\`git -C ${checkout} show v${version}:${CLASS_TABLE}\` failed (${err.message.split('\n')[0]}). ` +
        'Point CRUCIBLE_CAPABILITY_PY at the file extracted from that release.',
    );
  }
}

/** The class names capability.py declares: every `name="..."` in its CLASSES table. */
function classesIn(text) {
  return [...text.matchAll(/name="([a-z-]+)"/g)].map((m) => m[1]);
}

check('every act ContentStudio sends is a capability class in crucible/capability.py at the pinned release', async () => {
  const version = await pinnedVersion();
  const { source, text } = capabilityAtTag(version);
  const classes = classesIn(text);
  assert.ok(classes.length >= 5, `${source} declared no classes this reader could find`);
  const { CONTENTSTUDIO_ACTS } = crucible('acts');
  for (const act of CONTENTSTUDIO_ACTS) {
    assert.ok(classes.includes(act), `crucible/capability.py (${source}) has no class "${act}"; it knows ${classes.join(', ')}`);
  }
  console.log(`      (${CONTENTSTUDIO_ACTS.join(', ')} checked against ${source})`);
});

check('the acts the door can put on the wire are exactly the declared list', () => {
  const { CONTENTSTUDIO_ACTS, isUpstreamModelId, upstreamOf } = crucible('acts');
  assert.deepStrictEqual([...CONTENTSTUDIO_ACTS], ['analysis', 'generate', 'decide']);
  // A local id never contains `/` (PHASE15-HOST 1); an upstream id names its upstream.
  assert.strictEqual(isUpstreamModelId('qwen3.8-27b-4bit'), false);
  assert.strictEqual(isUpstreamModelId('anthropic/claude-sonnet-5'), true);
  assert.strictEqual(upstreamOf('anthropic/claude-haiku-4-5-20251001'), 'anthropic');
  assert.strictEqual(upstreamOf('qwen3.5-9b'), null);
  // The source sends no act string that is not in the list: every literal the transport and
  // the lease layer put in an act position is one of them.
  const transport = fs.readFileSync(path.join(REPO, 'electron', 'crucible', 'transport.ts'), 'utf8');
  const literals = [...transport.matchAll(/act: '([a-z]+)'/g)].map((m) => m[1]);
  for (const literal of literals) assert.ok(CONTENTSTUDIO_ACTS.includes(literal), `transport.ts names act '${literal}'`);
});

check('every routing option that runs through Crucible names its Crucible ids; claude -p names none', () => {
  const routing = require(path.join(REPO, 'dist', 'main', 'services', 'metadata', 'metadata-routing.js'));
  // An option names a MODEL (2026-09-29): a local one lists the quant builds some server may hold,
  // and the job's server's catalog picks the one it runs (metadata-routing.ts resolveLocalOption).
  const expected = {
    'qwen38-27b': ['qwen3.8-27b-8bit', 'qwen3.8-27b-4bit'],
    'qwen35-9b': ['qwen3.5-9b'],
    'qwen35-4b': ['qwen3.5-4b'],
    // The vision rungs (qwen35-9b-vl, qwen35-2b, qwen35-08b, qwen38-27b-vl) went with the thumbnail
    // frame row on 2026-09-29 (REMOVED_ROUTING_OPTIONS).
    sonnet5: ['anthropic/claude-sonnet-5'],
    opus5: ['anthropic/claude-opus-5-5'],
    haiku45: ['anthropic/claude-haiku-4-5-20251001'],
    'claude-cli': null,
    'claude-cli-sonnet': null,
  };
  for (const [id, option] of Object.entries(routing.METADATA_ROUTING_OPTIONS)) {
    assert.ok(id in expected, `an option this check does not know: ${id}`);
    assert.deepStrictEqual(option.crucibleIds, expected[id], id);
    assert.strictEqual(option.cliModel === null, option.crucibleIds !== null, `${id} names exactly one transport`);
    if (option.kind === 'cloud' && option.crucibleIds !== null) assert.strictEqual(option.crucibleIds.length, 1, `${id} names one upstream id`);
  }
  assert.strictEqual(routing.SUMMARIZATION_OPTION, 'qwen38-27b');
});

run('crucible: every act sent is one the pinned release knows');
