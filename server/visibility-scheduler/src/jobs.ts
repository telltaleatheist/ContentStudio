// Changes ("jobs"): storing them, and running the ones that are due.

import { randomUUID } from 'node:crypto';
import { sendAlert } from './alerts.js';
import type { Config } from './config.js';
import type { DB } from './db.js';
import { GoogleError, accessTokenFor, getVideo, updateStatus, type VideoInfo } from './google.js';
import { buildStatusUpdate, hasYouTubeSchedule, isAtTarget, retryDelay, scheduleProblem, type Visibility } from './rules.js';

export type JobState = 'pending' | 'done' | 'failed' | 'cancelled';

export interface Attempt {
  at: string;
  error: string;
}

export interface JobResult {
  before: string;
  after: string;
  ranAt: string;
  /** How long after runAt the change actually ran (0 or more). */
  lateByMs: number;
  clearedYouTubeSchedule: boolean;
  /** Set when nothing had to change, or for a failure. */
  message: string | null;
}

export interface Job {
  id: string;
  channelId: string;
  channelTitle: string | null;
  videoId: string;
  videoTitle: string;
  target: Visibility;
  runAt: string;
  note: string;
  createdAt: string;
  createdBy: string;
  state: JobState;
  nextAttemptAt: string | null;
  attempts: Attempt[];
  result: JobResult | null;
}

interface JobRow {
  id: string;
  channel_id: string;
  channel_title: string | null;
  video_id: string;
  video_title: string;
  target: Visibility;
  run_at: number;
  note: string;
  created_at: number;
  created_by: string;
  state: JobState;
  next_attempt_at: number | null;
  attempts: string;
  result: string | null;
}

const iso = (ms: number) => new Date(ms).toISOString();

function toJob(r: JobRow): Job {
  return {
    id: r.id,
    channelId: r.channel_id,
    channelTitle: r.channel_title,
    videoId: r.video_id,
    videoTitle: r.video_title,
    target: r.target,
    runAt: iso(r.run_at),
    note: r.note,
    createdAt: iso(r.created_at),
    createdBy: r.created_by,
    state: r.state,
    nextAttemptAt: r.next_attempt_at === null ? null : iso(r.next_attempt_at),
    attempts: JSON.parse(r.attempts) as Attempt[],
    result: r.result === null ? null : (JSON.parse(r.result) as JobResult),
  };
}

const SELECT = 'SELECT j.*, c.title AS channel_title FROM jobs j LEFT JOIN channels c ON c.channel_id = j.channel_id';

export interface JobFilter {
  videoId?: string;
  channelId?: string;
  state?: JobState;
  from?: number;
  to?: number;
}

export function listJobs(db: DB, f: JobFilter): Job[] {
  const where: string[] = [];
  const args: (string | number)[] = [];
  if (f.videoId) (where.push('j.video_id = ?'), args.push(f.videoId));
  if (f.channelId) (where.push('j.channel_id = ?'), args.push(f.channelId));
  if (f.state) (where.push('j.state = ?'), args.push(f.state));
  if (f.from !== undefined) (where.push('j.run_at >= ?'), args.push(f.from));
  if (f.to !== undefined) (where.push('j.run_at < ?'), args.push(f.to));
  const sql = `${SELECT}${where.length ? ` WHERE ${where.join(' AND ')}` : ''} ORDER BY j.run_at ASC`;
  return (db.prepare(sql).all(...args) as unknown as JobRow[]).map(toJob);
}

export function getJob(db: DB, id: string): Job | null {
  const r = db.prepare(`${SELECT} WHERE j.id = ?`).get(id) as unknown as JobRow | undefined;
  return r ? toJob(r) : null;
}

function pendingSlots(db: DB, videoId: string, exceptId: string | null) {
  return (db.prepare("SELECT id, video_id, run_at FROM jobs WHERE video_id = ? AND state = 'pending'").all(videoId) as { id: string; video_id: string; run_at: number }[])
    .filter((r) => r.id !== exceptId)
    .map((r) => ({ id: r.id, videoId: r.video_id, runAt: r.run_at }));
}

/** Looks the video up with each connected channel's token; the owner's token is the one that sees it as its own. */
export async function findVideo(config: Config, db: DB, videoId: string): Promise<VideoInfo | null> {
  const channels = db.prepare("SELECT channel_id FROM channels WHERE state = 'ok'").all() as { channel_id: string }[];
  for (const { channel_id } of channels) {
    const video = await getVideo(await accessTokenFor(config, db, channel_id), videoId);
    if (video && video.channelId === channel_id) return video;
  }
  return null;
}

/** Why a video was not found: says so when a channel that might own it cannot be asked. */
export function videoNotFound(db: DB): RequestError {
  const stale = db.prepare("SELECT title FROM channels WHERE state = 'reconnect'").all() as { title: string }[];
  const tail = stale.length ? ` (${stale.map((c) => `"${c.title}"`).join(', ')} needs reconnecting on the setup page, so its videos cannot be looked up)` : '';
  return new RequestError(`no connected channel owns that video${tail}`, 404);
}

export class RequestError extends Error {
  constructor(message: string, readonly status = 400) {
    super(message);
  }
}

export interface NewJob {
  video: VideoInfo;
  target: Visibility;
  runAt: number;
  note: string;
  createdBy: string;
}

export function createJob(db: DB, n: NewJob, now: number): { job: Job; warnings: string[] } {
  const problem = scheduleProblem(n.runAt, n.video.id, pendingSlots(db, n.video.id, null), now);
  if (problem) throw new RequestError(problem);
  const id = randomUUID();
  db.prepare(
    `INSERT INTO jobs (id, channel_id, video_id, video_title, target, run_at, note, created_at, created_by, state, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'pending', ?)`,
  ).run(id, n.video.channelId, n.video.id, n.video.title, n.target, n.runAt, n.note, now, n.createdBy, now);
  return { job: getJob(db, id)!, warnings: warningsFor(n.video, n.target) };
}

/** What the person making a change should know before it runs. */
export function warningsFor(video: VideoInfo, target: Visibility): string[] {
  const out: string[] = [];
  if (hasYouTubeSchedule(video.status)) {
    out.push(`YouTube itself is set to publish this video at ${String(video.status.publishAt)}; this change will cancel that schedule when it runs.`);
  }
  return out;
}

export function patchJob(db: DB, id: string, patch: { target?: Visibility; runAt?: number; note?: string }, now: number): Job {
  const job = getJob(db, id);
  if (!job) throw new RequestError('no such change', 404);
  if (job.state !== 'pending') throw new RequestError(`this change is ${job.state}; only a pending change can be edited`, 409);
  const runAt = patch.runAt ?? Date.parse(job.runAt);
  if (patch.runAt !== undefined) {
    const problem = scheduleProblem(runAt, job.videoId, pendingSlots(db, job.videoId, id), now);
    if (problem) throw new RequestError(problem);
  }
  db.prepare('UPDATE jobs SET target = ?, run_at = ?, note = ?, next_attempt_at = NULL, attempts = ?, updated_at = ? WHERE id = ?').run(
    patch.target ?? job.target,
    runAt,
    patch.note ?? job.note,
    '[]',
    now,
    id,
  );
  return getJob(db, id)!;
}

export function cancelJob(db: DB, id: string, now: number): Job {
  const job = getJob(db, id);
  if (!job) throw new RequestError('no such change', 404);
  if (job.state !== 'pending') throw new RequestError(`this change is already ${job.state}`, 409);
  db.prepare("UPDATE jobs SET state = 'cancelled', next_attempt_at = NULL, updated_at = ? WHERE id = ?").run(now, id);
  return getJob(db, id)!;
}

// ---- running ----------------------------------------------------------------------------

async function finish(config: Config, db: DB, job: Job, state: 'done' | 'failed', result: JobResult, attempts: Attempt[], now: number): Promise<void> {
  db.prepare('UPDATE jobs SET state = ?, result = ?, attempts = ?, next_attempt_at = NULL, updated_at = ? WHERE id = ?').run(
    state,
    JSON.stringify(result),
    JSON.stringify(attempts),
    now,
    job.id,
  );
  const line = `${job.videoId} "${job.videoTitle}" -> ${job.target}: ${state}${result.message ? ` (${result.message})` : ''}`;
  if (state === 'done') {
    console.log(`[run] ${line}`);
    return;
  }
  console.error(`[run] ${line}`);
  const when = new Date(job.runAt).toLocaleString('en-US', { timeZone: config.displayTimeZone, dateStyle: 'medium', timeStyle: 'short' });
  await sendAlert(
    config,
    `Failed: "${job.videoTitle}" did not go ${job.target}`,
    [
      `The change to ${job.target} set for ${when} failed.`,
      '',
      `Video: ${job.videoTitle}`,
      `Now: ${result.after}`,
      `Why: ${result.message ?? 'no reason recorded'}`,
      '',
      `Studio: https://studio.youtube.com/video/${job.videoId}/edit`,
      `Scheduler: ${config.baseUrl}/`,
    ].join('\n'),
  );
}

/** YouTube can go on reporting a removed publishAt for a while after accepting the update (seen 2026-11-05). */
const READ_BACK_WAITS_MS = [5, 10, 15, 30].map((s) => s * 1000);

export async function runJob(config: Config, db: DB, job: Job): Promise<void> {
  const started = Date.now();
  const attempts = [...job.attempts];
  const lateByMs = Math.max(0, started - Date.parse(job.runAt));
  let before = 'unknown';
  try {
    const token = await accessTokenFor(config, db, job.channelId);
    const video = await getVideo(token, job.videoId);
    if (!video) throw new GoogleError(`video ${job.videoId} is not visible to channel ${job.channelId} any more (deleted, or moved?)`, 404);
    before = String(video.status.privacyStatus);
    if (isAtTarget(video.status, job.target)) {
      return finish(config, db, job, 'done', { before, after: before, ranAt: iso(started), lateByMs, clearedYouTubeSchedule: false, message: `already ${before}, nothing changed` }, attempts, Date.now());
    }
    const update = buildStatusUpdate(video.status, job.target);
    await updateStatus(token, job.videoId, update.status);
    let check = await getVideo(token, job.videoId);
    for (const wait of READ_BACK_WAITS_MS) {
      if (check && isAtTarget(check.status, job.target)) break;
      await new Promise((resolve) => setTimeout(resolve, wait));
      check = await getVideo(token, job.videoId);
    }
    const after = check ? String(check.status.privacyStatus) : 'unknown';
    const result = { before, after, ranAt: iso(started), lateByMs, clearedYouTubeSchedule: update.clearedYouTubeSchedule, message: null as string | null };
    if (after !== job.target) {
      result.message = `YouTube accepted the change but reports ${after} afterwards`;
      return finish(config, db, job, 'failed', result, attempts, Date.now());
    }
    if (check && hasYouTubeSchedule(check.status)) {
      result.clearedYouTubeSchedule = false;
      result.message = `YouTube accepted the change but is still set to publish at ${String(check.status.publishAt)}`;
      return finish(config, db, job, 'failed', result, attempts, Date.now());
    }
    return finish(config, db, job, 'done', result, attempts, Date.now());
  } catch (err) {
    const message = (err as Error).message;
    attempts.push({ at: iso(started), error: message });
    const transient = err instanceof GoogleError ? err.transient : false;
    const delay = transient ? retryDelay(attempts.length) : null;
    if (delay !== null) {
      db.prepare('UPDATE jobs SET attempts = ?, next_attempt_at = ?, updated_at = ? WHERE id = ?').run(JSON.stringify(attempts), started + delay, Date.now(), job.id);
      console.error(`[run] ${job.videoId} -> ${job.target}: attempt ${attempts.length} failed, retrying in ${delay / 60_000} min: ${message}`);
      return;
    }
    const why = transient ? `gave up after ${attempts.length} attempts: ${message}` : message;
    await finish(config, db, job, 'failed', { before, after: before, ranAt: iso(started), lateByMs, clearedYouTubeSchedule: false, message: why }, attempts, Date.now());
  }
}

/**
 * Pending changes whose time has come, oldest first, so two due on one video run in order.
 * A change still waiting out a retry holds back every later change for the same video.
 */
export function dueJobs(db: DB, now: number): Job[] {
  const rows = db.prepare(`${SELECT} WHERE j.state = 'pending' AND j.run_at <= ? ORDER BY j.run_at ASC`).all(now) as unknown as JobRow[];
  const held = new Set<string>();
  const due: Job[] = [];
  for (const r of rows) {
    if (held.has(r.video_id)) continue;
    if (r.next_attempt_at !== null && r.next_attempt_at > now) {
      held.add(r.video_id);
      continue;
    }
    held.add(r.video_id); // one change per video per tick; the next tick takes the following one
    due.push(toJob(r));
  }
  return due;
}
