/**
 * OWEN'S LOGO (2026-09-28): one image file he chooses in the Thumbnails tab ("Logo: Choose
 * file…"), saved as a path under the store key `thumbnailLab.logo`, read in place (never copied
 * into the app or the repo). His is a 2000x2000 PNG with alpha, a round badge.
 *
 * The picture is cut to its visible pixels (the bounding box of every pixel with any alpha), so a
 * transparent margin in the file never pushes the words away from empty space. Drawing downscales
 * it here with Electron's nativeImage at the exact whole-pixel size layout.ts placeLogo gives
 * ('best' quality), so the page draws it 1:1 and a 2000 px badge lands crisp at ~70 px.
 *
 * A missing file, a file that is not an image, or a fully transparent one is refused naming the
 * file (Law 1). Nothing is drawn and nothing is reserved on-screen as a placeholder when no logo is
 * set; the tab says "none chosen".
 */
import { nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

export interface Logo {
  file: string;
  /** The file name, for the tab. */
  name: string;
  /** The visible part of the picture, PNG. */
  png: Buffer;
  width: number;
  height: number;
  /** The file's own size, for the tab's line. */
  fileWidth: number;
  fileHeight: number;
}

const cache = new Map<string, { mtimeMs: number; logo: Logo }>();

export function readLogo(file: string): Logo {
  if (!fs.existsSync(file)) throw new Error(`The logo file is not there: ${file}`);
  if (!fs.statSync(file).isFile()) throw new Error(`The logo is not a file: ${file}`);
  const mtimeMs = fs.statSync(file).mtimeMs;
  const hit = cache.get(file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.logo;
  const image = nativeImage.createFromPath(file);
  if (image.isEmpty()) throw new Error(`The logo file could not be read as an image (PNG or JPEG): ${file}`);
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (bitmap.length !== width * height * 4) throw new Error(`The logo file decoded to ${bitmap.length} bytes for ${width}x${height}: ${file}`);
  let x0 = width, y0 = height, x1 = -1, y1 = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (bitmap[(y * width + x) * 4 + 3] === 0) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
    }
  }
  if (x1 < 0) throw new Error(`The logo file is fully transparent, so there is nothing to draw: ${file}`);
  const crop = { x: x0, y: y0, width: x1 - x0 + 1, height: y1 - y0 + 1 };
  const visible = crop.width === width && crop.height === height ? image : image.crop(crop);
  const logo: Logo = {
    file,
    name: path.basename(file),
    png: visible.toPNG(),
    width: crop.width,
    height: crop.height,
    fileWidth: width,
    fileHeight: height,
  };
  cache.set(file, { mtimeMs, logo });
  return logo;
}

/** The logo downscaled to exactly w x h (whole pixels), PNG. */
export function logoAt(logo: Logo, w: number, h: number): Buffer {
  if (!(Number.isInteger(w) && Number.isInteger(h) && w > 0 && h > 0)) throw new Error(`logoAt: ${w}x${h} is not a whole-pixel size.`);
  if (w === logo.width && h === logo.height) return logo.png;
  return nativeImage.createFromBuffer(logo.png).resize({ width: w, height: h, quality: 'best' }).toPNG();
}

/** A small picture of the logo for the tab. */
export function logoPreview(logo: Logo, height = 48): string {
  const w = Math.max(1, Math.round((logo.width * height) / logo.height));
  return `data:image/png;base64,${logoAt(logo, w, height).toString('base64')}`;
}
