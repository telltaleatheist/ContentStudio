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
//
// ONE message that travels this bridge is not localhost traffic at all: the nav strip's
// video list, which is read from Studio's own content-list endpoint. It goes through the
// worker for a different reason — that endpoint needs the page's MAIN world, and only the
// worker can inject there — and it borrows nothing from this file but the transport below.
// Its type and its guard live in nav-messages.ts, so a mistyped publish message still
// cannot reach the worker's publish switch, and a nav message is never mistaken for one.

import type {
  BrowsePage,
  ItemDetail,
  PendingFillItem,
  PublishThumbnail,
  ResolveOutcome,
  SetTitlesResult,
} from './publish-client';

export type PublishMessage =
  | { type: 'publish-pending' }
  | { type: 'publish-resolve'; videoId: string; filename: string | null }
  | { type: 'publish-filled'; itemId: string; videoId: string }
  | { type: 'publish-reports'; offset: number; limit: number; query: string }
  | { type: 'publish-item'; itemId: string }
  | { type: 'publish-titles'; itemId: string; titles: string[] }
  | { type: 'publish-thumbnail'; itemId: string };

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
  'publish-thumbnail',
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

/**
 * What to tell the operator once this tab's extension context is gone.
 *
 * Reloading the TAB is the only fix — reloading the extension again does not re-inject
 * into pages that were already open, which is the trap that makes this look like the
 * shelf is simply broken.
 */
export const STALE_CONTEXT_MESSAGE =
  'This tab is running a copy of the extension that has since been reloaded. Reload the Studio tab to reconnect.';

/**
 * Is this content script still attached to a live extension?
 *
 * `chrome.runtime.id` becomes undefined the moment the extension is reloaded, updated or
 * disabled, and from then on EVERY chrome.* call from this page throws "Extension context
 * invalidated." It is a terminal state for the tab, so knowing it lets the shelf say
 * "reload the tab" once instead of throwing on a 600ms timer.
 */
export function extensionContextAlive(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.runtime && chrome.runtime.id !== undefined;
}

/**
 * Send one message to the service worker and unwrap its {ok, data|error} envelope.
 *
 * Typed on `{ type: string }` rather than PublishMessage because the worker also answers
 * a message that is NOT a publish call — the nav strip's video list, which the worker
 * reads out of Studio itself (see nav-messages.ts). The bridge, its two failure modes and
 * the response envelope are identical for both, and one copy of that is the point.
 */
export async function sendToWorker<T>(message: { type: string } & Record<string, unknown>): Promise<T> {
  let response: PublishResponse<T> | undefined;

  // Distinguish the two ways sendMessage fails. A dead context is permanent and needs a
  // tab reload; a worker that failed to wake is transient and worth trying again.
  if (!extensionContextAlive()) {
    throw new PublishBridgeError(STALE_CONTEXT_MESSAGE, 'stale-context');
  }

  try {
    response = await chrome.runtime.sendMessage(message);
  } catch {
    // The worker failed to wake, or the extension was reloaded out from under this page.
    // A stale content script can't recover — say so plainly instead of retrying.
    throw new PublishBridgeError(
      extensionContextAlive()
        ? 'Lost contact with the ContentStudio extension. Reload the Studio tab.'
        : STALE_CONTEXT_MESSAGE,
      extensionContextAlive() ? 'disconnected' : 'stale-context',
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
  return sendToWorker<PendingFillItem[]>({ type: 'publish-pending' });
}

export function requestResolve(videoId: string, filename: string | null): Promise<ResolveOutcome> {
  return sendToWorker<ResolveOutcome>({ type: 'publish-resolve', videoId, filename });
}

export function requestFilled(itemId: string, videoId: string): Promise<void> {
  return sendToWorker<void>({ type: 'publish-filled', itemId, videoId });
}

export function requestReports(offset: number, limit: number, query: string): Promise<BrowsePage> {
  return sendToWorker<BrowsePage>({ type: 'publish-reports', offset, limit, query });
}

export function requestItem(itemId: string): Promise<ItemDetail> {
  return sendToWorker<ItemDetail>({ type: 'publish-item', itemId });
}

export function requestSaveTitles(itemId: string, titles: string[]): Promise<SetTitlesResult> {
  return sendToWorker<SetTitlesResult>({ type: 'publish-titles', itemId, titles });
}

/**
 * The item's thumbnail bytes, base64, or null when it has none.
 *
 * Asked for at FILL TIME rather than carried on the item payload, and that is the whole
 * reason this is its own message: a thumbnail is up to 2 MiB, `/publish/pending` returns
 * every actionable item at once, and putting the bytes on that list would push megabytes
 * through the message channel on every Studio page load for images that will never be
 * used. One image, once, when the operator asks for it.
 */
export function requestThumbnail(itemId: string): Promise<PublishThumbnail | null> {
  return sendToWorker<PublishThumbnail | null>({ type: 'publish-thumbnail', itemId });
}
