/**
 * Thumbnail Validation
 *
 * Everything the app knows about a thumbnail FILE ON DISK: is it really the image it
 * claims to be, is it one YouTube will take, and — separately — where would the one for
 * this item be if it had been exported.
 *
 * Two properties this module is built around:
 *
 * 1. It NEVER fixes anything. No transcoding, no downscaling to fit, no "close enough".
 *    A file that fails a rule is refused with a message naming the actual value and the
 *    rule, because the fix is Owen re-exporting the image, and an app that silently
 *    re-encoded it would ship a thumbnail he never approved.
 *
 * 2. It is CHEAP AND RE-RUNNABLE, so it runs again at use time. thumbnailPath points at
 *    Callisto, an external volume: "it validated when I picked it" says nothing about
 *    whether the file is there, or is still the same file, at upload.
 *
 * No image library. package.json has none (deps: anthropic, axios, electron-log,
 * electron-store, js-yaml, openai) and a thumbnail check is not worth a native
 * dependency in a packaged Electron app — the two formats YouTube accepts both put
 * their dimensions in the header, so we read the header. Downscaling for PREVIEW is a
 * different job and belongs to Electron's own nativeImage (see publish-ipc's
 * publish-read-thumbnail); this module only ever reads.
 */

import * as fs from 'fs';
import * as path from 'path';
import { ThumbnailMeta } from './publish-types';

/** YouTube's hard limit. Rejected above this, never compressed to fit. */
export const MAX_THUMBNAIL_BYTES = 2 * 1024 * 1024;

/**
 * Dimension floors, split the way YouTube actually splits them.
 *
 * The HARD pair is YouTube's own minimum (640 wide; 360 completes 16:9) — below it the
 * upload API refuses the image, so refusing it here is stating their rule early, not
 * inventing one. The RECOMMENDED pair (1280x720) is what survives their re-encode best;
 * below it the file is accepted and stored with a warning saying exactly that.
 *
 * MEASURED 2026-08-21: every one of the 28 thumbnails currently on Callisto
 * (/Volumes/Callisto/Movies/FCPX/<week>/thumbnails/) is 1200x675 — correct 16:9, 94% of
 * the recommended size. The spec's original "≥1280x720 hard" would have refused all of
 * them for a rule YouTube does not have, which is why the hard floor sits at YouTube's
 * number and 1200x675 passes with a warning. If the FCPX export template ever moves to
 * 1280x720, nothing here needs to change.
 */
export const MIN_THUMBNAIL_WIDTH = 640;
export const MIN_THUMBNAIL_HEIGHT = 360;
export const RECOMMENDED_THUMBNAIL_WIDTH = 1280;
export const RECOMMENDED_THUMBNAIL_HEIGHT = 720;

/** How far from 16:9 an image may be before it is called out. 1% either way. */
export const ASPECT_TOLERANCE = 0.01;

/** The filename every exported thumbnail ends with, after the slot. */
const THUMBNAIL_SUFFIX = 'youtube-thumbnail.png';

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
 * Validate one thumbnail file, or throw naming the file, the value and the rule.
 *
 * Throws rather than returning an error union because every caller's honest response is
 * the same: refuse the write and show the message. A rejected thumbnail is never stored,
 * so there is no state to reconcile.
 */
export function validateThumbnailFile(absPath: string): ThumbnailValidation {
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
  if (st.size > MAX_THUMBNAIL_BYTES) {
    const mib = (st.size / (1024 * 1024)).toFixed(2);
    throw new Error(
      `Thumbnail ${absPath} is ${mib} MiB (${st.size} bytes); YouTube's hard limit is 2 MiB ` +
      `(${MAX_THUMBNAIL_BYTES} bytes). Re-export it smaller — nothing here will re-compress ` +
      `an image you approved.`
    );
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

  // Whole file: it is ≤2 MiB by the check above, and a JPEG's frame header can sit
  // behind a large EXIF block, so a fixed-size prefix read would be a guess.
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

  if (width < MIN_THUMBNAIL_WIDTH || height < MIN_THUMBNAIL_HEIGHT) {
    throw new Error(
      `Thumbnail ${absPath} is ${width}x${height}; YouTube's minimum is ` +
      `${MIN_THUMBNAIL_WIDTH}x${MIN_THUMBNAIL_HEIGHT}. Re-export it at least that large — ` +
      `upscaling here would just blur it.`
    );
  }

  const warnings: string[] = [];
  if (width < RECOMMENDED_THUMBNAIL_WIDTH || height < RECOMMENDED_THUMBNAIL_HEIGHT) {
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

  return {
    meta: { bytes: st.size, width, height, mime: actualMime },
    warnings,
  };
}

/**
 * Where this item's exported thumbnail WOULD be, from the final export's own path.
 *
 * PURE — it does not touch the disk. Existence is the caller's question, and the answer
 * "no file there" is a fact about the week's exports, not an error.
 *
 * The layout (spec §1): /Volumes/Callisto/Movies/FCPX/<weekMonday>/complete/<slot> -
 * <label>.mov beside <weekMonday>/thumbnails/<slot> - youtube-thumbnail.png, where slot
 * is an optional channel letter plus a number (none = Telltale, u = Unfiltered,
 * f = Fireside). So `…/2026-08-16/complete/1 - jake lang.mov` proposes
 * `…/2026-08-16/thumbnails/1 - youtube-thumbnail.png`.
 *
 * Returns null when the source path is not in that layout at all (a text subject, a
 * compilation, a file somewhere else entirely) — there is nothing to propose, and
 * inventing a path so the caller has something to stat would just move the failure.
 *
 * NOTHING IS APPLIED FROM THIS. Slots get renumbered between the export and the upload
 * (13 of 40 live exports, spec Q5), so the proposal is always shown for confirmation.
 */
export function deriveProposedThumbnailPath(sourcePath: string | null | undefined): string | null {
  if (typeof sourcePath !== 'string' || !sourcePath.trim()) return null;

  const base = path.basename(sourcePath);
  const parent = path.dirname(sourcePath);

  // The exports folder is what locates the week. Without it we do not know which
  // <week>/thumbnails/ to look in, and the folder above an arbitrary file is not it.
  if (path.basename(parent).toLowerCase() !== EXPORTS_DIR) return null;
  const weekDir = path.dirname(parent);
  if (!weekDir || weekDir === parent) return null;

  // Slot: optional channel letter + number, then " - ". Anchored, so a file that does
  // not follow the convention proposes nothing rather than something plausible.
  const slotMatch = /^([A-Za-z]?\d+)\s+-\s+/.exec(base);
  if (!slotMatch) return null;

  return path.join(weekDir, THUMBNAILS_DIR, `${slotMatch[1]} - ${THUMBNAIL_SUFFIX}`);
}
