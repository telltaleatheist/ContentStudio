/**
 * ONE THUMBNAIL, rendered deterministically: the frame, the face-safe text, the reserved (empty)
 * slots, written to disk inside YouTube's bounds.
 *
 * Output is always 1280x720 (the frame YouTube stores; a 1920x1080 source is scaled down), PNG
 * first. A PNG over the 2 MiB limit is written as JPEG instead, quality 92 then 85, and the result
 * says so (Law 8). The written file then goes through the app's own strict door,
 * `validateThumbnailFile` (thumbnail-validate.ts, LEDGER #219), so nothing this tab writes could
 * be refused at upload.
 *
 * A phrase that does not fit at the smallest allowed letter size is NOT rendered: the result is
 * `{ ok: false, reason }` in plain words, and the operator picks another option (layout.ts).
 */
import * as fs from 'fs';
import * as path from 'path';
import { MAX_THUMBNAIL_BYTES, measureThumbnailFile, validateThumbnailFile } from '../publish/thumbnail-validate';
import { bytesOfDataUrl, dataUrlOf, type ThumbnailCanvas } from './canvas-page';
import { REFERENCE_SIZE, phraseWords, placeReaction, planText, type ReactionPlacement, type Rect, type TextPlan, type ThumbnailStyle } from './layout';

export const OUTPUT_WIDTH = 1280;
export const OUTPUT_HEIGHT = 720;

/** The JPEG qualities tried, in order, when the PNG is over the byte limit. */
export const JPEG_QUALITIES = [0.92, 0.85] as const;

export type RenderResult =
  | {
      ok: true;
      path: string;
      bytes: number;
      format: 'png' | 'jpeg';
      /** Face boxes in output pixels, as the detector found them (unpadded). */
      faces: Rect[];
      plan: TextPlan | null;
      /** Where the reaction photo was drawn, or null for none. */
      reaction: ReactionPlacement | null;
      /** Plain sentences worth showing: a JPEG fallback-by-rule, no faces found. */
      notes: string[];
    }
  | { ok: false; reason: string };

export async function renderThumbnail(input: {
  canvas: ThumbnailCanvas;
  /** The full-size frame (PNG or JPEG). */
  frame: string;
  /** The words, or null for an image-only variant. */
  phrase: string | null;
  style: ThumbnailStyle;
  /** The trimmed reaction photo (PNG bytes and size), or null for none. */
  photo: { png: Buffer; width: number; height: number; note: string | null } | null;
  /** Where to write, WITHOUT extension: `.png` or `.jpg` is added. */
  outStem: string;
}): Promise<RenderResult> {
  const meta = measureThumbnailFile(input.frame);
  if (Math.abs(meta.width / meta.height - 16 / 9) > 0.01) {
    throw new Error(`The frame ${path.basename(input.frame)} is ${meta.width}x${meta.height}, not 16:9.`);
  }
  const image = dataUrlOf(input.frame);
  const scale = OUTPUT_WIDTH / meta.width;
  const faces = (await input.canvas.detectFaces(image)).map((f) => ({ x: f.x * scale, y: f.y * scale, w: f.w * scale, h: f.h * scale }));
  const notes: string[] = [];
  if (faces.length === 0) notes.push('The face detector found no face in this frame, so the text was placed with only the reserved slots to avoid.');

  const reaction = input.photo === null ? null : placeReaction(input.photo.width, input.photo.height, input.style, OUTPUT_WIDTH, OUTPUT_HEIGHT);
  if (input.photo?.note) notes.push(input.photo.note);
  const reactionDraw = reaction === null ? null : {
    image: `data:image/png;base64,${input.photo!.png.toString('base64')}`,
    x: reaction.x, y: reaction.y, w: reaction.w, h: reaction.h, outlinePx: reaction.outlinePx,
  };

  let plan: TextPlan | null = null;
  if (input.phrase !== null) {
    const words = phraseWords(input.phrase);
    const measured = await input.canvas.measure(input.style.font, words, REFERENCE_SIZE);
    const placed = planText({ words, ...measured }, faces, input.style, OUTPUT_WIDTH, OUTPUT_HEIGHT, reaction?.avoid ?? null);
    if (!placed.ok) return { ok: false, reason: placed.reason };
    plan = placed.plan;
  }

  fs.mkdirSync(path.dirname(input.outStem), { recursive: true });
  let format: 'png' | 'jpeg' = 'png';
  let bytes = bytesOfDataUrl(await input.canvas.draw({ image, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, style: input.style, plan, reaction: reactionDraw, jpegQuality: null }));
  if (bytes.length > MAX_THUMBNAIL_BYTES) {
    const pngBytes = bytes.length;
    for (const quality of JPEG_QUALITIES) {
      bytes = bytesOfDataUrl(await input.canvas.draw({ image, width: OUTPUT_WIDTH, height: OUTPUT_HEIGHT, style: input.style, plan, reaction: reactionDraw, jpegQuality: quality }));
      format = 'jpeg';
      if (bytes.length <= MAX_THUMBNAIL_BYTES) {
        notes.push(`Saved as JPEG (quality ${Math.round(quality * 100)}): as PNG it was ${(pngBytes / 1048576).toFixed(1)} MB, over YouTube's 2 MB limit.`);
        break;
      }
    }
    if (bytes.length > MAX_THUMBNAIL_BYTES) {
      throw new Error(`The thumbnail is ${(bytes.length / 1048576).toFixed(1)} MB even as JPEG at quality ${Math.round(JPEG_QUALITIES[JPEG_QUALITIES.length - 1] * 100)}, over YouTube's 2 MB limit.`);
    }
  }
  const out = `${input.outStem}${format === 'png' ? '.png' : '.jpg'}`;
  // A stale copy in the other format would sit beside the new one with the same name; remove it.
  const other = `${input.outStem}${format === 'png' ? '.jpg' : '.png'}`;
  if (fs.existsSync(other)) fs.unlinkSync(other);
  fs.writeFileSync(out, bytes);
  validateThumbnailFile(out);
  return { ok: true, path: out, bytes: bytes.length, format, faces, plan, reaction, notes };
}
