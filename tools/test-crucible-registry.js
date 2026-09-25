/**
 * THE SERVERS REGISTRY AND THE CHOICE: <userData>/crucible-servers.json and
 * crucible-routing.json.
 *
 * Ported from Briefcase's backend/test/crucible/registry.spec.ts, with the
 * record ContentStudio keeps: {selected, fastServer, paused} (LEDGER #205, plan
 * sections 4 and 14). What is held: the write is temp-then-rename and 0600; a
 * token never appears in a listing or an announcement; a corrupt file is
 * refused and never overwritten; the first server added is selected and a
 * removed selection leaves NONE selected (never another picked for the user);
 * a pre-ruling {order, disabled} file reads as its first running server.
 */
const fs = require('fs');
const path = require('path');
const { assert, crucible, tempDir, codeOf, check, run } = require('./_crucible-keeper');

const { ServerRegistry, maskToken, originKey, validateServerName, REGISTRY_FILE } = crucible('registry');
const { Routing, ROUTING_FILE } = crucible('routing');
const { CrucibleServers } = crucible('servers');

const TOKEN_A = 'tok-aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa-1234';
const TOKEN_B = 'tok-bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb-5678';

// ── the registry file ──────────────────────────────────────────────────────

check('a missing file is an empty registry that says it does not exist yet', () => {
  const registry = new ServerRegistry(path.join(tempDir(), REGISTRY_FILE));
  assert.strictEqual(registry.exists(), false);
  assert.deepStrictEqual(registry.list(), []);
});

check('writes temp-then-rename, 0600, and leaves no temp file behind', () => {
  const dir = tempDir();
  const file = path.join(dir, REGISTRY_FILE);
  const registry = new ServerRegistry(file);
  registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  registry.add({ name: 'pc', url: 'http://100.64.0.9:7100', token: TOKEN_B });
  assert.deepStrictEqual(fs.readdirSync(dir), [REGISTRY_FILE]);
  if (process.platform !== 'win32') assert.strictEqual(fs.statSync(file).mode & 0o777, 0o600);
  const onDisk = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.deepStrictEqual(Object.keys(onDisk), ['servers']);
  assert.deepStrictEqual(Object.keys(onDisk.servers[0]).sort(), ['added', 'name', 'token', 'url']);
  assert.strictEqual(onDisk.servers[0].token, TOKEN_A);
});

check('an interrupted write never damages the file: the rename is the only moment it changes', () => {
  const dir = tempDir();
  const file = path.join(dir, REGISTRY_FILE);
  const registry = new ServerRegistry(file);
  registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  const before = fs.readFileSync(file, 'utf8');
  // A crash between the temp write and the rename leaves the temp file and the old file whole.
  const realRename = fs.renameSync;
  fs.renameSync = () => { throw new Error('killed mid-write'); };
  try {
    assert.throws(() => registry.add({ name: 'pc', url: 'http://100.64.0.9:7100', token: TOKEN_B }), /killed mid-write/);
  } finally {
    fs.renameSync = realRename;
  }
  assert.strictEqual(fs.readFileSync(file, 'utf8'), before);
  assert.deepStrictEqual(registry.names(), ['mac']);
});

check('never lists a token: rows carry ****<last 4> only', () => {
  const registry = new ServerRegistry(path.join(tempDir(), REGISTRY_FILE));
  registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  const listed = registry.list();
  assert.strictEqual(listed[0].tokenMasked, '****1234');
  assert.ok(!JSON.stringify(listed).includes(TOKEN_A));
  assert.deepStrictEqual(Object.keys(listed[0]).sort(), ['added', 'name', 'tokenMasked', 'url']);
  assert.strictEqual(maskToken(TOKEN_B), '****5678');
});

check('hands the token out by exact name only, and refuses an unknown name by listing what it knows', () => {
  const registry = new ServerRegistry(path.join(tempDir(), REGISTRY_FILE));
  registry.add({ name: 'Mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  assert.strictEqual(registry.get('Mac').token, TOKEN_A);
  assert.strictEqual(codeOf(() => registry.get('mac')), 'unknown_server');
  assert.throws(() => registry.get('pc'), /known: Mac/);
});

check('refuses a duplicate name (case-insensitive) and a second row on the same address', () => {
  const registry = new ServerRegistry(path.join(tempDir(), REGISTRY_FILE));
  registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  assert.strictEqual(codeOf(() => registry.add({ name: 'MAC', url: 'http://10.0.0.2:7100', token: TOKEN_B })), 'duplicate_server');
  assert.strictEqual(codeOf(() => registry.add({ name: 'pc', url: 'http://127.0.0.1:7100/', token: TOKEN_B })), 'duplicate_server');
  assert.strictEqual(originKey('http://LOCALHOST:7100/'), originKey('http://localhost:7100'));
  assert.strictEqual(originKey('http://localhost'), 'http://localhost:80');
});

check('refuses a URL with no scheme or with /v1, and an empty token, writing nothing', () => {
  const file = path.join(tempDir(), REGISTRY_FILE);
  const registry = new ServerRegistry(file);
  assert.strictEqual(codeOf(() => registry.add({ name: 'a', url: '10.0.0.2:7100', token: TOKEN_A })), 'invalid_url');
  assert.strictEqual(codeOf(() => registry.add({ name: 'a', url: 'http://10.0.0.2:7100/v1', token: TOKEN_A })), 'invalid_url');
  assert.strictEqual(codeOf(() => registry.add({ name: 'a', url: 'http://10.0.0.2:7100', token: '  ' })), 'empty_token');
  assert.strictEqual(fs.existsSync(file), false);
});

check('validates names at the door: colons, slashes, control characters, double spaces, length', () => {
  assert.strictEqual(validateServerName('  crucible@owens-mac-studio '), 'crucible@owens-mac-studio');
  assert.strictEqual(validateServerName('3090 Ti'), '3090 Ti');
  for (const bad of ['', 'gpu:mac', 'a/b', 'a\\b', 'tab\there', 'two  spaces', 'x'.repeat(49)]) {
    assert.strictEqual(codeOf(() => validateServerName(bad)), 'invalid_name', `"${bad}"`);
  }
});

check('refuses a corrupt file and never overwrites it', () => {
  const file = path.join(tempDir(), REGISTRY_FILE);
  fs.writeFileSync(file, '{ not json');
  const registry = new ServerRegistry(file);
  assert.strictEqual(codeOf(() => registry.list()), 'corrupt_registry');
  assert.strictEqual(codeOf(() => registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A })), 'corrupt_registry');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ not json');
  fs.writeFileSync(file, JSON.stringify({ servers: [{ name: 'mac', url: 'http://x:1' }] }));
  assert.strictEqual(codeOf(() => registry.list()), 'corrupt_registry');
});

check('removes a server, keeps the (now empty) file, and refuses to remove one it does not have', () => {
  const registry = new ServerRegistry(path.join(tempDir(), REGISTRY_FILE));
  registry.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  assert.strictEqual(registry.remove('mac').name, 'mac');
  assert.deepStrictEqual(registry.list(), []);
  // The file stays: an empty registry that EXISTS is a user who removed a server on purpose.
  assert.strictEqual(registry.exists(), true);
  assert.strictEqual(codeOf(() => registry.remove('mac')), 'unknown_server');
});

// ── the choice: {selected, fastServer, paused} ────────────────────────────

function routingFile() {
  return path.join(tempDir(), ROUTING_FILE);
}

check('with no record: the only server is selected; with several none is, and selectedServer() refuses by name', () => {
  const routing = new Routing(routingFile());
  assert.deepStrictEqual(routing.view(['mac']), {
    servers: [{ name: 'mac', selected: true, fast: false, paused: false }], selected: 'mac', missing: null, fastServer: null,
  });
  assert.strictEqual(routing.selectedServer(['mac']), 'mac');
  assert.strictEqual(routing.view(['mac', 'pc']).selected, null);
  assert.throws(() => routing.selectedServer(['mac', 'pc']), /No Crucible server is selected/);
  assert.strictEqual(codeOf(() => routing.selectedServer([])), 'no_selected_server');
});

check('selects one server, refusing a name it does not know', () => {
  const routing = new Routing(routingFile());
  const view = routing.select('pc', ['mac', 'pc']);
  assert.deepStrictEqual(view.servers.map((row) => [row.name, row.selected]), [['mac', false], ['pc', true]]);
  assert.strictEqual(routing.selectedServer(['mac', 'pc']), 'pc');
  assert.strictEqual(codeOf(() => routing.select('ghost', ['mac', 'pc'])), 'unknown_server');
});

check('the first server added is selected; a later one is not, even when the first was only implied', () => {
  const routing = new Routing(routingFile());
  routing.added('mac', ['mac']);
  assert.deepStrictEqual(routing.read(), { selected: 'mac', fastServer: null, paused: [], recorded: true });
  routing.added('pc', ['mac', 'pc']);
  assert.strictEqual(routing.selectedServer(['mac', 'pc']), 'mac');

  const implied = new Routing(routingFile());
  assert.strictEqual(implied.view(['mac']).selected, 'mac');
  implied.added('pc', ['mac', 'pc']);
  assert.strictEqual(implied.selectedServer(['mac', 'pc']), 'mac');
});

check('never picks another server on its own: removing the selected one leaves none, and a vanished one is reported', () => {
  const routing = new Routing(routingFile());
  routing.select('pc', ['mac', 'pc']);
  routing.removed('pc');
  assert.deepStrictEqual(routing.view(['mac']), {
    servers: [{ name: 'mac', selected: false, fast: false, paused: false }], selected: null, missing: null, fastServer: null,
  });
  assert.throws(() => routing.selectedServer(['mac']), /No Crucible server is selected/);

  routing.select('mac', ['mac']);
  assert.strictEqual(routing.view(['pc']).missing, 'mac');
  assert.throws(() => routing.selectedServer(['pc']), /"mac" isn't connected any more/);
});

check('the fast pin: a single choice, never a default, cleared when its server is removed, refused by name when unset', () => {
  const routing = new Routing(routingFile());
  const known = ['mac', 'owens-pc'];
  routing.added('mac', ['mac']);
  assert.strictEqual(routing.view(known).fastServer, null);
  assert.strictEqual(codeOf(() => routing.fastServer(known)), 'no_fast_server');
  routing.setFast('owens-pc', known);
  assert.strictEqual(routing.fastServer(known), 'owens-pc');
  // Pinning does not move the selection: fast is per item, the selection is for everything else.
  assert.strictEqual(routing.selectedServer(known), 'mac');
  assert.deepStrictEqual(routing.view(known).servers.map((row) => [row.name, row.selected, row.fast]), [['mac', true, false], ['owens-pc', false, true]]);
  routing.setFast(null, known);
  assert.strictEqual(routing.view(known).fastServer, null);
  routing.setFast('owens-pc', known);
  routing.removed('owens-pc');
  assert.strictEqual(routing.view(['mac']).fastServer, null);
  assert.strictEqual(codeOf(() => routing.setFast('ghost', ['mac'])), 'unknown_server');
});

check('pinning fast on an implied selection writes the selection down with it, so nothing is un-selected', () => {
  const routing = new Routing(routingFile());
  routing.setFast('mac', ['mac']);
  assert.deepStrictEqual(routing.read(), { selected: 'mac', fastServer: 'mac', paused: [], recorded: true });
});

check('Running/Paused: a paused server stays selected (work waits for it), and removing it clears the pause', () => {
  const routing = new Routing(routingFile());
  const known = ['mac', 'owens-pc'];
  routing.added('mac', ['mac']);
  routing.setPaused('mac', true, known);
  assert.strictEqual(routing.selectedServer(known), 'mac');
  assert.deepStrictEqual(routing.view(known).servers.map((row) => [row.name, row.paused]), [['mac', true], ['owens-pc', false]]);
  routing.setPaused('mac', false, known);
  assert.strictEqual(routing.view(known).servers[0].paused, false);
  routing.setPaused('owens-pc', true, known);
  routing.removed('owens-pc');
  assert.deepStrictEqual(routing.read().paused, []);
  assert.strictEqual(codeOf(() => routing.setPaused('ghost', true, known)), 'unknown_server');
});

check('reads the pre-ruling ranked record as its first running server, its disabled list as paused; refuses a corrupt one', () => {
  const file = routingFile();
  fs.writeFileSync(file, JSON.stringify({ order: ['mac', 'pc'], disabled: ['mac'], newJobsWaitFor: 'any' }));
  assert.deepStrictEqual(new Routing(file).read(), { selected: 'pc', fastServer: null, paused: ['mac'], recorded: false });
  assert.strictEqual(new Routing(file).selectedServer(['mac', 'pc']), 'pc');
  fs.writeFileSync(file, JSON.stringify({ order: 'mac', disabled: [] }));
  assert.strictEqual(codeOf(() => new Routing(file).read()), 'corrupt_routing');
  fs.writeFileSync(file, JSON.stringify({ selected: 7 }));
  assert.strictEqual(codeOf(() => new Routing(file).read()), 'corrupt_routing');
  fs.writeFileSync(file, JSON.stringify({ selected: 'mac', paused: 'mac' }));
  assert.strictEqual(codeOf(() => new Routing(file).read()), 'corrupt_routing');
  fs.writeFileSync(file, '{ nope');
  assert.strictEqual(codeOf(() => new Routing(file).view(['mac'])), 'corrupt_routing');
  assert.strictEqual(fs.readFileSync(file, 'utf8'), '{ nope');
});

check('the routing write is temp-then-rename too', () => {
  const file = routingFile();
  new Routing(file).select('mac', ['mac']);
  assert.deepStrictEqual(fs.readdirSync(path.dirname(file)), [ROUTING_FILE]);
});

// ── the seam: registry + choice, announced ─────────────────────────────────

check('survives a restart: the selection, the fast pin and removals are read back by a new instance', () => {
  const dir = tempDir();
  const first = new CrucibleServers(dir);
  first.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  first.add({ name: 'owens-pc', url: 'http://100.64.0.9:7100', token: TOKEN_B });
  first.add({ name: 'droplet', url: 'https://droplet.example:7100', token: TOKEN_B });
  assert.strictEqual(first.selected(), 'mac');
  first.setFast('owens-pc');
  first.select('droplet');
  first.remove('mac');

  const second = new CrucibleServers(dir);
  assert.deepStrictEqual(second.names(), ['owens-pc', 'droplet']);
  assert.strictEqual(second.selected(), 'droplet');
  assert.strictEqual(second.fastServer(), 'owens-pc');
  assert.deepStrictEqual(JSON.parse(fs.readFileSync(path.join(dir, ROUTING_FILE), 'utf8')), { selected: 'droplet', fastServer: 'owens-pc', paused: [] });
});

check('announces every write to the renderer and to in-process listeners, never with a token', () => {
  const emitted = [];
  const heard = [];
  const servers = new CrucibleServers(tempDir(), (change) => emitted.push(change));
  servers.onChange((change) => heard.push(change));
  servers.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  servers.add({ name: 'pc', url: 'http://10.0.0.2:7100', token: TOKEN_B });
  servers.select('pc');
  servers.setFast('pc');
  servers.setPaused('mac', true);
  servers.setPaused('mac', false);
  servers.remove('mac');
  assert.deepStrictEqual(emitted.map((p) => p.reason), ['added', 'added', 'selected', 'fast', 'paused', 'resumed', 'removed']);
  assert.deepStrictEqual(heard, emitted);
  assert.ok(!JSON.stringify(emitted).includes(TOKEN_A));
});

check('a listener that throws does not stop the write or the other listeners', () => {
  const heard = [];
  const servers = new CrucibleServers(tempDir());
  servers.onChange(() => { throw new Error('a broken listener'); });
  servers.onChange((change) => heard.push(change.reason));
  servers.add({ name: 'mac', url: 'http://127.0.0.1:7100', token: TOKEN_A });
  assert.deepStrictEqual(heard, ['added']);
  assert.deepStrictEqual(servers.names(), ['mac']);
});

run('crucible: the servers registry and the choice');
