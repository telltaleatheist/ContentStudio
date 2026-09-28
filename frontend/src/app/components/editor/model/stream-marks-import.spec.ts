// The stream-marks arithmetic, tested where it is pure. Jasmine/Karma, matching the two
// existing specs in this frontend (app.spec.ts, services/electron.spec.ts).

import {
  buildImportRows,
  formatElapsed,
  formatSignedOffset,
  marksToStorySpans,
  parseElapsed,
  parseSignedOffset,
  streamStartForMarkAtMaster,
  StreamMarkInput,
} from './stream-marks-import';
// The map moved to its own module (it is a property of the timeline, not of stream marks); the
// import rows still ride on it, so these tests still exercise the pair together.
import { TimelineSegment, timelineToMaster } from './master-timeline-map';

const mark = (id: string, at: number, label = ''): StreamMarkInput => ({ id, at, label });

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

describe('parseElapsed', () => {
  it('reads hh:mm:ss', () => {
    expect(parseElapsed('00:00:00')).toBe(0);
    expect(parseElapsed('01:12:33')).toBe(4353);
    expect(parseElapsed('1:02:03')).toBe(3723);
  });

  it('refuses anything else rather than coercing it', () => {
    expect(parseElapsed('90')).toBeNull();
    expect(parseElapsed('1:2:3')).toBeNull();
    expect(parseElapsed('01:60:00')).toBeNull();
    expect(parseElapsed('01:00:60')).toBeNull();
    expect(parseElapsed('')).toBeNull();
    expect(parseElapsed('-00:01:00')).toBeNull();
    expect(parseElapsed('12:34')).toBeNull();
  });

  it('round-trips with formatElapsed', () => {
    expect(formatElapsed(4353)).toBe('01:12:33');
    expect(parseElapsed(formatElapsed(9999))).toBe(9999);
  });
});

describe('parseSignedOffset', () => {
  it('carries the sign', () => {
    expect(parseSignedOffset('+00:01:00')).toBe(60);
    expect(parseSignedOffset('-00:01:00')).toBe(-60);
    expect(parseSignedOffset('00:01:00')).toBe(60);
  });

  it('always prints a sign', () => {
    expect(formatSignedOffset(60)).toBe('+00:01:00');
    expect(formatSignedOffset(-60)).toBe('-00:01:00');
    expect(formatSignedOffset(0)).toBe('+00:00:00');
  });
});

describe('marksToStorySpans', () => {
  it('treats marks as boundaries: story 1 starts at zero and ends at the first mark', () => {
    const spans = marksToStorySpans([mark('a', 600, 'fox news'), mark('b', 1500, 'intelligent design')]);
    expect(spans.length).toBe(2);
    expect(spans[0]).toEqual(jasmine.objectContaining({ number: 1, title: 'fox news', startAt: 0, endAt: 600 }));
    expect(spans[1]).toEqual(
      jasmine.objectContaining({ number: 2, title: 'intelligent design', startAt: 600, endAt: 1500 })
    );
  });

  it('leaves the material after the last mark out — nothing ended it', () => {
    const spans = marksToStorySpans([mark('a', 100)]);
    expect(spans.length).toBe(1);
    expect(spans[0].endAt).toBe(100);
  });

  it('names an unlabelled story the way the editor does', () => {
    const spans = marksToStorySpans([mark('a', 10), mark('b', 20, '  ')]);
    expect(spans[1].title).toBe('Story 2');
    expect(spans[1].labelled).toBe(false);
    expect(marksToStorySpans([mark('a', 10, 'fox news')])[0].labelled).toBe(true);
  });

  it('sorts by time, so an out-of-order list cannot produce overlaps', () => {
    const spans = marksToStorySpans([mark('b', 200, 'second'), mark('a', 100, 'first')]);
    expect(spans.map((s) => s.title)).toEqual(['first', 'second']);
    expect(spans[1].startAt).toBe(100);
  });
});

describe('buildImportRows', () => {
  const marks = [mark('a', 20, 'fox news'), mark('b', 70, 'intelligent design')];

  it('maps each boundary through the table instead of adding a constant to the timeline', () => {
    // The stream's zero sits 10 s into the master, so the marks are master 30 and master 80 —
    // both of them the first frame of a cut, which is why both land where content resumes.
    const rows = buildImportRows(marks, 10, TABLE, TABLE_DURATION);
    expect(rows[0].masterStart).toBe(10);
    expect(rows[0].masterEnd).toBe(30);
    expect(rows[0].start).toBe(0);
    expect(rows[0].end).toBe(20);
    expect(rows[1].start).toBe(20);
    expect(rows[1].end).toBe(50);
    // 50 stream seconds became 30 timeline seconds: the 20 s the edit removed in between.
    expect(rows[1].end - rows[1].start).toBe(30);
    expect(rows.every((r) => r.state === 'inside')).toBe(true);
  });

  it('keeps the stream\'s own times on the row, for the drag to grab a boundary by', () => {
    const rows = buildImportRows(marks, 10, TABLE, TABLE_DURATION);
    expect(rows[0].startAt).toBe(0);
    expect(rows[0].endAt).toBe(20);
    expect(rows[1].startAt).toBe(20);
    expect(rows[1].endAt).toBe(70);
  });

  it('says when a boundary landed in material the edit removed', () => {
    const rows = buildImportRows(marks, 10, TABLE, TABLE_DURATION);
    expect(rows[0].startInGap).toBe(false);
    expect(rows[0].endInGap).toBe(true);
    expect(rows[0].gapNote).toContain('removed');
    expect(rows[1].gapNote).toContain('Both boundaries');
    // A row with both ends in kept material says nothing — silence has to mean something.
    const clean = buildImportRows([mark('a', 5, 'x')], 10, TABLE, TABLE_DURATION);
    expect(clean[0].gapNote).toBeNull();
  });

  it('refuses a story that lives entirely inside removed material, and says why', () => {
    // Master 35→45 is wholly inside the 30-50 the edit dropped.
    const rows = buildImportRows([mark('a', 35), mark('b', 45)], 0, TABLE, TABLE_DURATION);
    expect(rows[1].state).toBe('empty');
    expect(rows[1].start).toBe(20);
    expect(rows[1].end).toBe(20);
    expect(rows[1].reason).toContain('removed');
  });

  it('clamps a story that began before the recording\'s first kept frame', () => {
    const rows = buildImportRows([mark('a', 15)], 0, TABLE, TABLE_DURATION);
    expect(rows[0].state).toBe('clamped');
    expect(rows[0].start).toBe(0);
    expect(rows[0].end).toBe(5);
    expect(rows[0].reason).toContain('first kept frame');
  });

  it('clamps a story that ran past the last kept frame', () => {
    const rows = buildImportRows([mark('a', 20), mark('b', 120)], 0, TABLE, TABLE_DURATION);
    expect(rows[1].state).toBe('clamped');
    expect(rows[1].end).toBe(60);
    expect(rows[1].reason).toContain('last kept frame');
  });

  it('disables a story that is wholly off the recording, with the reason', () => {
    const early = buildImportRows([mark('a', 5)], 0, TABLE, TABLE_DURATION);
    expect(early[0].state).toBe('outside');
    expect(early[0].reason).toContain('before');

    const late = buildImportRows([mark('a', 5)], 200, TABLE, TABLE_DURATION);
    expect(late[0].state).toBe('outside');
    expect(late[0].reason).toContain('after');
  });

  it('disables a zero-length story from two marks at the same second', () => {
    const rows = buildImportRows([mark('a', 20), mark('b', 20)], 10, TABLE, TABLE_DURATION);
    expect(rows[1].state).toBe('empty');
    expect(rows[1].reason).toContain('no length');
  });

  it('refuses inputs it cannot judge against', () => {
    expect(() => buildImportRows(marks, 0, TABLE, 0)).toThrowError(/duration/);
    expect(() => buildImportRows(marks, Number.NaN, TABLE, TABLE_DURATION))
      .toThrowError(/streamStartInMaster/);
    expect(() => buildImportRows(marks, 0, [], TABLE_DURATION)).toThrowError(/segment table/);
    // A table that runs past the timeline it claims to describe is not this timeline's.
    expect(() => buildImportRows(marks, 0, TABLE, 30)).toThrowError(/not this timeline/);
  });
});

describe('streamStartForMarkAtMaster', () => {
  it('puts the chosen mark on the master second the playhead is over', () => {
    // The playhead sits at timeline 25, which is master 55; the mark it names is 20 s into the
    // stream, so the stream started at master 35.
    const masterAtPlayhead = timelineToMaster(TABLE, 25);
    expect(masterAtPlayhead).toBe(55);
    const streamStart = streamStartForMarkAtMaster(20, masterAtPlayhead);
    expect(streamStart).toBe(35);
    const rows = buildImportRows([mark('a', 20, 'fox news')], streamStart, TABLE, TABLE_DURATION);
    expect(rows[0].end).toBe(25);
  });
});
