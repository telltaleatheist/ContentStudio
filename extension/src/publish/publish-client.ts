// HTTP client for ContentStudio's publish endpoints.
//
//   GET  /publish/pending  -> { items: PendingFillItem[] }
//   POST /publish/resolve  -> body { videoId, filename } -> { item, reason, linked }
//   POST /publish/filled   -> body { jobId, itemIndex, videoId } -> { ok: true }
//
// Same auth story as the analytics endpoints: none. The server is localhost-bound and
// rejects cross-origin web Origins; this extension's chrome-extension:// Origin is
// allowed, so no Authorization header is sent.
//
// Like ingest-client, every failure is a DISTINCT typed state that reaches the UI
// unchanged. Nothing here retries, degrades, or swallows.

import { getSettings } from '../settings';

export interface PendingFillItem {
  jobId: string;
  itemIndex: number;
  /** Ordered. titles[0] is the main title AND A/B variant 1. */
  titles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  channelId: string | null;
  videoId: string | null;
  status: string;
  label: string;
}

export interface ResolveOutcome {
  item: PendingFillItem | null;
  reason: string;
  linked: boolean;
}

export type PublishFailureKind =
  /** ContentStudio is not running, or the port is wrong. */
  | 'unreachable'
  /** The app is running but the publish routes are not wired (503). */
  | 'unavailable'
  /** Unexpected status or a body that isn't ContentStudio's. */
  | 'unexpected-response';

export class PublishClientError extends Error {
  readonly kind: PublishFailureKind;
  readonly status: number | undefined;

  constructor(kind: PublishFailureKind, message: string, status?: number) {
    super(message);
    this.name = 'PublishClientError';
    this.kind = kind;
    this.status = status;
  }
}

async function baseUrl(): Promise<string> {
  const settings = await getSettings();
  return `http://127.0.0.1:${settings.port}`;
}

async function call<T>(path: string, init?: RequestInit): Promise<T> {
  const base = await baseUrl();

  let response: Response;
  try {
    response = await fetch(`${base}${path}`, {
      ...init,
      headers: { 'Content-Type': 'application/json', ...(init?.headers ?? {}) },
    });
  } catch (cause) {
    throw new PublishClientError(
      'unreachable',
      `Could not reach ContentStudio at ${base}. Is the app running?`,
    );
  }

  if (response.status === 503) {
    throw new PublishClientError(
      'unavailable',
      'ContentStudio is running but its publish feature is not available. Update the app.',
      503,
    );
  }

  const text = await response.text().catch(() => '');
  let body: unknown = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new PublishClientError(
      'unexpected-response',
      `${path} returned a non-JSON body (HTTP ${response.status})`,
      response.status,
    );
  }

  if (!response.ok) {
    const detail =
      body && typeof body === 'object' && 'error' in body
        ? String((body as { error: unknown }).error)
        : `HTTP ${response.status}`;
    throw new PublishClientError('unexpected-response', detail, response.status);
  }

  return body as T;
}

export async function fetchPending(): Promise<PendingFillItem[]> {
  const body = await call<{ items?: PendingFillItem[] }>('/publish/pending');
  if (!body || !Array.isArray(body.items)) {
    throw new PublishClientError('unexpected-response', '/publish/pending did not return an items array');
  }
  return body.items;
}

/**
 * Ask ContentStudio which generated item this Studio page corresponds to.
 *
 * All the matching logic lives on the app side; the extension only reports what it can
 * see. That keeps the fragile half thin and the tested half in the app.
 */
export async function resolveForPage(videoId: string, filename: string | null): Promise<ResolveOutcome> {
  const body = await call<ResolveOutcome>('/publish/resolve', {
    method: 'POST',
    body: JSON.stringify({ videoId, filename }),
  });
  if (!body || typeof body.reason !== 'string') {
    throw new PublishClientError('unexpected-response', '/publish/resolve returned an unexpected body');
  }
  return body;
}

/** Record that fields were filled. NOT the same as published — the operator still saves. */
export async function reportFilled(jobId: string, itemIndex: number, videoId: string): Promise<void> {
  await call<{ ok: boolean }>('/publish/filled', {
    method: 'POST',
    body: JSON.stringify({ jobId, itemIndex, videoId }),
  });
}
