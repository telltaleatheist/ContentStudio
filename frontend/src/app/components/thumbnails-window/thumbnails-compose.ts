/**
 * THE THUMBNAILS WINDOW'S CARD RULES, pure (the card editor, 2026-09-29). Owen:
 *
 *   "maybe i select the thumbnail card i want to fill. then i select the frame, the text, and the
 *   image of myself to use in it. then i click a different card and do the same. ... i should be
 *   able to hit a zoom button on a frame and resize (zoom/shrink) or reposition any of the three
 *   elements. logo goes in top right automatically, border goes on top of the image automatically
 *   and neither of those two should be edited. as soon as i click something, it adds it to the
 *   frame. if i unclick it, it removes it from the frame"
 *
 *   - THREE CARDS, card n = title and thumbnail pair n. One is ACTIVE. Clicking a frame, a line of
 *     text or a photo in the trays puts it on the active card at once, replacing what it had;
 *     clicking the one the active card already has takes it off (`toggleFrame`, `toggleText`,
 *     `togglePhoto`). The same frame, text or photo may sit on several cards (`cardsUsing` gives
 *     the tray's badges).
 *   - A card saved before 2026-09-29 may hold Owen's own finished image (an own-image pick): it is
 *     read back where it sat and saved as it is; clicking a tray item on it puts the card back to
 *     frames and text. Nothing makes a new one: his images are ADDED AS FRAMES now (dropped on a
 *     card, which `putFrame` fills, or on the Frames tray), so the words, photo, logo and border go
 *     on top and Edit zooms them. `clearCard` empties one card.
 *   - TEXT (`textOptions`, `textGroups`): every line the model wrote for this video, grouped by the
 *     title it was written for; a set followed by a newer one stays under "Earlier options", so a
 *     line on a card never disappears.
 *   - EDITS (`Card.adjust`, shared CardAdjust): the frame zoomed or moved, the words in his own box,
 *     the photo moved or resized. A new frame starts unzoomed; taking the words or the photo off
 *     drops their edit; another photo keeps the place the last one had.
 *   - SAVING (`planCards`, `cardRequests`): a card with a frame is drawn; his own image is saved as
 *     it is; a card with no frame is left out, and says why. The saved cards in order are the picks:
 *     the first saved card is Pick 1 (the video's thumbnail), and pick k goes with title k.
 *   - Reading the saved state back (`cardsFromView`) and what changed since (`unsavedCards`).
 *   - Every action goes through ONE runner that shows what is running and turns any failure into a
 *     line on screen (`ActionRunner`): nothing reaches only the log.
 *
 * No Angular. The keeper (tools/thumbnail-pipeline-checks.js) runs it under plain Node, handing the
 * compiled shared layout for './thumbnail-shared'.
 */
import {
  FRAME_MIN_COVER,
  FRAME_SCALE_MAX,
  FRAME_SCALE_MIN,
  PHOTO_HEIGHT_MAX,
  PHOTO_HEIGHT_MIN,
  TEXT_BOX_MIN,
  validateAdjust,
  type CardAdjust,
  type FrameView,
  type PhotoPlaceEdit,
  type TextBoxEdit,
} from './thumbnail-shared';
import type { CardRequest, EarlierWords, ItemThumbnails, PickView, StoredPair, StoredWords, WordKind } from './thumbnails.types';

export const CARD_COUNT = 3;

const KINDS: readonly WordKind[] = ['claim', 'stakes', 'reaction'];

// ── frames ────────────────────────────────────────────────────────────────────

/**
 * The frames as ONE list (no scenes): the images Owen added first, in the order he added them,
 * then every other candidate the record keeps in time order (the run keeps at most two per scene,
 * look-alikes dropped). Screenshots keep their own order (screenshot 1, 2, 3: all at t 0, and the
 * sort is stable).
 */
export function frameList(record: Pick<ItemThumbnails, 'frames'> | null): string[] {
  if (record === null) return [];
  const added = record.frames.filter((f) => f.origin === 'added');
  const rest = record.frames.filter((f) => f.origin !== 'added').sort((a, b) => a.t - b.t);
  return [...added, ...rest].map((f) => f.id);
}

// ── text ──────────────────────────────────────────────────────────────────────

/** One line of text for a card: generated words (labelled with their title and kind), or words Owen typed. */
export interface TextOption {
  key: string;
  phrase: string;
  kind: WordKind | null;
  /** The title the words were written for; null for typed words. */
  wordsFor: string | null;
  /** The pair whose words list it came from, or null. */
  pair: number | null;
}

function generatedKey(wordsFor: string, phrase: string): string {
  return `for|${wordsFor}|${phrase}`;
}

function linesOf(words: StoredWords, title: string, pair: number | null, seen: Set<string>): TextOption[] {
  const out: TextOption[] = [];
  for (const kind of KINDS) {
    for (const phrase of words[kind]) {
      const key = generatedKey(title, phrase);
      if (seen.has(key)) continue;
      seen.add(key);
      out.push({ key, phrase, kind, wordsFor: title, pair });
    }
  }
  return out;
}

/**
 * Every generated line: pair by pair (the pairs' order is the titles' order), claim, stakes,
 * reaction; then the earlier sets' lines (newest first) not already listed. One line written for
 * one title is listed once.
 */
export function textOptions(pairs: readonly StoredPair[], earlier: readonly EarlierWords[] = []): TextOption[] {
  const seen = new Set<string>();
  const out: TextOption[] = [];
  for (const p of [...pairs].sort((a, b) => a.pair - b.pair)) out.push(...linesOf(p.words, p.title, p.pair, seen));
  for (const e of earlier) out.push(...linesOf(e, e.title, null, seen));
  return out;
}

/** The Text tray's groups: one per title the words were written for, its current lines and its earlier ones. */
export interface TextGroup {
  /** The pair whose title this is (its New options / More options write for it); null: a title no pair has now. */
  pair: number | null;
  title: string;
  current: TextOption[];
  earlier: TextOption[];
}

/**
 * The Text tray, one group per pair (its title, its current lines), each with the earlier lines
 * written for that same title; then a group for each title only earlier sets were written for (a
 * pair since given another title). Every generated line appears exactly once.
 */
export function textGroups(pairs: readonly StoredPair[], earlier: readonly EarlierWords[] = []): TextGroup[] {
  const seen = new Set<string>();
  const sorted = [...pairs].sort((a, b) => a.pair - b.pair);
  const groups: TextGroup[] = sorted.map((p) => ({ pair: p.pair, title: p.title, current: linesOf(p.words, p.title, p.pair, seen), earlier: [] }));
  for (const e of earlier) {
    let g = groups.find((x) => x.title === e.title);
    if (g === undefined) {
      g = { pair: null, title: e.title, current: [], earlier: [] };
      groups.push(g);
    }
    g.earlier.push(...linesOf(e, e.title, null, seen));
  }
  return groups.filter((g) => g.current.length > 0 || g.earlier.length > 0 || g.pair !== null);
}

/** Words Owen typed. Refused when empty. */
export function typedText(phrase: string): TextOption {
  const words = phrase.trim();
  if (words === '') throw new Error('Type the words first.');
  return { key: `typed|${words}`, phrase: words, kind: null, wordsFor: null, pair: null };
}

/** Generated words as a text option (the words' own title and kind), found in the tray or made as stored. */
export function generatedText(options: readonly TextOption[], kind: WordKind, phrase: string, wordsFor: string, pair: number | null): TextOption {
  return options.find((o) => o.key === generatedKey(wordsFor, phrase)) ?? { key: generatedKey(wordsFor, phrase), phrase, kind, wordsFor, pair };
}

// ── the cards ─────────────────────────────────────────────────────────────────

export interface Card {
  /** 1 to CARD_COUNT: card n is drawn into title and thumbnail pair n. */
  n: number;
  /** Owen's own image on this card (it replaces the frame, text and photo), with a picture of it. */
  own: { file: string; picture: string } | null;
  frameId: string | null;
  text: TextOption | null;
  photo: string | null;
  /** His edits; {} for none. */
  adjust: CardAdjust;
}

export function emptyCard(n: number): Card {
  return { n, own: null, frameId: null, text: null, photo: null, adjust: {} };
}

export function emptyCards(): Card[] {
  return Array.from({ length: CARD_COUNT }, (_, i) => emptyCard(i + 1));
}

function withCard(cards: readonly Card[], n: number, change: (c: Card) => Card): Card[] {
  if (!cards.some((c) => c.n === n)) throw new Error(`There is no thumbnail ${n}; there are ${cards.length}.`);
  return cards.map((c) => (c.n === n ? change(c) : c));
}

function without<K extends keyof CardAdjust>(adjust: CardAdjust, key: K): CardAdjust {
  const out = { ...adjust };
  delete out[key];
  return out;
}

/**
 * A frame clicked in the tray: on the active card (replacing its frame, which starts unzoomed), or
 * off it when it is the frame the card has. His own image on the card gives way to frames and text.
 */
export function toggleFrame(cards: readonly Card[], n: number, frameId: string): Card[] {
  return withCard(cards, n, (c) => {
    if (c.own === null && c.frameId === frameId) return { ...c, frameId: null, adjust: without(c.adjust, 'frame') };
    return { ...c, own: null, frameId, adjust: without(c.adjust, 'frame') };
  });
}

/** A line of text clicked: on the active card (his text box, if any, kept for the new words), or off it (and its box). */
export function toggleText(cards: readonly Card[], n: number, option: TextOption): Card[] {
  return withCard(cards, n, (c) => {
    if (c.own === null && c.text !== null && c.text.key === option.key) return { ...c, text: null, adjust: without(c.adjust, 'text') };
    return { ...c, own: null, text: option };
  });
}

/** A photo clicked: on the active card (where he put the last one, if he moved it), or off it (and its place). */
export function togglePhoto(cards: readonly Card[], n: number, name: string): Card[] {
  return withCard(cards, n, (c) => {
    if (c.own === null && c.photo === name) return { ...c, photo: null, adjust: without(c.adjust, 'photo') };
    return { ...c, own: null, photo: name };
  });
}

/**
 * A frame put on card n whatever it had (an image Owen dropped on the card): like a tray click,
 * except that it never takes the frame off. It starts unzoomed; the words and photo stay.
 */
export function putFrame(cards: readonly Card[], n: number, frameId: string): Card[] {
  return withCard(cards, n, (c) => ({ ...c, own: null, frameId, adjust: c.own === null && c.frameId === frameId ? c.adjust : without(c.adjust, 'frame') }));
}

export function clearCard(cards: readonly Card[], n: number): Card[] {
  return withCard(cards, n, () => emptyCard(n));
}

/**
 * The card editor's result for card n, checked as the save checks it: an edit for a piece the card
 * does not have is refused (the editor offers only what is on the card).
 */
export function setAdjust(cards: readonly Card[], n: number, adjust: CardAdjust): Card[] {
  const checked = validateAdjust(adjust, `Thumbnail ${n}`);
  return withCard(cards, n, (c) => {
    if (checked.frame !== undefined && c.frameId === null) throw new Error(`Thumbnail ${n} has no frame to zoom.`);
    if (checked.text !== undefined && c.text === null) throw new Error(`Thumbnail ${n} has no text to place.`);
    if (checked.photo !== undefined && c.photo === null) throw new Error(`Thumbnail ${n} has no photo to place.`);
    return { ...c, adjust: checked };
  });
}

/** The cards (numbers) a tray item is on: the tray's badges. */
export function cardsUsing(cards: readonly Card[], on: (c: Card) => boolean): number[] {
  return cards.filter((c) => c.own === null && on(c)).map((c) => c.n);
}

/** What happens to one card on Save thumbnails. */
export interface CardPlan {
  n: number;
  /** 'made': drawn from its frame; 'own': his image as it is; null: left out (`why`). */
  saved: 'made' | 'own' | null;
  why: string | null;
  /** Its pick number when saved (the saved cards in order: the first is Pick 1), else null. */
  position: number | null;
}

/**
 * Why a card cannot hold frames and text: the report has no pair n (one per title, at most three)
 * to draw it into. Null when it can.
 */
export function noPairFor(n: number, pairs: readonly StoredPair[]): string | null {
  if (pairs.some((p) => p.pair === n)) return null;
  return pairs.length === 0
    ? `Thumbnail ${n} has no title to go with yet, so it cannot be filled.`
    : `There ${pairs.length === 1 ? 'is 1 title' : `are ${pairs.length} titles`}, so thumbnail ${n} has no title to go with.`;
}

export function planCards(cards: readonly Card[], pairs: readonly StoredPair[]): CardPlan[] {
  let k = 0;
  return [...cards].sort((a, b) => a.n - b.n).map((c) => {
    if (c.own !== null) return { n: c.n, saved: 'own', why: null, position: ++k };
    if (c.frameId !== null) {
      const noPair = noPairFor(c.n, pairs);
      if (noPair !== null) return { n: c.n, saved: null, why: noPair, position: null };
      return { n: c.n, saved: 'made', why: null, position: ++k };
    }
    if (c.text !== null || c.photo !== null) return { n: c.n, saved: null, why: 'It has no frame yet, so it is left out when you save. Pick a frame for it.', position: null };
    return { n: c.n, saved: null, why: 'Empty: it is left out when you save.', position: null };
  });
}

/** The cards as Save thumbnails sends them: all of them, in order. */
export function cardRequests(cards: readonly Card[], pairs: readonly StoredPair[]): CardRequest[] {
  const plans = planCards(cards, pairs);
  return [...cards].sort((a, b) => a.n - b.n).map((c): CardRequest => {
    const plan = plans.find((p) => p.n === c.n)!;
    if (plan.saved === 'own') return { card: c.n, kind: 'own', file: c.own!.file };
    if (plan.saved === 'made') {
      return {
        card: c.n, kind: 'made', frameId: c.frameId!,
        phrase: c.text?.phrase ?? null, textKind: c.text?.kind ?? null, wordsFor: c.text?.wordsFor ?? null,
        photo: c.photo, adjust: c.adjust,
      };
    }
    return { card: c.n, kind: 'empty' };
  });
}

/** Why Save thumbnails cannot run, or null: nothing is saved while no card can be (and nothing was saved before). */
export function saveBlocked(cards: readonly Card[], pairs: readonly StoredPair[], savedBefore: number): string | null {
  if (planCards(cards, pairs).some((p) => p.saved !== null) || savedBefore > 0) return null;
  return 'Put a frame (or your own image) on at least one thumbnail first.';
}

// ── the saved state ───────────────────────────────────────────────────────────

/** The title pair n's current words were written for (older records: its own title when the words are generated). */
export function currentWordsFor(pair: StoredPair): string | null {
  const d = pair.default;
  if (d.wordsFor !== undefined) return d.wordsFor;
  return d.kind !== null ? pair.title : null;
}

/**
 * The cards as saved (the window opened, or a save came back). Card n shows pair n when the pair
 * has a frame (what Save stored, or screenshot n), with his edits; his own image sits on the card it
 * was saved on (picks saved before the card editor: the card of its position). The run's suggested
 * words on a pair with no frame are not a card's content: that card starts empty. Two picks claiming
 * one card is refused (the record and the picks disagree).
 */
export function cardsFromView(view: { record: Pick<ItemThumbnails, 'pairs' | 'earlierWords'> | null; picks: readonly PickView[] }): Card[] {
  const pairs = view.record?.pairs ?? [];
  const options = textOptions(pairs, view.record?.earlierWords ?? []);
  const cards = emptyCards();
  const taken = new Map<number, string>();
  const claim = (n: number, what: string) => {
    if (n < 1 || n > CARD_COUNT) throw new Error(`${what} is on thumbnail ${n}; there are ${CARD_COUNT}.`);
    const had = taken.get(n);
    if (had !== undefined) throw new Error(`${had} and ${what} are both saved on thumbnail ${n}: the saved picks and the record disagree.`);
    taken.set(n, what);
  };
  for (const p of pairs) {
    if (p.pair < 1 || p.pair > CARD_COUNT || p.default.frameId === null) continue;
    const d = p.default;
    const wordsFor = currentWordsFor(p);
    let text: TextOption | null = null;
    if (d.phrase !== null) text = d.kind === null || wordsFor === null ? typedText(d.phrase) : generatedText(options, d.kind, d.phrase, wordsFor, pairs.find((x) => x.title === wordsFor)?.pair ?? null);
    cards[p.pair - 1] = { n: p.pair, own: null, frameId: d.frameId, text, photo: d.photo, adjust: d.adjust === undefined ? {} : validateAdjust(d.adjust, `Thumbnail ${p.pair}`) };
  }
  view.picks.forEach((v, i) => {
    const pick = v.pick;
    if (pick.kind === 'made') {
      claim(pick.pair, `Pick ${v.n}`);
      if (!pairs.some((p) => p.pair === pick.pair && p.default.frameId !== null)) throw new Error(`Pick ${v.n} is thumbnail ${pick.pair}, which has no frame: the saved picks and the record disagree.`);
      return;
    }
    const n = pick.card ?? i + 1;
    claim(n, `Pick ${v.n} (your own image)`);
    cards[n - 1] = { ...emptyCard(n), own: { file: pick.file, picture: v.picture } };
  });
  return cards;
}

/** The part of a card that is saved (his own image by its file; the picture is only for the eye). */
function savedShape(c: Card): string {
  const a = c.adjust;
  return JSON.stringify([
    c.own?.file ?? null, c.frameId, c.text?.key ?? null, c.photo,
    a.frame === undefined ? null : [a.frame.x, a.frame.y, a.frame.scale],
    a.text === undefined ? null : [a.text.x, a.text.y, a.text.w, a.text.h],
    a.photo === undefined ? null : [a.photo.cx, a.photo.cy, a.photo.h],
  ]);
}

export function sameCard(a: Card, b: Card): boolean {
  return a.n === b.n && savedShape(a) === savedShape(b);
}

/** The cards (numbers) that differ from what is saved. */
export function unsavedCards(cards: readonly Card[], saved: readonly Card[]): number[] {
  return cards.filter((c) => {
    const s = saved.find((x) => x.n === c.n);
    return s === undefined || !sameCard(c, s);
  }).map((c) => c.n);
}

/**
 * The title a saved card goes with: pick k goes with title k, his chosen titles first, then the
 * generated ones. `chosen` false: that title is not picked on the
 * report yet, so the pairing may still change.
 */
export function titleOf(position: number | null, chosen: readonly string[], generated: readonly string[]): { title: string; chosen: boolean } | null {
  if (position === null) return null;
  const all = [...new Set([...chosen, ...generated])];
  const title = all[position - 1];
  return title === undefined ? null : { title, chosen: position <= chosen.length };
}

/** The title a card's generated words were written for, when it is not the chosen title it goes with; else null. */
export function wordsMismatch(card: Card, title: { title: string; chosen: boolean } | null): string | null {
  if (title === null || !title.chosen || card.own !== null || card.text === null || card.text.kind === null || card.text.wordsFor === null) return null;
  return card.text.wordsFor !== title.title ? card.text.wordsFor : null;
}

// ── the editor's arithmetic (fractions of the picture) ────────────────────────

const clamp = (v: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, v));

/** A frame place kept inside the editor's limits (zoom range; a little of the frame always shows). */
export function clampFrame(f: FrameView): FrameView {
  const scale = clamp(f.scale, FRAME_SCALE_MIN, FRAME_SCALE_MAX);
  return { scale, x: clamp(f.x, FRAME_MIN_COVER - scale, 1 - FRAME_MIN_COVER), y: clamp(f.y, FRAME_MIN_COVER - scale, 1 - FRAME_MIN_COVER) };
}

/** Zoom the frame by `factor` about a point of the picture (cx, cy), the point staying put. */
export function zoomFrame(f: FrameView, factor: number, cx: number, cy: number): FrameView {
  const scale = clamp(f.scale * factor, FRAME_SCALE_MIN, FRAME_SCALE_MAX);
  const k = scale / f.scale;
  return clampFrame({ scale, x: cx - (cx - f.x) * k, y: cy - (cy - f.y) * k });
}

/** A text box kept inside the picture and the editor's smallest size. */
export function clampBox(b: TextBoxEdit): TextBoxEdit {
  const w = clamp(b.w, TEXT_BOX_MIN, 1);
  const h = clamp(b.h, TEXT_BOX_MIN, 1);
  return { w, h, x: clamp(b.x, 0, 1 - w), y: clamp(b.y, 0, 1 - h) };
}

/** Grow or shrink a text box by `factor` about its centre. */
export function scaleBox(b: TextBoxEdit, factor: number): TextBoxEdit {
  const cx = b.x + b.w / 2;
  const cy = b.y + b.h / 2;
  const w = clamp(b.w * factor, TEXT_BOX_MIN, 1);
  const h = clamp(b.h * factor, TEXT_BOX_MIN, 1);
  return clampBox({ w, h, x: cx - w / 2, y: cy - h / 2 });
}

/** A photo place kept inside the editor's limits (its centre on the picture). */
export function clampPhoto(p: PhotoPlaceEdit): PhotoPlaceEdit {
  return { cx: clamp(p.cx, 0, 1), cy: clamp(p.cy, 0, 1), h: clamp(p.h, PHOTO_HEIGHT_MIN, PHOTO_HEIGHT_MAX) };
}

// ── the runner ────────────────────────────────────────────────────────────────

/** "0:07", "1:23", "12:04". */
export function clockOf(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

/** "Saving the thumbnails failed: The reaction photo "laugh" is not in the app's library any more." */
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
