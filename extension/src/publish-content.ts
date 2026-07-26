// Content script for YouTube Studio video details pages.
//
// Flow: detect the details form -> read the videoId (URL) and the original filename
// (sidebar) -> ask ContentStudio which generated item that is -> show the confirm panel
// -> fill on click.
//
// Runs in the extension's ISOLATED world, which is sufficient: everything it does is DOM
// work (querySelector, execCommand, dispatched events, the native input setter) and DOM
// nodes are shared across worlds. No MAIN-world injection needed, so no page-script
// privileges are taken.
//
// Studio is an SPA — the URL changes without a reload — so this watches for navigation
// instead of relying on document_idle firing once.

import { fillerById, type FillContext, type FillId } from './publish/fillers';
import { PublishPanel } from './publish/panel';
import type { PendingFillItem } from './publish/publish-client';
// All localhost traffic goes through the service worker — see publish-messages.ts for
// why a content-script fetch cannot talk to ContentStudio directly.
import {
  PublishBridgeError,
  requestFilled,
  requestPending,
  requestResolve,
} from './publish/publish-messages';
import { detailsFormReady, isDetailsPage, readFilename, videoIdFromUrl } from './publish/page';
import { waitFor } from './publish/dom';

let panel: PublishPanel | null = null;
/** videoId we've already set up for, so navigation churn doesn't rebuild constantly. */
let activeVideoId: string | null = null;
/** Videos the operator explicitly dismissed — don't nag on the same page. */
const dismissed = new Set<string>();

function teardown(): void {
  panel?.destroy();
  panel = null;
  activeVideoId = null;
}

function contextOf(item: PendingFillItem): FillContext {
  return { titles: item.titles, description: item.description, tags: item.tags };
}

async function runFillers(item: PendingFillItem, videoId: string, ids: FillId[]): Promise<void> {
  const ctx = contextOf(item);
  let anySucceeded = false;

  for (const id of ids) {
    const filler = fillerById(id);
    if (!filler) continue;

    const detected = filler.detect(ctx);
    if (!detected.available) {
      // Skipping is only reported when the operator asked for this action specifically;
      // during "fill everything" an unavailable action isn't an error worth shouting about.
      if (ids.length === 1) panel?.log(false, filler, detected.reason);
      continue;
    }

    const outcome = await filler.fill(ctx);
    if (outcome.ok) {
      anySucceeded = true;
      panel?.log(true, filler, outcome.detail);
    } else {
      // FAIL LOUD: a selector miss must be visible, never a silent no-op.
      panel?.log(false, filler, outcome.reason);
    }
  }

  if (anySucceeded) {
    try {
      await requestFilled(item.jobId, item.itemIndex, videoId);
    } catch (error) {
      panel?.log(
        false,
        null,
        `Filled the form but could not tell ContentStudio: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

async function setupFor(videoId: string): Promise<void> {
  // Wait for the SPA to actually render the form before reading anything off it.
  try {
    await waitFor(() => detailsFormReady(), 'the Studio details form', 15000);
  } catch {
    return; // not a details page after all, or Studio is still loading — try again on next nav
  }

  const filename = readFilename();

  let resolved;
  let pending: PendingFillItem[] = [];
  try {
    resolved = await requestResolve(videoId, filename);
    if (!resolved.item) pending = await requestPending();
  } catch (error) {
    // ContentStudio simply not running is not worth a panel on every Studio page.
    // Anything else (503 stale app, bad response, worker disconnected) IS surfaced.
    if (error instanceof PublishBridgeError && error.kind === 'unreachable') return;
    panel = new PublishPanel(makeCallbacks(videoId, null));
    panel.renderError(error instanceof Error ? error.message : String(error));
    return;
  }

  // Nothing pending at all and no match: stay silent rather than nagging.
  if (!resolved.item && pending.length === 0) return;

  panel = new PublishPanel(makeCallbacks(videoId, resolved.item));

  if (resolved.item) {
    panel.renderMatch(resolved.item, resolved.reason, contextOf(resolved.item));
  } else {
    panel.renderNoMatch(resolved.reason, pending);
  }
}

function makeCallbacks(videoId: string, item: PendingFillItem | null) {
  return {
    onFill: async (ids: FillId[]) => {
      if (!item) return;
      await runFillers(item, videoId, ids);
    },
    onPickOther: async (jobId: string, itemIndex: number) => {
      // Manual override: pull the chosen item and re-render against it.
      try {
        const all = await requestPending();
        const picked = all.find((p) => p.jobId === jobId && p.itemIndex === itemIndex);
        if (!picked) return;
        panel?.destroy();
        panel = new PublishPanel(makeCallbacks(videoId, picked));
        panel.renderMatch(picked, 'Picked manually.', contextOf(picked));
      } catch (error) {
        panel?.renderError(error instanceof Error ? error.message : String(error));
      }
    },
    onDismiss: () => {
      dismissed.add(videoId);
      panel = null;
    },
  };
}

async function onNavigation(): Promise<void> {
  const videoId = videoIdFromUrl();

  if (!videoId || !isDetailsPage()) {
    teardown();
    return;
  }
  if (videoId === activeVideoId) return; // already set up
  if (dismissed.has(videoId)) return;

  teardown();
  activeVideoId = videoId;
  await setupFor(videoId);
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
  setInterval(() => {
    if (location.href !== lastUrl) {
      lastUrl = location.href;
      void onNavigation();
    }
  }, 600);
}

void onNavigation();
watchNavigation();
