/**
 * A CLI THAT HOLDS A QUEUE SESSION ENDS IT ON CTRL-C (plan sections 0a, 13.4; LEDGER #255).
 *
 * Briefcase's flag eval, interrupted, left its lease held until the TTL and the card was stuck
 * for everyone; an open queue session left behind is worse: nothing from any other client runs
 * until it idles out. This spawns a real child process that opens the CLI lanes
 * (electron/crucible/cli-lanes.ts, what generate-metadata-cli.js and prompt-harness/run.js
 * install), opens its step's queue session on a fake Crucible the way transport.ts does, and is
 * then sent SIGINT, SIGTERM or SIGKILL:
 *
 *   SIGINT   the session is ended, the ledger file removed, exit 130
 *   SIGTERM  the same, exit 143
 *   SIGKILL  nothing can run; the NEXT run of the tool finds the dead process's ledger and ends
 *            its session before it admits anything (its own would otherwise queue behind it)
 */
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const { assert, fake, context, tempDir, check, run } = require('./_crucible-keeper');

const MODEL = 'qwen3.5-9b';
const CHILD = `
const Module = require('module');
const stub = ${JSON.stringify(path.join(__dirname, '_electron-stub.js'))};
const original = Module._resolveFilename;
Module._resolveFilename = function (request, ...rest) {
  if (request === 'electron' || request === 'electron-log') return require.resolve(stub);
  return original.call(this, request, ...rest);
};
const dist = ${JSON.stringify(path.join(__dirname, '..', 'dist', 'main', 'crucible'))};
const { openCliLanes } = require(dist + '/cli-lanes.js');
const { gpuCall, crucibleStepHooks } = require(dist + '/lanes.js');
const cli = openCliLanes({ stateDir: process.argv[1], tool: 'keeper-cli', say: () => {} });
cli.lanes.aiCall(gpuCall('${MODEL}'), 'the job session', async () => {
  const hooks = crucibleStepHooks();
  const hold = await hooks.session({ act: 'generate', what: 'the keeper CLI' });
  process.stdout.write('SESSION ' + hold.card.id + '\\n');
  // A CLI mid-run has sockets and timers keeping it alive; a bare pending promise would let it exit.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`;

async function world() {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.76', resident: MODEL });
  const dir = tempDir();
  const { ctx } = context({ dir });
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  return { server, dir };
}

/** Start the child; resolves with it once its session is open. */
function holdingChild(dir) {
  const child = spawn(process.execPath, ['-e', CHILD, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const leased = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /SESSION (\S+)/.exec(out);
      if (m) resolve(m[1]);
    });
    child.on('exit', () => reject(new Error(`the child exited before its session opened: ${err}`)));
  });
  return { child, opened: leased, exited };
}

const ledgers = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('crucible-in-flight-keeper-cli-'));

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  check(`${signal}: the CLI ends its session, removes its ledger, and exits ${code}`, async () => {
    const { server, dir } = await world();
    try {
      const { child, opened, exited } = holdingChild(dir);
      const sessionId = await opened;
      assert.strictEqual(ledgers(dir).length, 1, 'the session was recorded in this process\'s own ledger');
      child.kill(signal);
      const end = await exited;
      assert.strictEqual(end.code, code);
      assert.deepStrictEqual(server.sessions.map((row) => [row.id, row.status]), [[sessionId, 'closed']]);
      assert.strictEqual(server.openSession(), null);
      assert.deepStrictEqual(ledgers(dir), [], 'nothing left for a next run to sweep');
    } finally {
      await server.close();
    }
  });
}

check('SIGKILL: nothing runs in the killed process, and the next run of the tool ends its session first', async () => {
  const { server, dir } = await world();
  try {
    const first = holdingChild(dir);
    const sessionId = await first.opened;
    first.child.kill('SIGKILL');
    await first.exited;
    assert.strictEqual(server.openSession().session_id, sessionId, 'still open: a kill runs nothing');
    assert.strictEqual(ledgers(dir).length, 1);
    // The next run's own session opens only once the old one is gone (it would queue behind it).
    const second = holdingChild(dir);
    const next = await second.opened;
    assert.strictEqual(server.sessions[0].status, 'closed', 'the dead run\'s session was ended by the next run, before its own opened');
    assert.notStrictEqual(next, sessionId);
    second.child.kill('SIGINT');
    assert.strictEqual((await second.exited).code, 130);
    assert.deepStrictEqual(ledgers(dir), []);
  } finally {
    await server.close();
  }
});

run('crucible: a CLI interrupted holding a queue session');
