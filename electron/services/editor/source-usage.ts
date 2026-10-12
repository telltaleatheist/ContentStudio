/**
 * Whether a detected source was actually in use during the recording, so the setup modal can
 * leave the slot of one that was not empty (Owen, 2026-10-11: "can we make it do that
 * automatically? clearing slots that i dont need?").
 *
 * An OBS set records every configured source whether or not anything is plugged in: Mic 2 and
 * game audio come out as tracks of exact zeros, and an unused camera as OBS's frozen "No Signal"
 * card. Processed as sources they cost time, put a silent track or colour bars into the
 * compounds, and give a low-confidence alignment warning.
 *
 * Both tests are evidence of absence across the whole stream, sampled at evenly spaced points:
 *   - audio: every sampled window is exact digital silence (all samples 0). A track with any
 *     signal at any sampled point is kept. A live mic's noise floor is never exactly 0.
 *   - video: the picture never changes between samples. Change is the mean |difference| in grey
 *     level at 240x135, the measure and the 0.25 threshold of the camera detector (LEDGER #276):
 *     the No Signal card measured 0.001–0.03, live cameras 2.29–37.
 * A cleared slot is named in the modal with its reason and can be filled again by hand.
 */
import { spawn } from 'child_process';

const AUDIO_WINDOWS = 24;
const AUDIO_WINDOW_SECONDS = 1;
const VIDEO_SAMPLES = 12;
const FRAME_W = 240;
const FRAME_H = 135;
export const STATIC_DIFF_THRESHOLD = 0.25;

function run(bin: string, args: string[]): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const proc = spawn(bin, args);
    const chunks: Buffer[] = [];
    let stderr = '';
    proc.stdout.on('data', (c: Buffer) => chunks.push(c));
    proc.stderr.on('data', (d: Buffer) => { stderr += d.toString(); });
    proc.on('error', reject);
    proc.on('close', (code) => {
      if (code !== 0) return reject(new Error(`${bin} ${args.join(' ')} failed (${code}): ${stderr.trim().slice(-500)}`));
      resolve(Buffer.concat(chunks));
    });
  });
}

export async function mediaDurationSeconds(ffprobe: string, file: string): Promise<number> {
  const out = await run(ffprobe, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', file]);
  const seconds = parseFloat(out.toString().trim());
  if (!Number.isFinite(seconds) || seconds <= 0) throw new Error(`ffprobe gave no duration for ${file}`);
  return seconds;
}

/** Evenly spaced sample times inside [0, duration), away from both ends. */
function sampleTimes(duration: number, count: number, length: number): number[] {
  const span = Math.max(0, duration - length);
  return Array.from({ length: count }, (_, i) => (span * (i + 0.5)) / count);
}

/**
 * True when `file`'s audio stream `audioIndex` (0-based among its audio streams) is exact
 * digital silence in every sampled window. Stops at the first window with signal.
 */
export async function isDigitalSilence(ffmpeg: string, file: string, audioIndex: number, duration: number): Promise<boolean> {
  for (const t of sampleTimes(duration, AUDIO_WINDOWS, AUDIO_WINDOW_SECONDS)) {
    const pcm = await run(ffmpeg, [
      '-v', 'error', '-nostdin', '-ss', t.toFixed(3), '-t', String(AUDIO_WINDOW_SECONDS), '-i', file,
      '-map', `0:a:${audioIndex}`, '-f', 's32le', '-acodec', 'pcm_s32le', 'pipe:1',
    ]);
    if (pcm.length === 0) throw new Error(`no audio decoded from ${file} (audio stream ${audioIndex}) at ${t.toFixed(0)} s`);
    for (let i = 0; i + 4 <= pcm.length; i += 4) {
      if (pcm.readInt32LE(i) !== 0) return false;
    }
  }
  return true;
}

/**
 * The largest picture change between consecutive samples of `file`, as mean |difference| in
 * grey level at 240x135. Below STATIC_DIFF_THRESHOLD the picture never changed.
 */
export async function largestPictureChange(ffmpeg: string, file: string, duration: number): Promise<number> {
  const size = FRAME_W * FRAME_H;
  let previous: Buffer | null = null;
  let largest = 0;
  for (const t of sampleTimes(duration, VIDEO_SAMPLES, 1)) {
    const frame = await run(ffmpeg, [
      '-v', 'error', '-nostdin', '-ss', t.toFixed(3), '-i', file, '-frames:v', '1',
      '-vf', `scale=${FRAME_W}:${FRAME_H}`, '-pix_fmt', 'gray', '-f', 'rawvideo', 'pipe:1',
    ]);
    if (frame.length !== size) throw new Error(`could not read a frame of ${file} at ${t.toFixed(0)} s (got ${frame.length} bytes)`);
    if (previous) {
      let sum = 0;
      for (let i = 0; i < size; i++) sum += Math.abs(frame[i] - previous[i]);
      largest = Math.max(largest, sum / size);
    }
    previous = frame;
  }
  return largest;
}
