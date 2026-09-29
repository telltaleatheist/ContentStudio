/**
 * SAMPLING A VIDEO FOR THUMBNAIL FRAMES: ffmpeg only, CPU only, no model.
 *
 * About one frame a second across the chosen STRETCHES of the video (the whole video when none
 * are given; for a story, the pieces of the screen recording it is made of, story-source.ts),
 * written twice as JPEG (640x360 for the vision model and the large view, 320x180 for the grid)
 * and streamed once more as small grey frames straight into frame-metrics.ts, so the sharpness and
 * the repeat hash are measured without writing a third copy to disk. A fourth branch streams each
 * frame as 16x9 colour cells (the grid picture shrunk by area average) on a second pipe (fd 3):
 * the scene signature frame-scenes.ts groups by.
 *
 * The rate is capped: stretches holding more than MAX_SAMPLES seconds are sampled MAX_SAMPLES
 * times, evenly, and the result says the rate it used (Law 8), so a two-hour master is not 7,200
 * frames. Stretches close together share one ffmpeg pass (passesFor); a frame that lands between
 * them is decoded and dropped, never kept, so every kept frame is inside a stretch.
 *
 * Only 16:9 videos are taken: the thumbnail is 16:9, and fitting any other shape would be a crop,
 * which is the operator's choice, never this code's. Anything else is refused naming its size.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import type { Readable } from 'stream';
import { differenceHash, laplacianVariance, type FrameMeasure } from './frame-metrics';
import { SIG_BYTES, SIG_COLS, SIG_ROWS } from './frame-scenes';

/** One frame a second (Owen: "~1 per second"). */
export const SAMPLE_EVERY_SECONDS = 1;
/** At most this many frames per run; longer ranges are sampled more thinly, evenly. */
export const MAX_SAMPLES = 1800;
/** The grey frames the cheap filters measure. */
export const GREY_WIDTH = 320;
export const GREY_HEIGHT = 180;
/** The two JPEG sizes written per frame. */
export const LARGE = { w: 640, h: 360 } as const;
export const SMALL = { w: 320, h: 180 } as const;

export interface VideoFacts {
  duration: number;
  width: number;
  height: number;
}

export interface SampledFrame extends FrameMeasure {
  /** The 640x360 JPEG. */
  large: string;
  /** The 320x180 JPEG. */
  small: string;
}

export interface SampleResult {
  frames: SampledFrame[];
  /** The first stretch's start and the last one's end. */
  start: number;
  end: number;
  /** The stretches sampled, as checked (resolveSpans), and the seconds they hold. */
  spans: SampleSpan[];
  seconds: number;
  /** Seconds between samples actually used (1, or more when the cap thinned them). */
  every: number;
  video: VideoFacts;
}

function run(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn(binary, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    let err = '';
    const abort = () => child.kill('SIGKILL');
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.on('data', (d) => { out += d.toString(); });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`${path.basename(binary)} could not be started (${binary}): ${e.message}`)));
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) reject(new Error('Stopped.'));
      else if (code === 0) resolve(out);
      else reject(new Error(`${path.basename(binary)} failed (exit ${code}): ${err.trim().slice(-400)}`));
    });
  });
}

/** Duration and picture size, from ffprobe. Anything it cannot say is refused by name. */
export async function probeVideo(ffprobe: string, video: string): Promise<VideoFacts> {
  if (!fs.existsSync(video)) throw new Error(`The video is not on disk: ${video}`);
  const out = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height:format=duration', '-of', 'json', video]);
  const parsed = JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }>; format?: { duration?: string } };
  const stream = parsed.streams?.[0];
  const duration = Number(parsed.format?.duration);
  if (!stream || !stream.width || !stream.height) throw new Error(`ffprobe found no picture in ${video}.`);
  if (!(duration > 0)) throw new Error(`ffprobe could not read the length of ${video}.`);
  return { duration, width: stream.width, height: stream.height };
}

/** A stretch of the video, in its own seconds. */
export interface SampleSpan {
  start: number;
  end: number;
}

/**
 * Two stretches closer than this are sampled in one ffmpeg pass (the frames between them are
 * decoded and thrown away); farther apart, each gets its own pass and seek. A story is dozens of
 * pieces with a few seconds of removed dead air between them, and one seek per piece would cost
 * more than decoding the air.
 */
export const JOIN_GAP_SECONDS = 30;

/**
 * The stretches to sample, checked against the video: `null` means the whole video. They must be
 * in order and apart, start at or after 0 and end by the video's end (half a second of slack for
 * a container's rounding); together they must hold at least two seconds.
 */
export function resolveSpans(spans: readonly SampleSpan[] | null, duration: number): SampleSpan[] {
  const list = spans === null ? [{ start: 0, end: duration }] : spans.map((s) => ({ ...s }));
  if (list.length === 0) throw new Error('No stretch of the video was given to sample.');
  for (let i = 0; i < list.length; i++) {
    const s = list[i];
    if (!Number.isFinite(s.start) || !Number.isFinite(s.end) || !(s.end > s.start)) throw new Error(`Stretch ${i + 1} (${s.start}-${s.end} s) is not a stretch of time.`);
    if (s.start < 0) throw new Error(`Stretch ${i + 1} starts at ${s.start} s, before the video begins.`);
    if (s.end > duration + 0.5) throw new Error(`Stretch ${i + 1} ends at ${clock(s.end)}, after the video ends (${clock(duration)}).`);
    if (i > 0 && s.start < list[i - 1].end) throw new Error(`Stretches ${i} and ${i + 1} overlap or are out of order.`);
    s.end = Math.min(s.end, duration);
  }
  const total = list.reduce((sum, s) => sum + (s.end - s.start), 0);
  if (!(total >= 2)) throw new Error(`The stretches hold ${total.toFixed(1)} s, too little to sample.`);
  return list;
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** A sampled frame's id: `f` and its file number. Shared by the tab and the metadata run's thumbnails stage. */
export function frameId(frame: { index: number }): string {
  return `f${frame.index}`;
}

/** "Scene 3 · 2:41 on screen". */
export function sceneLabel(scene: { number: number; seconds: number }): string {
  return `Scene ${scene.number} · ${clock(scene.seconds).replace(/^0(\d:)/, '$1')} on screen`;
}

/** The sampling rate for this many seconds: one a second, or MAX_SAMPLES evenly when that would be more. */
export function samplingFor(seconds: number): { count: number; every: number } {
  const count = Math.min(MAX_SAMPLES, Math.max(1, Math.floor(seconds / SAMPLE_EVERY_SECONDS)));
  return { count, every: seconds / count };
}

/** Consecutive stretches within JOIN_GAP_SECONDS of each other, as one pass each. */
export function passesFor(spans: readonly SampleSpan[]): Array<{ start: number; end: number; spans: SampleSpan[] }> {
  const passes: Array<{ start: number; end: number; spans: SampleSpan[] }> = [];
  for (const s of spans) {
    const last = passes[passes.length - 1];
    if (last && s.start - last.end <= JOIN_GAP_SECONDS) {
      last.end = s.end;
      last.spans.push(s);
    } else {
      passes.push({ start: s.start, end: s.end, spans: [s] });
    }
  }
  return passes;
}

export function assertSixteenNine(facts: VideoFacts, video: string): void {
  const ratio = facts.width / facts.height;
  if (Math.abs(ratio - 16 / 9) > 0.01) {
    throw new Error(
      `${path.basename(video)} is ${facts.width}x${facts.height}, not 16:9. Thumbnails are made from 16:9 video only, ` +
        `because fitting another shape would mean cropping it, and that is your choice to make.`,
    );
  }
}

/**
 * Sample the stretches into `outDir` (created; it must be empty or absent). Progress is reported per
 * kept frame measured.
 */
export async function sampleFrames(req: {
  ffmpeg: string;
  ffprobe: string;
  video: string;
  /** The stretches to sample in the video's own seconds, in order; null for the whole video. */
  spans: readonly SampleSpan[] | null;
  outDir: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<SampleResult> {
  const facts = await probeVideo(req.ffprobe, req.video);
  assertSixteenNine(facts, req.video);
  const spans = resolveSpans(req.spans, facts.duration);
  const seconds = spans.reduce((sum, s) => sum + (s.end - s.start), 0);
  const { count, every } = samplingFor(seconds);
  fs.mkdirSync(req.outDir, { recursive: true });
  if (fs.readdirSync(req.outDir).length > 0) throw new Error(`The frame folder is not empty: ${req.outDir}`);

  const measures: FrameMeasure[] = [];
  // Every frame ffmpeg writes gets the next file number across all passes, so ids stay unique.
  let written = 0;
  for (const pass of passesFor(spans)) {
    const first = written;
    const decoded = await samplePass(req, pass, every, first);
    for (let k = 0; k < decoded.length; k++) {
      const t = pass.start + k * every;
      const n = String(first + k + 1).padStart(5, '0');
      if (pass.spans.some((s) => t >= s.start - 1e-6 && t < s.end)) {
        measures.push({ index: first + k, t, hash: decoded[k].hash, sharpness: decoded[k].sharpness, colour: decoded[k].colour });
        req.onProgress?.(measures.length, count);
      } else {
        // Between two stretches of the pass: decoded, never kept.
        fs.rmSync(path.join(req.outDir, `f${n}.jpg`), { force: true });
        fs.rmSync(path.join(req.outDir, `s${n}.jpg`), { force: true });
      }
    }
    written += decoded.length;
  }
  if (measures.length === 0) throw new Error(`ffmpeg wrote no frames for ${path.basename(req.video)} inside the ${spans.length} stretch(es) asked for.`);

  const frames: SampledFrame[] = measures.map((m) => {
    const n = String(m.index + 1).padStart(5, '0');
    const large = path.join(req.outDir, `f${n}.jpg`);
    const small = path.join(req.outDir, `s${n}.jpg`);
    if (!fs.existsSync(large) || !fs.existsSync(small)) {
      throw new Error(`ffmpeg measured frame ${m.index + 1} but did not write its pictures (${large}).`);
    }
    return { ...m, large, small };
  });
  return { frames, start: spans[0].start, end: spans[spans.length - 1].end, spans, seconds, every, video: facts };
}

/** One ffmpeg pass over [pass.start, pass.end]: the pictures on disk from file number first+1, the grey measures back. */
function samplePass(
  req: { ffmpeg: string; video: string; outDir: string; signal?: AbortSignal },
  pass: { start: number; end: number },
  every: number,
  first: number,
): Promise<Array<{ hash: FrameMeasure['hash']; sharpness: number; colour: Uint8Array }>> {
  const fps = 1 / every;
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-ss', pass.start.toFixed(3), '-t', (pass.end - pass.start).toFixed(3), '-i', req.video,
    '-filter_complex',
    `[0:v]fps=${fps.toFixed(6)},split=3[a][b][c];[a]scale=${LARGE.w}:${LARGE.h}[big];[b]scale=${SMALL.w}:${SMALL.h},split=2[small][s2];` +
      `[s2]scale=${SIG_COLS}:${SIG_ROWS}:flags=area,format=rgb24[col];[c]scale=${GREY_WIDTH}:${GREY_HEIGHT},format=gray[g]`,
    '-map', '[big]', '-q:v', '3', '-start_number', String(first + 1), path.join(req.outDir, 'f%05d.jpg'),
    '-map', '[small]', '-q:v', '5', '-start_number', String(first + 1), path.join(req.outDir, 's%05d.jpg'),
    '-map', '[g]', '-f', 'rawvideo', 'pipe:1',
    '-map', '[col]', '-f', 'rawvideo', 'pipe:3',
  ];
  const out: Array<{ hash: FrameMeasure['hash']; sharpness: number }> = [];
  const colours: Uint8Array[] = [];
  const frameBytes = GREY_WIDTH * GREY_HEIGHT;
  return new Promise((resolve, reject) => {
    const child = spawn(req.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe', 'pipe'] });
    const [, stdout, stderr, colourPipe] = child.stdio as unknown as [null, Readable, Readable, Readable];
    let colourPending: Buffer = Buffer.alloc(0);
    colourPipe.on('data', (chunk: Buffer) => {
      colourPending = colourPending.length === 0 ? chunk : Buffer.concat([colourPending, chunk]);
      while (colourPending.length >= SIG_BYTES) {
        colours.push(new Uint8Array(colourPending.subarray(0, SIG_BYTES)));
        colourPending = colourPending.subarray(SIG_BYTES);
      }
    });
    const abort = () => child.kill('SIGKILL');
    req.signal?.addEventListener('abort', abort, { once: true });
    let pending: Buffer = Buffer.alloc(0);
    let err = '';
    stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const gray = new Uint8Array(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
        out.push({ hash: differenceHash(gray, GREY_WIDTH, GREY_HEIGHT), sharpness: laplacianVariance(gray, GREY_WIDTH, GREY_HEIGHT) });
      }
    });
    stderr.on('data', (d: Buffer) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`ffmpeg could not be started (${req.ffmpeg}): ${e.message}`)));
    child.on('close', (code) => {
      req.signal?.removeEventListener('abort', abort);
      if (req.signal?.aborted) reject(new Error('Stopped.'));
      else if (code !== 0) reject(new Error(`ffmpeg failed while sampling ${path.basename(req.video)} from ${clock(pass.start)} to ${clock(pass.end)} (exit ${code}): ${err.trim().slice(-400)}`));
      else if (colours.length !== out.length) {
        reject(new Error(`ffmpeg streamed ${out.length} grey frames and ${colours.length} colour signatures for ${path.basename(req.video)} from ${clock(pass.start)} to ${clock(pass.end)}; they must match.`));
      } else resolve(out.map((m, k) => ({ ...m, colour: colours[k] })));
    });
  });
}

/** One full-size frame at `t` seconds, as PNG, for the render. */
export async function extractFullFrame(ffmpeg: string, video: string, t: number, outPng: string, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-y', outPng], signal);
  if (!fs.existsSync(outPng) || fs.statSync(outPng).size === 0) throw new Error(`ffmpeg wrote no frame at ${clock(t)} of ${path.basename(video)}.`);
}

/** The size a screenshot background is written at: 16:9, the renderer scales it to 1280x720. */
export const STILL_SIZE = { w: 1920, h: 1080 } as const;

/**
 * One of Owen's screenshots as a thumbnail background (a report with no story, phase 2): cut to
 * 16:9 around its centre when it is another shape, scaled to STILL_SIZE, written as PNG. What was
 * done comes back as a plain line, so the window can say it (Law 8). His file is only read.
 */
export async function prepareStill(ffmpeg: string, ffprobe: string, image: string, outPng: string): Promise<{ line: string }> {
  if (!fs.existsSync(image)) throw new Error(`The screenshot is not on disk: ${image}`);
  const out = await run(ffprobe, ['-v', 'error', '-select_streams', 'v:0', '-show_entries', 'stream=width,height', '-of', 'json', image]);
  const stream = (JSON.parse(out) as { streams?: Array<{ width?: number; height?: number }> }).streams?.[0];
  if (!stream || !stream.width || !stream.height) throw new Error(`ffprobe found no picture in ${image}.`);
  const { width, height } = stream;
  const ratio = width / height;
  const cut = Math.abs(ratio - 16 / 9) > 0.01;
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await run(ffmpeg, [
    '-hide_banner', '-nostdin', '-v', 'error', '-i', image, '-frames:v', '1',
    '-vf', `crop=min(iw\\,ih*16/9):min(ih\\,iw*9/16),scale=${STILL_SIZE.w}:${STILL_SIZE.h},setsar=1`,
    '-y', outPng,
  ]);
  if (!fs.existsSync(outPng) || fs.statSync(outPng).size === 0) throw new Error(`ffmpeg wrote no picture from ${path.basename(image)}.`);
  const name = path.basename(image);
  const small = width < STILL_SIZE.w * 0.66 ? ` It is small, so it was enlarged and may look soft.` : '';
  return {
    line: cut
      ? `${name} is ${width}x${height}, not 16:9, so its middle was cut to 16:9 (the ${ratio > 16 / 9 ? 'left and right' : 'top and bottom'} edges were left out).${small}`
      : `${name} (${width}x${height}) is used whole.${small}`,
  };
}
