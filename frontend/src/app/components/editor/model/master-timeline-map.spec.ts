// The master↔timeline map, tested where it is pure. Jasmine/Karma, matching the other specs in
// this frontend (app.spec.ts, services/electron.spec.ts, model/stream-marks-import.spec.ts).
//
// These tests moved here WITH the code they cover (from stream-marks-import.spec.ts): the map is
// what the stream-marks import, and now the ribbon's shift-drag, both stand on.

import {
  masterKeptRange,
  masterToTimeline,
  orderSegmentsBySource,
  TimelineSegment,
  timelineToMaster,
} from './master-timeline-map';

/**
 * A three-piece timeline cut from a master, with the same shape as a real one: material
 * dropped before the first piece, between the pieces, and after the last.
 *
 *   master   10─30      50────80        100─110
 *   timeline  0─20      20────50         50─60
 *
 * So master 0-10, 30-50, 80-100 and everything past 110 is NOT on this timeline.
 */
const TABLE: TimelineSegment[] = [
  { sourceStart: 10, timelineStart: 0, duration: 20 },
  { sourceStart: 50, timelineStart: 20, duration: 30 },
  { sourceStart: 100, timelineStart: 50, duration: 10 },
];
const TABLE_DURATION = 60;

describe('orderSegmentsBySource', () => {
  it('sorts by sourceStart and keeps only the three numbers the map needs', () => {
    const ordered = orderSegmentsBySource([TABLE[2], TABLE[0], TABLE[1]]);
    expect(ordered.map((s) => s.sourceStart)).toEqual([10, 50, 100]);
    expect(ordered[0]).toEqual({ sourceStart: 10, timelineStart: 0, duration: 20 });
  });

  it('refuses a table with no segments, rather than mapping onto nothing', () => {
    expect(() => orderSegmentsBySource([])).toThrowError(/segment table/);
  });

  it('refuses a segment with no length', () => {
    expect(() => orderSegmentsBySource([{ sourceStart: 0, timelineStart: 0, duration: 0 }]))
      .toThrowError(/mappable piece/);
  });

  it('refuses a table whose pieces overlap in the master — one second, two places', () => {
    expect(() => orderSegmentsBySource([
      { sourceStart: 0, timelineStart: 0, duration: 20 },
      { sourceStart: 10, timelineStart: 20, duration: 20 },
    ])).toThrowError(/overlap/);
  });

  it('refuses a timeline that plays the master out of order', () => {
    expect(() => orderSegmentsBySource([
      { sourceStart: 0, timelineStart: 50, duration: 20 },
      { sourceStart: 100, timelineStart: 0, duration: 20 },
    ])).toThrowError(/out of order/);
  });
});

describe('masterToTimeline', () => {
  it('maps a second inside a kept piece exactly', () => {
    expect(masterToTimeline(TABLE, 10)).toEqual({ seconds: 0, inGap: false });
    expect(masterToTimeline(TABLE, 15)).toEqual({ seconds: 5, inGap: false });
    expect(masterToTimeline(TABLE, 60)).toEqual({ seconds: 30, inGap: false });
    expect(masterToTimeline(TABLE, 105)).toEqual({ seconds: 55, inGap: false });
  });

  it('puts a second from REMOVED material where the content resumes, and says so', () => {
    // The first frame the edit dropped is the moment the next kept piece begins.
    expect(masterToTimeline(TABLE, 30)).toEqual({ seconds: 20, inGap: true });
    expect(masterToTimeline(TABLE, 40)).toEqual({ seconds: 20, inGap: true });
    expect(masterToTimeline(TABLE, 90)).toEqual({ seconds: 50, inGap: true });
  });

  it('answers before the first kept frame with the start, and past the last with the end', () => {
    expect(masterToTimeline(TABLE, 0)).toEqual({ seconds: 0, inGap: true });
    expect(masterToTimeline(TABLE, 9.9)).toEqual({ seconds: 0, inGap: true });
    expect(masterToTimeline(TABLE, 110)).toEqual({ seconds: 60, inGap: true });
    expect(masterToTimeline(TABLE, 5000)).toEqual({ seconds: 60, inGap: true });
  });

  it('is not an offset: the same distance in the master is a different one on the timeline', () => {
    // 20 master seconds either side of a 20-second cut: 10→30 is 20 s of timeline, 30→50 is none.
    expect(masterToTimeline(TABLE, 30).seconds - masterToTimeline(TABLE, 10).seconds).toBe(20);
    expect(masterToTimeline(TABLE, 50).seconds - masterToTimeline(TABLE, 30).seconds).toBe(0);
  });

  it('refuses a table it cannot search, or a second it cannot map', () => {
    expect(() => masterToTimeline([], 5)).toThrowError(/segment table/);
    expect(() => masterToTimeline(TABLE, Number.NaN)).toThrowError(/finite/);
  });
});

describe('timelineToMaster', () => {
  it('is the exact inverse for every second that is ON the timeline', () => {
    for (let t = 0; t <= TABLE_DURATION; t += 0.25) {
      expect(masterToTimeline(TABLE, timelineToMaster(TABLE, t)).seconds).toBe(t);
    }
  });

  it('maps the pieces back to where they came from', () => {
    expect(timelineToMaster(TABLE, 0)).toBe(10);
    expect(timelineToMaster(TABLE, 5)).toBe(15);
    expect(timelineToMaster(TABLE, 20)).toBe(50);
    expect(timelineToMaster(TABLE, 50)).toBe(100);
  });

  it('answers past the end with the last kept frame, and before the start with the first', () => {
    expect(timelineToMaster(TABLE, 60)).toBe(110);
    expect(timelineToMaster(TABLE, 1000)).toBe(110);
    expect(timelineToMaster(TABLE, -5)).toBe(10);
  });
});

describe('masterKeptRange', () => {
  it('reports the master seconds the timeline is made of', () => {
    expect(masterKeptRange(TABLE)).toEqual({ from: 10, to: 110 });
  });

  it('is what a set-sized delta is clamped against: inside it, nothing collapses', () => {
    // Two boundaries 40 master seconds apart, shifted by the largest delta the range allows.
    const lo = 20;
    const hi = 60;
    const delta = masterKeptRange(TABLE).to - hi;          // +50, the most the set can travel
    expect(masterToTimeline(TABLE, lo + delta).seconds).toBe(40);
    expect(masterToTimeline(TABLE, hi + delta).seconds).toBe(60);
    // Past that they would BOTH pile onto the timeline's end, which is the collapse the clamp
    // exists to prevent.
    expect(masterToTimeline(TABLE, lo + delta + 100).seconds).toBe(60);
    expect(masterToTimeline(TABLE, hi + delta + 100).seconds).toBe(60);
  });

  it('refuses an empty table', () => {
    expect(() => masterKeptRange([])).toThrowError(/segment table/);
  });
});
