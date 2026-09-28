/**
 * SAMPLING A VIDEO FOR THUMBNAIL FRAMES: one ffmpeg pass, CPU only, no model.
 *
 * About one frame a second across the chosen range (the whole video when no range is given),
 * written twice as JPEG (640x360 for the vision model and the large view, 320x180 for the grid)
 * and streamed once more as small grey frames straight into frame-metrics.ts, so the sharpness and
 * the repeat hash are measured without writing a third copy to disk.
 *
 * The rate is capped: a range longer than MAX_SAMPLES seconds is sampled MAX_SAMPLES times, evenly,
 * and the result says the rate it used (Law 8), so a two-hour master is not 7,200 frames.
 *
 * Only 16:9 videos are taken: the thumbnail is 16:9, and fitting any other shape would be a crop,
 * which is the operator's choice, never this code's. Anything else is refused naming its size.
 */
import { spawn } from 'child_process';
import * as fs from 'fs';
import * as path from 'path';
import { differenceHash, laplacianVariance, type FrameMeasure } from './frame-metrics';

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
  start: number;
  end: number;
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

/** The range to sample, checked against the video. `null` ends mean the video's own ends. */
export function resolveRange(start: number | null, end: number | null, duration: number): { start: number; end: number } {
  const s = start ?? 0;
  const e = end ?? duration;
  if (!(s >= 0)) throw new Error(`The start (${s} s) is before the video begins.`);
  if (e > duration + 0.5) throw new Error(`The end (${clock(e)}) is after the video ends (${clock(duration)}).`);
  if (!(Math.min(e, duration) - s >= 2)) throw new Error(`The range ${clock(s)}-${clock(e)} is too short to sample.`);
  return { start: s, end: Math.min(e, duration) };
}

/** "07:31" or "1:07:31" (or plain seconds) as seconds; empty means not given. Anything else throws. */
export function parseClock(text: string | null | undefined, what: string): number | null {
  if (text === null || text === undefined || text.trim() === '') return null;
  const parts = text.trim().split(':');
  if (parts.length > 3 || parts.some((p) => !/^\d+(\.\d+)?$/.test(p))) {
    throw new Error(`The ${what} "${text}" is not a time. Write it like 07:31 or 1:07:31.`);
  }
  return parts.reduce((sum, p) => sum * 60 + Number(p), 0);
}

export function clock(seconds: number): string {
  const s = Math.max(0, Math.floor(seconds));
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const sec = s % 60;
  return h > 0 ? `${h}:${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}` : `${String(m).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
}

/** The sampling rate for a range: one a second, or MAX_SAMPLES evenly when that would be more. */
export function samplingFor(start: number, end: number): { count: number; every: number } {
  const span = end - start;
  const count = Math.min(MAX_SAMPLES, Math.max(1, Math.floor(span / SAMPLE_EVERY_SECONDS)));
  return { count, every: span / count };
}

export function assertSixteenNine(facts: VideoFacts, video: string): void {
  const ratio = facts.width / facts.height;
  if (Math.abs(ratio - 16 / 9) > 0.01) {
    throw new Error(
      `${path.basename(video)} is ${facts.width}x${facts.height}, not 16:9. The Thumbnails tab only takes 16:9 video, ` +
        `because fitting another shape would mean cropping it, and that is your choice to make.`,
    );
  }
}

/**
 * Sample the range into `outDir` (created; it must be empty or absent). Progress is reported per
 * grey frame measured.
 */
export async function sampleFrames(req: {
  ffmpeg: string;
  ffprobe: string;
  video: string;
  start: number | null;
  end: number | null;
  outDir: string;
  signal?: AbortSignal;
  onProgress?: (done: number, total: number) => void;
}): Promise<SampleResult> {
  const facts = await probeVideo(req.ffprobe, req.video);
  assertSixteenNine(facts, req.video);
  const range = resolveRange(req.start, req.end, facts.duration);
  const { count, every } = samplingFor(range.start, range.end);
  fs.mkdirSync(req.outDir, { recursive: true });
  if (fs.readdirSync(req.outDir).length > 0) throw new Error(`The frame folder is not empty: ${req.outDir}`);

  const fps = 1 / every;
  const args = [
    '-hide_banner', '-nostdin', '-v', 'error',
    '-ss', range.start.toFixed(3), '-t', (range.end - range.start).toFixed(3), '-i', req.video,
    '-filter_complex',
    `[0:v]fps=${fps.toFixed(6)},split=3[a][b][c];[a]scale=${LARGE.w}:${LARGE.h}[big];[b]scale=${SMALL.w}:${SMALL.h}[small];[c]scale=${GREY_WIDTH}:${GREY_HEIGHT},format=gray[g]`,
    '-map', '[big]', '-q:v', '3', path.join(req.outDir, 'f%05d.jpg'),
    '-map', '[small]', '-q:v', '5', path.join(req.outDir, 's%05d.jpg'),
    '-map', '[g]', '-f', 'rawvideo', 'pipe:1',
  ];

  const measures: FrameMeasure[] = [];
  const frameBytes = GREY_WIDTH * GREY_HEIGHT;
  await new Promise<void>((resolve, reject) => {
    const child = spawn(req.ffmpeg, args, { stdio: ['ignore', 'pipe', 'pipe'] });
    const abort = () => child.kill('SIGKILL');
    req.signal?.addEventListener('abort', abort, { once: true });
    let pending: Buffer = Buffer.alloc(0);
    let err = '';
    child.stdout.on('data', (chunk: Buffer) => {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length >= frameBytes) {
        const gray = new Uint8Array(pending.subarray(0, frameBytes));
        pending = pending.subarray(frameBytes);
        const index = measures.length;
        measures.push({
          index,
          t: range.start + index * every,
          hash: differenceHash(gray, GREY_WIDTH, GREY_HEIGHT),
          sharpness: laplacianVariance(gray, GREY_WIDTH, GREY_HEIGHT),
        });
        req.onProgress?.(measures.length, count);
      }
    });
    child.stderr.on('data', (d) => { err += d.toString(); });
    child.on('error', (e) => reject(new Error(`ffmpeg could not be started (${req.ffmpeg}): ${e.message}`)));
    child.on('close', (code) => {
      req.signal?.removeEventListener('abort', abort);
      if (req.signal?.aborted) reject(new Error('Stopped.'));
      else if (code !== 0) reject(new Error(`ffmpeg failed while sampling ${path.basename(req.video)} (exit ${code}): ${err.trim().slice(-400)}`));
      else resolve();
    });
  });
  if (measures.length === 0) throw new Error(`ffmpeg wrote no frames for ${path.basename(req.video)} between ${clock(range.start)} and ${clock(range.end)}.`);

  const frames: SampledFrame[] = measures.map((m) => {
    const n = String(m.index + 1).padStart(5, '0');
    const large = path.join(req.outDir, `f${n}.jpg`);
    const small = path.join(req.outDir, `s${n}.jpg`);
    if (!fs.existsSync(large) || !fs.existsSync(small)) {
      throw new Error(`ffmpeg measured frame ${m.index + 1} but did not write its pictures (${large}).`);
    }
    return { ...m, large, small };
  });
  return { frames, start: range.start, end: range.end, every, video: facts };
}

/** One full-size frame at `t` seconds, as PNG, for the render. */
export async function extractFullFrame(ffmpeg: string, video: string, t: number, outPng: string, signal?: AbortSignal): Promise<void> {
  fs.mkdirSync(path.dirname(outPng), { recursive: true });
  await run(ffmpeg, ['-hide_banner', '-nostdin', '-v', 'error', '-ss', t.toFixed(3), '-i', video, '-frames:v', '1', '-y', outPng], signal);
  if (!fs.existsSync(outPng) || fs.statSync(outPng).size === 0) throw new Error(`ffmpeg wrote no frame at ${clock(t)} of ${path.basename(video)}.`);
}
