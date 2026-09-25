/**
 * Sentence units — the transcript cut into the things snap is asked about.
 *
 * A port of submap.py `sentences()` (docs/crucible/reference/submap.py), the splitter the
 * measured method ran on, plus two rules Briefcase added when it ran the same method on real
 * videos (Briefcase backend/src/scorer/chapters/units.ts):
 *
 *   1. SPLIT at sentence punctuation over the joined caption text (submap's regex), and —
 *      new here — at a speaker change between captions: the mic and the screen interleave in a
 *      two-track transcript, and a "sentence" that runs from the host into the footage is two
 *      people's words presented as one.
 *   2. FOLD a sentence under 4 words into the one that follows ("Okay.", "Yeah.") — submap's
 *      min_words. A short tail stays a unit of its own.
 *   3. CAP a run-on: a unit over 60 words or 30 s (whisper sometimes emits minutes with no
 *      punctuation; the screen track of a stream has none at all) is cut at caption boundaries
 *      into ~30-word pieces, a short remainder joining the piece before it.
 *
 * TIMES (Law 6: the model never emits one; code maps them). A unit's start is its first
 * character's time and its end its last character's, read off the caption that character sits
 * in, INTERPOLATED by character fraction through that caption — submap.py's rule, stated in
 * its docstring as an estimate. At a caption edge the time is the caption's own. On a
 * word-level transcript the captions are ~16 words (transcript-import.service.ts), so the
 * estimate is within a second or two; on whisper `base` captions of 5-17 s it can be several
 * seconds inside a caption. Briefcase chose the caption's start instead (early, never late);
 * this port keeps the reference's rule because it is the one the measurement ran on.
 */

import { SentenceUnit } from './types';

/** What a caption needs to have: a time pair (SRT "HH:MM:SS,mmm" strings, or seconds) and text. */
export interface CaptionLike {
  start: string | number;
  end: string | number;
  text: string;
  speaker?: string;
}

export interface UnitOptions {
  /** submap.py min_words: a sentence with fewer words folds into the next. Default 4; 0 disables. */
  minWords?: number;
  /** Run-on cap: a unit over this many words is cut. Default 60; 0 disables. */
  maxWords?: number;
  /** Run-on cap: a unit over this many seconds is cut. Default 30; 0 disables. */
  maxSeconds?: number;
  /** Target words per piece when a run-on is cut. Default 30. */
  pieceWords?: number;
}

export const DEFAULT_UNIT_OPTIONS: Required<UnitOptions> = { minWords: 4, maxWords: 60, maxSeconds: 30, pieceWords: 30 };

/** submap.py's sentence regex: up to and including the terminal punctuation and any closing quote/bracket. */
const SENTENCE = /[^.!?]+(?:[.!?]+["')\]]*|$)/g;

interface Span {
  lo: number;
  hi: number;
  start: number;
  end: number;
  speaker: string | undefined;
}

interface Located {
  lo: number;
  hi: number;
  text: string;
}

/**
 * What `chapter()` accepts as a transcript: captions already in hand, or one of the three
 * transcript files ContentStudio holds —
 *
 *   - `{ segments: [...] }`                    a whisper-style file (submap.py load_segments);
 *   - `{ contentItems: [{ srtSegments }] }`    the pipeline's cached transcript (the other shape
 *                                              load_segments reads);
 *   - `{ words: [...] }`                       the editor's word-level transcript
 *                                              (TRANSCRIPT-IMPORT-FORMAT.md): every word is a
 *                                              caption of its own, so a unit's times are its
 *                                              first and last WORD's, not an interpolation, and
 *                                              the track (mic / screen) is the speaker.
 */
export type TranscriptInput =
  | CaptionLike[]
  | { segments: CaptionLike[] }
  | { contentItems: Array<{ srtSegments?: CaptionLike[] }> }
  | { words: WordLike[] };

export interface WordLike {
  text: string;
  start?: number;
  end?: number;
  timelineStart?: number;
  timelineEnd?: number;
  track?: string;
  speaker?: string;
}

/**
 * The captions of a transcript, in time order. A shape that is none of the above is refused by
 * name: guessing at a transcript's fields would chapter the wrong words (Law 1).
 */
export function captionsOf(transcript: TranscriptInput): CaptionLike[] {
  if (Array.isArray(transcript)) return transcript;
  const t = transcript as Record<string, unknown>;
  if (Array.isArray(t.segments)) return t.segments as CaptionLike[];
  if (Array.isArray(t.contentItems)) {
    const first = (t.contentItems as Array<{ srtSegments?: CaptionLike[] }>)[0];
    if (!first || !Array.isArray(first.srtSegments)) {
      throw new Error('the transcript has contentItems but its first item carries no srtSegments');
    }
    return first.srtSegments;
  }
  if (Array.isArray(t.words)) {
    const words = (t.words as WordLike[])
      .map((w) => {
        const start = w.timelineStart ?? w.start;
        const end = w.timelineEnd ?? w.end ?? start;
        if (typeof start !== 'number' || typeof end !== 'number') {
          throw new Error(`a word of the transcript ("${String(w.text).slice(0, 40)}") has no start/end time`);
        }
        const speaker = w.speaker ?? w.track;
        return { start, end, text: String(w.text ?? ''), ...(speaker !== undefined ? { speaker: String(speaker) } : {}) };
      })
      .filter((w) => w.text.trim().length > 0);
    // Two tracks interleave in time: order by start, then by track so a tie is stable.
    words.sort((a, b) => a.start - b.start || (a.speaker ?? '').localeCompare(b.speaker ?? ''));
    return words;
  }
  throw new Error(`not a transcript this service reads: expected captions, segments, contentItems[0].srtSegments or words (got keys ${Object.keys(t).join(', ')})`);
}

/** SRT "HH:MM:SS,mmm" (or "HH:MM:SS.mmm") to seconds; a number passes through. */
export function srtSeconds(value: string | number): number {
  if (typeof value === 'number') return value;
  const m = /^(\d+):(\d+):(\d+)[,.](\d+)$/.exec(value.trim());
  if (!m) throw new Error(`not an SRT time: "${value}"`);
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3]) + Number(m[4]) / 1000;
}

/** Python's len(s.split()). */
export function wordCount(s: string): number {
  const t = s.trim();
  return t ? t.split(/\s+/).length : 0;
}

/**
 * The captions -> the unit list, in order, covering every word once. An empty transcript
 * gives an empty list; the caller decides what that means.
 */
export function sentenceUnits(captions: CaptionLike[], options: UnitOptions = {}): SentenceUnit[] {
  const o = { ...DEFAULT_UNIT_OPTIONS, ...options };

  // The joined character stream and the caption each character belongs to.
  const spans: Span[] = [];
  let full = '';
  for (const c of captions) {
    const text = (c.text || '').replace(/\s+/g, ' ').trim();
    if (!text) continue;
    if (full) full += ' ';
    spans.push({ lo: full.length, hi: full.length + text.length, start: srtSeconds(c.start), end: srtSeconds(c.end), speaker: c.speaker });
    full += text;
  }
  if (spans.length === 0) return [];

  // 1. sentences, never across a speaker change.
  const raw: Located[] = [];
  let blockStart = 0;
  for (let i = 1; i <= spans.length; i++) {
    const boundary = i === spans.length || spans[i].speaker !== spans[blockStart].speaker;
    if (!boundary) continue;
    const lo = spans[blockStart].lo;
    const hi = spans[i - 1].hi;
    const block = full.slice(lo, hi);
    SENTENCE.lastIndex = 0;
    let m: RegExpExecArray | null;
    while ((m = SENTENCE.exec(block)) !== null) {
      if (m[0].length === 0) {
        SENTENCE.lastIndex++;
        continue;
      }
      const lead = m[0].length - m[0].trimStart().length;
      const s = m[0].trim();
      if (s) raw.push({ lo: lo + m.index + lead, hi: lo + m.index + lead + s.length, text: s });
    }
    blockStart = i;
  }

  // 2. fold short sentences forward.
  const folded: Located[] = [];
  let pend: Located | null = null;
  for (const s0 of raw) {
    let s = s0;
    if (pend) {
      s = { lo: pend.lo, hi: s.hi, text: full.slice(pend.lo, s.hi) };
      pend = null;
    }
    if (o.minWords > 0 && wordCount(s.text) < o.minWords) {
      pend = s;
      continue;
    }
    folded.push(s);
  }
  if (pend) folded.push(pend);

  // 3. cap run-ons at caption boundaries.
  // submap.py time_at: the first caption not yet ended at `ci` holds it (interpolated) or
  // follows it (its start). Spans are in character order, so a binary search finds it: a
  // word-level transcript is ~30k captions and a linear scan per unit was quadratic.
  const timeAt = (ci: number): number => {
    const k = firstSpan(spans, (sp) => ci < sp.hi);
    if (k === spans.length) return spans[spans.length - 1].end;
    const sp = spans[k];
    if (ci < sp.lo) return sp.start;
    return sp.start + ((sp.end - sp.start) * (ci - sp.lo)) / Math.max(1, sp.hi - sp.lo);
  };
  const endAt = (ci: number): number => {
    const k = firstSpan(spans, (sp) => ci <= sp.hi);
    if (k === spans.length) return spans[spans.length - 1].end;
    const sp = spans[k];
    if (ci <= sp.lo) return sp.start;
    return sp.start + ((sp.end - sp.start) * (ci - sp.lo)) / Math.max(1, sp.hi - sp.lo);
  };
  const speakerAt = (ci: number): string | undefined => spans[firstSpan(spans, (sp) => ci < sp.hi)]?.speaker;

  const out: SentenceUnit[] = [];
  const push = (u: Located) => {
    const text = u.text.trim();
    if (!text) return;
    const unit: SentenceUnit = { index: out.length, start: timeAt(u.lo), end: endAt(u.hi), text };
    const speaker = speakerAt(u.lo);
    if (speaker !== undefined) unit.speaker = speaker;
    out.push(unit);
  };
  for (const u of folded) {
    const tooLong =
      (o.maxWords > 0 && wordCount(u.text) > o.maxWords) || (o.maxSeconds > 0 && endAt(u.hi) - timeAt(u.lo) > o.maxSeconds);
    if (!tooLong) {
      push(u);
      continue;
    }
    for (const piece of cutAtCaptions(u, full, spans, o.pieceWords)) push(piece);
  }
  return out;
}

/** The first span for which `pred` holds, given `pred` is false then true along the list; `spans.length` when none. */
function firstSpan(spans: readonly Span[], pred: (sp: Span) => boolean): number {
  let lo = 0;
  let hi = spans.length;
  while (lo < hi) {
    const mid = (lo + hi) >>> 1;
    if (pred(spans[mid])) hi = mid;
    else lo = mid + 1;
  }
  return lo;
}

/** Cut a run-on unit at caption boundaries into pieces of about `pieceWords` words. */
function cutAtCaptions(u: Located, full: string, spans: Span[], pieceWords: number): Located[] {
  const hits: Span[] = [];
  for (let k = firstSpan(spans, (sp) => sp.hi > u.lo); k < spans.length && spans[k].lo < u.hi; k++) hits.push(spans[k]);
  if (hits.length < 2) return [u];
  const pieces: Located[] = [];
  let group: Span[] = [];
  let words = 0;
  const flush = () => {
    if (group.length === 0) return;
    const lo = Math.max(u.lo, group[0].lo);
    const hi = Math.min(u.hi, group[group.length - 1].hi);
    if (full.slice(lo, hi).trim()) pieces.push({ lo, hi, text: full.slice(lo, hi) });
    group = [];
    words = 0;
  };
  for (const sp of hits) {
    group.push(sp);
    words += wordCount(full.slice(Math.max(u.lo, sp.lo), Math.min(u.hi, sp.hi)));
    if (words >= pieceWords) flush();
  }
  // A short remainder joins the previous piece rather than standing alone.
  if (group.length > 0 && pieces.length > 0 && words < pieceWords / 2) {
    const prev = pieces.pop()!;
    const hi = Math.min(u.hi, group[group.length - 1].hi);
    pieces.push({ lo: prev.lo, hi, text: full.slice(prev.lo, hi) });
    group = [];
  }
  flush();
  return pieces.length > 0 ? pieces : [u];
}
