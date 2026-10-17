/**
 * THE STILL-WITH-TITLE THUMBNAIL (LEDGER #308; a channel file's `thumbnail_mode: still_title`, Little
 * Goose Productions): one frame of the video, 1280x720, a dark fade along the bottom, and the title
 * over it in Arial Rounded MT Bold, orange (255,140,26) with a cream outline. No A/B pairs, no
 * frames grid, no words call: the song's name is the whole text.
 *
 * DRAWN WITH FFMPEG, not on the A/B renderer's canvas page (canvas-page.ts). That page exists for
 * what only a browser engine does there (face boxes from Apple Vision, the shared layout the card
 * editor previews); this card has no faces to avoid and no editor, and ffmpeg's drawtext and
 * gradients draw it from the frame in one pass, testable under plain Node without Electron.
 *
 * THE FRAME is taken around 40% of the way in (an illustrated song is well under way there; the
 * opening and closing seconds are titles and fades). A candidate that is black is passed over for
 * the next nearest (45%, 35%, 50%, ...); when every candidate is black the still is refused by
 * name, never drawn on black.
 *
 * THE TITLE is fitted by measuring it in the font itself (its advance widths, read from the TTF):
 * one line at the largest size that fits between the margins, down to ONE_LINE_MIN_PX; a title too
 * long for that is set on two balanced lines; one too long for two lines at TWO_LINE_MIN_PX is
 * refused by name rather than shrunk into an unreadable card.
 */
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';
import { spawn } from 'child_process';
import { validateThumbnailFile } from '../publish/thumbnail-validate';
import { probeVideo } from './frame-sampler';

export const STILL_FONT_FILE = '/System/Library/Fonts/Supplemental/Arial Rounded Bold.ttf';
export const STILL_WIDTH = 1280;
export const STILL_HEIGHT = 720;
/** Orange fill and cream outline (Owen's banner lettering). */
export const TITLE_FILL = '0xFF8C1A';
export const TITLE_STROKE = '0xFFF3DC';
/** Where in the video the frames are tried, nearest to 40% first. */
export const FRAME_FRACTIONS = [0.4, 0.45, 0.35, 0.5, 0.3, 0.55, 0.25, 0.6] as const;
const SIDE_MARGIN_PX = 64;
const BOTTOM_MARGIN_PX = 44;
const LINE_GAP_PX = 6;
const FADE_HEIGHT_PX = 300;
const ONE_LINE_MAX_PX = 104;
const ONE_LINE_MIN_PX = 72;
const TWO_LINE_MAX_PX = 92;
const TWO_LINE_MIN_PX = 54;
/** Outline width as a share of the font size. */
const STROKE_SHARE = 0.07;

// ── the font's advance widths ────────────────────────────────────────────────

export interface FontMetrics {
  unitsPerEm: number;
  /** Advance width in font units, per character code. */
  advance: (code: number) => number;
}

/** The advance widths of a TrueType font (head, hhea, hmtx, cmap format 4). Anything else is refused by name. */
export function readFontMetrics(file: string): FontMetrics {
  const buf = fs.readFileSync(file);
  const numTables = buf.readUInt16BE(4);
  const tables = new Map<string, number>();
  for (let i = 0; i < numTables; i++) {
    const rec = 12 + i * 16;
    tables.set(buf.toString('latin1', rec, rec + 4), buf.readUInt32BE(rec + 8));
  }
  const at = (tag: string) => {
    const off = tables.get(tag);
    if (off === undefined) throw new Error(`The font ${file} has no "${tag}" table, so the title cannot be measured in it.`);
    return off;
  };
  const unitsPerEm = buf.readUInt16BE(at('head') + 18);
  const numberOfHMetrics = buf.readUInt16BE(at('hhea') + 34);
  const hmtx = at('hmtx');
  const cmap = at('cmap');
  let sub = -1;
  for (let i = 0; i < buf.readUInt16BE(cmap + 2); i++) {
    const rec = cmap + 4 + i * 8;
    const platform = buf.readUInt16BE(rec);
    const encoding = buf.readUInt16BE(rec + 2);
    const off = cmap + buf.readUInt32BE(rec + 4);
    if (buf.readUInt16BE(off) === 4 && ((platform === 3 && encoding === 1) || platform === 0)) {
      sub = off;
      break;
    }
  }
  if (sub < 0) throw new Error(`The font ${file} has no Unicode character map (cmap format 4), so the title cannot be measured in it.`);
  const segX2 = buf.readUInt16BE(sub + 6);
  const ends = sub + 14;
  const starts = ends + segX2 + 2;
  const deltas = starts + segX2;
  const ranges = deltas + segX2;
  const glyphOf = (code: number): number => {
    for (let i = 0; i < segX2 / 2; i++) {
      const end = buf.readUInt16BE(ends + i * 2);
      if (code > end) continue;
      const start = buf.readUInt16BE(starts + i * 2);
      if (code < start) return 0;
      const delta = buf.readInt16BE(deltas + i * 2);
      const rangeOffset = buf.readUInt16BE(ranges + i * 2);
      if (rangeOffset === 0) return (code + delta) & 0xffff;
      const glyph = buf.readUInt16BE(ranges + i * 2 + rangeOffset + (code - start) * 2);
      return glyph === 0 ? 0 : (glyph + delta) & 0xffff;
    }
    return 0;
  };
  const advance = (code: number): number => {
    const glyph = glyphOf(code);
    const index = Math.min(glyph, numberOfHMetrics - 1);
    return buf.readUInt16BE(hmtx + index * 4);
  };
  return { unitsPerEm, advance };
}

/** The width of `text` at `sizePx`, in pixels, outline included. */
export function textWidthPx(metrics: FontMetrics, text: string, sizePx: number): number {
  let units = 0;
  for (const ch of text) units += metrics.advance(ch.codePointAt(0)!);
  return (units / metrics.unitsPerEm) * sizePx + 2 * Math.round(sizePx * STROKE_SHARE);
}

export interface TitleLayout {
  lines: string[];
  sizePx: number;
}

/** The largest size in [min, max] at which every line fits `width`, or null. */
function largestFit(metrics: FontMetrics, lines: string[], width: number, min: number, max: number): number | null {
  for (let size = max; size >= min; size -= 2) {
    if (lines.every((line) => textWidthPx(metrics, line, size) <= width)) return size;
  }
  return null;
}

/** The title's lines and size (see the header). Pure: the font's metrics in, the layout out. */
export function layoutTitle(metrics: FontMetrics, title: string, width = STILL_WIDTH - 2 * SIDE_MARGIN_PX): TitleLayout {
  const text = title.replace(/\s+/g, ' ').trim();
  if (!text) throw new Error('The still thumbnail has no title to draw.');
  const one = largestFit(metrics, [text], width, ONE_LINE_MIN_PX, ONE_LINE_MAX_PX);
  if (one !== null) return { lines: [text], sizePx: one };
  const words = text.split(' ');
  let best: TitleLayout | null = null;
  for (let cut = 1; cut < words.length; cut++) {
    const lines = [words.slice(0, cut).join(' '), words.slice(cut).join(' ')];
    const size = largestFit(metrics, lines, width, TWO_LINE_MIN_PX, TWO_LINE_MAX_PX);
    if (size === null) continue;
    const balance = Math.abs(textWidthPx(metrics, lines[0], size) - textWidthPx(metrics, lines[1], size));
    const bestBalance = best === null ? Infinity : Math.abs(textWidthPx(metrics, best.lines[0], best.sizePx) - textWidthPx(metrics, best.lines[1], best.sizePx));
    if (best === null || size > best.sizePx || (size === best.sizePx && balance < bestBalance)) best = { lines, sizePx: size };
  }
  if (best === null) {
    throw new Error(
      `The title "${text}" does not fit the still thumbnail on two lines at ${TWO_LINE_MIN_PX} px or larger. ` +
        `Shorten the song's name in the file name, or make this thumbnail by hand.`
    );
  }
  return best;
}

// ── the frame ───────────────────────────────────────────────────────────────

/**
 * Is this frame black? `gray` is a small greyscale frame, one byte per pixel. Black is a mean under
 * 20 of 255, or 97% of its pixels under 24: a fade to black and a black card both, while a dark
 * night scene (a bedtime song's moon and stars) stays well above either.
 */
export function isBlackFrame(gray: Uint8Array): boolean {
  if (gray.length === 0) throw new Error('isBlackFrame was handed an empty frame');
  let sum = 0;
  let dark = 0;
  for (const v of gray) {
    sum += v;
    if (v < 24) dark++;
  }
  return sum / gray.length < 20 || dark / gray.length >= 0.97;
}

function run(binary: string, args: string[], signal?: AbortSignal): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const out: Buffer[] = [];
    let err = '';
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d: Buffer) => out.push(d));
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`${path.basename(binary)} could not be started (${binary}): ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Stopped.'));
      else if (code === 0) resolve(Buffer.concat(out));
      else reject(new Error(`${path.basename(binary)} failed (exit ${code}): ${err.trim().slice(-400)}`));
    });
  });
}

const GRAY_W = 64;
const GRAY_H = 36;

/** The first candidate time whose frame is not black, or a refusal naming every time tried. */
async function pickFrameTime(ffmpeg: string, video: string, duration: number, signal?: AbortSignal): Promise<number> {
  const tried: string[] = [];
  for (const fraction of FRAME_FRACTIONS) {
    const t = Math.floor(duration * fraction * 1000) / 1000;
    const gray = await run(ffmpeg, [
      '-hide_banner', '-nostdin', '-v', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1',
      '-vf', `scale=${GRAY_W}:${GRAY_H},format=gray`, '-f', 'rawvideo', 'pipe:1',
    ], signal);
    if (gray.length !== GRAY_W * GRAY_H) throw new Error(`ffmpeg gave no frame at ${t.toFixed(2)} s of ${path.basename(video)}.`);
    if (!isBlackFrame(gray)) return t;
    tried.push(`${Math.round(fraction * 100)}% (${t.toFixed(1)} s)`);
  }
  throw new Error(`Every frame tried for the still thumbnail of ${path.basename(video)} is black: ${tried.join(', ')}. Make this thumbnail by hand.`);
}

// ── the card ────────────────────────────────────────────────────────────────

/** A path made safe inside an ffmpeg filter argument (its own quoting). */
function filterPath(file: string): string {
  return `'${file.replace(/\\/g, '\\\\').replace(/'/g, `'\\''`).replace(/:/g, '\\:')}'`;
}

/** The filter graph that draws the card from input 0 (the frame) and the title's line files. */
export function stillFilterGraph(layout: TitleLayout, lineFiles: string[], fontFile: string): string {
  const stroke = Math.round(layout.sizePx * STROKE_SHARE);
  const bottom = (index: number) => {
    // Line `index` of n, counted from the top; the last one sits on the bottom margin.
    const fromBottom = layout.lines.length - 1 - index;
    return `h-${BOTTOM_MARGIN_PX}-line_h-${fromBottom}*(line_h+${LINE_GAP_PX})`;
  };
  const text = lineFiles.map((file, i) =>
    `drawtext=fontfile=${filterPath(fontFile)}:textfile=${filterPath(file)}:expansion=none:fontsize=${layout.sizePx}` +
      `:fontcolor=${TITLE_FILL}:borderw=${stroke}:bordercolor=${TITLE_STROKE}:x=(w-text_w)/2:y=${bottom(i)}`
  ).join(',');
  return (
    `[0:v]scale=${STILL_WIDTH}:${STILL_HEIGHT}:force_original_aspect_ratio=increase,crop=${STILL_WIDTH}:${STILL_HEIGHT},setsar=1,format=rgba[bg];` +
    `gradients=s=${STILL_WIDTH}x${FADE_HEIGHT_PX}:c0=0x00000000:c1=0x000000C8:x0=0:y0=0:x1=0:y1=${FADE_HEIGHT_PX}:nb_colors=2,format=rgba,trim=end_frame=1[fade];` +
    `[bg][fade]overlay=0:${STILL_HEIGHT - FADE_HEIGHT_PX}:format=auto,${text},format=yuvj444p[out]`
  );
}

export interface StillThumbnail {
  path: string;
  frameSec: number;
  /** What was drawn, in plain sentences for the item's record. */
  lines: string[];
}

export async function renderStillTitleThumbnail(input: {
  ffmpeg: string;
  ffprobe: string;
  video: string;
  title: string;
  /** Where to write: a .jpg path. */
  outFile: string;
  fontFile?: string;
  signal?: AbortSignal;
}): Promise<StillThumbnail> {
  const fontFile = input.fontFile ?? STILL_FONT_FILE;
  if (!fs.existsSync(fontFile)) throw new Error(`The still thumbnail's font is not on this Mac: ${fontFile}`);
  if (path.extname(input.outFile).toLowerCase() !== '.jpg') throw new Error(`The still thumbnail is written as a .jpg; asked for ${input.outFile}`);
  const layout = layoutTitle(readFontMetrics(fontFile), input.title);
  const { duration } = await probeVideo(input.ffprobe, input.video);
  const t = await pickFrameTime(input.ffmpeg, input.video, duration, input.signal);

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'cs-still-'));
  try {
    const lineFiles = layout.lines.map((line, i) => {
      const file = path.join(work, `line${i + 1}.txt`);
      fs.writeFileSync(file, line, 'utf8');
      return file;
    });
    fs.mkdirSync(path.dirname(input.outFile), { recursive: true });
    const partial = path.join(path.dirname(input.outFile), `.${path.basename(input.outFile, '.jpg')}-${process.pid}-${Date.now()}.jpg`);
    try {
      await run(input.ffmpeg, [
        '-hide_banner', '-nostdin', '-v', 'error', '-ss', t.toFixed(3), '-i', input.video,
        '-filter_complex', stillFilterGraph(layout, lineFiles, fontFile), '-map', '[out]',
        '-frames:v', '1', '-q:v', '2', '-y', partial,
      ], input.signal);
      if (!fs.existsSync(partial) || fs.statSync(partial).size === 0) throw new Error(`ffmpeg wrote no still for ${path.basename(input.video)}.`);
      fs.renameSync(partial, input.outFile);
    } finally {
      if (fs.existsSync(partial)) fs.rmSync(partial);
    }
  } finally {
    fs.rmSync(work, { recursive: true, force: true });
  }
  // The app's own door for what YouTube takes (thumbnail-validate.ts): nothing written here is refused at upload.
  validateThumbnailFile(input.outFile);
  return {
    path: input.outFile,
    frameSec: t,
    lines: [
      `The frame at ${t.toFixed(2)} s of ${duration.toFixed(1)} s.`,
      `The title on ${layout.lines.length === 1 ? 'one line' : 'two lines'} at ${layout.sizePx} px: ${layout.lines.map((l) => `"${l}"`).join(' / ')}.`,
    ],
  };
}
