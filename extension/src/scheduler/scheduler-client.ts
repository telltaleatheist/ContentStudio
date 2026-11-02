// HTTP client for the visibility scheduler on Triton (server/visibility-scheduler).
//
//   GET    /api/health                 -> { ok, lastTick, nextDue, caller }
//   GET    /api/channels               -> SchedulerChannel[]
//   GET    /api/video/:videoId         -> SchedulerVideo        (404 {error}: no connected channel owns it)
//   GET    /api/jobs?videoId=          -> SchedulerJob[]        (runAt ascending)
//   POST   /api/jobs                   -> body { videoId, target, runAt, note } -> 201 { job, warnings }
//   PATCH  /api/jobs/:id               -> body { target?, runAt?, note? }       -> { job, warnings }
//   DELETE /api/jobs/:id               -> { job }               (cancelled, kept in history)
//
// Called from the SERVICE WORKER (and the options page, which is an extension page too),
// never from the Studio content script: a content-script fetch carries Studio's origin and
// is bound by its CORS, so the shelf asks the worker (scheduler-messages.ts), the same way
// its ContentStudio calls already go.
//
// Nothing here depends on the ContentStudio desktop app; it talks to Triton only, with
// `Authorization: Bearer <device key>`.
//
// Every failure is a DISTINCT typed state. The server's own `{ error }` text reaches the
// shelf verbatim; nothing retries, degrades or swallows. A body that does not have the
// shape this file expects is refused by name rather than half-read.

import { getSchedulerKey } from '../settings';

export const SCHEDULER_BASE_URL = 'https://contentstudio.owenmorgan.com/scheduler';
/** Where device keys are made and channels connected. */
export const SCHEDULER_SETUP_URL = `${SCHEDULER_BASE_URL}/`;
/** Every device key the server issues starts with this (server auth.ts KEY_PREFIX). */
export const SCHEDULER_KEY_PREFIX = 'csk_';

export type Visibility = 'public' | 'unlisted' | 'private';
export type JobState = 'pending' | 'done' | 'failed' | 'cancelled';

export interface SchedulerHealth {
  ok: boolean;
  lastTick: string | null;
  nextDue: string | null;
  /** The device key's name, as the server knows it. */
  caller: string;
}

export interface SchedulerChannel {
  channelId: string;
  title: string;
  connectedAt: string;
  /** 'ok', or 'reconnect' when Google refused the channel's token. */
  state: string;
  lastError: string | null;
}

export interface SchedulerVideo {
  videoId: string;
  channelId: string;
  title: string;
  /** What YouTube reports now. */
  privacyStatus: string;
  /** YouTube's own scheduled publish time, when one is set. */
  publishAt: string | null;
}

export interface SchedulerAttempt {
  at: string;
  error: string;
}

export interface SchedulerJobResult {
  before: string;
  after: string;
  ranAt: string;
  lateByMs: number;
  clearedYouTubeSchedule: boolean;
  message: string | null;
}

export interface SchedulerJob {
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
  attempts: SchedulerAttempt[];
  result: SchedulerJobResult | null;
}

export interface SchedulerJobWithWarnings {
  job: SchedulerJob;
  warnings: string[];
}

export interface NewSchedulerJob {
  videoId: string;
  target: Visibility;
  /** ISO with an explicit zone offset (scheduler-format.runAtFromLocal). */
  runAt: string;
  note: string;
}

export interface SchedulerJobPatch {
  target?: Visibility;
  runAt?: string;
  note?: string;
}

export type SchedulerFailureKind =
  /** No device key in Options. */
  | 'no-key'
  /** The request never got an answer (offline, DNS, TLS, Triton down). */
  | 'unreachable'
  /** 401: the key is unknown or revoked. */
  | 'unauthorized'
  /** 404 with the server's message, e.g. "no connected channel owns that video". */
  | 'not-found'
  /** Any other 4xx/5xx with the server's message (a rule refused, Google failed…). */
  | 'refused'
  /** A status or body that is not the scheduler's. */
  | 'unexpected-response';

export class SchedulerError extends Error {
  readonly kind: SchedulerFailureKind;
  readonly status: number | undefined;

  constructor(kind: SchedulerFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'SchedulerError';
    this.kind = kind;
    this.status = status;
  }
}

export const NO_KEY_MESSAGE = 'No scheduler key is set. Add one in the extension’s Options.';

async function call(method: string, path: string, body?: unknown, keyOverride?: string): Promise<unknown> {
  const key = keyOverride ?? (await getSchedulerKey());
  if (!key) throw new SchedulerError('no-key', NO_KEY_MESSAGE);

  const url = `${SCHEDULER_BASE_URL}/api${path}`;
  const headers: Record<string, string> = { Authorization: `Bearer ${key}` };
  if (body !== undefined) headers['Content-Type'] = 'application/json';

  let response: Response;
  try {
    response = await fetch(url, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
  } catch (cause) {
    throw new SchedulerError(
      'unreachable',
      `Could not reach the scheduler at ${SCHEDULER_BASE_URL}: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }

  const text = await response.text();

  // The server answers an unknown or revoked key with a bare 401 and no message, so this
  // one is worded here.
  if (response.status === 401) {
    throw new SchedulerError(
      'unauthorized',
      `The scheduler refused the key (HTTP 401): it is mistyped or was revoked. Make a new key on ${SCHEDULER_SETUP_URL} and paste it in Options.`,
      401,
    );
  }

  let parsed: unknown = null;
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new SchedulerError(
        'unexpected-response',
        `${method} ${path} answered HTTP ${response.status} with a body that is not JSON.`,
        response.status,
      );
    }
  }

  if (!response.ok) {
    const error = parsed && typeof parsed === 'object' ? (parsed as { error?: unknown }).error : undefined;
    if (typeof error === 'string') {
      throw new SchedulerError(response.status === 404 ? 'not-found' : 'refused', error, response.status);
    }
    // Bare statuses: 404 for a route the server does not have, 403 for a refused origin.
    throw new SchedulerError(
      'unexpected-response',
      response.status === 404
        ? `The scheduler has no ${method} ${path} (HTTP 404, no message): this extension and the server disagree about the API.`
        : `${method} ${path} answered HTTP ${response.status} with no message.`,
      response.status,
    );
  }
  if (parsed === null) {
    throw new SchedulerError('unexpected-response', `${method} ${path} answered HTTP ${response.status} with an empty body.`, response.status);
  }
  return parsed;
}

// ---- shape checks -----------------------------------------------------------------------

function bad(route: string, what: string): SchedulerError {
  return new SchedulerError('unexpected-response', `${route} returned ${what}.`);
}

const isObj = (v: unknown): v is Record<string, unknown> => !!v && typeof v === 'object' && !Array.isArray(v);
const isStr = (v: unknown): v is string => typeof v === 'string';
const isTime = (v: unknown): v is string => typeof v === 'string' && !Number.isNaN(Date.parse(v));
const isNullable = <T>(v: unknown, test: (x: unknown) => x is T) => v === null || test(v);
const VISIBILITY_VALUES: readonly string[] = ['public', 'unlisted', 'private'];
const STATE_VALUES: readonly string[] = ['pending', 'done', 'failed', 'cancelled'];

/** A job as the server sends it, or a SchedulerError naming the first field that is off. */
function checkJob(route: string, v: unknown): SchedulerJob {
  if (!isObj(v)) throw bad(route, 'a change that is not an object');
  const fail = (field: string) => bad(route, `a change (${isStr(v.id) ? v.id : 'no id'}) with an unusable "${field}"`);
  for (const f of ['id', 'channelId', 'videoId', 'videoTitle', 'note', 'createdBy'] as const) if (!isStr(v[f])) throw fail(f);
  if (!isNullable(v.channelTitle, isStr)) throw fail('channelTitle');
  if (!isStr(v.target) || !VISIBILITY_VALUES.includes(v.target)) throw fail('target');
  if (!isStr(v.state) || !STATE_VALUES.includes(v.state)) throw fail('state');
  for (const f of ['runAt', 'createdAt'] as const) if (!isTime(v[f])) throw fail(f);
  if (!isNullable(v.nextAttemptAt, isTime)) throw fail('nextAttemptAt');
  if (!Array.isArray(v.attempts) || !v.attempts.every((a) => isObj(a) && isStr(a.at) && isStr(a.error))) throw fail('attempts');
  const r = v.result;
  if (r !== null) {
    if (!isObj(r)) throw fail('result');
    if (!isStr(r.before) || !isStr(r.after) || !isTime(r.ranAt)) throw fail('result');
    if (typeof r.lateByMs !== 'number' || typeof r.clearedYouTubeSchedule !== 'boolean') throw fail('result');
    if (!isNullable(r.message, isStr)) throw fail('result.message');
  }
  return v as unknown as SchedulerJob;
}

function checkWarnings(route: string, v: unknown): string[] {
  if (!Array.isArray(v) || !v.every(isStr)) throw bad(route, 'no "warnings" list');
  return v;
}

// ---- routes -----------------------------------------------------------------------------

/** `keyOverride` lets Options test a key before it is saved. */
export async function fetchSchedulerHealth(keyOverride?: string): Promise<SchedulerHealth> {
  const body = await call('GET', '/health', undefined, keyOverride);
  if (!isObj(body) || typeof body.ok !== 'boolean' || !isStr(body.caller) || !isNullable(body.lastTick, isTime) || !isNullable(body.nextDue, isTime)) {
    throw bad('/health', 'an unexpected body');
  }
  return body as unknown as SchedulerHealth;
}

export async function fetchSchedulerChannels(keyOverride?: string): Promise<SchedulerChannel[]> {
  const body = await call('GET', '/channels', undefined, keyOverride);
  if (!Array.isArray(body)) throw bad('/channels', 'something other than a list');
  for (const c of body) {
    if (!isObj(c) || !isStr(c.channelId) || !isStr(c.title) || !isStr(c.state) || !isNullable(c.lastError, isStr)) {
      throw bad('/channels', 'a channel with an unexpected shape');
    }
  }
  return body as SchedulerChannel[];
}

export async function fetchSchedulerVideo(videoId: string): Promise<SchedulerVideo> {
  const route = `/video/${encodeURIComponent(videoId)}`;
  const body = await call('GET', route);
  if (!isObj(body) || body.videoId !== videoId || !isStr(body.channelId) || !isStr(body.title) || !isStr(body.privacyStatus)) {
    throw bad(route, 'an unexpected body');
  }
  if (!isNullable(body.publishAt, isTime)) throw bad(route, 'an unusable "publishAt"');
  return body as unknown as SchedulerVideo;
}

export async function fetchSchedulerJobs(videoId: string): Promise<SchedulerJob[]> {
  const route = `/jobs?${new URLSearchParams({ videoId }).toString()}`;
  const body = await call('GET', route);
  if (!Array.isArray(body)) throw bad('/jobs', 'something other than a list');
  const jobs = body.map((j) => checkJob('/jobs', j));
  // The filter is the server's; a change for another video here would be drawn as this one's.
  const stray = jobs.find((j) => j.videoId !== videoId);
  if (stray) throw bad('/jobs', `change ${stray.id} for video ${stray.videoId} when asked for ${videoId}`);
  return jobs;
}

export async function createSchedulerJob(input: NewSchedulerJob): Promise<SchedulerJobWithWarnings> {
  const body = await call('POST', '/jobs', input);
  if (!isObj(body)) throw bad('POST /jobs', 'an unexpected body');
  return { job: checkJob('POST /jobs', body.job), warnings: checkWarnings('POST /jobs', body.warnings) };
}

export async function patchSchedulerJob(jobId: string, patch: SchedulerJobPatch): Promise<SchedulerJobWithWarnings> {
  const route = `/jobs/${encodeURIComponent(jobId)}`;
  const body = await call('PATCH', route, patch);
  if (!isObj(body)) throw bad(`PATCH ${route}`, 'an unexpected body');
  return { job: checkJob(`PATCH ${route}`, body.job), warnings: checkWarnings(`PATCH ${route}`, body.warnings) };
}

export async function cancelSchedulerJob(jobId: string): Promise<SchedulerJob> {
  const route = `/jobs/${encodeURIComponent(jobId)}`;
  const body = await call('DELETE', route);
  if (!isObj(body)) throw bad(`DELETE ${route}`, 'an unexpected body');
  return checkJob(`DELETE ${route}`, body.job);
}
