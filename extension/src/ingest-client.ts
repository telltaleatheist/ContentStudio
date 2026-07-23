// HTTP client for the ContentStudio desktop app's localhost ingest API.
//
// Endpoints (base http://127.0.0.1:<port>, port from settings, default 43117):
//   GET  /health             (no auth)       -> { ok: true, app: "contentstudio" }
//   GET  /analytics/channels (Bearer token)  -> { channels: [{ channelId, name }] }
//   POST /analytics/videos   (Bearer token)  -> body { videos: VideoRecord[] }
//   POST /analytics/ingest   (Bearer token)  -> body { snapshots: Snapshot[] }
//
// Failure handling policy (see README "No fallbacks"):
//   Every failure is a DISTINCT typed state that must reach the UI unchanged.
//   Nothing in this module retries, degrades, or swallows errors.

import type { Snapshot, VideoRecord } from './types';
import { getSettings, type ChannelConfig } from './settings';

export type IngestFailureKind =
  /** HTTP 401 — the bearer token is missing or was rejected. */
  | 'unauthorized'
  /** HTTP 400 — ContentStudio rejected the payload; details body is logged and preserved. */
  | 'validation'
  /** Network-level failure (connection refused) — the app is not running or the port is wrong. */
  | 'unreachable'
  /** Anything else: unexpected HTTP status or a response body that is not ContentStudio's. */
  | 'unexpected-response';

export class IngestError extends Error {
  readonly kind: IngestFailureKind;
  readonly status: number | undefined;
  readonly details: unknown;

  constructor(
    kind: IngestFailureKind,
    message: string,
    extra: { status?: number; details?: unknown; cause?: unknown } = {},
  ) {
    super(message, extra.cause !== undefined ? { cause: extra.cause } : undefined);
    this.name = 'IngestError';
    this.kind = kind;
    this.status = extra.status;
    this.details = extra.details;
  }
}

export type HealthResult =
  | { state: 'connected'; app: string }
  | { state: 'unreachable'; detail: string }
  | { state: 'unauthorized'; detail: string }
  | { state: 'unexpected-response'; detail: string };

async function baseUrl(): Promise<string> {
  const settings = await getSettings();
  return `http://127.0.0.1:${settings.port}`;
}

async function readBody(response: Response): Promise<unknown> {
  const text = await response.text().catch(() => null);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}

/**
 * Live connection check against GET /health (no auth).
 * Returns a discriminated union rather than throwing, so the popup can render
 * each state distinctly.
 */
export async function checkHealth(): Promise<HealthResult> {
  const base = await baseUrl();
  let response: Response;
  try {
    response = await fetch(`${base}/health`, { method: 'GET' });
  } catch (err) {
    return {
      state: 'unreachable',
      detail: `No response from ${base} — ContentStudio is not running, or the port is wrong.`,
    };
  }
  if (response.status === 401) {
    return {
      state: 'unauthorized',
      detail: `GET /health returned 401 — the server at ${base} rejected the request.`,
    };
  }
  if (!response.ok) {
    return {
      state: 'unexpected-response',
      detail: `GET /health returned HTTP ${response.status} — something other than ContentStudio may be listening at ${base}.`,
    };
  }
  const body = (await readBody(response)) as { ok?: unknown; app?: unknown } | null;
  if (body && body.ok === true && body.app === 'contentstudio') {
    return { state: 'connected', app: 'contentstudio' };
  }
  return {
    state: 'unexpected-response',
    detail: `GET /health returned 200 but not {ok:true,app:"contentstudio"} — something else is listening at ${base}.`,
  };
}

/**
 * GET /analytics/channels — the live channel list ContentStudio has registered.
 * This is the SINGLE SOURCE OF TRUTH for which channels the collector covers;
 * the extension no longer stores a hand-entered list. Throws IngestError with a
 * DISTINCT kind on every failure (unreachable = app not running, unauthorized =
 * bad token, unexpected-response = wrong shape / other status). An EMPTY list is
 * a valid success (ContentStudio has no channels registered yet) — NOT an error.
 */
export async function fetchChannels(): Promise<ChannelConfig[]> {
  const settings = await getSettings();
  const url = `http://127.0.0.1:${settings.port}/analytics/channels`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${settings.token}` },
    });
  } catch (err) {
    throw new IngestError(
      'unreachable',
      `ContentStudio is not reachable at ${url} — is the app running?`,
      { cause: err },
    );
  }

  if (response.status === 401) {
    throw new IngestError(
      'unauthorized',
      'ContentStudio rejected the token (HTTP 401). Paste a fresh token from the Analytics page into Options.',
      { status: 401, details: await readBody(response) },
    );
  }
  if (!response.ok) {
    throw new IngestError(
      'unexpected-response',
      `Unexpected HTTP ${response.status} from GET /analytics/channels.`,
      { status: response.status, details: await readBody(response) },
    );
  }

  const body = (await readBody(response)) as { channels?: unknown } | null;
  if (!body || !Array.isArray(body.channels)) {
    throw new IngestError(
      'unexpected-response',
      'GET /analytics/channels returned 200 but not { channels: [...] } — something other than ContentStudio may be listening.',
      { status: response.status, details: body },
    );
  }

  const channels: ChannelConfig[] = [];
  for (const entry of body.channels) {
    if (
      entry && typeof entry === 'object' &&
      typeof (entry as ChannelConfig).channelId === 'string' &&
      typeof (entry as ChannelConfig).name === 'string'
    ) {
      channels.push({ channelId: (entry as ChannelConfig).channelId, name: (entry as ChannelConfig).name });
    } else {
      throw new IngestError(
        'unexpected-response',
        'GET /analytics/channels returned a channel entry that is not { channelId: string; name: string }.',
        { status: response.status, details: entry },
      );
    }
  }
  return channels;
}

async function post(path: string, body: unknown): Promise<void> {
  const settings = await getSettings();
  const url = `http://127.0.0.1:${settings.port}${path}`;
  let response: Response;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${settings.token}`,
      },
      body: JSON.stringify(body),
    });
  } catch (err) {
    throw new IngestError(
      'unreachable',
      `ContentStudio is not reachable at ${url} — is the app running?`,
      { cause: err },
    );
  }

  if (response.status === 401) {
    throw new IngestError(
      'unauthorized',
      'ContentStudio rejected the token (HTTP 401). Paste a fresh token from the Analytics page into Options.',
      { status: 401, details: await readBody(response) },
    );
  }
  if (response.status === 400) {
    const details = await readBody(response);
    // Validation details are load-bearing for debugging schema drift — always log them.
    console.error(`[ingest-client] HTTP 400 validation failure for POST ${path}:`, details);
    throw new IngestError(
      'validation',
      `ContentStudio rejected the payload for POST ${path} (HTTP 400). Details logged to the service worker console.`,
      { status: 400, details },
    );
  }
  if (!response.ok) {
    throw new IngestError(
      'unexpected-response',
      `Unexpected HTTP ${response.status} from POST ${path}.`,
      { status: response.status, details: await readBody(response) },
    );
  }
}

/** POST /analytics/videos — upsert video metadata records. Throws IngestError on any failure. */
export async function pushVideos(videos: VideoRecord[]): Promise<void> {
  await post('/analytics/videos', { videos });
}

/** POST /analytics/ingest — append metric snapshots. Throws IngestError on any failure. */
export async function pushSnapshots(snapshots: Snapshot[]): Promise<void> {
  await post('/analytics/ingest', { snapshots });
}
