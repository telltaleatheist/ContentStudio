// Per-channel collection status + last-cycle summary, persisted in
// chrome.storage.local so the popup can render them without waking work up.

import type { FlushResult } from './outbox';

export interface ChannelStatus {
  channelId: string;
  /** ISO timestamp of the most recent collection attempt, or null if never attempted. */
  lastAttempt: string | null;
  /** Error name from the most recent attempt (e.g. 'CollectorNotImplementedError'), null if it succeeded. */
  lastErrorName: string | null;
  /** Human-readable error message from the most recent attempt, null if it succeeded. */
  lastError: string | null;
  /** ISO timestamp of the most recent successful collection, or null. */
  lastSuccess: string | null;
}

export interface CycleSummary {
  startedAt: string;
  finishedAt: string;
  trigger: 'alarm' | 'manual' | 'install';
  channelsAttempted: number;
  flush: FlushResult;
}

const CHANNEL_STATUS_KEY = 'channelStatus';
const LAST_CYCLE_KEY = 'lastCycle';

export async function getChannelStatuses(): Promise<Record<string, ChannelStatus>> {
  const stored = await chrome.storage.local.get(CHANNEL_STATUS_KEY);
  const raw = stored[CHANNEL_STATUS_KEY];
  return raw && typeof raw === 'object' ? (raw as Record<string, ChannelStatus>) : {};
}

export async function recordChannelAttempt(
  channelId: string,
  attemptAt: string,
  error: { name: string; message: string } | null,
): Promise<void> {
  const statuses = await getChannelStatuses();
  const previous = statuses[channelId];
  statuses[channelId] = {
    channelId,
    lastAttempt: attemptAt,
    lastErrorName: error ? error.name : null,
    lastError: error ? error.message : null,
    lastSuccess: error ? (previous?.lastSuccess ?? null) : attemptAt,
  };
  await chrome.storage.local.set({ [CHANNEL_STATUS_KEY]: statuses });
}

export async function getLastCycle(): Promise<CycleSummary | null> {
  const stored = await chrome.storage.local.get(LAST_CYCLE_KEY);
  const raw = stored[LAST_CYCLE_KEY];
  return raw && typeof raw === 'object' ? (raw as CycleSummary) : null;
}

export async function setLastCycle(summary: CycleSummary): Promise<void> {
  await chrome.storage.local.set({ [LAST_CYCLE_KEY]: summary });
}
