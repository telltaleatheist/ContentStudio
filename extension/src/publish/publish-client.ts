// HTTP client for ContentStudio's publish endpoints.
//
//   GET  /publish/pending  -> { items: PendingFillItem[] }
//   POST /publish/resolve  -> body { videoId, filename } -> { item, reason, linked, needsTitles }
//   POST /publish/filled   -> body { itemId, videoId } -> { ok: true }
//   GET  /publish/reports  -> ?offset&limit&q -> BrowsePage
//   GET  /publish/item     -> ?itemId -> { item: ItemDetail }
//   POST /publish/titles   -> body { itemId, titles } -> SetTitlesResult
//   GET  /publish/thumbnail-> ?itemId -> { thumbnail: PublishThumbnail | null }
//
// EVERY route names ONE generated item by its permanent `itemId`. They used to take a
// (jobId, itemIndex) pair; the index was a position in the job's items[] array, so
// deleting a sibling item silently made every stored index name a different item. The app
// REFUSES the old shape with a 400 naming the extension version rather than translating
// it, because a translation would be a guess about which item the operator meant.
//
// Same auth story as the analytics endpoints: none. The server is localhost-bound and
// rejects cross-origin web Origins; this extension's chrome-extension:// Origin is
// allowed, so no Authorization header is sent.
//
// Like ingest-client, every failure is a DISTINCT typed state that reaches the UI
// unchanged. Nothing here retries, degrades, or swallows.

import { getSettings } from '../settings';

export interface PendingFillItem {
  /** The item's permanent id — what every call back to ContentStudio names. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  /** Ordered. titles[0] is the main title AND A/B variant 1. */
  titles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  channelId: string | null;
  videoId: string | null;
  status: string;
  /**
   * Monetization. ContentStudio 1.1+ always sends `true`: monetization is on for every
   * video and stopped being a per-item decision on 2026-08-23.
   *
   * The TYPE stays three-valued because this extension can be talking to an older app
   * that still sends `false` or `null`, and a type that could not express what arrives
   * would be a lie about the wire. Nothing READS it any more — the monetization step runs
   * on every video regardless — but requireMonetize still refuses `undefined`, which is
   * an app so old the field does not exist at all.
   */
  monetize: boolean | null;
  /**
   * Whether ContentStudio has a thumbnail for this item.
   *
   * Optional on the wire, and that is a version fact rather than a hedge: an app older
   * than the thumbnail step does not send it, and `undefined` there means "this app
   * cannot serve thumbnails", which the thumbnail filler reports as its reason for being
   * unavailable. It is never read as `false` — see thumbnailAvailability.
   */
  hasThumbnail?: boolean;
  label: string;
}

/**
 * One thumbnail's bytes, as ContentStudio serves them.
 *
 * Base64 because the whole round trip is JSON: a content script cannot reach 127.0.0.1
 * (see publish-messages.ts), so the bytes come through the service worker's
 * chrome.runtime message channel, which serializes as JSON and drops ArrayBuffers and
 * Blobs. Decoded back to bytes in thumbnail.ts, right before the File is built.
 */
export interface PublishThumbnail {
  itemId: string;
  /** The export's own filename — what Studio shows beside the picked image. */
  filename: string;
  mime: 'image/png' | 'image/jpeg';
  /** Decoded length, checked against what base64 actually produced. */
  bytes: number;
  base64: string;
}

export interface ResolveOutcome {
  item: PendingFillItem | null;
  reason: string;
  linked: boolean;
  /** A report matched but has no titles picked yet — open the picker, don't offer a fill. */
  needsTitles: boolean;
}

/** One row in the shelf's report browser. Mirrors publish-bridge.BrowseRow. */
export interface BrowseRow {
  /** The item's permanent id — what opening this row sends back. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  label: string;
  createdAt: string;
  promptSet: string | null;
  titleCount: number;
  chosenCount: number;
  status: string;
  videoId: string | null;
}

export interface BrowsePage {
  rows: BrowseRow[];
  /** Total matching the query — lets the list size its scroll range without fetching all. */
  total: number;
  offset: number;
  /** Reports that could not be parsed. Shown, never hidden. */
  unreadable: number;
}

/** Everything the shelf needs to pick titles for one item. Mirrors publish-bridge.ItemDetail. */
export interface ItemDetail {
  /** The item's permanent id — what saving titles for it names. */
  itemId: string;
  /** Display back-reference to the run that produced it. Never a lookup key. */
  jobId: string;
  label: string;
  createdAt: string;
  generatedTitles: string[];
  chosenTitles: string[];
  description: string;
  tags: string;
  sourceFilename: string | null;
  status: string;
  videoId: string | null;
  /** Monetization. Always true from ContentStudio 1.1+ — see PendingFillItem.monetize. */
  monetize: boolean | null;
  /** Whether ContentStudio has a thumbnail for this item. See PendingFillItem. */
  hasThumbnail?: boolean;
  maxVariants: number;
  maxTitleLength: number;
}

export type SetTitlesResult =
  | { ok: true; item: ItemDetail }
  | { ok: false; errors: string[] };

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

/**
 * Refuse a payload from a ContentStudio that predates `monetize`.
 *
 * An older app simply omits the field, and `undefined` is the one value that must never
 * reach the monetization filler: `undefined === null` is false, so it would read as a
 * real decision and the falsy branch would switch monetization OFF on a video whose
 * operator never said anything. Three values are legal here and a fourth is a version
 * mismatch, which is a thing to SAY rather than to work around.
 *
 * Checked on every route that carries an item, not once at startup: the app can be
 * restarted (or downgraded) under a Studio tab that stays open for days.
 */
function requireMonetize(value: unknown, route: string): void {
  if (value === true || value === false || value === null) return;
  throw new PublishClientError(
    'unexpected-response',
    `${route} did not include a "monetize" value (got ${JSON.stringify(value)}). ` +
      `This extension is 0.2.1 or newer and ContentStudio is older than the monetization ` +
      `field — update ContentStudio.`,
  );
}

export async function fetchPending(): Promise<PendingFillItem[]> {
  const body = await call<{ items?: PendingFillItem[] }>('/publish/pending');
  if (!body || !Array.isArray(body.items)) {
    throw new PublishClientError('unexpected-response', '/publish/pending did not return an items array');
  }
  for (const item of body.items) requireMonetize(item.monetize, '/publish/pending');
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
  // A null item is a normal answer (nothing matched) and carries nothing to check.
  if (body.item) requireMonetize(body.item.monetize, '/publish/resolve');
  return body;
}

/** Record that fields were filled. NOT the same as published — the operator still saves. */
export async function reportFilled(itemId: string, videoId: string): Promise<void> {
  await call<{ ok: boolean }>('/publish/filled', {
    method: 'POST',
    body: JSON.stringify({ itemId, videoId }),
  });
}

/**
 * A page of the full report index. Paginated so the shelf can show months of reports
 * without pulling all of them, loading older pages as the operator scrolls.
 */
export async function fetchReports(offset: number, limit: number, query: string): Promise<BrowsePage> {
  const params = new URLSearchParams({
    offset: String(offset),
    limit: String(limit),
    q: query,
  });
  const body = await call<BrowsePage>(`/publish/reports?${params.toString()}`);
  if (!body || !Array.isArray(body.rows) || typeof body.total !== 'number') {
    throw new PublishClientError('unexpected-response', '/publish/reports returned an unexpected body');
  }
  return body;
}

/** One item in full, including every generated title — the picker's source data. */
export async function fetchItem(itemId: string): Promise<ItemDetail> {
  const params = new URLSearchParams({ itemId });
  const body = await call<{ item?: ItemDetail }>(`/publish/item?${params.toString()}`);
  if (!body || !body.item || !Array.isArray(body.item.generatedTitles)) {
    throw new PublishClientError('unexpected-response', '/publish/item returned an unexpected body');
  }
  requireMonetize(body.item.monetize, '/publish/item');
  return body.item;
}

/**
 * Save the chosen A/B variants. Order is preserved exactly as sent.
 *
 * A validation failure comes back as {ok:false, errors} rather than throwing — it's an
 * expected outcome of a click, and the reason belongs in the shelf verbatim.
 */
export async function saveTitles(itemId: string, titles: string[]): Promise<SetTitlesResult> {
  const body = await call<SetTitlesResult>('/publish/titles', {
    method: 'POST',
    body: JSON.stringify({ itemId, titles }),
  });
  if (!body || typeof body.ok !== 'boolean') {
    throw new PublishClientError('unexpected-response', '/publish/titles returned an unexpected body');
  }
  // The success shape carries a full ItemDetail, which is what the shelf then fills from.
  if (body.ok) requireMonetize(body.item.monetize, '/publish/titles');
  return body;
}

/**
 * The bytes of one item's thumbnail, or null when it has none.
 *
 * `null` is a normal answer and is NOT an error: an item without a thumbnail is a video
 * that goes up with Studio's auto-generated frame, which is a state the operator can
 * legitimately be in. What IS refused is a body that does not answer the question at all,
 * because "we could not tell" must never read as "there is none".
 *
 * The base64 is not decoded here. This module's job is the wire; turning bytes into a
 * File is the DOM's job, and it happens in thumbnail.ts where the File is used.
 */
export async function fetchThumbnail(itemId: string): Promise<PublishThumbnail | null> {
  const params = new URLSearchParams({ itemId });
  const body = await call<{ thumbnail?: PublishThumbnail | null }>(
    `/publish/thumbnail?${params.toString()}`,
  );
  if (!body || !('thumbnail' in body)) {
    throw new PublishClientError(
      'unexpected-response',
      `/publish/thumbnail returned a body with no "thumbnail" key. If ContentStudio is ` +
        `older than the thumbnail step, update it — this extension will not guess that ` +
        `the item has no image.`,
    );
  }
  const thumbnail = body.thumbnail ?? null;
  if (thumbnail === null) return null;

  if (typeof thumbnail.base64 !== 'string' || !thumbnail.base64) {
    throw new PublishClientError(
      'unexpected-response',
      `/publish/thumbnail said item ${itemId} has a thumbnail but sent no bytes.`,
    );
  }
  if (thumbnail.mime !== 'image/png' && thumbnail.mime !== 'image/jpeg') {
    throw new PublishClientError(
      'unexpected-response',
      `/publish/thumbnail sent ${JSON.stringify(thumbnail.mime)}, which is not one of the ` +
        `two types YouTube accepts. Nothing was set.`,
    );
  }
  return thumbnail;
}
