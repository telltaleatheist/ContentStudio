/**
 * Long-video chunking and seam stitching — Briefcase backend/src/scorer/chapters/chunks.ts,
 * ported as it shipped (plan §10.3: reuse, not re-port), with the sizes set to Owen's
 * context ruling (LEDGER #196: every local call under ~12-16k tokens).
 *
 * Planning:
 *   - a transcript of <= 12k tokens is one chunk and runs exactly as measured;
 *   - a longer one is cut into equal cores of <= 9k tokens (at unit boundaries), and each
 *     core carries ~1.5k tokens of overlap context on each side. A chunk's state (outline,
 *     assign, Viterbi) is overlap + core + overlap, so every decide state stays under 12k
 *     tokens with room for the question on top. Every unit is OWNED by exactly one core.
 *
 * Stitch rule, for each seam between chunk k and chunk k+1:
 *   - O = the units both chunks cover; the seam s is the middle unit of O.
 *   - A = the run of chunk k's path that contains s; B = chunk k+1's run that contains s.
 *     If A and B EACH cover >= 80% of O, they are the same chapter: the cut is at s and the
 *     two halves are joined into one chapter, labelled from whichever chunk's run holds more
 *     units (ties: the earlier chunk).
 *   - Otherwise the cut goes at the chapter boundary (from either path) inside O nearest to s
 *     (ties: the earlier unit); with none, at s.
 *   - Units before the cut take chunk k's labels, units from the cut on take chunk k+1's.
 *
 * Token counts are an ESTIMATE, declared: ~4 characters per token (Briefcase's rule without a
 * tokenizer). The transport may pass a real count through `countTokens`; either way the
 * number is used only to plan the cut, and a state over the loaded context is the transport's
 * to refuse by name (plan §6.1), never truncated.
 */

import { boundaries } from './viterbi';

export interface Chunk {
  /** Global unit range of the whole chunk [start, end): overlap + core + overlap. */
  start: number;
  end: number;
  /** The core this chunk owns [coreStart, coreEnd). */
  coreStart: number;
  coreEnd: number;
}

export interface ChunkPlanOptions {
  /** A transcript up to this many tokens is one chunk. Default 12000. */
  maxSingleTokens?: number;
  /** Largest core. Default 9000. */
  maxCoreTokens?: number;
  /** Overlap context on each side of a core. Default 1500. */
  overlapTokens?: number;
}

export const CHUNK_DEFAULTS = { maxSingleTokens: 12000, maxCoreTokens: 9000, overlapTokens: 1500 } as const;

/** Characters per token, the declared estimate when no tokenizer is at hand. */
export const CHARS_PER_TOKEN = 4;

/** Per-unit token estimates: a total (measured or chars/4) shared out by character length. */
export function unitTokens(texts: readonly string[], totalTokens?: number): number[] {
  const chars = texts.map((s) => s.length + 1);
  const totalChars = chars.reduce((a, b) => a + b, 0);
  const total = totalTokens ?? totalChars / CHARS_PER_TOKEN;
  return chars.map((c) => (c / totalChars) * total);
}

/** Plan chunks from per-unit token counts. */
export function planChunks(tokens: number[], opts: ChunkPlanOptions = {}): Chunk[] {
  const maxSingle = opts.maxSingleTokens ?? CHUNK_DEFAULTS.maxSingleTokens;
  const maxCore = opts.maxCoreTokens ?? CHUNK_DEFAULTS.maxCoreTokens;
  const overlap = opts.overlapTokens ?? CHUNK_DEFAULTS.overlapTokens;
  const n = tokens.length;
  if (n === 0) return [];
  const cum = [0];
  for (const t of tokens) cum.push(cum[cum.length - 1] + t);
  const total = cum[n];
  if (total <= maxSingle) return [{ start: 0, end: n, coreStart: 0, coreEnd: n }];

  const cores = Math.min(n, Math.ceil(total / maxCore));
  const target = total / cores;
  // Core boundaries: the unit boundary whose cumulative count is nearest each multiple of target.
  const cuts = [0];
  for (let c = 1; c < cores; c++) {
    const want = target * c;
    let best = cuts[cuts.length - 1] + 1;
    for (let i = best; i <= n - (cores - c); i++) {
      if (Math.abs(cum[i] - want) < Math.abs(cum[best] - want)) best = i;
      if (cum[i] > want) break;
    }
    cuts.push(best);
  }
  cuts.push(n);

  const out: Chunk[] = [];
  for (let c = 0; c < cores; c++) {
    const coreStart = cuts[c];
    const coreEnd = cuts[c + 1];
    let start = coreStart;
    for (let acc = 0; start > 0 && acc < overlap; ) acc += tokens[--start];
    let end = coreEnd;
    for (let acc = 0; end < n && acc < overlap; ) acc += tokens[end++];
    out.push({ start, end, coreStart, coreEnd });
  }
  return out;
}

/** A stretch of units with one outline item: the unit of stitching and of chapters. */
export interface Piece {
  /** Global unit range [start, end). */
  start: number;
  end: number;
  /** The outline item (the ad item's text for an ad). */
  label: string;
  isAd: boolean;
}

/** Runs of `path` over units [lo, hi) of a chunk whose first unit is global `offset`. */
export function pathPieces(path: number[], items: readonly string[], plug: number, offset: number, lo = 0, hi = path.length): Piece[] {
  const out: Piece[] = [];
  let i = lo;
  while (i < hi) {
    let k = i;
    while (k < hi && path[k] === path[i]) k++;
    const j = path[i];
    out.push({ start: offset + i, end: offset + k, label: items[j], isAd: j === plug });
    i = k;
  }
  return out;
}

/** One chunk's result, as stitchChunks needs it. */
export interface ChunkPath {
  chunk: Chunk;
  /** Item per unit of the chunk (length chunk.end - chunk.start). */
  path: number[];
  /** Outline items, the ad item last when ads are on. */
  items: string[];
  /** Index of the ad item in `items`, or -1. */
  plug: number;
}

export interface Seam {
  /** Global unit index where ownership passes to the next chunk. */
  cut: number;
  /** True when the chapters either side of the cut were joined into one. */
  merged: boolean;
}

/** Cover >= this share of the overlap on both sides and two seam chapters are one. */
export const SEAM_SAME_CHAPTER = 0.8;

function runAt(path: number[], offset: number, g: number): [number, number] {
  const i = g - offset;
  let a = i;
  let b = i + 1;
  while (a > 0 && path[a - 1] === path[i]) a--;
  while (b < path.length && path[b] === path[i]) b++;
  return [offset + a, offset + b];
}

function overlapLen(a: [number, number], lo: number, hi: number): number {
  return Math.max(0, Math.min(a[1], hi) - Math.max(a[0], lo));
}

/** Decide the seam between two neighbouring chunks (see the header for the rule). */
export function decideSeam(left: ChunkPath, right: ChunkPath): Seam & { labelFrom: 'left' | 'right' } {
  const lo = right.chunk.start;
  const hi = left.chunk.end;
  if (hi <= lo) return { cut: right.chunk.coreStart, merged: false, labelFrom: 'right' };
  const s = Math.floor((lo + hi) / 2);
  const size = hi - lo;
  const A = runAt(left.path, left.chunk.start, s);
  const B = runAt(right.path, right.chunk.start, s);
  if (overlapLen(A, lo, hi) >= SEAM_SAME_CHAPTER * size && overlapLen(B, lo, hi) >= SEAM_SAME_CHAPTER * size) {
    return { cut: s, merged: true, labelFrom: B[1] - B[0] > A[1] - A[0] ? 'right' : 'left' };
  }
  const candidates = [
    ...boundaries(left.path).map((b) => b + left.chunk.start),
    ...boundaries(right.path).map((b) => b + right.chunk.start),
  ].filter((b) => b > lo && b < hi);
  let cut = s;
  let best = Infinity;
  for (const b of candidates) {
    const d = Math.abs(b - s);
    if (d < best || (d === best && b < cut)) {
      best = d;
      cut = b;
    }
  }
  return { cut, merged: false, labelFrom: 'right' };
}

/** Stitch per-chunk paths into one contiguous list of pieces covering every unit. */
export function stitchChunks(results: ChunkPath[]): { pieces: Piece[]; seams: Seam[] } {
  if (results.length === 0) return { pieces: [], seams: [] };
  const seams: Array<Seam & { labelFrom: 'left' | 'right' }> = [];
  let prevCut = results[0].chunk.start;
  for (let k = 0; k + 1 < results.length; k++) {
    const seam = decideSeam(results[k], results[k + 1]);
    // Keep ownership monotone and inside both chunks, whatever the sizes.
    seam.cut = Math.min(Math.max(seam.cut, prevCut, results[k + 1].chunk.start), results[k].chunk.end);
    seams.push(seam);
    prevCut = seam.cut;
  }

  const pieces: Piece[] = [];
  for (let k = 0; k < results.length; k++) {
    const r = results[k];
    const from = k === 0 ? r.chunk.start : seams[k - 1].cut;
    const to = k === results.length - 1 ? r.chunk.end : seams[k].cut;
    if (to <= from) continue;
    const own = pathPieces(r.path, r.items, r.plug, r.chunk.start, from - r.chunk.start, to - r.chunk.start);
    const seam = k > 0 ? seams[k - 1] : null;
    const last = pieces[pieces.length - 1];
    if (seam?.merged && last && last.end === own[0].start) {
      const first = own.shift()!;
      const keep = seam.labelFrom === 'right' ? first : last;
      pieces[pieces.length - 1] = { ...keep, start: last.start, end: first.end };
    }
    pieces.push(...own);
  }
  return { pieces, seams: seams.map(({ cut, merged }) => ({ cut, merged })) };
}
