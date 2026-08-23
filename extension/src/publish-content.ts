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
// nodes are shared across worlds. No MAIN-world injection needed, so no page-script
// privileges are taken.
//
// Studio is an SPA — the URL changes without a reload — so this watches for navigation
// instead of relying on document_idle firing once.

import { fillerById, type FillContext, type FillId } from './publish/fillers';
import { PublishShelf, type PageContext } from './publish/shelf';
import type { ItemDetail } from './publish/publish-client';
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
import {
  detailsFormReady,
  isDetailsPage,
  isLivestreamPage,
  looksLikeDraft,
  readFilename,
  videoIdFromUrl,
} from './publish/page';
import { isMonetizationUrl, monetizationSurfaceReady } from './publish/monetization';
import { waitFor } from './publish/dom';

let shelf: PublishShelf | null = null;

/** The report currently loaded in the shelf. */
let item: ItemDetail | null = null;
/** videoId the shelf last resolved against, so navigation churn doesn't re-resolve. */
let resolvedFor: string | null = null;
/**
 * True while the operator picked a report by hand. Their choice outranks a filename
 * match, so an SPA navigation within the same video must not silently replace it.
 */
let manualPick = false;

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

function fillContextOf(detail: ItemDetail): FillContext {
  return {
    // The chosen set is what gets tested. With nothing picked, fall back to the
    // generator's top 3, which the prompts already order as the intended variants.
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
      shelf?.setStatus(resolved.reason);
      return;
    }

    // resolveForPage returns the fill-ready shape; the shelf needs the full picker data.
    const detail = await requestItem(resolved.item.itemId);
    item = detail;
    // A match with nothing picked is the one case worth interrupting for: there is a
    // decision to make before this video can be filled.
    shelf?.setItem(
      detail,
      resolved.needsTitles ? `${resolved.reason} Pick up to ${detail.maxVariants}.` : resolved.reason,
      resolved.needsTitles,
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
      await resolveCurrentVideo();
    },

    onOpenReport: async (itemId: string) => {
      try {
        const detail = await requestItem(itemId);
        item = detail;
        manualPick = true;
        shelf?.setItem(detail, 'Picked by hand.');
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
        shelf?.setItem(result.item, manualPick ? 'Picked by hand.' : 'Saved.');
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
