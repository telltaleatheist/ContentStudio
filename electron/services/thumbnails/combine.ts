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
 * NOTHING IS LEFT OFF A THUMBNAIL UNLESS OWEN CHOSE IT (2026-09-28, after a render came out with no
 * words and no photo because none were starred; Law 1):
 *   - WORDS. Starred lines are used as starred ("No text" included, only when starred). With none
 *     starred, the lines the model wrote are used: A the top claim, B the top stakes, C the top
 *     reaction; a held line ("Test one thing") is the top claim. With none starred and none written,
 *     combine refuses: "Write words first, or star “No text”."
 *   - PHOTOS. A starred photo is used (the highest-ranked starred one when the photo suggestion ran
 *     for these exact words). With none starred the variant takes `{ pick: 'top' }`: the top-ranked
 *     photo for the words, resolved when the thumbnails are made (lab-service.ts resolvePhotos runs
 *     the suggestion first when it has not run for those words). "No photo" is only ever a choice
 *     Owen makes in the variant's row.
 *   - A suggestion made for different words is never used: each variant's ranking carries the words
 *     it was made for, and a ranking whose words differ is ignored here.
 *
 * PURE: lists in, the layout out, or the one plain sentence saying what is missing.
 */

export type Piece = 'frame' | 'text' | 'photo';
export type CombineMode = { mode: 'best' } | { mode: 'test'; vary: Piece };

export type WordKind = 'claim' | 'stakes' | 'reaction';

export interface WordPick {
  phrase: string | null;
  kind: string | null;
}

/** The lines the model wrote, per kind, best first (words-writer.ts). */
export interface WrittenWords {
  claim: readonly string[];
  stakes: readonly string[];
  reaction: readonly string[];
}

export interface Favourites {
  frames: readonly string[];
  /** Starred word lines; `{ phrase: null }` is a starred "No text". */
  texts: readonly WordPick[];
  /** Starred photo names. */
  photos: readonly string[];
  /** Every line the model wrote, or null when no words have been written yet. */
  written: WrittenWords | null;
}

/**
 * A variant's photo. `photo`: that photo. `none`: Owen chose "No photo". `top`: the photo the
 * suggestion ranks first for thumbnail `of`'s words (`of` is the variant's own letter, or A's when
 * the photo is held across a "Test one thing" set).
 */
export type PhotoPick = { pick: 'photo'; name: string } | { pick: 'none' } | { pick: 'top'; of: string };

export interface Variant {
  letter: string;
  frameId: string;
  text: WordPick;
  photo: PhotoPick;
}

/** A variant's photo ranking and the words it was made for. */
export interface Ranking {
  text: string | null;
  ranked: readonly string[];
}

export type Rankings = Record<string, Ranking>;

export type CombineResult = { ok: true; variants: Variant[] } | { ok: false; reason: string };

export const LETTERS = ['A', 'B', 'C'] as const;

/** Which written kind each letter takes when no line is starred. */
export const KIND_OF_LETTER: Record<string, WordKind> = { A: 'claim', B: 'stakes', C: 'reaction' };

export const WRITE_WORDS_FIRST = 'Write words first, or star “No text”.';

const PIECE_WORDS: Record<Piece, string> = { frame: 'frames', text: 'word lines', photo: 'photos' };

function hasWritten(w: WrittenWords | null): w is WrittenWords {
  return w !== null && (w.claim.length > 0 || w.stakes.length > 0 || w.reaction.length > 0);
}

/** The top written line of a kind, or the sentence saying there is none. */
function topWritten(w: WrittenWords, kind: WordKind, letter: string): WordPick | string {
  const line = w[kind][0];
  if (line === undefined) return `No ${kind} lines were written, so ${letter} has no words to take. Star the words you want, or star “No text”.`;
  return { phrase: line, kind };
}

/** A ranking, only when it was made for exactly these words. */
function freshRanking(rank: Rankings | null, letter: string, text: string | null): readonly string[] | null {
  const r = rank?.[letter];
  return r !== undefined && r.text === text && r.ranked.length > 0 ? r.ranked : null;
}

function photoFor(fav: readonly string[], ranked: readonly string[] | null, i: number, of: string): PhotoPick {
  if (fav.length === 0) return { pick: 'top', of };
  if (ranked !== null) {
    const best = ranked.find((n) => fav.includes(n));
    if (best !== undefined) return { pick: 'photo', name: best };
  }
  return { pick: 'photo', name: fav[i % fav.length] };
}

export function combine(fav: Favourites, how: CombineMode, rank: Rankings | null = null): CombineResult {
  if (fav.frames.length === 0) return { ok: false, reason: 'Star at least one frame first.' };
  const starred = fav.texts.length > 0;
  if (!starred && !hasWritten(fav.written)) return { ok: false, reason: WRITE_WORDS_FIRST };

  if (how.mode === 'best') {
    const variants: Variant[] = [];
    for (const [i, letter] of LETTERS.entries()) {
      const text = starred ? fav.texts[i % fav.texts.length] : topWritten(fav.written!, KIND_OF_LETTER[letter], letter);
      if (typeof text === 'string') return { ok: false, reason: text };
      variants.push({
        letter,
        frameId: fav.frames[i % fav.frames.length],
        text,
        photo: photoFor(fav.photos, freshRanking(rank, letter, text.phrase), i, letter),
      });
    }
    return { ok: true, variants };
  }

  const count = how.vary === 'frame' ? fav.frames.length : how.vary === 'text' ? fav.texts.length : fav.photos.length;
  if (count < 2) return { ok: false, reason: `To test ${PIECE_WORDS[how.vary]}, star at least two ${PIECE_WORDS[how.vary]}.` };
  const n = Math.min(3, count);
  const held = starred ? fav.texts[0] : topWritten(fav.written!, 'claim', 'the held words');
  if (typeof held === 'string') return { ok: false, reason: held };
  const texts = LETTERS.slice(0, n).map((_, i) => (how.vary === 'text' ? fav.texts[i] : held));
  const rankA = freshRanking(rank, 'A', texts[0].phrase);
  const heldPhoto = photoFor(fav.photos, rankA, 0, 'A');
  const photoOrder = rankA !== null ? [...fav.photos].sort((a, b) => rankA.indexOf(a) - rankA.indexOf(b)) : [...fav.photos];
  return {
    ok: true,
    variants: LETTERS.slice(0, n).map((letter, i) => ({
      letter,
      frameId: how.vary === 'frame' ? fav.frames[i] : fav.frames[0],
      text: texts[i],
      photo: how.vary === 'photo' ? { pick: 'photo', name: photoOrder[i] } : heldPhoto,
    })),
  };
}
