// Turning stream marks into stories: the arithmetic, on its own.
//
// Pure — no Angular, no component state, no host. Two very different screens depend on this
// being one implementation: the Stream marks tab in the main window (typing an elapsed time
// into a row) and the editor's import dialog (the same times, mapped onto a timeline). A
// second copy of the hh:mm:ss parser is the kind of pair that agrees until the day one of
// them learns to accept "1:2:3" (LEDGER law 10).
//
// THE OTHER IDEA WORTH KNOWING: the timeline is NOT the recording. Three clocks meet here (the
// stream's elapsed seconds, the master file's seconds, the timeline's seconds) and only the
// first two are separated by a constant; the third is reached through the segment table, which
// lives in model/master-timeline-map.ts because it is a property of the TIMELINE and not of
// stream marks. Read that file's map comment before touching any arithmetic here.
//
// THE ONE IDEA WORTH KNOWING: a mark is a BOUNDARY, not a story. Owen presses the key when
// a story ENDS, so story i runs from the previous mark to mark i, and mark i's label names
// it. The material after the LAST mark is not a story — nothing has ended it.

import { masterToTimeline, type TimelineSegment } from './master-timeline-map';

/** Structural, so this file needs no import from editor-host.ts (which imports Angular). */
export interface StreamMarkInput {
  id: string;
  /** ELAPSED seconds since the session started. */
  at: number;
  label: string;
}

/** One story, still in the stream's own elapsed-seconds frame. */
export interface StorySpan {
  /** The mark that ENDED this story — the row's identity in the dialog. */
  markId: string;
  /** Stream order, 1-based. This becomes the story's place in the editor's list. */
  number: number;
  title: string;
  /**
   * True when `title` is the label Owen typed; false when it is the "Story N" placeholder.
   * The editor keeps a human-given title out of auto-titling's reach and a placeholder in it,
   * and the placeholder text alone cannot tell it which this is.
   */
  labelled: boolean;
  /** Elapsed seconds. */
  startAt: number;
  endAt: number;
}

/**
 * How a story span lands on the timeline once the marks are mapped.
 *
 *   inside   — the whole span is on the timeline, both ends landing in kept material.
 *   clamped  — it hangs off an end of the RECORDING; `start`/`end` are what gets created.
 *   outside  — none of it is on the timeline. The row is disabled with `reason`.
 *   empty    — it has no length on the timeline: two marks at the same second, or a whole
 *              story that lives inside material the edit removed. Disabled, and SAID.
 */
export type ImportRowState = 'inside' | 'clamped' | 'outside' | 'empty';

export interface ImportRow {
  markId: string;
  number: number;
  title: string;
  /** See StorySpan.labelled. */
  labelled: boolean;
  /** The span in the STREAM's own elapsed seconds — what Owen's key presses said. */
  startAt: number;
  endAt: number;
  /** The same two boundaries in MASTER seconds (elapsed + streamStartInMaster). */
  masterStart: number;
  masterEnd: number;
  /** Timeline seconds — the mapped position of each boundary. What would be created. */
  start: number;
  end: number;
  /**
   * True when that boundary's master second is not on the timeline: it fell in removed
   * material (or off an end of the kept range), so it landed where content resumes instead.
   * Shown on the row — a boundary nobody chose is exactly what this feature must not do
   * silently.
   */
  startInGap: boolean;
  endInGap: boolean;
  state: ImportRowState;
  /** Why this row is disabled or flagged. Null exactly when the state is not one of those. */
  reason: string | null;
  /** The in-gap sentence, when either end landed in removed material. Null otherwise. */
  gapNote: string | null;
}

const ELAPSED_RE = /^(\d{1,3}):([0-5]\d):([0-5]\d)$/;
const SIGNED_RE = /^([+-]?)(\d{1,3}):([0-5]\d):([0-5]\d)$/;

/**
 * Strict hh:mm:ss → seconds. Returns null for ANYTHING else, including "90" and "1:2:3".
 *
 * Null rather than a throw because the caller is a text field being typed into, and the
 * answer it needs is "that is not a time" shown next to the field. Null is never coerced to
 * a number by any caller here — a row that will not parse keeps the text the operator typed
 * and changes nothing on disk.
 */
export function parseElapsed(text: string): number | null {
  const m = ELAPSED_RE.exec((text || '').trim());
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]);
}

/** Seconds → hh:mm:ss, hours zero-padded to two. Negative input is an error, not a format. */
export function formatElapsed(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    throw new Error(`formatElapsed needs a finite number of seconds, got ${JSON.stringify(seconds)}.`);
  }
  const total = Math.max(0, Math.round(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  return `${pad2(h)}:${pad2(m)}:${pad2(s)}`;
}

/**
 * Strict ±hh:mm:ss → seconds, for the field that holds `streamStartInMaster`. A missing sign
 * means positive.
 *
 * That number legitimately goes both ways: the stream can have started after the recording did
 * (positive — the usual case, the camera rolls first) or before it (negative, when a stream is
 * recovered from a part-way restart), so the sign carries meaning and is not decoration.
 */
export function parseSignedOffset(text: string): number | null {
  const m = SIGNED_RE.exec((text || '').trim());
  if (!m) return null;
  const magnitude = Number(m[2]) * 3600 + Number(m[3]) * 60 + Number(m[4]);
  return m[1] === '-' ? -magnitude : magnitude;
}

/** Seconds → ±hh:mm:ss. The sign is ALWAYS shown, so a positive offset cannot be misread. */
export function formatSignedOffset(seconds: number): string {
  if (!Number.isFinite(seconds)) {
    throw new Error(`formatSignedOffset needs a finite number of seconds, got ${JSON.stringify(seconds)}.`);
  }
  const rounded = Math.round(seconds);
  const sign = rounded < 0 ? '-' : '+';
  return sign + formatElapsed(Math.abs(rounded));
}

function pad2(n: number): string {
  return n < 10 ? `0${n}` : String(n);
}

/**
 * Marks → stories, in the stream's own frame.
 *
 * Story 1 starts at elapsed 0 (the stream's start, not the first mark) and ends at the
 * first mark; every later story runs from the previous mark to its own. An empty label
 * becomes "Story N" — the same placeholder the editor's own ⌘S gives a new story, so a
 * mark nobody got round to naming looks like a story nobody got round to naming.
 *
 * Input order is irrelevant: the marks are sorted by time here, because the time is the
 * boundary and a list out of order would produce overlapping stories.
 */
export function marksToStorySpans(marks: StreamMarkInput[]): StorySpan[] {
  const sorted = marks.slice().sort((a, b) => a.at - b.at);
  return sorted.map((mark, i) => ({
    markId: mark.id,
    number: i + 1,
    title: mark.label.trim() === '' ? `Story ${i + 1}` : mark.label.trim(),
    labelled: mark.label.trim() !== '',
    startAt: i === 0 ? 0 : sorted[i - 1].at,
    endAt: mark.at,
  }));
}

/**
 * Where the stream's clock zero has to sit in the master for `markAt` to land on `masterSeconds`.
 *
 * This is "Selected mark = playhead" in one line, and the drag's arithmetic too: both say
 * "put THIS boundary exactly HERE", and the constant is what that demand works out to. The
 * caller maps the timeline position it is aiming at through `timelineToMaster` first — the
 * demand is about a place in the recording, never a place on the timeline.
 */
export function streamStartForMarkAtMaster(markAt: number, masterSeconds: number): number {
  return masterSeconds - markAt;
}

/**
 * Story spans, mapped onto the timeline and judged against it.
 *
 * `streamStartInMaster` is WHERE THE STREAM CLOCK'S ZERO SITS IN THE MASTER FILE, in master
 * seconds — not a timeline offset. A mark at elapsed `at` is the master second
 * `at + streamStartInMaster`, and that second goes through `masterToTimeline` to reach the
 * timeline. The constant is one number for the whole night because the stream's clock and the
 * recording's clock both ran in real time; everything non-linear between them is the edit, and
 * the edit is in the segment table.
 *
 * `segments` must already be ordered by sourceStart (orderSegmentsBySource) — this runs on
 * every mouse move of a drag.
 *
 * Nothing is clamped silently: a boundary that fell in removed material says so (`gapNote`),
 * a story that hangs off an end says so (`clamped`), and a story with no length on this
 * timeline — the two marks were the same second, or the whole story is inside material the
 * edit removed — is refused with the reason rather than created as a sliver.
 */
export function buildImportRows(
  marks: StreamMarkInput[],
  streamStartInMaster: number,
  segments: readonly TimelineSegment[],
  timelineDuration: number
): ImportRow[] {
  if (!Number.isFinite(streamStartInMaster)) {
    throw new Error(
      `buildImportRows needs a finite streamStartInMaster, got ${JSON.stringify(streamStartInMaster)}.`
    );
  }
  if (segments.length === 0) {
    throw new Error('buildImportRows needs the timeline\'s segment table; it was empty.');
  }
  if (!Number.isFinite(timelineDuration) || timelineDuration <= 0) {
    throw new Error(
      `buildImportRows needs the timeline's duration in seconds, got ${JSON.stringify(timelineDuration)}.`
    );
  }
  const first = segments[0];
  const last = segments[segments.length - 1];
  const keptFrom = first.sourceStart;
  const keptTo = last.sourceStart + last.duration;
  const timelineEnd = last.timelineStart + last.duration;
  // The two facts about the timeline arrive from different places (the segment table and the
  // manifest's own timelineDuration) and one contradicting the other means the map is not of
  // this timeline. Measured on the real session they agree to 0.6 s — the tail the last
  // segment does not cover — so the test is "runs PAST", not "differs".
  if (timelineEnd > timelineDuration + 1e-6) {
    throw new Error(
      `The timeline's segments end at ${fixed(timelineEnd)} s but the timeline is only ` +
      `${fixed(timelineDuration)} s long, so this segment table is not this timeline's.`
    );
  }

  return marksToStorySpans(marks).map((span) => {
    const masterStart = span.startAt + streamStartInMaster;
    const masterEnd = span.endAt + streamStartInMaster;
    const startMap = masterToTimeline(segments, masterStart);
    const endMap = masterToTimeline(segments, masterEnd);
    const base = {
      markId: span.markId, number: span.number, title: span.title, labelled: span.labelled,
      startAt: span.startAt, endAt: span.endAt,
      masterStart, masterEnd,
      start: startMap.seconds, end: endMap.seconds,
      startInGap: startMap.inGap, endInGap: endMap.inGap,
    };
    // A boundary that is in a gap because it is off the END of the kept material gets no note:
    // the row's own reason ('clamped' or 'outside') already says that, in the words that fit it,
    // and two sentences saying the same thing is how an operator learns to skim both.
    const startsBefore = masterStart < keptFrom;
    const endsAfter = masterEnd > keptTo;
    const gapNote = gapNoteFor(startMap.inGap && !startsBefore, endMap.inGap && !endsAfter);

    if (masterEnd <= masterStart) {
      return {
        ...base, end: base.start, state: 'empty' as ImportRowState,
        reason: 'This mark is at the same time as the one before it, so the story has no length.',
        gapNote,
      };
    }
    if (masterEnd <= keptFrom) {
      return {
        ...base, state: 'outside' as ImportRowState,
        reason: `This story ended before the first frame the edit kept (${fixed(keptFrom)} s into ` +
          'the recording), so none of it is on this timeline.',
        gapNote: null,
      };
    }
    if (masterStart >= keptTo) {
      return {
        ...base, state: 'outside' as ImportRowState,
        reason: `This story began after the last frame the edit kept (${fixed(keptTo)} s into the ` +
          'recording), so none of it is on this timeline.',
        gapNote: null,
      };
    }
    if (base.end <= base.start) {
      return {
        ...base, state: 'empty' as ImportRowState,
        reason: 'Every second of this story is inside material the edit removed, so there is ' +
          'nothing on this timeline to create.',
        gapNote: null,
      };
    }
    // The segment table is the timeline, so a mapped second is already within it; this test is
    // about the STORY hanging off an end of the RECORDING, which is a real outcome the operator
    // has to see before Apply.
    if (startsBefore || endsAfter) {
      return {
        ...base,
        state: 'clamped' as ImportRowState,
        reason: startsBefore
          ? 'This story began before the recording\'s first kept frame — it will start at the ' +
            'timeline\'s first frame.'
          : 'This story ran past the recording\'s last kept frame — it will end at the ' +
            'timeline\'s last frame.',
        // The OTHER end can still have landed in removed material, and that is worth saying.
        gapNote,
      };
    }
    return { ...base, state: 'inside' as ImportRowState, reason: null, gapNote };
  });
}

/** The one sentence a boundary that landed in removed material gets, or null. */
function gapNoteFor(startInGap: boolean, endInGap: boolean): string | null {
  if (!startInGap && !endInGap) return null;
  if (startInGap && endInGap) {
    return 'Both boundaries of this story fell in material the edit removed; each lands where ' +
      'the next kept piece starts.';
  }
  const which = startInGap ? 'This story\'s start fell' : 'This story\'s end fell';
  return `${which} in material the edit removed; it lands where the next kept piece starts.`;
}

/** One decimal, for a sentence about a place in a three-hour recording. */
function fixed(seconds: number): string {
  return (Math.round(seconds * 10) / 10).toFixed(1);
}
