/**
 * A PHOTO DRAWN FROM THE TOP 3, NOT ALWAYS THE TOP 1 (Owen, 2026-09-28, after the tab put "are you
 * kidding me" (32%) on A, B and C: "i think it would be safe to have temperature, where it picks
 * randomly from the top 3 or 4 … having the ability to pick directly is valuable").
 *
 * For each thumbnail whose photo is "top-ranked" (combine.ts `{ pick: 'top', of }`), the photo is
 * drawn from that ranking's top DRAW_POOL photos with the model's probabilities, renormalised over
 * the pool. A photo another thumbnail of this render already has (picked directly, or drawn before
 * it) is left out of the pool while any other remains, so A, B and C differ when they can; when the
 * whole pool is taken, the draw is from the whole pool and the result says the repeat was forced.
 * Direct picks are never touched.
 *
 * REPRODUCIBLE: the draw is a seeded generator (mulberry32) over a stated seed, and the rankings are
 * taken in the order given, so the same seed, rankings and picks give the same photos. The seed is
 * shown with the render (no hidden randomness); the tab can hand a seed back to repeat a draw.
 *
 * PURE: rankings in, draws out.
 */

/** How many of a ranking's top photos a draw chooses among. */
export const DRAW_POOL = 3;

export interface RankedPhoto {
  name: string;
  p: number | null;
}

export interface PhotoDraw {
  /** The photo drawn. */
  name: string;
  /** The model's probability for it (as ranked, before renormalising). */
  p: number;
  /** Its chance in this draw (renormalised over the pool it was drawn from). */
  chance: number;
  /** The pool it was drawn from, best first, with the model's probabilities. */
  pool: RankedPhoto[];
  /** True when every photo of the top DRAW_POOL was already on another thumbnail. */
  repeatForced: boolean;
}

/** A 32-bit seeded generator, uniform on [0, 1). */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** A seed as the tab shows and accepts it: a whole number from 1 to 2^31 - 1. */
export function checkSeed(seed: unknown): number {
  if (typeof seed !== 'number' || !Number.isInteger(seed) || seed < 1 || seed > 0x7fffffff) {
    throw new Error(`A draw seed is a whole number from 1 to ${0x7fffffff}; got ${JSON.stringify(seed)}.`);
  }
  return seed;
}

/**
 * Draw one photo per ranking in `order` (the letters whose words the rankings were made for, in
 * the render's order). `taken` are the photos already on the render by direct pick.
 */
export function drawPhotos(
  rankings: Readonly<Record<string, readonly RankedPhoto[]>>,
  order: readonly string[],
  taken: readonly string[],
  seed: number,
): Record<string, PhotoDraw> {
  const random = mulberry32(checkSeed(seed));
  const used = new Set(taken);
  const out: Record<string, PhotoDraw> = {};
  for (const of of order) {
    const ranking = rankings[of];
    if (ranking === undefined || ranking.length === 0) throw new Error(`There is no photo ranking for ${of}'s words to draw from.`);
    const pool = ranking.slice(0, DRAW_POOL);
    const fresh = pool.filter((r) => !used.has(r.name));
    const from = fresh.length > 0 ? fresh : pool;
    const weights = from.map((r) => (typeof r.p === 'number' && r.p > 0 ? r.p : 0));
    const total = weights.reduce((a, b) => a + b, 0);
    if (!(total > 0)) {
      throw new Error(`The photo ranking for ${of}'s words gives no probability to ${from.map((r) => `"${r.name}"`).join(', ')}, so there is nothing to draw by.`);
    }
    const roll = random() * total;
    let k = 0;
    for (let acc = weights[0]; roll >= acc && k < from.length - 1; acc += weights[++k]);
    const pick = from[k];
    out[of] = { name: pick.name, p: weights[k], chance: weights[k] / total, pool: pool.map((r) => ({ ...r })), repeatForced: fresh.length === 0 };
    used.add(pick.name);
  }
  return out;
}

/** "oh please (21%), drawn from the top 3: are you kidding me 32%, oh please 21%, horrified 15%". */
export function drawLine(d: PhotoDraw): string {
  const pct = (p: number | null) => `${Math.round((p ?? 0) * 100)}%`;
  return `${d.name} (${pct(d.p)}), drawn from the top ${d.pool.length}: ${d.pool.map((r) => `${r.name} ${pct(r.p)}`).join(', ')}` +
    (d.repeatForced ? ' (all three were already on another thumbnail)' : '');
}
