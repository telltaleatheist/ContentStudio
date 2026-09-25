/**
 * Pieces -> chapters: the Viterbi path's runs, with their times read off the sentence units
 * (Law 6). Ported from Briefcase segmenter.ts piecesToChapters.
 *
 * The first chapter starts at 0 — YouTube needs a 0:00 marker, and the run's first unit may
 * start a few seconds in — and every other chapter starts where its first unit starts. A
 * chapter ends where the next begins; the last ends at the transcript's end (or the media
 * duration when the caller knows it). Adjacent ad pieces (two chunks each saw the tail of one
 * sponsor read) are one chapter.
 */

import { Piece } from './chunks';
import { SentenceUnit } from './types';

export interface Span {
  startSec: number;
  endSec: number;
  unitRange: [number, number];
  label: string;
  isAd: boolean;
}

export function piecesToSpans(pieces: readonly Piece[], units: readonly SentenceUnit[], totalSeconds?: number): Span[] {
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if (last && last.end === p.start && last.isAd && p.isAd) last.end = p.end;
    else merged.push({ ...p });
  }
  const end = totalSeconds ?? (units.length ? units[units.length - 1].end : 0);
  return merged.map((p, c) => {
    const startSec = c === 0 ? 0 : units[p.start].start;
    const next = merged[c + 1];
    return {
      startSec,
      endSec: next ? units[next.start].start : Math.max(end, startSec),
      unitRange: [p.start, p.end] as [number, number],
      label: p.label,
      isAd: p.isAd,
    };
  });
}

/**
 * Children of a parent span from a run over the parent's own units (unit ranges relative to
 * the section). They tile the parent exactly: the first starts at the parent's start, the
 * last ends at its end, every inner boundary is a unit start clamped into the parent's span.
 * A zero-length child gives its units to a neighbour, and two neighbours left with one label
 * become one child. (Briefcase chapter-tree.ts childrenOf.)
 */
export function childrenOf(parent: Span, sub: readonly Span[], units: readonly SentenceUnit[]): Span[] {
  const a = parent.unitRange[0];
  const clamp = (t: number) => Math.min(parent.endSec, Math.max(parent.startSec, t));
  const kids: Span[] = sub.map((c, k) => {
    const unitRange: [number, number] = [a + c.unitRange[0], a + c.unitRange[1]];
    return {
      startSec: k === 0 ? parent.startSec : clamp(units[unitRange[0]].start),
      endSec: 0,
      unitRange,
      label: c.label,
      isAd: c.isAd,
    };
  });
  for (let k = 1; k < kids.length; k++) kids[k].startSec = Math.max(kids[k].startSec, kids[k - 1].startSec);
  for (let k = 0; k < kids.length; k++) kids[k].endSec = k + 1 < kids.length ? kids[k + 1].startSec : parent.endSec;
  const out: Span[] = [];
  let carry: number | null = null;
  for (const kid of kids) {
    const prev = out[out.length - 1];
    if (kid.endSec <= kid.startSec) {
      if (prev) prev.unitRange[1] = kid.unitRange[1];
      else carry ??= kid.unitRange[0];
      continue;
    }
    if (carry !== null) {
      kid.unitRange[0] = carry;
      carry = null;
    }
    if (prev && !prev.isAd && !kid.isAd && prev.label.toLowerCase() === kid.label.toLowerCase()) {
      prev.unitRange[1] = kid.unitRange[1];
      prev.endSec = kid.endSec;
      continue;
    }
    out.push(kid);
  }
  return out;
}
