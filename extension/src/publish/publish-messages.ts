// Message contract between the content script and the service worker.
//
// WHY THIS EXISTS: a `fetch` issued from a content script is attributed to the PAGE's
// origin, not the extension's. Talking to ContentStudio directly from the content script
// therefore (a) trips Chrome's local-network access prompt ("youtube.com wants to access
// services on this device") and (b) arrives at the ingest server with
// `Origin: https://studio.youtube.com`, which its CSRF whitelist rejects with 403 — by
// design, since that is exactly the shape of a malicious-page attack.
//
// The service worker has the extension's own origin (chrome-extension://…), which the
// server whitelists, and its fetches are not subject to page CORS. So ALL localhost
// traffic goes through here. Same reason the analytics collector does its fetching in
// the worker.

import type {
  BrowsePage,
  ItemDetail,
  PendingFillItem,
  ResolveOutcome,
  SetTitlesResult,
} from './publish-client';

export type PublishMessage =
  | { type: 'publish-pending' }
  | { type: 'publish-resolve'; videoId: string; filename: string | null }
  | { type: 'publish-filled'; jobId: string; itemIndex: number; videoId: string }
  | { type: 'publish-reports'; offset: number; limit: number; query: string }
  | { type: 'publish-item'; jobId: string; itemIndex: number }
  | { type: 'publish-titles'; jobId: string; itemIndex: number; titles: string[] };

export type PublishResponse<T> =
  | { ok: true; data: T }
  | { ok: false; error: string; kind: string };

/**
 * Every message type, in one place. Listed explicitly rather than prefix-matched on
 * 'publish-' so a typo'd type is rejected instead of silently reaching the worker's
 * switch and falling through.
 */
const PUBLISH_MESSAGE_TYPES: ReadonlySet<string> = new Set<PublishMessage['type']>([
  'publish-pending',
  'publish-resolve',
  'publish-filled',
  'publish-reports',
  'publish-item',
  'publish-titles',
]);

export function isPublishMessage(message: unknown): message is PublishMessage {
  if (typeof message !== 'object' || message === null) return false;
  const type = (message as { type?: unknown }).type;
  return typeof type === 'string' && PUBLISH_MESSAGE_TYPES.has(type);
}

/**
 * Error crossing the content-script boundary.
 *
 * `kind` is preserved deliberately: the shelf reports the app simply not running
 * ('unreachable') as a plain status line, and reserves the error box for real faults. A
 * bare Error would lose that and put a red box on every Studio page.
 */
export class PublishBridgeError extends Error {
  readonly kind: string;

  constructor(message: string, kind: string) {
    super(message);
    this.name = 'PublishBridgeError';
    this.kind = kind;
  }
}

async function send<T>(message: PublishMessage): Promise<T> {
  let response: PublishResponse<T> | undefined;
  try {
    response = await chrome.runtime.sendMessage(message);
  } catch {
    // The worker failed to wake, or the extension was reloaded out from under this page.
    // A stale content script can't recover — say so plainly instead of retrying.
    throw new PublishBridgeError(
      'Lost contact with the ContentStudio extension. Reload the Studio tab.',
      'disconnected',
    );
  }
  if (!response) {
    throw new PublishBridgeError('The ContentStudio extension returned no response.', 'unknown');
  }
  if (!response.ok) {
    throw new PublishBridgeError(response.error, response.kind);
  }
  return response.data;
}

export function requestPending(): Promise<PendingFillItem[]> {
  return send<PendingFillItem[]>({ type: 'publish-pending' });
}

export function requestResolve(videoId: string, filename: string | null): Promise<ResolveOutcome> {
  return send<ResolveOutcome>({ type: 'publish-resolve', videoId, filename });
}

export function requestFilled(jobId: string, itemIndex: number, videoId: string): Promise<void> {
  return send<void>({ type: 'publish-filled', jobId, itemIndex, videoId });
}

export function requestReports(offset: number, limit: number, query: string): Promise<BrowsePage> {
  return send<BrowsePage>({ type: 'publish-reports', offset, limit, query });
}

export function requestItem(jobId: string, itemIndex: number): Promise<ItemDetail> {
  return send<ItemDetail>({ type: 'publish-item', jobId, itemIndex });
}

export function requestSaveTitles(
  jobId: string,
  itemIndex: number,
  titles: string[],
): Promise<SetTitlesResult> {
  return send<SetTitlesResult>({ type: 'publish-titles', jobId, itemIndex, titles });
}
