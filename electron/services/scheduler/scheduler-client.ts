/**
 * Visibility scheduler client (VISIBILITY-SCHEDULER-PLAN.md, phase 2).
 *
 * The scheduler runs on Triton at contentstudio.owenmorgan.com/scheduler and is the ONLY
 * store of visibility changes ("jobs"): ContentStudio and the extension each talk to it
 * directly, so both always show the same list. This file is ContentStudio's half of that
 * conversation, in the main process: no CORS, and the device key never reaches a renderer.
 *
 * ── The key ──────────────────────────────────────────────────────────────────────────
 *
 * `<userData>/scheduler.json` holds `{ "baseUrl", "deviceKey" }`, mode 600, the same way
 * youtube-tokens.json and spreaker-credentials.json are kept. The key is a device key
 * (`csk_…`) made on the setup page behind Owen's Google login; it is read fresh on every
 * call, so a key saved in Settings works without a restart. It is NEVER logged and never
 * returned to a renderer: `status()` says whether one is stored and nothing more.
 *
 * ── What it refuses to do ────────────────────────────────────────────────────────────
 *
 * Nothing here has a fallback (Owen's cardinal rule). A missing or malformed file is a
 * SchedulerConfigError that says where the key comes from; a server refusal arrives as
 * a SchedulerRequestError carrying the server's own `{error}` text verbatim; a bare 401
 * (the server answers a wrong key and a missing one the same way, by design) says the key
 * was refused. A runAt is always sent with an explicit zone, because the server refuses a
 * zoneless time rather than read it in UTC.
 */

import * as fs from 'fs';
import * as path from 'path';

export const SCHEDULER_FILE = 'scheduler.json';
/** Where a device key is made (Owen's Google login), named in every fix-it message. */
export const SCHEDULER_SETUP_URL = 'https://contentstudio.owenmorgan.com/scheduler/';
/**
 * The scheduler's address, written into scheduler.json when Settings saves a key into a
 * machine that has no file yet. Not a guess: it is the only place the service runs (the
 * server's own config.json carries the same baseUrl).
 */
export const SCHEDULER_BASE_URL = 'https://contentstudio.owenmorgan.com/scheduler';
const KEY_PREFIX = 'csk_';
const REQUEST_TIMEOUT_MS = 30_000;

export type Visibility = 'public' | 'unlisted' | 'private';
export const VISIBILITIES: readonly Visibility[] = ['public', 'unlisted', 'private'];
export type JobState = 'pending' | 'done' | 'failed' | 'cancelled';
export const JOB_STATES: readonly JobState[] = ['pending', 'done', 'failed', 'cancelled'];

/** server/visibility-scheduler/src/jobs.ts `Attempt`. */
export interface SchedulerAttempt {
  at: string;
  error: string;
}

/** server/visibility-scheduler/src/jobs.ts `JobResult`. */
export interface SchedulerJobResult {
  before: string;
  after: string;
  ranAt: string;
  lateByMs: number;
  clearedYouTubeSchedule: boolean;
  message: string | null;
}

/** One change, exactly as the server's `GET /jobs` returns it. */
export interface SchedulerJob {
  id: string;
  channelId: string;
  channelTitle: string | null;
  videoId: string;
  videoTitle: string;
  target: Visibility;
  /** UTC ISO. Shown in local time everywhere. */
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
  /** e.g. YouTube's own publishAt will be cancelled when this runs. Shown before the form closes. */
  warnings: string[];
}

export interface SchedulerChannel {
  channelId: string;
  title: string;
  connectedAt: string;
  /** 'ok', or 'reconnect' when Google refused the channel's token. */
  state: string;
  lastError: string | null;
}

export interface SchedulerHealth {
  /** The run loop ticked within the last two minutes. */
  ok: boolean;
  lastTick: string | null;
  nextDue: string | null;
  /** The device key's name as the server knows it. */
  caller: string;
}

export interface SchedulerVideo {
  videoId: string;
  channelId: string;
  title: string;
  privacyStatus: string;
  publishAt: string | null;
}

export interface SchedulerJobFilter {
  videoId?: string;
  channelId?: string;
  state?: JobState;
  /** ISO with an explicit zone. Inclusive. */
  from?: string;
  /** ISO with an explicit zone. Exclusive. */
  to?: string;
}

export interface NewSchedulerJob {
  videoId: string;
  target: Visibility;
  /** ISO with an explicit zone. */
  runAt: string;
  note: string;
}

export interface SchedulerJobPatch {
  target?: Visibility;
  runAt?: string;
  note?: string;
}

/** What the renderer may know about this machine's scheduler setup. No key. */
export interface SchedulerStatus {
  configured: boolean;
  /** The address calls go to, or null when the file is missing or unreadable. */
  baseUrl: string | null;
  /** Why it is not configured, in full; null exactly when configured. */
  reason: string | null;
  /** Where the file lives, for the fix-it message. */
  configPath: string;
}

/** The file is missing, unreadable or incomplete. The message says how to fix it. */
export class SchedulerConfigError extends Error {}

/** The server refused or failed a request. `message` is the server's own words when it gave any. */
export class SchedulerRequestError extends Error {
  constructor(message: string, readonly status: number | null) {
    super(message);
  }
}

/** ISO-8601 with an explicit zone, the only form the server accepts (rules.ts parseRunAt). */
const ISO_WITH_ZONE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:\d{2})$/;
const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const JOB_ID = /^[\w-]+$/;

export function isZonedIso(value: unknown): value is string {
  return typeof value === 'string' && ISO_WITH_ZONE.test(value) && !Number.isNaN(Date.parse(value));
}

function fixIt(configPath: string): string {
  return `Make a device key on ${SCHEDULER_SETUP_URL} and save it in Settings → Visibility scheduler (it is written to ${configPath}).`;
}

/** The address with no trailing slash, refused when it is not the scheduler's https base. */
function normaliseBaseUrl(raw: unknown, configPath: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new SchedulerConfigError(`${configPath} has no baseUrl. ${fixIt(configPath)}`);
  }
  const base = raw.trim().replace(/\/+$/, '');
  let url: URL;
  try {
    url = new URL(base);
  } catch {
    throw new SchedulerConfigError(`${configPath}: baseUrl ${JSON.stringify(raw)} is not a URL. It should be ${SCHEDULER_BASE_URL}.`);
  }
  if (url.protocol !== 'https:') {
    throw new SchedulerConfigError(`${configPath}: baseUrl ${JSON.stringify(raw)} is not https; the device key must never travel in the clear.`);
  }
  // The API lives at <base>/api; a base that already ends in /api would call /api/api/…
  if (/\/api$/.test(url.pathname)) {
    throw new SchedulerConfigError(`${configPath}: baseUrl ${JSON.stringify(raw)} ends in /api. It is the scheduler's base, ${SCHEDULER_BASE_URL}.`);
  }
  return base;
}

function checkKey(raw: unknown, configPath: string): string {
  if (typeof raw !== 'string' || !raw.trim()) {
    throw new SchedulerConfigError(`${configPath} has no deviceKey. ${fixIt(configPath)}`);
  }
  const key = raw.trim();
  if (!key.startsWith(KEY_PREFIX) || /\s/.test(key)) {
    // The key itself is never quoted back, not even in an error.
    throw new SchedulerConfigError(
      `The deviceKey in ${configPath} is not a scheduler device key (they start "${KEY_PREFIX}" and have no spaces). ${fixIt(configPath)}`,
    );
  }
  return key;
}

/** `{ baseUrl, deviceKey }` from userData, or a SchedulerConfigError saying what to do. */
export function readSchedulerConfig(userDataPath: string): { baseUrl: string; deviceKey: string } {
  const configPath = path.join(userDataPath, SCHEDULER_FILE);
  if (!fs.existsSync(configPath)) {
    throw new SchedulerConfigError(`The visibility scheduler is not set up on this machine: ${configPath} does not exist. ${fixIt(configPath)}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(fs.readFileSync(configPath, 'utf-8'));
  } catch {
    throw new SchedulerConfigError(`${configPath} is not valid JSON. ${fixIt(configPath)}`);
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new SchedulerConfigError(`${configPath} must be an object {"baseUrl", "deviceKey"}. ${fixIt(configPath)}`);
  }
  const p = parsed as Record<string, unknown>;
  return { baseUrl: normaliseBaseUrl(p.baseUrl, configPath), deviceKey: checkKey(p.deviceKey, configPath) };
}

/**
 * Save (or replace) the device key, mode 600.
 *
 * The address stays what the file already says when it says something valid; a machine
 * with no file, or one whose file cannot be read, gets SCHEDULER_BASE_URL — saving a key is
 * how that file is repaired, and the Settings card shows the address it now holds.
 */
export function writeSchedulerKey(userDataPath: string, rawKey: unknown): SchedulerStatus {
  const configPath = path.join(userDataPath, SCHEDULER_FILE);
  const deviceKey = checkKey(rawKey, configPath);
  let baseUrl = SCHEDULER_BASE_URL;
  if (fs.existsSync(configPath)) {
    try {
      baseUrl = readSchedulerConfig(userDataPath).baseUrl;
    } catch {
      /* the file is being replaced because it is broken; the known address goes in */
    }
  }
  fs.writeFileSync(configPath, JSON.stringify({ baseUrl, deviceKey }, null, 2), { encoding: 'utf-8', mode: 0o600 });
  // Ensure 600 even if the file pre-existed with looser perms (youtube-tokens.json does the same).
  try { fs.chmodSync(configPath, 0o600); } catch { /* best-effort on platforms without chmod */ }
  return schedulerStatus(userDataPath);
}

export function schedulerStatus(userDataPath: string): SchedulerStatus {
  const configPath = path.join(userDataPath, SCHEDULER_FILE);
  try {
    const { baseUrl } = readSchedulerConfig(userDataPath);
    return { configured: true, baseUrl, reason: null, configPath };
  } catch (err) {
    if (!(err instanceof SchedulerConfigError)) throw err;
    let baseUrl: string | null = null;
    try {
      const raw = JSON.parse(fs.readFileSync(configPath, 'utf-8')) as Record<string, unknown>;
      baseUrl = normaliseBaseUrl(raw.baseUrl, configPath);
    } catch {
      /* no readable address to show; the reason says why */
    }
    return { configured: false, baseUrl, reason: err.message, configPath };
  }
}

/** What a bare (bodiless) answer means, since the server says nothing in it on purpose. */
function bareStatusMessage(status: number, configPath: string): string {
  if (status === 401) {
    return `The scheduler refused the device key (401): it was revoked, or the saved key is wrong. ${fixIt(configPath)}`;
  }
  if (status === 404) return 'The scheduler answered 404 for an API route this app expects. The server and this app disagree about the API.';
  if (status === 429) return 'The scheduler is rate-limiting this machine (429). Wait a minute and try again.';
  return `The scheduler answered HTTP ${status} with no message.`;
}

export interface SchedulerClientOptions {
  userDataPath: string;
  /** Injected for the offline checks; the real one is Node's global fetch. */
  fetch?: typeof fetch;
}

export class SchedulerClient {
  private readonly userDataPath: string;
  private readonly fetchFn: typeof fetch;

  constructor(opts: SchedulerClientOptions) {
    this.userDataPath = opts.userDataPath;
    this.fetchFn = opts.fetch ?? fetch;
  }

  status(): SchedulerStatus {
    return schedulerStatus(this.userDataPath);
  }

  saveKey(key: unknown): SchedulerStatus {
    return writeSchedulerKey(this.userDataPath, key);
  }

  /** Throws SchedulerConfigError now, before anything irreversible, when there is no usable key. */
  requireConfigured(): void {
    readSchedulerConfig(this.userDataPath);
  }

  health(): Promise<SchedulerHealth> {
    return this.request<SchedulerHealth>('GET', '/health');
  }

  channels(): Promise<SchedulerChannel[]> {
    return this.request<SchedulerChannel[]>('GET', '/channels');
  }

  video(videoId: string): Promise<SchedulerVideo> {
    return this.request<SchedulerVideo>('GET', `/video/${encodeURIComponent(requireVideoId(videoId))}`);
  }

  listJobs(filter: SchedulerJobFilter = {}): Promise<SchedulerJob[]> {
    const q = new URLSearchParams();
    if (filter.videoId !== undefined) q.set('videoId', requireVideoId(filter.videoId));
    if (filter.channelId !== undefined) q.set('channelId', filter.channelId);
    if (filter.state !== undefined) {
      if (!JOB_STATES.includes(filter.state)) throw new Error(`state must be one of ${JOB_STATES.join(', ')}; got ${JSON.stringify(filter.state)}.`);
      q.set('state', filter.state);
    }
    for (const k of ['from', 'to'] as const) {
      const v = filter[k];
      if (v === undefined) continue;
      if (!isZonedIso(v)) throw new Error(`${k} must be an ISO time with an explicit zone; got ${JSON.stringify(v)}.`);
      q.set(k, v);
    }
    const qs = q.toString();
    return this.request<SchedulerJob[]>('GET', `/jobs${qs ? `?${qs}` : ''}`);
  }

  createJob(input: NewSchedulerJob): Promise<SchedulerJobWithWarnings> {
    const body = {
      videoId: requireVideoId(input.videoId),
      target: requireVisibility(input.target),
      runAt: requireRunAt(input.runAt),
      note: requireNote(input.note),
    };
    return this.request<SchedulerJobWithWarnings>('POST', '/jobs', body);
  }

  patchJob(id: string, patch: SchedulerJobPatch): Promise<SchedulerJobWithWarnings> {
    const body: SchedulerJobPatch = {};
    if (patch.target !== undefined) body.target = requireVisibility(patch.target);
    if (patch.runAt !== undefined) body.runAt = requireRunAt(patch.runAt);
    if (patch.note !== undefined) body.note = requireNote(patch.note);
    if (Object.keys(body).length === 0) throw new Error('Nothing to change: the edit names no target, time or note.');
    return this.request<SchedulerJobWithWarnings>('PATCH', `/jobs/${encodeURIComponent(requireJobId(id))}`, body);
  }

  async cancelJob(id: string): Promise<SchedulerJob> {
    const out = await this.request<{ job: SchedulerJob }>('DELETE', `/jobs/${encodeURIComponent(requireJobId(id))}`);
    return out.job;
  }

  private async request<T>(method: string, route: string, body?: unknown): Promise<T> {
    const { baseUrl, deviceKey } = readSchedulerConfig(this.userDataPath);
    const configPath = path.join(this.userDataPath, SCHEDULER_FILE);
    const url = `${baseUrl}/api${route}`;
    let res: Response;
    try {
      res = await this.fetchFn(url, {
        method,
        headers: {
          Authorization: `Bearer ${deviceKey}`,
          Accept: 'application/json',
          ...(body !== undefined ? { 'Content-Type': 'application/json' } : {}),
        },
        ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
      });
    } catch (err) {
      // No status: the request never got an answer (offline, DNS, a ban at the firewall, the timeout).
      // fetch's own message is "fetch failed"; the reason (ENOTFOUND, ECONNREFUSED, …) is its cause.
      const cause = err instanceof Error ? (err as Error & { cause?: unknown }).cause : undefined;
      const why = err instanceof Error ? (cause instanceof Error ? `${err.message}: ${cause.message}` : err.message) : String(err);
      throw new SchedulerRequestError(`Could not reach the scheduler at ${baseUrl} (${method} ${route}): ${why}`, null);
    }
    const text = await res.text();
    let parsed: unknown = undefined;
    if (text) {
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
    }
    if (!res.ok) {
      const serverMessage =
        parsed && typeof parsed === 'object' && typeof (parsed as { error?: unknown }).error === 'string'
          ? (parsed as { error: string }).error
          : null;
      throw new SchedulerRequestError(serverMessage ?? bareStatusMessage(res.status, configPath), res.status);
    }
    if (parsed === undefined) {
      throw new SchedulerRequestError(`The scheduler answered ${method} ${route} with HTTP ${res.status} and no JSON body.`, res.status);
    }
    return parsed as T;
  }
}

function requireVideoId(value: unknown): string {
  if (typeof value !== 'string' || !VIDEO_ID.test(value)) throw new Error(`Not a YouTube video id: ${JSON.stringify(value)}.`);
  return value;
}
function requireJobId(value: unknown): string {
  if (typeof value !== 'string' || !JOB_ID.test(value)) throw new Error(`Not a scheduler change id: ${JSON.stringify(value)}.`);
  return value;
}
function requireVisibility(value: unknown): Visibility {
  if (typeof value !== 'string' || !(VISIBILITIES as readonly string[]).includes(value)) {
    throw new Error(`Visibility must be public, unlisted or private; got ${JSON.stringify(value)}.`);
  }
  return value as Visibility;
}
function requireRunAt(value: unknown): string {
  if (!isZonedIso(value)) {
    throw new Error(`The change's time must be an ISO time with an explicit zone (Z or ±hh:mm); got ${JSON.stringify(value)}.`);
  }
  return value;
}
function requireNote(value: unknown): string {
  if (typeof value !== 'string') throw new Error(`The note must be text; got ${typeof value}.`);
  return value;
}
