// MV3 background service worker (ES module).
//
// Responsibilities:
//   - Master alarm every 6 hours -> one collection cycle. The cycle first pulls
//     the channel list LIVE from ContentStudio (GET /analytics/channels) — the
//     extension holds no hand-entered list — then calls collectChannel per
//     returned channel. Per-video cadence tiering (age <7d every cycle, 7-28d
//     daily, 28-365d weekly, >1y monthly) is the COLLECTOR's concern — see
//     src/collector.ts.
//
//     THE ALARM NEVER PUTS A TAB ON SCREEN. It collects through whatever Studio
//     tab the operator already has open on that channel and defers the channels
//     it cannot reach that way (NoStudioTabError). Only a manual "Sync now" is
//     allowed to open or navigate a tab, because only then is somebody asking.
//     The old behaviour opened one per channel per cycle — including in the
//     middle of a livestream, which is both an interruption and a data loss:
//     the tab gets closed in a hurry and takes the in-flight fetch with it.
//   - Records lastAttempt / lastError / snapshot count per channel in
//     chrome.storage.local.
//   - Flushes the outbox after every cycle (and on manual "Sync now").
//   - onInstalled: initializes default settings and the alarm.
//
// No fallbacks: if the channel list can't be fetched (ContentStudio down) the
// cycle records that as its channelSourceError and stops — it never collects
// against a stale/cached list.

import { CollectorNotImplementedError, NoStudioTabError, closeCollectorTab, collectChannel } from './collector';
import {
  PublishClientError,
  fetchItem,
  fetchPending,
  fetchReports,
  fetchThumbnail,
  reportFilled,
  resolveForPage,
  saveTitles,
} from './publish/publish-client';
import { isPublishMessage, type PublishMessage } from './publish/publish-messages';
import { isNavMessage } from './publish/nav-messages';
import { NavSourceError, fetchNavListForTab } from './nav-source';
import { enqueueAbTests, enqueueSnapshots, enqueueVideos, flushOutbox, outboxDepth, type FlushResult } from './outbox';
import { fetchChannels } from './ingest-client';
import { DEFAULT_SETTINGS, saveSettings } from './settings';
import { recordChannelAttempt, setLastCycle, type CycleSummary } from './status';

const CYCLE_ALARM = 'contentstudio-collection-cycle';
const CYCLE_PERIOD_MINUTES = 6 * 60;

async function ensureAlarm(): Promise<void> {
  const existing = await chrome.alarms.get(CYCLE_ALARM);
  if (!existing) {
    chrome.alarms.create(CYCLE_ALARM, { periodInMinutes: CYCLE_PERIOD_MINUTES });
  }
}

chrome.runtime.onInstalled.addListener((details) => {
  void (async () => {
    if (details.reason === 'install') {
      // Initialize defaults only when nothing is stored yet — never clobber.
      const stored = await chrome.storage.local.get('settings');
      if (stored['settings'] === undefined) {
        await saveSettings({ ...DEFAULT_SETTINGS });
      }
    }
    await ensureAlarm();
  })();
});

// Alarms persist across service worker restarts, but re-check on browser
// startup in case the alarm was lost (e.g. after an extension update).
chrome.runtime.onStartup.addListener(() => {
  void ensureAlarm();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === CYCLE_ALARM) {
    void runCollectionCycle('alarm');
  }
});

// Serialize cycles: an alarm firing while a manual sync runs (or vice versa)
// awaits the in-flight cycle instead of interleaving storage writes.
let inFlightCycle: Promise<CycleSummary> | null = null;

function runCollectionCycle(trigger: CycleSummary['trigger']): Promise<CycleSummary> {
  if (inFlightCycle) {
    return inFlightCycle;
  }
  inFlightCycle = doRunCollectionCycle(trigger).finally(() => {
    inFlightCycle = null;
  });
  return inFlightCycle;
}

async function doRunCollectionCycle(trigger: CycleSummary['trigger']): Promise<CycleSummary> {
  const startedAt = new Date().toISOString();

  // The channel list comes LIVE from ContentStudio — never a stored/stale list.
  // If it can't be fetched (app down), there is nothing to collect AND nothing
  // could be pushed anyway, so record the distinct error and stop.
  let channels;
  try {
    channels = await fetchChannels();
  } catch (err) {
    const error = err instanceof Error ? err : new Error(String(err));
    console.error('[background] could not fetch the channel list from ContentStudio:', err);
    const summary: CycleSummary = {
      startedAt,
      finishedAt: new Date().toISOString(),
      trigger,
      channelsAttempted: 0,
      channelSourceError: { name: error.name, message: error.message },
      flush: { attempted: 0, delivered: 0, remaining: await outboxDepth(), stopped: null, entryErrors: [] },
    };
    await setLastCycle(summary);
    return summary;
  }

  try {
    await collectAllChannels(channels, trigger);
  } finally {
    // The collector tab is scoped to the cycle, so it closes here even if a channel threw.
    // A failure to close is NOT a collection failure — everything is already enqueued — but
    // it does mean a Studio tab stays open forever, so it is said out loud rather than
    // swallowed.
    try {
      await closeCollectorTab();
    } catch (err) {
      console.error('[background] could not close the collector tab (it will stay open):', err);
    }
  }

  // Flush anything queued — from this cycle or left over from earlier
  // failures. flushOutbox never swallows: failures come back in the result.
  const flush: FlushResult = await flushOutbox();
  if (flush.stopped) {
    console.warn(`[background] outbox flush stopped (${flush.stopped.kind}): ${flush.stopped.message}`);
  }
  for (const entryError of flush.entryErrors) {
    console.error(`[background] outbox entry ${entryError.id} rejected (${entryError.kind}): ${entryError.message}`);
  }

  const summary: CycleSummary = {
    startedAt,
    finishedAt: new Date().toISOString(),
    trigger,
    channelsAttempted: channels.length,
    channelSourceError: null,
    flush,
  };
  await setLastCycle(summary);
  return summary;
}

/**
 * Collect every channel through the one shared collector tab.
 *
 * Split out of the cycle so the tab's lifetime is a single try/finally around exactly the
 * work that needs it, instead of the whole cycle including the outbox flush.
 */
async function collectAllChannels(
  channels: Awaited<ReturnType<typeof fetchChannels>>,
  trigger: CycleSummary['trigger'],
): Promise<void> {
  for (const channel of channels) {
    const attemptAt = new Date().toISOString();
    try {
      // Only the operator's own sync may open a tab. See ensureStudioTabForChannel.
      const result = await collectChannel(channel.channelId, { mayOpenTab: trigger === 'manual' });
      if (result.videos.length > 0) {
        await enqueueVideos(result.videos);
      }
      if (result.snapshots.length > 0) {
        await enqueueSnapshots(result.snapshots);
      }
      // Decided A/B tests — these become ChannelInsights.abLearnings and are injected
      // into the metadata prompt, which is the point of collecting them.
      if (result.abTests.length > 0) {
        await enqueueAbTests(result.abTests);
      }
      await recordChannelAttempt(channel.channelId, attemptAt, null, result.snapshots.length);
    } catch (err) {
      // Every failure is recorded with its distinct error name so the popup
      // can tell "collector pending" apart from a real collection failure.
      const error = err instanceof Error ? err : new Error(String(err));
      await recordChannelAttempt(channel.channelId, attemptAt, {
        name: error.name,
        message: error.message,
      });
      if (err instanceof NoStudioTabError) {
        // Routine, not a fault: an unattended pass with no tab to borrow. It is still
        // RECORDED above so the popup can say why a channel has not updated — silence
        // here would look identical to a channel nobody has looked at in a week.
        console.info(`[background] ${channel.channelId}: ${error.message}`);
      } else if (err instanceof CollectorNotImplementedError) {
        console.info(`[background] ${channel.channelId}: ${error.message} (collector pending Studio recon)`);
      } else {
        console.error(`[background] collection failed for ${channel.channelId}:`, err);
      }
    }
  }
}

// The popup triggers manual syncs via messaging so all storage writes happen
// in this single service worker context.
chrome.runtime.onMessage.addListener((message: unknown, sender, sendResponse) => {
  if (
    typeof message === 'object' &&
    message !== null &&
    (message as { type?: unknown }).type === 'sync-now'
  ) {
    runCollectionCycle('manual').then(
      (summary) => sendResponse({ ok: true, summary }),
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        sendResponse({ ok: false, errorName: error.name, error: error.message });
      },
    );
    return true; // keep the message channel open for the async response
  }

  // The nav strip's video list. NOT a ContentStudio call — the worker reads it out of
  // Studio itself, by injecting into the SENDER's tab, which is the only place the
  // page-world globals the endpoint needs exist. See nav-source.ts.
  if (isNavMessage(message)) {
    const tabId = sender.tab?.id;
    if (typeof tabId !== 'number') {
      // Nothing to inject into. Only the content script sends this, so reaching here means
      // something else did — answer with the fact rather than guessing at a tab.
      sendResponse({
        ok: false,
        error: 'The video-list request did not come from a tab.',
        kind: 'no-tab',
      });
      return true;
    }
    // `extra` is how deep the strip wants to go — it grows when the operator scrolls past
    // the end of a truncated list. Anything that is not a positive number is left off so
    // nav-source's own default stands rather than a nonsense depth being honoured.
    const extra = typeof message.extra === 'number' && message.extra > 0 ? message.extra : undefined;
    fetchNavListForTab(tabId, extra).then(
      (data) => sendResponse({ ok: true, data }),
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        sendResponse({
          ok: false,
          error: error.message,
          kind: error instanceof NavSourceError ? error.kind : 'unknown',
        });
      },
    );
    return true;
  }

  // Publish requests from the Studio content script.
  //
  // These MUST be serviced here rather than by fetching from the content script: a
  // content-script fetch carries the page's origin (https://studio.youtube.com), which
  // ContentStudio's CSRF whitelist rejects with 403, and it also trips Chrome's
  // local-network access prompt. The worker's chrome-extension:// origin is whitelisted.
  if (isPublishMessage(message)) {
    handlePublishMessage(message).then(
      (data) => sendResponse({ ok: true, data }),
      (err: unknown) => {
        const error = err instanceof Error ? err : new Error(String(err));
        sendResponse({
          ok: false,
          error: error.message,
          kind: error instanceof PublishClientError ? error.kind : 'unknown',
        });
      },
    );
    return true;
  }

  return false;
});

async function handlePublishMessage(message: PublishMessage): Promise<unknown> {
  switch (message.type) {
    case 'publish-pending':
      return fetchPending();
    case 'publish-resolve':
      return resolveForPage(message.videoId, message.filename);
    case 'publish-filled':
      await reportFilled(message.itemId, message.videoId);
      return null;
    case 'publish-reports':
      return fetchReports(message.offset, message.limit, message.query);
    case 'publish-item':
      return fetchItem(message.itemId);
    case 'publish-titles':
      return saveTitles(message.itemId, message.titles);
    case 'publish-thumbnail':
      return fetchThumbnail(message.itemId);
  }
}
