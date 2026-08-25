// Content script for YouTube Studio.
//
// Owns the ContentStudio shelf: mounts it ONCE per tab and keeps it mounted. The shelf is
// not a per-video prompt — it is also how the operator browses reports and picks titles —
// so closing a video or navigating away must not take it down.
//
// Flow when a video is open: read the videoId (URL) and the original filename (sidebar) ->
// ask ContentStudio which generated item that is -> show it -> fill on click. When no
// video is open, the shelf stays up on its Reports tab.
//
// That resolution is a SUGGESTION and never a precondition. The operator can pick any
// report out of the browser and fill it into whatever Studio page is in front of them —
// including a livestream's details, which has no uploaded file and therefore no filename
// for the join to work on. manualPick below is what protects such a choice from being
// overwritten by the next navigation, and linkage.ts is what tells the operator, in one
// line, what they are about to do.
//
// Runs in the extension's ISOLATED world, which is sufficient: everything it does is DOM
// work (querySelector, execCommand, dispatched events, the native input setter) and DOM
// nodes are shared across worlds. It never injects into the MAIN world itself — the one
// thing that needs page globals, the nav strip's video list, is asked of the service
// worker, which is the only context that can inject at all.
//
// Studio is an SPA — the URL changes without a reload — so this watches for navigation
// instead of relying on document_idle firing once.

import { fillerById, type FillContext, type FillId } from './publish/fillers';
import { PublishShelf, type PageContext } from './publish/shelf';
import { NEIGHBOURS, NavStrip, type NavStripCallbacks, type NavVideo } from './publish/nav-strip';
import type { ItemDetail, ResolveAlternate } from './publish/publish-client';
// All localhost traffic goes through the service worker — see publish-messages.ts for
// why a content-script fetch cannot talk to ContentStudio directly.
import {
  PublishBridgeError,
  STALE_CONTEXT_MESSAGE,
  extensionContextAlive,
  requestFilled,
  requestItem,
  requestReports,
  requestResolve,
  requestSaveTitles,
  requestThumbnail,
} from './publish/publish-messages';
// The nav strip's list is NOT a ContentStudio call — it is read from Studio itself, so it
// travels its own message rather than a publish one. See nav-messages.ts.
import { NAV_EXTRA_INITIAL, requestNavList } from './publish/nav-messages';
import {
  detailsFormReady,
  isDetailsPage,
  isLivestreamPage,
  looksLikeDraft,
  readFilename,
  videoEditId,
  videoIdFromUrl,
} from './publish/page';
import { isMonetizationUrl, monetizationSurfaceReady } from './publish/monetization';
import { waitFor } from './publish/dom';

let shelf: PublishShelf | null = null;
/** The right-edge video navigator. Mounted only on /video/<id>/edit — see syncNavStrip. */
let navStrip: NavStrip | null = null;
/**
 * Studio's content list, as the strip draws it.
 *
 * Cached for the tab because it is the same list for every video on the channel and the
 * operator clicks through several in a row. Dropped — never quietly reused — when the
 * refresh button is pressed or when the cache rule below says it has been outgrown.
 */
let navList: NavVideo[] | null = null;
/**
 * Does `navList` reach the end of the channel?
 *
 * The fetch stops early on purpose — paging a whole channel took about a minute, which is
 * a minute of no strip at all — so the usual answer is NO, and this flag is what keeps a
 * list that merely stopped from being drawn as a channel that ended. See nav-strip's
 * NavList doc.
 */
let navComplete = false;
/**
 * The `extra` the cached list was fetched with: how many entries past the open video were
 * asked for. Doubling it is how a deeper fetch is requested.
 */
let navDepth = NAV_EXTRA_INITIAL;
/** A deeper fetch is in flight. One at a time — the strip asks on every scroll event. */
let navMoreInFlight = false;
/**
 * A deeper fetch came back no longer than what we already had, so asking again is asking
 * the same question. Stops the scroll-to-the-bottom loop from firing forever against a
 * channel that will not grow (MAX_PAGES reached, or Studio handing out a nextPageToken
 * that yields nothing). The list stays marked truncated, because that is what it is —
 * this only stops the asking.
 */
let navMoreExhausted = false;
/**
 * Sequence number for the in-flight list fetch.
 *
 * Studio navigation is far faster than paging a channel's whole content list, so a reply
 * can easily arrive after the operator has already moved on. Painting it would highlight
 * the wrong video and aim both arrows at the wrong neighbours, so a superseded reply is
 * dropped.
 */
let navRequest = 0;

/** The report currently loaded in the shelf. */
let item: ItemDetail | null = null;
/** videoId the shelf last resolved against, so navigation churn doesn't re-resolve. */
let resolvedFor: string | null = null;
/**
 * True while the operator picked a report by hand. Their choice outranks a filename
 * match, so an SPA navigation within the same video must not silently replace it.
 */
let manualPick = false;
/**
 * Every report sharing this page's filename, the loaded one included, newest first.
 *
 * The resolve answer names the OTHERS; the loaded report is added here so the shelf can
 * draw one list and mark the active member. Kept per page and never persisted — it is a
 * description of what is on screen, not a preference.
 */
let siblings: ResolveAlternate[] = [];

function pageContext(): PageContext {
  return {
    videoId: videoIdFromUrl(),
    filename: readFilename(),
    isDraft: looksLikeDraft(),
    formReady: detailsFormReady(),
    // Studio's monetization panel is a SEPARATE surface: the standalone
    // /video/.../monetization page, or the upload wizard's Monetization step. It is read
    // here, alongside the details form, because either one can be what the operator is
    // looking at and the shelf offers actions for whichever it is.
    monetizationReady: monetizationSurfaceReady(),
  };
}

/**
 * The loaded report as a chooser chip, so it can sit in the same list as the ones it beat.
 *
 * Read off the detail rather than the resolve answer because it has to stay true after a
 * title is picked: the chip says how many are chosen, and a stale count would contradict
 * the picker two lines below it.
 */
function choiceOf(detail: ItemDetail): ResolveAlternate {
  return {
    itemId: detail.itemId,
    label: detail.label,
    createdAt: detail.createdAt,
    titleCount: detail.generatedTitles.length,
    chosenCount: detail.chosenTitles.length,
  };
}

/** The sibling list with `detail`'s own chip refreshed in place. Order is preserved. */
function withChoice(list: ResolveAlternate[], detail: ItemDetail): ResolveAlternate[] {
  return list.map((s) => (s.itemId === detail.itemId ? choiceOf(detail) : s));
}

function fillContextOf(detail: ItemDetail): FillContext {
  return {
    // The chosen set is what gets tested. With nothing picked, fall back to the
    // generator's top 3, which the prompts already order as the intended variants.
    //
    // The fall-back is NOT silent: the shelf chips say "no titles picked — using top N
    // generated" and the picker marks those N distinctly (shelf.ts buildChips/buildPicker)
    // whenever chosenTitles is empty, so nobody fills unreviewed titles thinking they are
    // reviewed ones. It is not blocked either — the operator curates.
    titles: detail.chosenTitles.length
      ? detail.chosenTitles
      : detail.generatedTitles.slice(0, detail.maxVariants),
    description: detail.description,
    tags: detail.tags,
    // Straight through, INCLUDING undefined. An app too old to send the field is a
    // different situation from an item with no image, and the filler says so differently;
    // reading absence as `false` here would collapse the two and tell the operator their
    // report has no thumbnail when the truth is that the app cannot serve one.
    hasThumbnail: detail.hasThumbnail,
    // Bound to THIS item's id, and fetched only if the thumbnail action actually runs —
    // the bytes are up to 2 MiB and most fills never touch them.
    loadThumbnail: () => requestThumbnail(detail.itemId),
  };
}

/**
 * Run the named fillers against the page.
 *
 * `videoId` is NULLABLE, and that is the whole point of this signature. A Studio page can
 * legitimately have a fillable metadata form and no video id in its URL — the live
 * dashboard opens a stream's details in a dialog over /channel/<cid>/livestreaming — and
 * the operator filling that form is the pre-stream workflow this feature exists for. The
 * id is needed only to RECORD the fill afterwards, so its absence costs the record, not
 * the fill, and the shelf is told which of the two happened.
 */
async function runFillers(detail: ItemDetail, videoId: string | null, ids: FillId[]): Promise<void> {
  const ctx = fillContextOf(detail);
  let anySucceeded = false;

  for (const id of ids) {
    const filler = fillerById(id);
    if (!filler) continue;

    const detected = filler.detect(ctx);
    if (!detected.available) {
      // Skipping is only reported when the operator asked for this action specifically;
      // during "fill everything" an unavailable action isn't an error worth shouting about.
      if (ids.length === 1) shelf?.log(false, filler, detected.reason);
      continue;
    }

    const outcome = await filler.fill(ctx);
    if (outcome.ok) {
      anySucceeded = true;
      shelf?.log(true, filler, outcome.detail);
    } else {
      // FAIL LOUD: a selector miss must be visible, never a silent no-op.
      shelf?.log(false, filler, outcome.reason);
    }
  }

  if (!anySucceeded) return;

  if (!videoId) {
    // DECLARED, not swallowed. /publish/filled is keyed by videoId, so there is nothing
    // truthful to send from a page that has none — but a fill that quietly failed to
    // record would leave the report looking untouched next time the operator opens it,
    // and they would have no way to know why.
    shelf?.log(
      false,
      null,
      'Filled the form, but this page carries no video id, so ContentStudio could not ' +
        'record the fill or link the report. Open the video and fill again to link it.',
    );
    return;
  }

  // The fill re-points the report at the video it was just typed into, which is what makes
  // the pre-stream workflow work at all (a text-subject report acquires the stream's id
  // the moment it is filled). When it was pointing somewhere ELSE that is a real change to
  // state the operator has already made once, so it is said out loud rather than left to
  // be discovered on the reports page.
  const relinkedFrom = detail.videoId && detail.videoId !== videoId ? detail.videoId : null;

  try {
    await requestFilled(detail.itemId, videoId);
    if (relinkedFrom) {
      shelf?.log(true, null, `Re-linked this report from video ${relinkedFrom} to ${videoId}.`);
    }
  } catch (error) {
    shelf?.log(
      false,
      null,
      `Filled the form but could not tell ContentStudio: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}

/**
 * Work out which report belongs to the video currently open, and load it.
 *
 * Not called at all when the operator has picked a report by hand — see manualPick.
 */
async function resolveCurrentVideo(): Promise<void> {
  const ctx = pageContext();
  shelf?.setPageContext(ctx);

  // THREE kinds of page can have a video open, and only the first carries everything
  // resolution would like to have:
  //   * details page / upload wizard  -> isDetailsPage(), the metadata form and the
  //                                      filename sidebar that filename-matching needs
  //   * standalone monetization page  -> the url carries the video id, but there is no
  //                                      metadata form and no filename sidebar on it
  //   * live control room             -> the url carries the video id; there is no
  //                                      filename sidebar, and the metadata form is
  //                                      behind an Edit control that may never be opened
  // All three are worth resolving, because a video that is already LINKED resolves by its
  // id alone — which on the live surfaces is the only join available, since a stream has
  // no uploaded file for a filename to come from.
  // (The wizard's Monetization STEP is not a fourth case: it keeps the wizard's url, so
  // isDetailsPage() is still true there. Neither is the live DASHBOARD, which carries a
  // channel id and no video id and therefore falls out below — the operator reaches its
  // stream details through the Reports tab, which is exactly what that tab is for.)
  const onDetails = isDetailsPage();
  const onMonetization = isMonetizationUrl();
  const onLivestream = isLivestreamPage();

  if (!ctx.videoId || (!onDetails && !onMonetization && !onLivestream)) {
    item = null;
    resolvedFor = null;
    shelf?.setStatus('No video open. Use Reports to load one.');
    return;
  }

  if (onDetails) {
    // Wait for the SPA to actually render the form before reading the sidebar off it.
    try {
      await waitFor(() => detailsFormReady(), 'the Studio details form', 15000);
    } catch {
      shelf?.setStatus('Studio has not finished loading this video.');
      return;
    }
  }
  // Nothing to wait for on the monetization page or in the live control room: the video
  // id is in the url and the filename sidebar does not exist on either, so resolution has
  // everything it will get. Each page's own fillable PANEL is a separate fact and is
  // reported in the page context, not waited on — a channel outside the Partner Program
  // never renders the monetization radios, and a control room shows its metadata form only
  // once the operator opens Edit, so sitting in a 15-second timeout would report both of
  // those as "still loading". The surface poll in watchNavigation picks them up whenever
  // they do appear.

  // Re-read: on the details page the form (and with it the filename) has only just
  // arrived, and on any of them the fillable surfaces are what the shelf renders from.
  const loaded = pageContext();
  shelf?.setPageContext(loaded);

  try {
    const resolved = await requestResolve(loaded.videoId!, loaded.filename);
    if (!resolved.item) {
      item = null;
      siblings = [];
      shelf?.setStatus(resolved.reason);
      return;
    }

    // resolveForPage returns the fill-ready shape; the shelf needs the full picker data.
    const detail = await requestItem(resolved.item.itemId);
    item = detail;
    // A match with nothing picked is the one case worth interrupting for: there is a
    // decision to make before this video can be filled. The invitation is only true when
    // the report HAS titles -- "pick up to 3" on a report that generated none reads as a
    // shelf that has lost the list, so that state says what it is instead.
    const invite = detail.generatedTitles.length
      ? `Pick up to ${detail.maxVariants}.`
      : 'This report generated no titles.';
    // The alternates are the reports this match BEAT; the chooser shows the whole set, so
    // the loaded one joins them. No alternates means there was nothing to choose between
    // and the shelf draws no chooser at all.
    siblings = resolved.alternates.length
      ? [...resolved.alternates, choiceOf(detail)].sort((a, b) =>
          (b.createdAt || '').localeCompare(a.createdAt || '') ||
          b.itemId.localeCompare(a.itemId),
        )
      : [];
    shelf?.setItem(
      detail,
      resolved.needsTitles ? `${resolved.reason} ${invite}` : resolved.reason,
      resolved.needsTitles,
      siblings,
    );
  } catch (error) {
    if (error instanceof PublishBridgeError && error.kind === 'unreachable') {
      // The app being closed is a normal state, not a fault — say it plainly and quietly.
      item = null;
      shelf?.setStatus('ContentStudio is not running.');
      return;
    }
    shelf?.setError(error instanceof Error ? error.message : String(error));
  }
}

function navCallbacks(): NavStripCallbacks {
  return {
    // The strip owns the right edge; the shelf steps aside by exactly its width. Held
    // here rather than in either component so neither has to know the other exists.
    onLaneWidth: (px: number) => shelf?.setRightLaneWidth(px),

    // The operator has scrolled near the foot of a truncated list. Fetch more of it,
    // without disturbing what is on screen. Fires on every scroll event that qualifies,
    // hence the guards.
    onNeedMore: () => {
      void fetchDeeperNavList();
    },
  };
}

/**
 * Is the cached list still the right answer for `videoId`?
 *
 * THE RULE, and why it is this one: a list is usable when it contains the open video and
 * still has room below it. A COMPLETE list always has room — its bottom edge is the
 * channel's bottom edge, and the strip is right to draw an end there. A TRUNCATED list has
 * room only while the open video sits comfortably inside it, because its bottom edge is an
 * artefact of where the fetch stopped: standing near it, the operator would see a list that
 * appears to end and a down arrow with nowhere to go, neither of which is true.
 *
 * "Comfortably" is the same NEIGHBOURS margin the strip guarantees around the open video.
 * Cheap on purpose — one index comparison, no request — because it runs on every SPA
 * navigation.
 */
function navCacheUsable(videoId: string): boolean {
  if (!navList) return false;
  const index = navList.findIndex((v) => v.videoId === videoId);
  if (index === -1) return false;
  if (navComplete) return true;
  return index + NEIGHBOURS + 1 < navList.length;
}

/**
 * Ask for more of a truncated list, centred on the same video, and repaint in place.
 *
 * Depth DOUBLES each time so a determined scroll reaches the end of a long channel in a
 * handful of requests rather than a hundred. The strip keeps its scroll position across
 * the repaint (see NavStrip.render), so the tiles being read do not jump when the new ones
 * arrive.
 */
async function fetchDeeperNavList(): Promise<void> {
  const videoId = videoEditId();
  if (!videoId || !navStrip || !navList) return;
  // Nothing to deepen: the list already reaches the end of the channel, one request is
  // already out, or the last one came back no bigger than what we had.
  if (navComplete || navMoreInFlight || navMoreExhausted) return;

  const had = navList.length;
  const depth = navDepth * 2;
  navMoreInFlight = true;
  navStrip.setLoadingMore();
  const seq = (navRequest += 1);
  try {
    const list = await requestNavList(depth);
    if (seq !== navRequest) return;
    navDepth = depth;
    if (list.videos.length <= had && !list.complete) {
      // Asked deeper, got no more. Say so once and stop asking — see navMoreExhausted.
      navMoreExhausted = true;
    }
    navList = list.videos;
    navComplete = list.complete;
    navStrip.setList(videoId, list.videos, list.complete);
  } catch (error) {
    if (seq !== navRequest) return;
    // The list on screen is still good; only the attempt to extend it failed. Keep the
    // tiles and say what happened in the strip rather than blanking a working navigator —
    // and stop asking, so a scroll at the bottom does not retry forever in silence.
    navMoreExhausted = true;
    navStrip.setMoreFailed(error instanceof Error ? error.message : String(error));
  } finally {
    navMoreInFlight = false;
  }
}

/** Forget the cached list and everything derived from it. */
function dropNavList(): void {
  navList = null;
  navComplete = false;
  navDepth = NAV_EXTRA_INITIAL;
  navMoreExhausted = false;
}

/**
 * Mount, update or remove the nav strip for the page we are now on.
 *
 * Never throws: it is called fire-and-forget from the navigation watcher, and every state
 * it can end up in is one it shows on screen.
 */
async function syncNavStrip(): Promise<void> {
  const videoId = videoEditId();

  // Not a standalone edit page (channel lists, the upload wizard, analytics…). The strip
  // navigates between videos, which is meaningless — and in the wizard destructive — off
  // the edit page, so it comes down entirely and gives the shelf its lane back.
  if (!videoId) {
    navStrip?.destroy();
    navStrip = null;
    return;
  }

  if (!navStrip) {
    const created = new NavStrip(navCallbacks());
    try {
      await created.mount();
    } catch (error) {
      // Same reasoning as the shelf's mount: an overlay that silently fails to appear is
      // indistinguishable from one that was never built.
      console.error('[ContentStudio] the video nav strip could not mount:', error);
      return;
    }
    navStrip = created;
  }

  // A cached list that still holds this video, with room below it, is the whole answer —
  // same channel, no call. See navCacheUsable for what "room" means and why a truncated
  // list stops counting once the open video nears its bottom edge.
  if (navList && navCacheUsable(videoId)) {
    navStrip.setList(videoId, navList, navComplete);
    return;
  }

  const seq = (navRequest += 1);
  navStrip.setLoading();
  // Back to the shallow depth: the fetch re-centres on THIS video, so the deep list that
  // was built up around the previous one has no bearing on how far past this one to page.
  dropNavList();
  try {
    const list = await requestNavList(navDepth);
    if (seq !== navRequest) return;
    navList = list.videos;
    navComplete = list.complete;
    navStrip?.setList(videoId, list.videos, list.complete);
  } catch (error) {
    if (seq !== navRequest) return;
    dropNavList();
    const detail = error instanceof Error ? error.message : String(error);
    const kind = error instanceof PublishBridgeError ? error.kind : null;
    if (kind === 'ytcfg-missing' || kind === 'no-channel' || kind === 'no-sapisid') {
      // The tab has no usable Studio session yet: still loading, sitting on a sign-in
      // interstitial, or signed out. It is Studio's state, not a fault of ours, and it
      // fixes itself once the page is what it looks like — so it is muted, and the exact
      // reason waits in the tooltip.
      navStrip?.setNotice('Studio session not ready \u2014 reload this page.', detail);
      return;
    }
    navStrip?.setError(detail);
  }
}

function callbacks() {
  return {
    // WHAT IS DELIBERATELY NOT CHECKED HERE: whether the loaded report belongs to the
    // video on this page. It used to refuse without a videoId in the URL, which made the
    // one workflow that has no matching video — metadata generated from a text subject,
    // filled into a livestream created minutes earlier — impossible to perform at all.
    // The match is a suggestion (publish-bridge.resolveForPage) and the mismatch is a
    // NOTE (linkage.ts); neither is a gate. What stands between a report and the wrong
    // video is that nothing on this shelf fills without the operator clicking it, and
    // that they read the note before they did.
    onFill: async (ids: FillId[]) => {
      if (!item) {
        shelf?.log(false, null, 'No report loaded.');
        return;
      }
      await runFillers(item, videoIdFromUrl(), ids);
    },

    onRefresh: async () => {
      // An explicit refresh re-reads the page too: the operator may have switched videos
      // inside the wizard without the URL changing.
      manualPick = false;
      resolvedFor = videoIdFromUrl();
      // The refresh button is also the nav strip's: the cached list is a snapshot of
      // Studio's content list at the moment this tab first asked for it, so an upload made
      // since then reaches the strip only by dropping it, which is exactly what the
      // strip's "not in the list" state tells the operator to press.
      dropNavList();
      await Promise.all([resolveCurrentVideo(), syncNavStrip()]);
    },

    onOpenReport: async (itemId: string) => {
      try {
        const detail = await requestItem(itemId);
        item = detail;
        manualPick = true;
        // Two callers, one path. From the filename chooser the list stays up so the choice
        // stays reversible; from the Reports tab the operator has left that set entirely,
        // and keeping a chooser that no longer describes what is loaded would be a lie.
        const fromChooser = siblings.some((s) => s.itemId === itemId);
        const count = siblings.length;
        siblings = fromChooser ? withChoice(siblings, detail) : [];
        shelf?.setItem(
          detail,
          fromChooser ? `Picked from the ${count} reports sharing this filename.` : 'Picked by hand.',
          false,
          siblings,
        );
      } catch (error) {
        shelf?.setError(error instanceof Error ? error.message : String(error));
      }
    },

    onSaveTitles: async (titles: string[]) => {
      if (!item) return;
      try {
        const result = await requestSaveTitles(item.itemId, titles);
        if (!result.ok) {
          // Validation failures carry ContentStudio's own wording — show it verbatim
          // rather than inventing a second set of rules here.
          shelf?.setError(result.errors.join(' '));
          return;
        }
        item = result.item;
        // Picking a title changes this report's chip ("2 picked"), so the list is
        // refreshed rather than redrawn from the count resolve happened to see.
        siblings = withChoice(siblings, result.item);
        shelf?.setItem(result.item, manualPick ? 'Picked by hand.' : 'Saved.', false, siblings);
      } catch (error) {
        shelf?.setError(error instanceof Error ? error.message : String(error));
      }
    },

    onFetchReports: (offset: number, limit: number, query: string) =>
      requestReports(offset, limit, query),

    onLoadThumbnail: (itemId: string) => requestThumbnail(itemId),
  };
}

async function onNavigation(): Promise<void> {
  const videoId = videoIdFromUrl();
  shelf?.setPageContext(pageContext());

  // The strip follows the URL and nothing else — it has no report to resolve and no
  // manual pick to respect — so it syncs on every navigation, including the ones the
  // shelf deliberately ignores below. Fire-and-forget: it renders its own failures.
  void syncNavStrip();

  // The operator's own pick outranks anything we'd infer from the page.
  if (manualPick) return;
  if (videoId && videoId === resolvedFor) return;

  resolvedFor = videoId;
  await resolveCurrentVideo();
}

/**
 * SPA navigation watcher.
 *
 * Studio does not fire a page load between videos, and it doesn't emit a usable custom
 * event either, so poll the URL. 600ms is imperceptible to the operator and costs
 * nothing measurable.
 */
function watchNavigation(): void {
  let lastUrl = location.href;
  let lastSurfaces = surfaceKey();
  const timer = setInterval(() => {
    // Once the extension is reloaded this tab's context is dead for good. Stop polling and
    // say so ONCE — otherwise every tick fires another chrome.* call that throws, which is
    // where the "Uncaught (in promise) Error: Extension context invalidated." spam came
    // from, with nothing on screen to explain that the tab needs reloading.
    if (!extensionContextAlive()) {
      clearInterval(timer);
      shelf?.setError(STALE_CONTEXT_MESSAGE);
      return;
    }
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      lastSurfaces = surfaceKey();
      void onNavigation();
      return;
    }

    // The upload wizard changes STEP without changing the url: Details -> Monetization is
    // the same href, and the details form leaves while the monetization panel arrives. A
    // url watcher alone would leave the shelf offering description/tags buttons on a page
    // that has neither. So the two surface facts are polled as well, and the shelf is
    // told only when one of them actually flips — a re-render on every tick would fight
    // the operator for focus in the report browser's search box.
    const surfaces = surfaceKey();
    if (surfaces !== lastSurfaces) {
      lastSurfaces = surfaces;
      shelf?.setPageContext(pageContext());
    }
  }, 600);
}

/** The two surface facts as one comparable string. Cheap enough to read every tick. */
function surfaceKey(): string {
  return `${detailsFormReady()}|${monetizationSurfaceReady()}`;
}

/**
 * Toolbar button -> show the shelf.
 *
 * The popup asks the active Studio tab to reveal itself. Answering with `mounted` lets the
 * popup distinguish "shelf is there, now expanded" from "this tab has no content script",
 * which is what happens on a tab that was already open when the extension was reloaded —
 * the single most common reason the shelf appears to be missing.
 */
function listenForReveal(): void {
  chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
    if (typeof message !== 'object' || message === null) return false;
    if ((message as { type?: unknown }).type !== 'shelf-reveal') return false;

    if (!shelf) {
      sendResponse({ mounted: false, error: mountError ?? 'The shelf is not mounted on this page.' });
      return false;
    }
    void shelf.reveal();
    sendResponse({ mounted: true });
    return false;
  });
}

/** Why the shelf failed to mount, if it did. Reported to the popup rather than swallowed. */
let mountError: string | null = null;

async function start(): Promise<void> {
  // The reveal listener is registered FIRST and unconditionally, so that a shelf which
  // failed to mount can still explain itself when the operator clicks the toolbar button.
  listenForReveal();

  try {
    const created = new PublishShelf(callbacks());
    await created.mount();
    shelf = created;
  } catch (error) {
    // A shelf that silently fails to appear is indistinguishable from one that was never
    // built. Record it for the popup and put it in the console.
    mountError = error instanceof Error ? error.message : String(error);
    console.error('[ContentStudio] the shelf could not mount:', error);
    return;
  }

  await onNavigation();
  watchNavigation();
}

void start();
