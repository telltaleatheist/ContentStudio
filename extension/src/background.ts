// MV3 background service worker (ES module).
//
// Responsibilities:
//   - Master alarm every 6 hours -> one collection cycle. The cycle first pulls
//     the channel list LIVE from ContentStudio (GET /analytics/channels) — the
//     extension holds no hand-entered list — then calls collectChannel per
//     returned channel. Per-video cadence tiering (age <7d every cycle, 7-28d
//     daily, 28-365d weekly, >1y monthly) is the COLLECTOR's concern — see
//     src/collector.ts.
//   - Records lastAttempt / lastError / snapshot count per channel in
//     chrome.storage.local.
//   - Flushes the outbox after every cycle (and on manual "Sync now").
//   - onInstalled: initializes default settings and the alarm.
//
// No fallbacks: if the channel list can't be fetched (ContentStudio down or bad
// token) the cycle records that as its channelSourceError and stops — it never
// collects against a stale/cached list.

import { CollectorNotImplementedError, collectChannel } from './collector';
import { enqueueSnapshots, enqueueVideos, flushOutbox, outboxDepth, type FlushResult } from './outbox';
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
  // If it can't be fetched (app down or bad token), there is nothing to collect
  // AND nothing could be pushed anyway, so record the distinct error and stop.
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

  for (const channel of channels) {
    const attemptAt = new Date().toISOString();
    try {
      const result = await collectChannel(channel.channelId);
      if (result.videos.length > 0) {
        await enqueueVideos(result.videos);
      }
      if (result.snapshots.length > 0) {
        await enqueueSnapshots(result.snapshots);
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
      if (err instanceof CollectorNotImplementedError) {
        console.info(`[background] ${channel.channelId}: ${error.message} (collector pending Studio recon)`);
      } else {
        console.error(`[background] collection failed for ${channel.channelId}:`, err);
      }
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

// The popup triggers manual syncs via messaging so all storage writes happen
// in this single service worker context.
chrome.runtime.onMessage.addListener((message: unknown, _sender, sendResponse) => {
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
  return false;
});
