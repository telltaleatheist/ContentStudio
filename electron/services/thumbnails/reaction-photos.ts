/**
 * OWEN'S REACTION PHOTOS, READ: each photo of the app's library (photo-library.ts, since 2026-09-28;
 * before that a folder read in place) is trimmed to the person (photo-trim.ts) with Electron's
 * nativeImage, the one image codec the main process already has. A photo that cannot be read is
 * refused naming the file (Law 1).
 */
import { nativeImage } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import * as log from 'electron-log';
import { TRIMMED_DIR } from './photo-library';
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

const cache = new Map<string, { key: string; photo: TrimmedPhoto; preview?: string }>();

/**
 * KEPT ON DISK, because trimming is slow and runs on the app's main thread: 0.4-0.9 s a photo, about
 * 7.5 s for Owen's 13, which froze the whole app (a beachball) the first time the Thumbnails window
 * opened after every start (2026-09-30). Each trim is kept beside its photo in TRIMMED_DIR, keyed by
 * the photo file's modification time and size: a changed photo is trimmed again, never read stale.
 * The cache holds the trimmed PNG, its size, the trim's note and the picker's small picture.
 */

function keyOf(file: string): string {
  const st = fs.statSync(file);
  return `${Math.round(st.mtimeMs)}-${st.size}`;
}

function keptPaths(file: string, key: string): { dir: string; png: string; meta: string } {
  const dir = path.join(path.dirname(file), TRIMMED_DIR);
  const stem = `${path.basename(file)}.${key}`;
  return { dir, png: path.join(dir, `${stem}.png`), meta: path.join(dir, `${stem}.json`) };
}

/** The kept trim, or null when there is none for this version of the photo (or it cannot be read back). */
function readKept(photo: ReactionPhoto, key: string): { photo: TrimmedPhoto; preview?: string } | null {
  const kept = keptPaths(photo.file, key);
  if (!fs.existsSync(kept.meta) || !fs.existsSync(kept.png)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(kept.meta, 'utf8'));
    if (typeof meta.width !== 'number' || typeof meta.height !== 'number') return null;
    const png = fs.readFileSync(kept.png);
    return {
      photo: { name: photo.name, file: photo.file, png, width: meta.width, height: meta.height, note: typeof meta.note === 'string' ? meta.note : null },
      preview: typeof meta.preview === 'string' ? meta.preview : undefined,
    };
  } catch (err) {
    log.warn(`[Thumbnails] the kept trim of "${photo.name}" could not be read, so it is trimmed again: ${err instanceof Error ? err.message : String(err)}`);
    return null;
  }
}

/** Keep a trim (and its small picture) for this version of the photo; older versions' kept files go. */
function writeKept(photo: TrimmedPhoto, key: string, preview?: string): void {
  const kept = keptPaths(photo.file, key);
  try {
    fs.mkdirSync(kept.dir, { recursive: true });
    const prefix = `${path.basename(photo.file)}.`;
    for (const f of fs.readdirSync(kept.dir)) {
      if (f.startsWith(prefix) && !f.startsWith(`${prefix}${key}.`)) fs.rmSync(path.join(kept.dir, f), { force: true });
    }
    fs.writeFileSync(kept.png, photo.png);
    fs.writeFileSync(kept.meta, JSON.stringify({ width: photo.width, height: photo.height, note: photo.note, ...(preview === undefined ? {} : { preview }) }));
  } catch (err) {
    // Not kept: the trim itself is right and is used; the next start trims again, and says why here.
    log.warn(`[Thumbnails] the trim of "${photo.name}" could not be kept in ${kept.dir}: ${err instanceof Error ? err.message : String(err)}`);
  }
}

export function trimmedPhoto(photo: ReactionPhoto): TrimmedPhoto {
  if (!fs.existsSync(photo.file)) throw new Error(`The reaction photo "${photo.name}" is not there any more: ${photo.file}`);
  const key = keyOf(photo.file);
  const hit = cache.get(photo.file);
  if (hit && hit.key === key) return hit.photo;
  const kept = readKept(photo, key);
  if (kept !== null) {
    cache.set(photo.file, { key, ...kept });
    return kept.photo;
  }
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
  cache.set(photo.file, { key, photo: result });
  writeKept(result, key);
  return result;
}

const PREVIEW_HEIGHT = 96;

/** A small picture of the trimmed photo for the tab's picker (kept with the trim at the default height). */
export function photoPreview(photo: TrimmedPhoto, height = PREVIEW_HEIGHT): string {
  const hit = cache.get(photo.file);
  if (height === PREVIEW_HEIGHT && hit && hit.photo === photo && hit.preview !== undefined) return hit.preview;
  const preview = nativeImage.createFromBuffer(photo.png).resize({ height, quality: 'good' }).toDataURL();
  if (height === PREVIEW_HEIGHT && hit && hit.photo === photo) {
    hit.preview = preview;
    writeKept(photo, hit.key, preview);
  }
  return preview;
}
