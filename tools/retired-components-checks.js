#!/usr/bin/env node
/**
 * check:retired: P10's one-time retired-component cleanup (electron/retired-components.ts),
 * on a fake userData and a fake OwenMorgan shared dir built in a temp directory. Nothing outside
 * that directory is read or written. Needs `npm run build:electron` first (it loads dist).
 *
 * What it holds: the dry run lists what it would remove, with sizes, and removes nothing; every
 * target is inside its parent and inside a root, asserted again before removal; what this build
 * still uses and whatever sits outside the two roots is never touched; a symlink is removed as a
 * link; the store opt-out keeps everything; a run records itself and does not run twice.
 *
 *   node tools/retired-components-checks.js [--keep]   (--keep leaves the temp tree for a look)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const assert = require('assert');

const DIST = path.join(__dirname, '..', 'dist', 'main', 'retired-components.js');
if (!fs.existsSync(DIST)) {
  console.error(`${DIST} is missing: run npm run build:electron first`);
  process.exit(1);
}
const R = require(DIST);

const checks = [];
const check = (name, fn) => checks.push({ name, fn });

function write(file, bytes) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, Buffer.alloc(bytes, 7));
  return file;
}

/** Every file under `dir` with its size, for before/after comparisons. */
function tree(dir) {
  const out = {};
  const walk = (d) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isSymbolicLink()) out[path.relative(dir, full)] = `-> ${fs.readlinkSync(full)}`;
      else if (e.isDirectory()) walk(full);
      else out[path.relative(dir, full)] = fs.statSync(full).size;
    }
  };
  walk(dir);
  return out;
}

function memoryStore(initial = {}) {
  const data = { ...initial };
  return { data, get: (k) => data[k], set: (k, v) => { data[k] = v; } };
}

const silentLog = () => {
  const lines = [];
  return { lines, info: (m) => lines.push(m), warn: (m) => lines.push(`WARN ${m}`) };
};

/**
 * A machine as P10 finds it: ContentStudio's components (whisper-engine and a whisper model beside
 * ffmpeg and the speaker model), the shared dir's editor assets (two whisper models, the
 * separator env, the Python env and ffmpeg-tools BookForge-style neighbours), the per-app
 * fallback store, and a decoy OUTSIDE both roots.
 */
function machine() {
  const top = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-p10-retire-'));
  const userData = path.join(top, 'contentstudio');
  const shared = path.join(top, 'OwenMorgan');
  const outside = path.join(top, 'outside');
  const comp = path.join(userData, 'components');
  write(path.join(comp, 'ffmpeg', 'ffmpeg'), 1000);
  write(path.join(comp, 'speaker-embedding', 'nemo_en_titanet_small.onnx'), 400);
  write(path.join(comp, 'whisper-engine', 'whisper-cli-arm64'), 300);
  write(path.join(comp, 'whisper-engine', 'libwhisper.1.dylib'), 200);
  write(path.join(comp, 'whisper-base', 'ggml-base.bin'), 1500);
  fs.writeFileSync(path.join(comp, 'installed.json'), JSON.stringify({ components: {
    ffmpeg: { id: 'ffmpeg', path: path.join(comp, 'ffmpeg'), entryPath: path.join(comp, 'ffmpeg', 'ffmpeg') },
    'speaker-embedding': { id: 'speaker-embedding', path: path.join(comp, 'speaker-embedding'), entryPath: '' },
    'whisper-engine': { id: 'whisper-engine', path: path.join(comp, 'whisper-engine'), entryPath: '' },
    'whisper-base': { id: 'whisper-base', path: path.join(comp, 'whisper-base'), entryPath: '' },
  } }, null, 2));
  write(path.join(shared, 'models', 'whisper', 'ggml-base.bin'), 1480);
  write(path.join(shared, 'models', 'whisper', 'ggml-large-v3-turbo.bin'), 16245);
  write(path.join(shared, 'models', 'whisper', 'ggml-custom-finetune.bin'), 99); // not a catalog file
  write(path.join(shared, 'runtime', 'voice-separator-env', 'bin', 'python3'), 50);
  write(path.join(shared, 'runtime', 'voice-separator-env', 'audio-separator-models', 'vocals_mel_band_roformer.ckpt'), 9130);
  write(path.join(shared, 'runtime', 'autocutstudio-env', 'bin', 'python3'), 60);
  write(path.join(shared, 'managed-bins', 'ffmpeg-tools', 'ffmpeg'), 70);
  write(path.join(shared, 'llama-models', 'active-model.json'), 10);
  write(path.join(shared, 'autocutstudio', 'installed.json'), 0);
  fs.writeFileSync(path.join(shared, 'autocutstudio', 'installed.json'), JSON.stringify({ components: {
    'ffmpeg-tools': { id: 'ffmpeg-tools', category: 'managed-bins', subdir: 'ffmpeg-tools' },
    'python-env': { id: 'python-env', category: 'runtime', subdir: 'autocutstudio-env' },
    'whisper-base': { id: 'whisper-base', version: 'base', category: 'models', subdir: 'whisper' },
    'whisper-large-v3': { id: 'whisper-large-v3', version: 'large-v3', category: 'models', subdir: 'whisper' },
  } }, null, 2));
  write(path.join(userData, 'assets', 'models', 'whisper', 'ggml-small.bin'), 4870);
  write(path.join(outside, 'models', 'whisper', 'ggml-base.bin'), 1480);
  write(path.join(outside, 'voice-separator-env', 'conda-meta', 'history'), 5);
  return { top, userData, shared, outside, roots: { userData, sharedDir: shared } };
}

check('the dry run lists every retired item with its size, and removes nothing', async () => {
  const m = machine();
  const before = tree(m.top);
  const plan = await R.planRetirement(m.roots);
  const rel = plan.targets.map((t) => [path.relative(m.top, t.path), t.type, t.bytes]).sort();
  assert.deepStrictEqual(rel, [
    ['OwenMorgan/models/whisper/ggml-base.bin', 'file', 1480],
    ['OwenMorgan/models/whisper/ggml-large-v3-turbo.bin', 'file', 16245],
    ['OwenMorgan/runtime/voice-separator-env', 'dir', 9180],
    ['contentstudio/assets/models/whisper/ggml-small.bin', 'file', 4870],
    ['contentstudio/components/whisper-base', 'dir', 1500],
    ['contentstudio/components/whisper-engine', 'dir', 500],
  ].sort());
  assert.strictEqual(plan.totalBytes, 1480 + 16245 + 9180 + 4870 + 1500 + 500);
  const lines = R.describePlan(plan);
  assert.ok(lines.some((l) => /would remove\s+15\.9 KB\s+file\s+.*ggml-large-v3-turbo\.bin/.test(l)), lines.join('\n'));
  assert.ok(lines.some((l) => l.startsWith('would free 33.0 KB (33775 bytes) in 6 item(s)')), lines.join('\n'));
  assert.ok(lines.some((l) => /would drop records whisper-engine, whisper-base from .*components\/installed\.json/.test(l)));
  assert.ok(lines.some((l) => /would drop records whisper-base, whisper-large-v3 from .*autocutstudio\/installed\.json/.test(l)));
  assert.deepStrictEqual(tree(m.top), before, 'planning changed the disk');
});

check('the path assertion: strictly inside the parent and inside a root, or it throws naming the path', () => {
  const roots = { userData: '/x/contentstudio', sharedDir: '/x/OwenMorgan' };
  R.assertRemovable('/x/contentstudio/components/whisper-base', '/x/contentstudio/components', roots);
  R.assertRemovable('/x/OwenMorgan/models/whisper/ggml-base.bin', '/x/OwenMorgan/models/whisper', roots);
  const refused = (target, parent, why) => assert.throws(() => R.assertRemovable(target, parent, roots), why, target);
  refused('/x/contentstudio/components', '/x/contentstudio/components', /is not inside/); // the parent itself
  refused('/x/contentstudio/components/../../etc', '/x/contentstudio/components', /is not inside/);
  refused('/x/contentstudio-old/components/whisper-base', '/x/contentstudio-old/components', /outside the app's own directories/);
  refused('/Users/o/.ollama/models/blobs/sha256-1', '/Users/o/.ollama/models/blobs', /outside the app's own directories/);
  refused('/x/contentstudio', '/x', /outside the app's own directories/); // the root itself
  assert.throws(() => R.assertRemovable('/x/OwenMorgan/models/whisper/a', '/x/OwenMorgan/models/whisper',
    { userData: '/x/contentstudio', sharedDir: null }), /outside the app's own directories/);
});

check('the cleanup removes the plan, drops the stale records, and leaves everything this build uses', async () => {
  const m = machine();
  const store = memoryStore();
  const log = silentLog();
  const result = await R.retireOnce(m.roots, store, log, () => new Date('2026-09-26T12:00:00Z'));
  assert.ok(result, log.lines.join('\n'));
  assert.deepStrictEqual(result.errors, []);
  assert.strictEqual(result.bytesFreed, 33775);
  const after = tree(m.top);
  assert.deepStrictEqual(Object.keys(after).sort(), [
    'OwenMorgan/autocutstudio/installed.json',
    'OwenMorgan/llama-models/active-model.json',
    'OwenMorgan/managed-bins/ffmpeg-tools/ffmpeg',
    'OwenMorgan/models/whisper/ggml-custom-finetune.bin',
    'OwenMorgan/runtime/autocutstudio-env/bin/python3',
    'contentstudio/components/ffmpeg/ffmpeg',
    'contentstudio/components/installed.json',
    'contentstudio/components/speaker-embedding/nemo_en_titanet_small.onnx',
    'outside/models/whisper/ggml-base.bin',
    'outside/voice-separator-env/conda-meta/history',
  ]);
  // The fallback store's emptied models/whisper and models dirs are pruned; the shared one keeps a file.
  assert.ok(!fs.existsSync(path.join(m.userData, 'assets', 'models')));
  assert.ok(fs.existsSync(path.join(m.shared, 'models', 'whisper')));
  const comps = JSON.parse(fs.readFileSync(path.join(m.userData, 'components', 'installed.json'), 'utf8')).components;
  assert.deepStrictEqual(Object.keys(comps).sort(), ['ffmpeg', 'speaker-embedding']);
  const assets = JSON.parse(fs.readFileSync(path.join(m.shared, 'autocutstudio', 'installed.json'), 'utf8')).components;
  assert.deepStrictEqual(Object.keys(assets).sort(), ['ffmpeg-tools', 'python-env']);
  // The dry run was logged before anything was removed.
  const firstRemoval = log.lines.findIndex((l) => l.startsWith('[retire] removed '));
  const lastPlan = log.lines.map((l) => l.startsWith('[retire] would ')).lastIndexOf(true);
  assert.ok(lastPlan >= 0 && firstRemoval > lastPlan, log.lines.join('\n'));
  // Recorded once, and a second launch does nothing.
  const rec = store.data[R.RETIRED_STORE_KEY][R.RETIREMENT_ID];
  assert.strictEqual(rec.completedAt, '2026-09-26T12:00:00.000Z');
  assert.strictEqual(rec.bytesFreed, 33775);
  assert.strictEqual(rec.removed.length, 6);
  assert.strictEqual(await R.retireOnce(m.roots, store, silentLog()), null);
});

check('the opt-out store key keeps everything on disk, still logs the plan, and records nothing', async () => {
  const m = machine();
  const before = tree(m.top);
  const store = memoryStore({ [R.KEEP_RETIRED_STORE_KEY]: true });
  const log = silentLog();
  assert.strictEqual(await R.retireOnce(m.roots, store, log), null);
  assert.deepStrictEqual(tree(m.top), before);
  assert.strictEqual(store.data[R.RETIRED_STORE_KEY], undefined);
  assert.ok(log.lines.some((l) => l.startsWith('[retire] would remove')), log.lines.join('\n'));
  assert.ok(log.lines.some((l) => l.includes(`${R.KEEP_RETIRED_STORE_KEY} is true`)));
});

check('a symlinked env is removed as a link and its target outside the roots is untouched', async () => {
  const m = machine();
  const env = path.join(m.shared, 'runtime', 'voice-separator-env');
  fs.rmSync(env, { recursive: true, force: true });
  fs.symlinkSync(path.join(m.outside, 'voice-separator-env'), env);
  const plan = await R.planRetirement(m.roots);
  const t = plan.targets.find((x) => x.path === env);
  assert.strictEqual(t.type, 'symlink');
  assert.strictEqual(t.bytes, 0);
  await R.executeRetirement(plan);
  assert.ok(!fs.existsSync(env) && !fs.lstatSync(path.dirname(env)).isSymbolicLink());
  assert.ok(fs.existsSync(path.join(m.outside, 'voice-separator-env', 'conda-meta', 'history')));
});

check('a record pointing outside the app, and an env dir that is not the env, are left alone and said so', async () => {
  const m = machine();
  const manifest = path.join(m.userData, 'components', 'installed.json');
  const raw = JSON.parse(fs.readFileSync(manifest, 'utf8'));
  raw.components['whisper-small'] = { id: 'whisper-small', path: path.join(m.outside, 'models', 'whisper'), entryPath: '' };
  fs.writeFileSync(manifest, JSON.stringify(raw));
  const env = path.join(m.userData, 'assets', 'runtime', 'voice-separator-env');
  write(path.join(env, 'notes.txt'), 3);
  const plan = await R.planRetirement(m.roots);
  assert.ok(plan.skipped.some((s) => s.path === path.join(m.outside, 'models', 'whisper') && /points outside components\/whisper-small/.test(s.why)));
  assert.ok(plan.skipped.some((s) => s.path === env && /does not look like voice-separator-env/.test(s.why)));
  assert.ok(!plan.targets.some((t) => t.path.startsWith(m.outside) || t.path === env));
  await R.executeRetirement(plan);
  assert.ok(fs.existsSync(path.join(m.outside, 'models', 'whisper', 'ggml-base.bin')));
  assert.ok(fs.existsSync(path.join(env, 'notes.txt')));
});

check('execute re-asserts every target: a plan edited to point outside the roots removes nothing there', async () => {
  const m = machine();
  const plan = await R.planRetirement(m.roots);
  const decoy = path.join(m.outside, 'models', 'whisper', 'ggml-base.bin');
  plan.targets.push({ path: decoy, type: 'file', bytes: 1480, reason: 'tampered', parent: path.dirname(decoy) });
  plan.targets.push({ path: path.join(m.userData, 'components', 'ffmpeg'), type: 'dir', bytes: 1000, reason: 'tampered', parent: m.top });
  const result = await R.executeRetirement(plan);
  assert.ok(fs.existsSync(decoy));
  assert.ok(fs.existsSync(path.join(m.userData, 'components', 'ffmpeg', 'ffmpeg')));
  assert.deepStrictEqual(result.errors.map((e) => e.path).sort(), [decoy, path.join(m.userData, 'components', 'ffmpeg')].sort());
  assert.ok(result.errors.every((e) => /refusing to remove/.test(e.error)));
});

check('a run with a failure is not recorded, so the next launch tries again', async () => {
  const m = machine();
  const store = memoryStore();
  fs.writeFileSync(path.join(m.shared, 'autocutstudio', 'installed.json'), '{ not json');
  const log = silentLog();
  assert.strictEqual(await R.retireOnce(m.roots, store, log), null);
  assert.strictEqual(store.data[R.RETIRED_STORE_KEY], undefined);
  assert.ok(log.lines.some((l) => /skipped this launch: .*could not be read/.test(l)), log.lines.join('\n'));
  assert.ok(fs.existsSync(path.join(m.userData, 'components', 'whisper-engine')), 'nothing was removed on a plan that could not be made');
});

(async () => {
  let failed = 0;
  console.log('check:retired (P10: the one-time retired-component cleanup)');
  for (const c of checks) {
    try {
      await c.fn();
      console.log(`PASS  ${c.name}`);
    } catch (e) {
      failed += 1;
      console.log(`FAIL  ${c.name}\n      ${String(e && e.stack || e).split('\n').slice(0, 4).join('\n      ')}`);
    }
  }
  console.log(failed === 0 ? `check:retired: ALL PASS (${checks.length})` : `${failed} FAILED`);
  process.exit(failed === 0 ? 0 : 1);
})();
