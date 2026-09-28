/**
 * THE THUMBNAILS TAB'S CHEAP FILTERS: no model, only arithmetic on small grey frames.
 *
 * The tab samples a video about once a second (frame-sampler.ts) and most of those frames are
 * useless as a thumbnail: the same shot held for a minute, or a frame caught mid-motion. These two
 * filters remove them BEFORE anything is sent to the vision model, because every frame that
 * survives is one decide call on the card (Owen, 2026-09-28: "keep the cheap CPU dedupe + blur
 * filters to cut the call count"). Face presence is NOT judged here: the vision model answers it
 * ("is there a clearly visible human face"), and a CPU face filter would only duplicate that. The
 * deterministic face detector is used later, for exact boxes when the text is placed (layout.ts).
 *
 * PURE. Every function takes a grey frame (one byte per pixel, row-major) and returns numbers, so
 * tools/thumbnail-lab-checks.js exercises them on synthetic frames.
 *
 *   - SHARPNESS is the variance of the 4-neighbour Laplacian. A focused frame has strong edges and
 *     a high variance; a motion-blurred one has soft edges and a low one. It is judged RELATIVE to
 *     the run's own median, because an absolute number means different things for a webcam, a
 *     screen capture and a phone clip.
 *   - REPEATS are found with a 256-bit difference hash (dHash on a 17x16 grid: each bit says
 *     whether a cell is clearly brighter than its right neighbour). Two frames within
 *     DUPLICATE_MAX_BITS of each other are the same picture for a thumbnail's purpose. The
 *     threshold is TIGHT on purpose: a talking head changes only a few cells when the expression
 *     changes, and the expression is the whole point, so only genuinely held frames collapse.
 */

/** The hash grid: 17 columns compared pairwise give 16 bits per row, 16 rows give 256 bits. */
export const HASH_COLS = 17;
export const HASH_ROWS = 16;
export const HASH_BITS = (HASH_COLS - 1) * HASH_ROWS;

/**
 * A cell counts as brighter than its neighbour only by more than this many grey levels. Without it,
 * a flat region (a wall, a dark background) gives bits decided by sensor and compression noise,
 * and two copies of one held frame hash apart.
 */
export const HASH_DEAD_ZONE = 3;

/**
 * Two frames whose hashes differ in at most this many of 256 bits are one picture. 8/256 is about
 * 3%: a held shot with a moving mouth stays under it only when little else moves, and a change of
 * expression with a head turn clears it. Measured nowhere yet; it is Owen's to tune after a real run.
 */
export const DUPLICATE_MAX_BITS = 8;

/**
 * A frame whose sharpness is below this fraction of the run's median is blurry. 0.35 keeps the
 * ordinary spread of a talking-head video (most frames sit near the median) and drops the frames
 * caught mid-motion, which fall far below it.
 */
export const BLUR_FRACTION_OF_MEDIAN = 0.35;

/**
 * How many frames at most go to the vision model in one run (Owen: "e.g. ~100"). When more survive
 * the cheap filters, the kept frames are thinned evenly across the range (`thinAcrossRange`), so
 * the cap never concentrates the scoring on one stretch.
 */
export const MAX_FRAMES_TO_SCORE = 120;

/** One sampled frame's cheap measurements. */
export interface FrameMeasure {
  /** The sample's index in the run (0-based, in time order). */
  index: number;
  /** Seconds in the SOURCE VIDEO (not relative to the range). */
  t: number;
  hash: Uint8Array;
  sharpness: number;
}

export type FrameDrop = { index: number; t: number; reason: 'blurry' | 'repeat'; of?: number };

export interface FilterResult {
  kept: FrameMeasure[];
  dropped: FrameDrop[];
  /** The median sharpness the blur rule was judged against. */
  medianSharpness: number;
  /** The sharpness below which a frame counted as blurry. */
  blurFloor: number;
}

function assertFrame(gray: Uint8Array, width: number, height: number, what: string): void {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width < HASH_COLS || height < HASH_ROWS) {
    throw new Error(`${what}: a ${width}x${height} frame is too small to measure (at least ${HASH_COLS}x${HASH_ROWS}).`);
  }
  if (gray.length !== width * height) {
    throw new Error(`${what}: the frame has ${gray.length} bytes, and ${width}x${height} grey needs ${width * height}.`);
  }
}

/** The 256-bit difference hash of a grey frame, as 32 bytes. */
export function differenceHash(gray: Uint8Array, width: number, height: number): Uint8Array {
  assertFrame(gray, width, height, 'differenceHash');
  // Box-average the frame down to HASH_COLS x HASH_ROWS cells.
  const cells = new Float64Array(HASH_COLS * HASH_ROWS);
  for (let cy = 0; cy < HASH_ROWS; cy++) {
    const y0 = Math.floor((cy * height) / HASH_ROWS);
    const y1 = Math.floor(((cy + 1) * height) / HASH_ROWS);
    for (let cx = 0; cx < HASH_COLS; cx++) {
      const x0 = Math.floor((cx * width) / HASH_COLS);
      const x1 = Math.floor(((cx + 1) * width) / HASH_COLS);
      let sum = 0;
      for (let y = y0; y < y1; y++) {
        const row = y * width;
        for (let x = x0; x < x1; x++) sum += gray[row + x];
      }
      cells[cy * HASH_COLS + cx] = sum / Math.max(1, (y1 - y0) * (x1 - x0));
    }
  }
  const hash = new Uint8Array(HASH_BITS / 8);
  let bit = 0;
  for (let cy = 0; cy < HASH_ROWS; cy++) {
    for (let cx = 0; cx < HASH_COLS - 1; cx++) {
      if (cells[cy * HASH_COLS + cx] > cells[cy * HASH_COLS + cx + 1] + HASH_DEAD_ZONE) hash[bit >> 3] |= 1 << (bit & 7);
      bit++;
    }
  }
  return hash;
}

const POPCOUNT = new Uint8Array(256).map((_, n) => {
  let c = 0;
  for (let v = n; v; v >>= 1) c += v & 1;
  return c;
});

/** How many of the two hashes' bits differ. */
export function hammingDistance(a: Uint8Array, b: Uint8Array): number {
  if (a.length !== b.length) throw new Error(`hammingDistance: hashes of ${a.length} and ${b.length} bytes cannot be compared.`);
  let d = 0;
  for (let i = 0; i < a.length; i++) d += POPCOUNT[a[i] ^ b[i]];
  return d;
}

/** Variance of the 4-neighbour Laplacian over the frame's interior: higher is sharper. */
export function laplacianVariance(gray: Uint8Array, width: number, height: number): number {
  assertFrame(gray, width, height, 'laplacianVariance');
  let sum = 0;
  let sumSq = 0;
  let n = 0;
  for (let y = 1; y < height - 1; y++) {
    const row = y * width;
    for (let x = 1; x < width - 1; x++) {
      const i = row + x;
      const v = gray[i - 1] + gray[i + 1] + gray[i - width] + gray[i + width] - 4 * gray[i];
      sum += v;
      sumSq += v * v;
      n++;
    }
  }
  const mean = sum / n;
  return sumSq / n - mean * mean;
}

export function median(values: readonly number[]): number {
  if (values.length === 0) throw new Error('median: there are no values to take the median of.');
  const sorted = [...values].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/**
 * The two cheap filters, in order: blurry frames first (judged against the run's median), then
 * repeats among what is left. A repeat keeps the SHARPER of the two, so a held shot is represented
 * by its best frame, and every drop says what it was dropped for (and, for a repeat, which frame it
 * repeated) so the tab can say it in plain words.
 */
export function filterFrames(frames: readonly FrameMeasure[]): FilterResult {
  if (frames.length === 0) throw new Error('filterFrames: no frames were sampled, so there is nothing to filter.');
  const med = median(frames.map((f) => f.sharpness));
  const blurFloor = med * BLUR_FRACTION_OF_MEDIAN;
  const dropped: FrameDrop[] = [];
  const kept: FrameMeasure[] = [];
  for (const frame of [...frames].sort((a, b) => a.index - b.index)) {
    if (frame.sharpness < blurFloor) {
      dropped.push({ index: frame.index, t: frame.t, reason: 'blurry' });
      continue;
    }
    let twin = -1;
    for (let k = 0; k < kept.length; k++) {
      if (hammingDistance(kept[k].hash, frame.hash) <= DUPLICATE_MAX_BITS) {
        twin = k;
        break;
      }
    }
    if (twin === -1) {
      kept.push(frame);
    } else if (frame.sharpness > kept[twin].sharpness) {
      dropped.push({ index: kept[twin].index, t: kept[twin].t, reason: 'repeat', of: frame.index });
      kept[twin] = frame;
    } else {
      dropped.push({ index: frame.index, t: frame.t, reason: 'repeat', of: kept[twin].index });
    }
  }
  kept.sort((a, b) => a.index - b.index);
  return { kept, dropped, medianSharpness: med, blurFloor };
}

/**
 * At most `cap` frames, spread evenly over [start, end). The range is cut into `cap` equal
 * stretches and taken in ROUNDS: each round, every stretch that still has kept frames gives its
 * sharpest remaining one, until `cap` are taken. So the cap is filled even when some stretches have
 * nothing kept (a desktop stretch, a held shot), and no stretch gives a second frame before every
 * stretch has given its first. The last round, when it would overshoot, takes its sharpest offers.
 * Under the cap, everything is kept. Returned in time order.
 */
export function thinAcrossRange<T extends { t: number; sharpness: number }>(frames: readonly T[], start: number, end: number, cap: number): T[] {
  if (!(end > start)) throw new Error(`thinAcrossRange: the range ${start}-${end} s is empty.`);
  if (!Number.isInteger(cap) || cap < 1) throw new Error(`thinAcrossRange: a cap of ${cap} frames is not a count.`);
  if (frames.length <= cap) return [...frames];
  const width = (end - start) / cap;
  const buckets = new Map<number, T[]>();
  for (const frame of frames) {
    const bucket = Math.min(cap - 1, Math.max(0, Math.floor((frame.t - start) / width)));
    const list = buckets.get(bucket) ?? [];
    list.push(frame);
    buckets.set(bucket, list);
  }
  for (const list of buckets.values()) list.sort((a, b) => b.sharpness - a.sharpness || a.t - b.t);
  const order = [...buckets.keys()].sort((a, b) => a - b);
  const taken: T[] = [];
  while (taken.length < cap) {
    const offers = order.map((k) => buckets.get(k)!.shift()).filter((f): f is T => f !== undefined);
    if (offers.length === 0) break;
    if (taken.length + offers.length > cap) offers.sort((a, b) => b.sharpness - a.sharpness || a.t - b.t);
    taken.push(...offers.slice(0, cap - taken.length));
  }
  return taken.sort((a, b) => a.t - b.t);
}
