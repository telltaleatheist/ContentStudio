/**
 * AUTO-CONNECT: adopting the Crucible on this computer, only into a registry
 * that was never written (crucible docs/INTEGRATING-AN-APP.md section 5.1, plan
 * section 4).
 *
 * Ported from Briefcase's backend/test/crucible/auto-connect.spec.ts, against
 * the composition root (context.ts) so the wiring main.ts runs is the wiring
 * under test. What is held: an EXISTING empty registry is a person who removed
 * the server on purpose, so nothing is adopted and nothing is even asked; the
 * pairing is adopted only after its server answers `info` as itself on API 1;
 * boot never waits on it; and the attempts stop once they are over.
 */
const fs = require('fs');
const path = require('path');
const { assert, crucible, fake, tempDir, pairingHost, pairingLineFor, context, rejection, check, run } = require('./_crucible-keeper');

const { autoConnectLocal } = crucible('auto-connect');
const { REGISTRY_FILE } = crucible('registry');

async function withFake(options, fn) {
  const server = await fake.startFakeCrucible(options);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

const NAME = 'crucible@owens-mac-studio';

check('adopts the pairing when no registry exists yet, under the name the server calls itself', () => withFake({ name: NAME }, async (server) => {
  const { ctx, pushed } = context({ pairingHost: pairingHost(pairingLineFor(NAME, server.url, server.token)) });
  assert.strictEqual(await ctx.autoConnect.run(), NAME);
  const rows = ctx.servers.list();
  assert.deepStrictEqual(rows.map((r) => [r.name, r.url, r.tokenMasked]), [[NAME, server.url, `****${server.token.slice(-4)}`]]);
  assert.strictEqual(ctx.servers.getWithToken(NAME).token, server.token);
  assert.deepStrictEqual(pushed.servers, [{ reason: 'added', server: NAME }]);
  // The first server added is the selected one.
  assert.strictEqual(ctx.servers.selected(), NAME);
}));

check('adopts ONLY into an absent registry: an existing empty one is a deliberate removal, and nothing is even asked', () => withFake({ name: NAME }, async (server) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, REGISTRY_FILE), JSON.stringify({ servers: [] }));
  const { ctx } = context({ dir, pairingHost: pairingHost(pairingLineFor(NAME, server.url, server.token)) });
  assert.strictEqual(await ctx.autoConnect.run(), null);
  assert.deepStrictEqual(ctx.servers.list(), []);
  assert.strictEqual(server.requests.length, 0);
}));

check('adopts nothing into a registry that already has a server, even a different one', () => withFake({ name: NAME }, async (server) => {
  const { ctx } = context({ pairingHost: pairingHost(pairingLineFor(NAME, server.url, server.token)) });
  ctx.servers.add({ name: 'owens-pc', url: 'http://100.64.0.9:7100', token: 'tok-pc-0000' });
  assert.strictEqual(await ctx.autoConnect.run(), null);
  assert.deepStrictEqual(ctx.servers.names(), ['owens-pc']);
  assert.strictEqual(server.requests.length, 0);
}));

check('after an install it adopts even into an existing registry, and returns the row already at that address', () => withFake({ name: NAME }, async (server) => {
  const dir = tempDir();
  fs.writeFileSync(path.join(dir, REGISTRY_FILE), JSON.stringify({ servers: [] }));
  const { ctx } = context({ dir, pairingHost: pairingHost(pairingLineFor(NAME, server.url, server.token)) });
  assert.strictEqual(await ctx.autoConnect.run(true), NAME);
  assert.strictEqual(await ctx.autoConnect.run(true), NAME);
  assert.strictEqual(ctx.servers.list().length, 1);
}));

check('does nothing with no pairing file, and refuses by name after an install that published none', async () => {
  const { ctx } = context({ pairingHost: pairingHost(null) });
  assert.strictEqual(await ctx.autoConnect.run(), null);
  const err = await rejection(ctx.autoConnect.run(true));
  assert.match(err.message, /did not publish how to reach it/);
  assert.strictEqual(ctx.servers.exists(), false);
});

check('refuses a pairing whose token the server does not accept, and writes nothing', () => withFake({ name: NAME }, async (server) => {
  const { ctx } = context({ pairingHost: pairingHost(pairingLineFor(NAME, server.url, 'stale-token-0000')) });
  await rejection(ctx.autoConnect.run());
  assert.strictEqual(ctx.servers.exists(), false);
}));

check('refuses a pairing that points at something that is not a Crucible', async () => {
  const router = await fake.startNotCrucible();
  try {
    const { ctx } = context({ pairingHost: pairingHost(pairingLineFor(NAME, router.url, 'tok-0000')) });
    await rejection(ctx.autoConnect.run());
    assert.strictEqual(ctx.servers.exists(), false);
  } finally {
    await router.close();
  }
});

check('refuses a pairing when the server answering is a different Crucible', () => withFake({ name: NAME }, async (server) => {
  const { ctx } = context({ pairingHost: pairingHost(pairingLineFor('crucible@some-other-mac', server.url, server.token)) });
  const err = await rejection(ctx.autoConnect.run());
  assert.match(err.message, /not the "crucible@some-other-mac"/);
  assert.strictEqual(ctx.servers.exists(), false);
}));

check('never blocks boot: start() returns at once while its attempt is still out against a server that answers nothing', () => withFake({ name: NAME }, async (server) => {
  server.inject({ stallMs: 60_000 });
  const { ctx } = context({ pairingHost: pairingHost(pairingLineFor(NAME, server.url, server.token)) });
  ctx.autoConnect.retryDelaysMs = [];
  // Ordering, not a stopwatch: the call has returned while its attempt is still out.
  assert.strictEqual(ctx.autoConnect.start(), undefined);
  let over = false;
  void ctx.autoConnect.whenIdle().then(() => { over = true; });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.strictEqual(over, false);
  ctx.autoConnect.stop();
}));

check('asks again while nothing answers and no registry exists, then connects when the service is up', async () => {
  const port = new URL(await fake.unusedLoopbackUrl()).port;
  const { ctx } = context({ pairingHost: pairingHost(pairingLineFor(NAME, `http://127.0.0.1:${port}`, 'tok-later-1234')) });
  ctx.autoConnect.retryDelaysMs = [80, 80, 80];
  ctx.autoConnect.start();
  // The service comes up on that port after the first attempt found nothing there.
  await new Promise((resolve) => setTimeout(resolve, 40));
  const server = await fake.startFakeCrucible({ name: NAME, port: Number(port), token: 'tok-later-1234' });
  try {
    await ctx.autoConnect.whenIdle();
    assert.deepStrictEqual(ctx.servers.names(), [NAME]);
  } finally {
    ctx.autoConnect.stop();
    await server.close();
  }
});

check('the pure rule re-reads the registry after verifying, so a row that landed meanwhile wins', async () => {
  const rows = [];
  const deps = {
    registryExists: () => false,
    pairing: () => ({ name: 'crucible@x', url: 'http://127.0.0.1:7100', token: 't' }),
    list: () => rows,
    verify: async () => { rows.push({ name: 'added-meanwhile', url: 'http://127.0.0.1:7100/' }); },
    add: () => { throw new Error('must not add'); },
  };
  assert.strictEqual(await autoConnectLocal(false, deps), 'added-meanwhile');
});

run('crucible: auto-connect only into an empty registry');
