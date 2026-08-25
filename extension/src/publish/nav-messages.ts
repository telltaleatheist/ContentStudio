// The one message the nav strip sends, and the guard the worker recognises it by.
//
// Deliberately NOT a PublishMessage. Every message in publish-messages.ts is a call to
// ContentStudio over localhost; this one never leaves the browser — it asks the worker to
// read Studio's own content list out of this very tab (see nav-source.ts). Filing it under
// 'publish' would put a localhost promise on a message that makes no localhost call, and
// the next reader would look for a route that does not exist.
//
// It carries NO videoId and NO channelId. The worker injects into the SENDER's tab, so
// which channel's list to fetch and which video it is centred on are facts about the tab,
// not something the content script can usefully assert — an id in the message would be an
// invitation to trust it over the tab.
//
// It DOES carry `extra`, which is not an identity claim but an appetite: how far past the
// open video the list should reach before the fetch stops paging. The content script is
// the only thing that knows how much of the list the operator has scrolled through, so it
// is the only thing that can say when the first, deliberately shallow, answer ran out.
//
// The transport is shared (sendToWorker) because the bridge, its two failure modes and the
// response envelope are identical for both kinds of message. Only the vocabulary differs.

import { sendToWorker } from './publish-messages';
import type { NavList } from './nav-strip';

/**
 * The strip's first, deliberately shallow ask: entries wanted past the open video.
 *
 * Three neighbours are drawn each side and the column scrolls, so a dozen below gives the
 * down arrow and a short scroll somewhere to go while keeping the fetch to a page or two
 * instead of the whole channel. Deeper asks are this doubled, and doubled again.
 *
 * Lives here rather than in either end so the content script and the worker cannot hold
 * two different opinions about how deep "the usual" is — nav-source uses it as its default.
 */
export const NAV_EXTRA_INITIAL = 12;

export type NavMessage = {
  type: 'nav-list';
  /** Entries wanted past the open video; omitted leaves the worker's default in force. */
  extra?: number;
};

const NAV_MESSAGE_TYPE: NavMessage['type'] = 'nav-list';

export function isNavMessage(message: unknown): message is NavMessage {
  if (typeof message !== 'object' || message === null) return false;
  return (message as { type?: unknown }).type === NAV_MESSAGE_TYPE;
}

/**
 * Studio's content list around the video this tab has open, newest first.
 *
 * `extra` asks for that many entries past the open video before paging stops; the answer's
 * `complete` says whether it stopped early or reached the end of the channel.
 *
 * Rejects with a PublishBridgeError whose `kind` is the failure kind nav-source produced —
 * which is Studio's own, for anything that went wrong at Studio's end.
 */
export function requestNavList(extra?: number): Promise<NavList> {
  return sendToWorker<NavList>({ type: NAV_MESSAGE_TYPE, extra });
}
