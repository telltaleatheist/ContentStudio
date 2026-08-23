// The nav strip's video list, read from YOUTUBE STUDIO ITSELF.
//
// The strip navigates Studio's content list, so the list comes from Studio: the same
// `creator/list_creator_videos` call that backs the content list page, in the same
// VIDEO_ORDER_DISPLAY_TIME_DESC order. ContentStudio is not consulted and does not need to
// be running — the strip is a Studio convenience, not an app feature, and tying it to the
// desktop app made it go dark whenever the app was closed and made the collector's
// coverage decide which videos the operator could reach.
//
// This lives in the SERVICE WORKER because the content script cannot do it. The endpoint
// needs window.ytcfg and the SAPISID cookie, which exist only in the page's MAIN world,
// and the content script runs in the ISOLATED one; chrome.scripting — worker-only — is
// what crosses that boundary. The tab injected into is the SENDER's tab, so the list is
// always the channel the operator is actually looking at.
//
// No fallbacks: every failure throws a NavSourceError whose kind and message reach the
// strip unchanged. Nothing here substitutes a partial list for a failed one.

import { fetchCatalogueInPage } from './catalogue';
import { readStudioContext } from './collector';
import { NAV_EXTRA_INITIAL } from './publish/nav-messages';
import type { NavList, NavVideo } from './publish/nav-strip';

/**
 * Why the list could not be read.
 *
 * A plain string rather than a closed union because the catalogue kinds (no-sapisid,
 * ytcfg-missing, http, shape, network, channel-mismatch — see catalogue.ts) PASS THROUGH
 * unchanged. Re-listing them here would be a second copy of that vocabulary, and the two
 * would eventually disagree about what YouTube just said.
 */
export class NavSourceError extends Error {
  readonly kind: string;

  constructor(kind: string, message: string) {
    super(message);
    this.name = 'NavSourceError';
    this.kind = kind;
  }
}

/**
 * Studio's content list AROUND the video the given tab has open, newest first.
 *
 * Two injections: the context probe says which channel the tab is on AND what it is
 * looking at, then the catalogue fetch pages that channel's list. Both facts are READ from
 * the tab rather than passed in — the content script's word for either would be a claim
 * about a page the worker can just look at, and the tab is the thing being injected into.
 *
 * NOT the whole channel by default. Paging a channel of thousands takes about a minute,
 * and the strip needs the open video's neighbours; the fetch is told to stop `extra`
 * entries past the open video, and the answer says whether it stopped early
 * (`complete: false`) or genuinely reached the end. When the tab is NOT on a video edit
 * page there is nothing to centre on, so the whole list is paged — the honest behaviour,
 * since no window can be chosen without a centre.
 */
export async function fetchNavListForTab(
  tabId: number,
  extra: number = NAV_EXTRA_INITIAL,
): Promise<NavList> {
  const { channelId, videoId } = await readTabContext(tabId);

  let result: any;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: fetchCatalogueInPage,
      // The argument is OMITTED rather than passed as undefined: chrome.scripting
      // serializes this array, and undefined is not serializable.
      args: videoId ? [channelId, { videoId, extra }] : [channelId],
    });
    result = results[0]?.result;
  } catch (err) {
    throw new NavSourceError('injection-failed', `Could not run the content-list fetch in this tab: ${msg(err)}`);
  }

  if (!result) {
    throw new NavSourceError('injection-failed', 'The content-list fetch returned nothing.');
  }
  if (!result.ok) {
    // Studio's own words, its own failure kind. The strip decides how to show each one.
    throw new NavSourceError(String(result.kind || 'unknown'), String(result.message || 'The content-list fetch failed.'));
  }
  if (!Array.isArray(result.videos)) {
    throw new NavSourceError('shape', 'The content-list fetch returned no videos array.');
  }

  // `complete` is required, not optional-with-a-default: a missing flag would default to
  // some value, and either default is a lie about a list this function did not check.
  if (typeof result.complete !== 'boolean') {
    throw new NavSourceError('shape', 'The content-list fetch did not say whether the list is complete.');
  }

  return { channelId, videos: result.videos.map(toNavVideo), complete: result.complete };
}

/**
 * Which channel is this tab signed into, and which video does it have open?
 *
 * One injected probe, MAIN world. `videoId` is null whenever the tab is not on a video
 * edit page — a fact, not a failure: the caller pages the whole list instead of centring
 * on a video that isn't there.
 */
async function readTabContext(tabId: number): Promise<{ channelId: string; videoId: string | null }> {
  let context: ReturnType<typeof readStudioContext> | undefined;
  try {
    const results = await chrome.scripting.executeScript({
      target: { tabId },
      world: 'MAIN',
      func: readStudioContext,
    });
    context = results[0]?.result ?? undefined;
  } catch (err) {
    throw new NavSourceError('injection-failed', `Could not read this tab's Studio context: ${msg(err)}`);
  }

  if (!context) {
    throw new NavSourceError('injection-failed', 'The Studio context probe returned nothing.');
  }
  // Named apart because they are different faults with the same fix: no ytcfg at all means
  // the tab is not running the Studio app (a sign-in interstitial, or a page caught
  // mid-load); ytcfg without a CHANNEL_ID means Studio booted but has not resolved which
  // channel this session is acting as.
  if (!context.ytcfgPresent) {
    throw new NavSourceError('ytcfg-missing', 'This tab is not running the Studio app (window.ytcfg is absent).');
  }
  if (!context.channelId) {
    throw new NavSourceError('no-channel', 'Studio has not said which channel this tab is on (CHANNEL_ID is empty).');
  }
  // The probe reports the tab's own href; /video/<id>/edit is the shape the strip runs on.
  const match = /\/video\/([^/?#]+)\//.exec(context.href || '');
  return { channelId: context.channelId, videoId: match?.[1] ?? null };
}

/**
 * CatalogueVideo -> NavVideo.
 *
 * The four fields the strip renders, and nothing else. An absent title or publish date
 * becomes '' rather than dropping the entry: that entry is a DRAFT, it belongs in the list
 * because it is in Studio's, and the strip is written to render one. An absent VIDEO ID is
 * a different matter — there is no video to navigate to — so it fails the whole call
 * rather than seeding the list with an id that goes nowhere when clicked.
 */
function toNavVideo(video: any): NavVideo {
  if (typeof video?.videoId !== 'string' || !video.videoId) {
    throw new NavSourceError('shape', 'The content list contained an entry with no video id.');
  }
  return {
    videoId: video.videoId,
    title: typeof video?.title === 'string' ? video.title : '',
    publishedAt: typeof video?.publishedAt === 'string' ? video.publishedAt : '',
    // Anything that is not a usable URL string becomes null — the strip has a documented
    // fallback for null, and no fallback for a URL that turns out not to be one.
    thumbnailUrl: typeof video?.thumbnailUrl === 'string' && video.thumbnailUrl ? video.thumbnailUrl : null,
  };
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
