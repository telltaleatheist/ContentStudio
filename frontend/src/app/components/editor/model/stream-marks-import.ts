// Turning stream marks into stories: the arithmetic, on its own.
//
// Pure — no Angular, no component state, no host. Two very different screens depend on this
// being one implementation: the Stream marks tab in the main window (typing an elapsed time
// into a row) and the editor's import dialog (the same times, offset onto a timeline). A
// second copy of the hh:mm:ss parser is the kind of pair that agrees until the day one of
// them learns to accept "1:2:3" (LEDGER law 10).
//
// THE ONE IDEA WORTH KNOWING: a mark is a BOUNDARY, not a story. Owen presses the key when
// a story ENDS, so story i runs from the previous mark to mark i, and mark i's label names
// it. The material after the LAST mark is not a story — nothing has ended it.

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
 * How a story span lands on the timeline once the offset is applied.
 *
 *   inside   — the whole span is within [0, timelineDuration].
 *   clamped  — it hangs off one end; `start`/`end` are the clamped values that get created.
 *   outside  — none of it is on the timeline. The row is disabled with `reason`.
 *   empty    — two marks at the same second, so the story has no length. Disabled.
 */
export type ImportRowState = 'inside' | 'clamped' | 'outside' | 'empty';

export interface ImportRow {
  markId: string;
  number: number;
  title: string;
  /** See StorySpan.labelled. */
  labelled: boolean;
  /** Timeline seconds BEFORE clamping — what the offset says, warts and all. */
  rawStart: number;
  rawEnd: number;
  /** Timeline seconds after clamping to [0, timelineDuration] — what would be created. */
  start: number;
  end: number;
  state: ImportRowState;
  /** Why this row is disabled or flagged. Null exactly when state is 'inside'. */
  reason: string | null;
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
 * Strict ±hh:mm:ss → seconds, for the offset field. A missing sign means positive.
 *
 * The offset legitimately goes both ways: the stream can have started before the master
 * recording did (negative) or after it (positive), so the sign carries meaning and is not
 * decoration.
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
 * The offset that would put `markAt` exactly under the playhead.
 *
 * This is the "Selected mark = playhead" button in one line, and it is the escape hatch for
 * every case the file dates cannot answer: park the playhead on the moment a story visibly
 * ends, say which mark that is, and the whole set slides into place.
 */
export function offsetForMarkAtPlayhead(markAt: number, playheadSeconds: number): number {
  return playheadSeconds - markAt;
}

/**
 * Story spans, offset onto the timeline and judged against its length.
 *
 * `offsetSeconds` = the stream's start in timeline coordinates, so a mark at elapsed `at`
 * sits at `at + offset`. It is one number for the whole session on purpose: the stream and
 * the recording ran on the same clock, so a single correction is all the error there is.
 *
 * Clamping happens HERE rather than at creation time so the dialog can show what will be
 * created before anything is created.
 */
export function buildImportRows(
  marks: StreamMarkInput[],
  offsetSeconds: number,
  timelineDuration: number
): ImportRow[] {
  if (!Number.isFinite(offsetSeconds)) {
    throw new Error(`buildImportRows needs a finite offset, got ${JSON.stringify(offsetSeconds)}.`);
  }
  if (!Number.isFinite(timelineDuration) || timelineDuration <= 0) {
    throw new Error(
      `buildImportRows needs the timeline's duration in seconds, got ${JSON.stringify(timelineDuration)}.`
    );
  }
  return marksToStorySpans(marks).map((span) => {
    const rawStart = span.startAt + offsetSeconds;
    const rawEnd = span.endAt + offsetSeconds;

    if (rawEnd <= rawStart) {
      return {
        markId: span.markId, number: span.number, title: span.title, labelled: span.labelled,
        rawStart, rawEnd, start: rawStart, end: rawStart,
        state: 'empty' as ImportRowState,
        reason: 'This mark is at the same time as the one before it, so the story has no length.',
      };
    }

    const start = Math.max(0, rawStart);
    const end = Math.min(timelineDuration, rawEnd);

    if (end <= start) {
      return {
        markId: span.markId, number: span.number, title: span.title, labelled: span.labelled,
        rawStart, rawEnd, start: rawStart, end: rawEnd,
        state: 'outside' as ImportRowState,
        reason: rawEnd <= 0
          ? 'Entirely before the start of the timeline at this offset.'
          : 'Entirely past the end of the timeline at this offset.',
      };
    }

    if (start !== rawStart || end !== rawEnd) {
      return {
        markId: span.markId, number: span.number, title: span.title, labelled: span.labelled,
        rawStart, rawEnd, start, end,
        state: 'clamped' as ImportRowState,
        reason: start !== rawStart
          ? 'Starts before the timeline does — it will be trimmed to 00:00:00.'
          : 'Runs past the end of the timeline — it will be trimmed to the last frame.',
      };
    }

    return {
      markId: span.markId, number: span.number, title: span.title, labelled: span.labelled,
      rawStart, rawEnd, start, end,
      state: 'inside' as ImportRowState,
      reason: null,
    };
  });
}
