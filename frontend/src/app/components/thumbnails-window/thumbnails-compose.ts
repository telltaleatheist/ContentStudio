/**
 * THE THUMBNAILS WINDOW'S PICKING RULES, pure (2026-09-29). Owen, after the phase-2 window failed
 * him: "the images it gathered from the original section should be at the top. i pick three. the
 * text it generated. i pick three. it overlays them."
 *
 *   - FRAMES and TEXTS are picked in click order, up to three each; clicking a picked one takes it
 *     out and the rest close up (the titles' rule, publish-state.ts toggleTitle).
 *   - THUMBNAIL n is frame n + text n + photo n + the logo, drawn into pair n of the record (the
 *     main process draws; `wantedChange` says what pair n must change to show slot n, or null when
 *     it already does). Owen's own image can take any of the three places instead; the frames and
 *     texts then fill the other places in order.
 *   - The picks saved (pick 1 is the video's thumbnail; with an A/B test pick n goes with title n)
 *     are the places in order, once each is drawn (`pickRequests`). Saved as he goes.
 *   - Every action goes through ONE runner that shows what is running and turns any failure into a
 *     line on screen (`ActionRunner`): nothing reaches only the log.
 *
 * No Angular and only type imports, so tools/thumbnail-pipeline-checks.js runs it under plain Node.
 */
import type { PairChange, PickRequest, PickView, Ranked, StoredPair, WordKind } from './thumbnails.types';

export const MAX_PICKS = 3;

const KINDS: readonly WordKind[] = ['claim', 'stakes', 'reaction'];

/** One line of text Owen can pick: generated words (labelled with their title and kind), typed words, or no text. */
export interface TextOption {
  key: string;
  /** Null: "No text". */
  phrase: string | null;
  kind: WordKind | null;
  /** The title the words were written for; null for typed words or no text. */
  wordsFor: string | null;
  /** The pair whose words list it came from (its photo ranking is the one shown for it), or null. */
  pair: number | null;
}

export const NO_TEXT: TextOption = { key: 'none', phrase: null, kind: null, wordsFor: null, pair: null };

function generatedKey(wordsFor: string, phrase: string): string {
  return `for|${wordsFor}|${phrase}`;
}

/** Every generated line, pair by pair (the pairs' order is the titles' order), claim, stakes, reaction. */
export function textOptions(pairs: readonly StoredPair[]): TextOption[] {
  const out: TextOption[] = [];
  const seen = new Set<string>();
  for (const p of [...pairs].sort((a, b) => a.pair - b.pair)) {
    for (const kind of KINDS) {
      for (const phrase of p.words[kind]) {
        const key = generatedKey(p.title, phrase);
        if (seen.has(key)) continue;
        seen.add(key);
        out.push({ key, phrase, kind, wordsFor: p.title, pair: p.pair });
      }
    }
  }
  return out;
}

/** Words Owen typed. Refused when empty. */
export function typedText(phrase: string): TextOption {
  const words = phrase.trim();
  if (words === '') throw new Error('Type the words first.');
  return { key: `typed|${words}`, phrase: words, kind: null, wordsFor: null, pair: null };
}

/**
 * Click order is pick order: a new one goes last; a picked one comes out and the rest close up; a
 * fourth is refused with a line that says what to do.
 */
export function togglePick<T>(list: readonly T[], item: T, key: (t: T) => string, what: string): { list: T[]; refused: string | null } {
  const k = key(item);
  const at = list.findIndex((x) => key(x) === k);
  if (at !== -1) return { list: list.filter((_, i) => i !== at), refused: null };
  if (list.length >= MAX_PICKS) return { list: [...list], refused: `Up to ${MAX_PICKS} ${what} can be picked. Click a picked one to take it out first.` };
  return { list: [...list, item], refused: null };
}

/** 'auto': drawn from the top 3 of the ranking; null: no photo; a name: that photo. */
export type PhotoChoice = 'auto' | null | string;

/** Thumbnail n's photo choice: null ("No photo") is a choice, so only an absent entry means the draw. */
export function photoOf(photos: Readonly<Record<number, PhotoChoice>>, n: number): PhotoChoice {
  return Object.prototype.hasOwnProperty.call(photos, n) ? photos[n] : 'auto';
}

export interface Slot {
  /** The thumbnail's place, 1 to 3 (pair n is drawn for it). */
  n: number;
  /** Owen's own image in this place, or null. */
  own: string | null;
  /** Which frame and text pick this place takes (0-based), or null for his own image. */
  pickIndex: number | null;
  frameId: string | null;
  text: TextOption | null;
  photo: PhotoChoice;
  /** The pair whose photo ranking is shown and drawn from: the pair the words came from, else pair n. */
  rankingPair: number | null;
  /** What is missing before it can be drawn; null when it can be (or it is his own image). */
  missing: string | null;
}

export function planSlots(input: {
  pairs: readonly StoredPair[];
  frames: readonly string[];
  texts: readonly TextOption[];
  photos: Readonly<Record<number, PhotoChoice>>;
  own: Readonly<Record<number, string>>;
}): Slot[] {
  const { pairs } = input;
  const has = (n: number) => pairs.some((p) => p.pair === n);
  const ranked = (n: number | null) => n !== null && pairs.some((p) => p.pair === n && p.photos.length > 0);
  const slots: Slot[] = [];
  let k = 0;
  for (let n = 1; n <= MAX_PICKS; n++) {
    const own = input.own[n] ?? null;
    if (own !== null) {
      slots.push({ n, own, pickIndex: null, frameId: null, text: null, photo: null, rankingPair: null, missing: null });
      continue;
    }
    const i = k++;
    const frameId = input.frames[i] ?? null;
    const text = input.texts[i] ?? null;
    let missing: string | null = null;
    if (!has(n)) {
      missing = pairs.length === 0
        ? 'There are no thumbnails to draw into yet.'
        : `This report has ${pairs.length} title and thumbnail pair${pairs.length === 1 ? '' : 's'}, so there is no thumbnail ${n} to draw.`;
    } else if (frameId === null && text === null) missing = `Pick frame ${i + 1} and text ${i + 1} above.`;
    else if (frameId === null) missing = `Pick frame ${i + 1} above.`;
    else if (text === null) missing = `Pick text ${i + 1} above.`;
    const rankingPair = ranked(text?.pair ?? null) ? text!.pair : has(n) ? n : null;
    slots.push({ n, own: null, pickIndex: i, frameId, text, photo: photoOf(input.photos, n), rankingPair, missing });
  }
  return slots;
}

/** The ranking a slot's photos are shown and drawn from ([] when the photos were never ranked). */
export function rankingFor(slot: Slot, pairs: readonly StoredPair[]): Ranked[] {
  return pairs.find((p) => p.pair === slot.rankingPair)?.photos ?? [];
}

/** The title pair n's current words were written for (older records: its own title when the words are generated). */
export function currentWordsFor(pair: StoredPair): string | null {
  const d = pair.default;
  if (d.wordsFor !== undefined) return d.wordsFor;
  return d.kind !== null ? pair.title : null;
}

function sameNames(a: readonly Ranked[], b: readonly Ranked[]): boolean {
  return a.length === b.length && a.every((r, i) => r.name === b[i].name);
}

/**
 * The change that makes pair n show slot n, or null when it already does (or the slot cannot be
 * drawn: his own image, or something missing). An 'auto' photo is kept while it was drawn from the
 * top 3 of the slot's ranking, and drawn again when the ranking changed; with no ranking at all the
 * thumbnail has no photo (the Photos section says why).
 */
export function wantedChange(slot: Slot, pairs: readonly StoredPair[], logo: boolean): PairChange | null {
  if (slot.own !== null || slot.missing !== null || slot.frameId === null || slot.text === null) return null;
  const pair = pairs.find((p) => p.pair === slot.n);
  if (pair === undefined) return null;
  const d = pair.default;
  const change: PairChange = { pair: slot.n };
  let changed = false;
  if (d.frameId !== slot.frameId) {
    change.frameId = slot.frameId;
    changed = true;
  }
  const t = slot.text;
  if (d.phrase !== t.phrase || d.kind !== t.kind || currentWordsFor(pair) !== t.wordsFor) {
    change.phrase = t.phrase;
    change.kind = t.kind;
    change.wordsFor = t.wordsFor;
    changed = true;
  }
  if (slot.photo === null) {
    if (d.photo !== null) {
      change.photo = null;
      changed = true;
    }
  } else if (slot.photo !== 'auto') {
    if (d.photo !== slot.photo) {
      change.photo = slot.photo;
      changed = true;
    }
  } else {
    const ranking = rankingFor(slot, pairs);
    if (ranking.length === 0) {
      if (d.photo !== null) {
        change.photo = null;
        changed = true;
      }
    } else if (d.draw === null || d.photo === null || !sameNames(d.draw.pool, ranking.slice(0, 3))) {
      change.photo = 'draw';
      change.rankingOf = slot.rankingPair!;
      changed = true;
    }
  }
  if (d.logo !== logo) {
    change.logo = logo;
    changed = true;
  }
  if (!changed && !d.render.ok) {
    // Never drawn (a record from before phase 2 refused its words): draw it as it stands.
    change.frameId = slot.frameId;
    changed = true;
  }
  return changed ? change : null;
}

/**
 * The picks to save: the places in order, each his own image or a drawn pair; a place with
 * something missing is left out (the rest close up). Null while a place is still to be drawn.
 */
export function pickRequests(slots: readonly Slot[], pairs: readonly StoredPair[], logo: boolean): PickRequest[] | null {
  const out: PickRequest[] = [];
  for (const s of slots) {
    if (s.own !== null) {
      out.push({ kind: 'own', file: s.own });
      continue;
    }
    if (s.missing !== null) continue;
    if (wantedChange(s, pairs, logo) !== null) return null;
    out.push({ kind: 'made', pair: s.n });
  }
  return out;
}

export function samePicks(requests: readonly PickRequest[], saved: readonly PickView[]): boolean {
  return requests.length === saved.length && requests.every((r, i) => {
    const p = saved[i].pick;
    return r.kind === 'own' ? p.kind === 'own' && p.file === r.file : p.kind === 'made' && p.pair === r.pair;
  });
}

/** The frames, texts, photos and own images the saved picks stand for (the window reopened). */
export function selectionFromPicks(picks: readonly PickView[], pairs: readonly StoredPair[]): {
  frames: string[]; texts: TextOption[]; photos: Record<number, PhotoChoice>; own: Record<number, string>;
} {
  const options = textOptions(pairs);
  const frames: string[] = [];
  const texts: TextOption[] = [];
  const photos: Record<number, PhotoChoice> = {};
  const own: Record<number, string> = {};
  picks.forEach((view, i) => {
    const n = i + 1;
    const pick = view.pick;
    if (pick.kind === 'own') {
      own[n] = pick.file;
      return;
    }
    const pair = pairs.find((p) => p.pair === pick.pair);
    if (pair === undefined) return;
    const d = pair.default;
    frames.push(d.frameId);
    const wordsFor = currentWordsFor(pair);
    if (d.phrase === null) texts.push(NO_TEXT);
    else if (d.kind === null || wordsFor === null) texts.push(typedText(d.phrase));
    else {
      texts.push(options.find((o) => o.key === generatedKey(wordsFor, d.phrase!))
        ?? { key: generatedKey(wordsFor, d.phrase), phrase: d.phrase, kind: d.kind, wordsFor, pair: pairs.find((p) => p.title === wordsFor)?.pair ?? pair.pair });
    }
    photos[n] = d.draw !== null ? 'auto' : d.photo;
  });
  return { frames, texts, photos, own };
}

/** "0:07", "1:23", "12:04". */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Drawing thumbnail 2 failed: The reaction photo "laugh" is not in the app's library any more." */
export function failureLine(what: string, err: unknown): string {
  const message = err instanceof Error ? err.message : String(err);
  return `${what} failed: ${message}`;
}

/**
 * Every action of the window, one at a time in the order asked: while one runs, `busy` names it
 * (with when it started, for the running clock); a failure becomes `failed(line)` naming what
 * failed and the main process's own sentence, and the action answers null. Nothing is dropped and
 * nothing fails quietly.
 */
export class ActionRunner {
  private chain: Promise<unknown> = Promise.resolve();

  constructor(
    private readonly on: { busy(state: { what: string; since: number } | null): void; failed(line: string): void },
    private readonly now: () => number = Date.now,
  ) {}

  run<T>(what: string, fn: () => Promise<T>): Promise<T | null> {
    const next = this.chain.then(async () => {
      this.on.busy({ what, since: this.now() });
      try {
        return await fn();
      } catch (err) {
        this.on.failed(failureLine(what, err));
        return null;
      } finally {
        this.on.busy(null);
      }
    });
    this.chain = next.then(() => undefined, () => undefined);
    return next;
  }
}
