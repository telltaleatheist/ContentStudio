/**
 * PARKING, AS PURE RULES (electron/crucible/parking.ts): which refusals park,
 * what each one waits for, and the no-loop rule, with the SDK's own error types
 * and no server at all.
 */
const { assert, crucible, check, run } = require('./_crucible-keeper');
const { CrucibleBusy, CrucibleLeased, CrucibleRefused } = require('@crucible/client');

const { parkRefusalOf, parkFor, observe, FOREIGN_PROCESS_FLOOR_BYTES } = crucible('parking');

const busy = () => new CrucibleBusy(409, 'server_busy', 'the lane is busy', {}, {
  holder: 'bookforge', jobId: 'job-9', jobType: 'tts', model: null, jobStatus: 'running', since: null, progress: 0.62, jobMessage: null,
});
const leased = () => new CrucibleLeased(409, 'leased', 'leased', {}, {
  leaseId: 'lease-7', kind: 'llm', holder: 'foundry', act: 'translate', since: null, expiresAt: '2026-09-25T03:12:00+00:00',
});
const read = (at, facts) => ({ at, acceptsWork: true, leaseId: null, accelerator: null, ...facts });
const job = { jobId: 'j1', server: 'mac', fast: false, stage: 'chapters' };

check('server_busy parks with the SDK\'s busyLine and waits on accepts_work', () => {
  const refusal = parkRefusalOf(busy());
  assert.strictEqual(refusal.code, 'server_busy');
  assert.strictEqual(refusal.line, busy().busyLine);
  assert.match(refusal.line, /^busy: bookforge, tts, 62% done$/);
  assert.deepStrictEqual(refusal.wait, { kind: 'accepts_work' });
});

check('leased parks with the SDK\'s leasedLine and waits on the lease, not on accepts_work', () => {
  const refusal = parkRefusalOf(leased());
  assert.strictEqual(refusal.code, 'leased');
  assert.match(refusal.line, /foundry, translate/);
  assert.deepStrictEqual(refusal.wait, { kind: 'lease_clear', leaseId: 'lease-7' });
  const park = parkFor(refusal, job, null, 100);
  assert.strictEqual(observe(park, read(200, { acceptsWork: true, leaseId: 'lease-7' })), false, 'accepting, still leased: waits');
  assert.strictEqual(observe(park, read(300, { leaseId: null })), true);
});

check('a refusal wrapped once on its way up is still read by its type, never by its message (Law 10)', () => {
  const wrapped = new Error('AI request failed', { cause: busy() });
  assert.strictEqual(parkRefusalOf(wrapped).code, 'server_busy');
  assert.strictEqual(parkRefusalOf(new Error('GPU busy: bookforge, tts 62% done')), null, 'a sentence that looks busy is not a refusal');
});

check('the card\'s memory: a measured shortfall parks until the room is back; "ever" and the Mac\'s sized pool fail', () => {
  const measured = new CrucibleRefused(409, 'insufficient_memory', 'cannot load it: needs 20 GiB, 8 GiB free', { needed_bytes: 20e9, free_bytes: 8e9 });
  const refusal = parkRefusalOf(measured);
  assert.deepStrictEqual([refusal.code, refusal.wait], ['insufficient_memory', { kind: 'room', neededBytes: 20e9 }]);
  const park = parkFor(refusal, job, null, 100);
  assert.strictEqual(observe(park, read(200, {})), false, 'no accelerator read: says nothing');
  assert.strictEqual(observe(park, read(300, { accelerator: { freeBytes: 12e9, unattributedBytes: 0, pids: [] } })), false);
  assert.strictEqual(observe(park, read(400, { accelerator: { freeBytes: 21e9, unattributedBytes: 0, pids: [] } })), true);
  const ever = new CrucibleRefused(409, 'insufficient_memory', 'cannot load it on this host, ever', { needed_bytes: 90e9, total_bytes: 24e9, free_bytes: null });
  const sized = new CrucibleRefused(409, 'insufficient_memory', 'this Mac gives a model 50 GiB', { needed_bytes: 60e9, room_bytes: 50e9, free_bytes: 40e9 });
  assert.strictEqual(parkRefusalOf(ever), null);
  assert.strictEqual(parkRefusalOf(sized), null);
});

check('a card another process holds parks until those processes are gone and the unattributed memory is under the server\'s floor', () => {
  const named = parkRefusalOf(new CrucibleRefused(409, 'accelerator_busy', 'held by game.exe', { processes: [{ pid: 4242, name: 'game.exe', used_bytes: 9e9 }] }));
  assert.deepStrictEqual(named.wait, { kind: 'foreign_gone', pids: [4242], unattributedBytes: null });
  const park = parkFor(named, job, null, 100);
  assert.strictEqual(observe(park, read(200, { accelerator: { freeBytes: 1e9, unattributedBytes: 0, pids: [4242] } })), false);
  assert.strictEqual(observe(park, read(300, { accelerator: { freeBytes: 20e9, unattributedBytes: 0, pids: [] } })), true);
  const stray = parkFor(parkRefusalOf(new CrucibleRefused(409, 'accelerator_busy', '17 GiB unattributed', { unattributed_bytes: 17e9 })), job, null, 100);
  assert.strictEqual(observe(stray, read(200, { accelerator: { freeBytes: 1e9, unattributedBytes: 17e9, pids: [] } })), false);
  assert.strictEqual(observe(stray, read(300, { accelerator: { freeBytes: 20e9, unattributedBytes: FOREIGN_PROCESS_FLOOR_BYTES, pids: [] } })), true);
});

check('everything else is not a park: a misconfiguration fails by name', () => {
  for (const code of ['unknown_model', 'model_not_installed', 'upstream_unconfigured', 'context_over_limit', 'invalid_request']) {
    assert.strictEqual(parkRefusalOf(new CrucibleRefused(400, code, code, null)), null, code);
  }
});

check('NO LOOP: only a read taken after the park counts', () => {
  const park = parkFor(parkRefusalOf(busy()), job, null, 1_000);
  assert.strictEqual(observe(park, read(999, { acceptsWork: true })), false, 'a read from before the park');
  assert.strictEqual(observe(park, read(1_000, { acceptsWork: true })), false, 'a read at the same instant');
  assert.strictEqual(observe(park, read(1_001, { acceptsWork: false })), false);
  assert.strictEqual(observe(park, read(1_002, { acceptsWork: true })), true);
});

check('NO LOOP: when the door refused while the preflight said free, re-admission needs an edge (held, then clear)', () => {
  const park = parkFor(parkRefusalOf(busy()), job, read(900, { acceptsWork: true }), 1_000);
  assert.strictEqual(park.needsEdge, true);
  for (let t = 1_001; t < 1_020; t += 1) {
    assert.strictEqual(observe(park, read(t, { acceptsWork: true })), false, `still "free" at ${t}: the same disagreement, not a change`);
  }
  assert.strictEqual(observe(park, read(1_020, { acceptsWork: false })), false);
  assert.strictEqual(observe(park, read(1_021, { acceptsWork: true })), true, 'a real change on the server');
});

check('an unstated accepts_work is read as not accepting (1.0.25 nullability), never as free', () => {
  const park = parkFor(parkRefusalOf(busy()), job, null, 1_000);
  assert.strictEqual(observe(park, read(1_001, { acceptsWork: null })), false);
});

run('crucible: parking rules');
