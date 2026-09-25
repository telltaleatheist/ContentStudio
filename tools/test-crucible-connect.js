/**
 * ADDING A SERVER: connect codes (built, read, round-tripped through the SDK's
 * own parser), device-code pairing, and "this machine's connect code".
 *
 * Ported from Briefcase's backend/test/crucible/connect.spec.ts, plus what
 * ContentStudio does differently: this machine's code is read from the
 * server's own `/v1/setup` (one line per address another machine can dial),
 * never from the pairing file, whose line names 127.0.0.1. What is held
 * throughout: a server is written to the registry only after a probe answers
 * `ok`; the renderer's answers carry no token; a refusal has a code.
 */
const { parsePairing } = require('@crucible/client');
const { assert, crucible, fake, pairingHost, pairingLineFor, context, rejection, check, run } = require('./_crucible-keeper');

const { connectCodeFor, elideConnectCode } = crucible('connect-code');
const { CrucibleConnectError } = crucible('errors');

async function withFake(options, fn) {
  const server = await fake.startFakeCrucible(options);
  try {
    await fn(server);
  } finally {
    await server.close();
  }
}

// ── the code itself ─────────────────────────────────────────────────────────

check('builds crucible://name@host:port/#token with both halves percent-encoded, and elides it for show', () => {
  const line = connectCodeFor('crucible@owens-pc', 'http://192.168.68.20:7100', 'tok/en+1234');
  assert.strictEqual(line, 'crucible://crucible%40owens-pc@192.168.68.20:7100/#tok%2Fen%2B1234');
  assert.strictEqual(elideConnectCode(line), 'crucible://crucible%40owens-pc@192.168.68.20:7100/#****');
});

check('round trip: what connectCodeFor writes, the SDK\'s parsePairing reads back field for field', () => {
  const cases = [
    ['crucible@owens-pc', 'http://100.64.0.9:7100', 'Ab3-_x9QzLmN0pQrStUvWxYz0123456789abcdefgh'],
    ['The PC', 'http://pc.tailnet.example:8443', 'tok/with+odd=chars'],
    ['mac', 'http://127.0.0.1:7100', 'plain'],
  ];
  for (const [name, url, token] of cases) {
    assert.deepStrictEqual(parsePairing(connectCodeFor(name, url, token)), { name, url, token }, name);
  }
});

check('an https server has no connect code: the format carries no scheme and reads back as http, so it is refused', () => {
  assert.throws(() => connectCodeFor('droplet', 'https://droplet.example:7100', 'tok-1234'), (err) => err.code === 'invalid_pairing' && /http:\/\//.test(err.message));
});

check('reads a pasted code back with the token masked, and names a line that is not one', () => {
  const { ctx } = context();
  const line = connectCodeFor('crucible@owens-pc', 'http://192.168.68.20:7100', 'tok/en+1234');
  assert.deepStrictEqual(ctx.connect.readConnectCode(line), { ok: true, name: 'crucible@owens-pc', url: 'http://192.168.68.20:7100', tokenMasked: '****1234' });
  assert.strictEqual(ctx.connect.readConnectCode('https://example.com').code, 'invalid_pairing');
});

// ── adding by code ──────────────────────────────────────────────────────────

check('adds a server from a pasted connect code after probing it, under its own name or the one typed', () => withFake({ name: 'crucible@owens-pc' }, async (server) => {
  const { ctx, pushed } = context();
  const row = await ctx.connect.addFromConnectCode(pairingLineFor('crucible@owens-pc', server.url, server.token));
  assert.deepStrictEqual([row.name, row.url], ['crucible@owens-pc', server.url]);
  assert.ok(!JSON.stringify(row).includes(server.token));
  assert.ok(server.requestsTo('/v1/info').length > 0, 'probed before it was written');
  assert.deepStrictEqual(pushed.servers.map((p) => p.reason), ['added']);
  const renamed = context();
  await renamed.ctx.connect.addFromConnectCode(pairingLineFor('crucible@owens-pc', server.url, server.token), 'The PC');
  assert.deepStrictEqual(renamed.ctx.servers.names(), ['The PC']);
}));

check('writes nothing when the pasted code carries a token the server refuses', () => withFake({}, async (server) => {
  const { ctx } = context();
  const err = await rejection(ctx.connect.addFromConnectCode(pairingLineFor('crucible@fake', server.url, 'stale-0000')));
  assert.strictEqual(err.code, 'probe_failed');
  assert.strictEqual(ctx.servers.exists(), false);
}));

check('writes nothing when nothing answers at the pasted address', async () => {
  const { ctx } = context();
  const err = await rejection(ctx.connect.addFromConnectCode(pairingLineFor('crucible@gone', await fake.unusedLoopbackUrl(), 'tok-0000')));
  assert.strictEqual(err.code, 'probe_failed');
  assert.strictEqual(ctx.servers.exists(), false);
});

check('refuses a line that is not a connect code, without echoing a token', async () => {
  const { ctx } = context();
  const err = await rejection(ctx.connect.addFromConnectCode('crucible://127.0.0.1:7100/#s3cret-token-value'));
  assert.ok(err instanceof CrucibleConnectError);
  assert.strictEqual(err.code, 'invalid_pairing');
  assert.ok(!err.message.includes('s3cret-token-value'));
});

check('adopts the discovered Crucible on this computer on request, and says so when there is none', () => withFake({}, async (server) => {
  const { ctx } = context({ pairingHost: pairingHost(pairingLineFor('crucible@owens-mac-studio', server.url, server.token)) });
  assert.strictEqual((await ctx.connect.addDiscovered()).name, 'crucible@owens-mac-studio');
  const none = context({ pairingHost: pairingHost(null) });
  assert.strictEqual((await rejection(none.ctx.connect.addDiscovered())).code, 'nothing_discovered');
}));

// ── device-code pairing ─────────────────────────────────────────────────────

check('open pairing: start shows a user code, the first poll approves, probes and registers', () => withFake({ name: 'crucible@owens-pc' }, async (server) => {
  const { ctx } = context();
  const prompt = await ctx.connect.startPairing(server.url);
  assert.strictEqual(prompt.name, 'crucible@owens-pc');
  assert.strictEqual(prompt.approvalRequired, false);
  assert.match(prompt.userCode, /^[0-9A-F]{4}-[0-9A-F]{4}$/);
  assert.ok(!JSON.stringify(prompt).includes(server.token));
  assert.deepStrictEqual(Object.keys(prompt).sort(), ['approvalRequired', 'expiresIn', 'interval', 'name', 'requestId', 'url', 'userCode']);
  assert.strictEqual(server.pairings[0].clientName, 'ContentStudio');
  assert.deepStrictEqual(await ctx.connect.pollPairing(prompt.requestId), { status: 'approved', name: 'crucible@owens-pc' });
  assert.deepStrictEqual(ctx.servers.getWithToken('crucible@owens-pc'), { name: 'crucible@owens-pc', url: server.url, token: server.token });
  assert.strictEqual((await rejection(ctx.connect.pollPairing(prompt.requestId))).code, 'pairing_not_active');
}));

check('approval pairing: pending until the operator decides; approved registers, denied does not', () => withFake({ pairing: 'approval' }, async (server) => {
  const { ctx } = context();
  const first = await ctx.connect.startPairing(server.url, 'owens-pc');
  assert.strictEqual(first.approvalRequired, true);
  assert.deepStrictEqual(await ctx.connect.pollPairing(first.requestId), { status: 'pending' });
  server.decidePairing(server.pairings[0].id, false);
  assert.deepStrictEqual(await ctx.connect.pollPairing(first.requestId), { status: 'denied' });
  assert.strictEqual(ctx.servers.exists(), false);
  const second = await ctx.connect.startPairing(server.url, 'owens-pc');
  server.decidePairing(server.pairings[1].id, true);
  assert.deepStrictEqual(await ctx.connect.pollPairing(second.requestId), { status: 'approved', name: 'owens-pc' });
  assert.deepStrictEqual(ctx.servers.names(), ['owens-pc']);
}));

check('expired and cancelled requests end cleanly', () => withFake({ pairing: 'approval' }, async (server) => {
  const { ctx } = context();
  const expiring = await ctx.connect.startPairing(server.url);
  server.expirePairings();
  assert.deepStrictEqual(await ctx.connect.pollPairing(expiring.requestId), { status: 'expired' });
  const cancelled = await ctx.connect.startPairing(server.url);
  ctx.connect.cancelPairing(cancelled.requestId);
  assert.strictEqual((await rejection(ctx.connect.pollPairing(cancelled.requestId))).code, 'pairing_not_active');
}));

// ── copying codes out ───────────────────────────────────────────────────────

check('copies a registered server\'s code to the clipboard, and answers with the token elided', () => withFake({}, async (server) => {
  const { ctx, clipboard } = context();
  ctx.servers.add({ name: 'pc', url: server.url, token: server.token });
  const answer = await ctx.connect.copyConnectCode('pc');
  assert.deepStrictEqual(clipboard, [connectCodeFor('pc', server.url, server.token)]);
  assert.match(answer.copied, /^crucible:\/\/pc@127\.0\.0\.1:\d+\/#\*\*\*\*$/);
  assert.ok(!JSON.stringify(answer).includes(server.token));
}));

check('this machine\'s code comes from /v1/setup: one line per address another machine dials, never 127.0.0.1', () => withFake(
  { name: 'crucible@owens-mac-studio', setupUrls: ['http://192.168.68.79:7100', 'http://100.64.0.5:7100'] },
  async (server) => {
    const { ctx, clipboard } = context({ pairingHost: pairingHost(pairingLineFor('crucible@owens-mac-studio', server.url, server.token)) });
    const codes = await ctx.connect.localConnectCodes();
    assert.strictEqual(codes.server, 'crucible@owens-mac-studio');
    assert.deepStrictEqual(codes.lines.map((l) => l.url), ['http://192.168.68.79:7100', 'http://100.64.0.5:7100']);
    assert.ok(codes.lines.every((l) => l.elided.endsWith('#****')));
    assert.ok(!JSON.stringify(codes).includes(server.token));
    const copied = await ctx.connect.copyLocalConnectCode('http://100.64.0.5:7100');
    assert.strictEqual(clipboard.length, 1);
    assert.deepStrictEqual(parsePairing(clipboard[0]), { name: 'crucible@owens-mac-studio', url: 'http://100.64.0.5:7100', token: server.token });
    assert.ok(copied.copied.endsWith('#****'));
    assert.strictEqual((await rejection(ctx.connect.copyLocalConnectCode('http://10.9.9.9:7100'))).code, 'unknown_address');
  },
));

check('a loopback-bound server has no code for another machine, and says so by name', () => withFake({ setupUrls: [] }, async (server) => {
  const { ctx } = context({ pairingHost: pairingHost(pairingLineFor('crucible@fake', server.url, server.token)) });
  const err = await rejection(ctx.connect.localConnectCodes());
  assert.strictEqual(err.code, 'not_reachable_elsewhere');
  const none = context({ pairingHost: pairingHost(null) });
  assert.strictEqual((await rejection(none.ctx.connect.localConnectCodes())).code, 'nothing_discovered');
}));

run('crucible: connect codes and pairing');
