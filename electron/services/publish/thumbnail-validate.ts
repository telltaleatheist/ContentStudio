/**
 * Thumbnail Validation and Fitting
 *
 * Everything the app knows about a thumbnail FILE ON DISK: is it really the image it
 * claims to be, is it one YouTube will take, and — separately — where would the one for
 * this item be if it had been exported.
 *
 * Three properties this module is built around:
 *
 * 1. A file that is NOT AN IMAGE is refused with a message naming the file, the value and
 *    the rule: missing, empty, not a PNG or JPEG, an extension that lies about the bytes.
 *    Nothing can be made of such a file, so nothing is.
 *
 * 2. A real image OUTSIDE YOUTUBE'S BOUNDS is FITTED, never refused (Owen, 2026-09-26:
 *    "if a youtube thumbnail is too small or too big, i.e. its outside of the bounds
 *    youtube sets, it's automatically resized to be within the bounds. under 2 mb, a
 *    certain resolution, whatever"). The bounds are YouTube's own: at most 2 MiB, at least
 *    640x360, and the 1280x720 frame YouTube stores a thumbnail at (anything larger is
 *    thrown away on their side). A copy that fits is written BESIDE the original as
 *    `<stem> (2).png` (or `.jpg` when PNG cannot get under the byte limit) and that copy
 *    is what gets attached and uploaded. The original is the operator's master and is
 *    never touched. This replaces the earlier rule that validators never fix (LEDGER #27),
 *    which had already been bent once for oversized exports (bd559e3); the shape of an
 *    image — its 16:9-ness — is still never changed, because a crop would change the
 *    picture rather than its encoding.
 *
 * 3. It is CHEAP AND RE-RUNNABLE, so it runs again at use time. thumbnailPath points at
 *    Callisto, an external volume: "it validated when I picked it" says nothing about
 *    whether the file is there, or is still the same file, at upload. Every path that hands
 *    bytes to YouTube calls `fitThumbnailFile` on the stored path, so a master that was
 *    replaced by a larger export since it was attached is fitted again at that moment.
 *
 * No image library. Both formats YouTube accepts put their dimensions in the header, so
 * measuring reads the header; fitting uses Electron's own nativeImage, which the main
 * process already has, and is the one function here that needs the Electron runtime.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ThumbnailMeta } from './publish-types';

/** YouTube's hard limit on the file. A larger image gets a fitted copy (see the header). */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/**
 * The dimension bounds, split the way YouTube actually splits them.
 *
 * The MINIMUM pair is YouTube's own (640 wide; 360 completes 16:9) — below it the upload
 * API refuses the image. The RECOMMENDED pair (1280x720) is what survives their re-encode
 * best, and it is also the size YouTube STORES: a larger upload is downscaled to 1280x720
 * on their side, so the pixels above that never reach a viewer. That is why 1280x720 is
 * also the MAXIMUM here — a 1920x1080 or 4K export is fitted into that frame before upload,
 * losing nothing YouTube would have kept, and coming in well under the byte limit as a
 * side effect. Below the minimum the image is scaled UP to reach it: blurry, but accepted,
 * which is what was asked for; the warning about being under the recommended size still
 * says so.
 *
 * MEASURED 2026-08-21: every one of the 28 thumbnails then on Callisto
 * (/Volumes/Callisto/Movies/FCPX/<week>/thumbnails/) is 1200x675 — correct 16:9, inside
 * every bound here, so none of them is ever copied. (LEDGER #164: the template exports
 * 1200x675 whatever it claims.)
 */
export const MIN_THUMBNAIL_WIDTH = 640;
export const MIN_THUMBNAIL_HEIGHT = 360;
export const RECOMMENDED_THUMBNAIL_WIDTH = 1280;
export const RECOMMENDED_THUMBNAIL_HEIGHT = 720;
export const MAX_THUMBNAIL_WIDTH = RECOMMENDED_THUMBNAIL_WIDTH;
export const MAX_THUMBNAIL_HEIGHT = RECOMMENDED_THUMBNAIL_HEIGHT;

/** How far from 16:9 an image may be before it is called out. 1% either way. */
export const ASPECT_TOLERANCE = 0.01;

/**
 * The image extensions a proposal will look for, in order.
 *
 * PNG first because every one of the 28 thumbnails on Callisto is a PNG (measured
 * 2026-08-21, again 2026-08-23); the two JPEG spellings are here because they are the
 * other two formats this module accepts, so a proposal that ignored them would refuse to
 * see a file this module would happily take.
 */
export const PROPOSED_THUMBNAIL_EXTENSIONS: readonly string[] = ['.png', '.jpg', '.jpeg'];

/** The filename every exported thumbnail ended with, after the slot, until 2026-08-16. */
const LEGACY_THUMBNAIL_SUFFIX = 'youtube-thumbnail.png';

/** The encodings a fitted copy is written in, in the order they are tried (see fitThumbnailFile). */
const FITTED_EXTENSIONS: readonly ('.png' | '.jpg')[] = ['.png', '.jpg'];

/** The week-relative folders in the disk layout (see spec §1, "Disk layout"). */
const EXPORTS_DIR = 'complete';
const THUMBNAILS_DIR = 'thumbnails';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

/**
 * An accepted thumbnail: what it measured, plus anything worth saying about it.
 *
 * WARNINGS ARE NOT FAILURES, and the distinction is the point. A non-16:9 image is
 * stored, used, and uploaded — YouTube will letterbox it and Owen may well have meant
 * that. What it must not do is go through silently, so it comes back as text the panel
 * shows next to the preview.
 */
export interface ThumbnailValidation {
  meta: ThumbnailMeta;
  warnings: string[];
}

/**
 * A file measured and judged, with the judgement left to the caller: `refusals` are the
 * bounds it breaks (each one fixable by fitting), `warnings` the things worth saying about
 * an image inside the bounds. Empty `refusals` means YouTube takes the file as it is.
 */
export interface ThumbnailInspection extends ThumbnailValidation {
  refusals: string[];
}

interface Dimensions {
  width: number;
  height: number;
}

function describeStat(st: fs.Stats): string {
  if (st.isDirectory()) return 'a directory';
  if (st.isSymbolicLink()) return 'a symbolic link';
  if (st.isFIFO()) return 'a pipe';
  if (st.isSocket()) return 'a socket';
  if (st.isBlockDevice() || st.isCharacterDevice()) return 'a device';
  return 'not a regular file';
}

function mib(bytes: number): string {
  return (bytes / (1024 * 1024)).toFixed(2);
}

/**
 * Width and height out of a PNG's IHDR chunk.
 *
 * IHDR is required by the spec to be the FIRST chunk, immediately after the 8-byte
 * signature: length(4) 'IHDR' width(4) height(4). Anything else there is not a PNG the
 * rest of the pipeline can trust, whatever the signature said.
 */
function pngDimensions(buf: Buffer, file: string): Dimensions {
  if (buf.length < 24) {
    throw new Error(`${file} is only ${buf.length} bytes — too short to be a PNG.`);
  }
  const chunkType = buf.subarray(12, 16).toString('ascii');
  if (chunkType !== 'IHDR') {
    throw new Error(
      `${file} starts with a PNG signature but its first chunk is ${JSON.stringify(chunkType)}, ` +
      `not IHDR — the file is damaged or is not really a PNG.`
    );
  }
  return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
}

/**
 * Width and height out of a JPEG's frame header.
 *
 * A JPEG is a chain of length-prefixed segments; the dimensions live in whichever
 * Start-Of-Frame segment the encoder used (baseline C0, progressive C2, and the
 * arithmetic/lossless variants), which can sit behind an arbitrary amount of EXIF. So
 * this walks the chain rather than assuming an offset. C4 (Huffman tables), C8 (JPG
 * extension) and CC (arithmetic conditioning) share the C0-CF range and are NOT frames.
 */
function jpegDimensions(buf: Buffer, file: string): Dimensions {
  let offset = 2; // past the SOI we already matched
  while (offset + 3 < buf.length) {
    if (buf[offset] !== 0xff) {
      throw new Error(
        `${file} is not a readable JPEG: expected a marker at byte ${offset}, found 0x${buf[offset]
          .toString(16)
          .padStart(2, '0')}.`
      );
    }
    // Fill bytes: any number of 0xFF may precede a marker code.
    let marker = buf[offset + 1];
    let markerAt = offset + 1;
    while (marker === 0xff && markerAt + 1 < buf.length) {
      markerAt += 1;
      marker = buf[markerAt];
    }

    // Standalone markers carry no length: RSTn (D0-D7), SOI, EOI, TEM.
    if ((marker >= 0xd0 && marker <= 0xd9) || marker === 0x01) {
      offset = markerAt + 1;
      continue;
    }

    if (markerAt + 3 >= buf.length) break;
    const segmentLength = buf.readUInt16BE(markerAt + 1);
    if (segmentLength < 2) {
      throw new Error(
        `${file} is not a readable JPEG: segment at byte ${markerAt} declares an impossible ` +
        `length of ${segmentLength}.`
      );
    }

    const isFrame =
      marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc;
    if (isFrame) {
      // SOF payload: precision(1) height(2) width(2) ...
      if (markerAt + 8 >= buf.length) {
        throw new Error(`${file} is not a readable JPEG: its frame header is truncated.`);
      }
      return { height: buf.readUInt16BE(markerAt + 4), width: buf.readUInt16BE(markerAt + 6) };
    }

    // SOS (DA) starts entropy-coded data; past it there is no frame header to find.
    if (marker === 0xda) break;

    offset = markerAt + 1 + segmentLength;
  }
  throw new Error(`${file} is a JPEG with no frame header — its dimensions cannot be read.`);
}

/**
 * Measure one image file: bytes, width, height and real format. Throws for everything
 * that is not a PNG or JPEG image at an absolute path — the problems no fitting can mend.
 * Says nothing about YouTube's bounds; that is `judgeThumbnail`'s job.
 */
export function measureThumbnailFile(absPath: string): ThumbnailMeta {
  if (typeof absPath !== 'string' || !absPath.trim()) {
    throw new Error(`A thumbnail path is required; got ${JSON.stringify(absPath)}`);
  }
  if (!path.isAbsolute(absPath)) {
    throw new Error(
      `Thumbnail path must be absolute; got ${JSON.stringify(absPath)}. A relative path ` +
      `names a different file depending on where the app happens to be running.`
    );
  }

  if (!fs.existsSync(absPath)) {
    throw new Error(
      `Thumbnail ${absPath} does not exist. If it is on an external volume, check the ` +
      `volume is mounted.`
    );
  }

  // lstat, not stat: a path that is a symlink is reported as one rather than followed,
  // so what gets stored is the file we actually measured.
  const st = fs.lstatSync(absPath);
  if (!st.isFile()) {
    throw new Error(`Thumbnail ${absPath} is ${describeStat(st)}, not an image file.`);
  }
  if (st.size === 0) {
    throw new Error(`Thumbnail ${absPath} is empty (0 bytes).`);
  }

  const ext = path.extname(absPath).toLowerCase();
  const extMime =
    ext === '.png' ? 'image/png' : ext === '.jpg' || ext === '.jpeg' ? 'image/jpeg' : null;
  if (!extMime) {
    throw new Error(
      `Thumbnail ${absPath} has extension ${JSON.stringify(ext || '(none)')}; YouTube accepts ` +
      `only .png, .jpg and .jpeg.`
    );
  }

  // Whole file: a JPEG's frame header can sit behind a large EXIF block, so a fixed-size
  // prefix read would be a guess. An oversized master is read once to be measured and
  // then decoded for its fitted copy anyway.
  const buf = fs.readFileSync(absPath);

  const isPng = buf.length >= 8 && buf.subarray(0, 8).equals(PNG_SIGNATURE);
  const isJpeg = buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff;
  const actualMime = isPng ? 'image/png' : isJpeg ? 'image/jpeg' : null;

  if (!actualMime) {
    const head = buf.subarray(0, 8).toString('hex');
    throw new Error(
      `Thumbnail ${absPath} is not a PNG or JPEG — its first bytes are ${head}. The ` +
      `extension says ${extMime}, but the file's contents disagree.`
    );
  }
  // Extension and contents must AGREE. Trusting the bytes alone and ignoring a wrong
  // extension would hand YouTube a file whose name lies about it; trusting the extension
  // alone is how a renamed .webp gets uploaded as a .png.
  if (actualMime !== extMime) {
    throw new Error(
      `Thumbnail ${absPath} is a ${actualMime} file with a ${ext} extension. Rename it to ` +
      `match its real format rather than uploading a file whose name is wrong.`
    );
  }

  const { width, height } = isPng
    ? pngDimensions(buf, absPath)
    : jpegDimensions(buf, absPath);

  return { bytes: st.size, width, height, mime: actualMime };
}

/**
 * YouTube's bounds applied to a measurement. PURE.
 *
 * `refusals` name each bound the image breaks, with the value and the rule; every one of
 * them is something `fitThumbnailFile` can mend, which is why they are returned rather than
 * thrown. `warnings` are the non-fatal notes on an image that is (or will be) inside the
 * bounds: under the recommended size, or not 16:9.
 */
export function judgeThumbnail(meta: ThumbnailMeta, file: string): { refusals: string[]; warnings: string[] } {
  const refusals: string[] = [];
  const warnings: string[] = [];
  const { bytes, width, height } = meta;

  if (bytes > MAX_THUMBNAIL_BYTES) {
    refusals.push(
      `${file} is ${mib(bytes)} MiB (${bytes} bytes); YouTube's hard limit is 2 MiB ` +
      `(${MAX_THUMBNAIL_BYTES} bytes).`
    );
  }
  if (width < MIN_THUMBNAIL_WIDTH || height < MIN_THUMBNAIL_HEIGHT) {
    refusals.push(
      `${file} is ${width}x${height}; YouTube's minimum is ` +
      `${MIN_THUMBNAIL_WIDTH}x${MIN_THUMBNAIL_HEIGHT}.`
    );
  }
  if (width > MAX_THUMBNAIL_WIDTH || height > MAX_THUMBNAIL_HEIGHT) {
    refusals.push(
      `${file} is ${width}x${height}; YouTube stores thumbnails at ` +
      `${MAX_THUMBNAIL_WIDTH}x${MAX_THUMBNAIL_HEIGHT}, so anything larger is fitted into that frame ` +
      `before upload.`
    );
  }

  if (
    width >= MIN_THUMBNAIL_WIDTH && height >= MIN_THUMBNAIL_HEIGHT &&
    (width < RECOMMENDED_THUMBNAIL_WIDTH || height < RECOMMENDED_THUMBNAIL_HEIGHT)
  ) {
    warnings.push(
      `${width}x${height} is below YouTube's recommended ` +
      `${RECOMMENDED_THUMBNAIL_WIDTH}x${RECOMMENDED_THUMBNAIL_HEIGHT}; it will be accepted ` +
      `but survives YouTube's re-encode less well. Stored anyway.`
    );
  }
  const ratio = width / height;
  const target = 16 / 9;
  const off = Math.abs(ratio / target - 1);
  if (off > ASPECT_TOLERANCE) {
    warnings.push(
      `${width}x${height} is ${ratio.toFixed(3)}:1, ${(off * 100).toFixed(1)}% off 16:9. ` +
      `YouTube will letterbox or crop it. Stored anyway.`
    );
  }

  return { refusals, warnings };
}

/** Measure and judge, throwing for nothing but a file that is not an image. */
export function inspectThumbnailFile(absPath: string): ThumbnailInspection {
  const meta = measureThumbnailFile(absPath);
  const { refusals, warnings } = judgeThumbnail(meta, `Thumbnail ${absPath}`);
  return { meta, refusals, warnings };
}

/**
 * Validate one thumbnail file STRICTLY, or throw naming the file, the value and the rule.
 *
 * For a file that is expected to be inside the bounds already: a preview of a stored path,
 * a check that a record still points at what it measured. A caller that is about to attach
 * or upload a file calls `fitThumbnailFile` instead, which mends what this refuses.
 */
export function validateThumbnailFile(absPath: string): ThumbnailValidation {
  const { meta, refusals, warnings } = inspectThumbnailFile(absPath);
  if (refusals.length > 0) {
    throw new Error(
      `${refusals.join(' ')} The app fits such a file into YouTube's bounds when it is attached ` +
      `or uploaded; this path was expected to be inside them already.`
    );
  }
  return { meta, warnings };
}

/**
 * Where this item's exported thumbnail WOULD be, from the final export's own path — every
 * candidate, in the order they should be tried.
 *
 * PURE — it does not touch the disk. Existence is the caller's question, and the answer
 * "no file at any of these" is a fact about the week's exports, not an error. An empty
 * array means the source is not in the export layout at all (a text subject, a
 * compilation, a file somewhere else entirely): there is nothing to propose, and
 * inventing a path so the caller has something to stat would just move the failure.
 *
 * ── The layout ───────────────────────────────────────────────────────────────────────
 *
 * The half that has never changed is the two folders: the export lives in
 * `<week>/complete/` and its thumbnail in the sibling `<week>/thumbnails/`. The
 * `complete` folder is what locates the week, which is why a source outside one proposes
 * nothing — the folder above an arbitrary file is not a week.
 *
 * The half that DID change is the filename, and both spellings are live on disk right
 * now, which is why this returns a list rather than a path:
 *
 *   SAME BASENAME (current). `…/complete/1 - jake lang.mov`
 *                         -> `…/thumbnails/1 - jake lang.png`
 *   SLOT ONLY (legacy).      `…/complete/1 - jake lang.mov`
 *                         -> `…/thumbnails/1 - youtube-thumbnail.png`
 *
 * MEASURED 2026-08-23 across /Volumes/Callisto/Movies/FCPX: every one of the 11
 * thumbnails in the 2026-08-09 week uses the legacy spelling, and 13 of the 14 in
 * 2026-08-16 use the current one (that week also still holds a single
 * `u1 - youtube-thumbnail.png`). Dropping either form would strand a whole week of
 * exports, so both are declared, current first.
 *
 * ── The leading space ────────────────────────────────────────────────────────────────
 *
 * Six of the fourteen files in 2026-08-16/thumbnails/ are named with a LEADING SPACE
 * (` u1 - jesse watters commies.png`, ` 4 - satanism.png`, …) while their .mov siblings
 * are not. That is an export-side accident, but it is on disk in numbers, so the
 * space-prefixed spelling is a DECLARED CANDIDATE rather than something matched by
 * trimming or fuzzing at lookup time. The difference matters: a declared candidate can be
 * named in the log line that says which file was picked, and can be deleted from this
 * table the day the exports are renamed. A trim could only ever match "something close",
 * and nothing downstream could tell which file it actually got.
 *
 * Nothing here matches on anything but an exact filename.
 *
 * ── Why each candidate says HOW it matched ───────────────────────────────────────────
 *
 * `match: 'basename'` means the candidate's filename contains this export's own name —
 * slot AND label. `match: 'slot'` means it contains only the slot number.
 *
 * That difference is the whole reason auto-attachment is safe for one form and not the
 * other. Slots get renumbered between the export and the upload (13 of 40 live exports,
 * spec Q5): under the legacy spelling `2 - youtube-thumbnail.png` follows the SLOT, so a
 * renumber silently points an item at another video's image, and the original design was
 * emphatic that such a proposal must always be confirmed by eye. Under the current
 * spelling the filename carries the label too, so a match is a match on the video's own
 * name and a renumber makes it miss rather than mis-hit. auto-config.ts attaches
 * 'basename' matches automatically and leaves 'slot' matches to the proposal UI.
 */
export interface ThumbnailCandidate {
  /** Absolute path. Nothing has been stat'ed — see the note above. */
  path: string;
  /** Whether this filename identifies the export, or only its slot. */
  match: 'basename' | 'slot';
}

export function deriveProposedThumbnailPaths(
  sourcePath: string | null | undefined
): ThumbnailCandidate[] {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return [];

  const parent = path.dirname(sourcePath);
  if (path.basename(parent).toLowerCase() !== EXPORTS_DIR) return [];
  const weekDir = path.dirname(parent);
  if (!weekDir || weekDir === parent) return [];

  const thumbsDir = path.join(weekDir, THUMBNAILS_DIR);
  const base = path.basename(sourcePath);
  const stem = path.basename(sourcePath, path.extname(sourcePath));
  const candidates: ThumbnailCandidate[] = [];

  if (stem) {
    for (const ext of PROPOSED_THUMBNAIL_EXTENSIONS) {
      candidates.push({ path: path.join(thumbsDir, `${stem}${ext}`), match: 'basename' });
      candidates.push({ path: path.join(thumbsDir, ` ${stem}${ext}`), match: 'basename' });
    }
    // The fitted copies, AFTER the export they were made from. The original is preferred
    // while it is inside the bounds; these are reached when it is not — and offering them
    // here means a later rescan finds the copy that already fits instead of encoding
    // another one. Both encodings, because PNG is tried first and JPEG only when PNG
    // cannot get under the byte limit (see fitThumbnailFile).
    for (const ext of FITTED_EXTENSIONS) {
      candidates.push({ path: path.join(thumbsDir, `${stem} (2)${ext}`), match: 'basename' });
    }
  }

  // Slot: optional channel letter + number, then " - ". Anchored, so a file that does not
  // follow the convention adds nothing rather than something plausible.
  const slotMatch = /^([A-Za-z]?\d+)\s+-\s+/.exec(base);
  if (slotMatch) {
    candidates.push({
      path: path.join(thumbsDir, `${slotMatch[1]} - ${LEGACY_THUMBNAIL_SUFFIX}`),
      match: 'slot',
    });
  }

  return candidates;
}


// ---------------------------------------------------------------- fitting

/**
 * JPEG qualities tried, in order, when the PNG of a fitted image is still over the byte
 * limit. PNG is lossless and is tried first; at 1280x720 a JPEG at any of these is a
 * fraction of the limit, so the ladder is short and the last rung is never reached in
 * practice — if it is, the image is refused rather than degraded further.
 */
const FITTED_JPEG_QUALITIES: readonly number[] = [95, 90, 85, 80];

/**
 * The factor an image must be scaled by to sit inside YouTube's bounds, 1 when it does
 * already. PURE, and the whole geometry of fitting: the shape is kept, only the size moves.
 *
 * Too big on either side → shrink until both fit the 1280x720 frame. Too small on either
 * side → grow until both clear 640x360. An image that cannot do both — a portrait or a
 * very wide strip, where clearing the floor on one side breaks the ceiling on the other —
 * is refused with both numbers, because the fix is a crop and a crop is the operator's.
 */
export function fitScaleFor(width: number, height: number): number {
  if (!Number.isInteger(width) || !Number.isInteger(height) || width <= 0 || height <= 0) {
    throw new Error(`An image's dimensions must be positive integers; got ${width}x${height}.`);
  }
  if (width > MAX_THUMBNAIL_WIDTH || height > MAX_THUMBNAIL_HEIGHT) {
    const scale = Math.min(MAX_THUMBNAIL_WIDTH / width, MAX_THUMBNAIL_HEIGHT / height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (w < MIN_THUMBNAIL_WIDTH || h < MIN_THUMBNAIL_HEIGHT) {
      throw new Error(
        `A ${width}x${height} image cannot fit YouTube's bounds without cropping: inside the ` +
        `${MAX_THUMBNAIL_WIDTH}x${MAX_THUMBNAIL_HEIGHT} frame it is ${w}x${h}, under the ` +
        `${MIN_THUMBNAIL_WIDTH}x${MIN_THUMBNAIL_HEIGHT} minimum. Crop it nearer 16:9 first.`
      );
    }
    return scale;
  }
  if (width < MIN_THUMBNAIL_WIDTH || height < MIN_THUMBNAIL_HEIGHT) {
    const scale = Math.max(MIN_THUMBNAIL_WIDTH / width, MIN_THUMBNAIL_HEIGHT / height);
    const w = Math.round(width * scale);
    const h = Math.round(height * scale);
    if (w > MAX_THUMBNAIL_WIDTH || h > MAX_THUMBNAIL_HEIGHT) {
      throw new Error(
        `A ${width}x${height} image cannot fit YouTube's bounds without cropping: grown to the ` +
        `${MIN_THUMBNAIL_WIDTH}x${MIN_THUMBNAIL_HEIGHT} minimum it is ${w}x${h}, over the ` +
        `${MAX_THUMBNAIL_WIDTH}x${MAX_THUMBNAIL_HEIGHT} frame. Crop it nearer 16:9 first.`
      );
    }
    return scale;
  }
  return 1;
}

/** The size a fitted copy is written at. */
export function fittedSizeFor(width: number, height: number): Dimensions {
  const scale = fitScaleFor(width, height);
  if (scale === 1) return { width, height };
  // Clamp after rounding so a rounding error can never put the copy one pixel outside.
  return {
    width: Math.min(MAX_THUMBNAIL_WIDTH, Math.max(MIN_THUMBNAIL_WIDTH, Math.round(width * scale))),
    height: Math.min(MAX_THUMBNAIL_HEIGHT, Math.max(MIN_THUMBNAIL_HEIGHT, Math.round(height * scale))),
  };
}

/**
 * The name a fitted copy is written under: `<stem> (2).png` or `<stem> (2).jpg`, beside
 * the original. A NEW FILE, never a replacement: the original is the operator's master
 * and this app has no business overwriting something it did not make — and a silent
 * in-place re-encode would also mean the next export of the same name looks
 * already-handled. A master that is itself a ` (2)` copy does not grow a ` (2) (2)`.
 */
export function fittedThumbnailPath(originalPath: string, ext: '.png' | '.jpg'): string {
  const dir = path.dirname(originalPath);
  const stem = path.basename(originalPath, path.extname(originalPath)).replace(/ \(2\)$/, '');
  return path.join(dir, `${stem} (2)${ext}`);
}

/** A thumbnail inside YouTube's bounds, and how it got there. */
export interface ThumbnailFit extends ThumbnailValidation {
  /** The file to attach and upload: the original when it fit, else the copy beside it. */
  path: string;
  /** Non-empty only when a copy was written; says what was changed and why. */
  note: string;
}

/**
 * Write the copy of an image that sits inside YouTube's bounds, and return it measured.
 *
 * Scales by `fitScaleFor` (the shape is kept), encodes PNG first, and falls to the JPEG
 * ladder only when the PNG is over the byte limit. Throws when the shape cannot fit, when
 * the file cannot be decoded, or when even the last JPEG rung is over the limit — rather
 * than writing something that would be refused again on the next read.
 */
function writeFittedThumbnail(originalPath: string, original: ThumbnailMeta): ThumbnailFit {
  // Imported here rather than at module scope: this file is read by tooling that has no
  // Electron runtime, and only this one function needs it.
  const { nativeImage } = require('electron') as typeof import('electron');
  if (!nativeImage) {
    // Outside Electron the module resolves to the binary's path, not the API, and the
    // next line would fail as an unreadable TypeError. This says which it is.
    throw new Error(
      'Thumbnails can only be re-encoded inside the Electron main process; nativeImage is ' +
      'not available here.'
    );
  }

  const size = fittedSizeFor(original.width, original.height);
  const image = nativeImage.createFromPath(originalPath);
  if (image.isEmpty()) {
    throw new Error(
      `Thumbnail ${originalPath} could not be decoded, so no fitted copy could be made of it.`
    );
  }
  const scaled =
    size.width === original.width && size.height === original.height
      ? image
      : image.resize({ width: size.width, height: size.height, quality: 'best' });

  const attempts: { ext: '.png' | '.jpg'; encoded: Buffer; how: string }[] = [];
  attempts.push({ ext: '.png', encoded: scaled.toPNG(), how: 'PNG' });
  for (const quality of FITTED_JPEG_QUALITIES) {
    if (attempts[attempts.length - 1].encoded.length <= MAX_THUMBNAIL_BYTES) break;
    attempts.push({ ext: '.jpg', encoded: scaled.toJPEG(quality), how: `JPEG at quality ${quality}` });
  }
  const chosen = attempts[attempts.length - 1];
  if (chosen.encoded.length > MAX_THUMBNAIL_BYTES) {
    throw new Error(
      `Thumbnail ${originalPath} is ${mib(original.bytes)} MiB and could not be brought under ` +
      `YouTube's 2 MiB limit even at ${size.width}x${size.height} as ${chosen.how} ` +
      `(${mib(chosen.encoded.length)} MiB). Re-export it smaller.`
    );
  }

  const target = fittedThumbnailPath(originalPath, chosen.ext);
  fs.writeFileSync(target, chosen.encoded);

  const { meta, refusals, warnings } = inspectThumbnailFile(target);
  if (refusals.length > 0) {
    throw new Error(
      `The fitted copy ${target} is still outside YouTube's bounds after it was written, which ` +
      `the fitting arithmetic should make impossible: ${refusals.join(' ')}`
    );
  }

  const changes: string[] = [];
  if (size.width !== original.width || size.height !== original.height) {
    changes.push(
      `${size.width > original.width ? 'enlarged' : 'reduced'} from ${original.width}x${original.height} ` +
      `to ${size.width}x${size.height}`
    );
  }
  if (chosen.ext === '.jpg' || original.bytes > MAX_THUMBNAIL_BYTES) {
    changes.push(`re-encoded as ${chosen.how} (${mib(original.bytes)} MiB → ${mib(meta.bytes)} MiB)`);
  }
  const note =
    ` ${path.basename(originalPath)} was outside YouTube's bounds, so a copy was ${changes.join(' and ')} ` +
    `and written as ${path.basename(target)}; that copy is the one attached. The original is untouched.`;

  return { path: target, meta, warnings, note };
}

/**
 * The file YouTube can take for this image: the image itself when it is inside the
 * bounds, otherwise a fitted copy written beside it. THE ONE DOOR for anything that is
 * about to attach or upload a thumbnail. Throws only for what cannot be mended: not an
 * image, a shape that would need cropping, or a copy that will not get under the limit.
 */
export function fitThumbnailFile(absPath: string): ThumbnailFit {
  const inspection = inspectThumbnailFile(absPath);
  if (inspection.refusals.length === 0) {
    return { path: absPath, meta: inspection.meta, warnings: inspection.warnings, note: '' };
  }
  return writeFittedThumbnail(absPath, inspection.meta);
}


/** A usable thumbnail, and how it was arrived at. */
export interface ThumbnailPick {
  path: string;
  match: ThumbnailCandidate['match'];
  meta: ThumbnailMeta;
  warnings: string[];
  /** Non-empty only when a fitted copy had to be written to get inside the bounds. */
  note: string;
}

export type ThumbnailLookup =
  | { ok: true; pick: ThumbnailPick }
  | { ok: false; bucket: 'skipped' | 'refused'; detail: string };

/**
 * Find a thumbnail this app can actually use for a source, making one if it has to.
 *
 * THE ONE IMPLEMENTATION. There were two — the automatic pass and the rescan button each
 * had their own find-and-validate — and they drifted the moment one of them learned to
 * shrink an oversized file: the button kept refusing exports the automatic pass had
 * started accepting, which from the outside looked like the button doing nothing.
 *
 * Two passes over the candidates that EXIST. First, any file already inside the bounds
 * wins, in candidate order — which is what lets a fitted copy written on an earlier pass
 * be found before its master is re-encoded again. Then the first real image outside the
 * bounds is fitted (a copy beside it) and used. A candidate that is not an image at all
 * is recorded and passed over, so a usable file behind an unusable one is reachable.
 */
export function findUsableThumbnail(sourcePath: string | null | undefined): ThumbnailLookup {
  const candidates = deriveProposedThumbnailPaths(sourcePath ?? null);
  if (candidates.length === 0) {
    return {
      ok: false,
      bucket: 'skipped',
      detail: sourcePath
        ? `${sourcePath} is not inside a "complete" export folder, so there is no sibling ` +
          `"thumbnails" folder to look in.`
        : `this item has no single source file, so there is nowhere to look for an exported ` +
          `thumbnail.`,
    };
  }

  const present = candidates.filter((c) => fs.existsSync(c.path));
  if (present.length === 0) {
    return {
      ok: false,
      bucket: 'skipped',
      detail:
        `no exported thumbnail on disk. Looked for ${candidates.length} names, starting with ` +
        `${candidates[0].path}.`,
    };
  }

  const rejections: string[] = [];
  const outOfBounds: { candidate: ThumbnailCandidate; inspection: ThumbnailInspection }[] = [];
  for (const candidate of present) {
    try {
      const inspection = inspectThumbnailFile(candidate.path);
      if (inspection.refusals.length === 0) {
        return {
          ok: true,
          pick: {
            path: candidate.path,
            match: candidate.match,
            meta: inspection.meta,
            warnings: inspection.warnings,
            note: '',
          },
        };
      }
      outOfBounds.push({ candidate, inspection });
    } catch (err) {
      rejections.push(err instanceof Error ? err.message : String(err));
    }
  }

  if (outOfBounds.length === 0) {
    return { ok: false, bucket: 'refused', detail: rejections.join(' ') };
  }

  const { candidate, inspection } = outOfBounds[0];
  try {
    const fitted = writeFittedThumbnail(candidate.path, inspection.meta);
    return {
      ok: true,
      pick: {
        path: fitted.path,
        match: candidate.match,
        meta: fitted.meta,
        warnings: fitted.warnings,
        note: fitted.note,
      },
    };
  } catch (err) {
    return {
      ok: false,
      bucket: 'refused',
      detail: [...rejections, ...inspection.refusals, err instanceof Error ? err.message : String(err)].join(' '),
    };
  }
}
