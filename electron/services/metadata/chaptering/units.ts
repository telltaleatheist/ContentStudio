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
  const timeAt = (ci: number): number => {
    for (const sp of spans) {
      if (ci < sp.lo) return sp.start;
      if (ci < sp.hi) return sp.start + ((sp.end - sp.start) * (ci - sp.lo)) / Math.max(1, sp.hi - sp.lo);
    }
    return spans[spans.length - 1].end;
  };
  const endAt = (ci: number): number => {
    for (const sp of spans) {
      if (ci <= sp.lo) return sp.start;
      if (ci <= sp.hi) return sp.start + ((sp.end - sp.start) * (ci - sp.lo)) / Math.max(1, sp.hi - sp.lo);
    }
    return spans[spans.length - 1].end;
  };
  const speakerAt = (ci: number): string | undefined => spans.find((sp) => ci < sp.hi)?.speaker;

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

/** Cut a run-on unit at caption boundaries into pieces of about `pieceWords` words. */
function cutAtCaptions(u: Located, full: string, spans: Span[], pieceWords: number): Located[] {
  const hits = spans.filter((sp) => sp.lo < u.hi && sp.hi > u.lo);
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
