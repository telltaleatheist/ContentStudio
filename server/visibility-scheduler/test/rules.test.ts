import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildStatusUpdate, isTransientStatus, isVideoId, isVisibility, parseRunAt, retryDelay, scheduleProblem } from '../src/rules.js';

const NOW = Date.parse('2026-11-02T12:00:00Z');

test('runAt needs an explicit zone', () => {
  assert.equal(parseRunAt('2026-11-03T15:00:00Z'), Date.parse('2026-11-03T15:00:00Z'));
  assert.equal(parseRunAt('2026-11-03T10:00-05:00'), Date.parse('2026-11-03T15:00:00Z'));
  assert.equal(typeof parseRunAt('2026-11-03T15:00:00'), 'string');
  assert.equal(typeof parseRunAt('next tuesday'), 'string');
  assert.equal(typeof parseRunAt(1730000000000), 'string');
  assert.equal(typeof parseRunAt('2026-13-45T99:00:00Z'), 'string');
});

test('a change must be a minute ahead and alone in its minute for the video', () => {
  assert.match(scheduleProblem(NOW + 30_000, 'aaaaaaaaaaa', [], NOW)!, /one minute/);
  assert.equal(scheduleProblem(NOW + 60_000, 'aaaaaaaaaaa', [], NOW), null);
  const at = Date.parse('2026-11-03T15:00:10Z');
  const other = { id: 'j1', videoId: 'aaaaaaaaaaa', runAt: Date.parse('2026-11-03T15:00:50Z') };
  assert.match(scheduleProblem(at, 'aaaaaaaaaaa', [other], NOW)!, /j1/);
  assert.equal(scheduleProblem(at, 'bbbbbbbbbbb', [other], NOW), null, 'another video may share the minute');
  assert.equal(scheduleProblem(at + 60_000, 'aaaaaaaaaaa', [other], NOW), null, 'the next minute is free');
});

const LIVE_STATUS = {
  uploadStatus: 'processed',
  privacyStatus: 'unlisted',
  license: 'youtube',
  embeddable: true,
  publicStatsViewable: false,
  madeForKids: false,
  selfDeclaredMadeForKids: false,
  containsSyntheticMedia: false,
};

test('the update keeps every writable field and changes only privacyStatus', () => {
  const u = buildStatusUpdate(LIVE_STATUS, 'public');
  assert.deepEqual(u.status, {
    license: 'youtube',
    embeddable: true,
    publicStatsViewable: false,
    selfDeclaredMadeForKids: false,
    containsSyntheticMedia: false,
    privacyStatus: 'public',
  });
  assert.equal(u.clearedYouTubeSchedule, false);
  assert.ok(!('uploadStatus' in u.status) && !('madeForKids' in u.status), 'read-only fields are not sent');
});

test("a YouTube-native publishAt survives a change to private and is removed otherwise", () => {
  const scheduled = { ...LIVE_STATUS, privacyStatus: 'private', publishAt: '2026-11-10T15:00:00Z' };
  const toUnlisted = buildStatusUpdate(scheduled, 'unlisted');
  assert.equal(toUnlisted.clearedYouTubeSchedule, true);
  assert.ok(!('publishAt' in toUnlisted.status));
  const toPrivate = buildStatusUpdate({ ...scheduled, privacyStatus: 'public' }, 'private');
  assert.equal(toPrivate.status.publishAt, '2026-11-10T15:00:00Z');
  assert.equal(toPrivate.clearedYouTubeSchedule, false);
});

test('fields YouTube did not return are not invented', () => {
  const u = buildStatusUpdate({ privacyStatus: 'public' }, 'unlisted');
  assert.deepEqual(u.status, { privacyStatus: 'unlisted' });
});

test('retries: 1, 2, 5, 10 minutes, then none', () => {
  assert.deepEqual([1, 2, 3, 4, 5].map(retryDelay), [60_000, 120_000, 300_000, 600_000, null]);
  assert.equal(isTransientStatus(undefined), true);
  assert.equal(isTransientStatus(503), true);
  assert.equal(isTransientStatus(429), true);
  assert.equal(isTransientStatus(403), false);
  assert.equal(isTransientStatus(400), false);
});

test('ids and visibilities', () => {
  assert.ok(isVideoId('6YgtZwpngvY'));
  assert.ok(!isVideoId('6YgtZwpngv'));
  assert.ok(!isVideoId('6YgtZwpngvY/../x'));
  assert.ok(isVisibility('unlisted'));
  assert.ok(!isVisibility('scheduled'));
});
