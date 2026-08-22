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
} from './publish/publish-messages';
import { detailsFormReady, isDetailsPage, looksLikeDraft, readFilename, videoIdFromUrl } from './publish/page';
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
  };
}

async function runFillers(detail: ItemDetail, videoId: string, ids: FillId[]): Promise<void> {
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

  if (anySucceeded) {
    try {
      await requestFilled(detail.itemId, videoId);
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
}

/**
 * Work out which report belongs to the video currently open, and load it.
 *
 * Not called at all when the operator has picked a report by hand — see manualPick.
 */
async function resolveCurrentVideo(): Promise<void> {
  const ctx = pageContext();
  shelf?.setPageContext(ctx);

  if (!ctx.videoId || !isDetailsPage()) {
    item = null;
    resolvedFor = null;
    shelf?.setStatus('No video open. Use Reports to load one.');
    return;
  }

  // Wait for the SPA to actually render the form before reading the sidebar off it.
  try {
    await waitFor(() => detailsFormReady(), 'the Studio details form', 15000);
  } catch {
    shelf?.setStatus('Studio has not finished loading this video.');
    return;
  }

  const withForm = pageContext();
  shelf?.setPageContext(withForm);

  try {
    const resolved = await requestResolve(withForm.videoId!, withForm.filename);
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
    onFill: async (ids: FillId[]) => {
      const videoId = videoIdFromUrl();
      if (!item) {
        shelf?.log(false, null, 'No report loaded.');
        return;
      }
      if (!videoId) {
        shelf?.log(false, null, 'No video open to fill.');
        return;
      }
      await runFillers(item, videoId, ids);
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
      void onNavigation();
    }
  }, 600);
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
