/**
 * THE THUMBNAILS WINDOW'S PICKING RULES, pure. Two rounds with Owen on 2026-09-29:
 *
 *   First: "the images it gathered from the original section should be at the top. i pick three. the
 *   text it generated. i pick three. it overlays them."
 *   Then: "just let me pick the image of myself that goes in the corner ... for my images, let me click
 *   1->2->3, same as everything else ... the thumbnail text should be a list i pick. 1, 2, 3 ... we dont
 *   need to separate by scene. just show a list of possible images to use ... the 'generate
 *   thumbnails' button should be at the bottom".
 *
 *   - FRAMES, TEXTS and PHOTOS are each picked in click order, up to three; clicking a picked one
 *     takes it out and the rest close up (the titles' rule, publish-state.ts toggleTitle). The
 *     frames are ONE flat list in time order (`frameList`): at most two per scene, the sharpest,
 *     chosen on the CPU. Nothing ranks them (the vision model's frame scoring was removed
 *     2026-09-29: Owen picks the frames, so the run gives no pair a frame of its own).
 *   - "No photo" can be picked more than once (thumbnail 1 and 3 without a photo, 2 with one); a
 *     thumbnail beyond the photos picked has none. There is no ranking and no percentage any more.
 *   - THUMBNAIL n is frame n + text n + photo n + the logo, drawn into pair n of the record. Nothing
 *     is drawn until Owen presses Generate thumbnails (at the bottom): then every place that has a
 *     frame and a text is drawn (`drawChange`) and the places are saved as the ordered picks
 *     (`pickRequests`; pick 1 is the video's thumbnail, pick n goes with title n in an A/B test).
 *     A card whose picks changed after it was drawn says so (`wantedChange` is not null).
 *   - Owen's own image can take any of the three places instead; the frames, texts and photos then
 *     fill the other places in order.
 *   - Every action goes through ONE runner that shows what is running and turns any failure into a
 *     line on screen (`ActionRunner`): nothing reaches only the log.
 *
 * No Angular and only type imports, so tools/thumbnail-pipeline-checks.js runs it under plain Node.
 */
import type { ItemThumbnails, PairChange, PickRequest, PickView, StoredPair, WordKind } from './thumbnails.types';

export const MAX_PICKS = 3;

const KINDS: readonly WordKind[] = ['claim', 'stakes', 'reaction'];

// ── frames ────────────────────────────────────────────────────────────────────

/**
 * The frames as ONE list (no scenes), in time order: every candidate the record keeps (the run
 * keeps at most two per scene, frame-scenes.ts gridFrames; a record made before 2026-09-29 keeps
 * the frames it sent to the since-removed scoring, and their scores are ignored). Screenshots keep
 * their own order (screenshot 1, 2, 3: all at t 0, and the sort is stable).
 */
export function frameList(record: Pick<ItemThumbnails, 'frames'> | null): string[] {
  if (record === null) return [];
  return [...record.frames].sort((a, b) => a.t - b.t).map((f) => f.id);
}

// ── text ──────────────────────────────────────────────────────────────────────

/** One line of text Owen can pick: generated words (labelled with their title and kind), typed words, or no text. */
export interface TextOption {
  key: string;
  /** Null: "No text". */
  phrase: string | null;
  kind: WordKind | null;
  /** The title the words were written for; null for typed words or no text. */
  wordsFor: string | null;
  /** The pair whose words list it came from, or null. */
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

// ── photos ────────────────────────────────────────────────────────────────────

/** One of Owen's photo picks: a reaction photo by name, or "No photo" (name null). */
export interface PhotoOption {
  key: string;
  name: string | null;
}

export function photoOption(name: string): PhotoOption {
  return { key: `photo|${name}`, name };
}

/** A photo clicked: picked last, or taken out (the rest close up), a fourth refused. */
export function togglePhoto(list: readonly PhotoOption[], name: string): { list: PhotoOption[]; refused: string | null } {
  return togglePick(list, photoOption(name), (p) => p.key, 'photos');
}

/**
 * "No photo" clicked: one more place without a photo, last in the order (it can be picked more than
 * once, so thumbnails 1 and 3 can go without while 2 has one). Each is taken out on its own badge
 * (`removePhotoAt`).
 */
export function addNoPhoto(list: readonly PhotoOption[]): { list: PhotoOption[]; refused: string | null } {
  if (list.length >= MAX_PICKS) return { list: [...list], refused: `Up to ${MAX_PICKS} photos can be picked. Click a picked one to take it out first.` };
  let k = 1;
  while (list.some((p) => p.key === `none|${k}`)) k++;
  return { list: [...list, { key: `none|${k}`, name: null }], refused: null };
}

export function removePhotoAt(list: readonly PhotoOption[], index: number): PhotoOption[] {
  return list.filter((_, i) => i !== index);
}

/** The pick numbers (1-based) a photo holds; for "No photo" (null) every place it holds. */
export function photoNumbers(list: readonly PhotoOption[], name: string | null): number[] {
  return list.flatMap((p, i) => (p.name === name ? [i + 1] : []));
}

// ── the places ────────────────────────────────────────────────────────────────

export interface Slot {
  /** The thumbnail's place, 1 to 3 (pair n is drawn for it). */
  n: number;
  /** Owen's own image in this place, or null. */
  own: string | null;
  /** Which frame, text and photo pick this place takes (0-based), or null for his own image. */
  pickIndex: number | null;
  frameId: string | null;
  text: TextOption | null;
  /** The photo drawn on it: photo pick `pickIndex`, or null (No photo, or none picked for it). */
  photo: string | null;
  /** True when a photo pick (a photo or "No photo") stands for this place; false: none picked for it. */
  photoPicked: boolean;
  /** What is missing before it can be drawn; null when it can be (or it is his own image). */
  missing: string | null;
}

export function planSlots(input: {
  pairs: readonly StoredPair[];
  frames: readonly string[];
  texts: readonly TextOption[];
  photos: readonly PhotoOption[];
  own: Readonly<Record<number, string>>;
}): Slot[] {
  const { pairs } = input;
  const has = (n: number) => pairs.some((p) => p.pair === n);
  const slots: Slot[] = [];
  let k = 0;
  for (let n = 1; n <= MAX_PICKS; n++) {
    const own = input.own[n] ?? null;
    if (own !== null) {
      slots.push({ n, own, pickIndex: null, frameId: null, text: null, photo: null, photoPicked: false, missing: null });
      continue;
    }
    const i = k++;
    const frameId = input.frames[i] ?? null;
    const text = input.texts[i] ?? null;
    const photoPick = input.photos[i];
    let missing: string | null = null;
    if (!has(n)) {
      missing = pairs.length === 0
        ? 'There are no thumbnails to draw into yet.'
        : `This report has ${pairs.length} title and thumbnail pair${pairs.length === 1 ? '' : 's'}, so there is no thumbnail ${n} to draw.`;
    } else if (frameId === null && text === null) missing = `Pick frame ${i + 1} and text ${i + 1} above.`;
    else if (frameId === null) missing = `Pick frame ${i + 1} above.`;
    else if (text === null) missing = `Pick text ${i + 1} above.`;
    slots.push({ n, own: null, pickIndex: i, frameId, text, photo: photoPick?.name ?? null, photoPicked: photoPick !== undefined, missing });
  }
  return slots;
}

/** A place that Generate thumbnails will draw: a frame and a text (or No text) picked, and a pair to draw into. */
export function ready(slot: Slot): boolean {
  return slot.own === null && slot.missing === null && slot.frameId !== null && slot.text !== null;
}

/**
 * Why Generate thumbnails cannot run, or null when it can: it needs at least one place with a frame
 * and a text (or "No text"), or one of Owen's own images. `blocked` is the record's own reason
 * (stopped, no story, off), which only his own images get past.
 */
export function generateBlocked(slots: readonly Slot[], blocked: string | null): string | null {
  const own = slots.some((s) => s.own !== null);
  if (blocked !== null && !own) return blocked;
  if (blocked === null && slots.some(ready)) return null;
  if (own) return null;
  return 'Pick at least one frame and one line of text (or “No text”) above.';
}

/** The title pair n's current words were written for (older records: its own title when the words are generated). */
export function currentWordsFor(pair: StoredPair): string | null {
  const d = pair.default;
  if (d.wordsFor !== undefined) return d.wordsFor;
  return d.kind !== null ? pair.title : null;
}

/** The whole change that draws place n as picked: what Generate thumbnails sends for every ready place. */
export function drawChange(slot: Slot, logo: boolean): PairChange {
  if (!ready(slot)) throw new Error(`Thumbnail ${slot.n} cannot be drawn: ${slot.missing ?? 'it is your own image'}.`);
  const t = slot.text!;
  return { pair: slot.n, frameId: slot.frameId!, phrase: t.phrase, kind: t.kind, wordsFor: t.wordsFor, photo: slot.photo, logo };
}

/**
 * What pair n's current drawing differs in from place n as picked, or null when it already shows
 * it (or the place cannot be drawn: his own image, or something missing). The window uses it to say
 * a card changed since it was generated, and Generate checks it after drawing.
 */
export function wantedChange(slot: Slot, pairs: readonly StoredPair[], logo: boolean): PairChange | null {
  if (!ready(slot)) return null;
  const pair = pairs.find((p) => p.pair === slot.n);
  if (pair === undefined) return null;
  const d = pair.default;
  const change: PairChange = { pair: slot.n };
  let changed = false;
  if (d.frameId !== slot.frameId) {
    change.frameId = slot.frameId!;
    changed = true;
  }
  const t = slot.text!;
  if (d.phrase !== t.phrase || d.kind !== t.kind || currentWordsFor(pair) !== t.wordsFor) {
    change.phrase = t.phrase;
    change.kind = t.kind;
    change.wordsFor = t.wordsFor;
    changed = true;
  }
  if (d.photo !== slot.photo) {
    change.photo = slot.photo;
    changed = true;
  }
  if (d.logo !== logo) {
    change.logo = logo;
    changed = true;
  }
  if (!changed && !d.render.ok) {
    change.frameId = slot.frameId!;
    changed = true;
  }
  return changed ? change : null;
}

/**
 * The picks to save: the places in order, each his own image or a drawn pair; a place with
 * something missing is left out (the rest close up). Null while a place does not show its picks yet.
 */
export function pickRequests(slots: readonly Slot[], pairs: readonly StoredPair[], logo: boolean): PickRequest[] | null {
  const out: PickRequest[] = [];
  for (const s of slots) {
    if (s.own !== null) {
      out.push({ kind: 'own', file: s.own });
      continue;
    }
    if (!ready(s)) continue;
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

/**
 * The frames, texts, photos and own images the saved picks stand for (the window reopened). A
 * trailing run of "No photo" is left out: a place beyond the photos picked has none anyway. A pick
 * is a drawn pair, so it has its frame; one without is refused (the record and the picks disagree).
 */
export function selectionFromPicks(picks: readonly PickView[], pairs: readonly StoredPair[]): {
  frames: string[]; texts: TextOption[]; photos: PhotoOption[]; own: Record<number, string>;
} {
  const options = textOptions(pairs);
  const frames: string[] = [];
  const texts: TextOption[] = [];
  let photos: PhotoOption[] = [];
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
    if (d.frameId === null) throw new Error(`Pick ${n} is thumbnail ${pair.pair}, which has no frame: the saved picks and the record disagree.`);
    frames.push(d.frameId);
    const wordsFor = currentWordsFor(pair);
    if (d.phrase === null) texts.push(NO_TEXT);
    else if (d.kind === null || wordsFor === null) texts.push(typedText(d.phrase));
    else {
      texts.push(options.find((o) => o.key === generatedKey(wordsFor, d.phrase!))
        ?? { key: generatedKey(wordsFor, d.phrase), phrase: d.phrase, kind: d.kind, wordsFor, pair: pairs.find((p) => p.title === wordsFor)?.pair ?? pair.pair });
    }
    photos = d.photo === null ? addNoPhoto(photos).list : [...photos, photoOption(d.photo)];
  });
  while (photos.length > 0 && photos[photos.length - 1].name === null) photos = photos.slice(0, -1);
  return { frames, texts, photos, own };
}

/**
 * "Start from the suggested words": each pair's words as the run chose them (pair 1 its first
 * claim, pair 2 its first stakes, pair 3 its first reaction), in pair order. The frames and photos
 * are Owen's to pick; the run suggests neither.
 */
export function suggestedTexts(pairs: readonly StoredPair[]): TextOption[] {
  const options = textOptions(pairs);
  return [...pairs].sort((a, b) => a.pair - b.pair).slice(0, MAX_PICKS).map((pair) => {
    const d = pair.default;
    const wordsFor = currentWordsFor(pair);
    if (d.phrase === null) return NO_TEXT;
    if (d.kind === null || wordsFor === null) return typedText(d.phrase);
    const option = options.find((o) => o.key === generatedKey(wordsFor, d.phrase!));
    if (option === undefined) throw new Error(`Pair ${pair.pair}'s words “${d.phrase}” are not among the words written for “${wordsFor}”.`);
    return option;
  });
}

// ── the runner ────────────────────────────────────────────────────────────────

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
