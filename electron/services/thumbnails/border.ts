/**
 * OWEN'S BORDER OVERLAY (2026-09-29: "this goes over the thumbnail. it's a border i always use"): one
 * PNG he keeps in the app (photo-library.ts `<userData>/thumbnail-lab/border/`), drawn over the whole
 * frame, scaled to the output size with a normal alpha composite, BEFORE the words, the reaction
 * photo and the logo (canvas-page.ts). His is 1920x1080 RGBA: a transparent middle (alpha 0) and
 * soft black edges. It replaces the procedural "dark edges" vignette, which is gone from the look.
 *
 * A missing file, a file that is not a picture, a fully transparent or fully opaque one (it would
 * draw nothing, or hide the frame), or one that is not 16:9 (it is stretched to the picture, so any
 * other shape would be distorted) is refused naming the file (Law 1).
 */
import { nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface Border {
  file: string;
  name: string;
  /** The file's bytes (a PNG), drawn by the page scaled to the output. */
  png: Buffer;
  width: number;
  height: number;
}

const cache = new Map<string, { mtimeMs: number; border: Border }>();

export function readBorder(file: string): Border {
  if (!fs.existsSync(file)) throw new Error(`The border file is not there: ${file}`);
  if (!fs.statSync(file).isFile()) throw new Error(`The border is not a file: ${file}`);
  const mtimeMs = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.border;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`The border file could not be read as a PNG picture: ${file}`);
  const { width, height } = image.getSize();
  if (Math.abs(width / height - 16 / 9) > 0.01) {
    throw new Error(`The border file is ${width}x${height}, not 16:9 like a thumbnail, so it would be stretched out of shape: ${file}`);
  }
  const bitmap = image.toBitmap();
  if (bitmap.length !== width * height * 4) throw new Error(`The border file decoded to ${bitmap.length} bytes for ${width}x${height}: ${file}`);
  let clear = 0;
  let solid = 0;
  for (let i = 3; i < bitmap.length; i += 4) {
    if (bitmap[i] === 0) clear++;
    else if (bitmap[i] === 255) solid++;
  }
  const pixels = width * height;
  if (clear === pixels) throw new Error(`The border file is fully transparent, so there is nothing to draw: ${file}`);
  if (solid === pixels) throw new Error(`The border file has no transparent part, so it would hide the whole picture: ${file}`);
  const border: Border = { file, name: path.basename(file), png: fs.readFileSync(file), width, height };
  cache.set(file, { mtimeMs, border });
  return border;
}

/** A small picture of the border for Thumbnail look (the dialog shows it on grey, so its transparent middle reads). */
export function borderPreview(border: Border, width = 192): string {
  const small = nativeImage.createFromBuffer(border.png).resize({ width, quality: 'good' });
  return small.toDataURL();
}
