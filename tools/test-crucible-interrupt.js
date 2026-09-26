/**
 * A CLI THAT LEASES GIVES IT BACK ON CTRL-C (plan sections 0a, 13.4).
 *
 * Briefcase's flag eval, interrupted, left its lease held until the TTL and
 * the card was stuck for everyone. This spawns a real child process that opens
 * the CLI lanes (electron/crucible/cli-lanes.ts, what generate-metadata-cli.js
 * and prompt-harness/run.js install), takes a lease on a fake Crucible the way
 * transport.ts will, and is then sent SIGINT, SIGTERM or SIGKILL:
 *
 *   SIGINT   the lease is released, the ledger file removed, exit 130
 *   SIGTERM  the same, exit 143
 *   SIGKILL  nothing can run; the NEXT run of the tool finds the dead process's
 *            ledger and gives its lease back before it admits anything
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
cli.lanes.aiCall(gpuCall('${MODEL}'), 'the job lease', async () => {
  const hooks = crucibleStepHooks();
  const client = await cli.context.factory.clientFor(hooks.server);
  const lease = await client.lease('${MODEL}', { act: 'generate', ttlSeconds: 120 });
  hooks.leased({ server: hooks.server, id: lease.leaseId, model: '${MODEL}' });
  process.stdout.write('LEASED ' + lease.leaseId + '\\n');
  // A CLI mid-run has sockets and timers keeping it alive; a bare pending promise would let it exit.
  setInterval(() => {}, 1000);
  await new Promise(() => {});
});
`;

async function world() {
  const server = await fake.startFakeCrucible({ name: 'crucible@mac', version: '1.0.34', resident: MODEL });
  const dir = tempDir();
  const { ctx } = context({ dir });
  ctx.servers.add({ name: 'mac', url: server.url, token: server.token });
  return { server, dir };
}

/** Start the child; resolves with it once it holds the lease. */
function leasingChild(dir) {
  const child = spawn(process.execPath, ['-e', CHILD, dir], { stdio: ['ignore', 'pipe', 'pipe'] });
  let err = '';
  child.stderr.on('data', (d) => { err += d; });
  const exited = new Promise((resolve) => child.on('exit', (code, signal) => resolve({ code, signal })));
  const leased = new Promise((resolve, reject) => {
    let out = '';
    child.stdout.on('data', (d) => {
      out += d;
      const m = /LEASED (\S+)/.exec(out);
      if (m) resolve(m[1]);
    });
    child.on('exit', () => reject(new Error(`the child exited before leasing: ${err}`)));
  });
  return { child, leased, exited };
}

const ledgers = (dir) => fs.readdirSync(dir).filter((name) => name.startsWith('crucible-in-flight-keeper-cli-'));

for (const [signal, code] of [['SIGINT', 130], ['SIGTERM', 143]]) {
  check(`${signal}: the CLI releases its lease, removes its ledger, and exits ${code}`, async () => {
    const { server, dir } = await world();
    try {
      const { child, leased, exited } = leasingChild(dir);
      const leaseId = await leased;
      assert.strictEqual(ledgers(dir).length, 1, 'the lease was recorded in this process\'s own ledger');
      child.kill(signal);
      const end = await exited;
      assert.strictEqual(end.code, code);
      assert.deepStrictEqual(server.leases.released, [leaseId]);
      assert.strictEqual(server.openLease(), null);
      assert.deepStrictEqual(ledgers(dir), [], 'nothing left for a next run to sweep');
    } finally {
      await server.close();
    }
  });
}

check('SIGKILL: nothing runs in the killed process, and the next run of the tool gives its lease back first', async () => {
  const { server, dir } = await world();
  try {
    const first = leasingChild(dir);
    const leaseId = await first.leased;
    first.child.kill('SIGKILL');
    await first.exited;
    assert.strictEqual(server.openLease().leaseId, leaseId, 'still held: a kill runs nothing');
    assert.strictEqual(ledgers(dir).length, 1);
    // The next run takes a lease of its own, which it can only do once the old one is gone.
    const second = leasingChild(dir);
    const next = await second.leased;
    assert.deepStrictEqual(server.leases.released, [leaseId], 'the dead run\'s lease was released by the next run, before its own lease');
    assert.notStrictEqual(next, leaseId);
    second.child.kill('SIGINT');
    assert.strictEqual((await second.exited).code, 130);
    assert.deepStrictEqual(ledgers(dir), []);
  } finally {
    await server.close();
  }
});

run('crucible: a CLI interrupted mid-lease');
