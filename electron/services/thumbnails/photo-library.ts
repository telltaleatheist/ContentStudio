/**
 * OWEN'S REACTION PHOTOS AND LOGO, KEPT IN THE APP (2026-09-28; Owen: "my images should be
 * permanently linked. we can add a feature to add more, but they should be stored in app data or
 * something so i never have to upload them again").
 *
 *   <userData>/thumbnail-lab/reaction-photos/<name>.png   one file per photo, named by its name
 *   <userData>/thumbnail-lab/logo/<file name>              the one logo file
 *
 * Until this, the tab read a folder he pointed it at in place (store key
 * `thumbnailLab.reactionFolder`) and a logo path (`thumbnailLab.logo`). Those keys are now read for
 * ONE thing only: when the library is empty and the old setting points at something that is still
 * there, the tab OFFERS "Copy these into the app" (one click, Owen's). Nothing is copied on its own,
 * and his originals are only ever read (copyFileSync from them, never a move, never a write).
 *
 * Adding: files or folders (a folder adds its PNGs). A photo's name is its file name without
 * `selfie ` and `.png` (photo-trim.ts photoName), and it is stored as `<name>.png`. A name already
 * in the library is refused naming it, unless the call says to replace (the tab asks first). Two
 * files of one batch that would take one name are refused. A file that is not a PNG is refused
 * naming it. Nothing of a refused batch is copied.
 *
 * PURE FILE WORK (no electron import), so tools/thumbnail-lab-checks.js runs it in plain Node on a
 * CONTENTSTUDIO_USER_DATA scratch folder. Reading the pictures (the trim, the logo's pixels) stays in
 * reaction-photos.ts and logo.ts.
 */
import * as fs from 'fs';
import * as path from 'path';
import { photoName } from './photo-trim';

/** The folder under userData the tab keeps its own files in (the frame cache lives beside these). */
export const LAB_DIR = 'thumbnail-lab';
export const PHOTOS_DIR = 'reaction-photos';
export const LOGO_DIR = 'logo';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_SIGNATURE = Buffer.from([0xff, 0xd8, 0xff]);

export function photosDir(userData: string): string {
  return path.join(userData, LAB_DIR, PHOTOS_DIR);
}

export function logoDir(userData: string): string {
  return path.join(userData, LAB_DIR, LOGO_DIR);
}

function startsWith(file: string, signature: Buffer): boolean {
  const fd = fs.openSync(file, 'r');
  try {
    const head = Buffer.alloc(signature.length);
    const n = fs.readSync(fd, head, 0, head.length, 0);
    return n === head.length && head.equals(signature);
  } finally {
    fs.closeSync(fd);
  }
}

/** A photo ranking is a question, and a question needs at least two answers (judge.ts). */
export const MIN_PHOTOS_TO_RANK = 2;

/**
 * The stop reason when the library is too small to rank (2026-09-29: Owen's run stopped at
 * tone-photos on "it has 0" and nothing said where photos are added). Said by the run, the
 * Thumbnails window's Finish and Rewrite, and the screenshots path, before any model is called.
 */
export function photosMissingReason(count: number): string {
  return `The app's reaction photo library has ${count === 0 ? 'no photos' : count === 1 ? 'one photo' : `${count} photos`}, and ranking them needs at least ${MIN_PHOTOS_TO_RANK}. ` +
    'Add your reaction photos in Thumbnail look (the "Thumbnail look…" button in the Thumbnails window on the reports page, or Settings › Thumbnails).';
}

/** Throws `photosMissingReason` when the library holds fewer than MIN_PHOTOS_TO_RANK photos. */
export function needPhotosToRank(userData: string): void {
  const count = libraryPhotos(userData).length;
  if (count < MIN_PHOTOS_TO_RANK) throw new Error(photosMissingReason(count));
}

/** The library's photos, by name, sorted. An empty or absent library is an empty list. */
export function libraryPhotos(userData: string): Array<{ name: string; file: string }> {
  const dir = photosDir(userData);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((f) => /\.png$/i.test(f) && !f.startsWith('.'))
    .map((f) => ({ name: photoName(f), file: path.join(dir, f) }))
    .sort((a, b) => a.name.localeCompare(b.name));
}

/** The PNG files a chosen path stands for: the file itself, or a folder's PNGs (not its subfolders). */
function pngsOf(chosen: string): string[] {
  if (!fs.existsSync(chosen)) throw new Error(`Not there: ${chosen}`);
  if (fs.statSync(chosen).isDirectory()) {
    const found = fs.readdirSync(chosen).filter((f) => /\.png$/i.test(f) && !f.startsWith('.')).map((f) => path.join(chosen, f));
    if (found.length === 0) throw new Error(`The folder has no PNG photos in it: ${chosen}`);
    return found;
  }
  return [chosen];
}

export interface AddOutcome {
  added: string[];
  replaced: string[];
}

/** Thrown when names are already in the library and the call did not say to replace them. */
export class PhotosAlreadyThere extends Error {
  constructor(readonly names: string[]) {
    super(
      `Already in your reaction photos: ${names.map((n) => `"${n}"`).join(', ')}. ` +
        `Nothing was added. Add them again and choose Replace to swap ${names.length === 1 ? 'it' : 'them'}, or rename the file${names.length === 1 ? '' : 's'}.`,
    );
    this.name = 'PhotosAlreadyThere';
  }
}

/**
 * Copy photos into the library. `chosen` are files and/or folders. With `replace` false, a name
 * already in the library refuses the whole batch (PhotosAlreadyThere, naming them); with true, those
 * photos are replaced. The sources are only read.
 */
export function addPhotos(userData: string, chosen: readonly string[], replace: boolean): AddOutcome {
  if (chosen.length === 0) throw new Error('No photos were chosen.');
  const files = chosen.flatMap(pngsOf);
  const byName = new Map<string, string>();
  for (const file of files) {
    if (!/\.png$/i.test(file)) throw new Error(`Reaction photos are PNG cut-outs; this is not a .png file: ${file}`);
    if (!fs.statSync(file).isFile()) throw new Error(`Not a file: ${file}`);
    if (!startsWith(file, PNG_SIGNATURE)) throw new Error(`This file is named .png but is not a PNG picture: ${file}`);
    const name = photoName(path.basename(file));
    if (name === '') throw new Error(`This file's name gives the photo no name: ${file}`);
    const other = byName.get(name);
    if (other !== undefined) throw new Error(`Two of the chosen files would both be the photo "${name}": ${other} and ${file}. Rename one.`);
    byName.set(name, file);
  }
  const existing = new Map(libraryPhotos(userData).map((p) => [p.name, p.file]));
  const clashes = [...byName.keys()].filter((n) => existing.has(n));
  if (clashes.length > 0 && !replace) throw new PhotosAlreadyThere(clashes);
  const dir = photosDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  const out: AddOutcome = { added: [], replaced: [] };
  for (const [name, file] of byName) {
    const old = existing.get(name);
    const dest = path.join(dir, `${name}.png`);
    // The copy lands beside the library under a temporary name first, so a failed copy never
    // leaves half a photo under the real one.
    const temp = path.join(dir, `.adding-${process.pid}-${name}.png`);
    fs.copyFileSync(file, temp);
    if (old !== undefined && old !== dest) fs.rmSync(old);
    fs.renameSync(temp, dest);
    (old === undefined ? out.added : out.replaced).push(name);
  }
  return out;
}

/** Remove one photo from the library (the app's copy only). */
export function removePhoto(userData: string, name: string): void {
  const photo = libraryPhotos(userData).find((p) => p.name === name);
  if (photo === undefined) throw new Error(`There is no reaction photo "${name}" in the app's library.`);
  fs.rmSync(photo.file);
}

/**
 * The photos an old folder setting points at, when the library is empty: what the tab offers to copy.
 * Null when the library already has photos, nothing is set, or the folder is gone or holds no PNG.
 */
export function photoCopyOffer(userData: string, oldFolder: string | null): { from: string; count: number } | null {
  if (oldFolder === null || libraryPhotos(userData).length > 0) return null;
  if (!fs.existsSync(oldFolder) || !fs.statSync(oldFolder).isDirectory()) return null;
  const count = fs.readdirSync(oldFolder).filter((f) => /\.png$/i.test(f) && !f.startsWith('.')).length;
  return count === 0 ? null : { from: oldFolder, count };
}

/** The library's logo file, or null when none is kept. More than one file there is refused naming them. */
export function libraryLogo(userData: string): string | null {
  const dir = logoDir(userData);
  if (!fs.existsSync(dir)) return null;
  const files = fs.readdirSync(dir).filter((f) => !f.startsWith('.'));
  if (files.length === 0) return null;
  if (files.length > 1) throw new Error(`The app's logo folder holds ${files.length} files (${files.join(', ')}); it keeps one. ${dir}`);
  return path.join(dir, files[0]);
}

/**
 * Copy a logo file into the library, replacing the one kept there. The picture is checked by
 * `check` (logo.ts readLogo, which needs Electron) BEFORE anything is copied, so an unreadable
 * file is refused and the kept logo stays.
 */
export function setLibraryLogo(userData: string, file: string, check: (file: string) => void): string {
  if (!fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`The logo file is not there: ${file}`);
  if (!/\.(png|jpe?g)$/i.test(file) || !(startsWith(file, PNG_SIGNATURE) || startsWith(file, JPEG_SIGNATURE))) {
    throw new Error(`The logo must be a PNG or JPEG picture: ${file}`);
  }
  check(file);
  const dir = logoDir(userData);
  fs.mkdirSync(dir, { recursive: true });
  const dest = path.join(dir, path.basename(file));
  const temp = path.join(path.dirname(dir), `.logo-adding-${process.pid}${path.extname(file)}`);
  fs.copyFileSync(file, temp);
  for (const old of fs.readdirSync(dir)) fs.rmSync(path.join(dir, old));
  fs.renameSync(temp, dest);
  return dest;
}

/** The old logo setting, offered for copying while the library has none; null otherwise. */
export function logoCopyOffer(userData: string, oldFile: string | null): { from: string } | null {
  if (oldFile === null || libraryLogo(userData) !== null) return null;
  return fs.existsSync(oldFile) && fs.statSync(oldFile).isFile() ? { from: oldFile } : null;
}
