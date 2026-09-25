/**
 * What every `tools/test-crucible-*.js` keeper shares: the compiled main-process
 * Crucible modules loaded under plain Node, a temp state directory, a scripted
 * pairing file, the composition root wired over both, and a check runner.
 *
 * The keepers run against the COMPILED main process (dist/main/crucible/), which
 * is what ships, as check:pure does:
 *
 *   npm run build:electron && npm run check:crucible
 *
 * `electron` and `electron-log` are answered by tools/_electron-stub.js, so a
 * module that logs can be required outside an Electron app. Nothing here talks
 * to a real Crucible: every server is tools/fake-crucible.js on an ephemeral
 * loopback port, or a port nobody listens on.
 *
 * No test framework, on purpose (check:pure's reason): one line per check, and
 * a non-zero exit when any fails. An unhandled rejection anywhere in a keeper is
 * a failure too, because "no unhandled rejections" is one of the things P1 is
 * held to (CRUCIBLE-MIGRATION-PLAN.md section 16).
 */
const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const STUB = path.join(__dirname, '_electron-stub.js');
const originalResolve = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron-log' || request === 'electron') return require.resolve(STUB);
  return originalResolve.call(this, request, ...rest);
};

// The modules log every step; a keeper's output is its checks. The log is kept,
// not printed, so a check can still assert what was logged, and
// CRUCIBLE_KEEPER_VERBOSE=1 prints it as it happens.
const logged = [];
{
  const log = require(STUB);
  for (const level of ['info', 'warn', 'error', 'debug']) {
    log[level] = (...parts) => {
      logged.push({ level, text: parts.join(' ') });
      if (process.env.CRUCIBLE_KEEPER_VERBOSE === '1') console.log(`[log.${level}]`, ...parts);
    };
  }
}

const REPO = path.join(__dirname, '..');
const DIST = path.join(REPO, 'dist', 'main', 'crucible');

/** One compiled module from dist/main/crucible, or a refusal saying to build first. */
function crucible(name) {
  const file = path.join(DIST, `${name}.js`);
  if (!fs.existsSync(file)) {
    throw new Error(`${path.relative(REPO, file)} is not built. Run \`npm run build:electron\` first.`);
  }
  return require(file);
}

const fake = require('./fake-crucible');

function tempDir(prefix = 'cs-crucible-keeper-') {
  return fs.mkdtempSync(path.join(os.tmpdir(), prefix));
}

/** A pairing host whose one file is `text` (or absent when null), at ~/.crucible/pairing under `home`. */
function pairingHost(text, home = '/home/keeper') {
  return {
    platform: 'darwin',
    env: {},
    homedir: home,
    readFile: (file) => (file === path.posix.join(home, '.crucible', 'pairing') ? text : null),
  };
}

/** A pairing file's one line, as `crucible init` writes it: name and token percent-encoded, trailing newline. */
function pairingLineFor(name, url, token) {
  return `crucible://${encodeURIComponent(name)}@${new URL(url).host}/#${encodeURIComponent(token)}\n`;
}

/**
 * The local engine's seams, scripted: nothing here installs, spawns, reads
 * GitHub or asks the real machine's ~/.crucible anything. `hostable` and the
 * presence are set per check.
 */
function scriptedLocal(overrides = {}) {
  const state = {
    platform: 'darwin',
    arch: 'arm64',
    status: { state: 'absent', detail: 'no installation.json', url: '', name: '' },
    starts: 0,
    startResult: null,
  };
  const local = {
    host: {
      get platform() { return state.platform; },
      get arch() { return state.arch; },
      queryGpu: () => ({ status: 3, stdout: '', stderr: '' }),
      discovered: () => ({ present: false, code: 'no_local_config', reason: 'nothing here' }),
    },
    sources: {
      latest: async () => { throw new Error('a keeper never reads the release channel'); },
      running: async () => null,
      compare: (a, b) => a.localeCompare(b, undefined, { numeric: true }),
    },
    bootstrap: async () => { throw new Error('a keeper never installs'); },
    runner: () => { throw new Error('a keeper never spawns'); },
    localControls: async () => ({
      status: async () => state.status,
      start: async () => {
        state.starts += 1;
        if (state.startResult) return state.startResult();
        return state.status;
      },
    }),
    ...overrides,
  };
  return { state, local };
}

/**
 * The composition root (electron/crucible/context.ts) over a temp directory: the
 * same wiring main.ts builds, with recorders for the pushes and the clipboard.
 */
function context(options = {}) {
  const { createCrucibleContext } = crucible('context');
  const dir = options.dir ?? tempDir();
  const pushed = { servers: [], readiness: [], install: [], lanes: [] };
  const clipboard = [];
  const scripted = options.scripted ?? scriptedLocal();
  if (options.discovered) scripted.local.host.discovered = options.discovered;
  const ctx = createCrucibleContext({
    stateDir: dir,
    pairingHost: options.pairingHost ?? pairingHost(null),
    clipboard: (text) => { clipboard.push(text); },
    legacyClaudeKey: options.legacyClaudeKey ?? (() => undefined),
    push: {
      serversChanged: (change) => pushed.servers.push(change),
      readiness: (view) => pushed.readiness.push(view),
      installProgress: (event) => pushed.install.push(event),
      lanes: (view) => pushed.lanes.push(view),
    },
    local: scripted.local,
    // P3: the lanes' clocks, so a keeper drives the preflight and the stall clock itself.
    ...(options.lanes === undefined ? {} : { lanes: options.lanes }),
    ...(options.ledgerFile === undefined ? {} : { ledgerFile: options.ledgerFile }),
  });
  return { ctx, dir, pushed, clipboard, scripted };
}

/** The refusal's code, or a failure when there was none. */
function codeOf(fn) {
  try {
    fn();
  } catch (err) {
    return err.code;
  }
  throw new assert.AssertionError({ message: 'expected a refusal' });
}

async function rejection(promise) {
  try {
    await promise;
  } catch (err) {
    return err;
  }
  throw new assert.AssertionError({ message: 'expected a rejection' });
}

async function until(test, ms = 3000) {
  const deadline = Date.now() + ms;
  while (!(await test())) {
    if (Date.now() > deadline) throw new Error('timed out waiting');
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

const checks = [];
/** Queue one check; `run()` runs them in order. */
function check(name, fn) {
  checks.push({ name, fn });
}

const unhandled = [];
process.on('unhandledRejection', (reason) => unhandled.push(reason));

/** Run every queued check, print one line each, and set the exit code. */
async function run(title) {
  console.log(`\n${title}`);
  // The modules' own timers are unref'd (so they never hold the APP open on
  // quit), which would let Node exit mid-check while one waits on them.
  const keepAlive = setInterval(() => {}, 1_000);
  let failures = 0;
  for (const { name, fn } of checks) {
    try {
      await fn();
      console.log(`PASS  ${name}`);
    } catch (err) {
      failures += 1;
      console.log(`FAIL  ${name}`);
      console.log(`      ${(err && err.stack ? err.stack : String(err)).split('\n').slice(0, 6).join('\n      ')}`);
    }
  }
  // Give any stray promise a turn to surface before judging.
  await new Promise((resolve) => setTimeout(resolve, 50));
  if (unhandled.length > 0) {
    failures += 1;
    console.log(`FAIL  no unhandled rejections (${unhandled.length}: ${unhandled.map((r) => (r && r.message) || String(r)).join(' | ')})`);
  }
  clearInterval(keepAlive);
  console.log(failures === 0 ? `ALL PASS (${checks.length})` : `${failures} FAILED`);
  process.exitCode = failures === 0 ? 0 : 1;
}

module.exports = {
  assert,
  crucible,
  fake,
  tempDir,
  pairingHost,
  pairingLineFor,
  scriptedLocal,
  context,
  codeOf,
  rejection,
  until,
  check,
  run,
  logged,
  REPO,
};
