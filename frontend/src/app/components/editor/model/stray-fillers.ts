/**
 * Stray fillers (LEDGER #238). Owen, 2026-09-28: "any time there's an 'um' or an 'uh' as its
 * own standalone word in the mic1 audio, and it has cuts on either side, remove the whole cut
 * ... if it's connected to something already, if it doesnt have cuts on both sides, if there
 * are more words in its connected group, leave it. only cut it if it's a stray um or uh that's
 * standalone".
 *
 * A "cut" here is what auto-editor left when it removed silence: the mic track's pieces on the
 * timeline, and the boundary between two of them is a cut when the second does not carry on in
 * the recording where the first stopped. A piece is a STRAY FILLER, and is removed whole, when
 * ALL of these hold:
 *
 *   1. it is a piece of a mic track (the track whose words are being looked at);
 *   2. the ONLY transcript word anywhere on the timeline inside it — every track, the screen
 *      audio included — is one um or uh on that mic track (so a clip playing under it, or a
 *      second word, leaves it alone);
 *   3. BOTH its edges are cuts: the recording jumps on each side. The first and last pieces of
 *      the timeline have nothing on one side and are left.
 *
 * Nothing is inferred beyond that: a piece already inside a cut is skipped, and the result is
 * the list of pieces with the reason each one qualified, so the caller can say what it did.
 * Pure — no Angular, no editor state — so it is checked on its own (tools/stray-filler-checks.js).
 */

/** um, umm, uh, uhh, uhm — a filler spelled any length, nothing else. */
const FILLER = /^(u+m+|u+h+m*)$/;

export interface FillerSegment {
  timelineStart: number;   // seconds on the ORIGINAL timeline
  duration: number;        // seconds
  sourceStart: number;     // seconds into the track's media file
}

export interface FillerWord {
  track: string;
  text: string;
  timelineStart: number;   // ORIGINAL seconds
  timelineEnd: number;
}

export interface StrayFiller {
  start: number;           // ORIGINAL seconds — the whole piece
  end: number;
  word: string;            // the filler as the transcript spells it
}

/** No aligned word is longer than this; words starting earlier cannot reach a piece. */
const MAX_WORD_SECONDS = 30;

/** Index of the first word starting at or after `t` (words sorted by timelineStart). */
function firstFrom(words: readonly FillerWord[], t: number): number {
  let lo = 0, hi = words.length;
  while (lo < hi) {
    const mid = (lo + hi) >> 1;
    if (words[mid].timelineStart < t) lo = mid + 1; else hi = mid;
  }
  return lo;
}

/** The word with its punctuation and case taken off, e.g. "Um," -> "um". */
export function fillerKey(text: string): string {
  return text.toLowerCase().replace(/[^a-z]/g, '');
}

export function isFiller(text: string): boolean {
  return FILLER.test(fillerKey(text));
}

/**
 * Two neighbouring pieces are CONNECTED — no cut between them — when the second sits right
 * after the first on the timeline and carries on in the file where the first stopped. `tol`
 * absorbs float noise from the manifest's seconds (it is far below one frame).
 */
function connected(a: FillerSegment, b: FillerSegment, tol: number): boolean {
  const aEnd = a.timelineStart + a.duration;
  return Math.abs(b.timelineStart - aEnd) <= tol
    && Math.abs(b.sourceStart - (a.sourceStart + a.duration)) <= tol;
}

/**
 * The stray fillers on one mic track.
 *
 * @param segments  that mic track's pieces (any order)
 * @param micTrackId the transcript track id of that mic
 * @param words     EVERY transcript word, all tracks
 * @param isCut     true when an ORIGINAL-seconds span is already wholly removed
 */
export function findStrayFillers(
  segments: readonly FillerSegment[],
  micTrackId: string,
  words: readonly FillerWord[],
  isCut: (start: number, end: number) => boolean,
  tol = 1e-4,
): StrayFiller[] {
  const segs = [...segments].sort((a, b) => a.timelineStart - b.timelineStart);
  const byStart = [...words].sort((a, b) => a.timelineStart - b.timelineStart);
  const out: StrayFiller[] = [];
  for (let i = 1; i < segs.length - 1; i++) {
    const seg = segs[i];
    const start = seg.timelineStart;
    const end = start + seg.duration;
    if (connected(segs[i - 1], seg, tol) || connected(seg, segs[i + 1], tol)) continue;
    // Every word touching the piece, from any track. A word straddling an edge counts: it is
    // speech the cut would take half of.
    const inside: FillerWord[] = [];
    for (let k = firstFrom(byStart, start - MAX_WORD_SECONDS); k < byStart.length; k++) {
      const w = byStart[k];
      if (w.timelineStart >= end - tol) break;
      if (w.timelineEnd > start + tol) inside.push(w);
      if (inside.length > 1) break;
    }
    if (inside.length !== 1) continue;
    const only = inside[0];
    if (only.track !== micTrackId || !isFiller(only.text)) continue;
    if (isCut(start, end)) continue;
    out.push({ start, end, word: only.text });
  }
  return out;
}
