/**
 * OWEN'S REACTION PHOTOS, READ: each photo of the app's library (photo-library.ts, since 2026-09-28;
 * before that a folder read in place) is trimmed to the person (photo-trim.ts) with Electron's
 * nativeImage, the one image codec the main process already has. A photo that cannot be read is
 * refused naming the file (Law 1).
 */
import { nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { photoName, trimToPerson } from './photo-trim';

export interface ReactionPhoto {
  name: string;
  file: string;
}

export interface TrimmedPhoto {
  name: string;
  file: string;
  /** The trimmed photo, PNG. */
  png: Buffer;
  width: number;
  height: number;
  /** A sentence when specks were dropped, else null. */
  note: string | null;
}

const cache = new Map<string, { mtimeMs: number; photo: TrimmedPhoto }>();

export function trimmedPhoto(photo: ReactionPhoto): TrimmedPhoto {
  if (!fs.existsSync(photo.file)) throw new Error(`The reaction photo "${photo.name}" is not there any more: ${photo.file}`);
  const mtimeMs = fs.statSync(photo.file).mtimeMs;
  const hit = cache.get(photo.file);
  if (hit && hit.mtimeMs === mtimeMs) return hit.photo;
  const image = nativeImage.createFromPath(photo.file);
  if (image.isEmpty()) throw new Error(`The reaction photo "${photo.name}" could not be read as an image: ${photo.file}`);
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap();
  if (bitmap.length !== width * height * 4) throw new Error(`The reaction photo "${photo.name}" decoded to ${bitmap.length} bytes for ${width}x${height}: ${photo.file}`);
  const alpha = new Uint8Array(width * height);
  for (let i = 0; i < alpha.length; i++) alpha[i] = bitmap[i * 4 + 3];
  const trim = trimToPerson(alpha, width, height, `The reaction photo "${photo.name}" (${photo.file})`);
  const { box } = trim;
  const out = Buffer.alloc(box.w * box.h * 4);
  for (let y = 0; y < box.h; y++) {
    for (let x = 0; x < box.w; x++) {
      const src = (box.y + y) * width + (box.x + x);
      if (trim.keep[src] === 0) continue;
      bitmap.copy(out, (y * box.w + x) * 4, src * 4, src * 4 + 4);
    }
  }
  const png = nativeImage.createFromBitmap(out, { width: box.w, height: box.h }).toPNG();
  const note = trim.droppedGroups > 0
    ? `"${photo.name}": ${trim.droppedGroups} stray speck(s) (${trim.droppedPixels} px) away from the person were left out.`
    : null;
  const result = { name: photo.name, file: photo.file, png, width: box.w, height: box.h, note };
  cache.set(photo.file, { mtimeMs, photo: result });
  return result;
}

/** A small picture of the trimmed photo for the tab's picker. */
export function photoPreview(photo: TrimmedPhoto, height = 96): string {
  return nativeImage.createFromBuffer(photo.png).resize({ height, quality: 'good' }).toDataURL();
}
