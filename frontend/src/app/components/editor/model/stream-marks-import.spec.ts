// The stream-marks arithmetic, tested where it is pure. Jasmine/Karma, matching the two
// existing specs in this frontend (app.spec.ts, services/electron.spec.ts).

import {
  buildImportRows,
  formatElapsed,
  formatSignedOffset,
  marksToStorySpans,
  offsetForMarkAtPlayhead,
  parseElapsed,
  parseSignedOffset,
  StreamMarkInput,
} from './stream-marks-import';

const mark = (id: string, at: number, label = ''): StreamMarkInput => ({ id, at, label });

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
  const marks = [mark('a', 600, 'fox news'), mark('b', 1500, 'intelligent design')];

  it('shifts every span by the offset', () => {
    const rows = buildImportRows(marks, 120, 3600);
    expect(rows[0].start).toBe(120);
    expect(rows[0].end).toBe(720);
    expect(rows[1].start).toBe(720);
    expect(rows[1].end).toBe(1620);
    expect(rows.every((r) => r.state === 'inside')).toBe(true);
  });

  it('clamps a span that starts before the timeline and says so', () => {
    const rows = buildImportRows(marks, -300, 3600);
    expect(rows[0].state).toBe('clamped');
    expect(rows[0].rawStart).toBe(-300);
    expect(rows[0].start).toBe(0);
    expect(rows[0].end).toBe(300);
    expect(rows[0].reason).toContain('00:00:00');
  });

  it('clamps a span that runs past the end', () => {
    const rows = buildImportRows(marks, 0, 1000);
    expect(rows[1].state).toBe('clamped');
    expect(rows[1].end).toBe(1000);
  });

  it('disables a span that is wholly off the timeline, with the reason', () => {
    const early = buildImportRows(marks, -5000, 3600);
    expect(early[0].state).toBe('outside');
    expect(early[0].reason).toContain('before');

    const late = buildImportRows(marks, 5000, 3600);
    expect(late[0].state).toBe('outside');
    expect(late[0].reason).toContain('past');
  });

  it('disables a zero-length story from two marks at the same second', () => {
    const rows = buildImportRows([mark('a', 600), mark('b', 600)], 0, 3600);
    expect(rows[1].state).toBe('empty');
    expect(rows[1].reason).toContain('no length');
  });

  it('refuses a timeline duration it cannot judge against', () => {
    expect(() => buildImportRows(marks, 0, 0)).toThrowError(/duration/);
    expect(() => buildImportRows(marks, Number.NaN, 3600)).toThrowError(/offset/);
  });
});

describe('offsetForMarkAtPlayhead', () => {
  it('puts the chosen mark under the playhead', () => {
    const offset = offsetForMarkAtPlayhead(600, 930);
    expect(offset).toBe(330);
    const rows = buildImportRows([mark('a', 600, 'fox news')], offset, 3600);
    expect(rows[0].end).toBe(930);
  });
});
