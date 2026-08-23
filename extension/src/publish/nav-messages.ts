// The one message the nav strip sends, and the guard the worker recognises it by.
//
// Deliberately NOT a PublishMessage. Every message in publish-messages.ts is a call to
// ContentStudio over localhost; this one never leaves the browser — it asks the worker to
// read Studio's own content list out of this very tab (see nav-source.ts). Filing it under
// 'publish' would put a localhost promise on a message that makes no localhost call, and
// the next reader would look for a route that does not exist.
//
// It carries NO videoId. The worker injects into the SENDER's tab, so which channel's list
// to fetch is a fact about the tab, not something the content script can usefully assert —
// and a videoId in the message would be an invitation to trust it over the tab.
//
// The transport is shared (sendToWorker) because the bridge, its two failure modes and the
// response envelope are identical for both kinds of message. Only the vocabulary differs.

import { sendToWorker } from './publish-messages';
import type { NavList } from './nav-strip';

export type NavMessage = { type: 'nav-list' };

const NAV_MESSAGE_TYPE: NavMessage['type'] = 'nav-list';

export function isNavMessage(message: unknown): message is NavMessage {
  if (typeof message !== 'object' || message === null) return false;
  return (message as { type?: unknown }).type === NAV_MESSAGE_TYPE;
}

/**
 * Studio's content list for the channel this tab is signed into, newest first.
 *
 * Rejects with a PublishBridgeError whose `kind` is the failure kind nav-source produced —
 * which is Studio's own, for anything that went wrong at Studio's end.
 */
export function requestNavList(): Promise<NavList> {
  return sendToWorker<NavList>({ type: NAV_MESSAGE_TYPE });
}
