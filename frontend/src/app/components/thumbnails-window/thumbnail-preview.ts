/**
 * THE LIVE CARD PREVIEW (the card editor, 2026-09-29): a card drawn in the window, at once, with the
 * SAME layout (thumbnail-layout.ts composeThumbnail) and the SAME drawing (thumbnail-draw.ts
 * paintThumbnail, measurePhrase) the final render uses, through thumbnail-shared.ts. Nothing here
 * places or draws on its own; it only fetches the pieces and hands them over:
 *
 *   - the frame at full size and the faces Apple Vision finds in it (the render's own search, on the
 *     same file), asked once per frame and kept (`thumbnails:frame-detail`);
 *   - each reaction photo trimmed as the render trims it (`thumbnails:photo-detail`);
 *   - the look, the border and the logo at its drawn size (the view's `compose`).
 *
 * The pictures are decoded once and kept, so a click redraws in well under a second. Differences
 * from the saved PNG that remain, by construction: the frame is sent to the window as a 1280-wide
 * JPEG (the render reads the full PNG), and a photo taller than 900 px is sent at 900 px. Both are
 * drawn into the same rectangles, so only sharpness can differ, never a place or a size.
 */
import type { ElectronService } from '../../services/electron';
import type { Card } from './thumbnails-compose';
import {
  REFERENCE_SIZE,
  composeThumbnail,
  measurePhrase,
  noAdjust,
  paintThumbnail,
  phraseWords,
  type Composition,
} from './thumbnail-shared';
import type { ComposeView } from './thumbnails.types';

type Ready = Extract<ComposeView, { ok: true }>;

/** The view's compose when the preview can be drawn (the look, border and logo were all read). */
export function readyCompose(compose: ComposeView | null | undefined): compose is Ready {
  return compose !== null && compose !== undefined && compose.ok === true;
}

/** Why there can be no preview, or null when there can be one. */
export function composeError(compose: ComposeView | null | undefined): string | null {
  if (compose === null || compose === undefined) return null;
  return 'error' in compose ? compose.error : null;
}

async function decode(src: string): Promise<HTMLImageElement> {
  const img = new Image();
  img.src = src;
  await img.decode();
  return img;
}

interface LoadedFrame {
  image: HTMLImageElement;
  width: number;
  height: number;
  faces: Array<{ x: number; y: number; w: number; h: number }> | null;
  facesError: string | null;
}

interface LoadedPhoto {
  image: HTMLImageElement;
  width: number;
  height: number;
}

/** The pieces one window's previews draw with, fetched once each and kept while the window is open. */
export class PreviewPieces {
  private readonly frames = new Map<string, Promise<LoadedFrame>>();
  private readonly photos = new Map<string, Promise<LoadedPhoto>>();
  private readonly pictures = new Map<string, Promise<HTMLImageElement>>();

  constructor(
    private readonly electron: Pick<ElectronService, 'thumbnailsFrameDetail' | 'thumbnailsPhotoDetail'>,
    private readonly jobId: string,
    private readonly itemId: string,
  ) {}

  /** Whether frame `id` is here already (a card with a frame still loading says so). */
  hasFrame(id: string): boolean {
    return this.frames.has(id);
  }

  frame(id: string): Promise<LoadedFrame> {
    let hit = this.frames.get(id);
    if (hit === undefined) {
      hit = this.electron.thumbnailsFrameDetail(this.jobId, this.itemId, id).then(async (d) => ({
        image: await decode(d.picture), width: d.width, height: d.height, faces: d.faces, facesError: d.facesError,
      }));
      // A failed fetch is not kept: the next draw asks again.
      hit.catch(() => this.frames.delete(id));
      this.frames.set(id, hit);
    }
    return hit;
  }

  photo(name: string): Promise<LoadedPhoto> {
    let hit = this.photos.get(name);
    if (hit === undefined) {
      hit = this.electron.thumbnailsPhotoDetail(name).then(async (d) => ({ image: await decode(d.image), width: d.width, height: d.height }));
      hit.catch(() => this.photos.delete(name));
      this.photos.set(name, hit);
    }
    return hit;
  }

  /** A picture given as a data URL (the border, the logo, his own image), decoded once. */
  picture(src: string): Promise<HTMLImageElement> {
    let hit = this.pictures.get(src);
    if (hit === undefined) {
      hit = decode(src);
      hit.catch(() => this.pictures.delete(src));
      this.pictures.set(src, hit);
    }
    return hit;
  }

  /** Frames prepared again (screenshots given, the frames picked again): what was kept is stale. */
  forgetFrames(): void {
    this.frames.clear();
  }

  /** The look, border or logo changed (Thumbnail look): photos are trimmed again when the library changed. */
  forgetPhotos(): void {
    this.photos.clear();
  }
}

/** What a drawn card says besides its picture. */
export interface CardDrawing {
  /** The placement drawn (the editor's handles use it); null for his own image. */
  composition: Composition | null;
  /** Plain lines: the faces could not be found, the words could not be kept off a face. */
  notes: string[];
}

/**
 * Draw `card` onto `target` (a 1280x720 canvas) exactly as Save thumbnails will draw it. A card
 * with no frame and no image of his own draws nothing (the card says what is missing). Throws with
 * the reason when it cannot be drawn (a font that is not installed, a photo gone from the library).
 */
export async function drawCard(target: HTMLCanvasElement, card: Card, pieces: PreviewPieces, compose: Ready): Promise<CardDrawing | null> {
  const ctx = target.getContext('2d');
  if (ctx === null) throw new Error('The card has no drawing surface.');
  if (card.own !== null) {
    // His file is saved as it is: shown whole, on black where its shape is not 16:9.
    const img = await pieces.picture(card.own.picture);
    const k = Math.min(target.width / img.naturalWidth, target.height / img.naturalHeight);
    const w = img.naturalWidth * k;
    const h = img.naturalHeight * k;
    ctx.fillStyle = '#000000';
    ctx.fillRect(0, 0, target.width, target.height);
    ctx.drawImage(img, (target.width - w) / 2, (target.height - h) / 2, w, h);
    return { composition: null, notes: [] };
  }
  if (card.frameId === null) return null;
  const [frame, photo, border, logo] = await Promise.all([
    pieces.frame(card.frameId),
    card.photo === null ? Promise.resolve(null) : pieces.photo(card.photo),
    compose.border === null ? Promise.resolve(null) : pieces.picture(compose.border),
    compose.logo === null ? Promise.resolve(null) : pieces.picture(compose.logo.image),
  ]);
  const style = compose.style;
  let metrics = null;
  if (card.text !== null) {
    const words = phraseWords(card.text.phrase);
    const measured = measurePhrase({ font: style.font, words, size: REFERENCE_SIZE });
    if ('error' in measured) throw new Error(`The text cannot be measured: ${measured.error}.`);
    metrics = { words, ...measured };
  }
  const composition = composeThumbnail({
    width: compose.width,
    height: compose.height,
    frameSize: { width: frame.width, height: frame.height },
    faces: frame.faces ?? [],
    style,
    adjust: noAdjust(card.adjust) ? null : card.adjust,
    metrics,
    photo: photo === null ? null : { width: photo.width, height: photo.height },
    logo: compose.logo === null ? null : { width: compose.logo.width, height: compose.logo.height },
  });
  const { plan, reaction } = composition;
  const drawn = await paintThumbnail({
    image: frame.image,
    frame: composition.frame,
    width: compose.width,
    height: compose.height,
    style: { font: style.font, fill: style.fill, stroke: style.stroke, patch: style.patch, patchDarken: style.patchDarken },
    border,
    plan: plan === null ? null : { size: plan.size, capPx: plan.capPx, strokePx: plan.strokePx, lines: plan.lines, patches: plan.linePatches },
    reaction: reaction === null || photo === null ? null : { image: photo.image, x: reaction.x, y: reaction.y, w: reaction.w, h: reaction.h, outlinePx: reaction.outlinePx },
    logo: composition.logo === null || logo === null ? null : { image: logo, ...composition.logo },
  });
  ctx.clearRect(0, 0, target.width, target.height);
  ctx.drawImage(drawn, 0, 0, target.width, target.height);
  const notes: string[] = [];
  if (frame.facesError !== null && card.text !== null && card.adjust.text === undefined) {
    notes.push(`The faces in this frame could not be found (${frame.facesError}), so the text here is placed without them. Saving will stop on the same problem.`);
  }
  if (composition.note !== null) notes.push(composition.note);
  return { composition, notes };
}

/**
 * One drawing at a time per surface, the latest asked for winning: a click while a card draws is
 * drawn right after, and the clicks in between are skipped (dragging in the editor asks many times
 * a second).
 */
export class Redrawer {
  private running = false;
  private pending = false;

  constructor(private readonly draw: () => Promise<void>) {}

  request(): void {
    if (this.running) {
      this.pending = true;
      return;
    }
    this.running = true;
    void (async () => {
      try {
        do {
          this.pending = false;
          await this.draw();
        } while (this.pending);
      } finally {
        this.running = false;
      }
    })();
  }
}
