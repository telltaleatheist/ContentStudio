/**
 * AUTO-COMBINE (Owen, 2026-09-28): he stars a few favourites of each piece (frames, word lines,
 * photos) and the tab lays them out as thumbnails A, B and C. Every piece stays swappable before
 * saving; this only makes the starting layout.
 *
 *   "Best package": each variant takes the next favourite of every piece, so A, B and C differ in
 *     everything (a favourite list shorter than three repeats from its start).
 *   "Test one thing": two pieces are held at their first favourite and the chosen one varies across
 *     the variants, so the A/B test measures that piece alone. It needs at least two favourites of
 *     the varied piece, and makes as many variants as it has (up to three).
 *
 * PHOTOS follow the photo suggestion when there is one (judge.ts): a variant takes its
 * highest-ranked favourite photo (or its top-ranked photo when none is starred); a held photo is
 * the first variant's. Without a suggestion, favourites are taken in the order they were starred.
 *
 * PURE: lists in, the layout out, or the one plain sentence saying what is missing.
 */

export type Piece = 'frame' | 'text' | 'photo';
export type CombineMode = { mode: 'best' } | { mode: 'test'; vary: Piece };

export interface WordPick {
  phrase: string | null;
  kind: string | null;
}

export interface Favourites {
  frames: readonly string[];
  /** Word lines; `{ phrase: null }` is "no text". Empty means every variant is picture-only. */
  texts: readonly WordPick[];
  /** Photo names; empty means none starred. */
  photos: readonly string[];
}

export interface Variant {
  letter: string;
  frameId: string;
  text: WordPick;
  photo: string | null;
}

export type CombineResult = { ok: true; variants: Variant[] } | { ok: false; reason: string };

export const LETTERS = ['A', 'B', 'C'] as const;

const PIECE_WORDS: Record<Piece, string> = { frame: 'frames', text: 'word lines', photo: 'photos' };

function photoFor(letter: string, fav: readonly string[], rank: Record<string, readonly string[]> | null, i: number): string | null {
  const ranked = rank?.[letter];
  if (ranked && ranked.length > 0) {
    if (fav.length === 0) return ranked[0];
    const best = ranked.find((n) => fav.includes(n));
    return best ?? fav[i % fav.length];
  }
  return fav.length === 0 ? null : fav[i % fav.length];
}

export function combine(fav: Favourites, how: CombineMode, rank: Record<string, readonly string[]> | null = null): CombineResult {
  if (fav.frames.length === 0) return { ok: false, reason: 'Star at least one frame first.' };
  const texts: readonly WordPick[] = fav.texts.length > 0 ? fav.texts : [{ phrase: null, kind: null }];
  if (how.mode === 'best') {
    return {
      ok: true,
      variants: LETTERS.map((letter, i) => ({
        letter,
        frameId: fav.frames[i % fav.frames.length],
        text: texts[i % texts.length],
        photo: photoFor(letter, fav.photos, rank, i),
      })),
    };
  }
  const count = how.vary === 'frame' ? fav.frames.length : how.vary === 'text' ? fav.texts.length : fav.photos.length;
  if (count < 2) return { ok: false, reason: `To test ${PIECE_WORDS[how.vary]}, star at least two ${PIECE_WORDS[how.vary]}.` };
  const n = Math.min(3, count);
  const heldPhoto = photoFor('A', fav.photos, rank, 0);
  const photoOrder = rank?.['A'] ? [...fav.photos].sort((a, b) => rank['A'].indexOf(a) - rank['A'].indexOf(b)) : [...fav.photos];
  return {
    ok: true,
    variants: LETTERS.slice(0, n).map((letter, i) => ({
      letter,
      frameId: how.vary === 'frame' ? fav.frames[i] : fav.frames[0],
      text: how.vary === 'text' ? texts[i] : texts[0],
      photo: how.vary === 'photo' ? photoOrder[i] : heldPhoto,
    })),
  };
}
